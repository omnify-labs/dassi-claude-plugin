/**
 * Tool command parsers for the Dassi CLI.
 *
 * Parses targeting and generic tool envelopes. Browser names and parameters
 * are discovered from the connected extension, never translated here.
 */

/**
 * Appended to rejections that a pre-npm Claude Code plugin's skill can trigger
 * (retired commands, grouped `open`): Claude Code leaves auto-update off for
 * third-party marketplaces, so this error is how such an install learns about
 * the npm-packaged plugin.
 */
export const OUTDATED_PLUGIN_HINT =
  'If a skill told you to run this command, the Dassi plugin is outdated: run `claude plugin update dassi@dassi` in a shell (or in Claude Code: /plugin, Installed, dassi, Update now), then restart Claude Code.';

/**
 * Strict integer parser that rejects partial matches like "7abc".
 * `parseInt('7abc', 10)` returns 7 — a silent data loss bug.
 * This validator requires the entire string to be a valid integer.
 * @param {string} value  Raw string from CLI
 * @param {string} flag   Flag name for error messages (e.g. '--tab')
 * @returns {number}
 */
export function parseStrictInt(value, flag) {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${flag} must be a number, got "${value}"`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${flag} value out of range: "${value}"`);
  }
  return n;
}

export function parseTarget(value, flag) {
  const match = /^([a-zA-Z0-9_-]+):(-?\d+)$/.exec(value);
  return match ? { id: parseStrictInt(match[2], flag), profileTarget: match[1] }
    : { id: parseStrictInt(value, flag) };
}

export function parseWait(value) {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (!match) throw new Error('--wait requires a duration such as 30s, 10m, or 1h');
  const ms = Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] ?? 'ms']);
  if (!Number.isSafeInteger(ms) || ms > 2147483647) throw new Error('--wait is out of range');
  return ms;
}

/**
 * Resolve target: must pass exactly one of --tab, --group, --group-title.
 * Returns { tabId } | { groupId } | { groupTitle }.
 * @param {string} command
 * @param {string[]} args
 * @param {(args: string[], flag: string) => string | undefined} getFlag
 * @returns {{ tabId: number } | { groupId: number } | { groupTitle: string }}
 */
export function requireTarget(command, args, getFlag) {
  const tabRaw = getFlag(args, '--tab');
  const groupRaw = getFlag(args, '--group');
  const groupTitle = getFlag(args, '--group-title');
  const count = [tabRaw, groupRaw, groupTitle].filter((x) => x !== undefined).length;
  if (count === 0) throw new Error(`${command} requires --tab <id>, --group <id>, or --group-title <name>`);
  if (count > 1) throw new Error(`cannot combine --tab/--group/--group-title — pick one`);
  // Reason: empty/whitespace group titles silently match untitled groups (title: ""),
  // which is almost certainly not what the user intended.
  if (groupTitle !== undefined && groupTitle.trim() === '') {
    throw new Error('--group-title requires a non-empty name');
  }
  if (tabRaw !== undefined) {
    const { id: tabId, ...profile } = parseTarget(tabRaw, '--tab');
    return { tabId, ...profile };
  }
  if (groupRaw !== undefined) {
    const { id: groupId, ...profile } = parseTarget(groupRaw, '--group');
    return { groupId, ...profile };
  }
  return { groupTitle };
}

/** Parse the generic catalog/call interface; tool names and schemas belong to Chrome. */
export function parseToolCommand(command, args, getFlag, consumeFlag) {
  if (command === 'tools') {
    const tabRaw = getFlag(args, '--tab');
    const target = tabRaw === undefined ? {} : parseTarget(tabRaw, '--tab');
    const name = args[0] && !args[0].startsWith('-') ? args.shift() : undefined;
    return { __bridgeAction: 'list_tools', ...(name ? { name } : {}),
      ...(tabRaw === undefined ? {} : { tabId: target.id, profileTarget: target.profileTarget }) };
  }
  if (command === 'call') {
    const tool = args.shift();
    if (!tool || tool.startsWith('-')) throw new Error('call requires a tool name from dassi tools');
    const target = requireTarget('call', args, getFlag);
    const raw = getFlag(args, '--args') ?? '{}';
    let toolParams;
    try { toolParams = JSON.parse(raw); } catch { throw new Error('--args must be a JSON object'); }
    if (!toolParams || typeof toolParams !== 'object' || Array.isArray(toolParams)) throw new Error('--args must be a JSON object');
    const output = getFlag(args, '--output') ?? getFlag(args, '-o');
    return { tool, ...target, toolParams, ...(output ? { _output: output } : {}) };
  }
  if (command === 'open') {
    const windowRaw = getFlag(args, '--window');
    if (windowRaw === undefined) {
      throw new Error(`open requires --window <id>. For browser tools, use dassi tools and dassi call. ${OUTDATED_PLUGIN_HINT}`);
    }
    for (const flag of ['--tab', '--group', '--group-title']) {
      if (args.includes(flag)) throw new Error(`open --window cannot be combined with ${flag}`);
    }
    const active = consumeFlag(args, '--foreground');
    const url = args[0] && !args[0].startsWith('-') ? args.shift() : 'about:blank';
    return { __bridgeAction: 'open_tab', url, windowId: parseStrictInt(windowRaw, '--window'), active };
  }
  return null;
}
