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

describe('basic scenario — a full turn in the inline console', () => {
  it('renders the welcome, the turn and survives a resize', async () => {
    const result = await runScenario(join(SCENARIOS, 'basic.json'), { backend: BACKEND });
    const byName = Object.fromEntries(result.snapshots.map((s) => [s.name, s]));

    const welcome = byName['welcome']!.screen.join('\n');
    expect(welcome).toContain('AutoCode v');
    expect(welcome).toContain('/help for commands');
    expect(welcome).toMatch(/auto mode on/);

    const turn = byName['after-turn']!.scrollback.join('\n');
    expect(turn).toContain('> add a --verbose flag');
    expect(turn).toMatch(/Thought for \d+s/);
    expect(turn).toContain('Read 3 files (ctrl+o to expand)');
    expect(turn).toContain('cli.ts, util.ts, README.md');
    expect(turn).toMatch(/Search\(pattern: "mode", glob: "src\/\*\*\/\*\.ts"\)/);
    expect(turn).toContain('Bash(npm test --silent)');
    expect(turn).toContain('RUN v3.2.4');
    expect(turn).toMatch(/… \+\d+ lines \(ctrl\+o to expand\)/);
    expect(turn).not.toContain('--- stdout ---');
    expect(turn).toContain('Update(src/cli.ts)');
    expect(turn).toContain('Updated src/cli.ts with 2 additions and 1 removal');
    expect(turn).toContain('Update Todos');
    expect(turn).toContain('☒ Parse the flag in cli.ts');
    expect(turn).toContain('☐ Print timings in run()');
    expect(turn).toMatch(/Added --verbose to the CLI/);
    expect(turn).toMatch(/(Worked|Cooked|Sautéed|Baked|Brewed|Crafted|Hatched|Pondered|Cogitated|Percolated|Mused|Simmered) for \d+s · done \d{1,2}:\d{2} [AP]M/);

    // The rebuild after a resize must leave no stale rows: every committed row
    // appears exactly once and the composer + footer close the screen.
    const resized = byName['after-resize']!;
    expect(resized.cols).toBe(80);
    const all = resized.scrollback.join('\n');
    expect(all.match(/Update\(src\/cli\.ts\)/g)?.length).toBe(1);
    expect(all.match(/> add a --verbose flag/g)?.length).toBe(1);
    expect(resized.screen.join('\n')).toMatch(/auto mode on/);

    for (const snap of result.snapshots) checkGolden('basic', snap);
  });
});
