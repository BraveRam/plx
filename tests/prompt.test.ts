import { describe, test, expect } from 'bun:test';
import { safeText, withSpinner } from '../src/prompt.ts';

// Under `bun test`, stderr is not a TTY, so withSpinner is effectively a plain
// `await work()` — these tests cover that pass-through contract (value, error,
// single invocation). The animation itself is only exercised on a real terminal.
describe('withSpinner', () => {
  test('resolves to the value returned by work()', async () => {
    expect(await withSpinner('x', async () => 42)).toBe(42);
    expect(await withSpinner('x', async () => 'hello')).toBe('hello');
  });

  test('propagates a rejection from work()', async () => {
    await expect(
      withSpinner('x', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  test('invokes work() exactly once', async () => {
    let calls = 0;
    await withSpinner('x', async () => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });
});

describe('safeText', () => {
  test('leaves printable text untouched', () => {
    expect(safeText('rm -rf ./build && echo "done" | cat')).toBe('rm -rf ./build && echo "done" | cat');
    expect(safeText('')).toBe('');
    expect(safeText('café — naïve ✓')).toBe('café — naïve ✓');
  });

  test('passes tab and newline through (legitimate in here-docs / multi-line commands)', () => {
    expect(safeText('a\tb')).toBe('a\tb');
    expect(safeText('line1\nline2')).toBe('line1\nline2');
    expect(safeText("cat > f <<'EOF'\nhi\nEOF")).toBe("cat > f <<'EOF'\nhi\nEOF");
  });

  test('renders the dangerous C0 control chars in caret notation', () => {
    expect(safeText('a\x00b')).toBe('a^@b'); // NUL
    expect(safeText('a\bb')).toBe('a^Hb'); // BS (0x08 -> ^H)
    expect(safeText('a\rb')).toBe('a^Mb'); // CR (0x0d -> ^M)
    expect(safeText('a\x1bb')).toBe('a^[b'); // ESC (0x1b -> ^[)
    expect(safeText('a\x1fb')).toBe('a^_b'); // US (0x1f -> ^_)
  });

  test('renders DEL as ^? and C1 controls as \\xNN', () => {
    expect(safeText('a\x7fb')).toBe('a^?b');
    expect(safeText('a\x85b')).toBe('a\\x85b'); // NEL (0x85)
    expect(safeText('a\x9fb')).toBe('a\\x9fb'); // APC (0x9f)
  });

  test('neutralises a line-spoofing payload (ESC + CR)', () => {
    const malicious = 'rm -rf ./safe\x1b[2K\rrm -rf ~';
    const cleaned = safeText(malicious);
    expect(cleaned).not.toContain('\x1b');
    expect(cleaned).not.toContain('\r');
    expect(cleaned).toBe('rm -rf ./safe^[[2K^Mrm -rf ~');
  });
});
