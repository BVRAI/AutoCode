// Timing diagnostics for hosted-terminal problems (late resizes, event-loop
// stalls). AUTOCODE_TRACE_LOG=<file> appends one timestamped line per call;
// unset, every call is a no-op.

import { appendFileSync } from 'node:fs';

export function traceEnabled(): boolean {
  return Boolean(process.env.AUTOCODE_TRACE_LOG);
}

export function trace(line: string): void {
  const file = process.env.AUTOCODE_TRACE_LOG;
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* diagnostics only */
  }
}

/** Run `fn` and log how long it took when it exceeds `warnMs`. */
export async function traced<T>(label: string, fn: () => Promise<T>, warnMs = 100): Promise<T> {
  if (!traceEnabled()) return fn();
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const dt = Date.now() - t0;
    if (dt >= warnMs) trace(`${label} took ${dt}ms`);
  }
}

export function tracedSync<T>(label: string, fn: () => T, warnMs = 100): T {
  if (!traceEnabled()) return fn();
  const t0 = Date.now();
  try {
    return fn();
  } finally {
    const dt = Date.now() - t0;
    if (dt >= warnMs) trace(`${label} took ${dt}ms`);
  }
}
