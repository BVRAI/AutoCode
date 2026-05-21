import { describe, it, expect, vi } from 'vitest';
import { ConsoleRenderer } from '../../src/repl/ConsoleRenderer.js';

function capture(fn: () => void): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    chunks.push(String(c));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

describe('ConsoleRenderer assistant stream', () => {
  it('buffers chunks — nothing is written until endAssistantStream', () => {
    const r = new ConsoleRenderer();
    const out = capture(() => {
      r.beginAssistantStream();
      r.streamChunk('hello ');
      r.streamChunk('world');
    });
    expect(out).toBe('');
  });

  it('renders the buffered markdown as styled output at end of stream', () => {
    const r = new ConsoleRenderer();
    const out = capture(() => {
      r.streamChunk('# Heading\n\nsome **bold** text\n');
      r.endAssistantStream();
    });
    expect(out).toContain('ac:');
    // literal markdown markers are gone — it was rendered, not printed raw
    expect(out).not.toContain('**bold**');
    expect(out).not.toContain('# Heading');
    // the words survive (styled)
    expect(out.toLowerCase()).toContain('bold');
    expect(out.toLowerCase()).toContain('heading');
  });

  it('endAssistantStream writes nothing when no text was streamed', () => {
    const r = new ConsoleRenderer();
    const out = capture(() => r.endAssistantStream());
    expect(out).toBe('');
  });
});
