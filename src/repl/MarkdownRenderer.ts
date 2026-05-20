import { marked } from 'marked';
// @ts-expect-error — marked-terminal v7 ships types but they don't always line up with marked v15's MarkedExtension shape.
import { markedTerminal } from 'marked-terminal';

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  configured = true;
  marked.use(
    markedTerminal({
      reflowText: false,
      width: process.stdout.columns ? Math.min(process.stdout.columns, 120) : 100,
      showSectionPrefix: false,
      tab: 2,
    }) as Parameters<typeof marked.use>[0],
  );
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
