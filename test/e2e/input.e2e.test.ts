import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { runScenario } from '../../src/testkit/scenario.js';

const HERE = import.meta.dirname;
const BACKEND = process.env.TTY_MODE === 'emulated' ? 'emulated' : process.env.TTY_MODE === 'pty' ? 'pty' : undefined;

describe('input scenario — @ picker, paste placeholders, multi-line composer', () => {
  it('completes a mention, collapses a long paste, and keeps newlines in the composer', async () => {
    const result = await runScenario(join(HERE, 'scenarios', 'input.json'), { backend: BACKEND });
    const byName = Object.fromEntries(result.snapshots.map((s) => [s.name, s]));

    const menu = byName['mention-menu']!.screen.join('\n');
    expect(menu).toContain('Files');
    expect(menu).toContain('src/cli.ts');

    const completed = byName['mention-completed']!.screen.join('\n');
    expect(completed).toMatch(/> explain @src\/cli\.ts/);
    expect(completed).not.toContain('Files');

    const pasted = byName['paste-placeholder']!.screen.join('\n');
    expect(pasted).toContain('[Pasted text #1 +8 lines]');
    expect(pasted).not.toContain('line 7');

    // The transcript shows the placeholder, not the eight pasted lines.
    const turn = byName['after-turn']!.scrollback.join('\n');
    expect(turn).toContain('> explain @src/cli.ts [Pasted text #1 +8 lines]');
    expect(turn).not.toContain('line 7');
    expect(turn).toContain('Got it');

    const multi = byName['multiline']!.screen.join('\n');
    // Two composer rows inside the box: "│ > first line … │" then "│   second line … │".
    expect(multi).toMatch(/> first line\s*│\n\s*│\s+second line/);

    const second = byName['after-second-turn']!.scrollback.join('\n');
    expect(second).toContain('Second turn done.');
  });
});
