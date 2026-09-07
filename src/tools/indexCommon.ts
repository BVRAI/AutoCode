// Shared plumbing for the three code-index tools: getting the index for the
// session's project (building it on first use), resolving the loose entity
// references a model writes, and the output cap every listing respects.

import { getIndex, indexStatus } from '../index/IndexManager.js';
import type { CodeIndex, EntityNode } from '../index/CodeIndex.js';
import { resolveInsideRoot, toRelative } from '../util/pathSafety.js';
import type { ToolResult } from './types.js';

/** Hard cap on what one index tool returns (small models overflow on listings). */
export const INDEX_OUTPUT_CAP = 24_000;

export function indexDisabled(): boolean {
  return process.env.AUTOCODE_NO_INDEX === '1';
}

export async function indexFor(root: string): Promise<{ index: CodeIndex } | { error: ToolResult }> {
  if (indexDisabled()) {
    return {
      error: {
        summary: 'code index disabled',
        content: 'The code index is disabled (AUTOCODE_NO_INDEX=1). Use grep, glob and find_symbol instead.',
        isError: true,
      },
    };
  }
  try {
    const index = await getIndex(root);
    return { index };
  } catch (e) {
    const status = indexStatus(root);
    return {
      error: {
        summary: 'code index unavailable',
        content: `The code index could not be built (${status.error ?? (e instanceof Error ? e.message : String(e))}). Use grep, glob and find_symbol instead.`,
        isError: true,
      },
    };
  }
}

/**
 * Turn one model-written reference into entity nodes. Accepts an entity id
 * (`src/a.ts::App.render`), a path (relative, absolute, or with backslashes),
 * `path#symbol`, `path:line`, or a bare symbol name.
 */
export function resolveRef(index: CodeIndex, root: string, ref: string): EntityNode[] {
  const raw = ref.trim();
  if (raw.length === 0) return [];
  const direct = index.resolve(raw);
  if (direct.length > 0) return direct;
  // Path-looking references may be absolute or use backslashes; normalize
  // against the project root and retry.
  const pathPart = raw.split(/::|#/)[0]!.replace(/:(\d+)$/, '');
  if (/[\\/]/.test(pathPart) || /\.\w+$/.test(pathPart)) {
    try {
      const rel = toRelative(root, resolveInsideRoot(root, pathPart)).replace(/\\/g, '/');
      if (rel !== pathPart) return index.resolve(raw.replace(pathPart, rel));
    } catch {
      /* outside the root or malformed: no match */
    }
  }
  return [];
}

export function capOutput(text: string, cap = INDEX_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… (output truncated at ${cap} chars; narrow the query)`;
}

export function stringList(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  throw new Error(`argument '${key}' must be an array of strings`);
}
