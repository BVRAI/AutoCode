// TTY emulation and host-driven resizes.
//
// AUTOCODE_TTY_EMULATE=<cols>x<rows> makes the harness treat piped stdio as
// an interactive terminal: stdout/stdin report isTTY, stdout carries the given
// size and raw mode is a no-op. The test driver (src/testkit/tty.ts) feeds the
// byte stream into a headless xterm.
//
// Independently of emulation, the Ink app reads stdin through a filter that
// understands one host-only marker, `[[amx:resize:<cols>x<rows>]]`, and
// applies it as a window-size change (stdout columns/rows + the 'resize'
// event). Hosts that own the pseudo-console — Automax's terminal, the e2e
// driver — send it right after resizing the pty, because ConPTY hands the
// native resize to an idle Node process late or not at all (which is what
// left stale rows behind after a drag). The marker is plain printable text on
// purpose: ConPTY drops escape sequences and private-use characters written
// to its input, but forwards ordinary keys.

import { PassThrough, type Readable } from 'node:stream';
import { trace } from './trace.js';

export const RESIZE_MARK_RE = /\[\[amx:resize:(\d+)x(\d+)\]\]/g;
const RESIZE_MARK_PREFIX = '[[amx:resize:';
const PENDING_FLUSH_MS = 120;

export function resizeMark(cols: number, rows: number): string {
  return `[[amx:resize:${cols}x${rows}]]`;
}

let emulated: { cols: number; rows: number } | null = null;
let stdinProxy: Readable | null = null;

export function installTtyEmulation(): boolean {
  const m = /^(\d+)x(\d+)$/.exec(process.env.AUTOCODE_TTY_EMULATE?.trim() ?? '');
  if (!m) return false;
  emulated = { cols: Number(m[1]), rows: Number(m[2]) };
  const out = process.stdout as unknown as Record<string, unknown>;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true });
  out['columns'] = emulated.cols;
  out['rows'] = emulated.rows;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true, writable: true });
  (process.stdin as unknown as Record<string, unknown>)['setRawMode'] = () => process.stdin;
  return true;
}

export function isTtyEmulated(): boolean {
  return emulated !== null;
}

/**
 * Strip complete resize markers from `text`, applying each; keep a trailing
 * partial marker for the next chunk (ConPTY may split a write). Returns the
 * text to forward and the pending tail.
 */
export function filterResizeMarks(text: string, apply: (cols: number, rows: number) => void): { out: string; pending: string } {
  let out = text.replace(RESIZE_MARK_RE, (_m, c: string, r: string) => {
    apply(Number(c), Number(r));
    return '';
  });
  // A partial marker at the end: the longest suffix that is a prefix of a
  // full marker ("[[amx:resize:80x" …) waits for the rest.
  let pending = '';
  for (let len = Math.min(out.length, 30); len > 0; len--) {
    const tail = out.slice(out.length - len);
    const probe = tail.length <= RESIZE_MARK_PREFIX.length ? RESIZE_MARK_PREFIX.startsWith(tail) : tail.startsWith(RESIZE_MARK_PREFIX) && /^\[\[amx:resize:\d*(x\d*)?\]?$/.test(tail);
    if (probe) {
      pending = tail;
      out = out.slice(0, out.length - len);
      break;
    }
  }
  return { out, pending };
}

/**
 * The stdin the Ink app should read: process.stdin behind the resize-marker
 * filter whenever stdin is (or emulates) a terminal; plain process.stdin for
 * pipes, where nothing interactive runs.
 */
export function resizeAwareStdin(): NodeJS.ReadStream {
  if (stdinProxy) return stdinProxy as unknown as NodeJS.ReadStream;
  if (!emulated && !process.stdin.isTTY) return process.stdin;
  const real = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => unknown };
  const proxy = new PassThrough();
  const p = proxy as unknown as Record<string, unknown>;
  p['isTTY'] = true;
  p['setRawMode'] = (mode: boolean) => {
    trace(`stdin: setRawMode(${mode})`);
    if (!emulated && typeof real.setRawMode === 'function') {
      try {
        real.setRawMode(mode);
      } catch {
        /* not a tty after all */
      }
    }
    return proxy;
  };
  p['ref'] = () => proxy;
  p['unref'] = () => proxy;
  let pending = '';
  let pendingTimer: NodeJS.Timeout | null = null;
  const flushPending = (): void => {
    pendingTimer = null;
    if (pending.length > 0) {
      proxy.write(pending);
      pending = '';
    }
  };
  real.on('data', (chunk: Buffer | string) => {
    const text = pending + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    trace(`stdin: data ${JSON.stringify(text).slice(0, 48)}`);
    const r = filterResizeMarks(text, applyResize);
    pending = r.pending;
    if (r.out.length > 0) proxy.write(r.out);
    if (pending.length > 0) pendingTimer = setTimeout(flushPending, PENDING_FLUSH_MS);
  });
  real.on('end', () => {
    flushPending();
    proxy.end();
  });
  real.resume();
  stdinProxy = proxy;
  return proxy as unknown as NodeJS.ReadStream;
}

/** @deprecated name kept for the Ink mount; same as resizeAwareStdin(). */
export function emulatedStdin(): NodeJS.ReadStream {
  return resizeAwareStdin();
}

/** Apply a host-reported size as if the terminal had been resized. */
export function applyResize(cols: number, rows: number): void {
  if (cols < 4 || rows < 2) return;
  trace(`resize: marker ${cols}x${rows}`);
  if (emulated) emulated = { cols, rows };
  const out = process.stdout as unknown as Record<string, unknown>;
  if (out['columns'] === cols && out['rows'] === rows) return;
  out['columns'] = cols;
  out['rows'] = rows;
  process.stdout.emit('resize');
}
