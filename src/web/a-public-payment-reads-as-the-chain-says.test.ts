// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { READY_PING } from 'midnight-identity/profile/channel';
import { NETWORK } from 'midnight-identity/network';
import { HELD_ADDRESS_SLOTS } from 'midnight-identity/profile/unlock';
/*
 * **THE WALLET'S SIDE IS THE WALLET'S OWN SOURCE, AND THE PAGE'S SIDE IS THE
 * LIBRARY AS THE PAGE LOADS IT**, as in `the-wallet-confirms-the-payslips-address.test.ts`:
 * the wallet's modules are loaded by a path held in a variable and typed here by hand.
 */
import { identityFromWords } from '../../packages/identity/src/keys/derivation.js';
import type { Identity } from '../../packages/identity/src/keys/derivation.js';
import { parseAsk } from '../../packages/identity/src/profile/request.js';
import type { UnlockRequest } from '../../packages/identity/src/profile/request.js';
import { releaseFor } from '../../packages/identity/src/profile/unlock.js';
import { askWalletToUnlockAndWhereItReads } from './wallet-unlock.js';
import type { Openable } from './wallet-sign-in.js';
import { openAddresses } from './YourPay.js';
import { readTheChain, type MyPayslips } from './my-payslips.js';
import type { OpenedPayslip } from '../core/payslip-open.js';
import type { PayslipPayment } from './payslip-worker-client.js';
import { contractCircuits, movementOfPayslip } from './payslip-movement.js';
import { buildRun, paidMovementOfLeaf } from '../midnight/payout-tree.js';
import { payeeOf } from '../midnight/payee-address.js';
import { vaultDetails } from '../testing/vault-details.js';
import { ledgerTokenOf } from '../core/assets.js';

const WALLET_APP = '../../apps/wallet/src/accounts/';
const { receivingAddressesOf } = await import(/* @vite-ignore */ `${WALLET_APP}derived.js`) as {
  receivingAddressesOf: (identity: Identity, network: string) => string[];
};
const { WALLET_ACCOUNTS } = await import(/* @vite-ignore */ `${WALLET_APP}subwallets.js`) as {
  WALLET_ACCOUNTS: readonly number[];
};
const { ownedAddressFor } = await import(/* @vite-ignore */ `${WALLET_APP}owned-address.js`) as {
  ownedAddressFor: (identity: Identity, account: number, names: Record<string, string>, network: string) => {
    unshieldedBech32: string; address: { bech32: string };
  };
};

/**
 * **WHAT A PUBLIC PAYMENT READS ON THE PAYSLIPS PAGE, AND WHAT THE PAGE LEARNS.**
 *
 * The wallet does not answer for public addresses: a public address is on the
 * chain for anyone to read, so a page could test the wallet's answer against
 * every public address the chain has shown and learn which are this person's.
 * So a public payment reads "cannot tell" against a real wallet, and the answer
 * carries nothing a page could test a public address against.
 *
 * The page's own half is built and held here too: given a confirmation, a
 * public payment is asked about with the asset's public token and the vault's
 * public details circuit, and reads as the company's record says. The run is
 * built by the product's own `buildRun`, and the stand-in for the company's
 * contract holds exactly that run's recorded values, tested with the device's
 * own `movementOfPayslip` over the contracts' compiled circuits.
 */

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
const publicOf = (who: Identity, account: number) => ownedAddressFor(who, account, {}, NETWORK).unshieldedBech32;

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

const answers: unknown[] = [];
/** What the approval screen sends: `release` in `approve.tsx`, with the wallet's own addresses. */
const pressed = (identity = mine) => (ask: UnlockRequest) => {
  const r = releaseFor(identity, ask, AT, INDEXER, receivingAddressesOf(identity, NETWORK));
  answers.push(r);
  return r;
};

const openWith = async (wallet: TheWallet, slips: OpenedPayslip[]) => openAddresses([ACME],
  (company) => askWalletToUnlockAndWhereItReads(wallet, WALLET, {
    company, atOrigin: US, name: 'Confidential Accounts', rdns: 'social.lemonade.confidential-accounts',
    now: () => AT,
  }),
  async (): Promise<MyPayslips> => ({ opened: slips, sealed: [], unopened: 0, refused: 0 }));

/* One run, paying the wallet's main public address in NIGHT, which has no private form. */
const NIGHT_PUBLICLY = ledgerTokenOf('NIGHT', 'unshielded');
const PAID = 25_000_000n;
const run = buildRun([{ epoch: 0, seed: '5e'.repeat(32) }], { accountId: 'acc_1', runId: 'run_1', epoch: 0 },
  [{ payee: payeeOf(publicOf(mine, 0), NETWORK), token: NIGHT_PUBLICLY, amount: PAID }], vaultDetails);
const args = run.payeeArgs(0);
const RECORDED = new Set(run.tree.leaves.map(paidMovementOfLeaf));

const slip = (runId: string, paidTo: string, amount = PAID, asset = 'NIGHT'): OpenedPayslip => ({
  runId, period: runId, status: 'proposed', settledAt: null, wiring: 'chain', issuedBy: ACME,
  payslip: { employeeId: 'emp_1', name: 'Dana', asset, amount, period: runId, paidTo },
  receipt: { runId, nonce: args.nonce, blinding: args.blinding, company: ACME, until: AT / 1000 + 3_600 },
});

const reader = (asked: PayslipPayment[]) => ({ recorded: async (_i: unknown, _c: string, ps: PayslipPayment[]) => {
  const circuits = await contractCircuits();
  asked.push(...ps);
  return ps.map((p) => RECORDED.has(movementOfPayslip(circuits, p)));
} });

describe('a public payment on the payslips page', () => {
  it('THE WALLET ANSWERS FOR NO PUBLIC ADDRESS, SO A PUBLIC PAYMENT READS "CANNOT TELL" AND IS NEVER ASKED ABOUT', async () => {
    const held = receivingAddressesOf(mine, NETWORK);
    /* RED WHEN the wallet answers for its public addresses: a page could then find them all on the chain. */
    for (const account of WALLET_ACCOUNTS) expect(held).not.toContain(publicOf(mine, account));
    expect(held).toHaveLength(WALLET_ACCOUNTS.length);
    const asked: PayslipPayment[] = [];
    const slips = [slip('paid', publicOf(mine, 0))];
    const got = await openWith(new TheWallet(pressed()), slips);
    /* RED WHEN a public address reads as confirmed by a wallet that answered for none. */
    expect(got.confirmed(slips[0]!)).toBe(false);
    const read = await readTheChain(slips, reader(asked), INDEXER, got.confirmed, AT / 1000);
    expect(read.chain.get('paid')).toBe('cannot-tell');
    expect(asked).toEqual([]);
  });

  it('GIVEN A CONFIRMATION, A PUBLIC PAYMENT READS PAID WHEN RECORDED AND NOT YET WHEN NOT; AN UNCONFIRMED ONE CANNOT TELL', async () => {
    const asked: PayslipPayment[] = [];
    const slips = [
      slip('paid', publicOf(mine, 0)),
      slip('another-amount', publicOf(mine, 0), PAID + 1n),
      slip('theirs', publicOf(someoneElse, 0)),
    ];
    const confirmed = (s: OpenedPayslip) => s.payslip.paidTo === publicOf(mine, 0);
    const read = await readTheChain(slips, reader(asked), INDEXER, confirmed, AT / 1000, undefined, [ACME]);
    /*
     * RED WHEN the page skips a public payment (it reads "cannot tell"), asks
     * with the private token, or the device builds the value with the private
     * details circuit: none of those is the value the run recorded.
     */
    expect(read.chain.get('paid')).toBe('paid');
    expect(read.chain.get('another-amount')).toBe('not-yet');
    /* RED WHEN an address that was not confirmed is asked about. */
    expect(read.chain.get('theirs')).toBe('cannot-tell');
    expect(asked.map((p) => p.paidTo)).toEqual([publicOf(mine, 0), publicOf(mine, 0)]);
    expect(asked.every((p) => p.token === NIGHT_PUBLICLY)).toBe(true);
  });

  it('THE ASK NAMES NO ADDRESS, THE ANSWER CARRIES NO ADDRESS OF EITHER KIND, AND IT IS ONE APPROVAL', async () => {
    answers.length = 0;
    const wallet = new TheWallet(pressed());
    await openWith(wallet, [slip('paid', publicOf(mine, 0))]);
    /* RED WHEN the page asks the wallet a second time for one company. */
    expect(wallet.asked).toHaveLength(1);
    /* RED WHEN the ask carries an address or a list of them. */
    expect(JSON.stringify(wallet.asked)).not.toMatch(/mn_addr|shield-addr/u);
    const said = JSON.stringify(answers);
    /* RED WHEN an address, rather than its digest, leaves the wallet. */
    expect(said).not.toMatch(/mn_addr|shield-addr/u);
    for (const a of receivingAddressesOf(mine, NETWORK)) expect(said).not.toContain(a);
    for (const account of WALLET_ACCOUNTS) expect(said).not.toContain(publicOf(mine, account));
    /* RED WHEN the list's length tells how many addresses a wallet holds. */
    expect((answers[0] as { held: string[] }).held).toHaveLength(HELD_ADDRESS_SLOTS);
  });
});
