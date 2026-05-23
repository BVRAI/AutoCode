import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';

// Helpers for cooperating with a host process (Automax V6) that runs
// autocode inside a terminal. When hosted, autocode emits structured signal
// lines the host can act on; standalone, those code paths fall back to
// ordinary OS behavior.

// True when autocode is launched by Automax (it sets AUTOMAX_PROXY_TOKEN).
export function isAutomaxHosted(): boolean {
  return Boolean(process.env.AUTOMAX_PROXY_TOKEN);
}

// True when this is the V6-bundled copy of autocode (updated by V6's Velopack —
// the bundled copy must not try to self-update or nag the user). Set by V6 at
// launch via the AUTOMAX_BUNDLED env var; a sentinel `.automax-bundled` file
// next to the install also works for non-launcher distribution.
export function isBundled(): boolean {
  if (process.env.AUTOMAX_BUNDLED === '1') return true;
  return false;
}

// Emit a host-protocol line to stdout. The host (V6, Phase 9) scans for the
// `@@autocode:` prefix and filters these lines out of the visible terminal.
export function emitHostSignal(type: string, payload: unknown): void {
  process.stdout.write(`@@autocode:${type} ${JSON.stringify(payload)}\n`);
}

let requestSeq = 0;

// Make a request to the Automax host and wait for a result. autocode emits
// `@@autocode:<type> {requestId, resultPath, ...}`; the host does the work
// and writes a JSON result to `resultPath`, which autocode polls for. This
// file-based round-trip avoids racing the REPL's readline on stdin and works
// the same in interactive and headless mode. Returns null on timeout.
export async function requestHostResult(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<Record<string, unknown> | null> {
  const ioDir = join(dataDir(), 'host-io');
  mkdirSync(ioDir, { recursive: true });
  requestSeq += 1;
  const requestId = `${Date.now().toString(36)}-${requestSeq}`;
  const resultPath = join(ioDir, `${requestId}.result.json`);
  emitHostSignal(type, { requestId, resultPath, ...payload });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      try {
        const data = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
        rmSync(resultPath, { force: true });
        return data;
      } catch {
        rmSync(resultPath, { force: true });
        return null;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// The platform command to open a URL in the user's default browser.
export function osOpenCommand(url: string): { cmd: string; args: string[] } {
  switch (process.platform) {
    case 'win32':
      // The empty "" is start's window-title argument; without it a quoted
      // URL would be treated as the title.
      return { cmd: 'cmd', args: ['/c', 'start', '""', url] };
    case 'darwin':
      return { cmd: 'open', args: [url] };
    default:
      return { cmd: 'xdg-open', args: [url] };
  }
}
