#!/usr/bin/env bun
/**
 * `plx` — CLI entry point and orchestration.
 *
 * Pipeline for a single request:
 *
 *   natural language → {@link generateCommandPlan} (LLM via the Vercel AI Gateway)
 *                    → {@link renderPlan} (show the command + explanation + risk)
 *                    → {@link evaluateSafety} (local deny-/allow-list)
 *                    → optional {@link confirm} (skipped with `--yes` / auto-safe)
 *                    → {@link executeCommand} (run it, streaming output live)
 *                    → {@link recordHistory} (append to ~/.plx_history, best-effort)
 *
 * Modes:
 *   - One-shot:     `plx "<request...>"` — runs the pipeline once, exits with the
 *                   command's exit code.
 *   - `--dry-run`:  prints the generated command and stops before execution.
 *   - `--json`:     prints the raw structured plan as JSON and exits (no exec).
 *   - `--agent`:    multi-step autonomous mode — pursues the goal over up to
 *                   `--max-steps` commands (default 20), observing each command's
 *                   output before deciding the next. Lives in `./agent.ts`.
 *   - REPL:         `plx` with no request — interactive loop; a failed request
 *                   (AI error, blocked command, …) never kills the session.
 *
 * This module owns *orchestration and policy* only; presentation lives in
 * `./prompt.ts`, AI calls in `./ai.ts`, the safety layer in `./safety.ts`,
 * execution in `./execute.ts`, the agentic loop in `./agent.ts`, and the
 * history log in `./history.ts`.
 *
 * The shebang on line 1 makes the file directly executable, so the `bin` entry
 * in `package.json` works when the package is installed globally with Bun.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { statSync, writeFileSync } from 'node:fs';
import { generateCommandPlan, DEFAULT_MODEL } from './ai.ts';
import { runAgent, DEFAULT_MAX_STEPS, MIN_MAX_STEPS, MAX_MAX_STEPS } from './agent.ts';
import { loadGlobalConfig } from './config.ts';
import { evaluateSafety } from './safety.ts';
import { detectShell, executeCommand } from './execute.ts';
import { renderPlan, renderBlocked, confirm } from './prompt.ts';
import { recordHistory } from './history.ts';
import {
  asShellKind,
  detectShellKind,
  parseCdCommand,
  shellInitScript,
  SHELL_FILE_ENV,
  SUPPORTED_SHELLS,
} from './shell-init.ts';
import type { CliOptions } from './types.ts';
import type { CommandPlan } from './schema.ts';

/** Exit code used when the user declines the confirmation prompt (SIGINT-ish). */
const EXIT_ABORTED = 130;

/** CLI version, surfaced via `-V, --version`. Keep in sync with `package.json`. */
const VERSION = '0.1.0';

/**
 * Build and configure the `commander` program.
 *
 * Note: `--model` intentionally has *no* commander default — precedence
 * (`--model` → `PLX_MODEL` env → {@link DEFAULT_MODEL}) is resolved in
 * {@link resolveOptions} so an explicit flag always wins over the env var.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('plx')
    .version(VERSION, '-V, --version', 'print the version and exit')
    .description(
      'Translate a natural-language request into a safe shell command via the Vercel AI Gateway.',
    )
    .argument(
      '[request...]',
      'what you want to do, in plain English (omit to start an interactive session)',
    )
    .option('--dry-run', 'show the generated command but do not execute it')
    .option(
      '-y, --yes',
      'skip the confirmation prompt and execute immediately (deny-listed commands are still refused)',
    )
    .option('--json', 'print the raw structured JSON plan and exit (no execution)')
    .option(
      '--agent',
      `agentic mode: pursue the request over multiple steps, observing each command's output (see --max-steps)`,
    )
    .option(
      '--max-steps <n>',
      `agent mode: max command steps before stopping (default: ${DEFAULT_MAX_STEPS}, range ${MIN_MAX_STEPS}–${MAX_MAX_STEPS})`,
    )
    .option(
      '--model <name>',
      `AI Gateway model id (default: ${DEFAULT_MODEL}; also settable via the PLX_MODEL env var)`,
    )
    .option('--no-history', 'do not append the executed command to ~/.plx_history')
    .option(
      '--shell-init [shell]',
      `print a shell wrapper so 'cd' from plx changes your shell (${SUPPORTED_SHELLS.join('/')}; defaults to $SHELL), then exit`,
    )
    .showHelpAfterError()
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ plx "find all files larger than 500MB"',
        '  $ plx "show which process is using port 8000"',
        '  $ plx --dry-run "compress this folder into backup.zip"',
        '  $ plx --json "list git branches"',
        '  $ plx --agent "install deps, run the tests, and tell me what failed"',
        '  $ plx --agent --max-steps 8 "delete every .DS_Store file under here"',
        '',
        'Shell integration (so "take me to ~/projects" actually moves your shell) — run one:',
        `  bash:  echo 'eval "$(plx --shell-init bash)"' >> ~/.bashrc`,
        `  zsh:   echo 'eval "$(plx --shell-init zsh)"'  >> ~/.zshrc`,
        `  fish:  echo 'plx --shell-init fish | source'  >> ~/.config/fish/config.fish`,
        '  then open a new shell (or source that file).',
        '',
      ].join('\n'),
    );

  return program;
}

/**
 * Handle `--shell-init [shell]`: print the integration wrapper for the given
 * shell (or the one detected from `$SHELL`) to stdout and exit `0`. If the shell
 * is unknown, print an error to stderr and exit `2`. Never returns.
 */
function handleShellInit(value: string | boolean | undefined): never {
  // `--shell-init` with no value → commander gives `true`; fall back to $SHELL.
  const requested = typeof value === 'string' ? value : undefined;
  const kind = asShellKind(requested) ?? (requested === undefined ? detectShellKind() : undefined);
  if (!kind) {
    const what = requested ?? process.env.SHELL ?? '(no $SHELL set)';
    console.error(
      chalk.red('Error:'),
      `don't know how to make a wrapper for "${what}". Supported: ${SUPPORTED_SHELLS.join(', ')}.`,
    );
    console.error('Try:  plx --shell-init bash    # or zsh, or fish');
    process.exit(2);
  }
  process.stdout.write(shellInitScript(kind));
  process.exit(0);
}

/**
 * Read the parsed `commander` options and return a fully-resolved
 * {@link CliOptions}. Resolves the model precedence chain and normalises
 * commander's tri-state `--no-*` flags to plain booleans.
 */
export function resolveOptions(program: Command): CliOptions {
  // `commander` gives us a loosely-typed bag; narrow at this single boundary.
  const opts = program.opts<{
    dryRun?: boolean;
    yes?: boolean;
    json?: boolean;
    agent?: boolean;
    maxSteps?: string;
    model?: string;
    history?: boolean;
  }>();

  return {
    dryRun: Boolean(opts.dryRun),
    yes: Boolean(opts.yes),
    json: Boolean(opts.json),
    agent: Boolean(opts.agent),
    maxSteps: resolveMaxSteps(opts.maxSteps),
    model: opts.model ?? process.env.PLX_MODEL ?? DEFAULT_MODEL,
    // commander sets `history === false` only when `--no-history` is passed;
    // otherwise it is `undefined` (treated as enabled).
    history: opts.history !== false,
  };
}

/**
 * Parse and clamp the `--max-steps` value. A missing or unparsable value falls
 * back to {@link DEFAULT_MAX_STEPS}; valid values are clamped to
 * `[${MIN_MAX_STEPS}, ${MAX_MAX_STEPS}]` so a typo can't launch a runaway loop.
 */
function resolveMaxSteps(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_STEPS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_STEPS;
  return Math.min(MAX_MAX_STEPS, Math.max(MIN_MAX_STEPS, parsed));
}

/**
 * Run the full pipeline for a single request and return the process exit code.
 *
 * Never throws for an expected condition (blocked command, non-zero child exit);
 * a thrown error means something genuinely unexpected (AI failure, spawn error)
 * and is surfaced by the caller — except in the REPL, which catches it per-line.
 */
async function handleRequest(request: string, options: CliOptions): Promise<number> {
  const plan: CommandPlan = await generateCommandPlan({ request, model: options.model });

  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  const shell = detectShell();
  renderPlan(plan, { shell });

  // A plain `cd <dir>` can't change *this* shell's directory from a child
  // process — handle it via the shell-integration side channel (or explain it).
  const cd = parseCdCommand(plan.command);
  if (cd) {
    return handleCdRequest(request, cd.resolved, options);
  }

  const verdict = evaluateSafety(plan.command);
  if (!verdict.allowed) {
    renderBlocked(plan.command, verdict.reason ?? 'matched a hard safety block');
    return 1;
  }

  if (options.dryRun) {
    console.log(chalk.dim('(dry run — command not executed)'));
    return 0;
  }

  const needConfirm =
    !options.yes &&
    (verdict.forceConfirm ||
      plan.riskLevel === 'dangerous' ||
      (plan.requiresConfirmation && !verdict.autoSafe));

  if (needConfirm) {
    if (verdict.forceConfirm && verdict.reason) {
      console.log(chalk.yellow(`  ${verdict.reason}`));
    }
    const ok = await confirm('Run this command?');
    if (!ok) {
      console.log(chalk.dim('Aborted.'));
      return EXIT_ABORTED;
    }
  }

  // Under shell integration, capture the child's final cwd so `cd x && …` etc.
  // carry over to the user's shell.
  const result = await executeCommand(plan.command, {
    captureFinalCwd: Boolean(process.env[SHELL_FILE_ENV]),
  });

  if (options.history) {
    await recordHistory({
      request,
      command: plan.command,
      exitCode: result.exitCode,
      riskLevel: plan.riskLevel,
      shell: shell.name,
    });
  }

  if (result.exitCode !== 0) {
    console.log(chalk.dim(`(exit ${result.exitCode}, ${result.durationMs} ms)`));
  }

  return result.exitCode;
}

/**
 * Handle a request that resolved to a plain `cd <dir>`. A child process can't
 * move the parent shell, so: under shell integration, write the resolved path
 * to `$PLX_SHELL_FILE` (the wrapper does the actual `cd`); otherwise, print the
 * path and how to enable integration. Validates that the directory exists.
 */
async function handleCdRequest(request: string, dir: string, options: CliOptions): Promise<number> {
  if (options.dryRun) {
    console.log(chalk.dim(`(dry run — would change directory to ${dir})`));
    return 0;
  }

  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    console.error(chalk.yellow(`  That directory doesn't exist: ${dir}`));
    return 1;
  }

  const shellFile = process.env[SHELL_FILE_ENV];
  if (shellFile) {
    try {
      writeFileSync(shellFile, dir, 'utf8');
    } catch {
      // Can't write the side-channel file — fall back to printing advice.
      printCdAdvice(dir);
      return 0;
    }
    console.log(`${chalk.green('→')} ${dir}`);
    if (options.history) {
      await recordHistory({
        request,
        command: `cd ${dir}`,
        exitCode: 0,
        riskLevel: 'safe',
        shell: detectShell().name,
      });
    }
    return 0;
  }

  printCdAdvice(dir);
  return 0;
}

/** Explain why a one-off `cd` didn't move the user's shell, and how to fix it. */
function printCdAdvice(dir: string): void {
  const kind = detectShellKind() ?? 'bash';
  console.log(chalk.dim("A one-off command can't change your shell's working directory."));
  console.log(`To go there now:  ${chalk.cyan(`cd ${dir}`)}`);
  console.log(chalk.dim("To make plx's `cd` stick, enable shell integration — run this (it's safe to paste):"));
  if (kind === 'fish') {
    console.log(`  ${chalk.cyan("echo 'plx --shell-init fish | source' >> ~/.config/fish/config.fish")}`);
    console.log(chalk.dim('  then open a new shell, or run:  plx --shell-init fish | source'));
  } else {
    console.log(`  ${chalk.cyan(`echo 'eval "$(plx --shell-init ${kind})"' >> ~/.${kind}rc`)}`);
    console.log(chalk.dim(`  then open a new shell, or run:  eval "$(plx --shell-init ${kind})"`));
  }
}

/**
 * Interactive REPL, used when `plx` is invoked with no request on the command
 * line. Each line is treated as its own request; an error on one line (AI
 * failure, blocked command, …) is reported and the loop continues. JSON mode is
 * forced off inside the REPL — it would just dump JSON and immediately ask again.
 */
async function runRepl(options: CliOptions): Promise<number> {
  console.log(`${chalk.bold('plx')} — Type a request, or "exit" / Ctrl-D to quit.`);
  console.log(chalk.dim(`model: ${options.model}`));
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    for (;;) {
      let line: string;
      try {
        line = await rl.question(chalk.cyan('plx> '));
      } catch {
        // `rl.question` rejects on EOF (Ctrl-D) / stream close — end the loop.
        console.log();
        break;
      }

      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed === 'exit' || trimmed === 'quit') break;

      try {
        await handleRequest(trimmed, { ...options, json: false });
      } catch (err) {
        console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    rl.close();
  }

  return 0;
}

/**
 * Parse argv, resolve options, dispatch to the one-shot pipeline or the REPL,
 * and exit with the resulting code. Unexpected errors are printed and mapped to
 * exit code 1.
 */
async function main(): Promise<void> {
  // Fill in any missing config (e.g. AI_GATEWAY_API_KEY, PLX_MODEL) from
  // ~/.config/plx/.env — Bun already loaded a cwd-local .env, and the real
  // environment wins over both. Do this before parsing args.
  loadGlobalConfig();

  const program = buildProgram();
  program.parse(process.argv);

  // `--shell-init [shell]` is a "print and exit" flag, like `--help`/`--version`.
  const shellInit = program.opts<{ shellInit?: string | boolean }>().shellInit;
  if (shellInit !== undefined) handleShellInit(shellInit);

  const options = resolveOptions(program);
  const request = (program.args as string[]).join(' ').trim();

  if (options.agent && request.length === 0) {
    console.error(
      chalk.red('Error:'),
      '--agent needs a goal, e.g.  plx --agent "build and test the project"',
    );
    process.exit(2);
  }

  try {
    let code: number;
    if (options.agent) {
      code = await runAgent({ goal: request, options });
    } else if (request.length > 0) {
      code = await handleRequest(request, options);
    } else {
      code = await runRepl(options);
    }
    process.exit(code);
  } catch (err) {
    console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

void main();
