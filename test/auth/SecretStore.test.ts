import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutocodeConfig } from '../../src/auth/ConfigStore.js';

// Stateful in-memory mock of keytar. The mock is hoisted by vi.mock so
// every import of 'keytar' inside the SecretStore module under test gets
// this stand-in instead of the real native binding. Tests interact with
// the store via the exported helpers (resetKeytar, makeKeytarFail).
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

// Import after the mock is in place.
import {
  initialize,
  getSecret,
  setSecret,
  deleteSecret,
  _resetForTests,
  KNOWN_ACCOUNTS,
} from '../../src/auth/SecretStore.js';

describe('SecretStore', () => {
  let tmp: string;
  let origConfigDir: string | undefined;
  const envBefore = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'autocode-secretstore-test-'));
    origConfigDir = process.env.AUTOCODE_CONFIG_DIR;
    process.env.AUTOCODE_CONFIG_DIR = tmp;
    keytarState.clear();
    keytarShouldFail = false;
    _resetForTests();
  });
  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.AUTOCODE_CONFIG_DIR;
    else process.env.AUTOCODE_CONFIG_DIR = origConfigDir;
    process.env = { ...envBefore };
    rmSync(tmp, { recursive: true, force: true });
    keytarState.clear();
    keytarShouldFail = false;
    _resetForTests();
    vi.clearAllMocks();
  });

  // Helper: write a config.json directly into the tmp config dir.
  function writeConfig(cfg: AutocodeConfig): void {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'config.json'), JSON.stringify(cfg));
  }
  function readConfig(): AutocodeConfig {
    const path = join(tmp, 'config.json');
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8')) as AutocodeConfig;
  }

  it('initialize() with empty state populates an empty cache', async () => {
    await initialize();
    for (const account of KNOWN_ACCOUNTS) {
      expect(getSecret(account)).toBeUndefined();
    }
  });

  it('initialize() reads existing keyring entries into cache', async () => {
    keytarState.set('bvrai-autocode::amx', 'sk_amx_from_keyring');
    keytarState.set('bvrai-autocode::byok-anthropic', 'sk-ant-from-keyring');
    await initialize();
    expect(getSecret('amx')).toBe('sk_amx_from_keyring');
    expect(getSecret('byok-anthropic')).toBe('sk-ant-from-keyring');
    expect(getSecret('byok-openai')).toBeUndefined();
  });

  it('migrate-on-read: plaintext-only key gets copied to keyring + zeroed from config', async () => {
    writeConfig({ amxKey: 'sk_amx_plaintext_only', apiKeys: { anthropic: 'sk-ant-plaintext' } });
    await initialize();
    expect(getSecret('amx')).toBe('sk_amx_plaintext_only');
    expect(getSecret('byok-anthropic')).toBe('sk-ant-plaintext');
    expect(keytarState.get('bvrai-autocode::amx')).toBe('sk_amx_plaintext_only');
    expect(keytarState.get('bvrai-autocode::byok-anthropic')).toBe('sk-ant-plaintext');
    const cfg = readConfig();
    expect(cfg.amxKey).toBeUndefined();
    expect(cfg.apiKeys?.anthropic).toBeUndefined();
  });

  it('initialize() is idempotent — second call is a no-op', async () => {
    keytarState.set('bvrai-autocode::amx', 'sk_amx_first');
    await initialize();
    keytarState.set('bvrai-autocode::amx', 'sk_amx_changed');
    await initialize();
    // Cache still holds the first value (initialize short-circuited).
    expect(getSecret('amx')).toBe('sk_amx_first');
  });

  it('keyring unavailable: initialize falls back to plaintext, leaves it in place', async () => {
    keytarShouldFail = true;
    writeConfig({ amxKey: 'sk_amx_fallback' });
    await initialize();
    expect(getSecret('amx')).toBe('sk_amx_fallback');
    // Plaintext stays — migration couldn't proceed.
    expect(readConfig().amxKey).toBe('sk_amx_fallback');
  });

  it('setSecret writes to keyring + cache when keyring is available', async () => {
    await initialize();
    await setSecret('amx', 'sk_amx_new');
    expect(getSecret('amx')).toBe('sk_amx_new');
    expect(keytarState.get('bvrai-autocode::amx')).toBe('sk_amx_new');
  });

  it('setSecret falls back to plaintext config when keyring throws', async () => {
    keytarShouldFail = true;
    await initialize();
    await setSecret('amx', 'sk_amx_no_keyring');
    expect(getSecret('amx')).toBe('sk_amx_no_keyring');
    expect(readConfig().amxKey).toBe('sk_amx_no_keyring');
  });

  it('setSecret of an existing plaintext value moves it to keyring + clears plaintext', async () => {
    writeConfig({ amxKey: 'sk_amx_old_plaintext' });
    await initialize();
    // After init, migration already moved it. Now setSecret to a NEW value.
    await setSecret('amx', 'sk_amx_replaced');
    expect(getSecret('amx')).toBe('sk_amx_replaced');
    expect(keytarState.get('bvrai-autocode::amx')).toBe('sk_amx_replaced');
    expect(readConfig().amxKey).toBeUndefined();
  });

  it('deleteSecret clears keyring + cache + plaintext', async () => {
    keytarState.set('bvrai-autocode::amx', 'sk_amx_to_delete');
    writeConfig({ amxKey: 'sk_amx_to_delete_plaintext' });
    await initialize();
    expect(getSecret('amx')).toBe('sk_amx_to_delete');
    await deleteSecret('amx');
    expect(getSecret('amx')).toBeUndefined();
    expect(keytarState.has('bvrai-autocode::amx')).toBe(false);
    expect(readConfig().amxKey).toBeUndefined();
  });

  it('handles multiple providers without collision', async () => {
    await initialize();
    await setSecret('byok-anthropic', 'sk-ant-x');
    await setSecret('byok-openai', 'sk-oai-x');
    await setSecret('byok-xai', 'sk-xai-x');
    expect(getSecret('byok-anthropic')).toBe('sk-ant-x');
    expect(getSecret('byok-openai')).toBe('sk-oai-x');
    expect(getSecret('byok-xai')).toBe('sk-xai-x');
    expect(getSecret('byok-google')).toBeUndefined();
  });

  it('keyring entry beats plaintext when both present', async () => {
    keytarState.set('bvrai-autocode::amx', 'sk_amx_from_keyring');
    writeConfig({ amxKey: 'sk_amx_from_plaintext' });
    await initialize();
    expect(getSecret('amx')).toBe('sk_amx_from_keyring');
  });

  it('renderer hint fires when migration moves keys', async () => {
    const out: string[] = [];
    writeConfig({ amxKey: 'sk_amx_x', apiKeys: { anthropic: 'sk-ant-x' } });
    await initialize({
      info: () => {},
      dim: (t: string) => out.push(t),
      warn: () => {},
      error: () => {},
      status: () => {},
      assistant: () => {},
      user: () => {},
      rule: () => {},
    } as never);
    expect(out.some((t) => t.includes('migrated 2 saved keys'))).toBe(true);
  });

  it('renderer hint does NOT fire when no migration needed', async () => {
    const out: string[] = [];
    keytarState.set('bvrai-autocode::amx', 'sk_amx_already_in_keyring');
    await initialize({
      info: () => {},
      dim: (t: string) => out.push(t),
      warn: () => {},
      error: () => {},
      status: () => {},
      assistant: () => {},
      user: () => {},
      rule: () => {},
    } as never);
    expect(out.some((t) => t.includes('migrated'))).toBe(false);
  });
});
