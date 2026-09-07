import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docsMap, renderDocsMap, renderTemplate } from '../../src/repl/InitCommand.js';

describe('/init documentation map', () => {
  it('lists docs/*.md with their first heading and renders a map section', () => {
    const root = mkdtempSync(join(tmpdir(), 'autocode-init-'));
    mkdirSync(join(root, 'docs', 'guides'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ARCHITECTURE.md'), '# Architecture overview\n\ntext\n');
    writeFileSync(join(root, 'docs', 'guides', 'deploy.md'), 'no heading here\n');
    writeFileSync(join(root, 'docs', 'notes.txt'), 'ignored\n');
    const docs = docsMap(root);
    expect(docs).toEqual([
      { path: 'docs/ARCHITECTURE.md', title: 'Architecture overview' },
      { path: 'docs/guides/deploy.md', title: 'deploy' },
    ]);
    const section = renderDocsMap(docs);
    expect(section).toContain('## Documentation map');
    expect(section).toContain('- `docs/ARCHITECTURE.md` — Architecture overview');
    const template = renderTemplate('x', { root, types: ['node'], git: null }, docs);
    expect(template).toContain('## Documentation map');
    expect(renderTemplate('x', { root, types: ['node'], git: null })).not.toContain('## Documentation map');
    rmSync(root, { recursive: true, force: true });
  });
});
