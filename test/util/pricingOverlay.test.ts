import { describe, it, expect, afterEach } from 'vitest';
import { rateFor, estimateCost, setProxyRates } from '../../src/util/pricing.js';

const sampleProxyCatalog = {
  providers: {
    anthropic: {
      models: [
        {
          id: 'claude-opus-4-7-20260525',
          input_price_per_million: 14,
          output_price_per_million: 72,
          supports_caching: true,
          cache_read_multiplier: 0.1,
          cache_write_multiplier: 2.0,
        },
        {
          id: 'claude-new-future',
          input_price_per_million: 9,
          output_price_per_million: 36,
          supports_caching: false,
        },
      ],
    },
    xai: {
      models: [
        {
          id: 'grok-5',
          input_price_per_million: 2,
          output_price_per_million: 8,
          supports_caching: false,
        },
      ],
    },
  },
};

afterEach(() => {
  setProxyRates(null);
});

describe('rateFor with proxy overlay', () => {
  it('uses overlay rates when set, even if the model is unknown to bundled RATES', () => {
    setProxyRates(sampleProxyCatalog);
    const r = rateFor('anthropic', 'claude-new-future');
    expect(r).not.toBeNull();
    expect(r?.inputPerM).toBe(9);
    expect(r?.outputPerM).toBe(36);
  });

  it('overlay wins over bundled RATES for the same model', () => {
    setProxyRates(sampleProxyCatalog);
    // bundled has anthropic.claude-opus-4-7 at inputPerM=15; overlay sets 14.
    // longest-prefix-match on "claude-opus-4-7-20260525" → overlay row.
    const r = rateFor('anthropic', 'claude-opus-4-7-20260525');
    expect(r?.inputPerM).toBe(14);
    expect(r?.outputPerM).toBe(72);
  });

  it('applies cache multipliers when supports_caching is true', () => {
    setProxyRates(sampleProxyCatalog);
    const r = rateFor('anthropic', 'claude-opus-4-7-20260525');
    expect(r?.cacheReadPerM).toBeCloseTo(1.4, 5);   // 14 * 0.1
    expect(r?.cacheWritePerM).toBeCloseTo(28, 5);   // 14 * 2.0
  });

  it('skips cache multipliers when supports_caching is false', () => {
    setProxyRates(sampleProxyCatalog);
    const r = rateFor('xai', 'grok-5');
    expect(r?.cacheReadPerM).toBeUndefined();
    expect(r?.cacheWritePerM).toBeUndefined();
  });

  it('falls through to bundled RATES when overlay has no entry for the provider', () => {
    setProxyRates({ providers: {} });
    const r = rateFor('xai', 'grok-code-fast-1');
    expect(r).not.toBeNull();
    expect(r?.inputPerM).toBeGreaterThan(0);
  });

  it('setProxyRates(null) clears the overlay', () => {
    setProxyRates(sampleProxyCatalog);
    setProxyRates(null);
    // After clearing, bundled rate for claude-opus-4-7 (15) should win.
    const r = rateFor('anthropic', 'claude-opus-4-7-20260525');
    expect(r?.inputPerM).toBe(15);
  });

  it('estimateCost uses overlay prices end-to-end', () => {
    setProxyRates(sampleProxyCatalog);
    const { cost } = estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'xai',
      'grok-5',
    );
    // 2 + 8 = 10
    expect(cost).toBeCloseTo(10, 3);
  });
});
