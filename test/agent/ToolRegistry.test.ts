import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/agent/ToolRegistry.js';

describe('ToolRegistry', () => {
  it('full registry includes all standard tools (web tools optional via config)', () => {
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
        'task',
      ]),
    );
    // web_fetch + web_search are conditional on webTools.enabled config —
    // tests don't assert their presence/absence since user-space config
    // can swing either way during test runs.
  });

  it('forSubagent("Explore") contains the read-only core', () => {
    const r = ToolRegistry.forSubagent('Explore');
    const names = r.schemas().map((s) => s.name);
    // Core read-only tools always present.
    for (const required of ['find_symbol', 'glob', 'grep', 'list_directory', 'read_file']) {
      expect(names).toContain(required);
    }
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
