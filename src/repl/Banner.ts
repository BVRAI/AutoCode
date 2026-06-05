import pc from 'picocolors';

// ─────────────────────────────────────────────────────────────────────────
// Startup wordmark for autocode — the "ANSI Shadow" face, painted with a
// teal→violet gradient (teal = primary accent, violet = the assistant).
//
// One static banner. The old rotating gallery (BANNER_GALLERY / bannerBlock /
// printBannerGallery / --banners) was retired — there is a single launch
// banner now, shown in the inline TUI welcome and the plain console header.
//
// Two render paths share this art:
//   - Ink (inline TUI) builds per-column gradient runs natively via
//     gradientSegments() and feeds each to <Text color=…> — no raw ANSI,
//     because Ink's <Static> can't be trusted to pass embedded escapes
//     through. The gradient there is theme-aware (accent → agent), so it
//     adapts to dark/light.
//   - The plain console path (printBanner) writes 24-bit ANSI straight to the
//     stream with a fixed teal→violet ramp; it never goes through Ink.
// ─────────────────────────────────────────────────────────────────────────

export type RGB = [number, number, number];

// Big face — used when the terminal is wide enough (≥ 69 cols). Each row is a
// fixed 68-cell block, internally rectangular per letter, so it never bends on
// a character grid.
export const WORDMARK: string[] = [
  ' █████╗ ██╗   ██╗████████╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '███████║██║   ██║   ██║   ██║   ██║██║     ██║   ██║██║  ██║█████╗  ',
  '██╔══██║██║   ██║   ██║   ██║   ██║██║     ██║   ██║██║  ██║██╔══╝  ',
  '██║  ██║╚██████╔╝   ██║   ╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗',
  '╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
];

// Compact face — automatic fallback for narrow terminals (< 69 cols).
export const WORDMARK_COMPACT: string[] = [
  ' ▄▀█ █░█ ▀█▀ █▀█ █▀▀ █▀█ █▀▄ █▀▀',
  ' █▀█ █▄█ ░█░ █▄█ █▄▄ █▄█ █▄▀ ██▄',
];

export const TAGLINE = 'agentic coding, resident in your terminal';

// Fixed gradient endpoints for the plain console path (no theme there).
// Teal #3dd9c4 → violet #c98ce0 (the dark palette's accent → agent).
const TEAL: RGB = [0x3d, 0xd9, 0xc4];
const VIOLET: RGB = [0xc9, 0x8c, 0xe0];

const RESET = '\x1b[0m';

export function hexToRgb(hex: string): RGB {
  const h = hex.replace(/^#/, '');
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function rgbToHex([r, g, b]: RGB): string {
  const h = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function fg([r, g, b]: RGB): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

// A painted run of an art row: a chunk of glyphs sharing one color, or a chunk
// of bare spaces (color undefined). Consecutive same-color cells merge so Ink
// renders a handful of <Text> nodes per row instead of one per cell.
export interface Segment {
  text: string;
  color?: string;
}

// Split one art row into colored runs along a horizontal gradient. Column i
// maps to t = i/(width-1); spaces stay uncolored (no point colouring blanks).
export function gradientSegments(row: string, width: number, from: RGB, to: RGB): Segment[] {
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  const flush = (): void => {
    if (cur) {
      segs.push(cur);
      cur = null;
    }
  };
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (ch === ' ') {
      if (cur && cur.color === undefined) cur.text += ' ';
      else {
        flush();
        cur = { text: ' ' };
      }
      continue;
    }
    const t = width > 1 ? i / (width - 1) : 0;
    const color = rgbToHex(mix(from, to, t));
    if (cur && cur.color === color) cur.text += ch;
    else {
      flush();
      cur = { text: ch, color };
    }
  }
  flush();
  return segs;
}

// picocolors' own enable rule: honour NO_COLOR / FORCE_COLOR, else only a TTY.
function colorOn(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream.isTTY);
}

// Paint one art row with raw 24-bit ANSI (console path only). Spaces stay bare
// to keep the escape stream small.
function paintRow(row: string, width: number): string {
  let out = '';
  let last = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (ch === ' ') {
      out += ' ';
      continue;
    }
    const t = width > 1 ? i / (width - 1) : 0;
    const code = fg(mix(TEAL, VIOLET, t));
    out += (code === last ? '' : code) + ch;
    last = code;
  }
  return out + RESET;
}

// Plain-console launch banner — writes straight to the stream (NOT through
// Ink), so raw truecolor ANSI is fine. Used by ConsoleRenderer.printHeader()
// on the non-TTY / plain path; the session/project/model lines compose under
// it. Falls back to a clean monochrome wordmark when color is suppressed.
export function printBanner(stream: NodeJS.WriteStream = process.stdout): void {
  const cols = stream.columns ?? 80;
  const art = cols >= WORDMARK[0]!.length + 1 ? WORDMARK : WORDMARK_COMPACT;
  const width = art[0]!.length;
  const color = colorOn(stream);

  stream.write('\n');
  for (const row of art) {
    stream.write((color ? paintRow(row, width) : row) + '\n');
  }
  stream.write('\n' + pc.dim(TAGLINE) + '\n\n');
}
