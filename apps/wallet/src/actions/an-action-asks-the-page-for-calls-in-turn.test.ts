import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActEnded, ActingChannel, CalledOver, Relayed, StepAt } from 'midnight-identity/profile/channel';
import type { ActRequest } from 'midnight-identity/profile/request';
import { RELAY_PATIENCE_MS, runAction } from './run.js';
import type { ActionDefinition, ActionStep, Held, StepContext } from './definition.js';

vi.mock('midnight-identity/profile/act-intents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('midnight-identity/profile/act-intents')>();
  return {
    ...actual,
    ACT_INTENTS: Object.freeze({
      'name-a-vault': {
        fields: { company: 'record' },
        calls: [
          { method: 'GET', path: '/api/accounts/:company' },
          { method: 'POST', path: '/api/accounts/:company/vaults', sends: true },
          { method: 'POST', path: '/api/accounts/:company/proposals', sends: true, sendsWith: 'tx' },
        ],
        outcome: { vault: 'vault' },
      },
    }),
  };
});

/*
 * **AN ACTION ASKS THE PAGE FOR A CALL TO THE SERVICE ONLY WHERE ITS ENTRY NAMES ONE, IN TURN WITH WHAT IT HANDS
 * OVER.** The runner is driven over a channel that records what the wallet would post: a call its entry does not
 * name is never posted, a call the page refuses or does not answer stops the action, a call that carries a
 * transaction is counted with the relays, and the end tells the page only the outcome its entry lists.
 */

const START = 1_755_000_000_000;
const held = { identity: {}, secret: new Uint8Array(32) } as unknown as Held;
const request: ActRequest = {
  schema: 'midnight-identity/disclosure-request/v1', kind: 'act',
  requester: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'A test.', nonce: 'n1', expiresAt: START + 20 * 60_000, hearsProgress: true,
  intent: { name: 'name-a-vault' as never, fields: { company: 'acc_1' } },
} as ActRequest;

const channelThat = (answer: (method: string, path: string) => Promise<CalledOver>) => {
  const posted: string[] = [];
  const ended: ActEnded[] = [];
  const channel = {
    step: () => true,
    relay: async (_at: StepAt, tx: string): Promise<Relayed> => { posted.push(`relay ${tx}`); return 'relayed'; },
    call: (_at: StepAt, method: string, path: string, body?: string) => {
      posted.push(`${method} ${path}${body === undefined ? '' : ` ${body}`}`);
      return answer(method, path);
    },
    answer: (a: unknown) => { ended.push(a as ActEnded); return true; },
  } as unknown as ActingChannel;
  return { channel, posted, ended };
};
const actionOf = (steps: readonly ActionStep[]): ActionDefinition => ({
  headline: 'ask.act.headline', shown: async () => [], checks: [], check: async () => null, steps: () => steps,
});
const stepThat = (run: (c: StepContext) => Promise<void>): ActionStep => ({ title: { key: 'ask.act.headline' }, run });
const ok = (body: unknown = {}): Promise<CalledOver> => Promise.resolve({ of: 'answered', status: 200, body });
const go = (channel: ActingChannel, steps: readonly ActionStep[]) =>
  runAction({ definition: actionOf(steps), request, channel, held, stop: new AbortController().signal, now: () => Date.now() });

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

describe('a call goes to the page only where the action\'s entry names it', () => {
  it('hands a listed call over and gives the step the service\'s status and body as the page reports them', async () => {
    const { channel, posted, ended } = channelThat(async () => ({ of: 'answered', status: 404, body: { error: 'none' } }));
    let seen: unknown = null;
    await go(channel, [stepThat(async (c) => { seen = await c.call('GET', '/api/accounts/acc_1'); })]);
    /* RED WHEN: a listed call is not handed to the page, or its answer does not reach the step as the page gave it. */
    expect(posted).toEqual(['GET /api/accounts/acc_1']);
    expect(seen).toEqual({ status: 404, body: { error: 'none' } });
    expect(ended[0]).toMatchObject({ ended: 'done', relayed: 0 });
  });

  it('never posts a call its entry does not name, and stops the action there', async () => {
    const { channel, posted, ended } = channelThat(() => ok());
    const after: string[] = [];
    await go(channel, [stepThat(async (c) => {
      await c.call('GET', '/api/me/keys').catch(() => undefined);
      await c.relay('AAAA').catch(() => { after.push('relay refused'); });
    })]);
    /* RED WHEN: the wallet asks the page for a call outside the action's route list. */
    expect(posted).toEqual([]);
    /* RED WHEN: a step that catches the refusal can carry on handing things over. */
    expect(after).toEqual(['relay refused']);
    expect(ended[0]).toMatchObject({ ended: 'stopped', why: 'call-refused', step: 1 });
  });

  it('a call the page refuses stops the action, and so does one it does not answer in time', async () => {
    const refused = channelThat(async () => 'refused');
    await go(refused.channel, [stepThat(async (c) => { await c.call('GET', '/api/accounts/acc_1'); })]);
    /* RED WHEN: a page's refusal to make a call lets the action carry on as if it had been answered. */
    expect(refused.ended[0]).toMatchObject({ ended: 'stopped', why: 'call-refused' });
    const quiet = channelThat(() => new Promise<CalledOver>(() => {}));
    const ran = go(quiet.channel, [stepThat(async (c) => { await c.call('POST', '/api/accounts/acc_1/vaults', '{"tx":"AAAA"}'); })]);
    await vi.advanceTimersByTimeAsync(RELAY_PATIENCE_MS + 1);
    await ran;
    /* RED WHEN: a call left unanswered waits for ever, or a transaction in it is not counted as unconfirmed. */
    expect(quiet.ended[0]).toMatchObject({ ended: 'stopped', why: 'no-call-answer', unconfirmed: 1, relayed: 0 });
  });

  it('a call that carries a transaction counts with the relays once the service took it, and as unconfirmed when it answered otherwise', async () => {
    let status = 409;
    const { channel, ended } = channelThat(async () => ({ of: 'answered', status, body: {} }));
    await go(channel, [stepThat(async (c) => {
      await c.call('POST', '/api/accounts/acc_1/vaults', '{"tx":"AAAA"}');
      status = 201;
      await c.call('POST', '/api/accounts/acc_1/vaults', '{"tx":"BBBB"}');
      await c.call('GET', '/api/accounts/acc_1');
      status = 500;
      await c.call('GET', '/api/accounts/acc_1');
    })]);
    /* RED WHEN: a read, or a transaction the service refused, is counted as handed over. */
    expect(ended[0]).toMatchObject({ ended: 'done', relayed: 1 });
    /* RED WHEN: a transaction answered with a refusal is not counted as one that may be out, though the page may have sent it; or a read is. */
    expect(ended[0]).toMatchObject({ unconfirmed: 1 });
  });

  it('a proposal written down with no transaction is never counted with the relays or as unconfirmed, and one raised with its transaction is', async () => {
    let status = 500;
    const { channel, ended } = channelThat(async () => ({ of: 'answered', status, body: {} }));
    await go(channel, [stepThat(async (c) => {
      await c.call('POST', '/api/accounts/acc_1/proposals', '{"proposal":{},"salt":"ab"}');
      await c.call('POST', '/api/accounts/acc_1/proposals', '{"proposal":{},"salt":"ab","tx":"AAAA"}');
      status = 201;
      await c.call('POST', '/api/accounts/acc_1/proposals', '{"proposal":{},"salt":"ab"}');
      await c.call('POST', '/api/accounts/acc_1/proposals', '{"proposal":{},"salt":"ab","tx":"BBBB"}');
    })]);
    /* RED WHEN: a proposal written down with nothing for the chain counts as handed over, so the end says something may be out when nothing is. */
    expect(ended[0]).toMatchObject({ ended: 'done', relayed: 1, unconfirmed: 1 });
  });

  it('calls and relays go one at a time, each after the page\'s answer to the one before', async () => {
    const answers: Array<() => void> = [];
    const { channel, posted } = channelThat(() => new Promise<CalledOver>((resolve) => { answers.push(() => resolve({ of: 'answered', status: 200, body: {} })); }));
    const ran = go(channel, [stepThat(async (c) => {
      void c.call('GET', '/api/accounts/acc_1');
      void c.relay('AAAA');
      await c.call('GET', '/api/accounts/acc_1');
    })]);
    await vi.advanceTimersByTimeAsync(0);
    /* RED WHEN: a relay overtakes a call still waiting for the page's answer. */
    expect(posted).toEqual(['GET /api/accounts/acc_1']);
    answers.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(posted).toEqual(['GET /api/accounts/acc_1', 'relay AAAA', 'GET /api/accounts/acc_1']);
    answers.shift()!();
    await ran;
  });
});

describe('the end tells the page only the outcome the action\'s entry lists', () => {
  it('carries a listed part and drops an outcome with a part the entry does not list', async () => {
    const one = channelThat(() => ok());
    await go(one.channel, [stepThat(async (c) => { c.tell({ vault: 'c'.repeat(64) }); })]);
    /* RED WHEN: what the action got to does not reach the page. */
    expect(one.ended[0]?.outcome).toEqual({ vault: 'c'.repeat(64) });
    const two = channelThat(() => ok());
    await go(two.channel, [stepThat(async (c) => { c.tell({ vault: 'c'.repeat(64), secret: 'ab'.repeat(32) }); })]);
    /* RED WHEN: an action's end can carry anything beyond the public parts its entry names. */
    expect(two.ended[0]?.outcome).toBeUndefined();
  });
});
