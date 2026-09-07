// The Localize subagent's result contract (Gemini CLI's codebase-investigator
// shape, extended with spans): a JSON object the parent can trust, rendered
// as a compact ranked list for the transcript and the parent's context.

export interface RelevantLocation {
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  reasoning: string;
  /** 0–1; the parent asks the user when the top candidates are close. */
  confidence?: number;
}

export interface LocalizeResult {
  locations: RelevantLocation[];
  summary: string;
  /** Set when two readings of the request lead to different places. */
  ambiguity?: string;
}

const MAX_LOCATIONS = 12;

/** Parse the subagent's final text; null when it is not the JSON contract. */
export function parseLocalizeResult(text: string): LocalizeResult | null {
  const candidate = extractJson(text);
  if (!candidate) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj['locations']) ? (obj['locations'] as unknown[]) : null;
  if (!list) return null;
  const locations: RelevantLocation[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const path = typeof it['path'] === 'string' ? it['path'].replace(/\\/g, '/').trim() : '';
    if (!path) continue;
    const loc: RelevantLocation = {
      path,
      reasoning: typeof it['reasoning'] === 'string' ? it['reasoning'].trim() : '',
    };
    if (typeof it['symbol'] === 'string' && it['symbol'].trim()) loc.symbol = it['symbol'].trim();
    const s = numberOf(it['startLine'] ?? it['start_line']);
    const e = numberOf(it['endLine'] ?? it['end_line']);
    if (s !== undefined) loc.startLine = s;
    if (e !== undefined) loc.endLine = e;
    const c = numberOf(it['confidence']);
    if (c !== undefined) loc.confidence = Math.max(0, Math.min(1, c));
    locations.push(loc);
    if (locations.length >= MAX_LOCATIONS) break;
  }
  return {
    locations,
    summary: typeof obj['summary'] === 'string' ? obj['summary'].trim() : '',
    ambiguity: typeof obj['ambiguity'] === 'string' && obj['ambiguity'].trim() ? obj['ambiguity'].trim() : undefined,
  };
}

/** `path:12-40  Symbol  (0.9) — reasoning` lines, best first, plus summary and ambiguity. */
export function renderLocalizeResult(r: LocalizeResult): string {
  const lines: string[] = [];
  if (r.summary) lines.push(r.summary, '');
  if (r.locations.length === 0) lines.push('(no locations found)');
  const sorted = [...r.locations].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  for (const loc of sorted) {
    const span = loc.startLine !== undefined ? `:${loc.startLine}${loc.endLine !== undefined && loc.endLine !== loc.startLine ? `-${loc.endLine}` : ''}` : '';
    const conf = loc.confidence !== undefined ? `  (${loc.confidence.toFixed(2)})` : '';
    lines.push(`${loc.path}${span}${loc.symbol ? `  ${loc.symbol}` : ''}${conf}${loc.reasoning ? ` — ${loc.reasoning}` : ''}`);
  }
  if (r.ambiguity) lines.push('', `Ambiguity: ${r.ambiguity}`);
  return lines.join('\n');
}

function extractJson(text: string): string | null {
  const t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fence ? fence[1]!.trim() : t;
  if (body.startsWith('{')) return body;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return null;
}

function numberOf(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
}
