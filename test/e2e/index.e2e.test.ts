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

describe('index scenario — the code index tools and the Localize subagent', () => {
  it('runs a Localize task and a graph walk through the real tools', async () => {
    const result = await runScenario(join(SCENARIOS, 'index.json'), { backend: BACKEND });
    const byName = Object.fromEntries(result.snapshots.map((s) => [s.name, s]));
    const turn = byName['after-turn']!.scrollback.join('\n');

    expect(turn).toContain('> where does the mode flag get parsed?');
    // The subagent row carries its type and the Done line with its tool uses.
    expect(turn).toContain('Localize(Find where the mode flag is parsed)');
    expect(turn).toMatch(/Done \(2 tool uses/);
    // The graph walk ran against the real index of the fixture project.
    expect(turn).toContain('Graph(src/util.ts#parseArgs)');
    expect(turn).toMatch(/1 root\(s\), \d+ entities, \d+ edges/);
    expect(turn).toMatch(/parsed by parseArgs in src\/util\.ts/);
    expect(turn).toMatch(/(Worked|Cooked|Sautéed|Baked|Brewed|Crafted|Hatched|Pondered|Cogitated|Percolated|Mused|Simmered) for \d+s · done \d{1,2}:\d{2} [AP]M/);

    for (const snap of result.snapshots) checkGolden('index', snap);
  });
});
