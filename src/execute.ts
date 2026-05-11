/**
 * Command execution layer for the `plx` CLI.
 *
 * Responsibilities:
 *
 * 1. **Shell detection** — figure out which shell to run a generated command
 *    through. Generated commands are POSIX-shell snippets, so we always run
 *    them through `bash -c` / `sh -c`. The detection here is mostly for *display*
 *    and *compatibility*: if the user's interactive shell (`$SHELL`) is itself a
 *    POSIX shell (bash/zsh/sh/dash/ksh/ash/mksh) we use it directly; if it is
 *    something non-POSIX like `fish`, we transparently fall back to `bash`/`sh`
 *    so the POSIX command still works, and we surface that to the user.
 *
 * 2. **Execution** — run the command in a child shell with `stdio: 'inherit'`,
 *    so the child's stdout/stderr stream live to the user's terminal in real
 *    time (no buffering, no capture). A non-zero exit code is *not* treated as
 *    an error: we always read the exit code off the result and return it to the
 *    caller rather than throwing. The only thing that throws is a genuine
 *    *spawn* failure (e.g. the shell binary doesn't exist — `ENOENT`), which is
 *    re-thrown with a clearer message.
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { constants as osConstants } from 'node:os';
import { SHELL_FILE_ENV } from './shell-init.ts';
import type { ExecutionResult, ShellInfo } from './types.ts';

/**
 * Per-step timeout for agent-mode command execution (milliseconds). An
 * autonomous loop must not be stalled forever by a command that never exits
 * (a dev server, `tail -f`, an interactive editor); after this it is killed and
 * reported as a timeout so the agent can decide what to do.
 */
export const AGENT_STEP_TIMEOUT_MS = 120_000;

/** POSIX-compatible shells we are happy to run generated commands through directly. */
const POSIX_SHELLS = new Set(['bash', 'sh', 'dash', 'ksh', 'zsh', 'ash', 'mksh']);

/**
 * Candidate POSIX shells to fall back to, in priority order, when the user's
 * `$SHELL` is unusable (unset, non-POSIX, or the path doesn't exist).
 */
const FALLBACK_SHELLS = [
  '/bin/bash',
  '/usr/bin/bash',
  '/usr/local/bin/bash',
  '/bin/sh',
  '/usr/bin/sh',
];

/** Pick the first fallback shell that exists on disk, or `'sh'` to let PATH resolve it. */
function pickFallbackShell(): string {
  for (const candidate of FALLBACK_SHELLS) {
    if (existsSync(candidate)) return candidate;
  }
  return 'sh';
}

/**
 * Detect the shell to run generated commands through.
 *
 * - If `$SHELL` points to an existing POSIX-compatible shell, use it directly.
 * - Otherwise fall back to `bash`/`sh`, but keep the *name* of the user's
 *   configured shell (when set) so the UI can say "running through bash even
 *   though your shell is fish".
 */
export function detectShell(): ShellInfo {
  const envShell = process.env.SHELL;

  if (envShell) {
    const name = basename(envShell);
    if (POSIX_SHELLS.has(name) && existsSync(envShell)) {
      return { path: envShell, name, posix: true };
    }
    // $SHELL is set but unusable (non-POSIX like fish, or missing path):
    // fall back to bash/sh but report the user's actual shell name.
    const fallback = pickFallbackShell();
    return { path: fallback, name, posix: name === basename(fallback) };
  }

  // $SHELL not set at all — fall back and name it after the fallback.
  const fallback = pickFallbackShell();
  return { path: fallback, name: basename(fallback), posix: true };
}

/** Resolve a signal *name* (e.g. `'SIGINT'`) to its number, if known. */
function signalNumber(signal: string | undefined): number | undefined {
  if (!signal) return undefined;
  const num = (osConstants.signals as Record<string, number | undefined>)[signal];
  return typeof num === 'number' ? num : undefined;
}

/** Minimal structural view of the bits of an execa result we care about. */
interface ProcessOutcome {
  exitCode?: number | undefined;
  signal?: string | undefined;
  failed?: boolean | undefined;
}

/**
 * Derive a conventional exit code from an execa result. execa v9 leaves
 * `exitCode` undefined when the subprocess was killed by a signal — translate
 * that to the conventional `128 + signal number` (or a generic non-zero).
 */
function deriveExitCode(result: ProcessOutcome): number {
  if (typeof result.exitCode === 'number') return result.exitCode;
  if (result.signal) {
    const sigNum = signalNumber(result.signal);
    return typeof sigNum === 'number' ? 128 + sigNum : 1;
  }
  return result.failed ? 1 : 0;
}

/**
 * Wrap `command` so that, after it finishes, the child shell writes its final
 * working directory to `$PLX_SHELL_FILE` (set by the shell-integration wrapper —
 * see `shell-init.ts`). The original exit code is preserved. POSIX-shell syntax;
 * the lines are appended (not wrapped in `{ … }`) so they don't disturb the
 * command's own parsing, and a trailing newline separates them cleanly.
 */
function withCwdCapture(command: string): string {
  return [
    command,
    '__plx_rc=$?',
    `printf '%s' "$PWD" > "\${${SHELL_FILE_ENV}:-/dev/null}" 2>/dev/null`,
    'exit $__plx_rc',
  ].join('\n');
}

/**
 * Run `command` in a child shell (`<shell> -c <command>`), streaming
 * stdout/stderr/stdin between this process and the child so output appears live.
 *
 * With `options.captureFinalCwd`, the child also records its final working
 * directory for the shell-integration wrapper (see {@link withCwdCapture}), so a
 * `cd` (or anything that ends up changing directory) carries over into your
 * shell.
 *
 * Returns the *original* command, the resolved exit code, and the wall-clock
 * duration. A non-zero exit code is returned, not thrown. A spawn failure (shell
 * binary not found) is re-thrown with a clearer message.
 */
export async function executeCommand(
  command: string,
  options: { captureFinalCwd?: boolean } = {},
): Promise<ExecutionResult> {
  const shell = detectShell();
  const start = Date.now();
  const toRun = options.captureFinalCwd ? withCwdCapture(command) : command;

  let result;
  try {
    result = await execa(shell.path, ['-c', toRun], {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
      reject: false,
    });
  } catch (err) {
    throw new Error(
      `Failed to launch shell "${shell.path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const durationMs = Date.now() - start;
  return { command, exitCode: deriveExitCode(result), durationMs };
}

/** {@link ExecutionResult} plus the captured output and a timeout flag, for agent mode. */
export interface CapturedExecutionResult extends ExecutionResult {
  /** The command's combined stdout+stderr (what actually ran; the caller decides whether to truncate). */
  output: string;
  /** True if the command was killed for exceeding the timeout. */
  timedOut: boolean;
}

/**
 * Like {@link executeCommand}, but also *captures* the command's combined
 * stdout+stderr while still streaming it live, so the caller (the agent loop)
 * can feed the result back to the model. Enforces a timeout (default
 * {@link AGENT_STEP_TIMEOUT_MS}) so a hung command can't stall an autonomous run.
 *
 * Like {@link executeCommand}: non-zero exit codes (and timeouts) are returned,
 * not thrown; only a spawn failure throws.
 */
export async function executeCommandCapturing(
  command: string,
  options: { timeoutMs?: number } = {},
): Promise<CapturedExecutionResult> {
  const shell = detectShell();
  const start = Date.now();

  let result;
  try {
    result = await execa(shell.path, ['-c', command], {
      // Duplicate each stream: 'inherit' shows it live, 'pipe' captures it.
      stdout: ['inherit', 'pipe'],
      stderr: ['inherit', 'pipe'],
      stdin: 'inherit',
      // `all: true` merges the captured stdout+stderr in chronological order.
      all: true,
      reject: false,
      timeout: options.timeoutMs ?? AGENT_STEP_TIMEOUT_MS,
    });
  } catch (err) {
    throw new Error(
      `Failed to launch shell "${shell.path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const durationMs = Date.now() - start;

  // Prefer execa's merged `all`; fall back to concatenating the captured streams.
  const stdoutText = typeof result.stdout === 'string' ? result.stdout : '';
  const stderrText = typeof result.stderr === 'string' ? result.stderr : '';
  const output = typeof result.all === 'string' ? result.all : stdoutText + stderrText;

  return {
    command,
    exitCode: deriveExitCode(result),
    durationMs,
    output,
    timedOut: result.timedOut === true,
  };
}
