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
    'claude-opus-4-7': { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
    'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
    'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
    'claude-opus-4': { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
    'claude-sonnet-4': { inputPerM: 3, outputPerM: 15 },
    'claude-haiku-4': { inputPerM: 1, outputPerM: 5 },
  },
  xai: {
    'grok-code-fast-1': { inputPerM: 0.2, outputPerM: 1.5 },
    'grok-4-fast': { inputPerM: 0.5, outputPerM: 2.0 },
    'grok-4': { inputPerM: 3.0, outputPerM: 15.0 },
  },
  openai: {
    'gpt-5.1': { inputPerM: 5, outputPerM: 20 },
    'gpt-5': { inputPerM: 5, outputPerM: 20 },
    'gpt-4.1': { inputPerM: 2.5, outputPerM: 10 },
    'o3': { inputPerM: 15, outputPerM: 60 },
    'o4-mini': { inputPerM: 1.1, outputPerM: 4.4 },
  },
  openrouter: {
    // Routes to whatever upstream; pricing varies. Use a conservative midrange
    // default if no match. Specific routes resolve via prefix match if user
    // sets a model like "anthropic/claude-opus-4-7".
    'anthropic/claude-opus-4-7': { inputPerM: 15, outputPerM: 75 },
    'openai/gpt-5.1': { inputPerM: 5, outputPerM: 20 },
    'meta-llama/llama-3.3-70b': { inputPerM: 0.4, outputPerM: 0.6 },
  },
};

export function rateFor(provider: string, model: string): ModelRate | null {
  const providerRates = RATES[provider];
  if (!providerRates) return null;
  // Longest matching prefix wins so e.g. "claude-opus-4-7-20251001" picks the
  // 4-7 row, not the bare "claude-opus-4" row.
  let best: { key: string; rate: ModelRate } | null = null;
  for (const [key, rate] of Object.entries(providerRates)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, rate };
    }
  }
  return best ? best.rate : null;
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
