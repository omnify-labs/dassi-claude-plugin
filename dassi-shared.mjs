/**
 * Dassi CLI Shared Utilities
 *
 * Pure helper functions shared between the CLI client (dassi.mjs) and the
 * daemon process (dassi-daemon.mjs). Includes path resolution, session
 * validation, daemon lifecycle helpers, readiness, and browser identity.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

/** Node resolves import.meta.url through symlinks, but leaves argv[1] unchanged. */
export function isMainModule(metaUrl, argvPath) {
  if (!argvPath) return false;
  let resolvedPath = argvPath;
  try { resolvedPath = fs.realpathSync(argvPath); } catch { /* stdin and imports may have no file */ }
  return metaUrl === pathToFileURL(resolvedPath).href;
}

const PACKAGE = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'));
export const CLI_VERSION = PACKAGE.version;
/** Lives in package.json so the extension release gate can read it from npm (`npm view … dassi.protocol`) without downloading the tarball. */
export const CLI_PROTOCOL_VERSION = PACKAGE.dassi.protocol;

// ─── Extension identity ───────────────────────────────────────────────────────

/**
 * Stable Dassi extension ID. The extension manifest ships a fixed `key`, so the
 * unpacked dev build gets the SAME id as the Web Store build regardless of load
 * path — letting `dassi launch` open the extension's options page directly.
 */
export const DASSI_EXTENSION_ID = 'bjcngahpcjeililljmfegmlanlpgibdi';
export const CHROME_WEB_STORE_URL = `https://chromewebstore.google.com/detail/dassi-ai-browser-agent-fo/${DASSI_EXTENSION_ID}`;

// ─── Path helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the base directory for dassi socket/pid/ready files.
 * Priority: XDG_RUNTIME_DIR > ~/.dassi
 * @returns {string}
 */
export function getAppDir() {
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'dassi');
  }
  return path.join(os.homedir(), '.dassi');
}

/**
 * Returns the Unix socket path for the given session.
 * @param {string} session
 * @returns {string}
 */
export function getSocketPath(session) {
  return path.join(getAppDir(), `${session}.sock`);
}

/**
 * Returns the PID file path for the given session.
 * @param {string} session
 * @returns {string}
 */
export function getPidFile(session) {
  return path.join(getAppDir(), `${session}.pid`);
}

/**
 * Returns the ready file path for the given session.
 * Written when the local command transport is listening.
 * @param {string} session
 * @returns {string}
 */
export function getReadyFile(session) {
  return path.join(getAppDir(), `${session}.ready`);
}

/**
 * Resolve the bridge (WebSocket) port the daemon listens on. Configurable via
 * DASSI_BRIDGE_PORT (e.g. the benchmark harness uses 18791 to isolate from a
 * developer's real Chrome on 18790); falls back to 18790 on empty/invalid input.
 * Single source of truth shared by the daemon (which binds it) and `dassi launch`
 * (which seeds it into the launched extension so it connects to the same port).
 * @param {Record<string, string|undefined>} [env]
 * @returns {number} A valid TCP port (1–65535).
 */
export const DEFAULT_BRIDGE_PORT = 18790;

export function getDaemonBridgePort(env = process.env) {
  const p = parseInt(env.DASSI_BRIDGE_PORT ?? '', 10);
  return Number.isInteger(p) && p > 0 && p <= 65535 ? p : DEFAULT_BRIDGE_PORT;
}

/**
 * Path to the JSON file tracking Chrome instances started by `dassi launch`,
 * so `dassi launch --stop` can find and kill them.
 * @returns {string} Absolute path to launches.json under the app dir.
 */
export function getLaunchesFile() {
  return path.join(getAppDir(), 'launches.json');
}

// ─── Session validation ───────────────────────────────────────────────────────

/**
 * Validates a session name to prevent path traversal.
 * Only allows alphanumeric characters, hyphens, and underscores.
 * @param {string} session
 * @returns {string} The validated session name.
 * @throws {Error} If the session name contains unsafe characters.
 */
export function validateSession(session) {
  if (!/^[a-zA-Z0-9_-]+$/.test(session)) {
    throw new Error(`Invalid session name: "${session}". Only alphanumeric, hyphen, and underscore allowed.`);
  }
  return session;
}

// ─── Daemon lifecycle helpers ─────────────────────────────────────────────────

/**
 * Removes socket, PID, and ready files for the given session.
 * Called on stale daemon detection or on clean shutdown.
 * @param {string} session
 */
export function cleanupDaemonFiles(session) {
  for (const filePath of [getSocketPath(session), getPidFile(session), getReadyFile(session)]) {
    try { fs.unlinkSync(filePath); } catch { /* ignore missing files */ }
  }
}

/**
 * Checks whether the daemon is already running for the given session.
 * Reads the PID file and sends signal 0 to verify the process is alive.
 * Cleans up stale files if the process is dead.
 * @param {string} session
 * @returns {boolean}
 */
export function isDaemonRunning(session) {
  const pidFile = getPidFile(session);
  if (!fs.existsSync(pidFile)) return false;

  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    // Reason: signal 0 checks process existence without delivering a real signal
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    // Process does not exist — clean up stale files
    cleanupDaemonFiles(session);
    return false;
  }
}

// ─── Readiness payload helpers ───────────────────────────────────────────────

/**
 * Parses the ready file content into a status object.
 * Throws for incomplete writes so startup can keep polling.
 * @param {string} raw
 * @returns {{ status: string; [key: string]: unknown }}
 */
export function parseReadyPayload(raw) {
  const payload = JSON.parse(raw);
  if (!payload || typeof payload.status !== 'string') throw new Error('Invalid daemon readiness file');
  return payload;
}

// ─── Connected browser installations ──────────────────────────────────────────

/** A lost transport is not evidence that a browser action failed or stopped. */
export function unknownToolOutcome(error) {
  return Object.assign(new Error(`${error.message} Tool outcome unknown; it may still be running. Inspect the browser before retrying.`), { outcome: 'unknown' });
}

export function createConnectionRegistry() {
  const conns = new Map();
  return {
    add({ ws, label, installId, port }) {
      const id = installId || `legacy-${port}`;
      const old = conns.get(id);
      if (old) {
        for (const pending of old.pending.values()) pending.reject(Object.assign(new Error('Extension reconnected; check the existing task before retrying.'), { outcome: 'unknown' }));
        old.ws.close();
      }
      conns.set(id, { id, installId, label: label?.trim() || id, port, ws, pending: new Map() });
      return id;
    },
    remove(ws) {
      const entry = this.getByWs(ws);
      if (entry) conns.delete(entry.id);
      return entry ?? null;
    },
    getByWs(ws) { return [...conns.values()].find((entry) => entry.ws === ws) ?? null; },
    resolve(target) {
      if (!conns.size) throw new Error('No extension connected. Open Dassi in Chrome, then retry.');
      if (target == null) {
        if (conns.size === 1) return [...conns.values()][0];
        throw new Error(`Multiple profiles connected (${[...conns.values()].map(e => e.label).join(', ')}). Copy a target from dassi list-tabs or use --profile <id>.`);
      }
      if (conns.has(String(target))) return conns.get(String(target));
      const matches = [...conns.values()].filter(entry => entry.label === target);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new Error(`Profile name "${target}" is ambiguous. Use a profile ID from dassi list-profiles.`);
      throw new Error(`Unknown profile "${target}". Connected: ${[...conns.values()].map(e => `${e.label} (${e.id})`).join(', ')}`);
    },
    list() { return [...conns.values()].map(({ id, label, port }) => ({ id, label, port })); },
    size() { return conns.size; },
  };
}
