import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOST_ACT_STEPS } from 'midnight-identity/profile/channel';
import type { ActEnded, ActingChannel, Relayed, StepAt } from 'midnight-identity/profile/channel';
import type { ActRequest } from 'midnight-identity/profile/request';
import { DEADLINE_MARGIN_MS, HEARTBEAT_MS, RELAY_PATIENCE_MS, runAction } from './run.js';
import type { ActionDefinition, ActionStep, Held } from './definition.js';
import { StepRefused } from './definition.js';

/*
 * **AN ACTION KEEPS ITS OWN LIMITS, WHATEVER THE PAGE DOES.** The runner is driven here on a clock the test moves,
 * over a channel that records what the wallet would post: it says its step on a clock while a step builds, stops at
 * its own deadline, stops when the page does not answer a transaction in time, and builds nothing when a check after
 * the passkey does not hold.
 */

const START = 1_755_000_000_000;
const held = { identity: {}, secret: new Uint8Array(32) } as unknown as Held;

const request = (minutes = 20): ActRequest => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'act',
  requester: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'A test.',
  nonce: 'n1',
  expiresAt: START + minutes * 60_000,
  hearsProgress: true,
  intent: { name: 'move-between-vaults' as never, fields: {} },
});

const channelThat = (answer: (n: number) => Promise<Relayed | 'gone'>) => {
  const said: StepAt[] = [];
  const ended: ActEnded[] = [];
  let n = 0;
  const channel = {
    step: (at: StepAt) => { said.push(at); return true; },
    relay: () => answer((n += 1)),
    answer: (a: unknown) => { ended.push(a as ActEnded); return true; },
  } as unknown as ActingChannel;
  return { channel, said, ended };
};

const actionOf = (steps: readonly ActionStep[], check: ActionDefinition['check'] = async () => null): ActionDefinition => ({
  headline: 'ask.act.headline', shown: async () => [], checks: [], check, steps: () => steps,
});
const never = (): Promise<void> => new Promise(() => {});

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

const handedOver = () => {
  const answers: Array<(r: Relayed) => void> = [];
  const { channel, said, ended } = channelThat(() => new Promise((resolve) => { answers.push(resolve); }));
  return { channel, said, ended, answers };
};
const turn = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

describe('a transaction the page refuses or does not answer stops the action, whatever the step does', () => {
  it('a step that catches a refusal and hands over another is stopped at that step, and nothing more goes', async () => {
    const { channel, ended, answers } = handedOver();
    const tried: string[] = [];
    const done = runAction({
      definition: actionOf([
        {
          title: { key: 'x' },
          run: async (c) => {
            try { await c.relay('AAAA'); } catch { tried.push('caught'); }
            try { await c.relay('BBBB'); } catch { tried.push('caught again'); }
          },
        },
        { title: { key: 'y' }, run: async (c) => { await c.relay('CCCC'); } },
      ]),
      request: request(), channel, held, stop: new AbortController().signal,
    });
    await turn();
    answers[0]!('refused');
    const end = await done;
    /* RED WHEN: after a refusal the next transaction is handed over because the step caught the error. */
    expect(answers).toHaveLength(1);
    expect(tried).toEqual(['caught', 'caught again']);
    /* RED WHEN: a step that swallowed the refusal is counted as finished and the action runs on, or ends done. */
    expect(end.ended).toMatchObject({ ended: 'stopped', why: 'relay-refused', step: 1, steps: 2, relayed: 0 });
    expect(ended).toHaveLength(1);
  });

  it('a step that says why its refused transaction was refused keeps its words, and the end still says it was refused', async () => {
    const { channel, answers } = handedOver();
    const done = runAction({
      definition: actionOf([{
        title: { key: 'x' },
        run: async (c) => {
          try { await c.relay('AAAA'); } catch { throw new StepRefused({ key: 'act.why.the-clock', values: { minutes: 20 } }); }
        },
      }]),
      request: request(), channel, held, stop: new AbortController().signal,
    });
    await turn();
    answers[0]!('refused');
    const end = await done;
    /* RED WHEN: what the step says about a refusal is dropped, or it turns the refusal into a check that failed. */
    expect(end.ended).toMatchObject({ ended: 'stopped', why: 'relay-refused' });
    expect(end.says).toEqual({ key: 'act.why.the-clock', values: { minutes: 20 } });
  });

  it('two transactions handed over together go one at a time: the second only once the first is answered', async () => {
    const { channel, ended, answers } = handedOver();
    const done = runAction({
      definition: actionOf([{ title: { key: 'x' }, run: async (c) => { await Promise.all([c.relay('AAAA'), c.relay('BBBB')]); } }]),
      request: request(), channel, held, stop: new AbortController().signal,
    });
    await turn();
    /* RED WHEN: a second transaction goes to the page before the page has answered the first. */
    expect(answers).toHaveLength(1);
    answers[0]!('relayed');
    await turn();
    expect(answers).toHaveLength(2);
    answers[1]!('relayed');
    await done;
    expect(ended).toEqual([expect.objectContaining({ ended: 'done', relayed: 2, unconfirmed: 0 })]);
  });

  it('a transaction refused or not answered is counted as handed over and not confirmed, never as not sent', async () => {
    const refused = handedOver();
    const one = runAction({
      definition: actionOf([{ title: { key: 'x' }, run: (c) => c.relay('AAAA') }]),
      request: request(), channel: refused.channel, held, stop: new AbortController().signal,
    });
    await turn();
    refused.answers[0]!('refused');
    /* RED WHEN: a transaction the page answered refused is counted as never handed over, though the page holds it. */
    expect((await one).ended).toMatchObject({ relayed: 0, unconfirmed: 1 });
    const quiet = handedOver();
    const two = runAction({
      definition: actionOf([{ title: { key: 'x' }, run: (c) => c.relay('AAAA') }]),
      request: request(), channel: quiet.channel, held, stop: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(RELAY_PATIENCE_MS);
    /* RED WHEN: a transaction the page never answered is left out of the end answer's counts. */
    expect((await two).ended).toMatchObject({ why: 'no-relay-answer', relayed: 0, unconfirmed: 1 });
  });
});

describe('an action that ends cuts its steps off from the wallet\'s keys', () => {
  it('a step still running at the deadline is aborted, cannot read the keys afterwards, and the end says it was abandoned', async () => {
    const { channel } = channelThat(async () => 'relayed');
    let context: Parameters<ActionStep['run']>[0] | null = null;
    const done = runAction({
      definition: actionOf([{ title: { key: 'x' }, run: (c) => { context = c; return never(); } }]),
      request: request(10), channel, held, stop: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const end = await done;
    /* RED WHEN: the step's signal is not aborted when the action ends without it. */
    expect(context!.signal.aborted).toBe(true);
    /* RED WHEN: a step left running keeps reaching the wallet's seed after the action has ended. */
    expect(() => context!.held.secret).toThrow();
    /* RED WHEN: the end does not record that a step was still running, so the screen says its work is over. */
    expect(end.abandoned).toBe(true);
  });

  it('a definition that cannot list its steps still gets one answer, and nothing is thrown', async () => {
    const { channel, ended } = channelThat(async () => 'relayed');
    const broken = { ...actionOf([]), steps: () => { throw new Error('no steps'); } };
    /* RED WHEN: a throw while listing the steps escapes, so the page gets no answer and the wallet never locks. */
    const end = await runAction({ definition: broken, request: request(), channel, held, stop: new AbortController().signal });
    expect(ended).toEqual([expect.objectContaining({ ended: 'stopped', why: 'step-failed' })]);
    expect(end.abandoned).toBe(false);
  });
});

describe('an action keeps its own limits whatever the page does', () => {
  it('a step that builds for minutes is said again and again, so the page keeps waiting', async () => {
    const { channel, said, ended } = channelThat(async () => 'relayed');
    const done = runAction({
      definition: actionOf([{ title: { key: 'x' }, run: () => new Promise((r) => { setTimeout(r, 4 * 60_000); }) }]),
      request: request(), channel, held, stop: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await done;
    /* RED WHEN: the step is said only when it starts, so a page waiting out a long build gives up on a wallet at work. */
    expect(said.length).toBeGreaterThanOrEqual(1 + (4 * 60_000) / HEARTBEAT_MS - 1);
    expect(new Set(said.map((s) => `${s.step}/${s.steps}`))).toEqual(new Set(['1/1']));
    expect(ended.map((e) => e.ended)).toEqual(['done']);
    const afterwards = said.length;
    await vi.advanceTimersByTimeAsync(5 * HEARTBEAT_MS);
    /* RED WHEN: the clock keeps saying the step after the action has ended, so a page would wait on a finished wallet. */
    expect(said.length).toBe(afterwards);
  });

  it('a step that never ends is stopped at the wallet\'s own deadline, a little before the page\'s', async () => {
    const { channel, ended } = channelThat(async () => 'relayed');
    const done = runAction({
      definition: actionOf([{ title: { key: 'x' }, run: never }]), request: request(10), channel, held,
      stop: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000 - DEADLINE_MARGIN_MS - 1);
    /* RED WHEN: the wallet stops before its deadline. */
    expect(ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    /* RED WHEN: the wallet keeps no deadline of its own and waits on a dead step for as long as the page does. */
    expect(ended).toEqual([expect.objectContaining({ ended: 'stopped', why: 'out-of-time', step: 1, steps: 1, relayed: 0 })]);
  });

  it('a transaction the page does not answer in time stops the action at that step', async () => {
    const { channel, ended } = channelThat(() => new Promise(() => {}));
    const done = runAction({
      definition: actionOf([{ title: { key: 'x' }, run: (c) => c.relay('AAAA') }, { title: { key: 'y' }, run: async () => {} }]),
      request: request(), channel, held, stop: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(RELAY_PATIENCE_MS);
    await done;
    /* RED WHEN: the wallet waits for ever on a page that took a transaction and never said what it did with it. */
    expect(ended).toEqual([expect.objectContaining({ ended: 'stopped', why: 'no-relay-answer', step: 1, steps: 2, relayed: 0 })]);
  });

  it('an action with more steps than any action may have runs none of them', async () => {
    const ran = vi.fn(async () => {});
    const { channel, ended, said } = channelThat(async () => 'relayed');
    const steps = Array.from({ length: MOST_ACT_STEPS + 1 }, () => ({ title: { key: 'x' }, run: ran }));
    await runAction({ definition: actionOf(steps), request: request(), channel, held, stop: new AbortController().signal });
    /* RED WHEN: the wallet runs as many steps as an action lists. */
    expect(ran).not.toHaveBeenCalled();
    expect(said).toEqual([]);
    expect(ended).toEqual([expect.objectContaining({ ended: 'stopped', why: 'too-many', step: 1 })]);
  });

  it('a check after the passkey that does not hold builds nothing, and says why', async () => {
    const ran = vi.fn(async () => {});
    const { channel, ended } = channelThat(async () => 'relayed');
    const end = await runAction({
      definition: actionOf([{ title: { key: 'x' }, run: ran }], async () => ({ key: 'ask.act.unread' })),
      request: request(), channel, held, stop: new AbortController().signal,
    });
    /* RED WHEN: the steps run although the check after the passkey did not hold. */
    expect(ran).not.toHaveBeenCalled();
    expect(ended).toEqual([expect.objectContaining({ ended: 'stopped', why: 'check-failed', relayed: 0 })]);
    expect(end.says).toEqual({ key: 'ask.act.unread' });
  });

  it('a check that could not finish builds nothing, and says so in words of its own, not the title again', async () => {
    const ran = vi.fn(async () => {});
    const { channel, ended } = channelThat(async () => 'relayed');
    const end = await runAction({
      definition: actionOf([{ title: { key: 'x' }, run: ran }], async () => { throw new Error('the read failed'); }),
      request: request(), channel, held, stop: new AbortController().signal,
    });
    expect(ran).not.toHaveBeenCalled();
    expect(ended).toEqual([expect.objectContaining({ ended: 'stopped', why: 'check-failed', relayed: 0 })]);
    /* RED WHEN: the window's body repeats the stopped window's title instead of saying the checks could not finish. */
    expect(end.says).toEqual({ key: 'act.over.check-threw' });
  });
});

describe('the running window is shown what the action has told so far', () => {
  it('hands the watcher what each step told, so a later step can be listed as not needed', async () => {
    const { channel } = channelThat(async () => 'gone' as never);
    const seen: Array<Readonly<Record<string, string | number>> | undefined> = [];
    await runAction({
      definition: actionOf([
        { title: { key: 'x' }, run: async (c) => { c.tell({ state: 'awaiting-approvals' }); } },
        { title: { key: 'y' }, run: async () => {} },
      ]),
      request: request(), channel, held, stop: new AbortController().signal, watch: (at) => { seen.push(at.told); },
    });
    /* RED WHEN: the running window is not shown what a step told, so a step after it that had nothing to do is listed as done. */
    expect(seen.at(-1)).toEqual({ state: 'awaiting-approvals' });
  });
});

