import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../util/paths.js';

export interface ProjectStateData {
  projectRoot: string;
  recentFiles: string[];
  knownCommands: string[];
  lastUpdated: string;
}

export class ProjectState {
  private readonly path: string;
  private data: ProjectStateData;

  constructor(projectRoot: string) {
    const hash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
    const dir = join(dataDir(), 'projects', hash);
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'project_state.json');
    this.data = existsSync(this.path) ? this.load() : this.fresh(projectRoot);
  }

  private fresh(projectRoot: string): ProjectStateData {
    return {
      projectRoot,
      recentFiles: [],
      knownCommands: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  private load(): ProjectStateData {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as ProjectStateData;
    } catch {
      return this.fresh('');
    }
  }

  recordFileAccess(relPath: string): void {
    const recent = this.data.recentFiles.filter((p) => p !== relPath);
    recent.unshift(relPath);
    this.data.recentFiles = recent.slice(0, 50);
    this.persist();
  }

  recordCommand(command: string): void {
    if (!this.data.knownCommands.includes(command)) {
      this.data.knownCommands = [command, ...this.data.knownCommands].slice(0, 50);
      this.persist();
    }
  }

  get recentFiles(): readonly string[] {
    return this.data.recentFiles;
  }

  get knownCommands(): readonly string[] {
    return this.data.knownCommands;
  }

  private persist(): void {
    this.data.lastUpdated = new Date().toISOString();
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf8');
  }
}
