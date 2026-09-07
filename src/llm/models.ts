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
import type { EffortLevel, ThinkingRequest } from './types.js';

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
  /** Accepts image input (catalog `vision`). */
  vision?: boolean;
  /** Largest `max_tokens` the model accepts (catalog `max_output_tokens`). */
  maxOutputTokens?: number;
  /** Supports tool calling (catalog `tools`); undefined = assume yes. */
  supportsTools?: boolean;
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

  // openrouter — the unified `reasoning: { effort }` param reaches these upstreams.
  'anthropic/claude-opus-4-7':  { label: 'OpenRouter → Claude Opus 4.7',     notes: 'frontier via OR', thinking: true },
  'openai/gpt-5.1':              { label: 'OpenRouter → GPT-5.1',             notes: 'frontier via OR', thinking: true },
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
        vision: entry.vision === true,
        maxOutputTokens: typeof entry.max_output_tokens === 'number' && entry.max_output_tokens > 0 ? entry.max_output_tokens : undefined,
        supportsTools: entry.tools !== false,
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

/** Capability badges for pickers: "200k ctx", "think", "vision". */
export function modelBadges(m: ModelInfo): string[] {
  const out: string[] = [];
  if (m.contextWindow) out.push(`${Math.round(m.contextWindow / 1000)}k ctx`);
  if (m.supportsThinking) out.push('think');
  if (m.vision) out.push('vision');
  return out;
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

// The model a fresh session gets for a provider. Prefer the catalog when it
// is loaded so proxy users get a model that exists there: the hardcoded
// preference when the catalog lists it, else the catalog's first entry for
// the provider, else the hardcoded name.
export function defaultModelFor(provider: string): string {
  const hardcoded = hardcodedDefaultModelFor(provider);
  if (findModel(provider, hardcoded)) return hardcoded;
  for (const m of getKnownModels()) {
    if (m.provider === provider) return m.model;
  }
  return hardcoded;
}

function hardcodedDefaultModelFor(provider: string): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-opus-4-7';
    case 'xai':
      return 'grok-code-fast-1';
    case 'openai':
      return 'gpt-5.1';
    case 'google':
      return 'gemini-2.5-pro';
    case 'openrouter':
      return 'anthropic/claude-opus-4-7';
    default:
      return 'claude-opus-4-7';
  }
}

// Default extended-thinking budget when the catalog doesn't recommend one.
// Anthropic's floor is 1024; 8K is enough for multi-step code reasoning
// without dominating the output budget.
const DEFAULT_THINKING_BUDGET = 8_192;

// ── Effort policy ────────────────────────────────────────────────────────────
// One setting, per session (and remembered per model): how hard the model
// thinks. 'auto' = the provider's recommended default for the model, 'off' =
// no thinking request, or an explicit level. Resolved into a ThinkingRequest
// by thinkingFor(); each provider maps that natively.

export type EffortSetting = 'auto' | 'off' | EffortLevel;
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'max'];
export const EFFORT_SETTINGS: readonly EffortSetting[] = ['auto', 'off', ...EFFORT_LEVELS];

/** Token budgets an effort level maps to on providers that take a budget. */
export const EFFORT_BUDGETS: Record<EffortLevel, number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  max: 32_768,
};

export function parseEffortSetting(raw: string | undefined | null): EffortSetting | null {
  const v = (raw ?? '').trim().toLowerCase();
  return (EFFORT_SETTINGS as readonly string[]).includes(v) ? (v as EffortSetting) : null;
}

// Anthropic's modern request shape (Opus 4.7+, Sonnet 5, Opus 5, Fable/Mythos 5):
// no sampling params, adaptive thinking, effort via output_config. Prefix
// match so dated variants (claude-opus-4-7-20251001) and an `anthropic/`
// prefix still resolve. Shared with AnthropicProvider.
const MODERN_ANTHROPIC_SHAPE = /^(?:anthropic\/)?claude-(?:fable-5|mythos-5|opus-5|opus-4-8|opus-4-7|sonnet-5)\b/;

export function isModernAnthropicShape(model: string): boolean {
  return MODERN_ANTHROPIC_SHAPE.test(model.trim());
}

// Gemini thinking is armed: GeminiProvider replays thoughtSignatures on the
// parts they arrived with, which is what keeps tool use working with thoughts on.
const GEMINI_THINKING_ARMED = true;

// Resolve whether (and how) to arm extended thinking for a model. Returns
// undefined when the model has no thinking param, when the user turned it
// off (`/effort off`, AUTOCODE_NO_THINKING=1), or for providers whose echo
// path can't sustain it yet. This is what AgentLoop passes as
// CompletionRequest.thinking.
export function thinkingFor(
  provider: string,
  model: string,
  setting: EffortSetting = 'auto',
): ThinkingRequest | undefined {
  if (process.env.AUTOCODE_NO_THINKING === '1' || setting === 'off') return undefined;
  const level: EffortLevel | null = setting === 'auto' ? null : setting;
  const m = findModel(provider, model);
  switch (provider) {
    case 'anthropic': {
      // Modern shape: adaptive thinking paces itself; effort is the knob.
      if (isModernAnthropicShape(model)) return { mode: 'effort', effort: level ?? 'high' };
      if (!m?.supportsThinking) return undefined;
      return {
        mode: 'budget',
        budgetTokens: level ? EFFORT_BUDGETS[level] : (m.thinkingBudgetDefault ?? DEFAULT_THINKING_BUDGET),
      };
    }
    case 'openai':
      if (!m?.supportsThinking) return undefined;
      return { mode: 'effort', effort: level ?? 'medium', summary: true };
    case 'google': {
      if (!GEMINI_THINKING_ARMED) return undefined;
      if (/^gemini-3/.test(model)) return { mode: 'effort', effort: level ?? 'high', summary: true };
      if (/^gemini-2\.5/.test(model)) {
        return {
          mode: 'budget',
          budgetTokens: level ? EFFORT_BUDGETS[level] : (m?.thinkingBudgetDefault ?? DEFAULT_THINKING_BUDGET),
          summary: true,
        };
      }
      return undefined;
    }
    case 'xai':
    case 'openrouter':
      if (!m?.supportsThinking) return undefined;
      return { mode: 'effort', effort: level ?? 'medium' };
    default:
      return undefined;
  }
}

/** Short label for the status line and `/effort`: "high effort", "8k budget", or null. */
export function describeThinking(t: ThinkingRequest | undefined): string | null {
  if (!t) return null;
  if (t.mode === 'effort') return `${t.effort ?? 'medium'} effort`;
  const b = t.budgetTokens ?? 0;
  return b >= 1000 ? `${Math.round(b / 1024)}k budget` : `${b} budget`;
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
