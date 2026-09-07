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

// Mask (clear) old tool outputs at this earlier fraction — the cheap tier of
// context management. Evidence ("The Complexity Trap", arXiv 2508.21433):
// simply dropping stale tool outputs matches LLM summarization on solve rate
// at a fraction of the cost — an old file-read is re-fetchable any time, the
// conversation's decisions are what matter. The gap between 0.6 and 0.8 is
// deliberate: masking usually holds the line so the expensive LLM compaction
// rarely fires.
export const MASK_THRESHOLD = 0.6;

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

// True when the live context is large enough that old tool outputs should be
// cleared (the cheap first tier, before full compaction).
export function shouldMaskObservations(inputTokens: number, provider: string, model: string): boolean {
  if (inputTokens <= 0) return false;
  return inputTokens >= contextWindowFor(provider, model) * MASK_THRESHOLD;
}

// Output-token cap for agent calls. Providers default to 8192 when the
// request doesn't say otherwise, which truncates large single-file writes
// (a real failure mode on big edits). Family heuristic, conservative for
// providers whose per-model output limits vary by route (openrouter).
const MAX_OUTPUT: Array<{ match: RegExp; tokens: number }> = [
  { match: /claude/i, tokens: 32_000 },
  { match: /^(openai\/)?o\d/i, tokens: 32_000 }, // o-series: cap includes reasoning tokens
  { match: /gpt-5/i, tokens: 32_000 },
  { match: /gpt-4\.1/i, tokens: 32_000 },
  { match: /gemini-2\.5|gemini-3/i, tokens: 32_000 },
  { match: /grok/i, tokens: 16_384 },
];

const DEFAULT_MAX_OUTPUT = 16_384;

// Above this, a runaway answer costs more than it is worth even when the model
// allows it; the catalog value is honored up to here.
const MAX_OUTPUT_CEILING = 64_000;

export function defaultMaxOutputTokens(model: string, provider?: string): number {
  // The catalog knows the real per-model limit; the family table is the
  // fallback for bundled BYOK models.
  if (provider) {
    const known = findModel(provider, model);
    if (known?.maxOutputTokens) return Math.min(known.maxOutputTokens, MAX_OUTPUT_CEILING);
  }
  for (const m of MAX_OUTPUT) {
    if (m.match.test(model)) return m.tokens;
  }
  return DEFAULT_MAX_OUTPUT;
}
