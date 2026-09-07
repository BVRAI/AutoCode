// Attachments — what `@path` mentions in a prompt turn into.
//
//   @src/app.ts        text file → inlined as a <file> block after the prompt
//   @src/              directory → a one-level listing
//   @shot.png          image → an image block (png/jpg/gif/webp)
//   @spec.pdf          PDF → a document block on providers that take one
//   @renderDiff        a definition the code index knows → its source in a
//                      <symbol> block (`@path#name` pins one of several)
//
// The mention itself stays in the prompt text (it is useful context: the
// model sees which file the user pointed at). Caps keep a stray mention of a
// huge file from flooding the context. Everything here is synchronous and
// never throws — unreadable paths are reported in `missing`.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import type { ContentBlock, DocumentBlock, ImageBlock } from '../llm/types.js';
import type { CodeIndex } from '../index/CodeIndex.js';
import { peekIndex } from '../index/IndexManager.js';
import { resolveSymbolMention } from './symbolMentions.js';

const IMAGE_MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Providers whose request shape has a document/file part. */
const DOCUMENT_PROVIDERS = new Set(['anthropic', 'openai', 'google']);

export const MAX_TEXT_BYTES = 200 * 1024;
export const MAX_TEXT_LINES = 5_000;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_BYTES = 32 * 1024 * 1024;
export const MAX_DIR_ENTRIES = 200;

export interface AttachmentResult {
  /** The prompt as the agent receives it: a string, or text + attached blocks. */
  input: string | ContentBlock[];
  /** Mentions that could not be read. */
  missing: string[];
  /** Human-readable notes about what was attached or skipped (shown dim). */
  notes: string[];
}

/** `@path` mentions: a run of non-space characters after `@`, trailing punctuation dropped. */
export function findMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s(])@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const ref = m[1]!.replace(/[,.;:!?)\]]+$/, '');
    if (ref.length === 0 || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

export function buildAgentInput(text: string, projectRoot: string, opts: { provider?: string; index?: CodeIndex } = {}): AttachmentResult {
  const missing: string[] = [];
  const notes: string[] = [];
  const inlined: string[] = [];
  const blocks: ContentBlock[] = [];
  let images = 0;

  for (const ref of findMentions(text)) {
    const abs = isAbsolute(ref) ? ref : resolve(projectRoot, ref);
    const shown = displayPath(abs, projectRoot);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      // Not a path: a symbol the code index knows ("@render", "@src/app.ts#App")?
      const index = opts.index ?? peekIndex(projectRoot);
      const sym = index ? resolveSymbolMention(index, ref) : null;
      if (sym) {
        inlined.push(sym.block);
        notes.push(sym.note);
      } else {
        missing.push(ref);
      }
      continue;
    }
    if (st.isDirectory()) {
      inlined.push(directoryListing(abs, shown));
      continue;
    }
    const ext = extname(abs).toLowerCase();
    const media = IMAGE_MEDIA[ext];
    if (media) {
      if (st.size > MAX_IMAGE_BYTES) {
        notes.push(`${shown}: image over ${formatBytes(MAX_IMAGE_BYTES)}, skipped`);
        continue;
      }
      try {
        const block: ImageBlock = { type: 'image', mediaType: media, data: readFileSync(abs).toString('base64') };
        blocks.push(block);
        images += 1;
      } catch {
        missing.push(ref);
      }
      continue;
    }
    if (ext === '.pdf') {
      if (opts.provider && !DOCUMENT_PROVIDERS.has(opts.provider)) {
        notes.push(`${shown}: PDF attachments are not supported on ${opts.provider}, skipped`);
        continue;
      }
      if (st.size > MAX_PDF_BYTES) {
        notes.push(`${shown}: PDF over ${formatBytes(MAX_PDF_BYTES)}, skipped`);
        continue;
      }
      try {
        const block: DocumentBlock = {
          type: 'document',
          mediaType: 'application/pdf',
          data: readFileSync(abs).toString('base64'),
          name: basename(abs),
        };
        blocks.push(block);
        notes.push(`${shown}: attached (${formatBytes(st.size)})`);
      } catch {
        missing.push(ref);
      }
      continue;
    }
    // Anything else is treated as text.
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      missing.push(ref);
      continue;
    }
    if (looksBinary(buf)) {
      notes.push(`${shown}: binary file, skipped`);
      continue;
    }
    inlined.push(textBlock(buf, shown, notes));
  }

  const promptText = inlined.length > 0 ? `${text}\n\n${inlined.join('\n\n')}` : text;
  if (blocks.length === 0) return { input: promptText, missing, notes };
  if (images > 0) notes.push(`${images} image${images === 1 ? '' : 's'} attached`);
  return { input: [{ type: 'text', text: promptText }, ...blocks], missing, notes };
}

function textBlock(buf: Buffer, shown: string, notes: string[]): string {
  let text = buf.toString('utf8');
  let truncated = false;
  if (buf.length > MAX_TEXT_BYTES) {
    text = text.slice(0, MAX_TEXT_BYTES);
    truncated = true;
  }
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_TEXT_LINES) {
    text = lines.slice(0, MAX_TEXT_LINES).join('\n');
    truncated = true;
  }
  if (truncated) notes.push(`${shown}: truncated to ${MAX_TEXT_LINES} lines / ${formatBytes(MAX_TEXT_BYTES)}`);
  const marker = truncated ? '\n… (truncated)' : '';
  return `<file path="${shown}">\n${text.replace(/\s+$/, '')}${marker}\n</file>`;
}

function directoryListing(abs: string, shown: string): string {
  let entries: string[];
  try {
    entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch {
    return `<directory path="${shown}">\n(unreadable)\n</directory>`;
  }
  const more = entries.length > MAX_DIR_ENTRIES ? `\n… +${entries.length - MAX_DIR_ENTRIES} more` : '';
  return `<directory path="${shown}">\n${entries.slice(0, MAX_DIR_ENTRIES).join('\n')}${more}\n</directory>`;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function displayPath(abs: string, projectRoot: string): string {
  const rel = relative(projectRoot, abs);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : abs.replace(/\\/g, '/');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n / (1024 * 1024))} MB`;
}
