import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import updateNotifier from 'update-notifier';
import pc from 'picocolors';
import { isBundled } from '../util/host.js';

export interface NotifyContext {
  bundled: boolean;
  headless: boolean;
}

export interface OwnPackage {
  name: string;
  version: string;
}

// Pure: decide whether a notification should surface. Tested without network.
export function shouldNotify(current: string, latest: string | null, ctx: NotifyContext): boolean {
  if (ctx.bundled || ctx.headless) return false;
  if (!latest) return false;
  return compareVersions(latest, current) > 0;
}

export interface AutoUpdateContext {
  bundled: boolean;
  headless: boolean;
  currentVersion: string;
  optedOutByConfig: boolean; // config.json `autoUpdate: false`
  optedOutByEnv: boolean;    // env `AUTOCODE_NO_UPDATE=1`
}

// Pure: should the harness auto-install a detected update? Auto-update is
// opt-out (autocode is too young to leave users stranded on broken
// versions), but it never runs in contexts where surprise would harm:
// bundled-in-V6, headless `-p`, or on a prerelease version (different
// release track — user is likely testing on purpose).
export function shouldAutoUpdate(ctx: AutoUpdateContext): boolean {
  if (ctx.bundled || ctx.headless) return false;
  if (ctx.optedOutByConfig || ctx.optedOutByEnv) return false;
  if (ctx.currentVersion.includes('-')) return false;
  return true;
}

// Semver comparison limited to MAJOR.MINOR.PATCH (+ optional -prerelease).
// Returns > 0 if a > b, < 0 if a < b, 0 if equal. A release outranks its
// prerelease (1.0.0 > 1.0.0-rc.1).
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const diff = pa.main[i]! - pb.main[i]!;
    if (diff !== 0) return diff;
  }
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre.localeCompare(pb.pre);
  return 0;
}

function parseVersion(v: string): { main: number[]; pre: string | null } {
  const cleaned = v.replace(/^v/, '');
  const [core, ...rest] = cleaned.split('-');
  const main = (core ?? '0.0.0').split('.').map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  while (main.length < 3) main.push(0);
  return { main: main.slice(0, 3), pre: rest.length > 0 ? rest.join('-') : null };
}

// Resolve our own name+version by reading the shipped package.json. Works
// whether running from `dist/update/UpdateChecker.js` or, during tests, from
// `src/update/UpdateChecker.ts`.
export function readOwnPackage(): OwnPackage {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'package.json'),
    join(here, '..', '..', '..', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string };
      if (j.name && j.version) return { name: j.name, version: j.version };
    } catch {
      /* try next */
    }
  }
  return { name: '@automax/autocode', version: '0.0.0' };
}

// Trigger a background npm-registry check (via update-notifier) and return a
// one-line banner string when the cache shows a newer version is available.
// Returns null otherwise. Non-blocking — the actual registry hit runs in a
// detached child; the result is read from the on-disk cache on subsequent
// runs (the standard update-notifier UX).
export function checkForUpdate(): { banner: string; latest: string } | null {
  const pkg = readOwnPackage();
  const headless = !process.stdout.isTTY;
  if (!shouldNotify(pkg.version, null, { bundled: isBundled(), headless })) {
    // Even when we won't notify, still tickle update-notifier so the
    // background cache stays fresh for the next interactive run.
    try {
      updateNotifier({ pkg });
    } catch {
      /* ignore */
    }
    return null;
  }
  let latest: string | null = null;
  try {
    const notifier = updateNotifier({ pkg, updateCheckInterval: 24 * 60 * 60 * 1000 });
    latest = notifier.update?.latest ?? null;
  } catch {
    return null;
  }
  if (!shouldNotify(pkg.version, latest, { bundled: isBundled(), headless })) return null;
  const banner =
    pc.yellow(`  ↑ autocode ${latest!} available`) +
    pc.dim(` (you have ${pkg.version}) — run `) +
    pc.cyan('/update') +
    pc.dim(' or ') +
    pc.cyan('npm i -g @automax/autocode');
  return { banner, latest: latest! };
}

export interface UpdateRunner {
  info(text: string): void;
  warn(text: string): void;
  error(text: string): void;
}

// Run `npm install -g @automax/autocode@latest`. Streams output to the
// user's terminal and reports a clear result. Returns the npm exit code.
export function runUpdate(renderer: UpdateRunner): Promise<number> {
  return new Promise((resolve) => {
    renderer.info('Updating autocode via npm…');
    const child = spawn('npm install -g @automax/autocode@latest', {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on('error', (err) => {
      renderer.error(`Update failed to start: ${err.message}. Is npm on PATH?`);
      resolve(1);
    });
    child.on('close', (code) => {
      if (code === 0) {
        renderer.info('✓ updated — restart autocode to use the new version.');
        resolve(0);
        return;
      }
      if (/EACCES|EPERM|permission/i.test(stderr)) {
        renderer.error(
          'Update failed (permission denied). Re-run with elevated privileges ' +
            '(sudo on macOS/Linux; an admin shell on Windows).',
        );
      } else {
        renderer.error(`Update failed (npm exit ${code ?? '?'}).`);
      }
      resolve(code ?? 1);
    });
  });
}
