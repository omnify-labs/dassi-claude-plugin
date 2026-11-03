export const HELP_TEXT = `Usage: dassi [command] [options]

Start here:
  dassi                          Start setup in an interactive terminal
  setup                          Install agent skills and connect your Chrome profile
  skill                          Read the local-agent workflow (no browser needed)
  list-tabs                      Show tabs across connected profiles; copy a TARGET
  run <prompt> --tab <target>     Start a new task and return its ID
  run <prompt> --task <task-id>   Continue that conversation (queues a follow-up if busy)
  status <task-id>                Show progress or the finished result
  result <task-id>                Retrieve the conversation, captured images and files
  stop <task-id>                  Stop that task

Options:
  --wait <duration>              Wait for a result (30s, 10m, 1h); never stops the task
  --profile <id-or-name>          Choose a profile for unscoped tab/group IDs
  --json                         Machine-readable output
  --output-dir <directory>       Save a task report and files (run/result)
  --help                         Show help
  --version                      Show version

Agent setup:
  setup [--profile id]           Resume setup for the chosen profile
  setup --wait 0 --json          Check setup immediately; report any user action needed
  setup --no-open                Print browser instructions without opening Chrome
  skill --path                   Print the bundled skill directory for installation
  skill --remove                 Remove Dassi's registered agent skill links

Update / remove:
  npm install -g @dassi_ai/cli@latest    Update the CLI and its bundled agent skill
  dassi skill --remove                  Unregister the agent skill
  npm uninstall -g @dassi_ai/cli         Remove the npm package

Browser tools:
  tools [name] --tab <target>     Discover current tools or read one tool's schema
  call <name> --tab <target>      Execute a discovered tool with --args '<json>'
  call ... [-o file]             Save returned images (omit --json to write files)
  panel-screenshot [-o file]     Capture Dassi (--tab, --width, --height)
  open [url] --window <id>       Create an ungrouped tab (--foreground to activate)

Other commands:
  list-profiles                  Show profile IDs, labels, and sign-in status
  list-groups                    Show groups with profile-bound targets
  status                         Show connected profiles and their status
  bug-report [-o file]            Export diagnostic logs
  raw <json>                     Send a bridge command

Task reports:
  run <prompt> --tab <target> --wait 10m --output-dir ./result
  result <task-id> --wait 10m --output-dir ./result
  Open report.html; result.json, screenshots/ and files/ hold the evidence.
  run saves the accepted task ID in result.json before waiting.
  If run's wait expires, use its printed result command to export later.

Groups:
  run <prompt> --group <target>   Start one task for the whole group
  --group-title <name>           Select a group by name (use --profile if needed)
  call also accepts group targets and executes once per member tab.

Development:
  launch [--label name] [--dist path] [--chrome path]
         [--load-mode auto|pipe|flag] [-- <chrome args>]
  launch --stop [label] | --stop-all

Browser aliases such as read-page and click have been replaced by tools and call.
run rejects the old --timeout flag. Use --wait for local waiting; stop to cancel.
A wait ending or terminal disconnecting does not cancel browser work.
Each CLI task ID identifies a conversation; follow-ups reuse it.
Completed means the run finished. Read its answer for findings, gaps, or a question.
`;
