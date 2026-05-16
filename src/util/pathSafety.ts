import { realpathSync, statSync, existsSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSafetyError';
  }
}

// Resolve a (possibly relative) path against the project root and ensure it stays inside.
// Returns the absolute resolved path. Throws PathSafetyError if the resolved target escapes.
export function resolveInsideRoot(projectRoot: string, requested: string): string {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new PathSafetyError('path must be a non-empty string');
  }
  const root = realResolve(projectRoot);
  const absolute = isAbsolute(requested) ? normalize(requested) : resolve(root, requested);
  const real = realResolve(absolute);
  const rel = relative(root, real);
  if (rel === '' || rel === '.') return real;
  if (rel.startsWith('..') || (isAbsolute(rel) && rel !== real)) {
    throw new PathSafetyError(`path escapes project root: ${requested}`);
  }
  // Also reject if rel happens to be absolute on Windows after relative()
  if (isAbsolute(rel)) {
    throw new PathSafetyError(`path escapes project root: ${requested}`);
  }
  return real;
}

// Convert an absolute path to a project-relative form for display.
export function toRelative(projectRoot: string, absolute: string): string {
  const root = realResolve(projectRoot);
  const rel = relative(root, absolute);
  return rel.length === 0 ? '.' : rel.split(sep).join('/');
}

function realResolve(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) {
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  }
  return abs;
}

export function ensureDirectory(absolute: string): void {
  const s = statSync(absolute);
  if (!s.isDirectory()) {
    throw new PathSafetyError(`not a directory: ${absolute}`);
  }
}
