import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseImageRefs, buildAgentInput } from '../../src/util/imageInput.js';

describe('imageInput', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-img-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads a referenced image into a base64 ImageBlock', () => {
    writeFileSync(join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { images } = parseImageRefs('make it look like @shot.png please', root);
    expect(images).toHaveLength(1);
    expect(images[0]!.mediaType).toBe('image/png');
    expect(images[0]!.data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
  });

  it('records a missing image reference', () => {
    const { images, missing } = parseImageRefs('see @nope.jpg', root);
    expect(images).toHaveLength(0);
    expect(missing).toEqual(['nope.jpg']);
  });

  it('ignores @refs that are not image files', () => {
    const { images } = parseImageRefs('check @src/index.ts', root);
    expect(images).toHaveLength(0);
  });

  it('buildAgentInput returns a plain string when no images', () => {
    const { input } = buildAgentInput('just text', root);
    expect(input).toBe('just text');
  });

  it('buildAgentInput returns text + image blocks when images are present', () => {
    writeFileSync(join(root, 'm.webp'), Buffer.from([1, 2, 3]));
    const { input } = buildAgentInput('build @m.webp', root);
    expect(Array.isArray(input)).toBe(true);
    const blocks = input as Array<{ type: string }>;
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[1]!.type).toBe('image');
  });
});
