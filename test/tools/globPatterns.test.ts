import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitPatterns, escapeLiteralBrackets } from '../../src/tools/globPatterns.js';
import { GlobTool } from '../../src/tools/glob.js';
import { GrepTool } from '../../src/tools/grep.js';
import { invalidateProjectFiles } from '../../src/util/projectFiles.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

let root: string;

function ctx(): ToolExecutionContext {
  return {
    session: {
      sessionId: 't',
      projectRoot: root,
      dataDir: root,
      sessionDir: root,
      model: { provider: 'xai', model: 'm' },
      startedAt: new Date().toISOString(),
      mode: 'autocode',
    },
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'autocode-globpat-'));
  mkdirSync(join(root, 'src/app/[locale]/login'), { recursive: true });
  mkdirSync(join(root, 'src/app/[locale]/signup'), { recursive: true });
  writeFileSync(join(root, 'src/app/[locale]/login/page.tsx'), 'export default function LoginPage() { return null; }\n');
  writeFileSync(join(root, 'src/app/[locale]/signup/page.tsx'), 'export default function SignupPage() { return null; }\n');
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
  invalidateProjectFiles(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('splitPatterns', () => {
  it('keeps commas inside braces', () => {
    expect(splitPatterns('**/login*/**/*.{ts,tsx,js,jsx}')).toEqual(['**/login*/**/*.{ts,tsx,js,jsx}']);
    expect(splitPatterns('src/**/*.ts, docs/*.md')).toEqual(['src/**/*.ts', 'docs/*.md']);
    expect(splitPatterns('a.{x,y},b')).toEqual(['a.{x,y}', 'b']);
  });
});

describe('escapeLiteralBrackets', () => {
  it('escapes bracket segments that are real directories and leaves character classes alone', () => {
    expect(escapeLiteralBrackets('src/app/[locale]/**/*.tsx', root)).toBe('src/app/\\[locale\\]/**/*.tsx');
    expect(escapeLiteralBrackets('**/[locale]/login/*.tsx', root)).toBe('**/\\[locale\\]/login/*.tsx');
    expect(escapeLiteralBrackets('src/[abc].ts', root)).toBe('src/[abc].ts');
    expect(escapeLiteralBrackets('src/**/*.ts', root)).toBe('src/**/*.ts');
  });
});

describe('glob tool on a Next.js layout', () => {
  it('matches brace alternatives and bracketed route directories', async () => {
    const a = await new GlobTool().execute({ pattern: '**/login*/**/*.{ts,tsx,js,jsx}' }, ctx());
    expect(a.content).toBe('src/app/[locale]/login/page.tsx');
    const b = await new GlobTool().execute({ pattern: 'src/app/[locale]/**/*.tsx' }, ctx());
    expect(b.content.split('\n').sort()).toEqual(['src/app/[locale]/login/page.tsx', 'src/app/[locale]/signup/page.tsx']);
  });

  it('points at matching directories when no file matches', async () => {
    const r = await new GlobTool().execute({ pattern: 'src/app/[locale]/**/signup*' }, ctx());
    expect(r.summary).toMatch(/^0 matches/);
    expect(r.content).toContain('src/app/[locale]/signup/');
    expect(r.content).toContain('add /** to list their files');
  });

  it('grep honors the same glob filter rules', async () => {
    const r = await new GrepTool().execute({ pattern: 'SignupPage', glob: 'src/app/[locale]/**/*.{ts,tsx}' }, ctx());
    expect(r.content).toContain('src/app/[locale]/signup/page.tsx');
  });
});
