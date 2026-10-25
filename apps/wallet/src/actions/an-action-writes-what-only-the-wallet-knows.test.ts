import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActEnded, ActingChannel, StepAt } from 'midnight-identity/profile/channel';
import type { ActRequest } from 'midnight-identity/profile/request';
import { runAction } from './run.js';
import type { ActionDefinition, ActionStep, Held } from './definition.js';

/*
 * **WHAT ONLY THE WALLET KNOWS OF AN ACTION, WRITTEN TO THE CONSOLE REPORT.** The page sees step numbers and stop
 * reasons; the title of the step that started and the message of what a step threw stay in the wallet, so the runner
 * writes them to its own console, which a development build's console report carries to the service's log.
 */

const START = 1_755_000_000_000;
const SECRET_FIELD = 'hidden-ostrich-word';
const SECRET_TRANSACTION = 'UExBTlRFRC1TRUNSRVQtVFg=';
const held = { identity: {}, secret: new Uint8Array(32).fill(7) } as unknown as Held;

const request: ActRequest = {
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'act',
  requester: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'A test.',
  nonce: 'n1',
  expiresAt: START + 20 * 60_000,
  hearsProgress: true,
  intent: { name: 'move-between-vaults' as never, fields: { memo: SECRET_FIELD } },
};

const channel = (): { channel: ActingChannel; ended: ActEnded[] } => {
  const ended: ActEnded[] = [];
  return {
    ended,
    channel: {
      step: (_at: StepAt) => true,
      relay: async () => 'relayed',
      answer: (a: unknown) => { ended.push(a as ActEnded); return true; },
    } as unknown as ActingChannel,
  };
};
const actionOf = (steps: readonly ActionStep[]): ActionDefinition => ({
  headline: 'ask.act.headline', shown: async () => [], checks: [], check: async () => null, steps: () => steps,
});

let lines: string[] = [];
const warnWas = console.warn;
beforeEach(() => {
  vi.useFakeTimers({ now: START });
  vi.stubEnv('VITE_DEV_ERROR_SINK', '1');
  lines = [];
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
});
afterEach(() => {
  console.warn = warnWas;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('an action writes what only the wallet knows of it to the console report', () => {
  it('each step\'s title as it starts, the message a step threw, and the stop with its step and reason', async () => {
    const { channel: c, ended } = channel();
    await runAction({
      definition: actionOf([
        { title: { key: 'act.step.build-the-account' }, run: async (s) => { await s.relay(SECRET_TRANSACTION); } },
        { title: { key: 'act.step.send-it' }, run: async () => { throw new Error('the prover did not answer'); } },
        { title: { key: 'act.step.never' }, run: async () => {} },
      ]),
      request, channel: c, held, stop: new AbortController().signal,
    });
    expect(ended[0]).toMatchObject({ ended: 'stopped', step: 2, why: 'step-failed' });
    /* RED WHEN: a step's title is not written as the step starts. */
    expect(lines).toContain('action move-between-vaults in the wallet: step 1 of 3 started: act.step.build-the-account');
    expect(lines).toContain('action move-between-vaults in the wallet: step 2 of 3 started: act.step.send-it');
    /* RED WHEN: what a step threw is kept from the log, so a failed step says only "step-failed". */
    expect(lines).toContain('action move-between-vaults in the wallet: step 2 of 3 threw: Error: the prover did not answer');
    /* RED WHEN: the end is not written with its step, its reason and its counts. */
    expect(lines).toContain('action move-between-vaults in the wallet: stopped at step 2 of 3: step-failed (relayed 1, unconfirmed 0)');
    /* RED WHEN: a line carries the action's fields or a transaction the wallet built. */
    expect(lines.join('\n')).not.toContain(SECRET_FIELD);
    expect(lines.join('\n')).not.toContain(SECRET_TRANSACTION);
  });

  it('writes nothing outside a development build with the console report on', async () => {
    vi.stubEnv('VITE_DEV_ERROR_SINK', '');
    const { channel: c } = channel();
    await runAction({
      definition: actionOf([{ title: { key: 'act.step.x' }, run: async () => { throw new Error('no'); } }]),
      request, channel: c, held, stop: new AbortController().signal,
    });
    /* RED WHEN: the wallet writes an action's lines to the console when the console report is not on. */
    expect(lines).toEqual([]);
  });
});
