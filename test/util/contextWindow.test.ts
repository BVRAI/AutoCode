import { describe, it, expect, afterEach } from 'vitest';
import {
  contextWindowFor,
  shouldAutoCompact,
  AUTO_COMPACT_THRESHOLD,
} from '../../src/util/contextWindow.js';
import { setProxyCatalog } from '../../src/llm/models.js';
import type { CatalogEntry, FullCatalog } from '../../src/llm/CatalogClient.js';

describe('contextWindow', () => {
  it('returns model-family window sizes', () => {
    expect(contextWindowFor('xai', 'grok-code-fast-1')).toBe(200_000);
    expect(contextWindowFor('anthropic', 'claude-opus-4-7')).toBe(200_000);
    expect(contextWindowFor('google', 'gemini-2.5-pro')).toBe(1_000_000);
  });

  it('falls back to a default for unknown models', () => {
    expect(contextWindowFor('x', 'mystery-model')).toBe(128_000);
  });

  it('shouldAutoCompact triggers at or above the threshold', () => {
    const w = contextWindowFor('xai', 'grok-code-fast-1');
    expect(shouldAutoCompact(Math.ceil(w * AUTO_COMPACT_THRESHOLD), 'xai', 'grok-code-fast-1')).toBe(true);
    expect(shouldAutoCompact(w, 'xai', 'grok-code-fast-1')).toBe(true);
  });

  it('shouldAutoCompact is false well below the threshold', () => {
    expect(shouldAutoCompact(50_000, 'xai', 'grok-code-fast-1')).toBe(false);
  });

  it('shouldAutoCompact is false for zero input tokens', () => {
    expect(shouldAutoCompact(0, 'xai', 'grok-code-fast-1')).toBe(false);
  });
});

// Helper: a minimal catalog entry carrying just the fields setProxyCatalog
// reads (status must not be deprecated/model_not_verified or it's filtered).
function catalogEntry(id: string, contextWindow: number): CatalogEntry {
  return {
    id,
    input_price_per_million: 1,
    output_price_per_million: 1,
    status: 'pricing_stale',
    last_verified_at: '',
    last_priced_at: '',
    supports_thinking: false,
    thinking_budget_default: null,
    max_output_tokens: 8192,
    context_window: contextWindow,
    vision: false,
    tools: true,
    supports_caching: false,
    max_cache_breakpoints: 0,
    cache_read_multiplier: 0,
    cache_write_multiplier: 0,
  };
}

describe('contextWindowFor — catalog-backed', () => {
  afterEach(() => setProxyCatalog(null)); // reset overlay back to the bundled fallback

  it('prefers the proxy catalog context_window over the family heuristic', () => {
    setProxyCatalog({
      providers: {
        anthropic: { last_verified_at: '', models: [catalogEntry('claude-opus-4-8', 1_000_000)] },
      },
    } as unknown as FullCatalog);
    // The heuristic would say 200k for any claude-opus-4*; the catalog wins.
    expect(contextWindowFor('anthropic', 'claude-opus-4-8')).toBe(1_000_000);
  });

  it('falls back to the family heuristic once the catalog is cleared', () => {
    setProxyCatalog(null);
    expect(contextWindowFor('anthropic', 'claude-opus-4-8')).toBe(200_000);
  });
});

describe('contextWindowFor — long-context fallback', () => {
  it('recognises explicit 1M-variant ids without a catalog', () => {
    expect(contextWindowFor('anthropic', 'claude-opus-4-8[1m]')).toBe(1_000_000);
    expect(contextWindowFor('anthropic', 'claude-opus-4-8-1m')).toBe(1_000_000);
  });
});
