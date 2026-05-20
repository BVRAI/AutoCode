import { describe, it, expect } from 'vitest';
import { nextMode, newSessionId } from '../../src/session/SessionContext.js';

describe('nextMode', () => {
  it('cycles default → autocode → planning → default', () => {
    expect(nextMode('default')).toBe('autocode');
    expect(nextMode('autocode')).toBe('planning');
    expect(nextMode('planning')).toBe('default');
  });

  it('returns to the start after three steps', () => {
    expect(nextMode(nextMode(nextMode('default')))).toBe('default');
  });
});

describe('newSessionId', () => {
  it('produces a timestamp-prefixed id with a random suffix', () => {
    const id = newSessionId(new Date('2026-05-20T21:43:05Z'));
    expect(id).toMatch(/^20260520-214305-[a-z0-9]{6}$/);
  });

  it('produces distinct ids on successive calls', () => {
    expect(newSessionId()).not.toBe(newSessionId());
  });
});
