// TTY emulation for end-to-end tests without a pseudo-console.
//
// AUTOCODE_TTY_EMULATE=<cols>x<rows> makes the harness treat piped stdio as
// an interactive terminal: stdout/stdin report isTTY, stdout carries the given
// size, raw mode is a no-op, and a private OSC on stdin
// (`ESC ] 7777 ; resize ; <cols>x<rows> BEL`) changes the size and fires
// stdout's 'resize' event exactly as a window-size change would. The test
// driver (src/testkit/tty.ts) feeds the byte stream into a headless xterm.
// Off unless the variable is set; production behavior is untouched.

import { PassThrough, type Readable } from 'node:stream';

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
 * The stdin the Ink app should read in emulated mode: process.stdin with the
 * resize OSC filtered out and applied. Plain process.stdin otherwise.
 */
export function emulatedStdin(): NodeJS.ReadStream {
  if (!emulated) return process.stdin;
  if (stdinProxy) return stdinProxy as unknown as NodeJS.ReadStream;
  const proxy = new PassThrough();
  const p = proxy as unknown as Record<string, unknown>;
  p['isTTY'] = true;
  p['setRawMode'] = () => proxy;
  p['ref'] = () => proxy;
  p['unref'] = () => proxy;
  process.stdin.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const rest = text.replace(/\x1b\]7777;resize;(\d+)x(\d+)\x07/g, (_m, c: string, r: string) => {
      applyResize(Number(c), Number(r));
      return '';
    });
    if (rest.length > 0) proxy.write(rest);
  });
  process.stdin.on('end', () => proxy.end());
  process.stdin.resume();
  stdinProxy = proxy;
  return proxy as unknown as NodeJS.ReadStream;
}

function applyResize(cols: number, rows: number): void {
  if (!emulated || cols < 4 || rows < 2) return;
  emulated = { cols, rows };
  const out = process.stdout as unknown as Record<string, unknown>;
  out['columns'] = cols;
  out['rows'] = rows;
  process.stdout.emit('resize');
}
