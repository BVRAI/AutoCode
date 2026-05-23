#!/usr/bin/env node
import { Command } from 'commander';

import { ConsoleRenderer } from './repl/ConsoleRenderer.js';
import { TerminalMode } from './repl/TerminalMode.js';
import { runHeadless } from './repl/HeadlessMode.js';
import { PrompterRef, AutoDenyPrompter, PlainPrompter } from './repl/Prompter.js';
import { printBannerGallery } from './repl/Banner.js';
import { checkForUpdate, readOwnPackage, runUpdate, shouldAutoUpdate } from './update/UpdateChecker.js';
import { isBundled } from './util/host.js';
import pc from 'picocolors';
import { StubAgent } from './agent/StubAgent.js';
import { LiveAgent } from './agent/LiveAgent.js';
import { newSessionId, type SessionContext } from './session/SessionContext.js';
import { TranscriptStore, type SessionState } from './session/TranscriptStore.js';
import { CheckpointStore } from './session/CheckpointStore.js';
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
  .option('--banners', 'preview the startup banner options and exit', false)
  .option('--update', 'install the latest autocode from npm and exit', false)
  .action(
    async (opts: {
      projectRoot?: string;
      provider: string;
      model?: string;
      planMode?: boolean;
      print?: string;
      resume?: string;
      continue?: boolean;
      banners?: boolean;
      update?: boolean;
    }) => {
    if (opts.banners) {
      printBannerGallery();
      process.exit(0);
    }
    if (opts.update) {
      if (isBundled()) {
        process.stderr.write(
          'autocode is bundled with Automax — V6 manages updates via Velopack.\n',
        );
        process.exit(2);
      }
      const code = await runUpdate({
        info: (t) => process.stdout.write(t + '\n'),
        warn: (t) => process.stderr.write(t + '\n'),
        error: (t) => process.stderr.write(t + '\n'),
      });
      process.exit(code);
    }
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
    // One interactive-input authority. Headless auto-denies; the interactive
    // path swaps in the pinned-bar prompter once TerminalMode starts.
    const prompter = new PrompterRef(headless ? new AutoDenyPrompter() : new PlainPrompter());

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
    // Update pipeline: auto-update is opt-out — autocode is young and
    // iterating fast, so leaving users on a stale buggy version hurts more
    // than the rare surprise of a new release. Auto-update is disabled when
    // bundled in V6 (Velopack owns it), in headless `-p` mode, on a
    // prerelease version, or when the user opts out via config or env var.
    // If an auto-install fails, we fall back silently to the notify banner
    // and keep launching — a failed update must never break startup.
    if (!headless && !isBundled()) {
      const updateInfo = checkForUpdate();
      if (updateInfo) {
        const cfg = new ConfigStore().load();
        const canAutoUpdate = shouldAutoUpdate({
          bundled: false, // already gated above
          headless: false,
          currentVersion: readOwnPackage().version,
          optedOutByConfig: cfg.autoUpdate === false,
          optedOutByEnv: process.env.AUTOCODE_NO_UPDATE === '1',
        });
        if (canAutoUpdate) {
          process.stdout.write(
            pc.cyan(
              `auto-updating autocode ${readOwnPackage().version} → ${updateInfo.latest}…\n`,
            ),
          );
          const code = await runUpdate({
            info: (t) => process.stdout.write(t + '\n'),
            warn: (t) => process.stderr.write(t + '\n'),
            error: (t) => process.stderr.write(t + '\n'),
          });
          if (code === 0) {
            process.stdout.write(
              pc.green(
                `✓ updated to ${updateInfo.latest} — restart autocode to use the new version.\n`,
              ),
            );
            process.stdout.write(
              pc.dim('(to disable auto-updates: set autoUpdate:false in ~/.autocode/config.json or AUTOCODE_NO_UPDATE=1)\n'),
            );
            process.exit(0);
          }
          process.stderr.write(
            pc.yellow('(auto-update failed — continuing on the current version)\n'),
          );
        }
        renderer.setUpdateBanner(updateInfo.banner);
      }
    }
    const store = new TranscriptStore(ctx);
    const checkpoints = new CheckpointStore(ctx.sessionDir);
    checkpoints.sweep();
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
        : new LiveAgent(renderer, store, { checkpoints, prompter });

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
      : await new TerminalMode(ctx, renderer, agent, prompter).run();
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
