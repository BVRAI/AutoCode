import type { ContentBlock, Message } from '../llm/types.js';
import type { LlmRouter, ProviderName } from '../llm/Router.js';
import type { TranscriptStore } from '../session/TranscriptStore.js';
import type { SessionContext } from '../session/SessionContext.js';
import type { ToolExecutionContext, SubagentType } from '../tools/types.js';
import { ToolRegistry } from './ToolRegistry.js';
import { buildSubagentSystemPrompt } from './SubagentPromptBuilder.js';

const MAX_SUBAGENT_ITERATIONS = 16;
const LOOP_DETECT_WINDOW = 10;
const LOOP_DETECT_THRESHOLD = 3;

export interface SubagentRunInput {
  type: SubagentType;
  prompt: string;
  description: string;
  parent: SessionContext;
  parentDepth: number;
}

export interface SubagentRunResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  iterations: number;
  error?: string;
}

// Runs a sub-loop with a constrained tool registry. Non-streaming —
// subagent work is opaque to the user beyond a spinner label set by
// the caller. Tool calls are still logged to tool_log.jsonl for audit,
// tagged with the [subagent] prefix.
export class SubagentRunner {
  constructor(
    private readonly router: LlmRouter,
    private readonly store: TranscriptStore,
  ) {}

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const registry = ToolRegistry.forSubagent(input.type);
    const systemPrompt = buildSubagentSystemPrompt(input.type, input.parent);
    const messages: Message[] = [{ role: 'user', content: input.prompt }];

    const totalUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let lastText = '';
    const recentSigs: string[] = [];

    for (let iter = 0; iter < MAX_SUBAGENT_ITERATIONS; iter++) {
      const response = await this.router.complete(
        input.parent.model.provider as ProviderName,
        {
          model: input.parent.model.model,
          system: systemPrompt,
          messages,
          tools: registry.schemas(),
        },
      );

      totalUsage.inputTokens += response.usage.inputTokens;
      totalUsage.outputTokens += response.usage.outputTokens;
      totalUsage.cacheReadTokens += response.usage.cacheReadTokens ?? 0;
      totalUsage.cacheWriteTokens += response.usage.cacheWriteTokens ?? 0;

      messages.push({ role: 'assistant', content: response.content });

      const textBlocks = response.content.filter((b) => b.type === 'text');
      const turnText = textBlocks
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n')
        .trim();
      if (turnText.length > 0) lastText = turnText;

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0 || response.stopReason === 'end_turn') {
        return { text: lastText, usage: totalUsage, iterations: iter + 1 };
      }

      const results: ContentBlock[] = [];
      for (const tu of toolUses) {
        if (tu.type !== 'tool_use') continue;
        const sig = `${tu.name}:${stableStringify(tu.input)}`;
        recentSigs.push(sig);
        if (recentSigs.length > LOOP_DETECT_WINDOW) recentSigs.shift();

        const subCtx: ToolExecutionContext = {
          session: input.parent,
          depth: input.parentDepth + 1,
          // No subagentFactory passed in — defense-in-depth against recursion.
        };
        const t0 = Date.now();
        const result = await registry.execute(tu.name, tu.input, subCtx);
        const dt = Date.now() - t0;
        this.store.appendToolLog({
          tool: `[subagent:${input.type}] ${tu.name}`,
          arguments: tu.input,
          status: result.isError ? 'error' : 'success',
          durationMs: dt,
          summary: result.summary,
          error: result.isError ? result.content.slice(0, 500) : undefined,
        });
        results.push({
          type: 'tool_result',
          toolUseId: tu.id,
          content: result.content,
          isError: result.isError,
        });
      }

      // Loop detection — same pattern as parent.
      const loop = detectLoop(recentSigs, LOOP_DETECT_THRESHOLD);
      if (loop) {
        results.push({
          type: 'tool_result',
          toolUseId: 'loop-detected',
          content:
            `You called \`${loop}\` with the same arguments ${LOOP_DETECT_THRESHOLD}+ times recently. ` +
            `Stop calling tools and write your final answer with what you have.`,
          isError: true,
        });
        recentSigs.length = 0;
      }

      messages.push({ role: 'user', content: results });
    }

    return {
      text: lastText || '(subagent did not produce a final answer within iteration cap)',
      usage: totalUsage,
      iterations: MAX_SUBAGENT_ITERATIONS,
      error: 'iteration cap reached',
    };
  }
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
