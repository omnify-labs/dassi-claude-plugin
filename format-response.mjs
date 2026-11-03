/**
 * Response formatting for the Dassi CLI.
 * Converts daemon responses into human-readable terminal output.
 */

import * as fs from 'fs';

/** @param {{ success: boolean; data?: unknown }} response */
function formatListTabs(response) {
  const tabs = /** @type {Array<{tabId:number;title:string;url:string;active:boolean}>} */ (response.data ?? []);
  if (tabs.length === 0) return '(no open tabs — open Dassi in Chrome, then retry)';
  const header = 'PROFILE          TARGET                                           TITLE / URL';
  const rows = tabs.map((t) => {
    const id = String(t.tabId).padEnd(7);
    const prefix = t.active ? '* ' : '  ';
    const title = (prefix + t.title).slice(0, 42).padEnd(42);
    return `${(t.profile ?? '').padEnd(16)} ${(t.target ?? id).padEnd(48)} ${title}  ${t.url}`;
  });
  return [header, ...rows].join('\n');
}

/** @param {{ success: boolean; data?: unknown }} response */
function formatListGroups(response) {
  const groups = /** @type {Array<{id:number;title:string;color:string;windowId:number;tabCount:number}>} */ (response.data ?? []);
  if (groups.length === 0) return '(no tab groups)';
  const header = 'PROFILE          TARGET                                           COLOR    TABS   WINDOW   TITLE';
  const rows = groups.map((g) => {
    const id = String(g.id).padEnd(9);
    const color = (g.color ?? '').padEnd(8);
    const tabs = String(g.tabCount).padEnd(6);
    const win = String(g.windowId).padEnd(8);
    return `${(g.profile ?? '').padEnd(16)} ${(g.target ?? id).padEnd(48)} ${color} ${tabs} ${win} ${g.title || '(untitled)'}`;
  });
  return [header, ...rows].join('\n');
}

/** @param {{ success: boolean; data?: unknown }} response */
function formatRun(response) {
  const d = response.data ?? {};
  if (!d.taskId) return `${d.answer ?? ''}\n(${d.toolCalls ?? 0} tool calls, ${((d.durationMs ?? 0) / 1000).toFixed(1)}s)`;
  const status = d.status === 'completed' ? 'Run finished' : d.status[0].toUpperCase() + d.status.slice(1);
  const lines = [`${status} · ${Math.floor((d.durationMs ?? 0) / 60000)} minutes · ${d.profile ?? ''}`, `Task: ${d.taskId}`];
  if (d.answer) lines.push(d.answer);
  if (d.reason) lines.push(d.reason);
  if (d.export) lines.push(`Report: ${d.export.report}`, `Result: ${d.export.manifest}`);
  if (d.assets) lines.push(`${d.assets.filter(a => a.kind === 'screenshot').length} images, ${d.assets.filter(a => a.kind === 'file').length} files`);
  if (d.warnings?.length) lines.push(...d.warnings.map(warning => `Warning: ${warning}`));
  if (d.resultCommand) lines.push(`Retrieve: ${d.resultCommand}`);
  if (d.status === 'running' || d.status === 'stopping') lines.push(`Check: dassi status '${d.taskId}'`, `Stop:  dassi stop '${d.taskId}'`);
  return lines.join('\n');
}

/**
 * Formats tool_exec and panel_screenshot results.
 * Tool results from pi-agent-core have a { content: [{type, text/data}] } shape.
 * @param {{ success: boolean; data?: unknown }} response
 * @param {Record<string, unknown>} [params]
 * @param {string} action
 */
function formatToolExec(response, params, action) {
  const data = response.data;
  if (data && typeof data === 'object' && Array.isArray(data.content)) {
    const defaultPrefix = action === 'panel_screenshot' ? 'panel-screenshot' : 'screenshot';
    const parts = [];
    for (const item of data.content) {
      if (item.type === 'text') {
        parts.push(item.text);
      } else if (item.type === 'image' && item.data) {
        // Reason: Save image to file like agent-browser does. Use _output param if provided,
        // otherwise generate a timestamped filename.
        const ext = item.mimeType === 'image/png' ? 'png' : 'jpg';
        const outputPath = params?._output ?? `${defaultPrefix}-${Date.now()}.${ext}`;
        try {
          fs.writeFileSync(outputPath, Buffer.from(item.data, 'base64'));
          parts.push(`Saved ${outputPath}`);
        } catch (err) {
          parts.push(`[Failed to save image: ${err.message}]`);
        }
      } else {
        parts.push(`[${item.type ?? 'unknown'} content omitted]`);
      }
    }
    return parts.join('\n');
  }
  return JSON.stringify(data, null, 2);
}

/**
 * @param {{ success: boolean; data?: unknown }} response
 * @param {Record<string, unknown>} [params]
 */
function formatExportLogs(response, params) {
  const data = response.data;
  const logsJson = JSON.stringify(data, null, 2);
  const outputPath = params?.output ?? `dassi-debug-logs-${Date.now()}.json`;
  try {
    fs.writeFileSync(outputPath, logsJson);
    const sources = data?.sources ?? {};
    const total = data?.totalEntries ?? '?';
    const summary = Object.entries(sources).map(([k, v]) => `${k}=${v}`).join(', ');
    return `✓  Saved ${total} log entries to ${outputPath}\n   Sources: ${summary}`;
  } catch (err) {
    return `❌  Failed to save: ${err.message}\n${logsJson}`;
  }
}

/** @param {{ success: boolean; data?: unknown }} response */
function formatListProfiles(response) {
  const rows = /** @type {Array<{label:string;port:number}>} */ (response.data ?? []);
  if (rows.length === 0) return '(no profiles connected)';
  const header = 'PROFILE          ID                                    STATUS';
  const body = rows.map((r) => `${String(r.label).padEnd(16)} ${String(r.id ?? r.port).padEnd(37)} ${r.error ?? (r.authenticated ? 'Signed in' : 'Sign in required')}`);
  return [header, ...body].join('\n');
}

/** @param {{ success: boolean; data?: unknown }} response */
function formatStatus(response) {
  if (Array.isArray(response.data)) return formatListProfiles(response);
  const d = /** @type {{ authenticated?: boolean; email?: string | null }} */ (response.data ?? {});
  if (d.authenticated) {
    return `✓  Signed in as ${d.email}`;
  }
  return '✗  Not signed in';
}

// Reason: dispatch table keeps formatResponse small (~10 lines) and lets each
// action's formatting logic live in a focused, ≤40-line helper.
const FORMATTERS = {
  list_tabs: (r, _p, _a) => formatListTabs(r),
  list_groups: (r, _p, _a) => formatListGroups(r),
  run: (r, _p, _a) => formatRun(r),
  task_status: (r) => formatRun(r),
  task_result: (r) => formatRun(r),
  task_stop: (r) => formatRun(r),
  list_tools: (r) => Array.isArray(r.data) ? r.data.map(t => `${t.name}  ${t.description}`).join('\n') : JSON.stringify(r.data, null, 2),
  tool_exec: (r, p, a) => formatToolExec(r, p, a),
  panel_screenshot: (r, p, a) => formatToolExec(r, p, a),
  export_logs: (r, p, _a) => formatExportLogs(r, p),
  status: (r, _p, _a) => formatStatus(r),
  list_profiles: (r, _p, _a) => formatListProfiles(r),
};

/**
 * Formats a daemon response for terminal output.
 * @param {string} action
 * @param {{ success: boolean; data?: unknown; error?: string }} response
 * @param {boolean} rawJson  When true, outputs the raw JSON response
 * @param {Record<string, unknown>} [params]  Original command params (used for screenshot output path)
 * @returns {string}
 */
export function formatResponse(action, response, rawJson, params) {
  if (rawJson) return JSON.stringify(response);
  if (!response.success) return `❌  Error: ${response.error ?? 'Unknown error'}${response.data?.export ? `\nReport: ${response.data.export.report}` : ''}${response.taskId ? `\nTask: ${response.taskId}` : ''}`;
  const formatter = FORMATTERS[action];
  if (formatter) {
    const output = formatter(response, params, action);
    const errors = ['list_tabs', 'list_groups'].includes(action)
      ? (response.profiles ?? []).flatMap(p => [p.error, p.authError].filter(Boolean).map(error => `${p.label} (${p.id}): ${error}`))
      : [];
    return [output, ...errors].join('\n');
  }
  // Default: pretty-print data
  return JSON.stringify(response.data, null, 2);
}
