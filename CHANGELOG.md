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
