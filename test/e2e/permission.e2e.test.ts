import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { runScenario } from '../../src/testkit/scenario.js';

const HERE = import.meta.dirname;
const BACKEND = process.env.TTY_MODE === 'emulated' ? 'emulated' : process.env.TTY_MODE === 'pty' ? 'pty' : undefined;

describe('permission scenario — default mode reviews edits and commands', () => {
  it('shows the Claude Code dialog and honors Yes / don’t ask again / No-with-guidance', async () => {
    const result = await runScenario(join(HERE, 'scenarios', 'permission.json'), { backend: BACKEND });
    const byName = Object.fromEntries(result.snapshots.map((s) => [s.name, s]));

    const editDialog = byName['edit-dialog']!.screen.join('\n');
    expect(editDialog).toContain('Edit file');
    expect(editDialog).toContain('Do you want to proceed?');
    expect(editDialog).toContain('1. Yes');
    expect(editDialog).toMatch(/2\. Yes, and don't ask again for file edits this session/);
    expect(editDialog).toContain('3. No, and tell AutoCode what to do differently (esc)');
    expect(editDialog).toMatch(/[-+] ?export function parseArg/);

    const bashDialog = byName['bash-dialog']!.screen.join('\n');
    expect(bashDialog).toContain('Bash command');
    expect(bashDialog).toContain('npm test');
    expect(bashDialog).toMatch(/don't ask again for commands that start with "npm"/);

    // The second npm command was covered by "don't ask again": no third Bash
    // dialog, and the next dialog is the second edit.
    const secondEdit = byName['second-edit-dialog']!.screen.join('\n');
    expect(secondEdit).toContain('Edit file');
    expect(secondEdit).toContain('src/cli.ts');

    const turn = byName['after-turn']!.scrollback.join('\n');
    expect(turn).toContain('Update(src/util.ts)');
    expect(turn).toContain('Updated src/util.ts with 1 addition and 1 removal');
    expect(turn).toContain('Bash(npm test)');
    expect(turn).toContain('Bash(npm run test)');
    expect(turn).toMatch(/Update\(src\/cli\.ts\)[\s\S]*Error/);
    expect(turn).toContain('leave cli.ts alone');
    expect(turn).toMatch(/I'll leave cli\.ts as it is/);
  });
});
