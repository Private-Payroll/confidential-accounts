import { describe, expect, it } from 'vitest';
import {
  ACT_ENDED_SCHEMA, ACT_KEEP_SCHEMA, ACT_KEPT_SCHEMA, ACT_RELAYED_SCHEMA, ACT_RELAY_SCHEMA, READY_PING,
} from 'midnight-identity/profile/channel';
import { actInTheWallet } from './wallet-act.js';
import type { Openable, WalletWindow } from './wallet-sign-in.js';

/*
 * **THE PAGE CARRIES THE PERSON'S SAVED KEYS INTO AN ACTION SEALED, AND KEEPS WHAT THE WALLET SEALED AGAIN.** The
 * page names the person and hands over the saved keys as the service holds them; each copy the wallet hands back
 * is written over the version it names, in turn with the transactions, and the wallet is told `kept` only with the
 * version the service then holds.
 */

const WALLET = 'https://wallet.example';
const NONCE = 'act-1';
const SEALED = { iv: '00'.repeat(12), tag: '', body: 'ab'.repeat(40) };
const AGAIN = { iv: '11'.repeat(12), tag: '', body: 'cd'.repeat(40) };

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
const keepOf = (n: number, over: Record<string, unknown> = {}) =>
  ({ schema: ACT_KEEP_SCHEMA, nonce: NONCE, n, step: 1, steps: 2, sealed: AGAIN, ifVersion: 3, ...over });
const relayOf = (n: number) => ({ schema: ACT_RELAY_SCHEMA, nonce: NONCE, n, step: 2, steps: 2, transaction: 'dHgx' });

const start = (page: APage, keep: (sealed: unknown, ifVersion: number) => Promise<number | null>, order: string[] = []) => {
  const run = actInTheWallet(page, WALLET, {
    intent: { name: 'move-between-vaults', vault: 'c'.repeat(64) }, nonce: NONCE, now: () => page.now(),
    relay: async () => { order.push('relay'); return true; },
    savedKeys: { person: 'usr_a', keyring: { sealed: SEALED, version: 3 }, keep: async (s, v) => { order.push('keep'); return keep(s, v); } },
  });
  page.say({ schema: READY_PING });
  return run;
};

describe('the page carries the saved keys sealed and keeps what the wallet sealed again', () => {
  it('names the person and hands over the saved keys as the service holds them', () => {
    const page = new APage();
    void start(page, async () => 4);
    /* RED WHEN: the ask does not carry the saved keys or the person they are for, so the wallet has nothing to open. */
    expect(page.posted[0]).toMatchObject({ kind: 'act', person: 'usr_a', keyring: { sealed: SEALED, version: 3 } });
  });

  it('keeps each copy over the version named, before the transaction after it, and says kept with the version now held', async () => {
    const page = new APage();
    const order: string[] = [];
    const written: Array<[unknown, number]> = [];
    const run = start(page, async (s, v) => { written.push([s, v]); return 4; }, order);
    page.say(keepOf(1));
    page.say(relayOf(1));
    await settle();
    /* RED WHEN: what the wallet sealed is not written, or written over another version than the one it named. */
    expect(written).toEqual([[AGAIN, 3]]);
    /* RED WHEN: a transaction is sent before the saved keys the wallet handed over first are kept. */
    expect(order).toEqual(['keep', 'relay']);
    expect(page.sent(ACT_KEPT_SCHEMA)).toEqual([{ schema: ACT_KEPT_SCHEMA, nonce: NONCE, n: 1, outcome: 'kept', version: 4 }]);
    expect(page.sent(ACT_RELAYED_SCHEMA)).toHaveLength(1);
    /* RED WHEN: saved keys handed over are taken as the action's answer. */
    page.say({ schema: ACT_ENDED_SCHEMA, nonce: NONCE, intent: 'move-between-vaults', ended: 'done', step: 2, steps: 2, relayed: 1, unconfirmed: 0 });
    expect(await run).toEqual({ of: 'done', steps: 2, relayed: 1 });
  });

  it('says refused when the service did not keep them, when keeping throws, and for a copy out of turn', async () => {
    const page = new APage();
    let answer: number | null | 'throw' = null;
    void start(page, async () => { if (answer === 'throw') throw new Error('down'); return answer; });
    page.say(keepOf(1));
    await settle();
    answer = 'throw';
    page.say(keepOf(2));
    await settle();
    /* RED WHEN: a copy the service refused, or one that failed to be written, is said to be kept. */
    expect(page.sent(ACT_KEPT_SCHEMA).map((m) => m['outcome'])).toEqual(['refused', 'refused']);
    answer = 5;
    page.say(keepOf(4));
    await settle();
    /* RED WHEN: a copy out of turn is written, so an older copy could land after a newer one. */
    expect(page.sent(ACT_KEPT_SCHEMA).at(-1)).toEqual({ schema: ACT_KEPT_SCHEMA, nonce: NONCE, n: 4, outcome: 'refused' });
  });

  it('a page that handed over no saved keys keeps none', async () => {
    const page = new APage();
    void actInTheWallet(page, WALLET, {
      intent: { name: 'move-between-vaults', vault: 'c'.repeat(64) }, nonce: NONCE, now: () => page.now(), relay: async () => true,
    });
    page.say({ schema: READY_PING });
    expect(page.posted[0]).not.toHaveProperty('keyring');
    page.say(keepOf(1));
    await settle();
    /* RED WHEN: saved keys from a wallet are written by a page that never handed any over. */
    expect(page.sent(ACT_KEPT_SCHEMA)).toEqual([{ schema: ACT_KEPT_SCHEMA, nonce: NONCE, n: 1, outcome: 'refused' }]);
  });
});
