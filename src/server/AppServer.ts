// `autocode --server`: the app-server (Phase 5.1). A host (Automax's
// HarnessClient, a web or mobile shell later) speaks JSON-RPC over stdio:
// methods drive the session, notifications stream what the terminal UI
// would have shown. Everything below the protocol is the same LiveAgent the
// terminal uses, so the two front ends cannot drift.

import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConsoleRenderer } from '../repl/ConsoleRenderer.js';
import { PrompterRef } from '../repl/Prompter.js';
import { LiveAgent } from '../agent/LiveAgent.js';
import { newSessionId, type AgentMode, type SessionContext } from '../session/SessionContext.js';
import { TranscriptStore } from '../session/TranscriptStore.js';
import { CheckpointStore } from '../session/CheckpointStore.js';
import { loadSessionMeta } from '../session/SessionResume.js';
import { ConfigStore } from '../auth/ConfigStore.js';
import { initialize as initSecretStore } from '../auth/SecretStore.js';
import { dataDir, sessionsDir } from '../util/paths.js';
import { indexEnabled, startIndex, indexStatus } from '../index/IndexManager.js';
import { defaultModelFor, parseEffortSetting, EFFORT_SETTINGS, type EffortSetting } from '../llm/models.js';
import { buildAgentInput } from '../util/attachments.js';
import { MemoryStore } from '../agent/Memory.js';
import { isTrusted, markTrusted, trustPrompt, trustSensitiveContent } from '../agent/Trust.js';
import { readOwnPackage } from '../update/UpdateChecker.js';
import type { ContentBlock } from '../llm/types.js';
import { ServerSink } from './ServerSink.js';
import { ServerPrompter } from './ServerPrompter.js';
import {
  ERR_BUSY,
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  ERR_NO_SESSION,
  ERR_PARSE,
  PROTOCOL_VERSION,
  isRequest,
  parseLine,
  type JsonRpcRequest,
} from './protocol.js';

const MODES: AgentMode[] = ['planning', 'default', 'autocode', 'admin', 'sights'];

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface LiveSession {
  ctx: SessionContext;
  agent: LiveAgent;
  store: TranscriptStore;
  renderer: ConsoleRenderer;
  sink: ServerSink;
  prompter: ServerPrompter;
  busy: boolean;
  turnSeq: number;
}

export class AppServer {
  private session: LiveSession | null = null;
  private stopped = false;
  private readonly out: NodeJS.WritableStream;

  constructor(private readonly io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }) {
    this.out = io.output;
  }

  /** Serve until stdin closes or `shutdown` arrives. Resolves with the exit code. */
  run(): Promise<number> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: this.io.input, crlfDelay: Number.POSITIVE_INFINITY });
      rl.on('line', (line) => {
        void this.handleLine(line);
      });
      rl.on('close', () => {
        void this.dispose().then(() => resolve(0));
      });
      this.notify('server.ready', { protocolVersion: PROTOCOL_VERSION, pid: process.pid });
      const stopCheck = setInterval(() => {
        if (this.stopped) {
          clearInterval(stopCheck);
          rl.close();
        }
      }, 50);
    });
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.out.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* host went away */
    }
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private async handleLine(line: string): Promise<void> {
    let msg;
    try {
      msg = parseLine(line);
    } catch (e) {
      this.write({ jsonrpc: '2.0', id: null, error: { code: ERR_PARSE, message: `parse error: ${e instanceof Error ? e.message : String(e)}` } });
      return;
    }
    if (!msg) return;
    if (!isRequest(msg)) return; // responses/notifications from the host are not expected
    const req = msg;
    try {
      const result = await this.dispatch(req);
      this.write({ jsonrpc: '2.0', id: req.id, result: result ?? {} });
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError(ERR_INTERNAL, e instanceof Error ? e.message : String(e));
      this.write({ jsonrpc: '2.0', id: req.id, error: { code: err.code, message: err.message, data: err.data } });
    }
  }

  private params(req: JsonRpcRequest): Record<string, unknown> {
    return req.params && typeof req.params === 'object' ? req.params : {};
  }

  private need(): LiveSession {
    if (!this.session) throw new RpcError(ERR_NO_SESSION, 'no session — call session.new or session.resume first');
    return this.session;
  }

  private async dispatch(req: JsonRpcRequest): Promise<unknown> {
    const p = this.params(req);
    switch (req.method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          version: readOwnPackage().version,
          capabilities: {
            streaming: true,
            reasoning: true,
            approvals: true,
            resume: true,
            modes: MODES,
            efforts: [...EFFORT_SETTINGS],
            items: ['agent_message', 'reasoning', 'tool_call', 'file_change', 'user_message', 'note'],
            commands: ['clear', 'compact', 'undo', 'effort', 'model', 'refresh', 'memory', 'status'],
          },
        };
      case 'session.new':
        return this.newSession(p);
      case 'session.resume':
        return this.newSession(p, true);
      case 'session.info':
        return this.info();
      case 'session.setMode': {
        const s = this.need();
        const mode = String(p['mode'] ?? '');
        if (!MODES.includes(mode as AgentMode)) throw new RpcError(ERR_INVALID_PARAMS, `mode must be one of ${MODES.join(', ')}`);
        s.ctx.mode = mode as AgentMode;
        return { mode };
      }
      case 'session.command':
        return this.command(String(p['name'] ?? ''), Array.isArray(p['args']) ? (p['args'] as unknown[]).map(String) : []);
      case 'turn.submit':
        return this.submit(p);
      case 'turn.cancel': {
        const s = this.need();
        const was = s.busy;
        s.agent.stop();
        s.prompter.cancelAll();
        if (was) this.notify('turn.cancelled', { turnId: s.sink.currentTurn() });
        return { cancelled: was };
      }
      case 'respond': {
        const s = this.need();
        const id = String(p['requestId'] ?? '');
        const ok = s.prompter.respond(id, p);
        if (!ok) throw new RpcError(ERR_INVALID_PARAMS, `no open request ${id}`);
        return {};
      }
      case 'shutdown':
        await this.dispose();
        this.stopped = true;
        return {};
      default:
        throw new RpcError(ERR_METHOD_NOT_FOUND, `unknown method ${req.method}`);
    }
  }

  private async newSession(p: Record<string, unknown>, resume = false): Promise<unknown> {
    if (this.session) await this.dispose();
    const cfg = new ConfigStore().load();
    let sessionId = newSessionId();
    let root = typeof p['projectRoot'] === 'string' && p['projectRoot'] ? (p['projectRoot'] as string) : process.cwd();
    let provider = typeof p['provider'] === 'string' && p['provider'] ? (p['provider'] as string) : (process.env.AUTOMAX_PROVIDER ?? cfg.defaultProvider ?? 'xai');
    let model = typeof p['model'] === 'string' && p['model'] ? (p['model'] as string) : (process.env.AUTOMAX_MODEL ?? cfg.defaultModel ?? defaultModelFor(provider));
    let resumed: { messages: unknown[] } | null = null;
    if (resume) {
      const id = String(p['sessionId'] ?? '');
      const dir = join(sessionsDir(), id);
      const meta = loadSessionMeta(dir);
      if (!meta || !existsSync(join(dir, 'conversation.json'))) throw new RpcError(ERR_INVALID_PARAMS, `no resumable session ${id}`);
      sessionId = meta.sessionId;
      root = meta.projectRoot;
      provider = meta.provider;
      model = meta.model;
      resumed = { messages: [] };
    }
    const effortRaw = typeof p['effort'] === 'string' ? parseEffortSetting(p['effort'] as string) : null;
    const mode = MODES.includes(p['mode'] as AgentMode) ? (p['mode'] as AgentMode) : 'default';
    const ctx: SessionContext = {
      sessionId,
      projectRoot: root,
      dataDir: dataDir(),
      sessionDir: join(sessionsDir(), sessionId),
      model: { provider, model },
      startedAt: new Date().toISOString(),
      mode,
      locale: typeof p['locale'] === 'string' ? (p['locale'] as string) : process.env.AUTOMAX_LOCALE?.trim() || undefined,
      effort: (effortRaw ?? cfg.effort?.[`${provider}/${model}`] ?? cfg.defaultEffort ?? undefined) as EffortSetting | undefined,
      sandbox: cfg.sandbox,
    };
    const renderer = new ConsoleRenderer();
    const sink = new ServerSink((method, params) => this.notify(method, params));
    renderer.setSink(sink);
    await initSecretStore(renderer);
    const store = new TranscriptStore(ctx);
    const checkpoints = new CheckpointStore(ctx.sessionDir);
    checkpoints.sweep();
    const prompter = new ServerPrompter((method, params) => this.notify(method, params));
    // Trust gate: repo-supplied automation waits for a one-time yes from the host's user.
    if (!isTrusted(root)) {
      const found = trustSensitiveContent(root);
      if (found.length > 0 && (await prompter.confirm(trustPrompt(root, found)))) markTrusted(root);
    }
    const agent = new LiveAgent(renderer, store, { checkpoints, prompter: new PrompterRef(prompter), emitter: sink, mode });
    if (resumed) {
      const loaded = store.loadConversation();
      if (loaded) agent.loadState(loaded);
    }
    store.appendTranscript({ role: 'system', text: `session started for ${root} (server)` });
    this.session = { ctx, agent, store, renderer, sink, prompter, busy: false, turnSeq: 0 };
    if (indexEnabled()) startIndex(root).catch(() => undefined);
    try {
      await agent.initializeMcp(cfg.mcpServers);
    } catch (e) {
      this.notify('log', { level: 'warn', text: `mcp init failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    await agent.hooks.fire('SessionStart', { trigger: 'auto' });
    const result = { sessionId, projectRoot: root, model: ctx.model, mode: ctx.mode, effort: ctx.effort ?? 'auto', resumed: resume };
    this.notify('session.ready', result);
    return result;
  }

  private info(): unknown {
    const s = this.need();
    return {
      sessionId: s.ctx.sessionId,
      projectRoot: s.ctx.projectRoot,
      model: s.ctx.model,
      mode: s.ctx.mode,
      effort: s.ctx.effort ?? 'auto',
      busy: s.busy,
      usage: s.agent.cumulativeUsage(),
      contextTokens: s.agent.currentContextTokens?.() ?? 0,
      index: indexStatus(s.ctx.projectRoot),
      openRequests: s.prompter.openCount(),
    };
  }

  private async submit(p: Record<string, unknown>): Promise<unknown> {
    const s = this.need();
    if (s.busy) throw new RpcError(ERR_BUSY, 'a turn is already running — turn.cancel first');
    const text = typeof p['text'] === 'string' ? (p['text'] as string) : '';
    if (!text.trim()) throw new RpcError(ERR_INVALID_PARAMS, 'text is required');
    const { input, missing, notes } = buildAgentInput(text, s.ctx.projectRoot, { provider: s.ctx.model.provider });
    for (const ref of missing) this.notify('log', { level: 'warn', text: `could not read @${ref}` });
    for (const note of notes) this.notify('log', { level: 'info', text: note });
    const images = Array.isArray(p['images']) ? (p['images'] as Array<Record<string, unknown>>) : [];
    const blocks: ContentBlock[] = [];
    for (const img of images) {
      if (typeof img['data'] === 'string' && typeof img['mediaType'] === 'string') {
        blocks.push({ type: 'image', mediaType: img['mediaType'] as ContentBlock extends { mediaType: infer M } ? M : never, data: img['data'] as string } as ContentBlock);
      }
    }
    const withImages: string | ContentBlock[] =
      blocks.length === 0 ? input : typeof input === 'string' ? [{ type: 'text', text: input }, ...blocks] : [...input, ...blocks];
    s.turnSeq += 1;
    const turnId = s.sink.beginTurn(`turn_${s.turnSeq}`);
    s.busy = true;
    // The loop's 'completed' event fires before its verification and review
    // tail and before `submit` settles; the sink holds the terminal
    // notification back until the promise settles so a host that reads
    // `busy` (or submits the next turn) right after turn.completed is safe.
    s.sink.holdTerminal();
    void s.agent
      .submit(withImages, s.ctx)
      .then(
        () => {
          s.busy = false;
          s.prompter.cancelAll();
          s.sink.releaseTerminal();
        },
        (e: unknown) => {
          s.busy = false;
          s.prompter.cancelAll();
          s.sink.releaseTerminal({ turnId, error: e instanceof Error ? e.message : String(e) });
        },
      );
    return { turnId };
  }

  private async command(name: string, args: string[]): Promise<unknown> {
    const s = this.need();
    switch (name) {
      case 'clear':
        return { output: `cleared ${s.agent.clearConversation()} messages` };
      case 'compact': {
        const r = await s.agent.loop.compactConversation(s.ctx);
        return { output: `compacted ${r.before} → ${r.after} messages${r.summarized ? ' (summarized)' : ''}`, ...r };
      }
      case 'undo': {
        const r = s.agent.undo?.(args[0] === 'turn' ? 'turn' : 'step') ?? null;
        return { output: r ? `restored ${r.restored} file(s)` : 'nothing to undo', ...(r ?? {}) };
      }
      case 'effort': {
        const parsed = args[0] ? parseEffortSetting(args[0]) : null;
        if (args[0] && !parsed) throw new RpcError(ERR_INVALID_PARAMS, `effort must be one of ${EFFORT_SETTINGS.join(', ')}`);
        if (parsed) s.ctx.effort = parsed;
        return { output: `effort ${s.ctx.effort ?? 'auto'}`, effort: s.ctx.effort ?? 'auto' };
      }
      case 'model': {
        if (args.length >= 2) s.ctx.model = { provider: args[0]!, model: args[1]! };
        else if (args.length === 1) s.ctx.model = { ...s.ctx.model, model: args[0]! };
        return { output: `${s.ctx.model.provider}/${s.ctx.model.model}`, model: s.ctx.model };
      }
      case 'refresh': {
        const { resetIndex } = await import('../index/IndexManager.js');
        resetIndex(s.ctx.projectRoot);
        if (indexEnabled()) startIndex(s.ctx.projectRoot).catch(() => undefined);
        return { output: 'index rebuild started' };
      }
      case 'memory': {
        const entries = new MemoryStore(s.ctx.projectRoot).list();
        return { output: `${entries.length} memories`, memories: entries.map((m) => ({ name: m.name, kind: m.kind, description: m.description })) };
      }
      case 'status':
        return { output: 'ok', ...(this.info() as Record<string, unknown>) };
      default:
        throw new RpcError(ERR_INVALID_PARAMS, `unknown command ${name}`);
    }
  }

  private async dispose(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = null;
    try {
      s.agent.stop();
      s.prompter.cancelAll();
      await s.agent.hooks.fire('SessionEnd', { reason: 'shutdown' });
      await s.agent.shutdown();
      s.store.appendTranscript({ role: 'system', text: 'session ended' });
    } catch {
      /* best effort */
    }
  }
}

/** Entry point for `autocode --server`. */
export async function runServer(): Promise<number> {
  const server = new AppServer({ input: process.stdin, output: process.stdout });
  return server.run();
}
