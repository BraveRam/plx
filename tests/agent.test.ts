/**
 * Tests for the agentic loop. The model is never called for real — every test
 * injects a scripted `turn` function, so these run offline and deterministically.
 */

import { describe, test, expect } from 'bun:test';
import type { ModelMessage } from 'ai';
import { runAgent, truncateForFeedback, DEFAULT_MAX_STEPS, type AgentTurnFn } from '../src/agent.ts';
import type { AgentStep } from '../src/schema.ts';
import type { CliOptions } from '../src/types.ts';

function makeOptions(over: Partial<CliOptions> = {}): CliOptions {
  return {
    dryRun: false,
    yes: true, // default to non-interactive so `dangerous` steps don't block
    json: false,
    model: 'test/model',
    history: false,
    agent: true,
    maxSteps: DEFAULT_MAX_STEPS,
    ...over,
  };
}

/** Turn function that replays a fixed list of steps, repeating the last one if asked again. */
function scriptedTurn(steps: AgentStep[]): AgentTurnFn {
  let i = 0;
  return async () => {
    const step = steps[Math.min(i, steps.length - 1)] as AgentStep;
    i += 1;
    return { step, responseMessages: [{ role: 'assistant', content: JSON.stringify(step) }] };
  };
}

describe('runAgent', () => {
  test('runs a command, then finishes with "done" → exit 0', async () => {
    const code = await runAgent({
      goal: 'say hi',
      options: makeOptions(),
      turn: scriptedTurn([
        {
          status: 'continue',
          thought: 'print a greeting',
          command: 'true',
          explanation: 'a no-op standing in for a real command',
          riskLevel: 'safe',
        },
        { status: 'done', thought: 'all set', summary: 'Done.' },
      ]),
    });
    expect(code).toBe(0);
  });

  test('"blocked" status → exit 1', async () => {
    const code = await runAgent({
      goal: 'do the impossible',
      options: makeOptions(),
      turn: scriptedTurn([{ status: 'blocked', thought: 'cannot', summary: 'Not possible here.' }]),
    });
    expect(code).toBe(1);
  });

  test('a deny-listed command is refused, fed back, and the agent can recover', async () => {
    let calls = 0;
    const turn: AgentTurnFn = async () => {
      calls += 1;
      const step: AgentStep =
        calls === 1
          ? { status: 'continue', thought: 'try something destructive', command: 'rm -rf /', explanation: 'wipes the root filesystem', riskLevel: 'dangerous' }
          : calls === 2
            ? { status: 'continue', thought: 'okay, behave', command: 'true', explanation: 'harmless no-op', riskLevel: 'safe' }
            : { status: 'done', thought: 'finished without doing harm', summary: 'Did nothing harmful.' };
      return { step, responseMessages: [{ role: 'assistant', content: JSON.stringify(step) }] };
    };
    const code = await runAgent({ goal: 'be naughty then nice', options: makeOptions(), turn });
    expect(code).toBe(0);
    expect(calls).toBe(3); // refused step still consumed a turn; then a real step; then done
  });

  test('an invalid "continue" step (no command) is re-asked once, then aborts', async () => {
    let calls = 0;
    const turn: AgentTurnFn = async () => {
      calls += 1;
      // Always return an invalid continue step (status continue, no command).
      const step = { status: 'continue', thought: 'I forgot the command' } as AgentStep;
      return { step, responseMessages: [{ role: 'assistant', content: JSON.stringify(step) }] };
    };
    const code = await runAgent({ goal: 'misbehave', options: makeOptions(), turn });
    expect(code).toBe(1);
    expect(calls).toBe(2); // first invalid → one re-ask → second invalid → abort (no steps consumed)
  });

  test('exhausting the step budget asks for a final summary; "done" there → exit 0', async () => {
    const maxSteps = 3;
    let calls = 0;
    const turn: AgentTurnFn = async () => {
      calls += 1;
      const step: AgentStep =
        calls > maxSteps // the (maxSteps+1)-th call is the post-loop "wrap up" request
          ? { status: 'done', thought: 'actually all done', summary: 'Completed within the limit.' }
          : { status: 'continue', thought: 'keep going', command: 'true', explanation: 'no-op', riskLevel: 'safe' };
      return { step, responseMessages: [{ role: 'assistant', content: JSON.stringify(step) }] };
    };
    const code = await runAgent({ goal: 'loop a bit', options: makeOptions({ maxSteps }), turn });
    expect(code).toBe(0);
    expect(calls).toBe(maxSteps + 1);
  });

  test('exhausting the step budget with no resolution → exit 1', async () => {
    const maxSteps = 2;
    let calls = 0;
    const turn: AgentTurnFn = async () => {
      calls += 1;
      const step: AgentStep =
        calls > maxSteps
          ? { status: 'blocked', thought: 'ran out of room', summary: "Couldn't finish in time." }
          : { status: 'continue', thought: 'still going', command: 'true', explanation: 'no-op', riskLevel: 'safe' };
      return { step, responseMessages: [{ role: 'assistant', content: JSON.stringify(step) }] };
    };
    const code = await runAgent({ goal: 'never finishes', options: makeOptions({ maxSteps }), turn });
    expect(code).toBe(1);
    expect(calls).toBe(maxSteps + 1);
  });

  test('declining a dangerous step stops the run → exit 130', async () => {
    // yes:false + a step the model marks "dangerous". In the test environment
    // stdin is not a TTY, so confirm() resolves false → the agent aborts.
    const code = await runAgent({
      goal: 'something risky',
      options: makeOptions({ yes: false }),
      turn: scriptedTurn([
        { status: 'continue', thought: 'do the risky thing', command: 'echo not-really-dangerous', explanation: 'just prints', riskLevel: 'dangerous' },
      ]),
    });
    expect(code).toBe(130);
  });

  test('a `conversation` is seeded into the run and gets a compact summary appended after', async () => {
    const conversation: ModelMessage[] = [
      { role: 'user', content: 'earlier: my name is bash' },
      { role: 'assistant', content: '{"command":"echo bash"}' },
    ];
    let sawPriorContext = false;
    const turn: AgentTurnFn = async ({ messages }) => {
      // The run should hand the model the prior turns followed by the goal.
      if (messages.some((m) => typeof m.content === 'string' && m.content.includes('earlier: my name is bash'))) {
        sawPriorContext = true;
      }
      const step: AgentStep = { status: 'done', thought: 'recalled it', summary: 'Your name is bash.' };
      return { step, responseMessages: [{ role: 'assistant', content: JSON.stringify(step) }] };
    };

    const code = await runAgent({ goal: 'what name did I tell you?', options: makeOptions(), turn, conversation });
    expect(code).toBe(0);
    expect(sawPriorContext).toBe(true);
    // The session chat now has the two original turns plus the agent exchange.
    expect(conversation.length).toBe(4);
    expect(conversation[2]).toEqual({ role: 'user', content: '[agent] what name did I tell you?' });
    expect(conversation[3]).toEqual({ role: 'assistant', content: 'Your name is bash.' });
  });
});

describe('truncateForFeedback', () => {
  test('returns short output unchanged', () => {
    expect(truncateForFeedback('hello', 100)).toBe('hello');
  });

  test('keeps the head and tail and marks how much was omitted', () => {
    const input = 'A'.repeat(50) + 'B'.repeat(50);
    const out = truncateForFeedback(input, 30);
    expect(out.length).toBeLessThan(input.length);
    expect(out.startsWith('A')).toBe(true);
    expect(out.endsWith('B')).toBe(true);
    expect(out).toContain('characters omitted');
  });
});
