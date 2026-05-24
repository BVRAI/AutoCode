import pc from 'picocolors';
import type { SessionContext, AgentMode } from '../session/SessionContext.js';
import { detectProjectContext, formatContextLine } from '../agent/ProjectContext.js';
import { loadProjectInstructions } from '../agent/ProjectInstructions.js';
import { printBanner } from './Banner.js';
import { Spinner } from './Spinner.js';
import { renderUnifiedDiff } from '../util/diff.js';
import { renderMarkdown, looksLikeMarkdown } from './MarkdownRenderer.js';
import { getRepoMap } from '../agent/RepoMap.js';

// Optional output sink. When set, ConsoleRenderer routes all writes to
// this interface instead of stdout/stderr — used by the Ink Bridge UI to
// pull text into React state without touching any caller.
export interface RendererSink {
  info(text: string): void;
  assistant(text: string): void;
  dim(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  status(text: string): void;
  rule(): void;
  diff(label: string, before: string, after: string): void;
  user(text: string): void;
}

export class ConsoleRenderer {
  readonly spinner = new Spinner();
  private streaming = false;
  private streamBuffer = '';
  // Optional one-line banner shown in the header — set by the update checker
  // at startup when a newer autocode version is available.
  private updateBanner: string | null = null;
  private sink: RendererSink | null = null;

  // Attach a sink. After this, every output method routes to the sink and
  // stdout is left alone (the Ink TUI takes over the screen). printHeader
  // is a no-op in this mode — the rail/banner render via Ink components.
  setSink(sink: RendererSink | null): void {
    this.sink = sink;
  }

  setUpdateBanner(text: string | null): void {
    this.updateBanner = text;
  }

  printHeader(ctx: SessionContext): void {
    if (this.sink) return; // Ink owns the screen — banner is rendered as a component
    printBanner();
    const project = detectProjectContext(ctx.projectRoot);
    const projLine = formatContextLine(project);
    const instructions = loadProjectInstructions(ctx.projectRoot);

    const lines = [
      `${pc.dim('session:')} ${ctx.sessionId}`,
      `${pc.dim('project:')} ${ctx.projectRoot}${projLine ? ' · ' + pc.cyan(projLine) : ''}`,
      `${pc.dim('model:  ')} ${ctx.model.provider} / ${ctx.model.model}`,
      `${pc.dim('mode:   ')} ${this.modeLabel(ctx.mode)}${pc.dim('  ·  shift+tab to cycle')}`,
    ];
    if (instructions.length > 0) {
      const labels = instructions.map((inst) => {
        const scope = inst.relativeDir === '' ? inst.fileName : `${inst.relativeDir}/${inst.fileName}`;
        return inst.isAuthoritative ? pc.yellow(`⚠ ${scope}`) : scope;
      });
      const shown =
        labels.length > 5
          ? `${labels.slice(0, 5).join(', ')} (+${labels.length - 5} more)`
          : labels.join(', ');
      lines.push(pc.dim(`loaded ${shown}`));
    }
    const repoMap = getRepoMap(ctx.projectRoot);
    if (repoMap) {
      const n = repoMap.split('\n').filter((l) => l.length > 0 && !l.startsWith('…')).length;
      lines.push(pc.dim(`repo map: ${n} file${n === 1 ? '' : 's'} indexed`));
    }
    if (this.updateBanner) lines.push(this.updateBanner);
    lines.push('');
    lines.push(pc.dim('Type /help for commands. Plain text is sent to the agent.'));
    lines.push('');
    process.stdout.write(lines.join('\n') + '\n');
  }

  // Colored mode label: planning=yellow, default=cyan, autocode=green.
  modeLabel(mode: AgentMode): string {
    const paint = mode === 'planning' ? pc.yellow : mode === 'autocode' ? pc.green : pc.cyan;
    return paint(`▸ ${mode} mode`);
  }

  info(text: string): void {
    if (this.sink) { this.sink.info(text); return; }
    process.stdout.write(text + '\n');
  }

  // A full-width horizontal rule — separates a user prompt from the reply.
  rule(): void {
    if (this.sink) { this.sink.rule(); return; }
    process.stdout.write(pc.dim('─'.repeat(process.stdout.columns || 80)) + '\n');
  }

  assistant(text: string): void {
    if (this.sink) { this.sink.assistant(text); return; }
    const lines = text.split(/\r?\n/);
    let first = true;
    for (const line of lines) {
      if (first) {
        if (line.trim().length === 0) continue;
        process.stdout.write(`${pc.magenta('ac:')} ${line}\n`);
        first = false;
      } else {
        process.stdout.write(`    ${line}\n`);
      }
    }
    process.stdout.write('\n');
  }

  dim(text: string): void {
    if (this.sink) { this.sink.dim(text); return; }
    process.stdout.write(pc.dim(text) + '\n');
  }

  warn(text: string): void {
    if (this.sink) { this.sink.warn(text); return; }
    process.stderr.write(pc.yellow(text) + '\n');
  }

  error(text: string): void {
    if (this.sink) { this.sink.error(text); return; }
    process.stderr.write(pc.red(text) + '\n');
  }

  status(text: string): void {
    if (this.sink) { this.sink.status(text); return; }
    process.stdout.write(pc.dim(text) + '\n');
  }

  beginAssistantStream(): void {
    this.streaming = true;
    this.streamBuffer = '';
  }

  // The reply is buffered, not written live — so the styled block can be
  // rendered once at the end with no cursor-up (which would erase the
  // pinned footer). The spinner runs meanwhile.
  streamChunk(text: string): void {
    if (!this.streaming) this.beginAssistantStream();
    this.streamBuffer += text;
  }

  endAssistantStream(): void {
    if (!this.streaming) return;
    this.streaming = false;
    const text = this.streamBuffer;
    this.streamBuffer = '';
    if (text.trim().length === 0) return;
    if (this.sink) { this.sink.assistant(text); return; }
    const rendered = looksLikeMarkdown(text) ? renderMarkdown(text) : text;
    const lines = rendered.split(/\r?\n/);
    let first = true;
    for (const line of lines) {
      if (first) {
        if (line.trim().length === 0) continue;
        process.stdout.write(`${pc.magenta('ac:')} ${line}\n`);
        first = false;
      } else {
        process.stdout.write(`    ${line}\n`);
      }
    }
    process.stdout.write('\n');
  }

  // Render a colored inline unified diff. Truncates extremely long diffs.
  diff(label: string, before: string, after: string): void {
    if (before === after) return;
    if (this.sink) { this.sink.diff(label, before, after); return; }
    const out = renderUnifiedDiff(before, after);
    if (out === '(no textual change)') return;
    process.stdout.write(pc.dim(`  ${label}`) + '\n');
    for (const raw of out.split('\n')) {
      if (raw.startsWith('+ ')) {
        process.stdout.write('  ' + pc.green(raw) + '\n');
      } else if (raw.startsWith('- ')) {
        process.stdout.write('  ' + pc.red(raw) + '\n');
      } else if (raw.startsWith('@@')) {
        process.stdout.write('  ' + pc.cyan(raw) + '\n');
      } else {
        process.stdout.write('  ' + pc.dim(raw) + '\n');
      }
    }
  }
}
