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

describe('plan scenario — planning mode saves the plan and asks before implementing', () => {
  it('shows the approval dialog, switches mode on Yes, and implements the plan', async () => {
    const result = await runScenario(join(SCENARIOS, 'plan.json'), { backend: BACKEND });
    const byName = Object.fromEntries(result.snapshots.map((s) => [s.name, s]));

    const dialog = byName['plan-dialog']!.screen.join('\n');
    expect(dialog).toContain('Ready to implement this plan?');
    expect(dialog).toContain('Yes, and auto-accept edits');
    expect(dialog).toContain('No, keep planning');
    expect(dialog).toMatch(/plan saved to \.autocode\/plans\/\d{8}-\d{4}-plan-how-verbose-flag-prints/);

    const after = byName['after-implement']!.scrollback.join('\n');
    expect(after).toContain('plan approved — auto-accepting edits');
    expect(after).toContain('Update(src/cli.ts)');
    expect(after).toMatch(/Second turn done/);
    expect(after).toMatch(/auto mode on/);

    for (const snap of result.snapshots) checkGolden('plan', snap);
  });
});
