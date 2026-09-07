// TTY emulation and host-driven resizes.
//
// AUTOCODE_TTY_EMULATE=<cols>x<rows> makes the harness treat piped stdio as
// an interactive terminal: stdout/stdin report isTTY, stdout carries the given
// size and raw mode is a no-op. The test driver (src/testkit/tty.ts) feeds the
// byte stream into a headless xterm.
//
// Independently of emulation, the Ink app reads stdin through a filter that
// understands two host-only markers. `[[amx:resize:<cols>x<rows>]]` is
// applied as a window-size change (stdout columns/rows + the 'resize'
// event): hosts that own the pseudo-console — Automax's terminal, the e2e
// driver — send it right after resizing the pty, because ConPTY hands the
// native resize to an idle Node process late or not at all (which is what
// left stale rows behind after a drag). `[[amx:theme:light|dark]]` tells the
// app the host's background changed (Automax's theme toggle) so it can swap
// palettes and rebuild — without it a session launched in dark mode kept
// painting near-white text on the now-white pane. Both markers are plain
// printable text on purpose: ConPTY drops escape sequences and private-use
// characters written to its input, but forwards ordinary keys.

import { PassThrough, type Readable } from 'node:stream';
import { trace } from './trace.js';

export const RESIZE_MARK_RE = /\[\[amx:resize:(\d+)x(\d+)\]\]/g;
export const THEME_MARK_RE = /\[\[amx:theme:(light|dark)\]\]/g;
const MARK_PREFIXES = ['[[amx:resize:', '[[amx:theme:'];
const PENDING_FLUSH_MS = 120;

export function resizeMark(cols: number, rows: number): string {
  return `[[amx:resize:${cols}x${rows}]]`;
}

export function themeMark(name: 'light' | 'dark'): string {
  return `[[amx:theme:${name}]]`;
}

export type HostThemeName = 'light' | 'dark';
const themeListeners = new Set<(name: HostThemeName) => void>();

/** Subscribe to host theme notices; returns the unsubscribe function. */
export function onHostTheme(listener: (name: HostThemeName) => void): () => void {
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

export function applyHostTheme(name: HostThemeName): void {
  trace(`theme: marker ${name}`);
  for (const listener of themeListeners) {
    try {
      listener(name);
    } catch {
      /* one listener must not break the others */
    }
  }
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

export interface HostMarkHandlers {
  resize: (cols: number, rows: number) => void;
  theme: (name: HostThemeName) => void;
}

/** Could `tail` be the beginning of a marker that the next chunk completes? */
function isPartialMark(tail: string): boolean {
  for (const prefix of MARK_PREFIXES) {
    if (tail.length <= prefix.length) {
      if (prefix.startsWith(tail)) return true;
      continue;
    }
    if (!tail.startsWith(prefix)) continue;
    const body = tail.slice(prefix.length);
    if (prefix === '[[amx:resize:' && /^\d*(x\d*)?\]?$/.test(body)) return true;
    if (prefix === '[[amx:theme:' && /^[a-z]*\]?$/.test(body)) return true;
  }
  return false;
}

/**
 * Strip complete host markers from `text`, applying each; keep a trailing
 * partial marker for the next chunk (ConPTY may split a write). Returns the
 * text to forward and the pending tail.
 */
export function filterHostMarks(text: string, apply: HostMarkHandlers): { out: string; pending: string } {
  // One pass so markers apply in the order the host wrote them.
  let out = text.replace(/\[\[amx:(?:resize:(\d+)x(\d+)|theme:(light|dark))\]\]/g, (_m, c?: string, r?: string, name?: string) => {
    if (name === 'light' || name === 'dark') apply.theme(name);
    else if (c !== undefined && r !== undefined) apply.resize(Number(c), Number(r));
    return '';
  });
  // A partial marker at the end: the longest suffix that is a prefix of a
  // full marker ("[[amx:resize:80x" …) waits for the rest.
  let pending = '';
  for (let len = Math.min(out.length, 30); len > 0; len--) {
    const tail = out.slice(out.length - len);
    if (isPartialMark(tail)) {
      pending = tail;
      out = out.slice(0, out.length - len);
      break;
    }
  }
  return { out, pending };
}

/** Resize-only view of filterHostMarks (theme markers are still stripped and applied). */
export function filterResizeMarks(text: string, apply: (cols: number, rows: number) => void): { out: string; pending: string } {
  return filterHostMarks(text, { resize: apply, theme: applyHostTheme });
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
    const r = filterHostMarks(text, { resize: applyResize, theme: applyHostTheme });
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
