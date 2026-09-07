// Per-million-token rates in USD as of 2026-05-19. Comment dates are
// last-checked; update periodically as providers change pricing.
//
// Refs (all public, last verified May 2026):
// - https://docs.anthropic.com/en/docs/about-claude/models
// - https://platform.openai.com/docs/pricing
// - https://docs.x.ai/docs/models
// - https://openrouter.ai/models

import type { CompletionResponse } from '../llm/types.js';

export interface ModelRate {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
}

// Provider → model-prefix → rate. We use startsWith matching so suffixes
// (e.g. "-20251001") still resolve. Newest matching entry wins.
// Exported so `src/llm/models.ts` can build its KNOWN_MODELS catalog from
// the same source, no duplication.
export const RATES: Record<string, Record<string, ModelRate>> = {
  anthropic: {
    // The 5-generation and Opus 4.8 (prices as the Automax catalog reported
    // them on 2026-09-07; Opus has been $5 / $25 since 4.5).
    'claude-fable-5-1': { inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWritePerM: 12.5 },
    'claude-fable-5': { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5 },
    'claude-opus-5': { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
    'claude-sonnet-5': { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 },
    'claude-opus-4-8': { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
    'claude-opus-4-7': { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
    'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
    'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
    'claude-opus-4': { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
    'claude-sonnet-4': { inputPerM: 3, outputPerM: 15 },
    'claude-haiku-4': { inputPerM: 1, outputPerM: 5 },
  },
  xai: {
    // As xAI's /v1/language-models reported on 2026-09-07 (that list prices
    // in 1/10,000 USD per million tokens). grok-code-fast-1 is now an alias
    // of grok-build-0.1 and bills at its rate; grok-4 and grok-4-fast are no
    // longer listed (rows kept for old configs).
    'grok-build': { inputPerM: 1, outputPerM: 2, cacheReadPerM: 0.2 },
    'grok-code-fast-1': { inputPerM: 1, outputPerM: 2, cacheReadPerM: 0.2 },
    'grok-4.6': { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.5 },
    'grok-4.5': { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.3 },
    'grok-4.3': { inputPerM: 1.25, outputPerM: 2.5, cacheReadPerM: 0.2 },
    'grok-4.20': { inputPerM: 1.25, outputPerM: 2.5, cacheReadPerM: 0.2 },
    'grok-4-fast': { inputPerM: 0.5, outputPerM: 2.0 },
    'grok-4': { inputPerM: 1.25, outputPerM: 2.5, cacheReadPerM: 0.3125 },
  },
  openai: {
    // platform.openai.com/docs/pricing (GPT-5 family: $1.25 / $10, cached input
    // $0.125; o3 and gpt-4.1 after the 2025 price cuts). The old $5 / $20 rows
    // overstated a gpt-5.1 turn ~4× and tripped cost caps that real spend never reached.
    // gpt-6-astra: OpenRouter's listing on 2026-09-07 (the Automax catalog
    // carries no price for it yet).
    'gpt-6-astra': { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1 },
    'gpt-5.6-sol': { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.4 },
    'gpt-5.6-terra': { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2 },
    'gpt-5.6-luna': { inputPerM: 0.2, outputPerM: 1.2, cacheReadPerM: 0.02 },
    'gpt-5.5': { inputPerM: 5, outputPerM: 30, cacheReadPerM: 0.5 },
    'gpt-5.4-mini': { inputPerM: 0.75, outputPerM: 4.5, cacheReadPerM: 0.075 },
    'gpt-5.4-nano': { inputPerM: 0.2, outputPerM: 1.25, cacheReadPerM: 0.02 },
    'gpt-5.4': { inputPerM: 2.5, outputPerM: 15, cacheReadPerM: 0.25 },
    'gpt-5.2': { inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
    'gpt-5.1': { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
    'gpt-5-nano': { inputPerM: 0.05, outputPerM: 0.4, cacheReadPerM: 0.005 },
    'gpt-5': { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
    'gpt-5-mini': { inputPerM: 0.25, outputPerM: 2, cacheReadPerM: 0.025 },
    'gpt-4.1': { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5 },
    'o3': { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5 },
    'o4-mini': { inputPerM: 1.1, outputPerM: 4.4, cacheReadPerM: 0.275 },
  },
  openrouter: {
    // Routes to whatever upstream; pricing varies. Use a conservative midrange
    // default if no match. Specific routes resolve via prefix match if user
    // sets a model like "anthropic/claude-opus-4-7".
    'anthropic/claude-opus-4-7': { inputPerM: 15, outputPerM: 75 },
    'openai/gpt-5.1': { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
    'meta-llama/llama-3.3-70b': { inputPerM: 0.4, outputPerM: 0.6 },
  },
};

// Overlay populated at startup from the proxy's /v1/catalog when running
// inside Automax. Replaces the bundled RATES for cost math whenever a
// provider+model is present here; falls through to RATES otherwise so the
// open-source standalone path keeps working unchanged.
let proxyRateOverlay: Record<string, Record<string, ModelRate>> | null = null;

export interface ProxyRatesCatalog {
  providers: Record<
    string,
    {
      models: Array<{
        id: string;
        input_price_per_million: number;
        output_price_per_million: number;
        supports_caching?: boolean;
        cache_read_multiplier?: number;
        cache_write_multiplier?: number;
      }>;
    }
  >;
}

export function setProxyRates(catalog: ProxyRatesCatalog | null): void {
  if (catalog === null) {
    proxyRateOverlay = null;
    return;
  }
  const overlay: Record<string, Record<string, ModelRate>> = {};
  for (const [provider, providerCatalog] of Object.entries(catalog.providers)) {
    overlay[provider] = {};
    for (const entry of providerCatalog.models) {
      const inputPerM = entry.input_price_per_million;
      const outputPerM = entry.output_price_per_million;
      const rate: ModelRate = { inputPerM, outputPerM };
      // Cache pricing in the catalog is expressed as a multiplier on
      // inputPerMtok. estimateCost wants absolute per-M rates, so we
      // pre-multiply here.
      if (entry.supports_caching && typeof entry.cache_read_multiplier === 'number') {
        rate.cacheReadPerM = inputPerM * entry.cache_read_multiplier;
      }
      if (entry.supports_caching && typeof entry.cache_write_multiplier === 'number') {
        rate.cacheWritePerM = inputPerM * entry.cache_write_multiplier;
      }
      overlay[provider]![entry.id] = rate;
    }
  }
  proxyRateOverlay = overlay;
}

// Overlay populated by llm/ProviderDiscovery.ts with the prices the providers
// publish for the models they list (BYOK sessions). Consulted after the proxy
// overlay and before the bundled table.
const discoveredRateOverlay: Record<string, Record<string, ModelRate>> = {};

export function setDiscoveredRates(provider: string, rates: Record<string, ModelRate> | null): void {
  if (rates === null) delete discoveredRateOverlay[provider];
  else discoveredRateOverlay[provider] = rates;
}

// Longest matching prefix wins so e.g. "claude-opus-4-7-20251001" picks the
// 4-7 row, not the bare "claude-opus-4" row. `strict` also requires the id to
// continue at a family boundary ("-" or ":") after the key, so "gpt-5.3-codex"
// does not pass as "gpt-5".
function bestPrefix(table: Record<string, ModelRate> | undefined, model: string, strict = false): ModelRate | null {
  if (!table) return null;
  let best: { key: string; rate: ModelRate } | null = null;
  for (const [key, rate] of Object.entries(table)) {
    if (!model.startsWith(key)) continue;
    if (strict && model.length > key.length && model[key.length] !== '-' && model[key.length] !== ':') continue;
    if (!best || key.length > best.key.length) best = { key, rate };
  }
  return best ? best.rate : null;
}

export function rateFor(provider: string, model: string): ModelRate | null {
  // Proxy overlay wins, then the providers' own lists, then the bundled table.
  return (
    bestPrefix(proxyRateOverlay?.[provider], model) ??
    bestPrefix(discoveredRateOverlay[provider], model) ??
    bestPrefix(RATES[provider], model)
  );
}

/** The bundled table alone (no overlays); `strict` applies the family-boundary rule. */
export function bundledRateFor(provider: string, model: string, strict = false): ModelRate | null {
  return bestPrefix(RATES[provider], model, strict);
}

export function estimateCost(
  usage: CompletionResponse['usage'],
  provider: string,
  model: string,
): { cost: number; rate: ModelRate | null } {
  const rate = rateFor(provider, model);
  if (!rate) return { cost: 0, rate: null };
  // Anthropic's input_tokens already EXCLUDES the cached read portion when caching is in use,
  // so we sum cached + non-cached input separately.
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const freshInput = Math.max(0, usage.inputTokens);
  let total =
    (freshInput / 1_000_000) * rate.inputPerM +
    (usage.outputTokens / 1_000_000) * rate.outputPerM;
  if (cacheRead > 0 && rate.cacheReadPerM !== undefined) {
    total += (cacheRead / 1_000_000) * rate.cacheReadPerM;
  }
  if (cacheWrite > 0 && rate.cacheWritePerM !== undefined) {
    total += (cacheWrite / 1_000_000) * rate.cacheWritePerM;
  }
  return { cost: total, rate };
}

export function formatUsd(amount: number): string {
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
