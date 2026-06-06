// BYOK key status + mutation helpers, shared by the `/keys` manager overlay
// and the `/auth <provider> <key>` command. Computes, per provider, whether a
// key is set, where it lives (env / OS keyring / plaintext config), the last 4
// characters (so the user can verify the right key without revealing it), and
// when it was added. Mutations route through SecretStore (the key itself) and
// ConfigStore (the non-secret added-date metadata).

import { BYOK_PROVIDERS } from './firstRun.js';
import { getSecret, getSecretSource, setSecret, deleteSecret, type AccountName } from './SecretStore.js';
import { ConfigStore } from './ConfigStore.js';

export type KeySource = 'env' | 'keyring' | 'config';

export interface KeyStatus {
  id: string;
  label: string;
  envKey: string;
  signupUrl: string;
  hint?: string;
  set: boolean;
  // Where the credential that would actually be USED comes from (env wins over
  // a stored key, matching AuthResolver's precedence), or null when unset.
  source: KeySource | null;
  last4: string | null;
  addedAt: string | null; // ISO timestamp, only for stored keys
}

function account(id: string): AccountName {
  return `byok-${id}` as AccountName;
}

function last4(value: string): string {
  return value.length <= 4 ? value : value.slice(-4);
}

// One row per BYOK provider. Env vars take precedence over stored keys (same
// rule AuthResolver applies), so a provider with an env var set reports
// source:'env' even if a key is also stored.
export function keyStatuses(): KeyStatus[] {
  const meta = new ConfigStore().load().apiKeyMeta ?? {};
  return BYOK_PROVIDERS.map((p): KeyStatus => {
    const base = {
      id: p.id,
      label: p.label,
      envKey: p.envKey,
      signupUrl: p.signupUrl,
      hint: p.hint,
    };
    const envVal = process.env[p.envKey];
    if (envVal && envVal.length > 0) {
      return { ...base, set: true, source: 'env', last4: last4(envVal), addedAt: null };
    }
    const stored = getSecret(account(p.id));
    if (stored && stored.length > 0) {
      const source: KeySource = getSecretSource(account(p.id)) === 'keyring' ? 'keyring' : 'config';
      return { ...base, set: true, source, last4: last4(stored), addedAt: meta[p.id]?.addedAt ?? null };
    }
    return { ...base, set: false, source: null, last4: null, addedAt: null };
  });
}

// Save (or replace) a BYOK key and stamp its added-date. `nowIso` is injected
// so callers can keep it deterministic; defaults to the real clock.
export async function saveByokKey(id: string, key: string, nowIso: string = new Date().toISOString()): Promise<void> {
  await setSecret(account(id), key);
  const store = new ConfigStore();
  const cfg = store.load();
  cfg.apiKeyMeta = { ...(cfg.apiKeyMeta ?? {}), [id]: { addedAt: nowIso } };
  store.save(cfg);
}

// Remove a stored BYOK key and its date metadata. Does NOT touch env vars —
// those are unset in the user's shell, not here.
export async function removeByokKey(id: string): Promise<void> {
  await deleteSecret(account(id));
  const store = new ConfigStore();
  const cfg = store.load();
  if (cfg.apiKeyMeta && cfg.apiKeyMeta[id]) {
    const rest = { ...cfg.apiKeyMeta };
    delete rest[id];
    cfg.apiKeyMeta = rest;
    store.save(cfg);
  }
}
