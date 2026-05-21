import pc from 'picocolors';

// Block-style AUTOCODE wordmark printed on launch. Hand-rolled — no figlet.
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

// Candidate startup wordmarks — previewed via `acv1 --banners` so a style can
// be chosen. Once picked, the winner replaces LINES and this is removed.
export const BANNER_GALLERY: Array<{ id: number; label: string; lines: string[] }> = [
  {
    id: 1,
    label: 'autocode — filled block',
    lines: [
      ' █▀▀█ █  █ ▀█▀ █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀',
      ' █▄▄█ █  █  █  █  █ █    █  █ █  █ █▀▀ ',
      ' █  █ ▀▄▄▀  █  ▀▄▄▀ ▀▄▄█ ▀▄▄▀ █▄▄▀ █▄▄▄',
    ],
  },
  {
    id: 2,
    label: 'autocode — compact 2-row',
    lines: [
      ' ▄▀█ █░█ ▀█▀ █▀█ █▀▀ █▀█ █▀▄ █▀▀',
      ' █▀█ █▄█ ░█░ █▄█ █▄▄ █▄█ █▄▀ ██▄',
    ],
  },
  {
    id: 3,
    label: 'autocode — single-line box',
    lines: [
      '┌─────────────────────┐',
      '│   a u t o c o d e   │',
      '└─────────────────────┘',
    ],
  },
  {
    id: 4,
    label: 'autocode — double-line box',
    lines: [
      '╔══════════════════════╗',
      '║     ‹ autocode ›     ║',
      '╚══════════════════════╝',
    ],
  },
  {
    id: 5,
    label: 'autocode — minimalist',
    lines: ['  a u t o c o d e', '  ─────────────────'],
  },
  {
    id: 6,
    label: 'ACV1 — compact 2-row',
    lines: [' ▄▀█ █▀▀ █░█ ▄█', ' █▀█ █▄▄ ▀▄▀ ░█'],
  },
  {
    id: 7,
    label: 'ACV1 — filled block',
    lines: [
      ' █▀█ █▀▀ █░█ ▄█▄',
      ' █▀█ █░░ ▀▄▀ ░█░',
      ' ▀░▀ ▀▀▀ ░▀░ ▄█▄',
    ],
  },
  {
    id: 8,
    label: 'ACV1 — letter tiles',
    lines: ['┌──┐┌──┐┌──┐┌──┐', '│ A││ C││ V││ 1│', '└──┘└──┘└──┘└──┘'],
  },
  {
    id: 9,
    label: 'ACV1 — heavy frame',
    lines: ['▛▀▀▀▀▀▀▀▀▀▀▀▜', '▌  A C V 1  ▐', '▙▄▄▄▄▄▄▄▄▄▄▄▟'],
  },
  {
    id: 10,
    label: 'ACV1 — minimalist',
    lines: ['  A C V 1', '  ▪ ▪ ▪ ▪ ▪ ▪'],
  },
];

// Fixed height of the banner block (blank · 3 art rows · tagline · blank) so
// the rotating banner never shifts the layout below it.
export const BANNER_BLOCK_HEIGHT = 6;

// The 6-row block for a gallery entry — art padded to 3 rows, coloured,
// with the tagline. Used by the launch-banner rotation.
export function bannerBlock(entry: { lines: string[] }): string[] {
  const art = [...entry.lines];
  while (art.length < 3) art.push('');
  return ['', ...art.slice(0, 3).map((l) => pc.cyan(l)), pc.dim(TAGLINE), ''];
}

export function printBannerGallery(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write('\n' + pc.dim('autocode — startup banner options:') + '\n\n');
  for (const b of BANNER_GALLERY) {
    const header = `── ${b.id} ── ${b.label} `;
    stream.write(pc.dim(header + '─'.repeat(Math.max(0, 48 - header.length))) + '\n');
    for (const line of b.lines) stream.write(pc.cyan(line) + '\n');
    stream.write('\n');
  }
  stream.write(pc.dim('Tell autocode which number (1–10) you want as the launch banner.') + '\n\n');
}
