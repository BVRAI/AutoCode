import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkFileSyntax } from '../../src/tools/syntaxGate.js';

// autocode's own repo has typescript installed, so the TS fallback parser is
// available to the JSX probe in this test environment.
const PROJECT_ROOT = process.cwd();

const dirs: string[] = [];

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'autocode-gate-'));
  dirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('syntax gate — JSX in plain .js (React false-positive fix)', () => {
  it('accepts JSX in a .js file via the TypeScript JSX probe', async () => {
    const p = tempFile(
      'App.js',
      [
        "import React from 'react';",
        'export default function App() {',
        '  return <div className="app"><h1>Hello</h1></div>;',
        '}',
        '',
      ].join('\n'),
    );
    const check = await checkFileSyntax(p, [
      "import React from 'react';",
      'export default function App() {',
      '  return <div className="app"><h1>Hello</h1></div>;',
      '}',
      '',
    ].join('\n'), PROJECT_ROOT);
    expect(check.ok).toBe(true);
  });

  it('still rejects a genuinely broken .js file', async () => {
    const content = 'function broken( {\n  return 1;\n}\n';
    const p = tempFile('broken.js', content);
    const check = await checkFileSyntax(p, content, PROJECT_ROOT);
    expect(check.skipped).toBe(false);
    expect(check.ok).toBe(false);
  });

  it('still rejects broken JSX (probe parses, finds the real error)', async () => {
    // Unbalanced paren after a JSX expression — a structural error the TS
    // probe reliably reports. (transpileModule is lenient about SOME deep
    // JSX grammar errors, e.g. mismatched closing tags — those slip through
    // to the verify loop, which is the gate's documented backstop.)
    const content = 'export default function App() {\n  return (<div>ok</div>;\n}\n';
    const p = tempFile('BrokenJsx.js', content);
    const check = await checkFileSyntax(p, content, PROJECT_ROOT);
    expect(check.ok).toBe(false);
  });
});
