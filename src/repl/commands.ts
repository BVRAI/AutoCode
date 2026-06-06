// Single source of truth for slash-command metadata. Both the static
// `/help` text and the Bridge slash-menu render from this list, so a new
// command only needs to be added (or updated) in one place.

import type { LocalCommandName } from './CommandParser.js';

export interface CommandDef {
  name: LocalCommandName;
  // What the user types — includes optional/required args for hint clarity.
  signature: string;
  // One-line description shown next to the command in /help and the menu.
  summary: string;
  // Whether the command accepts arguments. Drives slash-menu behaviour:
  // 'none'      → completing the command also submits it immediately
  // 'optional'  → completing inserts trailing space; user can submit empty
  // 'required'  → completing inserts trailing space and waits for user
  args: 'none' | 'optional' | 'required';
}

export const COMMAND_DEFS: ReadonlyArray<CommandDef> = [
  { name: 'help',     signature: '/help',                                     summary: 'Show this menu',                                            args: 'none' },
  { name: 'status',   signature: '/status',                                   summary: 'Show session info',                                         args: 'none' },
  { name: 'cwd',      signature: '/cwd [path]',                               summary: 'Show or change the project root',                           args: 'optional' },
  { name: 'model',    signature: '/model [provider model]',                   summary: 'Pick a model (no args = picker)',                           args: 'optional' },
  { name: 'init',     signature: '/init',                                     summary: 'Scaffold an AUTOCODE.md for this project',                  args: 'none' },
  { name: 'clear',    signature: '/clear',                                    summary: 'Reset conversation history',                                args: 'none' },
  { name: 'compact',  signature: '/compact',                                  summary: 'Summarize older turns',                                     args: 'none' },
  { name: 'cost',     signature: '/cost',                                     summary: 'Show session cost estimate',                                args: 'none' },
  { name: 'diff',     signature: '/diff',                                     summary: 'Show uncommitted git changes',                              args: 'none' },
  { name: 'keys',     signature: '/keys',                                     summary: 'Manage your API keys (BYOK): see, add, replace, remove',     args: 'optional' },
  { name: 'auth',     signature: '/auth [provider key]',                      summary: 'Configure an API key (alias of /keys)',                     args: 'optional' },
  { name: 'login',    signature: '/login [sk_amx_…]',                         summary: 'Sign in to BVRAI for proxy-routed LLMs',                    args: 'optional' },
  { name: 'mode',     signature: '/mode [planning|default|autocode|admin]',   summary: 'Show or set the workflow mode',                             args: 'optional' },
  { name: 'undo',     signature: '/undo [turn]',                              summary: 'Revert last tool step (or whole turn)',                     args: 'optional' },
  { name: 'trash',    signature: '/trash',                                    summary: 'List recently deleted files (recoverable)',                 args: 'none' },
  { name: 'restore',  signature: '/restore <id>',                             summary: 'Restore a deleted file from the trash',                     args: 'required' },
  { name: 'mcp',      signature: '/mcp',                                      summary: 'List configured MCP servers and their tools',               args: 'none' },
  { name: 'plugins',  signature: '/plugins',                                  summary: 'List installed plugins (skills + hooks)',                   args: 'none' },
  { name: 'spinner',  signature: '/spinner [name]',                           summary: 'Show or set the active spinner',                            args: 'optional' },
  { name: 'ui',       signature: '/ui [inline|cockpit|dark|light]',           summary: 'Switch TUI mode (inline/cockpit) or theme',                 args: 'optional' },
  { name: 'update',   signature: '/update',                                   summary: 'Check for and install the latest autocode',                 args: 'none' },
  { name: 'reflect',  signature: '/reflect',                                  summary: 'Propose AUTOCODE.md additions based on this session',       args: 'none' },
  { name: 'stop',     signature: '/stop',                                     summary: 'Cancel current task (or ^C)',                               args: 'none' },
  { name: 'exit',     signature: '/exit',                                     summary: 'Close autocode',                                            args: 'none' },
];

// Filter COMMAND_DEFS by what the user has typed after the leading slash.
// Empty query returns the full list; otherwise returns commands whose name
// starts with the query (case-insensitive).
export function filterCommands(query: string): CommandDef[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return COMMAND_DEFS.slice();
  return COMMAND_DEFS.filter((c) => c.name.startsWith(q));
}
