import type { ConsoleRenderer } from '../repl/ConsoleRenderer.js';
import type { TranscriptStore } from '../session/TranscriptStore.js';
import type { SessionContext } from '../session/SessionContext.js';
import type { ToolExecutionContext } from '../tools/types.js';
import type { ContentBlock, Message } from '../llm/types.js';
import { LlmRouter, type ProviderName } from '../llm/Router.js';
import { ToolRegistry } from './ToolRegistry.js';
import { buildSystemPrompt } from './PromptBuilder.js';

const MAX_ITERATIONS = 32;
const LOOP_DETECT_WINDOW = 3;

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
    const recentToolCalls: string[] = [];

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (this.cancelled) {
        this.deps.renderer.dim('(cancelled)');
        this.conversation.push({
          role: 'user',
          content: '[user cancelled the task]',
        });
        return;
      }
      this.deps.store.touch(userText.slice(0, 80));

      const response = await this.deps.router.complete(
        ctx.model.provider as ProviderName,
        {
          model: ctx.model.model,
          system: buildSystemPrompt(ctx),
          messages: this.conversation,
          tools: this.deps.registry.schemas(),
        },
      );

      this.conversation.push({ role: 'assistant', content: response.content });

      const textParts = response.content.filter((b) => b.type === 'text');
      for (const t of textParts) {
        if (t.type === 'text' && t.text.trim().length > 0) {
          this.deps.renderer.info(t.text);
          this.deps.store.appendTranscript({ role: 'assistant', text: t.text });
        }
      }

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0 || response.stopReason === 'end_turn') {
        this.deps.store.touch(null);
        return;
      }

      const toolResults: ContentBlock[] = [];
      for (const tu of toolUses) {
        if (tu.type !== 'tool_use') continue;
        const sig = `${tu.name}:${stableStringify(tu.input)}`;
        recentToolCalls.push(sig);
        if (recentToolCalls.length > LOOP_DETECT_WINDOW) recentToolCalls.shift();

        this.deps.renderer.dim(`→ ${tu.name} ${truncate(JSON.stringify(tu.input), 200)}`);
        const t0 = Date.now();
        const result = await this.deps.registry.execute(tu.name, tu.input, toolExecCtx);
        const dt = Date.now() - t0;
        this.deps.store.appendToolLog({
          tool: tu.name,
          arguments: tu.input,
          status: result.isError ? 'error' : 'success',
          durationMs: dt,
          summary: result.summary,
          error: result.isError ? result.content.slice(0, 500) : undefined,
        });
        this.deps.renderer.dim(`  ${result.summary}`);

        toolResults.push({
          type: 'tool_result',
          toolUseId: tu.id,
          content: result.content,
          isError: result.isError,
        });
      }

      if (
        recentToolCalls.length === LOOP_DETECT_WINDOW &&
        recentToolCalls.every((s) => s === recentToolCalls[0])
      ) {
        toolResults.push({
          type: 'tool_result',
          toolUseId: 'loop-detected',
          content:
            'You have called the same tool with the same arguments 3 times. Stop and reflect: ' +
            'either the previous calls already gave you the information you need, or the approach is wrong. ' +
            'Summarize what you have learned so far and propose a different next step.',
          isError: true,
        });
      }

      this.conversation.push({ role: 'user', content: toolResults });
    }

    this.deps.renderer.warn(`(stopped after ${MAX_ITERATIONS} iterations)`);
    this.deps.store.touch(null);
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function stableStringify(o: unknown): string {
  try {
    return JSON.stringify(o, Object.keys((o as Record<string, unknown>) ?? {}).sort());
  } catch {
    return String(o);
  }
}
