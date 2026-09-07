import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, slugify } from '../../src/agent/Memory.js';
import { SaveMemoryTool } from '../../src/tools/saveMemory.js';

describe('MemoryStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autocode-memory-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('saves, indexes, replaces and deletes memories', () => {
    const store = new MemoryStore('/proj', dir);
    const a = store.save({ name: 'Prefers Small PRs', description: 'keep diffs small', kind: 'feedback', body: 'Small PRs.\n\n**Why:** reviews.\n**How to apply:** split work.' });
    expect(a.name).toBe('prefers-small-prs');
    expect(existsSync(join(dir, 'prefers-small-prs.md'))).toBe(true);
    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
    expect(index).toContain('## feedback');
    expect(index).toContain('[prefers-small-prs](prefers-small-prs.md) — keep diffs small');
    store.save({ name: 'prefers-small-prs', description: 'updated', kind: 'feedback', body: 'v2' });
    expect(store.list()).toHaveLength(1);
    expect(store.get('Prefers Small PRs')!.body).toBe('v2');
    expect(store.delete('prefers-small-prs')).toBe(true);
    expect(store.list()).toEqual([]);
    expect(slugify('Hello, World!')).toBe('hello-world');
  });

  it('renders an index plus bodies within the line and byte caps', () => {
    const store = new MemoryStore('/proj', dir);
    store.save({ name: 'owner', description: 'who the user is', kind: 'user', body: 'Gregory, CRE expert, not a developer.' });
    store.save({ name: 'deploy-target', description: 'where prod runs', kind: 'project', body: 'Vercel, region iad1.' });
    const text = store.renderForPrompt();
    expect(text).toContain('## user');
    expect(text).toContain('- **owner** — who the user is');
    expect(text).toContain('## details');
    expect(text).toContain('Vercel, region iad1.');
    const tiny = store.renderForPrompt({ maxLines: 4 });
    expect(tiny.split('\n').length).toBeLessThanOrEqual(4);
    expect(tiny).not.toContain('## details');
  });

  it('save_memory tool validates and writes through the store', async () => {
    process.env.AUTOCODE_DATA_DIR = dir;
    try {
      const ctx = { session: { sessionId: 't', projectRoot: join(dir, 'proj'), dataDir: dir, sessionDir: dir, model: { provider: 'xai', model: 'm' }, startedAt: '', mode: 'autocode' as const } };
      const bad = await new SaveMemoryTool().execute({ name: 'x', description: 'd', content: 'c', type: 'nope' }, ctx);
      expect(bad.isError).toBe(true);
      const ok = await new SaveMemoryTool().execute({ name: 'test-runner', description: 'how tests run', type: 'project', content: 'vitest, run with npm test' }, ctx);
      expect(ok.isError).toBeFalsy();
      expect(ok.summary).toBe('remembered test-runner (project)');
      const store = new MemoryStore(join(dir, 'proj'));
      expect(store.get('test-runner')!.body).toContain('vitest');
      const gone = await new SaveMemoryTool().execute({ name: 'test-runner', action: 'delete' }, ctx);
      expect(gone.isError).toBeFalsy();
      expect(store.list()).toEqual([]);
    } finally {
      delete process.env.AUTOCODE_DATA_DIR;
    }
  });
});
