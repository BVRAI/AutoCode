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
autocode      # or: acv1
```

Both `autocode` and `acv1` are installed. They run the same binary; `acv1` (short for "AutoCode v1") is the short-and-pinned form so future major versions can ship alongside as `acv2`, `acv3`, etc.

## Install from source (dev)

```sh
git clone https://github.com/BVRAI/AutoCode.git
cd autocode
npm install
npm run build
npm link        # adds `autocode` and `acv1` to your PATH
cd ~            # or any other project
acv1            # launches the REPL against the current directory
```

To uninstall later: `npm unlink -g @automax/autocode`.

## Auth

`autocode` runs in one of two modes (auto-detected):

- **Standalone (BYOK)** — set one of `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY` in your environment (or in a `.env` file in the cwd), or write it to `~/.autocode/config.json`.
- **Automax-managed** — if `AUTOMAX_PROXY_TOKEN` is set (Automax sets this when it launches `autocode` for you), traffic routes through `https://automax-proxy.fly.dev` and your Firebase identity authenticates the call. No keys needed. The proxy URL can be overridden with `AUTOMAX_PROXY_URL` (intended for self-hosted forks; the default URL is Automax-specific and unavailable to non-Automax subscribers).

A `.env` file in the directory you launch `autocode` from is loaded on startup. Existing env vars always win, so you can override a `.env` value by exporting it explicitly.

## Providers + defaults

| `--provider` | Default model | Env var (BYOK) |
| --- | --- | --- |
| `anthropic` (default) | `claude-opus-4-7` | `ANTHROPIC_API_KEY` |
| `xai` | `grok-code-fast-1` | `XAI_API_KEY` |
| `openai` | `gpt-5.1` | `OPENAI_API_KEY` |
| `openrouter` | `anthropic/claude-opus-4-7` | `OPENROUTER_API_KEY` |
| `google` | _(deferred — different API shape)_ | _(n/a)_ |

Override the model with `--model <name>` or `/model <provider> <name>` inside the REPL.

## MCP servers

autocode supports the [Model Context Protocol](https://modelcontextprotocol.io). Configure servers in `~/.autocode/config.json`:

```json
{
  "apiKeys": { "xai": "xai-..." },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"]
    },
    "git": {
      "command": "uvx",
      "args": ["mcp-server-git", "--repository", "/path/to/repo"]
    }
  }
}
```

On launch, autocode connects to each server, discovers its tools, and exposes them to the LLM as `mcp__<server>__<tool>`. A 5-second timeout per server keeps a misconfigured one from blocking startup; failed servers print a warning and are skipped. Use `/mcp` inside the REPL to see what's connected.

The config shape matches Claude Code's — you can copy/paste server entries between tools.

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

## Workflow modes

Autocode runs in one of four modes. The first three are for code work; the fourth (`admin`) is for general computer admin (file ops, scripts, batch operations).

| Mode | Behavior | How to enter |
|---|---|---|
| `planning` | Read-only. Agent investigates and writes a plan; no edits or shell commands. | `/mode planning` or `--plan-mode` |
| `default` | Agent works; each file edit and shell command is shown for approval. | default on launch; `/mode default` |
| `autocode` | Auto-apply. Agent edits files and runs shell commands without prompting. | `/mode autocode` |
| `admin` | Auto-apply, framed for **non-code tasks** (file shuffling, script running, Excel/CSV updates). Verify-loop is skipped (no `npm test` after renaming a CSV). | `/mode admin` or `--mode admin` |

`Shift+Tab` cycles `planning → default → autocode → planning`. **Admin mode is opt-in** — it's not in the cycle, so it doesn't crowd the discoverable UI for new users. Reach it via `/mode admin` in-session, or `--mode admin` on the CLI (which is how Automax V6 routes admin tasks).

### Customizing admin mode for your profession

Admin mode is intentionally a clean template — the same `run_shell` + file-op tools every other mode has, just framed for results-not-process work. To make it domain-aware (law firm records, accounting workflows, your particular MLS export format, etc.), use the existing **skills** and **plugins** infrastructure — no code change to autocode needed:

- **Skills** live in `~/.autocode/skills/<name>.md` (user-wide) or `<project>/.autocode/skills/<name>.md` (per-project). Each skill is a markdown file with frontmatter; the agent loads its body on demand via the `use_skill` tool when the task references the skill's domain.
- **Plugins** live in `~/.autocode/plugins/<name>/` and bundle skills + event hooks together. Drop a directory in, it's picked up.

Example: a law firm with a daily records-audit workflow could drop `~/.autocode/skills/records-audit.md` describing its DB schema + naming conventions, plus a `pre_tool` hook that gates anything touching `client_records/`. Combine with `autocode --mode admin --project-root ~/LawFirm -p "run today's records audit"` and you have a domain-specialized admin agent without forking autocode.

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
