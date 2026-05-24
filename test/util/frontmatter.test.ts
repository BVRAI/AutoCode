import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../../src/util/frontmatter.js';

describe('parseFrontmatter', () => {
  it('returns no frontmatter for plain content', () => {
    const r = parseFrontmatter('just markdown\nbody');
    expect(r.hasFrontmatter).toBe(false);
    expect(r.meta).toEqual({});
    expect(r.body).toBe('just markdown\nbody');
  });

  it('parses key/value pairs and strips them from the body', () => {
    const r = parseFrontmatter('---\nname: x\nverify: npm test\n---\n\n# Body\nstuff');
    expect(r.hasFrontmatter).toBe(true);
    expect(r.meta).toEqual({ name: 'x', verify: 'npm test' });
    expect(r.body).toBe('# Body\nstuff');
  });

  it('lowercases keys', () => {
    const r = parseFrontmatter('---\nVerify: pytest\n---\nbody');
    expect(r.meta.verify).toBe('pytest');
  });

  it('strips surrounding double or single quotes', () => {
    const r = parseFrontmatter('---\na: "quoted"\nb: \'also\'\n---\nbody');
    expect(r.meta).toEqual({ a: 'quoted', b: 'also' });
  });

  it('ignores lines without colons', () => {
    const r = parseFrontmatter('---\nname: x\nlooks like a comment\nverify: cmd\n---\nbody');
    expect(r.meta).toEqual({ name: 'x', verify: 'cmd' });
  });

  it('treats unclosed frontmatter as no frontmatter', () => {
    const r = parseFrontmatter('---\nname: x\nbody without close');
    expect(r.hasFrontmatter).toBe(false);
    expect(r.body).toContain('---');
  });

  it('handles an empty frontmatter block', () => {
    const r = parseFrontmatter('---\n---\nbody');
    expect(r.hasFrontmatter).toBe(true);
    expect(r.meta).toEqual({});
    expect(r.body).toBe('body');
  });
});
