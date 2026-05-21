import pc from 'picocolors';
import type { SessionContext, AgentMode } from '../session/SessionContext.js';
import { detectProjectContext, formatContextLine } from '../agent/ProjectContext.js';
import { loadProjectInstructions } from '../agent/ProjectInstructions.js';
import { printBanner } from './Banner.js';
import { Spinner } from './Spinner.js';
import { renderUnifiedDiff } from '../util/diff.js';
import { getRepoMap } from '../agent/RepoMap.js';

export class ConsoleRenderer {
  readonly spinner = new Spinner();
  private streaming = false;
  private streamBuffer = '';

  printHeader(ctx: SessionContext): void {
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
      const names = instructions.map((inst) =>
        inst.isAuthoritative ? pc.yellow(`⚠ ${inst.fileName}`) : inst.fileName,
      );
      lines.push(pc.dim(`loaded ${names.join(', ')}`));
    }
    const repoMap = getRepoMap(ctx.projectRoot);
    if (repoMap) {
      const n = repoMap.split('\n').filter((l) => l.length > 0 && !l.startsWith('…')).length;
      lines.push(pc.dim(`repo map: ${n} file${n === 1 ? '' : 's'} indexed`));
    }
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
    process.stdout.write(pc.magenta('ac: '));
  }

  streamChunk(text: string): void {
    if (!this.streaming) {
      this.beginAssistantStream();
    }
    process.stdout.write(text);
    this.streamBuffer += text;
  }

  endAssistantStream(): void {
    if (!this.streaming) return;
    this.streaming = false;
    // Ensure we end on a newline. (The cursor-up markdown re-render is not
    // used under the pinned-bar scroll region — it would erase the footer.)
    if (!this.streamBuffer.endsWith('\n')) {
      process.stdout.write('\n');
    }
    process.stdout.write('\n');
    this.streamBuffer = '';
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
