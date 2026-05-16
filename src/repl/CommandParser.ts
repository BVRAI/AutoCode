export type LocalCommandName =
  | 'help'
  | 'status'
  | 'cwd'
  | 'model'
  | 'stop'
  | 'exit';

export interface LocalCommand {
  kind: 'local';
  name: LocalCommandName;
  args: string[];
}

export interface AgentInput {
  kind: 'agent';
  text: string;
}

export interface Empty {
  kind: 'empty';
}

export type ParsedInput = LocalCommand | AgentInput | Empty;

const KNOWN: ReadonlySet<LocalCommandName> = new Set([
  'help',
  'status',
  'cwd',
  'model',
  'stop',
  'exit',
]);

export function parse(line: string): ParsedInput {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: 'empty' };
  if (!trimmed.startsWith('/')) return { kind: 'agent', text: trimmed };

  const parts = trimmed.slice(1).split(/\s+/);
  const head = parts[0]?.toLowerCase() ?? '';
  if (!head || !KNOWN.has(head as LocalCommandName)) {
    return { kind: 'agent', text: trimmed };
  }
  return {
    kind: 'local',
    name: head as LocalCommandName,
    args: parts.slice(1),
  };
}
