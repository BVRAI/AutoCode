# autocode

The coding engine inside [Automax](https://bvrai.com), and a terminal coding agent on its own.
Open `autocode` in any terminal, type a task, and it inspects, edits and runs commands inside the
current project; run `autocode --server` and a host application drives the same engine over a
JSON-RPC protocol.

> **Status (2026-09):** the public npm product is shelved. This repository is Automax's engine —
> it is not published to npm and the release workflow is off. Everything still works from a
> source checkout.

## What it is

- An agent loop on a stable, cache-friendly prompt with a transcript that follows Claude Code's
  grammar (`⏺ Read(src/app.ts)` / `⎿  Read 120 lines (ctrl+o to expand)`, collapsed Bash output,
  numbered diffs, `Explore(…)` subagent rows, a transient status line, an end-of-turn line).
- Five providers behind one router: Anthropic, OpenAI (Responses API), Google Gemini, xAI and
  OpenRouter, with thinking/effort armed per model and streaming everywhere.
- Large-codebase navigation: a tree-sitter code index (12 grammars) behind `search_entity`,
  `traverse_graph` and `retrieve_entity`, a PageRank repo map sized to the context window, a
  per-request "likely relevant" slice, and a `Localize` subagent for "which code do you mean".
- A production workflow: typecheck/lint/test stages after edits, failure triage over the import
  graph, an independent Review subagent, plan-then-approve, `/commit`, worktrees, Agent Skills,
  Claude-Code-shaped hooks, MCP (stdio and Streamable HTTP), auto memory and path-scoped rules.
- Safety in layers: a shell-command classifier (allow / confirm / block), fenced system zones,
  allow/ask/deny permission rules, a trust gate for repo-supplied automation, a reviewer model
  in auto mode, and an optional OS sandbox.

## Install from source

```sh
git clone https://github.com/BVRAI/AutoCode.git autocode
cd autocode
npm install
npm run build
npm link        # adds `autocode` and `acv1` to your PATH
cd ~/some/project
autocode
```

Node 22 or newer. `npm unlink -g @automax/autocode` removes the links.

## Auth

Two modes, auto-detected:

- **Standalone (BYOK)** — set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`,
  `XAI_API_KEY` or `OPENROUTER_API_KEY` in the environment or a `.env` in the working directory,
  or store keys in the OS keyring with `/keys`.
- **Automax-managed** — when `AUTOMAX_PROXY_TOKEN` is set (Automax sets it when it launches the
  engine), traffic goes through the BVRAI proxy and no keys are needed. `AUTOMAX_PROXY_URL`
  overrides the proxy for self-hosted forks.

With your own keys, `/model` lists what each provider currently publishes (the Anthropic,
OpenAI, xAI and Google model lists, OpenRouter's public list) rather than a bundled table. The
lists are fetched in the background at startup and cached for a day under the data directory;
`/model refresh` refetches them and `AUTOCODE_NO_DISCOVERY=1` turns discovery off. Prices come
from the provider when it publishes them (xAI, OpenRouter), else the bundled table, else
OpenRouter's listing of the same model; a model no source prices shows as "price unknown" and
is billed at the provider's dearest known rate so cost caps still apply.

## Providers and defaults

| `--provider` | Default model | Key |
| --- | --- | --- |
| `anthropic` | `claude-opus-4-7` | `ANTHROPIC_API_KEY` |
| `openai` | `gpt-5.1` | `OPENAI_API_KEY` |
| `google` | `gemini-2.5-pro` | `GOOGLE_API_KEY` |
| `xai` | `grok-build-0.1` | `XAI_API_KEY` |
| `openrouter` | `anthropic/claude-opus-4-7` | `OPENROUTER_API_KEY` |

`--model <name>` or `/model <provider> <name>` switches; `--effort low|medium|high|max|off` or
`/effort` sets how hard the model thinks (per model, remembered in config).

## Running

```sh
autocode                                  # interactive, current directory
autocode --project-root ../other --mode autocode
autocode -p "add a --verbose flag"        # headless: one task, exit
autocode --worktree feature-x             # work in .autocode/worktrees/feature-x
autocode --server                         # JSON-RPC 2.0 over stdio for a host application
```

### Modes

| Mode | Behavior |
| --- | --- |
| `planning` | Read-only. The agent investigates and writes a plan; a plan is saved under `.autocode/plans/` and offered for approval. |
| `default` | The agent works; each edit and shell command is shown for approval ("Yes, and don't ask again for …" scopes). |
| `autocode` | Auto-apply. Risky shell commands are judged by a cheap reviewer model first; only what it will not vouch for reaches you. |
| `admin` | Auto-apply framed for non-code work (file shuffling, scripts, spreadsheets); the verify loop is skipped. |

`Shift+Tab` cycles planning → default → autocode. `admin` is opt-in (`/mode admin`, `--mode admin`).
`sights` is a locked-down website-builder mode used by Automax (CLI only).

### The app-server protocol

`autocode --server` reads JSON-RPC requests line by line on stdin and writes responses and
notifications on stdout. Methods: `initialize`, `session.new`, `session.resume`, `session.info`,
`session.setMode`, `session.command` (clear, compact, undo, effort, model, refresh, memory,
status), `turn.submit`, `turn.cancel`, `respond`, `shutdown`. Notifications: `server.ready`,
`session.ready`, `turn.started|completed|failed|cancelled`, `item.started|updated|completed`
(agent_message, reasoning, tool_call, file_change, user_message, note),
`request.approval|confirm|choose|ask` (answer with `respond`), `status`, `usage`, `log`. The types
live in `src/server/protocol.ts`; Automax's C# client is `AutoCode.Engine/Backends/TsHarnessBackend.cs`.

## Commands

`/help` `/status` `/cost` `/diff` `/model` `/effort` `/mode` `/undo` `/trash` `/restore` `/clear`
`/compact` `/commit [hint]` `/init` `/hooks` `/memory` `/mcp` `/plugins` `/keys` `/auth` `/login`
`/proxy` `/cwd` `/ui` `/spinner` `/computer-use` `/refresh` `/update` `/reflect` `/stop` `/exit`,
plus `/<skill-name> …` for any installed skill. `@path` attaches a file, folder, image or PDF and
`@Symbol` (or `@path#name`) inlines a definition from the code index; `!` runs a shell command;
`Ctrl+O` expands the transcript, `Ctrl+T` shows the todo tray.

## Tools

File and search: `read_file` (line-based), `edit_file`, `write_file`, `create_directory`,
`delete_path`, `list_directory`, `glob`, `grep`. Code navigation: `find_symbol`, `file_deps`,
`search_entity`, `traverse_graph`, `retrieve_entity`, `search_commits`, `show_commit`, and `lsp`
(definition / references / hover / diagnostics / symbols through an installed language server).
Work: `run_shell`, `task` (Explore,
Localize, Review and ComputerUse subagents), `todo_write`, `ask_user`, `use_skill`, `save_memory`,
`tool_search` (loads optional tools on demand past 30 registered tools). Web: `web_fetch`,
`web_search`, `open_in_browser`. Computer use: `capture_screenshot`, `computer_use_task` and the
host bridge, when enabled. MCP servers add `mcp__<server>__<tool>`.

## Safety

- **Classifier:** every shell command is `allow`, `confirm` or `block`; destructive patterns
  (`rm -rf /`, `format`, `diskpart`, …) and destructive commands aimed outside the project or at
  protected zones are blocked outright.
- **Permission rules** (`permissions` in config; `.autocode/permissions.json` or
  `.claude/settings.json` in a trusted project): `allow` / `ask` / `deny` lists of
  `Tool(prefix *)` matchers, evaluated before the mode gate; deny wins.
- **Trust gate:** hooks, MCP servers, permission rules and `verify:` directives shipped inside a
  repository run only after a one-time yes for that folder (`AUTOCODE_TRUST_ALL=1` for automation).
- **Auto-mode reviewer:** in `autocode`/`admin` mode a `confirm`-class command is judged by the
  provider's cheap tier (command, flag and your request — never tool output) before you are asked.
- **Sandbox (optional):** `sandbox: { "enabled": true, "allowedDomains": ["github.com"],
  "allowWrite": ["."], "denyRead": ["~/.ssh"] }` wraps shell commands in Anthropic's
  `@anthropic-ai/sandbox-runtime` (install it separately); network is denied by default.
- **Checkpoints:** every edit is snapshotted; `/undo` rewinds a step or a turn, deletes go to a
  trash you can `/restore`.

## Project configuration

| Where | What |
| --- | --- |
| `AUTOCODE.md`, `AGENTS.md`, `master.md` | Instructions loaded into the prompt; `@path` imports supported. `/init` writes a starter with a documentation map. |
| `.autocode/rules/*.md`, `.claude/rules/*.md` | Rules; with `paths:` frontmatter they load only when matching files are touched. |
| `.autocode/skills/<name>/SKILL.md`, `.agents/skills`, `.claude/skills` | Agent Skills (project and home); resources alongside. |
| `.autocode/hooks.json`, `.claude/settings.json` `hooks` | Hooks on Claude Code's contract (13 events, JSON on stdin, exit 2 blocks). |
| `.mcp.json`, config `mcpServers` | MCP servers (stdio `command` or Streamable HTTP `url`); project and plugin servers are approved once per project. |
| `.autocode/permissions.json` | Permission rules (see Safety). |
| `.autocode/plans/`, `.autocode/worktrees/` | Plan files and worktrees the harness creates. |
| `~/.autocode/plugins/<name>/` | Plugins: `plugin.json`, `skills/`, `mcp.json`, hooks. |

User config lives in `~/.autocode/config.json` (`AUTOCODE_CONFIG_DIR` overrides): providers,
`effort`, `permissions`, `sandbox`, `autoMode`, `review`, `verifyCommand`, `autoVerify`, `hooks`,
`mcpServers`, `webTools`, `ui`, `spinner`, `autoUpdate`.

## Data

Sessions, checkpoints, the code index cache and auto memory live under the data directory —
`%LocalAppData%\autocode` on Windows, `~/.local/share/autocode` elsewhere (`AUTOCODE_DATA_DIR`
overrides). Nothing is written into the project except what you ask for (`.autocode/plans`,
`.autocode/worktrees`, `/init`).

## Development

```sh
npm install
npm run build
npm test                 # unit tests (vitest)
npm run test:e2e         # console scenarios through a real ConPTY (or an emulated terminal)
npm run tty -- --scenario basic --cols 100 --rows 30   # print the screens of one scenario
node scripts/bundle.mjs --out ../bundle                # self-contained harness for Automax
```

`AUTOCODE_FAKE_LLM=<script.json>` replaces every provider with a scripted model so a whole session
runs without an API call; the e2e scenarios in `test/e2e/scenarios/` use it. Useful switches:
`AUTOCODE_TRACE_LOG=<file>` (timing trace), `AUTOCODE_NO_INDEX=1`, `AUTOCODE_NO_REVIEW=1`,
`AUTOCODE_NO_CHECK_STAGES=1`, `AUTOCODE_REVIEW=auto|off`, `AUTOCODE_AUTO_JUDGE=on|off`,
`AUTOCODE_NO_SANDBOX=1`, `AUTOCODE_NO_REDACT=1`, `AUTOCODE_TTY_EMULATE=100x30`, and the request
watchdog ceilings `AUTOCODE_LLM_FIRST_EVENT_MS` (120000), `AUTOCODE_LLM_IDLE_MS` (180000),
`AUTOCODE_LLM_COMPLETE_MS` (600000).

Automax passes `AUTOMAX_THEME`, `AUTOMAX_LOCALE`, `AUTOMAX_EFFORT`, `AUTOMAX_PROVIDER`,
`AUTOMAX_MODEL`, `AUTOMAX_EVENT_FILE` and the proxy token when it launches the engine.

## License

MIT — see [LICENSE](./LICENSE).
