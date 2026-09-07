import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileEventEmitter, formatEnvelope } from '../../src/repl/EventEmitter.js';

describe('FileEventEmitter', () => {
  it('appends the same delimited envelope lines the stdout emitter writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'amx-events-'));
    const path = join(dir, 'events.amx');
    const em = new FileEventEmitter(path);
    em.emit('ready', { cwd: 'C:/x' });
    em.emit('tool_call', { name: 'read_file', args: { path: 'a.ts' } });
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(formatEnvelope('ready', { cwd: 'C:/x' }).trimEnd());
    expect(JSON.parse(/<<AMX>>(.+)<<\/AMX>>/.exec(lines[1]!)![1]!)).toEqual({
      type: 'tool_call',
      data: { name: 'read_file', args: { path: 'a.ts' } },
    });
  });

  it('does not create the file until the first event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'amx-events-'));
    const path = join(dir, 'events.amx');
    const em = new FileEventEmitter(path);
    expect(existsSync(path)).toBe(false);
    em.emit('ready', {});
    expect(existsSync(path)).toBe(true);
  });

  it('never throws on an unwritable path', () => {
    const em = new FileEventEmitter(join(tmpdir(), 'no-such-dir-' + Date.now(), 'x', 'events.amx'));
    expect(() => em.emit('ready', {})).not.toThrow();
  });
});
