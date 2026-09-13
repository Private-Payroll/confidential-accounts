/**
 * **THE RULES OF THE DOOR THAT PAYS OUT OF A VAULT, DRIVEN WITHOUT A CHAIN.**
 *
 * The door itself proves, submits and spends, so it is not run here. Everything
 * it decides is in `pay-from-vault-rules.ts` and is driven here: the answers a
 * person types, the record that lets a stopped payment be finished, the run and
 * payment built from it, the question put to the vault's holdings before any
 * fee, the next step read from the chain's answers, and what a balance read
 * afterwards means.
 */
import { describe, expect, it } from 'vitest';

import {
  amountFromText, referenceFromText, assertPublicPayee, assertVaultCanPayPublicly, assertVaultIsMarriedTo,
  windowAt, blockSecondsOf, newPayoutRecord, parsePayoutRecord, assertRecordIsThisPayment, runOf,
  vaultPaymentOf, asksOf, batchDigestOf, approvalsNeeded, nextStep, nextApprover, publicMovementOf,
  OPENS_BEFORE_NOW, STAYS_OPEN_FOR, drive, refusalBeforePayment, payoutRecordFromText, assertNotAlreadyPaid,
  finishedRecordFile, finishedRecordPrefix, type ChainFacts, type DoorActions, type PaymentAsk, type PayoutRecord,
} from './pay-from-vault-rules.js';
import { assets, ledgerTokenOf } from '../src/core/assets.js';
import { transferOf, transferFacts, privacyOf } from '../src/core/movement.js';
import { refuseWhatTheVaultCannotPay, VaultCannotPayThisProposal } from '../src/core/vault-holdings.js';
import { chainVaultHoldings } from '../src/midnight/vault-holdings.js';
import { VaultLedger, VaultCannotAfford, type NotePool } from '../src/midnight/vault-ledger.js';
import { vaultDetailsOf } from '../src/midnight/vault-details.js';
import { payeeFor, unshieldedPayeeFor } from '../src/testing/payees.js';
import { pureCircuits as vaultCircuits } from '../contracts/managed-vault/contract/index.js';
import { fromHex, toHex, type Hex } from '../src/core/crypto.js';
import type { VaultEntry } from '../src/midnight/vault-record.js';

const VAULT: Hex = 'c4'.repeat(32);
const ACCOUNT: Hex = 'a1'.repeat(32);
const NIGHT = ledgerTokenOf('NIGHT', 'unshielded') as Hex;
const NOW = 1_789_150_000n;
const PAYEE = unshieldedPayeeFor('5e'.repeat(32), 'stagenet');
const VAULT_ARTEFACTS = new URL('../contracts/managed-vault', import.meta.url).pathname;

const entry = (over: Partial<VaultEntry> = {}): VaultEntry => ({
  name: 'payroll-test-3', contractAddress: VAULT, accountAddress: ACCOUNT, deployedAt: '2026-09-09T02:19:06.000Z',
  circuits: ['deposit', 'depositUnshielded', 'payout', 'payoutUnshielded', 'splitNote', 'retire', 'forgetUnshielded'],
  maintenanceAuthority: {} as never, ...over,
} as VaultEntry);

const ask = (over: Partial<PaymentAsk> = {}): PaymentAsk => ({
  network: 'stagenet', vault: 'payroll-test-3', payTo: PAYEE.bech32, amount: 10n, reference: 'first payout', ...over,
});

let counter = 0;
const fresh = (): Hex => { counter += 1; return counter.toString(16).padStart(2, '0').repeat(32) as Hex; };
const record = (over: Partial<PaymentAsk> = {}): PayoutRecord =>
  newPayoutRecord(ask(over), fresh, NOW, '2026-09-11T12:00:00.000Z');

const factsFor = (amount: bigint) => transferFacts(transferOf({
  accountId: 'vault:payroll-test-3', payee: PAYEE, asset: 'NIGHT', amount,
  privacy: privacyOf(PAYEE), reference: 'first payout', createdBy: 'a test', employees: [],
}));

describe('§1 what a person types', () => {
  it('takes an amount as digits in the smallest unit, and refuses anything else by name', () => {
    expect(amountFromText(' 1250 ')).toBe(1250n);
    expect(() => amountFromText('')).toThrow(/no amount was given/);
    expect(() => amountFromText('12.5')).toThrow(/Digits and nothing else/);
    expect(() => amountFromText('-3')).toThrow(/Digits and nothing else/);
    expect(() => amountFromText('1,000')).toThrow(/Digits and nothing else/);
    expect(() => amountFromText('0')).toThrow(/positive amount/);
  });

  it('requires a reference', () => {
    expect(referenceFromText(' rent ')).toBe('rent');
    expect(() => referenceFromText('  ')).toThrow(/has no reference/);
  });

  it('REFUSES a private address, because this door pays out of the public balance', () => {
    expect(assertPublicPayee(PAYEE)).toBe(PAYEE);
    expect(() => assertPublicPayee(payeeFor('7a'.repeat(32), 'stagenet'))).toThrow(/that is a private address/);
  });
});

describe('§2 the vault it pays from', () => {
  it('REFUSES a vault that does not carry payoutUnshielded, and names what it does carry', () => {
    expect(() => assertVaultCanPayPublicly(entry())).not.toThrow();
    expect(() => assertVaultCanPayPublicly(entry({ circuits: ['deposit', 'payout'] })))
      .toThrow(/does not list payoutUnshielded.*It lists: deposit, payout/);
  });

  it('REFUSES a vault married to an account that is not the deployed one, and prints neither address', () => {
    expect(() => assertVaultIsMarriedTo(entry(), { contractAddress: ACCOUNT.toUpperCase() })).not.toThrow();
    const other = () => assertVaultIsMarriedTo(entry(), { contractAddress: 'b2'.repeat(32) });
    expect(other).toThrow(/married to an account that is not the one deployed/);
    expect(() => assertVaultIsMarriedTo(entry(), null)).toThrow(/married to an account/);
    expect(() => assertVaultIsMarriedTo(entry({ accountAddress: '' }), { contractAddress: '' })).toThrow(/married/);
    try { other(); } catch (e) {
      expect((e as Error).message).not.toContain(ACCOUNT);
      expect((e as Error).message).not.toContain('b2'.repeat(32));
    }
  });
});

describe('§3 the window, in seconds', () => {
  it('opens ten minutes before it is written and closes a day after', () => {
    expect(windowAt(NOW)).toEqual({ opensAt: NOW - OPENS_BEFORE_NOW, closesAt: NOW + STAYS_OPEN_FOR });
    expect(OPENS_BEFORE_NOW).toBe(600n);
    expect(STAYS_OPEN_FOR).toBe(86_400n);
  });

  it('REFUSES a time in milliseconds, which would build a window that never closes', () => {
    expect(() => windowAt(NOW * 1000n)).toThrow(/milliseconds, not seconds/);
    expect(() => windowAt(5n)).toThrow(/not a time in seconds/);
  });

  it('reads block time as whole seconds from the indexer\'s milliseconds', () => {
    expect(blockSecondsOf(1_789_150_000_999)).toBe(1_789_150_000n);
    expect(() => blockSecondsOf(0)).toThrow(/not a time/);
    expect(() => blockSecondsOf(Number.NaN)).toThrow(/not a time/);
  });
});

describe('§4 the record written before the first fee', () => {
  it('holds what was asked, a window, and two different random values, and reads back as itself', () => {
    const r = record();
    expect(r).toMatchObject({ format: 1, network: 'stagenet', vault: 'payroll-test-3', payTo: PAYEE.bech32, amount: '10', reference: 'first payout' });
    expect(r.opensAt).toBe((NOW - 600n).toString());
    expect(r.closesAt).toBe((NOW + 86_400n).toString());
    expect(r.seed).not.toBe(r.salt);
    expect(parsePayoutRecord(JSON.parse(JSON.stringify(r)), 'the record')).toEqual(r);
  });

  it('REFUSES to write a record from a random source that gave the same value twice', () => {
    expect(() => newPayoutRecord(ask(), () => 'ab'.repeat(32) as Hex, NOW, 'now')).toThrow(/two different 32-byte values/);
  });

  it('REFUSES a record read back with any field it cannot finish from, naming the field', () => {
    const r = record() as unknown as Record<string, unknown>;
    const broken = (k: string, v: unknown) => () => parsePayoutRecord({ ...r, [k]: v }, 'the record');
    expect(broken('format', 2)).toThrow(/format is 2/);
    expect(broken('seed', 'ab')).toThrow(/its seed is not 32 bytes/);
    expect(broken('salt', 'AB'.repeat(32))).toThrow(/its salt is not 32 bytes/);
    expect(broken('amount', '1.5')).toThrow(/its amount is not digits/);
    expect(broken('payTo', '')).toThrow(/it has no payTo/);
    expect(broken('opensAt', r.closesAt)).toThrow(/closes before it opens/);
    expect(() => parsePayoutRecord(null, 'the record')).toThrow(/not an object/);
  });

  it('finishes a record only with the answers it was written for, naming every difference', () => {
    const r = record();
    expect(() => assertRecordIsThisPayment(r, ask())).not.toThrow();
    expect(() => assertRecordIsThisPayment(r, ask({ amount: 11n }))).toThrow(/amount \(recorded 10, asked 11\)/);
    expect(() => assertRecordIsThisPayment(r, ask({ payTo: 'mn_addr_other' }))).toThrow(/the address paid/);
    expect(() => assertRecordIsThisPayment(r, ask({ reference: 'x' }))).toThrow(/reference \(recorded "first payout", asked "x"\)/);
    expect(() => assertRecordIsThisPayment(r, ask({ vault: 'payroll-test-4' }))).toThrow(/vault \(recorded "payroll-test-3"/);
    expect(() => assertRecordIsThisPayment(r, ask({ network: 'preview' }))).toThrow(/network \(recorded stagenet, asked preview\)/);
    expect(() => assertRecordIsThisPayment(r, ask({ amount: 11n }))).toThrow(/Nothing was proposed, approved or paid/);
  });

  it('digests a record to 32 bytes, the same way every time', () => {
    const r = record();
    expect(batchDigestOf(r)).toMatch(/^[0-9a-f]{64}$/);
    expect(batchDigestOf(r)).toBe(batchDigestOf(JSON.parse(JSON.stringify(r))));
    expect(batchDigestOf(r)).not.toBe(batchDigestOf({ ...r, amount: '11' }));
  });
});

describe('§5 the run and the payment built from the record', () => {
  it('builds the same root, leaf and secrets every time the same record is read', async () => {
    const details = await vaultDetailsOf();
    const r = record();
    const a = runOf(r, factsFor(10n), details, 'default');
    const b = runOf(JSON.parse(JSON.stringify(r)), factsFor(10n), details, 'default');
    expect(a.run.tree.root).toBe(b.run.tree.root);
    expect(a.args.leaf).toBe(b.args.leaf);
    expect(a.args.blinding).toBe(b.args.blinding);
    expect(a.args.nonce).toBe(b.args.nonce);
    expect(a.run.tree.payees).toBe(1n);
    const other = runOf({ ...r, seed: 'ee'.repeat(32) as Hex }, factsFor(10n), details, 'default');
    expect(other.args.leaf).not.toBe(a.args.leaf);
  });

  it('commits the leaf to the PUBLIC payment: the recipient, NIGHT, the amount, under the vault\'s unshielded details', async () => {
    const built = runOf(record(), factsFor(10n), await vaultDetailsOf(), 'default');
    const expected = toHex(vaultCircuits.unshieldedPayoutDetails(
      fromHex(PAYEE.userAddress), fromHex(NIGHT), 10n, fromHex(built.args.blinding)));
    expect(built.args.details).toBe(expected);
    expect(built.args.token).toBe(NIGHT);
    expect(built.run.tree.leaves).toEqual([built.args.leaf]);
  });

  it('REFUSES to build a run whose payment disagrees with the record\'s amount', async () => {
    expect(() => runOf(record(), factsFor(11n), {} as never, 'default')).toThrow(/pays 11 and the record says 10/);
  });

  it('hands the vault every argument from the run and the record, and none from anywhere else', async () => {
    const r = record();
    const built = runOf(r, factsFor(10n), await vaultDetailsOf(), 'default');
    const p = vaultPaymentOf(r, built, 'd7'.repeat(32) as Hex);
    expect(p.proposal).toBe('d7'.repeat(32));
    expect(p.root).toBe(built.run.tree.root);
    expect(p.payees).toBe(1n);
    expect(p.opensAt).toBe(NOW - 600n);
    expect(p.closesAt).toBe(NOW + 86_400n);
    expect(p.salt).toBe(r.salt);
    expect(p.payee).toBe(PAYEE);
    expect(p.token).toBe(NIGHT);
    expect(p.amount).toBe(10n);
    expect(p.blinding).toBe(built.args.blinding);
    expect(p.nonce).toBe(built.args.nonce);
    expect(p.path).toBe(built.args.path);
  });
});

describe('§6 the vault is asked whether it holds the money, before any fee, through the chain\'s reads', () => {
  const refusingPool: NotePool = {
    load: async () => { throw new Error('a public payment must not load the pool'); },
    save: async () => { throw new Error('a public payment must not save the pool'); },
    create: async () => { throw new Error('a public payment must not create a pool'); },
  };
  const vaultHolding = (rows: Array<[string, bigint]>) => new VaultLedger(
    { networkId: 'stagenet' } as never, {} as never,
    (async () => ({ publicDataProvider: { queryUnshieldedBalances: async () => rows.map(([tokenType, balance]) => ({ tokenType, balance })) } })) as never,
    {}, refusingPool, VAULT_ARTEFACTS);

  it('asks for one payment of the payment\'s own token and amount, as the account service asks', () => {
    const asks = asksOf(VAULT, assets.require('NIGHT'), factsFor(10n));
    expect(asks).toEqual({
      vault: VAULT, asset: assets.require('NIGHT'), total: 10n, payees: 1n,
      payments: [{ payee: { kind: 'unshielded' }, token: NIGHT, amount: 10n }],
    });
  });

  it('PASSES when the chain says the vault holds the amount, reading the public balance and never the pool', async () => {
    const asks = asksOf(VAULT, assets.require('NIGHT'), factsFor(10n));
    await expect(refuseWhatTheVaultCannotPay(chainVaultHoldings(vaultHolding([[NIGHT, 10n]])), asks)).resolves.toBeUndefined();
  });

  it('REFUSES before any fee when the chain says the vault holds less', async () => {
    const asks = asksOf(VAULT, assets.require('NIGHT'), factsFor(10n));
    await expect(refuseWhatTheVaultCannotPay(chainVaultHoldings(vaultHolding([[NIGHT, 9n]])), asks))
      .rejects.toThrow(VaultCannotPayThisProposal);
    await expect(refuseWhatTheVaultCannotPay(chainVaultHoldings(vaultHolding([])), asks))
      .rejects.toThrow(VaultCannotPayThisProposal);
  });
});

describe('§7 what comes next is read from the chain', () => {
  const at = (over: Partial<ChainFacts>): ChainFacts => ({
    paid: false, proposalOpen: true, approvals: 1n, needed: 1n,
    blockSeconds: NOW, opensAt: NOW - 600n, closesAt: NOW + 86_400n, ...over,
  });

  it('pays when the proposal is open, approved to the threshold, inside its window, and not yet paid', () => {
    expect(nextStep(at({}))).toBe('pay');
  });

  it('proposes when no open proposal has this run\'s identity', () => {
    expect(nextStep(at({ proposalOpen: false, approvals: 0n }))).toBe('propose');
  });

  it('approves while the chain counts fewer approvals than the vault needs', () => {
    expect(nextStep(at({ approvals: 1n, needed: 2n }))).toBe('approve');
    expect(nextStep(at({ approvals: 2n, needed: 2n }))).toBe('pay');
  });

  it('waits while the chain\'s clock is before the window, and pays at the moment it opens', () => {
    expect(nextStep(at({ blockSeconds: NOW - 601n }))).toBe('window-not-open');
    /* Proposing and approving do not wait for the window: only the payment does. */
    expect(nextStep(at({ blockSeconds: NOW - 601n, proposalOpen: false, approvals: 0n }))).toBe('propose');
    expect(nextStep(at({ blockSeconds: NOW - 601n, approvals: 0n }))).toBe('approve');
    expect(nextStep(at({ blockSeconds: NOW - 600n }))).toBe('pay');
  });

  it('stops at a window that has closed, at the second it closes, whatever else is true', () => {
    expect(nextStep(at({ blockSeconds: NOW + 86_400n }))).toBe('window-closed');
    expect(nextStep(at({ blockSeconds: NOW + 86_399n }))).toBe('pay');
    expect(nextStep(at({ blockSeconds: NOW + 86_400n, proposalOpen: false }))).toBe('window-closed');
  });

  it('NEVER PAYS TWICE: a leaf the chain has recorded is paid, whatever else is true', () => {
    expect(nextStep(at({ paid: true }))).toBe('paid');
    expect(nextStep(at({ paid: true, blockSeconds: NOW + 99_999n }))).toBe('paid');
    expect(nextStep(at({ paid: true, proposalOpen: false }))).toBe('paid');
  });

  it('needs the vault\'s own threshold when the account has one, and the account\'s otherwise', () => {
    expect(approvalsNeeded(1n, 3n)).toBe(3n);
    expect(approvalsNeeded(2n, null)).toBe(2n);
    expect(() => approvalsNeeded(0n, null)).toThrow(/no approval can meet/);
  });

  it('asks the signers in order, and refuses when the approval needed is one this machine has no signer for', () => {
    const order = ['A', 'B', 'C'] as const;
    expect(nextApprover(0n, order)).toBe('A');
    expect(nextApprover(2n, order)).toBe('C');
    expect(() => nextApprover(3n, order)).toThrow(/needs approval number 4 and this machine holds 3 signers/);
  });
});

describe('§8 what the balance afterwards says', () => {
  it('says the money left only when the balance fell by exactly the amount', () => {
    expect(publicMovementOf(100n, 90n, 10n)).toBe('left-the-vault');
    expect(publicMovementOf(100n, 100n, 10n)).toBe('did-not-move');
    expect(publicMovementOf(100n, 80n, 10n)).toBe('moved-by-a-different-amount');
    expect(publicMovementOf(100n, 105n, 10n)).toBe('moved-by-a-different-amount');
    expect(publicMovementOf(null, 90n, 10n)).toBe('not-read');
    expect(publicMovementOf(100n, null, 10n)).toBe('not-read');
  });
});

describe('§9 the whole sequence, against a chain that answers slowly', () => {
  /*
   * A chain that applies each transaction only after `lag` further reads, the
   * way an indexer answers with the state from before a transaction that has
   * already landed. Every action is logged, so what the door did, in what order
   * and how often, is what these assert.
   */
  const world = (o: { needed?: bigint; lag?: number; paid?: boolean; closed?: boolean; notOpenFor?: number; neverShows?: 'proposal' } = {}) => {
    const chain = {
      paid: o.paid ?? false, proposalOpen: false, approvals: 0n, needed: o.needed ?? 1n,
      blockSeconds: o.closed ? NOW + 86_400n : NOW - (o.notOpenFor ? 700n : 0n),
      opensAt: NOW - 600n, closesAt: NOW + 86_400n,
    };
    const log: string[] = [];
    const queued: Array<{ after: number; apply: () => void }> = [];
    const later = (apply: () => void) => queued.push({ after: o.lag ?? 0, apply });
    const act: DoorActions<'A' | 'B' | 'C'> = {
      readChain: async () => {
        for (const q of queued) if (q.after-- <= 0) q.apply();
        queued.splice(0, queued.length, ...queued.filter((q) => q.after >= 0));
        return { ...chain } as ChainFacts;
      },
      holdsTheMoney: async () => { log.push('holds'); },
      stillHoldsTheMoney: async () => { log.push('still-holds'); },
      propose: async () => {
        log.push('propose');
        if (o.neverShows !== 'proposal') later(() => { chain.proposalOpen = true; });
        return 'tx-propose';
      },
      approve: async (who) => { log.push(`approve ${who}`); later(() => { chain.approvals += 1n; }); return `tx-approve-${who}`; },
      pay: async () => { log.push('pay'); later(() => { chain.paid = true; }); return 'tx-pay'; },
      wait: async (ms) => { log.push(`wait ${ms}`); if (o.notOpenFor && ms === 7) chain.blockSeconds = NOW; },
      say: () => {},
    };
    return { act, log, chain };
  };
  const LIMITS = { steps: 12, polls: 5, pollMs: 1, notOpenYetMs: 7 };
  const actions = (log: string[]) => log.filter((l) => !l.startsWith('wait'));

  it('asks the vault, proposes, approves to the threshold in order, asks again, and pays, each exactly once', async () => {
    const w = world({ needed: 2n });
    const r = await drive(w.act, ['A', 'B', 'C'], LIMITS);
    expect(actions(w.log)).toEqual(['holds', 'propose', 'approve A', 'approve B', 'still-holds', 'pay']);
    expect(r.paidIn).toBe('tx-pay');
    expect(r.final.paid).toBe(true);
  });

  it('A SLOW INDEXER DOES NOT MAKE IT PROPOSE, APPROVE OR PAY TWICE', async () => {
    const w = world({ needed: 2n, lag: 3 });
    await drive(w.act, ['A', 'B', 'C'], LIMITS);
    expect(actions(w.log)).toEqual(['holds', 'propose', 'approve A', 'approve B', 'still-holds', 'pay']);
  });

  it('REFUSES BEFORE ANY PROPOSAL when the vault does not hold the money', async () => {
    const w = world();
    w.act.holdsTheMoney = async () => { w.log.push('holds'); throw new Error('the vault holds 9'); };
    await expect(drive(w.act, ['A'], LIMITS)).rejects.toThrow(/the vault holds 9/);
    expect(w.log).toEqual(['holds']);
  });

  it('REFUSES BEFORE THE PAYMENT when the vault no longer holds it', async () => {
    const w = world();
    w.act.stillHoldsTheMoney = async () => { w.log.push('still-holds'); throw new Error('spent meanwhile'); };
    await expect(drive(w.act, ['A'], LIMITS)).rejects.toThrow(/spent meanwhile/);
    expect(actions(w.log)).toEqual(['holds', 'propose', 'approve A', 'still-holds']);
  });

  it('STOPS, with nothing further submitted, when the chain never shows a transaction it was sent', async () => {
    const w = world({ neverShows: 'proposal' });
    await expect(drive(w.act, ['A'], LIMITS)).rejects.toThrow(/the proposal was submitted and the chain has not shown it after 5 reads/);
    expect(actions(w.log)).toEqual(['holds', 'propose']);
  });

  it('does nothing at all for a payment the account has already recorded', async () => {
    const w = world({ paid: true });
    const r = await drive(w.act, ['A'], LIMITS);
    expect(w.log).toEqual([]);
    expect(r.paidIn).toBeNull();
  });

  it('REFUSES a closed window before any action', async () => {
    const w = world({ closed: true });
    await expect(drive(w.act, ['A'], LIMITS)).rejects.toThrow(/window of the recorded run has closed/);
    expect(w.log).toEqual([]);
  });

  it('waits for a window the chain\'s clock has not reached, then pays', async () => {
    const w = world({ notOpenFor: 1 });
    await drive(w.act, ['A'], LIMITS);
    expect(w.log).toContain('wait 7');
    expect(actions(w.log)).toEqual(['holds', 'propose', 'approve A', 'still-holds', 'pay']);
  });

  it('stops and says so when the steps run out', async () => {
    const w = world({ needed: 3n });
    await expect(drive(w.act, ['A', 'B', 'C'], { ...LIMITS, steps: 2 })).rejects.toThrow(/after 2 steps/);
  });
});

describe('§10 what a person is told when the vault says no just before paying', () => {
  it('says a chain that could not be read is NOT the vault holding too little, and not to deposit again', () => {
    const e = refusalBeforePayment(new VaultCannotAfford(VAULT, 'chain-unreadable', 'the indexer did not answer')) as Error;
    expect(e.message).toMatch(/could not be read just now, so nothing was paid/);
    expect(e.message).toMatch(/do not deposit again/);
    expect(e.message).not.toMatch(/no longer holds/);
  });

  it('says a short vault is short', () => {
    const e = refusalBeforePayment(new VaultCannotAfford(VAULT, 'public-balance-short', 'holds 9')) as Error;
    expect(e.message).toMatch(/the chain says the vault no longer holds this payment/);
    expect(e.message).not.toMatch(/do not deposit again/);
  });

  it('passes on anything else unchanged', () => {
    const other = new Error('the proof server is down');
    expect(refusalBeforePayment(other)).toBe(other);
  });
});

describe('§11 a record cut short, and a payment already made', () => {
  it('REFUSES the text a write cut short leaves, by name, and reads a whole record as itself', () => {
    const r = record();
    const text = JSON.stringify(r, null, 2);
    expect(payoutRecordFromText(text, 'the record')).toEqual(r);
    expect(() => payoutRecordFromText(text.slice(0, 40), 'the record')).toThrow(/the record is not a payment record this door can finish: it is not whole JSON/);
    expect(() => payoutRecordFromText('', 'the record')).toThrow(/not whole JSON/);
  });

  it('REFUSES to start again exactly the payment a finished record made while its window is open', () => {
    const done = record();
    expect(() => assertNotAlreadyPaid([done], ask(), NOW)).toThrow(/this exact payment .* was already paid .* give it a different reference/);
  });

  it('lets a payment through that differs in any of address, amount, reference or vault, or whose window has closed', () => {
    const done = record();
    expect(() => assertNotAlreadyPaid([done], ask({ reference: 'second payout' }), NOW)).not.toThrow();
    expect(() => assertNotAlreadyPaid([done], ask({ amount: 11n }), NOW)).not.toThrow();
    expect(() => assertNotAlreadyPaid([done], ask({ payTo: 'mn_addr_other' }), NOW)).not.toThrow();
    expect(() => assertNotAlreadyPaid([done], ask({ vault: 'payroll-test-4' }), NOW)).not.toThrow();
    expect(() => assertNotAlreadyPaid([done], ask(), NOW + 86_400n)).not.toThrow();
    expect(() => assertNotAlreadyPaid([], ask(), NOW)).not.toThrow();
  });

  /**
   * **THE ASSET WAS NOT ONE OF THE FIELDS, AND A PAYMENT IS AN AMOUNT OF
   * SOMETHING.**
   *
   * Five fields were compared - network, vault, address, amount, reference -
   * and the asset was not among them. So a hundred units of one asset read as a
   * repeat of a hundred units of another, and the record the refusal named had
   * settled different money. The advice it gave was to change the reference,
   * which is asking somebody to alter a payroll reference to get round a door
   * that was wrong.
   */
  it('A DIFFERENT ASSET IS A DIFFERENT PAYMENT, not a repeat of the last one', () => {
    const TESTUSD_TOKEN = 'ab'.repeat(32);
    const done = record({ asset: 'TESTUSD', token: TESTUSD_TOKEN });
    /* RED WHEN the asset is not compared: the same address, amount and
     * reference in a DIFFERENT asset is refused as already paid. */
    expect(() => assertNotAlreadyPaid([done], ask({ asset: 'NIGHT', token: 'cd'.repeat(32) }), NOW))
      .not.toThrow();
    /*
     * **AND THE LEDGER TOKEN IS DELIBERATELY NOT COMPARED HERE.**
     *
     * RED WHEN it is. A colour is the one value in the registry a person may
     * change and they change it by minting, so the same payment to the same
     * person for the same amount under the same reference, asked again after a
     * re-mint, would carry a different token - and comparing tokens here would
     * find no match, raise a second proposal and pay them twice. The token is
     * what decides whether a record may be RESUMED, which is
     * `assertRecordIsThisPayment`'s question and not this one.
     */
    expect(() => assertNotAlreadyPaid([done], ask({ asset: 'TESTUSD', token: 'cd'.repeat(32) }), NOW))
      .toThrow(/already paid/);
    /* RED WHEN the same asset stops being caught, which is what this refusal is
     * for: the second copy of a door that stopped after the first had paid. */
    expect(() => assertNotAlreadyPaid([done], ask({ asset: 'TESTUSD', token: TESTUSD_TOKEN }), NOW))
      .toThrow(/already paid/);
    expect(() => assertNotAlreadyPaid([done], ask({ asset: 'TESTUSD', token: TESTUSD_TOKEN }), NOW))
      .toThrow(/the same address, amount, asset and reference/);
  });

  it('AND A RECORD WRITTEN BEFORE THE ASSET WAS KEPT IS STILL CAUGHT', () => {
    /*
     * RED WHEN an absent value is compared against a present one. Every record
     * written before the asset was kept names none, so comparing them strictly
     * would stop this refusing for exactly the records it exists for - and the
     * cost of refusing too often here is a changed reference, while the cost of
     * refusing too rarely is somebody paid twice.
     */
    const old = record();
    expect(() => assertNotAlreadyPaid([old], ask({ asset: 'TESTUSD', token: 'ab'.repeat(32) }), NOW))
      .toThrow(/already paid/);
    const now = record({ asset: 'TESTUSD', token: 'ab'.repeat(32) });
    expect(() => assertNotAlreadyPaid([now], ask(), NOW)).toThrow(/already paid/);
    /* RED WHEN a record naming one asset matches an ask naming another, which
     * is the defect this widening was for. */
    expect(() => assertNotAlreadyPaid([now], ask({ asset: 'NIGHT' }), NOW)).not.toThrow();
  });

  it('AND THE REFUSAL NAMES ONLY THE FIELDS IT ACTUALLY COMPARED', () => {
    /*
     * **THE ADVICE THIS REFUSAL GIVES IS TO CHANGE A PAYROLL REFERENCE**, so
     * it has to be honest about what it is advising somebody round. For a
     * record written before the asset was kept, the asset was not compared -
     * and saying it was would tell somebody two payments in different assets
     * had been shown to be the same payment.
     */
    const legacy = record();
    let said = '';
    try { assertNotAlreadyPaid([legacy], ask({ asset: 'TESTUSD' }), NOW); } catch (e) { said = String((e as Error).message); }
    /* RED WHEN it claims the asset matched a record that names none. */
    expect(said).not.toContain('amount, asset and reference');
    expect(said).toContain('amount and reference');
    /* RED WHEN it stops saying WHY the asset was not compared, which is the
     * part that lets somebody judge the refusal rather than obey it. */
    expect(said).toMatch(/written before the asset was kept with it/);

    let both = '';
    const known = record({ asset: 'TESTUSD', token: 'ab'.repeat(32) });
    try { assertNotAlreadyPaid([known], ask({ asset: 'TESTUSD' }), NOW); } catch (e) { both = String((e as Error).message); }
    /* RED WHEN a comparison that DID happen is not named, which is the other
     * half: the sentence has to track what was done. */
    expect(both).toContain('amount, asset and reference');
    expect(both).not.toMatch(/written before the asset was kept with it/);
  });
});

describe('§12 where a finished record goes, and that the check against paying it again finds it there', () => {
  it('keeps it beside the live record under a name the finished-record check looks for', () => {
    const r = record();
    const live = '/x/.midnight/stagenet-vault-payout-payroll-test-3.json';
    const kept = finishedRecordFile(live, r);
    expect(kept).toBe('/x/.midnight/stagenet-vault-payout-payroll-test-3.paid-20260911T120000000Z.json');
    const name = kept.slice(kept.lastIndexOf('/') + 1);
    expect(name.startsWith(finishedRecordPrefix('stagenet-vault-payout-payroll-test-3.json'))).toBe(true);
    expect(name.endsWith('.json')).toBe(true);
    expect(name.startsWith(finishedRecordPrefix('stagenet-vault-payout-payroll-test-30.json'))).toBe(false);
    /* RED WHEN one vault's finished records are read as another's, whose name it begins with. */
    const otherVaults = finishedRecordFile('/x/.midnight/stagenet-vault-payout-payroll-test-30.json', r);
    expect(otherVaults.slice(otherVaults.lastIndexOf('/') + 1)
      .startsWith(finishedRecordPrefix('stagenet-vault-payout-payroll-test-3.json'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * THE ASSET AND THE TOKEN A RECORD WAS APPROVED FOR
 * ------------------------------------------------------------------ */

describe('a record is finished in the money it was approved for, or not at all', () => {
  const NIGHT = '00'.repeat(32);
  const OTHER = 'ab'.repeat(32);
  const askFor = (over: Record<string, unknown> = {}) => ({
    network: 'stagenet', vault: 'payroll-test', payTo: 'mn_shield-addr_stagenet1qq', amount: 5n,
    reference: 'september', asset: 'TESTUSD', token: OTHER, ...over,
  });
  const recordFor = (ask: ReturnType<typeof askFor>) =>
    newPayoutRecord(ask, (() => { let n = 0; return () => (n++ === 0 ? '11' : '22').repeat(32) as Hex; })(),
      1_800_000_000n, '2026-09-13T00:00:00.000Z');

  it('WRITES the asset and the token into the record', () => {
    const r = recordFor(askFor());
    /* RED WHEN the record stops naming what it was approved for, which is what the comparison reads. */
    expect(r.asset).toBe('TESTUSD');
    expect(r.token).toBe(OTHER);
  });

  it('writes NEITHER when the ask names neither, so a caller that has none is unchanged', () => {
    const r = recordFor(askFor({ asset: undefined, token: undefined }));
    /* RED WHEN an absent asset is written as a placeholder, which a later comparison would trust. */
    expect(r).not.toHaveProperty('asset');
    expect(r).not.toHaveProperty('token');
  });

  it('REFUSES a record whose token is not the one this run would settle in', () => {
    const record = recordFor(askFor());
    /*
     * RED WHEN the token is not compared. A leaf commits to the token, so
     * finishing this record under another one builds a different leaf, a
     * different proposal, and a SECOND payable run while the first is open,
     * approved and inside its window. The account records payments per leaf and
     * does not refuse it.
     */
    expect(() => assertRecordIsThisPayment(record, askFor({ token: NIGHT })))
      .toThrow('the ledger token this settles in');
    expect(() => assertRecordIsThisPayment(record, askFor({ asset: 'NIGHT', token: NIGHT })))
      .toThrow('asset (recorded TESTUSD, asked NIGHT)');
  });

  it('REFUSES a record that names NEITHER on a door whose asset can change between runs', () => {
    const legacy = recordFor(askFor({ asset: undefined, token: undefined }));
    /*
     * RED WHEN a record written before the token was kept is finished anyway on
     * such a door. That is the same second-proposal hazard with nothing to
     * compare: the record fixes the payee, the amount and the reference, and a
     * leaf commits to the token.
     */
    expect(() => assertRecordIsThisPayment(legacy, askFor()))
      .toThrow('names no asset and no ledger token');
    expect(() => assertRecordIsThisPayment(legacy, askFor(), true))
      .toThrow('names no asset and no ledger token');
  });

  it('FINISHES that same record on a door whose asset cannot change, which is not a hazard there', () => {
    const legacy = recordFor(askFor({ asset: undefined, token: undefined }));
    /*
     * RED WHEN the strictness is applied where it strands money instead of
     * saving it: a door whose asset is a literal and whose token is a constant
     * cannot settle one record in two different moneys, and its old records
     * have proposals already open and approved on chain.
     */
    expect(() => assertRecordIsThisPayment(legacy, askFor(), false)).not.toThrow();
  });

  it('takes a record and an ask that agree, on either kind of door', () => {
    const record = recordFor(askFor());
    /* RED WHEN a matching record is refused, which strands every resumed payment. */
    for (const strict of [true, false]) {
      expect(() => assertRecordIsThisPayment(record, askFor(), strict), String(strict)).not.toThrow();
    }
  });

  it('REFUSES a record carrying a present-but-empty asset rather than reading past it', () => {
    const record = { ...recordFor(askFor()), asset: '' };
    /* RED WHEN an empty value is read as an absent one, which is a comparison that passes on nothing. */
    expect(() => parsePayoutRecord(record, 'a record')).toThrow('its asset is present and is not a usable value');
  });
});
