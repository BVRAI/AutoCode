import { marked } from 'marked';
// @ts-expect-error — no bundled types for marked-terminal in some versions.
import TerminalRenderer from 'marked-terminal';

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  configured = true;
  const renderer = new (TerminalRenderer as unknown as new (opts?: unknown) => unknown)({
    reflowText: false,
    width: process.stdout.columns ? Math.min(process.stdout.columns, 120) : 100,
    showSectionPrefix: false,
    tab: 2,
  });
  // marked v15 accepts a Renderer via use(); cast through unknown to keep types loose.
  marked.use({ renderer: renderer as unknown as Parameters<typeof marked.use>[0]['renderer'] });
}

// Render a markdown string into ANSI-formatted terminal text. Safe to call
// on partial content (incomplete lists / code blocks just render as best
// they can). If rendering fails for any reason, returns the input unchanged.
export function renderMarkdown(text: string): string {
  try {
    ensureConfigured();
    const out = marked.parse(text);
    return typeof out === 'string' ? out.replace(/\n+$/, '') : text;
  } catch {
    return text;
  }
}

// Quick heuristic: does this text contain anything worth re-rendering as
// markdown? Saves the cost of re-rendering plain text.
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s/m.test(text) || // headers
    /\*\*[^*]+\*\*/.test(text) || // bold
    /(^|\s)`[^`]+`/.test(text) || // inline code
    /^```/m.test(text) || // code fences
    /^\s*[-*]\s/m.test(text) || // bullets
    /^\s*\d+\.\s/m.test(text) // numbered lists
  );
}
