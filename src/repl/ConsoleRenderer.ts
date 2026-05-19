import pc from 'picocolors';
import type { SessionContext } from '../session/SessionContext.js';
import { detectProjectContext, formatContextLine } from '../agent/ProjectContext.js';
import { loadProjectInstructions } from '../agent/ProjectInstructions.js';
import { printBanner } from './Banner.js';
import { Spinner } from './Spinner.js';
import { renderUnifiedDiff } from '../util/diff.js';
import { renderMarkdown, looksLikeMarkdown } from './MarkdownRenderer.js';

export class ConsoleRenderer {
  readonly spinner = new Spinner();
  private streaming = false;
  private streamBuffer = '';
  private streamLineCount = 0;
  private readonly canRedraw = Boolean(process.stdout.isTTY);

  printHeader(ctx: SessionContext): void {
    printBanner();
    const project = detectProjectContext(ctx.projectRoot);
    const projLine = formatContextLine(project);
    const instructions = loadProjectInstructions(ctx.projectRoot);

    const lines = [
      `${pc.dim('session:')} ${ctx.sessionId}`,
      `${pc.dim('project:')} ${ctx.projectRoot}${projLine ? ' · ' + pc.cyan(projLine) : ''}`,
      `${pc.dim('model:  ')} ${ctx.model.provider} / ${ctx.model.model}`,
    ];
    if (instructions.length > 0) {
      const names = instructions.map((inst) =>
        inst.isAuthoritative ? pc.yellow(`⚠ ${inst.fileName}`) : inst.fileName,
      );
      lines.push(pc.dim(`loaded ${names.join(', ')}`));
    }
    lines.push('');
    lines.push(pc.dim('Type /help for commands. Plain text is sent to the agent.'));
    lines.push('');
    process.stdout.write(lines.join('\n') + '\n');
  }

  prompt(): string {
    return pc.cyan('=> ');
  }

  info(text: string): void {
    process.stdout.write(text + '\n');
  }

  assistant(text: string): void {
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
    process.stdout.write(pc.dim(text) + '\n');
  }

  warn(text: string): void {
    process.stderr.write(pc.yellow(text) + '\n');
  }

  error(text: string): void {
    process.stderr.write(pc.red(text) + '\n');
  }

  status(text: string): void {
    process.stdout.write(pc.dim(text) + '\n');
  }

  beginAssistantStream(): void {
    this.streaming = true;
    this.streamBuffer = '';
    this.streamLineCount = 0;
    process.stdout.write(pc.magenta('ac: '));
  }

  streamChunk(text: string): void {
    if (!this.streaming) {
      this.beginAssistantStream();
    }
    process.stdout.write(text);
    this.streamBuffer += text;
    // Track lines for the redraw-with-markdown step.
    for (const ch of text) {
      if (ch === '\n') this.streamLineCount += 1;
    }
  }

  endAssistantStream(): void {
    if (!this.streaming) return;
    this.streaming = false;
    // Ensure we end on a newline.
    if (!this.streamBuffer.endsWith('\n')) {
      process.stdout.write('\n');
      this.streamLineCount += 1;
    }
    // Final markdown redraw if it's worth it and we're on a TTY.
    if (this.canRedraw && looksLikeMarkdown(this.streamBuffer)) {
      const rendered = renderMarkdown(this.streamBuffer);
      // Move cursor up over the streamed lines (including the "ac: " line)
      // and erase, then reprint with markdown formatting.
      const linesToErase = this.streamLineCount + 1; // +1 for the partially-filled first line
      process.stdout.write(`\x1b[${linesToErase}A\r\x1b[J`);
      // Reprint with ac: prefix, indenting continuation lines.
      const lines = rendered.split('\n');
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
    }
    process.stdout.write('\n');
    this.streamBuffer = '';
    this.streamLineCount = 0;
  }

  // Render a colored inline unified diff. Truncates extremely long diffs.
  diff(label: string, before: string, after: string): void {
    if (before === after) return;
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
