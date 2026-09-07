// Secret redaction for what leaves the process as a record (Phase 5.4): the
// session transcript and tool log on disk, the <<AMX>> event stream, and the
// app-server notifications. The conversation the model sees is untouched —
// redacting there would silently break a tool result the agent still needs.
//
// Patterns are token-shaped (no spaces or quotes inside a match), so applying
// the filter to a serialized JSON line never breaks the JSON.

const KEY_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic / OpenRouter
  /\bsk_amx_[A-Za-z0-9_-]{8,}/g, // BVRAI proxy key
  /\bxai-[A-Za-z0-9]{16,}/g, // xAI
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, // JWT (Firebase ID tokens)
];

// "Bearer <token>" and KEY=value / "key": "value" assignments for names that
// mean a secret. The name is kept so logs stay readable; the value goes.
const BEARER = /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g;
// The name may carry a prefix (OPENAI_API_KEY, x-auth-token); the value must
// look like a credential (see looksLikeSecretValue) so `token_budget=8000`
// and `password=null` survive.
const ASSIGNMENT = /\b([A-Za-z0-9_-]*(?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)s?)(["']?\s*[=:]\s*["']?)([^\s"'&,;]{12,})/gi;

const ALLOWLIST_VALUES = /^(?:true|false|null|undefined|none|redacted|\*+|<[^>]+>|\$\{[^}]+\}|%[^%]+%|process\.env\.[A-Z_]+)$/i;

function looksLikeSecretValue(value: string): boolean {
  if (ALLOWLIST_VALUES.test(value)) return false;
  // Paths, URLs and relative references are configuration, not credentials.
  if (/^(?:[A-Za-z]:\\|\/|\.{1,2}\/|https?:\/\/|file:)/i.test(value)) return false;
  // Pure digits (budgets, ids) and plain lowercase words (flags, modes) are not secrets.
  if (/^\d+$/.test(value) || /^[a-z_]+$/.test(value)) return false;
  return true;
}

export function maskSecret(value: string): string {
  const keep = value.length >= 12 ? value.slice(0, 4) : '';
  return `${keep}…[redacted]`;
}

/** Replace secret-shaped substrings; returns the input unchanged when nothing matches. */
export function redactSecrets(text: string): string {
  if (!text || text.length < 12) return text;
  let out = text;
  for (const re of KEY_PATTERNS) out = out.replace(re, (m) => maskSecret(m));
  out = out.replace(BEARER, (_m, tok: string) => `Bearer ${maskSecret(tok)}`);
  out = out.replace(ASSIGNMENT, (m, name: string, sep: string, value: string) => {
    if (!looksLikeSecretValue(value)) return m;
    return `${name}${sep}${maskSecret(value)}`;
  });
  return out;
}

/** Redact every string inside a JSON-serializable value (objects and arrays are walked). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

export function redactionDisabled(): boolean {
  return process.env.AUTOCODE_NO_REDACT === '1';
}
