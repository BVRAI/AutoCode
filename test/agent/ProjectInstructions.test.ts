import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectInstructions } from '../../src/agent/ProjectInstructions.js';

describe('loadProjectInstructions', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autocode-pi-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty array when no instruction file exists', () => {
    expect(loadProjectInstructions(dir)).toEqual([]);
  });

  it('loads a single AGENTS.md when only it exists', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'shared rules');
    const r = loadProjectInstructions(dir);
    expect(r).toHaveLength(1);
    expect(r[0]!.fileName).toBe('AGENTS.md');
    expect(r[0]!.isAuthoritative).toBe(false);
  });

  it('loads AUTOCODE.md alone when it is the only file', () => {
    writeFileSync(join(dir, 'AUTOCODE.md'), 'autocode rules');
    const r = loadProjectInstructions(dir);
    expect(r).toHaveLength(1);
    expect(r[0]!.fileName).toBe('AUTOCODE.md');
  });

  it('layers all four files in priority order (lowest first)', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'agents content');
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude content');
    writeFileSync(join(dir, 'AUTOCODE.md'), 'autocode content');
    writeFileSync(join(dir, 'master.md'), 'master content');
    const r = loadProjectInstructions(dir);
    expect(r.map((i) => i.fileName)).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'AUTOCODE.md',
      'master.md',
    ]);
    // master.md is last (highest priority) and flagged authoritative.
    expect(r[r.length - 1]!.isAuthoritative).toBe(true);
    expect(r[0]!.isAuthoritative).toBe(false);
  });

  it('marks only master.md as authoritative', () => {
    writeFileSync(join(dir, 'AUTOCODE.md'), 'autocode');
    writeFileSync(join(dir, 'master.md'), 'master');
    const r = loadProjectInstructions(dir);
    expect(r.find((i) => i.fileName === 'AUTOCODE.md')?.isAuthoritative).toBe(false);
    expect(r.find((i) => i.fileName === 'master.md')?.isAuthoritative).toBe(true);
  });

  it('applies a total byte cap across all files', () => {
    // Write three files totaling ~60 KB — should be truncated to ~40 KB total.
    writeFileSync(join(dir, 'AGENTS.md'), 'x'.repeat(25_000));
    writeFileSync(join(dir, 'AUTOCODE.md'), 'y'.repeat(25_000));
    writeFileSync(join(dir, 'master.md'), 'z'.repeat(25_000));
    const r = loadProjectInstructions(dir);
    const totalContent = r.reduce((s, i) => s + i.content.length, 0);
    // Allow a small slop for the truncation marker.
    expect(totalContent).toBeLessThanOrEqual(40_000 + 200);
    expect(r.some((i) => i.truncated)).toBe(true);
  });

  it('skips files that do not exist', () => {
    writeFileSync(join(dir, 'AUTOCODE.md'), 'only one');
    const r = loadProjectInstructions(dir);
    expect(r).toHaveLength(1);
    expect(r[0]!.fileName).toBe('AUTOCODE.md');
  });
});
