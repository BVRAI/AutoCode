// save_memory — the agent's write path into auto memory (Phase 4.8). Memory
// lives outside the project (per-project directory under the data dir), so
// the file tools cannot reach it; this tool is the one door. The system
// prompt's "Memory" section is the read path, loaded once per session.

import { MemoryStore, MEMORY_KINDS, type MemoryKind } from '../agent/Memory.js';
import {
  optionalString,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFINITION: ToolDefinition = {
  name: 'save_memory',
  description:
    'Remember something for future sessions on this project: who the user is and how they like to work ' +
    '(type "user"), guidance or corrections they gave you (type "feedback", say why and how to apply it), ' +
    'ongoing work, decisions and constraints not derivable from the code (type "project"), or pointers to ' +
    'external resources (type "reference"). One fact per memory, a short kebab-case name, a one-line ' +
    'description. Do not save what the repo already records (code structure, git history, instruction files). ' +
    'Saving with an existing name replaces it; action "delete" removes one.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short kebab-case slug, e.g. "prefers-small-prs".' },
      description: { type: 'string', description: 'One line used to decide relevance later.' },
      type: { type: 'string', enum: [...MEMORY_KINDS], description: 'user | feedback | project | reference.' },
      content: { type: 'string', description: 'The fact itself. For feedback and project memories add "Why:" and "How to apply:" lines.' },
      action: { type: 'string', enum: ['save', 'delete'], description: 'Default save.' },
    },
    required: ['name'],
  },
};

export class SaveMemoryTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const name = requireString(args, 'name');
    const action = optionalString(args, 'action') ?? 'save';
    const store = new MemoryStore(ctx.session.projectRoot);
    if (action === 'delete') {
      const ok = store.delete(name);
      return ok
        ? { summary: `forgot ${name}`, content: `Memory "${name}" deleted.`, metadata: { action, name } }
        : { summary: `no memory named ${name}`, content: `No memory named "${name}".`, isError: true };
    }
    const description = requireString(args, 'description');
    const content = requireString(args, 'content');
    const typeRaw = optionalString(args, 'type') ?? 'project';
    if (!MEMORY_KINDS.includes(typeRaw as MemoryKind)) {
      return { summary: 'bad type', content: `type must be one of ${MEMORY_KINDS.join(', ')}`, isError: true };
    }
    try {
      const entry = store.save({ name, description, kind: typeRaw as MemoryKind, body: content });
      return {
        summary: `remembered ${entry.name} (${entry.kind})`,
        content: `Saved memory "${entry.name}" (${entry.kind}): ${entry.description}\nIt loads into future sessions on this project.`,
        metadata: { action: 'save', name: entry.name, kind: entry.kind, path: entry.path },
      };
    } catch (e) {
      return { summary: 'could not save memory', content: e instanceof Error ? e.message : String(e), isError: true };
    }
  }
}
