import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import {
  createCapture,
  middleTruncate,
  trimOutput,
  MAX_MODEL_OUTPUT_CHARS,
  RunShellTool,
  type CapturedStream,
} from '../../src/tools/runShell.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function ctx(): ToolExecutionContext {
  const session: SessionContext = {
    sessionId: 't',
    projectRoot: tmpdir(),
    dataDir: tmpdir(),
    sessionDir: tmpdir(),
    model: { provider: 'xai', model: 'm' },
    startedAt: new Date().toISOString(),
    mode: 'autocode',
  };
  return { session };
}

describe('run_shell quoting', () => {
  // Regression: argv-array spawn on Windows re-escaped embedded quotes into
  // \" which cmd.exe mangled — quoted arguments with spaces were corrupted.
  it('preserves a quoted argument that contains spaces', async () => {
    const out = await new RunShellTool().execute(
      { command: 'node -e "console.log(\'a b c\')"' },
      ctx(),
    );
    expect(out.isError).toBe(false);
    expect(out.content).toContain('a b c');
  }, 20_000);

  it('passes a quoted spaced path through as a single argument', async () => {
    const out = await new RunShellTool().execute(
      { command: 'node -e "console.log(process.argv[1])" "new par website"' },
      ctx(),
    );
    expect(out.isError).toBe(false);
    expect(out.content).toContain('new par website');
  }, 20_000);
});

describe('run_shell background mode', () => {
  it('returns promptly for a long-running process instead of hanging', async () => {
    const t0 = Date.now();
    const out = await new RunShellTool().execute(
      { command: 'node -e "setInterval(()=>{},1000)"', background: true },
      ctx(),
    );
    const elapsed = Date.now() - t0;
    expect(out.metadata?.background).toBe(true);
    // returns after the ~3s grace window, not the 300s foreground timeout
    expect(elapsed).toBeLessThan(15_000);
    const pid = out.metadata?.pid as number | undefined;
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
  }, 20_000);

  it('captures startup output from a quick background command', async () => {
    const out = await new RunShellTool().execute(
      { command: 'echo hello-bg', background: true },
      ctx(),
    );
    expect(out.content).toContain('hello-bg');
  }, 20_000);
});

function stream(text: string): CapturedStream {
  return { head: text, tail: '', chars: text.length, bytes: Buffer.byteLength(text) };
}

const EMPTY = stream('');

describe('middleTruncate', () => {
  it('passes short output through unchanged', () => {
    const r = middleTruncate(stream('hello world'), 1_000);
    expect(r.text).toBe('hello world');
    expect(r.truncated).toBe(false);
  });

  it('middle-truncates long output with an omission marker and correct count', () => {
    const r = middleTruncate(stream('x'.repeat(50_000)), 10_000);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('40000 chars omitted');
    expect(r.text).toContain('middle-truncated');
  });

  it('preserves a tail sentinel — failure summaries at the end survive', () => {
    const sentinel = 'FAIL test/foo.test.ts — 3 failed';
    const r = middleTruncate(stream('noise\n'.repeat(20_000) + sentinel), 10_000);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith(sentinel)).toBe(true);
  });

  it('gives the tail a larger share than the head', () => {
    const full = 'H'.repeat(50_000) + 'T'.repeat(50_000);
    const r = middleTruncate(stream(full), 10_000);
    const headKept = (r.text.match(/H/g) ?? []).length;
    const tailKept = (r.text.match(/T/g) ?? []).length;
    expect(tailKept).toBeGreaterThan(headKept);
  });

  it('counts capture-dropped chars in the omission marker', () => {
    // Simulates a capture that already lost 500 chars in the middle.
    const s: CapturedStream = { head: 'a'.repeat(100), tail: 'b'.repeat(100), chars: 700, bytes: 700 };
    const r = middleTruncate(s, 10_000);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('500 chars omitted');
    expect(r.text.startsWith('a'.repeat(100))).toBe(true);
    expect(r.text.endsWith('b'.repeat(100))).toBe(true);
  });
});

describe('trimOutput', () => {
  it('renders (no output) for empty streams', () => {
    expect(trimOutput(EMPTY, EMPTY).content).toBe('(no output)');
  });

  it('keeps section headers for both streams', () => {
    const r = trimOutput(stream('out'), stream('err'));
    expect(r.content).toContain('--- stdout ---\nout');
    expect(r.content).toContain('--- stderr ---\nerr');
    expect(r.stdoutTruncated).toBe(false);
    expect(r.stderrTruncated).toBe(false);
  });

  it('stderr survives a huge stdout', () => {
    const err = 'E'.repeat(5_000) + '\nTHE-REAL-ERROR';
    const r = trimOutput(stream('x'.repeat(500_000)), stream(err));
    expect(r.content).toContain('THE-REAL-ERROR');
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderrTruncated).toBe(false);
    // Total stays within the model budget plus small marker/header overhead.
    expect(r.content.length).toBeLessThan(MAX_MODEL_OUTPUT_CHARS + 500);
  });

  it('gives stdout the full budget when stderr is empty', () => {
    const r = trimOutput(stream('x'.repeat(MAX_MODEL_OUTPUT_CHARS - 100)), EMPTY);
    expect(r.stdoutTruncated).toBe(false);
  });
});

describe('createCapture', () => {
  it('keeps head and tail with exact char/byte totals on very large input', () => {
    const cap = createCapture();
    const chunk = 'y'.repeat(10_000);
    for (let i = 0; i < 100; i++) cap.push(Buffer.from(chunk)); // 1M chars total
    cap.push(Buffer.from('LAST-CHUNK'));
    const s = cap.snapshot();
    expect(s.chars).toBe(1_000_000 + 'LAST-CHUNK'.length);
    expect(s.bytes).toBe(1_000_000 + 'LAST-CHUNK'.length);
    // Retention is bounded: head + tail caps, not the full megabyte.
    expect(s.head.length + s.tail.length).toBeLessThanOrEqual(400_000);
    expect(s.tail.endsWith('LAST-CHUNK')).toBe(true);
  });

  it('holds everything when input fits the head buffer', () => {
    const cap = createCapture();
    cap.push(Buffer.from('small output'));
    const s = cap.snapshot();
    expect(s.head).toBe('small output');
    expect(s.tail).toBe('');
    expect(s.chars).toBe('small output'.length);
  });
});

describe('run_shell end-to-end truncation', () => {
  it('middle-truncates 80K of stdout keeping the tail and stderr intact', async () => {
    const script =
      "process.stdout.write('x'.repeat(80000)); console.log('TAIL-SENTINEL'); console.error('ERR-SENTINEL')";
    const result = await new RunShellTool().execute(
      { command: `node -e "${script}"` },
      ctx(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('chars omitted');
    expect(result.content).toContain('TAIL-SENTINEL');
    expect(result.content).toContain('ERR-SENTINEL');
    const md = result.metadata as { stdoutTruncated?: boolean; stdoutChars?: number };
    expect(md.stdoutTruncated).toBe(true);
    expect(md.stdoutChars).toBeGreaterThan(80_000);
  }, 30_000);
});
