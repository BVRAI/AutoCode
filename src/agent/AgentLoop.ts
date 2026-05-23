import type { ConsoleRenderer } from '../repl/ConsoleRenderer.js';
import type { TranscriptStore, CumulativeUsage } from '../session/TranscriptStore.js';
import type { SessionContext, AgentMode } from '../session/SessionContext.js';
import type { CheckpointStore } from '../session/CheckpointStore.js';
import type { ToolExecutionContext } from '../tools/types.js';
import type { ContentBlock, ImageBlock, Message, StreamEvent } from '../llm/types.js';
import { LlmRouter, type ProviderName } from '../llm/Router.js';
import { ToolRegistry } from './ToolRegistry.js';
import { buildSystemPrompt } from './PromptBuilder.js';
import { currentTodos, markInProgressInterrupted } from '../tools/todoWrite.js';
import { renderUnifiedDiff } from '../util/diff.js';
import { estimateCost, formatUsd } from '../util/pricing.js';
import { shouldAutoCompact } from '../util/contextWindow.js';
import type { SubagentFactory } from '../tools/types.js';
import type { ApproveVerdict } from '../repl/Prompter.js';
import { resolveVerifyCommand, runVerification } from './Verify.js';
import type { EventEmitter } from '../repl/EventEmitter.js';

const MAX_ITERATIONS = 40;
const LOOP_DETECT_WINDOW = 10;
const LOOP_DETECT_THRESHOLD = 3;
const MAX_RETRIES_PER_TOOL = 3;
// How many times the harness will feed a verification failure back to the
// agent to fix before giving up (round 0 is the user's actual turn).
const MAX_VERIFY_ROUNDS = 2;

// Tools that change the project — gated according to the session mode.
const MUTATING_TOOLS = new Set(['edit_file', 'write_file', 'create_directory', 'delete_path', 'run_shell']);

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
  }
}

export interface AgentDeps {
  renderer: ConsoleRenderer;
  store: TranscriptStore;
  router: LlmRouter;
  registry: ToolRegistry;
  confirm: (prompt: string) => Promise<boolean>;
  // Approve / decline / revise an edit or command (default-mode gate).
  approve: (label: string) => Promise<ApproveVerdict>;
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
  // Machine-readable activity stream for the Automax V6 host. NullEventEmitter
  // when --automax is off; StdoutEventEmitter when it is on.
  emitter: EventEmitter;
}

export class AgentLoop {
  private cancelled = false;
  private readonly conversation: Message[] = [];
  private cumIn = 0;
  private cumOut = 0;
  private cumCacheRead = 0;
  private cumCacheWrite = 0;
  // Input-token count of the most recent LLM call ≈ current context size;
  // drives auto-compaction.
  private lastInputTokens = 0;

  constructor(private readonly deps: AgentDeps) {}

  cumulativeUsage(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
    return {
      inputTokens: this.cumIn,
      outputTokens: this.cumOut,
      cacheReadTokens: this.cumCacheRead,
      cacheWriteTokens: this.cumCacheWrite,
    };
  }

  cancel(): void {
    this.cancelled = true;
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
  ): Promise<{ before: number; after: number; summarized: boolean }> {
    const before = this.conversation.length;
    const cut = findCompactionCut(this.conversation, keepPairs);
    if (cut <= 0) return { before, after: before, summarized: false };

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
    return { before, after: this.conversation.length, summarized: summary !== null };
  }

  private async summarizeMessages(messages: Message[], ctx: SessionContext): Promise<string> {
    const transcript = messages.map(renderForSummary).join('\n\n');
    const resp = await this.deps.router.complete(ctx.model.provider as ProviderName, {
      model: ctx.model.model,
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

  async submit(input: string | ContentBlock[], ctx: SessionContext): Promise<void> {
    this.cancelled = false;
    this.deps.checkpoints?.beginTurn();
    const userText = typeof input === 'string' ? input : textOf(input);
    this.deps.store.appendTranscript({ role: 'user', text: userText });
    this.conversation.push({ role: 'user', content: input });

    const toolExecCtx: ToolExecutionContext = {
      session: ctx,
      confirm: this.deps.confirm,
      choose: this.deps.choose,
      checkpoint: this.deps.checkpoints,
      depth: 0,
      subagentFactory: this.deps.subagentFactory
        ? async (input) => {
            this.deps.renderer.spinner.start(`task: ${input.description}`);
            try {
              const result = await this.deps.subagentFactory!(input);
              // Fold subagent usage into parent cumulative counters.
              this.cumIn += result.usage.inputTokens;
              this.cumOut += result.usage.outputTokens;
              this.cumCacheRead += result.usage.cacheReadTokens ?? 0;
              this.cumCacheWrite += result.usage.cacheWriteTokens ?? 0;
              return result;
            } finally {
              this.deps.renderer.spinner.stop();
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
      let mutated = false;
      // Round 0 is the user's actual turn; rounds 1.. are verification-driven
      // fix attempts. After any round that changed files, the harness runs the
      // project's verification command and, on failure, feeds the output back.
      for (let round = 0; round <= MAX_VERIFY_ROUNDS; round++) {
        const r = await this.runIterations(ctx, toolExecCtx, userText, totals, filesChanged, turnState);
        mutated = mutated || r.mutated;
        if (this.cancelled || !mutated || ctx.mode === 'planning' || !this.deps.autoVerify) break;

        const cmd = resolveVerifyCommand(ctx.projectRoot, this.deps.verifyCommand);
        if (!cmd) break;

        this.deps.renderer.spinner.start(`verifying — $ ${cmd}`);
        const v = await runVerification(cmd, ctx.projectRoot, () => this.cancelled);
        this.deps.renderer.spinner.stop();
        if (this.cancelled) break;

        if (v.ok) {
          this.deps.renderer.status(`  ✓ verification passed ($ ${cmd})`);
          break;
        }
        if (round === MAX_VERIFY_ROUNDS) {
          this.deps.renderer.warn(
            `  ✗ verification still failing after ${MAX_VERIFY_ROUNDS} fix attempt(s) ($ ${cmd})`,
          );
          break;
        }
        this.deps.renderer.warn(`  ✗ verification failed ($ ${cmd}) — asking the agent to fix`);
        this.conversation.push({
          role: 'user',
          content:
            `The verification command \`${cmd}\` failed (exit ${v.code ?? '?'}) after your changes:\n\n` +
            '```\n' +
            v.output +
            '\n```\n\n' +
            'Fix the failures, then stop — verification re-runs automatically. If these ' +
            'failures are pre-existing and unrelated to your changes, do not try to fix ' +
            'them; say so briefly and stop.',
        });
      }
      if (this.cancelled) {
        this.deps.emitter.emit('failed', { error: 'cancelled by user' });
      } else {
        this.deps.emitter.emit('completed', {
          summary: turnState.lastAssistantText,
          filesChanged: [...filesChanged],
        });
      }
      this.emitStatusLine(totals.in, totals.out, totals.cacheRead, totals.cacheWrite, ctx);
    } catch (e) {
      this.deps.emitter.emit('failed', { error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      // Persist the conversation after every turn — natural end, iteration
      // cap, cancel, or exception — so the session is always resumable.
      this.persist();
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

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (this.cancelled) {
        this.deps.renderer.spinner.stop();
        this.deps.renderer.dim('(cancelled)');
        this.conversation.push({ role: 'user', content: '[user cancelled the task]' });
        // Mark any in-progress todo as 'interrupted' so the user can see at
        // a glance where we stopped.
        markInProgressInterrupted(ctx.sessionId);
        return { mutated };
      }
      // Auto-compact before the call if the live context is getting large.
      if (shouldAutoCompact(this.lastInputTokens, ctx.model.provider, ctx.model.model)) {
        this.deps.renderer.dim('  (auto-compacting — conversation context is getting large)');
        await this.compactConversation(ctx);
        this.lastInputTokens = 0;
      }
      this.deps.store.touch(userText.slice(0, 80));

      this.deps.renderer.spinner.start('thinking');
      let response: { content: ContentBlock[]; stopReason: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } } | null = null;
      let firstTextSeen = false;
      try {
        const stream = this.deps.router.completeStream(
          ctx.model.provider as ProviderName,
          {
            model: ctx.model.model,
            system: buildSystemPrompt(ctx),
            messages: this.conversation,
            tools: this.deps.registry.schemas(),
          },
        );
        for await (const evt of stream as AsyncIterable<StreamEvent>) {
          if (evt.type === 'text_delta') {
            // The reply is buffered (rendered as styled markdown at the end),
            // so the spinner keeps running while it arrives — no silent gap.
            if (!firstTextSeen) {
              this.deps.renderer.beginAssistantStream();
              firstTextSeen = true;
            }
            this.deps.renderer.streamChunk(evt.text);
          } else if (evt.type === 'tool_use_start') {
            this.deps.renderer.spinner.stop();
            if (firstTextSeen) {
              this.deps.renderer.endAssistantStream();
              firstTextSeen = false;
            }
            this.deps.renderer.spinner.start(evt.name);
          } else if (evt.type === 'message_stop') {
            response = evt.response;
          }
        }
      } finally {
        this.deps.renderer.spinner.stop();
        if (firstTextSeen) this.deps.renderer.endAssistantStream();
      }

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
      this.lastInputTokens = response.usage.inputTokens;

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
      for (const tu of toolUses) {
        if (tu.type !== 'tool_use') continue;
        const sig = `${tu.name}:${stableStringify(tu.input)}`;
        recentToolSigs.push(sig);
        if (recentToolSigs.length > LOOP_DETECT_WINDOW) recentToolSigs.shift();

        // Activity events for the Automax host. tool_call gives the
        // mechanical detail (name + args); file_edit_proposed is a semantic
        // shortcut so V6 can surface "autocode wants to edit X" without
        // parsing the tool args.
        this.deps.emitter.emit('tool_call', { name: tu.name, args: tu.input });
        emitFileEditProposed(this.deps.emitter, tu.name, tu.input);

        // Mode gate: planning blocks mutating tools; default asks first.
        const gate = gateFor(ctx.mode, tu.name);
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
          this.deps.renderer.dim(`  ✗ ${tu.name} blocked (planning mode)`);
          continue;
        }
        if (gate === 'approve') {
          const preview = formatToolPreview(tu.name, tu.input);
          this.deps.renderer.dim('  --- preview ---');
          this.deps.renderer.info(preview);
          this.deps.renderer.dim('  ---------------');
          const verdict = await this.deps.approve(`Run ${tu.name}?`);
          if (verdict.decision !== 'accept') {
            const content =
              verdict.decision === 'revise'
                ? `User declined this tool call and asks you to revise the approach: ${verdict.guidance || '(no guidance given)'}`
                : 'User declined this tool call. Adapt your plan.';
            toolResults.push({ type: 'tool_result', toolUseId: tu.id, content, isError: true });
            this.deps.renderer.dim(`  ✗ ${tu.name} ${verdict.decision}`);
            continue;
          }
        }

        this.deps.renderer.spinner.start(`${tu.name}`);
        const t0 = Date.now();
        // One step per tool execution — any snapshots the tool takes land
        // under one step number so step-level /undo rewinds exactly one
        // tool's worth of work.
        this.deps.checkpoints?.beginStep();
        const result = await this.deps.registry.execute(tu.name, tu.input, toolExecCtx);
        const dt = Date.now() - t0;
        this.deps.renderer.spinner.stop();

        if (result.isError) {
          consecutiveFailures.set(tu.name, (consecutiveFailures.get(tu.name) ?? 0) + 1);
        } else {
          consecutiveFailures.set(tu.name, 0);
          if (FILE_MUTATING_TOOLS.has(tu.name)) {
            mutated = true;
            for (const p of pathsTouched(tu.input)) filesChanged.add(p);
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

        toolResults.push({
          type: 'tool_result',
          toolUseId: tu.id,
          content: result.content,
          isError: result.isError,
        });
        // A tool may return an image (e.g. capture_screenshot) — collect it
        // so the agent can actually see it on the next turn.
        const img = (result.metadata as { image?: unknown } | undefined)?.image;
        if (img && typeof img === 'object' && (img as { type?: string }).type === 'image') {
          toolImages.push(img as ImageBlock);
        }
      }

      const loopOffender = detectLoop(recentToolSigs, LOOP_DETECT_THRESHOLD);
      if (loopOffender) {
        toolResults.push({
          type: 'tool_result',
          toolUseId: 'loop-detected',
          content:
            `You have called \`${loopOffender}\` with the same (or very similar) arguments ${LOOP_DETECT_THRESHOLD}+ times recently. ` +
            `Stop and reflect: the previous calls likely already gave you the information you need, or the approach is wrong. ` +
            `Summarize what you have learned and propose a different next step. Do not call this tool with these arguments again.`,
          isError: true,
        });
        recentToolSigs.length = 0;
      }

      for (const [tool, count] of consecutiveFailures.entries()) {
        if (count >= MAX_RETRIES_PER_TOOL) {
          toolResults.push({
            type: 'tool_result',
            toolUseId: 'retry-cap',
            content:
              `\`${tool}\` has failed ${count} times in a row. Stop retrying. Summarize what went wrong and ask the user for guidance, or try a fundamentally different approach.`,
            isError: true,
          });
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
    }

    this.deps.renderer.warn(`(stopped after ${MAX_ITERATIONS} iterations)`);
    this.deps.store.touch(null);
    return { mutated };
  }

  private emitStatusLine(
    inT: number,
    outT: number,
    cacheRead: number,
    cacheWrite: number,
    ctx: SessionContext,
  ): void {
    const cacheTotal = cacheRead + cacheWrite;
    const cachePct = inT > 0 ? Math.round((cacheRead / Math.max(1, inT)) * 100) : 0;
    const todos = currentTodos(ctx.sessionId);
    const done = todos.filter((t) => t.status === 'completed').length;
    const interrupted = todos.filter((t) => t.status === 'interrupted').length;
    const usage = { inputTokens: inT, outputTokens: outT, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
    const { cost } = estimateCost(usage, ctx.model.provider, ctx.model.model);
    const parts = [`in: ${inT}`, `out: ${outT}`];
    if (cacheTotal > 0) parts.push(`cache: ${cachePct}%`);
    if (todos.length > 0) parts.push(`${done}/${todos.length} todos`);
    if (interrupted > 0) parts.push(`${interrupted} interrupted`);
    if (cost > 0) parts.push(formatUsd(cost));
    this.deps.renderer.status(`  (${parts.join(' · ')})`);
  }
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
