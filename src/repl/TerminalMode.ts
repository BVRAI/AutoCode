import { createInterface, Interface } from 'node:readline';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';

import type { SessionContext } from '../session/SessionContext.js';
import type { CumulativeUsage } from '../session/TranscriptStore.js';
import type { Message } from '../llm/types.js';
import { ConsoleRenderer } from './ConsoleRenderer.js';
import { parse, type ParsedInput } from './CommandParser.js';
import { runInit } from './InitCommand.js';
import { runAuth } from './AuthCommand.js';
import { estimateCost, formatUsd } from '../util/pricing.js';

export interface AgentHandler {
  submit(text: string, ctx: SessionContext): Promise<void>;
  stop(): void;
  clearConversation(): number;
  compactConversation(): { before: number; after: number };
  cumulativeUsage(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  loadState?(state: { messages: Message[]; usage: CumulativeUsage }): void;
  mcpStatus?(): Array<{ name: string; connected: boolean; toolCount: number; error?: string }>;
  mcpTools?(): string[];
}

export class TerminalMode {
  private readonly rl: Interface;
  private exiting = false;

  constructor(
    private readonly ctx: SessionContext,
    private readonly renderer: ConsoleRenderer,
    private readonly agent: AgentHandler,
  ) {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      prompt: this.renderer.prompt(),
    });
  }

  async run(): Promise<number> {
    this.renderer.printHeader(this.ctx);
    this.rl.prompt();

    return new Promise<number>((resolveExit) => {
      this.rl.on('line', (line) => {
        const parsed = parse(line);
        void this.dispatch(parsed).finally(() => {
          if (!this.exiting) this.rl.prompt();
        });
      });

      this.rl.on('close', () => {
        if (!this.exiting) {
          process.stdout.write('\n');
        }
        resolveExit(0);
      });

      process.on('SIGINT', () => {
        this.agent.stop();
        this.renderer.dim('(stopped — press /exit to quit)');
        this.rl.prompt();
      });
    });
  }

  private async dispatch(parsed: ParsedInput): Promise<void> {
    switch (parsed.kind) {
      case 'empty':
        return;
      case 'agent':
        await this.agent.submit(parsed.text, this.ctx);
        return;
      case 'local':
        return this.handleLocal(parsed.name, parsed.args);
    }
  }

  private async handleLocal(
    name:
      | 'help'
      | 'status'
      | 'cwd'
      | 'model'
      | 'stop'
      | 'exit'
      | 'init'
      | 'clear'
      | 'compact'
      | 'cost'
      | 'diff'
      | 'auth'
      | 'plan'
      | 'mcp',
    args: string[],
  ): Promise<void> {
    switch (name) {
      case 'help':
        this.printHelp();
        return;
      case 'status':
        this.printStatus();
        return;
      case 'cwd':
        this.handleCwd(args);
        return;
      case 'model':
        this.handleModel(args);
        return;
      case 'stop':
        this.agent.stop();
        this.renderer.dim('(stop requested)');
        return;
      case 'exit':
        this.exiting = true;
        this.rl.close();
        return;
      case 'init':
        await runInit(this.ctx.projectRoot, this.renderer);
        return;
      case 'clear':
        this.handleClear();
        return;
      case 'compact':
        this.handleCompact();
        return;
      case 'cost':
        this.handleCost();
        return;
      case 'diff':
        this.handleDiff();
        return;
      case 'auth':
        await runAuth(this.renderer);
        return;
      case 'plan':
        this.handlePlan(args);
        return;
      case 'mcp':
        this.handleMcp();
        return;
    }
  }

  private handleMcp(): void {
    const status = this.agent.mcpStatus?.() ?? [];
    if (status.length === 0) {
      this.renderer.dim('(no MCP servers configured — add mcpServers to ~/.autocode/config.json)');
      return;
    }
    for (const s of status) {
      const tag = s.connected ? `${s.toolCount} tools` : `failed: ${s.error}`;
      this.renderer.info(`${s.connected ? '✓' : '✗'} ${s.name} — ${tag}`);
    }
    const tools = this.agent.mcpTools?.() ?? [];
    if (tools.length > 0) {
      this.renderer.dim(`  tools: ${tools.join(', ')}`);
    }
  }

  private printHelp(): void {
    const lines = [
      '/help                          Show this message',
      '/status                        Show session info',
      '/cwd                           Show project root',
      '/cwd <path>                    Change project root',
      '/model                         Show current model',
      '/model <provider> <name>       Switch provider/model',
      '/init                          Scaffold an AUTOCODE.md for this project',
      '/clear                         Reset conversation history',
      '/compact                       Truncate conversation to last 4 turns',
      '/cost                          Show session cost estimate',
      '/diff                          Show uncommitted git changes',
      '/auth                          Configure an API key',
      '/plan [on|off]                 Toggle approval-before-edit mode',
      '/mcp                           List configured MCP servers and their tools',
      '/stop                          Cancel current task',
      '/exit                          Close autocode',
    ];
    for (const l of lines) this.renderer.info(l);
  }

  private printStatus(): void {
    this.renderer.info(`session: ${this.ctx.sessionId}`);
    this.renderer.info(`project: ${this.ctx.projectRoot}`);
    this.renderer.info(`model:   ${this.ctx.model.provider} / ${this.ctx.model.model}`);
    this.renderer.info(`plan:    ${this.ctx.planMode ? 'on (approval required)' : 'off (auto)'}`);
    this.renderer.info(`started: ${this.ctx.startedAt}`);
  }

  private handleCwd(args: string[]): void {
    if (args.length === 0) {
      this.renderer.info(this.ctx.projectRoot);
      return;
    }
    const target = resolve(args.join(' '));
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      this.renderer.error(`not a directory: ${target}`);
      return;
    }
    this.ctx.projectRoot = target;
    this.renderer.info(`project root → ${target}`);
  }

  private handleModel(args: string[]): void {
    if (args.length === 0) {
      this.renderer.info(`${this.ctx.model.provider} / ${this.ctx.model.model}`);
      return;
    }
    if (args.length < 2) {
      this.renderer.error('usage: /model <provider> <model>');
      return;
    }
    this.ctx.model = { provider: args[0]!, model: args.slice(1).join(' ') };
    this.renderer.info(`model → ${this.ctx.model.provider} / ${this.ctx.model.model}`);
  }

  private handleClear(): void {
    const n = this.agent.clearConversation();
    this.renderer.dim(`(cleared ${n} message${n === 1 ? '' : 's'} from conversation history)`);
  }

  private handleCompact(): void {
    const { before, after } = this.agent.compactConversation();
    if (before === after) {
      this.renderer.dim('(nothing to compact)');
    } else {
      this.renderer.dim(`(compacted ${before} → ${after} messages)`);
    }
  }

  private handleCost(): void {
    const u = this.agent.cumulativeUsage();
    const { cost, rate } = estimateCost(u, this.ctx.model.provider, this.ctx.model.model);
    if (!rate) {
      this.renderer.info(
        `No pricing data for ${this.ctx.model.provider}/${this.ctx.model.model}. ` +
          `Tokens this session: in ${u.inputTokens}, out ${u.outputTokens}.`,
      );
      return;
    }
    this.renderer.info(
      `Session estimate: ${formatUsd(cost)} (${this.ctx.model.provider} ${this.ctx.model.model})`,
    );
    this.renderer.dim(
      `  in: ${u.inputTokens} @ $${rate.inputPerM}/M · out: ${u.outputTokens} @ $${rate.outputPerM}/M` +
        (u.cacheReadTokens > 0 ? ` · cache_read: ${u.cacheReadTokens}` : ''),
    );
  }

  private handleDiff(): void {
    try {
      const out = execSync('git -c color.ui=always diff', {
        cwd: this.ctx.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
      if (out.trim().length === 0) {
        this.renderer.dim('(no uncommitted changes)');
      } else {
        process.stdout.write(out);
        if (!out.endsWith('\n')) process.stdout.write('\n');
      }
    } catch (e) {
      this.renderer.error(`git diff failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private handlePlan(args: string[]): void {
    if (args.length === 0) {
      this.renderer.info(`plan mode: ${this.ctx.planMode ? 'ON (approval required)' : 'OFF (auto)'}`);
      return;
    }
    const arg = args[0]!.toLowerCase();
    if (arg === 'on' || arg === 'true' || arg === '1') {
      this.ctx.planMode = true;
      this.renderer.info('plan mode: ON — file edits and shell commands require approval');
    } else if (arg === 'off' || arg === 'false' || arg === '0') {
      this.ctx.planMode = false;
      this.renderer.info('plan mode: OFF — auto-approve');
    } else {
      this.renderer.error(`usage: /plan [on|off]`);
    }
  }
}
