#!/usr/bin/env node
/**
 * Dassi CLI — thin client that talks to the daemon over a Unix socket.
 * Protocol-compatible with agent-browser: {id, action, ...} → {id, success, data/error}
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import { getSocketPath, validateSession, getAppDir, getLaunchesFile, CLI_VERSION, isMainModule } from './dassi-shared.mjs';
import { ensureDaemonRunning, sendCommand, sendAndWait, ensureDaemonReady } from './daemon-client.mjs';
import { dispatchLaunch } from './launch.mjs';
import {
  OUTDATED_PLUGIN_HINT,
  parseToolCommand,
  requireTarget,
  parseStrictInt,
  parseTarget,
  parseWait,
} from './tool-commands.mjs';
import { runWithGroupExpansion } from './group-expansion.mjs';
import { formatResponse } from './format-response.mjs';
import { HELP_TEXT } from './help-text.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Arg parsing ──────────────────────────────────────────────────────────────

/**
 * Parses CLI arguments into a command descriptor.
 * Supports live tool discovery and generic browser calls,
 * agent commands (run, list-tabs, status, raw), and top-level flags (--version, --help).
 * Run `dassi --help` for the full command reference.
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{ action: string; params: Record<string, unknown>; session: string; json: boolean; profile: string | null }}
 */
export function parseCliArgs(argv, { interactive = false } = {}) {
  const args = [...argv];

  // Reason: hoist the `--` split to BEFORE global flag parsing so that Chrome
  // passthrough tokens like --json, --label, --profile, or --stop can never be
  // mistakenly consumed as CLI flags. Everything after the first `--` token is
  // sliced out here and stored verbatim in `chromeArgs`; the remaining `args`
  // array is then parsed as usual with no risk of collision. Non-launch commands
  // that supply a `--` separator are rejected loudly below (after the action is
  // known) so callers get a clear error instead of silent data loss.
  const sepIdx = args.indexOf('--');
  const chromeArgs = sepIdx === -1 ? [] : args.splice(sepIdx).slice(1);

  // Reason: handle --version and --help before any flag parsing so they work
  // even when other flags like --session are incomplete (e.g. `dassi --version --session`)
  if (consumeFlag(args, '--version')) {
    return { action: 'version', params: {}, session: 'default', json: args.includes('--json'), profile: null };
  }
  if (consumeFlag(args, '--help')) {
    return { action: 'help', params: {}, session: 'default', json: args.includes('--json'), profile: null };
  }

  const session = validateSession(getFlag(args, '--session') ?? process.env.DASSI_SESSION ?? 'default');
  const json = consumeFlag(args, '--json');
  const profile = getFlag(args, '--profile') ?? getFlag(args, '--label') ?? null;

  // Reason: centralise the return shape so every command branch includes profile
  // without editing each return individually
  const finish = (action, params) => {
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}. Run: dassi --help`);
    const { profileTarget, ...rest } = params;
    if (profile && profileTarget && profile !== profileTarget) throw new Error('Target includes a profile; omit --profile or use the same profile ID.');
    return { action, params: rest, session, json, profile: profileTarget ?? profile };
  };

  const command = args.shift() ?? (interactive && argv.length === 0 ? 'setup' : undefined);
  if (!command) throw new Error('No command specified. Run dassi setup to connect Chrome, or dassi --help for commands.');

  // Reason: chromeArgs (tokens after `--`) are only meaningful for the `launch`
  // command. Any other command that supplies `--` tokens would have them silently
  // dropped — fail loudly instead so the caller knows their intent was not honoured.
  if (chromeArgs.length > 0 && command !== 'launch') {
    throw new Error("'--' is only valid with the launch command");
  }

  if (command === 'setup') {
    const waitRaw = getFlag(args, '--wait');
    return finish('setup', { waitMs: parseWait(waitRaw ?? '5m'), noOpen: consumeFlag(args, '--no-open') });
  }

  if (command === 'skill') {
    const pathOnly = consumeFlag(args, '--path');
    const remove = consumeFlag(args, '--remove');
    if (pathOnly && remove) throw new Error('Use either skill --path or skill --remove.');
    return finish(remove ? 'remove_skill' : 'skill', remove ? {} : { pathOnly });
  }

  if (command === 'list-tabs') {
    consumeFlag(args, '--all');
    return finish('list_tabs', { all: true });
  }

  if (command === 'list-groups') {
    consumeFlag(args, '--all');
    return finish('list_groups', { all: true });
  }

  if (command === 'result') {
    const outputDir = getFlag(args, '--output-dir');
    const waitRaw = getFlag(args, '--wait');
    const taskId = args[0] && !args[0].startsWith('-') ? args.shift() : undefined;
    if (!taskId) throw new Error('result requires a task ID');
    if (outputDir !== undefined && !outputDir.trim()) throw new Error('--output-dir requires a directory');
    return finish('task_result', { taskId,
      ...(outputDir !== undefined ? { _outputDir: outputDir } : {}),
      ...(waitRaw !== undefined ? { waitMs: parseWait(waitRaw) } : {}) });
  }

  if (command === 'status' || command === 'stop') {
    const waitRaw = getFlag(args, '--wait');
    const taskId = args[0] && !args[0].startsWith('-') ? args.shift() : undefined;
    if (!taskId && (command === 'stop' || waitRaw !== undefined)) throw new Error(`${command} requires a task ID`);
    return finish(taskId ? (command === 'stop' ? 'task_stop' : 'task_status') : 'status',
      taskId ? { taskId, ...(waitRaw !== undefined ? { waitMs: parseWait(waitRaw) } : {}) } : {});
  }

  if (command === 'list-profiles') {
    return finish('list_profiles', {});
  }

  if (command === 'launch') {
    if (consumeFlag(args, '--stop-all')) {
      // Reason: chromeArgs with --stop-all makes no sense — reject to prevent confusion.
      if (chromeArgs.length > 0) throw new Error("'--' chrome args cannot be combined with launch --stop-all");
      return finish('launch_stop', { all: true });
    }
    const stopIdx = args.indexOf('--stop');
    if (stopIdx !== -1) {
      args.splice(stopIdx, 1);
      // Reason: chromeArgs with --stop makes no sense — reject to prevent confusion.
      if (chromeArgs.length > 0) throw new Error("'--' chrome args cannot be combined with launch --stop");
      // Reason: resolve the stop label like the start path does — a positional
      // token after --stop wins, else the global --label/--profile (parsed into
      // `profile` before this branch), else the default. Keeps `--stop --label qa`
      // symmetric with `launch --label qa` instead of silently targeting "dev".
      const positional = args[0] && !args[0].startsWith('--') ? args.shift() : null;
      return finish('launch_stop', { label: positional ?? profile ?? 'dev', all: false });
    }
    const timeoutRaw = getFlag(args, '--timeout');
    // Reason: --label is consumed early as a global flag (aliased to --profile).
    // The launch branch reads it from `profile` as the canonical source; any
    // remaining --label token in args is a second occurrence and takes precedence.
    const launchLabel = getFlag(args, '--label') ?? profile ?? 'dev';
    // Reason: the label becomes a path segment (per-label profile dir) + the seed URL,
    // so restrict to a path-safe token (blocks "x/../../.ssh" traversal) within the
    // extension's 64-char cap — same character set as validateSession.
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(launchLabel)) {
      throw new Error('--label must be 1–64 characters of letters, digits, hyphen, or underscore.');
    }
    const loadMode = getFlag(args, '--load-mode') ?? 'auto'; // auto (detect) | pipe | flag
    if (!['auto', 'pipe', 'flag'].includes(loadMode)) throw new Error('--load-mode must be one of: auto, pipe, flag.');
    return finish('launch', {
      label: launchLabel,
      dist: getFlag(args, '--dist') ?? null,
      chrome: getFlag(args, '--chrome') ?? null,
      profileDir: getFlag(args, '--profile-dir') ?? null,
      loadMode,
      timeoutMs: timeoutRaw ? parseStrictInt(timeoutRaw, '--timeout') : 30000,
      chromeArgs,
    });
  }

  // Hidden helper command (detached child of `dassi launch` pipe mode); config via DASSI_HOLD_* env.
  if (command === '__launch-hold') return finish('launch_hold', {});

  if (command === 'run') {
    const prompt = args.shift();
    if (!prompt) throw new Error('run requires a prompt argument');
    const taskId = getFlag(args, '--task');
    if (args.includes('--timeout')) throw new Error('run no longer accepts --timeout. Use --wait to wait locally, or stop <task-id> to cancel.');
    if (taskId && ['--tab', '--group', '--group-title'].some(flag => args.includes(flag))) throw new Error('Use --task to continue its original browser context; omit tab/group selectors.');
    const target = taskId ? { taskId } : requireTarget('run', args, getFlag);
    const waitRaw = getFlag(args, '--wait');
    const waitMs = waitRaw !== undefined ? parseWait(waitRaw) : 0;
    const outputDir = getFlag(args, '--output-dir');
    if (outputDir !== undefined && !outputDir.trim()) throw new Error('--output-dir requires a directory');
    const base = { prompt, ...(waitMs ? { waitMs } : {}), ...(outputDir !== undefined ? { _outputDir: outputDir } : {}) };
    return finish('run', { ...base, ...target });
  }

  if (command === 'bug-report') {
    const output = getFlag(args, '-o') ?? getFlag(args, '--output');
    return finish('export_logs', { output });
  }

  if (command === 'panel-screenshot') {
    const tabRaw = getFlag(args, '--tab');
    if (!tabRaw) throw new Error('panel-screenshot requires --tab <tabId>');
    const { id: tabId, ...target } = parseTarget(tabRaw, '--tab');
    const output = getFlag(args, '-o') ?? getFlag(args, '--output') ?? null;
    const widthRaw = getFlag(args, '--width');
    const heightRaw = getFlag(args, '--height');
    const width = widthRaw ? parseStrictInt(widthRaw, '--width') : undefined;
    const height = heightRaw ? parseStrictInt(heightRaw, '--height') : undefined;
    return finish('panel_screenshot', { tabId, ...target, ...(output ? { _output: output } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}) });
  }

  if (command === 'raw') {
    const rawArg = args.shift();
    if (!rawArg) throw new Error('raw requires a JSON string argument');
    const cmd = JSON.parse(rawArg);
    // Reason: store action='raw' as a sentinel so run() can send the full cmd envelope
    // verbatim, letting the user control every field (including action) without reconstruction
    return finish('raw', cmd);
  }

  const toolParams = parseToolCommand(command, args, getFlag, consumeFlag);
  if (toolParams) {
    // Reason: some tool commands resolve to dedicated bridge methods rather
    // than tool_exec (open --window → open_tab).
    if (toolParams.__bridgeAction) {
      const { __bridgeAction, ...params } = toolParams;
      return finish(__bridgeAction, params);
    }
    return finish('tool_exec', toolParams);
  }

  throw new Error(
    `Unknown command: "${command}". Browser commands use dassi tools and dassi call (run: dassi --help). ${OUTDATED_PLUGIN_HINT}`,
  );
}

/**
 * Extracts --flag <value> from args array (mutates array, removes both tokens).
 * @param {string[]} args
 * @param {string} flag
 * @returns {string | undefined}
 */
function getFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  if (idx + 1 >= args.length || String(args[idx + 1]).startsWith('--')) {
    throw new Error(`Flag ${flag} requires a value`);
  }
  const val = args[idx + 1];
  args.splice(idx, 2);
  return val;
}

/**
 * Removes a boolean flag from args array (mutates). Returns true if it was present.
 * @param {string[]} args
 * @param {string} flag
 * @returns {boolean}
 */
function consumeFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

// ─── Immediate actions ────────────────────────────────────────────────────────

// HELP_TEXT lives in ./help-text.mjs (extracted to keep this file within the size limit).

function handleImmediateAction({ action, params, json }) {
  let text;
  if (action === 'version') text = CLI_VERSION;
  else if (action === 'help') text = HELP_TEXT;
  else if (action === 'skill') {
    const skillDir = path.join(__dirname, 'skills', 'dassi');
    text = params.pathOnly ? skillDir : fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  } else return false;
  console.log(json ? JSON.stringify({ success: true, data: text }) : text);
  return true;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Parses arguments, connects to the daemon, and prints the command result.
 * @returns {Promise<void>}
 */
export async function run(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseCliArgs(argv, { interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
    await execute(parsed);
  } catch (err) {
    const args = argv.slice(0, argv.indexOf('--') === -1 ? argv.length : argv.indexOf('--'));
    const json = parsed?.json ?? args.includes('--json');
    const response = { success: false, error: err instanceof Error ? err.message : String(err), ...(err?.outcome === 'unknown' ? { outcome: 'unknown' } : {}) };
    if (json) console.log(formatResponse('error', response, true));
    else console.error(formatResponse('error', response, false));
    process.exitCode = 1;
  }
}

async function execute(parsed) {
  const { action, params, session, json, profile } = parsed;
  if (handleImmediateAction(parsed)) return;
  if (action === 'remove_skill') {
    const { unregisterSkills } = await import('./setup.mjs');
    const skills = await unregisterSkills();
    console.log(json ? JSON.stringify({ success: true, data: { skills } }) : [
      ...skills.map(skill => `${skill.status}: ${skill.path}`),
      'To remove the CLI, run: npm uninstall -g @dassi_ai/cli',
    ].join('\n'));
    return;
  }
  if (action === 'setup') {
    const { setup, formatSetup } = await import('./setup.mjs');
    const data = await setup({ ...params, profile, session, interactive: !json && Boolean(process.stdin.isTTY) });
    const response = { success: data.ready, data, ...(!data.ready ? { error: data.next } : {}) };
    console.log(json ? JSON.stringify(response) : formatSetup(data));
    if (!data.ready) process.exitCode = 1;
    return;
  }

  // Launch family (launch / --stop / __launch-hold) → launch.mjs.
  if (await dispatchLaunch(action, params, { spawn: child_process.spawn, ensureDaemonRunning, getSocketPath, sendCommand, appDir: getAppDir(), launchesFile: getLaunchesFile() })) return;

  const socketPath = await ensureDaemonReady(session);
  const sendTaskCommand = (socket, command) => sendAndWait(socket, { ...command, _session: session });

  const id = `cli_${randomUUID()}`;

  // Group expansion: if action=run or action=tool_exec with groupId/groupTitle, expand and fan out sequentially
  if (
    (action === 'run' || action === 'tool_exec') &&
    (params.groupId !== undefined || params.groupTitle !== undefined)
  ) {
    const allOk = await runWithGroupExpansion(socketPath, action, params, json, sendTaskCommand, formatResponse, profile);
    if (!allOk) process.exitCode = 1;
    return;
  }

  // Reason: for 'raw' the user controls the full envelope — send params verbatim (no target injection).
  // For all other commands, include target only when --profile/--label was given so back-compat is exact.
  const command = action === 'raw'
    ? { id, ...params }
    : { id, action, ...params, ...(profile ? { target: profile } : {}) };
  const response = await sendTaskCommand(socketPath, command);

  const output = formatResponse(action, response, json, params);
  if (!json && !response.success) console.error(output);
  else console.log(output);
  if (!response.success || (command.action !== 'task_stop' && ['failed', 'stopped'].includes(response.data?.status))) process.exitCode = 1;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await run();
}
