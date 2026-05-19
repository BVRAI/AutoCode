import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectInstructions } from '../../src/agent/ProjectInstructions.js';

describe('loadProjectInstructions', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autocode-pi-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no instruction file exists', () => {
    expect(loadProjectInstructions(dir)).toBeNull();
  });

  it('finds AUTOCODE.md first (highest priority)', () => {
    writeFileSync(join(dir, 'AUTOCODE.md'), 'use 2-space indent');
    writeFileSync(join(dir, 'AGENTS.md'), 'use tabs');
    writeFileSync(join(dir, 'CLAUDE.md'), 'use 4-space indent');
    const r = loadProjectInstructions(dir);
    expect(r?.fileName).toBe('AUTOCODE.md');
    expect(r?.content).toContain('2-space');
  });

  it('falls back to AGENTS.md when AUTOCODE.md is missing', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'agents content');
    const r = loadProjectInstructions(dir);
    expect(r?.fileName).toBe('AGENTS.md');
  });

  it('falls back to CLAUDE.md when AGENTS.md is also missing', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude content');
    const r = loadProjectInstructions(dir);
    expect(r?.fileName).toBe('CLAUDE.md');
  });

  it('truncates content above the 20KB cap', () => {
    const big = 'x'.repeat(30_000);
    writeFileSync(join(dir, 'AGENTS.md'), big);
    const r = loadProjectInstructions(dir);
    expect(r?.truncated).toBe(true);
    expect(r?.content.length).toBeLessThanOrEqual(20_000 + 50);
    expect(r?.content).toMatch(/truncated/);
  });
});
