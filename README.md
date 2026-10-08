# dassi — Claude Code plugin marketplace

Use [Dassi](https://dassi.ai) in Chrome from Claude Code: read and operate your open tabs, or delegate a browser task to Dassi and retrieve its result.

This repo is only a marketplace entry. The plugin itself is the [`@dassi_ai/cli`](https://www.npmjs.com/package/@dassi_ai/cli) npm package, which carries the skill and the CLI it runs, so the plugin version is always the CLI version.

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
npx --yes @dassi_ai/cli@latest setup
```

## Updating

Claude Code leaves auto-update off for third-party marketplaces, so an installed plugin stays on its version until you update it. Turn auto-update on once: run `/plugin`, open the **Marketplaces** tab, select `dassi`, and choose **Enable auto-update**. New versions then install on their own.

To update right now, run this in a shell:

```sh
claude plugin update dassi@dassi
```

or, inside Claude Code, run `/plugin`, open the **Installed** tab, select `dassi`, and choose **Update now**. Then restart Claude Code or run `/reload-plugins`.

If the skill tells Claude to run commands the CLI rejects, such as `dassi read-page` or `dassi click`, the installed plugin predates the npm package. The same update command replaces it.

## How it works

The skill runs the CLI bundled in the plugin. The CLI talks to a local daemon, which the Dassi extension connects to over `127.0.0.1`. The plugin itself sends no data to Anthropic, Omnify Labs, or any third party.

## License

MIT — see [LICENSE](./LICENSE).

## Contact

- Web: https://dassi.ai
- Email: team@dassi.ai
- Issues: [open here](https://github.com/omnify-labs/dassi-claude-plugin/issues)
