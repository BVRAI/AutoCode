import { findSkill, getSkills } from '../agent/Skills.js';
import {
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

// The on-demand load tool. Listed alongside read_file / glob / etc. so the
// agent sees it as part of its normal toolbox; the system prompt's
// `# Skills available` table tells it which names are valid.

const DEFINITION: ToolDefinition = {
  name: 'use_skill',
  description:
    'Load the full body of a named skill into your context. The list of available skill names ' +
    'and one-line descriptions appears in the system prompt under "Skills available" — call ' +
    'this tool with `name` set to one of those to pull in its full guidance only when relevant. ' +
    'Use this for task-specific expertise (how to write a Django view, terraform module template, ' +
    "postgres migration recipe, etc.). Returns an error listing valid names if the skill doesn't exist.",
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name from the "Skills available" table.' },
    },
    required: ['name'],
  },
};

export class UseSkillTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const name = requireString(args, 'name');
    const skills = getSkills(ctx.session.projectRoot);
    if (skills.length === 0) {
      return {
        summary: 'no skills configured',
        content: 'No skills are configured for this project. Drop a Markdown file at `.autocode/skills/<name>.md` (project-local) or `~/.autocode/skills/<name>.md` (user-global) with `name:` and `description:` frontmatter.',
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
    return {
      summary: `loaded skill ${skill.name}`,
      content: skill.body,
      metadata: { skill: skill.name, source: skill.source, bytes: skill.body.length },
    };
  }
}
