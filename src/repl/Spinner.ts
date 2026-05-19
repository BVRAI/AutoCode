import pc from 'picocolors';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;

// Minimal braille-dot spinner. Writes to stderr so it does not interleave
// with assistant output to stdout. Carriage-return overwrites the line.
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frameIdx = 0;
  private label = '';
  private active = false;
  private readonly enabled: boolean;

  constructor(private readonly stream: NodeJS.WriteStream = process.stderr) {
    // Disable in non-TTY environments (CI, pipes) — animation would spam logs.
    this.enabled = Boolean(stream.isTTY);
  }

  start(label: string): void {
    this.label = label;
    if (!this.enabled) return;
    if (this.active) {
      this.render();
      return;
    }
    this.active = true;
    this.frameIdx = 0;
    this.render();
    this.timer = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % FRAMES.length;
      this.render();
    }, FRAME_MS);
  }

  update(label: string): void {
    this.label = label;
    if (this.active) this.render();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.enabled) {
      // Erase the line and return cursor to col 0.
      this.stream.write('\r\x1b[2K');
    }
  }

  private render(): void {
    if (!this.enabled) return;
    const frame = FRAMES[this.frameIdx]!;
    this.stream.write(`\r${pc.cyan(frame)} ${pc.dim(this.label)}\x1b[K`);
  }
}
