---
name: pick-tabs
description: Use when a task requires acting on one or more Chrome tabs but the
  target tab(s) cannot be determined from the user message. Lists open tabs and
  tab groups via the dassi CLI and asks the user to pick. Returns the resolved
  tab IDs.
---

# dassi:pick-tabs

Reusable tab/group picker for the Dassi Chrome extension. Other skills (notably `dassi:operate`) compose with this; users can also invoke it directly to see what's open.

## When to invoke

- User asked for a browser action but did not name a specific tab or URL
- User referenced "these tabs," "all my tabs," "those tabs," or similar plural language
- User named a group title that returns 0 or >1 matches from `dassi list-groups`
- Another skill (e.g. `dassi:operate`) explicitly delegates to the picker
- User explicitly says "let me pick" / "show tabs" / "pick again"

## Skip when

- User explicitly named a tab by URL, title, or tab id
- User said "this tab" / "current tab" / "active tab" — use the active tab without asking
- A prior turn in this conversation already resolved a selection AND the user's new message does not reference a different tab/group

## Process

1. **Call the CLI sequentially** (parallel startup would race the daemon bootstrap):

   ```bash
   dassi list-tabs --json
   dassi list-groups --json
   ```

   First call spawns the daemon if needed; second reuses it. Total latency is dominated by daemon startup (~1s first run, instant after).

2. **Render a markdown list:**

   For each group, list its name + color + member tabs (indented, using the real Chrome `tabId` in brackets). Then list ungrouped tabs.

   ```
   Open browser:

   Research (blue, 3 tabs)
     [1847] MacBook Air — apple.com/macbook-air
     [1853] AirPods — apple.com/airpods
     [1861] iPad Pro — apple.com/ipad-pro
   Reading (orange, 2 tabs)
     [1872] Gmail Inbox
     [1899] NYTimes
   (ungrouped)
     [1923] Twitter
     [1978] ChatGPT
     [2014] Settings

   Reply with: comma-separated tab IDs ("1847,1853"), a group name ("Research"),
   a description ("the Apple ones"), or "all".
   ```

3. **Ask the user with free-text input** (do NOT use `AskUserQuestion` — it caps at 4 options, and users routinely have more open tabs).

4. **Parse the reply:**

   | Pattern | Action |
   |---|---|
   | Comma- or space-separated integers (e.g. `1847,1853,1861`) | Treat as Chrome tab IDs directly; cross-check each against `list-tabs --json`. If any supplied IDs are NOT present, surface a one-line warning to the user before returning (e.g., "Note: tab IDs 9999, 8888 were not found and will be skipped."), and proceed with the verified set. If ALL supplied IDs are missing, stop and ask the user to re-pick. |
   | Range like `1847-1861` | NOT supported — Chrome tab IDs are not sequential. If the user uses range syntax, ask them to switch to comma-separated. |
   | Exact group name (case-insensitive) | Return all tab IDs in that group from `list-groups --json` + `list-tabs --json`. |
   | Substring match against tab titles/URLs ("Apple ones") | Match against `list-tabs --json` data; confirm matches with the user before returning. |
   | "all" | Return every tab ID. |

5. **Return** the resolved tab ID list. If invoked standalone (not by another skill), also print a confirmation line: `Picked: <n> tabs from <source>.`

## Errors

- **Extension not installed**: The CLI exits 1 with the Chrome Web Store link. Surface it; do not retry.
- **Not signed in**: The CLI opens the options page and polls (internal 5-minute timeout). Tell the user to sign in and wait. If the CLI returns a login-timeout error, surface it and let the user retry — do not auto-retry.
- **No tabs match a description**: Show the list again and ask for a different reference.

## Output contract

When invoked by another skill, return:

```json
{ "tabIds": [1847, 1853, 1861], "source": "group", "groupTitle": "Research" }
```

Where `source` is one of:
- `"explicit"` — user typed tab IDs directly
- `"group"` — user named a group
- `"matched"` — description matched titles
- `"all"` — user replied "all" (every open tab returned)
