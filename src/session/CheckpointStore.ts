import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../util/paths.js';

export type CheckpointOp = 'modify' | 'create' | 'delete';

export interface CheckpointEntry {
  id: string;
  turn: number;
  // Step counter within a turn — each tool execution that touches files is one
  // step, so /undo can rewind to right before the last step (the natural
  // boundary after an interrupt) instead of always reverting the whole turn.
  step: number;
  op: CheckpointOp;
  originalPath: string;
  kind: 'file' | 'dir';
  backup: string | null; // absolute path to the backup copy; null when op === 'create'
  at: string;
  undone: boolean;
}

export interface TrashItem {
  id: string;
  originalPath: string;
  kind: 'file' | 'dir';
  deletedAt: string;
}

const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Snapshot-before-mutate store. Powers two things:
//  - /undo — reverts all file changes from the most recent turn (per session).
//  - the trash can — deletions are moved to a global trash, recoverable for
//    7 days via /trash and /restore.
export class CheckpointStore {
  private readonly blobsDir: string; // <sessionDir>/checkpoints/blobs — edit/create backups
  private readonly trashDir: string; // <dataDir>/trash — global, cross-session
  private readonly entries: CheckpointEntry[] = [];
  private turn = 0;
  private step = 0;
  private seq = 0;

  constructor(sessionDir: string) {
    this.blobsDir = join(sessionDir, 'checkpoints', 'blobs');
    this.trashDir = join(dataDir(), 'trash');
    mkdirSync(this.blobsDir, { recursive: true });
    mkdirSync(this.trashDir, { recursive: true });
  }

  // Called by AgentLoop at the start of each user turn. Resets the step
  // counter so steps are scoped within a turn.
  beginTurn(): void {
    this.turn += 1;
    this.step = 0;
  }

  // Called by AgentLoop immediately before each tool execution that may
  // mutate files. Groups all snapshots from that tool call under one step
  // number so step-level undo rewinds exactly one tool's worth of work.
  beginStep(): void {
    this.step += 1;
  }

  private nextId(): string {
    this.seq += 1;
    return `${Date.now().toString(36)}-${this.seq.toString(36)}`;
  }

  // Snapshot a file before edit_file / write_file changes it. If the file
  // does not exist yet, records a 'create' entry so undo deletes it.
  snapshotBeforeWrite(absPath: string): void {
    const id = this.nextId();
    const at = new Date().toISOString();
    if (!existsSync(absPath)) {
      this.entries.push({ id, turn: this.turn, step: this.step, op: 'create', originalPath: absPath, kind: 'file', backup: null, at, undone: false });
      return;
    }
    const backup = join(this.blobsDir, id);
    cpSync(absPath, backup, { recursive: true });
    const kind = statSync(absPath).isDirectory() ? 'dir' : 'file';
    this.entries.push({ id, turn: this.turn, step: this.step, op: 'modify', originalPath: absPath, kind, backup, at, undone: false });
  }

  // Move a path into the global trash (used by delete_path). The original is
  // removed only after the copy succeeds. Returns the trash id.
  trash(absPath: string): string {
    const id = this.nextId();
    const dest = join(this.trashDir, id);
    const kind = statSync(absPath).isDirectory() ? 'dir' : 'file';
    cpSync(absPath, dest, { recursive: true });
    const meta: TrashItem = { id, originalPath: absPath, kind, deletedAt: new Date().toISOString() };
    writeFileSync(join(this.trashDir, `${id}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
    rmSync(absPath, { recursive: true, force: true });
    this.entries.push({ id, turn: this.turn, step: this.step, op: 'delete', originalPath: absPath, kind, backup: dest, at: meta.deletedAt, undone: false });
    return id;
  }

  // Revert just the most recent live step — the natural rewind point after an
  // interrupt, so earlier good steps from the same turn stay on disk.
  undoLastStep(): { turn: number; step: number; restored: number } | null {
    let t = -1;
    let s = -1;
    for (const e of this.entries) {
      if (e.undone) continue;
      if (e.turn > t || (e.turn === t && e.step > s)) {
        t = e.turn;
        s = e.step;
      }
    }
    if (t < 0) return null;
    let restored = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.undone || e.turn !== t || e.step !== s) continue;
      this.applyUndo(e);
      e.undone = true;
      restored += 1;
    }
    return { turn: t, step: s, restored };
  }

  // Revert every change from the most recent turn that still has live entries.
  undoLastTurn(): { turn: number; restored: number } | null {
    let t = -1;
    for (const e of this.entries) if (!e.undone && e.turn > t) t = e.turn;
    if (t < 0) return null;
    let restored = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.turn !== t || e.undone) continue;
      this.applyUndo(e);
      e.undone = true;
      restored += 1;
    }
    return { turn: t, restored };
  }

  private applyUndo(e: CheckpointEntry): void {
    if (e.op === 'create') {
      rmSync(e.originalPath, { recursive: true, force: true });
      return;
    }
    // modify or delete — restore the backup over the original location.
    rmSync(e.originalPath, { recursive: true, force: true });
    if (e.backup && existsSync(e.backup)) {
      mkdirSync(dirname(e.originalPath), { recursive: true });
      cpSync(e.backup, e.originalPath, { recursive: true });
    }
  }

  // The trash can — recent deletions on disk, newest first, across all sessions.
  listTrash(): TrashItem[] {
    const out: TrashItem[] = [];
    for (const f of safeReaddir(this.trashDir)) {
      if (!f.endsWith('.meta.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.trashDir, f), 'utf8')) as TrashItem);
      } catch {
        /* skip unreadable meta */
      }
    }
    return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  // Restore a trashed item back to its original location.
  restoreFromTrash(id: string): TrashItem | null {
    const metaPath = join(this.trashDir, `${id}.meta.json`);
    const blob = join(this.trashDir, id);
    if (!existsSync(metaPath) || !existsSync(blob)) return null;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as TrashItem;
    mkdirSync(dirname(meta.originalPath), { recursive: true });
    cpSync(blob, meta.originalPath, { recursive: true });
    return meta;
  }

  // Drop trash entries older than the 7-day retention window.
  sweep(): void {
    const cutoff = Date.now() - TRASH_RETENTION_MS;
    for (const f of safeReaddir(this.trashDir)) {
      if (!f.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(readFileSync(join(this.trashDir, f), 'utf8')) as TrashItem;
        if (new Date(meta.deletedAt).getTime() < cutoff) {
          rmSync(join(this.trashDir, meta.id), { recursive: true, force: true });
          rmSync(join(this.trashDir, f), { force: true });
        }
      } catch {
        /* skip */
      }
    }
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
