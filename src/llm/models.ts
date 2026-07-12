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
  /** Model accepts an explicit extended-thinking/reasoning request param.
   *  False/undefined for models that either don't reason or reason
   *  unconditionally with no param (e.g. grok-code-fast). */
  supportsThinking?: boolean;
  /** Provider-recommended thinking budget (tokens), when the catalog has one. */
  thinkingBudgetDefault?: number | null;
}

export type ModelCatalogSource = 'bundled' | 'proxy';

// Friendly labels + tags per model. Keys must match a model prefix in
// RATES (or a catalog id). Missing entries fall back to the raw model id
// as the label.
const EXTRA_METADATA: Record<string, { label: string; notes?: string; thinking?: boolean }> = {
  // anthropic — the Claude 4 family accepts the extended-thinking param.
  'claude-opus-4-7':  { label: 'Claude Opus 4.7',   notes: 'frontier · highest quality', thinking: true },
  'claude-sonnet-4-6': { label: 'Claude Sonnet 4.6', notes: 'balanced default · great for code', thinking: true },
  'claude-haiku-4-5': { label: 'Claude Haiku 4.5',  notes: 'cheap & fast', thinking: true },
  'claude-opus-4':    { label: 'Claude Opus 4',     notes: 'prior frontier', thinking: true },
  'claude-sonnet-4':  { label: 'Claude Sonnet 4',   notes: 'prior balanced', thinking: true },
  'claude-haiku-4':   { label: 'Claude Haiku 4',    notes: 'prior cheap & fast' },

  // xai — grok reasoning models reason unconditionally; there is no request
  // param to arm (they return reasoning_content on their own).
  'grok-code-fast-1': { label: 'Grok Code Fast 1',  notes: 'budget tier · coding-tuned (current default)' },
  'grok-4-fast':      { label: 'Grok 4 Fast',       notes: 'mid-tier' },
  'grok-4':           { label: 'Grok 4',            notes: 'frontier' },

  // openai — o-series and the gpt-5 family accept reasoning_effort.
  'gpt-5.1':  { label: 'GPT-5.1',  notes: 'frontier', thinking: true },
  'gpt-5':    { label: 'GPT-5',    notes: 'frontier', thinking: true },
  'gpt-4.1':  { label: 'GPT-4.1',  notes: 'mid-tier' },
  'o3':       { label: 'o3',       notes: 'reasoning · slow & expensive', thinking: true },
  'o4-mini':  { label: 'o4-mini',  notes: 'reasoning · cheaper', thinking: true },

  // openrouter — reasoning params are route-specific; leave unarmed.
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
        supportsThinking: meta.thinking === true,
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
        supportsThinking: entry.supports_thinking === true,
        thinkingBudgetDefault: entry.thinking_budget_default,
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

// Cheap same-provider models for internal summarization work (compaction,
// reflection). Summarizing a long transcript with the flagship session model
// is pure waste — the summary quality difference is negligible. Falls back
// to the session model when the provider has no cheaper bundled option
// (the user's key always works for their own provider).
const CHEAP_SUMMARIZER: Record<string, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4.1',
  xai: 'grok-code-fast-1',
};

export function summarizerModelFor(provider: string, sessionModel: string): string {
  return CHEAP_SUMMARIZER[provider] ?? sessionModel;
}

// Default extended-thinking budget when the catalog doesn't recommend one.
// Anthropic's floor is 1024; 8K is enough for multi-step code reasoning
// without dominating the output budget.
const DEFAULT_THINKING_BUDGET = 8_192;

// Resolve whether (and how) to arm extended thinking for a model. Returns
// undefined when the model has no thinking param, when the user disabled it
// (AUTOCODE_NO_THINKING=1), or for providers whose echo path can't sustain
// it yet. This is what AgentLoop passes as CompletionRequest.thinking.
export function thinkingFor(provider: string, model: string): { budgetTokens: number } | undefined {
  if (process.env.AUTOCODE_NO_THINKING === '1') return undefined;
  // Gemini: enabling thinkingConfig without re-attaching thoughtSignature on
  // function calls breaks tool-use continuity — deferred until the outbound
  // pairing pass exists (see GeminiProvider's thinking comment).
  if (provider === 'google') return undefined;
  const m = findModel(provider, model);
  if (!m?.supportsThinking) return undefined;
  return { budgetTokens: m.thinkingBudgetDefault ?? DEFAULT_THINKING_BUDGET };
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
