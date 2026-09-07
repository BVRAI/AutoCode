// A small Language Server Protocol client (Phase 3.5 leftover): JSON-RPC
// over stdio with Content-Length framing, one server per language per
// session, started lazily by the `lsp` tool and stopped at session end.
// Servers are discovered in the project (node_modules) and on PATH, and can
// be pinned with AUTOCODE_LSP_<LANGUAGE>="<command> [args]" (or a config
// `lsp.servers` map). Everything degrades to a clear tool error when no
// server is available — the tree-sitter index remains the default path.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, extname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export type LspLanguage = 'typescript' | 'python' | 'csharp' | 'go' | 'rust';

export interface LspServerSpec {
  language: LspLanguage;
  command: string;
  args: string[];
  /** Spawn through the platform shell (PATH shims such as .cmd files). */
  shell: boolean;
}

export interface LspPosition {
  line: number; // 0-based
  character: number; // 0-based
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

export interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange?: LspRange;
  children?: LspDocumentSymbol[];
  detail?: string;
}

const EXT_LANGUAGE: Record<string, LspLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'typescript',
  '.jsx': 'typescript',
  '.mjs': 'typescript',
  '.cjs': 'typescript',
  '.py': 'python',
  '.pyi': 'python',
  '.cs': 'csharp',
  '.go': 'go',
  '.rs': 'rust',
};

const LANGUAGE_ID: Record<LspLanguage, string> = {
  typescript: 'typescript',
  python: 'python',
  csharp: 'csharp',
  go: 'go',
  rust: 'rust',
};

export function languageForPath(path: string): LspLanguage | null {
  const ext = extname(path).toLowerCase();
  const lang = EXT_LANGUAGE[ext];
  if (!lang) return null;
  return lang;
}

/** Which LSP language id to send for a file (JavaScript files still use the TypeScript server). */
export function languageIdForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (ext === '.tsx') return 'typescriptreact';
  const lang = languageForPath(path);
  return lang ? LANGUAGE_ID[lang] : 'plaintext';
}

function onPath(name: string): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const p = join(dir, n);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Split "cmd arg1 arg2" (double quotes respected) for the env / config override. */
export function parseCommandLine(line: string): { command: string; args: string[] } | null {
  const parts = line.match(/"[^"]*"|\S+/g)?.map((p) => p.replace(/^"|"$/g, '')) ?? [];
  if (parts.length === 0) return null;
  return { command: parts[0]!, args: parts.slice(1) };
}

/**
 * Find a server for a language: an explicit override first, then the
 * project's own install (TypeScript), then PATH. Null when nothing is found.
 */
export function discoverServer(language: LspLanguage, projectRoot: string, overrides: Partial<Record<LspLanguage, string>> = {}): LspServerSpec | null {
  const override = process.env[`AUTOCODE_LSP_${language.toUpperCase()}`] ?? overrides[language];
  if (override) {
    const parsed = parseCommandLine(override);
    if (parsed) return { language, command: parsed.command, args: parsed.args, shell: false };
  }
  switch (language) {
    case 'typescript': {
      const local = join(projectRoot, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs');
      if (existsSync(local)) return { language, command: process.execPath, args: [local, '--stdio'], shell: false };
      const bin = onPath('typescript-language-server');
      if (bin) return { language, command: bin, args: ['--stdio'], shell: process.platform === 'win32' };
      return null;
    }
    case 'python': {
      const pyright = onPath('pyright-langserver');
      if (pyright) return { language, command: pyright, args: ['--stdio'], shell: process.platform === 'win32' };
      const pylsp = onPath('pylsp');
      if (pylsp) return { language, command: pylsp, args: [], shell: process.platform === 'win32' };
      return null;
    }
    case 'csharp': {
      const bin = onPath('csharp-ls');
      return bin ? { language, command: bin, args: [], shell: process.platform === 'win32' } : null;
    }
    case 'go': {
      const bin = onPath('gopls');
      return bin ? { language, command: bin, args: [], shell: process.platform === 'win32' } : null;
    }
    case 'rust': {
      const bin = onPath('rust-analyzer');
      return bin ? { language, command: bin, args: [], shell: process.platform === 'win32' } : null;
    }
  }
}

export function installHint(language: LspLanguage): string {
  switch (language) {
    case 'typescript':
      return 'npm i -D typescript-language-server typescript (in the project) or npm i -g typescript-language-server';
    case 'python':
      return 'pip install pyright (pyright-langserver) or pip install python-lsp-server';
    case 'csharp':
      return 'dotnet tool install --global csharp-ls';
    case 'go':
      return 'go install golang.org/x/tools/gopls@latest';
    case 'rust':
      return 'rustup component add rust-analyzer';
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class LspClient {
  private readonly proc: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly diagnosticWaiters = new Map<string, Array<() => void>>();
  private readonly openDocs = new Map<string, number>();
  private readonly activeProgress = new Set<string>();
  private progressSeen = false;
  private readonly progressWaiters: Array<() => void> = [];
  private exited = false;
  private exitError: string | null = null;

  private constructor(
    readonly spec: LspServerSpec,
    readonly projectRoot: string,
    proc: ChildProcess,
  ) {
    this.proc = proc;
    proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    proc.stderr?.on('data', () => undefined);
    proc.on('exit', (code) => {
      this.exited = true;
      this.exitError = `language server exited (code ${code ?? 'n/a'})`;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(this.exitError));
        this.pending.delete(id);
      }
    });
    proc.on('error', (err) => {
      this.exited = true;
      this.exitError = `language server failed to start: ${err.message}`;
    });
  }

  static async start(spec: LspServerSpec, projectRoot: string, opts: { initTimeoutMs?: number } = {}): Promise<LspClient> {
    const proc = spawn(spec.command, spec.args, {
      cwd: projectRoot,
      shell: spec.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const client = new LspClient(spec, projectRoot, proc);
    const rootUri = pathToFileURL(resolve(projectRoot)).href;
    await client.request(
      'initialize',
      {
        processId: process.pid,
        rootUri,
        rootPath: resolve(projectRoot),
        workspaceFolders: [{ uri: rootUri, name: 'project' }],
        capabilities: {
          textDocument: {
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            publishDiagnostics: {},
          },
          workspace: { workspaceFolders: true },
          // Servers report project loading as work-done progress; the
          // client waits for it before the first semantic request.
          window: { workDoneProgress: true },
        },
        initializationOptions: {},
      },
      opts.initTimeoutMs ?? 30_000,
    );
    client.notify('initialized', {});
    return client;
  }

  get alive(): boolean {
    return !this.exited;
  }

  uriFor(absPath: string): string {
    return pathToFileURL(resolve(absPath)).href;
  }

  static pathFor(uri: string): string {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri;
    }
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
    if (this.exited) return Promise.reject(new Error(this.exitError ?? 'language server is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`language server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: (v) => resolvePromise(v as T), reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Open (or refresh) a document from disk so the server has its text. */
  open(absPath: string): string {
    return this.openDocument(absPath).uri;
  }

  /**
   * Open a document and say whether this was its first open. A server that
   * is still loading the project answers the first requests for a fresh
   * document from syntax alone (TypeScript: the import alias instead of the
   * declaration); callers wait for its first diagnostics push in that case.
   */
  openDocument(absPath: string): { uri: string; fresh: boolean } {
    const uri = this.uriFor(absPath);
    const text = readFileSync(absPath, 'utf8');
    const version = (this.openDocs.get(uri) ?? 0) + 1;
    if (version === 1) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: languageIdForPath(absPath), version, text } });
    } else {
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
    this.openDocs.set(uri, version);
    return { uri, fresh: version === 1 };
  }

  currentDiagnostics(uri: string): LspDiagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  /**
   * Wait until the server has no work-done progress in flight (TypeScript
   * reports "Initializing JS/TS language features" while it loads the
   * project; answers before that are syntax-only). Resolves after `ms` at
   * the latest, and after a short grace period when no progress was ever
   * reported (servers that do not use progress).
   */
  waitForProjectLoad(ms: number, graceMs = 400): Promise<void> {
    return new Promise((resolvePromise) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolvePromise();
      };
      const deadline = setTimeout(finish, ms);
      deadline.unref?.();
      const check = (): void => {
        if (this.progressSeen && this.activeProgress.size === 0) {
          clearTimeout(deadline);
          finish();
        }
      };
      this.progressWaiters.push(check);
      // Give a late `begin` a moment to arrive; if none does, do not wait.
      const grace = setTimeout(() => {
        if (!this.progressSeen) {
          clearTimeout(deadline);
          finish();
        }
      }, graceMs);
      grace.unref?.();
      check();
    });
  }

  /** Diagnostics for a document, waiting up to `ms` for the server's next publish. */
  waitForDiagnostics(uri: string, ms: number): Promise<LspDiagnostic[]> {
    return new Promise((resolvePromise) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolvePromise(this.diagnostics.get(uri) ?? []);
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      const list = this.diagnosticWaiters.get(uri) ?? [];
      list.push(() => {
        clearTimeout(timer);
        finish();
      });
      this.diagnosticWaiters.set(uri, list);
    });
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    try {
      await this.request('shutdown', null, 3_000);
      this.notify('exit', null);
    } catch {
      /* fall through to kill */
    }
    setTimeout(() => {
      try {
        if (!this.exited) this.proc.kill();
      } catch {
        /* ignore */
      }
    }, 500).unref?.();
  }

  private send(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const head = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    try {
      this.proc.stdin?.write(Buffer.concat([head, body]));
    } catch {
      /* server gone; the exit handler rejects pending requests */
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(m[1]!, 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(body) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg['id'] === 'number' && !('method' in msg)) {
      const p = this.pending.get(msg['id']);
      if (!p) return;
      this.pending.delete(msg['id']);
      clearTimeout(p.timer);
      const err = msg['error'] as { message?: string } | undefined;
      if (err) p.reject(new Error(err.message ?? 'language server error'));
      else p.resolve(msg['result']);
      return;
    }
    const method = msg['method'];
    if (method === '$/progress') {
      const params = msg['params'] as { token: string | number; value?: { kind?: string } };
      const token = String(params.token);
      const kind = params.value?.kind;
      if (kind === 'begin') {
        this.progressSeen = true;
        this.activeProgress.add(token);
      } else if (kind === 'end') {
        this.activeProgress.delete(token);
      }
      for (const w of [...this.progressWaiters]) w();
      if (this.activeProgress.size === 0) this.progressWaiters.length = 0;
      return;
    }
    if (method === 'textDocument/publishDiagnostics') {
      const params = msg['params'] as { uri: string; diagnostics: LspDiagnostic[] };
      this.diagnostics.set(params.uri, params.diagnostics ?? []);
      const waiters = this.diagnosticWaiters.get(params.uri) ?? [];
      this.diagnosticWaiters.delete(params.uri);
      for (const w of waiters) w();
      return;
    }
    // Server → client requests (configuration, registrations): answer with nulls so it proceeds.
    if (typeof msg['id'] === 'number' && typeof method === 'string') {
      const result = method === 'workspace/configuration' ? ((msg['params'] as { items?: unknown[] })?.items ?? []).map(() => null) : null;
      this.send({ jsonrpc: '2.0', id: msg['id'], result });
    }
  }
}
