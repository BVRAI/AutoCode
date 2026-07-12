import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  declarationPatternForExt,
  forceRefreshRepoMap,
  getRepoMap,
  invalidateRepoMap,
  refreshRepoMapIfStale,
} from '../../src/agent/RepoMap.js';

const dirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autocode-map-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('repo map staleness lifecycle', () => {
  it('serves the cached digest until a turn-boundary refresh', () => {
    const root = tempProject();
    writeFileSync(join(root, 'a.ts'), 'export function alpha(): number { return 1; }\n');
    const first = getRepoMap(root);
    expect(first).toContain('a.ts');

    // New file — the cached digest must NOT change yet (stability within a
    // turn keeps the system-prompt prefix cache-safe).
    writeFileSync(join(root, 'b.ts'), 'export function beta(): number { return 2; }\n');
    invalidateRepoMap(root);
    expect(getRepoMap(root)).toBe(first);

    // Turn boundary: refresh picks up the new file.
    expect(refreshRepoMapIfStale(root)).toBe(true);
    expect(getRepoMap(root)).toContain('b.ts');
    // No further dirt — second refresh is a no-op.
    expect(refreshRepoMapIfStale(root)).toBe(false);
  });

  it('forceRefreshRepoMap rebuilds even without an invalidate', () => {
    const root = tempProject();
    writeFileSync(join(root, 'a.ts'), 'export const one = 1;\n');
    expect(getRepoMap(root)).toContain('a.ts');
    writeFileSync(join(root, 'c.ts'), 'export const three = 3;\n');
    forceRefreshRepoMap(root);
    expect(getRepoMap(root)).toContain('c.ts');
  });

  it('invalidate on an unbuilt root is a no-op (no eager build)', () => {
    const root = tempProject();
    invalidateRepoMap(root);
    expect(refreshRepoMapIfStale(root)).toBe(false);
  });
});

describe('declarationPatternForExt — languages advertised by find_symbol', () => {
  function names(ext: string, source: string): string[] {
    const re = declarationPatternForExt(ext);
    if (!re) return [];
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const n = m[1] ?? m[2];
      if (n) out.push(n);
    }
    return out;
  }

  it('java: classes, interfaces, records, and modifier-prefixed methods', () => {
    const src = [
      'public class OrderService {',
      '    private static final int MAX = 3;',
      '    public void submitOrder(String id) {',
      '        if (id == null) {',
      '            return;',
      '        }',
      '    }',
      '}',
      'interface Repository {}',
      'public record Point(int x, int y) {}',
    ].join('\n');
    const found = names('.java', src);
    expect(found).toContain('OrderService');
    expect(found).toContain('Repository');
    expect(found).toContain('Point');
    expect(found).toContain('submitOrder');
    expect(found).not.toContain('id'); // control flow must not match
  });

  it('ruby: def / class / module including self-methods and predicate names', () => {
    const src = [
      'module Billing',
      '  class Invoice',
      '    def total_cents',
      '    end',
      '    def self.build',
      '    end',
      '    def paid?',
      '    end',
      '  end',
      'end',
    ].join('\n');
    const found = names('.rb', src);
    expect(found).toEqual(expect.arrayContaining(['Billing', 'Invoice', 'total_cents', 'build', 'paid?']));
  });

  it('php: functions, classes, traits — including visibility-prefixed methods', () => {
    const src = [
      '<?php',
      'class Cart {',
      '    public function addItem($sku) {}',
      '    private static function reindex() {}',
      '}',
      'trait Discountable {}',
      'function checkout() {}',
    ].join('\n');
    const found = names('.php', src);
    expect(found).toEqual(expect.arrayContaining(['Cart', 'addItem', 'reindex', 'Discountable', 'checkout']));
  });

  it('csharp: types and modifier-prefixed methods', () => {
    const src = [
      'public sealed class PaymentProcessor',
      '{',
      '    public async Task<bool> ChargeAsync(string id)',
      '    {',
      '        return true;',
      '    }',
      '}',
      'public record Receipt(decimal Amount);',
      'internal interface IGateway {}',
    ].join('\n');
    const found = names('.cs', src);
    expect(found).toContain('PaymentProcessor');
    expect(found).toContain('Receipt');
    expect(found).toContain('IGateway');
    expect(found).toContain('ChargeAsync');
  });
});
