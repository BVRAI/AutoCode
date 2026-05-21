import { describe, it, expect } from 'vitest';
import { parseYes, AutoDenyPrompter, PrompterRef } from '../../src/repl/Prompter.js';
import { ANSWER_CANCELLED } from '../../src/repl/LineEditor.js';

describe('parseYes', () => {
  it('accepts y / yes / empty', () => {
    expect(parseYes('y')).toBe(true);
    expect(parseYes('Y')).toBe(true);
    expect(parseYes('yes')).toBe(true);
    expect(parseYes('')).toBe(true);
  });

  it('rejects other answers and a cancelled prompt', () => {
    expect(parseYes('n')).toBe(false);
    expect(parseYes('no')).toBe(false);
    expect(parseYes('nope')).toBe(false);
    expect(parseYes(ANSWER_CANCELLED)).toBe(false);
  });
});

describe('AutoDenyPrompter', () => {
  it('declines confirms, returns empty answers and no selection', async () => {
    const p = new AutoDenyPrompter();
    expect(await p.confirm('run it?')).toBe(false);
    expect(await p.ask('key?')).toBe('');
    expect(await p.choose('q', ['a', 'b'], false)).toEqual([]);
  });
});

describe('PrompterRef', () => {
  it('delegates to the swapped-in implementation', async () => {
    const ref = new PrompterRef(new AutoDenyPrompter());
    expect(await ref.confirm('x')).toBe(false);
    ref.use({ confirm: async () => true, ask: async () => 'hi', choose: async () => [1] });
    expect(await ref.confirm('x')).toBe(true);
    expect(await ref.ask('x')).toBe('hi');
    expect(await ref.choose('q', ['a', 'b'], false)).toEqual([1]);
  });
});
