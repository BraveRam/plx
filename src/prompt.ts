/**
 * Terminal presentation layer for the `plx` CLI.
 *
 * This module owns everything the user sees in their terminal once the model has
 * produced a {@link CommandPlan}:
 *
 *  - {@link renderPlan}    — pretty-prints the proposed command, its explanation,
 *                            and a color-coded risk badge to stdout.
 *  - {@link renderBlocked} — prints an unmistakable refusal to stderr when the
 *                            local safety layer hard-blocks a command.
 *  - {@link confirm}       — asks a yes/no question on the terminal and resolves
 *                            `true` only on an explicit "y"/"yes".
 *
 * Design notes:
 *  - The functions have no side effects beyond writing to stdout/stderr and (for
 *    {@link confirm}) reading a single line from stdin. They never execute a
 *    command, never touch the filesystem, and never decide policy — the caller
 *    in `index.ts` orchestrates whether and when to prompt.
 *  - `renderPlan` deliberately does *not* print a trailing prompt; the caller
 *    decides whether {@link confirm} is needed (e.g. `--yes`, auto-safe commands).
 *  - Colours come from `chalk` v5 (ESM-only). When stdout is not a TTY, chalk
 *    auto-disables styling, so the output stays clean in pipes and CI.
 */

import chalk from 'chalk';
import { basename } from 'node:path';
import * as readline from 'node:readline/promises';
import type { AgentStep, CommandPlan } from './schema.ts';
import type { RiskLevel, ShellInfo } from './types.ts';

/** Width at which the explanation text is soft-wrapped (printable columns). */
const EXPLANATION_WRAP_WIDTH = 76;

/** Leading indent applied to every printed line, for a tidy left margin. */
const INDENT = '  ';

/** Column at which the value text begins, so labels and values line up. */
const LABEL_COLUMN_WIDTH = 'Explanation'.length + 2;

/**
 * Render a colour-coded risk badge for the given level.
 *
 * The badge is a high-contrast inverse block (so it reads at a glance even in a
 * busy terminal) followed by a same-colour word for redundancy when colours are
 * stripped by a pager or `NO_COLOR`.
 */
export function colorRisk(level: RiskLevel): string {
  switch (level) {
    case 'safe':
      return `${chalk.bgGreen.black(' SAFE ')} ${chalk.green('low risk')}`;
    case 'caution':
      return `${chalk.bgYellow.black(' CAUTION ')} ${chalk.yellow('mutates state')}`;
    case 'dangerous':
      return `${chalk.bgRed.white.bold(' DANGEROUS ')} ${chalk.red.bold('destructive / irreversible')}`;
  }
}

/**
 * Format a label/value pair as a single line:
 * `  Label        value`
 * The label is dimmed and right-padded so all values share a column.
 */
function field(label: string, value: string): string {
  return `${INDENT}${chalk.dim(label.padEnd(LABEL_COLUMN_WIDTH))}${value}`;
}

/**
 * Wrap `text` to at most `width` printable columns, breaking on spaces, and
 * indent every line so it aligns under the value column. The first line is
 * returned without the leading indent (the caller's `field()` supplies it).
 */
function wrapExplanation(text: string, width: number): string {
  const continuationIndent = INDENT + ' '.repeat(LABEL_COLUMN_WIDTH);
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  if (lines.length === 0) lines.push('');

  return lines
    .map((line, i) => (i === 0 ? line : `${continuationIndent}${line}`))
    .join('\n');
}

/**
 * Pretty-print the model's command plan to stdout, with a colour-coded risk
 * badge. Does not prompt — the caller decides whether to call {@link confirm}.
 */
export function renderPlan(plan: CommandPlan, ctx: { shell: ShellInfo }): void {
  const { shell } = ctx;

  console.log();
  console.log(field('Command', chalk.bold.cyan(plan.command)));
  console.log(
    field('Explanation', wrapExplanation(plan.explanation, EXPLANATION_WRAP_WIDTH)),
  );
  console.log(field('Risk', colorRisk(plan.riskLevel)));

  if (!shell.posix) {
    console.log(
      `${INDENT}${chalk.dim(
        `(your shell is ${shell.name}; the command will run via ${basename(shell.path)} for POSIX compatibility)`,
      )}`,
    );
  }

  console.log();
}

/**
 * Print a refusal message to stderr when the local safety layer hard-blocks a
 * command. This is for genuinely dangerous commands the deny-list caught — the
 * tone is deliberately unmistakable.
 */
export function renderBlocked(command: string, reason: string): void {
  console.error();
  console.error(
    `${INDENT}${chalk.red.bold('✗ Refusing to run this command — it matches a hard safety block.')}`,
  );
  console.error(`${INDENT}  ${chalk.dim('Command:')} ${chalk.red(command)}`);
  console.error(`${INDENT}  ${chalk.dim('Reason: ')} ${chalk.red(reason)}`);
  console.error();
}

/**
 * Ask the user a yes/no question on the terminal. Resolves `true` only on an
 * explicit "y" / "yes" (case-insensitive, surrounding whitespace ignored);
 * anything else — including an empty answer or EOF (Ctrl-D) — resolves `false`.
 */
export async function confirm(question: string): Promise<boolean> {
  // If stdin is not a TTY (piped input, CI, no controlling terminal) there is no
  // one to answer, and blocking on a read would hang the process forever. Treat
  // that as "no" — the caller interprets a false result as "aborted by user".
  if (!process.stdin.isTTY) return false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`${question} ${chalk.dim('[y/N]')} `);
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } catch {
    // `rl.question` rejects when the stream closes (e.g. Ctrl-D). Treat as "no".
    return false;
  } finally {
    rl.close();
  }
}

/* ───────────────────────── Waiting indicator ───────────────────────── */

/** Braille spinner frames, cycled while waiting on the model. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const SPINNER_INTERVAL_MS = 80;

/**
 * Run `work()` while showing an animated spinner with `label` on **stderr** (so
 * it never pollutes stdout — JSON output, redirected commands, …). It only
 * animates when stderr is a TTY; otherwise it's a plain `await work()`, so pipes
 * and CI stay clean. The spinner line is always erased before returning, even if
 * `work()` throws.
 */
export async function withSpinner<T>(label: string, work: () => Promise<T>): Promise<T> {
  if (!process.stderr.isTTY) return work();

  let frame = 0;
  const render = (): void => {
    const dot = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
    // `\r` → start of line, write the spinner+label, `\x1b[K` → erase to EOL.
    process.stderr.write(`\r${chalk.cyan(dot)} ${chalk.dim(label)}\x1b[K`);
  };

  render();
  const timer = setInterval(() => {
    frame += 1;
    render();
  }, SPINNER_INTERVAL_MS);

  try {
    return await work();
  } finally {
    clearInterval(timer);
    process.stderr.write('\r\x1b[K'); // back to column 0, erase the spinner line
  }
}

/* ───────────────────────── Agent mode ───────────────────────── */

/** A short risk tag (no background block) for the compact agent-step line. */
function riskTag(level: RiskLevel): string {
  switch (level) {
    case 'safe':
      return chalk.green('safe');
    case 'caution':
      return chalk.yellow('caution');
    case 'dangerous':
      return chalk.red.bold('DANGEROUS');
  }
}

/** Print the banner shown once at the start of an agent run. */
export function renderAgentBanner(goal: string, model: string, maxSteps: number): void {
  console.log();
  console.log(`${chalk.bold.magenta('plx agent')} ${chalk.dim(`· up to ${maxSteps} steps · ${model}`)}`);
  console.log(`${INDENT}${chalk.dim('goal:')} ${goal}`);
  console.log();
}

/**
 * Print one agent step *before* its command runs: a step-counter rule, the
 * agent's "thought", and (for a `continue` step) the command, its explanation,
 * and a risk tag. `done`/`blocked` steps are rendered by {@link renderAgentFinish}.
 */
export function renderAgentStep(stepNumber: number, maxSteps: number, step: AgentStep): void {
  console.log(chalk.dim(`── step ${stepNumber}/${maxSteps} ${'─'.repeat(Math.max(0, 40 - String(stepNumber).length - String(maxSteps).length))}`));
  if (step.thought.trim().length > 0) {
    console.log(`${chalk.dim('·')} ${chalk.italic(step.thought.trim())}`);
  }
  if (step.status === 'continue' && step.command) {
    const risk = step.riskLevel ? ` ${chalk.dim('[')}${riskTag(step.riskLevel)}${chalk.dim(']')}` : '';
    console.log(`${chalk.cyan('$')} ${chalk.bold(step.command)}${risk}`);
    if (step.explanation && step.explanation.trim().length > 0) {
      console.log(`${INDENT}${chalk.dim(step.explanation.trim())}`);
    }
  }
}

/** Print the outcome line after an agent step's command has run. */
export function renderAgentOutcome(exitCode: number, durationMs: number, timedOut: boolean): void {
  const status = timedOut
    ? chalk.red(`timed out (killed) after ${durationMs} ms`)
    : exitCode === 0
      ? chalk.green(`ok (${durationMs} ms)`)
      : chalk.yellow(`exit ${exitCode} (${durationMs} ms)`);
  console.log(`${chalk.dim('→')} ${status}`);
  console.log();
}

/**
 * Print the final result of an agent run.
 * - `done`  → green ✓ and the summary.
 * - `blocked` → yellow ⚠ and the summary (the agent gave up).
 * - `limit` → yellow ⚠ and the summary (ran out of steps).
 */
export function renderAgentFinish(
  outcome: 'done' | 'blocked' | 'limit',
  summary: string,
  stepsUsed: number,
  maxSteps: number,
): void {
  console.log();
  const usage = chalk.dim(`(${stepsUsed}/${maxSteps} steps used)`);
  if (outcome === 'done') {
    console.log(`${chalk.green.bold('✓ done')} ${usage}`);
  } else if (outcome === 'limit') {
    console.log(`${chalk.yellow.bold(`⚠ step limit reached`)} ${usage}`);
  } else {
    console.log(`${chalk.yellow.bold('⚠ stopped')} ${usage}`);
  }
  if (summary.trim().length > 0) {
    console.log(`${INDENT}${summary.trim()}`);
  }
  console.log();
}
