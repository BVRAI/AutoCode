import {
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

// Per-session in-memory list. Exposed via getter so the renderer can show it after each turn.
const sessionLists = new Map<string, TodoItem[]>();

export function currentTodos(sessionId: string): readonly TodoItem[] {
  return sessionLists.get(sessionId) ?? [];
}

const DEFINITION: ToolDefinition = {
  name: 'todo_write',
  description:
    'Maintain a checklist of subtasks for the current request. Use this at the start of any non-trivial ' +
    'task to plan your steps explicitly, and update statuses as you progress. Helps the user follow along ' +
    'and prevents loss of context across many tool calls.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'update'],
        description: '"set" replaces the whole list; "update" changes a single item by id.',
      },
      items: {
        type: 'array',
        description: 'Required for action="set". Full list of todos.',
        items: { type: 'object' },
      },
      id: { type: 'string', description: 'Required for action="update".' },
      text: { type: 'string', description: 'Optional new text (update).' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
    },
    required: ['action'],
  },
};

export class TodoWriteTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const action = requireString(args, 'action');
    const sessionId = ctx.session.sessionId;
    const list = sessionLists.get(sessionId) ?? [];

    if (action === 'set') {
      const raw = args.items;
      if (!Array.isArray(raw)) {
        return { summary: 'bad input', content: 'items must be an array', isError: true };
      }
      const items: TodoItem[] = raw.map((it, idx) => {
        const o = it as Record<string, unknown>;
        return {
          id: typeof o.id === 'string' && o.id.length > 0 ? o.id : `t${idx + 1}`,
          text: typeof o.text === 'string' ? o.text : String(o.text ?? ''),
          status: normalizeStatus(o.status),
        };
      });
      sessionLists.set(sessionId, items);
      return {
        summary: `set ${items.length} todo${items.length === 1 ? '' : 's'}`,
        content: render(items),
        metadata: { count: items.length },
      };
    }

    if (action === 'update') {
      const id = requireString(args, 'id');
      const idx = list.findIndex((t) => t.id === id);
      if (idx < 0) {
        return { summary: 'todo not found', content: `no todo with id=${id}`, isError: true };
      }
      const existing = list[idx]!;
      const text = typeof args.text === 'string' ? args.text : existing.text;
      const statusRaw = args.status;
      const status =
        typeof statusRaw === 'string' && (['pending', 'in_progress', 'completed'] as const).includes(statusRaw as TodoStatus)
          ? (statusRaw as TodoStatus)
          : existing.status;
      list[idx] = { id, text, status };
      sessionLists.set(sessionId, list);
      return {
        summary: `updated ${id} → ${status}`,
        content: render(list),
        metadata: { id, status },
      };
    }

    return { summary: 'bad action', content: `unknown action: ${action}`, isError: true };
  }
}

function render(items: TodoItem[]): string {
  if (items.length === 0) return '(no todos)';
  return items
    .map((t) => `${symbol(t.status)} ${t.id}. ${t.text}`)
    .join('\n');
}

function symbol(s: TodoStatus): string {
  switch (s) {
    case 'pending':
      return '[ ]';
    case 'in_progress':
      return '[~]';
    case 'completed':
      return '[x]';
  }
}

function normalizeStatus(raw: unknown): TodoStatus {
  if (raw === 'in_progress' || raw === 'completed') return raw;
  return 'pending';
}
