import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario, normalizeScreen, type Snapshot } from '../../src/testkit/scenario.js';

const HERE = import.meta.dirname;
const SCENARIOS = join(HERE, 'scenarios');
const SCREENS = join(HERE, '__screens__');
const UPDATE = process.env.UPDATE_SCREENS === '1';
const BACKEND = process.env.TTY_MODE === 'emulated' ? 'emulated' : process.env.TTY_MODE === 'pty' ? 'pty' : undefined;

function checkGolden(scenario: string, snap: Snapshot): void {
  mkdirSync(SCREENS, { recursive: true });
  const file = join(SCREENS, `${scenario}.${snap.name}.${snap.cols}x${snap.rows}.txt`);
  const actual = normalizeScreen(snap.screen).join('\n');
  if (UPDATE || !existsSync(file)) {
    writeFileSync(file, actual + '\n');
    return;
  }
  const expected = readFileSync(file, 'utf8').replace(/\n$/, '');
  expect(actual).toBe(expected);
}

describe('review scenario — the Review subagent gates the end of a turn', () => {
  it('shows the review row, requests changes, and the agent fixes them in one more round', async () => {
    const result = await runScenario(join(SCENARIOS, 'review.json'), { backend: BACKEND });
    const byName = Object.fromEntries(result.snapshots.map((s) => [s.name, s]));
    const turn = byName['after-turn']!.scrollback.join('\n');

    expect(turn).toContain('> fix parseArgs so a bare --flag counts as true');
    expect(turn).toContain('Review(1 file)');
    expect(turn).toMatch(/Changes requested \(2 findings\)/);
    expect(turn).toContain('[high] src/util.ts:11');
    // Two edits: the original and the fix the review asked for.
    expect(turn.match(/Update\(src\/util\.ts\)/g)?.length).toBe(2);
    expect(turn).toMatch(/counts as true too, as the review pointed out/);
    expect(turn).toMatch(/(Worked|Cooked|Sautéed|Baked|Brewed|Crafted|Hatched|Pondered|Cogitated|Percolated|Mused|Simmered) for \d+s · done \d{1,2}:\d{2} [AP]M/);

    for (const snap of result.snapshots) checkGolden('review', snap);
  });
});
