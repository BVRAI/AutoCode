# Project: autocode

You are operating inside the `autocode` repository — the source for the very tool you are running. Be careful with self-modifying changes; treat them like changes to your own implementation.

## Conventions

- **Language**: TypeScript on Node 20+ with ESM (`"type": "module"`). Always use `.js` import suffixes in source even though the actual files are `.ts` — that's how the TS compiler resolves under `"moduleResolution": "Bundler"`.
- **Tests**: vitest. Run `npm test` after non-trivial changes. All tests must pass before claiming a task complete.
- **Indentation**: 2 spaces.
- **Quotes**: single quotes for strings; backticks only for templates.
- **Imports**: type-only imports use `import type` syntax (`import type { Foo } from './foo.js'`).
- **One class per file**: matches the modularity philosophy. Avoid combining unrelated classes.

## Architecture

- `src/cli.ts` — entrypoint (commander)
- `src/repl/` — terminal REPL surface (prompt, banner, spinner, command parser)
- `src/agent/` — agent loop, system prompt, tool registry, project context
- `src/tools/` — one tool per file (list_directory, read_file, edit_file, write_file, run_shell, glob, grep, todo_write, web_fetch, web_search)
- `src/safety/` — three-level allow/confirm/block command classifier
- `src/llm/` — provider-neutral router + provider implementations
- `src/auth/` — credential resolution (Automax proxy token, BYOK, config file)
- `src/session/` — session lifecycle, transcript store, per-project state
- `src/util/` — small leaf utilities (path safety, diff, dotenv)

## Working principles for this repo specifically

- The exact-match `edit_file` rule applies to your own changes. When editing source files, read first, then provide a unique anchor in `old_text`.
- After non-trivial code changes, run `npm run build` then `npm test`. Report which tests passed and any that failed.
- Don't add dependencies casually. Every npm package becomes a supply-chain risk and a Windows-compatibility concern. Prefer hand-rolled implementations of small primitives.
- Follow Anthropic's "writing effective tools" guidance when adding or changing tool descriptions — write them as if explaining to a new colleague.
- When the user asks for a UX change, also consider whether the same change would surprise a user upgrading from a previous version. If so, mention the migration concern.

## Reference material

- `_context_only/` — read-only reference material the user keeps for you to consult: design files, screenshots, log outputs, exported specs. It is **gitignored and never part of the build** — read from it for context, but never import it into source or commit it. (A convention used across the user's projects.)
