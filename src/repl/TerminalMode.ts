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
import { applyProposal, type Proposal } from '../agent/SessionReflection.js';
import { ConfigStore } from '../auth/ConfigStore.js';
import { runHooksForEvent } from '../agent/HookRunner.js';
import { getPlugins, pluginHooksForEvent } from '../agent/Plugins.js';
import { relative } from 'node:path';
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
  hasReflectableActivity?(): boolean;
  reflectOnSession?(ctx: SessionContext): Promise<import('../agent/SessionReflection.js').Proposal[]>;
  trashList?(): TrashItem[];
  restore?(id: string): TrashItem | null;
  mcpStatus?(): Array<{ name: string; connected: boolean; toolCount: number; error?: string }>;
  mcpTools?(): string[];
  // Optional — Ink Bridge mode wraps the event emitter at runtime.
  setEmitter?(emitter: EventEmitter): void;
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
    // V6 / --automax: when autocode is hosted by Automax V6, the V6 UI
    // owns the chat panel + input bar + spinner. We must not mount any
    // visual TUI; V6 only wants a line-oriented stdin and the JSON
    // event stream on stdout. Use runPlain regardless of TTY.
    if (process.env['AUTOCODE_AUTOMAX'] === '1') return this.runPlain();
    if (!this.screen.isTty) return this.runPlain();
    // Bridge (Ink) is the default TTY experience. Opt out via env var to
    // fall back to the legacy pinned-bar TUI in case of regressions.
    if (process.env['AUTOCODE_LEGACY_TUI'] === '1') return this.runTui();
    return this.runBridge();
  }

  // ── Ink Bridge TUI ────────────────────────────────────────────────────
  //
  // Full-bleed alt-screen React app. Reuses every dispatch / queue / slash-
  // command handler from this class — we just swap the rendering surface.
  // The agent's event emitter is wrapped (BridgeEventEmitter → React store)
  // and the renderer's sink is set so all `renderer.info/assistant/diff/…`
  // calls accumulate in the same store. Nothing in agent/loop/tools sees
  // any of this.
  private inkInstance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null;

  private async runBridge(): Promise<number> {
    const { BridgeStore } = await import('./ink/store.js');
    const { createRendererSink, createBridgeEventEmitter } = await import('./ink/bridge.js');
    const { mountInkApp } = await import('./ink/InkApp.js');
    const { AutoAcceptPrompter } = await import('./Prompter.js');

    const store = new BridgeStore();
    this.renderer.setSink(createRendererSink(store));
    // Interim: Bridge has no inline approval UI yet, so wire an auto-accept
    // prompter — the agent does not hang waiting for confirmations the
    // React tree can't render. Tracked for a follow-up PR.
    this.prompter.use(new AutoAcceptPrompter(this.emitter));

    // Wrap the existing emitter — preserves --automax JSON output.
    const innerEmitter = this.emitter;
    const bridgeEmitter = createBridgeEventEmitter(store, innerEmitter);
    this.agent.setEmitter?.(bridgeEmitter);

    store.setMode(this.ctx.mode);
    // Snapshot MCP status into the rail (refreshed every 5s).
    const refreshMcp = (): void => {
      const s = this.agent.mcpStatus?.() ?? [];
      store.setMcpStatus(s);
    };
    refreshMcp();
    const mcpTimer = setInterval(refreshMcp, 5_000);

    // Poll cumulative usage every 1500ms to keep the rail's context meter
    // alive between events. Cheap — just reads in-memory counters. The
    // store dedupes identical values, so steady-state cycles cost nothing.
    // Was 500ms originally — that produced ~8 React re-renders per second
    // and a visible flicker in the Ink tree.
    const { estimateCost } = await import('../util/pricing.js');
    const usageTimer = setInterval(() => {
      const u = this.agent.cumulativeUsage();
      const { cost } = estimateCost(u, this.ctx.model.provider, this.ctx.model.model);
      store.setUsage({
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        costUsd: cost,
      });
      store.setQueueDepth(this.queue.length);
      store.setBusy(this.busy);
      store.setMode(this.ctx.mode);
    }, 1500);

    const version = await this.readVersion();

    this.inkInstance = await mountInkApp({
      store,
      sessionId: this.ctx.sessionId,
      projectRoot: this.ctx.projectRoot,
      modelProvider: this.ctx.model.provider,
      modelName: this.ctx.model.model,
      version,
      onSubmit: (text) => this.handleSubmit(text),
      onCycleMode: () => {
        this.handleCycle();
        store.setMode(this.ctx.mode);
      },
      onInterrupt: () => this.handleInterrupt(),
      onExit: () => this.exitInk(),
    });

    return new Promise<number>((resolve) => {
      this.resolveExit = (code) => {
        clearInterval(mcpTimer);
        clearInterval(usageTimer);
        try {
          this.renderer.setSink(null);
          if (innerEmitter) this.agent.setEmitter?.(innerEmitter);
        } catch {
          /* nothing */
        }
        try {
          this.inkInstance?.unmount();
        } catch {
          /* nothing */
        }
        this.inkInstance = null;
        resolve(code);
      };
    });
  }

  private exitInk(): void {
    if (this.exiting) return;
    this.exit(0);
  }

  private async readVersion(): Promise<string> {
    try {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      // dist/repl → ../package.json (when running the built bundle)
      // src/repl → ../../package.json (during dev)
      for (const p of [resolve(here, '../../package.json'), resolve(here, '../package.json')]) {
        try {
          const pkg = JSON.parse(readFileSync(p, 'utf8')) as { version?: string };
          if (pkg.version) return `v${pkg.version}`;
        } catch { /* try next */ }
      }
    } catch {
      /* default */
    }
    return 'v0.1.0-dev';
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
      | 'update'
      | 'reflect'
      | 'plugins'
      | 'spinner',
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
        return this.handleExit();
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
      case 'reflect':
        return this.handleReflect();
      case 'plugins':
        return this.handlePlugins();
      case 'spinner':
        return this.handleSpinner(args);
    }
  }

  private handleSpinner(args: string[]): void {
    const valid = ['braille', 'pulse', 'orbit', 'arc', 'dots', 'heartbeat', 'bars', 'shimmer', 'pipeline', 'reactor'];
    if (args.length === 0) {
      this.renderer.info(`spinners: ${valid.join(', ')}`);
      try {
        const cfg = new ConfigStore().load();
        const current = cfg.spinner?.default ?? 'braille';
        this.renderer.dim(`current: ${current} · set with /spinner <name>`);
      } catch {
        this.renderer.dim('current: braille (default)');
      }
      return;
    }
    const id = args[0]!.toLowerCase();
    if (!valid.includes(id)) {
      this.renderer.error(`unknown spinner '${id}'. valid: ${valid.join(', ')}`);
      return;
    }
    try {
      const cs = new ConfigStore();
      const cfg = cs.load();
      cs.save({ ...cfg, spinner: { ...(cfg.spinner ?? {}), default: id } });
      this.renderer.dim(`spinner → ${id} (saved; takes effect on next restart for now)`);
    } catch (e) {
      this.renderer.error(`failed to save spinner: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private handlePlugins(): void {
    const plugins = getPlugins(this.ctx.projectRoot);
    if (plugins.length === 0) {
      this.renderer.dim(
        '(no plugins installed — drop a directory with plugin.json into ~/.autocode/plugins/<name>/ or <project>/.autocode/plugins/<name>/)',
      );
      return;
    }
    for (const p of plugins) {
      const counts: string[] = [];
      if (p.skills.length > 0) counts.push(`${p.skills.length} skill${p.skills.length === 1 ? '' : 's'}`);
      const hookTotal =
        (p.hooks.pre_tool?.length ?? 0) +
        (p.hooks.post_tool?.length ?? 0) +
        (p.hooks.stop?.length ?? 0);
      if (hookTotal > 0) counts.push(`${hookTotal} hook${hookTotal === 1 ? '' : 's'}`);
      const tag = `[${p.source}${p.version ? ` ${p.version}` : ''}]`;
      this.renderer.info(
        `${p.name}  ${tag}${p.description ? '  · ' + p.description : ''}${counts.length > 0 ? '  · ' + counts.join(', ') : ''}`,
      );
    }
  }

  // Smart docs — run a reflection on the session and review proposals
  // one at a time. Called explicitly via /reflect, and by exit() when
  // the session has meaningful activity (unless disabled in config).
  // /exit handler — runs smart-docs reflection first (unless conditions
  // say no), then shuts the TUI down. Distinct from the Ctrl+C exit path
  // (handleInterrupt) which exits immediately without reflection — Ctrl+C
  // is for "get me out fast."
  private async handleExit(): Promise<void> {
    await this.maybeReflectAtExit();
    await this.fireStopHooks();
    this.exit(0);
  }

  // Run user-defined `stop` hooks at /exit time. Advisory only — failures
  // are logged but the process exits regardless.
  private async fireStopHooks(): Promise<void> {
    let cfg: { hooks?: { stop?: Array<{ match?: string; command: string; timeoutMs?: number }> } } = {};
    try {
      cfg = new ConfigStore().load();
    } catch {
      /* default */
    }
    const stopHooks = [
      ...(cfg.hooks?.stop ?? []),
      ...pluginHooksForEvent(getPlugins(this.ctx.projectRoot), 'stop'),
    ];
    if (stopHooks.length === 0) return;
    const outcomes = await runHooksForEvent(stopHooks, {
      event: 'stop',
      projectRoot: this.ctx.projectRoot,
      sessionId: this.ctx.sessionId,
    });
    for (const o of outcomes) {
      if (o.timedOut) this.renderer.warn(`hook[stop] ${o.command} → timed out`);
      else if (o.exitCode !== 0) this.renderer.warn(`hook[stop] ${o.command} → exit ${o.exitCode ?? '?'}`);
      if (o.stdout.trim().length > 0) this.renderer.dim(`hook[stop]: ${o.stdout.trim()}`);
      if (o.stderr.trim().length > 0 && o.exitCode !== 0) this.renderer.dim(`hook[stop]: ${o.stderr.trim()}`);
    }
  }

  private async maybeReflectAtExit(): Promise<void> {
    if (!this.screen.isTty) return; // headless: no interactive review
    if (!this.agent.hasReflectableActivity) return; // no capability (e.g. stub)
    if (!this.agent.hasReflectableActivity()) return; // nothing meaningful happened
    let cfg: { reflectAfterSession?: boolean } = {};
    try {
      cfg = new ConfigStore().load();
    } catch {
      /* default config */
    }
    if (cfg.reflectAfterSession === false) return;
    await this.handleReflect();
  }

  private async handleReflect(): Promise<void> {
    if (!this.agent.reflectOnSession) {
      this.renderer.dim('(reflection not available in this mode)');
      return;
    }
    this.renderer.dim('reflecting on this session…');
    this.renderer.spinner.start('reflecting');
    let proposals: Proposal[] = [];
    try {
      proposals = await this.agent.reflectOnSession(this.ctx);
    } catch (e) {
      this.renderer.spinner.stop();
      this.renderer.warn(`(reflection failed: ${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    this.renderer.spinner.stop();
    if (proposals.length === 0) {
      this.renderer.dim('(nothing worth recording — pretty quiet session)');
      return;
    }
    this.renderer.info(`Found ${proposals.length} proposal${proposals.length === 1 ? '' : 's'} to consider:`);
    let accepted = 0;
    for (let i = 0; i < proposals.length; i++) {
      if (this.exiting) break;
      const p = proposals[i]!;
      const targetRel = relative(this.ctx.projectRoot, p.target).replace(/\\/g, '/') || 'AUTOCODE.md';
      const label =
        `Proposal ${i + 1}/${proposals.length}  →  ${targetRel}\n` +
        `  ${p.text}\n` +
        `  why: ${p.reason}`;
      const verdict = await this.prompter.approve(label);
      if (verdict.decision === 'accept') {
        applyProposal(p);
        this.renderer.dim(`  ✓ appended to ${targetRel}`);
        accepted += 1;
      } else if (verdict.decision === 'revise' && verdict.guidance) {
        applyProposal({ ...p, text: verdict.guidance });
        this.renderer.dim(`  ✓ appended (revised) to ${targetRel}`);
        accepted += 1;
      } else {
        this.renderer.dim('  ✗ skipped');
      }
    }
    this.renderer.dim(`(${accepted}/${proposals.length} accepted)`);
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
      '/plugins                       List installed autocode plugins (skills + hooks)',
      '/update                        Check for and install the latest autocode (npm)',
      '/reflect                       Propose AUTOCODE.md additions based on this session',
      '/spinner [name]                Show or set the active spinner (braille, pulse, orbit, …)',
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
