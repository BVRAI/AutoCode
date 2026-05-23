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

  it('undoLastStep reverts only the most recent step (earlier steps in same turn survive)', () => {
    const f1 = join(proj, 'step-a.txt');
    const f2 = join(proj, 'step-b.txt');
    writeFileSync(f1, 'a-v1');
    writeFileSync(f2, 'b-v1');
    const cp = new CheckpointStore(sessionDir);
    cp.beginTurn();
    // step 1 — touch f1
    cp.beginStep();
    cp.snapshotBeforeWrite(f1);
    writeFileSync(f1, 'a-v2');
    // step 2 — touch f2
    cp.beginStep();
    cp.snapshotBeforeWrite(f2);
    writeFileSync(f2, 'b-v2');

    const r = cp.undoLastStep();
    expect(r?.restored).toBe(1);
    expect(r?.step).toBe(2);
    expect(readFileSync(f1, 'utf8')).toBe('a-v2'); // earlier step survives
    expect(readFileSync(f2, 'utf8')).toBe('b-v1'); // last step reverted
  });

  it('undoLastStep can be called repeatedly to walk back through a turn', () => {
    const f1 = join(proj, 'walk-a.txt');
    const f2 = join(proj, 'walk-b.txt');
    writeFileSync(f1, 'a-v1');
    writeFileSync(f2, 'b-v1');
    const cp = new CheckpointStore(sessionDir);
    cp.beginTurn();
    cp.beginStep();
    cp.snapshotBeforeWrite(f1);
    writeFileSync(f1, 'a-v2');
    cp.beginStep();
    cp.snapshotBeforeWrite(f2);
    writeFileSync(f2, 'b-v2');

    cp.undoLastStep(); // reverts step 2
    cp.undoLastStep(); // reverts step 1
    expect(readFileSync(f1, 'utf8')).toBe('a-v1');
    expect(readFileSync(f2, 'utf8')).toBe('b-v1');
    expect(cp.undoLastStep()).toBeNull(); // nothing left
  });

  it('beginTurn resets the step counter so step numbers stay scoped within a turn', () => {
    const f1 = join(proj, 'scope-a.txt');
    const f2 = join(proj, 'scope-b.txt');
    writeFileSync(f1, 'a');
    writeFileSync(f2, 'b');
    const cp = new CheckpointStore(sessionDir);
    cp.beginTurn();
    cp.beginStep();
    cp.snapshotBeforeWrite(f1);
    cp.beginTurn();
    cp.beginStep();
    cp.snapshotBeforeWrite(f2);
    const r = cp.undoLastStep();
    // After beginTurn the step counter reset, so the second turn's step is 1
    // (not 2) — proves the reset.
    expect(r?.step).toBe(1);
  });

  it('undoLastTurn still reverts a whole turn (step grouping does not break it)', () => {
    const f1 = join(proj, 'whole-a.txt');
    const f2 = join(proj, 'whole-b.txt');
    writeFileSync(f1, 'a-v1');
    writeFileSync(f2, 'b-v1');
    const cp = new CheckpointStore(sessionDir);
    cp.beginTurn();
    cp.beginStep();
    cp.snapshotBeforeWrite(f1);
    writeFileSync(f1, 'a-v2');
    cp.beginStep();
    cp.snapshotBeforeWrite(f2);
    writeFileSync(f2, 'b-v2');
    const r = cp.undoLastTurn();
    expect(r?.restored).toBe(2);
    expect(readFileSync(f1, 'utf8')).toBe('a-v1');
    expect(readFileSync(f2, 'utf8')).toBe('b-v1');
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
