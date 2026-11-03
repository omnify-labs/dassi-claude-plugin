/** CLI transport, daemon startup, and bounded observation of browser-owned tasks. */

import * as net from 'net';
import { prepareResultDirectory, recordAcceptedTask, saveTaskResult } from './task-result.mjs';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { fileURLToPath } from 'url';
import {
  getSocketPath,
  CLI_PROTOCOL_VERSION,
  getReadyFile,
  getPidFile,
  isDaemonRunning,
  parseReadyPayload,
  CHROME_WEB_STORE_URL,
  unknownToolOutcome,
} from './dassi-shared.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.join(__dirname, 'dassi-daemon.mjs');
const READY_POLL_MS = 100;
const READY_TIMEOUT_MS = 30_000;

// ─── Daemon management ────────────────────────────────────────────────────────

/**
 * Ensures the daemon is running for the given session.
 * Spawns it as a detached background process if the PID file is missing or stale.
 * @param {string} session
 */
export function ensureDaemonRunning(session) {
  if (isDaemonRunning(session)) return;

  // Reason: detached + unref means the daemon outlives the CLI process
  const daemon = child_process.spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DASSI_SESSION: session },
  });
  daemon.unref();
}

/**
 * Polls for the ready file until it appears or the timeout elapses.
 * Resolves with the parsed ready payload.
 * @param {string} readyFile
 * @param {number} [timeoutMs]
 * @returns {Promise<{ status: string; [key: string]: unknown }>}
 */
export function waitForReady(readyFile, timeoutMs = READY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (fs.existsSync(readyFile)) {
        try {
          resolve(parseReadyPayload(fs.readFileSync(readyFile, 'utf8')));
          return;
        } catch { /* file may be partially written — keep polling */ }
      }
      if (Date.now() >= deadline) {
        const seconds = Math.round(timeoutMs / 1000);
        reject(new Error(`Timed out waiting for Dassi daemon to start (${seconds}s)`));
        return;
      }
      setTimeout(check, READY_POLL_MS);
    };
    check();
  });
}

/**
 * Connects to the daemon Unix socket, sends one NDJSON command, and reads the response.
 * @param {string} socketPath - Unix socket path.
 * @param {object} command - Command object to send (will be JSON-stringified).
 * @returns {Promise<object>} Parsed response object.
 */
export function sendCommand(socketPath, command, {
  // Direct tools own their deadlines; a plugin need not expose a timeout parameter.
  timeoutMs = command.action === 'tool_exec' ? null : command.action !== 'run' && Number.isFinite(command.timeoutMs) && command.timeoutMs > 0
    ? Math.min(command.timeoutMs + 15_000, 2147483647)
    : 70_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = timeoutMs == null ? null : setTimeout(() => socket.destroy(new Error('Daemon did not respond. Check the existing task before retrying.')), timeoutMs);
    let buffer = '';
    let settled = false;
    let submitted = false;

    // Reason: guard against double-settlement since 'close' fires after socket.destroy()
    // in the normal data path, and we don't want the close handler to re-resolve
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(fn === reject && submitted && command.action === 'tool_exec' ? unknownToolOutcome(val) : val);
    };

    socket.on('connect', () => {
      submitted = true;
      socket.write(JSON.stringify(command) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        socket.destroy();
        try { settle(resolve, JSON.parse(line)); }
        catch { settle(reject, new Error(`Invalid JSON from daemon: ${line}`)); }
      }
    });

    socket.on('error', (err) => settle(reject, err));

    socket.on('close', () => {
      if (settled) return;
      // Reason: attempt to parse whatever arrived before the socket closed unexpectedly
      if (buffer.trim()) {
        try { settle(resolve, JSON.parse(buffer.trim())); }
        catch { settle(reject, new Error(`Invalid JSON from daemon: ${buffer.trim()}`)); }
      } else {
        settle(reject, new Error('Daemon closed connection without a response'));
      }
    });
  });
}

// ─── Daemon readiness ─────────────────────────────────────────────────────────

/**
 * Ensures the local command transport is ready.
 * @param {string} session
 * @returns {Promise<string>} The daemon's Unix socket path.
 */
export async function ensureDaemonReady(session) {
  const socketPath = getSocketPath(session);
  const readyFile = getReadyFile(session);

  // Reason: delete any stale ready file from a previous run so the new daemon
  // writes a fresh one. Skip if a daemon is already running to avoid racing.
  if (!isDaemonRunning(session)) {
    try { fs.unlinkSync(readyFile); } catch { /* ok if missing */ }
  }

  ensureDaemonRunning(session);

  const ready = await waitForReady(readyFile);

  if (ready.status === 'extension_not_installed') {
    throw new Error(
      `Dassi extension not detected.\n\n` +
      `   Install it from:\n   ${CHROME_WEB_STORE_URL}\n\n` +
      `   Then run this command again.`
    );
  }

  if (ready.status === 'error') throw new Error(ready.error);
  if (ready.protocolVersion > CLI_PROTOCOL_VERSION) throw new Error(`A newer Dassi daemon is running (protocol ${ready.protocolVersion}, this CLI speaks ${CLI_PROTOCOL_VERSION}). Run \`npm install -g @dassi_ai/cli@latest\` and retry.`);
  if (ready.protocolVersion !== CLI_PROTOCOL_VERSION) throw new Error(`An older Dassi daemon is running. Finish active tasks, stop it (kill the PID in ${getPidFile(session)}), then retry with this CLI.`);

  return socketPath;
}

function retrievalCommand(taskId, directory, session) {
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  return `dassi result ${quote(taskId)} --output-dir ${quote(directory)} --session ${quote(session)}`;
}

/** Waiting expires locally; it never cancels the browser-owned task. */
export async function sendAndWait(socketPath, command, send = sendCommand, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const { waitMs = 0, _outputDir, _session = 'default', ...wire } = command;
  if (_outputDir) await prepareResultDirectory(_outputDir, wire.taskId);
  const wantsResult = wire.action === 'task_result';
  if (wantsResult) wire.action = 'task_status';
  if (['run', 'task_status', 'task_stop'].includes(wire.action)) wire.protocolVersion = CLI_PROTOCOL_VERSION;
  let response = await send(socketPath, wire);
  if (wire.action === 'run' && _outputDir && response.success && response.data?.taskId) {
    response.data.resultCommand = retrievalCommand(response.data.taskId, _outputDir, _session);
    try { await recordAcceptedTask(response.data, _outputDir); }
    catch (error) { return { success: false, taskId: response.data.taskId, error: `Task accepted, but its local record could not be saved: ${error.message} Retrieve: ${response.data.resultCommand}` }; }
  }
  const deadline = now() + waitMs;
  while (response.success && ['running', 'stopping'].includes(response.data?.status) && now() < deadline) {
    await sleep(Math.min(1000, deadline - now()));
    if (now() >= deadline) break;
    const taskId = response.data.taskId;
    try {
      const next = await send(socketPath, { id: `${wire.id}-status-${now()}`, action: 'task_status', taskId, protocolVersion: CLI_PROTOCOL_VERSION }, { timeoutMs: Math.max(1, deadline - now()) });
      if (!next.success) return { ...next, taskId, error: `${next.error} Check task ${taskId}; do not resubmit.` };
      response = next;
    } catch (error) { if (now() >= deadline) break; return { success: false, taskId, error: `${error.message} Check task ${taskId}; do not resubmit.` }; }
  }
  if (!response.success) return response;
  const active = ['running', 'stopping'].includes(response.data?.status);
  if (!wantsResult && (!_outputDir || active)) {
    if (_outputDir && response.data?.taskId) {
      response.data.resultCommand = retrievalCommand(response.data.taskId, _outputDir, _session);
    }
    return response;
  }
  const taskId = response.data.taskId;
  try {
    const result = await send(socketPath, { id: `${wire.id}-result`, action: 'task_result', taskId, protocolVersion: CLI_PROTOCOL_VERSION });
    if (!result.success) return { ...result, taskId };
    if (_outputDir) {
      result.data = await saveTaskResult(result.data, _outputDir, send, socketPath);
      if (!result.data.export.complete) return { ...result, success: false, taskId, error: 'Task result saved with missing files. Retry result to download them.' };
    }
    return result;
  } catch (error) {
    return { success: false, taskId, error: `Could not export task result: ${error.message} Retrieve this task with dassi result; do not resubmit.` };
  }
}
