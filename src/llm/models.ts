// Single source of truth for "models autocode knows about." Two layers:
//
//  1) KNOWN_MODELS_FALLBACK: hardcoded list built from pricing.RATES +
//     EXTRA_METADATA. Used standalone (no proxy token) so the open-source
//     CLI works out of the box with BYO keys.
//  2) Proxy overlay: when running inside Automax (AUTOMAX_PROXY_TOKEN set),
//     cli.ts calls setProxyCatalog() with the live /v1/catalog payload. The
//     overlay then replaces the fallback as the catalog source. Models with
//     status "deprecated" or "model_not_verified" are filtered out.
//
// The picker reads via getKnownModels(); cost tracking reads from pricing.ts
// (which has its own setProxyRates() overlay). Adding a new bundled model
// is still a one-stop edit: append to RATES in pricing.ts AND drop a line
// in EXTRA_METADATA below.

import { RATES } from '../util/pricing.js';
import type { FullCatalog } from './CatalogClient.js';

export interface ModelInfo {
  provider: string;
  model: string;
  label: string;       // e.g. "Claude Sonnet 4.6"
  notes?: string;      // e.g. "balanced default" — shown in picker
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  /** Max context window in tokens, when known. Populated from the proxy
   *  catalog; undefined for bundled BYOK models (callers fall back to a
   *  family heuristic in contextWindow.ts). */
  contextWindow?: number;
}

export type ModelCatalogSource = 'bundled' | 'proxy';

// Friendly labels + tags per model. Keys must match a model prefix in
// RATES (or a catalog id). Missing entries fall back to the raw model id
// as the label.
const EXTRA_METADATA: Record<string, { label: string; notes?: string }> = {
  // anthropic
  'claude-opus-4-7':  { label: 'Claude Opus 4.7',   notes: 'frontier · highest quality' },
  'claude-sonnet-4-6': { label: 'Claude Sonnet 4.6', notes: 'balanced default · great for code' },
  'claude-haiku-4-5': { label: 'Claude Haiku 4.5',  notes: 'cheap & fast' },
  'claude-opus-4':    { label: 'Claude Opus 4',     notes: 'prior frontier' },
  'claude-sonnet-4':  { label: 'Claude Sonnet 4',   notes: 'prior balanced' },
  'claude-haiku-4':   { label: 'Claude Haiku 4',    notes: 'prior cheap & fast' },

  // xai
  'grok-code-fast-1': { label: 'Grok Code Fast 1',  notes: 'budget tier · coding-tuned (current default)' },
  'grok-4-fast':      { label: 'Grok 4 Fast',       notes: 'mid-tier' },
  'grok-4':           { label: 'Grok 4',            notes: 'frontier' },

  // openai
  'gpt-5.1':  { label: 'GPT-5.1',  notes: 'frontier' },
  'gpt-5':    { label: 'GPT-5',    notes: 'frontier' },
  'gpt-4.1':  { label: 'GPT-4.1',  notes: 'mid-tier' },
  'o3':       { label: 'o3',       notes: 'reasoning · slow & expensive' },
  'o4-mini':  { label: 'o4-mini',  notes: 'reasoning · cheaper' },

  // openrouter
  'anthropic/claude-opus-4-7':  { label: 'OpenRouter → Claude Opus 4.7',     notes: 'frontier via OR' },
  'openai/gpt-5.1':              { label: 'OpenRouter → GPT-5.1',             notes: 'frontier via OR' },
  'meta-llama/llama-3.3-70b':    { label: 'OpenRouter → Llama 3.3 70B',       notes: 'open-weights · very cheap' },
};

// Flatten RATES into a typed catalog. Order preserved from RATES so the
// picker shows providers in a sensible order.
export const KNOWN_MODELS_FALLBACK: ModelInfo[] = (() => {
  const out: ModelInfo[] = [];
  for (const [provider, models] of Object.entries(RATES)) {
    for (const [model, rate] of Object.entries(models)) {
      const meta = EXTRA_METADATA[model] ?? { label: model };
      out.push({
        provider,
        model,
        label: meta.label,
        notes: meta.notes,
        inputPerM: rate.inputPerM,
        outputPerM: rate.outputPerM,
        cacheReadPerM: rate.cacheReadPerM,
      });
    }
  }
  return out;
})();

// Mutable overlay populated at startup by cli.ts when running inside
// Automax. When non-null, getKnownModels() returns this list instead of
// the fallback.
let proxyOverlay: ModelInfo[] | null = null;

// Longest-prefix match against EXTRA_METADATA so e.g. catalog id
// "claude-opus-4-7-20251001" still picks up the "claude-opus-4-7" label.
function labelFor(modelId: string): { label: string; notes?: string } {
  let best: { key: string; meta: { label: string; notes?: string } } | null = null;
  for (const [key, meta] of Object.entries(EXTRA_METADATA)) {
    if (modelId.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, meta };
    }
  }
  return best ? best.meta : { label: modelId };
}

// Called by cli.ts at startup. Pass null to clear the overlay (back to
// fallback). Entries with status "deprecated" or "model_not_verified" are
// dropped so the picker only shows usable models.
export function setProxyCatalog(catalog: FullCatalog | null): void {
  if (catalog === null) {
    proxyOverlay = null;
    return;
  }
  const out: ModelInfo[] = [];
  for (const [provider, providerCatalog] of Object.entries(catalog.providers)) {
    for (const entry of providerCatalog.models) {
      if (entry.status === 'deprecated' || entry.status === 'model_not_verified') continue;
      const meta = labelFor(entry.id);
      const inputPerM = entry.input_price_per_million;
      const outputPerM = entry.output_price_per_million;
      const cacheReadPerM =
        entry.supports_caching && typeof entry.cache_read_multiplier === 'number'
          ? inputPerM * entry.cache_read_multiplier
          : undefined;
      out.push({
        provider,
        model: entry.id,
        label: meta.label,
        notes: meta.notes,
        inputPerM,
        outputPerM,
        cacheReadPerM,
        contextWindow: entry.context_window,
      });
    }
  }
  proxyOverlay = out;
}

// True when the proxy overlay is the active source.
export function modelCatalogSource(): ModelCatalogSource {
  return proxyOverlay ? 'proxy' : 'bundled';
}

export function getKnownModels(): ModelInfo[] {
  return proxyOverlay ?? KNOWN_MODELS_FALLBACK;
}

export function getKnownProviders(): string[] {
  return Array.from(new Set(getKnownModels().map((m) => m.provider)));
}

// Lookup helper: returns the catalog entry matching a (provider, model)
// pair via the same longest-prefix-wins rule pricing uses.
export function findModel(provider: string, model: string): ModelInfo | null {
  let best: ModelInfo | null = null;
  for (const m of getKnownModels()) {
    if (m.provider !== provider) continue;
    if (model.startsWith(m.model) && (!best || m.model.length > best.model.length)) {
      best = m;
    }
  }
  return best;
}
