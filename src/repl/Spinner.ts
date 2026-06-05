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
  private muted = false;
  private readonly enabled: boolean;

  constructor(private readonly stream: NodeJS.WriteStream = process.stderr) {
    // Disable in non-TTY environments (CI, pipes) — animation would spam
    // logs. Also disable under --automax (Automax V6 owns the UI; the
    // \r-overwrite frames corrupt V6's pty reader).
    this.enabled = Boolean(stream.isTTY) && process.env['AUTOCODE_AUTOMAX'] !== '1';
  }

  // Silence the spinner without touching its many call sites. The Ink Bridge
  // UI mutes it while it owns the screen: Bridge renders its own activity
  // indicator (the inline ActivityLine), so this stderr spinner would
  // otherwise bleed a duplicate 'thinking' line — plus a stray \r-erased blank
  // line — below Ink's frame, since inline mode has no alt-screen to hide it.
  mute(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stop(); // erase any frame already on screen
  }

  start(label: string): void {
    this.label = label;
    if (!this.enabled || this.muted) return;
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
    if (!this.enabled || this.muted) return;
    const frame = FRAMES[this.frameIdx]!;
    this.stream.write(`\r${pc.cyan(frame)} ${pc.dim(this.label)}\x1b[K`);
  }
}
