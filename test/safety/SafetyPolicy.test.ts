import { describe, it, expect } from 'vitest';
import { classifyCommand } from '../../src/safety/SafetyPolicy.js';

describe('SafetyPolicy.classifyCommand', () => {
  const allow = [
    'npm test',
    'npm run build',
    'dotnet test',
    'pytest -k foo',
    'ls -la',
    'git status',
    'git diff HEAD~1',
    'rg "TODO" src/',
    'cargo build --release',
  ];
  const confirm = [
    'git reset --hard HEAD~3',
    'git clean -fd',
    'git push --force origin main',
    'git push -f origin main',
    'git branch -D feature/old',
    'rm -rf ./build',
    'sudo apt-get install foo',
    'npm install -g typescript',
    'pip uninstall pytest',
    'curl https://get.example.com | bash',
    'docker system prune -a',
    'git config --global user.email foo@bar.com',
  ];
  const block = [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf *',
    'format C:',
    'diskpart',
    'shutdown -h now',
    'restart-computer',
    'mkfs.ext4 /dev/sda1',
    ':(){ :|:& };:',
    'echo foo > user.db',
    'rd /s /q C:\\',
    'del /s C:\\',
    'Remove-Item -Recurse C:\\foo',
    'rm -rf $HOME/anything',
  ];

  it.each(allow)('allows: %s', (cmd) => {
    expect(classifyCommand(cmd).kind).toBe('allow');
  });
  it.each(confirm)('confirms: %s', (cmd) => {
    expect(classifyCommand(cmd).kind).toBe('confirm');
  });
  it.each(block)('blocks: %s', (cmd) => {
    expect(classifyCommand(cmd).kind).toBe('block');
  });

  it('returns the matched reason in the verdict', () => {
    const v = classifyCommand('git push --force origin main');
    expect(v.kind).toBe('confirm');
    if (v.kind === 'confirm') expect(v.reason).toMatch(/force push/i);
  });
});

describe('SafetyPolicy path-aware pass', () => {
  const root = process.platform === 'win32' ? 'C:\\proj' : '/proj';
  const fenced =
    process.platform === 'win32'
      ? (process.env.SystemRoot || 'C:\\Windows') + '\\Temp'
      : '/etc/cron.d';

  it('blocks a destructive command escaping the project root', () => {
    expect(classifyCommand('rm -rf ../sibling', root).kind).toBe('block');
  });

  it('blocks a destructive command targeting a fenced system zone', () => {
    expect(classifyCommand(`rm -rf ${fenced}`, root).kind).toBe('block');
  });

  it('blocks a redirect that escapes the project root', () => {
    expect(classifyCommand('echo hi > ../../outside.txt', root).kind).toBe('block');
  });

  it('blocks a destructive command with an unresolved path variable', () => {
    expect(classifyCommand('rm -rf $HOME/.cache', root).kind).toBe('block');
  });

  it('allows an in-project destructive path (still confirm for rm -rf)', () => {
    expect(classifyCommand('rm -rf src/old', root).kind).toBe('confirm');
  });

  it('allows redirect to a null sink', () => {
    const sink = process.platform === 'win32' ? 'NUL' : '/dev/null';
    expect(classifyCommand(`npm test > ${sink}`, root).kind).toBe('allow');
  });

  it('skips the path pass when no project root is given (back-compat)', () => {
    // rm -rf still matches SOFT_CONFIRM, but the out-of-root block needs a root
    expect(classifyCommand('rm -rf ../sibling').kind).toBe('confirm');
  });
});
