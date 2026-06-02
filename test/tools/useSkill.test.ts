import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UseSkillTool } from '../../src/tools/useSkill.js';
import { _resetSkillCacheForTests } from '../../src/agent/Skills.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function makeCtx(projectRoot: string): ToolExecutionContext {
  const session: SessionContext = {
    sessionId: 'useskill-test',
    projectRoot,
    dataDir: tmpdir(),
    sessionDir: tmpdir(),
    model: { provider: 'xai', model: 'm' },
    startedAt: new Date().toISOString(),
    mode: 'autocode',
  };
  return { session };
}

function writeSkill(projectRoot: string, filename: string, content: string): void {
  mkdirSync(join(projectRoot, '.autocode', 'skills'), { recursive: true });
  writeFileSync(join(projectRoot, '.autocode', 'skills', filename), content, 'utf8');
}

describe('UseSkillTool', () => {
  let projectRoot: string;

  beforeEach(() => {
    _resetSkillCacheForTests();
    projectRoot = mkdtempSync(join(tmpdir(), 'autocode-useskill-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns the body for a known skill', async () => {
    writeSkill(
      projectRoot,
      'hello.md',
      '---\nname: hello\ndescription: Returns world\n---\nThe answer is "world".',
    );
    const r = await new UseSkillTool().execute({ name: 'hello' }, makeCtx(projectRoot));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('The answer is "world".');
    expect(r.metadata?.skill).toBe('hello');
  });

  it('returns an error result listing available names on miss', async () => {
    writeSkill(projectRoot, 'a.md', '---\nname: a\ndescription: A\n---\na');
    writeSkill(projectRoot, 'b.md', '---\nname: b\ndescription: B\n---\nb');
    const r = await new UseSkillTool().execute({ name: 'nope' }, makeCtx(projectRoot));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('nope');
    expect(r.content).toContain('a');
    expect(r.content).toContain('b');
  });

  it('exposes the built-in git skill out of the box (no setup required)', async () => {
    const r = await new UseSkillTool().execute({ name: 'git' }, makeCtx(projectRoot));
    expect(r.isError).toBeFalsy();
    expect(r.metadata?.skill).toBe('git');
    expect(r.metadata?.source).toBe('builtin');
    expect(r.content).toContain('Co-Authored-By: Autocode');
  });

  it('rejects an empty name with a clear error', async () => {
    writeSkill(projectRoot, 'a.md', '---\nname: a\ndescription: A\n---\na');
    await expect(new UseSkillTool().execute({ name: '' }, makeCtx(projectRoot))).rejects.toThrow(
      /name/,
    );
  });
});
