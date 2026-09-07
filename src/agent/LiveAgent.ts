import type { AgentHandler } from '../repl/TerminalMode.js';
import type { Prompter } from '../repl/Prompter.js';
import type { ConsoleRenderer } from '../repl/ConsoleRenderer.js';
import type { TranscriptStore } from '../session/TranscriptStore.js';
import type { SessionContext } from '../session/SessionContext.js';
import type { CheckpointStore } from '../session/CheckpointStore.js';

import { AgentLoop } from './AgentLoop.js';
import { ToolRegistry } from './ToolRegistry.js';
import { LlmRouter, type ProviderName } from '../llm/Router.js';
import { summarizerModelFor } from '../llm/models.js';
import type { ContentBlock } from '../llm/types.js';
import { SubagentRunner } from './SubagentRunner.js';
import { McpClientManager } from '../mcp/McpClientManager.js';
import { McpTool } from '../mcp/McpTool.js';
import { ConfigStore } from '../auth/ConfigStore.js';
import { HookHub } from './HookHub.js';
import { collectMcpServers, describeServer } from '../mcp/McpConfig.js';
import { ProjectState } from '../session/ProjectState.js';
import { isTrusted } from './Trust.js';
import { mergeRules, normalizeRules, readProjectRules, type PermissionRules } from '../safety/PermissionRules.js';
import type { EventEmitter } from '../repl/EventEmitter.js';
import { NullEventEmitter } from '../repl/EventEmitter.js';
import { judgePrompt, parseJudgement, type Judgement } from './AutoApprover.js';
import { shutdownLsp } from '../lsp/LspManager.js';
import { benchMode } from './toolAvailability.js';
import type { AutocodeConfig } from '../auth/ConfigStore.js';

export function autoJudgeEnabled(config: AutocodeConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (benchMode()) return false;
  if (env.AUTOCODE_AUTO_JUDGE === 'on') return true;
  if (env.AUTOCODE_AUTO_JUDGE === 'off') return false;
  return config.autoMode?.reviewer !== false;
}

export class LiveAgent implements AgentHandler {
  readonly loop: AgentLoop;
  readonly registry: ToolRegistry;
  readonly mcp: McpClientManager;

  private readonly checkpoints?: CheckpointStore;

  constructor(
    private readonly renderer: ConsoleRenderer,
    store: TranscriptStore,
    opts: {
      checkpoints?: CheckpointStore;
      prompter: Prompter;
      emitter?: EventEmitter;
      mode?: import('../session/SessionContext.js').AgentMode;
      // A host's per-session verification policy (overrides config.json).
      autoVerify?: boolean;
      verifyCommand?: string;
    },
  ) {
    const router = new LlmRouter();
    this.router = router;
    // Verification settings and hooks: config.json plus the project's own
    // hooks.json and plugin hooks (see agent/HookHub.ts).
    const config = new ConfigStore().load();
    // Repo-supplied hooks, permission rules and MCP servers wait for the
    // trust gate (agent/Trust.ts); user config always applies.
    const trusted = isTrusted(store.projectRoot);
    this.hooks = new HookHub(store.projectRoot, store.sessionId, { config: config.hooks ?? null, renderer: this.renderer, includeProject: trusted, includePlugins: trusted });
    this.permissions = mergeRules(normalizeRules(config.permissions), trusted ? readProjectRules(store.projectRoot) : null);
    const runner = new SubagentRunner(router, store, this.hooks);
    // Sights mode (Automax V6's locked-down website builder) gets a registry
    // restricted to in-root file ops. The registry is fixed at construction —
    // sights is CLI-only and headless, so the mode never changes in-session.
    this.registry = opts.mode === 'sights' ? ToolRegistry.forSights() : new ToolRegistry();
    this.mcp = new McpClientManager();
    this.checkpoints = opts.checkpoints;
    this.prompter = opts.prompter;
    this.projectRoot = store.projectRoot;
    // All interactive confirmation goes through the Prompter — the single
    // owner of stdin (auto-deny in headless, the pinned bar in the TUI).
    this.loop = new AgentLoop({
      renderer: this.renderer,
      store,
      router,
      registry: this.registry,
      confirm: (message) => opts.prompter.confirm(message),
      approve: (label, detail) => opts.prompter.approve(label, detail),
      choose: (question, options, multiSelect) => opts.prompter.choose(question, options, multiSelect),
      subagentFactory: (input) => runner.run(input),
      checkpoints: this.checkpoints,
      autoVerify: opts.autoVerify ?? config.autoVerify !== false,
      verifyCommand: opts.verifyCommand ?? config.verifyCommand,
      review: process.env.AUTOCODE_REVIEW === 'auto' ? true : process.env.AUTOCODE_REVIEW === 'off' ? false : config.review !== 'off',
      emitter: opts.emitter ?? new NullEventEmitter(),
      hooks: this.hooks,
      permissions: this.permissions,
      // Auto mode's reviewer tier (config `autoMode.reviewer`, default on;
      // AUTOCODE_AUTO_JUDGE=on|off overrides; never in bench mode, where a
      // scripted or budgeted run must not spend calls on judgements).
      judge: autoJudgeEnabled(config) ? (input) => this.judgeCommand(input) : undefined,
    });
  }

  // The session context of the turn in flight — the judge needs the model.
  private activeCtx: SessionContext | null = null;

  private async judgeCommand(input: { command: string; reason: string; task: string }): Promise<Judgement> {
    const ctx = this.activeCtx;
    if (!ctx) return { decision: 'ask', reason: 'no active session' };
    const { system, user } = judgePrompt({ ...input, projectRoot: ctx.projectRoot });
    try {
      return parseJudgement(await this.quickText(ctx, system, user));
    } catch (e) {
      return { decision: 'ask', reason: `judge failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private readonly permissions: PermissionRules;

  /** Every hook this session has; the CLI fires SessionStart / SessionEnd. */
  readonly hooks: HookHub;
  private readonly prompter: Prompter;
  private readonly projectRoot: string;
  private readonly router: LlmRouter;

  // Connect to configured MCP servers and register their tools.
  // Connect the session's MCP servers: config.json ones as they are; plugin
  // and project (.mcp.json) ones only after the user approved them once for
  // this project — repo content must not spawn processes unasked. MCP tools
  // register as optional: past the deferral threshold they load on demand
  // through `tool_search`.
  async initializeMcp(mcpServers: Record<string, import('../auth/ConfigStore.js').McpServerConfig> | undefined): Promise<void> {
    const trusted = isTrusted(this.projectRoot);
    const entries = collectMcpServers(this.projectRoot, mcpServers).filter((e) => e.source === 'config' || trusted);
    if (entries.length === 0) return;
    const state = new ProjectState(this.projectRoot);
    const approved: Record<string, import('../auth/ConfigStore.js').McpServerConfig> = {};
    for (const entry of entries) {
      if (entry.source === 'config' || state.isMcpServerApproved(entry.name)) {
        approved[entry.name] = entry.config;
        continue;
      }
      let ok = false;
      try {
        ok = await this.prompter.confirm(`Start MCP server ${describeServer(entry)}? (asked once per project)`);
      } catch {
        ok = false;
      }
      if (ok) {
        state.approveMcpServer(entry.name);
        approved[entry.name] = entry.config;
      } else {
        this.renderer.dim(`mcp: ${entry.name} (${entry.source}) not started — approve it interactively to enable`);
      }
    }
    if (Object.keys(approved).length === 0) return;
    await this.mcp.connectAll(approved);
    for (const discovered of this.mcp.discoveredTools()) {
      this.registry.registerOptional(new McpTool(this.mcp, discovered));
    }
    const status = this.mcp.status();
    const connected = status.filter((s) => s.connected);
    const failed = status.filter((s) => !s.connected);
    if (connected.length > 0) {
      const tot = connected.reduce((n, s) => n + s.toolCount, 0);
      const res = connected.reduce((n, s) => n + s.resourceCount, 0);
      const deferred = this.registry.deferredNames().length;
      this.renderer.dim(
        `mcp: ${connected.length} server${connected.length === 1 ? '' : 's'} connected (${tot} tools${res > 0 ? `, ${res} resources` : ''}${deferred > 0 ? `; ${deferred} load on demand via tool_search` : ''})`,
      );
    }
    for (const f of failed) {
      this.renderer.warn(`mcp: ${f.name} failed — ${f.error}`);
    }
  }

  mcpResources(): ReturnType<McpClientManager['discoveredResources']> {
    return this.mcp.discoveredResources();
  }

  lastAssistantText(): string {
    return this.loop.lastAssistantText();
  }

  /** A one-shot text completion on the provider's cheap tier (commit messages, summaries). */
  async quickText(ctx: SessionContext, system: string, user: string): Promise<string> {
    const resp = await this.router.complete(ctx.model.provider as ProviderName, {
      model: summarizerModelFor(ctx.model.provider, ctx.model.model),
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
    });
    return resp.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  async shutdown(): Promise<void> {
    await this.mcp.closeAll();
    await shutdownLsp(this.projectRoot);
  }

  // Forward to AgentLoop — used by the Ink Bridge UI to install its own
  // event emitter (wrapping the original).
  setEmitter(emitter: EventEmitter): void {
    this.loop.setEmitter(emitter);
  }

  async submit(
    input: string | import('../llm/types.js').ContentBlock[],
    ctx: SessionContext,
  ): Promise<void> {
    this.activeCtx = ctx;
    try {
      await this.loop.submit(input, ctx);
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

  currentContextTokens(): number {
    return this.loop.currentContextTokens();
  }

  mcpStatus(): ReturnType<McpClientManager['status']> {
    return this.mcp.status();
  }

  mcpTools(): string[] {
    return this.mcp.discoveredTools().map((d) => `mcp__${d.serverName}__${d.toolName}`);
  }

  refreshConfig(): void {
    this.registry.syncOptionalTools();
  }

  undo(grain: 'step' | 'turn' = 'step'): { turn: number; restored: number; step?: number } | null {
    if (!this.checkpoints) return null;
    return grain === 'turn' ? this.checkpoints.undoLastTurn() : this.checkpoints.undoLastStep();
  }

  trashList(): ReturnType<CheckpointStore['listTrash']> {
    return this.checkpoints?.listTrash() ?? [];
  }

  restore(id: string): ReturnType<CheckpointStore['restoreFromTrash']> {
    return this.checkpoints?.restoreFromTrash(id) ?? null;
  }

  hasReflectableActivity(): boolean {
    return this.loop.hasReflectableActivity();
  }

  reflectOnSession(ctx: SessionContext): ReturnType<AgentLoop['reflectOnSession']> {
    return this.loop.reflectOnSession(ctx);
  }
}
