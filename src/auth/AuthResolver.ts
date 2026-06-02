import { ConfigStore } from './ConfigStore.js';
import { getSecret } from './SecretStore.js';

export type AuthMode =
  // V6-embedded path: short-lived Firebase ID token injected via
  // AUTOMAX_PROXY_TOKEN env var. Highest precedence.
  | { kind: 'automax'; token: string; baseOverride: string }
  // Standalone-authenticated path: long-lived `sk_amx_*` key from /login,
  // persisted in ConfigStore.amxKey. Used when AutoCode runs in any
  // terminal outside V6 and the user has authenticated via Plan 8's flow.
  | { kind: 'amxkey'; token: string; baseOverride: string }
  // BYOK fallback: user's own per-provider API key (Anthropic, OpenAI…).
  // Falls through to here when neither proxy auth path is set.
  | { kind: 'byok'; apiKey: string }
  // No usable credential anywhere — caller decides whether to launch the
  // first-run wizard, error, or fall through to stub mode.
  | { kind: 'missing'; provider: string };

const DEFAULT_AUTOMAX_PROXY_URL = 'https://automax-proxy.fly.dev';

export class AuthResolver {
  // ConfigStore was the credential source pre-SecretStore; now everything
  // routes through SecretStore.getSecret() (which loads from keyring or
  // plaintext-config fallback). The constructor still accepts a
  // ConfigStore for tests that want to inject a stub, but the resolver
  // doesn't actually call it anymore — it reads from SecretStore's cache.
  constructor(_config = new ConfigStore()) {
    void _config;
  }

  resolve(provider: string): AuthMode {
    // 1. AUTOMAX_PROXY_TOKEN env var (V6-embedded). Always wins when set —
    //    a freshly-injected Firebase token is by definition the right
    //    identity for the V6-spawned session.
    const proxyToken = process.env.AUTOMAX_PROXY_TOKEN;
    if (proxyToken && proxyToken.length > 0) {
      return {
        kind: 'automax',
        token: proxyToken,
        baseOverride: this.proxyBase(provider),
      };
    }
    // 2. Persisted `sk_amx_*` key from /login. Long-lived; user revokes
    //    via the bvrai.ca dashboard if needed. SecretStore returns from
    //    OS keyring when available, plaintext config when not.
    const amxKey = getSecret('amx');
    if (amxKey && amxKey.length > 0) {
      return {
        kind: 'amxkey',
        token: amxKey,
        baseOverride: this.proxyBase(provider),
      };
    }
    // 3. BYOK: env var beats stored key (matches every CLI's "env wins"
    //    convention); fall back to SecretStore's per-provider slot.
    const envKey = envVarFor(provider);
    const fromEnv = envKey ? process.env[envKey] : undefined;
    if (fromEnv && fromEnv.length > 0) {
      return { kind: 'byok', apiKey: fromEnv };
    }
    const storedKey = getSecret(`byok-${provider}` as 'byok-anthropic');
    if (storedKey && storedKey.length > 0) {
      return { kind: 'byok', apiKey: storedKey };
    }
    // 4. Nothing usable.
    return { kind: 'missing', provider };
  }

  // Single source for the proxy base URL — env override or compiled-in
  // default. Returns the per-provider sub-path the existing providers
  // expect (e.g. `https://automax-proxy.fly.dev/v1/anthropic`).
  private proxyBase(provider: string): string {
    const base = process.env.AUTOMAX_PROXY_URL ?? DEFAULT_AUTOMAX_PROXY_URL;
    return `${base.replace(/\/$/, '')}/v1/${provider}`;
  }
}

// Map provider id → env-var name. Mirrors ConfigStore.envKeyFor but kept
// local so AuthResolver doesn't reach back into ConfigStore for what's
// now SecretStore-owned key resolution.
function envVarFor(provider: string): string | undefined {
  switch (provider) {
    case 'anthropic': return 'ANTHROPIC_API_KEY';
    case 'openai': return 'OPENAI_API_KEY';
    case 'google': return 'GOOGLE_API_KEY';
    case 'xai': return 'XAI_API_KEY';
    case 'openrouter': return 'OPENROUTER_API_KEY';
    case 'brave': return 'BRAVE_API_KEY';
    default: return undefined;
  }
}

// Exported for `/login` and other callers that need the same proxy-base
// derivation without instantiating an AuthResolver. Returns the root proxy
// URL (no `/v1/<provider>` suffix) since callers like `/login` hit
// non-provider endpoints (e.g. `/v1/usage/me`).
export function proxyRootUrl(): string {
  const base = process.env.AUTOMAX_PROXY_URL ?? DEFAULT_AUTOMAX_PROXY_URL;
  return base.replace(/\/$/, '');
}

// True when the auth is a proxy-routed mode — both `automax` (Firebase ID
// token via env var) and `amxkey` (`sk_amx_*` from /login) share the same
// `{ token, baseOverride }` shape and identical downstream handling
// (Bearer header + override the provider's base URL with the proxy's).
// Providers should use this rather than duplicating the discriminator
// check across both kinds. The type narrowing here gives callers safe
// access to `.token` / `.baseOverride` without extra casts.
export function isProxyAuth(
  auth: AuthMode,
): auth is { kind: 'automax' | 'amxkey'; token: string; baseOverride: string } {
  return auth.kind === 'automax' || auth.kind === 'amxkey';
}
