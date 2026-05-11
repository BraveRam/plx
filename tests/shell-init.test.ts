import { describe, test, expect } from 'bun:test';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  asShellKind,
  detectShellKind,
  parseCdCommand,
  shellInitScript,
  SHELL_FILE_ENV,
  SUPPORTED_SHELLS,
} from '../src/shell-init.ts';

describe('parseCdCommand', () => {
  test('bare `cd` → home directory', () => {
    expect(parseCdCommand('cd')).toEqual({ resolved: homedir() });
  });

  test('`cd ~` / `cd "~"` / `cd \'~\'` → home directory', () => {
    expect(parseCdCommand('cd ~')).toEqual({ resolved: homedir() });
    expect(parseCdCommand('cd "~"')).toEqual({ resolved: homedir() });
    expect(parseCdCommand("cd '~'")).toEqual({ resolved: homedir() });
  });

  test('`cd $HOME` / `cd ${HOME}` → home directory', () => {
    expect(parseCdCommand('cd $HOME')).toEqual({ resolved: homedir() });
    expect(parseCdCommand('cd ${HOME}')).toEqual({ resolved: homedir() });
  });

  test('`cd -- <dir>` strips the end-of-options marker', () => {
    expect(parseCdCommand('cd -- /tmp')).toEqual({ resolved: '/tmp' });
  });

  test('absolute path is returned as-is', () => {
    expect(parseCdCommand('cd /var/log')).toEqual({ resolved: '/var/log' });
    expect(parseCdCommand('cd "/var/log"')).toEqual({ resolved: '/var/log' });
  });

  test('`cd ~/projects` resolves under home', () => {
    expect(parseCdCommand('cd ~/projects')).toEqual({ resolved: resolve(homedir(), 'projects') });
  });

  test('relative path resolves against cwd', () => {
    expect(parseCdCommand('cd ../sibling')).toEqual({ resolved: resolve(process.cwd(), '../sibling') });
    expect(parseCdCommand('cd ./child')).toEqual({ resolved: resolve(process.cwd(), './child') });
    expect(parseCdCommand('cd nested/dir')).toEqual({ resolved: resolve(process.cwd(), 'nested/dir') });
  });

  test('`cd -` uses $OLDPWD when set, else null', () => {
    const saved = process.env.OLDPWD;
    process.env.OLDPWD = '/some/old/dir';
    expect(parseCdCommand('cd -')).toEqual({ resolved: '/some/old/dir' });
    delete process.env.OLDPWD;
    expect(parseCdCommand('cd -')).toBeNull();
    if (saved === undefined) delete process.env.OLDPWD;
    else process.env.OLDPWD = saved;
  });

  test('not a `cd` at all → null', () => {
    expect(parseCdCommand('ls -la')).toBeNull();
    expect(parseCdCommand('cdr something')).toBeNull(); // "cdr", not "cd"
    expect(parseCdCommand('echo cd /tmp')).toBeNull();
  });

  test('chained / compound / substituted forms → null (handled by the normal flow)', () => {
    expect(parseCdCommand('cd /tmp && rm -rf foo')).toBeNull();
    expect(parseCdCommand('cd /tmp; ls')).toBeNull();
    expect(parseCdCommand('cd /tmp | cat')).toBeNull();
    expect(parseCdCommand('cd "$(pwd)"')).toBeNull();
    expect(parseCdCommand('cd `pwd`')).toBeNull();
    expect(parseCdCommand('cd /a /b')).toBeNull(); // two args
    expect(parseCdCommand('cd -P /tmp')).toBeNull(); // a flag we don't special-case
    expect(parseCdCommand('cd $SOMEWHERE')).toBeNull(); // non-HOME env var
  });
});

describe('shellInitScript', () => {
  test('bash/zsh wrapper defines a `plx` function and uses the side-channel file + builtin cd', () => {
    for (const kind of ['bash', 'zsh'] as const) {
      const s = shellInitScript(kind);
      expect(s).toContain('plx() {');
      expect(s).toContain(SHELL_FILE_ENV);
      expect(s).toContain('builtin cd');
      expect(s).toContain('command plx "$@"');
      // The "Install:" comment should mention the right rc file and shell.
      expect(s).toContain(`plx --shell-init ${kind}`);
      expect(s).toContain(`~/.${kind}rc`);
      // Placeholder fully substituted.
      expect(s).not.toContain('SHELL_KIND');
    }
  });

  test('fish wrapper defines a `function plx` and uses the side-channel file + builtin cd', () => {
    const s = shellInitScript('fish');
    expect(s).toContain('function plx');
    expect(s).toContain(SHELL_FILE_ENV);
    expect(s).toContain('builtin cd');
    expect(s).toContain('plx --shell-init fish | source');
  });
});

describe('shell kind detection', () => {
  test('asShellKind narrows known shells, rejects others', () => {
    expect(asShellKind('bash')).toBe('bash');
    expect(asShellKind('zsh')).toBe('zsh');
    expect(asShellKind('fish')).toBe('fish');
    expect(asShellKind('dash')).toBeUndefined();
    expect(asShellKind(undefined)).toBeUndefined();
    expect(asShellKind('')).toBeUndefined();
  });

  test('detectShellKind reads $SHELL', () => {
    const saved = process.env.SHELL;
    try {
      process.env.SHELL = '/bin/bash';
      expect(detectShellKind()).toBe('bash');
      process.env.SHELL = '/usr/local/bin/fish';
      expect(detectShellKind()).toBe('fish');
      process.env.SHELL = '/bin/zsh';
      expect(detectShellKind()).toBe('zsh');
      process.env.SHELL = '/bin/dash';
      expect(detectShellKind()).toBeUndefined();
      delete process.env.SHELL;
      expect(detectShellKind()).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.SHELL;
      else process.env.SHELL = saved;
    }
  });

  test('SUPPORTED_SHELLS is exactly bash/zsh/fish', () => {
    expect([...SUPPORTED_SHELLS]).toEqual(['bash', 'zsh', 'fish']);
  });
});
