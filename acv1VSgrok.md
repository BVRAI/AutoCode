# Autocode (acv1) vs Grok Build — Context Architecture Review

**Date:** 2026-07-16  
**Sources:** Autocode workspace (`src/`), open-source [xai-org/grok-build](https://github.com/xai-org/grok-build) (cloned for review), [xAI announcement](https://x.ai/news/grok-build-open-source)

This review compares how the two coding agents **build, inject, refresh, and reclaim model context**. Grok Build is far larger and more productized; Autocode is a lean TypeScript harness with several thoughtful context choices of its own. The goal is a clear map of where each is strong, and what Autocode can learn.

---

## 1. Scale and posture

| Dimension | Autocode (acv1) | Grok Build |
|-----------|-----------------|------------|
| Language | TypeScript / Node ESM | Rust workspace (~60+ crates) |
| Size (approx.) | ~18k LOC in `src/` (~116 TS files) | ~2,100+ `.rs` files in `crates/` |
| Role | Automax-bundled + learning CLI | Production coding agent + fullscreen TUI |
| Multi-provider | Anthropic, xAI, OpenAI, OpenRouter, Automax proxy | xAI-first; local-inference capable via config |
| Extensibility | Skills, plugins, hooks, MCP | Skills, plugins, hooks, MCP, custom agents, marketplace |

Grok Build is a full product stack (TUI, workspace, sandbox, ACP, telemetry, compaction engine, memory, code graph). Autocode is a focused agent loop with deliberate modularity. **Context design should be compared on architecture, not LOC.**

---

## 2. High-level context philosophy

### Autocode: *eager digests + cache-stable system prompt*

Autocode tries to put a **useful structural overview into the system prompt on every turn** so the model navigates without blind discovery:

1. Project type + env line  
2. Long, explicit working principles  
3. Tool catalog (prose)  
4. **Repository map** (ranked files + top-level symbols)  
5. Optional “large codebase localization” protocol  
6. Project instruction files (layered)  
7. Skills **index** (names + descriptions only)  
8. **Volatile** git working-state suffix (outside the cacheable prefix)

Navigation quality also comes from **tools** (`find_symbol`, `file_deps`, Explore `task` subagents).

### Grok Build: *templated identity + lazy intelligence + external memory*

Grok Build does **not** eagerly inject a full repo-symbol digest into the system prompt. Context is assembled as:

1. **System prompt** from MiniJinja templates (`promptMode: extend | full`) — identity, safety, tool conventions, optional memory section  
2. **First user message / preamble** — `<user_info>`, optional `<git_status>`, rules/skills/MCP listings  
3. **Project rules** as `<system-reminder>` blocks (AGENTS.md / Claude / Cursor compat, `.grok/rules/`, etc.)  
4. **On-demand code intelligence** — tree-sitter codebase graph + real LSP tool  
5. **Cross-session memory** (experimental) — hybrid search tools  
6. **Runtime system-reminders** — todos, skill announcements, diagnostics, task completion  
7. **Heavy compaction** when the window fills  

**Summary:** Autocode front-loads *code structure*; Grok Build front-loads *session/env/rules* and expects the model to *query* structure via tools and indexes.

---

## 3. Context assembly pipelines

### 3.1 Autocode — `PromptBuilder` / `ProjectContext` / `RepoMap`

Primary entry: `src/agent/PromptBuilder.ts` → `buildSystemPromptParts(ctx)`.

```
┌─────────────────────────────────────────────────────────────┐
│ system (cache-stable prefix)                                │
│  • role + environment (root, project types, OS, shell, mode)│
│  • working principles (inspect-before-edit, parallel tools…)│
│  • tools available (prose catalog)                          │
│  • repository map (PageRank-ranked digest, ≤ ~6 KB)         │
│  • large-repo localization protocol (if ≥ 25 source files)  │
│  • AGENTS.md / AUTOCODE.md / master.md (depth-ordered)      │
│  • skills index (name + description; bodies via use_skill)  │
├─────────────────────────────────────────────────────────────┤
│ systemVolatile (refreshed each turn; not in cache prefix)   │
│  • Working state: branch, staged/modified/deleted, commits  │
│  • mid-rebase / merge / cherry-pick warnings                │
└─────────────────────────────────────────────────────────────┘
```

**Project detection** (`ProjectContext.ts`): marker files (`package.json`, `Cargo.toml`, `go.mod`, …) → ecosystem labels + git dirty count.

**Repo map** (`RepoMap.ts` + `ImportGraph.ts`):

| Control | Value |
|---------|--------|
| Max digest | 6,000 bytes |
| Max files scanned | 400 |
| Max symbols / file | 10 |
| Ranking | PageRank × (1 + in-degree) over import graph |
| Phase mix | ~75% ranked symbol lines, remainder bare paths |
| Refresh | Deferred to **turn boundary** (protects prompt cache) |
| Large-repo gate | ≥ 25 files → localization protocol section |

**Project instructions** (`ProjectInstructions.ts`):

- Candidates: `AGENTS.md` → `AUTOCODE.md` → `master.md` (authoritative)  
- Walks tree (depth ≤ 8), noise dirs skipped  
- Total cap **40 KB**; deeper files later → override shallower  
- Frontmatter `verify:` directives for post-edit verify loop  

**Subagents** (`SubagentPromptBuilder.ts`): Explore agents get the **parent’s cached repo map** and a read-only tool set (context firewall via `task`).

### 3.2 Grok Build — `PromptContext` + `UserMessageContext` + reminders

Primary crates: `xai-grok-agent` (prompt assembly), `xai-grok-shell` (session host), `xai-grok-tools` (tools + reminders).

**System prompt (`PromptContext`)** — first-class, JSON-serializable, inspectable:

| Field | Role |
|-------|------|
| `prompt_mode` | `Extend` (base template + body) or `Full` (body is entire prompt) |
| `audience` | Primary vs Subagent (different templates / catalogs) |
| `agents_md_files` | Discovered project rules (precedence ordered) |
| `memory_*` | Paths + enable flag for memory section |
| `os_name`, `shell_path`, `working_directory`, `current_date` | Env placeholders |
| `system_prompt_label` | “You are …” identity |
| `role_instructions` / `persona_instructions` | Durable identity |

Templates use MiniJinja with custom `${{ }}` / `${% %}` delimiters so prose can keep `{{ }}`. Tool names resolve dynamically via `ToolBridge` (`tools.by_kind.read`, etc.).

**First user message (`UserMessageContext`)**:

- `<user_info>`: OS, shell, workspace path, date, optional terminals folder  
- `<git_status>`: pre-fetched VCS status, **10,000 character cap**, truncated at last newline  
- Workspace + user **rules**  
- **Skills listing** (budgeted XML announcement; ~1% of context heuristic)  
- **MCP** server list + on-disk schema folder paths  

**AGENTS.md / rules** (`agents_md.rs`, user guide `12-project-rules.md`):

- Filenames: `AGENTS.md`, `Agents.md`, `Claude.md` / `CLAUDE.md` / `CLAUDE.local.md`, `AGENT.md`, …  
- Rules dirs: `.grok/rules/`, `.claude/rules/`, `.cursor/rules/` (compat-gated)  
- Walk: `~/.grok/` → repo root → cwd (deeper wins)  
- Injected as `<system-reminder>` with “From: {path}” headers  
- **Dynamic load** when the agent touches directories outside the initial chain  

This is broader vendor compatibility than Autocode’s three-name set.

---

## 4. How the model “sees” the codebase

This is the core difference.

### Autocode: structure in the prompt

```
# Repository map
src/agent/AgentLoop.ts  ·  AgentLoop, compactConversation  (imported by 3)
src/agent/RepoMap.ts  ·  getRepoMap, buildRepoMap  (imported by 5)
…
— other files —
src/util/paths.ts, src/util/diff.ts, …
```

Plus tools:

| Tool | Backend | Purpose |
|------|---------|---------|
| `find_symbol` | Language-aware regex (shared with RepoMap) | Defs + references |
| `file_deps` | Import graph | Blast radius / importers |
| `grep` / `glob` / `read_file` | FS | Content / names |
| `task` (Explore) | Subagent loop | Context firewall for large research |

Honest self-description in Autocode source: `find_symbol` is **“LSP-lite”** (~80% of value without real language servers).

### Grok Build: indexes and servers, not a digest

| Subsystem | What it is | How the model uses it |
|-----------|------------|------------------------|
| **`xai-codebase-graph`** | tree-sitter multi-language index, parallel build, mmap cache, incremental FS events, scope graphs | Navigation APIs (goto def/refs, by name); powers workspace code-nav, not a fixed system-prompt dump |
| **`lsp` tool** | Real language servers via `~/.grok/lsp.json` | goToDefinition, findReferences, hover, implementations, documentSymbol, workspaceSymbol |
| **grep / read / list** | Standard tools | Same role as Autocode |
| **task / subagents** | First-class agent definitions + isolation (worktrees) | Parallel explore without polluting parent window |

**Implication:** On a large monorepo, Autocode’s 6 KB map can go stale or truncate, but the model always gets *some* orientation. Grok’s model may start “colder” on structure and spend early tool calls to orient—but when indexes/LSP are warm, symbol accuracy and type info are much stronger.

Autocode’s large-repo section (≥25 files) explicitly encodes research-backed localization (file → symbol → line; Aider-style map-first; Explore subagents). Grok encodes similar guidance in tool descriptions and plan-mode prompts rather than a gated system-prompt block.

---

## 5. Working state & live environment

| Signal | Autocode | Grok Build |
|--------|----------|------------|
| Git branch / dirty | Yes (volatile system section) | Yes (`<git_status>` in user preamble; large cap) |
| Staged / modified / deleted lists | Cap 20 paths each | Full short status up to 10k chars |
| Recent commits | Last 5 | Via status/log as gathered by host |
| In-progress rebase/merge/cherry-pick | Explicit warnings | Depends on VCS status text |
| Background terminal outputs | Limited (`run_shell` background) | Terminals folder path in `<user_info>`; model can `read` logs |
| Prompt-cache hygiene | Stable prefix + volatile suffix | Template/base identity stable; rules/status in user/reminder channel |

Autocode’s **cache split** (`system` vs `systemVolatile`) is a sharp, small-team design win: git churn must not bust Anthropic-style prefix caches every turn. Grok’s split is different (system template vs user preamble / reminders) but serves a similar “don’t put volatile bits in the durable identity” idea.

---

## 6. Project instructions & progressive knowledge

### In-session / project rules

| Feature | Autocode | Grok Build |
|---------|----------|------------|
| Industry `AGENTS.md` | Yes | Yes (+ many aliases) |
| Product-specific file | `AUTOCODE.md` | `.grok/` agents, rules, config |
| Authoritative host overrides | `master.md` (Automax) | Workspace user dir + remote settings |
| Subdirectory layering | Full tree walk, depth-ordered | Root→cwd chain + on-demand extra dirs |
| Claude / Cursor rules | No dedicated | Yes (compat flags) |
| Byte caps | 40 KB total instructions | Reminder formatting + skill listing budgets |

### Skills (progressive disclosure)

Both use **name+description in context, body on demand**.

| | Autocode | Grok Build |
|--|----------|------------|
| Discovery | Project, user (`~/.autocode/skills`), plugins, builtins | Local, intermediate, repo, user, config paths, server, bundled, plugins |
| Load tool | `use_skill` | Skill tool / announcement XML |
| Mid-session new skills | Process-lifetime cache | Watcher + announcement reminders |
| Budgeting | Section omitted if empty | Character budget (~1% context) + overflow indicator |

Grok’s skill pipeline is production-scale (marketplace, plugins, multi-scope merge, disable vs ignore). Autocode’s is correct for progressive disclosure but simpler.

### Cross-session memory

| | Autocode | Grok Build |
|--|----------|------------|
| Mechanism | **Session reflection** → propose appends to `AUTOCODE.md` | **Memory subsystem** (`xai-grok-memory`) |
| Storage | Markdown project instructions | `~/.grok/memory/` global + workspace hash dirs + session logs |
| Retrieval | Next session’s instruction load (eager) | `memory_search` / `memory_get` tools |
| Ranking | N/A (human accepts proposals) | FTS5 BM25 + sqlite-vec KNN + temporal decay + source weights + optional **MMR** diversity |
| Consolidation | User-reviewed proposals | **autoDream** gated consolidation of session logs → curated MEMORY.md |
| Status | On by default when there’s activity | **Experimental** (`--experimental-memory` / `GROK_MEMORY=1`) |

**Autocode strength:** reflection writes durable, human-audited project rules—the right place for conventions.  
**Grok strength:** searchable, multi-session episodic + curated memory with embeddings; pre-compaction **memory flush** so knowledge isn’t lost when history is replaced.

These are complementary patterns, not substitutes.

---

## 7. Conversation compaction & context reclamation

### Autocode — two-tier + optional server editing

| Tier | Trigger | Action |
|------|---------|--------|
| Server-side (Anthropic) | ~50% window | Provider context editing (cache-friendly when supported) |
| Mask observations | ~60% | Clear old tool outputs; marker: re-run tool if needed |
| LLM compact | ~80% | Summarize older turns; keep last ~4 pairs; cheap summarizer model |

Design note in code cites research that **dropping stale tool outputs** matches summarization quality at lower cost (“The Complexity Trap”). Masking is deliberately cheaper and preferred.

### Grok Build — full-replace engine + policies

Shared crate `xai-grok-compaction`:

- **Full-replace** (grok-build style): ~**85%** default auto-compact threshold  
- Structured multi-section summary prompt *or* short self-summarization  
- Degenerate-summary detection (min ~500 cleaned chars), retries  
- Two-pass / prefire compaction (feature-flagged)  
- Intra / inter styles (shared with Grok chat product)  
- Tool-pair-safe selection so tool_use/tool_result pairs aren’t orphaned  
- Active-agent-state re-injection via `<system-reminder>` after compact  
- Optional **memory flush** before compact  

Grok’s compaction is a **product subsystem** with observers, failure classification, and host wiring. Autocode’s is a **tight, research-informed ladder** that is easy to reason about and already cache-aware.

---

## 8. Runtime “live” context (beyond the system prompt)

| Mechanism | Autocode | Grok Build |
|-----------|----------|------------|
| Hooks | Pre/post tool, stop (shell exit codes) | Richer hooks package + examples |
| Todo | `todo_write` tool | Todo + **TodoNudge** + optional **TodoGate** (force continue if todos incomplete) |
| Diagnostics | Post-edit **verify loop** (inferred/scoped tests) | LSP diagnostics reminders |
| Plan mode | `planning` agent mode (tools disabled) | `enter_plan_mode` / `exit_plan_mode` tools + permission modes |
| Subagents | Explore + ComputerUse | Custom agent markdown defs, worktrees, completion requirements |
| Untrusted external content | Explicit markers for web tools | Similar hygiene in tool layers |

Autocode’s **automatic verify-after-edit** loop (with scoped-then-full test plan from project type / `verify:` frontmatter) is a distinctive harness-level behavior that keeps “is it green?” out of the model’s optional discipline. Grok leans on tools, plan mode, and LSP diagnostics instead.

---

## 9. Side-by-side: context building maturity

| Capability | Autocode | Grok Build | Edge |
|------------|:--------:|:----------:|:----:|
| Eager repo / symbol digest in prompt | Strong | Weak / absent | **Autocode** |
| Import-graph importance ranking | Strong (PageRank) | N/A for prompt | **Autocode** |
| Prompt-cache stable/volatile split | Explicit | Different shape | **Autocode** (clarity) |
| Cheap tool-output masking tier | Yes (~60%) | Compaction-centric | **Autocode** (simplicity) |
| Project instruction layering | Good | Excellent + vendor compat | **Grok** |
| Dynamic rules when leaving cwd chain | No | Yes | **Grok** |
| Real AST / tree-sitter index | No | Yes | **Grok** |
| Real LSP | No (regex LSP-lite) | Yes | **Grok** |
| Cross-session vector/hybrid memory | No | Yes (experimental) | **Grok** |
| Session → durable instructions | Reflection → AUTOCODE.md | Dream + MEMORY.md + flush | **Both** (different) |
| Compaction sophistication | Solid two-tier | Production multi-mode | **Grok** |
| Skills / plugins ecosystem | Basic+ | Full product | **Grok** |
| Custom agent prompt system | Fixed types | Markdown agents + MiniJinja | **Grok** |
| System-reminder runtime policy | Minimal | Extensive | **Grok** |
| Post-edit verification harness | Strong | Weaker as automatic loop | **Autocode** |
| Inspectable prompt context object | Ad-hoc | `PromptContext` serializable | **Grok** |
| Code readability / teachability | High | Steep | **Autocode** |

---

## 10. What Autocode already does well (don’t throw away)

1. **Repo map + import graph** — rare and valuable; most agents force discovery via tools only. Keep and deepen it.  
2. **Turn-boundary map refresh** — correct prompt-cache hygiene.  
3. **Mask-before-summarize** — empirically grounded and cheap.  
4. **system / systemVolatile split** — small feature, large cost impact on Anthropic-class caches.  
5. **Explore subagents as context firewalls** — same idea Grok uses at larger scale.  
6. **Session reflection → AUTOCODE.md** — human-in-the-loop memory for *conventions* (often better than silent MEMORY.md writes).  
7. **Verify loop** — closes the “model claims green without evidence” hole.

---

## 11. Highest-leverage gaps for Autocode (inspired by Grok)

Ordered roughly by ROI for Autocode’s size and Automax deployment:

### P0 — Context quality without rewriting the world

1. **Richer AGENTS / rules discovery**  
   - Accept Claude/Cursor filenames and `.claude/rules` / `.cursor/rules` (compat flag).  
   - Optional root→cwd chain (not only full tree walk) for monorepos.  
   - On-demand instruction load when tools touch new directories (Grok’s “check for additional project instruction files”).

2. **First-user-message channel for volatile bulk**  
   - Consider moving huge git status / long instruction blobs to a structured user/reminder channel so the *identity* system prefix stays smaller and more cacheable (Grok’s pattern).  
   - Keep Autocode’s volatile system suffix for small working-state, or unify under one policy.

3. **Compaction quality bar**  
   - Structured summary sections (user goal / files touched / decisions / remaining work).  
   - Degenerate-summary retry (Grok’s min seed length).  
   - Preserve tool-pair integrity when cutting history (already partially handled via cut-finder; harden tests).

### P1 — Intelligence backends

4. **Evolve `find_symbol` toward real structure**  
   - Short term: tree-sitter optional for TS/Python/Rust where available.  
   - Medium term: optional LSP config (Autocode already documents this as the path).  
   - Keep the tool API stable so prompts don’t churn.

5. **Repo map upgrades without ballooning tokens**  
   - Adaptive budget by model context window (not fixed 6 KB).  
   - Task-conditioned re-ranking (query-aware map slice) when user message is known.  
   - Optional “no map for tiny repos / polyglot exercises” is already gated—keep that.

### P2 — Memory productization

6. **Hybrid memory (opt-in)**  
   - Grok’s layout is a good blueprint: markdown source of truth + sqlite index + search tool.  
   - Wire **pre-compact flush**: extract durable facts before full-replace.  
   - Keep reflection for *project rules*; use memory for *session episodic* knowledge.

7. **Skill/plugin watcher + mid-session announcements**  
   - Grok’s system-reminder skill announcements avoid “restart to see new skills.”

### P3 — Runtime control plane

8. **Serializable prompt context** (`PromptContext`-style) for `/debug context`, tests, and Automax host injection.  
9. **TodoGate-style optional policy** for agentic modes where unfinished todos should not end the turn.  
10. **Custom agent markdown** only if Automax multi-agent surfaces need it—Grok’s complexity here is product-driven.

---

## 12. Architectural diagrams

### Autocode (eager digest)

```
User turn
   │
   ▼
buildSystemPromptParts ──► [stable system + volatile git]
   │                         └── getRepoMap / loadProjectInstructions / skills
   ▼
LLM  ◄── tools: read/grep/find_symbol/file_deps/task/use_skill
   │
   ├─ mask tool results @60%
   ├─ compact @80%
   └─ verify loop after mutations
```

### Grok Build (lazy + memory + reminders)

```
Session start
   │
   ├─ render system template (PromptContext)
   ├─ inject AGENTS/rules as system-reminders
   ├─ first user preamble (user_info, git_status, skills, MCP)
   └─ optional memory enable + index warm
   │
User turn
   │
   ▼
LLM  ◄── tools: read/grep/lsp/code-nav/memory_search/task/…
   │         ▲
   │         └── tree-sitter IndexManager + LSP servers
   │
   ├─ runtime system-reminders (todos, diagnostics, skills)
   ├─ full-replace compact @~85% (+ optional memory flush)
   └─ dream consolidation (async, gated)
```

---

## 13. Bottom line

| Question | Answer |
|----------|--------|
| Is Grok Build more developed overall? | **Yes** — by an order of magnitude in product surface, code intelligence infrastructure, memory, compaction, and extension systems. |
| Is Grok’s *context building* uniformly more advanced? | **No.** It is more advanced on **rules discovery, memory, AST/LSP intelligence, and compaction**. Autocode is more advanced (or at least more explicit) on **eager structural digests, import-graph ranking, and cache-aware prompt splitting**. |
| What should Autocode steal first? | Vendor-compatible rules discovery, on-demand instruction loading, better compaction summaries, adaptive repo-map budgets, then optional tree-sitter/LSP and hybrid memory. |
| What should Autocode keep as differentiators? | Repo map + PageRank, mask-first context reclaim, verify loop, reflection into `AUTOCODE.md`, readable single-language agent core. |

**Framing for Automax:** Autocode does not need to become Grok Build. It needs a **clearer layered context model**—stable identity, budgeted structure, volatile environment, progressive skills, reclaimable history, and optional durable memory—while staying small enough to ship inside Automax safely. Grok Build’s open source is the best public reference for how far each of those layers can go when unconstrained by bundle size.

---

## Appendix A — Key source maps

### Autocode

| Concern | Path |
|---------|------|
| System prompt | `src/agent/PromptBuilder.ts` |
| Repo map + symbols | `src/agent/RepoMap.ts` |
| Import graph | `src/agent/ImportGraph.ts` |
| Project type | `src/agent/ProjectContext.ts` |
| Instructions | `src/agent/ProjectInstructions.ts` |
| Git working state | `src/agent/SessionState.ts` |
| Window / thresholds | `src/util/contextWindow.ts` |
| Agent loop + compact/mask | `src/agent/AgentLoop.ts` |
| Subagent prompts | `src/agent/SubagentPromptBuilder.ts` |
| Reflection | `src/agent/SessionReflection.ts` |
| Skills | `src/agent/Skills.ts` |
| Symbol tool | `src/tools/findSymbol.ts` |

### Grok Build (open source)

| Concern | Path |
|---------|------|
| Agent / prompt assembly | `crates/codegen/xai-grok-agent/` |
| Prompt context | `…/prompt/context.rs` |
| User message / git | `…/prompt/user_message.rs` |
| AGENTS.md discovery | `…/prompt/agents_md.rs` |
| Skills discovery | `…/prompt/skills.rs` |
| System reminder policy | `…/system_reminder.rs` |
| Codebase graph | `crates/codegen/xai-codebase-graph/` |
| Memory | `crates/codegen/xai-grok-memory/` |
| Compaction | `crates/common/xai-grok-compaction/` |
| Tools (LSP, memory, …) | `crates/codegen/xai-grok-tools/` |
| Session host | `crates/codegen/xai-grok-shell/` |
| Project rules docs | `crates/codegen/xai-grok-pager/docs/user-guide/12-project-rules.md` |

### Review method

Grok Build was cloned from `https://github.com/xai-org/grok-build` for offline source inspection. Autocode was reviewed from this workspace. Findings emphasize **context building**; TUI polish, auth, sandboxing, and marketplace are out of scope except where they touch context.

---

*Document generated for Automax / Autocode planning. Update when either codebase’s context pipeline changes materially.*
