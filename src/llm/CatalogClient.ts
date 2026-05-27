// Fetches the proxy's model catalog (GET /v1/catalog) when running with an
// Automax token. Disk-cached at <dataDir>/proxy-catalog.json so subsequent
// launches start instantly with stale-while-revalidate. Never throws: any
// error path returns null so startup keeps moving on the bundled fallback.
//
// The FullCatalog type below mirrors proxy/src/lib/catalog/types.ts. We keep
// a local copy (rather than importing across repos) because the schema is
// frozen at version 1 and evolves additively only — see the comment in the
// proxy's types.ts. If schema_version ever ticks past 1, this client refuses
// the payload and the fallback list takes over.

import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../util/paths.js';

export const CATALOG_SCHEMA_VERSION = 1 as const;

export type CatalogStatus =
  | 'active'
  | 'pricing_pending'
  | 'pricing_stale'
  | 'model_not_verified'
  | 'deprecated';

export interface CatalogEntry {
  id: string;
  input_price_per_million: number;
  output_price_per_million: number;
  status: CatalogStatus;
  last_verified_at: string;
  last_priced_at: string;
  supports_thinking: boolean;
  thinking_budget_default: number | null;
  max_output_tokens: number;
  context_window: number;
  vision: boolean;
  tools: boolean;
  supports_caching: boolean;
  max_cache_breakpoints: number;
  cache_read_multiplier: number;
  cache_write_multiplier: number;
}

export interface ProviderCatalog {
  last_verified_at: string;
  models: CatalogEntry[];
}

export interface FullCatalog {
  schema_version: typeof CATALOG_SCHEMA_VERSION;
  fetched_at: string;
  run_id: string;
  providers: Record<string, ProviderCatalog>;
}

const DEFAULT_TIMEOUT_MS = 4000;
const FRESH_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface FetchOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

// Network fetch only. Returns the parsed catalog on 200, null on anything
// else (network failure, non-2xx, parse error, schema mismatch). Does not
// touch disk.
export async function fetchProxyCatalog(opts: FetchOptions): Promise<FullCatalog | null> {
  const base = opts.baseUrl.replace(/\/$/, '');
  const url = `${base}/v1/catalog`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.token}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return validateCatalog(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Defensive shape check — accepts any object that looks like a v1 FullCatalog.
// Tolerates extra fields (additive evolution). Rejects schema_version != 1 so
// a future breaking change can't silently mis-feed cost math.
export function validateCatalog(body: unknown): FullCatalog | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  if (obj.schema_version !== CATALOG_SCHEMA_VERSION) return null;
  if (typeof obj.fetched_at !== 'string') return null;
  if (!obj.providers || typeof obj.providers !== 'object') return null;
  const providers = obj.providers as Record<string, unknown>;
  const cleanProviders: Record<string, ProviderCatalog> = {};
  for (const [name, pc] of Object.entries(providers)) {
    if (!pc || typeof pc !== 'object') continue;
    const pcObj = pc as Record<string, unknown>;
    if (!Array.isArray(pcObj.models)) continue;
    const models: CatalogEntry[] = [];
    for (const m of pcObj.models) {
      if (!m || typeof m !== 'object') continue;
      const me = m as Record<string, unknown>;
      if (typeof me.id !== 'string') continue;
      if (typeof me.input_price_per_million !== 'number') continue;
      if (typeof me.output_price_per_million !== 'number') continue;
      if (typeof me.status !== 'string') continue;
      models.push(m as CatalogEntry);
    }
    cleanProviders[name] = {
      last_verified_at: typeof pcObj.last_verified_at === 'string' ? pcObj.last_verified_at : '',
      models,
    };
  }
  return {
    schema_version: CATALOG_SCHEMA_VERSION,
    fetched_at: obj.fetched_at,
    run_id: typeof obj.run_id === 'string' ? obj.run_id : '',
    providers: cleanProviders,
  };
}

function cachePath(): string {
  return join(dataDir(), 'proxy-catalog.json');
}

// Reads the cached catalog if present. Returns { catalog, ageMs } or null
// when no usable cache exists. Stale entries are still returned — callers
// decide whether to use them based on ageMs.
export function readCachedCatalog(): { catalog: FullCatalog; ageMs: number } | null {
  const path = cachePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const catalog = validateCatalog(parsed);
    if (!catalog) return null;
    const stat = statSync(path);
    return { catalog, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

export function writeCachedCatalog(catalog: FullCatalog): void {
  const path = cachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(catalog), 'utf8');
  } catch {
    /* cache write failures are non-fatal */
  }
}

export interface LoadResult {
  catalog: FullCatalog | null;
  source: 'fresh' | 'cache' | 'none';
  // True when the caller should kick a background refresh (cache was served
  // but is older than FRESH_TTL_MS, or about to expire).
  refreshInBackground: boolean;
}

// Startup helper. Three paths:
//   1) Cache exists and is < TTL → return cache, signal background refresh.
//   2) No cache (or cache stale) → await a network fetch; on failure, fall
//      back to whatever cache exists (even if stale).
//   3) Nothing usable → return { catalog: null, source: 'none' }.
export async function loadCatalogForStartup(opts: FetchOptions): Promise<LoadResult> {
  const cached = readCachedCatalog();
  if (cached && cached.ageMs < FRESH_TTL_MS) {
    return { catalog: cached.catalog, source: 'cache', refreshInBackground: true };
  }
  const fresh = await fetchProxyCatalog(opts);
  if (fresh) {
    writeCachedCatalog(fresh);
    return { catalog: fresh, source: 'fresh', refreshInBackground: false };
  }
  if (cached) {
    return { catalog: cached.catalog, source: 'cache', refreshInBackground: false };
  }
  return { catalog: null, source: 'none', refreshInBackground: false };
}

// Background refresh: fetch and write cache, no return value. Fire-and-forget.
export async function refreshCatalogInBackground(opts: FetchOptions): Promise<void> {
  const fresh = await fetchProxyCatalog(opts);
  if (fresh) writeCachedCatalog(fresh);
}
