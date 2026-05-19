import type { ConsoleRenderer } from '../repl/ConsoleRenderer.js';
import type { TranscriptStore } from '../session/TranscriptStore.js';
import type { SessionContext } from '../session/SessionContext.js';
import type { ToolExecutionContext } from '../tools/types.js';
import type { ContentBlock, Message } from '../llm/types.js';
import { LlmRouter, type ProviderName } from '../llm/Router.js';
import { ToolRegistry } from './ToolRegistry.js';
import { buildSystemPrompt } from './PromptBuilder.js';
import { currentTodos } from '../tools/todoWrite.js';

const MAX_ITERATIONS = 32;
const LOOP_DETECT_WINDOW = 10;
const LOOP_DETECT_THRESHOLD = 3; // Same (tool, args-hash) ≥ this many times in window → intervene.
const MAX_RETRIES_PER_TOOL = 3;  // Same tool failing repeatedly → intervene.

export interface AgentDeps {
  renderer: ConsoleRenderer;
  store: TranscriptStore;
  router: LlmRouter;
  registry: ToolRegistry;
  confirm: (prompt: string) => Promise<boolean>;
}

export class AgentLoop {
  private cancelled = false;
  private readonly conversation: Message[] = [];

  constructor(private readonly deps: AgentDeps) {}

  cancel(): void {
    this.cancelled = true;
  }

  async submit(userText: string, ctx: SessionContext): Promise<void> {
    this.cancelled = false;
    this.deps.store.appendTranscript({ role: 'user', text: userText });
    this.conversation.push({ role: 'user', content: userText });

    const toolExecCtx: ToolExecutionContext = {
      session: ctx,
      confirm: this.deps.confirm,
    };

    // Sliding-window loop detection — pattern from research:
    // OpenClaw uses a window of ~10 with normalized arg hashing and threshold 3.
    const recentToolSigs: string[] = [];
    // Per-tool consecutive-failure counter — separate from total iteration cap.
    const consecutiveFailures = new Map<string, number>();

    // Cumulative usage for the status line at end of turn.
    let totalIn = 0;
    let totalOut = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (this.cancelled) {
        this.deps.renderer.spinner.stop();
        this.deps.renderer.dim('(cancelled)');
        this.conversation.push({
          role: 'user',
          content: '[user cancelled the task]',
        });
        return;
      }
      this.deps.store.touch(userText.slice(0, 80));

      this.deps.renderer.spinner.start('thinking');
      let response;
      try {
        response = await this.deps.router.complete(
          ctx.model.provider as ProviderName,
          {
            model: ctx.model.model,
            system: buildSystemPrompt(ctx),
            messages: this.conversation,
            tools: this.deps.registry.schemas(),
          },
        );
      } finally {
        this.deps.renderer.spinner.stop();
      }

      totalIn += response.usage.inputTokens;
      totalOut += response.usage.outputTokens;
      totalCacheRead += response.usage.cacheReadTokens ?? 0;
      totalCacheWrite += response.usage.cacheWriteTokens ?? 0;

      this.conversation.push({ role: 'assistant', content: response.content });

      const textParts = response.content.filter((b) => b.type === 'text');
      for (const t of textParts) {
        if (t.type === 'text' && t.text.trim().length > 0) {
          this.deps.renderer.assistant(t.text);
          this.deps.store.appendTranscript({ role: 'assistant', text: t.text });
        }
      }

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0 || response.stopReason === 'end_turn') {
        this.emitStatusLine(totalIn, totalOut, totalCacheRead, totalCacheWrite, ctx);
        this.deps.store.touch(null);
        return;
      }

      const toolResults: ContentBlock[] = [];
      for (const tu of toolUses) {
        if (tu.type !== 'tool_use') continue;
        const sig = `${tu.name}:${stableStringify(tu.input)}`;
        recentToolSigs.push(sig);
        if (recentToolSigs.length > LOOP_DETECT_WINDOW) recentToolSigs.shift();

        this.deps.renderer.spinner.start(`${tu.name}`);
        const t0 = Date.now();
        const result = await this.deps.registry.execute(tu.name, tu.input, toolExecCtx);
        const dt = Date.now() - t0;
        this.deps.renderer.spinner.stop();

        // Track per-tool consecutive failures.
        if (result.isError) {
          consecutiveFailures.set(tu.name, (consecutiveFailures.get(tu.name) ?? 0) + 1);
        } else {
          consecutiveFailures.set(tu.name, 0);
        }

        this.deps.store.appendToolLog({
          tool: tu.name,
          arguments: tu.input,
          status: result.isError ? 'error' : 'success',
          durationMs: dt,
          summary: result.summary,
          error: result.isError ? result.content.slice(0, 500) : undefined,
        });
        this.deps.renderer.dim(`→ ${tu.name}  ${result.summary}  (${dt}ms)`);

        // Render diff if this was an edit/write tool that produced before/after.
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
      }

      // Loop detection — sliding window with arg-hash normalization (pattern
      // from OpenClaw): if any signature occurs ≥ threshold times in the
      // recent window, push a reflection message instead of letting the model
      // continue thrashing.
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

      // Per-tool retry cap — stop the agent if a single tool fails repeatedly.
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
    }

    this.deps.renderer.warn(`(stopped after ${MAX_ITERATIONS} iterations)`);
    this.emitStatusLine(totalIn, totalOut, totalCacheRead, totalCacheWrite, ctx);
    this.deps.store.touch(null);
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
    const parts = [`in: ${inT}`, `out: ${outT}`];
    if (cacheTotal > 0) parts.push(`cache: ${cachePct}%`);
    if (todos.length > 0) parts.push(`${done}/${todos.length} todos`);
    this.deps.renderer.status(`(${parts.join(' · ')})`);
  }
}

function detectLoop(window: string[], threshold: number): string | null {
  const counts = new Map<string, number>();
  for (const s of window) {
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  for (const [sig, n] of counts.entries()) {
    if (n >= threshold) {
      // Return just the tool name portion of the signature for the reflection message.
      const colon = sig.indexOf(':');
      return colon >= 0 ? sig.slice(0, colon) : sig;
    }
  }
  return null;
}

function stableStringify(o: unknown): string {
  try {
    if (o === null || typeof o !== 'object') return JSON.stringify(o);
    const keys = Object.keys(o as Record<string, unknown>).sort();
    const norm: Record<string, unknown> = {};
    for (const k of keys) {
      const v = (o as Record<string, unknown>)[k];
      // Normalize whitespace in string args so trivial reformatting doesn't escape loop detection.
      norm[k] = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v;
    }
    return JSON.stringify(norm);
  } catch {
    return String(o);
  }
}
