import pc from 'picocolors';
import type { SessionContext } from '../session/SessionContext.js';

export class ConsoleRenderer {
  printHeader(ctx: SessionContext): void {
    const lines = [
      pc.bold('autocode'),
      `${pc.dim('Session:')} ${ctx.sessionId}`,
      `${pc.dim('Project:')} ${ctx.projectRoot}`,
      `${pc.dim('Model:  ')} ${ctx.model.provider} / ${ctx.model.model}`,
      '',
      pc.dim('Type /help for commands. Plain text is sent to the agent.'),
      '',
    ];
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
}
