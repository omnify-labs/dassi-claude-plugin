# dassi — Claude Code plugin

Drive the [Dassi](https://dassi.ai) Chrome extension from Claude Code. Pick tabs or tab groups, then run AI agent prompts or individual browser tools (navigate, click, fill, screenshot, eval, …) against them.

This repo contains the plugin manifest, marketplace entry, and skills. The actual CLI binary that the skills invoke (`dassi`) ships separately on npm as [`@dassi_ai/cli`](https://www.npmjs.com/package/@dassi_ai/cli).

## Prerequisites

1. **Install the dassi Chrome extension** from the [Chrome Web Store](https://chromewebstore.google.com/detail/dassi-ai-browser-agent-fo/bjcngahpcjeililljmfegmlanlpgibdi) and sign in.
2. **Install the dassi CLI** globally:
   ```bash
   npm install -g @dassi_ai/cli
   ```
3. Verify both are working:
   ```bash
   dassi status
   # → ✓ Signed in as your@email
   ```

## Install the Claude Code plugin

```text
/plugin marketplace add omnify-labs/dassi-claude-plugin
/plugin install dassi@dassi
```

After install, reload Claude Code (`/reload-plugins`) and the two skills become available:

- `/dassi:operate` — run a browser action (summarize, click, fill, screenshot, etc.) on a tab or tab group.
- `/dassi:pick-tabs` — when the target tab(s) are ambiguous, lists open tabs/groups and asks the user to pick.

## Usage examples

```text
/dassi:operate take a screenshot of the active tab and save it to /tmp/shot.png
/dassi:operate fill the email field on the signup form with test@example.com
/dassi:operate compare the prices on the Apple group and tell me which is cheapest
/dassi:pick-tabs the research tabs
```

## How it works

- Each skill in this plugin resolves "which tab(s)" the user means, then shells out to the local `dassi` CLI to drive the Chrome extension over the local daemon socket.
- The CLI talks to a long-lived background daemon at `~/.dassi/<session>.sock` (owner-only).
- The daemon hosts a WebSocket server (`127.0.0.1:18790`) that the Chrome extension's service worker connects to.
- No data is sent to Anthropic, Omnify Labs, or any third party by the plugin itself — all routing happens locally between the CLI, the daemon, and your Chrome.

## Versions

This plugin tracks the matching `@dassi_ai/cli` npm release. Current: **0.1.2**.

## Source

- Plugin metadata + skills: this repo (`omnify-labs/dassi-claude-plugin`)
- CLI source: published as `@dassi_ai/cli` on npm; source visible inside the tarball
- Chrome extension source: not open source

## License

MIT — see [LICENSE](./LICENSE).

## Contact

- Web: https://dassi.ai
- Email: team@dassi.ai
- Issues for the plugin specifically: [open here](https://github.com/omnify-labs/dassi-claude-plugin/issues)
