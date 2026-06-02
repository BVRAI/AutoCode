import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stateful in-memory keytar mock — same shape as SecretStore.test.ts so
// AuthResolver tests can exercise the real SecretStore + AuthResolver
// pipeline without touching the OS keyring.
const keytarState: Map<string, string> = new Map();
let keytarShouldFail = false;

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(async (service: string, account: string) => {
      if (keytarShouldFail) throw new Error('keyring unavailable');
      return keytarState.get(`${service}::${account}`) ?? null;
    }),
    setPassword: vi.fn(async (service: string, account: string, password: string) => {
      if (keytarShouldFail) throw new Error('keyring unavailable');
      keytarState.set(`${service}::${account}`, password);
    }),
    deletePassword: vi.fn(async (service: string, account: string) => {
      if (keytarShouldFail) throw new Error('keyring unavailable');
      return keytarState.delete(`${service}::${account}`);
    }),
  },
}));

import { AuthResolver, isProxyAuth, proxyRootUrl, type AuthMode } from '../../src/auth/AuthResolver.js';
import { initialize, setSecret, _resetForTests } from '../../src/auth/SecretStore.js';

describe('AuthResolver', () => {
  const envBefore = { ...process.env };
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'autocode-authresolver-test-'));
    process.env.AUTOCODE_CONFIG_DIR = tmp;
    delete process.env.AUTOMAX_PROXY_TOKEN;
    delete process.env.AUTOMAX_PROXY_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    keytarState.clear();
    keytarShouldFail = false;
    _resetForTests();
    await initialize();
  });
  afterEach(() => {
    process.env = { ...envBefore };
    rmSync(tmp, { recursive: true, force: true });
    keytarState.clear();
    _resetForTests();
  });

  it('returns automax mode with default URL when AUTOMAX_PROXY_TOKEN is set', () => {
    process.env.AUTOMAX_PROXY_TOKEN = 'firebase-token';
    const r = new AuthResolver().resolve('xai');
    expect(r).toEqual({
      kind: 'automax',
      token: 'firebase-token',
      baseOverride: 'https://automax-proxy.fly.dev/v1/xai',
    });
  });

  it('honors AUTOMAX_PROXY_URL override', () => {
    process.env.AUTOMAX_PROXY_TOKEN = 'firebase-token';
    process.env.AUTOMAX_PROXY_URL = 'https://my-proxy.example.com';
    const r = new AuthResolver().resolve('anthropic');
    expect(r).toMatchObject({
      kind: 'automax',
      baseOverride: 'https://my-proxy.example.com/v1/anthropic',
    });
  });

  it('strips trailing slash from AUTOMAX_PROXY_URL', () => {
    process.env.AUTOMAX_PROXY_TOKEN = 'firebase-token';
    process.env.AUTOMAX_PROXY_URL = 'https://my-proxy.example.com/';
    const r = new AuthResolver().resolve('xai');
    expect(r).toMatchObject({
      baseOverride: 'https://my-proxy.example.com/v1/xai',
    });
  });

  it('returns byok mode when env API key is set', () => {
    process.env.XAI_API_KEY = 'xai-key';
    const r = new AuthResolver().resolve('xai');
    expect(r).toEqual({ kind: 'byok', apiKey: 'xai-key' });
  });

  it('returns byok mode when SecretStore has a stored key', async () => {
    await setSecret('byok-xai', 'stored-xai-key');
    const r = new AuthResolver().resolve('xai');
    expect(r).toEqual({ kind: 'byok', apiKey: 'stored-xai-key' });
  });

  it('env-var BYOK wins over SecretStore-stored BYOK', async () => {
    process.env.XAI_API_KEY = 'env-xai-key';
    await setSecret('byok-xai', 'stored-xai-key');
    const r = new AuthResolver().resolve('xai');
    expect(r).toMatchObject({ kind: 'byok', apiKey: 'env-xai-key' });
  });

  it('proxy token wins over BYOK when both are set', () => {
    process.env.AUTOMAX_PROXY_TOKEN = 'firebase-token';
    process.env.XAI_API_KEY = 'xai-key';
    const r = new AuthResolver().resolve('xai');
    expect(r.kind).toBe('automax');
  });

  it('returns missing when no credentials present', () => {
    const r = new AuthResolver().resolve('xai');
    expect(r).toEqual({ kind: 'missing', provider: 'xai' });
  });

  // ── amxkey arm (Plan 8 Phase A/B) ────────────────────────────────────

  it('returns amxkey mode when SecretStore has amxKey set', async () => {
    await setSecret('amx', 'sk_amx_xxxxx');
    const r = new AuthResolver().resolve('anthropic');
    expect(r).toEqual({
      kind: 'amxkey',
      token: 'sk_amx_xxxxx',
      baseOverride: 'https://automax-proxy.fly.dev/v1/anthropic',
    });
  });

  it('AUTOMAX_PROXY_TOKEN wins over a stored amxKey (V6-embedded)', async () => {
    process.env.AUTOMAX_PROXY_TOKEN = 'firebase-token';
    await setSecret('amx', 'sk_amx_xxxxx');
    const r = new AuthResolver().resolve('xai');
    expect(r.kind).toBe('automax');
    if (r.kind === 'automax') expect(r.token).toBe('firebase-token');
  });

  it('amxKey wins over BYOK when both are set', async () => {
    await setSecret('amx', 'sk_amx_xxxxx');
    await setSecret('byok-xai', 'stored-xai-key');
    const r = new AuthResolver().resolve('xai');
    expect(r.kind).toBe('amxkey');
  });

  it('full precedence: env > amxKey > BYOK > missing', async () => {
    process.env.AUTOMAX_PROXY_TOKEN = 'firebase-token';
    process.env.XAI_API_KEY = 'env-xai-key';
    await setSecret('amx', 'sk_amx_stored');
    await setSecret('byok-xai', 'stored-xai-key');

    // Env token (automax) wins.
    expect(new AuthResolver().resolve('xai').kind).toBe('automax');

    // Remove env token → amxKey wins.
    delete process.env.AUTOMAX_PROXY_TOKEN;
    expect(new AuthResolver().resolve('xai').kind).toBe('amxkey');

    // Remove amxKey too → env BYOK wins.
    keytarState.delete('bvrai-autocode::amx');
    _resetForTests();
    await initialize();
    expect(new AuthResolver().resolve('xai').kind).toBe('byok');
    if (new AuthResolver().resolve('xai').kind === 'byok') {
      // Env beats stored BYOK.
      const r = new AuthResolver().resolve('xai') as Extract<AuthMode, { kind: 'byok' }>;
      expect(r.apiKey).toBe('env-xai-key');
    }

    // Remove env BYOK too → stored BYOK wins.
    delete process.env.XAI_API_KEY;
    const r2 = new AuthResolver().resolve('xai');
    expect(r2.kind).toBe('byok');
    if (r2.kind === 'byok') expect(r2.apiKey).toBe('stored-xai-key');

    // Remove stored BYOK → missing.
    keytarState.delete('bvrai-autocode::byok-xai');
    _resetForTests();
    await initialize();
    expect(new AuthResolver().resolve('xai').kind).toBe('missing');
  });

  it('amxKey baseOverride honors AUTOMAX_PROXY_URL', async () => {
    process.env.AUTOMAX_PROXY_URL = 'https://staging-proxy.example.com';
    await setSecret('amx', 'sk_amx_yyy');
    const r = new AuthResolver().resolve('openai');
    expect(r).toMatchObject({
      kind: 'amxkey',
      baseOverride: 'https://staging-proxy.example.com/v1/openai',
    });
  });
});

describe('isProxyAuth helper', () => {
  it('narrows to automax', () => {
    const auth: AuthMode = { kind: 'automax', token: 't', baseOverride: 'https://x/v1/xai' };
    expect(isProxyAuth(auth)).toBe(true);
  });
  it('narrows to amxkey', () => {
    const auth: AuthMode = { kind: 'amxkey', token: 'sk_amx_x', baseOverride: 'https://x/v1/xai' };
    expect(isProxyAuth(auth)).toBe(true);
  });
  it('rejects byok', () => {
    const auth: AuthMode = { kind: 'byok', apiKey: 'x' };
    expect(isProxyAuth(auth)).toBe(false);
  });
  it('rejects missing', () => {
    const auth: AuthMode = { kind: 'missing', provider: 'xai' };
    expect(isProxyAuth(auth)).toBe(false);
  });
});

describe('proxyRootUrl helper', () => {
  const before = { ...process.env };
  beforeEach(() => { delete process.env.AUTOMAX_PROXY_URL; });
  afterEach(() => { process.env = { ...before }; });

  it('returns the default proxy URL when AUTOMAX_PROXY_URL is unset', () => {
    expect(proxyRootUrl()).toBe('https://automax-proxy.fly.dev');
  });
  it('returns the override when AUTOMAX_PROXY_URL is set', () => {
    process.env.AUTOMAX_PROXY_URL = 'https://staging.example.com';
    expect(proxyRootUrl()).toBe('https://staging.example.com');
  });
  it('strips trailing slash', () => {
    process.env.AUTOMAX_PROXY_URL = 'https://staging.example.com/';
    expect(proxyRootUrl()).toBe('https://staging.example.com');
  });
});
