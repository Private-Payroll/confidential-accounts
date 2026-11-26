import { describe, expect, it, vi } from 'vitest';
import type { ActEnded, ActingChannel, StepAt } from 'midnight-identity/profile/channel';
import type { ActRequest } from 'midnight-identity/profile/request';
import { DEADLINE_MARGIN_MS, REGISTRY_WRITE_MS, runAction } from './run.js';
import type { ActionStep, Held, StepContext } from './definition.js';

/*
 * **THE REGISTRY WRITE A STEP NAMES OWED RUNS ONCE, AFTER THE LAST STEP AND BEFORE THE END IS ANSWERED, AND NOTHING IT
 * DOES CHANGES HOW THE ACTION ENDS**: a write that throws, that the person declines, or that runs past its time ends
 * the action exactly as it would have ended without it.
 */

const held = { identity: {}, secret: new Uint8Array(32) } as unknown as Held;
const requestUntil = (expiresAt: number): ActRequest => ({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'act',
  requester: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'A test.', nonce: 'n1', expiresAt, hearsProgress: true,
  intent: { name: 'move-between-vaults' as never, fields: {} },
});

const ranWith = async (steps: readonly ActionStep[], expiresAt = Date.now() + 20 * 60_000, said = true) => {
  const order: string[] = [];
  const ended: ActEnded[] = [];
  const channel = {
    step: (_at: StepAt) => true,
    relay: async () => 'relayed' as const,
    answer: (a: unknown) => { order.push('answered'); ended.push(a as ActEnded); return true; },
  } as unknown as ActingChannel;
  await runAction({
    definition: { headline: 'ask.act.headline', shown: async () => [], checks: [], check: async () => null, steps: () => steps },
    request: requestUntil(expiresAt), channel, held, stop: new AbortController().signal,
    confirm: async () => said,
  });
  return { order, ended };
};
const stepOwing = (order: string[], write: (c: StepContext) => Promise<void>): ActionStep => ({
  title: { key: 'x' },
  run: async (c) => { order.push('step'); c.registryEntryOwed!(write); },
});

describe('the registry write owed after the steps', () => {
  it('runs once, after the last step and before the end is answered', async () => {
    const order: string[] = [];
    let ran = 0;
    const { order: seen, ended } = await ranWith([
      stepOwing(order, async () => { ran += 1; order.push('write'); }),
      { title: { key: 'y' }, run: async () => { order.push('last step'); } },
    ]);
    /* RED WHEN: the write runs before the steps end, more than once, or after the end is answered. */
    expect(ran).toBe(1);
    expect([...order, ...seen]).toEqual(['step', 'last step', 'write', 'answered']);
    expect(ended).toEqual([expect.objectContaining({ ended: 'done', steps: 2 })]);
  });

  it('a write that throws, or that the person declines, ends the action done all the same', async () => {
    const order: string[] = [];
    /* RED WHEN: a write that throws stops the action, or changes what its end says. */
    const threw = await ranWith([stepOwing(order, async () => { throw new Error('the registry could not be read'); })]);
    expect(threw.ended).toEqual([expect.objectContaining({ ended: 'done', steps: 1, unconfirmed: 0 })]);
    /* RED WHEN: a no to the fee in the window stops the action. */
    const declined = await ranWith([stepOwing(order, async (c) => { await c.confirmFee!([{ key: 'act.fee.own-offer' }]); })], undefined, false);
    expect(declined.ended).toEqual([expect.objectContaining({ ended: 'done', steps: 1 })]);
  });

  it('a write that runs past its time is left owed, and the action ends done without waiting for it', async () => {
    const order: string[] = [];
    const started = Date.now();
    /* The ask runs out just after the margin, so the write has a moment and no more. */
    const { ended } = await ranWith([stepOwing(order, () => new Promise<void>(() => undefined))], Date.now() + DEADLINE_MARGIN_MS + 300);
    /* RED WHEN: a write that never ends holds the action's end up, or ends it as stopped. */
    expect(ended).toEqual([expect.objectContaining({ ended: 'done', steps: 1 })]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a write that never ends is let go at its own time limit, well inside the ask\'s deadline', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      let ended: ActEnded[] | null = null;
      void ranWith([stepOwing(order, () => new Promise<void>(() => undefined))]).then((r) => { ended = r.ended; });
      await vi.advanceTimersByTimeAsync(REGISTRY_WRITE_MS + 1_000);
      /* RED WHEN: the write is waited for until the ask's own deadline, twenty minutes away, rather than its time limit. */
      expect(ended).toEqual([expect.objectContaining({ ended: 'done', steps: 1 })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks the registry write\'s fee on its own, whatever the steps were answered', async () => {
    const order: string[] = [];
    let asks = 0;
    const answers: boolean[] = [];
    await (async () => {
      const ended: ActEnded[] = [];
      await runAction({
        definition: {
          headline: 'ask.act.headline', shown: async () => [], checks: [], check: async () => null,
          steps: () => [{
            title: { key: 'x' },
            run: async (c) => {
              await c.relay('AAAA');
              answers.push(await c.confirmFee!([{ key: 'act.fee.own-offer' }], 10n));
              c.registryEntryOwed!(async (w) => { order.push('write'); answers.push(await w.confirmFee!([{ key: 'act.fee.own-offer' }], 1n)); });
            },
          }],
        },
        request: requestUntil(Date.now() + 20 * 60_000),
        channel: { step: () => true, relay: async () => 'relayed' as const, answer: (a: unknown) => { ended.push(a as ActEnded); return true; } } as unknown as ActingChannel,
        held, stop: new AbortController().signal, confirm: async () => { asks += 1; return true; },
      });
    })();
    /* RED WHEN: the registry write's fee is paid on the steps' yes, without its own question and fee shown. */
    expect(order).toEqual(['write']);
    expect(asks).toBe(2);
    expect(answers).toEqual([true, true]);
  });

  it('is not run when the action stops before its steps have all passed', async () => {
    const order: string[] = [];
    let ran = 0;
    const { ended } = await ranWith([
      stepOwing(order, async () => { ran += 1; }),
      { title: { key: 'y' }, run: async () => { throw new Error('the second step failed'); } },
    ]);
    /* RED WHEN: a write is made for an action that did not finish its steps. */
    expect(ran).toBe(0);
    expect(ended).toEqual([expect.objectContaining({ ended: 'stopped' })]);
  });
});
