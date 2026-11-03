/**
 * CDP-over-pipe transport for `dassi launch`. Chrome 137+ branded builds disabled the
 * `--load-extension` flag, so the dist is installed at runtime via the
 * `Extensions.loadUnpacked` CDP command over `--remote-debugging-pipe`. This module is
 * the minimal, dependency-free client for that exchange.
 *
 * PRIVATE (underscore-prefixed): import these symbols from `launch.mjs`, which re-exports
 * them. `launch.mjs` is the single public gateway for the launch module.
 */

/**
 * Minimal CDP client over Chrome's `--remote-debugging-pipe` transport. Messages are
 * JSON framed with a trailing NUL (`\0`) byte; replies are matched back by `id`.
 * No external deps — the CLI only needs to issue a couple of commands at launch.
 * @param {{ writable: import('stream').Writable; readable: import('stream').Readable }} pipe
 *   `writable` = Chrome's CDP input (fd 3); `readable` = Chrome's CDP output (fd 4).
 * @returns {{ send: (method: string, params?: object) => Promise<object>; dispose: () => void }}
 */
export function cdpPipeClient({ writable, readable }) {
  let nextId = 1;
  const pending = new Map();
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let nul;
    // Reason: a single chunk may carry several NUL-delimited frames, or a partial one —
    // drain every complete frame and keep the remainder buffered for the next chunk.
    while ((nul = buf.indexOf(0)) !== -1) {
      const frame = buf.subarray(0, nul).toString('utf8');
      buf = buf.subarray(nul + 1);
      if (!frame) continue;
      let msg;
      try { msg = JSON.parse(frame); } catch { continue; }
      const entry = msg.id != null ? pending.get(msg.id) : undefined;
      if (!entry) continue; // an event, or a reply we're not waiting on
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || `CDP error ${msg.error.code ?? ''}`));
      else entry.resolve(msg.result ?? {});
    }
  };
  readable.on('data', onData);
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        writable.write(`${JSON.stringify({ id, method, params })}\0`);
      });
    },
    dispose() {
      readable.off('data', onData);
      for (const { reject } of pending.values()) reject(new Error('CDP pipe disposed'));
      pending.clear();
    },
  };
}

/**
 * Install the unpacked dist into the just-launched Chrome over the CDP pipe, then
 * open the seed options page (so the extension persists label+bridgePort and dials
 * the daemon). This is the runtime replacement for the disabled `--load-extension`.
 *
 * On success the pipe is left OPEN (still draining Chrome's CDP output so its buffer
 * can't fill) and a `dispose()` is returned — the caller MUST call it once the
 * profile has registered. Reason: branded Chrome discards an automation-created tab
 * (the seed page) if the debugging pipe closes before it finishes loading; keeping
 * the pipe alive until the bridge registers lets the seed run.
 * @param {{ child: import('child_process').ChildProcess; distPath: string; label: string; bridgePort: number; timeoutMs?: number }} opts
 * @returns {Promise<{ id: string; dispose: () => void }>} the loaded extension id + a pipe closer.
 * @throws if the pipe fds are missing or a CDP command errors/times out.
 */
export async function loadExtensionOverPipe({ child, distPath, label, bridgePort, timeoutMs = 15000 }) {
  const writable = child.stdio?.[3];
  const readable = child.stdio?.[4];
  if (!writable || !readable) {
    throw new Error('Chrome was not spawned with a CDP pipe (fds 3/4 missing).');
  }
  const cdp = cdpPipeClient({ writable, readable });
  // Reason: capture + clear the timer so a fast-resolving CDP command doesn't leave a
  // pending setTimeout keeping the event loop alive for the full timeoutMs.
  const withTimeout = (p, what) => {
    let timer;
    const timeout = new Promise((_, r) => {
      timer = setTimeout(() => r(new Error(`CDP ${what} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  };
  try {
    const loaded = await withTimeout(cdp.send('Extensions.loadUnpacked', { path: distPath }), 'Extensions.loadUnpacked');
    const id = loaded.id;
    if (!id) throw new Error('Extensions.loadUnpacked returned no extension id.');
    // Reason: open the seed page AFTER the extension exists (it isn't loaded at
    // startup anymore), so the options page persists label+bridgePort and the
    // extension's bridge connects to the daemon's actual port.
    const seed = `chrome-extension://${id}/options.html?label=${encodeURIComponent(label)}&bridgePort=${bridgePort}`;
    await withTimeout(cdp.send('Target.createTarget', { url: seed }), 'Target.createTarget');
    return { id, dispose: () => cdp.dispose() };
  } catch (err) {
    cdp.dispose();
    throw err;
  }
}
