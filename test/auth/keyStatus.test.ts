import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// In-memory keytar mock (same approach as SecretStore.test.ts).
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

import { _resetForTests } from '../../src/auth/SecretStore.js';
import { keyStatuses, saveByokKey, removeByokKey } from '../../src/auth/keyStatus.js';

const PROVIDER_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY'];

describe('keyStatus', () => {
  let tmp: string;
  const envBefore = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'autocode-keystatus-'));
    process.env.AUTOCODE_CONFIG_DIR = tmp;
    for (const e of PROVIDER_ENV) delete process.env[e];
    keytarState.clear();
    keytarShouldFail = false;
    _resetForTests();
  });
  afterEach(() => {
    process.env = { ...envBefore };
    rmSync(tmp, { recursive: true, force: true });
    keytarState.clear();
    keytarShouldFail = false;
    _resetForTests();
    vi.clearAllMocks();
  });

  const row = (id: string): ReturnType<typeof keyStatuses>[number] =>
    keyStatuses().find((r) => r.id === id)!;

  it('reports a provider as unset when no key or env var is present', () => {
    expect(row('xai').set).toBe(false);
    expect(row('xai').source).toBeNull();
    expect(row('xai').last4).toBeNull();
  });

  it('saveByokKey stores the key with keyring source, last4, and added date', async () => {
    await saveByokKey('xai', 'xai-secret-abcd', '2026-06-05T00:00:00.000Z');
    const r = row('xai');
    expect(r.set).toBe(true);
    expect(r.source).toBe('keyring');
    expect(r.last4).toBe('abcd');
    expect(r.addedAt).toBe('2026-06-05T00:00:00.000Z');
  });

  it('falls back to config source when the keyring is unavailable', async () => {
    keytarShouldFail = true;
    await saveByokKey('openai', 'oai-secret-wxyz');
    const r = row('openai');
    expect(r.set).toBe(true);
    expect(r.source).toBe('config');
    expect(r.last4).toBe('wxyz');
  });

  it('an env var takes precedence over a stored key (source env, no date)', async () => {
    await saveByokKey('xai', 'xai-stored-0000', '2026-06-05T00:00:00.000Z');
    process.env.XAI_API_KEY = 'xai-env-9999';
    const r = row('xai');
    expect(r.source).toBe('env');
    expect(r.last4).toBe('9999');
    expect(r.addedAt).toBeNull();
  });

  it('removeByokKey clears the key and its date metadata', async () => {
    await saveByokKey('google', 'g-secret-1234', '2026-06-05T00:00:00.000Z');
    expect(row('google').set).toBe(true);
    await removeByokKey('google');
    const r = row('google');
    expect(r.set).toBe(false);
    expect(r.source).toBeNull();
    expect(r.addedAt).toBeNull();
  });
});
