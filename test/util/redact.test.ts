import { describe, expect, it } from 'vitest';
import { redactDeep, redactSecrets } from '../../src/util/redact.js';

describe('redactSecrets', () => {
  it('masks vendor key shapes and keeps a 4-char prefix', () => {
    const s = redactSecrets('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and xai-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234');
    expect(s).toBe('key sk-a…[redacted] and xai-…[redacted]');
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('AKIA…[redacted]');
    expect(redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('ghp_…[redacted]');
    expect(redactSecrets('AIzaSyA-abcdefghijklmnopqrstuvwxyz0123456')).toBe('AIza…[redacted]');
  });

  it('masks bearer tokens and JWTs', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz.0123456789')).toBe('Authorization: Bearer abcd…[redacted]');
    const jwt = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMzQ1Njc4OTAifQ.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactSecrets(`token ${jwt}`)).toBe('token eyJh…[redacted]');
  });

  it('masks assignments to secret-like names but leaves paths, urls and flags alone', () => {
    expect(redactSecrets('OPENAI_API_KEY=abcdefghijklmnop123456')).toBe('OPENAI_API_KEY=abcd…[redacted]');
    expect(redactSecrets('"password": "hunter2hunter2hunter2"')).toBe('"password": "hunt…[redacted]"');
    expect(redactSecrets('api_key: ${OPENAI_API_KEY}')).toBe('api_key: ${OPENAI_API_KEY}');
    expect(redactSecrets('token=process.env.MY_TOKEN')).toBe('token=process.env.MY_TOKEN');
    expect(redactSecrets('secret_path=C:\\Users\\me\\secrets.json')).toBe('secret_path=C:\\Users\\me\\secrets.json');
    expect(redactSecrets('token_url=https://example.com/oauth/token')).toBe('token_url=https://example.com/oauth/token');
    expect(redactSecrets('password=null')).toBe('password=null');
  });

  it('returns ordinary text unchanged', () => {
    const text = 'Updated src/app.ts with 3 additions and 1 removal. Run npm test to verify; token budget 8k.';
    expect(redactSecrets(text)).toBe(text);
    expect(redactSecrets('')).toBe('');
  });

  it('keeps a serialized JSON line valid', () => {
    const line = JSON.stringify({ tool: 'run_shell', arguments: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" https://api.example.com' }, summary: 'exit 0' });
    const red = redactSecrets(line);
    expect(() => JSON.parse(red)).not.toThrow();
    expect(red).toContain('Bearer abcd…[redacted]');
    expect(red).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
  });

  it('walks objects and arrays', () => {
    const v = redactDeep({ a: ['xai-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234'], b: { c: 'plain', d: 5 } });
    expect(v).toEqual({ a: ['xai-…[redacted]'], b: { c: 'plain', d: 5 } });
  });
});
