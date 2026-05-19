import { describe, it, expect } from 'vitest';
import { rateFor, estimateCost, formatUsd } from '../../src/util/pricing.js';

describe('rateFor', () => {
  it('returns null for unknown provider', () => {
    expect(rateFor('unknown', 'whatever')).toBeNull();
  });

  it('matches model prefix', () => {
    const r = rateFor('xai', 'grok-code-fast-1');
    expect(r).not.toBeNull();
    expect(r?.inputPerM).toBeGreaterThan(0);
  });

  it('matches model with date suffix via prefix', () => {
    expect(rateFor('anthropic', 'claude-opus-4-7-20251001')).not.toBeNull();
    expect(rateFor('anthropic', 'claude-haiku-4-5-20251001')).not.toBeNull();
  });

  it('picks the longest matching prefix', () => {
    // "claude-opus-4-7" should win over "claude-opus-4" for an opus-4-7 model.
    const r = rateFor('anthropic', 'claude-opus-4-7');
    expect(r?.inputPerM).toBe(15);
    expect(r?.cacheReadPerM).toBe(1.5);
  });
});

describe('estimateCost', () => {
  it('computes cost from input + output tokens', () => {
    const { cost } = estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'xai',
      'grok-code-fast-1',
    );
    // grok-code-fast-1: $0.20/M in + $1.50/M out → $1.70
    expect(cost).toBeCloseTo(1.7, 3);
  });

  it('adds cache read cost when applicable', () => {
    const { cost } = estimateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      },
      'anthropic',
      'claude-opus-4-7',
    );
    // $15/M fresh + $1.5/M cache read = $16.5
    expect(cost).toBeCloseTo(16.5, 2);
  });

  it('returns zero cost when pricing is unknown', () => {
    const { cost, rate } = estimateCost(
      { inputTokens: 100, outputTokens: 100 },
      'unknown-provider',
      'some-model',
    );
    expect(cost).toBe(0);
    expect(rate).toBeNull();
  });
});

describe('formatUsd', () => {
  it('uses 4 decimals for sub-cent amounts', () => {
    expect(formatUsd(0.0001)).toBe('$0.0001');
    expect(formatUsd(0.0042)).toBe('$0.0042');
  });

  it('uses 2 decimals for normal amounts', () => {
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(15.99)).toBe('$15.99');
  });
});
