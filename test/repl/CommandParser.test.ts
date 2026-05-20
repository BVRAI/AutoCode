import { describe, it, expect } from 'vitest';
import { parse } from '../../src/repl/CommandParser.js';

describe('CommandParser.parse', () => {
  it('treats blank input as empty', () => {
    expect(parse('   ')).toEqual({ kind: 'empty' });
  });

  it('parses /help', () => {
    expect(parse('/help')).toEqual({ kind: 'local', name: 'help', args: [] });
  });

  it('parses /cwd with a path', () => {
    expect(parse('/cwd C:\\foo\\bar')).toEqual({
      kind: 'local',
      name: 'cwd',
      args: ['C:\\foo\\bar'],
    });
  });

  it('parses /model with provider and name', () => {
    expect(parse('/model anthropic claude-opus-4-7')).toEqual({
      kind: 'local',
      name: 'model',
      args: ['anthropic', 'claude-opus-4-7'],
    });
  });

  it('treats unknown slash-prefixed input as agent text', () => {
    expect(parse('/nope what is this')).toEqual({
      kind: 'agent',
      text: '/nope what is this',
    });
  });

  it('treats plain text as agent input', () => {
    expect(parse('fix the bug in foo.ts')).toEqual({
      kind: 'agent',
      text: 'fix the bug in foo.ts',
    });
  });

  it('is case-insensitive on command name', () => {
    expect(parse('/EXIT')).toEqual({ kind: 'local', name: 'exit', args: [] });
  });

  it('parses /mode with an argument', () => {
    expect(parse('/mode planning')).toEqual({
      kind: 'local',
      name: 'mode',
      args: ['planning'],
    });
  });

  it('no longer recognizes /plan (treated as agent text)', () => {
    expect(parse('/plan')).toEqual({ kind: 'agent', text: '/plan' });
  });
});
