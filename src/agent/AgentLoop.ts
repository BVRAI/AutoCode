import type { ConsoleRenderer } from '../repl/ConsoleRenderer.js';
import type { TranscriptStore, CumulativeUsage } from '../session/TranscriptStore.js';
import type { SessionContext, AgentMode } from '../session/SessionContext.js';
import type { ToolExecutionContext } from '../tools/types.js';
import type { ContentBlock, Message, StreamEvent } from '../llm/types.js';
import { LlmRouter, type ProviderName } from '../llm/Router.js';
import { ToolRegistry } from './ToolRegistry.js';
import { buildSystemPrompt } from './PromptBuilder.js';
import { currentTodos } from '../tools/todoWrite.js';
import { renderUnifiedDiff } from '../util/diff.js';
import { estimateCost, formatUsd } from '../util/pricing.js';
import { requestApproval } from '../repl/ApprovalPrompt.js';
import type { SubagentFactory } from '../tools/types.js';

const MAX_ITERATIONS = 32;
const LOOP_DETECT_WINDOW = 10;
const LOOP_DETECT_THRESHOLD = 3;
const MAX_RETRIES_PER_TOOL = 3;

// Tools that change the project — gated according to the session mode.
const MUTATING_TOOLS = new Set(['edit_file', 'write_file', 'create_directory', 'run_shell']);

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
  // Optional — when present, the `task` tool will use this to spawn
  // subagents. AgentLoop wraps it to also fold subagent usage into the
  // parent's cumulative counters and to display a spinner.
  subagentFactory?: SubagentFactory;
}

export class AgentLoop {
  private cancelled = false;
  private readonly conversation: Message[] = [];
  private cumIn = 0;
  private cumOut = 0;
  private cumCacheRead = 0;
  private cumCacheWrite = 0;

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

  // Cheap "compaction": keep the last N user/assistant pairs. LLM-driven
  // summarization is the v0.2 plan.
  compactConversation(keepPairs = 4): { before: number; after: number } {
    const before = this.conversation.length;
    // Find last keepPairs user messages, slice from there.
    let userSeen = 0;
    let cutIdx = 0;
    for (let i = this.conversation.length - 1; i >= 0; i--) {
      if (this.conversation[i]!.role === 'user') {
        userSeen += 1;
        if (userSeen === keepPairs) {
          cutIdx = i;
          break;
        }
      }
    }
    if (cutIdx > 0) this.conversation.splice(0, cutIdx);
    return { before, after: this.conversation.length };
  }

  async submit(userText: string, ctx: SessionContext): Promise<void> {
    this.cancelled = false;
    this.deps.store.appendTranscript({ role: 'user', text: userText });
    this.conversation.push({ role: 'user', content: userText });

    const toolExecCtx: ToolExecutionContext = {
      session: ctx,
      confirm: this.deps.confirm,
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

    const recentToolSigs: string[] = [];
    const consecutiveFailures = new Map<string, number>();

    let totalIn = 0;
    let totalOut = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;

    try {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (this.cancelled) {
        this.deps.renderer.spinner.stop();
        this.deps.renderer.dim('(cancelled)');
        this.conversation.push({ role: 'user', content: '[user cancelled the task]' });
        return;
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
            if (!firstTextSeen) {
              this.deps.renderer.spinner.stop();
              this.deps.renderer.beginAssistantStream();
              firstTextSeen = true;
            }
            this.deps.renderer.streamChunk(evt.text);
          } else if (evt.type === 'tool_use_start') {
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
        return;
      }

      totalIn += response.usage.inputTokens;
      totalOut += response.usage.outputTokens;
      totalCacheRead += response.usage.cacheReadTokens ?? 0;
      totalCacheWrite += response.usage.cacheWriteTokens ?? 0;
      this.cumIn += response.usage.inputTokens;
      this.cumOut += response.usage.outputTokens;
      this.cumCacheRead += response.usage.cacheReadTokens ?? 0;
      this.cumCacheWrite += response.usage.cacheWriteTokens ?? 0;

      this.conversation.push({ role: 'assistant', content: response.content });

      // Transcript log: capture the streamed text portions.
      for (const b of response.content) {
        if (b.type === 'text' && b.text.trim().length > 0) {
          this.deps.store.appendTranscript({ role: 'assistant', text: b.text });
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
          const ok = await requestApproval(`Run ${tu.name}?`, preview);
          if (!ok) {
            toolResults.push({
              type: 'tool_result',
              toolUseId: tu.id,
              content: 'User declined this tool call. Adapt your plan.',
              isError: true,
            });
            this.deps.renderer.dim(`  ✗ ${tu.name} declined`);
            continue;
          }
        }

        this.deps.renderer.spinner.start(`${tu.name}`);
        const t0 = Date.now();
        const result = await this.deps.registry.execute(tu.name, tu.input, toolExecCtx);
        const dt = Date.now() - t0;
        this.deps.renderer.spinner.stop();

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
    }

    this.deps.renderer.warn(`(stopped after ${MAX_ITERATIONS} iterations)`);
    this.emitStatusLine(totalIn, totalOut, totalCacheRead, totalCacheWrite, ctx);
    this.deps.store.touch(null);
    } finally {
      // Persist the conversation after every turn — natural end, iteration
      // cap, cancel, or exception — so the session is always resumable.
      this.persist();
    }
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
    const usage = { inputTokens: inT, outputTokens: outT, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
    const { cost } = estimateCost(usage, ctx.model.provider, ctx.model.model);
    const parts = [`in: ${inT}`, `out: ${outT}`];
    if (cacheTotal > 0) parts.push(`cache: ${cachePct}%`);
    if (todos.length > 0) parts.push(`${done}/${todos.length} todos`);
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
  return JSON.stringify(input, null, 2);
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
