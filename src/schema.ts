/**
 * Structured-output contract for the AI model.
 *
 * When `plx` asks the model to translate a natural-language request into a shell
 * command, it does **not** ask for free-form text — it asks for an object that
 * conforms to {@link commandPlanSchema}. The schema is converted to a JSON Schema
 * and handed to the model (via the `ai` SDK's structured-output support), so the
 * `.describe()` strings below are not just developer notes: they are *instructions
 * the model actually reads*. Keep them concrete and actionable.
 *
 * The inferred {@link CommandPlan} type is the single source of truth for the
 * shape of a model response — runtime validation (Zod) and the static type can
 * never drift apart because one is derived from the other.
 *
 * Built with Zod v4.
 */

import { z } from 'zod';

/**
 * Soft upper bounds. These are generous on purpose: they exist only to reject
 * pathological responses (a runaway model dumping kilobytes), not to constrain
 * legitimate commands or explanations.
 */
const MAX_COMMAND_LENGTH = 2_000;
const MAX_EXPLANATION_LENGTH = 4_000;

/**
 * The object the model must return for every request.
 *
 * Field-by-field contract:
 * - `command` — exactly one POSIX shell command, ready to paste into `bash`/`sh`.
 *   No markdown, no backticks, no leading `$`, no surrounding prose.
 * - `explanation` — a plain-English description of what the command does and why
 *   it answers the user's request. This is shown to the user before they confirm.
 * - `riskLevel` — the model's own judgement of how dangerous the command is.
 *   Always required; the model must never omit it.
 * - `requiresConfirmation` — whether `plx` should prompt before running the
 *   command. Must be `true` whenever `riskLevel` is `caution` or `dangerous`,
 *   and `false` only when `riskLevel` is `safe`.
 */
export const commandPlanSchema = z.object({
  command: z
    .string()
    .min(1)
    .max(MAX_COMMAND_LENGTH)
    .describe(
      'A single POSIX shell command, no markdown/backticks/prose. ' +
        'Exactly one command line, ready to run in bash/sh. ' +
        'Do not prefix with "$", do not wrap in code fences, do not add commentary — put commentary in "explanation".',
    ),
  explanation: z
    .string()
    .min(1)
    .max(MAX_EXPLANATION_LENGTH)
    .describe(
      'Plain-English explanation of what the command does and why it satisfies the request. ' +
        'Mention any flags or side effects the user should know about. Shown to the user before confirmation.',
    ),
  riskLevel: z
    .enum(['safe', 'caution', 'dangerous'])
    .describe(
      'How risky the command is. ' +
        'safe = read-only (lists, prints, inspects; changes nothing). ' +
        'caution = mutates files/processes/state in a recoverable-ish way (creates/edits/moves files, kills a process, installs a package). ' +
        'dangerous = destructive, irreversible, or system-wide (rm -rf, dd, mkfs, chmod -R on system paths, force-push, dropping a database, anything you cannot easily undo).',
    ),
  requiresConfirmation: z
    .boolean()
    .describe(
      'Whether the user must confirm before the command runs. ' +
        'Must be true for "caution" and "dangerous"; must be false for "safe".',
    ),
});

/**
 * Statically-typed view of a validated model response.
 *
 * Always derive new code from this type rather than re-declaring the shape, so
 * the validator and the type stay in lockstep.
 */
export type CommandPlan = z.infer<typeof commandPlanSchema>;

/* ───────────────────────── Agent mode ───────────────────────── */

/** Soft upper bounds for the agent's free-text fields (see note on the others above). */
const MAX_THOUGHT_LENGTH = 2_000;
const MAX_SUMMARY_LENGTH = 6_000;

/**
 * One turn of the agentic loop (`plx --agent`).
 *
 * Each turn the model returns this object. `status` drives what happens next:
 * - `continue` — run another command. `command`, `explanation`, and `riskLevel`
 *   MUST be present (the loop validates this and re-asks once if they aren't).
 * - `done` — the goal is accomplished. `summary` MUST be present.
 * - `blocked` — the goal is impossible/unsafe or no further progress is possible.
 *   `summary` MUST be present and should say why and what the user could do.
 *
 * The optional fields are modelled as optional (rather than via a discriminated
 * union) because real models follow a flat object + clear field descriptions
 * more reliably than they follow a tagged union; the loop enforces the per-status
 * requirements at runtime.
 */
export const agentStepSchema = z.object({
  thought: z
    .string()
    .min(1)
    .max(MAX_THOUGHT_LENGTH)
    .describe(
      'One or two sentences of reasoning: what the previous command output told you (if any) and what you will do next — or why you are finishing or stopping. Keep it short.',
    ),
  status: z
    .enum(['continue', 'done', 'blocked'])
    .describe(
      'continue = you want to run another shell command (then "command", "explanation", and "riskLevel" are required). ' +
        'done = the goal is fully accomplished (then "summary" is required). ' +
        'blocked = the goal is impossible/unsafe or you cannot make further progress (then "summary" is required).',
    ),
  command: z
    .string()
    .max(MAX_COMMAND_LENGTH)
    .optional()
    .describe(
      'Required when status is "continue": EXACTLY ONE POSIX shell command, raw text only — no markdown, code fences, backticks, leading "$", or commentary. A single pipeline (|) or &&-chain forming one logical step is fine. Omit when status is "done" or "blocked".',
    ),
  explanation: z
    .string()
    .max(MAX_EXPLANATION_LENGTH)
    .optional()
    .describe(
      'Required when status is "continue": a short plain-English description of what the command does. Omit otherwise.',
    ),
  riskLevel: z
    .enum(['safe', 'caution', 'dangerous'])
    .optional()
    .describe(
      'Required when status is "continue": safe = strictly read-only (lists/prints/inspects; changes nothing). ' +
        'caution = mutates files/processes/packages/state in a recoverable-ish way. ' +
        'dangerous = destructive, irreversible, or system-wide. Omit otherwise.',
    ),
  summary: z
    .string()
    .max(MAX_SUMMARY_LENGTH)
    .optional()
    .describe(
      'Required when status is "done" or "blocked": a concise wrap-up — what was accomplished, or why progress stopped and what (if anything) the user should do next. Omit when status is "continue".',
    ),
});

/** Statically-typed view of one validated agent turn. Derive new code from this type. */
export type AgentStep = z.infer<typeof agentStepSchema>;
