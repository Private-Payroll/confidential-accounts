import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActEnded, ActingChannel, StepAt } from 'midnight-identity/profile/channel';
import type { ActRequest } from 'midnight-identity/profile/request';
import { runAction } from './run.js';
import { StepRefused, type ActionDefinition, type ActionStep, type Held } from './definition.js';

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

  it('a step that refuses ends the action naming its refusal by key and kind, in the end and the log, never its words', async () => {
    const { channel: c, ended } = channel();
    await runAction({
      definition: actionOf([
        { title: { key: 'act.step.read-it' }, run: async () => {
          throw new StepRefused({ key: 'act.move-between-vaults.why.start-owed', values: { says: SECRET_FIELD } }, 'chain-unread');
        } },
        { title: { key: 'act.step.never' }, run: async () => {} },
      ]),
      request, channel: c, held, stop: new AbortController().signal,
    });
    /* RED WHEN: the end does not carry which refusal stopped it, or of what kind. */
    expect(ended[0]).toMatchObject({ ended: 'stopped', step: 1, why: 'check-failed', refused: 'act.move-between-vaults.why.start-owed', code: 'chain-unread' });
    /* RED WHEN: the wallet's stop line does not name the refusal. */
    expect(lines).toContain('action move-between-vaults in the wallet: stopped at step 1 of 2: check-failed (relayed 0, unconfirmed 0) '
      + '(refused: act.move-between-vaults.why.start-owed chain-unread)');
    /* RED WHEN: the refusal's words' values reach the page or the log. */
    expect(JSON.stringify(ended)).not.toContain(SECRET_FIELD);
    expect(lines.join('\n')).not.toContain(SECRET_FIELD);
  });

  it('a refusal or code not in its shape, or a stop that is not a refused check, carries no refusal', async () => {
    const end = async (step: ActionStep) => {
      const { channel: c, ended } = channel();
      await runAction({ definition: actionOf([step]), request, channel: c, held, stop: new AbortController().signal });
      return ended[0]!;
    };
    const oddCode = await end({ title: { key: 'act.step.x' }, run: async () => { throw new StepRefused({ key: 'act.move-between-vaults.why.y' }, 'seat 7'); } });
    /* RED WHEN: a code not in its shape is carried. */
    expect(oddCode).toMatchObject({ why: 'check-failed', refused: 'act.move-between-vaults.why.y' });
    expect(oddCode).not.toHaveProperty('code');
    const oddKey = await end({ title: { key: 'act.step.x' }, run: async () => { throw new StepRefused({ key: 'Some words 12' }, 'z'); } });
    /* RED WHEN: a key not in its shape is carried. */
    expect(oddKey).toMatchObject({ why: 'check-failed' });
    expect(oddKey).not.toHaveProperty('refused');
    const failed = await end({ title: { key: 'act.step.x' }, run: async () => { throw new Error('no'); } });
    /* RED WHEN: a step that failed is reported as a refusal. */
    expect(failed).not.toHaveProperty('refused');
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
