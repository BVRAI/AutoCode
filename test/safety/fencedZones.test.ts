import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isFenced, fencedReason } from '../../src/safety/fencedZones.js';

describe('fencedZones', () => {
  it('fences the ~/.ssh credential directory', () => {
    expect(isFenced(join(homedir(), '.ssh', 'id_rsa'))).toBe(true);
  });

  it('fences autocode\'s own ~/.autocode config dir', () => {
    expect(isFenced(join(homedir(), '.autocode', 'config.json'))).toBe(true);
  });

  it('does not fence an ordinary project path', () => {
    expect(isFenced(join(homedir(), 'projects', 'mysite', 'index.html'))).toBe(false);
  });

  it('fences platform system directories', () => {
    if (process.platform === 'win32') {
      expect(isFenced(join(process.env.SystemRoot || 'C:\\Windows', 'System32'))).toBe(true);
      expect(isFenced('C:\\Program Files\\SomeApp')).toBe(true);
    } else {
      expect(isFenced('/etc/passwd')).toBe(true);
      expect(isFenced('/usr/bin/node')).toBe(true);
    }
  });

  it('does not fence the filesystem/drive root itself (projects live there)', () => {
    const root = process.platform === 'win32' ? 'C:\\Projects' : '/projects';
    expect(isFenced(root)).toBe(false);
  });

  it('fencedReason returns the matched prefix or null', () => {
    expect(fencedReason(join(homedir(), '.ssh', 'known_hosts'))).toContain('.ssh');
    expect(fencedReason(join(homedir(), 'code', 'app.ts'))).toBeNull();
  });
});
