/**
 * Agentic loop for `plx --agent`.
 *
 * Where the one-shot path turns a request into a *single* command, agent mode
 * gives the model a GOAL and lets it work toward it over multiple steps: it
 * proposes a command, we run it (through the same safety layer), and we feed the
 * command's exit code and output back so it can decide the next step — up to a
 * hard step budget (default {@link DEFAULT_MAX_STEPS}).
 *
 * Safety: the deny-list is still absolute — a hard-blocked command is never run,
 * even with `--yes`; the agent is told it was refused and must try something
 * else (or stop). `safe`/`caution` steps run automatically (that's the point of
 * an agent); a `dangerous` step still prompts for confirmation unless `--yes`.
 * A declined step stops the run. Each executed command is recorded in
 * `~/.plx_history` (unless `--no-history`).
 *
 * Statelessness: the model API is stateless, so the conversation is rebuilt on
 * every turn by accumulating a `messages` array. Nothing persists between
 * invocations — a fresh `plx --agent` knows nothing of the last one.
 */

import chalk from 'chalk';
import type { ModelMessage } from 'ai';
import { runAgentTurn, type AgentTurnResult } from './ai.ts';
import type { AgentStep } from './schema.ts';
import { evaluateSafety } from './safety.ts';
import { AGENT_STEP_TIMEOUT_MS, detectShell, executeCommandCapturing } from './execute.ts';
import { recordHistory } from './history.ts';
import {
  confirm,
  renderAgentBanner,
  renderAgentFinish,
  renderAgentOutcome,
  renderAgentStep,
  renderBlocked,
  withSpinner,
} from './prompt.ts';
import type { CliOptions } from './types.ts';

/** Default ceiling on command steps in agent mode. */
export const DEFAULT_MAX_STEPS = 20;

/** Inclusive bounds for `--max-steps`. */
export const MIN_MAX_STEPS = 1;
export const MAX_MAX_STEPS = 100;

/** Exit code used when the user declines a step (mirrors the one-shot abort code). */
const EXIT_ABORTED = 130;

/** Max characters of a command's captured output that we feed back to the model. */
const MAX_FEEDBACK_CHARS = 6_000;

/** A `continue` step that actually carries everything needed to run a command. */
type RunnableStep = AgentStep & {
  status: 'continue';
  command: string;
  explanation: string;
  riskLevel: NonNullable<AgentStep['riskLevel']>;
};

/** Validate that a `continue` step is complete enough to act on. */
function isRunnableStep(step: AgentStep): step is RunnableStep {
  return (
    step.status === 'continue' &&
    typeof step.command === 'string' &&
    step.command.trim().length > 0 &&
    typeof step.explanation === 'string' &&
    step.explanation.length > 0 &&
    step.riskLevel !== undefined
  );
}

/**
 * Truncate `output` for inclusion in the conversation, keeping the head and
 * (more of) the tail — the end of a command's output is usually the most useful
 * part (errors, summaries). Exported for testing.
 */
export function truncateForFeedback(output: string, limit: number = MAX_FEEDBACK_CHARS): string {
  if (output.length <= limit) return output;
  const headLen = Math.floor(limit / 3);
  const tailLen = limit - headLen;
  const omitted = output.length - headLen - tailLen;
  return `${output.slice(0, headLen)}\n... [${omitted} characters omitted] ...\n${output.slice(output.length - tailLen)}`;
}

/** Build the feedback message handed to the model after a command runs. */
function feedbackMessage(args: {
  exitCode: number;
  timedOut: boolean;
  output: string;
  stepsUsed: number;
  maxSteps: number;
}): string {
  const body = args.output.trim().length > 0 ? truncateForFeedback(args.output) : '(no output)';
  const remaining = args.maxSteps - args.stepsUsed;
  const budgetLine =
    remaining <= 0
      ? 'This was your LAST allowed step — you may not run any more commands. Return status "done" or "blocked" with a "summary".'
      : `${remaining} step(s) remaining. Return your next step, or "done"/"blocked".`;
  return [
    `Command finished with exit code ${args.exitCode}${args.timedOut ? ' (TIMED OUT — it was killed for exceeding the time limit)' : ''}.`,
    'Combined stdout+stderr:',
    body,
    '',
    budgetLine,
  ].join('\n');
}

/** Injectable model-turn function (defaults to the real one). Lets tests script a run. */
export type AgentTurnFn = (args: { model?: string; messages: ModelMessage[] }) => Promise<AgentTurnResult>;

export interface RunAgentArgs {
  /** The natural-language goal. */
  goal: string;
  /** Resolved options — uses `model`, `maxSteps`, `yes`, and `history`. */
  options: CliOptions;
  /** Override the model-turn function (for tests); defaults to {@link runAgentTurn}. */
  turn?: AgentTurnFn;
}

/**
 * Run the agentic loop for `goal`. Returns the process exit code:
 * `0` on `done`, `1` on `blocked` / step-limit, `130` if the user declines a
 * step. Unexpected errors (AI/network/spawn) propagate to the caller.
 */
export async function runAgent(args: RunAgentArgs): Promise<number> {
  const { goal, options } = args;
  const turn: AgentTurnFn = args.turn ?? runAgentTurn;
  const maxSteps = options.maxSteps;
  const shell = detectShell();

  renderAgentBanner(goal, options.model, maxSteps);

  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: [
        `Goal: ${goal}`,
        `Working directory: ${process.cwd()}`,
        `OS: ${process.platform}`,
        `Step budget: at most ${maxSteps} command step(s).`,
        'Begin. Return your first step.',
      ].join('\n'),
    },
  ];

  let stepsUsed = 0;
  let invalidRetries = 0;

  while (stepsUsed < maxSteps) {
    const { step, responseMessages } = await withSpinner('thinking…', () =>
      turn({ model: options.model, messages }),
    );
    messages.push(...responseMessages);

    if (step.status === 'done') {
      renderAgentFinish('done', step.summary ?? 'Goal accomplished.', stepsUsed, maxSteps);
      return 0;
    }
    if (step.status === 'blocked') {
      renderAgentFinish('blocked', step.summary ?? 'The agent stopped without giving a reason.', stepsUsed, maxSteps);
      return 1;
    }

    // status === 'continue' — must carry a runnable command.
    if (!isRunnableStep(step)) {
      if (invalidRetries >= 1) {
        renderAgentFinish(
          'blocked',
          'The model kept returning invalid steps (status "continue" without a usable "command"). Aborting.',
          stepsUsed,
          maxSteps,
        );
        return 1;
      }
      invalidRetries += 1;
      messages.push({
        role: 'user',
        content:
          'Your last response had status "continue" but did not include a usable "command" (with "explanation" and "riskLevel"). Return a corrected step now.',
      });
      continue; // does not consume a step
    }
    invalidRetries = 0;

    // From here on this turn consumes a step (even if the command is refused —
    // that bounds a model that keeps proposing blocked commands).
    stepsUsed += 1;
    renderAgentStep(stepsUsed, maxSteps, step);

    const verdict = evaluateSafety(step.command);
    if (!verdict.allowed) {
      renderBlocked(step.command, verdict.reason ?? 'matched a hard safety block');
      messages.push({
        role: 'user',
        content: `That command was REFUSED by the local safety layer (${verdict.reason ?? 'hard safety block'}); it was not run. Choose a genuinely different, safer approach, or return status "blocked". ${
          maxSteps - stepsUsed <= 0 ? 'You have no steps left — you must return "done" or "blocked".' : `${maxSteps - stepsUsed} step(s) remaining.`
        }`,
      });
      continue;
    }

    if (!options.yes && (verdict.forceConfirm || step.riskLevel === 'dangerous')) {
      if (verdict.forceConfirm && verdict.reason) {
        console.log(chalk.yellow(`  ${verdict.reason}`));
      }
      const label = step.riskLevel === 'dangerous' ? `${chalk.red.bold('dangerous')} command` : 'command';
      const ok = await confirm(`Run this ${label}?`);
      if (!ok) {
        console.log(chalk.dim('Declined — stopping the agent.'));
        return EXIT_ABORTED;
      }
    }

    const result = await executeCommandCapturing(step.command, { timeoutMs: AGENT_STEP_TIMEOUT_MS });
    renderAgentOutcome(result.exitCode, result.durationMs, result.timedOut);

    if (options.history) {
      await recordHistory({
        request: `[agent] ${goal}`,
        command: step.command,
        exitCode: result.exitCode,
        riskLevel: step.riskLevel,
        shell: shell.name,
      });
    }

    messages.push({
      role: 'user',
      content: feedbackMessage({
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        output: result.output,
        stepsUsed,
        maxSteps,
      }),
    });
  }

  // Step budget exhausted without an explicit done/blocked — ask for a final wrap-up.
  try {
    const { step } = await withSpinner('wrapping up…', () =>
      turn({
        model: options.model,
        messages: [
          ...messages,
          {
            role: 'user',
            content: `You have reached the ${maxSteps}-step limit and may not run any more commands. Return status "done" if the goal is genuinely complete, otherwise "blocked", with a "summary" of what you accomplished and what (if anything) is left.`,
          },
        ],
      }),
    );
    if (step.status === 'done') {
      renderAgentFinish('done', step.summary ?? 'Goal accomplished.', stepsUsed, maxSteps);
      return 0;
    }
    renderAgentFinish('limit', step.summary ?? `Reached the ${maxSteps}-step limit before the goal was confirmed complete.`, stepsUsed, maxSteps);
    return 1;
  } catch {
    renderAgentFinish('limit', `Reached the ${maxSteps}-step limit before the goal was confirmed complete.`, stepsUsed, maxSteps);
    return 1;
  }
}
