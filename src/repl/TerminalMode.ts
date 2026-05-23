import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import pc from 'picocolors';

import { nextMode, type SessionContext, type AgentMode } from '../session/SessionContext.js';
import type { CumulativeUsage } from '../session/TranscriptStore.js';
import type { TrashItem } from '../session/CheckpointStore.js';
import type { Message, ContentBlock } from '../llm/types.js';
import { buildAgentInput } from '../util/imageInput.js';
import { estimateCost, formatUsd } from '../util/pricing.js';
import { ConsoleRenderer } from './ConsoleRenderer.js';
import { parse, type ParsedInput } from './CommandParser.js';
import { runInit } from './InitCommand.js';
import { runAuth } from './AuthCommand.js';
import { Screen } from './Screen.js';
import { LineEditor } from './LineEditor.js';
import { BottomBar, renderBar, type BarState } from './BottomBar.js';
import { PrompterRef, TuiPrompter } from './Prompter.js';
import { BANNER_GALLERY, bannerBlock } from './Banner.js';
import { runUpdate } from '../update/UpdateChecker.js';
import { isBundled } from '../util/host.js';
import { type EventEmitter, NullEventEmitter } from './EventEmitter.js';

const MAX_QUEUE = 5;

export interface AgentHandler {
  submit(input: string | ContentBlock[], ctx: SessionContext): Promise<void>;
  stop(): void;
  clearConversation(): number;
  compactConversation(ctx: SessionContext): Promise<{ before: number; after: number; summarized: boolean }>;
  cumulativeUsage(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  loadState?(state: { messages: Message[]; usage: CumulativeUsage }): void;
  undo?(grain?: 'step' | 'turn'): { turn: number; restored: number; step?: number } | null;
  trashList?(): TrashItem[];
  restore?(id: string): TrashItem | null;
  mcpStatus?(): Array<{ name: string; connected: boolean; toolCount: number; error?: string }>;
  mcpTools?(): string[];
}

// The interactive REPL — a pinned bottom bar (input + status) with output
// scrolling above it via a terminal scroll region. Falls back to a plain
// line loop when stdout is not a TTY.
export class TerminalMode {
  private readonly screen = new Screen();
  private readonly editor: LineEditor;
  private bar: BottomBar | null = null;
  private exiting = false;
  private busy = false;
  private readonly queue: string[] = [];
  private resolveExit: ((code: number) => void) | null = null;
  // Launch-banner rotation — flashes a new random gallery banner every 2s
  // until the first prompt is submitted.
  private bannerTimer: ReturnType<typeof setInterval> | null = null;
  private lastBannerId = 1; // banner 1 is the static draw from printHeader
  // Debounce coalesces the burst of resize events a terminal fires while the
  // user is dragging the window into a single repaint at the end.
  private resizeDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctx: SessionContext,
    private readonly renderer: ConsoleRenderer,
    private readonly agent: AgentHandler,
    private readonly prompter: PrompterRef,
    private readonly emitter: EventEmitter = new NullEventEmitter(),
  ) {
    this.editor = new LineEditor({
      onChange: () => this.redrawBar(),
      onSubmit: (text) => this.handleSubmit(text),
      onInterrupt: () => this.handleInterrupt(),
      onCycleMode: () => this.handleCycle(),
    });
  }

  run(): Promise<number> {
    return this.screen.isTty ? this.runTui() : this.runPlain();
  }

  // ── TUI mode ──────────────────────────────────────────────────────────
  private runTui(): Promise<number> {
    this.screen.clear(); // anchor the header (and banner) at row 1
    this.renderer.printHeader(this.ctx);
    this.screen.enter(renderBar(this.barState()).footerHeight);
    // Park the output cursor at the bottom of the output region — output
    // accumulates there and scrolls up.
    this.screen.moveToOutputBottom();

    this.bar = new BottomBar(this.screen);
    this.screen.onResize = () => this.handleResize();
    this.prompter.use(new TuiPrompter(this.editor, this.renderer, this.screen, this.emitter));
    this.editor.start();
    this.redrawBar();
    this.startBannerRotation();

    return new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  // ── Launch-banner rotation ────────────────────────────────────────────
  // The banner sits at fixed rows 1–6 (drawn by printHeader before the
  // scroll region was installed). Until the first prompt, swap in a random
  // gallery banner every 2s. Skipped on short terminals where the header
  // may already have scrolled off.
  private startBannerRotation(): void {
    if (this.screen.outputRows < 14) return;
    this.bannerTimer = setInterval(() => this.rotateBanner(), 2000);
  }

  private stopBannerRotation(): void {
    if (this.bannerTimer) {
      clearInterval(this.bannerTimer);
      this.bannerTimer = null;
    }
  }

  // ── Resize handling ───────────────────────────────────────────────────
  // Terminal resize fires many events while the window is being dragged;
  // debounce so we repaint once at the end. Two paths: idle → full repaint
  // (header + scroll region + footer all re-rendered cleanly under the new
  // geometry, on-screen visible area wiped — terminal scrollback preserved);
  // busy mid-turn → just realign the footer (don't trash live output).
  private handleResize(): void {
    if (this.resizeDebounce) clearTimeout(this.resizeDebounce);
    this.resizeDebounce = setTimeout(() => {
      this.resizeDebounce = null;
      this.performResize();
    }, 150);
  }

  private performResize(): void {
    if (!this.bar || this.exiting) return;
    if (this.busy) {
      this.redrawBar();
      return;
    }
    const wasRotating = this.bannerTimer !== null;
    this.stopBannerRotation();
    this.screen.clearVisible();
    this.renderer.printHeader(this.ctx);
    this.screen.enter(renderBar(this.barState()).footerHeight);
    this.screen.moveToOutputBottom();
    this.redrawBar();
    if (wasRotating) this.startBannerRotation();
  }

  private rotateBanner(): void {
    if (!this.bar) return;
    let pick = BANNER_GALLERY[Math.floor(Math.random() * BANNER_GALLERY.length)]!;
    while (pick.id === this.lastBannerId && BANNER_GALLERY.length > 1) {
      pick = BANNER_GALLERY[Math.floor(Math.random() * BANNER_GALLERY.length)]!;
    }
    this.lastBannerId = pick.id;
    this.screen.hideCursor();
    const block = bannerBlock(pick);
    for (let i = 0; i < block.length; i++) {
      this.screen.write(`\x1b[${i + 1};1H\x1b[2K` + block[i]!);
    }
    this.redrawBar(); // re-places the input cursor and shows it
  }

  private barState(): BarState {
    const u = this.agent.cumulativeUsage();
    const { cost } = estimateCost(u, this.ctx.model.provider, this.ctx.model.model);
    return {
      input: this.editor.text,
      cursor: this.editor.cursorIndex,
      columns: this.screen.columns,
      mode: this.ctx.mode,
      usage: {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        costText: cost > 0 ? formatUsd(cost) : '',
      },
      queued: this.queue.length,
      busy: this.busy,
      choice: this.editor.choiceState ?? undefined,
    };
  }

  private redrawBar(): void {
    if (!this.bar) return;
    // Hide the cursor across the multi-row redraw so it does not flicker.
    this.screen.hideCursor();
    if (this.busy && !this.editor.answering && !this.editor.choosing) {
      // Mid-turn keystroke — keep streaming output undisturbed.
      this.screen.saveOutputCursor();
      this.bar.draw(this.barState());
      this.screen.restoreOutputCursor();
    } else {
      const layout = this.bar.draw(this.barState());
      this.bar.placeCursor(layout);
    }
    this.screen.showCursor();
  }

  private handleSubmit(text: string): void {
    if (this.busy) {
      if (this.queue.length < MAX_QUEUE) this.queue.push(text);
      this.redrawBar();
      return;
    }
    void this.runTurn(text);
  }

  private async runTurn(text: string): Promise<void> {
    this.stopBannerRotation(); // first prompt ends the banner flashing
    this.busy = true;
    this.screen.moveToOutputBottom(); // cursor → output region
    this.renderer.info(pc.cyan('=> ') + text); // echo the prompt into the log
    this.renderer.rule(); // separate the prompt from the reply
    this.redrawBar();
    try {
      await this.dispatch(parse(text));
    } catch (e) {
      this.renderer.error(e instanceof Error ? e.message : String(e));
    }
    this.busy = false;
    this.redrawBar();
    const next = this.queue.shift();
    if (next && !this.exiting) void this.runTurn(next);
  }

  private handleInterrupt(): void {
    if (this.busy) {
      this.agent.stop();
      this.renderer.dim('(interrupted)');
      return;
    }
    if (this.editor.text.length > 0) {
      this.editor.clear();
      this.redrawBar();
      return;
    }
    this.exit(0);
  }

  private handleCycle(): void {
    this.ctx.mode = nextMode(this.ctx.mode);
    this.redrawBar();
  }

  private exit(code: number): void {
    if (this.exiting) return;
    this.exiting = true;
    this.stopBannerRotation();
    if (this.resizeDebounce) {
      clearTimeout(this.resizeDebounce);
      this.resizeDebounce = null;
    }
    this.editor.stop();
    this.screen.exit();
    this.resolveExit?.(code);
  }

  // ── Non-TTY fallback ──────────────────────────────────────────────────
  private runPlain(): Promise<number> {
    this.renderer.printHeader(this.ctx);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<number>((resolve) => {
      const ask = (): void => {
        if (this.exiting) {
          rl.close();
          resolve(0);
          return;
        }
        rl.question('=> ', (line) => {
          void (async () => {
            const parsed = parse(line);
            if (parsed.kind !== 'empty') {
              try {
                await this.dispatch(parsed);
              } catch (e) {
                this.renderer.error(e instanceof Error ? e.message : String(e));
              }
            }
            ask();
          })();
        });
      };
      ask();
    });
  }

  // ── Dispatch ──────────────────────────────────────────────────────────
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
      | 'mcp'
      | 'update',
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
        this.exit(0);
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
        await runAuth(this.prompter, this.renderer);
        return;
      case 'mode':
        this.handleMode(args);
        return;
      case 'undo':
        this.handleUndo(args);
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
      case 'update':
        return this.handleUpdate();
    }
  }

  private async handleUpdate(): Promise<void> {
    if (isBundled()) {
      this.renderer.dim('(autocode is bundled with Automax — V6 manages updates via Velopack)');
      return;
    }
    await runUpdate(this.renderer);
  }

  private handleUndo(args: string[]): void {
    const grain: 'step' | 'turn' = args[0] === 'turn' ? 'turn' : 'step';
    const r = this.agent.undo?.(grain);
    if (!r || r.restored === 0) {
      this.renderer.dim('(nothing to undo)');
      return;
    }
    const files = `${r.restored} file${r.restored === 1 ? '' : 's'}`;
    if (grain === 'turn') {
      this.renderer.info(`undid turn ${r.turn} — restored ${files}`);
    } else {
      this.renderer.info(`undid step ${r.step} of turn ${r.turn} — restored ${files}`);
    }
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
      '/cwd [path]                    Show or change the project root',
      '/model [provider name]         Show or switch provider/model',
      '/init                          Scaffold an AUTOCODE.md for this project',
      '/clear                         Reset conversation history',
      '/compact                       Summarize older turns',
      '/cost                          Show session cost estimate',
      '/diff                          Show uncommitted git changes',
      '/auth                          Configure an API key',
      '/mode [planning|default|autocode]  Show or set the workflow mode (or shift+tab)',
      '/undo [turn]                   Revert last tool step (or last whole turn with `/undo turn`)',
      '/trash                         List recently deleted files (recoverable)',
      '/restore <id>                  Restore a deleted file from the trash',
      '/mcp                           List configured MCP servers and their tools',
      '/update                        Check for and install the latest autocode (npm)',
      '/stop                          Cancel current task (or Ctrl+C)',
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
        this.renderer.info(out.replace(/\n$/, ''));
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
