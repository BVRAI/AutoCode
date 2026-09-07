// TtySession — drive the harness in a terminal from a test.
//
// Two backends behind one API:
//   'pty'      — node-pty spawns `node dist/cli.js` under a real pseudo-console
//                (ConPTY on Windows), the same substrate Automax's terminal
//                sits on. Default when node-pty loads.
//   'emulated' — plain pipes plus AUTOCODE_TTY_EMULATE (see util/ttyEmulation.ts);
//                no native module; resizes are a private OSC on stdin.
// Either way the byte stream feeds a headless xterm, and the test reads the
// screen the user would see: rows of text, cells with colors, the cursor.
//
// Every session gets a fresh HOME (config + data isolated from the developer's
// own ~/.autocode) and a fresh copy of the project it works on, so scenarios
// can edit files freely and run identically every time.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';
import type { Terminal as XtermTerminal } from '@xterm/headless';

export type TtyBackend = 'pty' | 'emulated';

export interface TtyOptions {
  /** Project directory to copy into the session's home and open the harness in. */
  project: string;
  cols?: number;
  rows?: number;
  theme?: 'dark' | 'light';
  mode?: 'default' | 'planning' | 'autocode' | 'admin';
  /** Path to a FakeProvider script (AUTOCODE_FAKE_LLM). */
  fakeScript?: string;
  backend?: TtyBackend;
  /** Extra CLI arguments. */
  args?: string[];
  /** Extra environment for the harness. */
  env?: Record<string, string>;
  /** dist/cli.js to run; defaults to the one next to this module's dist. */
  cli?: string;
  /** Provider/model label shown in the UI; the fake model ignores them. */
  provider?: string;
  model?: string;
}

export interface CellInfo {
  ch: string;
  fg: number | null;
  bg: number | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

/** Key names → the bytes a terminal sends. */
export const KEYS: Record<string, string> = {
  enter: '\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  'shift+tab': '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  backspace: '\x7f',
  delete: '\x1b[3~',
  space: ' ',
  'ctrl+a': '\x01',
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+e': '\x05',
  'ctrl+g': '\x07',
  'ctrl+j': '\n',
  'ctrl+l': '\x0c',
  'ctrl+o': '\x0f',
  'ctrl+p': '\x10',
  'ctrl+t': '\x14',
  'ctrl+u': '\x15',
  'ctrl+v': '\x16',
};

export function keyBytes(name: string): string {
  const k = KEYS[name.toLowerCase()];
  if (k !== undefined) return k;
  // A single character ("1", "y", "/") is sent as itself.
  if ([...name].length === 1) return name;
  throw new Error(`unknown key: ${name}`);
}

/** True when node-pty can be loaded on this machine (prebuilt binding present). */
export async function ptyAvailable(): Promise<boolean> {
  try {
    await import('node-pty');
    return true;
  } catch {
    return false;
  }
}

/** The end-of-turn line: "✻ Cooked for 23s · done 6:05 PM". */
export const TURN_END = /(Worked|Cooked|Sautéed|Baked|Brewed|Crafted|Hatched|Pondered|Cogitated|Percolated|Mused|Simmered) for \d/;

export class TtySession {
  readonly home: string;
  readonly projectDir: string;
  readonly backend: TtyBackend;
  readonly exited: Promise<number>;
  private cols: number;
  private rows: number;
  private readonly term: XtermTerminal;
  private pty: import('node-pty').IPty | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: Promise<void> = Promise.resolve();
  private lastOutputAt = Date.now();
  private outputVersion = 0;
  private resolveExit!: (code: number) => void;
  private exitCode: number | null = null;
  private stopped = false;

  private constructor(opts: { home: string; projectDir: string; backend: TtyBackend; cols: number; rows: number }) {
    this.home = opts.home;
    this.projectDir = opts.projectDir;
    this.backend = opts.backend;
    this.cols = opts.cols;
    this.rows = opts.rows;
    // Over plain pipes nothing turns "\n" into "\r\n" (a pty's ONLCR does), so
    // the emulated backend lets the terminal do it.
    this.term = new xterm.Terminal({
      cols: opts.cols,
      rows: opts.rows,
      allowProposedApi: true,
      scrollback: 5000,
      convertEol: opts.backend === 'emulated',
    });
    this.exited = new Promise<number>((r) => {
      this.resolveExit = (code) => {
        this.exitCode = code;
        r(code);
      };
    });
  }

  static async start(opts: TtyOptions): Promise<TtySession> {
    const cols = opts.cols ?? 100;
    const rows = opts.rows ?? 30;
    const backend: TtyBackend = opts.backend ?? ((await ptyAvailable()) ? 'pty' : 'emulated');
    const home = mkdtempSync(join(tmpdir(), 'autocode-e2e-'));
    const projectDir = join(home, 'project');
    cpSync(resolve(opts.project), projectDir, { recursive: true });
    const configDir = join(home, '.autocode');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(home, 'data'), { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify(
        {
          firstRunCompletedAt: '2026-01-01T00:00:00.000Z',
          autoVerify: false,
          autoUpdate: false,
          reflectAfterSession: false,
          webTools: { enabled: false },
          ui: { mode: 'inline', theme: opts.theme ?? 'dark' },
          defaultProvider: opts.provider ?? 'xai',
          defaultModel: opts.model ?? 'grok-code-fast-1',
        },
        null,
        2,
      ),
    );

    const cli = opts.cli ?? defaultCliPath();
    const args = [
      cli,
      '--project-root',
      projectDir,
      '--provider',
      opts.provider ?? 'xai',
      '--model',
      opts.model ?? 'grok-code-fast-1',
      '--mode',
      opts.mode ?? 'autocode',
      ...(opts.args ?? []),
    ];
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const k of Object.keys(env)) {
      if (k.startsWith('AUTOMAX_') || k === 'CI' || k === 'AUTOCODE_FAKE_LLM' || k === 'AUTOCODE_TTY_EMULATE') delete env[k];
    }
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      AUTOCODE_CONFIG_DIR: configDir,
      AUTOCODE_DATA_DIR: join(home, 'data'),
      AUTOMAX_THEME: opts.theme ?? 'dark',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
      NO_UPDATE_NOTIFIER: '1',
      AUTOCODE_E2E: '1',
    });
    if (opts.fakeScript) env['AUTOCODE_FAKE_LLM'] = resolve(opts.fakeScript);
    if (backend === 'emulated') env['AUTOCODE_TTY_EMULATE'] = `${cols}x${rows}`;
    Object.assign(env, opts.env ?? {});

    const session = new TtySession({ home, projectDir, backend, cols, rows });
    if (backend === 'pty') {
      const pty = await import('node-pty');
      const p = pty.spawn(process.execPath, args, { name: 'xterm-256color', cols, rows, cwd: projectDir, env });
      p.onData((d) => session.feed(d));
      p.onExit(({ exitCode }) => session.resolveExit(exitCode));
      session.pty = p;
    } else {
      const child = spawn(process.execPath, args, { cwd: projectDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.on('data', (d: Buffer) => session.feed(d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => session.feed(d.toString('utf8')));
      child.on('exit', (code) => session.resolveExit(code ?? -1));
      session.child = child;
    }
    return session;
  }

  private feed(data: string): void {
    this.lastOutputAt = Date.now();
    this.outputVersion += 1;
    this.pending = this.pending.then(() => new Promise<void>((r) => this.term.write(data, r)));
  }

  /** Wait until every byte received so far has been parsed by the terminal. */
  async flush(): Promise<void> {
    await this.pending;
  }

  write(data: string): void {
    if (this.pty) this.pty.write(data);
    else this.child?.stdin.write(data);
  }

  /**
   * Type text, then pause briefly so the next key lands in its own read:
   * ConPTY coalesces back-to-back writes, and a `\r` glued to the end of a
   * text chunk is not a Return key to Ink's parser (a person cannot type that
   * fast, but a script can).
   */
  async type(text: string): Promise<void> {
    this.write(text);
    await sleep(40);
  }

  async key(name: string): Promise<void> {
    this.write(keyBytes(name));
    await sleep(40);
  }

  /** Paste as a terminal would: wrapped in bracketed-paste markers. */
  async paste(text: string): Promise<void> {
    this.write(`\x1b[200~${text}\x1b[201~`);
    await sleep(60);
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    if (this.pty) this.pty.resize(cols, rows);
    else this.child?.stdin.write(`\x1b]7777;resize;${cols}x${rows}\x07`);
  }

  size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  /** Visible rows, right-trimmed. */
  screen(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      out.push(line ? line.translateToString(true) : '');
    }
    return out;
  }

  screenText(): string {
    return this.screen().join('\n');
  }

  /** Everything in the buffer (scrollback + screen), right-trimmed. */
  scrollback(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      out.push(line ? line.translateToString(true) : '');
    }
    return out;
  }

  cursor(): { x: number; y: number } {
    const buf = this.term.buffer.active;
    return { x: buf.cursorX, y: buf.cursorY };
  }

  /** Visible cells with attributes, for color checks. */
  cells(): CellInfo[][] {
    const buf = this.term.buffer.active;
    const rows: CellInfo[][] = [];
    for (let y = 0; y < this.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      const row: CellInfo[] = [];
      if (line) {
        for (let x = 0; x < this.cols; x++) {
          const c = line.getCell(x);
          if (!c) break;
          row.push({
            ch: c.getChars() || ' ',
            fg: c.isFgDefault() ? null : c.getFgColor(),
            bg: c.isBgDefault() ? null : c.getBgColor(),
            bold: c.isBold() !== 0,
            dim: c.isDim() !== 0,
            italic: c.isItalic() !== 0,
            underline: c.isUnderline() !== 0,
            inverse: c.isInverse() !== 0,
          });
        }
      }
      rows.push(row);
    }
    return rows;
  }

  /** Poll until the screen matches; resolves with the screen text. */
  async waitFor(pattern: RegExp | string | ((screen: string) => boolean), timeoutMs = 20_000): Promise<string> {
    const test = (s: string): boolean =>
      typeof pattern === 'function' ? pattern(s) : typeof pattern === 'string' ? s.includes(pattern) : pattern.test(s);
    const started = Date.now();
    for (;;) {
      await this.flush();
      const s = this.screenText();
      if (test(s)) return s;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`waitFor timed out after ${timeoutMs}ms waiting for ${String(pattern)}\n--- screen ---\n${s}`);
      }
      await sleep(50);
    }
  }

  /** Resolve once no output has arrived for `quietMs`. */
  async waitIdle(quietMs = 500, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();
    for (;;) {
      await this.flush();
      if (Date.now() - this.lastOutputAt >= quietMs) return;
      if (Date.now() - started > timeoutMs) throw new Error(`waitIdle timed out after ${timeoutMs}ms`);
      await sleep(50);
    }
  }

  /** Ask the harness to quit; kill it only if it does not go on its own. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.exitCode === null) {
      try {
        await this.key('esc'); // closes any menu or dialog first
        await this.type('/exit');
        await this.key('enter');
      } catch {
        /* pipe already closed */
      }
      const left = await Promise.race([this.exited.then(() => true), sleep(2500).then(() => false)]);
      if (!left) {
        try {
          if (this.pty) this.pty.kill();
          else this.child?.kill();
        } catch {
          /* already gone */
        }
        await Promise.race([this.exited, sleep(2000)]);
      }
    }
    this.term.dispose();
  }
}

function defaultCliPath(): string {
  // dist/testkit/tty.js → dist/cli.js (or src/testkit/tty.ts → dist/cli.js under vitest)
  const here = dirname(fileURLToPath(import.meta.url));
  const fromDist = resolve(here, '..', 'cli.js');
  const fromSrc = resolve(here, '..', '..', 'dist', 'cli.js');
  return here.replace(/\\/g, '/').includes('/dist/') ? fromDist : fromSrc;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
