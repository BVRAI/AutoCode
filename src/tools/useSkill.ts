import { readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { findSkill, getSkills } from '../agent/Skills.js';
import {
  optionalString,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

// The on-demand load tool. Listed alongside read_file / glob / etc. so the
// agent sees it as part of its normal toolbox; the system prompt's
// `# Skills available` table tells it which names are valid. A skill in the
// Agent Skills form may ship scripts and reference files; `resource` returns
// one of them (they live outside the project root, so read_file cannot).
const MAX_RESOURCE_BYTES = 200 * 1024;

const DEFINITION: ToolDefinition = {
  name: 'use_skill',
  description:
    'Load the full body of a named skill into your context. The list of available skill names ' +
    'and one-line descriptions appears in the system prompt under "Skills available" — call ' +
    'this tool with `name` set to one of those to pull in its full guidance only when relevant. ' +
    'The result lists the files the skill ships (scripts, templates, references); pass one of ' +
    "them as `resource` to read it. Returns an error listing valid names if the skill doesn't exist.",
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name from the "Skills available" table.' },
      resource: { type: 'string', description: 'Optional: a file the skill ships, relative to the skill directory (as listed by a previous call).' },
    },
    required: ['name'],
  },
};

export class UseSkillTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const name = requireString(args, 'name');
    const resource = optionalString(args, 'resource');
    const skills = getSkills(ctx.session.projectRoot);
    if (skills.length === 0) {
      return {
        summary: 'no skills configured',
        content:
          'No skills are configured for this project. Add a directory `.autocode/skills/<name>/SKILL.md` (or `.agents/skills`, `.claude/skills`; `~/…` for user-global) with `name:` and `description:` frontmatter.',
        isError: true,
      };
    }
    const skill = findSkill(skills, name);
    if (!skill) {
      const available = skills.map((s) => s.name).join(', ');
      return {
        summary: `unknown skill: ${name}`,
        content: `No skill named \`${name}\` is registered. Available: ${available}.`,
        isError: true,
      };
    }
    if (resource) {
      if (!skill.dir) {
        return { summary: 'skill has no resources', content: `Skill \`${name}\` is a single file and ships no resources.`, isError: true };
      }
      const rel = resource.replace(/\\/g, '/').replace(/^\.\//, '');
      const abs = resolve(skill.dir, normalize(rel));
      const root = resolve(skill.dir) + sep;
      if (!abs.startsWith(root)) {
        return { summary: 'resource outside the skill', content: `\`${resource}\` is not inside the skill directory.`, isError: true };
      }
      try {
        const st = statSync(abs);
        if (!st.isFile()) return { summary: 'not a file', content: `\`${resource}\` is not a file.`, isError: true };
        const buf = readFileSync(abs);
        if (buf.includes(0)) return { summary: 'binary resource', content: `\`${resource}\` is binary; run it or reference it by path instead: ${abs}`, isError: true };
        const truncated = buf.length > MAX_RESOURCE_BYTES;
        const text = buf.subarray(0, MAX_RESOURCE_BYTES).toString('utf8');
        return {
          summary: `skill ${skill.name}: ${rel} (${buf.length} bytes${truncated ? ', truncated' : ''})`,
          content: `<resource skill="${skill.name}" path="${rel}" absolute="${abs}">\n${text}${truncated ? '\n[…truncated]' : ''}\n</resource>`,
          metadata: { skill: skill.name, resource: rel, path: abs, bytes: buf.length, truncated },
        };
      } catch (e) {
        return { summary: 'resource not found', content: `Could not read \`${resource}\`: ${e instanceof Error ? e.message : String(e)}. Listed resources: ${(skill.resources ?? []).join(', ') || '(none)'}`, isError: true };
      }
    }
    const resources = skill.resources ?? [];
    const footer = skill.dir
      ? `\n\n<skill-resources dir="${skill.dir}">\n${resources.length > 0 ? resources.map((r) => `- ${r}`).join('\n') : '(none)'}\n</skill-resources>\n` +
        (resources.length > 0 ? 'Read any of them with use_skill { name, resource }; run scripts by their absolute path under the directory above.' : '')
      : '';
    return {
      summary: `loaded skill ${skill.name}`,
      content: `${skill.body}${footer}`,
      metadata: { skill: skill.name, source: skill.source, bytes: skill.body.length, dir: skill.dir, resources },
    };
  }
}

// Kept for callers that resolve resource paths themselves.
export function resourcePath(dir: string, rel: string): string {
  return join(dir, rel);
}
