import { readFileSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import type { ImageBlock } from '../llm/types.js';

const IMAGE_MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Find @<path> references to image files in user input, read and
// base64-encode them. The text is returned unchanged — the @path mention
// stays as useful context alongside the attached image.
export function parseImageRefs(
  text: string,
  projectRoot: string,
): { text: string; images: ImageBlock[]; missing: string[] } {
  const images: ImageBlock[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const re = /@(\S+\.(?:png|jpe?g|gif|webp))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const ref = m[1]!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const abs = isAbsolute(ref) ? ref : resolve(projectRoot, ref);
    const media = IMAGE_MEDIA[extname(abs).toLowerCase()];
    if (!media) continue;
    try {
      images.push({ type: 'image', mediaType: media, data: readFileSync(abs).toString('base64') });
    } catch {
      missing.push(ref);
    }
  }
  return { text, images, missing };
}

// Build the submit input: a plain string when there are no images, or a
// content-block array (text + images) when there are.
export function buildAgentInput(text: string, projectRoot: string): {
  input: string | import('../llm/types.js').ContentBlock[];
  missing: string[];
} {
  const { images, missing } = parseImageRefs(text, projectRoot);
  if (images.length === 0) return { input: text, missing };
  return { input: [{ type: 'text', text }, ...images], missing };
}
