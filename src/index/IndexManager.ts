// One CodeIndex per project root, built in the background at session start
// and refreshed (stat pass) when a tool asks for it after edits. Tools await
// `getIndex`; the prompt builder uses `peekIndex` so it never blocks a turn on
// a build that hasn't finished.

import { CodeIndex } from './CodeIndex.js';

const indexes = new Map<string, Promise<CodeIndex>>();
const ready = new Map<string, CodeIndex>();
const failures = new Map<string, string>();

export interface IndexStatus {
  state: 'idle' | 'building' | 'ready' | 'failed';
  error?: string;
}

/** Kill switch: AUTOCODE_NO_INDEX=1 disables the index, its tools and the index-backed map. */
export function indexEnabled(): boolean {
  return process.env.AUTOCODE_NO_INDEX !== '1';
}

/** Kick off (or reuse) the build for a root. Never throws. */
export function startIndex(root: string): Promise<CodeIndex> {
  let p = indexes.get(root);
  if (!p) {
    p = CodeIndex.open(root)
      .then((idx) => {
        ready.set(root, idx);
        failures.delete(root);
        return idx;
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        failures.set(root, msg);
        indexes.delete(root);
        throw new Error(`code index failed: ${msg}`);
      });
    indexes.set(root, p);
    // Swallow the rejection on the stored promise; callers that await get it.
    p.catch(() => undefined);
  }
  return p;
}

/** The index, building it first if needed, then brought up to date with a stat pass. */
export async function getIndex(root: string): Promise<CodeIndex> {
  const idx = await startIndex(root);
  await idx.refresh();
  return idx;
}

/** The index only if it is already built; never triggers a build. */
export function peekIndex(root: string): CodeIndex | undefined {
  return ready.get(root);
}

export function indexStatus(root: string): IndexStatus {
  if (ready.has(root)) return { state: 'ready' };
  if (failures.has(root)) return { state: 'failed', error: failures.get(root) };
  if (indexes.has(root)) return { state: 'building' };
  return { state: 'idle' };
}

/** Drop the in-memory index (tests, /refresh). The on-disk cache stays. */
export function resetIndex(root: string): void {
  indexes.delete(root);
  ready.delete(root);
  failures.delete(root);
}
