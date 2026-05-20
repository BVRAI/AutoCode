#!/usr/bin/env node
import { Command } from 'commander';

import { ConsoleRenderer } from './repl/ConsoleRenderer.js';
import { TerminalMode } from './repl/TerminalMode.js';
import { runHeadless } from './repl/HeadlessMode.js';
import { StubAgent } from './agent/StubAgent.js';
import { LiveAgent } from './agent/LiveAgent.js';
import { newSessionId, type SessionContext } from './session/SessionContext.js';
import { TranscriptStore, type SessionState } from './session/TranscriptStore.js';
import { findLatestSession, loadSessionMeta } from './session/SessionResume.js';
import { AuthResolver } from './auth/AuthResolver.js';
import { ConfigStore } from './auth/ConfigStore.js';
import { dataDir, projectRootDefault, sessionsDir } from './util/paths.js';
import { loadDotEnv } from './util/dotenv.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Load .env from cwd before commander reads env-var defaults below.
const dotenvResult = loadDotEnv();

const program = new Command();
program
  .name('autocode')
  .description('Terminal-resident agentic coding CLI')
  .version('0.1.0-dev');

program
  .option('--project-root <path>', 'project root (defaults to cwd)')
  .option('--provider <name>', 'LLM provider (anthropic|xai|openai|openrouter)', process.env.AUTOMAX_PROVIDER ?? 'xai')
  .option('--model <name>', 'model id (defaults per provider)', process.env.AUTOMAX_MODEL)
  .option('--plan-mode', 'start in planning mode (read-only — agent plans, makes no changes)', false)
  .option('-p, --print <prompt>', 'run a single task non-interactively and exit')
  .option('--resume <sessionId>', 'resume a specific prior session')
  .option('-c, --continue', 'resume the most recent prior session', false)
  .action(
    async (opts: {
      projectRoot?: string;
      provider: string;
      model?: string;
      planMode?: boolean;
      print?: string;
      resume?: string;
      continue?: boolean;
    }) => {
    // Resolve a resume target before building the session context. A session
    // is resumable only if it has both state.json and conversation.json.
    let resumedMeta: SessionState | null = null;
    let resumeRequested = '';
    if (typeof opts.resume === 'string' || opts.continue === true) {
      resumeRequested = typeof opts.resume === 'string' ? opts.resume : '(most recent)';
      const targetId =
        typeof opts.resume === 'string' ? opts.resume : findLatestSession(sessionsDir());
      if (targetId) {
        const dir = join(sessionsDir(), targetId);
        const meta = loadSessionMeta(dir);
        if (meta && existsSync(join(dir, 'conversation.json'))) {
          resumedMeta = meta;
        }
      }
    }

    const sessionId = resumedMeta ? resumedMeta.sessionId : newSessionId();
    const root = opts.projectRoot
      ? opts.projectRoot
      : (resumedMeta?.projectRoot ?? projectRootDefault());
    // On resume, provider + model come from the saved session (/model can
    // still switch mid-session). Otherwise, from flags.
    const provider = resumedMeta ? resumedMeta.provider : opts.provider;
    const model = resumedMeta
      ? resumedMeta.model
      : (opts.model ?? defaultModelFor(opts.provider));

    // Headless runs auto-accept (no interactive approval is possible);
    // --plan-mode starts in planning; otherwise default (review each change).
    const headless = typeof opts.print === 'string';
    const initialMode = headless ? 'autocode' : opts.planMode ? 'planning' : 'default';

    const ctx: SessionContext = {
      sessionId,
      projectRoot: root,
      dataDir: dataDir(),
      sessionDir: join(sessionsDir(), sessionId),
      model: { provider, model },
      startedAt: new Date().toISOString(),
      mode: initialMode,
    };

    const renderer = new ConsoleRenderer();
    const store = new TranscriptStore(ctx);
    store.appendTranscript({ role: 'system', text: `session started for ${root}` });
    if (dotenvResult.loaded > 0) {
      renderer.dim(`(loaded ${dotenvResult.loaded} var${dotenvResult.loaded === 1 ? '' : 's'} from .env)`);
    }
    if (resumeRequested && !resumedMeta) {
      renderer.warn(`(no resumable session for ${resumeRequested} — starting fresh)`);
    }

    if (headless) {
      renderer.dim(`session ${ctx.sessionId} · ${ctx.sessionDir}`);
    }
    const auth = new AuthResolver().resolve(ctx.model.provider);
    const agent =
      auth.kind === 'missing'
        ? (renderer.warn(
            `no credentials for ${ctx.model.provider} — set ${envKeyFor(ctx.model.provider)} or AUTOMAX_PROXY_TOKEN. Running in stub mode.`,
          ),
          new StubAgent(renderer, store))
        : new LiveAgent(renderer, store, { headless });

    // Initialize MCP servers if any are configured. Fail soft.
    if (agent instanceof LiveAgent) {
      try {
        const config = new ConfigStore().load();
        await agent.initializeMcp(config.mcpServers);
      } catch (e) {
        renderer.warn(`mcp init failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Restore the prior conversation + token counters before the first turn.
    if (resumedMeta && agent instanceof LiveAgent) {
      const loaded = store.loadConversation();
      if (loaded) {
        agent.loadState(loaded);
        renderer.dim(`(resumed session ${ctx.sessionId} — ${loaded.messages.length} messages)`);
      } else {
        renderer.warn(`(could not load conversation for ${ctx.sessionId} — starting fresh)`);
      }
    }

    const code = headless
      ? await runHeadless(agent, renderer, ctx, opts.print as string)
      : await new TerminalMode(ctx, renderer, agent).run();
    if (agent instanceof LiveAgent) {
      try {
        await agent.shutdown();
      } catch {
        /* ignore */
      }
    }
    store.appendTranscript({ role: 'system', text: 'session ended' });
    process.exit(code);
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

function defaultModelFor(provider: string): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-opus-4-7';
    case 'xai':
      return 'grok-code-fast-1';
    case 'openai':
      return 'gpt-5.1';
    case 'google':
      return 'gemini-2.5-pro';
    case 'openrouter':
      return 'anthropic/claude-opus-4-7';
    default:
      return 'claude-opus-4-7';
  }
}

function envKeyFor(provider: string): string {
  switch (provider) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'xai':
      return 'XAI_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'google':
      return 'GOOGLE_API_KEY';
    default:
      return 'API_KEY';
  }
}
