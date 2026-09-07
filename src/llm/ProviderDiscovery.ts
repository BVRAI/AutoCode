// Model discovery straight from the providers, for sessions that have no
// Automax catalog (BYOK keys, no proxy token). Each provider publishes its
// model list — Anthropic, OpenAI and Google under /models, xAI under
// /language-models with prices, OpenRouter publicly with prices — so the
// picker no longer depends on a hand-edited table that drifts within weeks
// of a release. Lists are cached per provider under the data dir for a day
// (`/model refresh` refetches).
//
// Prices, in order: what the provider publishes (xAI, OpenRouter) → the
// bundled table when the id is a known family member → OpenRouter's public
// list as an oracle (it carries the origin's list price for OpenAI,
// Anthropic, xAI and Google models) → the bundled table by loose prefix →
// a conservative cap (the provider's dearest bundled rate) flagged
// `priceUnknown`, so a cost cap still fires for a model nobody has priced.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../util/paths.js';
import { RATES, bundledRateFor, setDiscoveredRates, type ModelRate } from '../util/pricing.js';
import { labelFor, setDiscoveredModels, type ModelInfo } from './models.js';

export const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export type DiscoverableProvider = 'anthropic' | 'openai' | 'xai' | 'google' | 'openrouter';

export const DISCOVERABLE: readonly DiscoverableProvider[] = ['anthropic', 'openai', 'xai', 'google', 'openrouter'];

export function isDiscoverable(provider: string): provider is DiscoverableProvider {
  return (DISCOVERABLE as readonly string[]).includes(provider);
}

export interface DiscoveredModel {
  id: string;
  label?: string;
  inputPerM?: number;
  outputPerM?: number;
  cacheReadPerM?: number;
  contextWindow?: number;
  vision?: boolean;
  supportsThinking?: boolean;
  /** The provider serves this id as an alias of `aliasOf`. */
  aliasOf?: string;
  /** Release time (unix seconds) when the list carries one (OpenRouter); newest sorts first. */
  createdAt?: number;
}

/** Chat-capable models only; the lists also carry embeddings, speech, image, video and batch ids. */
const NOT_CHAT =
  /embed|tts|whisper|transcri|speech|audio|realtime|moderation|dall-e|image|video|imagine|sora|veo|search-api|search-preview|chat-latest|computer-use|deep-research|-batch|:batch|davinci|babbage|curie|instruct|similarity|aqa$|live-|-live\b/i;

export function isChatModelId(provider: DiscoverableProvider, id: string): boolean {
  if (NOT_CHAT.test(id)) return false;
  switch (provider) {
    case 'anthropic':
      return id.startsWith('claude');
    case 'openai':
      return /^(gpt-|o[1-9]|chatgpt-)/.test(id);
    case 'xai':
      return id.startsWith('grok');
    case 'google':
      return id.startsWith('gemini') || id.startsWith('gemma');
    case 'openrouter':
      return true;
  }
}

/** Parse one provider's list response into models. Pure; tested with fixtures. */
export function parseProviderModels(provider: DiscoverableProvider, body: unknown, now: number = Date.now()): DiscoveredModel[] {
  const obj = (body ?? {}) as Record<string, unknown>;
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  const push = (m: DiscoveredModel): void => {
    if (!m.id || seen.has(m.id) || !isChatModelId(provider, m.id)) return;
    seen.add(m.id);
    out.push(m);
  };
  switch (provider) {
    case 'anthropic': {
      const entries = asArray(obj['data']);
      const ids = new Set(entries.map((e) => str(e['id'])).filter((x): x is string => x !== undefined));
      for (const e of entries) {
        const id = str(e['id']);
        if (!id) continue;
        // A dated id whose undated alias is listed too is a duplicate row.
        const undated = id.replace(/-\d{8}$/, '');
        if (undated !== id && ids.has(undated)) continue;
        push({ id, label: str(e['display_name']) });
      }
      break;
    }
    case 'openai': {
      const entries = asArray(obj['data']);
      const ids = new Set(entries.map((e) => str(e['id'])).filter((x): x is string => x !== undefined));
      for (const e of entries) {
        const id = str(e['id']);
        if (!id) continue;
        const shutdown = str(e['shutdown_date']);
        if (shutdown !== undefined && Number.isFinite(Date.parse(shutdown)) && Date.parse(shutdown) < now) continue;
        // "gpt-5.4-2026-03-05" next to "gpt-5.4", or "gpt-4-0613" next to
        // "gpt-4", is the same model pinned.
        const undated = id.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{4}$/, '');
        if (undated !== id && ids.has(undated)) continue;
        push({ id });
      }
      break;
    }
    case 'xai': {
      // /v1/language-models prices in 1/10,000 USD per million tokens
      // (grok-4.6: 20000 → $2). Every entry also lists its aliases. The row
      // shows the name people know: a bundled-known alias that heads the
      // pinned id ("grok-4.20" for "grok-4.20-0309-reasoning"), else the
      // undated alias ("grok-4.20-non-reasoning"), else the id itself. Aliases
      // of a differently named model (grok-code-fast-1 → grok-build-0.1) are
      // not rows: the real name is listed and xAI still honours the old one
      // when typed.
      for (const e of asArray(obj['models'] ?? obj['data'])) {
        const id = str(e['id']);
        if (!id) continue;
        const price = {
          inputPerM: xaiPrice(e['prompt_text_token_price']),
          outputPerM: xaiPrice(e['completion_text_token_price']),
          cacheReadPerM: xaiPrice(e['cached_prompt_text_token_price']),
        };
        const inputs = asStringArray(e['input_modalities']);
        const vision = inputs.length > 0 ? inputs.includes('image') : undefined;
        const aliases = asStringArray(e['aliases']);
        const known = aliases.filter((alias) => alias in (RATES['xai'] ?? {}));
        const display = known.find((alias) => id.startsWith(alias)) ?? undatedAlias(id, aliases);
        push({ id: display, ...price, vision, aliasOf: display === id ? undefined : id });
      }
      break;
    }
    case 'google': {
      for (const e of asArray(obj['models'])) {
        const name = str(e['name']);
        if (!name) continue;
        const methods = asStringArray(e['supportedGenerationMethods']);
        if (methods.length > 0 && !methods.includes('generateContent')) continue;
        const id = name.replace(/^models\//, '');
        push({
          id,
          label: str(e['displayName']),
          contextWindow: num(e['inputTokenLimit']),
          supportsThinking: /^gemini-(2\.5|[3-9])/.test(id) ? true : undefined,
        });
      }
      break;
    }
    case 'openrouter': {
      for (const e of asArray(obj['data'])) {
        const id = str(e['id']);
        if (!id) continue;
        const pricing = (e['pricing'] ?? {}) as Record<string, unknown>;
        const arch = (e['architecture'] ?? {}) as Record<string, unknown>;
        const inputs = asStringArray(arch['input_modalities']);
        const params = asStringArray(e['supported_parameters']);
        push({
          id,
          label: str(e['name']),
          inputPerM: perToken(pricing['prompt']),
          outputPerM: perToken(pricing['completion']),
          cacheReadPerM: perToken(pricing['input_cache_read']),
          contextWindow: num(e['context_length']),
          vision: inputs.length > 0 ? inputs.includes('image') : undefined,
          supportsThinking: params.length > 0 ? params.includes('reasoning') : undefined,
          createdAt: num(e['created']),
        });
      }
      break;
    }
  }
  return out;
}

/** "grok-4.20-0309-reasoning" → "grok-4.20-reasoning" when xAI lists that alias. */
function undatedAlias(id: string, aliases: string[]): string {
  const undated = id.replace(/-\d{4}(?=-|$)/, '');
  return undated !== id && aliases.includes(undated) ? undated : id;
}

function listUrl(provider: DiscoverableProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'https://api.anthropic.com/v1/models?limit=1000';
    case 'openai':
      return 'https://api.openai.com/v1/models';
    case 'xai':
      return 'https://api.x.ai/v1/language-models';
    case 'google':
      return 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1/models';
  }
}

function headersFor(provider: DiscoverableProvider, apiKey: string): Record<string, string> {
  if (apiKey.length === 0) return {};
  switch (provider) {
    case 'anthropic':
      return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    case 'google':
      return { 'x-goog-api-key': apiKey };
    default:
      return { authorization: `Bearer ${apiKey}` };
  }
}

/** Network fetch of one provider's list; null on any failure. OpenRouter's list is public (empty key allowed). */
export async function fetchProviderModels(
  provider: DiscoverableProvider,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredModel[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(listUrl(provider), { headers: headersFor(provider, apiKey), signal: ctrl.signal });
    if (!res.ok) return null;
    return parseProviderModels(provider, await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function cachePath(provider: string): string {
  return join(dataDir(), 'provider-models', `${provider}.json`);
}

export function readDiscoveryCache(provider: string): { models: DiscoveredModel[]; ageMs: number } | null {
  const path = cachePath(provider);
  if (!existsSync(path)) return null;
  try {
    const models = JSON.parse(readFileSync(path, 'utf8')) as DiscoveredModel[];
    if (!Array.isArray(models)) return null;
    return { models, ageMs: Date.now() - statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

export function writeDiscoveryCache(provider: string, models: DiscoveredModel[]): void {
  try {
    mkdirSync(join(dataDir(), 'provider-models'), { recursive: true });
    writeFileSync(cachePath(provider), JSON.stringify(models, null, 2), 'utf8');
  } catch {
    /* the cache is a convenience */
  }
}

export type ListSource = 'fresh' | 'cache' | 'failed';

/** Cache (within TTL, unless forced) → network → stale cache → failed. */
export async function loadProviderList(
  provider: DiscoverableProvider,
  apiKey: string,
  opts: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ models: DiscoveredModel[]; source: ListSource; ageMs?: number }> {
  const cached = readDiscoveryCache(provider);
  if (cached && !opts.force && cached.ageMs < DISCOVERY_TTL_MS) {
    return { models: cached.models, source: 'cache', ageMs: cached.ageMs };
  }
  const fresh = await fetchProviderModels(provider, apiKey, opts.fetchImpl);
  if (fresh) {
    writeDiscoveryCache(provider, fresh);
    return { models: fresh, source: 'fresh', ageMs: 0 };
  }
  if (cached) return { models: cached.models, source: 'cache', ageMs: cached.ageMs };
  return { models: [], source: 'failed' };
}

/** OpenRouter's id for a model of another provider ("anthropic/claude-opus-4.7", "x-ai/grok-4.6"). */
export function openRouterId(provider: DiscoverableProvider, id: string): string | null {
  switch (provider) {
    case 'openai':
      return `openai/${id}`;
    case 'xai':
      return `x-ai/${id}`;
    case 'google':
      return `google/${id}`;
    case 'anthropic':
      return `anthropic/${id.replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
    case 'openrouter':
      return null;
  }
}

export type PriceOracle = (provider: DiscoverableProvider, id: string) => ModelRate | null;

/** Build the oracle from OpenRouter's list. */
export function oracleFrom(openRouterModels: DiscoveredModel[]): PriceOracle {
  const byId = new Map<string, DiscoveredModel>();
  for (const m of openRouterModels) byId.set(m.id, m);
  return (provider, id) => {
    const key = openRouterId(provider, id);
    const m = key ? byId.get(key) : undefined;
    if (!m || m.inputPerM === undefined || m.outputPerM === undefined) return null;
    return { inputPerM: m.inputPerM, outputPerM: m.outputPerM, cacheReadPerM: m.cacheReadPerM };
  };
}

/** The provider's dearest bundled rate; $5/$25 for a provider with no bundled rows. */
export function capRate(provider: string): ModelRate {
  const rows = Object.values(RATES[provider] ?? {});
  if (rows.length === 0) return { inputPerM: 5, outputPerM: 25 };
  return {
    inputPerM: Math.max(...rows.map((r) => r.inputPerM)),
    outputPerM: Math.max(...rows.map((r) => r.outputPerM)),
  };
}

export interface ModelInfosResult {
  infos: ModelInfo[];
  /** Exact-id rates for pricing.ts (primary ids too, so a typed alias target is priced). */
  rates: Record<string, ModelRate>;
  /** Ids that ended up on the cap. */
  unpriced: string[];
}

/** Discovered models as picker rows plus the rates cost math should use. */
export function toModelInfos(
  provider: DiscoverableProvider,
  models: DiscoveredModel[],
  oracle: PriceOracle = () => null,
): ModelInfosResult {
  const infos: ModelInfo[] = [];
  const rates: Record<string, ModelRate> = {};
  const unpriced: string[] = [];
  for (const m of models) {
    let rate: ModelRate | null =
      m.inputPerM !== undefined && m.outputPerM !== undefined
        ? { inputPerM: m.inputPerM, outputPerM: m.outputPerM, cacheReadPerM: m.cacheReadPerM }
        : null;
    rate ??= bundledRateFor(provider, m.id, true);
    rate ??= oracle(provider, m.id);
    rate ??= bundledRateFor(provider, m.id, false);
    let priceUnknown = false;
    if (!rate) {
      rate = capRate(provider);
      priceUnknown = true;
      unpriced.push(m.id);
    }
    rates[m.id] = rate;
    if (m.aliasOf) rates[m.aliasOf] ??= rate;

    const meta = labelFor(m.id);
    const exact = meta.key === m.id;
    let label: string;
    if (exact) label = meta.label;
    else if (m.label) label = m.label;
    else if (meta.key) label = `${meta.label} ${m.id.slice(meta.key.length).replace(/^[-:]/, '')}`.trim();
    else label = m.id;

    const notes = [
      exact ? meta.notes : undefined,
      m.aliasOf && !(exact && meta.notes?.includes('alias of')) ? `alias of ${m.aliasOf}` : undefined,
      priceUnknown ? `billed as $${rate.inputPerM}/$${rate.outputPerM} for the cost cap` : undefined,
    ]
      .filter((x): x is string => Boolean(x))
      .join(' · ');

    infos.push({
      provider,
      model: m.id,
      label,
      notes: notes.length > 0 ? notes : undefined,
      inputPerM: rate.inputPerM,
      outputPerM: rate.outputPerM,
      cacheReadPerM: rate.cacheReadPerM,
      contextWindow: m.contextWindow,
      supportsThinking: m.supportsThinking ?? (meta.key ? meta.thinking === true : undefined),
      vision: m.vision,
      priceUnknown: priceUnknown || undefined,
      aliasOf: m.aliasOf,
    });
  }
  return { infos, rates, unpriced };
}

/** Newest first: release time when the list carries one, else higher version numbers, then shorter ids, then alphabetical. */
export function sortModelIds<T extends { id: string; createdAt?: number }>(models: T[]): T[] {
  const version = (id: string): number => {
    const tail = id.replace(/^[^\d]*(?=\d)/, '');
    const m = /^(\d+)(?:[.-](\d+))?/.exec(tail);
    if (!m) return 0;
    return Number.parseFloat(`${m[1]}.${m[2] ?? '0'}`);
  };
  return [...models].sort(
    (a, b) =>
      (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
      version(b.id) - version(a.id) ||
      a.id.length - b.id.length ||
      a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Orchestration: one run per process (startup kicks it off in the background,
// /model waits for it; /model refresh forces a new one).

export interface DiscoveryProviderResult {
  provider: DiscoverableProvider;
  source: ListSource | 'no-key';
  count: number;
  ageMs?: number;
}

export interface DiscoveryReport {
  providers: DiscoveryProviderResult[];
  /** "provider/id" entries priced by the cap. */
  unpriced: string[];
  durationMs: number;
}

export interface DiscoveryOptions {
  /** The user's own key for a provider, or null when the session has none. */
  keyFor: (provider: DiscoverableProvider) => string | null;
  force?: boolean;
  fetchImpl?: typeof fetch;
}

let current: Promise<DiscoveryReport> | null = null;
let state: 'idle' | 'running' | 'done' = 'idle';
let last: DiscoveryReport | null = null;

export function discoveryState(): 'idle' | 'running' | 'done' {
  return state;
}

export function discoveryReport(): DiscoveryReport | null {
  return last;
}

export function discoverModels(opts: DiscoveryOptions): Promise<DiscoveryReport> {
  if (current && !opts.force) return current;
  state = 'running';
  const run = runDiscovery(opts).then(
    (report) => {
      last = report;
      state = 'done';
      return report;
    },
    (err: unknown) => {
      state = 'done';
      throw err;
    },
  );
  current = run;
  return run;
}

/** Test hook: forget the run and the overlays it installed. */
export function resetDiscovery(): void {
  current = null;
  state = 'idle';
  last = null;
  for (const provider of DISCOVERABLE) {
    setDiscoveredModels(provider, null);
    setDiscoveredRates(provider, null);
  }
}

async function runDiscovery(opts: DiscoveryOptions): Promise<DiscoveryReport> {
  const started = Date.now();
  const listOpts = { force: opts.force, fetchImpl: opts.fetchImpl };
  const results: DiscoveryProviderResult[] = [];
  const lists = new Map<DiscoverableProvider, DiscoveredModel[]>();
  await Promise.all(
    DISCOVERABLE.map(async (provider) => {
      // OpenRouter's list is public, so it is always loaded: the picker offers
      // the whole marketplace (a key is still needed to use a model) and the
      // list prices other providers' models the bundled table lacks.
      const key = opts.keyFor(provider) ?? (provider === 'openrouter' ? '' : null);
      if (key === null) {
        results.push({ provider, source: 'no-key', count: 0 });
        return;
      }
      const got = await loadProviderList(provider, key, listOpts);
      results.push({ provider, source: got.source, count: got.models.length, ageMs: got.ageMs });
      if (got.source !== 'failed') lists.set(provider, got.models);
    }),
  );

  // OpenRouter as the price oracle for models with neither a provider price
  // nor a bundled family price.
  const oracle: PriceOracle = oracleFrom(lists.get('openrouter') ?? []);

  const unpriced: string[] = [];
  for (const provider of DISCOVERABLE) {
    const models = lists.get(provider);
    if (!models) continue;
    const { infos, rates, unpriced: u } = toModelInfos(provider, sortModelIds(models), oracle);
    setDiscoveredModels(provider, infos);
    setDiscoveredRates(provider, rates);
    unpriced.push(...u.map((id) => `${provider}/${id}`));
  }
  results.sort((a, b) => DISCOVERABLE.indexOf(a.provider) - DISCOVERABLE.indexOf(b.provider));
  return { providers: results, unpriced, durationMs: Date.now() - started };
}

// ---------------------------------------------------------------------------

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>>) : [];
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
/** xAI prices are integers in 1/10,000 USD per million tokens (20000 → $2/M). */
function xaiPrice(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n / 10_000 : undefined;
}
/** OpenRouter prices are USD per token as strings → USD per million. */
function perToken(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined;
}
