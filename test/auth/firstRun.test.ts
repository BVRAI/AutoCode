import { describe, it, expect } from 'vitest';
import {
  hasAnyCredentials,
  shouldRunFirstRunWizard,
  BYOK_PROVIDERS,
  BVRAI_SIGNUP_URL,
} from '../../src/auth/firstRun.js';
import type { AutocodeConfig } from '../../src/auth/ConfigStore.js';

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe('hasAnyCredentials', () => {
  it('returns false for an empty config and empty env', () => {
    expect(hasAnyCredentials({}, EMPTY_ENV)).toBe(false);
  });

  it('returns true when AUTOMAX_PROXY_TOKEN is set (V6-embedded case)', () => {
    expect(hasAnyCredentials({}, { AUTOMAX_PROXY_TOKEN: 'firebase-token' })).toBe(true);
  });

  it('returns true for each individual provider env var', () => {
    expect(hasAnyCredentials({}, { ANTHROPIC_API_KEY: 'x' })).toBe(true);
    expect(hasAnyCredentials({}, { OPENAI_API_KEY: 'x' })).toBe(true);
    expect(hasAnyCredentials({}, { XAI_API_KEY: 'x' })).toBe(true);
    expect(hasAnyCredentials({}, { OPENROUTER_API_KEY: 'x' })).toBe(true);
    expect(hasAnyCredentials({}, { GOOGLE_API_KEY: 'x' })).toBe(true);
  });

  it('returns true when config has a stored key for any provider', () => {
    const cfg: AutocodeConfig = { apiKeys: { anthropic: 'sk-ant-xxx' } };
    expect(hasAnyCredentials(cfg, EMPTY_ENV)).toBe(true);
  });

  it('ignores empty-string values in env and config', () => {
    expect(hasAnyCredentials({ apiKeys: { anthropic: '' } }, { ANTHROPIC_API_KEY: '' })).toBe(false);
  });

  it('returns false for unrelated env vars', () => {
    expect(hasAnyCredentials({}, { PATH: '/usr/bin', HOME: '/home/x' })).toBe(false);
  });
});

describe('shouldRunFirstRunWizard', () => {
  it('returns true when interactive, no creds, no prior completion', () => {
    expect(shouldRunFirstRunWizard({ config: {}, env: EMPTY_ENV, interactive: true })).toBe(true);
  });

  it('returns false when not interactive (headless / non-TTY)', () => {
    expect(shouldRunFirstRunWizard({ config: {}, env: EMPTY_ENV, interactive: false })).toBe(false);
  });

  it('returns false when firstRunCompletedAt is set, regardless of creds', () => {
    const cfg: AutocodeConfig = { firstRunCompletedAt: '2026-05-25T00:00:00Z' };
    expect(shouldRunFirstRunWizard({ config: cfg, env: EMPTY_ENV, interactive: true })).toBe(false);
  });

  it('returns false when any credential is present', () => {
    expect(
      shouldRunFirstRunWizard({ config: {}, env: { ANTHROPIC_API_KEY: 'x' }, interactive: true }),
    ).toBe(false);
    expect(
      shouldRunFirstRunWizard({
        config: { apiKeys: { openai: 'sk-xxx' } },
        env: EMPTY_ENV,
        interactive: true,
      }),
    ).toBe(false);
  });

  it('returns false in the V6-embedded path (AUTOMAX_PROXY_TOKEN present)', () => {
    expect(
      shouldRunFirstRunWizard({
        config: {},
        env: { AUTOMAX_PROXY_TOKEN: 'tok' },
        interactive: true,
      }),
    ).toBe(false);
  });

  it('a Skip outcome that just stamped firstRunCompletedAt suppresses the wizard next launch', () => {
    // Simulate the post-Skip state: no creds, but firstRunCompletedAt set.
    const cfg: AutocodeConfig = { firstRunCompletedAt: '2026-05-26T00:00:00Z' };
    expect(shouldRunFirstRunWizard({ config: cfg, env: EMPTY_ENV, interactive: true })).toBe(false);
  });
});

describe('BYOK_PROVIDERS catalog', () => {
  it('lists all five expected providers in order', () => {
    expect(BYOK_PROVIDERS.map((p) => p.id)).toEqual([
      'anthropic',
      'openai',
      'xai',
      'openrouter',
      'google',
    ]);
  });

  it('every option has a non-empty label, envKey, and signupUrl', () => {
    for (const p of BYOK_PROVIDERS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.envKey.length).toBeGreaterThan(0);
      expect(p.signupUrl.startsWith('https://')).toBe(true);
    }
  });

  it('free-tier providers surface a hint mentioning "free"', () => {
    const openrouter = BYOK_PROVIDERS.find((p) => p.id === 'openrouter')!;
    const google = BYOK_PROVIDERS.find((p) => p.id === 'google')!;
    expect(openrouter.hint?.toLowerCase()).toContain('free');
    expect(google.hint?.toLowerCase()).toContain('free');
  });
});

describe('BVRAI_SIGNUP_URL', () => {
  it('is an https URL', () => {
    expect(BVRAI_SIGNUP_URL.startsWith('https://')).toBe(true);
  });
});
