// `/auth` slash-command handler — BYOK key configuration.
//
// Two invocation shapes (mirrors `/login` Plan 8 Phase A):
//   1. `/auth`                    → prints provider list + example syntax.
//   2. `/auth <provider> <key>`   → validates provider name against the
//                                    BYOK_PROVIDERS catalog, persists the
//                                    key to ConfigStore (Phase 3 will route
//                                    via SecretStore → OS keyring).
//
// Args-based: same reason as `/login` — the Bridge TUI's interim
// AutoAcceptPrompter swallows `prompter.ask()` (returns '' immediately
// without waiting for input). Passing values as command args is the
// only path that reliably works in every shell.

import pc from 'picocolors';
import { BYOK_PROVIDERS } from '../auth/firstRun.js';
import { setSecret, type AccountName } from '../auth/SecretStore.js';
import type { ConsoleRenderer } from './ConsoleRenderer.js';

type ProviderId = (typeof BYOK_PROVIDERS)[number]['id'];

const VALID_IDS = new Set<ProviderId>(BYOK_PROVIDERS.map((p) => p.id));

export async function runAuth(renderer: ConsoleRenderer, args: string[]): Promise<void> {
  // No-arg → instructions.
  if (args.length === 0) {
    printAuthInstructions(renderer);
    return;
  }
  if (args.length === 1) {
    renderer.error(`Missing key. Usage: ${pc.cyan('/auth <provider> <key>')}`);
    renderer.dim('Run /auth (no args) to see the provider list.');
    return;
  }

  const provider = args[0]!.toLowerCase();
  const key = args.slice(1).join(' ').trim();

  if (!VALID_IDS.has(provider as ProviderId)) {
    const validList = BYOK_PROVIDERS.map((p) => p.id).join(', ');
    renderer.error(`Unknown provider: ${pc.bold(args[0]!)}. Valid: ${validList}`);
    return;
  }
  if (key.length < 8) {
    renderer.error('Key seems too short — pass the full value as the argument.');
    return;
  }

  await setSecret(`byok-${provider}` as AccountName, key);

  const meta = BYOK_PROVIDERS.find((p) => p.id === provider);
  const label = meta?.label ?? provider;
  renderer.info(`${pc.green('✓')} Saved ${label} key.`);
  renderer.dim(`(stored in OS keyring when available; ${meta?.envKey ?? 'env var'} still overrides if set)`);
  renderer.dim('Restart autocode (/exit then acv1) to use it.');
}

function printAuthInstructions(renderer: ConsoleRenderer): void {
  renderer.info('Configure a per-provider API key (BYOK).');
  renderer.info('');
  renderer.info(`Usage: ${pc.cyan('/auth <provider> <key>')}`);
  renderer.info('');
  renderer.info('Providers:');
  for (const p of BYOK_PROVIDERS) {
    const hint = p.hint ? ` · ${pc.dim(p.hint)}` : '';
    renderer.info(`  ${pc.bold(p.id.padEnd(12))} ${p.signupUrl}${hint}`);
  }
  renderer.info('');
  renderer.dim('Example:  /auth anthropic sk-ant-…');
  renderer.dim('Or set the env var instead (e.g. ANTHROPIC_API_KEY) — env vars override the saved key.');
  renderer.dim('For the BVRAI proxy, use /login instead (browser flow).');
}
