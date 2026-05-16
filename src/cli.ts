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
import { join } from 'node:path';

const program = new Command();
program
  .name('autocode')
  .description('Terminal-resident agentic coding CLI')
  .version('0.1.0-dev');

program
  .option('-p, --project-root <path>', 'project root (defaults to cwd)')
  .option('--provider <name>', 'LLM provider', process.env.AUTOMAX_PROVIDER ?? 'anthropic')
  .option('--model <name>', 'model id', process.env.AUTOMAX_MODEL ?? 'claude-opus-4-7')
  .action(async (opts: { projectRoot?: string; provider: string; model: string }) => {
    const sessionId = newSessionId();
    const root = opts.projectRoot ? opts.projectRoot : projectRootDefault();

    const ctx: SessionContext = {
      sessionId,
      projectRoot: root,
      dataDir: dataDir(),
      sessionDir: join(sessionsDir(), sessionId),
      model: { provider: opts.provider, model: opts.model },
      startedAt: new Date().toISOString(),
    };

    const renderer = new ConsoleRenderer();
    const store = new TranscriptStore(ctx);
    store.appendTranscript({ role: 'system', text: `session started for ${root}` });

    const auth = new AuthResolver().resolve(ctx.model.provider);
    const agent =
      auth.kind === 'missing'
        ? (renderer.warn(
            `no credentials for ${ctx.model.provider} — set ANTHROPIC_API_KEY or AUTOMAX_PROXY_TOKEN. Running in stub mode.`,
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
