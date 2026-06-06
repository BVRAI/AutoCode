// SecretStore — OS-keyring-backed credential storage with plaintext
// fallback. Industry standard (gh, aws, Docker Desktop, VS Code) for
// sensitive CLI credentials.
//
// Design:
//   - Eager initialize() at startup loads every known secret from the OS
//     keyring into an in-memory cache. Subsequent reads are SYNC, so
//     AuthResolver can stay synchronous and the provider construction path
//     doesn't need to thread `await` through every layer.
//   - setSecret() / deleteSecret() are async — they have to call into
//     keytar's async API and persist before returning.
//   - If keytar fails to load (e.g. native binding broke during npm
//     install, headless Linux without libsecret), every operation
//     transparently falls back to ConfigStore's plaintext slots. Saved
//     keys keep working; we just lose the OS-level encryption.
//   - Migration on init: any key sitting in plaintext config but NOT yet
//     in keyring gets copied to keyring and zeroed from plaintext. Quiet
//     dim line so the user sees that it happened.
//
// Account naming:
//   - "amx"           — the BVRAI proxy `sk_amx_*` key (Plan 8)
//   - "byok-<id>"     — per-provider BYOK keys (anthropic, openai, xai,
//                       openrouter, google, brave)
//
// Service name: "bvrai-autocode" (visible in Credential Manager / Keychain
// Access — picked once, never change so users can find their entries).

import type { ConsoleRenderer } from '../repl/ConsoleRenderer.js';
import { ConfigStore, type AutocodeConfig } from './ConfigStore.js';

const SERVICE_NAME = 'bvrai-autocode';

// Every account name SecretStore tracks. New providers added here are
// auto-included in the eager load + migration sweep.
export const KNOWN_ACCOUNTS = [
  'amx',
  'byok-anthropic',
  'byok-openai',
  'byok-xai',
  'byok-openrouter',
  'byok-google',
  'byok-brave',
] as const;

export type AccountName = (typeof KNOWN_ACCOUNTS)[number];

// Minimal keytar API surface we touch. Declared locally so we don't fail
// to typecheck on systems where @types/keytar isn't installed (keytar
// ships its own types but they're sometimes flaky on Windows native build
// failures).
interface KeytarLike {
  getPassword: (service: string, account: string) => Promise<string | null>;
  setPassword: (service: string, account: string, password: string) => Promise<void>;
  deletePassword: (service: string, account: string) => Promise<boolean>;
}

let keytarModule: KeytarLike | null = null;
let keytarLoadAttempted = false;
let cache: Partial<Record<AccountName, string>> = {};
// Where each cached secret actually lives — 'keyring' (OS-encrypted) or
// 'plaintext' (~/.autocode/config.json). Surfaced by the /keys manager so the
// user can see whether OS encryption is in play.
let sources: Partial<Record<AccountName, 'keyring' | 'plaintext'>> = {};
let initialized = false;

// Lazy-load keytar. Returns null on any failure so callers can fall
// through to plaintext. We attempt the load exactly once per process.
async function loadKeytar(): Promise<KeytarLike | null> {
  if (keytarLoadAttempted) return keytarModule;
  keytarLoadAttempted = true;
  try {
    // Dynamic import + double-resolve: keytar is CommonJS so the ESM
    // wrapper exposes the API on `.default`. Some bundler configurations
    // hoist it; cover both shapes.
    const mod = (await import('keytar')) as { default?: KeytarLike } & Partial<KeytarLike>;
    const api = mod.default ?? (mod as KeytarLike);
    if (typeof api.getPassword !== 'function') return null;
    // Smoke-test by calling getPassword on a known-absent account. If the
    // native binding works but the OS keyring isn't available (libsecret
    // missing on a headless Linux box), the call throws synchronously
    // inside the native shim — catch it here.
    try {
      await api.getPassword(SERVICE_NAME, '__autocode_keyring_probe__');
    } catch {
      return null;
    }
    keytarModule = api;
    return api;
  } catch {
    return null;
  }
}

// Map an AccountName to the plaintext-config slot it falls back to.
// "amx" → cfg.amxKey; "byok-anthropic" → cfg.apiKeys.anthropic; etc.
function readPlaintext(account: AccountName, cfg: AutocodeConfig): string | undefined {
  if (account === 'amx') return cfg.amxKey;
  const providerId = account.slice('byok-'.length) as keyof NonNullable<AutocodeConfig['apiKeys']>;
  return cfg.apiKeys?.[providerId];
}

function writePlaintext(account: AccountName, cfg: AutocodeConfig, value: string | undefined): void {
  if (account === 'amx') {
    if (value === undefined) delete cfg.amxKey;
    else cfg.amxKey = value;
    return;
  }
  const providerId = account.slice('byok-'.length) as keyof NonNullable<AutocodeConfig['apiKeys']>;
  cfg.apiKeys = cfg.apiKeys ?? {};
  if (value === undefined) delete cfg.apiKeys[providerId];
  else cfg.apiKeys[providerId] = value;
}

// Called once at startup from cli.ts. Populates the in-memory cache from
// keyring (preferred) or plaintext config (fallback). Migrates plaintext-
// only keys to keyring when possible. Silent on success; emits one dim
// line via renderer when migration actually moved keys.
export async function initialize(renderer?: ConsoleRenderer): Promise<void> {
  if (initialized) return;
  initialized = true;

  const keytar = await loadKeytar();
  const store = new ConfigStore();
  const cfg = store.load();
  let migrated = 0;
  let cfgDirty = false;

  for (const account of KNOWN_ACCOUNTS) {
    let value: string | undefined;
    let src: 'keyring' | 'plaintext' | undefined;
    if (keytar) {
      try {
        value = (await keytar.getPassword(SERVICE_NAME, account)) ?? undefined;
        if (value !== undefined) src = 'keyring';
      } catch {
        value = undefined;
      }
    }
    if (value === undefined) {
      // Fall back to plaintext config slot.
      const plain = readPlaintext(account, cfg);
      if (plain !== undefined && plain.length > 0) {
        value = plain;
        src = 'plaintext';
        // Migrate-on-read: if keyring is available, copy to keyring AND
        // zero the plaintext slot so the secret stops sitting in
        // config.json.
        if (keytar) {
          try {
            await keytar.setPassword(SERVICE_NAME, account, plain);
            writePlaintext(account, cfg, undefined);
            cfgDirty = true;
            migrated += 1;
            src = 'keyring';
          } catch {
            /* couldn't write to keyring — leave plaintext as-is */
          }
        }
      }
    }
    if (value !== undefined) {
      cache[account] = value;
      if (src) sources[account] = src;
    }
  }

  if (cfgDirty) store.save(cfg);
  if (migrated > 0 && renderer) {
    renderer.dim(`(migrated ${migrated} saved key${migrated === 1 ? '' : 's'} to OS keyring)`);
  }
  if (!keytar && renderer) {
    // One-time hint, not an error. Only fires if we tried to load and failed.
    renderer.dim('(OS keyring unavailable — saved keys stored in ~/.autocode/config.json)');
  }
}

// Synchronous read from the cache. Returns undefined when no secret is
// stored for this account. Safe to call from any path that runs after
// initialize().
export function getSecret(account: AccountName): string | undefined {
  return cache[account];
}

// Where the cached secret for this account is stored — 'keyring',
// 'plaintext', or undefined when no secret is set. Read-only view for the
// /keys manager; does not trigger any I/O.
export function getSecretSource(account: AccountName): 'keyring' | 'plaintext' | undefined {
  return sources[account];
}

// Persist a secret. Writes to keyring if available, plaintext config
// otherwise. Updates the in-memory cache so subsequent getSecret() calls
// see the new value without restart.
export async function setSecret(account: AccountName, value: string): Promise<void> {
  cache[account] = value;
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      await keytar.setPassword(SERVICE_NAME, account, value);
      // Successfully wrote to keyring → ensure plaintext slot is empty.
      const store = new ConfigStore();
      const cfg = store.load();
      if (readPlaintext(account, cfg) !== undefined) {
        writePlaintext(account, cfg, undefined);
        store.save(cfg);
      }
      sources[account] = 'keyring';
      return;
    } catch {
      /* fall through to plaintext */
    }
  }
  // Plaintext fallback.
  const store = new ConfigStore();
  const cfg = store.load();
  writePlaintext(account, cfg, value);
  store.save(cfg);
  sources[account] = 'plaintext';
}

// Remove a secret from both keyring and plaintext config. Idempotent.
export async function deleteSecret(account: AccountName): Promise<void> {
  delete cache[account];
  delete sources[account];
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      await keytar.deletePassword(SERVICE_NAME, account);
    } catch {
      /* ignore */
    }
  }
  const store = new ConfigStore();
  const cfg = store.load();
  if (readPlaintext(account, cfg) !== undefined) {
    writePlaintext(account, cfg, undefined);
    store.save(cfg);
  }
}

// Test-only helper: reset module state so beforeEach can start fresh.
// Not exported in the public API surface; tests import via the file path.
export function _resetForTests(): void {
  cache = {};
  sources = {};
  initialized = false;
  keytarModule = null;
  keytarLoadAttempted = false;
}
