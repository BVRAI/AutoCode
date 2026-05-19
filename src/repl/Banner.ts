import pc from 'picocolors';

// Block-style AUTOCODE wordmark. Hand-rolled — no figlet dependency.
const LINES: string[] = [
  ' █▀▀█ █  █ ▀█▀ █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀',
  ' █▄▄█ █  █  █  █  █ █    █  █ █  █ █▀▀ ',
  ' █  █ ▀▄▄▀  █  ▀▄▄▀ ▀▄▄█ ▀▄▄▀ █▄▄▀ █▄▄▄',
];

const TAGLINE = '   agentic coding cli · github.com/gregpalin/autocode';

export function printBanner(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write('\n');
  for (const line of LINES) {
    stream.write(pc.cyan(line) + '\n');
  }
  stream.write(pc.dim(TAGLINE) + '\n');
  stream.write('\n');
}
