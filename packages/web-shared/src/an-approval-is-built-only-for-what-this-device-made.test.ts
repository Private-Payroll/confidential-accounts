/**
 * **AN APPROVAL OF A RUN IS BUILT ONLY FOR THE RUN THIS DEVICE MADE AGAIN.**
 * Every case here is the check where the approval is built, run with the
 * account's and the vault's own compiled circuits.
 */
import { describe, expect, it } from 'vitest';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';
import { pureCircuits as vaultCircuits } from '../../../contracts/managed-vault/contract/index.js';
import { firstSecretRunOf } from '../../../src/midnight/vault-start.js';
import { buildPayoutTree, buildRun, paidOnceOfNonce, type PaymentFacts } from '../../../src/midnight/payout-tree.js';
import { payRecordNonceOf } from '../../../src/midnight/run-keys.js';
import { fromHex, toHex, type Hex } from '../../../src/core/crypto.js';
import { payeeFor, payFor } from '../../../src/testing/payees.js';
import { vaultDetails } from '../../../src/testing/vault-details.js';
import { TEST_TOKEN } from '../../../src/testing/assets.js';
import {
  NotMadeOnThisDevice, refuseWhatThisDeviceDidNotMake, type AccountLedgerView, type MadeHere, type RunMadeHere, type WalletReadFacts,
} from './what-this-device-made.js';
import { paymentEntriesOf } from './payment-entries.js';

const NET = 'undeployed' as const;
const facts: PaymentFacts[] = [
  { payee: payeeFor('a1'.repeat(32), NET), token: TEST_TOKEN, amount: 250n },
  { payee: payeeFor('a2'.repeat(32), NET), token: TEST_TOKEN, amount: 90n },
  { payee: payeeFor('a3'.repeat(32), NET), token: TEST_TOKEN, amount: 7n },
];
const pay = payFor(facts, { people: ['p1', 'p2', 'p3'] });
const WINDOW = { opensAt: 1_800_000_000n, closesAt: 1_800_600_000n };

const made = (over: Partial<RunMadeHere> = {}): RunMadeHere => ({
  kind: 'payroll', seeds: [{ epoch: 0, seed: '6e'.repeat(32) as Hex }], payKey: pay.key,
  identity: { accountId: 'acc_1', runId: 'run_1:leg', epoch: 0 }, facts, records: pay.records, asset: TEST_TOKEN,
  opensAt: String(WINDOW.opensAt), closesAt: String(WINDOW.closesAt), required: '0', ...over,
});

/** The payload of the run as the raising device made it: what the chain's proposal commits to. */
const payloadOf = (m: RunMadeHere): string => {
  const built = buildRun([...m.seeds], m.identity, [...m.facts], vaultDetails, { key: m.payKey as Hex, records: [...m.records] }, m.asset);
  return toHex(pureCircuits.runPayload(fromHex(built.tree.root), built.tree.payees, BigInt(m.opensAt), BigInt(m.closesAt), BigInt(m.required)));
};

/*
 * A retry's payload: the root and count of a tree of only the people it names, each at the leaf the leg gave them.
 * Built here from the leg's own leaf inputs and amounts with the tree builder alone, not with the retry builder the
 * check uses, so a retry builder that picked other people, other leaves or the whole leg is caught.
 */
const payloadOfRetry = (m: RunMadeHere): string => {
  const leg = buildRun([...m.seeds], m.identity, [...m.facts], vaultDetails, { key: m.payKey as Hex, records: [...m.records] }, m.asset);
  const tree = buildPayoutTree(m.retry!.map((i) => leg.payments[i]!), m.retry!.map((i) => m.facts[i]!.amount), leg.tree.asset);
  expect(tree.leaves).toEqual(m.retry!.map((i) => leg.tree.leaves[i]));
  return toHex(pureCircuits.runPayload(fromHex(tree.root), BigInt(m.retry!.length), BigInt(m.opensAt), BigInt(m.closesAt), BigInt(m.required)));
};

const CHAIN_ID = 'c1'.repeat(32);
type ChainSays = { open?: boolean; paid?: readonly Hex[]; payKey?: Hex | null };
/** The account as the chain holds it: whether the proposal is open and who is paid. What the wallet reads, `payKey` included (`null` for none), is `walletRead`'s. */
const chain = (o: ChainSays = {}): AccountLedgerView & { readonly says: ChainSays } => ({
  says: o,
  openProposals: { member: (id: Uint8Array) => (o.open ?? true) && toHex(id) === CHAIN_ID },
  movements: { member: (x: Uint8Array) => (o.paid ?? []).some((n) => paidOnceOfNonce(n) === toHex(x)) },
});
/** What the person's own wallet reads off the chain about a run's payments: the entries asked about, those held, the commitment. */
const walletRead = (m: RunMadeHere, o: ChainSays): WalletReadFacts => {
  const asked = paymentEntriesOf(m, pureCircuits.paidOnceOf);
  const paid = new Set((o.paid ?? []).map((n) => paidOnceOfNonce(n)));
  return {
    asked, held: asked.filter((e) => paid.has(e as Hex)),
    payKeyCommitment: o.payKey === null ? null : toHex(pureCircuits.payKeyCommitmentOf(fromHex(o.payKey ?? pay.key))),
    openRounds: (o.open ?? true) ? [CHAIN_ID] : [], entries: 2 * (o.paid ?? []).length,
  };
};

const deps = {
  runPayload: pureCircuits.runPayload, vaultDetails, payKeyCommitmentOf: pureCircuits.payKeyCommitmentOf,
  secretRun: { vault: vaultCircuits as never, account: pureCircuits as never },
};
/* Unless a case says otherwise, the wallet reads the same chain the ledger is: a run carries what it read. */
const check = (m: MadeHere | undefined, digest: string, ledger: (AccountLedgerView & { says?: ChainSays }) | null = chain(), d: object = deps) => {
  const read = m?.kind === 'payroll' && m.wallet === undefined ? { ...m, wallet: walletRead(m, ledger?.says ?? {}) } : m;
  return () => refuseWhatThisDeviceDidNotMake(d as never, { chainId: CHAIN_ID, digest, ...(read === undefined ? {} : { made: read }) }, ledger);
};
const nonceOf = (i: number, occurrence = 0) => payRecordNonceOf(pay.key, { ...pay.records[i]!, occurrence });

describe('AN APPROVAL OF A PAYROLL RUN', () => {
  it('IS BUILT FOR THE RUN THIS DEVICE MADE AGAIN, WHEN IT IS THE PROPOSAL THE CHAIN HOLDS OPEN', () => {
    /* RED WHEN: the run made again here from the company's records is refused. */
    expect(check(made(), payloadOf(made()))).not.toThrow();
  });

  it('IS REFUSED WHEN THIS DEVICE MADE NOTHING AGAIN, OR CANNOT READ THE CHAIN OR MAKE A LEAF', () => {
    /* RED WHEN: an approval is built for a proposal this device did not rebuild. */
    expect(check(undefined, payloadOf(made()))).toThrow(/did not rebuild what this proposal pays/);
    /* RED WHEN: an approval is built with no read of the chain to check it against. */
    expect(check(made(), payloadOf(made()), null)).toThrow(/cannot read the company's account on the chain/);
    /* RED WHEN: a run is taken as rebuilt where no payee's leaf could be made. */
    expect(check(made(), payloadOf(made()), chain(), { ...deps, vaultDetails: undefined })).toThrow(/cannot rebuild a payroll run/);
  });

  it('IS REFUSED, BY NAME, WHEN A WINDOW OR A NUMBER OF APPROVALS IT MADE IS NOT A WHOLE NUMBER', () => {
    const raised = payloadOf(made());
    for (const [what, m] of [
      ['window', made({ opensAt: 'soon' })], ['window', made({ closesAt: '1.5' })], ['approvals required', made({ required: '-1' })],
    ] as const) {
      /* RED WHEN: a window or a count that is not a whole number reaches the payload, where it would be read as something else. */
      expect(check(m, raised), m.opensAt + m.closesAt + m.required).toThrow(new RegExp(`what this device worked out for the ${what} is not a whole number`));
    }
  });

  it('IS REFUSED WHEN THE CHAIN HOLDS NO OPEN PROPOSAL BY THAT NAME', () => {
    /* RED WHEN: a proposal the chain does not hold open is approved. */
    expect(check(made(), payloadOf(made()), chain({ open: false }))).toThrow(/holds no open proposal by this name/);
  });

  it('IS REFUSED WHEN THE PROPOSAL PAYS ANYTHING BUT THE RUN MADE HERE: ANOTHER AMOUNT, PERSON, MONTH, WINDOW OR SEED', () => {
    const raised = payloadOf(made());
    const cases: Array<[string, RunMadeHere]> = [
      ['another amount', made({ facts: facts.map((f, i) => (i === 1 ? { ...f, amount: 91n } : f)) })],
      ['another person', made({ facts: facts.map((f, i) => (i === 2 ? { ...f, payee: payeeFor('a9'.repeat(32), NET) } : f)) })],
      ['another month', made({ records: pay.records.map((r) => ({ ...r, month: '2026-10' })) })],
      ['another window', made({ closesAt: String(WINDOW.closesAt + 1n) })],
      ['another seed', made({ seeds: [{ epoch: 0, seed: '6f'.repeat(32) as Hex }] })],
      ['another number of approvals', made({ required: '2' })],
    ];
    for (const [why, m] of cases) {
      /* RED WHEN: the payload is not worked out again here from every part, so a proposal paying something else is approved. */
      expect(check(m, raised), why).toThrow(NotMadeOnThisDevice);
      expect(check(m, raised), why).toThrow(/is not what this device rebuilt/);
    }
  });

  it('IS REFUSED WHEN THE STATE IT WAS MADE FROM CARRIES A PAY-RECORD KEY OTHER THAN THE ONE THE COMPANY COMMITTED TO', () => {
    /* RED WHEN: a state whose pay-record key is not the committed one gives the nonces payments are recorded under. */
    expect(check(made(), payloadOf(made()), chain({ payKey: '5b'.repeat(32) as Hex }))).toThrow(/pay-record key other than the one the company committed to/);
    /* RED WHEN: a company that committed to no pay-record key has a run approved. */
    expect(check(made(), payloadOf(made()), chain({ payKey: null }))).toThrow(/pay-record key other than the one the company committed to/);
    /* RED WHEN: the commitment is taken as read where the page cannot read it. */
    expect(check(made(), payloadOf(made()), chain(), { ...deps, payKeyCommitmentOf: undefined })).toThrow(/cannot read the company's pay-record key/);
  });

  it('IS REFUSED WHEN ANYBODY IT PAYS IS ALREADY RECORDED AS PAID FOR THAT MONTH', () => {
    /* RED WHEN: a run paying somebody the chain records as paid for the month is approved. */
    expect(check(made(), payloadOf(made()), chain({ paid: [nonceOf(1)] }))).toThrow(/already recorded as paid for 2026-09/);
  });

  it('PAYS A NUMBERED EXTRA ONLY AS THE NEXT ONE: THE PAYMENT BEFORE IT MADE', () => {
    const extra = made({ records: pay.records.map((r, i) => (i === 0 ? { ...r, occurrence: 1 } : r)) });
    /* RED WHEN: a first extra is approved while the regular payment for that month is unpaid: two payments for one month. */
    expect(check(extra, payloadOf(extra))).toThrow(/whose payment before it has not been made/);
    /* RED WHEN: a first extra after the regular payment was made is refused. */
    expect(check(extra, payloadOf(extra), chain({ paid: [nonceOf(0, 0)] }))).not.toThrow();
    /* RED WHEN: the extra itself already paid is approved again. */
    expect(check(extra, payloadOf(extra), chain({ paid: [nonceOf(0, 0), nonceOf(0, 1)] }))).toThrow(/already recorded as paid/);
  });

  it('WHO IS PAID AND THE PAY-RECORD KEY ARE THE PERSON\'S OWN WALLET\'S READ: A SERVED LIE ABOUT EACH IS REFUSED', () => {
    const served = chain();
    /* RED WHEN: the paid entry is read from the served state, which says nobody is paid, while the wallet reads somebody paid. */
    expect(check(made({ wallet: walletRead(made(), { paid: [nonceOf(1)] }) }), payloadOf(made()), served)).toThrow(/already recorded as paid/);
    const extra = made({ records: pay.records.map((r, i) => (i === 0 ? { ...r, occurrence: 1 } : r)) });
    /* RED WHEN: the payment before an extra is taken as made because the served state says so and the wallet reads it unmade. */
    expect(check({ ...extra, wallet: walletRead(extra, {}) }, payloadOf(extra), chain({ paid: [nonceOf(0, 0)] }))).toThrow(/whose payment before it has not been made/);
    /* RED WHEN: the pay-record key is held to the served state's commitment rather than the one the wallet read. */
    expect(check(made({ wallet: walletRead(made(), { payKey: '5b'.repeat(32) as Hex }) }), payloadOf(made()), served))
      .toThrow(/pay-record key other than the one the company committed to/);
    /* And the served state is not believed the other way: a served "paid" the wallet does not read refuses nothing. */
    expect(check(made({ wallet: walletRead(made(), {}) }), payloadOf(made()), chain({ paid: [nonceOf(1)], payKey: '5b'.repeat(32) as Hex }))).not.toThrow();
  });

  it('A RUN THE WALLET READ NOTHING FOR, OR WAS NOT ASKED ABOUT IN FULL, IS REFUSED', () => {
    const m = made();
    const full = walletRead(m, {});
    /* RED WHEN: a run is approved with no read through the wallet at all, falling back on the served state. */
    expect(() => refuseWhatThisDeviceDidNotMake(deps as never, { chainId: CHAIN_ID, digest: payloadOf(m), made: m }, chain()))
      .toThrow(/Your wallet did not read whether the people on this run were already paid/);
    /* RED WHEN: an entry the wallet was not asked about is taken as unpaid. */
    expect(check(made({ wallet: { ...full, asked: full.asked.slice(1) } }), payloadOf(m))).toThrow(/was not asked about every payment/);
  });

  it('A RETRY IS CHECKED OVER A TREE OF ONLY THE PEOPLE IT NAMES, AND ONLY THEY ARE ASKED ABOUT', () => {
    const retry = made({ retry: [2], closesAt: String(WINDOW.closesAt + 600n) });
    /* RED WHEN: a retry is approved as a proposal over the leg's whole tree - its approval would then pay anybody on the leg. */
    expect(check(retry, payloadOf(retry))).toThrow(/is not what this device rebuilt/);
    /* RED WHEN: a retry whose earlier people were paid is refused, which is every retry. */
    expect(check(retry, payloadOfRetry(retry), chain({ paid: [nonceOf(0), nonceOf(1)] }))).not.toThrow();
    /* RED WHEN: a retry paying somebody already paid is approved. */
    expect(check(retry, payloadOfRetry(retry), chain({ paid: [nonceOf(2)] }))).toThrow(/already recorded as paid/);
    /* RED WHEN: a retry naming a position the run does not have, or one twice, is approved. */
    for (const bad of [[3], [], [2, 2], [-1]]) {
      const m = made({ retry: bad });
      expect(check(m, payloadOf(m)), JSON.stringify(bad)).toThrow(/names people who are not on the run it retries/);
    }
  });
});

describe('AN APPROVAL OF A VAULT\'S FIRST SECRET', () => {
  const VAULT = 'd4'.repeat(32) as Hex;
  const READERS = ['e1'.repeat(32), 'e2'.repeat(32)] as Hex[];
  const secret = { kind: 'vault-secret' as const, vault: VAULT, secret: `${'5c'.repeat(31)}00`, readers: READERS, opensAt: '100', closesAt: '200' };
  const madeRun = firstSecretRunOf({ vault: vaultCircuits as never, account: pureCircuits as never }, { vault: VAULT, secret: secret.secret as Hex, readers: READERS });
  const payload = toHex(pureCircuits.runPayload(fromHex(madeRun.root), madeRun.payees, 100n, 200n, 0n));
  it('IS BUILT ONLY FOR THE RUN MADE AGAIN HERE FROM THE SECRET, THE VAULT AND ITS READERS', () => {
    /* RED WHEN: the secret run made again here is refused. */
    expect(check(secret, payload)).not.toThrow();
    /* RED WHEN: a proposal over any other run - another secret, vault, reader or window - is approved as this one. */
    expect(check({ ...secret, secret: `${'5d'.repeat(31)}00` }, payload)).toThrow(/is not what this device rebuilt/);
    expect(check({ ...secret, vault: 'd5'.repeat(32) }, payload)).toThrow(/is not what this device rebuilt/);
    expect(check({ ...secret, readers: READERS.slice(0, 1) }, payload)).toThrow(/is not what this device rebuilt/);
    expect(check({ ...secret, closesAt: '201' }, payload)).toThrow(/is not what this device rebuilt/);
    /* RED WHEN: a payroll run's payload passes as a vault's secret run: no secret makes a payroll run's root. */
    expect(check(secret, payloadOf(made()))).toThrow(/is not what this device rebuilt/);
    /* RED WHEN: a secret run is taken as made again where the page cannot make one. */
    expect(check(secret, payload, chain(), { ...deps, secretRun: undefined })).toThrow(/cannot make a vault's first secret run again/);
  });
});
