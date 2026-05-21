// Terminal screen manager for the pinned bottom bar.
//
// Uses a DECSTBM scroll region (`ESC[top;bottomr`) to confine all normal
// output to the top rows; the bottom `footerHeight` rows are frozen and hold
// the input bar. Output written with the cursor in the top region scrolls
// only there — the bar is never trampled and is redrawn only when its own
// content changes.
//
// Cursor discipline (one DEC save-slot, ESC7/ESC8):
//   - saveOutputCursor()  — ESC7, called once when a turn ends (and after the
//     header) to remember where output left off.
//   - restoreOutputCursor() — ESC8, called when a turn starts.
//   - idle footer redraws never touch ESC7/ESC8 (nothing is streaming), so the
//     saved output cursor survives across keystrokes.
//   - busy footer redraws save/restore transiently around themselves.

const ESC = '\x1b';

export class Screen {
  private readonly out = process.stdout;
  private footerHeight = 0;
  private active = false;
  onResize?: () => void;

  get isTty(): boolean {
    return Boolean(this.out.isTTY);
  }
  get rows(): number {
    return this.out.rows || 24;
  }
  get columns(): number {
    return this.out.columns || 80;
  }
  // Number of rows available for scrolling output.
  get outputRows(): number {
    return Math.max(1, this.rows - this.footerHeight);
  }
  // 1-indexed absolute row of the first footer line.
  get footerTop(): number {
    return this.outputRows + 1;
  }

  enter(footerHeight: number): void {
    if (!this.isTty) return;
    this.footerHeight = footerHeight;
    this.active = true;
    this.installRegion();
    this.out.on('resize', this.handleResize);
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.out.off('resize', this.handleResize);
    // Reset the scroll region and drop the cursor below the footer so the
    // shell prompt lands on a clean line.
    this.out.write(`${ESC}[r`);
    this.out.write(`${ESC}[${this.rows};1H\n`);
  }

  private handleResize = (): void => {
    if (!this.active) return;
    this.installRegion();
    this.onResize?.();
  };

  // Re-install the region when the input box grows/shrinks. Setting DECSTBM
  // homes the cursor; callers redraw the footer (and restore the output
  // cursor at turn start), so the transient home is harmless.
  setFooterHeight(height: number): void {
    if (!this.active || height === this.footerHeight) return;
    this.footerHeight = height;
    this.installRegion();
  }

  private installRegion(): void {
    const bottom = Math.max(1, this.rows - this.footerHeight);
    this.out.write(`${ESC}[1;${bottom}r`);
  }

  saveOutputCursor(): void {
    if (this.active) this.out.write(`${ESC}7`);
  }

  restoreOutputCursor(): void {
    if (this.active) this.out.write(`${ESC}8`);
  }

  // Move the cursor to (1-indexed) row `rowInFooter`, column `col` within the
  // footer block.
  moveInFooter(rowInFooter: number, col = 1): void {
    this.out.write(`${ESC}[${this.footerTop + rowInFooter - 1};${col}H`);
  }

  // Clear from the cursor to the end of the current line.
  clearLine(): void {
    this.out.write(`${ESC}[2K`);
  }

  write(s: string): void {
    this.out.write(s);
  }
}
