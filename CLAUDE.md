# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`plx` — a CLI (`bin: plx`) that turns a natural-language request into a single POSIX shell command via an LLM (Vercel AI Gateway; `deepseek/deepseek-v4-flash` by default, any gateway model via `--model`), shows it with a color-coded risk badge, runs it through a local safety layer, optionally asks for confirmation, then executes it streaming output live. `--agent` turns it into a multi-step autonomous loop (default 20 steps). `--shell-init` prints a shell wrapper so `cd` from `plx` actually moves the user's shell. Stateless per invocation (no LLM conversation memory between runs). Bun + TypeScript, ESM.

## Commands

```bash
bun install                          # deps (ai, chalk, commander, execa, zod)
bun run dev -- "find big files"       # run the CLI (`--` forwards args to src/index.ts)
bun run dev -- --agent "..."          # agentic multi-step mode (--max-steps n, default 20)
bun run dev -- --shell-init bash      # print the shell-integration wrapper (bash|zsh|fish)
bun run dev                          # no args → interactive REPL
bun test                             # all unit tests (in tests/: safety, execute, agent, shell-init, config)
bun test tests/safety.test.ts        # a single test file
bunx tsc --noEmit   # or: bun run typecheck
bun run build                        # → standalone ./plx binary (gitignored)
```

Needs `AI_GATEWAY_API_KEY` (or `VERCEL_OIDC_TOKEN`) for any request that hits the model. Resolution order (first wins): real env → cwd `.env` (Bun auto-loads) → `~/.config/plx/.env` (`config.ts`'s `loadGlobalConfig`, called first in `main()` — fills only unset keys, so the global file never overrides the env). `--help` / `--version` / `--json` / `--dry-run` / `--shell-init` work without credentials.

## Architecture

**One-shot** (`src/index.ts` → `handleRequest()`):
`generateCommandPlan` (`ai.ts`) → `renderPlan` (`prompt.ts`) → `evaluateSafety` (`safety.ts`) → confirm if needed (`prompt.ts`) → `executeCommand` (`execute.ts`) → `recordHistory` (`history.ts`).

**Agent** (`src/index.ts` → `runAgent()` in `agent.ts`, when `--agent`): a loop that accumulates a `messages` array and, each turn, calls `runAgentTurn` (`ai.ts`, `generateText` + `Output.object(agentStepSchema)`) → renders the step → `evaluateSafety` → confirm only if `dangerous` (unless `--yes`) → `executeCommandCapturing` (streams *and* captures, with a per-step timeout) → `recordHistory` → feeds exit code + truncated output back as a user message. Ends on the model's `done`/`blocked`, the step budget, a declined step (exit 130), or a thrown error.

**Shell integration** (`--shell-init`): one-shot mode special-cases a pure `cd <dir>` via `handleRequest` → `parseCdCommand` → `handleCdRequest` (no subshell run; resolves the path, writes it to `$PLX_SHELL_FILE` if set, else prints advice). For every other executed command, `executeCommand` is called with `captureFinalCwd: Boolean(process.env.PLX_SHELL_FILE)` so `cd x && …` etc. also propagate. The wrapper from `plx --shell-init <bash|zsh|fish>` reads that file and `cd`s the user's shell. Agent mode does *not* do cwd capture (would pollute the captured output fed back to the model).

| File | Responsibility | Notes |
|------|----------------|-------|
| `src/index.ts` | Commander CLI, option resolution, orchestration, REPL, agent dispatch, `--shell-init`, `cd` handling (`handleCdRequest`) | shebang `#!/usr/bin/env bun`; `main()` calls `process.exit(code)`; `--agent` without a goal → exit 2; `--shell-init` is a print-and-exit flag handled before option resolution |
| `src/ai.ts` | AI Gateway calls + system prompts | uses **AI SDK v6** `generateText({ output: Output.object({ schema }) })` → `result.output` (NOT `generateObject`, removed in v6); plain `"provider/model"` string routes through the gateway; `DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'`; `runAgentTurn` returns `{ step, responseMessages: result.response.messages }` for multi-turn; maps `APICallError` status codes to friendly messages |
| `src/agent.ts` | `runAgent()` — the agentic loop; `DEFAULT_MAX_STEPS = 20`, clamp `MIN_MAX_STEPS`/`MAX_MAX_STEPS` (1–100); `truncateForFeedback()` | injectable `turn` param (`AgentTurnFn`) so `tests/agent.test.ts` scripts runs offline; a refused command still consumes a step (bounds a misbehaving model); invalid `continue` step → one re-ask then abort |
| `src/config.ts` | `GLOBAL_CONFIG_PATH` (`$XDG_CONFIG_HOME/plx/.env`, default `~/.config/plx/.env`), `loadGlobalConfig(path?)` → string[] of keys it set | parses `KEY=value` lines (strips quotes, skips `#`/blank/bad-key lines); only sets keys not already in `process.env`; best-effort (missing file → `[]`). `main()` calls `loadGlobalConfig()` before parsing args. `ai.ts`'s `MISSING_CREDENTIALS_MESSAGE` references `GLOBAL_CONFIG_PATH` |
| `src/schema.ts` | Zod v4 `commandPlanSchema`/`CommandPlan` (one-shot) and `agentStepSchema`/`AgentStep` (agent) | one-shot: `{ command, explanation, riskLevel: 'safe'\|'caution'\|'dangerous', requiresConfirmation }`. Agent step: `{ thought, status: 'continue'\|'done'\|'blocked', command?, explanation?, riskLevel?, summary? }` — flat object with optionals (more model-reliable than a tagged union); `agent.ts` enforces the per-status requirements at runtime |
| `src/safety.ts` | `DENY_PATTERNS`, `CONFIRM_PATTERNS`, `SAFE_COMMAND_PREFIXES`, `evaluateSafety()` → `SafetyVerdict { allowed, reason?, autoSafe, forceConfirm }` | deny-list = **absolute backstop** (refused even with `--yes`); `CONFIRM_PATTERNS` = power/session-state commands (`shutdown`/`reboot`/`halt`/`poweroff`, `init 0/6`, `systemctl`/`loginctl` power+sleep, screen lockers, `pmset`, …) → `forceConfirm: true` (allowed, but always prompt regardless of model `riskLevel`, unless `--yes`); allow-list (read-only heads, no shell metacharacters) → `autoSafe: true`. Power/runlevel patterns are command-position anchored (`CMD_POS`) so `echo "reboot..."` isn't flagged. Regex-based safety net for LLM mistakes, not a hardened security boundary |
| `src/execute.ts` | `detectShell()`, `executeCommand()` (stream-only; `captureFinalCwd` opt → appends a `printf "$PWD" > "$PLX_SHELL_FILE"` epilogue for shell integration), `executeCommandCapturing()` (stream + capture, `timeoutMs`, default `AGENT_STEP_TIMEOUT_MS = 120_000`) | `execa(shell, ['-c', command], { reject: false })`; always returns the exit code, never throws on non-zero (only spawn failures throw); POSIX commands run through `bash`/`sh` even when `$SHELL` is `fish` (`ShellInfo.posix` reflects this) |
| `src/shell-init.ts` | `SUPPORTED_SHELLS`, `detectShellKind()`, `shellInitScript(kind)` (the wrapper text for bash/zsh/fish), `parseCdCommand(cmd)` → `{ resolved }` for a *pure* `cd <dir>` else `null`, `SHELL_FILE_ENV = 'PLX_SHELL_FILE'` | pure module (no I/O). Wrapper protocol: shell function `plx` shadows the binary, sets `PLX_SHELL_FILE`=tempfile, runs `command plx "$@"`, then `builtin cd -- "$(cat tempfile)"` if non-empty. `plx` writes the resolved dir to that file for a pure `cd` (`handleCdRequest`) or via `executeCommand`'s `captureFinalCwd` epilogue for everything else |
| `src/prompt.ts` | `renderPlan`, `renderBlocked`, `confirm`; agent: `renderAgentBanner`/`renderAgentStep`/`renderAgentOutcome`/`renderAgentFinish` | `confirm()` returns `false` immediately when `!process.stdin.isTTY` (no hang in pipes/CI) |
| `src/history.ts` | `recordHistory()` → `~/.plx_history` | best-effort, tab-separated; intentionally swallows its own errors (non-critical); agent runs record each command with `request = "[agent] <goal>"` |
| `src/types.ts` | shared non-schema types incl. `CliOptions` (`agent`, `maxSteps`, …) | `CommandPlan`/`AgentStep` deliberately live in `schema.ts` (inferred), not here |

Confirmation rules: one-shot prompts iff `!--yes && (verdict.forceConfirm || riskLevel === 'dangerous' || (requiresConfirmation && !verdict.autoSafe))`; agent prompts iff `!--yes && (verdict.forceConfirm || riskLevel === 'dangerous')`. When `verdict.forceConfirm` the `verdict.reason` is printed before the prompt. Decline → exit 130. `--json`/`--dry-run` are ignored in agent mode.

Module imports use explicit `.ts` extensions (`tsconfig.json` has `allowImportingTsExtensions` + `moduleResolution: "bundler"`); running `tsc` on a file in isolation will wrongly flag `TS5097` — always typecheck the whole project (`bunx tsc --noEmit`). Note: importing `src/index.ts` runs `main()` (it self-executes); tests import the leaf modules, not `index.ts`.

## Conventions

- Bun-first per the original `bun init` notes still apply where relevant, **except** `execute.ts` uses `execa` (chosen for streaming + exit-code handling) over `Bun.$`, and `node:fs`/`node:os`/`node:path`/`node:readline/promises` are used directly.
- New AI SDK code: do not trust memorized APIs — check `node_modules/ai/docs/` (esp. `08-migration-guides/24-migration-guide-6-0.mdx`, `03-ai-sdk-core/`, `07-reference/01-ai-sdk-core/`). AI Gateway model slugs use dotted versions (`claude-sonnet-4.6`, not `claude-sonnet-4-6`).
- Tests live in `tests/` (not co-located); they import the modules under test via `../src/…`. `bun test` discovers them automatically.
- CI (`.github/workflows/ci.yml`) runs `bun install` → `bun run typecheck` → `bun test` → `bun run build` on pushes to `main` and on PRs. Keep all four green.
- Adding a safety pattern: a *catastrophic, never-legit* command → `DENY_PATTERNS`; a *drastic-but-legitimate* one (power/session/lock) → `CONFIRM_PATTERNS` (sets `forceConfirm`). Either way add a positive case **and** a "scary but fine" negative case in `tests/safety.test.ts`; anchor keyword-style patterns (`shutdown`, `reboot`, `init 0/6`, …) to command position (`CMD_POS`) so `echo "shutdown ..."` isn't flagged but `cmd; shutdown` is.
