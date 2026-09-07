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
