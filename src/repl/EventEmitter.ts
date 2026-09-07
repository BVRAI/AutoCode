// Machine-readable activity events for the Automax V6 host.
//
// When --automax is on, autocode emits one delimited JSON line per
// significant moment in a turn — V6's AutoCodeEventBridge tails the pty for
// `<<AMX>>{…}<</AMX>>` blocks and translates them into ChildAgentRecord
// updates so Max sees autocode's live state without scraping the terminal.
//
// The format is intentionally human-glanceable so the raw events stay
// readable to a developer watching the terminal. Distinct from the
// `@@autocode:<type> <json>` host-signal channel in src/util/host.ts
// (file-based round-trips that V6 filters out — the new channel is
// surfaced-by-design).

import { openSync, writeSync } from 'node:fs';

export interface EventEmitter {
  emit(type: string, data: Record<string, unknown>): void;
}

const MAX_STRING_FIELD = 500;

// Recursively truncate every string field in `value` so a giant tool arg or
// summary doesn't bloat the event line. Numbers / booleans / null pass
// through; arrays and plain objects are walked.
export function truncateForEvent(value: unknown, max: number = MAX_STRING_FIELD): unknown {
  if (typeof value === 'string') {
    if (value.length <= max) return value;
    return value.slice(0, max) + `…[+${value.length - max} more]`;
  }
  if (Array.isArray(value)) return value.map((v) => truncateForEvent(v, max));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateForEvent(v, max);
    }
    return out;
  }
  return value;
}

// Default emitter — call sites stay un-conditional; this just does nothing.
export class NullEventEmitter implements EventEmitter {
  emit(_type: string, _data: Record<string, unknown>): void {
    /* no-op */
  }
}

export function formatEnvelope(type: string, data: Record<string, unknown>): string {
  const safeData = truncateForEvent(data) as Record<string, unknown>;
  return `<<AMX>>${JSON.stringify({ type, data: safeData })}<</AMX>>\n`;
}

// `--automax` mode: write one `<<AMX>>{…}<</AMX>>\n` line to stdout per
// event. Never throws — a logging bug must not break a turn.
export class StdoutEventEmitter implements EventEmitter {
  emit(type: string, data: Record<string, unknown>): void {
    try {
      process.stdout.write(formatEnvelope(type, data));
    } catch {
      /* circular reference or stringify failure — drop the event */
    }
  }
}

// `--automax` with AUTOMAX_EVENT_FILE set: the same envelope lines, appended
// to a file the host tails instead of the screen stream. Writing events to
// stdout while the Ink UI owns the terminal moves the cursor under Ink's
// feet (one stale row per event), so a hosted session keeps the two apart.
// Sync appends keep ordering; events are small and infrequent.
export class FileEventEmitter implements EventEmitter {
  private fd: number | null = null;

  constructor(private readonly path: string) {}

  emit(type: string, data: Record<string, unknown>): void {
    try {
      const line = formatEnvelope(type, data);
      if (this.fd === null) this.fd = openSync(this.path, 'a');
      writeSync(this.fd, line);
    } catch {
      /* unwritable file or stringify failure — drop the event */
    }
  }
}
