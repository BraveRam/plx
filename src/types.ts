/**
 * Shared, schema-independent types for the `plx` CLI.
 *
 * The AI-response shape (`CommandPlan`) is intentionally kept out of this file —
 * it is inferred from the Zod schema in `./schema.ts` so the runtime validator
 * and the static type can never drift apart.
 */

/** How risky the model judged a generated command to be. */
export type RiskLevel = 'safe' | 'caution' | 'dangerous';

/** Resolved command-line options for a single invocation. */
export interface CliOptions {
  /** Show the generated command but never execute it. */
  dryRun: boolean;
  /** Skip the confirmation prompt (deny-listed commands are still refused; in agent mode, also auto-runs `dangerous` steps). */
  yes: boolean;
  /** Print the raw structured JSON plan and exit without executing. */
  json: boolean;
  /** Resolved model id: `--model` ?? `PLX_MODEL` env ?? `DEFAULT_MODEL`. */
  model: string;
  /** Append executed commands to `~/.plx_history` (false when `--no-history`). */
  history: boolean;
  /** Agentic mode: pursue the request over multiple steps (see {@link maxSteps}). */
  agent: boolean;
  /** Hard ceiling on command steps in agent mode (resolved from `--max-steps`, default 20). */
  maxSteps: number;
}

/** Result of running a command through the local safety layer. */
export interface SafetyVerdict {
  /**
   * `false` means the command is hard-blocked and must never run — not even
   * with `--yes`.
   */
  allowed: boolean;
  /**
   * Human-readable reason. Present when `allowed` is `false` (why it was
   * blocked) or when `forceConfirm` is `true` (why it always needs confirming).
   */
  reason?: string;
  /**
   * `true` when the command matches the read-only allow-list and can therefore
   * skip the confirmation prompt regardless of the model's own judgement.
   * Never `true` at the same time as `forceConfirm`.
   */
  autoSafe: boolean;
  /**
   * `true` for commands that change the machine's power or session state
   * (`shutdown`, `reboot`, suspend/hibernate, log out, lock the screen, …):
   * allowed to run, but the user must confirm first regardless of the model's
   * `riskLevel` — unless `--yes` is passed.
   */
  forceConfirm: boolean;
}

/** Outcome of executing a command in a child shell. */
export interface ExecutionResult {
  /** The exact command string that was executed. */
  command: string;
  /** Process exit code (0 = success). */
  exitCode: number;
  /** Wall-clock duration of the child process, in milliseconds. */
  durationMs: number;
}

/** Information about the shell used to run generated commands. */
export interface ShellInfo {
  /** Absolute path to the shell executable (e.g. `/bin/bash`). */
  path: string;
  /** Short shell name (e.g. `bash`, `zsh`, `fish`, `sh`). Reflects `$SHELL`. */
  name: string;
  /**
   * `true` when the command is actually run through a POSIX-compatible shell.
   * If the user's `$SHELL` is non-POSIX (e.g. `fish`), commands are still run
   * through `bash`/`sh` for compatibility and this is `false`.
   */
  posix: boolean;
}
