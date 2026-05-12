# plx

**Natural-language shell assistant.** Describe what you want; `plx` asks an LLM to translate it into a single POSIX command, shows you the command with a plain-English explanation and a colour-coded risk rating, runs it past a local safety layer, asks for confirmation when it matters, then executes it — streaming output live. An `--agent` mode pursues a goal over multiple steps, reading each command's output before deciding the next.

[![CI](https://github.com/BraveRam/plx/actions/workflows/ci.yml/badge.svg)](https://github.com/BraveRam/plx/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) &nbsp; built with [Bun](https://bun.com) · TypeScript · the [Vercel AI SDK](https://sdk.vercel.ai) + [AI Gateway](https://vercel.com/docs/ai-gateway)

```console
$ plx "show which process is listening on port 8000"

  Command      lsof -nP -iTCP:8000 -sTCP:LISTEN
  Explanation  Lists the process holding TCP port 8000 in the LISTEN state, with numeric ports and addresses.
  Risk          SAFE  low risk

COMMAND   PID  USER   FD  TYPE  DEVICE  SIZE/OFF  NODE  NAME
node     4821  you    23u IPv4  ...               TCP   *:8000 (LISTEN)
```

Read-only commands like that one run immediately. Anything that changes state is shown first and (unless it's whitelisted as read-only or you pass `--yes`) waits for a `y`:

```console
$ plx "kill whatever is using port 3000"

  Command      kill $(lsof -tiTCP:3000 -sTCP:LISTEN)
  Explanation  Sends SIGTERM to the process IDs listening on TCP port 3000.
  Risk          CAUTION  mutates state

Run this command? [y/N] y
```

---

## Features

- **Natural language → one shell command.** One request in, one POSIX command out (a pipeline or `&&`-chain counts as one).
- **Structured, explained, rated.** The model returns `{ command, explanation, riskLevel, requiresConfirmation }`; you see all of it before anything runs.
- **A safety layer that doesn't depend on the model.** A fixed deny-list of catastrophic patterns (`rm -rf /` & home-dir variants — long flags too, `mkfs`, `dd` to a block device, fork bombs, `chmod -R 777 /`, piping a downloaded script into a shell, commands with raw control/escape bytes other than tab/newline, …) is refused outright — no flag overrides it. Power/session commands (`shutdown`, `reboot`, suspend/hibernate, log out, lock the screen) and `git push --force` always ask first, whatever the model thinks. A read-only allow-list (`ls`, `find`, `grep`, `cat`, `ps`, `df`, …) skips the prompt for obviously safe commands. Everything else asks based on the model's risk rating.
- **Agent mode (`--agent`).** Give it a goal; it works step by step — run a command, read the output, decide the next — up to a step budget (default 20).
- **`cd` that sticks.** With the optional [shell integration](#shell-integration), `plx "take me to ~/projects"` actually moves *your* shell — and so does `cd x && …` in any command.
- **Live output.** Commands run through `bash -c` / `sh -c` with stdio inherited, so output streams in real time.
- **Quality-of-life flags.** `--dry-run` (show, don't run), `--yes` (skip confirmation), `--json` (machine-readable plan), `--model` (any AI Gateway model).
- **Stateless across invocations.** Nothing about your requests is persisted; each `plx` process starts cold. (The REPL keeps in-memory chat context for the *session only* — wiped on exit or `/clear`.)
- **Interactive REPL.** Run `plx` with no arguments for a `plx>` prompt.
- **Command log.** Executed commands are appended to `~/.plx_history` (opt out with `--no-history`).
- **Linux & macOS.** Generated commands are POSIX-oriented; works the same under `bash`, `zsh`, `sh`, and falls back gracefully under `fish`.

## Requirements

- [Bun](https://bun.com) ≥ 1.3
- A Vercel AI Gateway credential — see [Configuration](#configuration).

## Installation

```bash
git clone https://github.com/BraveRam/plx.git
cd plx
bun install
cp .env.example .env          # then add your key — see Configuration below
```

To get a `plx` command on your `PATH`:

```bash
bun link                      # exposes the package's `plx` bin
```

Or build a standalone binary (no Bun required to run it):

```bash
bun run build                 # → ./plx
./plx "list git branches"
```

Optional but recommended — [shell integration](#shell-integration) so `cd` from `plx` changes your shell:

```bash
echo 'eval "$(plx --shell-init bash)"' >> ~/.bashrc      # bash
echo 'eval "$(plx --shell-init zsh)"'  >> ~/.zshrc       # zsh
echo 'plx --shell-init fish | source'  >> ~/.config/fish/config.fish   # fish
```

## Configuration

`plx` talks to models through the **Vercel AI Gateway**, which needs an `AI_GATEWAY_API_KEY` (a static key from the Vercel dashboard → AI Gateway — [docs](https://vercel.com/docs/ai-gateway)). `plx` looks for it in this order — first one wins:

1. **The real environment** — e.g. `export AI_GATEWAY_API_KEY=…` in `~/.zshrc` / `~/.bashrc`, or `set -gx AI_GATEWAY_API_KEY …` in fish. Use this if you run `plx` from anywhere.
2. **A `.env` in the directory you run `plx` from** (Bun auto-loads it). Handy inside one project; doesn't apply elsewhere.
3. **`~/.config/plx/.env`** (or `$XDG_CONFIG_HOME/plx/.env`) — `plx`'s own user-global config, read no matter where you run it. Just put `AI_GATEWAY_API_KEY=…` in it. The recommended spot if you don't want it in your shell env.

Alternatively, inside a **linked Vercel project**, `vercel env pull .env.local` provisions a short-lived `VERCEL_OIDC_TOKEN` that the gateway uses when `AI_GATEWAY_API_KEY` isn't set.

If no credential is found, `plx` exits with a message listing these options. `--help`, `--version`, `--json`, and `--dry-run` work without credentials.

`~/.config/plx/.env` also accepts **`PLX_MODEL`** (or set it in your shell env) — the default model id (`provider/model`, e.g. `anthropic/claude-sonnet-4.6`); the `--model` flag wins over it. Out of the box `plx` uses `deepseek/deepseek-v4-flash`.

## Usage

```bash
plx "find all files larger than 500MB"
plx "compress this folder into backup.zip"
plx "create a new git branch called feature/auth"
plx "show what changed in the last 3 commits"

plx --dry-run "delete node_modules everywhere under here"   # show it, don't run it
plx --json "list git branches"                              # {"command":"git branch", ...}
plx --yes "git fetch --all"                                 # don't prompt
plx --model anthropic/claude-sonnet-4.6 "..."               # use a different model

plx --agent "install deps, run the tests, and tell me what failed"
plx --agent --max-steps 8 "find and delete every .DS_Store file under here"

plx                                                         # no args → interactive REPL
```

Quoting the request is optional — `plx find big files` and `plx "find big files"` are equivalent; quote when it contains shell metacharacters.

During development, run the CLI without installing it via `bun run dev -- <args>` (the `--` forwards everything after it):

```bash
bun run dev -- "find all jpg files modified today"
bun run dev -- --agent "set up this project"
```

### CLI flags

| Flag | Description |
| --- | --- |
| `[request...]` | The natural-language request — or, with `--agent`, the goal. Omit it entirely to start the interactive REPL. |
| `--dry-run` | Show the generated command but do not execute it. (Ignored with `--agent`.) |
| `-y`, `--yes` | Skip the confirmation prompt and execute immediately. Deny-listed commands are still refused. With `--agent`, also auto-runs `caution`/`dangerous` steps (without it, only read-only steps run unattended). |
| `--json` | Print the raw structured JSON plan and exit (no execution). (Ignored with `--agent`.) |
| `--agent` | Agentic mode: pursue the request over multiple steps. See [Agent mode](#agent-mode). |
| `--max-steps <n>` | Agent mode only: maximum command steps before stopping. Default `20`; clamped to `1`–`100`. |
| `--model <name>` | AI Gateway model id (`provider/model`). Also settable via `PLX_MODEL`; `--model` wins. |
| `--no-history` | Do not append executed commands to `~/.plx_history`. |
| `--shell-init [shell]` | Print a shell wrapper (`bash`/`zsh`/`fish`; defaults to `$SHELL`) so `cd` from `plx` changes your shell, then exit. See [Shell integration](#shell-integration). |
| `-h`, `--help` | Show help and exit. |
| `-V`, `--version` | Show the version and exit. |

## How it works

For a single request:

1. Assemble the request string from the CLI arguments.
2. Call `generateText` with `Output.object` (Vercel AI SDK v6 → AI Gateway). The model returns `{ command, explanation, riskLevel, requiresConfirmation }`.
3. Render the command, the explanation, and a colour-coded risk badge.
4. Run the command through the safety layer: a deny-list match is a hard block (nothing runs); a read-only allow-list match marks the command auto-safe.
5. If the command isn't auto-safe and is `caution`/`dangerous` — and `--yes` wasn't passed — ask for confirmation. `dangerous` always prompts unless `--yes`.
6. Execute it via `execa(shell, ['-c', command], { stdio: 'inherit' })`, streaming output live; `plx` exits with the command's exit code.
7. Append the command to `~/.plx_history` (best-effort, unless `--no-history`).

Module layout (`src/`):

| File | Responsibility |
| --- | --- |
| `index.ts` | CLI entry point, argument parsing, orchestration, REPL, agent dispatch, `--shell-init`, `cd` handling |
| `ai.ts` | AI Gateway calls and system prompts (`generateText` + `Output.object`) — one-shot and agent turns |
| `agent.ts` | The agentic loop: step budget, per-step safety, feeding output back to the model |
| `config.ts` | Loads `~/.config/plx/.env` into `process.env` for missing keys (so credentials work from any directory) |
| `chat.ts` | The REPL's in-memory session chat helpers (`pushChat`, the cap) — shared by one-shot lines and agent runs |
| `schema.ts` | Zod schemas for the model's structured responses (one-shot plan + agent step) and their inferred types |
| `safety.ts` | Deny-list + always-confirm list + read-only allow-list (`evaluateSafety`) |
| `execute.ts` | Shell detection; command execution (live streaming; a capturing variant for agent mode; final-cwd capture for shell integration) |
| `shell-init.ts` | `--shell-init` wrappers (`bash`/`zsh`/`fish`) and `cd`-command parsing/resolution |
| `prompt.ts` | Terminal rendering and the yes/no confirmation prompt |
| `history.ts` | Best-effort append to `~/.plx_history` |
| `types.ts` | Shared types |

`bun:test` unit tests live in `tests/` (`safety.test.ts`, `execute.test.ts`, `agent.test.ts`, `shell-init.test.ts`, `config.test.ts`, `prompt.test.ts`) and import the modules under test via `../src/…`. `bun test` picks them up automatically.

## Safety model

`plx` runs shell commands an LLM wrote. It has four gates, applied in order:

1. **Deny-list — absolute backstop.** A fixed set of regex patterns for catastrophic commands (`rm -rf /` / `/*` / the literal home dir — short *and* long flags, anything that disables `--preserve-root`, `mkfs`, `dd` to a block device, output redirection onto a raw block device, classic fork bombs, `chmod -R 777 /`, `chown -R … /`, `mv … /dev/null`, piping a downloaded script straight into a shell, and any command containing raw control/escape characters other than tab/newline — a terminal-spoofing vector). A match means the command is **never** run — no flag, no prompt, and no model risk rating overrides it. `--yes` does not affect this gate. (A `rm -rf` of a *specific* subdirectory like `./build` is *not* denied — it goes through gate 4.)
2. **Always-confirm.** Commands that change the machine's power or session state — shut down / reboot / halt / power off, change runlevel (`init 0`/`6`), suspend or hibernate, log out, lock the screen (`shutdown`, `reboot`, `systemctl poweroff`/`suspend`, `loginctl lock-session`, `xdg-screensaver lock`, `swaylock`, `pmset displaysleepnow`, …) — plus `git push --force` / `--mirror` / `--delete` (rewrites or destroys a remote). These are allowed, but you're always asked first regardless of the model's risk rating. `--yes` skips this prompt like any other.
3. **Read-only allow-list — skip the prompt.** Commands whose first word is read-only by nature (`ls`, `find`, `grep`, `cat`, `head`, `tail`, `ps`, `df`, `du`, `pwd`, `wc`, `stat`, …) *and* that contain no shell metacharacters that could chain or redirect (`;`, `|`, `&`, `<`, `>`, `$`, backticks, `$(…)`) run without asking. `find . | xargs rm -f` starts with `find` but the pipe disqualifies it.
4. **Confirmation — everything else.** Any command that is none of the above is shown to you and waits for a `y` based on the model's risk rating: `caution` and `dangerous` commands prompt unless you passed `--yes`; `dangerous` always prompts unless `--yes`. `--dry-run` shows the command without running it.

**Read the command before you confirm.** The model can be wrong; the deny-list catches well-known catastrophes, not every possible mistake. Treat `plx` like a sharp tool — it's a safety net, not a sandbox.

## Agent mode

`plx --agent "<goal>"` doesn't stop at one command. The model is given a goal and works toward it over multiple steps: it proposes a command, `plx` runs it, and the command's exit code and (truncated) combined output are fed back so the model can decide the next step — until it reports the goal done, gives up, the step budget runs out, you decline a step, or you press Ctrl-C.

```console
$ plx --agent "set up this project: install dependencies and run the tests"

plx agent · up to 20 steps · deepseek/deepseek-v4-flash
  goal: set up this project: install dependencies and run the tests

── step 1/20 ──────────────────────────────────
· No node_modules yet — install dependencies first.
$ bun install [caution]
  Installs the project's dependencies from the lockfile.
Run this caution command? [y/N] y
... (live output) ...
→ ok (1.7 s)

── step 2/20 ──────────────────────────────────
· Dependencies installed; run the test suite.
$ bun test [safe]
  Runs the project's test suite.
... (live output) ...               ← read-only, runs without asking
→ ok (210 ms)

✓ done (2/20 steps used)
  Installed dependencies and ran the tests — all suites passed.
```

(Pass `--agent --yes` for a hands-off run that doesn't pause on `caution`/`dangerous` steps — the deny-list still applies.)

The step budget defaults to **20**; set it with `--max-steps <n>` (clamped to 1–100). Each step prints a counter, the agent's one-line reasoning, the command and its risk tag, then its output streams live and the outcome (`ok` / `exit N` / `timed out`) is shown. The run ends with `✓ done`, `⚠ stopped`, or `⚠ step limit reached`, plus a summary.

**Safety in agent mode.** The deny-list is still absolute — a hard-blocked command is never run (even with `--yes`), and the agent is told it was refused and must try something else or stop. Beyond that, only strictly read-only (`safe`) steps run unattended: **`caution` and `dangerous` steps prompt for a `y`** (as does anything the always-confirm list catches) unless you pass `--yes`. This is deliberate — the command output fed back to the model is untrusted (a README, log line, or fetched page the agent reads could try to steer it), and the agent's system prompt is explicitly told that command output is data, never instructions; the human-in-the-loop on mutating steps is the backstop if that fails. So: leave `--yes` off and approve each mutating step, *or* pass `--yes` for a hands-off run of a goal you trust (deny-list still applies). Declining a step stops the run. Each executed command is recorded in `~/.plx_history` unless `--no-history`. `--json` and `--dry-run` have no effect with `--agent`.

A step that never exits — a dev server, `tail -f`, an interactive editor — is killed after a per-step timeout (2 minutes) and reported as a timeout, so agent mode is best aimed at goals that *complete* (prefer "verify the app builds and starts" over "run the dev server"). `cd` only affects the command it appears in (each step runs in a fresh shell); the agent knows this and chains `cd … && …`. With [shell integration](#shell-integration) installed, your shell follows the agent to wherever its last command ended up — so `plx --agent "take me to ~/projects"` actually moves you, just like the one-shot form.

## Interactive mode

Run `plx` with no arguments to open a prompt:

```console
$ plx
plx — interactive. /help for commands · model: deepseek/deepseek-v4-flash

plx> echo a line saying hello
  Command  echo hello
  ...
plx> now do the same but add the word world
  Command  echo 'hello world'        ← it remembered the previous turn
  ...
plx> /agent install deps, run the tests, and tell me what failed
plx agent · up to 20 steps · …
...
plx> exit
```

**Chat context (session-scoped).** Lines in a session share conversation context — each one is sent to the model with the earlier turns, so follow-ups like *"now delete them"*, *"that failed, try X"*, or *"you remember the name I gave you?"* work. After a command runs (or is declined / blocked / dry-run) a short *"(I ran the previous command; it exited 0.)"* note is added too, so the next turn knows the outcome. **Agent runs join this too** — a run is *seeded* with the session chat, and afterwards a compact *`[agent] <goal>` → `<final summary>`* pair is appended (its step-by-step internals aren't kept). It's all **in-memory only** — wiped by `/clear`, gone when you exit, never written to disk; capped at the last ~24 turns so it doesn't balloon. A failed line (AI error, blocked command, declined step) is reported and the session continues.

REPL commands:

| | |
|---|---|
| `<text>` | run as a request — or, in agent mode, as a multi-step goal |
| `/agent` | switch to **agent mode**: each line becomes a goal (up to `--max-steps`, default 20) |
| `/agent <goal>` | run one goal in agent mode without switching |
| `/once` | switch back to one-shot mode |
| `/clear` | forget the chat context built up this session |
| `/help` | the command list |
| `/exit`, `exit`, `quit`, Ctrl-D | quit |

`plx --agent` with no goal starts the REPL already in agent mode (`plx agent> `). `--yes` / `--max-steps` from the launch command apply to all agent runs in the session.

## Command history

Executed commands are appended to `~/.plx_history` as one tab-separated line each:

```
2026-05-11T12:34:56.789Z<TAB>exit=0<TAB>risk=safe<TAB>shell=bash<TAB>request=find big files<TAB>command=find . -type f -size +500M
```

Fields: ISO timestamp, exit code, risk level, shell name, the original request, and the command that ran (newlines and tabs inside the request/command are escaped so each entry stays one line). Disable per run with `--no-history`. Writing the log is best-effort — if it fails, `plx` carries on. This is shell-command history only; there is no LLM conversation memory.

## Shell integration

`plx` runs commands in a *child* shell, so a `cd` it runs can't change *your* shell's working directory — a child process can't move its parent (that's why `cd` is a shell builtin, not a program). To bridge that, install a small wrapper function — the same trick `zoxide`/`direnv`/`fzf` use:

```bash
# bash — in ~/.bashrc
eval "$(plx --shell-init bash)"

# zsh — in ~/.zshrc
eval "$(plx --shell-init zsh)"

# fish — in ~/.config/fish/config.fish
plx --shell-init fish | source
```

(`plx --shell-init` with no argument picks the wrapper for your `$SHELL`.)

With it installed, when a command changes directory, `plx` writes the resulting path to a temp file the wrapper reads, and the wrapper `cd`s your shell there:

```console
$ pwd
/home/you/work/some-repo
$ plx "take me to my home directory"

  Command      cd ~
  Explanation  Changes the current directory to your home directory.
  Risk          SAFE  low risk

→ /home/you
$ pwd
/home/you
```

It also carries over for commands that *end up* somewhere — `plx "go to ~/projects, pull, and show the log"` leaves you in `~/projects` after it runs. Without the wrapper, a `cd` request just prints the resolved path and a reminder of how to enable integration (nothing is silently no-op'd).

## Shell detection

`plx` reads `$SHELL` for display. If it points to a POSIX-compatible shell (`bash`, `zsh`, `sh`, `dash`, `ksh`, `ash`, `mksh`), generated commands run through it directly. If your interactive shell is non-POSIX (e.g. `fish`), `plx` runs the generated POSIX command through `bash -c` (or `sh -c`) so it behaves correctly, and notes that in the output.

## Development

```bash
bun run dev -- "<request>"     # run the CLI from source
bun test                       # run the unit tests (safety.ts, execute.ts, agent.ts)
bun test tests/safety.test.ts  # a single test file
bun run typecheck              # tsc --noEmit
bun run build                  # → standalone ./plx binary
```

The codebase is small and modular — see [the module layout](#how-it-works). Module imports use explicit `.ts` extensions (the project's `tsconfig.json` enables `allowImportingTsExtensions` with `moduleResolution: "bundler"`), so always type-check the whole project rather than a single file.

When touching anything that talks to the model, don't rely on memorised APIs — the Vercel AI SDK moves quickly; check the bundled docs under `node_modules/ai/docs/`.

## Contributing

Issues and pull requests are welcome. Please run `bun run typecheck` and `bun test` before opening a PR. Source lives in `src/`, tests in `tests/`. If you add or change a deny-list (or always-confirm) pattern in `src/safety.ts`, add a matching test (a "should be blocked"/"should confirm" case and a "looks scary but is fine" case) in `tests/safety.test.ts`.

## License

[MIT](LICENSE).
