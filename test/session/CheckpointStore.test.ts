import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointStore } from '../../src/session/CheckpointStore.js';

describe('CheckpointStore', () => {
  let root: string;
  let sessionDir: string;
  let proj: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-ckpt-'));
    vi.stubEnv('AUTOCODE_DATA_DIR', root); // global trash lands under here
    sessionDir = join(root, 'session');
    proj = join(root, 'proj');
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(proj, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('undo restores a modified file', () => {
    const f = join(proj, 'a.txt');
    writeFileSync(f, 'original');
    const cp = new CheckpointStore(sessionDir);
    cp.snapshotBeforeWrite(f);
    writeFileSync(f, 'changed');
    const r = cp.undoLastTurn();
    expect(r?.restored).toBe(1);
    expect(readFileSync(f, 'utf8')).toBe('original');
  });

  it('undo deletes a file that was newly created in the turn', () => {
    const f = join(proj, 'new.txt');
    const cp = new CheckpointStore(sessionDir);
    cp.snapshotBeforeWrite(f); // does not exist yet -> 'create'
    writeFileSync(f, 'hi');
    cp.undoLastTurn();
    expect(existsSync(f)).toBe(false);
  });

  it('trash moves a file out and restoreFromTrash brings it back', () => {
    const f = join(proj, 'doomed.txt');
    writeFileSync(f, 'content');
    const cp = new CheckpointStore(sessionDir);
    const id = cp.trash(f);
    expect(existsSync(f)).toBe(false);
    expect(cp.listTrash().some((i) => i.id === id)).toBe(true);
    const restored = cp.restoreFromTrash(id);
    expect(restored?.originalPath).toBe(f);
    expect(readFileSync(f, 'utf8')).toBe('content');
  });

  it('undo restores a deleted file from the trash', () => {
    const f = join(proj, 'gone.txt');
    writeFileSync(f, 'data');
    const cp = new CheckpointStore(sessionDir);
    cp.trash(f);
    cp.undoLastTurn();
    expect(readFileSync(f, 'utf8')).toBe('data');
  });

  it('undo only reverts the most recent turn', () => {
    const f1 = join(proj, 'one.txt');
    const f2 = join(proj, 'two.txt');
    writeFileSync(f1, 'one-v1');
    writeFileSync(f2, 'two-v1');
    const cp = new CheckpointStore(sessionDir);
    cp.beginTurn();
    cp.snapshotBeforeWrite(f1);
    writeFileSync(f1, 'one-v2');
    cp.beginTurn();
    cp.snapshotBeforeWrite(f2);
    writeFileSync(f2, 'two-v2');
    cp.undoLastTurn();
    expect(readFileSync(f1, 'utf8')).toBe('one-v2'); // earlier turn untouched
    expect(readFileSync(f2, 'utf8')).toBe('two-v1'); // last turn reverted
    cp.undoLastTurn();
    expect(readFileSync(f1, 'utf8')).toBe('one-v1');
  });

  it('undoLastTurn returns null when there is nothing to undo', () => {
    expect(new CheckpointStore(sessionDir).undoLastTurn()).toBeNull();
  });

  it('sweep removes trash older than the retention window', () => {
    const f = join(proj, 'old.txt');
    writeFileSync(f, 'x');
    const cp = new CheckpointStore(sessionDir);
    const id = cp.trash(f);
    const metaPath = join(root, 'trash', `${id}.meta.json`);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    meta.deletedAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    writeFileSync(metaPath, JSON.stringify(meta));
    cp.sweep();
    expect(cp.listTrash().some((i) => i.id === id)).toBe(false);
  });
});
