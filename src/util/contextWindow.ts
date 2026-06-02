import { findModel } from '../llm/models.js';

// Family heuristic for models the catalog doesn't cover (BYOK / offline).
// Exact values matter less than triggering compaction before the real limit.
// The explicit long-context rule comes first so a 1M variant id (e.g.
// "claude-opus-4-8[1m]" or "...-1m") wins over its base-family entry.
const WINDOWS: Array<{ match: RegExp; tokens: number }> = [
  { match: /\[1m\]|[-:]1m\b/i, tokens: 1_000_000 },
  { match: /claude-opus-4/i, tokens: 200_000 },
  { match: /claude/i, tokens: 200_000 },
  { match: /grok/i, tokens: 200_000 },
  { match: /gpt-5/i, tokens: 200_000 },
  { match: /gpt-4/i, tokens: 128_000 },
  { match: /gemini/i, tokens: 1_000_000 },
];

const DEFAULT_WINDOW = 128_000;

// Auto-compact once the live context reaches this fraction of the window.
export const AUTO_COMPACT_THRESHOLD = 0.8;

export function contextWindowFor(provider: string, model: string): number {
  // Authoritative: the proxy catalog reports an exact context_window per
  // model. Fall back to the family heuristic for models it doesn't cover.
  const known = findModel(provider, model)?.contextWindow;
  if (known && known > 0) return known;
  for (const w of WINDOWS) {
    if (w.match.test(model)) return w.tokens;
  }
  return DEFAULT_WINDOW;
}

// True when a turn whose input was `inputTokens` has filled enough of the
// model's window that the conversation should be compacted.
export function shouldAutoCompact(inputTokens: number, provider: string, model: string): boolean {
  if (inputTokens <= 0) return false;
  return inputTokens >= contextWindowFor(provider, model) * AUTO_COMPACT_THRESHOLD;
}
