import { createInterface, emitKeypressEvents, Interface } from 'node:readline';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';

import { nextMode, type SessionContext, type AgentMode } from '../session/SessionContext.js';
import type { CumulativeUsage } from '../session/TranscriptStore.js';
import type { TrashItem } from '../session/CheckpointStore.js';
import type { Message, ContentBlock } from '../llm/types.js';
import { buildAgentInput } from '../util/imageInput.js';
import { ConsoleRenderer } from './ConsoleRenderer.js';
import { parse, type ParsedInput } from './CommandParser.js';
import { runInit } from './InitCommand.js';
import { runAuth } from './AuthCommand.js';
import { estimateCost, formatUsd } from '../util/pricing.js';

export interface AgentHandler {
  submit(input: string | ContentBlock[], ctx: SessionContext): Promise<void>;
  stop(): void;
  clearConversation(): number;
  compactConversation(ctx: SessionContext): Promise<{ before: number; after: number; summarized: boolean }>;
  cumulativeUsage(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  loadState?(state: { messages: Message[]; usage: CumulativeUsage }): void;
  undo?(): { turn: number; restored: number } | null;
  trashList?(): TrashItem[];
  restore?(id: string): TrashItem | null;
  mcpStatus?(): Array<{ name: string; connected: boolean; toolCount: number; error?: string }>;
  mcpTools?(): string[];
}

export class TerminalMode {
  private readonly rl: Interface;
  private exiting = false;
  private busy = false;

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
    // Shift+Tab cycles the workflow mode. readline (terminal:true) already
    // puts stdin in raw mode; a sibling keypress listener is safe.
    emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', (_str, key) => {
      if (key && key.name === 'tab' && key.shift) this.cycleMode();
    });
  }

  // Print the upper rule, then the readline prompt row.
  private showPrompt(): void {
    process.stdout.write(this.renderer.hr() + '\n');
    this.rl.prompt();
  }

  // Shift+Tab handler: advance the mode and give immediate feedback.
  private cycleMode(): void {
    this.ctx.mode = nextMode(this.ctx.mode);
    if (this.busy) {
      // Mid-turn: just note it; the new mode applies to the next tool call.
      this.renderer.dim(`  ▸ mode → ${this.ctx.mode}`);
      return;
    }
    // At the prompt: clear the input row, toast the change, re-prompt with
    // the in-progress text preserved (readline may insert a stray tab).
    const pending = this.rl.line.replace(/\t/g, '');
    process.stdout.write('\r\x1b[2K');
    this.renderer.dim(`  ▸ mode → ${this.ctx.mode}`);
    this.rl.prompt();
    if (pending) this.rl.write(pending);
  }

  async run(): Promise<number> {
    this.renderer.printHeader(this.ctx);
    this.showPrompt();

    return new Promise<number>((resolveExit) => {
      this.rl.on('line', (line) => {
        const parsed = parse(line);
        if (parsed.kind === 'empty') {
          this.showPrompt();
          return;
        }
        this.renderer.promptFooter(this.ctx.mode);
        this.busy = true;
        void this.dispatch(parsed).finally(() => {
          this.busy = false;
          if (!this.exiting) this.showPrompt();
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
        this.showPrompt();
      });
    });
  }

  private async dispatch(parsed: ParsedInput): Promise<void> {
    switch (parsed.kind) {
      case 'empty':
        return;
      case 'agent': {
        const { input, missing } = buildAgentInput(parsed.text, this.ctx.projectRoot);
        for (const ref of missing) this.renderer.warn(`(could not read image: ${ref})`);
        await this.agent.submit(input, this.ctx);
        return;
      }
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
      | 'mode'
      | 'undo'
      | 'trash'
      | 'restore'
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
        return this.handleCompact();
      case 'cost':
        this.handleCost();
        return;
      case 'diff':
        this.handleDiff();
        return;
      case 'auth':
        await runAuth(this.renderer);
        return;
      case 'mode':
        this.handleMode(args);
        return;
      case 'undo':
        this.handleUndo();
        return;
      case 'trash':
        this.handleTrash();
        return;
      case 'restore':
        this.handleRestore(args);
        return;
      case 'mcp':
        this.handleMcp();
        return;
    }
  }

  private handleUndo(): void {
    const r = this.agent.undo?.();
    if (!r || r.restored === 0) {
      this.renderer.dim('(nothing to undo)');
      return;
    }
    this.renderer.info(`undid turn ${r.turn} — restored ${r.restored} file${r.restored === 1 ? '' : 's'}`);
  }

  private handleTrash(): void {
    const items = this.agent.trashList?.() ?? [];
    if (items.length === 0) {
      this.renderer.dim('(trash is empty)');
      return;
    }
    for (const it of items.slice(0, 20)) {
      this.renderer.info(`${it.id}  ${it.deletedAt.slice(0, 19)}  ${it.kind}  ${it.originalPath}`);
    }
    this.renderer.dim('restore with /restore <id>');
  }

  private handleRestore(args: string[]): void {
    const id = args[0];
    if (!id) {
      this.renderer.error('usage: /restore <id>  (run /trash to see ids)');
      return;
    }
    const r = this.agent.restore?.(id);
    if (!r) {
      this.renderer.error(`no trash item with id ${id}`);
      return;
    }
    this.renderer.info(`restored ${r.originalPath}`);
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
      '/mode [planning|default|autocode]  Show or set the workflow mode (or shift+tab)',
      '/undo                          Revert the file changes from the last turn',
      '/trash                         List recently deleted files (recoverable)',
      '/restore <id>                  Restore a deleted file from the trash',
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
    this.renderer.info(`mode:    ${this.ctx.mode}`);
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

  private async handleCompact(): Promise<void> {
    const { before, after, summarized } = await this.agent.compactConversation(this.ctx);
    if (before === after) {
      this.renderer.dim('(nothing to compact)');
    } else {
      this.renderer.dim(
        `(compacted ${before} → ${after} messages${summarized ? ', summarized' : ', truncated'})`,
      );
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

  private handleMode(args: string[]): void {
    if (args.length === 0) {
      this.renderer.info(`mode: ${this.ctx.mode} (cycle with shift+tab)`);
      return;
    }
    const arg = args[0]!.toLowerCase();
    if (arg === 'planning' || arg === 'default' || arg === 'autocode') {
      this.ctx.mode = arg as AgentMode;
      this.renderer.info(`mode → ${this.ctx.mode}`);
    } else {
      this.renderer.error('usage: /mode [planning|default|autocode]');
    }
  }
}
