# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
