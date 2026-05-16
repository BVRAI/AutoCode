import { createInterface } from 'node:readline';

import type { AgentHandler } from '../repl/TerminalMode.js';
import type { ConsoleRenderer } from '../repl/ConsoleRenderer.js';
import type { TranscriptStore } from '../session/TranscriptStore.js';
import type { SessionContext } from '../session/SessionContext.js';

import { AgentLoop } from './AgentLoop.js';
import { ToolRegistry } from './ToolRegistry.js';
import { LlmRouter } from '../llm/Router.js';

export class LiveAgent implements AgentHandler {
  private readonly loop: AgentLoop;

  constructor(
    private readonly renderer: ConsoleRenderer,
    store: TranscriptStore,
  ) {
    this.loop = new AgentLoop({
      renderer: this.renderer,
      store,
      router: new LlmRouter(),
      registry: new ToolRegistry(),
      confirm: (prompt) => askYesNo(prompt),
    });
  }

  async submit(text: string, ctx: SessionContext): Promise<void> {
    try {
      await this.loop.submit(text, ctx);
    } catch (e) {
      this.renderer.error(e instanceof Error ? e.message : String(e));
    }
  }

  stop(): void {
    this.loop.cancel();
  }
}

function askYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith('y'));
    });
  });
}
