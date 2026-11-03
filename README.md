# dassi — Claude Code plugin marketplace

Use [Dassi](https://dassi.ai) in Chrome from Claude Code: read and operate your open tabs, or delegate a browser task to Dassi and retrieve its result.

This repository contains the plugin, its skill, the CLI it runs, and its bundled WebSocket dependency. Claude's directory requires a local marketplace source, so `source` points at this repository's root. The runtime files are copied unchanged from the published [`@dassi_ai/cli@0.8.0`](https://www.npmjs.com/package/@dassi_ai/cli/v/0.8.0) package. Installation does not need to download runtime dependencies.

## Install

1. Install the Dassi Chrome extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/dassi-ai-browser-agent-fo/bjcngahpcjeililljmfegmlanlpgibdi).
2. In Claude Code:

   ```text
   /plugin marketplace add omnify-labs/dassi-claude-plugin
   /plugin install dassi@dassi
   ```

3. Run `/reload-plugins`, then ask: "Use Dassi to show my open browser tabs." The skill is also available as `/dassi:dassi`.

Requires Node ≥ 20.11 and Google Chrome on the same macOS or Linux machine.

## Other agents

Codex, OpenCode, and Claude Code without the plugin can register the same skill with one command:

```sh
npx --yes @dassi_ai/cli@0.8.0 setup
```

## Updating

Claude Code leaves auto-update off for third-party marketplaces, so an installed plugin stays on its version until you update it. Turn auto-update on once: run `/plugin`, open the **Marketplaces** tab, select `dassi`, and choose **Enable auto-update**. New versions then install on their own.

To update right now, run this in a shell:

```sh
claude plugin update dassi@dassi
```

or, inside Claude Code, run `/plugin`, open the **Installed** tab, select `dassi`, and choose **Update now**. Then restart Claude Code or run `/reload-plugins`.

If the skill tells Claude to run commands the CLI rejects, such as `dassi read-page` or `dassi click`, the installed plugin is outdated. The same update command replaces it.

## How it works

The skill runs the CLI bundled in the plugin. The CLI talks to a local daemon, which the Dassi extension connects to over `127.0.0.1`. Browser commands and results pass through that local connection. Results returned to Claude become part of the Claude conversation. Delegated tasks use the model configured in Dassi and its normal allowance or provider billing. Browser actions can read or change websites in the connected Chrome profile.

## Privacy policy

See the [Dassi privacy policy](https://dassi.ai/privacy-policy/) for data collection, processing, retention, and contact details. The CLI transport is local; the connected extension, configured model provider, and Claude process the task and relevant website content. Contact privacy@omnifylabs.com for privacy requests.

## Updating the bundled release

Copy the files from an exact published CLI package, including its `node_modules/ws` directory, into the repository root. Preserve this README, the marketplace manifest, and LICENSE. Keep `.claude-plugin/plugin.json` at the package version, validate with `claude plugin validate .`, and verify the skill launcher with `node skills/dassi/scripts/dassi.mjs --help`. Publish changes through a pull request. The source CLI and its tests remain in [omnify-labs/dassi/cli](https://github.com/omnify-labs/dassi/tree/main/cli).

Release provenance: `@dassi_ai/cli@0.8.0`, npm tarball SHA-512 integrity `sha512-1I5F+4kp0V8K43pLtvKN9Yx6ry6SfmxoV4b2qMIQTPNePXA5/zs0qSoavWpKBVx44dswNrbaksU7hTwz1eSywA==`. Every file from that tarball except README.md is included unchanged.

## License

MIT — see [LICENSE](./LICENSE).

## Contact

- Web: https://dassi.ai
- Email: team@dassi.ai
- Issues: [open here](https://github.com/omnify-labs/dassi-claude-plugin/issues)
