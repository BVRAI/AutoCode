import pc from 'picocolors';
import type { SessionContext } from '../session/SessionContext.js';
import { detectProjectContext, formatContextLine } from '../agent/ProjectContext.js';
import { loadProjectInstructions } from '../agent/ProjectInstructions.js';
import { printBanner } from './Banner.js';
import { Spinner } from './Spinner.js';
import { renderUnifiedDiff } from '../util/diff.js';

export class ConsoleRenderer {
  readonly spinner = new Spinner();

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
    if (instructions) {
      lines.push(
        pc.dim(
          `loaded ${instructions.fileName} (${instructions.bytes} bytes${instructions.truncated ? ', truncated' : ''})`,
        ),
      );
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
