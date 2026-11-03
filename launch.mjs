/**
 * Pure helpers for `dassi launch` — locating Chrome, resolving the dist,
 * building Chrome launch args, and tracking launched instances.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync, spawn as childSpawn } from 'child_process';
import * as path from 'path';
import { DASSI_EXTENSION_ID, getDaemonBridgePort, DEFAULT_BRIDGE_PORT, isDaemonRunning as isDaemonRunningImpl } from './dassi-shared.mjs';
import { loadExtensionOverPipe } from './_launch-pipe.mjs';
// `_launch-pipe.mjs` is private (underscore-prefixed): `launch.mjs` is the SINGLE public
// gateway for the launch module. Re-export the pipe transport here so every consumer
// (including the unit tests) imports it from this one surface, never from the private file.
export { cdpPipeClient, loadExtensionOverPipe } from './_launch-pipe.mjs';

/**
 * Resolve the path to an installed Chrome binary.
 * @param {{ platform?: string; env?: Record<string,string|undefined>; override?: string|null; exists?: (p: string) => boolean }} [opts]
 * @returns {string | null} The first existing Chrome path, the override, or null.
 */
export function resolveChromePath({ platform = process.platform, env = process.env, override = null, exists = existsSync } = {}) {
  if (override) return override;
  const candidates = [];
  if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else if (platform === 'win32') {
    const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    candidates.push(`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`);
    if (env['LOCALAPPDATA']) candidates.push(`${env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`);
  } else {
    candidates.push('/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return candidates.find((p) => exists(p)) ?? null;
}

/**
 * Resolve and validate the extension dist directory to load.
 * @param {{ dist?: string|null; cwd?: string; exists?: (p: string) => boolean }} [opts]
 * @returns {string} Absolute path to the dist directory.
 * @throws if the directory has no manifest.json.
 */
export function resolveDistPath({ dist = null, cwd = process.cwd(), exists = existsSync } = {}) {
  const base = dist ? path.resolve(cwd, dist) : path.resolve(cwd, 'extension/dist');
  if (!exists(path.join(base, 'manifest.json'))) {
    throw new Error(`No built extension at ${base} (manifest.json missing). Run \`pnpm build\`, or pass --dist <path>.`);
  }
  return base;
}

/**
 * Build the Chrome args for a pipe-driven launch.
 *
 * The extension is NOT loaded via the `--load-extension` flag: Chrome 137+ branded
 * builds reject it (`ERR_BLOCKED_BY_CLIENT`), and the `--disable-features=
 * DisableLoadExtensionCommandLineSwitch` escape hatch is gone in Chrome 149. Instead
 * the dist is installed at runtime over the CDP pipe via `Extensions.loadUnpacked`
 * (see {@link loadExtensionOverPipe}). That command is only accepted over the
 * `--remote-debugging-pipe` transport (fds 3/4) — not `--remote-debugging-port` —
 * and requires `--enable-unsafe-extension-debugging`. Works on branded Chrome,
 * Chrome for Testing, and Chromium alike.
 * @param {{ profileDir: string; chromeArgs?: string[] }} opts
 * @returns {string[]} Chrome args.
 */
export function buildLaunchArgs({ profileDir, chromeArgs = [] }) {
  return [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...chromeArgs,
  ];
}

/**
 * Build Chrome args for the legacy `--load-extension` path (Chrome for Testing /
 * Chromium, which still honour it and load the extension *persistently*). The dist
 * is loaded at startup, so the seed options URL can ride along as the startup tab.
 * @param {{ distPath: string; profileDir: string; label: string; bridgePort: number; chromeArgs?: string[] }} opts
 * @returns {string[]} Chrome args (the final entry is the seed URL to open).
 */
export function buildFlagArgs({ distPath, profileDir, label, bridgePort, chromeArgs = [] }) {
  const seed = `options.html?label=${encodeURIComponent(label)}&bridgePort=${bridgePort}`;
  return [
    `--load-extension=${distPath}`,
    `--disable-extensions-except=${distPath}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Reason: extra args must precede the positional seed URL — Chrome treats
    // everything after the first positional as URLs to open.
    ...chromeArgs,
    `chrome-extension://${DASSI_EXTENSION_ID}/${seed}`,
  ];
}

/**
 * Does this Chrome binary still support a *persistent* `--load-extension`?
 * Branded Google Chrome 137+ disabled it (ERR_BLOCKED_BY_CLIENT); Chrome for Testing
 * and Chromium still honour it. Detected from `--version` output. Defaults to false
 * (→ pipe path) on any error — the pipe path works everywhere, so it's the safe
 * fallback.
 * @param {string} chromePath
 * @param {(p: string) => string} [runVersion] inject for tests
 * @returns {boolean} true → use `--load-extension`; false → use the CDP pipe.
 */
export function chromeSupportsLoadFlag(chromePath, runVersion = (p) => execFileSync(p, ['--version'], { encoding: 'utf8' })) {
  try {
    return /for testing|chromium/i.test(runVersion(chromePath));
  } catch {
    return false;
  }
}

/**
 * Read the launches registry. Returns [] if the file is missing or unparseable.
 * @param {string} file
 * @returns {Array<{label: string; pid: number; profileDir: string; startedAt: number}>}
 */
export function readLaunches(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Record a launched Chrome, replacing any prior entry for the same label.
 *
 * Reason: read-modify-write is not cross-process locked. For this dev-only CLI
 * that's acceptable — concurrent `dassi launch`/`--stop` of *different* labels is
 * rare, and the worst case (a lost entry) is recoverable via `--stop-all` + a
 * manual Chrome close. A lock is intentionally omitted (YAGNI for a dev tool).
 * @param {string} file
 * @param {{label: string; pid: number; profileDir: string; startedAt: number}} entry
 */
export function recordLaunch(file, entry) {
  const list = readLaunches(file).filter((e) => e.label !== entry.label);
  list.push(entry);
  // Reason: ensure the dir exists so the write can't ENOENT after Chrome is already
  // spawned+connected (which would orphan it with nothing recorded to --stop).
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 });
}

/**
 * Remove the entry for a label. Returns the removed entry, or null if absent.
 * @param {string} file
 * @param {string} label
 * @returns {object | null}
 */
export function removeLaunch(file, label) {
  const list = readLaunches(file);
  const found = list.find((e) => e.label === label) ?? null;
  if (found) writeFileSync(file, JSON.stringify(list.filter((e) => e.label !== label), null, 2), { mode: 0o600 });
  return found;
}

// ─── Launch orchestrators (exported for testability; deps-injected to avoid circular imports) ───

/**
 * Poll the daemon's list_profiles until `label` registers or the timeout elapses.
 * @param {{ sendCommand: Function; socketPath: string; label: string; timeoutMs: number; sleep?: (ms:number)=>Promise<void> }} deps
 * @returns {Promise<boolean>} true if the label connected in time.
 */
export async function waitForProfile({ sendCommand, socketPath, label, timeoutMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await sendCommand(socketPath, { id: `cli_lp_${Date.now()}`, action: 'list_profiles' });
      if (resp.success && Array.isArray(resp.data) && resp.data.some((p) => p.label === label)) return true;
    } catch { /* daemon still coming up — keep polling */ }
    await sleep(500);
  }
  return false;
}

/**
 * One-shot check: is a profile with `label` already connected to the daemon?
 * Tolerates the daemon/socket not being up yet (returns false).
 * @param {{ sendCommand: Function; socketPath: string; label: string }} deps
 * @returns {Promise<boolean>}
 */
async function isLabelConnected({ sendCommand, socketPath, label }) {
  try {
    const resp = await sendCommand(socketPath, { id: `cli_pre_${Date.now()}`, action: 'list_profiles' });
    return resp.success && Array.isArray(resp.data) && resp.data.some((p) => p.label === label);
  } catch {
    return false;
  }
}

/**
 * Daemon pre-flight for a launch: validate the bridge port, spawn the (non-blocking)
 * daemon, and refuse a duplicate label. Calls `exit(1)` + returns null on failure.
 * @returns {Promise<{ bridgePort: number; socketPath: string } | null>}
 */
async function preflightLaunch({ ensureDaemonRunning, getSocketPath, sendCommand, isDaemonRunning, label, error, exit }) {
  // Reason: `dassi launch` reuses the 'default' daemon session, but the session PID
  // doesn't tell us its port. If a non-default DASSI_BRIDGE_PORT is requested while a
  // default daemon is already running, we can't confirm it's on that port — fail clearly.
  const bridgePort = getDaemonBridgePort();
  if (bridgePort !== DEFAULT_BRIDGE_PORT && isDaemonRunning('default')) {
    error(`❌  DASSI_BRIDGE_PORT=${bridgePort} is set, but a daemon is already running for the default session (it may be on a different port). Stop it first, or omit DASSI_BRIDGE_PORT to use the running daemon.`);
    exit(1);
    return null;
  }
  // Reason: only SPAWN the daemon (non-blocking) — none has connected yet.
  ensureDaemonRunning('default');
  const socketPath = getSocketPath('default');
  // Reason: a same-label Chrome already running makes waitForProfile falsely succeed.
  if (await isLabelConnected({ sendCommand, socketPath, label })) {
    error(`❌  A profile labelled "${label}" is already connected. Run \`dassi launch --stop ${label}\` first, or use a different --label.`);
    exit(1);
    return null;
  }
  return { bridgePort, socketPath };
}

/**
 * Launch Chrome with the dev dist loaded under a dedicated profile, wait for the
 * extension to register under `label`, then record it. Auto-detects the load mode
 * (pipe helper for branded Chrome / `--load-extension` for CfT/Chromium).
 * @param {{label:string; dist:string|null; chrome:string|null; profileDir:string|null; loadMode?:string; timeoutMs:number; chromeArgs?:string[]}} opts
 * @param {{ spawn: Function; ensureDaemonRunning: Function; getSocketPath: Function; sendCommand: Function; appDir: string; launchesFile: string; isDaemonRunning?: Function; detectLoadFlag?: Function; helperCommand?: string[]; log?: Function; error?: Function; exit?: Function; mkdir?: Function; kill?: Function }} deps
 *   `detectLoadFlag` chooses pipe-vs-flag mode; `helperCommand` is the argv used to spawn the detached pipe-hold helper (both injectable for tests).
 * @returns {Promise<void>} resolves once the launch is recorded (or `deps.exit` is called on failure).
 */
export async function handleLaunch(opts, deps) {
  const {
    spawn, ensureDaemonRunning, getSocketPath, sendCommand, appDir, launchesFile,
    isDaemonRunning = isDaemonRunningImpl,
    detectLoadFlag = chromeSupportsLoadFlag,
    helperCommand = [process.execPath, process.argv[1]],
    log = console.log, error = console.error, exit = process.exit,
    mkdir = (d) => mkdirSync(d, { recursive: true }), kill = (pid) => process.kill(pid),
  } = deps;

  const target = resolveLaunchTarget(opts, { error, exit, appDir, mkdir });
  if (!target) return; // resolution failed (exit already called)
  const { distPath, chromePath, profileDir } = target;

  const pre = await preflightLaunch({ ensureDaemonRunning, getSocketPath, sendCommand, isDaemonRunning, label: opts.label, error, exit });
  if (!pre) return; // a guard failed (exit already called)
  const { bridgePort, socketPath } = pre;

  // Reason: branded Chrome 137+ disabled --load-extension, so install over the CDP pipe via
  // a persistent helper. CfT/Chromium still honour --load-extension. --load-mode forces it;
  // 'auto' (default) detects from the binary's --version.
  const useFlag = opts.loadMode === 'flag' ? true : opts.loadMode === 'pipe' ? false : detectLoadFlag(chromePath);
  const common = { spawn, kill, sendCommand, socketPath, chromePath, distPath, profileDir, bridgePort, opts, error };
  const pid = useFlag ? await spawnFlagAndConnect(common) : await spawnHelperAndConnect({ ...common, helperCommand });
  if (pid === null) return exit(1);

  recordLaunch(launchesFile, { label: opts.label, pid, profileDir, mode: useFlag ? 'flag' : 'pipe', startedAt: Date.now() });
  log(`✅  launched "${opts.label}" (pid ${pid}) — find targets with: dassi list-tabs --profile ${opts.label}`);
}

/**
 * Entry for the hidden `dassi __launch-hold` subcommand: reads the DASSI_HOLD_* env vars
 * (set by spawnHelperAndConnect) and runs the pipe-holding helper. Never returns.
 * @param {Record<string,string|undefined>} [env] Environment variables; defaults to process.env.
 * @param {Function} [run] Pipe-hold runner; defaults to runPipeHoldHelper (injectable for tests).
 * @returns {Promise<void>}
 */
export async function handleLaunchHold(env = process.env, run = runPipeHoldHelper) {
  let chromeArgs = [];
  // Reason: fail-open to [] — a malformed env var must not strand the helper.
  try { chromeArgs = JSON.parse(env.DASSI_HOLD_CHROME_ARGS ?? '[]'); } catch { process.stderr.write('⚠️  Ignoring malformed DASSI_HOLD_CHROME_ARGS (expected JSON array).\n'); }
  if (!Array.isArray(chromeArgs)) chromeArgs = [];
  await run({
    label: env.DASSI_HOLD_LABEL,
    distPath: env.DASSI_HOLD_DIST,
    profileDir: env.DASSI_HOLD_PROFILE_DIR,
    bridgePort: Number(env.DASSI_HOLD_BRIDGE_PORT),
    chromePath: env.DASSI_HOLD_CHROME,
    chromeArgs,
  });
}

/**
 * Route a `launch*` CLI action to its handler. Returns true if it was a launch action
 * (so the caller can `return`), false otherwise. Keeps the launch surface out of dassi.mjs.
 * @param {string} action
 * @param {object} params
 * @param {{ spawn:Function; ensureDaemonRunning:Function; getSocketPath:Function; sendCommand:Function; appDir:string; launchesFile:string; kill?:Function; handleHold?:Function }} deps
 *   `handleHold` overrides the `__launch-hold` runner (injectable for tests; defaults to handleLaunchHold).
 * @returns {Promise<boolean>}
 */
export async function dispatchLaunch(action, params, deps) {
  if (action === 'launch') { await handleLaunch(params, deps); return true; }
  if (action === 'launch_stop') { handleStop(params, { launchesFile: deps.launchesFile, kill: deps.kill }); return true; }
  if (action === 'launch_hold') { await (deps.handleHold ?? handleLaunchHold)(); return true; }
  return false;
}

/**
 * Flag mode (Chrome for Testing / Chromium): detached Chrome with a persistent
 * `--load-extension`. The browser keeps the extension after this CLI exits.
 * @returns {Promise<number|null>} the Chrome pid, or null on spawn/connect failure.
 */
async function spawnFlagAndConnect({ spawn, kill, sendCommand, socketPath, chromePath, distPath, profileDir, bridgePort, opts, error }) {
  const child = spawn(chromePath, buildFlagArgs({ distPath, profileDir, label: opts.label, bridgePort, chromeArgs: opts.chromeArgs ?? [] }), { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  if (typeof child.pid !== 'number') {
    error('❌  Failed to launch Chrome — check the Chrome path (--chrome).');
    return null;
  }
  error(`Launching Chrome (pid ${child.pid}) with ${distPath} — waiting for "${opts.label}" to connect…`);
  if (await waitForProfile({ sendCommand, socketPath, label: opts.label, timeoutMs: opts.timeoutMs })) return child.pid;
  try { kill(child.pid); } catch { /* already gone */ }
  error(`❌  "${opts.label}" did not connect within ${opts.timeoutMs}ms (Chrome already using ${profileDir}, or a stale profile).`);
  return null;
}

/**
 * Pipe mode (branded Chrome): spawn a detached `dassi __launch-hold` helper that holds the
 * CDP pipe open so the loadUnpacked extension persists. The recorded pid is the HELPER's —
 * `dassi launch --stop` SIGTERMs it, and it closes the pipe + kills its Chrome child.
 * @returns {Promise<number|null>} the helper pid, or null on spawn/connect failure.
 */
async function spawnHelperAndConnect({ spawn, kill, sendCommand, socketPath, chromePath, distPath, profileDir, bridgePort, opts, error, helperCommand }) {
  const [node, cli] = helperCommand;
  // Reason: pass the helper's config via env (not flags) so it can't collide with the
  // CLI's global --label/--profile parsing.
  const helper = spawn(node, [cli, '__launch-hold'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DASSI_HOLD_LABEL: opts.label,
      DASSI_HOLD_DIST: distPath,
      DASSI_HOLD_PROFILE_DIR: profileDir,
      DASSI_HOLD_BRIDGE_PORT: String(bridgePort),
      DASSI_HOLD_CHROME: chromePath,
      // Reason: JSON, not space-joined — Chrome args may contain spaces.
      DASSI_HOLD_CHROME_ARGS: JSON.stringify(opts.chromeArgs ?? []),
    },
  });
  helper.on('error', () => {});
  helper.unref();
  if (typeof helper.pid !== 'number') {
    error('❌  Failed to start the launch helper.');
    return null;
  }
  error(`Launching Chrome via pipe helper (pid ${helper.pid}) with ${distPath} — waiting for "${opts.label}" to connect…`);
  if (await waitForProfile({ sendCommand, socketPath, label: opts.label, timeoutMs: opts.timeoutMs })) return helper.pid;
  try { kill(helper.pid); } catch { /* already gone */ }
  error(`❌  "${opts.label}" did not connect within ${opts.timeoutMs}ms (extension installed but the bridge didn't register — daemon port mismatch or a stale profile).`);
  return null;
}

/**
 * Long-lived `dassi __launch-hold` helper (a detached child of `dassi launch` on branded
 * Chrome): spawns Chrome with the CDP pipe, installs the dist, signals readiness, then
 * HOLDS the pipe open until killed — a loadUnpacked extension lives only as long as its
 * debugging session. On SIGTERM/SIGINT (from `dassi launch --stop`) or if Chrome exits, it
 * tears down and exits.
 * @param {{ distPath:string; profileDir:string; label:string; bridgePort:number; chromePath:string;
 *          chromeArgs?:string[];
 *          spawn?:Function; loadExtension?:Function; onReady?:Function; hold?:()=>Promise<void>;
 *          error?:Function; exit?:Function }} o
 * @returns {Promise<void>} In production never resolves (hold() is infinite until killed);
 *   resolves after calling exit(1) on extension-install failure.
 */
export async function runPipeHoldHelper(o) {
  const {
    distPath, profileDir, label, bridgePort, chromePath,
    chromeArgs = [],
    spawn = childSpawn, loadExtension = loadExtensionOverPipe,
    onReady = () => {}, hold = () => new Promise(() => {}),
    error = (m) => process.stderr.write(`${m}\n`), exit = process.exit,
  } = o;
  const child = spawn(chromePath, buildLaunchArgs({ profileDir, chromeArgs }), { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let dispose = () => {};
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { dispose(); } catch { /* ignore */ }
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    exit(0);
  };
  // Reason: this helper runs as a detached process whose whole job is to hold the CDP
  // pipe open. SIGTERM is how `dassi launch --stop` tears it down; SIGINT covers Ctrl-C.
  // Without these handlers the Chrome child (and its loaded extension) would be orphaned.
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  child.on('error', () => {});
  child.on('exit', () => { if (!shuttingDown) exit(0); }); // Chrome died → stop holding
  try {
    ({ dispose } = await loadExtension({ child, distPath, label, bridgePort }));
  } catch (err) {
    // Reason: set shuttingDown FIRST so the child.on('exit') guard above can't win the
    // race and call exit(0) — a failed install must surface as exit(1), not false success.
    shuttingDown = true;
    error(`launch-hold: failed to install extension: ${err.message}`);
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    return exit(1);
  }
  onReady();
  await hold(); // hold the pipe open (draining) until killed
}

/**
 * Resolve the dist dir, Chrome binary, and profile dir for a launch.
 * Calls `exit(1)` and returns null on any failure (extracted to keep
 * handleLaunch within the function-length limit).
 * @param {{label:string; dist:string|null; chrome:string|null; profileDir:string|null}} opts
 * @param {{ error: Function; exit: Function; appDir: string; mkdir: Function }} deps
 * @returns {{distPath:string; chromePath:string; profileDir:string} | null}
 */
function resolveLaunchTarget(opts, { error, exit, appDir, mkdir }) {
  let distPath;
  try { distPath = resolveDistPath({ dist: opts.dist }); }
  catch (err) { error(`❌  ${err.message}`); exit(1); return null; }

  const chromePath = resolveChromePath({ override: opts.chrome });
  if (!chromePath) {
    error('❌  Could not find Chrome. Pass --chrome <path> to the Chrome/Chromium binary.');
    exit(1);
    return null;
  }

  const profileDir = opts.profileDir ?? path.join(appDir, `launch-${opts.label}`);
  mkdir(profileDir);
  return { distPath, chromePath, profileDir };
}

/**
 * Kill the Chrome instance(s) recorded by `dassi launch`.
 * @param {{label?: string; all?: boolean}} opts
 * @param {{ launchesFile: string; kill?: (pid:number)=>void; log?: Function }} deps
 */
export function handleStop(opts, deps) {
  const { launchesFile, kill = (pid) => process.kill(pid), log = console.log } = deps;
  const list = readLaunches(launchesFile);
  const targets = opts.all ? list : list.filter((e) => e.label === opts.label);
  if (targets.length === 0) {
    log(opts.all ? 'No launched Chrome instances to stop.' : `Nothing to stop for "${opts.label}".`);
    return;
  }
  for (const e of targets) {
    // Reason: guard against corrupt launches.json entries with non-number pids, which
    // would cause process.kill to throw a misleading TypeError instead of a clear skip.
    if (typeof e.pid !== 'number') { log(`Skipping "${e.label}" — corrupt record (no pid).`); removeLaunch(launchesFile, e.label); continue; }
    try { kill(e.pid); log(`Stopped "${e.label}" (pid ${e.pid}).`); }
    catch { log(`"${e.label}" (pid ${e.pid}) was already gone.`); }
    removeLaunch(launchesFile, e.label);
  }
}
