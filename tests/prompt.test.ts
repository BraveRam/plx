import { describe, test, expect } from 'bun:test';
import { withSpinner } from '../src/prompt.ts';

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
