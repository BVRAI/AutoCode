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
    return pc.cyan('autocode> ');
  }

  info(text: string): void {
    process.stdout.write(text + '\n');
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
