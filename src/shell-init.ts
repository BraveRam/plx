/**
 * Shell integration for `plx` — making `cd` actually stick.
 *
 * A `plx` invoked the normal way runs commands in a *child* shell (`bash -c …`),
 * so a `cd` it runs can never change *your* shell's working directory — a child
 * process simply cannot move its parent. (That's why `cd` is a shell builtin and
 * not a program.)
 *
 * The fix, like `zoxide`/`direnv`/`fzf`: a small wrapper *function* named `plx`
 * that shadows the binary. The wrapper points the binary at a temp file via
 * `PLX_SHELL_FILE`; when a command ends up changing directory, `plx` writes the
 * resulting absolute path to that file; after `plx` exits, the wrapper `cd`s
 * your shell there and deletes the file.
 *
 * This module is pure: it generates the wrapper text and parses/​resolves `cd`
 * commands. The actual file writes and execution live in `index.ts`/`execute.ts`.
 */

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/** Shells we can emit an integration wrapper for. */
export const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type ShellKind = (typeof SUPPORTED_SHELLS)[number];

/** Environment variable the wrapper sets and the binary writes a resolved path into. */
export const SHELL_FILE_ENV = 'PLX_SHELL_FILE';

/** Narrow an arbitrary string to a {@link ShellKind}, or `undefined`. */
export function asShellKind(value: string | undefined): ShellKind | undefined {
  return value !== undefined && (SUPPORTED_SHELLS as readonly string[]).includes(value)
    ? (value as ShellKind)
    : undefined;
}

/** Best-effort guess of the user's shell from `$SHELL` (basename). */
export function detectShellKind(): ShellKind | undefined {
  const shell = process.env.SHELL;
  if (!shell) return undefined;
  return asShellKind(shell.slice(shell.lastIndexOf('/') + 1));
}

/* ── Wrapper scripts ─────────────────────────────────────────────────────── */

// bash and zsh share one script — `local`, `builtin`, `command`, `[ … ]`,
// `$(…)`, and `VAR=val cmd` all behave the same in both.
const POSIX_WRAPPER = `# plx shell integration — makes \`cd\` from \`plx\` change THIS shell.
# Install:  add  eval "$(plx --shell-init SHELL_KIND)"  to your ~/.SHELL_KINDrc
plx() {
  if ! command -v mktemp >/dev/null 2>&1; then
    command plx "$@"
    return $?
  fi
  local __plx_file
  __plx_file="$(mktemp "\${TMPDIR:-/tmp}/plx-cd.XXXXXX")" || { command plx "$@"; return $?; }
  ${SHELL_FILE_ENV}="$__plx_file" command plx "$@"
  local __plx_status=$?
  if [ -s "$__plx_file" ]; then
    builtin cd -- "$(cat "$__plx_file")" 2>/dev/null || :
  fi
  command rm -f "$__plx_file"
  return $__plx_status
}
`;

const FISH_WRAPPER = `# plx shell integration — makes \`cd\` from \`plx\` change THIS shell.
# Install:  add  plx --shell-init fish | source  to your ~/.config/fish/config.fish
function plx --description 'plx (with cd persistence)'
    if not command -q mktemp
        command plx $argv
        return $status
    end
    set -l __plx_tmpdir $TMPDIR
    test -n "$__plx_tmpdir"; or set __plx_tmpdir /tmp
    set -l __plx_file (mktemp $__plx_tmpdir/plx-cd.XXXXXX)
    if test -z "$__plx_file"
        command plx $argv
        return $status
    end
    env ${SHELL_FILE_ENV}=$__plx_file plx $argv
    set -l __plx_status $status
    if test -s $__plx_file
        builtin cd -- (cat $__plx_file) 2>/dev/null
    end
    command rm -f $__plx_file
    return $__plx_status
end
`;

/** Return the shell-integration wrapper text for `kind`, ready to `eval`/`source`. */
export function shellInitScript(kind: ShellKind): string {
  if (kind === 'fish') return FISH_WRAPPER;
  return POSIX_WRAPPER.replaceAll('SHELL_KIND', kind);
}

/* ── Parsing & resolving a plain `cd` command ────────────────────────────── */

/**
 * Shell metacharacters that mean "this is not a plain `cd <dir>`" — anything
 * matching goes through `plx`'s normal command flow (where, under shell
 * integration, the subshell's final `$PWD` is captured anyway, so chained forms
 * like `cd x && pull` still move your shell — they just aren't special-cased
 * here). We reject command substitution / chaining / redirection / subshells.
 */
const CD_DISQUALIFY = /[;&|<>`()\n]|\$\(/;

/** Strip one layer of matching surrounding single or double quotes. */
function unquote(token: string): string {
  if (token.length >= 2) {
    const a = token[0];
    const b = token[token.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return token.slice(1, -1);
  }
  return token;
}

/**
 * If `command` is a *pure* directory change (`cd`, `cd <dir>`, `cd -- <dir>`,
 * `cd ~`, `cd "$HOME"`, `cd -`, …) with nothing else, return the absolute target
 * directory. Otherwise return `null` — including anything with shell operators,
 * command substitution, multiple arguments, or `cd` flags other than `--`.
 *
 * `cd` / `cd ~` / `cd $HOME` / `cd ${HOME}` → home directory.
 * `cd -`                                    → `$OLDPWD` if set, else `null`.
 * `cd <relative>`                           → resolved against `process.cwd()`.
 */
export function parseCdCommand(command: string): { resolved: string } | null {
  const trimmed = command.trim();
  if (!/^cd(?:\s|$)/.test(trimmed)) return null;
  if (CD_DISQUALIFY.test(trimmed)) return null;

  let rest = trimmed.slice(2).trim();
  if (rest === '--') rest = '';
  else if (rest.startsWith('-- ')) rest = rest.slice(3).trim();

  if (rest === '' || rest === '~') return { resolved: homedir() };
  if (rest === '-') {
    const old = process.env.OLDPWD;
    return old ? { resolved: old } : null;
  }
  // More than one argument, or some other `-flag` — not a plain `cd`.
  if (/\s/.test(rest) || rest.startsWith('-')) return null;

  let target = unquote(rest);
  if (target === '' || target === '~') return { resolved: homedir() };
  if (target === '$HOME' || target === '${HOME}') return { resolved: homedir() };
  if (target.includes('$')) return null; // some other env var — can't resolve it here

  if (target === '~') target = homedir();
  else if (target.startsWith('~/')) target = resolve(homedir(), target.slice(2));

  return { resolved: isAbsolute(target) ? target : resolve(process.cwd(), target) };
}
