import { describe, it, expect } from 'vitest';
import { resolveThemeName } from '../../src/repl/ink/theme.js';

describe('resolveThemeName — the host theme hint beats the saved /ui choice', () => {
  it('follows AUTOMAX_THEME when Automax passes one', () => {
    expect(resolveThemeName('light', 'dark')).toBe('light');
    expect(resolveThemeName('DARK', 'light')).toBe('dark');
    expect(resolveThemeName(' light ', undefined)).toBe('light');
  });

  it('falls back to the saved choice, then dark', () => {
    expect(resolveThemeName(undefined, 'light')).toBe('light');
    expect(resolveThemeName('', 'light')).toBe('light');
    expect(resolveThemeName('neon', 'light')).toBe('light');
    expect(resolveThemeName(undefined, undefined)).toBe('dark');
  });
});
