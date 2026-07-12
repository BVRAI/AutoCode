import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDepsTool } from '../../src/tools/fileDeps.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

describe('file_deps', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-filedeps-'));
    // core.ts imported by a.ts and b.ts; core imports util.ts.
    writeFileSync(join(root, 'core.ts'), "import { u } from './util.js';\nexport function core() {}\n");
    writeFileSync(join(root, 'util.ts'), 'export const u = 1;\n');
    writeFileSync(join(root, 'a.ts'), "import { core } from './core.js';\n");
    writeFileSync(join(root, 'b.ts'), "import { core } from './core.js';\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function ctx(): { session: SessionContext } {
    return {
      session: {
        sessionId: 't',
        projectRoot: root,
        dataDir: root,
        sessionDir: root,
        model: { provider: 'xai', model: 'm' },
        startedAt: new Date().toISOString(),
        mode: 'autocode',
      },
    };
  }

  it('lists importers and imports for a hub file', async () => {
    const r = await new FileDepsTool().execute({ path: 'core.ts' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('imported by (2):');
    expect(r.content).toContain('a.ts');
    expect(r.content).toContain('b.ts');
    expect(r.content).toContain('imports (1):');
    expect(r.content).toContain('util.ts');
  });

  it('direction=importers omits the imports section', async () => {
    const r = await new FileDepsTool().execute({ path: 'core.ts', direction: 'importers' }, ctx());
    expect(r.content).toContain('imported by (2):');
    expect(r.content).not.toContain('imports (1):');
  });

  it('renders zero importers honestly', async () => {
    const r = await new FileDepsTool().execute({ path: 'a.ts' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('imported by (0):');
  });

  it('normalizes ./ and backslash input paths', async () => {
    const r = await new FileDepsTool().execute({ path: './core.ts' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('deps for core.ts');
  });

  it('returns an explanation for unscanned paths (map self-heals for real files)', async () => {
    const r = await new FileDepsTool().execute({ path: 'does-not-exist.ts' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not in the scanned import graph/);
  });

  it('rejects an invalid direction', async () => {
    const r = await new FileDepsTool().execute({ path: 'core.ts', direction: 'sideways' }, ctx());
    expect(r.isError).toBe(true);
  });
});
