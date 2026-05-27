import { describe, it, expect, afterEach } from 'vitest';
import {
  KNOWN_MODELS_FALLBACK,
  getKnownModels,
  setProxyCatalog,
  findModel,
  modelCatalogSource,
} from '../../src/llm/models.js';
import type { FullCatalog } from '../../src/llm/CatalogClient.js';

function sampleCatalog(): FullCatalog {
  return {
    schema_version: 1,
    fetched_at: '2026-05-25T00:00:00Z',
    run_id: 'run-1',
    providers: {
      anthropic: {
        last_verified_at: '2026-05-25T00:00:00Z',
        models: [
          {
            id: 'claude-opus-4-7-20260525',
            input_price_per_million: 14,
            output_price_per_million: 72,
            status: 'active',
            last_verified_at: '2026-05-25T00:00:00Z',
            last_priced_at: '2026-05-25T00:00:00Z',
            supports_thinking: true,
            thinking_budget_default: 8192,
            max_output_tokens: 8192,
            context_window: 200000,
            vision: true,
            tools: true,
            supports_caching: true,
            max_cache_breakpoints: 4,
            cache_read_multiplier: 0.1,
            cache_write_multiplier: 2.0,
          },
          {
            id: 'claude-opus-3-legacy',
            input_price_per_million: 99,
            output_price_per_million: 999,
            status: 'deprecated',
            last_verified_at: '2026-01-01T00:00:00Z',
            last_priced_at: '2026-01-01T00:00:00Z',
            supports_thinking: false,
            thinking_budget_default: null,
            max_output_tokens: 4096,
            context_window: 100000,
            vision: false,
            tools: true,
            supports_caching: false,
            max_cache_breakpoints: 0,
            cache_read_multiplier: 1.0,
            cache_write_multiplier: 1.0,
          },
          {
            id: 'claude-zeta-1',
            input_price_per_million: 7,
            output_price_per_million: 35,
            status: 'model_not_verified',
            last_verified_at: '',
            last_priced_at: '',
            supports_thinking: false,
            thinking_budget_default: null,
            max_output_tokens: 8192,
            context_window: 200000,
            vision: false,
            tools: true,
            supports_caching: false,
            max_cache_breakpoints: 0,
            cache_read_multiplier: 1.0,
            cache_write_multiplier: 1.0,
          },
        ],
      },
      xai: {
        last_verified_at: '2026-05-25T00:00:00Z',
        models: [
          {
            id: 'grok-5',
            input_price_per_million: 2,
            output_price_per_million: 8,
            status: 'pricing_pending',
            last_verified_at: '2026-05-25T00:00:00Z',
            last_priced_at: '',
            supports_thinking: false,
            thinking_budget_default: null,
            max_output_tokens: 8192,
            context_window: 200000,
            vision: false,
            tools: true,
            supports_caching: false,
            max_cache_breakpoints: 0,
            cache_read_multiplier: 1.0,
            cache_write_multiplier: 1.0,
          },
        ],
      },
    },
  };
}

afterEach(() => {
  setProxyCatalog(null);
});

describe('model registry — bundled fallback', () => {
  it('exposes the hardcoded fallback by default', () => {
    expect(modelCatalogSource()).toBe('bundled');
    expect(getKnownModels()).toBe(KNOWN_MODELS_FALLBACK);
    expect(getKnownModels().length).toBeGreaterThan(0);
  });

  it('findModel resolves a known prefix in the fallback', () => {
    const m = findModel('anthropic', 'claude-opus-4-7-20251001');
    expect(m).not.toBeNull();
    expect(m?.model).toBe('claude-opus-4-7');
  });
});

describe('model registry — proxy overlay', () => {
  it('replaces the catalog when a proxy payload is loaded', () => {
    setProxyCatalog(sampleCatalog());
    expect(modelCatalogSource()).toBe('proxy');
    const models = getKnownModels();
    // anthropic.claude-opus-4-7-20260525 (active) +
    // xai.grok-5 (pricing_pending) — deprecated + model_not_verified dropped.
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.model).sort()).toEqual([
      'claude-opus-4-7-20260525',
      'grok-5',
    ]);
  });

  it('reuses EXTRA_METADATA labels when the catalog id has a known prefix', () => {
    setProxyCatalog(sampleCatalog());
    const m = findModel('anthropic', 'claude-opus-4-7-20260525');
    expect(m?.label).toBe('Claude Opus 4.7');
    expect(m?.notes).toMatch(/frontier/);
  });

  it('derives cacheReadPerM from the multiplier when caching is supported', () => {
    setProxyCatalog(sampleCatalog());
    const opus = findModel('anthropic', 'claude-opus-4-7-20260525');
    // inputPerM 14 * cache_read_multiplier 0.1 = 1.4
    expect(opus?.cacheReadPerM).toBeCloseTo(1.4, 5);
    const grok = findModel('xai', 'grok-5');
    // supports_caching false → no cacheReadPerM
    expect(grok?.cacheReadPerM).toBeUndefined();
  });

  it('falls back to the catalog id as label when no metadata matches', () => {
    setProxyCatalog({
      schema_version: 1,
      fetched_at: '2026-05-25T00:00:00Z',
      run_id: 'run-x',
      providers: {
        openai: {
          last_verified_at: '2026-05-25T00:00:00Z',
          models: [
            {
              id: 'some-future-model-xyz',
              input_price_per_million: 1,
              output_price_per_million: 4,
              status: 'active',
              last_verified_at: '2026-05-25T00:00:00Z',
              last_priced_at: '2026-05-25T00:00:00Z',
              supports_thinking: false,
              thinking_budget_default: null,
              max_output_tokens: 4096,
              context_window: 100000,
              vision: false,
              tools: true,
              supports_caching: false,
              max_cache_breakpoints: 0,
              cache_read_multiplier: 1.0,
              cache_write_multiplier: 1.0,
            },
          ],
        },
      },
    });
    const m = findModel('openai', 'some-future-model-xyz');
    expect(m?.label).toBe('some-future-model-xyz');
  });

  it('setProxyCatalog(null) restores the bundled fallback', () => {
    setProxyCatalog(sampleCatalog());
    expect(modelCatalogSource()).toBe('proxy');
    setProxyCatalog(null);
    expect(modelCatalogSource()).toBe('bundled');
    expect(getKnownModels()).toBe(KNOWN_MODELS_FALLBACK);
  });
});
