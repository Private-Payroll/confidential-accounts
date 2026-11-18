import { describe, expect, it } from 'vitest';
import type { ActEnded, ActingChannel, StepAt } from 'midnight-identity/profile/channel';
import type { ActRequest } from 'midnight-identity/profile/request';
import { runAction } from './run.js';
import type { ActionDefinition, ActionStep, Held, StepContext, Words } from './definition.js';

/*
 * **THE ONE QUESTION ASKED AFTER A HAND-OVER: WHETHER TO PAY A NETWORK FEE FROM THE PERSON'S OWN DUST.** The read
 * question (`confirm`) is refused once anything was handed over; the fee question is not, is asked at most once, says
 * which question it is to the window, and answers no when the window cannot ask.
 */

const held = { identity: {}, secret: new Uint8Array(32) } as unknown as Held;
const request: ActRequest = {
  schema: 'midnight-identity/disclosure-request/v1', kind: 'act',
  requester: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'A test.', nonce: 'n1', expiresAt: Date.now() + 20 * 60_000, hearsProgress: true,
  intent: { name: 'move-between-vaults' as never, fields: {} },
};
const channel = (ended: ActEnded[]) => ({
  step: (_at: StepAt) => true,
  relay: async () => 'relayed' as const,
  answer: (a: unknown) => { ended.push(a as ActEnded); return true; },
}) as unknown as ActingChannel;
const actionOf = (steps: readonly ActionStep[]): ActionDefinition => ({
  headline: 'ask.act.headline', shown: async () => [], checks: [], check: async () => null, steps: () => steps,
});
const LINES: readonly Words[] = [{ key: 'act.private-deposit.fee.own' }];

const ranWith = async (step: (c: StepContext) => Promise<void>, window?: (lines: readonly Words[], cut: AbortSignal, asks?: 'read' | 'fee') => Promise<boolean>) => {
  const ended: ActEnded[] = [];
  await runAction({
    definition: actionOf([{ title: { key: 'x' }, run: step }]), request, channel: channel(ended), held, stop: new AbortController().signal,
    ...(window === undefined ? {} : { confirm: window }),
  });
  return ended;
};

describe('the fee question comes after a hand-over, once', () => {
  it('after a relay the fee is asked, as the fee question, and the person\'s answer is the step\'s', async () => {
    const asked: Array<{ lines: readonly Words[]; asks: string | undefined }> = [];
    const answers: boolean[] = [];
    const ended = await ranWith(async (c) => {
      await c.relay('AAAA');
      answers.push(await c.confirmFee!(LINES));
    }, async (lines, _cut, asks) => { asked.push({ lines, asks }); return true; });
    /* RED WHEN: the fee question is refused after a hand-over, as the read question is, or the window is not told which question it shows. */
    expect(asked).toEqual([{ lines: LINES, asks: 'fee' }]);
    expect(answers).toEqual([true]);
    expect(ended).toEqual([expect.objectContaining({ ended: 'done' })]);
  });

  it('a second fee question is answered no without asking, and Stop in the window is a no', async () => {
    let asks = 0;
    const answers: boolean[] = [];
    await ranWith(async (c) => {
      answers.push(await c.confirmFee!(LINES));
      answers.push(await c.confirmFee!(LINES));
    }, async () => { asks += 1; return false; });
    /* RED WHEN: the person is asked to pay a fee from their DUST twice in one action, or a Stop is read as yes. */
    expect(asks).toBe(1);
    expect(answers).toEqual([false, false]);
  });

  it('a window that cannot ask answers no', async () => {
    const answers: boolean[] = [];
    await ranWith(async (c) => { answers.push(await c.confirmFee!(LINES)); });
    /* RED WHEN: with no window to ask, the fee is taken as confirmed. */
    expect(answers).toEqual([false]);
  });

  it('the read question is still refused after a hand-over', async () => {
    let asks = 0;
    const ended = await ranWith(async (c) => {
      await c.relay('AAAA');
      await c.confirm(LINES);
    }, async () => { asks += 1; return true; });
    /* RED WHEN: the fee question's room after a hand-over lets the read question in too. */
    expect(asks).toBe(0);
    expect(ended).toEqual([expect.objectContaining({ ended: 'stopped' })]);
  });
});
