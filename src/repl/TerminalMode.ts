import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import { relative } from 'node:path';

import { nextMode, type SessionContext, type AgentMode } from '../session/SessionContext.js';
import type { CumulativeUsage } from '../session/TranscriptStore.js';
import type { TrashItem } from '../session/CheckpointStore.js';
import type { Message, ContentBlock } from '../llm/types.js';
import type { SubmitExtras } from './ink/composerText.js';
import { readFileSync } from 'node:fs';
import { buildAgentInput } from '../util/attachments.js';
import { trace } from '../util/trace.js';
import { estimateCost, formatUsd } from '../util/pricing.js';
import { ConsoleRenderer } from './ConsoleRenderer.js';
import { parse, type ParsedInput, type LocalCommandName } from './CommandParser.js';
import { runInit } from './InitCommand.js';
import { runAuth } from './AuthCommand.js';
import { runLogin, printAlreadyAuthenticatedNotice } from './LoginCommand.js';
import { runProxyStatus } from './ProxyStatusCommand.js';
import { isAutomaxHosted } from '../util/host.js';
import { PrompterRef } from './Prompter.js';
import { runUpdate } from '../update/UpdateChecker.js';
import { isBundled } from '../util/host.js';
import { applyProposal, type Proposal } from '../agent/SessionReflection.js';
import { getGitWorkingState } from '../agent/SessionState.js';
import { contextWindowFor } from '../util/contextWindow.js';
import { currentTodos } from '../tools/todoWrite.js';
import { ConfigStore } from '../auth/ConfigStore.js';
import { getPlugins } from '../agent/Plugins.js';
import { getSkills, renderSkillInvocation, skillForCommand } from '../agent/Skills.js';
import { MemoryStore } from '../agent/Memory.js';
import { cleanCommitMessage, commit, commitMessagePrompt, currentBranch, isGitRepo, stageAll, stagedSummary } from '../agent/GitWorkflow.js';
import { PLAN_CHOICES, implementPlanMessage, looksLikePlan, savePlan } from '../agent/PlanFile.js';
import { type EventEmitter, NullEventEmitter } from './EventEmitter.js';
import { COMMAND_DEFS } from './commands.js';
import {
  EFFORT_SETTINGS,
  describeThinking,
  getKnownModels,
  modelBadges,
  modelCatalogDetail,
  modelCatalogSource,
  parseEffortSetting,
  thinkingFor,
} from '../llm/models.js';
import { discoverModels, discoveryState } from '../llm/ProviderDiscovery.js';
import { byokKeyFor } from '../auth/AuthResolver.js';
import { cwdStatus, resolveCwdTarget } from './cwd.js';
import { resolveThemeName } from './ink/theme.js';

const MAX_QUEUE = 5;

export interface AgentHandler {
  submit(input: string | ContentBlock[], ctx: SessionContext): Promise<void>;
  stop(): void;
  clearConversation(): number;
  compactConversation(ctx: SessionContext): Promise<{ before: number; after: number; summarized: boolean }>;
  cumulativeUsage(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  // Tokens currently live in the context window (≈ last request's input).
  currentContextTokens?(): number;
  loadState?(state: { messages: Message[]; usage: CumulativeUsage }): void;
  undo?(grain?: 'step' | 'turn'): { turn: number; restored: number; step?: number } | null;
  hasReflectableActivity?(): boolean;
  reflectOnSession?(ctx: SessionContext): Promise<import('../agent/SessionReflection.js').Proposal[]>;
  trashList?(): TrashItem[];
  restore?(id: string): TrashItem | null;
  mcpStatus?(): Array<{ name: string; connected: boolean; toolCount: number; resourceCount?: number; error?: string }>;
  mcpTools?(): string[];
  mcpResources?(): Array<{ serverName: string; uri: string; name: string; description?: string }>;
  hooks?: { events(): string[]; count(): number };
  // The final text of the last completed turn (plan approval).
  lastAssistantText?(): string;
  // One-shot text on the provider's cheap tier (commit messages).
  quickText?(ctx: SessionContext, system: string, user: string): Promise<string>;
  // Optional — Ink Bridge mode wraps the event emitter at runtime.
  setEmitter?(emitter: EventEmitter): void;
  refreshConfig?(): void;
}

// The interactive REPL. Two render paths:
//  - Ink Bridge (default for TTY) — full-screen alt-screen React app.
//  - Plain readline (non-TTY, AUTOCODE_AUTOMAX=1, piped stdin) — the line
//    loop the Automax V6 host bridges over.
// The legacy pinned-bar TUI (raw ANSI scroll regions + Screen/BottomBar/
// LineEditor) was removed in Phase 36 — Bridge supersedes it cleanly,
// and `runPlain` handles every environment where Bridge can't render.

// Resize diagnostics for hosted terminals (ConPTY delivers resizes late or
// not at all to idle processes): AUTOCODE_TRACE_LOG=<file> gets one line per
// event, poll detection, remount and event-loop stall (see util/trace.ts).
function resizeTrace(line: string): void {
  trace(`resize: ${line}`);
}

export class TerminalMode {
  private exiting = false;
  private busy = false;
  private readonly queue: Array<{ text: string; extras?: SubmitExtras }> = [];
  private resolveExit: ((code: number) => void) | null = null;
  private inkInstance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null;
  // The composer's text and history, owned here so an inline-mode remount
  // (rebuild-on-resize) does not lose what the user was typing.
  private readonly draft: import('./ink/InkApp.js').ComposerDraft = { input: '', cursor: 0, history: [] };
  private remounting = false;
  // Reference to the live BridgeStore (only set while Bridge is mounted)
  // so slash-command handlers can open overlays like the model picker.
  private bridgeStore: import('./ink/store.js').BridgeStore | null = null;

  constructor(
    private readonly ctx: SessionContext,
    private readonly renderer: ConsoleRenderer,
    private readonly agent: AgentHandler,
    private readonly prompter: PrompterRef,
    private readonly emitter: EventEmitter = new NullEventEmitter(),
  ) {}

  run(): Promise<number> {
    // Launch-time liveness handshake for the Automax V6 host. V6's safety gate
    // won't send input to a terminal pane until it has seen at least one
    // <<AMX>> event confirming autocode is actually running — and the next
    // event (`started`) only fires once a task begins, which needs that input.
    // Emitting `ready` here breaks that deadlock. Going through `this.emitter`
    // makes it a byte-identical <<AMX>> line under --automax (StdoutEventEmitter)
    // and a silent no-op standalone (NullEventEmitter) — same convention as
    // started/tool_call/etc. Fires exactly once: run() is called once per launch.
    this.emitter.emit('ready', {
      pid: process.pid,
      cwd: this.ctx.projectRoot,
      mode: this.ctx.mode,
    });

    // Bridge (Ink) for any real TTY; readline fallback otherwise.
    // Note: when hosted by Automax V6, --automax still drives the AMX event
    // stream + proxy-catalog fetch (see cli.ts), but the TUI choice is now
    // purely TTY-based — V6's ConPty pane reports as a TTY and renders the
    // full Ink Bridge UI just like a standalone shell. The earlier "V6 owns
    // the chat panel" gate that forced runPlain here was a dated assumption
    // from before the Terminal-tab redesign.
    if (!process.stdout.isTTY) return this.runPlain();
    return this.runBridge();
  }

  // ── Ink Bridge TUI ────────────────────────────────────────────────────
  //
  // Full-bleed alt-screen React app. Reuses every dispatch / queue / slash-
  // command handler from this class — Bridge just swaps the rendering
  // surface. The agent's event emitter is wrapped (BridgeEventEmitter →
  // React store) and the renderer's sink is set so all
  // `renderer.info/assistant/diff/…` calls accumulate in the same store.
  // Nothing in agent/loop/tools sees any of this.
  private async runBridge(): Promise<number> {
    const { BridgeStore } = await import('./ink/store.js');
    const { createRendererSink, createBridgeEventEmitter } = await import('./ink/bridge.js');
    const { mountInkApp } = await import('./ink/InkApp.js');
    const { BridgePrompter } = await import('./ink/BridgePrompter.js');

    const store = new BridgeStore();
    this.bridgeStore = store;
    store.setModel(this.ctx.model.provider, this.ctx.model.model);
    this.renderer.setSink(createRendererSink(store));
    // Real inline prompts: confirmations, default-mode approvals, ask_user
    // choices, and text input all render as a PromptOverlay in the React
    // tree. (Replaces the interim AutoAcceptPrompter that silently accepted
    // everything — default mode now actually reviews.)
    this.prompter.use(new BridgePrompter(store, this.emitter));

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

    // Snapshot the project's git branch + dirty count into the rail's PROJECT
    // row. getGitWorkingState is cached ~2s, so polling it on the usage timer
    // is nearly free; it keeps the branch live across mid-session checkouts.
    const refreshProjectGit = (): void => {
      this.refreshBridgeProject();
    };
    refreshProjectGit();

    // Poll cumulative usage every 1500ms to keep the rail's context meter
    // alive between events. Cheap — just reads in-memory counters. The
    // store dedupes identical values, so steady-state cycles cost nothing.
    const usageTimer = setInterval(() => {
      const u = this.agent.cumulativeUsage();
      const { cost } = estimateCost(u, this.ctx.model.provider, this.ctx.model.model);
      store.setUsage({
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        costUsd: cost,
        currentContextTokens: this.agent.currentContextTokens?.() ?? 0,
        contextWindow: contextWindowFor(this.ctx.model.provider, this.ctx.model.model),
      });
      store.setQueueDepth(this.queue.length);
      store.setBusy(this.busy);
      store.setMode(this.ctx.mode);
      store.setModel(this.ctx.model.provider, this.ctx.model.model);
      store.setEffort(describeThinking(thinkingFor(this.ctx.model.provider, this.ctx.model.model, this.ctx.effort)));
      refreshProjectGit();
      store.setPlan(currentTodos(this.ctx.sessionId).map((td) => ({ text: td.text, status: td.status })));
    }, 1500);

    const version = await this.readVersion();

    const uiCfg = (() => {
      try {
        return new ConfigStore().load().ui ?? {};
      } catch {
        return {};
      }
    })();
    const uiMode: 'inline' | 'cockpit' = uiCfg.mode === 'cockpit' ? 'cockpit' : 'inline';
    const uiTheme = resolveThemeName(process.env.AUTOMAX_THEME, uiCfg.theme);

    const appProps: import('./ink/InkApp.js').InkAppProps = {
      store,
      draft: this.draft,
      sessionId: this.ctx.sessionId,
      projectRoot: this.ctx.projectRoot,
      modelProvider: this.ctx.model.provider,
      modelName: this.ctx.model.model,
      version,
      uiMode,
      theme: uiTheme,
      onSubmit: (text, extras) => this.handleSubmit(text, extras),
      onCycleMode: () => {
        this.handleCycle();
        store.setMode(this.ctx.mode);
      },
      onInterrupt: () => this.handleInterrupt(),
      onExit: () => this.exitInk(),
      onModelChange: (provider, model) => {
        this.ctx.model = { provider, model };
        store.setModel(provider, model);
        this.renderer.dim(`model → ${provider} / ${model}`);
      },
      onSaveKey: async (provider, apiKey) => {
        const { saveByokKey } = await import('../auth/keyStatus.js');
        await saveByokKey(provider, apiKey);
        this.renderer.dim(`saved ${provider} key (restart autocode to use it)`);
      },
      onRemoveKey: async (provider) => {
        const { removeByokKey } = await import('../auth/keyStatus.js');
        await removeByokKey(provider);
        this.renderer.dim(`removed ${provider} key`);
      },
    };

    const mount = (): Promise<{ unmount: () => void; waitUntilExit: () => Promise<void> }> => mountInkApp(appProps);
    this.inkInstance = await mount();

    // Inline mode rebuilds the transcript from source on resize (Codex CLI's
    // approach): the rows Ink's <Static> wrote were laid out for the old
    // width, so after the drag settles we unmount, clear screen + scrollback
    // and mount again — the store and the composer draft survive, only the
    // paint is redone. Cockpit mode owns the alternate screen and relayouts
    // itself.
    let resizeTimer: NodeJS.Timeout | null = null;
    const onResize = (): void => {
      resizeTrace(`event ${process.stdout.columns}x${process.stdout.rows} ui=${uiMode} exiting=${this.exiting}`);
      if (uiMode !== 'inline' || this.exiting) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        resizeTrace(`remount ${process.stdout.columns}x${process.stdout.rows}`);
        void this.remountInk(mount);
      }, 200);
    };
    process.stdout.on('resize', onResize);

    // ConPTY (Automax's terminal, Windows Terminal, node-pty) only tells an
    // idle Node process about a resize on its next write, so a session
    // sitting at the composer would never rebuild. Poll the real window size
    // and raise the event ourselves when it changed; a later native event
    // for the same size is coalesced by the debounce above.
    const readSize = (): [number, number] | null => {
      try {
        const fn = (process.stdout as { getWindowSize?: () => [number, number] }).getWindowSize;
        const size = fn ? fn.call(process.stdout) : null;
        return size && size[0] > 0 && size[1] > 0 ? size : null;
      } catch {
        return null;
      }
    };
    let lastSize = readSize();
    let lastTick = Date.now();
    const sizeTimer = setInterval(() => {
      // Event-loop stalls delay every resize signal; make them visible.
      const tick = Date.now();
      if (tick - lastTick > 600) resizeTrace(`loop stalled ${tick - lastTick}ms`);
      lastTick = tick;
      const now = readSize();
      if (!now || !lastSize) return;
      if (now[0] === lastSize[0] && now[1] === lastSize[1]) return;
      lastSize = now;
      resizeTrace(`poll ${now[0]}x${now[1]} prop ${process.stdout.columns}x${process.stdout.rows}`);
      if (process.stdout.columns !== now[0] || process.stdout.rows !== now[1]) {
        (process.stdout as { columns: number }).columns = now[0];
        (process.stdout as { rows: number }).rows = now[1];
        process.stdout.emit('resize');
      }
    }, 250);

    return new Promise<number>((resolve) => {
      this.resolveExit = (code) => {
        process.stdout.off('resize', onResize);
        clearInterval(sizeTimer);
        if (resizeTimer) clearTimeout(resizeTimer);
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
        this.bridgeStore = null;
        resolve(code);
      };
    });
  }

  private exitInk(): void {
    if (this.exiting) return;
    this.exit(0);
  }

  // Tear the Ink tree down and mount it again at the current terminal size.
  // Everything the transcript shows lives in the BridgeStore, so the new
  // instance re-emits the whole history at the new width.
  private async remountInk(
    mount: () => Promise<{ unmount: () => void; waitUntilExit: () => Promise<void> }>,
  ): Promise<void> {
    if (this.exiting || this.remounting || !this.inkInstance) return;
    this.remounting = true;
    try {
      try {
        this.inkInstance.unmount();
      } catch {
        /* nothing */
      }
      this.inkInstance = null;
      // Clear the screen and the scrollback so no row from the old width survives.
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      this.inkInstance = await mount();
    } finally {
      this.remounting = false;
    }
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

  // ── Input plumbing (shared by Bridge callbacks) ───────────────────────

  private handleSubmit(text: string, extras?: SubmitExtras): void {
    if (this.busy) {
      if (this.queue.length < MAX_QUEUE) this.queue.push({ text, extras });
      return;
    }
    void this.runTurn(text, extras);
  }

  private async runTurn(text: string, extras?: SubmitExtras): Promise<void> {
    this.busy = true;
    const parsed = parse(text);
    try {
      await this.dispatch(parsed, extras);
      if (parsed.kind === 'agent' && this.ctx.mode === 'planning') await this.offerPlanApproval(parsed.text);
    } catch (e) {
      this.renderer.error(e instanceof Error ? e.message : String(e));
    }
    trace('terminal: turn finished');
    this.busy = false;
    const next = this.queue.shift();
    if (next && !this.exiting) void this.runTurn(next.text, next.extras);
  }

  private handleInterrupt(): void {
    // Pure interrupt: stops the agent if it's running, no-op otherwise.
    // Exit is a separate path (Ctrl+C double-press in Bridge, /exit
    // anywhere) so the user can't accidentally close autocode while
    // an important long-running task is mid-flight.
    if (this.busy) {
      this.agent.stop();
      this.renderer.dim('(interrupted)');
    }
  }

  private handleCycle(): void {
    this.ctx.mode = nextMode(this.ctx.mode);
  }

  private exit(code: number): void {
    if (this.exiting) return;
    this.exiting = true;
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
  private async dispatch(parsed: ParsedInput, extras?: SubmitExtras): Promise<void> {
    switch (parsed.kind) {
      case 'empty':
        return;
      case 'agent': {
        // `/<skill-name> …` invokes a skill: its body rides inside the
        // message, Claude Code style, and the model applies it to the rest.
        let text = parsed.text;
        if (text.startsWith('/')) {
          const [head, ...rest] = text.slice(1).split(/\s+/);
          const skill = skillForCommand(getSkills(this.ctx.projectRoot), head ?? '');
          if (skill) {
            text = renderSkillInvocation(skill, rest.join(' '));
            this.bridgeStore?.setUserDisplay(parsed.text);
            this.renderer.dim(`  (skill ${skill.name} loaded)`);
          }
        }
        const { input, missing, notes } = buildAgentInput(text, this.ctx.projectRoot, {
          provider: this.ctx.model.provider,
        });
        for (const ref of missing) this.renderer.warn(`(could not read @${ref})`);
        for (const note of notes) this.renderer.dim(`  ${note}`);
        // Clipboard images from the composer ride along as image blocks.
        const clips: ContentBlock[] = [];
        for (const img of extras?.images ?? []) {
          try {
            clips.push({ type: 'image', mediaType: img.mediaType, data: readFileSync(img.path).toString('base64') });
          } catch {
            this.renderer.warn(`(could not read clipboard image ${img.path})`);
          }
        }
        const withClips: string | ContentBlock[] =
          clips.length === 0 ? input : typeof input === 'string' ? [{ type: 'text', text: input }, ...clips] : [...input, ...clips];
        if (extras?.display) this.bridgeStore?.setUserDisplay(extras.display);
        await this.agent.submit(withClips, this.ctx);
        return;
      }
      case 'local':
        return this.handleLocal(parsed.name, parsed.args);
    }
  }

  private async handleLocal(
    name: LocalCommandName,
    args: string[],
  ): Promise<void> {
    switch (name) {
      case 'help':
        this.printHelp();
        return;
      case 'status':
        this.printStatus();
        return;
      case 'proxy':
        await runProxyStatus(this.renderer, this.ctx.model.provider);
        return;
      case 'cwd':
        this.handleCwd(args);
        return;
      case 'model':
        await this.handleModel(args);
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
      case 'keys':
        return this.handleKeys(args);
      case 'login':
        if (isAutomaxHosted()) {
          // V6-embedded — V6's session owns the auth. Plan 8 Open Decision
          // #4 (a): hard no-op with a helpful message, never spawn a
          // browser handoff that would create who-am-I ambiguity.
          printAlreadyAuthenticatedNotice(this.renderer);
        } else {
          // /login takes the key as an inline argument. The Bridge prompter
          // can't reliably ask for paste mid-session (interim AutoAccept
          // returns ''), so passing-as-arg is the only mode that works in
          // every shell. /login alone prints instructions; /login sk_amx_…
          // validates + saves.
          await runLogin(this.renderer, args[0]);
        }
        return;
      case 'mode':
        this.handleMode(args);
        return;
      case 'effort':
        this.handleEffort(args);
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
      case 'refresh': {
        const { forceRefreshRepoMap, adoptIndexIfReady } = await import('../agent/RepoMap.js');
        const { indexEnabled, resetIndex, startIndex } = await import('../index/IndexManager.js');
        forceRefreshRepoMap(this.ctx.projectRoot);
        if (indexEnabled()) {
          resetIndex(this.ctx.projectRoot);
          try {
            const index = await startIndex(this.ctx.projectRoot);
            adoptIndexIfReady(this.ctx.projectRoot, this.ctx.model);
            const s = index.stats();
            this.renderer.info(`Repo map and code index rebuilt: ${s.files} files, ${s.symbols} symbols, ${s.edges} edges.`);
          } catch (e) {
            this.renderer.warn(`Repo map rebuilt; code index failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          this.renderer.info('Repo map rebuilt from the current file tree.');
        }
        return;
      }
      case 'update':
        return this.handleUpdate();
      case 'reflect':
        return this.handleReflect();
      case 'plugins':
        return this.handlePlugins();
      case 'hooks':
        return this.handleHooks();
      case 'memory':
        return this.handleMemory(args);
      case 'commit':
        return this.handleCommit(args.join(' '));
      case 'spinner':
        return this.handleSpinner(args);
      case 'computer-use':
        return this.handleComputerUse(args);
      case 'ui':
        return this.handleUi(args);
    }
  }

  // `/keys` (and its `/auth` alias). No args inside Bridge opens the
  // interactive key-manager overlay (see/add/replace/remove BYOK keys). The
  // arg path (`/keys <provider> <key>`) and the non-TTY no-args help both
  // route through runAuth.
  private async handleKeys(args: string[]): Promise<void> {
    if (args.length === 0 && this.bridgeStore !== null) {
      this.bridgeStore.setOverlay({ kind: 'byok' });
      return;
    }
    await runAuth(this.renderer, args);
  }

  private handleUi(args: string[]): void {
    const cs = new ConfigStore();
    const cfg = cs.load();
    const ui = cfg.ui ?? {};
    if (args.length === 0) {
      const hostTheme = process.env.AUTOMAX_THEME;
      const effective = resolveThemeName(hostTheme, ui.theme);
      const source = effective !== (ui.theme ?? 'dark') && hostTheme ? ' (set by Automax)' : '';
      this.renderer.info(`ui mode: ${ui.mode ?? 'inline'} · theme: ${effective}${source}`);
      this.renderer.dim('set with  /ui inline|cockpit  or  /ui dark|light');
      return;
    }
    const arg = args[0]!.toLowerCase();
    if (arg === 'inline' || arg === 'cockpit') {
      cs.save({ ...cfg, ui: { ...ui, mode: arg } });
      this.renderer.dim(`ui mode → ${arg} (restart autocode to apply)`);
      return;
    }
    if (arg === 'dark' || arg === 'light') {
      cs.save({ ...cfg, ui: { ...ui, theme: arg } });
      this.renderer.dim(`ui theme → ${arg} (restart autocode to apply)`);
      return;
    }
    this.renderer.error(`unknown /ui option '${arg}'. valid: inline, cockpit, dark, light`);
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

  private handleComputerUse(args: string[]): void {
    const cs = new ConfigStore();
    const cfg = cs.load();
    const enabled = cfg.computerUse?.enabled === true;
    if (args.length === 0) {
      this.renderer.info(`computer use: ${enabled ? 'on' : 'off'}`);
      this.renderer.dim('set with /computer-use on|off');
      return;
    }
    const arg = args[0]!.toLowerCase();
    if (arg !== 'on' && arg !== 'off') {
      this.renderer.error(`unknown /computer-use option '${arg}'. valid: on, off`);
      return;
    }
    const nextEnabled = arg === 'on';
    cs.save({ ...cfg, computerUse: { ...(cfg.computerUse ?? {}), enabled: nextEnabled } });
    this.agent.refreshConfig?.();
    this.renderer.dim(`computer use -> ${nextEnabled ? 'on' : 'off'}`);
  }

  // Plan mode as a workflow (Phase 4.2): a planning answer that reads like
  // a plan is saved under .autocode/plans and offered for approval with
  // Claude Code's dialog; approval switches the mode and starts the work.
  private async offerPlanApproval(request: string): Promise<void> {
    const plan = this.agent.lastAssistantText?.() ?? '';
    if (!looksLikePlan(plan)) return;
    let planPath: string;
    try {
      planPath = savePlan(this.ctx.projectRoot, request, plan);
    } catch (e) {
      this.renderer.warn(`could not save the plan: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.renderer.dim(`  plan saved to ${planPath}`);
    let picked: number[];
    try {
      picked = await this.prompter.choose('Ready to implement this plan?', [...PLAN_CHOICES], false);
    } catch {
      return; // headless / no prompter: leave the plan on disk
    }
    const choice = picked[0];
    if (choice === 0 || choice === 1) {
      this.ctx.mode = choice === 0 ? 'autocode' : 'default';
      this.bridgeStore?.setMode?.(this.ctx.mode);
      this.renderer.status(`  ✓ plan approved — ${choice === 0 ? 'auto-accepting edits' : 'edits will be shown for approval'}`);
      await this.dispatch({ kind: 'agent', text: implementPlanMessage(planPath) });
    } else {
      this.renderer.dim('  (still planning — refine the plan or switch modes with shift+tab)');
    }
  }

  // /commit [hint]: stage everything, write a conventional message (the
  // model's cheap tier, from the staged diff), confirm, commit.
  private async handleCommit(hint: string): Promise<void> {
    const root = this.ctx.projectRoot;
    if (!isGitRepo(root)) {
      this.renderer.warn('Not a git repository.');
      return;
    }
    const staged = stageAll(root);
    if (!staged.ok) {
      this.renderer.error(`git add failed: ${staged.error}`);
      return;
    }
    const summary = stagedSummary(root);
    if (summary.files.length === 0) {
      this.renderer.dim('(nothing to commit)');
      return;
    }
    let message = hint.trim();
    if (message.length === 0 || !this.agent.quickText) {
      if (this.agent.quickText) {
        this.renderer.spinner.start('writing commit message');
        try {
          const p = commitMessagePrompt(summary, hint.trim() || undefined);
          message = cleanCommitMessage(await this.agent.quickText(this.ctx, p.system, p.user));
        } catch (e) {
          this.renderer.warn(`could not generate a message: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          this.renderer.spinner.stop();
        }
      }
      if (message.length === 0) message = `chore: update ${summary.files.length} file${summary.files.length === 1 ? '' : 's'}`;
    } else if (this.agent.quickText && hint.trim().split(/\s+/).length <= 6 && !/^[a-z]+(\(.+\))?!?:/.test(hint.trim())) {
      // A few words are a hint for the message writer, not the message.
      this.renderer.spinner.start('writing commit message');
      try {
        const p = commitMessagePrompt(summary, hint.trim());
        message = cleanCommitMessage(await this.agent.quickText(this.ctx, p.system, p.user)) || message;
      } catch {
        /* keep the hint as the message */
      } finally {
        this.renderer.spinner.stop();
      }
    }
    this.renderer.info(`Staged ${summary.files.length} file${summary.files.length === 1 ? '' : 's'}:`);
    this.renderer.dim(summary.stat);
    this.renderer.info(message);
    const ok = await this.prompter.confirm('Commit with this message?');
    if (!ok) {
      this.renderer.dim('(not committed — changes stay staged)');
      return;
    }
    const r = commit(root, message, 'Co-Authored-By: autocode <noreply@bvrai.com>');
    if (r.ok) this.renderer.status(`  ✓ committed ${r.hash}${currentBranch(root) ? ` on ${currentBranch(root)}` : ''}`);
    else this.renderer.error(`git commit failed: ${r.error}`);
  }

  private handleHooks(): void {
    const hub = this.agent.hooks;
    if (!hub || hub.count() === 0) {
      this.renderer.dim('(no hooks — add `hooks` to ~/.autocode/config.json, a .autocode/hooks.json in the project, or a plugin hooks.json)');
      return;
    }
    for (const event of hub.events()) this.renderer.info(`${event}`);
    this.renderer.dim(`  ${hub.count()} hook command(s) across ${hub.events().length} event(s); see agent/HookRunner.ts for the contract`);
  }

  private handleMemory(args: string[]): void {
    const store = new MemoryStore(this.ctx.projectRoot);
    if (args[0] === 'forget' && args[1]) {
      this.renderer.info(store.delete(args[1]) ? `Forgot "${args[1]}".` : `No memory named "${args[1]}".`);
      return;
    }
    const entries = store.list();
    if (entries.length === 0) {
      this.renderer.dim(`(nothing remembered yet for this project — the agent saves facts with save_memory; files live in ${store.dir})`);
      return;
    }
    for (const m of entries) this.renderer.info(`${m.kind.padEnd(9)} ${m.name} — ${m.description}`);
    this.renderer.dim(`  ${entries.length} memor${entries.length === 1 ? 'y' : 'ies'} in ${store.dir}; /memory forget <name> removes one`);
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

  // /exit handler — runs smart-docs reflection first (unless conditions
  // say no), then shuts the TUI down. Distinct from the Ctrl+C exit path
  // (handleInterrupt) which exits immediately without reflection — Ctrl+C
  // is for "get me out fast."
  private async handleExit(): Promise<void> {
    await this.maybeReflectAtExit();
    // SessionEnd hooks (the legacy `stop` hooks) fire from the CLI once the
    // session returns, for headless and interactive runs alike.
    this.exit(0);
  }

  private async maybeReflectAtExit(): Promise<void> {
    if (!process.stdout.isTTY) return; // headless: no interactive review
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
      const tag = s.connected ? `${s.toolCount} tools${s.resourceCount ? `, ${s.resourceCount} resources` : ''}` : `failed: ${s.error}`;
      this.renderer.info(`${s.connected ? '✓' : '✗'} ${s.name} — ${tag}`);
    }
    const tools = this.agent.mcpTools?.() ?? [];
    if (tools.length > 0) {
      this.renderer.dim(`  tools: ${tools.join(', ')}`);
    }
    const resources = this.agent.mcpResources?.() ?? [];
    for (const r of resources.slice(0, 40)) {
      this.renderer.dim(`  resource: ${r.serverName} ${r.uri}${r.description ? ` — ${r.description}` : ''}`);
    }
    if (resources.length > 40) this.renderer.dim(`  … ${resources.length - 40} more resources`);
  }

  private printHelp(): void {
    // Source of truth = COMMAND_DEFS. Same list drives the Bridge slash
    // menu, so help and discovery never drift apart.
    const sigWidth = Math.max(...COMMAND_DEFS.map((c) => c.signature.length)) + 2;
    for (const c of COMMAND_DEFS) {
      this.renderer.info(`${c.signature.padEnd(sigWidth)}${c.summary}`);
    }
  }

  private printStatus(): void {
    this.renderer.info(`session: ${this.ctx.sessionId}`);
    this.renderer.info(`project: ${this.ctx.projectRoot}`);
    this.renderer.info(`model:   ${this.ctx.model.provider} / ${this.ctx.model.model}`);
    this.renderer.info(`mode:    ${this.ctx.mode}`);
    this.renderer.info(`started: ${this.ctx.startedAt}`);
  }

  private refreshBridgeProject(): void {
    if (this.bridgeStore === null) return;
    this.bridgeStore.setProjectRoot(this.ctx.projectRoot);
    const g = getGitWorkingState(this.ctx.projectRoot);
    if (!g) {
      this.bridgeStore.setProjectGit(null, 0);
      return;
    }
    const branch = g.isDetachedHead ? 'detached' : g.branch;
    const dirty = g.stagedFiles.length + g.modifiedFiles.length + g.deletedFiles.length + g.untrackedCount;
    this.bridgeStore.setProjectGit(branch, dirty);
  }

  private handleCwd(args: string[]): void {
    if (args.length === 0) {
      this.renderer.info(this.ctx.projectRoot);
      return;
    }
    const target = resolveCwdTarget(args.join(' '), this.ctx.projectRoot);
    const status = cwdStatus(target);
    if (!status.ok) {
      this.renderer.error(`not a directory (${status.label}): ${target}`);
      return;
    }
    this.ctx.projectRoot = target;
    this.refreshBridgeProject();
    this.renderer.info(`project root → ${target}`);
  }

  // `/effort` — show or set how hard the model thinks (Claude Code's effort
  // levels). Remembered per model in config so the choice survives restarts.
  private handleEffort(args: string[]): void {
    const { provider, model } = this.ctx.model;
    if (args.length === 0) {
      const setting = this.ctx.effort ?? 'auto';
      const resolved = describeThinking(thinkingFor(provider, model, setting));
      this.renderer.info(
        `effort: ${setting} → ${resolved ?? 'thinking off'} for ${provider}/${model}`,
      );
      this.renderer.dim(`  /effort ${EFFORT_SETTINGS.join('|')}`);
      return;
    }
    const setting = parseEffortSetting(args[0]);
    if (setting === null) {
      this.renderer.error(`usage: /effort ${EFFORT_SETTINGS.join('|')}`);
      return;
    }
    this.ctx.effort = setting;
    const resolved = describeThinking(thinkingFor(provider, model, setting));
    this.bridgeStore?.setEffort(resolved);
    try {
      const store = new ConfigStore();
      const cfg = store.load();
      cfg.effort = { ...(cfg.effort ?? {}), [`${provider}/${model}`]: setting };
      store.save(cfg);
    } catch {
      /* persistence failure is non-fatal — the setting still applies this session */
    }
    this.renderer.info(`effort → ${setting} (${resolved ?? 'thinking off'}) for ${provider}/${model}`);
  }

  private async handleModel(args: string[]): Promise<void> {
    const refresh = args.length === 1 && args[0]!.toLowerCase() === 'refresh';
    if (args.length === 0 || refresh) {
      await this.refreshModelLists(refresh);
      // Inside Bridge → open the two-stage picker (provider first, then that
      // provider's models). Esc semantics inside the pickers handle the
      // "back to providers" transition.
      if (this.bridgeStore !== null) {
        this.bridgeStore.setOverlay({ kind: 'model-provider' });
        return;
      }
      // Plain mode (V6 / AUTOCODE_AUTOMAX / non-TTY) → there's no Ink overlay
      // to mount, so print the full catalog instead. Without this the user
      // only saw the *current* model and had no way to discover the available
      // names — and inside V6 specifically, the live proxy catalog we fetch
      // at startup was invisible.
      this.printModelList();
      return;
    }
    if (args.length < 2) {
      this.renderer.error('usage: /model <provider> <model>');
      return;
    }
    this.ctx.model = { provider: args[0]!, model: args.slice(1).join(' ') };
    this.bridgeStore?.setModel(this.ctx.model.provider, this.ctx.model.model);
    // Persist the choice as the new launch default. Next plain `acv1`
    // opens with this provider/model instead of falling back to xai.
    // Silent — matches gh/gcloud's "last-used is the default" UX.
    try {
      const store = new ConfigStore();
      const cfg = store.load();
      cfg.defaultProvider = this.ctx.model.provider;
      cfg.defaultModel = this.ctx.model.model;
      store.save(cfg);
    } catch {
      /* persistence failure is non-fatal — the switch still applies for
         this session, just won't be remembered next launch */
    }
    this.renderer.info(`model → ${this.ctx.model.provider} / ${this.ctx.model.model}`);
  }

  // Sessions without an Automax catalog list what the providers publish
  // (llm/ProviderDiscovery.ts). Startup begins that in the background; here
  // we wait for it — or redo it on `/model refresh` — so the picker opens on
  // the live rows. Sessions on the proxy catalog have nothing to fetch.
  private async refreshModelLists(force: boolean): Promise<void> {
    if (modelCatalogSource() === 'proxy' || process.env.AUTOCODE_NO_DISCOVERY) return;
    if (!force && discoveryState() === 'done') return;
    this.renderer.dim(force ? '(refreshing provider model lists…)' : '(checking provider model lists…)');
    try {
      const report = await discoverModels({ keyFor: byokKeyFor, force });
      const live = report.providers.filter((p) => p.source === 'fresh' || p.source === 'cache');
      const failed = report.providers.filter((p) => p.source === 'failed');
      if (live.length > 0) this.renderer.dim(`(live model lists: ${live.map((p) => `${p.provider} ${p.count}`).join(' · ')})`);
      if (failed.length > 0) this.renderer.dim(`(could not fetch ${failed.map((p) => p.provider).join(', ')} — bundled rows shown)`);
    } catch (e) {
      this.renderer.dim(`(model discovery failed: ${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // Plain-text equivalent of the Ink ModelPicker overlay. Same data source
  // (getKnownModels), same grouping, same current-model highlight rule —
  // just rendered through the renderer instead of as a React tree.
  private printModelList(): void {
    const models = getKnownModels();
    const currentProvider = this.ctx.model.provider;
    const currentModel = this.ctx.model.model;
    // Longest-prefix-match for the current row, matching findModel's rule
    // so e.g. "claude-opus-4-7-20251001" highlights the "claude-opus-4-7" entry.
    let currentKey: string | null = null;
    let bestLen = -1;
    for (const m of models) {
      if (m.provider !== currentProvider) continue;
      if (currentModel.startsWith(m.model) && m.model.length > bestLen) {
        currentKey = `${m.provider}/${m.model}`;
        bestLen = m.model.length;
      }
    }
    const sourceTag = `${modelCatalogDetail()} · ${models.length} models`;
    this.renderer.info(`Current: ${currentProvider} / ${currentModel}`);
    this.renderer.info('');
    this.renderer.info(`Available models (${sourceTag}):`);
    let lastProvider = '';
    const LABEL_WIDTH = 32;
    for (const m of models) {
      if (m.provider !== lastProvider) {
        this.renderer.info('');
        this.renderer.dim(`  ${m.provider.toUpperCase()}`);
        lastProvider = m.provider;
      }
      const isCurrent = `${m.provider}/${m.model}` === currentKey;
      const marker = isCurrent ? '←' : ' ';
      const label = m.label.length > LABEL_WIDTH ? m.label.slice(0, LABEL_WIDTH - 1) + '…' : m.label.padEnd(LABEL_WIDTH);
      const fmt = (n: number): string => String(Number(n.toFixed(4)));
      const price = m.priceUnknown ? 'price unknown' : `$${fmt(m.inputPerM)}/M in · $${fmt(m.outputPerM)}/M out`;
      const badges = modelBadges(m);
      const badgeText = badges.length > 0 ? `· ${badges.join(' · ')} ` : '';
      const notes = m.notes ? `· ${m.notes}` : '';
      const currentTag = isCurrent ? ' ← current' : '';
      this.renderer.info(`    ${marker} ${label}  ${price}  ${badgeText}${notes}${currentTag}`);
    }
    this.renderer.info('');
    this.renderer.dim('Switch with:  /model <provider> <model>');
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
    if (arg === 'planning' || arg === 'default' || arg === 'autocode' || arg === 'admin') {
      this.ctx.mode = arg as AgentMode;
      this.renderer.info(`mode → ${this.ctx.mode}`);
    } else {
      this.renderer.error('usage: /mode [planning|default|autocode|admin]');
    }
  }
}
