import { describe, test, expect } from 'bun:test';
import { detectShell, executeCommand } from '../src/execute.ts';

describe('detectShell', () => {
  test('returns a well-formed ShellInfo for this machine', () => {
    const info = detectShell();
    expect(typeof info.path).toBe('string');
    expect(info.path.length).toBeGreaterThan(0);
    expect(typeof info.name).toBe('string');
    expect(info.name.length).toBeGreaterThan(0);
    expect(typeof info.posix).toBe('boolean');
  });
});

describe('executeCommand', () => {
  test('propagates a non-zero exit code instead of throwing', async () => {
    const result = await executeCommand('exit 7');
    expect(result.exitCode).toBe(7);
    expect(result.command).toBe('exit 7');
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('returns exit code 0 for a successful no-op command', async () => {
    const result = await executeCommand("printf ''");
    expect(result.exitCode).toBe(0);
  });

  test('returns a non-zero exit code for `false`', async () => {
    const result = await executeCommand('false');
    expect(result.exitCode).not.toBe(0);
  });

  test('runs `echo` successfully (output goes to inherited stdout)', async () => {
    const result = await executeCommand('echo hi');
    expect(result.exitCode).toBe(0);
  });

  test('runs a command that references $0 without throwing', async () => {
    const result = await executeCommand('echo "$0"');
    expect(result.exitCode).toBe(0);
  });
});
