# autocode

A terminal-resident agentic coding CLI. Open `autocode` in any terminal, type a task, and it inspects, edits, and runs commands inside the current project — with project-root scoping and a safety policy on every shell command.

> **Status**: pre-release (v0.1 in progress). Not yet on npm.

## Why another coding CLI?

There are already excellent agentic coding CLIs — Claude Code, Codex CLI, Gemini CLI. `autocode` is not trying to compete. It exists for two reasons:

1. **Bundled with Automax** — Automax is an agentic super-application that needs a sandboxed coding agent. Raw terminal access for a workspace-automation agent is unsafe. `autocode` is the safer default.
2. **Learning project** — built in the open so other developers can see how a small coding CLI is put together.

## Install (once published)

```sh
npm i -g @automax/autocode
autocode
```

## Auth

`autocode` runs in one of two modes:

- **Standalone (BYOK)** — set `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `XAI_API_KEY`) in your environment, or run `autocode auth` to write `~/.autocode/config.json`.
- **Automax-managed** — if `AUTOMAX_PROXY_TOKEN` is set (Automax sets this when it launches `autocode` for you), traffic routes through `https://automax-proxy.fly.dev` and your Firebase identity authenticates the call. No keys needed.

## Local commands

Inside the `autocode>` prompt:

```
/help              Show available commands
/status            Show session id, project root, model
/cwd               Show project root
/cwd <path>        Change project root
/model             Show current model
/model <provider> <name>   Switch provider/model
/stop              Cancel current task
/exit              Close autocode
```

Plain text is sent to the agent.

## Tools

The agent has access to five tools, all scoped to the project root:

| Tool | Purpose |
| --- | --- |
| `list_directory` | List files and directories |
| `read_file` | Read a text file (with offset/length) |
| `edit_file` | Exact-match `old_text` → `new_text` replacement |
| `write_file` | Create a new file or rewrite an existing one |
| `run_shell` | Run a shell command under the safety policy |

Shell commands are classified as **allow**, **confirm**, or **block**. Destructive patterns (`rm -rf /`, `format`, `diskpart`, etc.) are hard-blocked. Risky-but-sometimes-valid patterns (`git push --force`, `git reset --hard`) require explicit user confirmation.

## Data storage

Session transcripts and tool logs are written under:

- `%LocalAppData%\autocode\sessions\{sessionId}\` on Windows
- `~/.local/share/autocode/sessions/{sessionId}/` on Linux/macOS

Override with `AUTOCODE_DATA_DIR`.

`autocode` does **not** write metadata into your project directory by default.

## Development

```sh
npm install
npm run build
node dist/cli.js
```

Tests:

```sh
npm test
```

## License

MIT — see [LICENSE](./LICENSE).
