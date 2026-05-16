import { createInterface, Interface } from 'node:readline';
import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';

import type { SessionContext } from '../session/SessionContext.js';
import { ConsoleRenderer } from './ConsoleRenderer.js';
import { parse, type ParsedInput } from './CommandParser.js';

export interface AgentHandler {
  submit(text: string, ctx: SessionContext): Promise<void>;
  stop(): void;
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
    name: 'help' | 'status' | 'cwd' | 'model' | 'stop' | 'exit',
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
      '/stop                          Cancel current task',
      '/exit                          Close autocode',
    ];
    for (const l of lines) this.renderer.info(l);
  }

  private printStatus(): void {
    this.renderer.info(`session: ${this.ctx.sessionId}`);
    this.renderer.info(`project: ${this.ctx.projectRoot}`);
    this.renderer.info(`model:   ${this.ctx.model.provider} / ${this.ctx.model.model}`);
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
}
