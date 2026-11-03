/**
 * Group expansion helpers for the Dassi CLI.
 * Converts a group reference (groupId or groupTitle) into member tab IDs
 * and fans out a command across all of them sequentially.
 */

import * as path from 'path';
import { randomUUID } from 'node:crypto';

/**
 * Inject `tabId` into a filename before the extension so multi-tab fan-out
 * produces N unique files instead of overwriting the same path.
 * E.g. `uniquifyOutputForTab('shot.png', 42)` → `'shot-tab42.png'`.
 * Returns the original output unchanged if it's null/undefined.
 *
 * Reason: split dirname/basename first so dotted directory names (e.g.
 * `/tmp/v1.2/shot`) don't cause the tab-id to land inside the dir segment.
 * @param {string | null | undefined} output
 * @param {number} tabId
 * @returns {string | null | undefined}
 */
export function uniquifyOutputForTab(output, tabId) {
  if (!output) return output;
  const dir = path.dirname(output);
  const base = path.basename(output);
  const dot = base.lastIndexOf('.');
  const newBase = dot === -1 ? `${base}-tab${tabId}` : `${base.slice(0, dot)}-tab${tabId}${base.slice(dot)}`;
  // Reason: preserve the caller's shape — if the user passed a plain filename
  // (no dir prefix), don't silently prepend './' to the result. If they passed
  // './foo', restore the './' that path.join('.', ...) would strip.
  if (dir === '.') {
    return output.startsWith('./') ? `./${newBase}` : newBase;
  }
  return path.join(dir, newBase);
}

/**
 * Expand a group reference (groupId or groupTitle) to member tab IDs.
 * Calls list_groups and list_tabs against the daemon to resolve.
 * @param {string} socketPath  Daemon Unix socket
 * @param {{ groupId?: number; groupTitle?: string }} ref
 * @param {(socketPath: string, command: object) => Promise<{success:boolean,data?:any,error?:string}>} sendFn - send function (required, injectable for tests)
 * @param {string | null} [target] - Profile label to route the resolving queries to (when --profile is set).
 * @returns {Promise<number[]>}  Member tab IDs (order: ascending)
 */
export async function expandGroupToTabIds(socketPath, ref, sendFn, target = null) {
  // Reason: route the group-resolving queries to the same profile the command
  // targets, so resolution isn't ambiguous when multiple profiles are connected.
  const targetField = target ? { target } : {};
  // Reason: pass all:true (flat, NOT nested under `params`) so --group /
  // --group-title can resolve against any Chrome tab group, not just groups
  // dassi currently has open. The daemon's dispatchToExtension does
  // `{ id, action, ...rest } = cmd` and forwards `rest` as JSON-RPC params,
  // so nesting under `params` would arrive at the extension as
  // `params.params.all` — and the filter would NOT bypass.
  const groupsResp = await sendFn(socketPath, { id: `cli_lg_${randomUUID()}`, action: 'list_groups', all: true, ...targetField });
  if (!groupsResp.success) throw new Error(`Failed to list groups: ${groupsResp.error ?? 'unknown'}`);
  if (!target && groupsResp.profiles?.length > 1) throw new Error('Choose a profile with --profile <id>, or copy a group target from dassi list-groups.');
  const groups = /** @type {Array<{id:number;title:string;windowId:number}>} */ (groupsResp.data ?? []);

  let groupId;
  if (ref.groupId !== undefined) {
    groupId = ref.groupId;
    if (!groups.find((g) => g.id === groupId)) {
      throw new Error(`No group with id ${groupId}`);
    }
  } else if (ref.groupTitle !== undefined) {
    const matches = groups.filter((g) => g.title === ref.groupTitle);
    if (matches.length === 0) throw new Error(`No group titled "${ref.groupTitle}"`);
    if (matches.length > 1) {
      const ids = matches.map((m) => `id=${m.id} (window=${m.windowId})`).join(', ');
      throw new Error(`Ambiguous group title "${ref.groupTitle}". Matches: ${ids}. Use --group <id>.`);
    }
    groupId = matches[0].id;
  } else {
    throw new Error('expandGroupToTabIds: pass groupId or groupTitle');
  }

  const tabsResp = await sendFn(socketPath, { id: `cli_lt_${randomUUID()}`, action: 'list_tabs', all: true, ...targetField });
  if (!tabsResp.success) throw new Error(`Failed to list tabs: ${tabsResp.error ?? 'unknown'}`);
  const tabs = /** @type {Array<{tabId:number;groupId:number}>} */ (tabsResp.data ?? []);
  const memberIds = tabs.filter((t) => t.groupId === groupId).map((t) => t.tabId);

  if (memberIds.length === 0) throw new Error(`Group ${groupId} has no tabs`);
  return memberIds;
}

/**
 * Collects per-tab responses into a JSON array string for --json mode.
 * Each entry is `{ tabId, response }` where response is the raw daemon
 * response object so callers can inspect success/data/error.
 * @param {Array<{tabId: number, response: {success:boolean,data?:any,error?:string}}>} results
 * @returns {string}
 */
export function formatGroupJsonResults(results) {
  return JSON.stringify(results.map(({ tabId, response }) => ({ tabId, response })));
}

/**
 * Dispatch one child action against a single tab.
 * Builds per-tab params (uniquifying _output when fanning out) and calls sendFn.
 *
 * @param {string} socketPath
 * @param {string} action
 * @param {Record<string, unknown>} childBase  Params with group fields already stripped
 * @param {number} tabId
 * @param {boolean} multiTab  True when >1 tab in the expansion (triggers output uniquification)
 * @param {(socketPath: string, command: object) => Promise<{success:boolean,data?:any,error?:string}>} sendFn
 * @param {string | null} [target] - Profile label to route the child command to (when --profile is set).
 * @returns {Promise<{tabId: number, response: {success:boolean,data?:any,error?:string}, childParams: object}>}
 */
async function dispatchChildForTab(socketPath, action, childBase, tabId, multiTab, sendFn, target = null) {
  // Reason: uniquify _output per tab when fanning out so each file write targets a distinct path
  const perTabOutput =
    multiTab && childBase._output ? uniquifyOutputForTab(childBase._output, tabId) : childBase._output;
  const childParams = { ...childBase, tabId, ...(perTabOutput !== childBase._output ? { _output: perTabOutput } : {}) };
  // Reason: include target only when set so the fan-out routes to the chosen profile.
  const response = await sendFn(socketPath, { id: `cli_${randomUUID()}`, action, ...childParams, ...(target ? { target } : {}) });
  return { tabId, response, childParams };
}

/**
 * Expands a group reference, then fans out the given action sequentially across
 * all member tabs. Logs progress to stderr/stdout.
 *
 * Non-json mode: prints `── tab N ──` dividers + formatted output per tab.
 * JSON mode: collects all responses, emits a single JSON array on stdout.
 *
 * When multiple tabs are targeted and `childBase._output` is set, each tab
 * gets a uniquified output path (e.g. `shot.png` → `shot-tab42.png`) so
 * files don't overwrite each other.
 *
 * @param {string} socketPath
 * @param {string} action
 * @param {Record<string, unknown>} params  Must include groupId or groupTitle
 * @param {boolean} json
 * @param {(socketPath: string, command: object) => Promise<{success:boolean,data?:any,error?:string}>} sendFn
 * @param {(action: string, response: object, json: boolean, params: object) => string} formatFn
 * @param {string | null} [target] - Profile label to route every query/child command to (when --profile is set).
 * @returns {Promise<boolean>}  true if all child calls succeeded, false if any failed
 */
export async function runWithGroupExpansion(socketPath, action, params, json, sendFn, formatFn, target = null) {
  const tabIds = await expandGroupToTabIds(
    socketPath,
    { groupId: params.groupId, groupTitle: params.groupTitle },
    sendFn,
    target,
  );
  // One group is one conversation: submit an agent prompt once for the whole workspace.
  if (action === 'run') {
    const { groupId: _group, groupTitle: _title, ...base } = params;
    const { response } = await dispatchChildForTab(socketPath, action, base, tabIds[0], false, sendFn, target);
    const output = formatFn(action, response, json, base);
    if (!json && !response.success) console.error(output);
    else console.log(output);
    return response.success && !['failed', 'stopped'].includes(response.data?.status);
  }
  // Reason: always on stderr so it doesn't pollute JSON output on stdout
  console.error(`Running on ${tabIds.length} tab${tabIds.length === 1 ? '' : 's'}: ${tabIds.join(', ')}`);
  // Strip group fields; substitute tabId per child call
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { groupId: _g, groupTitle: _gt, ...childBase } = params;
  const multiTab = tabIds.length > 1;
  const results = [];
  let allOk = true;

  for (const tabId of tabIds) {
    const { response, childParams } = await dispatchChildForTab(socketPath, action, childBase, tabId, multiTab, sendFn, target);
    if (!response.success) allOk = false;
    if (json) {
      // Reason: collect for a single JSON array emission after the loop
      results.push({ tabId, response });
    } else {
      console.log(`\n── tab ${tabId} ──`);
      console.log(formatFn(action, response, json, childParams));
    }
  }

  // Reason: JSON mode — emit one array on stdout so stdout is valid JSON
  if (json) console.log(formatGroupJsonResults(results));
  return allOk;
}
