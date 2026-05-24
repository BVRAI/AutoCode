import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('layers the three supported files at root in priority order (lowest first)', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'agents content');
    writeFileSync(join(dir, 'AUTOCODE.md'), 'autocode content');
    writeFileSync(join(dir, 'master.md'), 'master content');
    const r = loadProjectInstructions(dir);
    expect(r.map((i) => i.fileName)).toEqual(['AGENTS.md', 'AUTOCODE.md', 'master.md']);
    // master.md is last (highest priority) and flagged authoritative.
    expect(r[r.length - 1]!.isAuthoritative).toBe(true);
    expect(r[0]!.isAuthoritative).toBe(false);
  });

  it('does NOT load CLAUDE.md — autocode uses AUTOCODE.md as the equivalent', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'should be ignored');
    writeFileSync(join(dir, 'AUTOCODE.md'), 'this one wins');
    const r = loadProjectInstructions(dir);
    expect(r.map((i) => i.fileName)).toEqual(['AUTOCODE.md']);
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

  it('discovers AUTOCODE.md in a nested subdirectory with the right scope', () => {
    writeFileSync(join(dir, 'AUTOCODE.md'), 'root conventions');
    mkdirSync(join(dir, 'src', 'api'), { recursive: true });
    writeFileSync(join(dir, 'src', 'api', 'AUTOCODE.md'), 'api conventions');
    const r = loadProjectInstructions(dir);
    expect(r).toHaveLength(2);
    expect(r[0]!.relativeDir).toBe('');
    expect(r[0]!.depth).toBe(0);
    expect(r[1]!.relativeDir).toBe('src/api');
    expect(r[1]!.depth).toBe(2);
  });

  it('orders multiple nested files by depth (root → leaves), then directory', () => {
    writeFileSync(join(dir, 'AUTOCODE.md'), 'root');
    mkdirSync(join(dir, 'a'), { recursive: true });
    mkdirSync(join(dir, 'b'), { recursive: true });
    mkdirSync(join(dir, 'a', 'inner'), { recursive: true });
    writeFileSync(join(dir, 'a', 'AUTOCODE.md'), 'a');
    writeFileSync(join(dir, 'b', 'AUTOCODE.md'), 'b');
    writeFileSync(join(dir, 'a', 'inner', 'AUTOCODE.md'), 'a-inner');
    const r = loadProjectInstructions(dir);
    const order = r.map((i) => i.relativeDir);
    expect(order).toEqual(['', 'a', 'b', 'a/inner']);
  });

  it('skips noise directories like node_modules', () => {
    writeFileSync(join(dir, 'AUTOCODE.md'), 'root');
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'AUTOCODE.md'), 'should not load');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'AUTOCODE.md'), 'also nope');
    const r = loadProjectInstructions(dir);
    expect(r).toHaveLength(1);
    expect(r[0]!.relativeDir).toBe('');
  });

  it('still treats master.md as authoritative even when found in a subdirectory', () => {
    mkdirSync(join(dir, 'deploy'), { recursive: true });
    writeFileSync(join(dir, 'deploy', 'master.md'), 'deploy-scoped override');
    const r = loadProjectInstructions(dir);
    expect(r).toHaveLength(1);
    expect(r[0]!.isAuthoritative).toBe(true);
    expect(r[0]!.relativeDir).toBe('deploy');
  });

  it('parses an optional `verify:` directive from frontmatter and strips it from the body', () => {
    writeFileSync(
      join(dir, 'AUTOCODE.md'),
      '---\nverify: pytest -xvs tests/\n---\n\n# Conventions\nThe body content.\n',
    );
    const r = loadProjectInstructions(dir);
    expect(r).toHaveLength(1);
    expect(r[0]!.verify).toBe('pytest -xvs tests/');
    // The frontmatter must not leak into the prompt content.
    expect(r[0]!.content).not.toContain('verify:');
    expect(r[0]!.content).not.toContain('---');
    expect(r[0]!.content).toContain('The body content.');
  });

  it('leaves verify undefined when there is no frontmatter', () => {
    writeFileSync(join(dir, 'AUTOCODE.md'), 'just plain conventions');
    const r = loadProjectInstructions(dir);
    expect(r[0]!.verify).toBeUndefined();
    expect(r[0]!.content).toBe('just plain conventions');
  });

  it('handles frontmatter with no `verify:` key (other keys present)', () => {
    writeFileSync(join(dir, 'AUTOCODE.md'), '---\nowner: api-team\n---\nbody');
    const r = loadProjectInstructions(dir);
    expect(r[0]!.verify).toBeUndefined();
    expect(r[0]!.content).toBe('body');
  });
});
