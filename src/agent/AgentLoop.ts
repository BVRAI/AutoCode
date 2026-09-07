import type { ConsoleRenderer } from '../repl/ConsoleRenderer.js';
import type { TranscriptStore, CumulativeUsage } from '../session/TranscriptStore.js';
import type { SessionContext, AgentMode } from '../session/SessionContext.js';
import type { CheckpointStore } from '../session/CheckpointStore.js';
import type { ToolExecutionContext } from '../tools/types.js';
import type { ContentBlock, ImageBlock, Message, StreamEvent } from '../llm/types.js';
import { LlmRouter, type ProviderName } from '../llm/Router.js';
import { summarizerModelFor, thinkingFor } from '../llm/models.js';
import { ToolRegistry } from './ToolRegistry.js';
import { buildSystemPromptParts } from './PromptBuilder.js';
import { currentTodos, markInProgressInterrupted } from '../tools/todoWrite.js';
import { renderUnifiedDiff } from '../util/diff.js';
import { estimateCost } from '../util/pricing.js';
import { contextWindowFor, defaultMaxOutputTokens, shouldAutoCompact, shouldMaskObservations } from '../util/contextWindow.js';
import { classifyCommand } from '../safety/SafetyPolicy.js';
import type { SubagentFactory } from '../tools/types.js';
import type { ApproveDetail, ApproveVerdict } from '../repl/Prompter.js';
import { resolveVerifyPlanForFiles, runVerification, type VerifyResult } from './Verify.js';
import { adoptIndexIfReady, invalidateRepoMap, refreshRepoMapIfStale } from './RepoMap.js';
import { indexEnabled, peekIndex, startIndex } from '../index/IndexManager.js';
import { trace, traced, tracedSync } from '../util/trace.js';
import { checkStagesDisabled, resolveCheckStages } from './VerifyStages.js';
import { describeUnrelated, extractFailingPaths, triageFailures } from './FailureTriage.js';
import { blockingFindings, buildReviewRequest, buildTurnDiff, parseReviewResult, renderFixRequest, renderReviewResult } from './Reviewer.js';
import { benchMode } from './toolAvailability.js';
import { loadProjectInstructions } from './ProjectInstructions.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSkill, getSkills } from './Skills.js';
import { getRules, renderRule, rulesForPath } from './Rules.js';
import type { EventEmitter } from '../repl/EventEmitter.js';
import { runSessionReflection, type Proposal, type SessionSnapshot } from './SessionReflection.js';
import { additionalContext, blockingReason, permissionDecision, updatedInput } from './HookRunner.js';
import type { HookHub } from './HookHub.js';
import { decide as decidePermission, type PermissionRules } from '../safety/PermissionRules.js';
import { isTrusted } from './Trust.js';

// Runaway backstop, not a working limit. Hard step caps truncate exactly the
// careful behavior we want on repo-level tasks (top harnesses run hundreds of
// turns; the standard SWE-bench harness allows 250) — the real governors are
// the cost budget (--max-cost) and the user's cancel key. The bench budget can
// still override this either way.
const MAX_ITERATIONS = 200;
const LOOP_DETECT_WINDOW = 10;
const LOOP_DETECT_THRESHOLD = 3;
const MAX_RETRIES_PER_TOOL = 3;
// How many times the harness will feed a verification failure back to the
// agent to fix before giving up (round 0 is the user's actual turn).
const MAX_VERIFY_ROUNDS = 3;
// Claude Code's cap on Stop hooks re-engaging the agent within one turn.
const MAX_STOP_HOOK_ROUNDS = 8;

// Tools that change the project — gated according to the session mode.
const MUTATING_TOOLS = new Set([
  'edit_file',
  'write_file',
  'create_directory',
  'delete_path',
  'run_shell',
  'computer_use_task',
]);

// Tools that change files on disk — a successful call means the turn should
// be verified. (run_shell is excluded: too ambiguous, and verification itself
// runs shell commands.)
const FILE_MUTATING_TOOLS = new Set(['edit_file', 'write_file', 'create_directory', 'delete_path']);

// How a tool call should be handled given the current mode:
//  - block:   refuse (planning mode — read-only).
//  - approve: ask the user before running (default mode review).
//  - allow:   run with no gate.
export function gateFor(mode: AgentMode, toolName: string): 'block' | 'approve' | 'allow' {
  if (!MUTATING_TOOLS.has(toolName)) return 'allow';
  switch (mode) {
    case 'planning':
      return 'block';
    case 'default':
      return 'approve';
    case 'autocode':
      return 'allow';
    case 'admin':
      // Admin work expects autonomous execution; gate is the same as
      // autocode mode. The mode-specific differences (prompt framing,
      // verify-loop skip) live elsewhere.
      return 'allow';
    case 'sights':
      // Headless website-builder mode — auto-apply. The restriction lives
      // in the registry (ToolRegistry.forSights: file ops only), not here.
      return 'allow';
  }
}

export interface AgentDeps {
  renderer: ConsoleRenderer;
  store: TranscriptStore;
  router: LlmRouter;
  registry: ToolRegistry;
  confirm: (prompt: string) => Promise<boolean>;
  // Approve / approve-always / decline / revise an edit or command (the
  // default-mode gate). `detail` carries what the dialog shows.
  approve: (label: string, detail?: ApproveDetail) => Promise<ApproveVerdict>;
  // Ask the user a multiple-choice question (the `ask_user` tool).
  choose?: (question: string, options: string[], multiSelect: boolean) => Promise<number[]>;
  // Optional — when present, the `task` tool will use this to spawn
  // subagents. AgentLoop wraps it to also fold subagent usage into the
  // parent's cumulative counters and to display a spinner.
  subagentFactory?: SubagentFactory;
  // Snapshot store — threaded onto each tool's ToolExecutionContext so edits
  // are undoable and deletes recoverable. Optional (absent in stub mode).
  checkpoints?: CheckpointStore;
  // When true, the harness runs the project's verification command after any
  // turn that changed files, and feeds failures back to the agent to fix.
  autoVerify: boolean;
  // Explicit verification command — overrides the inferred default.
  verifyCommand?: string;
  // Independent review of each turn's diff by a Review subagent (Phase 4.1).
  // Off in bench mode and with AUTOCODE_NO_REVIEW=1 regardless.
  review: boolean;
  // Machine-readable activity stream for the Automax V6 host. NullEventEmitter
  // when --automax is off; StdoutEventEmitter when it is on.
  emitter: EventEmitter;
  // Permission rules (config + trusted project rules): deny / ask / allow
  // matchers evaluated before the mode gate (Phase 5.4).
  permissions?: PermissionRules;
  // Auto mode's reviewer tier: judges `confirm`-class shell commands in
  // autocode/admin mode (a cheap model; see agent/AutoApprover.ts). Absent =
  // the user is asked, as in default mode.
  judge?: (input: { command: string; reason: string; task: string }) => Promise<{ decision: 'allow' | 'ask'; reason: string }>;
  // Every hook the session has (user config, project hooks.json, plugins),
  // fired here for UserPromptSubmit, PreToolUse, PermissionRequest,
  // PostToolUse, PostToolUseFailure, Stop, PreCompact and PostCompact.
  // SessionStart/SessionEnd fire from the CLI, Subagent* from the runner.
  hooks?: HookHub;
}

export class AgentLoop {
  // Every verification run (check stages, focused and full test runs) also
  // reaches the host as a `verification` event.
  private async verifyAndEmit(command: string, root: string, cancelled: () => boolean): Promise<VerifyResult> {
    const r = await runVerification(command, root, cancelled);
    this.deps.emitter.emit('verification', { command, passed: r.ok, exitCode: r.code, output: r.output.slice(-4_000) });
    return r;
  }

  private cancelled = false;
  // Abort handle for the in-flight LLM request — cancel() aborts it so Esc
  // stops generation immediately instead of waiting for the stream to finish.
  private inflightAbort: AbortController | null = null;
  // Repo-supplied `verify:` directives the user has approved this session
  // (trust-on-first-use for commands the safety policy flags).
  private readonly approvedVerifyCommands = new Set<string>();
  // "Yes, and don't ask again for …" scopes (see approvalScope) for this session.
  private readonly alwaysApproved = new Set<string>();
  private readonly conversation: Message[] = [];
  private cumIn = 0;
  private cumOut = 0;
  private cumCacheRead = 0;
  private cumCacheWrite = 0;
  // Input-token count of the most recent LLM call ≈ current context size;
  // drives auto-compaction.
  private lastInputTokens = 0;
  // Session-scoped accumulators used by the smart-docs reflection at
  // /exit or /reflect time. Per-turn filesChanged is computed inside
  // submit(); this Set is the union across all turns in the session.
  private readonly sessionFilesChanged = new Set<string>();
  private sessionToolCalls = 0;
  // What compaction must bring back (Phase 4.7): skills the agent loaded
  // (use_skill or /<skill>) and the files it changed most recently.
  private readonly invokedSkills = new Set<string>();
  private readonly recentlyChanged = new Map<string, number>();
  // Path-scoped rules already shown this session (each is injected once).
  private readonly injectedRules = new Set<string>();
  // The assistant's final text of the last completed turn (plan approval).
  private lastTurnText = '';

  lastAssistantText(): string {
    return this.lastTurnText;
  }
  // The current turn's user text — personalizes the repo map's query slice.
  // Fixed for the whole turn so the prompt stays byte-stable across
  // iterations (the slice lives in the volatile suffix, after the cache
  // breakpoint, so a new turn's slice never busts the prefix).
  private turnQuery = '';

  constructor(private readonly deps: AgentDeps) {}

  cumulativeUsage(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
    return {
      inputTokens: this.cumIn,
      outputTokens: this.cumOut,
      cacheReadTokens: this.cumCacheRead,
      cacheWriteTokens: this.cumCacheWrite,
    };
  }

  // Input tokens of the most recent LLM call ≈ tokens currently live in the
  // context window (system prompt + tools + conversation). Drives the rail's
  // CONTEXT meter; 0 before the first reply and just after an auto-compact.
  currentContextTokens(): number {
    return this.lastInputTokens;
  }

  // Swap the activity emitter at runtime. Used by the Ink Bridge UI to
  // wrap whatever emitter was passed at construction with a fanout that
  // also routes events into the React state store. The bridge emitter
  // forwards to the original, so --automax JSON output still works when
  // both are active.
  setEmitter(emitter: EventEmitter): void {
    this.deps.emitter = emitter;
  }

  cancel(): void {
    this.cancelled = true;
    // Abort the in-flight LLM request (if any) — the provider forwards this
    // signal to fetch, so generation stops now, not at the next iteration.
    this.inflightAbort?.abort();
  }

  clearConversation(): number {
    const n = this.conversation.length;
    this.conversation.length = 0;
    return n;
  }

  // Restore a prior session's conversation + token counters (session resume).
  loadState(state: { messages: Message[]; usage: CumulativeUsage }): void {
    this.conversation.length = 0;
    this.conversation.push(...state.messages);
    this.cumIn = state.usage.inputTokens;
    this.cumOut = state.usage.outputTokens;
    this.cumCacheRead = state.usage.cacheReadTokens;
    this.cumCacheWrite = state.usage.cacheWriteTokens;
  }

  // Snapshot the conversation to disk so a later process can resume it.
  private persist(): void {
    this.deps.store.saveConversation(this.conversation, this.cumulativeUsage());
  }

  // Compact the conversation: summarize older turns with the LLM and keep
  // the last few verbatim. Falls back to plain truncation if the summary
  // call fails. Used by /compact and by auto-compaction.
  async compactConversation(
    ctx: SessionContext,
    keepPairs = 4,
    trigger: 'manual' | 'auto' = 'manual',
  ): Promise<{ before: number; after: number; summarized: boolean }> {
    const before = this.conversation.length;
    const cut = findCompactionCut(this.conversation, keepPairs);
    if (cut <= 0) return { before, after: before, summarized: false };

    await this.deps.hooks?.fire('PreCompact', { trigger });
    const older = this.conversation.slice(0, cut);
    const kept = this.conversation.slice(cut);
    let summary: string | null = null;
    try {
      summary = await this.summarizeMessages(older, ctx);
    } catch {
      summary = null; // fall back to plain truncation
    }
    this.conversation.length = 0;
    if (summary) {
      this.conversation.push({ role: 'user', content: `[Summary of earlier conversation]\n${summary}` });
    }
    this.conversation.push(...kept);
    const restored = this.compactionRestoreMessage(ctx);
    if (restored) this.conversation.push({ role: 'user', content: restored });
    await this.deps.hooks?.fire('PostCompact', { trigger });
    return { before, after: this.conversation.length, summarized: summary !== null };
  }

  // After compaction the summary keeps decisions but loses material the agent
  // was working from: bring back the skills it loaded and the head of the
  // five most recently changed files (Claude Code's re-read behaviour).
  private compactionRestoreMessage(ctx: SessionContext): string | null {
    const parts: string[] = [];
    let skillBudget = 20_000;
    if (this.invokedSkills.size > 0) {
      const skills = getSkills(ctx.projectRoot);
      for (const name of this.invokedSkills) {
        const s = findSkill(skills, name);
        if (!s || skillBudget <= 0) continue;
        const body = s.body.slice(0, skillBudget);
        parts.push(`<skill name="${name}">\n${body}\n</skill>`);
        skillBudget -= body.length;
      }
    }
    const recent = [...this.recentlyChanged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    let fileBudget = 30_000;
    for (const [rel] of recent) {
      if (fileBudget <= 0) break;
      try {
        const text = readFileSync(join(ctx.projectRoot, rel), 'utf8');
        const lines = text.split(/\r?\n/);
        const head = lines.slice(0, 200).join('\n').slice(0, fileBudget);
        if (head.length === 0) continue;
        parts.push(`<file path="${rel}"${lines.length > 200 ? ` lines="1-200 of ${lines.length}"` : ''}>\n${head}\n</file>`);
        fileBudget -= head.length;
      } catch {
        /* deleted since; nothing to restore */
      }
    }
    if (parts.length === 0) return null;
    return (
      '[Context restored after compaction] The skills you loaded and the files you changed most recently, ' +
      'so you can continue without re-reading them:\n\n' +
      parts.join('\n\n')
    );
  }

  private async summarizeMessages(messages: Message[], ctx: SessionContext): Promise<string> {
    const transcript = messages.map(renderForSummary).join('\n\n');
    const resp = await this.deps.router.complete(ctx.model.provider as ProviderName, {
      // Summarization doesn't need the flagship session model — use the
      // provider's cheap tier (falls back to the session model when the
      // provider has no cheaper bundled option).
      model: summarizerModelFor(ctx.model.provider, ctx.model.model),
      system:
        'You compress coding-assistant conversations. Produce a concise but complete summary that ' +
        'preserves: what the user asked for, key decisions, files created or modified, important ' +
        'findings, and any unfinished work. Use compact bullet points.',
      messages: [{ role: 'user', content: `Summarize this conversation excerpt:\n\n${transcript}` }],
      tools: [],
    });
    this.cumIn += resp.usage.inputTokens;
    this.cumOut += resp.usage.outputTokens;
    const text = resp.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!text) throw new Error('empty summary');
    return text;
  }

  // Whether the session has done enough to be worth reflecting on. Used by
  // TerminalMode to decide whether to auto-trigger smart-docs on /exit.
  hasReflectableActivity(): boolean {
    return this.sessionFilesChanged.size > 0 || this.sessionToolCalls >= 3;
  }

  // Smart docs — ask a small model to look at this session and propose
  // appendable lines for the right-scoped AUTOCODE.md. Returns [] on any
  // LLM error or when nothing meaningful happened. The caller (TerminalMode)
  // handles the user-review UX + writes accepted proposals.
  async reflectOnSession(ctx: SessionContext): Promise<Proposal[]> {
    const snapshot: SessionSnapshot = {
      userPrompts: this.extractUserPrompts(),
      assistantReplies: this.extractAssistantTexts(),
      toolCalls: this.extractToolCallPreviews(),
      filesChanged: [...this.sessionFilesChanged].sort(),
    };
    return runSessionReflection(snapshot, {
      router: this.deps.router,
      provider: ctx.model.provider as ProviderName,
      model: ctx.model.model,
      projectRoot: ctx.projectRoot,
    });
  }

  private extractUserPrompts(): string[] {
    const out: string[] = [];
    for (const m of this.conversation) {
      if (m.role !== 'user') continue;
      const text = typeof m.content === 'string' ? m.content : textOf(m.content);
      if (
        text.trim().length > 0 &&
        !text.startsWith('[Summary of earlier conversation]') &&
        !text.startsWith('[user cancelled') &&
        !text.startsWith('[harness advisory]')
      ) {
        out.push(text);
      }
    }
    return out;
  }

  private extractAssistantTexts(): string[] {
    const out: string[] = [];
    for (const m of this.conversation) {
      if (m.role !== 'assistant' || typeof m.content === 'string') continue;
      const joined = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (joined.length > 0) out.push(joined);
    }
    return out;
  }

  private extractToolCallPreviews(): Array<{ name: string; argsPreview: string }> {
    const out: Array<{ name: string; argsPreview: string }> = [];
    for (const m of this.conversation) {
      if (m.role !== 'assistant' || typeof m.content === 'string') continue;
      for (const b of m.content) {
        if (b.type !== 'tool_use') continue;
        out.push({
          name: b.name,
          argsPreview: JSON.stringify(b.input).slice(0, 200),
        });
      }
    }
    return out;
  }

  async submit(input: string | ContentBlock[], ctx: SessionContext): Promise<void> {
    this.cancelled = false;
    const turnStartedAt = Date.now();
    this.deps.checkpoints?.beginTurn();
    // Rebuild the repo map if last turn's edits made it stale. Turn-boundary
    // (not per-edit) so the system prompt stays byte-stable within a turn —
    // the digest is part of the cached prefix.
    refreshRepoMapIfStale(ctx.projectRoot);
    // The code index (Phase 3): started here as well so headless runs get it,
    // brought up to date with a stat pass at the same turn boundary, and only
    // then adopted as the repo map's source — never mid-turn.
    if (indexEnabled()) {
      startIndex(ctx.projectRoot).catch(() => undefined);
      const index = peekIndex(ctx.projectRoot);
      if (index) {
        try {
          await traced('index.refresh', () => index.refresh({ force: true }));
        } catch {
          /* a failed stat pass keeps the previous graph */
        }
      }
      tracedSync('adoptIndexIfReady', () => adoptIndexIfReady(ctx.projectRoot, ctx.model));
    }
    let userText = typeof input === 'string' ? input : textOf(input);
    this.turnQuery = userText;
    trace('turn: start');
    for (const m of userText.matchAll(/<skill name="([^"]+)">/g)) this.invokedSkills.add(m[1]!);
    // UserPromptSubmit hooks can refuse the prompt (exit 2, reason shown) or
    // add context that rides along inside the user message.
    if (this.deps.hooks?.has('UserPromptSubmit')) {
      const outcomes = await this.deps.hooks.fire('UserPromptSubmit', { prompt: userText.slice(0, 8_000) });
      const reason = blockingReason(outcomes);
      if (reason !== null) {
        this.deps.renderer.error(`Prompt blocked by a UserPromptSubmit hook: ${reason}`);
        this.deps.emitter.emit('failed', { error: `blocked by UserPromptSubmit hook: ${reason}` });
        return;
      }
      const extra = additionalContext(outcomes);
      if (extra.length > 0) {
        const note = `\n\n[hook context]\n${extra.join('\n')}`;
        input = typeof input === 'string' ? `${input}${note}` : [...input, { type: 'text', text: note.trim() }];
        userText = `${userText}${note}`;
      }
    }
    this.deps.store.appendTranscript({ role: 'user', text: userText });
    this.conversation.push({ role: 'user', content: input });

    // Reference-count the subagent spinner — parallel task fan-out means
    // several subagents can be live at once, and a per-call start/stop pair
    // would kill the spinner when the FIRST one finishes.
    let activeSubagents = 0;
    const judge = this.deps.judge;
    const toolExecCtx: ToolExecutionContext = {
      session: ctx,
      confirm: this.deps.confirm,
      choose: this.deps.choose,
      checkpoint: this.deps.checkpoints,
      depth: 0,
      // The reviewer tier only exists where the gate is already 'allow' —
      // default mode keeps asking the user for every risky command.
      judge:
        judge && (ctx.mode === 'autocode' || ctx.mode === 'admin')
          ? async (input) => {
              const j = await judge({ ...input, task: userText });
              if (j.decision === 'allow') this.deps.renderer.dim(`auto mode: allowed "${input.command.slice(0, 80)}" — ${j.reason}`);
              return j;
            }
          : undefined,
      subagentFactory: this.deps.subagentFactory
        ? async (input) => {
            activeSubagents += 1;
            this.deps.renderer.spinner.start(
              activeSubagents > 1 ? `task ×${activeSubagents}` : `task: ${input.description}`,
            );
            try {
              const result = await this.deps.subagentFactory!(input);
              // Fold subagent usage into parent cumulative counters.
              this.cumIn += result.usage.inputTokens;
              this.cumOut += result.usage.outputTokens;
              this.cumCacheRead += result.usage.cacheReadTokens ?? 0;
              this.cumCacheWrite += result.usage.cacheWriteTokens ?? 0;
              return result;
            } finally {
              activeSubagents -= 1;
              if (activeSubagents === 0) this.deps.renderer.spinner.stop();
              else this.deps.renderer.spinner.start(`task ×${activeSubagents}`);
            }
          }
        : undefined,
    };

    const totals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    // Accumulated across all verification rounds — surfaced in the `completed`
    // event so V6 / the host can see which files this turn touched.
    const filesChanged = new Set<string>();
    // Mutable container so runIterations can update the last assistant text
    // we report as the turn's `summary` on completion.
    const turnState = { lastAssistantText: '' };
    try {
      this.deps.emitter.emit('started', {
        task: userText,
        projectRoot: ctx.projectRoot,
        sessionId: ctx.sessionId,
        mode: ctx.mode,
        model: `${ctx.model.provider}/${ctx.model.model}`,
      });
      // Round 0 is the user's actual turn; rounds 1.. are verification-driven
      // fix attempts. After any round that changed files, the harness runs the
      // typecheck/lint stages and the project's verification command and, on
      // failure, feeds the output back. Wrapped so the review round below can
      // run the same loop once more after a fix.
      const runWithVerification = async (): Promise<boolean> => {
      let mutated = false;
      for (let round = 0; round <= MAX_VERIFY_ROUNDS; round++) {
        const r = await this.runIterations(ctx, toolExecCtx, userText, totals, filesChanged, turnState);
        mutated = mutated || r.mutated;
        // Admin mode skips the verify-loop — admin tasks (rename CSVs,
        // archive folders, run scripts) have no "test command" concept,
        // and the existing project verify command (npm test / pytest /
        // etc.) is meaningless after non-code file ops.
        if (
          this.cancelled ||
          !mutated ||
          ctx.mode === 'planning' ||
          ctx.mode === 'admin' ||
          // Sights builds plain static sites — there is no test command to
          // run, and the V6 host performs its own validation pass instead.
          ctx.mode === 'sights' ||
          !this.deps.autoVerify
        ) break;

        // Re-load instructions per round — the agent may have just written
        // (or edited) an AUTOCODE.md with a new `verify:` directive, and we
        // want the next verification round to pick it up.
        const instructions = loadProjectInstructions(ctx.projectRoot);
        const plan = resolveVerifyPlanForFiles(
          ctx.projectRoot,
          this.deps.verifyCommand,
          instructions,
          [...filesChanged],
        );
        if (!plan) break;

        // Safety gate for REPO-SUPPLIED verify commands. An AUTOCODE.md
        // `verify:` directive is repo content — auto-executing it verbatim
        // would let a cloned hostile repo run arbitrary shell after any edit.
        // Override (user config) and inferred (harness-built) commands are
        // trusted; directives pass through the same allow/confirm/block
        // policy as run_shell, with trust-on-first-use per command.
        if (plan.source === 'directive' && !isTrusted(ctx.projectRoot)) {
          this.deps.renderer.warn(`  ✗ verification skipped — the repo's verify command runs only once this folder is trusted ($ ${plan.command})`);
          break;
        }
        if (plan.source === 'directive') {
          const verdict = classifyCommand(plan.command, ctx.projectRoot);
          if (verdict.kind === 'block') {
            this.deps.renderer.warn(
              `  ✗ verification skipped — the repo's verify command was blocked by the safety policy (${verdict.reason}): $ ${plan.command}`,
            );
            break;
          }
          if (verdict.kind === 'confirm' && !this.approvedVerifyCommands.has(plan.command)) {
            const ok = await this.deps.confirm(
              `This repo's AUTOCODE.md asks to run "${plan.command}" as its verify command (${verdict.reason}). Allow it?`,
            );
            if (!ok) {
              this.deps.renderer.warn('  ✗ verification skipped — repo verify command declined');
              break;
            }
            this.approvedVerifyCommands.add(plan.command);
          }
        }

        // Typecheck / lint stages first (Phase 4.1): cheaper than the suite
        // and they catch what tests report late. A failing stage costs one
        // fix round like a failing test run.
        const stages = checkStagesDisabled() || benchMode()
          ? []
          : resolveCheckStages(ctx.projectRoot, [...filesChanged], { skipCommands: [plan.command, plan.fullCommand ?? ''] });
        let stageFailed = false;
        for (const stage of stages) {
          this.deps.renderer.spinner.start(`verifying — ${stage.label}: $ ${stage.command}`);
          const s = await this.verifyAndEmit(stage.command, ctx.projectRoot, () => this.cancelled);
          this.deps.renderer.spinner.stop();
          if (this.cancelled) break;
          if (s.ok || /not recognized|command not found|ENOENT|npm ERR! could not determine executable|Cannot find module/i.test(s.output.slice(0, 400)) && s.code !== 1) {
            if (s.ok) this.deps.renderer.status(`  ✓ ${stage.label} passed`);
            else this.deps.renderer.dim(`  (${stage.label} unavailable — skipped)`);
            continue;
          }
          stageFailed = true;
          if (round === MAX_VERIFY_ROUNDS) {
            this.deps.renderer.warn(`  ✗ ${stage.label} still failing after ${MAX_VERIFY_ROUNDS} fix attempt(s) ($ ${stage.command})`);
            break;
          }
          this.deps.renderer.warn(`  ✗ ${stage.label} failed ($ ${stage.command}) — asking the agent to fix`);
          this.conversation.push({
            role: 'user',
            content:
              `The ${stage.label} (\`${stage.command}\`) failed (exit ${s.code ?? '?'}) after your changes:\n\n` +
              '```\n' +
              s.output +
              '\n```\n\n' +
              'Fix the reported problems, then stop — checks and verification re-run automatically. If a problem is ' +
              'pre-existing and unrelated to your changes, say so briefly and stop.',
          });
          break;
        }
        if (this.cancelled) break;
        if (stageFailed) {
          if (round === MAX_VERIFY_ROUNDS) break;
          continue;
        }

        this.deps.renderer.spinner.start(`verifying — $ ${plan.command}`);
        let v = await this.verifyAndEmit(plan.command, ctx.projectRoot, () => this.cancelled);
        this.deps.renderer.spinner.stop();
        if (this.cancelled) break;

        // Scoped run hit a runner-config mismatch (the mapped test file exists
        // but the runner's include patterns exclude it) — fall back to the
        // full suite for a truthful signal instead of a misleading fix loop.
        if (!v.ok && plan.fullCommand && /No test files found/i.test(v.output)) {
          this.deps.renderer.spinner.start(`verifying — $ ${plan.fullCommand}`);
          v = await this.verifyAndEmit(plan.fullCommand, ctx.projectRoot, () => this.cancelled);
          this.deps.renderer.spinner.stop();
          if (this.cancelled) break;
          plan.command = plan.fullCommand;
          plan.fullCommand = null;
        }

        if (v.ok && plan.fullCommand) {
          // Focused tests pass — escalate ONCE to the full suite. Scoped
          // passing while something else silently broke is exactly the
          // regression the verify loop exists to catch.
          this.deps.renderer.status(`  ✓ focused tests passed ($ ${plan.command})`);
          this.deps.renderer.spinner.start(`verifying full suite — $ ${plan.fullCommand}`);
          const fullRun = await this.verifyAndEmit(plan.fullCommand, ctx.projectRoot, () => this.cancelled);
          this.deps.renderer.spinner.stop();
          if (this.cancelled) break;
          if (fullRun.ok) {
            this.deps.renderer.status(`  ✓ verification passed ($ ${plan.fullCommand})`);
            break;
          }
          if (round === MAX_VERIFY_ROUNDS) {
            this.deps.renderer.warn(
              `  ✗ full suite still failing after ${MAX_VERIFY_ROUNDS} fix attempt(s) ($ ${plan.fullCommand})`,
            );
            break;
          }
          this.deps.renderer.warn(
            `  ✗ full suite failed after focused tests passed ($ ${plan.fullCommand}) — asking the agent to fix`,
          );
          this.conversation.push({
            role: 'user',
            content:
              `The focused tests for your changed files pass, but the full suite ` +
              `\`${plan.fullCommand}\` fails (exit ${fullRun.code ?? '?'}) — likely a regression ` +
              `elsewhere in the project caused by your changes:\n\n` +
              '```\n' +
              fullRun.output +
              '\n```\n\n' +
              'Fix the regressions, then stop — verification re-runs automatically. If these ' +
              'failures are pre-existing and unrelated to your changes, do not try to fix ' +
              'them; say so briefly and stop.',
          });
          continue;
        }

        if (v.ok) {
          this.deps.renderer.status(`  ✓ verification passed ($ ${plan.command})`);
          break;
        }
        if (round === MAX_VERIFY_ROUNDS) {
          this.deps.renderer.warn(
            `  ✗ verification still failing after ${MAX_VERIFY_ROUNDS} fix attempt(s) ($ ${plan.command})`,
          );
          break;
        }
        // Failures only in files this turn did not touch and that do not
        // reach the changed files through the import graph are pre-existing:
        // report them once instead of looping on them (Phase 4.1).
        const failing = extractFailingPaths(v.output, ctx.projectRoot);
        const triage = triageFailures(peekIndex(ctx.projectRoot), [...filesChanged], failing);
        if (triage.decidable && triage.related.length === 0 && triage.unrelated.length > 0) {
          const note = describeUnrelated(triage, plan.command);
          this.deps.renderer.warn(`  ✗ ${note}`);
          this.conversation.push({ role: 'user', content: `[harness] ${note} Mention it to the user in one sentence and stop.` });
          const again = await this.runIterations(ctx, toolExecCtx, userText, totals, filesChanged, turnState);
          mutated = mutated || again.mutated;
          break;
        }
        this.deps.renderer.warn(`  ✗ verification failed ($ ${plan.command}) — asking the agent to fix`);
        this.conversation.push({
          role: 'user',
          content:
            `The verification command \`${plan.command}\` failed (exit ${v.code ?? '?'}) after your changes:\n\n` +
            '```\n' +
            v.output +
            '\n```\n\n' +
            'Fix the failures, then stop — verification re-runs automatically. If these ' +
            'failures are pre-existing and unrelated to your changes, do not try to fix ' +
            'them; say so briefly and stop.',
        });
      }
      return mutated;
      };

      let mutated = await runWithVerification();
      // Independent review of the diff before the turn ends (Phase 4.1): a
      // fresh-context reader reports bugs, regressions and scope creep; a
      // high-severity finding buys exactly one fix round, verified again.
      if (mutated && !this.cancelled && this.shouldReview(ctx)) {
        const fixRequest = await this.reviewTurn(ctx, userText, filesChanged, totals);
        if (fixRequest && !this.cancelled) {
          this.conversation.push({ role: 'user', content: fixRequest });
          mutated = (await runWithVerification()) || mutated;
        }
      }
      // Stop hooks: exit 2 (or a deny decision) asks the agent to keep going
      // with the hook's reason, at most MAX_STOP_HOOK_ROUNDS times per turn.
      let stopRounds = 0;
      while (!this.cancelled && this.deps.hooks?.has('Stop')) {
        const outcomes = await this.deps.hooks.fire('Stop', { stop_hook_active: stopRounds > 0 });
        const reason = blockingReason(outcomes);
        if (reason === null) break;
        if (stopRounds >= MAX_STOP_HOOK_ROUNDS) {
          this.deps.renderer.warn(`  ✗ Stop hook still asks to continue after ${MAX_STOP_HOOK_ROUNDS} rounds — stopping anyway`);
          break;
        }
        stopRounds += 1;
        this.deps.renderer.warn(`  ↻ Stop hook asks to continue (${stopRounds}/${MAX_STOP_HOOK_ROUNDS})`);
        this.conversation.push({ role: 'user', content: `[Stop hook] ${reason}` });
        mutated = (await runWithVerification()) || mutated;
      }
      if (this.cancelled) {
        this.deps.emitter.emit('failed', { error: 'cancelled by user' });
      } else {
        this.lastTurnText = turnState.lastAssistantText;
        this.deps.emitter.emit('completed', {
          summary: turnState.lastAssistantText,
          filesChanged: [...filesChanged],
        });
      }
      tracedSync('emitTurnEnd', () => this.emitTurnEnd(turnStartedAt, totals, ctx), 50);
      trace('turn: end');
    } catch (e) {
      this.deps.emitter.emit('failed', { error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      // Persist the conversation after every turn — natural end, iteration
      // cap, cancel, or exception — so the session is always resumable.
      tracedSync('persist', () => this.persist(), 50);
    }
  }

  // One run of the agent's tool-use loop: repeatedly call the LLM and execute
  // its tool calls until it ends the turn (or the iteration cap is hit).
  // Returns whether any file-mutating tool succeeded — which tells submit()
  // whether the result is worth verifying.
  private async runIterations(
    ctx: SessionContext,
    toolExecCtx: ToolExecutionContext,
    userText: string,
    totals: { in: number; out: number; cacheRead: number; cacheWrite: number },
    filesChanged: Set<string>,
    turnState: { lastAssistantText: string },
  ): Promise<{ mutated: boolean }> {
    const recentToolSigs: string[] = [];
    const consecutiveFailures = new Map<string, number>();
    let mutated = false;
    // Per-turn iteration backstop. Defaults to MAX_ITERATIONS but the budget
    // can raise it — the benchmark harness governs by cost instead and only
    // wants this as a loose runaway guard.
    const maxIterations = ctx.budget?.maxIterations ?? MAX_ITERATIONS;

    for (let iter = 0; iter < maxIterations; iter++) {
      if (this.cancelled) {
        this.deps.renderer.spinner.stop();
        this.deps.renderer.dim('[Request interrupted by user]');
        this.conversation.push({ role: 'user', content: '[user cancelled the task]' });
        // Mark any in-progress todo as 'interrupted' so the user can see at
        // a glance where we stopped.
        markInProgressInterrupted(ctx.sessionId);
        return { mutated };
      }
      // Two-tier context management. Tier 1 (cheap, at 60% of window): clear
      // old tool outputs — stale reads are re-fetchable, decisions are what
      // matter. Tier 2 (expensive, at 80%): full LLM summarization — rarely
      // fires once masking holds the line.
      if (shouldAutoCompact(this.lastInputTokens, ctx.model.provider, ctx.model.model)) {
        this.deps.renderer.dim('  (auto-compacting — conversation context is getting large)');
        await this.compactConversation(ctx, 4, 'auto');
        this.lastInputTokens = 0;
      } else if (shouldMaskObservations(this.lastInputTokens, ctx.model.provider, ctx.model.model)) {
        const masked = maskOldToolResults(this.conversation);
        if (masked > 0) {
          this.deps.renderer.dim(`  (cleared ${masked} old tool outputs — context was getting large)`);
        }
      }
      // Cost-budget backstop: once the turn's accumulated model cost crosses
      // the configured ceiling, stop before paying for another call. The model
      // is deliberately NOT told about this — a generous budget means honest
      // work finishes on its own first, and surfacing a shrinking budget just
      // provokes rushed, low-quality last-ditch attempts.
      const maxCostUsd = ctx.budget?.maxCostUsd;
      if (maxCostUsd !== undefined && maxCostUsd > 0) {
        const { cost } = estimateCost(
          {
            inputTokens: totals.in,
            outputTokens: totals.out,
            cacheReadTokens: totals.cacheRead,
            cacheWriteTokens: totals.cacheWrite,
          },
          ctx.model.provider,
          ctx.model.model,
        );
        if (cost > maxCostUsd) {
          this.deps.renderer.warn(
            `(stopped — turn cost $${cost.toFixed(2)} reached the $${maxCostUsd.toFixed(2)} budget)`,
          );
          this.deps.store.touch(null);
          return { mutated };
        }
      }
      this.deps.store.touch(userText.slice(0, 80));
      trace(`iter ${iter}: request start (messages=${this.conversation.length}, lastInput=${this.lastInputTokens})`);

      this.deps.renderer.spinner.start('thinking');
      let response: { content: ContentBlock[]; stopReason: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } } | null = null;
      let firstTextSeen = false;
      let firstEventSeen = false;
      const abort = new AbortController();
      this.inflightAbort = abort;
      try {
        const { system, systemVolatile } = buildSystemPromptParts(ctx, { query: this.turnQuery });
        const stream = this.deps.router.completeStream(
          ctx.model.provider as ProviderName,
          {
            model: ctx.model.model,
            system,
            systemVolatile,
            messages: this.conversation,
            tools: this.deps.registry.schemas(),
            // Providers default to 8192 output tokens — too small for large
            // single-file writes. Deterministic sampling unless configured.
            maxTokens: defaultMaxOutputTokens(ctx.model.model, ctx.model.provider),
            temperature: ctx.sampling?.temperature ?? 0,
            // Extended thinking, when the model supports the request param
            // (`/effort`; kill switch: AUTOCODE_NO_THINKING=1).
            thinking: thinkingFor(ctx.model.provider, ctx.model.model, ctx.effort),
            // Server-side context editing (Anthropic beta): trigger at 50%
            // of the window — BELOW the client-side mask tier (60%) — so the
            // cache-preserving server path does the clearing and the
            // cache-busting client mask rarely fires. Providers without
            // support ignore this; the client tiers remain the fallback.
            contextEditing: {
              triggerInputTokens: Math.floor(
                contextWindowFor(ctx.model.provider, ctx.model.model) * 0.5,
              ),
            },
            signal: abort.signal,
          },
        );
        let thinkingStartedAt = 0;
        const noteThinkingDone = (): void => {
          if (thinkingStartedAt > 0) {
            // Ink commits a collapsed "Thought for Ns" stub; plain prints a line.
            this.deps.renderer.thinkingEnd(Date.now() - thinkingStartedAt);
            thinkingStartedAt = 0;
          }
        };
        for await (const evt of stream as AsyncIterable<StreamEvent>) {
          if (!firstEventSeen) {
            firstEventSeen = true;
            trace(`iter ${iter}: first stream event (${evt.type})`);
          }
          if (evt.type === 'thinking_delta') {
            // Reasoning trace streaming in — the Ink UI shows its tail live and
            // collapses it on transition; the plain path only times it.
            if (thinkingStartedAt === 0) thinkingStartedAt = Date.now();
            this.deps.renderer.thinkingChunk(evt.text);
          } else if (evt.type === 'text_delta') {
            noteThinkingDone();
            // The reply is buffered (rendered as styled markdown at the end),
            // so the spinner keeps running while it arrives — no silent gap.
            if (!firstTextSeen) {
              this.deps.renderer.beginAssistantStream();
              firstTextSeen = true;
            }
            this.deps.renderer.streamChunk(evt.text);
          } else if (evt.type === 'tool_use_start') {
            noteThinkingDone();
            this.deps.renderer.spinner.stop();
            if (firstTextSeen) {
              this.deps.renderer.endAssistantStream();
              firstTextSeen = false;
            }
            this.deps.renderer.spinner.start(evt.name);
          } else if (evt.type === 'message_stop') {
            noteThinkingDone();
            response = evt.response;
          }
        }
      } catch (e) {
        // Esc mid-generation: cancel() aborted the in-flight request. Swallow
        // the abort error and loop — the cancellation check at the top of the
        // next iteration performs the normal cleanup + exit.
        if (this.cancelled && isAbortError(e)) continue;
        throw e;
      } finally {
        this.inflightAbort = null;
        this.deps.renderer.spinner.stop();
        if (firstTextSeen) this.deps.renderer.endAssistantStream();
      }

      trace(`iter ${iter}: stream end (${response ? response.stopReason : 'no message_stop'})`);
      if (!response) {
        this.deps.renderer.error('stream ended without a message_stop event');
        return { mutated };
      }

      totals.in += response.usage.inputTokens;
      totals.out += response.usage.outputTokens;
      totals.cacheRead += response.usage.cacheReadTokens ?? 0;
      totals.cacheWrite += response.usage.cacheWriteTokens ?? 0;
      this.cumIn += response.usage.inputTokens;
      this.cumOut += response.usage.outputTokens;
      this.cumCacheRead += response.usage.cacheReadTokens ?? 0;
      this.cumCacheWrite += response.usage.cacheWriteTokens ?? 0;
      // Context size = everything the request carried: fresh input plus the
      // cached prefix (inputTokens excludes cache reads on every provider).
      this.lastInputTokens = response.usage.inputTokens + (response.usage.cacheReadTokens ?? 0) + (response.usage.cacheWriteTokens ?? 0);

      this.conversation.push({ role: 'assistant', content: response.content });

      // Transcript log: capture the streamed text portions.
      const assistantTextParts: string[] = [];
      for (const b of response.content) {
        if (b.type === 'text' && b.text.trim().length > 0) {
          this.deps.store.appendTranscript({ role: 'assistant', text: b.text });
          assistantTextParts.push(b.text);
        }
      }
      // The last iteration's assistant text becomes the turn's `completed`
      // summary — overwriting any intermediate iteration's text.
      if (assistantTextParts.length > 0) {
        turnState.lastAssistantText = assistantTextParts.join('\n').trim();
      }

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0 || response.stopReason === 'end_turn') {
        this.deps.store.touch(null);
        return { mutated };
      }

      const toolResults: ContentBlock[] = [];
      const toolImages: ImageBlock[] = [];

      // Parallel fan-out: a batch of pure `task` calls runs concurrently.
      // Explore subagents are read-only context firewalls, so concurrent
      // dispatch is safe (this is NOT parallel writers — the industry
      // anti-pattern). Mixed batches stay sequential below.
      const parallelTasks =
        toolUses.length >= 2 &&
        toolUses.every((b) => b.type === 'tool_use' && b.name === 'task');
      if (parallelTasks) {
        const settled = await Promise.all(
          toolUses.map(async (tu) => {
            if (tu.type !== 'tool_use') return null;
            const sig = `${tu.name}:${stableStringify(tu.input)}`;
            recentToolSigs.push(sig);
            if (recentToolSigs.length > LOOP_DETECT_WINDOW) recentToolSigs.shift();
            this.sessionToolCalls += 1;
            this.deps.emitter.emit('tool_call', { name: tu.name, args: tu.input });
            const t0 = Date.now();
            const result = await this.deps.registry.execute(tu.name, tu.input, toolExecCtx);
            const dt = Date.now() - t0;
            this.deps.emitter.emit('tool_result', {
              name: tu.name,
              summary: result.summary,
              content: result.content,
              isError: result.isError === true,
              durationMs: dt,
              metadata: result.metadata,
            });
            this.deps.store.appendToolLog({
              tool: tu.name,
              arguments: tu.input,
              status: result.isError ? 'error' : 'success',
              durationMs: dt,
              summary: result.summary,
              error: result.isError ? result.content.slice(0, 500) : undefined,
            });
            this.deps.renderer.dim(`  → ${tu.name}  ${result.summary}  (${dt}ms)`);
            return { tu, result };
          }),
        );
        for (const s of settled) {
          if (!s) continue;
          if (s.result.isError) {
            consecutiveFailures.set(s.tu.name, (consecutiveFailures.get(s.tu.name) ?? 0) + 1);
          } else {
            consecutiveFailures.set(s.tu.name, 0);
          }
          toolResults.push({
            type: 'tool_result',
            toolUseId: s.tu.id,
            content: s.result.content,
            isError: s.result.isError,
          });
        }
      }

      for (const tu of parallelTasks ? [] : toolUses) {
        if (tu.type !== 'tool_use') continue;
        const sig = `${tu.name}:${stableStringify(tu.input)}`;
        recentToolSigs.push(sig);
        if (recentToolSigs.length > LOOP_DETECT_WINDOW) recentToolSigs.shift();
        this.sessionToolCalls += 1;

        // Activity events for the Automax host. tool_call gives the
        // mechanical detail (name + args); file_edit_proposed is a semantic
        // shortcut so V6 can surface "autocode wants to edit X" without
        // parsing the tool args.
        this.deps.emitter.emit('tool_call', { name: tu.name, args: tu.input });
        emitFileEditProposed(this.deps.emitter, tu.name, tu.input);

        // Permission rules first (Phase 5.4): deny refuses outright, allow
        // skips the approval a mode would ask for, ask forces one.
        const perm = decidePermission(this.deps.permissions ?? {}, tu.name, tu.input);
        if (perm.decision === 'deny') {
          const content = `Denied by permission rule "${perm.rule}". Choose a different approach.`;
          toolResults.push({ type: 'tool_result', toolUseId: tu.id, content, isError: true });
          this.deps.emitter.emit('tool_result', { name: tu.name, summary: 'denied by permission rule', content, isError: true });
          this.deps.renderer.warn(`  ✗ ${tu.name} denied by permission rule "${perm.rule}"`);
          consecutiveFailures.set(tu.name, (consecutiveFailures.get(tu.name) ?? 0) + 1);
          continue;
        }
        // Mode gate: planning blocks mutating tools; default asks first.
        let gate = gateFor(ctx.mode, tu.name);
        if (perm.decision === 'allow' && gate === 'approve') gate = 'allow';
        if (perm.decision === 'ask' && gate === 'allow') gate = 'approve';
        if (gate === 'block') {
          toolResults.push({
            type: 'tool_result',
            toolUseId: tu.id,
            content:
              'Planning mode is active — file edits and commands are disabled. ' +
              'Produce a clear plan describing the changes instead; the user can switch ' +
              'out of planning mode (Shift+Tab) to apply it.',
            isError: true,
          });
          this.deps.emitter.emit('tool_result', {
            name: tu.name,
            summary: 'blocked (planning mode)',
            content: 'Planning mode is active — file edits and commands are disabled.',
            isError: true,
          });
          this.deps.renderer.dim(`  ✗ ${tu.name} blocked (planning mode)`);
          continue;
        }
        const scope = approvalScope(tu.name, tu.input);
        if (gate === 'approve' && !this.alwaysApproved.has(scope.key)) {
          // PermissionRequest hooks see the call before the user does and
          // can allow or deny it outright (Claude Code's contract).
          const permOutcomes = (await this.deps.hooks?.fire('PermissionRequest', { tool_name: tu.name, tool_input: tu.input })) ?? [];
          const perm = permissionDecision(permOutcomes);
          const hookReason = blockingReason(permOutcomes);
          let verdict: Awaited<ReturnType<AgentDeps['approve']>>;
          if (perm.decision === 'allow') {
            this.deps.renderer.dim(`  hook[PermissionRequest]: allowed ${tu.name}${perm.reason ? ` — ${perm.reason}` : ''}`);
            verdict = { decision: 'accept' };
          } else if (perm.decision === 'deny' || hookReason !== null) {
            verdict = { decision: 'revise', guidance: perm.reason ?? hookReason ?? 'denied by a PermissionRequest hook' };
          } else {
            // The dialog shows the preview (the command, or the edit as a
            // diff); "Yes, and don't ask again" remembers the scope.
            const preview = formatToolPreview(tu.name, tu.input);
            verdict = await this.deps.approve(`Run ${tu.name}?`, {
              tool: tu.name,
              args: tu.input,
              preview,
              scope: scope.label,
            });
          }
          if (verdict.decision === 'accept_always') this.alwaysApproved.add(scope.key);
          if (verdict.decision !== 'accept' && verdict.decision !== 'accept_always') {
            const content =
              verdict.decision === 'revise'
                ? `User declined this tool call and asks you to revise the approach: ${verdict.guidance || '(no guidance given)'}`
                : 'User declined this tool call. Adapt your plan.';
            toolResults.push({ type: 'tool_result', toolUseId: tu.id, content, isError: true });
            this.deps.emitter.emit('tool_result', {
              name: tu.name,
              summary: verdict.decision,
              content,
              isError: true,
            });
            this.deps.renderer.dim(`  ✗ ${tu.name} ${verdict.decision}`);
            continue;
          }
        }

        // PreToolUse hooks — can block the call (exit 2 or a `deny`
        // decision; stderr / reason goes back to the model as the tool
        // result), rewrite its input (`updatedInput`), or add context.
        trace(`tool pre-hooks ${tu.name}`);
        const preOutcomes = (await this.deps.hooks?.fire('PreToolUse', { tool_name: tu.name, tool_input: tu.input })) ?? [];
        const rewritten = updatedInput(preOutcomes);
        if (rewritten) {
          tu.input = rewritten;
          this.deps.renderer.dim(`  hook[PreToolUse]: input of ${tu.name} updated`);
        }
        const blockReason = blockingReason(preOutcomes);
        if (blockReason !== null) {
          this.deps.renderer.warn(`  ✗ ${tu.name} blocked by a PreToolUse hook`);
          toolResults.push({
            type: 'tool_result',
            toolUseId: tu.id,
            content: blockReason,
            isError: true,
          });
          this.deps.emitter.emit('tool_result', {
            name: tu.name,
            summary: 'blocked by PreToolUse hook',
            content: blockReason,
            isError: true,
          });
          consecutiveFailures.set(tu.name, (consecutiveFailures.get(tu.name) ?? 0) + 1);
          continue;
        }

        this.deps.renderer.spinner.start(`${tu.name}`);
        const t0 = Date.now();
        // One step per tool execution — any snapshots the tool takes land
        // under one step number so step-level /undo rewinds exactly one
        // tool's worth of work.
        this.deps.checkpoints?.beginStep();
        trace(`tool start ${tu.name}`);
        const result = await this.deps.registry.execute(tu.name, tu.input, toolExecCtx);
        const dt = Date.now() - t0;
        trace(`tool end ${tu.name} ${dt}ms${result.isError ? ' (error)' : ''}`);
        this.deps.renderer.spinner.stop();
        if (tu.name === 'use_skill' && !result.isError && typeof tu.input['name'] === 'string') {
          this.invokedSkills.add(tu.input['name'] as string);
        }
        // Hosts render the checklist from this event (the Plan card in Automax).
        if (tu.name === 'todo_write' && !result.isError) {
          this.deps.emitter.emit('todo', { items: currentTodos(ctx.sessionId).map((t) => ({ id: t.id, text: t.text, status: t.status })) });
        }
        this.deps.emitter.emit('tool_result', {
          name: tu.name,
          summary: result.summary,
          content: result.content,
          isError: result.isError === true,
          durationMs: dt,
          metadata: result.metadata,
        });

        if (result.isError) {
          consecutiveFailures.set(tu.name, (consecutiveFailures.get(tu.name) ?? 0) + 1);
        } else {
          consecutiveFailures.set(tu.name, 0);
          if (FILE_MUTATING_TOOLS.has(tu.name)) {
            mutated = true;
            invalidateRepoMap(ctx.projectRoot);
            for (const p of pathsTouched(tu.input)) {
              filesChanged.add(p);
              this.sessionFilesChanged.add(p);
              this.recentlyChanged.set(p, Date.now());
            }
          } else if (tu.name === 'run_shell') {
            // Shell commands can change files too (sed -i, codegen, mv, npm
            // install …) — those edits must not escape the verify loop. We
            // can't know which files changed, so mark the turn mutated unless
            // the command is conservatively read-only. False positives just
            // run the verify command once; false negatives skip the safety
            // net entirely.
            const cmd = typeof (tu.input as { command?: unknown }).command === 'string'
              ? ((tu.input as { command: string }).command)
              : '';
            if (!isReadOnlyShellCommand(cmd)) {
              mutated = true;
              invalidateRepoMap(ctx.projectRoot);
            }
          }
        }

        this.deps.store.appendToolLog({
          tool: tu.name,
          arguments: tu.input,
          status: result.isError ? 'error' : 'success',
          durationMs: dt,
          summary: result.summary,
          error: result.isError ? result.content.slice(0, 500) : undefined,
        });
        this.deps.renderer.dim(`  → ${tu.name}  ${result.summary}  (${dt}ms)`);

        const md = result.metadata as { before?: string; after?: string; path?: string } | undefined;
        if (!result.isError && md && typeof md.before === 'string' && typeof md.after === 'string') {
          this.deps.renderer.diff(md.path ?? tu.name, md.before, md.after);
        }

        // Wrap web tool outputs in an explicit untrusted-content marker so
        // the model treats embedded text as DATA, not as instructions.
        // System prompt has a matching directive telling the model how to
        // handle this marker. Doesn't fully defeat prompt injection but
        // raises the bar meaningfully on weaker models.
        let content = result.content;
        if (!result.isError && (tu.name === 'web_fetch' || tu.name === 'web_search')) {
          const url =
            (tu.input as { url?: string; query?: string }).url ??
            (tu.input as { url?: string; query?: string }).query ??
            '';
          content = `<external_untrusted_content tool="${tu.name}" source=${JSON.stringify(url)}>\n${content}\n</external_untrusted_content>`;
        }
        // Path-scoped project rules ride in with the first result that
        // touches a file they cover — precise, and outside the cached prefix.
        if (!result.isError) {
          const touched = FILE_MUTATING_TOOLS.has(tu.name) ? pathsTouched(tu.input) : tu.name === 'read_file' && typeof tu.input['path'] === 'string' ? [String(tu.input['path'])] : [];
          const notes: string[] = [];
          for (const p of touched) {
            const rel = p.replace(/\\/g, '/').replace(/^\.\//, '');
            for (const rule of rulesForPath(getRules(ctx.projectRoot), rel)) {
              if (this.injectedRules.has(rule.name)) continue;
              this.injectedRules.add(rule.name);
              notes.push(renderRule(rule));
            }
          }
          if (notes.length > 0) content = `${content}\n\n${notes.join('\n\n')}`;
        }
        toolResults.push({
          type: 'tool_result',
          toolUseId: tu.id,
          content,
          isError: result.isError,
        });
        // A tool may return an image (e.g. capture_screenshot) — collect it
        // so the agent can actually see it on the next turn.
        const img = (result.metadata as { image?: unknown } | undefined)?.image;
        if (img && typeof img === 'object' && (img as { type?: string }).type === 'image') {
          toolImages.push(img as ImageBlock);
        }

        // PostToolUse / PostToolUseFailure hooks — advisory (lint after
        // edits, audit log, formatter); `additionalContext` from a hook is
        // appended to the tool result so the model sees it.
        const postEvent = result.isError ? 'PostToolUseFailure' : 'PostToolUse';
        const postOutcomes =
          (await this.deps.hooks?.fire(postEvent, {
            tool_name: tu.name,
            tool_input: tu.input,
            tool_response: result.content.slice(0, 8_000),
            tool_error: result.isError ? result.content.slice(0, 8_000) : undefined,
          })) ?? [];
        const extra = additionalContext([...preOutcomes, ...postOutcomes]);
        if (extra.length > 0) {
          const last = toolResults[toolResults.length - 1];
          if (last && last.type === 'tool_result' && last.toolUseId === tu.id && typeof last.content === 'string') {
            last.content = `${last.content}\n\n[hook context]\n${extra.join('\n')}`;
          }
        }
        trace(`tool done ${tu.name}`);
      }
      trace(`iter ${iter}: tools done`);

      // Harness advisories (loop detection, retry caps) ride in a SEPARATE
      // follow-up user message as plain text — NOT as tool_result blocks.
      // A tool_result whose id has no matching tool_use is an API error on
      // Anthropic ("unexpected tool_use_id"), and other providers translate
      // tool_results into role:"tool" messages that must reference a real
      // call id.
      const advisories: string[] = [];
      const loopOffender = detectLoop(recentToolSigs, LOOP_DETECT_THRESHOLD);
      if (loopOffender) {
        advisories.push(
          `[harness advisory] You have called \`${loopOffender}\` with the same (or very similar) arguments ${LOOP_DETECT_THRESHOLD}+ times recently. ` +
            `Stop and reflect: the previous calls likely already gave you the information you need, or the approach is wrong. ` +
            `Summarize what you have learned and propose a different next step. Do not call this tool with these arguments again.`,
        );
        recentToolSigs.length = 0;
      }

      for (const [tool, count] of consecutiveFailures.entries()) {
        if (count >= MAX_RETRIES_PER_TOOL) {
          advisories.push(
            `[harness advisory] \`${tool}\` has failed ${count} times in a row. Stop retrying. Summarize what went wrong and ask the user for guidance, or try a fundamentally different approach.`,
          );
          consecutiveFailures.set(tool, 0);
        }
      }

      this.conversation.push({ role: 'user', content: toolResults });
      // Images returned by tools ride in a follow-up user message so the
      // model can see them (tool_result blocks are text-only here).
      if (toolImages.length > 0) {
        this.conversation.push({
          role: 'user',
          content: [...toolImages, { type: 'text', text: '(images returned by the tool calls above)' }],
        });
      }
      if (advisories.length > 0) {
        this.conversation.push({
          role: 'user',
          content: [{ type: 'text', text: advisories.join('\n\n') }],
        });
      }
    }

    this.deps.renderer.warn(`(stopped after ${maxIterations} iterations)`);
    this.deps.store.touch(null);
    return { mutated };
  }

  private shouldReview(ctx: SessionContext): boolean {
    if (!this.deps.review || benchMode() || process.env.AUTOCODE_NO_REVIEW === '1') return false;
    if (ctx.mode !== 'default' && ctx.mode !== 'autocode') return false;
    return Boolean(this.deps.subagentFactory && this.deps.checkpoints);
  }

  // Run the Review subagent over the turn's diff. Rendered as a `Review(N
  // files)` row like a tool call. Returns the fix request for the main agent
  // when the review found high-severity issues, null otherwise.
  private async reviewTurn(
    ctx: SessionContext,
    userText: string,
    filesChanged: Set<string>,
    totals: { in: number; out: number; cacheRead: number; cacheWrite: number },
  ): Promise<string | null> {
    const factory = this.deps.subagentFactory;
    const changes = this.deps.checkpoints?.changesForCurrentTurn() ?? [];
    if (!factory || changes.length === 0) return null;
    const diff = buildTurnDiff(ctx.projectRoot, changes);
    if (diff.files.length === 0) return null;
    const files = diff.files.length > 0 ? diff.files : [...filesChanged];

    this.deps.emitter.emit('tool_call', { name: 'review', args: { files } });
    this.deps.renderer.spinner.start('reviewing changes');
    const t0 = Date.now();
    let result: ReturnType<typeof parseReviewResult> = null;
    let raw = '';
    let error: string | undefined;
    let iterations = 0;
    let toolUses = 0;
    let usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined;
    try {
      const run = await factory({
        type: 'Review',
        prompt: buildReviewRequest({ request: userText, diff: diff.text, files, truncated: diff.truncated }),
        description: 'Reviewing changes',
        parentDepth: 0,
        parent: ctx,
      });
      raw = run.text;
      usage = run.usage;
      iterations = run.iterations;
      toolUses = run.toolCalls ?? run.iterations;
      error = run.error;
      this.cumIn += run.usage.inputTokens;
      this.cumOut += run.usage.outputTokens;
      this.cumCacheRead += run.usage.cacheReadTokens ?? 0;
      this.cumCacheWrite += run.usage.cacheWriteTokens ?? 0;
      totals.in += run.usage.inputTokens;
      totals.out += run.usage.outputTokens;
      totals.cacheRead += run.usage.cacheReadTokens ?? 0;
      totals.cacheWrite += run.usage.cacheWriteTokens ?? 0;
      result = parseReviewResult(run.text);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      this.deps.renderer.spinner.stop();
    }
    const dt = Date.now() - t0;
    const blocking = result ? blockingFindings(result) : [];
    const summary = !result
      ? 'review unavailable'
      : result.verdict === 'approve'
        ? 'approved'
        : `${blocking.length} high, ${result.findings.length} total`;
    const content = result ? renderReviewResult(result) : `(review unavailable: ${error ?? 'no parsable result'})\n${raw.slice(0, 2_000)}`;
    this.deps.emitter.emit('tool_result', {
      name: 'review',
      summary,
      content,
      isError: !result,
      durationMs: dt,
      metadata: {
        verdict: result?.verdict,
        findings: result?.findings ?? [],
        scopeCreep: result?.scopeCreep,
        files,
        iterations,
        toolUses,
        usage,
        error,
      },
    });
    this.deps.store.appendToolLog({
      tool: '[review]',
      arguments: { files },
      status: result ? 'success' : 'error',
      durationMs: dt,
      summary,
      error: result ? undefined : (error ?? raw.slice(0, 500)),
    });
    this.deps.renderer.dim(`  → review  ${summary}  (${dt}ms)`);
    if (result && blocking.length > 0) {
      this.deps.renderer.warn(`  ✗ review found ${blocking.length} high-severity issue${blocking.length === 1 ? '' : 's'} — asking the agent to fix`);
      return renderFixRequest(result);
    }
    return null;
  }

  // One line per turn. The Ink UI renders it as Claude Code's
  // "✻ Sautéed for 23s · done 6:05 PM"; the plain path prints the token/cost
  // account it always printed.
  private emitTurnEnd(
    startedAt: number,
    totals: { in: number; out: number; cacheRead: number; cacheWrite: number },
    ctx: SessionContext,
  ): void {
    const todos = currentTodos(ctx.sessionId);
    const done = todos.filter((t) => t.status === 'completed').length;
    const interrupted = todos.filter((t) => t.status === 'interrupted').length;
    const usage = {
      inputTokens: totals.in,
      outputTokens: totals.out,
      cacheReadTokens: totals.cacheRead,
      cacheWriteTokens: totals.cacheWrite,
    };
    const { cost } = estimateCost(usage, ctx.model.provider, ctx.model.model);
    const now = Date.now();
    this.deps.renderer.turnEnd({
      durationMs: now - startedAt,
      endedAt: now,
      ...usage,
      costUsd: cost,
      todos: { done, total: todos.length, interrupted },
    });
  }
}

// The scope "Yes, and don't ask again" covers — Claude Code's rule: for shell
// commands, commands that start with the same first word; for file tools, that
// tool for the rest of the session.
function approvalScope(toolName: string, input: Record<string, unknown>): { key: string; label: string } {
  if (toolName === 'run_shell') {
    const cmd = typeof input.command === 'string' ? input.command.trim() : '';
    const first = cmd.split(/\s+/)[0] ?? '';
    return { key: `run_shell:${first}`, label: first ? `commands that start with "${first}"` : 'shell commands' };
  }
  const labels: Record<string, string> = {
    edit_file: 'file edits',
    write_file: 'file writes',
    delete_path: 'deletions',
    create_directory: 'directory creation',
  };
  return { key: toolName, label: `${labels[toolName] ?? toolName} this session` };
}

function formatToolPreview(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'edit_file') {
    const path = typeof input.path === 'string' ? input.path : '?';
    const oldText = typeof input.old_text === 'string' ? input.old_text : '';
    const newText = typeof input.new_text === 'string' ? input.new_text : '';
    return `${path}\n` + renderUnifiedDiff(oldText, newText);
  }
  if (toolName === 'write_file') {
    const path = typeof input.path === 'string' ? input.path : '?';
    const mode = typeof input.mode === 'string' ? input.mode : 'create_only';
    const content = typeof input.content === 'string' ? input.content : '';
    const preview = content.split('\n').slice(0, 10).join('\n');
    return `${path} (${mode}, ${content.length} bytes)\n${preview}${content.split('\n').length > 10 ? '\n…' : ''}`;
  }
  if (toolName === 'run_shell') {
    const cmd = typeof input.command === 'string' ? input.command : '?';
    return `$ ${cmd}`;
  }
  if (toolName === 'delete_path') {
    const list = Array.isArray(input.paths) ? input.paths : input.path ? [input.path] : [];
    return `delete (to trash): ${list.join(', ')}`;
  }
  return JSON.stringify(input, null, 2);
}

const MASKED_MARKER = '[old tool output cleared to save context — re-run the tool if needed]';
// Don't bother masking tiny results — no meaningful savings, real info loss.
const MASK_MIN_CHARS = 500;
// Skip the whole pass if it would reclaim less than this — every mask event
// mutates history and busts the provider prompt cache, so it has to earn it.
const MASK_MIN_TOTAL_SAVINGS = 2_000;

// Observation masking — clear the content of tool_result blocks in messages
// OLDER than the `keepPairs`-th most recent user turn. Idempotent (already-
// masked and short results are skipped); leaves text/tool_use/thinking/image
// blocks untouched. Returns how many blocks were masked (0 = nothing mutated).
export function maskOldToolResults(conversation: Message[], keepPairs = 2): number {
  const cut = findCompactionCut(conversation, keepPairs);
  if (cut <= 0) return 0;

  const candidates: Array<Extract<ContentBlock, { type: 'tool_result' }>> = [];
  let savings = 0;
  for (let i = 0; i < cut; i++) {
    const m = conversation[i]!;
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      if (b.content.length <= MASK_MIN_CHARS || b.content === MASKED_MARKER) continue;
      candidates.push(b);
      savings += b.content.length - MASKED_MARKER.length;
    }
  }
  if (savings < MASK_MIN_TOTAL_SAVINGS) return 0;
  for (const b of candidates) b.content = MASKED_MARKER;
  return candidates.length;
}

// The index before which messages should be summarized during compaction:
// everything before the `keepPairs`-th most recent real user turn (a
// string-content user message). Returns 0 when there is nothing to compact.
export function findCompactionCut(conversation: Message[], keepPairs: number): number {
  let userSeen = 0;
  for (let i = conversation.length - 1; i >= 0; i--) {
    const m = conversation[i]!;
    if (m.role === 'user' && typeof m.content === 'string') {
      userSeen += 1;
      if (userSeen === keepPairs) return i;
    }
  }
  return 0;
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function renderForSummary(m: Message): string {
  if (typeof m.content === 'string') return `${m.role}: ${m.content}`;
  const parts: string[] = [];
  for (const b of m.content) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'tool_use') parts.push(`[tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 200)}]`);
    else if (b.type === 'tool_result') parts.push(`[tool_result ${b.content.slice(0, 200)}]`);
  }
  return `${m.role}: ${parts.join(' ')}`;
}

function detectLoop(window: string[], threshold: number): string | null {
  const counts = new Map<string, number>();
  for (const s of window) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const [sig, n] of counts.entries()) {
    if (n >= threshold) {
      const colon = sig.indexOf(':');
      return colon >= 0 ? sig.slice(0, colon) : sig;
    }
  }
  return null;
}

// AbortError detection across runtimes: undici throws a DOMException named
// "AbortError"; some environments surface "This operation was aborted".
function isAbortError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const name = (e as { name?: unknown }).name;
  if (name === 'AbortError') return true;
  const msg = (e as { message?: unknown }).message;
  return typeof msg === 'string' && /\baborted\b/i.test(msg);
}

// First words that make a shell segment read-only. Anything not on this list
// (or any output redirect) is treated as potentially file-mutating so the
// verify loop fires. Deliberately conservative — an unnecessary verify run
// is cheap; a missed mutation escapes the safety net.
const READONLY_SHELL_HEADS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'more', 'less', 'pwd', 'cd',
  'echo', 'printf', 'which', 'where', 'whoami', 'hostname', 'date', 'env',
  'printenv', 'grep', 'rg', 'findstr', 'find', 'fd', 'wc', 'uniq', 'du',
  'df', 'ps', 'tree', 'file', 'stat', 'diff',
]);
const READONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'blame', 'remote', 'describe',
  'rev-parse', 'ls-files', 'shortlog', 'reflog', 'grep',
]);

// True when every segment of the command (split on |, &&, ;) starts with a
// known read-only program and there is no output redirect anywhere.
export function isReadOnlyShellCommand(command: string): boolean {
  const cmd = command.trim();
  if (cmd.length === 0) return true;
  if (/>/.test(cmd)) return false; // any redirect can write a file
  for (const segment of cmd.split(/\|\||&&|;|\|/)) {
    const words = segment.trim().split(/\s+/);
    const head = (words[0] ?? '').toLowerCase();
    if (head === '') continue;
    if (head === 'git') {
      const sub = (words[1] ?? '').toLowerCase();
      if (!READONLY_GIT_SUBCOMMANDS.has(sub)) return false;
      continue;
    }
    if (!READONLY_SHELL_HEADS.has(head)) return false;
  }
  return true;
}

// Emit a `file_edit_proposed` semantic event for any file-mutating tool so the
// Automax host can surface "autocode wants to touch this file" without
// parsing tool_call args. No-op for tools that don't touch files.
function emitFileEditProposed(
  emitter: EventEmitter,
  name: string,
  input: Record<string, unknown>,
): void {
  const path = typeof input.path === 'string' ? input.path : undefined;
  const paths = Array.isArray(input.paths) ? (input.paths as unknown[]).filter((p): p is string => typeof p === 'string') : undefined;
  const summaryFor: Record<string, string> = {
    edit_file: 'edit',
    write_file: input.mode === 'overwrite' ? 'rewrite' : 'create',
    create_directory: 'mkdir',
    delete_path: 'delete',
  };
  const summary = summaryFor[name];
  if (!summary) return;
  const target = path ?? (paths && paths.length > 0 ? paths.join(', ') : undefined);
  if (!target) return;
  emitter.emit('file_edit_proposed', { path: target, summary });
}

// Collect the file paths affected by a successful file-mutating tool call —
// used to populate filesChanged in the turn's completed event.
function pathsTouched(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof input.path === 'string') out.push(input.path);
  if (Array.isArray(input.paths)) {
    for (const p of input.paths) if (typeof p === 'string') out.push(p);
  }
  return out;
}

function stableStringify(o: unknown): string {
  try {
    if (o === null || typeof o !== 'object') return JSON.stringify(o);
    const keys = Object.keys(o as Record<string, unknown>).sort();
    const norm: Record<string, unknown> = {};
    for (const k of keys) {
      const v = (o as Record<string, unknown>)[k];
      norm[k] = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v;
    }
    return JSON.stringify(norm);
  } catch {
    return String(o);
  }
}
