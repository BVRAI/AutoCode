import { describe, it, expect } from 'vitest';
import { validateUrl, isPrivateIp } from '../../src/util/urlGuard.js';

describe('isPrivateIp', () => {
  it('flags RFC1918 private v4', () => {
    expect(isPrivateIp('10.0.0.5')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });
  it('flags loopback v4', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('127.99.0.1')).toBe(true);
  });
  it('flags link-local + metadata v4', () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('169.254.0.1')).toBe(true);
  });
  it('flags 0.0.0.0', () => {
    expect(isPrivateIp('0.0.0.0')).toBe(true);
  });
  it('flags CGNAT', () => {
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('100.127.0.1')).toBe(true);
  });
  it('does NOT flag public v4', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('142.250.190.78')).toBe(false);
    expect(isPrivateIp('172.32.0.1')).toBe(false); // just outside 172.16-31
    expect(isPrivateIp('192.169.0.1')).toBe(false);
  });
  it('flags v6 loopback + link-local + ULA', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd00::1')).toBe(true);
  });
  it('flags v4-mapped v6 if v4 is private', () => {
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });
  it('returns false for non-IP strings', () => {
    expect(isPrivateIp('example.com')).toBe(false);
    expect(isPrivateIp('not-an-ip')).toBe(false);
  });
});

describe('validateUrl', () => {
  it('rejects malformed URLs', async () => {
    const v = await validateUrl('not a url');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/valid URL/);
  });

  it('rejects file:// scheme', async () => {
    const v = await validateUrl('file:///etc/passwd');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/scheme/);
  });

  it('rejects javascript: scheme', async () => {
    const v = await validateUrl('javascript:alert(1)');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/scheme/);
  });

  it('rejects data: scheme', async () => {
    const v = await validateUrl('data:text/plain,hello');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/scheme/);
  });

  it('rejects http by default', async () => {
    const v = await validateUrl('http://example.com');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/scheme/);
  });

  it('allows http when allowHttp is true', async () => {
    const v = await validateUrl('http://example.com', { allowHttp: true });
    expect(v.ok).toBe(true);
  });

  it('rejects AWS metadata IP', async () => {
    const v = await validateUrl('https://169.254.169.254/latest/meta-data/');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/blocklist|private|loopback/i);
  });

  it('rejects localhost by name', async () => {
    const v = await validateUrl('https://localhost:8080/admin');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/blocklist/);
  });

  it('rejects 127.0.0.1 by IP', async () => {
    const v = await validateUrl('https://127.0.0.1/');
    expect(v.ok).toBe(false);
  });

  it('rejects RFC1918 IP literal', async () => {
    const v = await validateUrl('https://10.0.0.1/');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/blocklist|private/i);
  });

  it('rejects .local TLDs', async () => {
    const v = await validateUrl('https://router.local/');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/private suffix/);
  });

  it('rejects .internal TLDs', async () => {
    const v = await validateUrl('https://foo.internal/');
    expect(v.ok).toBe(false);
  });

  it('honors extraAllowedHosts override', async () => {
    const v = await validateUrl('https://localhost:8080/', {
      extraAllowedHosts: ['localhost'],
      blockPrivateIps: false, // would otherwise re-block when DNS resolves
    });
    expect(v.ok).toBe(true);
  });

  it('honors extraBlockedHosts', async () => {
    const v = await validateUrl('https://example.com/', {
      extraBlockedHosts: ['example.com'],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/user blocklist/);
  });

  // Live DNS — skipped by default, opt in via env. Confirms a real public
  // hostname passes when DNS works.
  it.skipIf(!process.env['AUTOCODE_TEST_NET'])('allows public hosts (live DNS)', async () => {
    const v = await validateUrl('https://example.com/');
    expect(v.ok).toBe(true);
  });
});
