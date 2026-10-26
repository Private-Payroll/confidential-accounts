import { describe, expect, it, vi } from 'vitest';

vi.mock('midnight-identity/profile/act-channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('midnight-identity/profile/act-channel')>();
  const shape = {
    fields: { company: 'record' },
    calls: [
      { method: 'GET', path: '/api/accounts/:company' },
      { method: 'POST', path: '/api/accounts/:company/vaults', sends: true },
      { method: 'POST', path: '/api/accounts/:company/proposals', sends: true, sendsWith: 'tx' },
    ],
  };
  return { ...actual, intentShapeOf: (name: string) => (name === 'name-a-vault' ? shape : actual.intentShapeOf(name)) };
});

import { ACT_CALLED_SCHEMA, ACT_CALL_SCHEMA, ACT_ENDED_SCHEMA, ACT_RELAY_SCHEMA, READY_PING } from 'midnight-identity/profile/channel';
import { actInTheWallet } from './wallet-act.js';
import type { Openable, WalletWindow } from './wallet-sign-in.js';

/*
 * **THE PAGE MAKES A CALL TO THE SERVICE FOR AN ACTION ONLY WHEN THE ACTION'S ROUTE LIST NAMES IT.** It checks the
 * method and the path itself before it calls, answers with the service's status and body, takes a call that carries
 * a transaction as handed over only when the service took it, and refuses everything else.
 */

const WALLET = 'https://wallet.example';
const NONCE = 'act-1';

class APage implements Openable {
  private handler: ((e: MessageEvent) => void) | null = null;
  readonly posted: unknown[] = [];
  readonly wallet: WalletWindow = { postMessage: (m: unknown) => { this.posted.push(m); }, close: () => {}, focus: () => {}, closed: false };
  open(): WalletWindow { return this.wallet; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void { this.handler = h; }
  removeEventListener(): void { this.handler = null; }
  setTimeout(): number { return 0; }
  clearTimeout(): void { /* the test moves no clock */ }
  now(): number { return 1_755_000_000_000; }
  say(data: unknown): void { this.handler?.({ origin: WALLET, source: this.wallet, data } as unknown as MessageEvent); }
  sent(schema: string): Record<string, unknown>[] {
    return this.posted.filter((m) => (m as { schema?: unknown }).schema === schema) as Record<string, unknown>[];
  }
}

const settle = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const callOf = (n: number, method: string, path: string, body?: string) =>
  ({ schema: ACT_CALL_SCHEMA, nonce: NONCE, n, step: 1, steps: 1, method, path, ...(body === undefined ? {} : { body }) });

const start = (page: APage, call?: (r: { method: string; path: string; body?: string }) => Promise<{ status: number; body: unknown }>) => {
  const made: string[] = [];
  const run = actInTheWallet(page, WALLET, {
    intent: { name: 'name-a-vault', company: 'acc_1' }, nonce: NONCE, now: () => page.now(),
    relay: async () => { made.push('relay'); return true; },
    ...(call === undefined ? {} : { call: async (r) => { made.push(`${r.method} ${r.path}${r.body === undefined ? '' : ` ${r.body}`}`); return call(r); } }),
  });
  page.say({ schema: READY_PING });
  return { run, made };
};

describe('the page makes a call for an action only where its route list names one', () => {
  it('makes a listed call and answers with the service\'s status and body', async () => {
    const page = new APage();
    const { made } = start(page, async () => ({ status: 409, body: { error: 'taken' } }));
    page.say(callOf(1, 'POST', '/api/accounts/acc_1/vaults', '{"tx":"AAAA"}'));
    await settle();
    /* RED WHEN: a listed call is not made, or made without the body it carries. */
    expect(made).toEqual(['POST /api/accounts/acc_1/vaults {"tx":"AAAA"}']);
    /* RED WHEN: the service's answer does not reach the wallet as given. */
    expect(page.sent(ACT_CALLED_SCHEMA)).toEqual([{ schema: ACT_CALLED_SCHEMA, nonce: NONCE, n: 1, outcome: 'answered', status: 409, body: { error: 'taken' } }]);
  });

  it('refuses a call its route list does not name, one out of turn, and every call when it was given no way to make one', async () => {
    const page = new APage();
    const { made } = start(page, async () => ({ status: 200, body: {} }));
    page.say(callOf(1, 'GET', '/api/me/keys'));
    page.say(callOf(3, 'GET', '/api/accounts/acc_1'));
    page.say(callOf(2, 'PUT', '/api/accounts/acc_1'));
    await settle();
    /* RED WHEN: a wallet can have the page reach a route the action does not name, or skip a number. */
    expect(made).toEqual([]);
    expect(page.sent(ACT_CALLED_SCHEMA).map((m) => [m['n'], m['outcome']])).toEqual([[1, 'refused'], [3, 'refused'], [2, 'refused']]);
    const bare = new APage();
    start(bare);
    bare.say(callOf(1, 'GET', '/api/accounts/acc_1'));
    await settle();
    /* RED WHEN: a page that offers no way to call is taken to have made one. */
    expect(bare.sent(ACT_CALLED_SCHEMA).map((m) => m['outcome'])).toEqual(['refused']);
  });

  it('a call that throws is refused, and one carrying a transaction counts as handed over only when the service took it', async () => {
    const page = new APage();
    let next: 'throw' | number = 'throw';
    const { run } = start(page, async () => { if (next === 'throw') throw new Error('down'); return { status: next, body: {} }; });
    page.say(callOf(1, 'POST', '/api/accounts/acc_1/vaults', '{"tx":"AAAA"}'));
    await settle();
    next = 500;
    page.say(callOf(2, 'POST', '/api/accounts/acc_1/vaults', '{"tx":"AAAA"}'));
    await settle();
    next = 201;
    page.say(callOf(3, 'POST', '/api/accounts/acc_1/vaults', '{"tx":"AAAA"}'));
    page.say(callOf(4, 'GET', '/api/accounts/acc_1'));
    await settle();
    /* RED WHEN: a call that failed on the page is answered as if the service had said something. */
    expect(page.sent(ACT_CALLED_SCHEMA)[0]).toMatchObject({ n: 1, outcome: 'refused' });
    page.say({ schema: ACT_RELAY_SCHEMA, nonce: NONCE, n: 1, step: 1, steps: 1, transaction: 'dHgx' });
    await settle();
    page.say({ schema: ACT_ENDED_SCHEMA, nonce: NONCE, intent: 'name-a-vault', ended: 'stopped', why: 'step-failed', step: 1, steps: 1, relayed: 2, unconfirmed: 2 });
    /* RED WHEN: a read or a refused transaction is counted as handed over, or one handed over and not taken is not unconfirmed. */
    expect(await run).toMatchObject({ of: 'stopped', relayed: 2, unconfirmed: 2 });
  });

  it('a proposal written down with no transaction is never counted as handed over, and one raised with its transaction is', async () => {
    const page = new APage();
    let next = 500;
    const { run } = start(page, async () => ({ status: next, body: {} }));
    page.say(callOf(1, 'POST', '/api/accounts/acc_1/proposals', '{"proposal":{},"salt":"ab"}'));
    await settle();
    page.say(callOf(2, 'POST', '/api/accounts/acc_1/proposals', '{"proposal":{},"salt":"ab","tx":"AAAA"}'));
    await settle();
    next = 201;
    page.say(callOf(3, 'POST', '/api/accounts/acc_1/proposals', '{"proposal":{},"salt":"ab"}'));
    page.say(callOf(4, 'POST', '/api/accounts/acc_1/proposals', '{"proposal":{},"salt":"ab","tx":"AAAA"}'));
    await settle();
    page.say({ schema: ACT_ENDED_SCHEMA, nonce: NONCE, intent: 'name-a-vault', ended: 'stopped', why: 'step-failed', step: 1, steps: 1, relayed: 1, unconfirmed: 1 });
    /* RED WHEN: a proposal written down with nothing for the chain counts as handed over, so a late or refused answer reads as maybe sent. */
    expect(await run).toMatchObject({ of: 'stopped', relayed: 1, unconfirmed: 1 });
  });
});
