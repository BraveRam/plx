import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GLOBAL_CONFIG_PATH, loadGlobalConfig } from '../src/config.ts';

describe('loadGlobalConfig', () => {
  const tmpDirs: string[] = [];
  const envKeys: string[] = [];

  afterEach(() => {
    for (const k of envKeys.splice(0)) delete process.env[k];
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Write `contents` to a fresh temp `.env` and return its path; tracks the dir for cleanup. */
  function writeTmpEnv(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'plx-cfg-'));
    tmpDirs.push(dir);
    const file = join(dir, '.env');
    writeFileSync(file, contents, 'utf8');
    return file;
  }

  test('missing file → returns [] and sets nothing', () => {
    expect(loadGlobalConfig(join(tmpdir(), 'plx-nope-' + Date.now(), '.env'))).toEqual([]);
  });

  test('loads KEY=value lines; strips quotes; trims; skips comments and blanks', () => {
    const file = writeTmpEnv(
      '# a comment\n\n  PLX_TEST_A = hello world \nPLX_TEST_B="quoted value"\nPLX_TEST_C=\'single\'\n',
    );
    envKeys.push('PLX_TEST_A', 'PLX_TEST_B', 'PLX_TEST_C');
    const applied = loadGlobalConfig(file);
    expect(applied.sort()).toEqual(['PLX_TEST_A', 'PLX_TEST_B', 'PLX_TEST_C']);
    expect(process.env.PLX_TEST_A).toBe('hello world');
    expect(process.env.PLX_TEST_B).toBe('quoted value');
    expect(process.env.PLX_TEST_C).toBe('single');
  });

  test('does NOT override a key already present in the environment', () => {
    process.env.PLX_TEST_X = 'original';
    envKeys.push('PLX_TEST_X');
    const file = writeTmpEnv('PLX_TEST_X=from-file\n');
    expect(loadGlobalConfig(file)).toEqual([]);
    expect(process.env.PLX_TEST_X).toBe('original');
  });

  test('ignores malformed lines (no `=`, empty key, key starting with a digit)', () => {
    const file = writeTmpEnv('not a kv line\n=novalue\n1BAD=x\nPLX_TEST_GOOD=ok\n');
    envKeys.push('PLX_TEST_GOOD');
    expect(loadGlobalConfig(file)).toEqual(['PLX_TEST_GOOD']);
    expect(process.env.PLX_TEST_GOOD).toBe('ok');
  });

  test('GLOBAL_CONFIG_PATH points at plx/.env', () => {
    expect(GLOBAL_CONFIG_PATH).toMatch(/[/\\]plx[/\\]\.env$/);
  });
});
