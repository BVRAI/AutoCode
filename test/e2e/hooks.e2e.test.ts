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

describe('hooks scenario — project hooks.json on Claude Code\'s contract', () => {
  it('blocks a matched command with exit 2, feeds the reason back, and reports post-tool output', async () => {
    const result = await runScenario(join(SCENARIOS, 'hooks.json'), { backend: BACKEND });
    const byName = Object.fromEntries(result.snapshots.map((s) => [s.name, s]));
    const turn = byName['after-turn']!.scrollback.join('\n');

    expect(turn).toContain('> run the tests and tell me if they pass');
    // The npm call was refused by the PreToolUse hook; the retry went through.
    expect(turn).toContain('Bash(npm test --silent)');
    expect(turn).toContain('blocked by PreToolUse hook');
    expect(turn).toContain('Bash(node scripts/test.mjs)');
    expect(turn).toContain('RUN v3.2.4');
    // Successful hook stdout is curated out of the transcript (Claude Code
    // hides it too); only warnings and blocks reach the user.
    expect(turn).not.toMatch(/audit: shell command logged/);
    expect(turn).toMatch(/refuses direct npm calls/);

    for (const snap of result.snapshots) checkGolden('hooks', snap);
  });
});
