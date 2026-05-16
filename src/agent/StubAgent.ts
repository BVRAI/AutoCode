import type { SessionContext } from '../session/SessionContext.js';
import type { AgentHandler } from '../repl/TerminalMode.js';
import type { ConsoleRenderer } from '../repl/ConsoleRenderer.js';

/**
 * Placeholder agent used until Phase 5 wires up the LLM router.
 * Echoes the prompt back so we can dogfood the REPL surface.
 */
export class StubAgent implements AgentHandler {
  constructor(private readonly renderer: ConsoleRenderer) {}

  async submit(text: string, _ctx: SessionContext): Promise<void> {
    this.renderer.dim(`(no LLM wired yet — would have sent: "${text}")`);
  }

  stop(): void {
    // no-op for stub
  }
}
