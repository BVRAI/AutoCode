import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { runScenario } from '../../src/testkit/scenario.js';

const HERE = import.meta.dirname;
const BACKEND = process.env.TTY_MODE === 'emulated' ? 'emulated' : process.env.TTY_MODE === 'pty' ? 'pty' : undefined;

describe('resize scenario — the inline transcript is rebuilt at the new width', () => {
  it('leaves no stale rows after shrinking mid-turn and growing after the turn', async () => {
    const result = await runScenario(join(HERE, 'scenarios', 'resize.json'), { backend: BACKEND });
    const byName = Object.fromEntries(result.snapshots.map((s) => [s.name, s]));

    const mid = byName['mid-turn']!.screen.join('\n');
    expect(mid).toMatch(/esc to interrupt/);

    const shrunk = byName['resized-mid-turn']!;
    expect(shrunk.cols).toBe(72);
    for (const line of shrunk.screen) expect(line.length).toBeLessThanOrEqual(72);

    const after = byName['after-turn']!.scrollback.join('\n');
    expect(after.match(/> add a --verbose flag/g)?.length).toBe(1);
    expect(after).toContain('Update(src/cli.ts)');
    // The answer wraps inside the width left after the "⏺ " prefix, so the
    // terminal never has to break a word on its own.
    expect(after).toContain('Nothing else changed.');
    expect(after).not.toMatch(/^ng$/m);
    expect(after).toMatch(/(Worked|Cooked|Sautéed|Baked|Brewed|Crafted|Hatched|Pondered|Cogitated|Percolated|Mused|Simmered) for/);

    const grown = byName['after-grow']!;
    expect(grown.cols).toBe(110);
    const all = grown.scrollback.join('\n');
    expect(all.match(/> add a --verbose flag/g)?.length).toBe(1);
    expect(all.match(/Update\(src\/cli\.ts\)/g)?.length).toBe(1);
    expect(all.match(/AutoCode v/g)?.length).toBe(1);
    expect(grown.screen.join('\n')).toMatch(/auto mode on/);
  });
});
