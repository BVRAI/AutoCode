import { describe, it, expect } from 'vitest';
import { parseSseStream } from '../../src/llm/sse.js';

function stringStream(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(parts[i]!));
      i += 1;
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('parseSseStream', () => {
  it('parses a single data-only event', async () => {
    const events = await collect(parseSseStream(stringStream(['data: hello\n\n'])));
    expect(events).toEqual([{ event: undefined, data: 'hello' }]);
  });

  it('parses event + data pairs', async () => {
    const events = await collect(parseSseStream(stringStream(['event: ping\ndata: 1\n\n'])));
    expect(events).toEqual([{ event: 'ping', data: '1' }]);
  });

  it('concatenates multi-line data fields with newlines', async () => {
    const events = await collect(parseSseStream(stringStream(['data: line1\ndata: line2\n\n'])));
    expect(events).toEqual([{ event: undefined, data: 'line1\nline2' }]);
  });

  it('handles records split across chunks', async () => {
    const events = await collect(
      parseSseStream(stringStream(['event: foo\nda', 'ta: ba', 'r\n', '\n'])),
    );
    expect(events).toEqual([{ event: 'foo', data: 'bar' }]);
  });

  it('skips comment lines starting with colon', async () => {
    const events = await collect(parseSseStream(stringStream([': keepalive\ndata: x\n\n'])));
    expect(events).toEqual([{ event: undefined, data: 'x' }]);
  });

  it('flushes the trailing record when stream ends without blank line', async () => {
    const events = await collect(parseSseStream(stringStream(['data: tail'])));
    expect(events).toEqual([{ event: undefined, data: 'tail' }]);
  });
});
