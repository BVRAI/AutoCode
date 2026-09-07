import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockingFindings, buildReviewRequest, buildTurnDiff, parseReviewResult, renderFixRequest, renderReviewResult } from '../../src/agent/Reviewer.js';

describe('Review contract', () => {
  it('parses findings with severity aliases and infers the verdict', () => {
    const r = parseReviewResult('```json\n{"findings":[{"severity":"critical","file":"src\\\\a.ts","line":"12","issue":"null deref","suggestion":"guard it"},{"severity":"minor","issue":"naming"}],"summary":"one real bug","scope_creep":"renamed helper"}\n```');
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe('request_changes');
    expect(r!.findings[0]).toEqual({ severity: 'high', file: 'src/a.ts', line: 12, issue: 'null deref', suggestion: 'guard it' });
    expect(r!.findings[1]!.severity).toBe('low');
    expect(r!.scopeCreep).toBe('renamed helper');
    expect(blockingFindings(r!).length).toBe(1);
    expect(renderReviewResult(r!).split('\n')[0]).toBe('Changes requested — one real bug');
    expect(renderReviewResult(r!)).toContain('[high] src/a.ts:12  null deref → guard it');
    expect(renderFixRequest(r!)).toContain('1. src/a.ts:12: null deref');
  });

  it('treats an explicit approve with only low findings as approved and rejects prose', () => {
    const r = parseReviewResult('{"verdict":"approve","findings":[{"severity":"low","issue":"style"}],"summary":"fine"}');
    expect(r!.verdict).toBe('approve');
    expect(blockingFindings(r!)).toEqual([]);
    expect(parseReviewResult('Looks good to me.')).toBeNull();
  });

  it('builds a bounded diff of the turn and a request message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autocode-review-'));
    const before = join(dir, 'before.txt');
    const after = join(dir, 'after.ts');
    writeFileSync(before, 'a\nb\nc\n');
    writeFileSync(after, 'a\nB\nc\n');
    const created = join(dir, 'new.ts');
    writeFileSync(created, 'export const n = 1;\n');
    const diff = buildTurnDiff(dir, [
      { path: after, op: 'modify', backup: before },
      { path: created, op: 'create', backup: null },
    ]);
    expect(diff.files).toEqual(['after.ts', 'new.ts']);
    expect(diff.text).toContain('--- a/after.ts');
    expect(diff.text).toContain('- b');
    expect(diff.text).toContain('+ B');
    expect(diff.text).toContain('(new file, 2 lines)');
    const req = buildReviewRequest({ request: 'rename b', diff: diff.text, files: diff.files, verification: 'npm test passed' });
    expect(req).toContain('## What the user asked for\nrename b');
    expect(req).toContain('## Files changed (2)');
    expect(req).toContain('```diff');
  });
});
