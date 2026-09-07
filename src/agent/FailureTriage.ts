// When verification fails, decide whether the failures can be this turn's
// doing (Phase 4.1, the "known-broken skip"). Failing files are pulled out
// of the runner output; a failure is related when its file was changed, is
// the test twin of a changed file, or reaches a changed file through the
// code index's import graph. Failures with none of those links are reported
// as pre-existing instead of feeding a fix loop that can only flail.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CodeIndex } from '../index/CodeIndex.js';

const PATH_RE = /(?<![\w@/\\.-])((?:[A-Za-z]:[\\/])?(?:[\w.@-]+[\\/])+[\w.@-]+\.(?:tsx?|mts|cts|[cm]?jsx?|py|go|rs|java|kt|cs|rb|php|c|cc|cpp|h|hpp|vue|svelte))(?=$|[\s:(),'"`\]>])/g;
const MAX_PATHS = 50;

export interface Triage {
  related: string[];
  unrelated: string[];
  /** False when there was no basis to decide (no index, nothing extracted): treat as related. */
  decidable: boolean;
}

/** Project-relative files named in runner output that exist on disk, in order of first mention. */
export function extractFailingPaths(output: string, root: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const absRoot = resolve(root).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  for (const m of output.matchAll(PATH_RE)) {
    let p = m[1]!.replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) {
      const lower = p.toLowerCase();
      if (!lower.startsWith(`${absRoot}/`)) continue;
      p = p.slice(absRoot.length + 1);
    }
    p = p.replace(/^\.\//, '');
    if (p.includes('node_modules/') || seen.has(p)) continue;
    if (!existsSync(join(root, p))) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

export function triageFailures(index: CodeIndex | undefined, changedFiles: string[], failing: string[]): Triage {
  const changed = new Set(changedFiles.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')));
  const changedStems = new Set([...changed].map(stem));
  const related: string[] = [];
  const unrelated: string[] = [];
  if (failing.length === 0) return { related, unrelated, decidable: false };
  for (const f of failing) {
    if (changed.has(f) || changedStems.has(stem(f))) {
      related.push(f);
      continue;
    }
    if (!index) {
      related.push(f); // no graph: assume the safe thing
      continue;
    }
    const reach = index.traverse([f], { direction: 'out', hops: 2, kinds: ['imports'], maxNodes: 400 });
    if (reach.nodes.some((n) => changed.has(n.path))) related.push(f);
    else unrelated.push(f);
  }
  return { related, unrelated, decidable: index !== undefined };
}

/** `src/x/foo.test.ts` and `src/x/foo.ts` share the stem `src/x/foo`. */
function stem(p: string): string {
  return p
    .replace(/\.[^./]+$/, '')
    .replace(/[._-](test|spec|tests)$/i, '')
    .replace(/(^|\/)test_([^/]+)$/, '$1$2')
    .replace(/(^|\/)__tests__\//, '$1');
}

/** One paragraph for the user and the model when every failure is unrelated. */
export function describeUnrelated(triage: Triage, command: string): string {
  return (
    `Verification (\`${command}\`) fails only in files this turn did not touch and that do not import ` +
    `the changed files (${triage.unrelated.join(', ')}). Treating those failures as pre-existing; ` +
    'not re-running the fix loop for them.'
  );
}
