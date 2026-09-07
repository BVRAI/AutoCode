import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, renderSkillInvocation, renderSkillsSection, skillForCommand, type Skill } from '../../src/agent/Skills.js';
import { UseSkillTool } from '../../src/tools/useSkill.js';
import { _resetSkillCacheForTests } from '../../src/agent/Skills.js';

function skill(name: string, source: Skill['source'], description = `${name} description`): Skill {
  return { name, description, body: `# ${name}`, source };
}

describe('Agent Skills directories', () => {
  let projectRoot: string;
  let userHome: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'autocode-skills-p-'));
    userHome = mkdtempSync(join(tmpdir(), 'autocode-skills-u-'));
    _resetSkillCacheForTests();
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  });

  it('reads <name>/SKILL.md with resources from .autocode, .agents and .claude locations', () => {
    const a = join(projectRoot, '.agents', 'skills', 'deploy-checklist');
    mkdirSync(join(a, 'scripts'), { recursive: true });
    writeFileSync(join(a, 'SKILL.md'), '---\nname: deploy-checklist\ndescription: How we ship\nallowed-tools: run_shell, read_file\nlicense: MIT\n---\n# Deploy\nRun scripts/check.sh first.\n');
    writeFileSync(join(a, 'scripts', 'check.sh'), 'echo ok\n');
    writeFileSync(join(a, 'reference.md'), '# ref\n');
    const c = join(userHome, '.claude', 'skills', 'pr-etiquette');
    mkdirSync(c, { recursive: true });
    writeFileSync(join(c, 'SKILL.md'), '---\nname: pr-etiquette\ndescription: PR rules\n---\nBe kind.\n');
    const r = discoverSkills(projectRoot, userHome);
    expect(r.map((s) => `${s.name}:${s.source}`)).toEqual(['deploy-checklist:project', 'pr-etiquette:user']);
    const deploy = r[0]!;
    expect(deploy.dir).toBe(a);
    expect(deploy.resources).toEqual(['reference.md', 'scripts/check.sh']);
    expect(deploy.allowedTools).toEqual(['run_shell', 'read_file']);
    expect(deploy.license).toBe('MIT');
  });

  it('later locations override earlier ones by name', () => {
    for (const [dir, desc] of [
      ['.autocode/skills', 'from autocode'],
      ['.claude/skills', 'from claude'],
    ] as const) {
      const d = join(projectRoot, dir, 'same');
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'SKILL.md'), `---\nname: same\ndescription: ${desc}\n---\nbody\n`);
    }
    const r = discoverSkills(projectRoot, userHome);
    expect(r).toHaveLength(1);
    expect(r[0]!.description).toBe('from claude');
  });

  it('use_skill lists resources and returns one, refusing paths outside the skill', async () => {
    const d = join(projectRoot, '.autocode', 'skills', 'with-files');
    mkdirSync(join(d, 'templates'), { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), '---\nname: with-files\ndescription: has files\n---\nUse templates/a.txt.\n');
    writeFileSync(join(d, 'templates', 'a.txt'), 'TEMPLATE A\n');
    _resetSkillCacheForTests();
    const ctx = { session: { sessionId: 't', projectRoot, dataDir: projectRoot, sessionDir: projectRoot, model: { provider: 'xai', model: 'm' }, startedAt: '', mode: 'autocode' as const } };
    const listed = await new UseSkillTool().execute({ name: 'with-files' }, ctx);
    expect(listed.content).toContain('Use templates/a.txt.');
    expect(listed.content).toContain('- templates/a.txt');
    const res = await new UseSkillTool().execute({ name: 'with-files', resource: 'templates/a.txt' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('TEMPLATE A');
    const bad = await new UseSkillTool().execute({ name: 'with-files', resource: '../../package.json' }, ctx);
    expect(bad.isError).toBe(true);
  });
});

describe('skills listing budget and slash invocation', () => {
  it('keeps project skills when the budget bites and names the rest', () => {
    const skills = [skill('zeta', 'builtin', 'z'.repeat(300)), skill('alpha', 'user', 'a'.repeat(300)), skill('mine', 'project', 'm'.repeat(300))];
    const section = renderSkillsSection(skills, { budgetChars: 700 });
    expect(section).toContain('**mine**');
    expect(section).toContain('**alpha**');
    expect(section).not.toContain('**zeta**');
    expect(section).toContain('1 more not listed');
    expect(section).toContain('zeta');
    const long = renderSkillsSection([skill('big', 'project', 'x'.repeat(2_000))]);
    expect(long.length).toBeLessThan(2_000);
    expect(long).toContain('…');
  });

  it('resolves /skill-name and renders the invocation message', () => {
    const skills = [skill('deploy-checklist', 'project')];
    expect(skillForCommand(skills, '/Deploy-Checklist')?.name).toBe('deploy-checklist');
    expect(skillForCommand(skills, '/help')).toBeNull();
    const msg = renderSkillInvocation(skills[0]!, 'to staging');
    expect(msg).toContain('<skill name="deploy-checklist">');
    expect(msg).toContain('# deploy-checklist');
    expect(msg).toContain('Request: to staging');
  });
});
