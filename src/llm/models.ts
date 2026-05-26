// Single source of truth for "models autocode knows about." Built on top
// of the pricing table in `src/util/pricing.ts` (the existing per-model
// rate data) plus a small layer of UI metadata (friendly label, short
// notes). The picker in `src/repl/ink/components/ModelPicker.tsx` reads
// from this; the cost line reads from pricing directly.
//
// Adding a new model is a one-stop edit: append to RATES in pricing.ts
// AND drop a line in EXTRA_METADATA below. Picker + cost both pick it up.

import { RATES } from '../util/pricing.js';

export interface ModelInfo {
  provider: string;
  model: string;
  label: string;       // e.g. "Claude Sonnet 4.6"
  notes?: string;      // e.g. "balanced default" — shown in picker
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
}

// Friendly labels + tags per model. Keys must match a model prefix in
// RATES. Missing entries fall back to the raw model id as the label.
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

// Flatten RATES into a typed catalog. Order preserved from RATES so
// the picker shows providers in a sensible order.
export const KNOWN_MODELS: ModelInfo[] = (() => {
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

// All providers represented in the catalog, in catalog order.
export const KNOWN_PROVIDERS: string[] = Array.from(
  new Set(KNOWN_MODELS.map((m) => m.provider)),
);

// Lookup helper: returns the catalog entry matching a (provider, model)
// pair via the same longest-prefix-wins rule pricing uses.
export function findModel(provider: string, model: string): ModelInfo | null {
  let best: ModelInfo | null = null;
  for (const m of KNOWN_MODELS) {
    if (m.provider !== provider) continue;
    if (model.startsWith(m.model) && (!best || m.model.length > best.model.length)) {
      best = m;
    }
  }
  return best;
}
