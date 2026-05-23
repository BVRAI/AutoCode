import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetSkillCacheForTests,
  discoverSkills,
  findSkill,
  parseSkill,
  renderSkillsSection,
} from '../../src/agent/Skills.js';

describe('parseSkill', () => {
  it('parses required fields + body', () => {
    const r = parseSkill(`---
name: hello
description: Returns world
---

When asked the world, the answer is "world".`);
    expect(r).not.toBeNull();
    expect(r!.meta.name).toBe('hello');
    expect(r!.meta.description).toBe('Returns world');
    expect(r!.body).toContain('the world, the answer is "world"');
  });

  it('parses the optional match field', () => {
    const r = parseSkill(`---
name: x
description: y
match: src/api/**
---
body`);
    expect(r!.meta.match).toBe('src/api/**');
  });

  it('strips quotes around values', () => {
    const r = parseSkill(`---
name: "quoted-name"
description: 'single-quoted'
---
body`);
    expect(r!.meta.name).toBe('quoted-name');
    expect(r!.meta.description).toBe('single-quoted');
  });

  it('returns null without frontmatter', () => {
    expect(parseSkill('just markdown')).toBeNull();
  });

  it('returns null with no closing ---', () => {
    expect(parseSkill('---\nname: x\ndescription: y\nbody but no close')).toBeNull();
  });

  it('returns null when name is missing', () => {
    expect(parseSkill(`---
description: x
---
body`)).toBeNull();
  });

  it('returns null when description is missing', () => {
    expect(parseSkill(`---
name: x
---
body`)).toBeNull();
  });

  it('lowercases keys', () => {
    const r = parseSkill(`---
NAME: x
Description: y
---
body`);
    expect(r!.meta.name).toBe('x');
    expect(r!.meta.description).toBe('y');
  });
});

describe('discoverSkills', () => {
  let projectRoot: string;
  let userHome: string;

  beforeEach(() => {
    _resetSkillCacheForTests();
    projectRoot = mkdtempSync(join(tmpdir(), 'autocode-skills-proj-'));
    userHome = mkdtempSync(join(tmpdir(), 'autocode-skills-user-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  });

  function writeSkill(root: string, filename: string, content: string): void {
    mkdirSync(join(root, '.autocode', 'skills'), { recursive: true });
    writeFileSync(join(root, '.autocode', 'skills', filename), content, 'utf8');
  }

  it('returns [] when neither directory exists', () => {
    expect(discoverSkills(projectRoot, userHome)).toEqual([]);
  });

  it('discovers a project-local skill', () => {
    writeSkill(projectRoot, 'a.md', '---\nname: a\ndescription: A\n---\nbody-a');
    const r = discoverSkills(projectRoot, userHome);
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe('a');
    expect(r[0]!.source).toBe('project');
  });

  it('discovers a user-global skill', () => {
    writeSkill(userHome, 'b.md', '---\nname: b\ndescription: B\n---\nbody-b');
    const r = discoverSkills(projectRoot, userHome);
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe('b');
    expect(r[0]!.source).toBe('user');
  });

  it('project-local overrides user-global on name conflict', () => {
    writeSkill(userHome, 'shared.md', '---\nname: shared\ndescription: user version\n---\nuser-body');
    writeSkill(projectRoot, 'shared.md', '---\nname: shared\ndescription: project version\n---\nproject-body');
    const r = discoverSkills(projectRoot, userHome);
    expect(r).toHaveLength(1);
    expect(r[0]!.source).toBe('project');
    expect(r[0]!.description).toBe('project version');
    expect(r[0]!.body).toBe('project-body');
  });

  it('returns multiple skills sorted by name', () => {
    writeSkill(projectRoot, 'zebra.md', '---\nname: zebra\ndescription: z\n---\nz');
    writeSkill(projectRoot, 'alpha.md', '---\nname: alpha\ndescription: a\n---\na');
    const r = discoverSkills(projectRoot, userHome);
    expect(r.map((s) => s.name)).toEqual(['alpha', 'zebra']);
  });

  it('skips non-markdown files and malformed skills', () => {
    writeSkill(projectRoot, 'good.md', '---\nname: good\ndescription: g\n---\nbody');
    writeSkill(projectRoot, 'notmd.txt', '---\nname: x\ndescription: y\n---\nbody');
    writeSkill(projectRoot, 'bad.md', 'no frontmatter');
    const r = discoverSkills(projectRoot, userHome);
    expect(r.map((s) => s.name)).toEqual(['good']);
  });
});

describe('findSkill', () => {
  it('returns the matching skill', () => {
    const skills = [
      { name: 'a', description: 'd', body: 'b', source: 'project' as const },
      { name: 'b', description: 'd', body: 'b', source: 'project' as const },
    ];
    expect(findSkill(skills, 'a')!.name).toBe('a');
    expect(findSkill(skills, 'b')!.name).toBe('b');
  });

  it('returns null when not found', () => {
    expect(findSkill([{ name: 'a', description: 'd', body: 'b', source: 'project' }], 'missing')).toBeNull();
  });

  it('is case-sensitive', () => {
    expect(findSkill([{ name: 'Foo', description: 'd', body: 'b', source: 'project' }], 'foo')).toBeNull();
  });
});

describe('renderSkillsSection', () => {
  it('returns empty string when no skills', () => {
    expect(renderSkillsSection([])).toBe('');
  });

  it('renders names + descriptions and mentions use_skill', () => {
    const section = renderSkillsSection([
      { name: 'a', description: 'AAA', body: '', source: 'project' },
      { name: 'b', description: 'BBB', body: '', source: 'user' },
    ]);
    expect(section).toContain('Skills available');
    expect(section).toContain('use_skill');
    expect(section).toContain('**a** — AAA');
    expect(section).toContain('**b** — BBB');
  });
});
