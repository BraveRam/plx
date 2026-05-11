/**
 * Local command safety layer for the `plx` CLI.
 *
 * ## The model
 *
 * `plx` turns natural language into shell commands using an LLM and then runs
 * the result through *this* layer before anything touches a real shell. There
 * are four gates, applied in order:
 *
 * 1. **Deny-list (absolute backstop).** `DENY_PATTERNS` is a hard wall of
 *    regexes for commands that are catastrophic and effectively never what the
 *    user wants from a terminal assistant (`rm -rf /`, `mkfs`, `dd` onto a raw
 *    block device, fork bombs, piping a downloaded script into a shell, …). A
 *    match means `allowed: false`. This is **completely independent of the LLM
 *    and of `--yes`** — there is no flag, no prompt, and no model "risk" rating
 *    that can override it. If the model hallucinates a destructive command, the
 *    deny-list is what stops it.
 *
 * 2. **Always-confirm list.** `CONFIRM_PATTERNS` matches commands that change
 *    the machine's *power or session state* — `shutdown`, `reboot`, `halt`,
 *    `poweroff`, `init 0/6`, suspend/hibernate, logging out, and locking the
 *    screen. These are perfectly legitimate to ask for, so they are **allowed**
 *    — but `evaluateSafety` reports `forceConfirm: true`, and the caller must
 *    prompt before running them no matter what `riskLevel` the model assigned
 *    (a screen lock might be rated `safe`, but you still want to be asked).
 *    `--yes` skips this prompt like any other.
 *
 * 3. **Allow-list (skip the confirmation prompt).** `SAFE_COMMAND_PREFIXES`
 *    lists first words of commands that are read-only by nature (`ls`, `cat`,
 *    `grep`, `df`, `pwd`, …). When the command's "head" is on this list *and*
 *    the command contains no shell metacharacters that could chain or redirect
 *    to something dangerous, `evaluateSafety` reports `autoSafe: true` and the
 *    caller is free to run it without asking. `find . | xargs rm -f` starts
 *    with `find`, but the pipe means it is **not** auto-safe.
 *
 * 4. **Confirmation (everything else).** Any command that is neither denied,
 *    nor force-confirm, nor auto-safe comes back as
 *    `{ allowed: true, autoSafe: false, forceConfirm: false }`. The caller
 *    shows it to the user and decides whether to ask based on the model's
 *    `riskLevel` — unless `--yes` was passed. `--yes` only bypasses gates 2–4;
 *    it can never resurrect a deny-listed command.
 *
 * In short: the deny-list is a safety net, not a security boundary — a
 * determined user can always obfuscate their way around regexes — but it
 * reliably catches the "the AI did something insane" and "I fat-fingered a
 * suggestion" cases, which is exactly the threat model for a tool like this.
 *
 * ### Note on command-position anchoring
 *
 * Several patterns (`shutdown`, `reboot`, `systemctl poweroff`, …) anchor the
 * keyword to a *command position* — the start of the string, or immediately
 * after a `;`, `&&`, `||`, `|`, or `(` — rather than matching the bare word
 * anywhere. This is deliberate: `echo "shutdown the server"` is a harmless echo
 * of a string and must stay un-flagged, while `echo hi; shutdown -h now` must
 * be caught. The `CMD_POS` helper below builds that prefix.
 */

import type { SafetyVerdict } from './types.ts';

/**
 * Regex fragment matching a "command position": either the very start of the
 * string, or just after a shell separator/opener (`;`, `&&`, `||`, `|`, `(`),
 * with optional surrounding whitespace. Used to anchor dangerous keywords so we
 * don't false-positive on the same word appearing inside a quoted argument.
 *
 * It is written as a non-capturing group so callers can drop it straight into a
 * larger pattern: `new RegExp(CMD_POS + 'shutdown\\b', 'i')`.
 */
const CMD_POS = '(?:^|[;&|(])\\s*(?:sudo\\s+)?';

/* ── `rm` flag forms (short bundles or long forms), used in the deny patterns ──
 * Quantifiers are bounded so the lookaheads they sit in can't backtrack
 * catastrophically (and the schema caps the command at ~2000 chars anyway). */
/** A short flag bundle containing `r`, or `--recursive`: `-r`, `-rv`, `-fr`, `--recursive`. */
const RM_RECURSIVE = '(?:-[a-z]{0,15}r[a-z]{0,15}|--recursive)\\b';
/** A short flag bundle containing `f`, or `--force`. */
const RM_FORCE = '(?:-[a-z]{0,15}f[a-z]{0,15}|--force)\\b';
/** A single short bundle containing both: `-rf`, `-fr`, `-rfv`, `-vfr`, … */
const RM_RF = '-[a-z]{0,15}(?:rf|fr)[a-z]{0,15}\\b';
/** Lookahead (placed right after `\brm\b`) asserting recursive+force flags follow. */
const RM_RECURSIVE_FORCE =
  `(?=\\s+(?:${RM_RF}|${RM_RECURSIVE}[^\\n]{0,200}\\s+${RM_FORCE}|${RM_FORCE}[^\\n]{0,200}\\s+${RM_RECURSIVE}))`;

/**
 * Patterns that are NEVER allowed to run — refused even with `--yes`.
 *
 * These are the "catastrophic and effectively never what you want" cases:
 * wiping the root filesystem or home directory, formatting a disk, raw block
 * device writes, fork bombs, nuking permissions/ownership of `/`, moving things
 * into oblivion, and piping a downloaded script straight into a shell. Things
 * that are *drastic but legitimate* (rebooting, shutting down, locking the
 * screen, suspending) are NOT here — see {@link CONFIRM_PATTERNS}.
 *
 * Every regex is case-insensitive and deliberately avoids the `/g` flag so it
 * carries no `lastIndex` state between calls. The accompanying `reason` is
 * short, human-readable, and safe to print directly to a terminal.
 */
export const DENY_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // --- control / escape characters --------------------------------------
  {
    // Refuses raw control/escape bytes — they enable terminal-spoofing tricks
    // (a `\r` or ESC sequence that makes the rendered command differ from what
    // bash runs). Tab (0x09) and newline (0x0a) are allowed: they appear
    // legitimately in here-docs and multi-line commands, and can't spoof a line.
    pattern: /[\x00-\x08\x0b-\x1f\x7f-\x9f]/,
    reason: 'Refuses commands containing control or escape characters (other than tab/newline) — terminal-spoofing risk.',
  },

  // --- rm -rf / and friends ---------------------------------------------
  // `rm` with recursive+force flags (short bundles, separate short flags, or the
  // `--recursive`/`--force` long forms) targeting `/`, `/*`, or the literal home
  // directory (`~`, `~/`, `$HOME`, `${HOME}`). A specific subdirectory like
  // `rm -rf ./build` or `rm -rf ~/Downloads/junk` is NOT denied here — it goes
  // through the normal confirmation gate.
  {
    pattern: new RegExp(`\\brm\\b${RM_RECURSIVE_FORCE}[^\\n]{0,300}\\s\\/(?=\\s|$)`, 'i'),
    reason: 'Refuses to recursively force-delete the root filesystem (`rm -rf /`).',
  },
  {
    pattern: new RegExp(`\\brm\\b${RM_RECURSIVE_FORCE}[^\\n]{0,300}\\s\\/\\*(?=\\s|$)`, 'i'),
    reason: 'Refuses to recursively force-delete everything under root (`rm -rf /*`).',
  },
  {
    pattern: new RegExp(
      `\\brm\\b${RM_RECURSIVE_FORCE}[^\\n]{0,300}\\s(?:~|\\$HOME|\\$\\{HOME\\})\\/?(?=\\s|$)`,
      'i',
    ),
    reason: 'Refuses to recursively force-delete your home directory (`rm -rf ~`).',
  },
  {
    pattern: /--no-preserve-root\b/i,
    reason: 'Refuses commands that disable the `--preserve-root` safeguard.',
  },

  // --- filesystem creation / raw devices --------------------------------
  {
    pattern: /\bmkfs(?:\.[A-Za-z0-9_-]+)?\b/i,
    reason: 'Refuses to create a new filesystem (`mkfs`) — this destroys data.',
  },
  {
    // `dd ... of=/dev/<block device>`
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd|vd|mmcblk|disk|loop)[A-Za-z0-9]*\b/i,
    reason: 'Refuses `dd` writing directly to a block device — this destroys data.',
  },
  {
    // Output redirection (> or >>) to a raw block device.
    pattern: />>?\s*\/dev\/(?:sd|nvme|hd|vd|mmcblk|disk)[A-Za-z0-9]*\b/i,
    reason: 'Refuses to redirect output onto a raw block device.',
  },

  // --- fork bomb --------------------------------------------------------
  {
    // Classic `:(){ :|:& };:` with arbitrary whitespace between tokens.
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: 'Refuses the classic fork-bomb pattern.',
  },
  {
    // Generic detector: a shell function whose body pipes itself into a
    // backgrounded copy of itself — i.e. `name(){ name|name& };name`.
    pattern: /([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*;?\s*\}\s*;\s*\1\b/,
    reason: 'Refuses a self-replicating fork-bomb-style function definition.',
  },

  // --- permission / ownership nukes -------------------------------------
  {
    pattern: /\bchmod\b[^\n]*\s-[A-Za-z]*R[A-Za-z]*\b[^\n]*\s0?777\s+\/(?=\s|$)/i,
    reason: 'Refuses a recursive `chmod 777` on the root filesystem.',
  },
  {
    pattern: /\bchown\b[^\n]*\s-[A-Za-z]*R[A-Za-z]*\b[^\n]*\s\/(?=\s|$)/i,
    reason: 'Refuses a recursive `chown` of the root filesystem.',
  },

  // --- moving things into oblivion / moving root ------------------------
  {
    pattern: /\bmv\b[^\n]+\s\/dev\/null(?=\s|$)/i,
    reason: 'Refuses to `mv` a path into `/dev/null` (this destroys it).',
  },
  {
    pattern: /\bmv\b\s+\/\*(?=\s)/i,
    reason: 'Refuses to move the contents of the root filesystem.',
  },

  // --- pipe-to-shell from the network -----------------------------------
  {
    pattern: /\b(?:curl|wget)\b[^\n]*\|[^\n]*\b(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh)\b/i,
    reason: 'Refuses to pipe a downloaded script straight into a shell.',
  },
];

/**
 * Patterns for commands that change the machine's **power or session state** —
 * allowed to run, but always behind a confirmation prompt (regardless of the
 * model's `riskLevel`), unless `--yes` is passed. This is the home for
 * `shutdown`/`reboot`/`halt`/`poweroff`, `init 0/6`, suspend/hibernate, logging
 * out, locking the screen, and a few other "drastic but legitimate" actions
 * such as force-pushing a git remote.
 *
 * The power/runlevel keywords are command-position anchored ({@link CMD_POS})
 * so `echo "reboot the box"` is not flagged but `echo hi && reboot` is. The
 * dedicated tools (screen lockers, `pmset`, …) are matched by name; there is no
 * legitimate reason a generated command would mention `swaylock`/`pm-suspend`
 * etc. except to run them.
 */
export const CONFIRM_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    // `git push --force` / `-f` / `--force-with-lease` / `--mirror` / `--delete`
    // — rewrites or destroys refs on a remote. (`git push origin main` is fine.)
    pattern: /\bgit\s+push\b[^\n]*?(?:--force\b|--mirror\b|--delete\b|(?:^|\s)-[a-z]*f[a-z]*\b)/i,
    reason: 'This force-pushes, mirrors, or deletes a branch on a git remote (rewrites/destroys remote history).',
  },
  {
    pattern: new RegExp(CMD_POS + '(?:shutdown|reboot|halt|poweroff)\\b', 'i'),
    reason: 'This will shut down, reboot, or halt the machine.',
  },
  {
    pattern: new RegExp(CMD_POS + '(?:tel)?init\\s+[06]\\b', 'i'),
    reason: 'This changes the runlevel to halt/reboot (`init 0` / `init 6`).',
  },
  {
    pattern:
      /\bsystemctl\b[^\n]*\b(?:poweroff|reboot|halt|kexec|emergency|rescue|suspend|hibernate|hybrid-sleep|suspend-then-hibernate)\b/i,
    reason: 'This runs a `systemctl` power/sleep target (poweroff, reboot, suspend, …).',
  },
  {
    pattern:
      /\bloginctl\b[^\n]*\b(?:poweroff|reboot|halt|suspend|hibernate|hybrid-sleep|suspend-then-hibernate|lock-sessions?|terminate-sessions?|kill-sessions?|terminate-user)\b/i,
    reason: 'This runs a `loginctl` power/session action (lock, log out, suspend, reboot, …).',
  },
  {
    pattern: new RegExp(CMD_POS + '(?:pm-suspend|pm-hibernate|pm-suspend-hybrid|rtcwake|zzz|ZZZ|acpitool)\\b', 'i'),
    reason: 'This suspends or hibernates the machine.',
  },
  {
    pattern: new RegExp(
      CMD_POS +
        '(?:swaylock|i3lock|slock|sxlock|xlock|xtrlock|sflock|hyprlock|gtklock|waylock|betterlockscreen|physlock|vlock|tlock)\\b',
      'i',
    ),
    reason: 'This locks the screen.',
  },
  { pattern: new RegExp(CMD_POS + 'xdg-screensaver\\s+lock\\b', 'i'), reason: 'This locks the screen.' },
  {
    pattern: new RegExp(CMD_POS + 'gnome-screensaver-command\\s+(?:-l\\b|--lock\\b|-a\\b|--activate\\b)', 'i'),
    reason: 'This locks the screen.',
  },
  { pattern: new RegExp(CMD_POS + 'dm-tool\\s+lock\\b', 'i'), reason: 'This locks the screen.' },
  { pattern: new RegExp(CMD_POS + 'light-locker-command\\s+(?:-l\\b|--lock\\b)', 'i'), reason: 'This locks the screen.' },
  { pattern: new RegExp(CMD_POS + 'xset\\s+s\\s+activate\\b', 'i'), reason: 'This activates the screensaver / locks the screen.' },
  { pattern: /\bqdbus\b[^\n]*\borg\.freedesktop\.ScreenSaver\b/i, reason: 'This locks the screen via the ScreenSaver D-Bus service.' },
  { pattern: new RegExp(CMD_POS + 'gnome-session-quit\\b', 'i'), reason: 'This logs out / ends the desktop session.' },
  { pattern: /\bCGSession\b[^\n]*\s-suspend\b/i, reason: 'This locks the screen (macOS).' },
  {
    pattern: new RegExp(CMD_POS + 'pmset\\b[^\n]*\\b(?:displaysleepnow|sleepnow|sleep)\\b', 'i'),
    reason: 'This puts the machine or display to sleep (macOS) — typically locking the screen.',
  },
];

/**
 * First command word ("head") of commands considered read-only / always safe.
 *
 * Membership here is a *necessary* condition for `autoSafe: true`, not a
 * sufficient one — see `evaluateSafety` for the metacharacter check that also
 * has to pass. Notably absent: `git`, `rm`, `mv`, `cp`, `kill`, `chmod`,
 * `chown`, `dd`, `tar`, `curl`, `wget` — all of those can mutate state.
 */
export const SAFE_COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  'ls',
  'find',
  'cat',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ps',
  'df',
  'du',
  'pwd',
  'whoami',
  'id',
  'date',
  'echo',
  'printf',
  'wc',
  'stat',
  'file',
  'which',
  'type',
  'uname',
  'hostname',
  'uptime',
  'tree',
  'sort',
  'uniq',
  'basename',
  'dirname',
  'realpath',
  'env',
]);

/** Shell control / redirection metacharacters that disqualify `autoSafe`. */
const UNSAFE_META = /[;|&<>$`\n]|\$\(/;

/** `true` when the token looks like a leading `VAR=value` environment assignment. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Strip any leading path component from a command word: `/bin/ls` -> `ls`. */
function basename(token: string): string {
  const slash = token.lastIndexOf('/');
  return slash === -1 ? token : token.slice(slash + 1);
}

/**
 * Find the "head" command word of `trimmed`:
 *  - skip leading `VAR=value` environment assignments,
 *  - skip a single bare leading `sudo`, `command`, or `env` token (but not
 *    `env VAR=...` — we keep this simple and only skip a bare `env`),
 *  - basename whatever comes next.
 *
 * Returns `''` if there is nothing left.
 */
function headCommand(trimmed: string): string {
  const tokens = trimmed.split(/\s+/);
  let i = 0;

  // Skip leading env assignments.
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i]!)) i++;

  // Optionally skip ONE bare sudo/command/env wrapper. For `env`, only skip it
  // if the *next* token is not itself a VAR=value form.
  const wrapper = tokens[i];
  if (wrapper === 'sudo' || wrapper === 'command') {
    i++;
  } else if (wrapper === 'env' && !(tokens[i + 1] && ENV_ASSIGNMENT.test(tokens[i + 1]!))) {
    i++;
  }

  // Skip env assignments that may follow the wrapper (e.g. `sudo VAR=x cmd`).
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i]!)) i++;

  const head = tokens[i];
  return head ? basename(head) : '';
}

/** Test a list of `{ pattern }` entries against `text`, returning the first match's entry. */
function firstMatch(
  entries: ReadonlyArray<{ pattern: RegExp; reason: string }>,
  text: string,
): { pattern: RegExp; reason: string } | undefined {
  for (const entry of entries) {
    // Defensive: these regexes are not global, but reset anyway in case one ever
    // gains a /g or /y flag.
    entry.pattern.lastIndex = 0;
    if (entry.pattern.test(text)) return entry;
  }
  return undefined;
}

/**
 * Run a command string through the safety gates.
 *
 * See the file-level doc comment for the full model. Summary:
 *  - empty                          -> `{ allowed: false, reason, autoSafe: false, forceConfirm: false }`
 *  - matches a deny pattern         -> `{ allowed: false, reason, autoSafe: false, forceConfirm: false }`
 *  - matches a confirm pattern      -> `{ allowed: true,  reason, autoSafe: false, forceConfirm: true  }`
 *  - head read-only, no metachars   -> `{ allowed: true,          autoSafe: true,  forceConfirm: false }`
 *  - otherwise                      -> `{ allowed: true,          autoSafe: false, forceConfirm: false }`
 */
export function evaluateSafety(command: string): SafetyVerdict {
  const trimmed = command.trim();
  if (trimmed === '') {
    return { allowed: false, reason: 'Empty command.', autoSafe: false, forceConfirm: false };
  }

  const denied = firstMatch(DENY_PATTERNS, trimmed);
  if (denied) {
    return { allowed: false, reason: denied.reason, autoSafe: false, forceConfirm: false };
  }

  const mustConfirm = firstMatch(CONFIRM_PATTERNS, trimmed);
  if (mustConfirm) {
    return { allowed: true, reason: mustConfirm.reason, autoSafe: false, forceConfirm: true };
  }

  const head = headCommand(trimmed);
  const autoSafe = head !== '' && SAFE_COMMAND_PREFIXES.has(head) && !UNSAFE_META.test(trimmed);

  return { allowed: true, autoSafe, forceConfirm: false };
}
