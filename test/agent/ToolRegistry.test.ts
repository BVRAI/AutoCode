import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/agent/ToolRegistry.js';

describe('ToolRegistry', () => {
  it('full registry includes all standard tools', () => {
    const r = new ToolRegistry();
    const names = r.schemas().map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_directory',
        'read_file',
        'edit_file',
        'write_file',
        'run_shell',
        'glob',
        'grep',
        'todo_write',
        'web_fetch',
        'web_search',
        'task',
      ]),
    );
  });

  it('forSubagent("Explore") contains only read-only tools', () => {
    const r = ToolRegistry.forSubagent('Explore');
    const names = r.schemas().map((s) => s.name).sort();
    expect(names).toEqual([
      'find_symbol',
      'glob',
      'grep',
      'list_directory',
      'read_file',
      'web_fetch',
      'web_search',
    ]);
  });

  it('Explore subagent registry has NO write/edit/shell tools', () => {
    const r = ToolRegistry.forSubagent('Explore');
    const names = r.schemas().map((s) => s.name);
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('run_shell');
  });

  it('Explore subagent registry has NO task tool (no recursion)', () => {
    const r = ToolRegistry.forSubagent('Explore');
    const names = r.schemas().map((s) => s.name);
    expect(names).not.toContain('task');
  });
});
