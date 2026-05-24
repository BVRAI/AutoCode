// Minimal YAML-ish frontmatter parser shared by AUTOCODE.md (per-subdir
// directives like `verify:`) and skill files. Deliberately tiny — single
// scalar values per key, no nesting, no arrays. Unknown keys are kept in
// `meta` so callers can decide what to honour.

export interface FrontmatterResult {
  /** Map of key → raw string value (lowercased keys, surrounding quotes
   *  stripped). Empty when there's no frontmatter at all. */
  meta: Record<string, string>;
  /** The file content with the frontmatter block removed (trimmed). */
  body: string;
  /** True if a `---`-delimited frontmatter block was present (even if empty). */
  hasFrontmatter: boolean;
}

/** Parse optional `---`-delimited frontmatter at the top of a file. Files
 *  without frontmatter pass through unchanged (`hasFrontmatter: false`,
 *  `meta: {}`, `body` = full input). */
export function parseFrontmatter(content: string): FrontmatterResult {
  if (!content.startsWith('---')) {
    return { meta: {}, body: content, hasFrontmatter: false };
  }
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { meta: {}, body: content, hasFrontmatter: false };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) {
    // Opener but no closer — treat as no frontmatter (don't eat the file).
    return { meta: {}, body: content, hasFrontmatter: false };
  }

  const meta: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && value) meta[key] = value;
  }
  const body = lines.slice(endIdx + 1).join('\n').trim();
  return { meta, body, hasFrontmatter: true };
}
