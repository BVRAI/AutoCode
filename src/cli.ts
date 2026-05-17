#!/usr/bin/env node
import { Command } from 'commander';

import { ConsoleRenderer } from './repl/ConsoleRenderer.js';
import { TerminalMode } from './repl/TerminalMode.js';
import { StubAgent } from './agent/StubAgent.js';
import { LiveAgent } from './agent/LiveAgent.js';
import { newSessionId, type SessionContext } from './session/SessionContext.js';
import { TranscriptStore } from './session/TranscriptStore.js';
import { AuthResolver } from './auth/AuthResolver.js';
import { dataDir, projectRootDefault, sessionsDir } from './util/paths.js';
import { loadDotEnv } from './util/dotenv.js';
import { join } from 'node:path';

// Load .env from cwd before commander reads env-var defaults below.
const dotenvResult = loadDotEnv();

const program = new Command();
program
  .name('autocode')
  .description('Terminal-resident agentic coding CLI')
  .version('0.1.0-dev');

program
  .option('-p, --project-root <path>', 'project root (defaults to cwd)')
  .option('--provider <name>', 'LLM provider (anthropic|xai|openai|openrouter)', process.env.AUTOMAX_PROVIDER ?? 'anthropic')
  .option('--model <name>', 'model id (defaults per provider)', process.env.AUTOMAX_MODEL)
  .action(async (opts: { projectRoot?: string; provider: string; model?: string }) => {
    const sessionId = newSessionId();
    const root = opts.projectRoot ? opts.projectRoot : projectRootDefault();
    const model = opts.model ?? defaultModelFor(opts.provider);

    const ctx: SessionContext = {
      sessionId,
      projectRoot: root,
      dataDir: dataDir(),
      sessionDir: join(sessionsDir(), sessionId),
      model: { provider: opts.provider, model },
      startedAt: new Date().toISOString(),
    };

    const renderer = new ConsoleRenderer();
    const store = new TranscriptStore(ctx);
    store.appendTranscript({ role: 'system', text: `session started for ${root}` });
    if (dotenvResult.loaded > 0) {
      renderer.dim(`(loaded ${dotenvResult.loaded} var${dotenvResult.loaded === 1 ? '' : 's'} from .env)`);
    }

    const auth = new AuthResolver().resolve(ctx.model.provider);
    const agent =
      auth.kind === 'missing'
        ? (renderer.warn(
            `no credentials for ${ctx.model.provider} — set ${envKeyFor(ctx.model.provider)} or AUTOMAX_PROXY_TOKEN. Running in stub mode.`,
          ),
          new StubAgent(renderer, store))
        : new LiveAgent(renderer, store);

    const repl = new TerminalMode(ctx, renderer, agent);
    const code = await repl.run();
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
