/**
 * Best-effort, append-only command history log for `plx`.
 *
 * Every successfully executed command (subject to `--no-history`) is appended as
 * a single tab-separated line to `~/.plx_history`. The log is intentionally
 * *non-critical*: if writing it fails for any reason — read-only home dir, full
 * disk, weird permissions, a race — `plx` carries on as if nothing happened.
 * History is a convenience, never a correctness requirement.
 *
 * The on-disk format is deliberately greppable and one-line-per-entry:
 *
 *   <ISO timestamp>\texit=<n>\trisk=<level>\tshell=<name|?>\trequest=<...>\tcommand=<...>\n
 *
 * Because the request and command can themselves contain newlines or tabs (a
 * heredoc, a multi-line script the model produced, etc.), those characters are
 * escaped to their literal two-character forms (`\n`, `\r`, `\t`) so a single
 * logical entry always occupies exactly one physical line.
 */

import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RiskLevel } from './types.ts';

/** Absolute path to the history file: `~/.plx_history`. */
export const HISTORY_PATH: string = join(homedir(), '.plx_history');

/** A single history entry, as supplied by the caller after a command runs. */
interface HistoryEntry {
  /** The original natural-language request the user typed. */
  request: string;
  /** The shell command that was actually executed. */
  command: string;
  /** The command's process exit code (0 = success). */
  exitCode: number;
  /** The model's risk classification for the command. */
  riskLevel: RiskLevel;
  /** Short name of the shell the command ran in (e.g. `bash`); `?` if unknown. */
  shell?: string;
}

/**
 * Escape characters that would break the one-line-per-entry invariant.
 *
 * Backslash is escaped first so the escape sequences we introduce afterwards
 * remain unambiguous (i.e. a literal `\n` in the input becomes `\\n`, not `\` + a
 * real newline-escape).
 */
function escapeField(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Append one line describing an executed command to {@link HISTORY_PATH}.
 *
 * Best-effort by design: this never throws. `appendFile` creates the file if it
 * does not exist, so there is no separate "ensure file" step.
 */
export async function recordHistory(entry: HistoryEntry): Promise<void> {
  try {
    const timestamp = new Date().toISOString();
    const shell = entry.shell && entry.shell.length > 0 ? entry.shell : '?';

    const line =
      `${timestamp}\t` +
      `exit=${entry.exitCode}\t` +
      `risk=${entry.riskLevel}\t` +
      `shell=${shell}\t` +
      `request=${escapeField(entry.request)}\t` +
      `command=${escapeField(entry.command)}\n`;

    await appendFile(HISTORY_PATH, line, { encoding: 'utf8' });
  } catch {
    // History is non-critical: a failed write must never disrupt the CLI, and
    // there is nothing useful the user can do about it, so the error is
    // deliberately swallowed without logging (keeps the happy path quiet).
  }
}
