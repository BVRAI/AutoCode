// Auto memory (Phase 4.8): facts the agent keeps across sessions for one
// project — the same shape Automax itself uses: an index file (MEMORY.md,
// one line per memory) plus one file per memory with frontmatter
// (name, description, type user|feedback|project|reference). Stored under
// the data dir, never inside the project. The index and the most useful
// memories load into the system prompt at session start within a cap
// (Claude Code: 200 lines / 25 KB); the agent writes through `save_memory`.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { dataDir } from '../util/paths.js';
import { parseFrontmatter } from '../util/frontmatter.js';

export type MemoryKind = 'user' | 'feedback' | 'project' | 'reference';
export const MEMORY_KINDS: readonly MemoryKind[] = ['user', 'feedback', 'project', 'reference'];

export interface MemoryEntry {
  name: string;
  description: string;
  kind: MemoryKind;
  body: string;
  path: string;
  updatedAt: string;
}

export const MEMORY_LOAD_MAX_LINES = 200;
export const MEMORY_LOAD_MAX_BYTES = 25_000;
const MAX_BODY_BYTES = 4_000;
const MAX_ENTRIES = 300;

export function memoryDir(projectRoot: string): string {
  const hash = createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 16);
  return join(dataDir(), 'projects', hash, 'memory');
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export class MemoryStore {
  readonly dir: string;

  constructor(projectRoot: string, dir?: string) {
    this.dir = dir ?? memoryDir(projectRoot);
  }

  list(): MemoryEntry[] {
    if (!existsSync(this.dir)) return [];
    const out: MemoryEntry[] = [];
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    for (const file of names) {
      if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
      const path = join(this.dir, file);
      let raw: string;
      let mtime = '';
      try {
        raw = readFileSync(path, 'utf8');
        mtime = statSync(path).mtime.toISOString();
      } catch {
        continue;
      }
      const fm = parseFrontmatter(raw);
      if (!fm.hasFrontmatter) continue;
      const meta = fm.meta as Record<string, string | undefined>;
      const kind = MEMORY_KINDS.includes(meta['type'] as MemoryKind) ? (meta['type'] as MemoryKind) : 'project';
      out.push({
        name: meta['name'] ?? file.replace(/\.md$/, ''),
        description: meta['description'] ?? '',
        kind,
        body: fm.body.trim(),
        path,
        updatedAt: mtime,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): MemoryEntry | null {
    const slug = slugify(name);
    return this.list().find((m) => slugify(m.name) === slug) ?? null;
  }

  /** Create or replace one memory; rewrites the index line. */
  save(input: { name: string; description: string; kind: MemoryKind; body: string }): MemoryEntry {
    const slug = slugify(input.name);
    if (!slug) throw new Error('memory name must contain letters or digits');
    if (this.list().length >= MAX_ENTRIES && !this.get(slug)) throw new Error(`memory is full (${MAX_ENTRIES} entries); delete one first`);
    mkdirSync(this.dir, { recursive: true });
    const body = input.body.trim().slice(0, MAX_BODY_BYTES);
    const description = input.description.trim().replace(/\s+/g, ' ').slice(0, 200);
    const content = `---\nname: ${slug}\ndescription: ${description}\ntype: ${input.kind}\n---\n\n${body}\n`;
    const path = join(this.dir, `${slug}.md`);
    writeFileSync(path, content, 'utf8');
    this.writeIndex();
    return { name: slug, description, kind: input.kind, body, path, updatedAt: new Date().toISOString() };
  }

  delete(name: string): boolean {
    const entry = this.get(name);
    if (!entry) return false;
    try {
      unlinkSync(entry.path);
    } catch {
      return false;
    }
    this.writeIndex();
    return true;
  }

  private writeIndex(): void {
    const lines = ['# Memory', '', 'One line per memory; the files hold the details.', ''];
    for (const kind of MEMORY_KINDS) {
      const entries = this.list().filter((m) => m.kind === kind);
      if (entries.length === 0) continue;
      lines.push(`## ${kind}`);
      for (const m of entries) lines.push(`- [${m.name}](${m.name}.md) — ${m.description}`);
      lines.push('');
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'MEMORY.md'), lines.join('\n'), 'utf8');
  }

  /**
   * What goes into the system prompt: every memory's name + description,
   * then bodies newest-first until the cap. Stable for a session (read once
   * at start), so it lives in the cached prefix.
   */
  renderForPrompt(opts: { maxLines?: number; maxBytes?: number } = {}): string {
    const maxLines = opts.maxLines ?? MEMORY_LOAD_MAX_LINES;
    const maxBytes = opts.maxBytes ?? MEMORY_LOAD_MAX_BYTES;
    const entries = this.list();
    if (entries.length === 0) return '';
    const lines: string[] = [];
    let bytes = 0;
    const push = (line: string): boolean => {
      if (lines.length >= maxLines || bytes + line.length + 1 > maxBytes) return false;
      lines.push(line);
      bytes += line.length + 1;
      return true;
    };
    for (const kind of MEMORY_KINDS) {
      const group = entries.filter((m) => m.kind === kind);
      if (group.length === 0) continue;
      push(`## ${kind}`);
      for (const m of group) push(`- **${m.name}** — ${m.description}`);
    }
    // Bodies, most recently updated first, while there is room.
    const byRecency = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    let wroteHeader = false;
    for (const m of byRecency) {
      const body = m.body.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (body.length === 0) continue;
      const needed = body.length + 1;
      if (lines.length + needed > maxLines) continue;
      if (!wroteHeader) {
        if (!push('## details')) break;
        wroteHeader = true;
      }
      if (!push(`### ${m.name}`)) break;
      let ok = true;
      for (const l of body) {
        if (!push(l)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }
    return lines.join('\n');
  }
}
