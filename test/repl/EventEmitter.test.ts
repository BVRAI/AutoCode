import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  NullEventEmitter,
  StdoutEventEmitter,
  truncateForEvent,
} from '../../src/repl/EventEmitter.js';

describe('truncateForEvent', () => {
  it('passes a short string through unchanged', () => {
    expect(truncateForEvent('hello')).toBe('hello');
  });

  it('truncates a long string with a marker showing how much was dropped', () => {
    const long = 'x'.repeat(600);
    const out = truncateForEvent(long, 500) as string;
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.startsWith('x'.repeat(500))).toBe(true);
    expect(out).toContain('…[+100 more]');
  });

  it('walks nested objects and arrays', () => {
    const long = 'x'.repeat(600);
    const out = truncateForEvent({ a: [long, { b: long }] }, 500) as {
      a: [string, { b: string }];
    };
    expect(out.a[0]).toContain('…[+100 more]');
    expect(out.a[1].b).toContain('…[+100 more]');
  });

  it('passes numbers, booleans, and null through unchanged', () => {
    expect(truncateForEvent(42)).toBe(42);
    expect(truncateForEvent(true)).toBe(true);
    expect(truncateForEvent(null)).toBeNull();
  });
});

describe('NullEventEmitter', () => {
  it('does not write to stdout', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    new NullEventEmitter().emit('whatever', { a: 1 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('StdoutEventEmitter', () => {
  let writes: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    writes = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString());
      return true;
    });
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it('writes one delimited line with type and data keys', () => {
    new StdoutEventEmitter().emit('tool_call', { name: 'edit_file', args: { path: 'x.ts' } });
    expect(writes).toHaveLength(1);
    const line = writes[0]!;
    expect(line.startsWith('<<AMX>>')).toBe(true);
    expect(line.endsWith('<</AMX>>\n')).toBe(true);
    const body = line.slice('<<AMX>>'.length, line.lastIndexOf('<</AMX>>'));
    const parsed = JSON.parse(body) as { type: string; data: Record<string, unknown> };
    expect(parsed.type).toBe('tool_call');
    expect(parsed.data).toEqual({ name: 'edit_file', args: { path: 'x.ts' } });
  });

  it('truncates a large string field in the data payload', () => {
    const long = 'y'.repeat(600);
    new StdoutEventEmitter().emit('tool_call', { args: { content: long } });
    const body = writes[0]!.slice('<<AMX>>'.length, writes[0]!.lastIndexOf('<</AMX>>'));
    const parsed = JSON.parse(body) as { data: { args: { content: string } } };
    expect(parsed.data.args.content).toContain('…[+100 more]');
  });

  it('swallows a circular-reference stringify failure instead of throwing', () => {
    const data: Record<string, unknown> = { name: 'x' };
    data.self = data;
    expect(() => new StdoutEventEmitter().emit('tool_call', data)).not.toThrow();
    expect(writes).toHaveLength(0); // event dropped, no line written
  });

  it('emits the launch-time ready handshake in the exact envelope V6 expects', () => {
    // Byte-for-byte contract with Automax V6's AutoCodeEventBridge — key order
    // included (pid, cwd, mode).
    new StdoutEventEmitter().emit('ready', { pid: 4242, cwd: '/tmp/proj', mode: 'default' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(
      '<<AMX>>{"type":"ready","data":{"pid":4242,"cwd":"/tmp/proj","mode":"default"}}<</AMX>>\n',
    );
  });
});

describe('NullEventEmitter — ready handshake', () => {
  it('stays silent for the ready event in standalone (non-automax) runs', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    new NullEventEmitter().emit('ready', { pid: 1, cwd: '/x', mode: 'default' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
