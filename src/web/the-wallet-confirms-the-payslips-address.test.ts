// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { READY_PING } from 'midnight-identity/profile/channel';
import { NETWORK } from 'midnight-identity/network';
/*
 * **THE WALLET'S SIDE IS THE WALLET'S OWN SOURCE, AND THE PAGE'S SIDE IS THE
 * LIBRARY AS THE PAGE LOADS IT.** The wallet is built from `packages/identity/src`
 * and the page from its emitted `lib/`, so the two digests below are two builds
 * of one function meeting the way they meet in a browser.
 *
 * The wallet application's own modules are loaded by a path held in a variable,
 * so this project's typecheck does not walk into the wallet, which has its own
 * config and reaches library modules this project cannot name. What is used from
 * them is typed by hand below, and a module that changed shape fails at the call.
 */
import { identityFromWords } from '../../packages/identity/src/keys/derivation.js';
import type { Identity } from '../../packages/identity/src/keys/derivation.js';
import { addressFor } from '../../packages/identity/src/wallet/address.js';
import { parseAsk } from '../../packages/identity/src/profile/request.js';
import type { UnlockRequest } from '../../packages/identity/src/profile/request.js';
import { releaseFor } from '../../packages/identity/src/profile/unlock.js';
import { askWalletToUnlockAndWhereItReads } from './wallet-unlock.js';
import type { Openable } from './wallet-sign-in.js';
import { openAddresses } from './YourPay.js';
import { readTheChain } from './my-payslips.js';
import type { OpenedPayslip } from '../core/payslip-open.js';
import type { MyPayslips } from './my-payslips.js';

const WALLET_APP = '../../apps/wallet/src/accounts/';
const { receivingAddressesOf } = await import(/* @vite-ignore */ `${WALLET_APP}derived.js`) as {
  receivingAddressesOf: (identity: Identity, network: string) => string[];
};
const { WALLET_ACCOUNTS } = await import(/* @vite-ignore */ `${WALLET_APP}subwallets.js`) as {
  WALLET_ACCOUNTS: readonly number[];
};

/**
 * **A SLIP PAID TO THE WALLET'S OWN ADDRESS IS CONFIRMED, A SLIP PAID TO ANY
 * OTHER IS NOT, AND THE ASK NAMES NO ADDRESS.** The wallet's real derivation of
 * every account's receiving address goes into a real release; the page's real
 * unlock reads it back, and its real check is asked about each slip.
 */

/* The wallet runs in a browser and encodes addresses with the browser's `Buffer`, as its own tests do. */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const ACME = 'a1'.repeat(32);
const AT = 1_756_000_000_000;
const INDEXER = { indexerUri: 'https://indexer.example/graphql', indexerWsUri: 'wss://indexer.example/graphql/ws' };

const mine = identityFromWords(TEST_MNEMONIC);
const someoneElse = identityFromWords(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon '
  + 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art');

/** A wallet in another window, answering an unlock as the approval screen does when it is pressed. */
class TheWallet implements Openable {
  private handler: ((event: MessageEvent) => void) | null = null;
  readonly asked: unknown[] = [];
  private readonly tab = { postMessage: (m: unknown) => this.onAsk(m) };
  constructor(private readonly answer: (ask: UnlockRequest) => unknown) {}
  open(): Window | null { return this.tab as unknown as Window; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void {
    this.handler = h;
    queueMicrotask(() => this.deliver({ schema: READY_PING }));
  }
  removeEventListener(): void { this.handler = null; }
  setTimeout(): number { return 0; }
  clearTimeout(): void { /* nothing to clear */ }
  private deliver(data: unknown): void {
    this.handler?.({ origin: WALLET, source: this.tab, data } as unknown as MessageEvent);
  }
  private onAsk(message: unknown): void {
    this.asked.push(message);
    const ask = parseAsk(message, US, AT) as UnlockRequest;
    queueMicrotask(() => this.deliver(this.answer(ask)));
  }
}

/** What the approval screen sends: `release` in `approve.tsx`, with the wallet's own addresses. */
const pressed = (identity = mine) => (ask: UnlockRequest) =>
  releaseFor(identity, ask, AT, INDEXER, receivingAddressesOf(identity, NETWORK));

const slipPaidTo = (runId: string, paidTo: string): OpenedPayslip => ({
  runId, period: runId, status: 'proposed', settledAt: null, wiring: 'chain', issuedBy: ACME,
  payslip: { employeeId: 'emp_1', name: 'Dana', asset: 'TESTUSD', amount: 1n, period: runId, paidTo },
  receipt: { runId, nonce: '01'.repeat(32), blinding: '09'.repeat(32), company: ACME, until: AT / 1000 + 3_600 },
});

const openWith = async (wallet: TheWallet, slips: OpenedPayslip[]) => openAddresses([ACME],
  (company) => askWalletToUnlockAndWhereItReads(wallet, WALLET, {
    company, atOrigin: US, name: 'Confidential Accounts', rdns: 'social.lemonade.confidential-accounts',
    now: () => AT,
  }),
  async (): Promise<MyPayslips> => ({ opened: slips, sealed: [], unopened: 0, refused: 0 }));

describe('the wallet confirms the payslip\'s address, and only its own', () => {
  it('THE WALLET WORKS OUT A RECEIVING ADDRESS FOR EVERY ACCOUNT IT OFFERS, WITH NO FURTHER PRESS', () => {
    const held = receivingAddressesOf(mine, NETWORK);
    /* RED WHEN an account is left out: a person paid into that subwallet would read "cannot tell". */
    expect(held).toHaveLength(WALLET_ACCOUNTS.length);
    expect(new Set(held).size).toBe(WALLET_ACCOUNTS.length);
    expect(held).toContain(addressFor(mine.moneyAt(0).zswap, NETWORK).bech32);
    expect(held).toContain(addressFor(mine.moneyAt(WALLET_ACCOUNTS.at(-1)!).zswap, NETWORK).bech32);
  });

  it('A SLIP PAID TO THE WALLET\'S OWN ADDRESS IS CONFIRMED; ONE PAID TO ANY OTHER IS NOT', async () => {
    const wallet = new TheWallet(pressed());
    const main = addressFor(mine.moneyAt(0).zswap, NETWORK).bech32;
    const sub = addressFor(mine.moneyAt(WALLET_ACCOUNTS[3]!).zswap, NETWORK).bech32;
    const theirs = addressFor(someoneElse.moneyAt(0).zswap, NETWORK).bech32;
    /* The wallet's own keys at an account it does not offer. */
    const unoffered = addressFor(mine.moneyAt(Math.max(...WALLET_ACCOUNTS) + 1).zswap, NETWORK).bech32;
    const slips = [slipPaidTo('main', main), slipPaidTo('sub', sub), slipPaidTo('theirs', theirs),
      slipPaidTo('unoffered', unoffered), slipPaidTo('upper', main.toUpperCase())];
    const got = await openWith(wallet, slips);
    const confirmed = Object.fromEntries(slips.map(s => [s.runId, got.confirmed(s)]));
    /* RED WHEN either side's digest changes: nothing is confirmed. RED WHEN anything but a match confirms. */
    expect(confirmed).toEqual({ main: true, sub: true, theirs: false, unoffered: false, upper: true });

    /*
     * And what the page then reads: a confirmed address is asked about, an
     * unconfirmed one never. The stand-in answers "recorded" for everything
     * asked, so an unconfirmed slip that was asked would read paid.
     */
    const asked: string[] = [];
    const reader = { recorded: async (_i: unknown, _c: string, ps: Array<{ paidTo: string }>) => {
      asked.push(...ps.map(p => p.paidTo)); return ps.map(() => true);
    } };
    const read = await readTheChain(slips, reader, INDEXER, got.confirmed, AT / 1000);
    expect(read.chain.get('main')).toBe('paid');
    /* RED WHEN an address the wallet did not confirm is asked about. */
    expect(read.chain.get('theirs')).toBe('cannot-tell');
    expect(read.chain.get('unoffered')).toBe('cannot-tell');
    expect(asked.sort()).toEqual([main, sub, main.toUpperCase()].sort());
  });

  it('THE ASK NAMES NO ADDRESS, AND THE ANSWER CARRIES NONE IN THE CLEAR', async () => {
    const answers: unknown[] = [];
    const wallet = new TheWallet((ask) => { const r = pressed()(ask); answers.push(r); return r; });
    await openWith(wallet, [slipPaidTo('main', addressFor(mine.moneyAt(0).zswap, NETWORK).bech32)]);
    const said = JSON.stringify(wallet.asked);
    /* RED WHEN the ask carries an address, or a list of them. */
    expect(said).not.toContain('shield-addr');
    expect(Object.keys(wallet.asked[0] as object).sort())
      .toEqual(['company', 'expiresAt', 'kind', 'nonce', 'purpose', 'requester', 'schema']);
    /* RED WHEN an address, rather than its digest, leaves the wallet. */
    const answered = JSON.stringify(answers);
    for (const a of receivingAddressesOf(mine, NETWORK)) expect(answered).not.toContain(a);
    expect(answered).not.toContain('shield-addr');
  });

  it('A WALLET THAT GIVES NO LIST - AN OLDER ONE - CONFIRMS NOTHING, AND THE PAGE STILL OPENS', async () => {
    const older = new TheWallet((ask) => releaseFor(mine, ask, AT, INDEXER));
    const main = addressFor(mine.moneyAt(0).zswap, NETWORK).bech32;
    const got = await openWith(older, [slipPaidTo('main', main)]);
    expect(got.found).toHaveLength(1);
    /* RED WHEN a missing list is read as confirming, or the unlock is refused for it. */
    expect(got.confirmed(got.found[0]!)).toBe(false);
  });
});
