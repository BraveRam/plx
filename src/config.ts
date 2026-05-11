/**
 * User-global config for `plx`.
 *
 * `plx` is meant to be run from anywhere (you `cd` around with it), but Bun only
 * auto-loads a `.env` from the *current* directory. So a project-local `.env`
 * with your `AI_GATEWAY_API_KEY` works inside that project and nowhere else.
 *
 * To fix that, `plx` also reads `KEY=value` lines from a fixed user-global file
 * — `$XDG_CONFIG_HOME/plx/.env` (i.e. `~/.config/plx/.env` by default) — on
 * startup. The real environment and a cwd-local `.env` still take precedence;
 * the global file only fills in keys that aren't already set. (Exporting the var
 * in your shell config works too, and wins over everything.)
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Path to `plx`'s optional user-global config file (`.env` syntax). */
export const GLOBAL_CONFIG_PATH = join(
  process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), '.config'),
  'plx',
  '.env',
);

/** Strip one layer of matching surrounding single or double quotes. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const a = value[0];
    const b = value[value.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return value.slice(1, -1);
  }
  return value;
}

/**
 * Load `KEY=value` lines from `path` (default {@link GLOBAL_CONFIG_PATH}) into
 * `process.env` — but only for keys that aren't already set, so the real
 * environment and a cwd-local `.env` always win. Comment (`#`) and blank lines
 * are ignored, as are lines without a valid `KEY=`. Best-effort: a missing or
 * unreadable file is silently ignored. Returns the names of the keys it set.
 */
export function loadGlobalConfig(path: string = GLOBAL_CONFIG_PATH): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const applied: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // already set — don't override

    process.env[key] = unquote(line.slice(eq + 1).trim());
    applied.push(key);
  }
  return applied;
}
