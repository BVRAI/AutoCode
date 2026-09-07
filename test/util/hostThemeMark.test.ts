import { describe, expect, it } from 'vitest';
import { applyHostTheme, filterHostMarks, onHostTheme, themeMark } from '../../src/util/ttyEmulation.js';

describe('host theme marker', () => {
  it('strips complete theme markers and applies them, next to resize markers', () => {
    const seen: string[] = [];
    const r = filterHostMarks(`abc${themeMark('light')}def[[amx:resize:80x24]]`, {
      resize: (c, rows) => seen.push(`resize ${c}x${rows}`),
      theme: (name) => seen.push(`theme ${name}`),
    });
    expect(r.out).toBe('abcdef');
    expect(r.pending).toBe('');
    expect(seen).toEqual(['theme light', 'resize 80x24']);
  });

  it('holds a split theme marker until the rest arrives', () => {
    const seen: string[] = [];
    const handlers = { resize: () => undefined, theme: (name: string) => seen.push(name) };
    const first = filterHostMarks('typed [[amx:the', handlers);
    expect(first.out).toBe('typed ');
    expect(first.pending).toBe('[[amx:the');
    const second = filterHostMarks(first.pending + 'me:dark]] more', handlers);
    expect(second.out).toBe(' more');
    expect(seen).toEqual(['dark']);
  });

  it('ignores unknown theme names and ordinary brackets', () => {
    const seen: string[] = [];
    const r = filterHostMarks('[[amx:theme:neon]] x [[not a marker]]', { resize: () => undefined, theme: (name) => seen.push(name) });
    expect(seen).toEqual([]);
    expect(r.out).toBe('[[amx:theme:neon]] x [[not a marker]]');
  });

  it('fans a notice out to subscribers and lets them unsubscribe', () => {
    const got: string[] = [];
    const off = onHostTheme((name) => got.push(name));
    applyHostTheme('light');
    off();
    applyHostTheme('dark');
    expect(got).toEqual(['light']);
  });
});
