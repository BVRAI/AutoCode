import type { SessionContext } from '../session/SessionContext.js';
import type { AgentHandler } from '../repl/TerminalMode.js';
import type { ConsoleRenderer } from '../repl/ConsoleRenderer.js';
import type { TranscriptStore } from '../session/TranscriptStore.js';

// Placeholder until the LLM router is wired (i.e., when no credentials are present).
export class StubAgent implements AgentHandler {
  constructor(
    private readonly renderer: ConsoleRenderer,
    private readonly store: TranscriptStore,
  ) {}

  async submit(text: string, _ctx: SessionContext): Promise<void> {
    this.store.appendTranscript({ role: 'user', text });
    this.renderer.dim(`(no LLM wired yet — would have sent: "${text}")`);
    this.store.appendTranscript({
      role: 'assistant',
      text: '[stub] LLM not yet wired',
    });
  }

  stop(): void {
    // no-op for stub
  }

  clearConversation(): number {
    return 0;
  }

  compactConversation(): { before: number; after: number } {
    return { before: 0, after: 0 };
  }

  cumulativeUsage(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }
}
