/**
 * The REPL's session-scoped chat context.
 *
 * In the interactive REPL, lines (one-shot requests *and* agent goals) share an
 * in-memory `ModelMessage[]` so follow-ups have context — "now delete them",
 * "that failed, try X", "you remember the name I gave you?". It's in-memory
 * only: never written to disk, dropped on exit, and wiped by `/clear`.
 *
 * One-shot lines append their full request/plan/outcome turns; an agent run
 * appends just a compact `[agent] <goal>` → `<final summary>` pair (its
 * step-by-step internals stay inside that run). Either way the list is capped so
 * a long session doesn't balloon token cost — oldest turns drop off the front.
 */

import type { ModelMessage } from 'ai';

/** Maximum messages kept in a REPL session's chat context (oldest dropped when over). */
export const MAX_CHAT_MESSAGES = 24;

/** Append `messages` to `conversation` (a no-op if it's `undefined`) and trim to {@link MAX_CHAT_MESSAGES}. */
export function pushChat(conversation: ModelMessage[] | undefined, ...messages: ModelMessage[]): void {
  if (!conversation || messages.length === 0) return;
  conversation.push(...messages);
  while (conversation.length > MAX_CHAT_MESSAGES) conversation.shift();
}
