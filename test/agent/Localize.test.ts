import { describe, it, expect } from 'vitest';
import { parseLocalizeResult, renderLocalizeResult } from '../../src/agent/Localize.js';

describe('Localize result contract', () => {
  it('parses plain JSON, fenced JSON and JSON with surrounding prose', () => {
    const json = '{"locations":[{"path":"src\\\\a.ts","symbol":"A.run","startLine":10,"endLine":20,"reasoning":"does it","confidence":0.9}],"summary":"found"}';
    for (const text of [json, '```json\n' + json + '\n```', 'Here you go:\n' + json + '\nDone.']) {
      const r = parseLocalizeResult(text);
      expect(r).not.toBeNull();
      expect(r!.locations[0]).toEqual({ path: 'src/a.ts', symbol: 'A.run', startLine: 10, endLine: 20, reasoning: 'does it', confidence: 0.9 });
      expect(r!.summary).toBe('found');
      expect(r!.ambiguity).toBeUndefined();
    }
  });

  it('tolerates snake_case lines, string numbers and clamps confidence', () => {
    const r = parseLocalizeResult('{"locations":[{"path":"x.cs","start_line":"5","end_line":"9","reasoning":"r","confidence":7}],"summary":"s","ambiguity":"two readings"}');
    expect(r!.locations[0]).toMatchObject({ startLine: 5, endLine: 9, confidence: 1 });
    expect(r!.ambiguity).toBe('two readings');
  });

  it('rejects prose and malformed objects', () => {
    expect(parseLocalizeResult('I could not find it.')).toBeNull();
    expect(parseLocalizeResult('{"summary":"no list"}')).toBeNull();
    expect(parseLocalizeResult('{"locations":"nope"}')).toBeNull();
  });

  it('renders best-first with spans, symbols, confidence and ambiguity', () => {
    const text = renderLocalizeResult({
      summary: 'Two places.',
      locations: [
        { path: 'b.ts', reasoning: 'maybe', confidence: 0.4 },
        { path: 'a.ts', symbol: 'A', startLine: 1, endLine: 3, reasoning: 'yes', confidence: 0.95 },
      ],
      ambiguity: 'view vs model',
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Two places.');
    expect(lines[2]).toBe('a.ts:1-3  A  (0.95) — yes');
    expect(lines[3]).toBe('b.ts  (0.40) — maybe');
    expect(text).toContain('Ambiguity: view vs model');
  });
});
