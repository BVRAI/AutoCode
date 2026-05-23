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

// `--automax` mode: write one `<<AMX>>{…}<</AMX>>\n` line to stdout per
// event. Never throws — a logging bug must not break a turn.
export class StdoutEventEmitter implements EventEmitter {
  emit(type: string, data: Record<string, unknown>): void {
    try {
      const safeData = truncateForEvent(data) as Record<string, unknown>;
      const json = JSON.stringify({ type, data: safeData });
      process.stdout.write(`<<AMX>>${json}<</AMX>>\n`);
    } catch {
      /* circular reference or stringify failure — drop the event */
    }
  }
}
