// Server-Sent Events line parser. Both Anthropic's Messages SSE and the
// OpenAI/xAI/OpenRouter chat-completions SSE follow the SSE format:
// - blank line separates events
// - lines are "field: value" pairs (event:, data:, id:, retry:)
// - within an event, "data:" can repeat and is concatenated with \n
//
// We yield one parsed event per blank-line-separated record so callers can
// switch on `event` (Anthropic) or just parse `data` (OpenAI).

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array> | null,
): AsyncIterable<SseEvent> {
  if (!stream) return;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.length > 0) {
          const parsed = parseRecord(buffer);
          if (parsed) yield parsed;
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const record = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseRecord(record);
        if (parsed) yield parsed;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function parseRecord(record: string): SseEvent | null {
  if (record.trim().length === 0) return null;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const raw of record.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length === 0) continue;
    if (line.startsWith(':')) continue; // comment
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && !event) return null;
  return { event, data: dataLines.join('\n') };
}
