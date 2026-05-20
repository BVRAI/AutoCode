import { describe, it, expect } from 'vitest';
import {
  contextWindowFor,
  shouldAutoCompact,
  AUTO_COMPACT_THRESHOLD,
} from '../../src/util/contextWindow.js';

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
