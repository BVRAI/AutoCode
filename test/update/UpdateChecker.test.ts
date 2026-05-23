import { describe, it, expect } from 'vitest';
import { compareVersions, shouldAutoUpdate, shouldNotify } from '../../src/update/UpdateChecker.js';

describe('compareVersions', () => {
  it('orders by major then minor then patch', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
  });

  it('treats a release as higher than its prerelease', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('0.2.0', '0.2.0-dev')).toBeGreaterThan(0);
  });

  it('tolerates a leading v and short versions', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });
});

describe('shouldNotify', () => {
  const base = { bundled: false, headless: false };

  it('notifies when latest is newer than current', () => {
    expect(shouldNotify('0.1.0', '0.2.0', base)).toBe(true);
  });

  it('does not notify on equal versions', () => {
    expect(shouldNotify('0.2.0', '0.2.0', base)).toBe(false);
  });

  it('does not notify when latest is older', () => {
    expect(shouldNotify('0.2.0', '0.1.9', base)).toBe(false);
  });

  it('does not notify when latest is null (no cached info yet)', () => {
    expect(shouldNotify('0.1.0', null, base)).toBe(false);
  });

  it('suppresses notification for the V6-bundled copy', () => {
    expect(shouldNotify('0.1.0', '0.2.0', { ...base, bundled: true })).toBe(false);
  });

  it('suppresses notification in headless mode', () => {
    expect(shouldNotify('0.1.0', '0.2.0', { ...base, headless: true })).toBe(false);
  });
});

describe('shouldAutoUpdate', () => {
  const base = {
    bundled: false,
    headless: false,
    currentVersion: '0.1.0',
    optedOutByConfig: false,
    optedOutByEnv: false,
  };

  it('is on by default (opt-out) in a standard interactive launch', () => {
    expect(shouldAutoUpdate(base)).toBe(true);
  });

  it('is off when the user opts out via config.json', () => {
    expect(shouldAutoUpdate({ ...base, optedOutByConfig: true })).toBe(false);
  });

  it('is off when AUTOCODE_NO_UPDATE=1 is set', () => {
    expect(shouldAutoUpdate({ ...base, optedOutByEnv: true })).toBe(false);
  });

  it('is off for the V6-bundled copy (Velopack owns updates)', () => {
    expect(shouldAutoUpdate({ ...base, bundled: true })).toBe(false);
  });

  it('is off in headless mode so scripted runs are not surprised', () => {
    expect(shouldAutoUpdate({ ...base, headless: true })).toBe(false);
  });

  it('is off on a prerelease (user is on a deliberate testing track)', () => {
    expect(shouldAutoUpdate({ ...base, currentVersion: '0.2.0-rc.1' })).toBe(false);
    expect(shouldAutoUpdate({ ...base, currentVersion: '0.1.0-dev' })).toBe(false);
  });
});
