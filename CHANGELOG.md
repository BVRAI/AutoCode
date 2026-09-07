# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- The inline console now follows Claude Code's transcript grammar: `⏺ Label(arg)`
  tool rows with collapsed `⎿` results ("Read 120 lines (ctrl+o to expand)",
  grouped "Read 3 files", Bash output folded after three lines, "Updated path
  with N additions and M removals" over a numbered diff, "Done (12 tool uses ·
  34.2k tokens · 1m 5s)" for subagents, ☒/☐ todo rows), a collapsed "Thought for
  Ns" stub, a transient status line (`✢ Reading… (4s · ↓ 20 tokens · esc to
  interrupt)`), an end-of-turn line (`✻ Cooked for 23s · done 6:05 PM`), a tinted
  user band, a mode-colored composer, footer mode badges, and a permission dialog
  with "Yes, and don't ask again for …" scopes. Answers stream as they arrive.
- Inline mode rebuilds the whole transcript from source after a resize (the
  composer draft survives), instead of leaving stale rows behind.

### Added
- App-server protocol (Phase 5): `autocode --server` speaks JSON-RPC 2.0 over
  stdio — methods `initialize`, `session.new`, `session.resume`,
  `session.info`, `session.setMode`, `session.command`, `turn.submit`,
  `turn.cancel`, `respond`, `shutdown`; notifications `server.ready`,
  `session.ready`, `turn.started|completed|failed|cancelled`,
  `item.started|updated|completed` (agent_message, reasoning, tool_call,
  file_change, user_message, note), `request.approval|confirm|choose|ask`
  (answered with `respond`), `status`, `usage`, `log`. The same LiveAgent the
  terminal uses sits behind it, so Automax's `TsHarnessBackend` (v6) and the
  console cannot drift. `turn.completed` is sent only after the turn's
  verification and review tail has settled.
- Permission rules in Claude Code's shape: `permissions.allow / ask / deny`
  lists of `Tool(prefix *)` matchers in config and, for trusted projects, in
  `.autocode/permissions.json` or `.claude/settings.json`; deny wins, allow
  skips the default-mode approval, ask forces it.
- Trust gate: a folder's hooks, MCP servers, permission rules and `verify:`
  directives run only after a one-time yes, remembered per project
  (`AUTOCODE_TRUST_ALL=1` for automation).
- Auto-mode reviewer tier: in autocode/admin mode a `confirm`-class shell
  command is judged by the provider's cheap tier (command, flag and request —
  never tool output) and runs without a prompt when cleared; otherwise the
  user is asked as before (`autoMode.reviewer: false` in config or
  `AUTOCODE_AUTO_JUDGE=off`; never in bench mode).
- Optional OS sandbox for `run_shell` through Anthropic's open-source
  `@anthropic-ai/sandbox-runtime` (Seatbelt / bubblewrap / Windows sandbox
  user): `sandbox: { "enabled": true, "allowedDomains": [...],
  "allowWrite": ["."], "denyRead": ["~/.ssh"] }` in config; the package is
  installed separately, and a missing runtime is reported once
  (`AUTOCODE_NO_SANDBOX=1` disables).
- Secret redaction: key-shaped tokens (vendor API keys, bearer tokens, JWTs,
  `*_API_KEY=` / `password:` assignments) are masked in the session
  transcript and tool log on disk, in the `<<AMX>>` event stream and in
  app-server notifications; the conversation the model sees is untouched
  (`AUTOCODE_NO_REDACT=1` disables).
- `lsp` tool: definition, references, hover, diagnostics and a file's symbol
  outline through the project's language server (TypeScript/JavaScript via
  `typescript-language-server`, Python via pyright or pylsp, C# via
  csharp-ls, Go via gopls, Rust via rust-analyzer), discovered in the project
  and on PATH or pinned with `AUTOCODE_LSP_<LANGUAGE>="<command>"`; one server
  per language per session, stopped at exit. The precision layer over the
  tree-sitter index for re-exports, overloads, generics and path aliases
  (`AUTOCODE_NO_LSP=1` hides it).
- Git-history tools `search_commits` (messages, or diffs with `in_diff`,
  optionally under a path) and `show_commit` (message, stat and capped diff)
  in the main, Explore and Localize registries — "where was this last
  changed" as a localization signal (`AUTOCODE_NO_GIT_TOOLS=1` hides them).
- Symbol `@`-mentions: `@renderDiff` (or `@src/app.ts#App`, `@App.render`)
  inlines that definition's source from the code index as a `<symbol>` block,
  the way `@path` inlines a file; an ambiguous bare name inlines the candidate
  list instead. The `@` picker under the composer offers symbols next to
  files once the index is built.
- Request watchdog in the LLM router: a provider that sends nothing for 2
  minutes (first event) or 3 minutes (between stream events) fails the
  request — retryable before the first event — instead of hanging the turn;
  non-streaming completions time out at 10 minutes
  (`AUTOCODE_LLM_FIRST_EVENT_MS`, `AUTOCODE_LLM_IDLE_MS`,
  `AUTOCODE_LLM_COMPLETE_MS`). `AUTOCODE_TRACE_LOG` now also records each
  iteration's request, first event, stream end and tool start/end.
- Subagents end with an answer-only final iteration (no tools, a request for
  the verdict or list), so Review and Localize runs on a budget model no
  longer finish with "review unavailable" after exploring to the cap.
- Bundling and CI: `node scripts/bundle.mjs --out <dir>` produces a
  self-contained harness (node runtime, dist, production modules, launchers)
  that Automax's Release build drops under `Resources/autocode/`; GitHub
  Actions run typecheck, build, unit and e2e (emulated terminal on Linux,
  Windows and macOS; ConPTY on Windows) with an on-demand Aider-30 job.
- Verification pipeline (Phase 4): typecheck and lint stages detected from the
  project (tsc, eslint, ruff, mypy, go vet, cargo check) run before the test
  command, scoped to the changed files where the tool allows; a failing stage
  costs one fix round like a failing test run (`AUTOCODE_NO_CHECK_STAGES=1`
  disables). Verification failures that touch only files unrelated to the
  turn's changes (by file, test twin, or the import graph) are reported as
  pre-existing instead of looping. A Review subagent reads the turn's diff
  in a fresh context before the turn ends and reports correctness bugs,
  regressions and scope creep (`⏺ Review(N files)` row); high-severity
  findings buy the agent exactly one fix round (`review: "off"` in config or
  `AUTOCODE_NO_REVIEW=1`; never in bench mode).
- Plan mode as a workflow: a planning answer that reads like a plan is saved
  under `.autocode/plans/` and offered with Claude Code's dialog (auto-accept
  edits / approve edits / keep planning); approval switches the mode and
  starts the implementation.
- Git workflow: `/commit [hint]` stages everything, writes a conventional
  commit message from the staged diff on the provider's cheap tier, confirms
  and commits; `--worktree [name]` runs the session in its own git worktree
  and branch under `.autocode/worktrees/`; `/init` adds a documentation map
  (every markdown file under docs/ with its heading).
- Agent Skills standard: `<name>/SKILL.md` directories with resources
  (scripts, templates) alongside the flat `<name>.md` form, discovered in
  `.autocode/skills`, `.agents/skills` and `.claude/skills` (project and
  home) and in plugins; `use_skill` lists a skill's files and returns one with
  `resource`; `/<skill-name> …` invokes a skill from the composer; the listing
  in the system prompt is budgeted (1% of the context window, 1,536 chars per
  description) and names what it left out. Plugins gain `mcp.json` servers
  and hooks in either shape (Agent Plugins 1.0).
- Hooks on Claude Code's contract: events SessionStart, SessionEnd,
  UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse,
  PostToolUseFailure, SubagentStart, SubagentStop, Stop, PreCompact,
  PostCompact; config in Claude Code's shape (`{ "PreToolUse": [{ "matcher":
  "Bash(git *)", "hooks": [...] }] }`) with the legacy flat shape still
  accepted; project hooks from `.autocode/hooks.json` or the `hooks` key of
  `.claude/settings.json`; JSON on stdin, `hookSpecificOutput` on stdout
  (permissionDecision, updatedInput, additionalContext), exit 2 blocks with
  stderr as the reason, Stop hooks re-engage the agent at most 8 times.
  `/hooks` lists what is active.
- MCP: Streamable HTTP servers (`url` + `headers` with `${ENV}` expansion)
  next to stdio ones, servers from the project's `.mcp.json` and plugin
  `mcp.json` (started only after a one-time approval per project), resources
  listed in `/mcp`, deterministic tool ordering, a 100 KB result cap and a
  2-minute call timeout. Past 30 tools, MCP tools load on demand through a
  `tool_search` tool instead of riding in every request.
- Auto memory: facts saved with `save_memory` (user, feedback, project,
  reference) live per project under the data dir and load into the system
  prompt within 200 lines / 25 KB; `/memory` lists them. Path-scoped rules
  (`.autocode/rules/*.md`, `.claude/rules/*.md` with `paths:`) are injected
  with the first tool result that touches a matching file; rules without
  paths join the project instructions. `@path` lines in instruction files
  import other files.
- After compaction the skills the agent loaded and the head of its five most
  recently changed files are restored into the conversation.
- A tree-sitter code index (`src/index/`): every source file with a bundled
  grammar (TypeScript, TSX, JavaScript, Python, Go, Rust, Java, C#, C, C++,
  Ruby, PHP) becomes a graph of directories, files, text files and definitions
  with `contains`, `imports`, `invokes` and `inherits` edges, a name table,
  BM25 over identifier/path/signature tokens and PageRank over the file graph.
  Built in the background at session start, cached per project under the data
  dir and refreshed by a stat pass at each turn boundary. Vendored, minified
  and generated files are indexed as files only; name-only call resolution
  never points into tests and never feeds ranking. `AUTOCODE_NO_INDEX=1`
  turns it all off.
- Three navigation tools on the index: `search_entity` (ranked entities by
  name, path fragment or keywords, fold/preview/full views), `traverse_graph`
  (callers, importers, subclasses, calls, imports, members; 1–3 hops, bounded)
  and `retrieve_entity` (a symbol's exact numbered span, or a file's outline).
  Every listing is capped so small models never overflow.
- A `Localize` subagent type for `task`: answers "which code does this request
  mean?" through the search → graph → retrieve funnel and returns ranked
  `path:line` spans with symbols, reasoning, confidence and an ambiguity note
  the main agent turns into an `ask_user` question. Subagent rows now count
  real tool uses, and the `task` row is labelled `Localize(…)` for that type.
- Repo map v2: once the index is built the map comes from it (nested symbols,
  docs and config included, PageRank over imports and calls) with a budget
  scaled to the model's context window (~2%, 1.5k–8k tokens) instead of the
  fixed 6 KB; a query-aware slice ("Likely relevant to this request", from
  personalized PageRank seeded by the paths and identifiers in the prompt)
  rides in the volatile suffix of the system prompt, so it never busts the
  cached prefix. Subagents receive the map too. `/refresh` rebuilds both.
- The large-codebase protocol in the system prompt now walks
  `search_entity → traverse_graph → retrieve_entity`, delegates loose requests
  to a `Localize` task, and asks the user (`ask_user`) when the top candidates
  are close instead of guessing.
- Thinking effort: `/effort low|medium|high|max|off|auto` (also `--effort`,
  `AUTOMAX_EFFORT`, remembered per model in config). Resolved per provider:
  Anthropic adaptive thinking + `output_config.effort` on Opus 4.7+/Sonnet 5/Opus 5
  (budgets on older models), OpenAI `reasoning.effort` with summaries, Gemini 3
  `thinkingLevel` / Gemini 2.5 `thinkingBudget`, xAI and OpenRouter effort. The
  status line shows the level while the model thinks.
- OpenAI now uses the Responses API (stateless, encrypted reasoning items
  replayed across tool calls, reasoning summaries streamed). Set
  `AUTOCODE_OPENAI_CHAT_COMPLETIONS=1` to fall back to Chat Completions.
- Gemini streams for real (`streamGenerateContent`) and replays thought
  signatures on the parts they arrived with, so thinking is on for Gemini too.
- Attachments: `@path` now inlines text files, lists directories, attaches PDFs
  as documents (Anthropic, OpenAI, Gemini) and images as before, with size caps.
- Composer: `@` opens a fuzzy file picker (Tab/Enter completes); long pastes
  collapse to `[Pasted text #1 +N lines]` and expand on submit; `\` + Enter adds
  a line; Ctrl+V attaches a clipboard image as `[Image #1]`.
- `/model` shows context size, thinking and vision badges from the catalog, and
  the catalog's `max_output_tokens` sets the output cap.
- `AUTOMAX_EVENT_FILE=<path>`: with `--automax`, the `<<AMX>>` events go to that
  file instead of stdout, so a host's terminal never shares the screen stream with
  machine events.
- Test channel: `AUTOCODE_FAKE_LLM=<script.json>` replaces every provider with a
  scripted model; `npm run test:e2e` drives the real console under a real
  pseudo-console (node-pty) or an emulated TTY with golden screens;
  `npm run tty -- --scenario <name>` prints the screens of a scenario.
- `AUTOMAX_THEME=light|dark` picks the TUI palette when a host sets it (Automax
  passes its own theme when it launches autocode in its terminal pane); it
  overrides the saved `/ui` theme for that run, and `/ui` reports the effective
  theme and its source.
- `AUTOMAX_LOCALE=<code>` (e.g. `fr`, `zh-Hans`) makes the agent reply in the
  user's language. English or unset leaves the system prompt byte-identical;
  code, paths and commands are never translated. UI chrome stays English.
- `/proxy` command to verify whether the current authentication can reach the
  BVRAI proxy without exposing the active credential.
- Update pipeline: startup check against npm for newer releases. **Auto-update is
  opt-out** (autocode is too young to leave users stranded on broken versions);
  disable via `autoUpdate: false` in `~/.autocode/config.json` or the env var
  `AUTOCODE_NO_UPDATE=1`. Auto-update is suppressed in headless `-p` mode, on
  prerelease versions, and for the V6-bundled copy (detected via
  `AUTOMAX_BUNDLED` — Velopack owns it). A failed auto-install falls back
  silently to the notify banner. Adds `/update` slash command, `--update` CLI
  flag, and a GitHub Actions release workflow that publishes to npm on a `v*` tag.
- Deterministic self-verifying loop: after a turn that changes files, the harness
  runs the project's verification command and feeds failures back to the agent.
- Rotating startup banner cycling through 10 designs every 2s until first prompt.

### Fixed
- `run_shell` on Windows mangled quoted arguments containing spaces (Node argv
  escaping clashing with `cmd.exe /s`). Switched to `spawn(cmd, { shell: true })`.

### Earlier
- Initial repository scaffold (Phase 0): REPL, session store, tool registry,
  safety policy, LLM router, agent loop, multi-provider support, proxy gateway,
  MCP, image input, repo map, pinned bottom-bar TUI, markdown rendering.
