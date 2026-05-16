import type { SessionContext } from '../session/SessionContext.js';
import type { AgentHandler } from '../repl/TerminalMode.js';
import type { ConsoleRenderer } from '../repl/ConsoleRenderer.js';
import type { TranscriptStore } from '../session/TranscriptStore.js';

// Placeholder until Phase 5 wires the LLM router.
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
}
