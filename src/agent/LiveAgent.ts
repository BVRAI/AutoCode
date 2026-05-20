import { createInterface } from 'node:readline';

import type { AgentHandler } from '../repl/TerminalMode.js';
import type { ConsoleRenderer } from '../repl/ConsoleRenderer.js';
import type { TranscriptStore } from '../session/TranscriptStore.js';
import type { SessionContext } from '../session/SessionContext.js';
import type { CheckpointStore } from '../session/CheckpointStore.js';

import { AgentLoop } from './AgentLoop.js';
import { ToolRegistry } from './ToolRegistry.js';
import { LlmRouter } from '../llm/Router.js';
import { SubagentRunner } from './SubagentRunner.js';
import { McpClientManager } from '../mcp/McpClientManager.js';
import { McpTool } from '../mcp/McpTool.js';

export class LiveAgent implements AgentHandler {
  readonly loop: AgentLoop;
  readonly registry: ToolRegistry;
  readonly mcp: McpClientManager;

  private readonly checkpoints?: CheckpointStore;

  constructor(
    private readonly renderer: ConsoleRenderer,
    store: TranscriptStore,
    opts?: { headless?: boolean; checkpoints?: CheckpointStore },
  ) {
    const router = new LlmRouter();
    const runner = new SubagentRunner(router, store);
    this.registry = new ToolRegistry();
    this.mcp = new McpClientManager();
    this.checkpoints = opts?.checkpoints;
    // Headless runs have no interactive user — auto-decline confirm-gated
    // commands and plan-mode edits rather than blocking on stdin. Routine
    // allow-classified work (file/dir creation, edits) still runs freely.
    const confirm = opts?.headless ? async () => false : (prompt: string) => askYesNo(prompt);
    this.loop = new AgentLoop({
      renderer: this.renderer,
      store,
      router,
      registry: this.registry,
      confirm,
      subagentFactory: (input) => runner.run(input),
      checkpoints: this.checkpoints,
    });
  }

  // Connect to configured MCP servers and register their tools.
  async initializeMcp(mcpServers: Record<string, import('../auth/ConfigStore.js').McpServerConfig> | undefined): Promise<void> {
    if (!mcpServers || Object.keys(mcpServers).length === 0) return;
    await this.mcp.connectAll(mcpServers);
    for (const discovered of this.mcp.discoveredTools()) {
      this.registry.register(new McpTool(this.mcp, discovered));
    }
    const status = this.mcp.status();
    const connected = status.filter((s) => s.connected);
    const failed = status.filter((s) => !s.connected);
    if (connected.length > 0) {
      const tot = connected.reduce((n, s) => n + s.toolCount, 0);
      this.renderer.dim(`mcp: ${connected.length} server${connected.length === 1 ? '' : 's'} connected (${tot} tools)`);
    }
    for (const f of failed) {
      this.renderer.warn(`mcp: ${f.name} failed — ${f.error}`);
    }
  }

  async shutdown(): Promise<void> {
    await this.mcp.closeAll();
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

  clearConversation(): number {
    return this.loop.clearConversation();
  }

  loadState(state: Parameters<AgentLoop['loadState']>[0]): void {
    this.loop.loadState(state);
  }

  compactConversation(ctx: SessionContext): ReturnType<AgentLoop['compactConversation']> {
    return this.loop.compactConversation(ctx);
  }

  cumulativeUsage(): ReturnType<AgentLoop['cumulativeUsage']> {
    return this.loop.cumulativeUsage();
  }

  mcpStatus(): ReturnType<McpClientManager['status']> {
    return this.mcp.status();
  }

  mcpTools(): string[] {
    return this.mcp.discoveredTools().map((d) => `mcp__${d.serverName}__${d.toolName}`);
  }

  undo(): { turn: number; restored: number } | null {
    return this.checkpoints?.undoLastTurn() ?? null;
  }

  trashList(): ReturnType<CheckpointStore['listTrash']> {
    return this.checkpoints?.listTrash() ?? [];
  }

  restore(id: string): ReturnType<CheckpointStore['restoreFromTrash']> {
    return this.checkpoints?.restoreFromTrash(id) ?? null;
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
