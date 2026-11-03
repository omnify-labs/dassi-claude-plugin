#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { CLI_PROTOCOL_VERSION } from './dassi-shared.mjs';
/**
 * Dassi CLI Daemon
 *
 * Persistent process that hosts a WebSocket server on port 18790 (override
 * with DASSI_BRIDGE_PORT — the benchmark harness uses 18791 to isolate
 * from a developer's real Chrome on the default port), waits for the Dassi
 * Chrome extension to connect, and exposes a Unix socket for thin CLI
 * clients to send NDJSON commands.
 *
 * Protocol is compatible with agent-browser: {id, action, ...} → {id, success, data/error}.
 * Socket path: ~/.dassi/<session>.sock  (env: DASSI_SESSION, default: "default")
 */

import * as net from 'net';
import { setTimeout as sleep } from 'node:timers/promises';
import * as fs from 'fs';
import {
  getAppDir,
  getSocketPath,
  getReadyFile,
  getPidFile,
  validateSession,
  cleanupDaemonFiles,
  createConnectionRegistry,
  getDaemonBridgePort,
  unknownToolOutcome,
  isMainModule,
} from './dassi-shared.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

const registry = createConnectionRegistry();

// ─── WebSocket loader helper ──────────────────────────────────────────────────

/**
 * Dynamically loads the `ws` package and returns both the WebSocket client
 * class and the WebSocketServer class.
 * @returns {Promise<{ WS: typeof import('ws').WebSocket; WSServer: typeof import('ws').WebSocketServer }>}
 */
async function loadWebSocket() {
  try {
    const mod = await import('ws');
    // Reason: ws may export default or named WebSocket depending on build
    return { WS: mod.WebSocket ?? mod.default, WSServer: mod.WebSocketServer };
  } catch {
    // Fallback for environments where dynamic import of CJS doesn't work
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const mod = require('ws');
    return { WS: mod.WebSocket ?? mod.default, WSServer: mod.WebSocketServer };
  }
}

// ─── Extension response routing ──────────────────────────────────────────────

/**
 * Route responses from one extension connection back to its pending callers.
 * @param {{ ws: any; pending: Map<string, any> }} entry
 */
function setupResponseRouter(entry) {
  entry.ws.on('message', (responseData) => {
    let resp;
    try { resp = JSON.parse(responseData.toString()); } catch { return; }
    const pending = entry.pending.get(String(resp.id));
    if (!pending) return;
    entry.pending.delete(String(resp.id));
    if (resp.error) {
      pending.reject(Object.assign(new Error(resp.error.message ?? String(resp.error)), { taskId: resp.error.taskId, existingTaskId: resp.error.existingTaskId }));
    } else {
      pending.resolve(resp.result);
    }
  });
}

/**
 * Reject all pending responses for one connection (called when it closes).
 * @param {{ pending: Map<string, any> }} entry
 */
function drainPendingResponses(entry) {
  for (const [id, pending] of entry.pending) {
    pending.reject(Object.assign(new Error('Extension disconnected'), { outcome: 'unknown' }));
    entry.pending.delete(id);
  }
}

// ─── Extension server ─────────────────────────────────────────────────────────

/**
 * Register a newly connected extension socket into the registry and wire up
 * its response router + close handler.
 * @param {any} ws
 * @param {{ label: string | null; installId: string }} identity
 * @param {number} port - The port this daemon session listens on.
 * @returns {object} The registry entry.
 */
function acceptExtensionSocket(ws, identity, port) {
  const key = registry.add({ ws, label: identity.label, installId: identity.installId, port });
  const entry = registry.getByWs(ws);
  ws.on('close', () => {
    const removed = registry.remove(ws);
    drainPendingResponses(entry);
    if (removed) console.log(`[dassi-daemon] Extension "${removed.label}" disconnected`);
  });
  setupResponseRouter(entry);
  console.log(`[dassi-daemon] Extension registered as "${key}"`);
  return entry;
}

function handleRegistration(ws, data, port) {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { ws.close(); return; }
  if (msg.type !== 'register' || msg.client !== 'dassi-extension') { ws.close(); return; }
  acceptExtensionSocket(ws, { label: typeof msg.label === 'string' ? msg.label : null,
    installId: String(msg.installId ?? '') }, port);
}

// Reason: Port is configurable via DASSI_BRIDGE_PORT (single source of truth in
// getDaemonBridgePort — also seeded into launched extensions by `dassi launch`).
// Defaults to 18790, the production port. The validation guards against an
// empty/garbage env var yielding NaN, which `new WSServer({ port: NaN })` would
// silently accept and bind to a random ephemeral port.
const BRIDGE_PORT = getDaemonBridgePort();

/** Listen independently of whether Chrome is connected or signed in. */
async function startExtensionServer() {
  const { WSServer } = await loadWebSocket();
  return new Promise((resolve, reject) => {
    const wss = new WSServer({ host: '127.0.0.1', port: BRIDGE_PORT });
    wss.once('listening', () => resolve(wss));
    wss.on('error', reject);
    wss.on('connection', (ws) => {
      ws.once('message', (data) => handleRegistration(ws, data, BRIDGE_PORT));
    });
  });
}

// ─── Internal extension dispatcher ───────────────────────────────────────────

/**
 * Dispatches a single command to the Dassi extension via the persistent WS
 * connection, translating from the daemon's internal format to the extension's
 * JSON-RPC-style protocol.
 * @param {Record<string, unknown>} cmd - Command object with {id, action, target?, ...params}
 * @returns {Promise<unknown>} The extension's result value (not wrapped in success/data).
 */
export async function dispatchToExtension(cmd, reg = registry) {
  const { id, action, target = null, ...params } = cmd;
  const entry = reg.resolve(target); // throws with a helpful message if ambiguous/unknown/none
  if (!entry.ws || entry.ws.readyState !== 1 /* OPEN */) {
    throw new Error('Extension not connected');
  }

  // Reason: the extension expects JSON-RPC {id, method, params}; `target` is a
  // daemon-only routing field and must not leak into the extension params.
  const correlationId = randomUUID();
  const message = { id: correlationId, method: action ?? String(id), params };
  // The canonical tool controls execution deadlines, including for dynamic plugins.
  const timeoutMs = action === 'tool_exec' ? null : action === 'status' ? 10_000 : action === 'run' ? 65_000
    : Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? Math.min(params.timeoutMs + 10_000, 2147483647) : 65_000;

  return new Promise((resolve, reject) => {
    const timer = timeoutMs == null ? null : setTimeout(() => {
      entry.pending.delete(correlationId);
      reject(new Error(`Extension timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    entry.pending.set(correlationId, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    try { entry.ws.send(JSON.stringify(message)); } catch (error) {
      entry.pending.delete(correlationId); clearTimeout(timer); reject(error);
    }
  });
}

/** Discovery is independent of authentication and in-flight agent work. */
const session = validateSession(process.env.DASSI_SESSION ?? 'default');

export async function routeCommand(cmd, reg = registry, dispatch = dispatchToExtension) {
  let resolvedProfile;
  const call = (command) => dispatch(command, reg);
  try {
    if (['run', 'task_status', 'task_stop', 'task_result', 'task_result_file'].includes(cmd.action) && cmd.protocolVersion !== CLI_PROTOCOL_VERSION) throw new Error(cmd.protocolVersion > CLI_PROTOCOL_VERSION
      ? `This Dassi daemon is older than the CLI (daemon protocol ${CLI_PROTOCOL_VERSION}, CLI ${cmd.protocolVersion}). Stop it (kill the PID in ${getPidFile(session)}) and retry.`
      : `Incompatible CLI (protocol ${cmd.protocolVersion ?? 'none'}, this daemon speaks ${CLI_PROTOCOL_VERSION}). Run \`npm install -g @dassi_ai/cli@latest\` and retry.`);
    let target = cmd.target ?? null;
    let localTaskId = cmd.taskId;
    if (['task_status', 'task_stop', 'task_result', 'task_result_file'].includes(cmd.action) || (cmd.action === 'run' && cmd.taskId)) {
      const split = typeof cmd.taskId === 'string' ? cmd.taskId.indexOf('~') : -1;
      if (split < 1) throw new Error('Invalid task ID. Copy the ID returned by dassi run.');
      const taskProfile = cmd.taskId.slice(0, split);
      if (target && reg.resolve(target).id !== taskProfile) throw new Error('Task belongs to another profile.');
      target = taskProfile;
      localTaskId = cmd.taskId.slice(split + 1);
    }
    const discovery = ['list_profiles', 'list_tabs', 'list_groups', 'status'].includes(cmd.action);
    if (discovery) {
      const profiles = target ? [reg.resolve(target)] : reg.list();
      const profileOnly = cmd.action === 'list_profiles' || cmd.action === 'status';
      const snapshots = await Promise.all(profiles.map(async (profile) => {
        const [status, listing] = await Promise.allSettled([
          call({ id: `${cmd.id}-${profile.id}-status`, action: 'status', target: profile.id }),
          profileOnly ? Promise.resolve([]) : call({ ...cmd, id: `${cmd.id}-${profile.id}`, target: profile.id }),
        ]);
        const info = { id: profile.id, label: profile.label,
          ...(status.status === 'fulfilled' ? status.value
            : { [profileOnly ? 'error' : 'authError']: status.reason.message }),
          ...(listing.status === 'rejected' ? { error: listing.reason.message } : {}),
        };
        const items = listing.status === 'fulfilled' ? listing.value : [];
        return { profile: info, items: items.map(item => ({ ...item, profileId: profile.id, profile: profile.label,
          target: `${profile.id}:${cmd.action === 'list_tabs' ? item.tabId : item.id}` })) };
      }));
      return { id: cmd.id, success: true,
        data: cmd.action === 'list_profiles' || cmd.action === 'status' ? snapshots.map(s => s.profile) : snapshots.flatMap(s => s.items),
        profiles: snapshots.map(s => s.profile) };
    }
    const profile = reg.resolve(target);
    resolvedProfile = profile;
    if (cmd.action === 'run') {
      const status = await call({ id: `${cmd.id}-auth`, action: 'status', target: profile.id });
      if (status.cliProtocolVersion !== CLI_PROTOCOL_VERSION) throw new Error(`Update Dassi in profile "${profile.label}" to use task commands.`);
      if (!status.authenticated) throw new Error(`Sign in to Dassi in profile "${profile.label}" (${profile.id}), then retry.`);
    }
    const data = await call({ ...cmd, target: profile.id, ...(localTaskId ? { taskId: localTaskId } : {}) });
    return { id: cmd.id, success: true, data: data?.taskId
      ? { ...data, taskId: `${profile.id}~${data.taskId}`, profileId: profile.id, profile: profile.label } : data };
  } catch (error) {
    if (cmd.action === 'tool_exec' && error.outcome === 'unknown') {
      const uncertain = unknownToolOutcome(error);
      return { id: cmd.id, success: false, error: uncertain.message, outcome: uncertain.outcome };
    }
    const taskId = error.taskId && resolvedProfile ? `${resolvedProfile.id}~${error.taskId}` : undefined;
    const existingTaskId = error.existingTaskId && resolvedProfile ? `${resolvedProfile.id}~${error.existingTaskId}` : undefined;
    const checkId = taskId ?? existingTaskId;
    return { id: cmd.id, success: false, ...(taskId ? { taskId } : {}), ...(existingTaskId ? { existingTaskId } : {}), error: `${error.message}${checkId ? ` Check: dassi status '${checkId}'` : ''}` };
  }
}

// ─── Daemon setup helpers ─────────────────────────────────────────────────────

/**
 * Initializes daemon process: creates app dir, writes PID, registers shutdown handlers.
 * @param {string} session - Validated session name.
 * @returns {{ socketPath: string; readyFile: string }}
 */
function initDaemonProcess(session) {
  const appDir = getAppDir();
  const socketPath = getSocketPath(session);
  const readyFile = getReadyFile(session);

  fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
  // Reason: mkdirSync's `mode` is ignored when the directory already exists.
  // Normalize perms on every start so installs created before the mode arg
  // was added (or with a permissive umask) get tightened to owner-only.
  // The socket and ready/pid files live here; loose perms would let other
  // local users connect to the socket and dispatch CLI commands.
  try { fs.chmodSync(appDir, 0o700); } catch { /* best-effort */ }
  cleanupDaemonFiles(session);
  const pidFile = getPidFile(session);
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  try { fs.chmodSync(pidFile, 0o600); } catch { /* best-effort */ }

  const shutdown = () => {
    cleanupDaemonFiles(session);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return { socketPath, readyFile };
}

/**
 * Creates a Unix socket server that dispatches independent NDJSON commands.
 * @param {(cmd: Record<string, unknown>) => Promise<unknown>} dispatch
 * @param {string} socketPath
 * @returns {net.Server}
 */
function createSocketServer(dispatch, socketPath) {
  const server = net.createServer((socket) => {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // Reason: keep the incomplete last line in the buffer for the next data event
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let cmd;
        try {
          cmd = JSON.parse(line);
        } catch {
          socket.write(JSON.stringify({ id: 'unknown', success: false, error: 'Invalid JSON' }) + '\n');
          continue;
        }

        dispatch(cmd)
          .then((response) => {
            if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n');
          })
          .catch((err) => console.error('[dassi-daemon] dispatch error:', err));
      }
    });

    socket.on('error', () => { /* ignore client disconnects */ });
  });

  // Reason: tighten the Unix socket to owner-only so other local users on a
  // multi-user system can't connect and dispatch CLI commands. chmod has to
  // happen after the socket file is actually created — listen()'s callback
  // fires on the 'listening' event, by which point the inode exists.
  server.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch { /* best-effort */ }
  });
  return server;
}

/**
 * Sets up an idle timer that shuts down the daemon after IDLE_TIMEOUT_MS of inactivity.
 * @param {net.Server} server
 * @param {string} session
 * @param {() => number} getLastCommandAt - Returns timestamp of last command.
 */
function startIdleShutdown(server, session, getLastCommandAt) {
  // Reason: unref() prevents the timer from keeping the process alive if the
  // server is closed; the server itself keeps the process alive while running
  setInterval(() => {
    if (Date.now() - getLastCommandAt() > IDLE_TIMEOUT_MS) {
      server.close();
      cleanupDaemonFiles(session);
      process.exit(0);
    }
  }, IDLE_CHECK_INTERVAL_MS).unref();
}

// ─── Daemon entry point ───────────────────────────────────────────────────────

/**
 * Starts the two local transports and idle shutdown. Browser tasks outlive this process.
 * @returns {Promise<void>}
 */
export async function startDaemon() {
  const { socketPath, readyFile } = initDaemonProcess(session);

  try {
    await startExtensionServer();
  } catch (error) {
    fs.writeFileSync(readyFile, JSON.stringify({ status: 'error', error: error.code === 'EADDRINUSE'
      ? `Bridge port ${BRIDGE_PORT} is already in use. Use the existing daemon; --session does not select a browser.` : error.message }), { mode: 0o600 });
    process.exit(1);
  }
  let lastCommandAt = Date.now();
  let inFlight = 0;
  const server = createSocketServer(async (cmd) => {
    inFlight++;
    try {
      // Chrome reconnects every five seconds after an idle daemon exits.
      const connectDeadline = Date.now() + 6000;
      while (!registry.size() && Date.now() < connectDeadline) await sleep(100);
      return await routeCommand(cmd);
    }
    finally { inFlight--; lastCommandAt = Date.now(); }
  }, socketPath);
  await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
  fs.writeFileSync(readyFile, JSON.stringify({ status: 'ok', protocolVersion: CLI_PROTOCOL_VERSION }), { mode: 0o600 });
  startIdleShutdown(server, session, () => inFlight ? Date.now() : lastCommandAt);
}

// ── Entry point ───────────────────────────────────────────────────────────────
// Reason: guard allows this file to be imported by tests without starting the daemon
if (isMainModule(import.meta.url, process.argv[1])) {
  startDaemon().catch((err) => {
    console.error('[dassi-daemon] fatal:', err.message);
    process.exit(1);
  });
}
