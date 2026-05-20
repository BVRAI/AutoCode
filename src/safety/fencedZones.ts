import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

// Absolute-path zones that NO autocode operation may ever mutate — not in any
// mode, not behind any confirmation. This is the protection floor: it must be
// programmatically impossible for the agent to destroy the OS, system
// configuration, or the user's credentials.
//
// The system *drive root* itself (C:\, /) is intentionally NOT fenced — user
// projects live under it. Only specific system/credential subtrees are.
function buildFencedPrefixes(): string[] {
  const home = homedir();
  const prefixes: string[] = [];

  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const sysDrive = process.env.SystemDrive ?? 'C:';
    prefixes.push(
      sysRoot,
      `${sysDrive}\\Program Files`,
      `${sysDrive}\\Program Files (x86)`,
      `${sysDrive}\\ProgramData`,
      `${sysDrive}\\$Recycle.Bin`,
      `${sysDrive}\\System Volume Information`,
    );
  } else {
    prefixes.push(
      '/etc', '/usr', '/bin', '/sbin', '/lib', '/boot', '/dev', '/sys', '/proc',
      '/System', '/Library', '/private', '/Applications',
    );
  }

  // Credential / key material — sensitive on every platform.
  for (const d of ['.ssh', '.aws', '.gnupg', '.kube', '.docker']) {
    prefixes.push(join(home, d));
  }
  prefixes.push(join(home, '.config', 'gcloud'));

  // autocode's own config/state — the agent must not compromise its own logs.
  prefixes.push(join(home, '.autocode'));

  return prefixes.map((p) => resolve(p));
}

export const FENCED_PREFIXES: readonly string[] = buildFencedPrefixes();

function norm(p: string): string {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

// True if `absPath` is, or is inside, a fenced zone.
export function isFenced(absPath: string): boolean {
  return fencedReason(absPath) !== null;
}

// The matched fenced prefix if `absPath` is fenced, else null.
export function fencedReason(absPath: string): string | null {
  const target = norm(absPath);
  for (const prefix of FENCED_PREFIXES) {
    const p = norm(prefix);
    if (target === p || target.startsWith(p + sep)) return prefix;
  }
  return null;
}
