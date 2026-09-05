import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './store-file.js';
/* `signerRemovePayload` was imported here until `S44`; it is a scheme method now. `C373`. */
import { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } from './ledger.js';
import type { LedgerStatus, StateChange, StateView } from './ledger.js';
import { AccountService, openAccount, sealAccount, approvalMessage } from './account.js';
import { payeeAddressFromKeys } from '../midnight/payee-address.js';
import { PayrollService, RecordingInviteDelivery } from './payroll.js';
import { PluginService } from './plugins.js';
import { NO_ASSET } from './assets.js';
import type { ShieldedState, StateBlinding } from './types.js';
import { newWrappingKeypair, newSigningKeypair, newSymmetricKey, seal, unseal,
  commit, newProposalSalt, canonical, parseCanonical } from './crypto.js';
import {
  openRecord, sealRecord, sealToInbox, openFromInbox, inboxPublicKey,
} from './sealed-records.js';
import { IdentityService } from './identity.js';
import { MemorySessionStore } from './sessions.js';
import { MemoryChallengeStore } from './challenges.js';
import { sign } from './crypto.js';
import { redactHex } from '../testing/redact.js';
import { privatePayee } from '../testing/payees.js';
import { addressFingerprint } from 'midnight-identity/profile/fingerprint';
import {
  sealHandover, HANDOVER_SCHEMA, type SealedHandover,
} from './invite-handover.js';
import type { DataStore } from './store.js';
import type { Hex } from './crypto.js';
import type { PayeeAddress } from '../midnight/payee-address.js';

/**
 * **X11 §7 — THE INVITEE'S OWN DEVICE SEALS, SO A TEST HAS TO SEAL TOO.**
 *
 * `acceptInvite` has nowhere to put a plain address any more: it takes a blob
 * the service cannot open, sealed to the account's inbox public key. That key
 * reaches a real invitee inside the sealed offer; here it is looked up from the
 * invite the token belongs to, which is the same account by construction.
 */
const handedOver = (
  h: { store: DataStore },
  token: string,
  parts: { wrappingPublicKey: Hex; address: PayeeAddress; confirmation?: string | null },
): SealedHandover => {
  const invite = h.store.getInvite(token);
  if (!invite) throw new Error(`no invite for ${token} — the test is wrong, not the code`);
  const account = h.store.getAccount(invite.accountId);
  if (!account) throw new Error('no account for that invite');
  return sealHandover(
    {
      wrappingPublicKey: parts.wrappingPublicKey,
      address: parts.address.bech32,
      /* X12 §2 — the code the invitee read off their own wallet. Null here:
       * these tests are about what the SERVICE does with a handover, and the
       * comparison the code exists for is made on an admin's screen. */
      confirmation: parts.confirmation ?? null,
    },
    account.inboxPublicKey);
};

/**
 * **`limits` IS GONE FROM HERE.** `PI4b`.
 *
 * It existed so a test about the SHAPE of the limiter did not have to spend
 * sixty round trips reaching the production ceiling — and every test that used
 * it was an S-2 test against `login`. `login` is deleted; the door that counts
 * is the wallet sign-in, and the same trick is done at its own harness in
 * `wallet-sign-in.test.ts`, where the limiter now lives.
 */
function harness() {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-')), 'db.json'));
  const ledger = new SimulatedLedger(SimulatedCommitments);
  const proofs = new SimulatedProofSystem();
  const accounts = new AccountService(store, ledger, SimulatedCommitments);
  /*
   * The invite delivery, read by tests the way an employee reads their email.
   * `X11` §1 REVERSED `A-10`: `invite()` now hands the token back to whoever
   * raised it, once, because the admin is the one who sends the link and there
   * is no mailer. The assertion that states the new rule is below, at the
   * exhaustive key check on `invite()`'s return; `C21` is the row that carries
   * what the reversal costs.
   */
  const invites = new RecordingInviteDelivery();
  const payroll = new PayrollService(store, accounts, proofs, undefined, 'undeployed', invites);
  const plugins = new PluginService(store, accounts);
  // In-memory sessions: the same class the standalone build uses, so these
  // tests exercise a real implementation rather than a stub. The Postgres one
  // is held to the identical contract in sessions.test.ts.
  const sessionStore = new MemorySessionStore();
  const challenges = new MemoryChallengeStore();
  /* `PI4b`: no limiter. `IdentityService` counts nothing now — it holds the
   * session and the sealed bundle, and the door that counts is the wallet
   * sign-in, which takes its own. */
  const identity = new IdentityService(store, sessionStore);
  return {
    store, ledger, proofs, accounts, payroll, plugins, identity, sessionStore, invites, challenges,
  };
}

/**
 * Gives somebody a sign-in, so they can redeem their own invite.
 *
 * A-11: `admit` checks that whoever redeemed the invite is signed in as the
 * person the company said it was hiring. A test that skipped that would be
 * asserting against a roster state the product cannot produce.
 */
const signIn = (h: { store: { putUser: (u: any) => void } }, email: string, name = email) => {
  const id = 'usr_' + email.replace(/[^a-z0-9]/gi, '_');
  h.store.putUser({
    /* `PI4b`: `authHash: ''` and `authSalt: ''` were here and the empty strings
     * were the tell — this fixture never had a password to hash. Both fields
     * are deleted from `User`. */
    id, email, name, keyBundle: null,
    createdAt: '2026-08-17T00:00:00.000Z',
  });
  return id;
};

/**
 * The store as text, with every ciphertext and key blanked. M-101.
 *
 * Searching raw ciphertext for a salary is a false-positive generator, and it
 * was firing about one run in twenty. The sealed bodies are hex, `"6200"` and
 * `"1337"` are valid hex, and AES emits those four characters often enough that
 * `not.toContain('6200')` fails at random on correct code. **A test that cries
 * wolf is worse than one that always fails**, because the failure gets waved
 * through as flakiness — and these are the tests that stand between us and the
 * two leaks this project has already shipped.
 *
 * Blanking every long hex run keeps exactly the property under test. If a name,
 * a salary or a role is readable, it is sitting in a PLAINTEXT field, and a
 * plaintext field is not 32 characters of hex. Nothing that could hide a real
 * leak is removed.
 *
 * Long values that must be searched for literally — a `leafCommitment` is 64
 * hex characters — are searched in the RAW text instead. At that length a
 * chance collision is not a thing that happens.
 *
 * BIGINTS ARE RENDERED AS THEIR DIGITS. M-125. Every amount is a bigint now and
 * `JSON.stringify` throws on one, which would turn this helper into a crash
 * rather than a check. Their decimal digits are exactly what a leaked salary
 * would look like in the file the store writes, so rendering them is the
 * property under test rather than a concession to it.
 */
/*
 * MOVED OUT, 16 Aug. This was a private helper here, and `sealed-records.test.ts`
 * wrote the same check without it — because there was no way to reach it — and
 * flaked at random for two afternoons. One rule held somewhere nobody else can
 * get to is the same defect as one rule written twice. T-12.
 */
const readableStore = redactHex;

/** A leaf commitment as an invitee's device would compute it. */
const LEAF = 'ab'.repeat(32);
/*
 * There is deliberately no BLINDING constant any more. M-99 needed the invitee
 * to hand over the blinding behind their leaf, because a removal re-seated
 * every survivor and could not compute their new leaves without it. M-106
 * re-seats nobody, so the blinding never leaves the invitee's device and the
 * API that accepted it is gone — see `Signer` in core/types.ts.
 */

/**
 * Edits an account the way a signer holding the key would. M-96.
 *
 * Since the account is sealed, a test that wants to change a spending limit or
 * shove a ghost signer into the roster can no longer reach into the store and
 * write a field — which is the entire point of the change, and is why these
 * tests had to be touched at all. Open, edit, re-seal.
 */
function editAccount(
  h: ReturnType<typeof harness>,
  accountId: string,
  viewingKey: string,
  edit: (a: import('./types.js').Account) => void,
) {
  const rec = h.accounts.require(accountId);
  const account = openAccount(rec, viewingKey);
  edit(account);
  h.store.putAccount(sealAccount(account, viewingKey, rec.pendingSigners, rec.keyEpoch));
  return account;
}

const THREE_SIGNERS = [
  { name: 'Ada', role: 'admin' as const },
  { name: 'Blake', role: 'approver' as const },
  { name: 'Cleo', role: 'approver' as const },
];

describe('account layer', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('creates a 2 of 3 account and every signer can recover the viewing key', async () => {
    const { account, viewingKey, secrets } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    expect(account.signers).toHaveLength(3);
    expect(account.policy.threshold).toBe(2);
    for (const s of secrets) {
      expect(h.accounts.recoverViewingKey(account.id, s.signerId, s.wrappingSecret)).toBe(viewingKey);
    }
  });

  it('refuses a threshold larger than the signer set', async () => {
    await expect(h.accounts.create('Bad', THREE_SIGNERS, 4)).rejects.toThrow(/not valid/);
  });

  it('will not open shielded state with a key that is not the viewing key', async () => {
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const stranger = 'ff'.repeat(32);
    await expect(h.accounts.readState(account.id, stranger)).rejects.toThrow(/cannot open/);
  });

  it('a signer outside the account cannot unwrap the viewing key', async () => {
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const outsider = newWrappingKeypair();
    expect(() =>
      h.accounts.recoverViewingKey(account.id, account.signers[0].id, outsider.secret),
    ).toThrow();
  });

  it('rejects an approval signed with the wrong key', async () => {
    const { account, viewingKey, secrets } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const p = await h.accounts.propose({
      accountId: account.id, viewingKey, kind: 'transfer', summary: 'x',
      payload: { entries: [{ id: 'e1', kind: 'transfer', asset: 'GBP', amount: 10_00n, counterparty: 'y', memo: '', at: '' }] },
      proposedBy: secrets[0].signerId,
    });
    // Blake's id, Cleo's key.
    await expect(
      h.accounts.approve(p.id, secrets[1].signerId, sign(approvalMessage(p), secrets[2].signingSecret), viewingKey),
    ).rejects.toThrow(/does not match/);
  });

  it('blocks a proposal that breaches a role spending limit', async () => {
    const { account, viewingKey, secrets } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    /*
     * A CEILING IS KEYED BY ASSET. M-125.
     *
     * `limitsByRole.approver` used to be one `SpendingLimit`; it is now one per
     * asset, because 5,000 is a sensible monthly ceiling in pounds and a
     * fortune in ether, and a single number covering both would either block
     * every legitimate ETH payment or wave through every fraudulent one.
     */
    editAccount(h, account.id, viewingKey, a => {
      a.policy.limitsByRole = {
        approver: { GBP: { perTransaction: 1_000_00n, perPeriod: null, periodDays: 30 } },
      };
    });

    const p = await h.accounts.propose({
      accountId: account.id, viewingKey, kind: 'transfer', summary: 'over limit',
      payload: { entries: [{ id: 'e1', kind: 'transfer', asset: 'GBP', amount: 5_000_00n, counterparty: 'y', memo: '', at: '' }] },
      proposedBy: secrets[1].signerId, // Blake, an approver
    });
    expect(p.status).toBe('blocked');
    // The refusal names the asset, because a ceiling that does not is a number
    // about a different question.
    expect(p.blockedReason).toMatch(/per-transaction GBP limit/);
  });
});

describe('payroll and disclosure', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  async function setup() {
    const created = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    // Every figure is an integer in the asset's smallest unit, so £6,200.00 is
    // `6_200_00n`. There is no float anywhere in this system. M-125, D11.
    const { run, secrets: emp } = await h.payroll.createRun(created.account.id, '2026-07', [
      { name: 'Dana', asset: 'GBP', amount: 6_200_00n },
      { name: 'Eli', asset: 'GBP', amount: 4_800_00n },
      { name: 'Fern', asset: 'GBP', amount: 9_000_00n },
    ], created.viewingKey);
    return { ...created, run, emp };
  }

  it('lets an employee open their own payslip and nobody else\'s', async () => {
    const s = await setup();
    const dana = h.payroll.employeeView(s.run.id, s.emp[0].employeeId, s.emp[0].wrappingSecret);
    expect((dana.payslip as any).amount).toBe(6_200_00n);
    expect((dana.payslip as any).asset).toBe('GBP');
    expect((dana.payslip as any).name).toBe('Dana');

    // Eli's key against Dana's payslip.
    expect(() =>
      h.payroll.employeeView(s.run.id, s.emp[0].employeeId, s.emp[1].wrappingSecret),
    ).toThrow(/cannot open/);
  });

  it('does not let account signers open an individual payslip', async () => {
    const s = await setup();
    // The account viewing key is not a wrapping secret and must not work.
    expect(() =>
      h.payroll.employeeView(s.run.id, s.emp[0].employeeId, s.viewingKey),
    ).toThrow(/cannot open/);
  });

  it('leaks no salary, name or email TO US — the store itself', async () => {
    /*
     * S-9. The test that was missing, and whose absence let the leak survive.
     *
     * The one below it checks what the CHAIN can see, and its name reads as
     * "everyone" when it means "an outside observer of the ledger". Our own
     * database was never covered, and it held every employee's name, email and
     * salary in the clear.
     *
     * This serialises what the SERVER holds. It is the claim a customer
     * actually cares about: our payroll provider cannot see what we pay people.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    /*
     * `salary` and `currency` USED TO BE TWO FIELDS HERE, and M-125 replaced
     * them with one `asset` and one `baseAmount` in that asset's smallest unit.
     * An earlier draft also carried `denomination` beside `settlementAsset`, so
     * somebody hired at $5,000 could be paid in USDC at a recorded rate.
     * Exchange rates were ruled out of the product, and two fields required to
     * be equal is one field and a bug waiting to be written.
     */
    h.payroll.hireDirect(account.id, { name: 'Dana Whitfield', email: 'dana@acme.co', title: 'Engineer', asset: 'GBP', baseAmount: 6_200_00n }, viewingKey);
    h.payroll.hireDirect(account.id, { name: 'Sam Ortega', email: 'sam@acme.co', title: 'Designer', asset: 'GBP', baseAmount: 4_800_00n }, viewingKey);

    const whatWeHold = readableStore((h.store as any).data.employees);

    for (const amount of [6_200_00n, 4_800_00n]) expect(whatWeHold).not.toContain(String(amount));
    for (const text of ['Dana Whitfield', 'Sam Ortega', 'dana@acme.co', 'sam@acme.co', 'Engineer', 'Designer']) {
      expect(whatWeHold).not.toContain(text);
    }

    /*
     * Nor WHICH CURRENCY anybody is paid in. Asserted as a shape rather than a
     * substring: an asset code is three characters and a nanoid is drawn from a
     * 64-character alphabet, so `not.toContain('GBP')` would fire at random on
     * correct code — the M-101 lesson. There is no field on the stored record
     * through which an asset could be written in the clear, which is the
     * property, and `asset` is not among them.
     */
    const sealedPerson = h.store.listEmployees(account.id)[0];
    expect(Object.values(sealedPerson).some(v => v === 'GBP')).toBe(false);

    // And the same for invites, which used to carry a duplicate copy.
    expect(readableStore((h.store as any).data.invites)).not.toContain('620000');
    expect(readableStore((h.store as any).data.invites)).not.toContain('dana@acme.co');

    // The roster still reads correctly for someone who holds the key.
    const roster = h.payroll.listPeople(account.id, viewingKey); // sorted by name
    expect(roster.map(e => e.baseAmount)).toEqual([6_200_00n, 4_800_00n]);
    expect(roster.map(e => e.asset)).toEqual(['GBP', 'GBP']);
  });

  /*
   * THREE SOLVENCY TESTS STOOD HERE AND ARE REPLACED BY ONE. `C292`, `S26`.
   *
   * They proved a threshold against the account's balance, refused an asset it
   * had never held, and refused a false statement. All three needed a balance,
   * and the account keeps none.
   *
   * `attestSolvency` IS NOT DELETED: the brief reserves it and its screen for a
   * round of their own. What it must not do meanwhile is issue an attestation
   * that is true only because there is nothing to be solvent with, which is
   * `rule 14` and `rule 29`. So it refuses, and this test is what holds it to
   * refusing rather than quietly attesting zero.
   */
  it('refuses to attest solvency at all, because there is no balance to attest to', async () => {
    const s = await setup();
    await expect(
      h.payroll.attestSolvency(s.account.id, s.viewingKey, 'GBP', 50_000_00n),
    ).rejects.toThrow(/holds no balance/);
  });

  /**
   * **THE REFUSAL USED TO SAY *"cannot attest an unsettled run"*, AND `S47`
   * CHANGED THE SENTENCE RATHER THAN THE BEHAVIOUR.** `T-217` `F10`, `T-234`.
   *
   * That wording describes a RUN, as though settling one were a step somebody
   * could go and take. It is not: `run.status` is assigned in exactly two
   * places in `src/`, `'draft'` and `'proposed'`, and **`'settled'` is assigned
   * nowhere** — `C292`/`S26` deleted `settle` with the balance. Rule 19 says a
   * refusal names the door that resolves it, and when there is no door the
   * honest refusal says so.
   *
   * **AND THIS ASSERTS THE FACT, NOT THE WORDING**, so it is the mechanical
   * half rather than a string check: the day something assigns `'settled'`,
   * the second expectation goes red and the sentences above it — in
   * `payroll.ts`, in the three routes and on the screen — have to be revisited
   * in the same round. Rule 14's own instrument.
   */
  it('will not attest a run that has not settled, because nothing can settle one', async () => {
    const s = await setup();
    await expect(h.payroll.attestPayrollTotal(s.run.id, s.viewingKey, 'GBP'))
      .rejects.toThrow(/no run in this product can be anything else/);

    const src = readFileSync(new URL('./payroll.ts', import.meta.url), 'utf8');
    const writers = [...src.matchAll(/run\.status\s*=\s*'([a-z]+)'|status:\s*'([a-z]+)'/g)]
      .map(m => m[1] ?? m[2]);
    expect(writers, 'something now assigns a run status; revisit every sentence that says nothing can')
      .not.toContain('settled');
  });
});

describe('roster', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('keeps an employee key stable across runs so old payslips stay readable', async () => {
    const { account, viewingKey, secrets } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { secret } = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'dana@acme.co', title: 'Engineer', asset: 'GBP', baseAmount: 6_200_00n,
    }, viewingKey);

    const june = await h.payroll.createRunFromRoster(account.id, '2026-06', viewingKey);
    const july = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    // The same secret opens both months.
    for (const r of [june.run, july.run]) {
      const v = h.payroll.employeeView(r.id, secret.employeeId, secret.wrappingSecret);
      expect((v.payslip as any).amount).toBe(6_200_00n);
    }
  });

  it('excludes leavers from a run', async () => {
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    h.payroll.hireDirect(account.id, { name: 'Stay', email: 's@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n }, viewingKey);
    const { employee } = h.payroll.hireDirect(account.id, { name: 'Go', email: 'g@a.co', title: 'Eng', asset: 'GBP', baseAmount: 200_00n }, viewingKey);
    h.payroll.setStatus(employee.id, 'leaver', viewingKey);
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);
    expect(run.employees.map(e => e.name)).toEqual(['Stay']);
    /*
     * `run.total` USED TO BE HERE and M-125 replaced it with `totals`, a
     * subtotal per asset. One figure across mixed currencies is not an
     * approximation, it is meaningless, and the sufficiency check that used it
     * would pass or fail for reasons unrelated to whether the account can pay
     * anybody. Comparing the whole map is what makes the leaver's absence a
     * fact about every asset rather than about one of them.
     */
    expect(run.totals).toEqual({ GBP: 100_00n });
  });

  it('refuses a duplicate period', async () => {
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    h.payroll.hireDirect(account.id, { name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n }, viewingKey);
    const first = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);
    h.store.putRun({ ...h.store.getRun(first.run.id)!, status: 'proposed' });
    await expect(h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey)).rejects.toThrow(/already exists/);
  });
});

describe('onboarding', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('a pending signer can see nothing until access is granted', async () => {
    const { account, viewingKey, secrets } = await h.accounts.create('Acme', [THREE_SIGNERS[0]], 1);
    const invite = h.accounts.inviteSigner(account.id, 'Blake', 'b@acme.co', 'approver');

    // The invitee's device generates its own keys. Only public halves travel.
    const sk = newSigningKeypair(); const wk = newWrappingKeypair();
    const pending = h.accounts.acceptSignerInvite(invite.token, null, sk.publicKey, wk.publicKey, LEAF);
    expect(pending.status).toBe('pending');

    // No wrapped key exists for them, so they cannot reach the viewing key.
    expect(() => h.accounts.recoverViewingKey(account.id, pending.id, wk.secret))
      .toThrow(/no wrapped key/);

    /*
     * M-69/M-37. Granting access to a LIVE account is an approval round, not a
     * single call: the account already has as many signers as its threshold, so
     * one existing signer adding another freely would make the threshold
     * decorative. Propose the signer, reach the threshold, then grant.
     */
    const seat = await h.accounts.proposeSigner(account.id, viewingKey, pending.id, secrets[0].signerId);
    await h.accounts.approve(seat.id, secrets[0].signerId, sign(approvalMessage(seat), secrets[0].signingSecret), viewingKey);

    await h.accounts.grantAccess(account.id, viewingKey, pending.id);
    expect(h.accounts.recoverViewingKey(account.id, pending.id, wk.secret)).toBe(viewingKey);
  });

  it('a pending signer cannot approve', async () => {
    const { account, viewingKey, secrets } = await h.accounts.create('Acme', [THREE_SIGNERS[0]], 1);
    const invite = h.accounts.inviteSigner(account.id, 'Blake', 'b@acme.co', 'approver');
    const sk = newSigningKeypair(); const wk = newWrappingKeypair();
    const pending = h.accounts.acceptSignerInvite(invite.token, null, sk.publicKey, wk.publicKey, LEAF);

    const p = await h.accounts.propose({
      accountId: account.id, viewingKey, kind: 'transfer', summary: 'x',
      payload: { entries: [{ id: 'e1', kind: 'transfer', asset: 'GBP', amount: 10_00n, counterparty: 'y', memo: '', at: '' }] },
      proposedBy: secrets[0].signerId,
    });
    /*
     * **A REAL SIGNATURE, SO THE REFUSAL IS THE ONE THIS TEST NAMES.** `C121`.
     *
     * Passing `sk.secret` where a signature belongs would also be refused, and
     * this test would stay green while asserting nothing about `status` — the
     * status check happens to run first, so the reason would be right by
     * accident. Blake's key is the key registered against Blake's seat; the
     * only thing wrong with this approval is that nobody has granted it yet.
     */
    await expect(h.accounts.approve(p.id, pending.id, sign(approvalMessage(p), sk.secret), viewingKey))
      .rejects.toThrow(/not been granted access/);
  });

  it('an invite cannot be used twice', async () => {
    const { account, viewingKey } = await h.accounts.create('Acme', [THREE_SIGNERS[0]], 1);
    const invite = h.accounts.inviteSigner(account.id, 'Blake', 'b@acme.co', 'approver');
    const a = newSigningKeypair(), b = newWrappingKeypair();
    h.accounts.acceptSignerInvite(invite.token, null, a.publicKey, b.publicKey, LEAF);
    expect(() => h.accounts.acceptSignerInvite(invite.token, null, a.publicKey, b.publicKey, LEAF))
      .toThrow(/already used/);
  });

  it('an invited employee holds no key until their own device sends one', async () => {
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'd@acme.co', title: 'Engineer', asset: 'GBP', baseAmount: 6_200_00n,
    }, viewingKey, 'usr_operator');
    expect(employee.status).toBe('pending');
    expect(employee.wrappingPublicKey).toBeNull();

    const wk = newWrappingKeypair();
    const address = payeeAddressFromKeys(
      { coinPublicKey: '31'.repeat(32), encryptionPublicKey: '32'.repeat(32) }, 'undeployed');

    /*
     * ACCEPTING IS NOT BEING ADMITTED. A-2, and it is `C9`'s gate.
     *
     * What the employee hands over goes into the account's drop box, sealed to
     * a key they do not hold. They stay pending — an address on file is not the
     * same as somebody who can reach what is sent to it, and a payment settles
     * irreversibly the moment it lands.
     */
    const handed = h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
      wrappingPublicKey: wk.publicKey, address,
    }), signIn(h, sentTo));
    expect(handed.status).toBe('pending');
    expect(handed.wrappingPublicKey).toBeNull();
    expect(handed.inbox).not.toBeNull();

    /* And nothing readable about them leaked outside the envelope on the way. */
    expect(JSON.stringify(handed)).not.toContain(address.bech32);
    expect(JSON.stringify(handed)).not.toContain(wk.publicKey);

    const admitted = h.payroll.admit(employee.id, viewingKey, 'usr_admin');
    expect(admitted.status).toBe('active');
    expect(admitted.wrappingPublicKey).toBe(wk.publicKey);
    expect(admitted.address?.bech32).toBe(address.bech32);
    /* The box is emptied, so there is never a second record of where money goes. */
    expect(h.store.getEmployee(employee.id)!.inbox).toBeNull();
  });

  it('ADMIT REBUILDS THE ADDRESS FROM ITS OWN STRING, and does not trust the object', async () => {
    /*
     * What comes out of the drop box is JSON — a shape that looks like an
     * address, not an address. If `admit` took the object at its word, a
     * handover carrying one person's spending key beside another's reading key
     * would land in the roster fully formed, and every guard downstream would
     * see a well-formed payee. That is `C7` arriving through the one door that
     * was built to close it.
     *
     * So this posts a deliberately inconsistent handover — a real address
     * string with both halves overwritten — and checks the roster ends up with
     * what the STRING says.
     *
     * **X11 §7 MADE THIS STRICTLY HARDER TO GET WRONG, AND THE TEST IS KEPT
     * ANYWAY.** The invitee's envelope now carries the address as ONE bech32
     * string and has no field for either half, so the inconsistency this test
     * describes cannot be expressed by an honest client at all. It is still
     * written by hand into the store below, because *cannot be expressed* is a
     * property of a type and this is about what `admit` does with bytes.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_operator');

    const real = payeeAddressFromKeys(
      { coinPublicKey: '51'.repeat(32), encryptionPublicKey: '52'.repeat(32) }, 'undeployed');
    const impostor = payeeAddressFromKeys(
      { coinPublicKey: '61'.repeat(32), encryptionPublicKey: '62'.repeat(32) }, 'undeployed');

    h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
      wrappingPublicKey: newWrappingKeypair().publicKey, address: real,
    }), signIn(h, sentTo));

    /*
     * Tamper with what is sitting in the box, as a broken client or an attacker
     * would — **through both envelopes**, because that is what is really
     * stored since `X11` §7.
     */
    const rec = h.store.getEmployee(employee.id)!;
    const acct = h.accounts.require(account.id);
    h.store.putEmployee({
      ...rec,
      inbox: sealToInbox({
        /* Still redeemed by the invited person; only the address is tampered with. */
        byUserId: signIn(h, sentTo),
        handover: sealToInbox({
          schema: HANDOVER_SCHEMA,
          wrappingPublicKey: newWrappingKeypair().publicKey,
          /* The string says one thing and the halves beside it say another. */
          address: real.bech32,
          coinPublicKey: impostor.coinPublicKey,
          encryptionPublicKey: impostor.encryptionPublicKey,
        }, acct.inboxPublicKey),
      }, acct.inboxPublicKey),
    });

    const admitted = privatePayee(h.payroll.admit(employee.id, viewingKey, 'usr_admin').address);
    expect(admitted.coinPublicKey).toBe(real.coinPublicKey);
    expect(admitted.encryptionPublicKey).toBe(real.encryptionPublicKey);
    expect(admitted.coinPublicKey).not.toBe(impostor.coinPublicKey);
  });

  it('RECORDS a handover redeemed by the person who raised it, rather than refusing it', async () => {
    /*
     * THIS USED TO THROW, AND REMOVING THE THROW IS THE POINT.
     *
     * "Who raised this?" is a proxy question. The one that matters is "is the
     * redeemer the payee?", and the email check answers it directly — so a
     * founder inviting themselves passes naturally, because they ARE that
     * address. What the refusal bought was one extra step for an attacker who
     * succeeds anyway (`C21`); what it cost was a second flow so founders could
     * get on their own payroll, and that flow became `C24` — an active payable
     * entry under anybody's name for one POST.
     *
     * The information survives as a recorded fact.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const founder = signIn(h, 'founder@acme.co', 'Founder');
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: [founder, 'usr_second'],
    });

    /* The founder invites themselves, through the ordinary employee flow. */
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Founder', email: 'founder@acme.co', title: 'CEO', asset: 'GBP', baseAmount: 500_00n,
    }, viewingKey, founder);
    h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: '31'.repeat(32), encryptionPublicKey: '32'.repeat(32) }, 'undeployed'),
    }), founder);

    const admitted = h.payroll.admit(employee.id, viewingKey, founder);
    expect(admitted.status).toBe('active');
    /* Visible rather than refused. */
    expect(admitted.selfRaised).toBe(true);

    /* And an ordinary hire is not marked as one. */
    const other = h.payroll.invite(account.id, {
      name: 'Dana', email: 'dana@acme.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, founder);
    h.payroll.acceptInvite(h.invites.tokenFor(other.sentTo), handedOver(h, h.invites.tokenFor(other.sentTo), {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: '41'.repeat(32), encryptionPublicKey: '42'.repeat(32) }, 'undeployed'),
    }), signIn(h, 'dana@acme.co'));
    expect(h.payroll.admit(other.employee.id, viewingKey, founder).selfRaised).toBe(false);
  });

  it('REFUSES A VIEWING KEY THAT IS NOT THIS ACCOUNT\'S, before it seals anything — C25', async () => {
    /*
     * RESTORED 17 Aug, with four others, after one splice of this file deleted
     * five tests at once. The guards all survived; their only coverage did not,
     * and an auditor found this one by deleting `requireKeyFor` and watching the
     * suite stay green. **`M-97` in the test file** — `BACKLOG.md` has a checker
     * that counts entries and no test file has anything equivalent.
     *
     * What it guards: the viewing key arrives in a request body and was never
     * checked. Seal one roster entry under a stale key — a client holding an old
     * one after a rotation is the ordinary way — and `listPeople` opens EVERY
     * entry, so the roster, and every run with it, is permanently unreadable.
     * Nothing deletes an employee, so there is no way back.
     */
    const a = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const b = await h.accounts.create('Other', THREE_SIGNERS, 2);

    expect(() => h.payroll.invite(a.account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, b.viewingKey, 'usr_operator')).toThrow();
    expect(h.payroll.listPeople(a.account.id, a.viewingKey)).toHaveLength(0);

    h.payroll.invite(a.account.id, {
      name: 'Real', email: 'r@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, a.viewingKey, 'usr_operator');
    const rotated = await h.accounts.rotate(a.account.id, a.viewingKey);
    expect(() => h.payroll.invite(a.account.id, {
      name: 'Late', email: 'l@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, a.viewingKey, 'usr_operator')).toThrow();
    expect(h.payroll.listPeople(a.account.id, rotated.viewingKey)).toHaveLength(1);
  });

  it('AN INVITEE CAN SEE WHAT THEY ARE BEING OFFERED BEFORE THEY HAND ANYTHING OVER', async () => {
    /*
     * The order was wrong. An invitee was asked for the address their salary
     * would be paid to **before being shown the salary, the title, or who was
     * offering it** — and they cannot read the roster, because it is sealed
     * under the company's viewing key and they must never hold one.
     *
     * The offer is sealed under a key derived from the RAW TOKEN, so holding the
     * token is what opens it. The person best placed to notice that a hire is
     * wrong is the person it is about.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { sentTo } = h.payroll.invite(account.id, {
      name: 'Dana Patel', email: 'dana@acme.co', title: 'Engineer',
      asset: 'GBP', baseAmount: 6_200_00n, startDate: '2026-09-01',
    }, viewingKey, 'usr_operator');

    const token = h.invites.tokenFor(sentTo);
    const offer = h.payroll.offerFor(token);

    expect(offer.company).toBe('Acme');
    expect(offer.name).toBe('Dana Patel');
    expect(offer.title).toBe('Engineer');
    expect(offer.baseAmount).toBe(6_200_00n);
    expect(offer.asset).toBe('GBP');
    expect(offer.startDate).toBe('2026-09-01');
  });

  it('AND NOBODY WITHOUT THE TOKEN CAN READ IT, INCLUDING US', async () => {
    /*
     * The whole point. We store the HASH of the token, and the offer is sealed
     * under a key derived from the raw one — domain-separated, so the value in
     * our database is not the value that decrypts. A database backup carries
     * neither a usable invite nor a readable salary.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { sentTo } = h.payroll.invite(account.id, {
      name: 'Dana Patel', email: 'dana@acme.co', title: 'Engineer',
      asset: 'GBP', baseAmount: 6_200_00n,
    }, viewingKey, 'usr_operator');
    const token = h.invites.tokenFor(sentTo);

    /* What we hold is not what was sent, and it does not open the offer. */
    const stored = h.store.listInvites(account.id).find(i => i.kind === 'employee')!;
    expect(stored.token).not.toBe(token);
    expect(() => h.payroll.offerFor(stored.token)).toThrow(/invite not found/);

    /* And the salary is not readable in the store at all. */
    expect(readableStore((h.store as any).data)).not.toContain('Dana Patel');
    expect(readableStore((h.store as any).data)).not.toContain('Engineer');

    /* A wrong token opens nothing. */
    expect(() => h.payroll.offerFor('inv_not-the-one')).toThrow(/invite not found/);

    /*
     * AND THE VALUE WE STORE DOES NOT OPEN IT. This is the property, and it is
     * the one a mutation slipped past on the first pass: sealing the offer under
     * `sha256(token)` — the same value the invites table holds — left the whole
     * suite green while making every salary readable to anyone with the
     * database. The offer key is domain-separated for exactly this reason, and
     * nothing else in the suite would notice if it stopped being.
     */
    expect(() => unseal(stored.offer!, stored.token)).toThrow();
  });

  it('AN INVITE WRITTEN BEFORE TOKENS WERE HASHED STILL WORKS — C27', async () => {
    /*
     * `getInvite` hashes its argument. A row written by the previous version is
     * keyed by the raw token, so without a migration it could never be found
     * again — while the admin screen went on showing it as open, the person
     * stayed `pending`, and **a run refuses to build while anybody is pending**.
     * One employee hired the day before a deploy stopped everybody being paid,
     * with no route to delete the orphan.
     *
     * Handled in the store rather than in a migration script, because the store
     * is also a file somebody restores from a backup: a one-shot migration fixes
     * the deploy and not the restore.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'dana@acme.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_operator');
    const token = h.invites.tokenFor(sentTo);

    /* Rewrite the row the way the previous version stored it: keyed by the raw token. */
    const data = (h.store as any).data;
    const row = h.store.getInvite(token)!;
    delete data.invites[row.token];
    data.invites[token] = { ...row, token };

    /* Found, re-keyed on the way past, and usable. */
    expect(h.payroll.offerFor(token).name).toBe('Dana');
    expect(data.invites[token]).toBeUndefined();

    h.payroll.acceptInvite(token, handedOver(h, token, {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: '81'.repeat(32), encryptionPublicKey: '82'.repeat(32) }, 'undeployed'),
    }), signIn(h, sentTo));
    expect(h.payroll.admit(employee.id, viewingKey, 'usr_admin').status).toBe('active');
  });

  it('AND THE STORED KEY IS NOT ITSELF A USABLE TOKEN', async () => {
    /*
     * The migration above nearly undid the whole change: a fallback that looked
     * a row up by its own key would have made `sha256(token)` — the value in the
     * table and in every backup — open the row and decrypt the offer. Anything
     * shaped like a stored key is refused rather than looked up.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    h.payroll.invite(account.id, {
      name: 'Dana', email: 'dana@acme.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_operator');
    const stored = h.store.listInvites(account.id).find(i => i.kind === 'employee')!;
    expect(stored.token).toMatch(/^[0-9a-f]{64}$/);
    expect(h.store.getInvite(stored.token)).toBeNull();
  });

  it('AND THE OFFER SURVIVES A REFUSAL, GOING ONLY WHEN THE INVITE IS SPENT FOR GOOD', async () => {
    /*
     * It existed to be read BEFORE accepting, so it used to be dropped on
     * accept — one standing copy of a salary rather than two, `S-9`'s shape.
     *
     * **But a refused handover PUTS THE INVITATION BACK**, and dropping the
     * offer on accept made that retry a blank screen for the rest of the
     * invite's life: only the holder of the raw token can re-seal it, and we do
     * not hold it. A put-back that restores half of what it took is `C17`'s
     * shape again. Found by audit 17 Aug.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'dana@acme.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_operator');
    const token = h.invites.tokenFor(sentTo);
    expect(h.payroll.offerFor(token).name).toBe('Dana');

    /*
     * **REFUSED AT ADMIT, AND `PI4c` CHANGED WHICH REFUSAL THIS REACHES FOR.**
     *
     * It used to redeem from the WRONG SIGN-IN, because `admit` compared the
     * redeemer's email against the one the company addressed. `C21` says that
     * comparison closes by deletion — the operator types both sides of it — so
     * this now uses the refusal that replaced it: a handover whose confirmation
     * code is of a DIFFERENT address from the one inside it, which is what a
     * page that substituted an address produces. **The subject of this test is
     * the PUT-BACK and has not moved**; only the way a refusal is provoked has.
     */
    h.payroll.acceptInvite(token, handedOver(h, token, {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: '71'.repeat(32), encryptionPublicKey: '72'.repeat(32) }, 'undeployed'),
      confirmation: addressFingerprint(payeeAddressFromKeys(
        { coinPublicKey: '7a'.repeat(32), encryptionPublicKey: '7b'.repeat(32) },
        'undeployed').bech32),
    }), signIn(h, 'someone-else@acme.co'));
    expect(() => h.payroll.admit(employee.id, viewingKey, 'usr_admin')).toThrow(/put back/);

    /* The retry is not a blank screen. */
    expect(h.payroll.offerFor(token).name).toBe('Dana');

    /* And the real person spends it for good, after which the copy is gone. */
    h.payroll.acceptInvite(token, handedOver(h, token, {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: '73'.repeat(32), encryptionPublicKey: '74'.repeat(32) }, 'undeployed'),
    }), signIn(h, sentTo));
    expect(h.payroll.admit(employee.id, viewingKey, 'usr_admin').status).toBe('active');
    expect(h.store.listInvites(account.id).find(i => i.kind === 'employee')!.offer).toBeNull();
    expect(() => h.payroll.offerFor(token)).toThrow(/already used/);
  });

  it('AND THE DELIVERY FORGETS THE RAW TOKEN ONCE THE HANDOVER IS ADMITTED — C30', async () => {
    /*
     * Hashing the stored token protects the DATABASE. The delivery port held
     * every raw token for the life of the process with the name, the email and
     * the account id in the clear beside it — `S-9`'s mapping, unsealed, in the
     * same process as the ciphertext those tokens open. Found by audit 17 Aug.
     *
     * Forgetting on admit is a narrowing rather than a fix, and `C30` says so:
     * an invite nobody redeems is still held for ever.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'dana@acme.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_operator');
    const token = h.invites.tokenFor(sentTo);
    expect(JSON.stringify(h.invites.sent)).toContain(token);

    h.payroll.acceptInvite(token, handedOver(h, token, {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: '75'.repeat(32), encryptionPublicKey: '76'.repeat(32) }, 'undeployed'),
    }), signIn(h, sentTo));
    h.payroll.admit(employee.id, viewingKey, 'usr_admin');

    expect(JSON.stringify(h.invites.sent)).not.toContain(token);
    expect(JSON.stringify(h.invites.sent)).not.toContain('dana@acme.co');
  });

  it('SAYS WHEN NOTHING WAS ACTUALLY SENT, rather than reporting a delivery', async () => {
    /*
     * There is no mailer. Until there is one, nobody can complete onboarding, and
     * an operator is entitled to be told that when they hire somebody rather
     * than on payday.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const out = h.payroll.invite(account.id, {
      name: 'Dana', email: 'dana@acme.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_operator');

    expect(out.sentTo).toBe('dana@acme.co');
    expect(out.delivered).toBe(false);
    /*
     * **AND THE TOKEN DOES COME BACK HERE, ONCE. `X11` §1 REVERSES `A-10` AND
     * THIS ASSERTION IS WHERE THAT IS RECORDED.**
     *
     * The assertion used to be that `raw` was ABSENT, and it was right for a
     * system that was going to have a mailer. There is no mailer and there is
     * not going to be one: the invitation scope settles that the admin sends
     * the link, which is what makes *we never learn the employee's email
     * address* true. A channel that requires the link to be held on the raising
     * side and a rule forbidding it from being held there cannot both stand —
     * and while the rule won, `delivered` was false, the token reached nobody,
     * and **nobody could be hired at all**, which is what the line above this
     * one has been reporting the whole time.
     *
     * **WHAT IT COSTS IS `C21`, WHICH IS ALREADY OPEN AND ALREADY REPRODUCED:**
     * whoever raises an invitation types the email the only positive check
     * later compares against, so they can redeem it themselves either way. This
     * removes one step from that; it creates nothing. And the delivery port
     * beside it already retained every raw token it was handed, in memory, for
     * the life of the process (`C8`).
     *
     * **THE EXHAUSTIVE KEY CHECK STAYS, AND IT IS THE POINT OF THIS LINE.** The
     * first version of this test asserted `not.toContain('invite')` — a key that
     * never existed on this return type, so it could not fail, and
     * reintroducing exactly the `A-10` bug left the suite green. Listing every
     * key is what makes a NEW field impossible to add unnoticed, and that
     * property is worth more now than it was, because one of the fields is the
     * token.
     */
    expect(Object.keys(out).sort()).toEqual(['delivered', 'employee', 'raw', 'sentTo']);
    expect(out.raw).toMatch(/^inv_/);
    /* The same token, and not a second one: the copy handed to the delivery
     * port is the copy that opens the offer. */
    expect(h.invites.tokenFor('dana@acme.co')).toBe(out.raw);
    /* AND IT IS UNREACHABLE FROM EVERY LISTING FROM HERE ON, which is the half
     * that did not change. `src/server/invitations.test.ts` walks the routes an
     * admin can actually reach; this is the store's own answer. */
    expect(JSON.stringify(h.store.listInvites(account.id))).not.toContain(out.raw);
  });

  it('A MEMBER MAKING THEMSELVES PAYABLE NEEDS NO INVITE AT ALL', async () => {
    const { account, viewingKey } = await h.accounts.create('Solo', [THREE_SIGNERS[0]], 1);
    const solo = signIn(h, 'solo@acme.co', 'Solo Founder');
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: [solo],
    });
    const me = h.payroll.addSelfAsPayee(account.id, solo, {
      name: 'Me', email: 'me@a.co', title: 'Founder', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: '11'.repeat(32), encryptionPublicKey: '12'.repeat(32) }, 'undeployed'),
    });
    /* Payable immediately, with no token having existed for anybody to intercept. */
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);
    expect(h.payroll.paymentFactsFor(run.id, viewingKey)[0].payee.bech32).toBe(me.address!.bech32);
  });

  it('A REFUSED HANDOVER PUTS THE INVITATION BACK — C23', async () => {
    /*
     * The check cannot run where the employee is (`acceptInvite` holds no
     * viewing key, which is the point of sealing the roster), so it runs at
     * `admit`. The first version left the invite spent when it refused, and
     * nothing re-opens one — so the person was permanently unadmittable, and a
     * run refuses to build while anybody is pending.
     *
     * **`PI4c` CHANGED THE REFUSAL THIS PROVOKES, NOT THE PROPERTY.** The
     * refusal used to be the email comparison, which `C21` closes by deletion.
     * It is now the confirmation code disagreeing with the address that
     * arrived — `X12` §2, the positive the PAYEE produces — and the invariant
     * this test is about is unchanged: **every refusal at `admit` empties the
     * box and puts the invitation back**, so the honest retry simply works.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const op = signIn(h, 'op@acme.co', 'Operator');
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: [op, 'usr_second'],
    });
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'dana@acme.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, op);

    h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: 'd1'.repeat(32), encryptionPublicKey: 'd2'.repeat(32) }, 'undeployed'),
      /* The code is of an address that is not the one in the envelope. */
      confirmation: addressFingerprint(payeeAddressFromKeys(
        { coinPublicKey: 'da'.repeat(32), encryptionPublicKey: 'db'.repeat(32) },
        'undeployed').bech32),
    }), signIn(h, 'someone-else@gmail.com'));
    expect(() => h.payroll.admit(employee.id, viewingKey, 'usr_second')).toThrow();

    /* The box is empty and the invitation is usable again. Nothing reset by hand. */
    expect(h.store.getEmployee(employee.id)!.inbox).toBeNull();
    h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: 'e1'.repeat(32), encryptionPublicKey: 'e2'.repeat(32) }, 'undeployed'),
    }), signIn(h, 'dana@acme.co'));
    expect(h.payroll.admit(employee.id, viewingKey, 'usr_second').status).toBe('active');
  });

  it('AND THE COMPANY↔PERSON MAPPING STAYS SEALED, now that employees have sign-ins', async () => {
    /*
     * An invite carries `accountId` in the clear — it has to, to be found. When
     * employees got sign-ins of their own, putting the redeeming USER beside it
     * put us one join from `users.email` to "this named person is paid by this
     * company", which is exactly what `S-8` sealed the roster to destroy.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: ['usr_operator', 'usr_second'],
    });
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'dana@acme.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_operator');
    const dana = signIn(h, sentTo);
    h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: 'f1'.repeat(32), encryptionPublicKey: 'f2'.repeat(32) }, 'undeployed'),
    }), dana);

    const invites = JSON.stringify(h.store.listInvites(account.id));
    expect(invites).toContain(account.id);
    expect(invites).not.toContain(dana);
    expect(invites).not.toContain('dana@acme.co');

    h.payroll.admit(employee.id, viewingKey, 'usr_second');
    expect(JSON.stringify(h.store.getEmployee(employee.id))).not.toContain(dana);
  });

  it('A MEMBER CANNOT MINT GHOST PAYEES UNDER THEIR OWN EMAIL — C26', async () => {
    /*
     * The auditor's reproduction, kept. Removing the raiser refusal made this
     * free: a member raises an ordinary invite carrying THEIR OWN sign-in email
     * under any name and any salary, redeems it, admits, repeats. Every refusal
     * passes, because the only positive asks whether the redeemer is the email
     * on the record and the record says the member. Three payees, one address.
     *
     * The cap that stops it lived in `addSelfAsPayee` alone; `admit` never
     * consulted it, so the ordinary path skipped it entirely.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const op = signIn(h, 'op@acme.co', 'Operator');
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: [op, 'usr_second'],
    });

    const ghost = (name: string, coin: string) => {
      const { employee, sentTo } = h.payroll.invite(account.id, {
        name, email: 'op@acme.co', title: 'Eng', asset: 'GBP', baseAmount: 9_000_00n,
      }, viewingKey, op);
      h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
        wrappingPublicKey: newWrappingKeypair().publicKey,
        address: payeeAddressFromKeys(
          { coinPublicKey: coin.repeat(32), encryptionPublicKey: '99'.repeat(32) }, 'undeployed'),
      }), op);
      return employee;
    };

    expect(h.payroll.admit(ghost('Ghost One', '61').id, viewingKey, op).status).toBe('active');
    expect(() => h.payroll.admit(ghost('Ghost Two', '62').id, viewingKey, op))
      .toThrow(/already payable on this account/);
    expect(h.payroll.listPeople(account.id, viewingKey).filter(p => p.status === 'active'))
      .toHaveLength(1);
  });

  it('AND THE SOCKPUPPET IS NO LONGER REFUSED BY AN EMAIL — it is RECORDED — C21', async () => {
    /*
     * **THIS TEST ASSERTED THE OPPOSITE UNTIL `PI4c`, AND THE REVERSAL IS THE
     * HONEST READING OF `C21` RATHER THAN A WEAKENING.**
     *
     * It said an operator redeeming somebody else's invitation as themselves is
     * refused, and called that *the check that was doing the work*. **It was
     * doing no work.** The refusal compared the redeemer's sign-in email
     * against the email on the roster entry — and the operator TYPES that
     * email, at hire time, into the form that raises the invitation. Name a
     * mailbox you own, sign in there, redeem, admit: the comparison passes.
     * `C21` reproduced exactly that, end to end, with the suite green. The
     * refusal cost this attacker one mailbox they already had, and it cost
     * every real invitee the hire, because after `PI4b` a real invitee signs in
     * with a wallet and a wallet sign-in has no email at all.
     *
     * **SO WHAT ACTUALLY STANDS HERE NOW.** The fact is recorded rather than
     * refused: `selfRaised` is written onto the roster entry, where an admin
     * reviewing can see that one sign-in both raised and redeemed this
     * invitation. And the one payable entry per person cap (`C26`) still means
     * this cannot be repeated into a second salary — the test above is that.
     *
     * **AND WHAT IS OPEN, SAID OUT LOUD RATHER THAN IMPLIED.** `X12`'s
     * confirmation code catches an address that is not the one the payee's
     * wallet showed; it does not catch a person accepting their own
     * invitation, who pastes their own matching code. That is `C21`'s
     * remainder, it was open before this round and it is open after it, and
     * nothing here should be read as closing it.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const op = signIn(h, 'op@acme.co', 'Operator');
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: [op, 'usr_second'],
    });
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'dana@acme.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, op);
    /* The operator redeems Dana's invite as themselves. */
    h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: '51'.repeat(32), encryptionPublicKey: '52'.repeat(32) }, 'undeployed'),
    }), op);

    const admitted = h.payroll.admit(employee.id, viewingKey, op);
    expect(admitted.status).toBe('active');
    /* The one thing this leaves behind for a person to look at. */
    expect(admitted.selfRaised).toBe(true);
  });

  it('A MEMBER ADDING THEIR OWN ADDRESS IS NOT AN INVITE, and needs no exception', async () => {
    /*
     * Decided 17 Aug, and it deletes a guard rather than patching one.
     *
     * A founder creating a company and adding themselves, or a vendor who has
     * just incorporated, is not an employee being invited — there is no third
     * party, no token to deliver and nobody to impersonate. Treating it as an
     * invitation is what forced an exception, and the exception had to ask "is
     * there anybody to defraud", which no count can answer: the one it used was
     * a list of SIGNER SEATS, which cannot see an employee at all.
     *
     * Two flows, and the invite path now has no exception in it whatsoever.
     */
    const { account, viewingKey } = await h.accounts.create('Solo', [THREE_SIGNERS[0]], 1);
    const solo = signIn(h, 'solo@acme.co', 'Solo Founder');
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: [solo],
    });

    const me = h.payroll.addSelfAsPayee(account.id, solo, {
      /* The email here is IGNORED — it comes off the caller's sign-in. C24. */
      name: 'Me', email: 'somebody-else@a.co', title: 'Founder', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: 'a1'.repeat(32), encryptionPublicKey: 'a2'.repeat(32) }, 'undeployed'),
    });

    expect(me.status).toBe('active');
    expect(me.handedOverBy).toBe(solo);
    expect(me.admittedBy).toBe(solo);
    /*
     * THE RECORD IS ABOUT THE CALLER, whatever the body asked for. The first
     * version took the email from the request, so one authenticated call could
     * mint an active payee under somebody else's name pointing at the caller's
     * address, repeatably, at any amount. `C24`.
     */
    expect(me.email).toBe('solo@acme.co');
    expect(me.email).not.toBe('somebody-else@a.co');
  });

  it('AND ONLY ONE PAYABLE ENTRY PER PERSON — two is two salaries', async () => {
    const { account, viewingKey } = await h.accounts.create('Solo', [THREE_SIGNERS[0]], 1);
    const solo = signIn(h, 'solo@acme.co', 'Solo Founder');
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: [solo],
    });
    const spec = { name: 'Me', email: 'x@x.co', title: 'Founder', asset: 'GBP', baseAmount: 100_00n };
    const hand = () => ({
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: '21'.repeat(32), encryptionPublicKey: '22'.repeat(32) }, 'undeployed'),
    });
    h.payroll.addSelfAsPayee(account.id, solo, spec, viewingKey, hand());
    expect(() => h.payroll.addSelfAsPayee(account.id, solo, spec, viewingKey, hand()))
      .toThrow(/already payable on this account/);
  });

  it('AND A HANDOVER FROM AN ACCOUNT THAT NO LONGER EXISTS IS REFUSED, NOT BURNT — C28', async () => {
    /*
     * The last of admit's five exits, and the one nothing reached: the user id
     * sealed into the handover resolves to nobody, so there is nothing to check
     * the address against. It is reachable — a redemption from a session whose
     * account has since been closed — and like the others it used to leave the
     * box full and the invite spent, with no route to either.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'dana@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_admin');
    const token = h.invites.tokenFor(sentTo);
    h.payroll.acceptInvite(token, handedOver(h, token, {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: '41'.repeat(32), encryptionPublicKey: '42'.repeat(32) }, 'undeployed'),
    }), 'usr_gone');   // never registered, or since closed

    expect(() => h.payroll.admit(employee.id, viewingKey, 'usr_admin'))
      .toThrow(/no longer exists/);
    expect(h.store.getEmployee(employee.id)!.inbox).toBeNull();
    expect(h.payroll.offerFor(token).name).toBe('Dana');
  });

  it('AND THE CAP REFUSES WITHOUT BURNING THE INVITE — C28', async () => {
    /*
     * The cap is the refusal an admin is most likely to hit by accident: one
     * person invited twice, or invited after adding themselves. It is also the
     * only one that is RESOLVABLE — mark the duplicate a leaver and the same
     * handover works. That is worth nothing if refusing spends the invitation,
     * because no route re-opens one.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const first = h.payroll.invite(account.id, {
      name: 'Dana', email: 'dana@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_admin');
    const dana = signIn(h, 'dana@a.co');
    const hand = (b: string) => ({
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: b.repeat(32), encryptionPublicKey: b.repeat(32) }, 'undeployed'),
    });
    h.payroll.acceptInvite(h.invites.tokenFor(first.sentTo), handedOver(h, h.invites.tokenFor(first.sentTo), hand('31')), dana);
    h.payroll.admit(first.employee.id, viewingKey, 'usr_admin');

    /* The same person invited a second time, and they redeem it. */
    const again = h.payroll.invite(account.id, {
      name: 'Dana', email: 'dana@a.co', title: 'Eng', asset: 'GBP', baseAmount: 900_00n,
    }, viewingKey, 'usr_admin');
    const token = h.invites.tokenFor(again.sentTo);
    h.payroll.acceptInvite(token, handedOver(h, token, hand('32')), dana);
    expect(() => h.payroll.admit(again.employee.id, viewingKey, 'usr_admin'))
      .toThrow(/already payable on this account/);

    /* Refused, and recoverable: the box is empty and the invitation is open. */
    expect(h.store.getEmployee(again.employee.id)!.inbox).toBeNull();
    expect(h.payroll.offerFor(token).name).toBe('Dana');

    /* Clear the duplicate, and the same invitation goes through. */
    h.payroll.setStatus(first.employee.id, 'leaver', viewingKey);
    h.payroll.acceptInvite(token, handedOver(h, token, hand('33')), dana);
    expect(h.payroll.admit(again.employee.id, viewingKey, 'usr_admin').status).toBe('active');
  });

  it('AND A NON-MEMBER CANNOT USE THAT DOOR', async () => {
    /* Otherwise "adding yourself" is a way past the invite path for anybody. */
    const { account, viewingKey } = await h.accounts.create('Solo', [THREE_SIGNERS[0]], 1);
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: ['usr_solo'],
    });
    expect(() => h.payroll.addSelfAsPayee(account.id, 'usr_stranger', {
      name: 'Nope', email: 'n@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: 'b1'.repeat(32), encryptionPublicKey: 'b2'.repeat(32) }, 'undeployed'),
    })).toThrow(/an employee is invited/);
  });

  it('FAILS CLOSED when it cannot tell who set the address — C16\'s lesson, one file over', async () => {
    /*
     * The first version disabled itself on a missing id and admitted anyway.
     * Not knowing who set the address of record is exactly when to refuse: a
     * guard whose failure mode is to disable itself is not a guard.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);   // no creator recorded — an invite from before this existed
    h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: 'c1'.repeat(32), encryptionPublicKey: 'c2'.repeat(32) }, 'undeployed'),
    }), signIn(h, sentTo));

    expect(() => h.payroll.admit(employee.id, viewingKey, 'usr_admin'))
      .toThrow(/raised before the product recorded who raised it/);
  });

  it('AND REFUSING DOES NOT STRAND THEM — every exit puts the handover back — C28', async () => {
    /*
     * `C23` wired the put-back to ONE of admit's five refusals, the email
     * mismatch, because that was the one being fixed. The others left the drop
     * box full and the invite spent, **and no route re-opens an invite or
     * empties a box.** A run refuses to build while anybody is `pending`, so any
     * one of them froze the whole account's payroll behind one person, for good.
     *
     * The case that makes it certain rather than theoretical: `createdBy`
     * arrived with `A-10`, so EVERY invite written by the version now deployed
     * is missing it. Found by audit 17 Aug, reproduced end to end.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);   // the shape the deployed code writes: no `createdBy`
    const token = h.invites.tokenFor(sentTo);

    /* Somebody else on the same payroll, admitted normally. */
    const other = h.payroll.invite(account.id, {
      name: 'Rae', email: 'rae@a.co', title: 'Eng', asset: 'GBP', baseAmount: 200_00n,
    }, viewingKey, 'usr_admin');
    h.payroll.acceptInvite(h.invites.tokenFor(other.sentTo), handedOver(h, h.invites.tokenFor(other.sentTo), {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: 'c5'.repeat(32), encryptionPublicKey: 'c6'.repeat(32) }, 'undeployed'),
    }), signIn(h, other.sentTo));
    h.payroll.admit(other.employee.id, viewingKey, 'usr_admin');
    h.payroll.acceptInvite(token, handedOver(h, token, {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: 'c3'.repeat(32), encryptionPublicKey: 'c4'.repeat(32) }, 'undeployed'),
    }), signIn(h, sentTo));

    expect(() => h.payroll.admit(employee.id, viewingKey, 'usr_admin')).toThrow();

    /* The box is empty and the invitation is open again — nothing is burnt. */
    expect(h.store.getEmployee(employee.id)!.inbox).toBeNull();
    expect(h.store.listInvites(account.id).find(i => i.kind === 'employee')!.acceptedAt)
      .toBeUndefined();
    expect(h.payroll.offerFor(token).name).toBe('Dana');

    /*
     * AND THE COMPANY IS NOT FROZEN. Withdrawing the one person who cannot be
     * admitted lets everybody else be paid, which is the exit the refusal now
     * names. It is the only one that works: re-inviting alone mints a SECOND
     * pending entry and blocks the run again.
     */
    await expect(h.payroll.createRunFromRoster(account.id, '2026-08', viewingKey))
      .rejects.toThrow(/payroll cannot run/);
    h.payroll.setStatus(employee.id, 'leaver', viewingKey);
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-08', viewingKey);
    const built = h.payroll.requireRun(run.id, viewingKey);
    expect(built.employees).toHaveLength(1);
    expect(built.employees[0]!.name).toBe('Rae');
  });

  it('RECORDS WHO HANDED OVER AND WHO ADMITTED, because admit sets where money goes', async () => {
    /*
     * The skip register already carries an author, a time and a reason for a
     * decision NOT to pay somebody. Deciding WHERE to pay them left no trace of
     * itself at all.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: ['usr_admin', 'usr_second'],
    });
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_admin');
    const dana = signIn(h, sentTo);
    h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: 'b1'.repeat(32), encryptionPublicKey: 'b2'.repeat(32) }, 'undeployed'),
    }), dana);

    const admitted = h.payroll.admit(employee.id, viewingKey, 'usr_admin');
    expect(admitted.handedOverBy).toBe(dana);
    expect(admitted.admittedBy).toBe('usr_admin');
    expect(admitted.admittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    /* And none of it is readable without the key. */
    const raw = JSON.stringify(h.store.getEmployee(employee.id));
    expect(raw).not.toContain(dana);
    expect(raw).not.toContain('usr_admin');
  });

  it('THE PAYSLIP TELLS THE PAYEE WHERE THEY WERE PAID — the only check they can make', async () => {
    /*
     * An employee cannot read the company's roster; they hold no viewing key
     * and must not. So the only way they can ever discover that the address the
     * company holds for them is not the one they handed over is for it to come
     * back sealed to their OWN key — which is what a payslip already is.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { employee, secret } = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    const view = h.payroll.employeeView(run.id, employee.id, secret.wrappingSecret);
    const onRoster = h.payroll.person(employee.id, viewingKey)!;
    expect((view.payslip as any).paidTo).toBe(onRoster.address!.bech32);
    /* Read with their OWN secret and no account viewing key anywhere near it. */
    expect(onRoster.address!.bech32).toMatch(/^mn_shield-addr_undeployed1/);
  });

  it('A HANDOVER SURVIVES A KEY ROTATION, like a pending signer\'s does', async () => {
    /*
     * Rotation is what happens when a signer leaves; onboarding never stops. So
     * a handover sitting unadmitted while the key rotates is the DEFAULT
     * overlap, not bad luck.
     *
     * Before this was fixed the drop box was copied through untouched while
     * everything around it moved to the new epoch — and then **no key could
     * complete the admit**: the old one opens the box and not the roster entry,
     * the new one opens the roster entry and not the box. The invite refuses a
     * second handover as "already used", so the person was permanently
     * unadmittable — and since a run refuses to build while anybody is pending,
     * the whole company's payroll froze behind one new hire. C17.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Mid Onboarding', email: 'm@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_operator');

    const wk = newWrappingKeypair();
    const address = payeeAddressFromKeys(
      { coinPublicKey: '81'.repeat(32), encryptionPublicKey: '82'.repeat(32) }, 'undeployed');
    h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), { wrappingPublicKey: wk.publicKey, address }), signIn(h, sentTo));

    /* A signer leaves. The key rotates. The handover is still in the box. */
    const rotated = await h.accounts.rotate(account.id, viewingKey);

    const admitted = h.payroll.admit(employee.id, rotated.viewingKey, 'usr_admin');
    expect(admitted.status).toBe('active');
    expect(admitted.address!.bech32).toBe(address.bech32);
    expect(admitted.wrappingPublicKey).toBe(wk.publicKey);

    /* And payroll is not frozen behind them. */
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', rotated.viewingKey);
    expect(h.payroll.paymentFactsFor(run.id, rotated.viewingKey)).toHaveLength(1);
  });

  it('ADMIT REFUSES AN ADDRESS FOR ANOTHER NETWORK, at onboarding rather than at payment', async () => {
    /*
     * A coin public key is network-independent bytes, so nothing further down
     * objects to a preview address on a stagenet company — the payment settles
     * to somebody on a chain this deployment has never heard of. Refusing here
     * is free; refusing at payment time is not.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_operator');

    h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: '71'.repeat(32), encryptionPublicKey: '72'.repeat(32) }, 'preview'),
    }), signIn(h, sentTo));

    /* The service is on `undeployed`; the handover is for preview. */
    expect(() => h.payroll.admit(employee.id, viewingKey, 'usr_admin')).toThrow(/undeployed/);
  });

  it('REFUSES TO PAY AN ACTIVE PERSON WHO SOMEHOW HAS NO ADDRESS — C9, defence in depth', async () => {
    /*
     * `admit` cannot produce this state, which is exactly why the check is
     * worth having: a record restored from an older version, or written by a
     * future path nobody has thought of yet, must not become a payment into
     * nothing. The alternative is a payee whose address is absent being paid
     * anyway, and that failure is irreversible the moment it lands.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const { employee } = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    const person = h.payroll.person(employee.id, viewingKey)!;
    (h.payroll as any).putPerson({ ...person, address: null }, viewingKey);

    expect(() => h.payroll.paymentFactsFor(run.id, viewingKey))
      .toThrow(/Dana has no address[\s\S]*nowhere for an operator to enter one/);
  });

  it('names the two pending states separately, because they wait on different people', async () => {
    /*
     * B15's lesson, one step earlier. "Outstanding" that covers two situations
     * is how an operator stops looking: somebody who has handed nothing over is
     * waiting on THEM, somebody whose drop box is full is waiting on US, and an
     * admin who cannot tell the difference cannot act on either.
     */
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const theirs = h.payroll.invite(account.id, {
      name: 'Not Started', email: 'a@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_operator');
    const ours = h.payroll.invite(account.id, {
      name: 'Handed Over', email: 'b@a.co', title: 'Eng', asset: 'GBP', baseAmount: 200_00n,
    }, viewingKey, 'usr_operator');
    void theirs;
    h.payroll.acceptInvite(h.invites.tokenFor(ours.sentTo), handedOver(h, h.invites.tokenFor(ours.sentTo), {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: payeeAddressFromKeys(
        { coinPublicKey: '41'.repeat(32), encryptionPublicKey: '42'.repeat(32) }, 'undeployed'),
    }));

    await expect(h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey))
      .rejects.toThrow(/Not Started has not set up yet[\s\S]*Handed Over is waiting to be admitted/);
  });

  it('BUILDS THE CHAIN PAYMENTS FROM THE ROSTER, with nowhere to type an address', async () => {
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const a = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    const b = h.payroll.hireDirect(account.id, {
      name: 'Sam', email: 's@a.co', title: 'Eng', asset: 'GBP', baseAmount: 200_00n,
    }, viewingKey);

    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);
    const facts = h.payroll.paymentFactsFor(run.id, viewingKey);

    expect(facts).toHaveLength(2);
    expect(facts.map(f => f.amount)).toEqual([100_00n, 200_00n]);

    /* Each payee is the address on their OWN roster entry, and both halves of it. */
    const dana = privatePayee(h.payroll.person(a.employee.id, viewingKey)!.address);
    const sam = privatePayee(h.payroll.person(b.employee.id, viewingKey)!.address);
    expect(facts[0].payee.bech32).toBe(dana.bech32);
    expect(facts[1].payee.bech32).toBe(sam.bech32);
    expect(facts[0].payee.coinPublicKey).toBe(dana.coinPublicKey);
    expect(facts[0].payee.encryptionPublicKey).toBe(dana.encryptionPublicKey);

    /* Two people are two different payees, in both halves. */
    expect(facts[0].payee.coinPublicKey).not.toBe(facts[1].payee.coinPublicKey);
    expect(facts[0].payee.encryptionPublicKey).not.toBe(facts[1].payee.encryptionPublicKey);
    /* And a reading key is never a spending key. */
    expect(facts[0].payee.encryptionPublicKey).not.toBe(facts[0].payee.coinPublicKey);
  });

  /**
   * **AN ADDRESS THAT COMES BACK OUT OF THE SEAL IS A PARSED ONE, NOT A REVIVED
   * OBJECT.** `A-1`, `C246`, `S6k`.
   *
   * `openRecord` returns JSON and `PayeeAddress`'s brand is a compile-time
   * symbol, so what comes back type-checks as an address and, before this, was
   * simply whatever fields had been sealed. That was harmless for as long as
   * every field a caller read was one of them.
   *
   * **`S6k` added `kind`, and `kind` decides which door money leaves by.** A
   * roster record sealed before it carries no such field, and `buildRun` picks
   * a payee's details circuit by exactly that value. This test is the boundary:
   * a payee handed to the chain layer came out of a decode, whenever it was
   * written.
   */
  it('A ROSTER ADDRESS SEALED WITHOUT A KIND COMES BACK WITH ONE', async () => {
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const a = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);

    const person = h.payroll.person(a.employee.id, viewingKey)!;
    expect(person.address!.kind).toBe('shielded');

    /*
     * **RE-SEALED WITHOUT THE FIELD, WHICH IS WHAT A PRE-`S6k` RECORD IS.** Not
     * a mock and not a stub of the store: the real record, opened, stripped of
     * exactly the one field that did not exist yesterday, and sealed back
     * through the same function that wrote it.
     */
    const raw = h.store.getEmployee(a.employee.id)!;
    const secrets = openRecord<any>('payroll', raw.accountId, raw.sealed, viewingKey);
    const { kind, ...withoutKind } = secrets.address;
    expect(kind).toBe('shielded');
    h.store.putEmployee({
      ...raw,
      sealed: sealRecord(
        'payroll', raw.accountId, { ...secrets, address: withoutKind }, viewingKey),
    });

    /* Read back, the kind is there — because the address was parsed, not revived. */
    const again = privatePayee(h.payroll.person(a.employee.id, viewingKey)!.address);
    expect(again.kind).toBe('shielded');
    expect(again.bech32).toBe(person.address!.bech32);
    expect(again.coinPublicKey).toBe(privatePayee(person.address).coinPublicKey);

    /* And the run built from it carries a payee the chain layer can dispatch on. */
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);
    expect(h.payroll.paymentFactsFor(run.id, viewingKey)[0].payee.kind).toBe('shielded');
  });

  it('REFUSES TO PAY SOMEBODY WHO CANNOT REACH IT — C9, and it names them', async () => {
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    /*
     * An ad hoc payee is sealed a payslip and has no roster entry, so there is
     * no address they put there themselves. A payslip is not a payment.
     */
    const adHoc = await h.payroll.createRun(
      account.id, '2026-08', [{ name: 'Contractor', asset: 'GBP', amount: 50_00n }], viewingKey);
    expect(() => h.payroll.paymentFactsFor(adHoc.run.id, viewingKey))
      .toThrow(/Contractor is not on the roster/);

    /* And the run built from the roster is fine, so the refusal is not blanket. */
    expect(h.payroll.paymentFactsFor(run.id, viewingKey)).toHaveLength(1);
  });

  it('blocks payroll while anyone is still pending, and names them', async () => {
    const { account, viewingKey } = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    h.payroll.hireDirect(account.id, { name: 'Ready', email: 'r@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n }, viewingKey);
    h.payroll.invite(account.id, { name: 'Not Ready', email: 'n@a.co', title: 'Eng', asset: 'GBP', baseAmount: 200_00n }, viewingKey);

    await expect(h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey))
      .rejects.toThrow(/Not Ready/);
  });
});

describe('plug-ins', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  async function acct() {
    const c = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    return c;
  }

  it('refuses a scope the plug-in never requested', async () => {
    const c = await acct();
    expect(() => h.plugins.install({
      accountId: c.account.id, pluginId: 'xero-sync',
      scopes: ['state:read'] as any, allowance: null, installedBy: c.secrets[0].signerId,
    })).toThrow(/did not request/);
  });

  it('will not let a plug-in propose without an allowance', async () => {
    const c = await acct();
    const ins = h.plugins.install({
      accountId: c.account.id, pluginId: 'treasury-yield',
      scopes: ['state:read', 'proposal:create'], allowance: null, installedBy: c.secrets[0].signerId,
    });
    await expect(h.plugins.propose(ins.token, c.viewingKey, {
      summary: 'Deploy to lending', asset: 'GBP', amount: 10_00n, recipient: 'Pool',
      proposedBy: c.secrets[0].signerId,
    })).rejects.toThrow(/no spending allowance/);
  });

  it('enforces the per-proposal and per-period allowance', async () => {
    const c = await acct();
    const ins = h.plugins.install({
      accountId: c.account.id, pluginId: 'treasury-yield',
      scopes: ['state:read', 'proposal:create'],
      /*
       * A CEILING PER ASSET, in ONE installation. M-125.
       *
       * The first version of this made an installation single-asset and said a
       * plug-in needing two should be installed twice — the same safety,
       * charged for twice over: two capability tokens, two audit trails, two
       * things to revoke. The ceiling is looked up by the asset being spent, so
       * there is no pairing left to get wrong.
       */
      allowance: { limits: { GBP: { perProposal: 5_000_00n, perPeriod: 8_000_00n } }, periodDays: 30 },
      installedBy: c.secrets[0].signerId,
    });
    const go = (amount: bigint) => h.plugins.propose(ins.token, c.viewingKey, {
      summary: 'Deploy', asset: 'GBP', amount, recipient: 'Pool',
      proposedBy: c.secrets[0].signerId,
    });

    await expect(go(9_000_00n)).rejects.toThrow(/per-proposal allowance/);
    await go(5_000_00n);                              // fine
    await expect(go(4_000_00n)).rejects.toThrow(/allowance for the period/);
  });

  it('refuses an asset the installation was never granted, rather than defaulting', async () => {
    /*
     * The other half of the per-asset ceiling, and the reason the allowance is
     * a map with no fallback. An asset with no entry is not a limit of zero and
     * not a limit of infinity — it is an asset this plug-in was never granted,
     * and the refusal says which assets it may spend instead. M-125.
     *
     * Without this a plug-in granted a sterling ceiling could spend ether
     * against it: 5,000 is a sensible weekly limit in pounds and roughly
     * nothing in ether, and the plug-in must not be the one that decides which.
     */
    const c = await acct();
    const ins = h.plugins.install({
      accountId: c.account.id, pluginId: 'treasury-yield',
      scopes: ['state:read', 'proposal:create'],
      allowance: { limits: { GBP: { perProposal: 5_000_00n, perPeriod: 8_000_00n } }, periodDays: 30 },
      installedBy: c.secrets[0].signerId,
    });
    await expect(h.plugins.propose(ins.token, c.viewingKey, {
      summary: 'Deploy', asset: 'USDC', amount: 1n, recipient: 'Pool',
      proposedBy: c.secrets[0].signerId,
    })).rejects.toThrow(/no USDC allowance\. It may spend GBP and nothing else/);

    // Refused, and recorded — a refusal is the more interesting audit line.
    const refused = h.plugins.events(c.account.id).filter(e => !e.allowed);
    expect(refused).toHaveLength(1);
    expect(refused[0].asset).toBe('USDC');
    expect(refused[0].amount).toBe(1n);
  });

  it('an allowance naming an asset the registry does not know is refused at install', async () => {
    /*
     * Checked when the grant is made rather than at the first payment, because
     * an allowance in a currency nobody can resolve is a limit nobody can
     * enforce — and the first payment is the worst possible moment to discover
     * that. M-125.
     */
    const c = await acct();
    expect(() => h.plugins.install({
      accountId: c.account.id, pluginId: 'treasury-yield',
      scopes: ['state:read', 'proposal:create'],
      allowance: { limits: { XYZ: { perProposal: 1n, perPeriod: 1n } }, periodDays: 30 },
      installedBy: c.secrets[0].signerId,
    })).toThrow(/unknown asset "XYZ"/);
  });

  it('stops working the moment it is suspended', async () => {
    const c = await acct();
    const ins = h.plugins.install({
      accountId: c.account.id, pluginId: 'xero-sync',
      scopes: ['state:read:totals', 'runs:read'], allowance: null, installedBy: c.secrets[0].signerId,
    });
    h.plugins.readRuns(ins.token);
    h.plugins.setStatus(ins.id, 'suspended');
    expect(() => h.plugins.readRuns(ins.token)).toThrow(/suspended/);
  });

  it('records refusals in the audit trail, not just successes', async () => {
    const c = await acct();
    const ins = h.plugins.install({
      accountId: c.account.id, pluginId: 'xero-sync',
      scopes: ['runs:read'], allowance: null, installedBy: c.secrets[0].signerId,
    });
    expect(() => h.plugins.readPeople(ins.token)).toThrow(/not granted/);

    const refused = h.plugins.events(c.account.id).filter(e => !e.allowed);
    expect(refused).toHaveLength(1);
    expect(refused[0].detail).toMatch(/people:read was not granted/);
  });
});

/* ============================================================================
 * Identity and multi-tenancy.
 *
 * These are the tests that decide whether this is a product or a demo. Every
 * other suite proves the cryptography is honest for one tenant. This one proves
 * that two tenants on the same deployment cannot reach each other.
 * ========================================================================== */

describe('identity', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  /**
   * **A PERSON WITH A SESSION AND A SEALED BUNDLE, AND NO CREDENTIAL AT ALL.**
   * `PI4b`.
   *
   * This used to be `enrol(email, password)`: it stretched the password with
   * argon2id, sent the `authKey` half to `register`, and sealed the bundle
   * under the `encKey` half. **There is no derivation and no `register`.**
   *
   * `WalletIdentityService` is what creates a person now, and it is tested
   * against real wallet bytes in `wallet-sign-in.test.ts`. What the tests below
   * need is what the wallet leaves behind — a `User` row and a session — so
   * that is what this makes, through the same two doors the service itself
   * uses. **Nothing here fabricates a credential, because there is no longer
   * such a thing to fabricate.**
   *
   * `encKey` is picked rather than derived, which is the honest shape: in the
   * product it is 32 bytes the wallet releases for one company, and nothing
   * below this line depends on where it came from — `keyring.ts` has the same
   * note on `canOpenCompanies`.
   */
  let people = 0;
  const enrol = async (email: string | null, encKey = 'ee'.repeat(32)) => {
    const user: import('./types.js').User = {
      id: 'usr_enrolled_' + (++people),
      email,
      name: email ?? '',
      keyBundle: seal(JSON.stringify({ signing: 'aa'.repeat(32) }), encKey),
      keyBundleVersion: 1,
      walletKey: 'wk_' + people,
      createdAt: '2026-08-25T00:00:00.000Z',
    };
    h.store.putUser(user);
    return { user, session: await h.identity.issue(user.id), encKey };
  };

  /*
   * `C40`. The bundle is replaced WHOLE, so two devices signed in at once used
   * to overwrite each other silently: one records a seat, the other creates a
   * company, and the second write erased the first with a 200. What it erased
   * is the one value a derived seat still stores, so the membership it recorded
   * became unreachable — `C39`.
   */
  it('A CLIENT CAN WRITE THE BUNDLE IT JUST READ — the round trip, C41', async () => {
    /*
     * Reproduces what a real client does and nothing else: arrive with a
     * bundle, then save something. That was refused for ever, and no test
     * looked because each half was tested against its own idea of the number.
     *
     * **THE FIRST WRITE USED TO BE `register` AND IS NOW THE WALLET'S.**
     * `WalletIdentityService.createFor` writes `keyBundleVersion: 0` with a
     * null bundle, and the first bundle a new person has is written through
     * `updateKeyBundle` — so the count a client must present is whatever the
     * row already says, read rather than assumed. That is the whole of `C41`
     * and it did not depend on which door made the row.
     */
    const { user, encKey } = await enrol('ada@acme.co');

    const onTheRow = h.store.getUser(user.id)!.keyBundleVersion!;
    expect(() => h.identity.updateKeyBundle(user.id, seal('{"a":1}', encKey), onTheRow))
      .not.toThrow();

    /* And what `GET /api/me/keys` hands a fresh tab is the version it must
     * present next, rather than a number that tab guessed. */
    const served = h.identity.user(user.id).keyBundleVersion ?? 0;
    expect(served).toBe(onTheRow + 1);
    expect(() => h.identity.updateKeyBundle(user.id, seal('{"a":2}', encKey), served))
      .not.toThrow();
  });

  it('A KEY BUNDLE WRITE THAT DID NOT SEE THE LAST ONE IS REFUSED — C40', async () => {
    const { user, encKey } = await enrol('ada@acme.co');
    const seal1 = seal(JSON.stringify({ from: 'laptop' }), encKey);
    const seal2 = seal(JSON.stringify({ from: 'phone' }), encKey);

    /*
     * THE ROW ARRIVES AT ONE, so the count starts there. `C41`.
     *
     * The first version of this test asserted zero here, which was the server
     * half of a disagreement with the client — and because the test agreed with
     * the server, the suite was green while **every bundle write a new account
     * made was refused as stale, permanently.** A fixture that shares the code's
     * wrong model cannot see the model.
     */
    expect(h.store.getUser(user.id)!.keyBundleVersion).toBe(1);

    /* Both devices read version 1. The laptop writes first and wins. */
    h.identity.updateKeyBundle(user.id, seal1, 1);
    expect(h.store.getUser(user.id)!.keyBundleVersion).toBe(2);

    /* The phone still thinks it is at 1. Its write would erase the laptop's. */
    expect(() => h.identity.updateKeyBundle(user.id, seal2, 1)).toThrow(/changed somewhere else/);
    expect(unseal(h.store.getUser(user.id)!.keyBundle!, encKey)).toContain('laptop');

    /* Re-reading, it writes cleanly. */
    h.identity.updateKeyBundle(user.id, seal2, 2);
    expect(unseal(h.store.getUser(user.id)!.keyBundle!, encKey)).toContain('phone');
    expect(h.store.getUser(user.id)!.keyBundleVersion).toBe(3);
  });

  it('AND A CALLER THAT SENDS NO VERSION STILL WRITES, knowingly', async () => {
    /*
     * Optional on purpose so nothing that has not been taught to send it breaks.
     * Worth pinning, because the alternative reading — that omitting it is also
     * refused — would be a silent outage for every un-updated caller.
     */
    const { user, encKey } = await enrol('bob@acme.co');
    h.identity.updateKeyBundle(user.id, seal(JSON.stringify({ a: 1 }), encKey));
    h.identity.updateKeyBundle(user.id, seal(JSON.stringify({ a: 2 }), encKey));
    expect(h.store.getUser(user.id)!.keyBundleVersion).toBe(3);
  });

  /*
   * **NINE RECOVERY TESTS WERE DELETED HERE, NOT REWRITTEN.** `PI4a`.
   *
   * They covered a flow that could not serve a wallet account and had no client
   * — see `docs/reports/PI4a-proof-of-death.md`, written before the deletion.
   * **A test kept alive against a system nobody can reach is a green tick that
   * means nothing**, so they went with it rather than being pointed somewhere
   * else.
   */
  /*
   * **AND TEN PASSWORD TESTS WENT FROM HERE, FOR THE SAME REASON.**
   * `PI4b`, `C129`. **Every one is named**, so that what stopped being watched
   * is legible rather than implied by a smaller number at the bottom of a run:
   *
   *   · *registers and logs in, and the server never holds anything that
   *     decrypts* — the surviving half is the test below, which asks the same
   *     question of the row a wallet sign-in leaves.
   *   · *derives the same material from the same password on a different
   *     device* and *gives the same error for a wrong password and an unknown
   *     email* — there is no derivation and no such refusal.
   *   · *will not register the same email twice* — nothing registers. The
   *     uniqueness it bought is argued in `payroll.ts`'s cap note: a wallet row
   *     is found by `sha256` of an address only its holder can sign for.
   *   · **the four S-2 tests** — *login itself counts, so no route can forget
   *     to*, the wait, the spray across many accounts, and the clear on
   *     success. **These MOVED rather than died**: `wallet-sign-in.test.ts`
   *     ends with an `S-2` describe against the door that counts now, because
   *     deleting a system and not checking what replaced it is how a round
   *     leaves a hole where a feature was. `clear` itself is deleted.
   *   · *rotates the key bundle on a password change, and ends the old
   *     sessions* — there is no password change. The half worth keeping is its
   *     own door and is the test below it.
   *   · *AND EVERY WRITER OF THE BUNDLE MOVES ITS VERSION, not just one of
   *     them* — `C40` was closed on the assumption one writer owned that value,
   *     and this test existed because `replaceKeyBundle` was a second one.
   *     **`replaceKeyBundle` is deleted, so there is one writer again**, and
   *     `updateKeyBundle` moving the version is asserted by the three `C40`/
   *     `C41` tests above. **If a second writer is ever added, this is the test
   *     to write back.**
   *
   * The helper they shared went with them: `enrol` above takes no password,
   * because there is nowhere to put one.
   */

  it('THE SERVER HOLDS NOTHING THAT DECRYPTS, and that did not depend on a password',
    async () => {
      /*
       * The surviving half of *registers and logs in, and the server never
       * holds anything that decrypts*. The claim was never about the password:
       * it is that what is on disk is an opaque blob, and the key that opens it
       * is not. **It is a stronger claim now**, because there is no keyed hash
       * of anything on the row either — the wallet holds the only secret, and
       * it holds it off this machine entirely.
       */
      const { user, encKey } = await enrol('ada@acme.co');
      const stored = h.store.getUser(user.id)!;

      expect(JSON.stringify(stored)).not.toContain(encKey);
      expect(JSON.stringify(stored)).not.toContain('aa'.repeat(32));
      /* And nothing that was ever a credential is on the row under any name. */
      expect(JSON.stringify(stored)).not.toMatch(/authHash|authSalt|authKey|password/i);

      /* The client can open its own keys. This process could not have. */
      expect(unseal(stored.keyBundle!, encKey)).toContain('aa'.repeat(32));
    });

  /* --------------------------- S-3 and S-4 --------------------------- */

  it('THE ONE S-3 IS ABOUT: signing out ends the session on the server', async () => {
    const { user, session } = await enrol('ada@acme.co');
    expect(await h.identity.verify(session.token)).toBe(user.id);

    await h.identity.signOut(session.token);
    await expect(h.identity.verify(session.token)).rejects.toThrow(/not signed in/);
  });

  it('signs out the other devices and keeps the one asking', async () => {
    /*
     * **THIS IS THE WHOLE OF WHAT A PASSWORD CHANGE USED TO BE GOOD FOR.**
     * `PI4b`. `replaceKeyBundle` ended every other session as a side effect of
     * rotating the bundle; the rotation is gone and this is the door that was
     * doing the useful half all along.
     */
    const { user } = await enrol('ada@acme.co');
    const laptop = await h.identity.issue(user.id);
    const phone = await h.identity.issue(user.id);

    await h.identity.signOutEverywhere(user.id, laptop.token);
    expect(await h.identity.verify(laptop.token)).toBe(user.id);
    await expect(h.identity.verify(phone.token)).rejects.toThrow(/not signed in/);
  });

  it('shows a person their sessions without showing a token, and ends one by id', async () => {
    const { user } = await enrol('ada@acme.co');
    const here = await h.identity.issue(user.id, { userAgent: 'the laptop' });
    const phone = await h.identity.issue(user.id, { userAgent: 'the phone' });

    const live = await h.identity.listSessions(user.id, here.token);
    expect(JSON.stringify(live)).not.toContain(phone.token);
    expect(live.find(s => s.userAgent === 'the laptop')!.current).toBe(true);

    const id = live.find(s => s.userAgent === 'the phone')!.id;
    expect(await h.identity.endSession(user.id, id)).toBe(true);
    await expect(h.identity.verify(phone.token)).rejects.toThrow(/not signed in/);
    expect(await h.identity.verify(here.token)).toBe(user.id);
  });

  it('THE ONE M-118 IS ABOUT: a session id is not a licence to end a stranger\'s session', async () => {
    // A token is 32 random bytes and is its own authority. An id is twelve
    // characters of a hash, shown on a screen. Only one of them is a credential.
    const { user: ada } = await enrol('ada@acme.co');
    const { user: mal, session: malSession } = await enrol('mal@evil.co');
    const adaSession = (await h.identity.listSessions(ada.id))[0];

    expect(await h.identity.endSession(mal.id, adaSession.id)).toBe(false);
    expect(await h.identity.listSessions(ada.id)).toHaveLength(1);
    expect(await h.identity.verify(malSession.token)).toBe(mal.id);
  });

  it('one answer for a token that is unknown, expired, revoked or malformed', async () => {
    /*
     * Three of those are facts an attacker would like told apart and the
     * caller does the same thing in all of them. The old version had a
     * different message for each, which turned a stolen token into a question
     * the server would answer.
     */
    const { user, session } = await enrol('ada@acme.co');
    const revoked = await h.identity.issue(user.id);
    await h.identity.signOut(revoked.token);
    const expired = await h.identity.issue(user.id, { ttlHours: -1 });

    for (const t of ['', 'garbage', 'a'.repeat(64), revoked.token, expired.token]) {
      await expect(h.identity.verify(t)).rejects.toThrow(/^not signed in$/);
    }
    expect(await h.identity.verify(session.token)).toBe(user.id);
  });

  it('S-4: a second instance sharing the store honours the same sessions', async () => {
    /*
     * Two IdentityServices over one session store stand in for two server
     * processes. This could not pass before: the token was signed with a
     * per-process secret that defaulted to a fresh random value, so a restart
     * silently invalidated everything and looked like a room full of expired
     * logins. There is no secret to disagree about any more.
     *
     * The durable half — surviving an actual process restart — needs a real
     * database and lives in sessions.test.ts, where it runs against Postgres.
     */
    const { user, session } = await enrol('ada@acme.co');
    const other = new IdentityService(h.store, h.sessionStore);

    expect(await other.verify(session.token)).toBe(user.id);
    await other.signOut(session.token);
    await expect(h.identity.verify(session.token)).rejects.toThrow(/not signed in/);
  });

  it('A SESSION OUTLIVES NOTHING — a token for a row that is gone is not signed in', async () => {
    /*
     * `verify` checks the row as well as the token, and the comment on it says
     * why: *the session can outlive the user it belongs to*. **That branch had
     * no test of its own and it matters more now** — a store carried over from
     * before `PI4b` holds password rows nothing can reach, and a session token
     * minted against one of them must not resolve.
     */
    const { user, session } = await enrol('ada@acme.co');
    expect(await h.identity.verify(session.token)).toBe(user.id);

    const snapshot = h.store.snapshot();
    delete snapshot.users[user.id];
    await expect(h.identity.verify(session.token)).rejects.toThrow(/not signed in/);
  });
});

describe('multi-tenancy', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  /**
   * A person on this deployment.
   *
   * **`PI4b`: THIS USED TO STRETCH A PASSWORD AND REGISTER.** Nothing in this
   * describe is about how somebody proved who they were — it is about whether
   * two tenants on one deployment can reach each other — so what it needs is a
   * `User` row, which is what a wallet sign-in leaves.
   */
  let people = 0;
  const enrol = async (email: string) => {
    const user: import('./types.js').User = {
      id: 'usr_tenant_' + (++people),
      email, name: email,
      keyBundle: seal('{}', 'ee'.repeat(32)),
      keyBundleVersion: 1,
      walletKey: 'wk_tenant_' + people,
      createdAt: '2026-08-25T00:00:00.000Z',
    };
    h.store.putUser(user);
    return user;
  };

  /** Two unrelated companies on one deployment. */
  const twoTenants = async () => {
    const ada = await enrol('ada@acme.co');
    const raj = await enrol('raj@globex.co');
    const acme = await h.accounts.create('Acme', [{ ...THREE_SIGNERS[0], userId: ada.id }], 1);
    const globex = await h.accounts.create('Globex', [{ ...THREE_SIGNERS[0], userId: raj.id }], 1);
    return { ada, raj, acme, globex };
  };

  it('a user reaches their own account and no other', async () => {
    const { ada, raj, acme, globex } = await twoTenants();

    expect(h.accounts.membership(acme.account.id, ada.id)).toBe(true);
    expect(h.accounts.membership(globex.account.id, ada.id)).toBe(false);
    expect(h.accounts.membership(acme.account.id, raj.id)).toBe(false);

    expect(() => h.accounts.requireMember(globex.account.id, ada.id)).toThrow();
  });

  it('reports a foreign account and a missing account identically', async () => {
    const { ada, globex } = await twoTenants();
    const foreign = (() => {
      try { h.accounts.requireMember(globex.account.id, ada.id); } catch (e: any) { return e.message; }
    })();
    const missing = (() => {
      try { h.accounts.requireMember('acc_doesnotexist', ada.id); } catch (e: any) { return e.message; }
    })();
    // Otherwise the error is an oracle for which account ids exist.
    expect(foreign).toBe(missing);
  });

  it('lists only the accounts a user is actually on', async () => {
    const { ada, raj, acme, globex } = await twoTenants();
    expect(h.store.accountsForUser(ada.id).map(a => a.id)).toEqual([acme.account.id]);
    expect(h.store.accountsForUser(raj.id).map(a => a.id)).toEqual([globex.account.id]);
    expect(h.store.accountsForUser('usr_nobody')).toEqual([]);
  });

  it('holds a shared account for both of its members', async () => {
    const ada = await enrol('ada@acme.co');
    const blake = await enrol('blake@acme.co');
    const c = await h.accounts.create('Acme', [
      { ...THREE_SIGNERS[0], userId: ada.id },
      { ...THREE_SIGNERS[1], userId: blake.id },
    ], 2);
    expect(h.store.accountsForUser(ada.id)).toHaveLength(1);
    expect(h.store.accountsForUser(blake.id)).toHaveLength(1);
    expect(h.accounts.membership(c.account.id, blake.id)).toBe(true);
    // The ROLE is sealed now, so reading it takes the key. That is the change.
    expect(h.accounts.open(c.account.id, c.viewingKey)
      .signers.find(s => s.userId === blake.id)!.role).toBe('approver');
  });

  it('does not count a pending signer as a member', async () => {
    const ada = await enrol('ada@acme.co');
    const blake = await enrol('blake@acme.co');
    const c = await h.accounts.create('Acme', [{ ...THREE_SIGNERS[0], userId: ada.id }], 1);

    const invite = h.accounts.inviteSigner(c.account.id, 'Blake', 'blake@acme.co', 'approver');
    const sk = newSigningKeypair(); const wk = newWrappingKeypair();
    const pending = h.accounts.acceptSignerInvite(invite.token, blake.id, sk.publicKey, wk.publicKey, LEAF);

    // On the account, but not yet a member: an invite is not a grant.
    expect(pending.status).toBe('pending');
    expect(h.accounts.membership(c.account.id, blake.id)).toBe(false);

    const seat = await h.accounts.proposeSigner(c.account.id, c.viewingKey, pending.id, c.secrets[0].signerId);
    await h.accounts.approve(seat.id, c.secrets[0].signerId, sign(approvalMessage(seat), c.secrets[0].signingSecret), c.viewingKey);

    await h.accounts.grantAccess(c.account.id, c.viewingKey, pending.id);
    expect(h.accounts.membership(c.account.id, blake.id)).toBe(true);
  });

  it('refuses a second seat for the same user on one account', async () => {
    const ada = await enrol('ada@acme.co');
    const c = await h.accounts.create('Acme', [{ ...THREE_SIGNERS[0], userId: ada.id }], 1);
    const invite = h.accounts.inviteSigner(c.account.id, 'Ada again', 'ada@acme.co', 'approver');
    const sk = newSigningKeypair(); const wk = newWrappingKeypair();
    // Two seats would be two votes towards the threshold from one person.
    expect(() => h.accounts.acceptSignerInvite(invite.token, ada.id, sk.publicKey, wk.publicKey, LEAF))
      .toThrow(/already on this account/);
  });

  it('does not let a foreign member decrypt state even when they know the account id', async () => {
    const { globex, acme } = await twoTenants();
    // Membership is the outer gate. The viewing key is the inner one, and the
    // two are independent: neither alone opens the other tenant's state.
    await expect(h.accounts.readState(globex.account.id, acme.viewingKey))
      .rejects.toThrow(/cannot open/);
  });
});

/**
 * M-29. The approval round is enforced, not recorded.
 *
 * Before this, `SimulatedLedger` accepted any state at any time. That made the
 * boundary a faithful model of the easiest implementation to write and an
 * impossible model of the chain: `core/account.ts` could be driving a sequence
 * Midnight would reject, and every test here would still pass.
 *
 * Each of these is a rule the Compact contract enforces. The simulation now
 * enforces the same one, so a product built against it is being told the truth.
 */
describe('the approval round, as the chain enforces it', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  const transfer = (amount: bigint) => ({
    entries: [{ id: 'e1', kind: 'transfer', asset: 'GBP', amount, counterparty: 'y', memo: '', at: '' }],
  });

  async function funded(threshold = 2) {
    const c = await h.accounts.create('Acme', THREE_SIGNERS, threshold);
    return c;
  }

  const propose = (c: Awaited<ReturnType<typeof funded>>, amount: bigint, summary = 'p') =>
    h.accounts.propose({
      accountId: c.account.id, viewingKey: c.viewingKey, kind: 'transfer',
      summary, payload: transfer(amount), proposedBy: c.secrets[0].signerId,
    });

  /** What the chain publishes about one proposal while it is still open. */
  const openOnChain = async (accountId: string) =>
    (await h.accounts.ledgerStatus(accountId))!.openProposals;

  /*
   * 'a fresh account is at round 1 with nothing open — matching the constructor'
   * WAS HERE AND IS DELETED. M-128.
   *
   * It checked that `LedgerStatus.round` started at 1, because the contract's
   * constructor did `round.increment(1)` and a simulation starting at 0 would
   * have been off by one against the real thing forever. There is no round any
   * more: it existed only to scope approval nullifiers, which is what limited
   * an account to one proposal at a time, and nullifiers bind to the proposal
   * now. `proposalOpen` and `approvalCount` went with it, for the same reason —
   * they described THE open proposal, and there is no such thing.
   *
   * What is left of the property is below: what an account publishes.
   */
  it('an account publishes no assets at all, and nothing open', async () => {
    const c = await funded();
    const status = (await h.accounts.ledgerStatus(c.account.id))!;
    expect(status.openProposals).toEqual([]);
    expect(status.threshold).toBe(2);
    expect(status.signerCount).toBe(3);
    /*
     * NO ASSET ENTRIES, EVER. `C292`, `S26`.
     *
     * This asserted ONE entry, for the one asset a deposit had credited, and
     * that the key was opaque rather than the asset code. The account keeps no
     * balance map, so what a public observer learns is now strictly less: not
     * even how many distinct assets are involved.
     *
     * The field is still on `LedgerStatus` and still asserted, because empty is
     * a claim this boundary makes and a future round quietly filling it is
     * exactly what this line would catch.
     */
    expect(status.assets).toEqual([]);
  });

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * **WHAT REPLACED `publicView().settlements`, AND WHY A TEST HAD TO.**
   * `C313`, `C286`, rule 27. `S29`.
   *
   * `publicView` is the evidence behind *a public observer learns nothing*, and
   * until `S29` it answered with `settlements: []` — an array `settleRound`
   * alone had ever written, and `C292` removed the writer. **A property held by
   * an empty data structure names nothing that enforces it**, and the tests
   * that read that array went into `_to_delete/S26-C292/` with the writer, so
   * nothing was even asserting the emptiness out loud.
   *
   * The array is gone. **This is what now enforces the ground it stood on**:
   * not *the list is empty*, which is true of any absence, but *nothing this
   * boundary publishes is denominated in money* — which is false the moment a
   * settlement row comes back, with its asset and its amount as a real integer.
   * That is what `C122` says goes out of `GET /api/public` to anybody at all.
   *
   * **AND IT IS HALF OF THAT ROW'S *DONE WHEN*, NOT THE WHOLE OF IT.** `C122`
   * asks for *"the endpoint shows commitments and nothing denominated in money,
   * and a test that fails if any field it returns is a number of an asset"* —
   * and the subject of both halves is THE ENDPOINT. **This test is about
   * `SimulatedLedger.publicView()`, which is not the endpoint**: the route
   * spreads this object and then overwrites `proposals` with a store-derived
   * list of its own (`src/server/index.ts`), so the half of the response a
   * stranger actually reads is not walked here at all, and nothing in this
   * repository exercises `GET /api/public`. `BACKLOG.md`.
   *
   * **THE WALKER IS CONTROLLED BOTH WAYS.** An absence test whose probe cannot
   * see the thing it looks for passes perfectly, so the probe is run over an
   * object that DOES carry money before it is trusted over one that should not.
   * ───────────────────────────────────────────────────────────────────────────
   */
  describe('the public observer view carries nothing denominated in money', () => {
    /*
     * **THE ALLOW-LIST IS THE POINT, AND THE FIRST VERSION OF THIS WALKER DID
     * NOT HAVE ONE.** `S29`, caught by this round's own two auditors, both of
     * which measured the same hole independently.
     *
     * It flagged `bigint`, and fields literally named `amount` or `asset`. So
     * it fired on the shape the deleted `settlements` had, and on nothing else:
     * `{ currency: 'GBP', paid: '12,000.00' }` — the shape any formatting layer
     * produces — walked straight past it, all 130 tests green. `C122`'s own
     * words are *the amount as a real number*, so a `number` is exactly what it
     * is about, and a probe that allows every number except two names fails
     * OPEN.
     *
     * **SO IT REFUSES EVERY `number` AND EVERY `bigint`, AND NAMES THE FEW
     * KEYS THAT MAY HOLD ONE.** `approvalCount` and `threshold` are counts of
     * people, public on chain by design (decision 0003), and they are listed
     * here rather than inferred — a field added to this boundary carrying a
     * figure has to be argued for in this list before it can pass.
     *
     * Anything that is not an array or a plain object is refused outright, so a
     * `Map`, a `Set` or a class instance cannot smuggle a value past the
     * recursion.
     */
    const COUNTS_OF_PEOPLE = new Set(['approvalCount', 'threshold', 'signerCount']);

    /** Every money-shaped thing found in a value, as `path: why`. */
    const moneyIn = (value: unknown, path = '', key = ''): string[] => {
      if (typeof value === 'bigint') return [`${path}: a bigint`];
      if (typeof value === 'number') {
        return COUNTS_OF_PEOPLE.has(key) ? [] : [`${path}: a number, under the key "${key}"`];
      }
      if (typeof value === 'string' || typeof value === 'boolean' || value == null) return [];
      if (Array.isArray(value)) return value.flatMap((v, i) => moneyIn(v, `${path}[${i}]`, key));
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        return [`${path}: neither an array nor a plain object, so nothing here can see into it`];
      }
      return Object.entries(value).flatMap(([k, v]) => [
        ...(k === 'amount' || k === 'asset' ? [`${path}.${k}: a field named "${k}"`] : []),
        ...moneyIn(v, `${path}.${k}`, k),
      ]);
    };

    it('THE CONTROL: the probe finds money when money is there', () => {
      /*
       * Held in memory rather than read off the ledger, so that the probe and
       * the assertion below are not both reading one absence. This is the shape
       * `settlements` had, field for field.
       */
      const asItWas = {
        commitments: [{ accountId: 'a', commitment: '00', updatedAt: 't' }],
        settlements: [{ ref: 'r', accountId: 'a', asset: 'GBP', amount: 12_000_00n,
          memo: 'Payroll 2026-06, 8 recipients', at: 't' }],
      };
      expect(moneyIn(asItWas)).toEqual([
        '.settlements[0].asset: a field named "asset"',
        '.settlements[0].amount: a field named "amount"',
        '.settlements[0].amount: a bigint',
      ]);
    });

    it('THE SECOND CONTROL: and finds it under a name nobody chose in advance', () => {
      /*
       * **THE FIRST CONTROL ONLY EVER PROVED THE PROBE COULD SEE THE SHAPE IT
       * WAS WRITTEN FOR.** That is the failure this whole describe replaced —
       * an evidence surface that answers about one shape and reads as an answer
       * about the property. A future round publishing a settlement will not
       * call the field `amount`; it will call it `paid`, or `total`, or
       * `minorUnits`, and it will very likely format it as a string of digits.
       */
      const formatted = {
        commitments: [{ accountId: 'a', commitment: '00', updatedAt: 't' }],
        settlements: [{ ref: 'r', currency: 'GBP', paid: 1200000, at: 't' }],
      };
      expect(moneyIn(formatted)).toEqual(['.settlements[0].paid: a number, under the key "paid"']);

      // And a count of people is allowed through, or the rule would refuse the
      // two fields this boundary is FOR.
      expect(moneyIn({ proposals: [{ approvalCount: 1, threshold: 2 }] })).toEqual([]);

      // A container the recursion cannot see into is refused rather than
      // skipped, which is the direction that fails closed.
      expect(moneyIn({ rows: new Map([['a', 1n]]) }))
        .toEqual(['.rows: neither an array nor a plain object, so nothing here can see into it']);
    });

    it('AND FINDS NONE IN WHAT AN OBSERVER ACTUALLY GETS', async () => {
      const c = await funded();
      const p = await propose(c, 12_000_00n, 'Payroll 2026-06, 8 recipients');
      await h.accounts.approve(
        p.id, c.secrets[0].signerId, sign(approvalMessage(p), c.secrets[0].signingSecret), c.viewingKey);

      const view = h.ledger.publicView();

      /*
       * **POSITIVE CONTROLS: THE VIEW WAS REALLY READ, AND THE MONEY IS REALLY
       * IN THE SYSTEM.** Without these, a `publicView` that returned `{}` — or
       * a proposal that was never raised — passes the assertion underneath as
       * comfortably as a correct one does.
       */
      expect(view.commitments).toHaveLength(1);
      expect(view.proposals).toHaveLength(1);
      expect(view.proposals[0].approvalCount).toBe(1);
      expect(h.accounts.changeOf(
        h.accounts.requireProposal(p.id, c.viewingKey), c.viewingKey))
        .toEqual({ asset: 'GBP', amount: 12_000_00n });

      expect(moneyIn(view)).toEqual([]);
      /*
       * And nothing arrives back by a route the walker cannot see into. The
       * memo carried the figure's own sentence — `C122` quotes it — so both the
       * number and the sentence are looked for as text.
       */
      expect(JSON.stringify(view)).not.toContain('1200000');
      expect(JSON.stringify(view)).not.toContain('Payroll 2026-06');
    });
  });

  it('cancel withdraws ONE proposal and leaves every other one untouched', async () => {
    /*
     * WAS 'cancel unwedges the account, and burns the approvals already given'.
     *
     * Cancelling used to rotate the round: it closed the one proposal an
     * account was allowed to have and burned every approval on the account,
     * including approvals given to something else. It existed because a single
     * proposal that would never reach its threshold wedged the account
     * permanently (M-29).
     *
     * M-128 gives it a proposal id. The named proposal is deleted along with
     * the approvals given to it, and nothing else on the account moves — and
     * "unwedging" is no longer what it is for, because an account holding as
     * many proposals as it likes cannot be wedged by one of them.
     */
    const c = await funded();
    const stuck = await propose(c, 1_000_00n, 'never going to pass');
    const other = await propose(c, 2_000_00n, 'a good one');
    await h.accounts.approve(stuck.id, c.secrets[0].signerId, sign(approvalMessage(stuck), c.secrets[0].signingSecret), c.viewingKey);
    await h.accounts.approve(other.id, c.secrets[0].signerId, sign(approvalMessage(other), c.secrets[0].signingSecret), c.viewingKey);

    await h.accounts.cancel(stuck.id, c.viewingKey);

    expect(await openOnChain(c.account.id)).toEqual([
      { id: other.chainId, change: expect.any(String), approvals: 1 },
    ]);
    // And the cancelled record keeps no claim to the approvals it collected.
    expect(h.accounts.requireProposal(stuck.id, c.viewingKey).status).toBe('cancelled');
    expect(h.accounts.requireProposal(stuck.id, c.viewingKey).approvals).toEqual([]);
  });

  it('one signer, one approval per proposal — and the ledger is what says so', async () => {
    /*
     * The nullifier burns once per signer per proposal. Our own record refuses
     * a duplicate too, but the local check is bookkeeping: the chain holds the
     * nullifier set and is the only party that can say an approval has already
     * been spent, which is why `approve` calls it BEFORE writing anything down.
     */
    const c = await funded();
    const p = await propose(c, 1_000_00n);
    const account = h.accounts.open(c.account.id, c.viewingKey);
    const by = { signerId: account.signers[0].id, leaf: account.signers[0].leafCommitment! };

    await h.ledger.approve(c.account.id, p.chainId, by);
    await expect(h.ledger.approve(c.account.id, p.chainId, by))
      .rejects.toThrow(/already approved this proposal/i);
    expect((await openOnChain(c.account.id))[0].approvals).toBe(1);
  });

  it('refuses to act for someone who is not in the on-chain signer set', async () => {
    const c = await funded();
    // A signer the account service knows about but the tree does not: exactly
    // what `grantAccess` produces today, because it makes a signer active
    // locally without adding their leaf on chain. M-69.
    const outsider = newSigningKeypair();
    editAccount(h, c.account.id, c.viewingKey, a => {
      a.signers.push({
        id: 'sgn_ghost', name: 'Ghost', role: 'approver', status: 'active', userId: null,
        signingPublicKey: outsider.publicKey, wrappingPublicKey: outsider.publicKey,
        leafCommitment: 'cd'.repeat(32),
      });
    });

    await expect(h.accounts.propose({
      accountId: c.account.id, viewingKey: c.viewingKey, kind: 'transfer',
      summary: 'p', payload: transfer(10_00n), proposedBy: 'sgn_ghost',
    })).rejects.toThrow(/not a signer on this account/);
  });

  it('a blocked proposal never reaches the ledger', async () => {
    /*
     * It used to matter because a blocked proposal on chain would have WEDGED
     * the account: the contract allowed one open proposal, so it would have had
     * to be cancelled before anything legitimate could be raised. M-128 removed
     * that consequence, and the reason survives it — a proposal the policy
     * engine refused is a local record of an attempt, and putting it on chain
     * would publish an approval round for something that will never be
     * approved, at the price of a transaction.
     */
    const c = await funded();
    editAccount(h, c.account.id, c.viewingKey, a => {
      a.policy.limitsByRole.approver = { GBP: { perTransaction: 100_00n, perPeriod: 100_00n, periodDays: 30 } };
    });

    const blocked = await h.accounts.propose({
      accountId: c.account.id, viewingKey: c.viewingKey, kind: 'transfer',
      summary: 'too big', payload: transfer(5_000_00n),
      proposedBy: c.secrets[1].signerId, // Blake, an approver
    });
    expect(blocked.status).toBe('blocked');
    expect(await openOnChain(c.account.id)).toEqual([]);

    // A legitimate proposal still goes through, and is the only thing on chain.
    const ok = await propose(c, 1_000_00n);
    expect((await openOnChain(c.account.id)).map(x => x.id)).toEqual([ok.chainId]);
  });

});

/**
 * M-69. A granted signer can actually act.
 *
 * `grantAccess` used to set `status = 'active'` and stop. The viewing key was
 * re-wrapped, so the signer could READ the account — and every circuit begins
 * with `requireSigner()`, which proves a Merkle path into the on-chain tree, so
 * they could not ACT on it. The product showed an active signer whose every
 * approval failed inside a proof, with "not a signer" as the only clue.
 */
describe('granting access puts the signer in the on-chain set', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('a granted signer can approve, and their approval counts on chain', async () => {
    const c = await h.accounts.create('Acme', [THREE_SIGNERS[0]], 1);

    const invite = h.accounts.inviteSigner(c.account.id, 'Blake', 'b@acme.co', 'approver');
    const sk = newSigningKeypair(); const wk = newWrappingKeypair();
    const blake = h.accounts.acceptSignerInvite(
      invite.token, null, sk.publicKey, wk.publicKey, 'be'.repeat(32));

    const seat = await h.accounts.proposeSigner(
      c.account.id, c.viewingKey, blake.id, c.secrets[0].signerId,
    );
    await h.accounts.approve(seat.id, c.secrets[0].signerId, sign(approvalMessage(seat), c.secrets[0].signingSecret), c.viewingKey);
    await h.accounts.grantAccess(c.account.id, c.viewingKey, blake.id);

    // The proposal that seated them is consumed, exactly as an execute consumes
    // one. `round` used to advance here as well; there is no round. M-128.
    const seated = (await h.accounts.ledgerStatus(c.account.id))!;
    expect(seated.openProposals).toEqual([]);
    expect(seated.signerCount).toBe(2);

    // And now the thing that used to fail: Blake acts.
    const p = await h.accounts.propose({
      accountId: c.account.id, viewingKey: c.viewingKey, kind: 'transfer',
      summary: 'supplier',
      payload: { entries: [{ id: 'e1', kind: 'transfer', asset: 'GBP', amount: 1_000_00n, counterparty: 'y', memo: '', at: '' }] },
      proposedBy: blake.id,
    });
    const approved = await h.accounts.approve(p.id, blake.id, sign(approvalMessage(p), sk.secret), c.viewingKey);
    expect(approved.approvals.map(a => a.signerId)).toEqual([blake.id]);
    expect((await h.accounts.ledgerStatus(c.account.id))!.openProposals).toEqual([
      { id: p.chainId, change: expect.any(String), approvals: 1 },
    ]);
  });

  it('refuses to seat a signer on a live account without an approved round', async () => {
    // M-37. One existing signer adding signers freely makes the threshold
    // decorative: a single stolen key could manufacture as many approvers as it
    // liked, then approve anything M times alone.
    const c = await h.accounts.create('Acme', [THREE_SIGNERS[0]], 1);
    const invite = h.accounts.inviteSigner(c.account.id, 'Blake', 'b@acme.co', 'approver');
    const sk = newSigningKeypair(); const wk = newWrappingKeypair();
    const blake = h.accounts.acceptSignerInvite(
      invite.token, null, sk.publicKey, wk.publicKey, 'be'.repeat(32));

    /*
     * THE REFUSAL MOVED UP A LAYER. M-128.
     *
     * `Ledger.addSigner` takes a proposal id now, because an account holds
     * several open proposals at once and the contract has to be told WHICH one
     * authorises the addition. So `grantAccess` has to find that proposal
     * before it can call the chain, and finds nothing — the ledger's own
     * "adding a signer needs an approved proposal" is no longer reachable from
     * here, and is pinned directly against the ledger below.
     */
    await expect(h.accounts.grantAccess(c.account.id, c.viewingKey, blake.id))
      .rejects.toThrow(/no open proposal on this account for that change/i);
  });

  it('the LEDGER refuses an addition with no proposal, and one approved for another leaf', async () => {
    /*
     * The two guards `grantAccess` no longer reaches, asserted where they live.
     * Our own `approvedFor` lookup is bookkeeping and is worth nothing against
     * somebody who calls the contract directly — which is the entire threat
     * model for M-37: one stolen key must not be able to manufacture approvers.
     */
    const c = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const account = h.accounts.open(c.account.id, c.viewingKey);
    const by = { signerId: account.signers[0].id, leaf: account.signers[0].leafCommitment! };
    const wanted = 'be'.repeat(32);
    const other = 'ma'.repeat(32);

    // Three signers against a threshold of two: past the bootstrap window, so
    // the contract requires a round.
    await expect(h.ledger.addSigner(c.account.id, wanted, null, by))
      .rejects.toThrow(/needs an approved proposal/i);

    // A round approved for `wanted` does not authorise seating `other`. Without
    // the per-leaf check any approved proposal would authorise adding anyone.
    const invite = h.accounts.inviteSigner(c.account.id, 'Blake', 'b@acme.co', 'approver');
    const sk = newSigningKeypair(); const wk = newWrappingKeypair();
    const blake = h.accounts.acceptSignerInvite(
      invite.token, null, sk.publicKey, wk.publicKey, wanted);
    const p = await h.accounts.proposeSigner(
      c.account.id, c.viewingKey, blake.id, c.secrets[0].signerId);
    await h.accounts.approve(p.id, c.secrets[0].signerId, sign(approvalMessage(p), c.secrets[0].signingSecret), c.viewingKey);
    await h.accounts.approve(p.id, c.secrets[1].signerId, sign(approvalMessage(p), c.secrets[1].signingSecret), c.viewingKey);

    await expect(h.ledger.addSigner(c.account.id, other, p.chainId, by))
      .rejects.toThrow(/not for this signer/i);
    // And the one it WAS approved for goes in.
    await h.ledger.addSigner(c.account.id, wanted, p.chainId, by);
    expect((await h.ledger.status(c.account.id))!.signerCount).toBe(4);
  });

  it('refuses to seat a signer on a round that has not reached the threshold', async () => {
    /*
     * Proposing is not approving. Without this the round is theatre: anyone who
     * can open a proposal could seat a signer of their choosing immediately,
     * which is M-37 again with one extra step.
     *
     * Found by a mutation run — removing the guard broke nothing, because every
     * other test happened to approve before granting.
     */
    const c = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const invite = h.accounts.inviteSigner(c.account.id, 'Dana', 'd@acme.co', 'approver');
    const sk = newSigningKeypair(); const wk = newWrappingKeypair();
    const dana = h.accounts.acceptSignerInvite(
      invite.token, null, sk.publicKey, wk.publicKey, 'da'.repeat(32));

    const seat = await h.accounts.proposeSigner(
      c.account.id, c.viewingKey, dana.id, c.secrets[0].signerId,
    );

    // Zero approvals.
    await expect(h.accounts.grantAccess(c.account.id, c.viewingKey, dana.id))
      .rejects.toThrow(/not enough approvals/i);

    // One of two.
    await h.accounts.approve(seat.id, c.secrets[0].signerId, sign(approvalMessage(seat), c.secrets[0].signingSecret), c.viewingKey);
    await expect(h.accounts.grantAccess(c.account.id, c.viewingKey, dana.id))
      .rejects.toThrow(/not enough approvals/i);

    // Two of two.
    await h.accounts.approve(seat.id, c.secrets[1].signerId, sign(approvalMessage(seat), c.secrets[1].signingSecret), c.viewingKey);
    const account = await h.accounts.grantAccess(c.account.id, c.viewingKey, dana.id);
    expect(account.signers.find(s => s.id === dana.id)!.status).toBe('active');
    expect((await h.accounts.ledgerStatus(c.account.id))!.signerCount).toBe(4);
  });

  it('refuses to seat a signer against a round approved for someone else', async () => {
    // Without domain separation and a per-leaf commitment, any approved
    // proposal would authorise adding anyone — the same hole in a new place.
    const c = await h.accounts.create('Acme', [THREE_SIGNERS[0]], 1);
    const mk = (name: string, leaf: string) => {
      const invite = h.accounts.inviteSigner(c.account.id, name, `${name}@acme.co`, 'approver');
      const sk = newSigningKeypair(); const wk = newWrappingKeypair();
      return h.accounts.acceptSignerInvite(invite.token, null, sk.publicKey, wk.publicKey, leaf);
    };
    const wanted = mk('Blake', 'be'.repeat(32));
    const other = mk('Mallory', 'ma'.repeat(32));

    const seat = await h.accounts.proposeSigner(
      c.account.id, c.viewingKey, wanted.id, c.secrets[0].signerId,
    );
    await h.accounts.approve(seat.id, c.secrets[0].signerId, sign(approvalMessage(seat), c.secrets[0].signingSecret), c.viewingKey);

    /*
     * The refusal comes from `approvedFor` rather than from the ledger now: an
     * approved round is matched on its DIGEST, which is
     * `signerAddPayload(leaf)`, so a round raised for Blake's leaf is simply not
     * a round for Mallory's and there is nothing to hand the contract. The
     * ledger's own version of this check is pinned directly above. M-128.
     */
    await expect(h.accounts.grantAccess(c.account.id, c.viewingKey, other.id))
      .rejects.toThrow(/no open proposal on this account for that change/i);
  });

  it('the contract\'s bootstrap window is unreachable from here, and that is fine', async () => {
    /*
     * The contract lets any existing signer add another while
     * `signerCount < threshold`, because a 2-of-3 account starting with one
     * signer cannot collect the two approvals its own threshold requires and
     * would be wedged at creation.
     *
     * `AccountService.create` never produces that state: it refuses a threshold
     * larger than the signer set, so an account always starts at or above its
     * threshold and every later signer needs a round. The window exists for the
     * deploy script, which seats the deployer alone and adds the rest.
     *
     * Pinned rather than assumed, because "the two layers disagree about
     * whether a code path is reachable" is how a hole gets left open by
     * everyone believing the other side covers it.
     */
    await expect(h.accounts.create('Acme', [THREE_SIGNERS[0]], 2)).rejects.toThrow(/not valid/);

    const c = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    const invite = h.accounts.inviteSigner(c.account.id, 'Dana', 'd@acme.co', 'approver');
    const sk = newSigningKeypair(); const wk = newWrappingKeypair();
    const dana = h.accounts.acceptSignerInvite(
      invite.token, null, sk.publicKey, wk.publicKey, 'da'.repeat(32));
    // Three signers, threshold two: past the window on the first extra signer.
    await expect(h.accounts.grantAccess(c.account.id, c.viewingKey, dana.id))
      .rejects.toThrow(/no open proposal on this account for that change/i);
  });
});

describe('S-9 follow-up: what a RUN leaves in the store', () => {
  it('a settled run must not leave salaries in the runs table either', async () => {
    /*
     * Checking a claim I made rather than assuming it.
     *
     * Sealing the roster closed one table. `PayrollRun.employees[].amount` and
     * the run's own totals are a SECOND copy of the same numbers, written when
     * a run is created — so "we cannot read anyone's salary" is only true if
     * this table is covered too.
     */
    const h2 = harness();
    const { account, viewingKey } = await h2.accounts.create('Acme', THREE_SIGNERS, 2);
    h2.payroll.hireDirect(account.id, { name: 'Dana Whitfield', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 6_200_00n }, viewingKey);
    await h2.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    const runs = readableStore((h2.store as any).data.runs);
    expect(runs).not.toContain('620000');
    expect(runs).not.toContain('Dana Whitfield');

    /*
     * Nor WHICH ASSET each leg settles in. `totals` and the per-asset proposal
     * map are inside the envelope; the copy left outside is a bare list of
     * proposal ids with no asset attached, so the store cannot see that this
     * company pays anyone in ether. M-125.
     *
     * Asserted as a shape rather than a substring: an asset code is three
     * characters and a nanoid is drawn from a 64-character alphabet, so
     * `not.toContain('GBP')` would fire at random on correct code — the M-101
     * lesson.
     */
    const stored = h2.store.listRuns(account.id)[0];
    expect(Object.values(stored).some(v => v === 'GBP')).toBe(false);
    expect(h2.payroll.requireRun(stored.id, viewingKey).totals).toEqual({ GBP: 6_200_00n });
  });
});

describe('S-8: what the proposals table leaves in the store', () => {
  it('holds no summary, no proposer and no per-signer approval list', async () => {
    /*
     * The sharpest item in the whole exercise.
     *
     * The chain records approvals as NULLIFIERS so that nobody — including us —
     * can tell which signer approved what. That is decision 0003 and the M-36
     * fix. Our own table held the deanonymised version of exactly that, beside
     * a human-written summary that names people and amounts.
     */
    const h2 = harness();
    const c = await h2.accounts.create('Acme', THREE_SIGNERS, 2);
    const p = await h2.accounts.propose({
      accountId: c.account.id, viewingKey: c.viewingKey, kind: 'transfer',
      summary: 'Pay Wilkinson Legal 12000 for the Q3 retainer',
      payload: {
        to: 'Wilkinson Legal',
        entries: [{ id: 'e1', kind: 'transfer', asset: 'GBP', amount: 12_000_00n, counterparty: 'Wilkinson Legal', memo: '', at: '' }],
      },
      proposedBy: c.secrets[0].signerId,
    });
    await h2.accounts.approve(p.id, c.secrets[0].signerId, sign(approvalMessage(p), c.secrets[0].signingSecret), c.viewingKey);

    const stored = readableStore((h2.store as any).data.proposals);
    expect(stored).not.toContain('Wilkinson Legal');
    // '12000' from the summary, and '1200000' — the amount in minor units —
    // which contains it, so one check covers both.
    expect(stored).not.toContain('12000');
    expect(stored).not.toContain(c.secrets[0].signerId);
    // Nor the asset: there is no readable field on the record that carries one.
    expect(Object.values(h2.store.getProposal(p.id)!).some(v => v === 'GBP')).toBe(false);

    // A count is fine — the chain publishes one too. WHOSE is the leak.
    expect(h2.store.getProposal(p.id)!.approvalCount).toBe(1);
    // And a signer with the key still reads it all.
    expect(h2.accounts.requireProposal(p.id, c.viewingKey).summary).toContain('Wilkinson');
    /*
     * `amountOf` USED TO BE THE READER HERE and returned a bare number — which
     * is the shape the policy engine then evaluated against a ceiling belonging
     * to some other asset. `changeOf` returns the pair, which is what makes
     * that impossible to write. M-125.
     */
    expect(h2.accounts.changeOf(h2.accounts.requireProposal(p.id, c.viewingKey), c.viewingKey))
      .toEqual({ asset: 'GBP', amount: 12_000_00n });
  });
});

describe('M-96: what the ACCOUNTS table leaves in the store', () => {
  /*
   * The other half of S-8, and the last table.
   *
   * These assert against the SERIALISED STORE rather than against a public view,
   * because that is exactly the check whose absence let the salary leak survive
   * a test called "leaks no individual salary to a public observer". The claim
   * here is about what WE hold.
   */

  /** A company with an active roster, a real spending limit, and one pending signer. */
  async function company() {
    const h = harness();
    /* `PI4b`: two people, made the way a wallet sign-in makes one. These two
     * are here to be SIGNERS with real user ids; how they signed in was never
     * what this section is about. */
    const ada = { id: signIn(h, 'ada@acme.co', 'Ada Okafor') };
    const blake = { id: signIn(h, 'blake@acme.co', 'Blake Ruiz') };
    const c = await h.accounts.create('Northwind Ltd', [
      { name: 'Ada Okafor', role: 'admin', userId: ada.id },
      { name: 'Cleo Nakamura', role: 'approver' },
    ], 2);
    editAccount(h, c.account.id, c.viewingKey, a => {
      // Both are keyed by asset since M-125: a ceiling is a number in one
      // currency and nothing else.
      a.policy.limitsByRole = {
        approver: { GBP: { perTransaction: 250_000_00n, perPeriod: null, periodDays: 30 } },
      };
    });

    const invite = h.accounts.inviteSigner(c.account.id, 'Devi Raman', 'devi@acme.co', 'approver');
    const sk = newSigningKeypair();
    const wk = newWrappingKeypair();
    const pendingLeaf = 'ef'.repeat(32);
    const pending = h.accounts.acceptSignerInvite(
      invite.token, blake.id, sk.publicKey, wk.publicKey, pendingLeaf);

    return { h, c, ada, blake, pending, pendingLeaf, sk, wk };
  }

  it('holds no company name, no signer name, no role and no spending limit', async () => {
    const { h, c } = await company();
    const stored = readableStore((h.store as any).data.accounts);

    for (const text of ['Northwind', 'Ada Okafor', 'Cleo Nakamura', 'Devi Raman']) {
      expect(stored).not.toContain(text);
    }
    /*
     * Roles, and the limits as real money figures — in minor units, which is
     * the only form they exist in now.
     *
     * `'133700'` WAS IN THIS LIST AND IS GONE WITH THE FIELD IT CAME FROM. `R4`
     * deleted `Policy`'s auto-approve figure entirely, so the fixture no longer
     * sets a second money value and there is no second value to look for. The
     * property under test is unchanged: a money figure held in this company's
     * policy must not be readable in the store, and the surviving ceiling is
     * still one.
     */
    for (const text of ['admin', 'approver', '25000000']) {
      expect(stored).not.toContain(text);
    }
    // The recovery quorum is a rule about who can rescue the account.
    expect(stored).not.toContain('"recovery"');

    // And a key holder still reads all of it.
    const open = h.accounts.open(c.account.id, c.viewingKey);
    expect(open.name).toBe('Northwind Ltd');
    expect(open.policy.limitsByRole.approver?.GBP?.perTransaction).toBe(250_000_00n);
    expect(open.recovery.threshold).toBe(2);
  });

  it('never holds a leafCommitment where anything readable can be joined to a name', async () => {
    /*
     * THE NON-NEGOTIABLE ONE, and the reason S-8 exists.
     *
     * The on-chain tree is blinded precisely so nobody — including us — can link
     * a leaf to a person (decision 0003, M-36). A leaf beside a name in our own
     * database is the answer key to exactly that.
     *
     * This checks the WHOLE store, not the accounts table, because `userId` is
     * one join from `users.name`: a leaf left in the clear next to an opaque
     * user id would satisfy a per-row check and still reconstruct the mapping.
     */
    const { h, c, pendingLeaf } = await company();
    const everything = JSON.stringify((h.store as any).data);

    // The active signers' leaves, straight from the opened roster.
    const active = h.accounts.open(c.account.id, c.viewingKey)
      .signers.filter(s => s.status === 'active');
    expect(active.length).toBe(2);
    for (const s of active) {
      expect(s.leafCommitment).toBeTruthy();
      expect(everything).not.toContain(s.leafCommitment!);
    }
    // And the pending signer's, which is the case that blocked M-96 the first time.
    expect(everything).not.toContain(pendingLeaf);

    // Meanwhile the users table does still hold real names — which is what
    // makes leaving a leaf in the clear a leak rather than a technicality.
    expect(everything).toContain('Ada Okafor');
  });

  it('answers membership with no viewing key at all, which is why memberUserIds exists', async () => {
    const { h, c, ada, blake } = await company();
    // No key is passed, and there is none to pass: the server makes this
    // decision before the key arrives in the body of the request it is gating.
    expect(h.accounts.membership(c.account.id, ada.id)).toBe(true);
    // Accepted an invite, not yet granted. On the account, not yet a member.
    expect(h.accounts.membership(c.account.id, blake.id)).toBe(false);
    expect(h.accounts.membership(c.account.id, 'usr_nobody')).toBe(false);
    // But the account is listed for them, so they can see what they are waiting on.
    expect(h.store.accountsForUser(blake.id).map(a => a.id)).toEqual([c.account.id]);
  });

  it('a pending signer is a non-member in every derived field the record carries', async () => {
    /*
     * Added because a mutation survived. `memberUserIds` is the ONLY thing the
     * multi-tenancy gate reads, and folding pending signers into it would make
     * somebody who has merely accepted an invite a full member of every
     * account-scoped route — before any existing signer granted them anything.
     *
     * The check above cannot catch that on its own: `acceptSignerInvite` writes
     * the record by hand, because it holds no key and cannot re-seal, so the
     * derived fields are not recomputed at that point. This drives a normal
     * keyed write afterwards so `sealAccount` is the thing under test.
     */
    const { h, c, blake, pending } = await company();
    /*
     * A KEYED WRITE STOOD HERE and there is no longer one to make. `C292`,
     * `S26`: it was `accounts.deposit`, the simplest thing that routed through
     * `sealAccount`, and the account keeps no balance to deposit into.
     *
     * The assertions below still hold — `acceptSignerInvite` writes the record
     * by hand — but THE PROPERTY THIS TEST WAS FOR IS NO LONGER EXERCISED:
     * that a normal keyed write recomputes the derived fields and does not
     * promote a pending signer. It needs a keyed write to come back, or a
     * different one to stand in. Filed rather than faked.
     */

    const rec = h.accounts.require(c.account.id);
    expect(rec.pendingSigners.map(p => p.userId)).toEqual([blake.id]);
    expect(rec.memberUserIds).not.toContain(blake.id);
    expect(rec.signerCount).toBe(2);
    expect(h.accounts.membership(c.account.id, blake.id)).toBe(false);
    // Still pending, still there, still unreadable.
    expect(h.accounts.open(c.account.id, c.viewingKey)
      .signers.find(s => s.id === pending.id)!.status).toBe('pending');
  });

  it('one account\'s inbox does not open another\'s, even on the same viewing key', async () => {
    /*
     * Added because a mutation survived: dropping the account id from the inbox
     * derivation broke nothing. Within one account it makes no difference, and
     * two real accounts have different viewing keys — so the property the salt
     * buys is only visible if you reuse one deliberately, which is exactly the
     * scenario it defends against.
     */
    const vk = newSymmetricKey();
    const box = sealToInbox({ secret: 'devi@acme.co' }, inboxPublicKey(vk, 'acc_1'));
    expect(openFromInbox<{ secret: string }>(box, 'acc_1', vk).secret).toBe('devi@acme.co');
    expect(() => openFromInbox(box, 'acc_2', vk)).toThrow(/will not open/);
  });

  it('lets an invitee accept with no viewing key, and we cannot read what they wrote', async () => {
    const { h, c, pending, pendingLeaf, sk } = await company();
    // The invitee supplied public halves and never touched a viewing key.
    expect(pending.status).toBe('pending');

    const rec = h.accounts.require(c.account.id);
    expect(rec.pendingSigners).toHaveLength(1);
    const box = JSON.stringify(rec.pendingSigners[0]);
    expect(box).not.toContain(pendingLeaf);
    expect(box).not.toContain(sk.publicKey);
    expect(box).not.toContain('Devi Raman');
    expect(box).not.toContain('approver');

    // A key holder opens it, and gets everything back.
    const opened = h.accounts.open(c.account.id, c.viewingKey)
      .signers.find(s => s.id === pending.id)!;
    expect(opened.name).toBe('Devi Raman');
    expect(opened.role).toBe('approver');
    expect(opened.leafCommitment).toBe(pendingLeaf);
    expect(opened.signingPublicKey).toBe(sk.publicKey);
  });

  it('the invite stops holding a second copy of the name and email once accepted', async () => {
    const { h, c } = await company();
    const invites = JSON.stringify((h.store as any).data.invites);
    expect(invites).not.toContain('Devi Raman');
    expect(invites).not.toContain('devi@acme.co');
    // Still linked to the seat it created, which is what the record is for.
    const invite = h.store.listInvites(c.account.id)[0];
    expect(invite.subjectId).toBe(h.accounts.require(c.account.id).pendingSigners[0].id);
  });

  it('granting access moves the signer into the sealed roster and leaves no second copy', async () => {
    const { h, c, pending, blake } = await company();

    const seat = await h.accounts.proposeSigner(c.account.id, c.viewingKey, pending.id, c.secrets[0].signerId);
    await h.accounts.approve(seat.id, c.secrets[0].signerId, sign(approvalMessage(seat), c.secrets[0].signingSecret), c.viewingKey);
    await h.accounts.approve(seat.id, c.secrets[1].signerId, sign(approvalMessage(seat), c.secrets[1].signingSecret), c.viewingKey);
    await h.accounts.grantAccess(c.account.id, c.viewingKey, pending.id);

    const rec = h.accounts.require(c.account.id);
    // The drop box is emptied. Two copies of one signer, free to disagree, is
    // the failure this avoids.
    expect(rec.pendingSigners).toHaveLength(0);
    expect(rec.memberUserIds).toContain(blake.id);
    expect(rec.signerCount).toBe(3);
    expect(h.accounts.membership(c.account.id, blake.id)).toBe(true);

    const roster = h.accounts.open(c.account.id, c.viewingKey).signers;
    expect(roster).toHaveLength(3);
    expect(roster.filter(s => s.id === pending.id)).toHaveLength(1);
    expect(roster.find(s => s.id === pending.id)!.status).toBe('active');
    // And still nothing readable.
    expect(JSON.stringify((h.store as any).data)).not.toContain('Devi Raman');
  });

  it('the roster and the policy are under DIFFERENT keys, so one can be delegated without the other', async () => {
    /*
     * The first place per-purpose subkeys buy anything concrete (M-90, M-95).
     * If both envelopes opened under one key, handing an accounting plug-in the
     * spending rules would hand it the staff list too.
     */
    const { h, c } = await company();
    const rec = h.accounts.require(c.account.id);
    expect(() => openRecord('policy', rec.id, rec.sealedRoster, c.viewingKey)).toThrow(/will not open/);
    expect(() => openRecord('roster', rec.id, rec.sealedPolicy, c.viewingKey)).toThrow(/will not open/);
  });

  it('a proposal does not open under the policy subkey either', async () => {
    /*
     * S-11. Proposals were sealed under `policy` until M-96, so the subkey you
     * would delegate for spending rules also opened every proposal summary and
     * the per-signer approval list — the deanonymised form of the chain's
     * nullifiers. Separation that a delegation would defeat is not separation.
     */
    const { h, c } = await company();
    /*
     * No entries, so the asset cannot be derived from them — which is the only
     * reason `asset` is still an argument to `propose`. M-125.
     */
    const p = await h.accounts.propose({
      accountId: c.account.id, viewingKey: c.viewingKey, kind: 'transfer',
      summary: 'Pay Wilkinson Legal', payload: {}, asset: 'GBP',
      proposedBy: c.secrets[0].signerId,
    });
    const stored = h.store.getProposal(p.id)!;
    expect(() => openRecord('policy', stored.accountId, stored.sealed, c.viewingKey)).toThrow(/will not open/);
    expect(h.accounts.requireProposal(p.id, c.viewingKey).summary).toContain('Wilkinson');
  });

  it('another account\'s viewing key opens nothing, and neither does the inbox public key', async () => {
    const { h, c } = await company();
    const other = await h.accounts.create('Globex', THREE_SIGNERS, 2);
    const rec = h.accounts.require(c.account.id);

    expect(() => openAccount(rec, other.viewingKey)).toThrow(/will not open/);
    // The inbox public key is published in the clear. It must not be a way in.
    expect(() => openAccount(rec, rec.inboxPublicKey)).toThrow(/will not open/);
  });

  it('seal and open are a round trip, so nothing is silently dropped', async () => {
    const { h, c } = await company();
    const before = h.accounts.open(c.account.id, c.viewingKey);
    const rec = h.accounts.require(c.account.id);
    const again = openAccount(sealAccount(before, c.viewingKey, rec.pendingSigners, rec.keyEpoch), c.viewingKey);
    expect(again).toEqual(before);
  });

  it('the readable numbers match the sealed ones they were written from', async () => {
    const { h, c } = await company();
    const rec = h.accounts.require(c.account.id);
    const open = h.accounts.open(c.account.id, c.viewingKey);
    // Both are public on chain, which is the only reason they are outside.
    expect(rec.threshold).toBe(open.policy.threshold);
    expect(rec.signerCount).toBe(open.signers.filter(s => s.status === 'active').length);
    // A pending signer is not in the count and not a member.
    expect(rec.signerCount).toBe(2);
    expect(rec.pendingSigners).toHaveLength(1);
  });
});

describe('K-4: changing the locks', () => {
  /*
   * Removing a signer does not un-teach them a key they already hold, so
   * removal means rotation: a new viewing key, everything re-sealed under it,
   * re-wrapped to whoever is left.
   *
   * These assert the property against the STORE and against the ledger blob,
   * not against a return value, because "the old key no longer opens current
   * state" is a negative and the S-9 lesson is that negatives have to be
   * checked where the data actually sits.
   */

  /** A company with money, payroll, a settled run, a proposal and a pending signer. */
  async function loaded() {
    const h = harness();
    /* `PI4b`: a signer with a real user id, made the way a wallet sign-in
     * makes one. See `company()` above. */
    const blake = { id: signIn(h, 'blake@acme.co', 'Blake Ruiz') };
    const c = await h.accounts.create('Northwind Ltd', THREE_SIGNERS, 2);
    h.payroll.hireDirect(c.account.id,
      { name: 'Dana Whitfield', email: 'dana@acme.co', title: 'Engineer', asset: 'GBP', baseAmount: 6_200_00n }, c.viewingKey);
    const { run } = await h.payroll.createRunFromRoster(c.account.id, '2026-07', c.viewingKey);
    const p = await h.accounts.propose({
      accountId: c.account.id, viewingKey: c.viewingKey, kind: 'transfer',
      summary: 'Pay Wilkinson Legal',
      payload: { entries: [{ id: 'e1', kind: 'transfer', asset: 'GBP', amount: 9_000_00n, counterparty: 'y', memo: '', at: '' }] },
      proposedBy: c.secrets[0].signerId,
    });

    const invite = h.accounts.inviteSigner(c.account.id, 'Devi Raman', 'devi@acme.co', 'approver');
    const sk = newSigningKeypair();
    const wk = newWrappingKeypair();
    const pendingLeaf = 'ef'.repeat(32);
    const pending = h.accounts.acceptSignerInvite(
      invite.token, blake.id, sk.publicKey, wk.publicKey, pendingLeaf);

    return { h, c, run, p, pending, pendingLeaf };
  }

  it('the old key opens nothing afterwards, and the new key opens everything', async () => {
    const { h, c, run, p, pending, pendingLeaf } = await loaded();
    const old = c.viewingKey;
    const before = await h.accounts.readState(c.account.id, old);

    const { viewingKey: next, keyEpoch } = await h.accounts.rotate(c.account.id, old);
    expect(keyEpoch).toBe(1);
    expect(next).not.toBe(old);

    // THE PROPERTY. Every record, checked one by one rather than trusting that
    // one of them standing in for the rest.
    expect(() => h.accounts.open(c.account.id, old)).toThrow(/will not open/);
    expect(() => h.payroll.listPeople(c.account.id, old)).toThrow(/will not open/);
    expect(() => h.payroll.requireRun(run.id, old)).toThrow(/will not open/);
    expect(() => h.accounts.requireProposal(p.id, old)).toThrow(/will not open/);
    await expect(h.accounts.readState(c.account.id, old)).rejects.toThrow(/no sealed state|cannot open/);

    // And all of it still reads under the new one.
    const opened = h.accounts.open(c.account.id, next);
    expect(opened.name).toBe('Northwind Ltd');
    expect(opened.policy.threshold).toBe(2);
    expect(h.payroll.listPeople(c.account.id, next).map(e => e.baseAmount)).toEqual([6_200_00n]);
    // `total` USED TO BE ONE NUMBER; M-125 replaced it with a subtotal per
    // asset, because one figure across mixed currencies means nothing.
    expect(h.payroll.requireRun(run.id, next).totals).toEqual({ GBP: 6_200_00n });
    expect(h.accounts.requireProposal(p.id, next).summary).toContain('Wilkinson');
    expect(await h.accounts.readState(c.account.id, next)).toEqual(before);

    // Including the pending signer, whose drop box was sealed to an inbox
    // derived from a key that no longer exists.
    const stillPending = opened.signers.find(s => s.id === pending.id)!;
    expect(stillPending.status).toBe('pending');
    expect(stillPending.name).toBe('Devi Raman');
    expect(stillPending.leafCommitment).toBe(pendingLeaf);
  });

  it('every remaining signer can reach the new key from their own wrapping secret', async () => {
    const { h, c } = await loaded();
    const { viewingKey: next } = await h.accounts.rotate(c.account.id, c.viewingKey);
    for (const s of c.secrets) {
      expect(h.accounts.recoverViewingKey(c.account.id, s.signerId, s.wrappingSecret)).toBe(next);
    }
  });

  it('an excluded signer loses their wrapped copy and their seat', async () => {
    const { h, c } = await loaded();
    const gone = c.secrets[2];
    const { viewingKey: next } = await h.accounts.rotate(c.account.id, c.viewingKey, [gone.signerId]);

    // No wrapped key, so there is no path from their secret to the new one.
    expect(() => h.accounts.recoverViewingKey(c.account.id, gone.signerId, gone.wrappingSecret))
      .toThrow(/no wrapped key/);
    expect(h.accounts.open(c.account.id, next).signers.map(s => s.id)).not.toContain(gone.signerId);
    // And the two who stayed are unaffected.
    expect(h.accounts.recoverViewingKey(c.account.id, c.secrets[0].signerId, c.secrets[0].wrappingSecret))
      .toBe(next);
  });

  it('refuses a rotation that would leave the account below its own threshold', async () => {
    /*
     * Not politeness. Below the threshold the account can never approve
     * anything again — including a proposal to add somebody back — so it is
     * finished, with the money still in it.
     */
    const { h, c } = await loaded();
    await expect(
      h.accounts.rotate(c.account.id, c.viewingKey, [c.secrets[1].signerId, c.secrets[2].signerId]),
    ).rejects.toThrow(/could never approve anything again/);
    // And nothing moved: the old key still works.
    expect(h.accounts.open(c.account.id, c.viewingKey).name).toBe('Northwind Ltd');
    expect(h.accounts.require(c.account.id).keyEpoch).toBe(0);
  });

  it('refuses a rotation driven by someone who does not hold the current key', async () => {
    const { h, c } = await loaded();
    const other = await h.accounts.create('Globex', THREE_SIGNERS, 2);
    await expect(h.accounts.rotate(c.account.id, other.viewingKey)).rejects.toThrow(/will not open/);
    expect(h.accounts.require(c.account.id).keyEpoch).toBe(0);
  });

  it('refuses to re-seal over an epoch that already exists', async () => {
    const { h, c } = await loaded();
    const { keyEpoch } = await h.accounts.rotate(c.account.id, c.viewingKey);
    // Writing over an epoch destroys the only copy of the state under that key.
    await expect(h.ledger.reseal(c.account.id, { keyEpoch, sealed: seal('{}', 'ee'.repeat(32)) }))
      .rejects.toThrow(/already sealed at key epoch/);
  });

  it('stamps records created AFTER a rotation with the current epoch, so the next one works', async () => {
    /*
     * The trap this closes: a literal `keyEpoch: 0` at the call site. An
     * employee hired after a rotation would be filed at epoch 0 while sealed
     * under the epoch-1 key, and the NEXT rotation would re-seal it from the
     * wrong key and destroy it. Two rotations, so the failure has somewhere to
     * land.
     */
    const { h, c } = await loaded();
    const r1 = await h.accounts.rotate(c.account.id, c.viewingKey);
    h.payroll.hireDirect(c.account.id,
      { name: 'Sam Ortega', email: 'sam@acme.co', title: 'Designer', asset: 'GBP', baseAmount: 4_800_00n }, r1.viewingKey);
    expect(h.store.listEmployees(c.account.id).map(e => e.keyEpoch)).toEqual([1, 1]);

    const r2 = await h.accounts.rotate(c.account.id, r1.viewingKey);
    // `listPeople` sorts by name, which it can only do because it holds the key.
    expect(h.payroll.listPeople(c.account.id, r2.viewingKey).map(e => e.baseAmount))
      .toEqual([6_200_00n, 4_800_00n]);
    expect(h.store.listEmployees(c.account.id).map(e => e.keyEpoch)).toEqual([2, 2]);
  });

  it('still holds no company name, no salary and no leafCommitment afterwards', async () => {
    // Rotation must not quietly undo M-96 by writing something back in the clear.
    const { h, c, pendingLeaf } = await loaded();
    await h.accounts.rotate(c.account.id, c.viewingKey);
    // Short strings against the blanked view; the 64-character leaf against the
    // raw text, where it cannot collide by chance. See `readableStore`.
    const readable = readableStore((h.store as any).data);
    for (const text of ['Northwind', 'Dana Whitfield', '620000', 'Wilkinson']) {
      expect(readable).not.toContain(text);
    }
    expect(JSON.stringify((h.store as any).data)).not.toContain(pendingLeaf);
  });
});

describe('M-99: removing a signer', () => {
  /*
   * K-4 changes the locks, which stops a departing signer READING. This is the
   * other half: stopping them ACTING.
   *
   * Each signer holds a SLOT in the tree, and removing somebody clears that one
   * slot. Nobody else is touched, nothing is recomputed, and nobody is ever
   * identified: the removal proves membership exactly as approving a payment
   * does. M-106.
   */

  async function threeSigners() {
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE_SIGNERS, 2);
    return { h, c, ada: c.secrets[0], blake: c.secrets[1], cleo: c.secrets[2] };
  }

  /** Runs the whole round: propose, reach the threshold, remove. */
  async function removeCleo(h: ReturnType<typeof harness>, c: any) {
    const p = await h.accounts.proposeRemoval(
      c.account.id, c.viewingKey, c.secrets[2].signerId, c.secrets[0].signerId);
    await h.accounts.approve(p.id, c.secrets[0].signerId, sign(approvalMessage(p), c.secrets[0].signingSecret), c.viewingKey);
    await h.accounts.approve(p.id, c.secrets[1].signerId, sign(approvalMessage(p), c.secrets[1].signingSecret), c.viewingKey);
    return h.accounts.removeSigner(c.account.id, c.viewingKey, c.secrets[2].signerId);
  }

  it('the removed signer can no longer act on chain, which K-4 alone could not do', async () => {
    const { h, c, cleo } = await threeSigners();
    expect((await h.accounts.ledgerStatus(c.account.id))!.signerCount).toBe(3);

    const out = await removeCleo(h, c);

    // One fewer seat on chain, and the chain and the roster agree about it.
    expect((await h.accounts.ledgerStatus(c.account.id))!.signerCount).toBe(2);
    expect(h.accounts.open(c.account.id, out.viewingKey).signers).toHaveLength(2);

    // THE POINT. Their old leaf is not in the tree any more, so the ledger
    // refuses them — without anyone having said which signer they are.
    await expect(h.accounts.propose({
      accountId: c.account.id, viewingKey: out.viewingKey, kind: 'transfer',
      summary: 'after removal', payload: { entries: [] }, asset: 'GBP',
      proposedBy: cleo.signerId,
    })).rejects.toThrow(/not a signer/);
  });

  it('removes their access to the data in the same operation — revoke, then rotate', async () => {
    /*
     * The ORDER matters and is the reason this is one method rather than two
     * calls a screen makes in sequence. Rotating first would leave a window in
     * which the leaver can still act on chain and still read, because they hold
     * the old viewing key until the new records are written.
     */
    const { h, c, cleo, ada } = await threeSigners();
    const old = c.viewingKey;
    const out = await removeCleo(h, c);

    expect(out.viewingKey).not.toBe(old);
    expect(out.keyEpoch).toBe(1);
    expect(() => h.accounts.open(c.account.id, old)).toThrow(/will not open/);
    // No wrapped copy for them, so their own secret reaches nothing.
    expect(() => h.accounts.recoverViewingKey(c.account.id, cleo.signerId, cleo.wrappingSecret))
      .toThrow(/no wrapped key/);
    // And the people who stayed reach the new key from their own secrets.
    expect(h.accounts.recoverViewingKey(c.account.id, ada.signerId, ada.wrappingSecret))
      .toBe(out.viewingKey);
  });

  it('refuses a removal that has not reached the threshold', async () => {
    const { h, c } = await threeSigners();
    const p = await h.accounts.proposeRemoval(
      c.account.id, c.viewingKey, c.secrets[2].signerId, c.secrets[0].signerId);
    await h.accounts.approve(p.id, c.secrets[0].signerId, sign(approvalMessage(p), c.secrets[0].signingSecret), c.viewingKey);

    await expect(h.accounts.removeSigner(c.account.id, c.viewingKey, c.secrets[2].signerId))
      .rejects.toThrow(/not enough approvals/);
    // Nothing moved: they are still a signer and the key has not rotated.
    expect(h.accounts.open(c.account.id, c.viewingKey).signers).toHaveLength(3);
    expect(h.accounts.require(c.account.id).keyEpoch).toBe(0);
  });

  it('refuses a removal with no approved round at all', async () => {
    const { h, c } = await threeSigners();
    /*
     * The refusal moved up a layer. `Ledger.removeSigner` takes a proposal id
     * now — an account holds several open proposals at once and the contract
     * has to be told which one is being spent — so `removeSigner` has to find
     * that approved round before it can call the chain, and finds nothing.
     * M-128. The ledger's own guard is pinned separately below.
     */
    await expect(h.accounts.removeSigner(c.account.id, c.viewingKey, c.secrets[2].signerId))
      .rejects.toThrow(/no open proposal on this account for that change/);
  });

  it('refuses a removal approved for somebody else', async () => {
    /*
     * The round commits to the exact leaf. Without that, one approved removal
     * would authorise removing anyone — the same hole M-69 closed for
     * additions.
     */
    const { h, c } = await threeSigners();
    const p = await h.accounts.proposeRemoval(
      c.account.id, c.viewingKey, c.secrets[2].signerId, c.secrets[0].signerId);
    await h.accounts.approve(p.id, c.secrets[0].signerId, sign(approvalMessage(p), c.secrets[0].signingSecret), c.viewingKey);
    await h.accounts.approve(p.id, c.secrets[1].signerId, sign(approvalMessage(p), c.secrets[1].signingSecret), c.viewingKey);

    /*
     * Approved to remove Cleo; try to remove Blake instead. The round is
     * matched on its digest — `signerRemovePayload(leaf)` — so a round raised
     * for Cleo's leaf is simply not a round for Blake's, and there is nothing
     * to hand the contract. The LEDGER's version of this check is the one that
     * counts against somebody calling the chain directly, and is pinned below.
     */
    await expect(h.accounts.removeSigner(c.account.id, c.viewingKey, c.secrets[1].signerId))
      .rejects.toThrow(/no open proposal on this account for that change/);
  });

  it('refuses to strand the account below its own threshold, at the earliest point', async () => {
    /*
     * Refused when the round is PROPOSED, not when it is performed. A removal
     * that can never legally settle should not be able to collect approvals
     * first — three people would sign something that was always going to be
     * refused, and the fee would be paid to find out.
     *
     * The chain refuses it too. That is the test below, and it is the one that
     * matters: this one is a courtesy, and a courtesy is worth nothing against
     * somebody who calls the contract directly.
     */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE_SIGNERS, 3);

    await expect(h.accounts.proposeRemoval(
      c.account.id, c.viewingKey, c.secrets[2].signerId, c.secrets[0].signerId,
    )).rejects.toThrow(/could never approve anything again/);

    // Nothing moved: no round was opened and everyone is still a signer.
    expect((await h.accounts.ledgerStatus(c.account.id))!.openProposals).toEqual([]);
    expect(h.accounts.open(c.account.id, c.viewingKey).signers).toHaveLength(3);
  });

  it('a signer arriving between the proposal and the removal does not invalidate it', async () => {
    /*
     * Under the generation design the proposal digest covered the whole
     * survivor list, so anything that changed the signer set between proposing
     * and removing made the approved digest describe something that would no
     * longer happen — the round reached its threshold and was then refused by
     * the chain with the fee paid. The digest is one leaf now, so the only
     * thing that can invalidate it is a change to WHO is leaving.
     */
    const { h, c } = await threeSigners();
    const p = await h.accounts.proposeRemoval(
      c.account.id, c.viewingKey, c.secrets[2].signerId, c.secrets[0].signerId);
    await h.accounts.approve(p.id, c.secrets[0].signerId, sign(approvalMessage(p), c.secrets[0].signingSecret), c.viewingKey);
    await h.accounts.approve(p.id, c.secrets[1].signerId, sign(approvalMessage(p), c.secrets[1].signingSecret), c.viewingKey);

    // Adding a signer between proposing and removing changes the survivor set,
    // so the approved digest no longer describes what would happen.
    const invite = h.accounts.inviteSigner(c.account.id, 'Devi', 'devi@acme.co', 'approver');
    const sk = newSigningKeypair(); const wk = newWrappingKeypair();
    const pending = h.accounts.acceptSignerInvite(
      invite.token, null, sk.publicKey, wk.publicKey, LEAF);
    expect(pending.status).toBe('pending');
    // Pending signers are not seated, so the set is unchanged and it still works.
    const out = await h.accounts.removeSigner(c.account.id, c.viewingKey, c.secrets[2].signerId);
    expect(out.account.signers.map(s => s.id)).not.toContain(c.secrets[2].signerId);
    expect((await h.accounts.ledgerStatus(c.account.id))!.signerCount).toBe(2);
  });

  it('the LEDGER refuses the removed signer, not merely our own roster', async () => {
    /*
     * Added because a mutation survived, and it showed the headline test above
     * was passing for the wrong reason.
     *
     * `AccountService` refuses a removed signer because they are no longer in
     * its roster — which is our own bookkeeping, and worth nothing against
     * somebody who calls the chain directly. That is the entire threat: a
     * departing signer does not have to use our server.
     *
     * So this goes around the service and asks the ledger, holding exactly what
     * the removed signer still holds: their old leaf.
     */
    const { h, c, cleo } = await threeSigners();
    const oldLeaf = h.accounts.open(c.account.id, c.viewingKey)
      .signers.find(s => s.id === cleo.signerId)!.leafCommitment!;

    /*
     * A governance change moves no money, so its asset is the reserved `NONE`.
     * It derives a perfectly valid map key that can never appear in
     * `assetBalances`, because no governance circuit writes to the map — and
     * naming a real asset would be a lie in the ledger a client could read as
     * "this round concerns pounds". M-125.
     */
    const change = { asset: NO_ASSET, amount: 0n, batchDigest: 'bb'.repeat(32), salt: 'cc'.repeat(32) };

    // It works before the removal, so the test can fail for the right reason.
    await h.ledger.propose(
      c.account.id, 'aa'.repeat(32), change, { signerId: cleo.signerId, leaf: oldLeaf },
      SimulatedCommitments.noVault());
    // The id is read back from what the chain publishes rather than derived.
    const [opened] = (await h.ledger.status(c.account.id))!.openProposals;
    await h.ledger.cancel(c.account.id, opened.id, { signerId: cleo.signerId, leaf: oldLeaf });

    await removeCleo(h, c);

    await expect(h.ledger.propose(
      c.account.id, 'aa'.repeat(32), change, { signerId: cleo.signerId, leaf: oldLeaf },
      SimulatedCommitments.noVault(),
    )).rejects.toThrow(/not a signer/);
    // The signer check comes before the proposal lookup, so any id shows it.
    await expect(h.ledger.approve(
      c.account.id, opened.id, { signerId: cleo.signerId, leaf: oldLeaf },
    )).rejects.toThrow(/not a signer/);
  });

  it('a leaf never changes, so a survivor cannot be locked out by somebody else leaving',
    async () => {
      /*
       * The inverse of the test this replaces, and the reason M-106 is worth
       * doing rather than only cheaper.
       *
       * A leaf used to be bound to the signer set's generation, so every
       * removal gave every remaining signer a NEW leaf that the account had to
       * recompute correctly for all of them. M-104 was that computation being
       * wrong by a domain tag, and its consequence was an account with money in
       * it that nobody — not the person removed, everybody — could act on.
       *
       * A leaf is now `commit(publicKey, blinding)` and never moves. There is
       * no recomputation, so there is no way for it to be wrong.
       */
      const { h, c, ada } = await threeSigners();
      const before = h.accounts.open(c.account.id, c.viewingKey)
        .signers.find(s => s.id === ada.signerId)!;
      const out = await removeCleo(h, c);
      const after = h.accounts.open(c.account.id, out.viewingKey)
        .signers.find(s => s.id === ada.signerId)!;

      expect(after.signingPublicKey).toBe(before.signingPublicKey);
      expect(after.leafCommitment).toBe(before.leafCommitment);

      // And it still works against the ledger, which is the claim that matters.
      await h.ledger.propose(
        c.account.id, 'aa'.repeat(32),
        { asset: NO_ASSET, amount: 0n, batchDigest: 'bb'.repeat(32), salt: 'cc'.repeat(32) },
        { signerId: ada.signerId, leaf: before.leafCommitment! },
        SimulatedCommitments.noVault(),
      );
      expect((await h.ledger.status(c.account.id))!.openProposals).toHaveLength(1);
    });

  it('the product cannot express a threshold the chain does not enforce', async () => {
    /*
     * M-102, and the assertion this file used to make was that `setThreshold`
     * DID NOT EXIST. That was right while the contract's threshold was a
     * `sealed` ledger field with no circuit able to move it: the method wrote
     * our own copy and nothing else, so the product could tell a customer three
     * approvals were required while the chain settled at two — a lie in the
     * dangerous direction, claiming more safety than existed.
     *
     * The field is unsealed now and there is a circuit. So the property under
     * test is no longer "you cannot change it" but the one that always
     * mattered: **the product cannot hold a threshold the chain does not.**
     */
    const { h, c } = await threeSigners();
    const chainThreshold = (await h.accounts.ledgerStatus(c.account.id))!.threshold;
    expect(h.accounts.open(c.account.id, c.viewingKey).policy.threshold).toBe(chainThreshold);
    expect(h.accounts.require(c.account.id).threshold).toBe(chainThreshold);
    /*
     * A THIRD ASSERTION STOOD HERE — the same read again, after an operation
     * that rewrote the sealed account. The operation was `accounts.deposit`,
     * and `C292` deleted it, so repeating the read would assert nothing that
     * the line above has not already asserted. Removed rather than left
     * looking like a second check.
     */
  });

  it('A ROUND SURVIVES ITS PROPOSER BEING REMOVED, AND THE NEXT APPROVAL DOES NOT THROW — `C377`, `T-286`, `S58`', async () => {
    /*
     * **THE SEQUENCE HAS NO FAILURE IN IT, WHICH IS WHY THIS IS A ROW AND NOT
     * AN EDGE CASE.** Cleo raises a round; Cleo is removed by a properly
     * governed round; Blake approves the one Cleo raised. Every step is an
     * ordinary governance action a screen offers.
     *
     * **WHAT IT USED TO DO.** `recordStanding` read
     * `account.signers.find(s => s.id === proposal.proposedBy)!` — and
     * `removeSigner` DELETES the row rather than marking it, with nothing
     * closing a removed proposer's still-open rounds. So the lookup returned
     * `undefined` and `.role` threw a `TypeError`. **`S52`'s reorder made that
     * permanent rather than costly:** the approval is durable by the time this
     * runs, so the reconcile re-entered on Blake's every later call and threw
     * the same `TypeError` again — Blake never reached the honest
     * `already approved`, and the round could never reach `'approved'`.
     *
     * **THE ASSERTION IS THE ABSENCE OF A THROW, AND THEN THAT THE STANDING
     * WAS ACTUALLY RECORDED** — a `catch` that swallowed the failure would
     * satisfy the first and not the second.
     */
    const { h, c, blake, cleo } = await threeSigners();

    const raised = await h.accounts.propose({
      accountId: c.account.id, viewingKey: c.viewingKey, kind: 'transfer',
      summary: "Cleo's round", payload: { entries: [] }, asset: 'GBP',
      proposedBy: cleo.signerId,
    });

    /* The removal rotates the viewing key and re-seals every record, so the
     * round Cleo raised is read back under the NEW key from here on. */
    const out = await removeCleo(h, c);
    expect(h.accounts.open(c.account.id, out.viewingKey).signers
      .some(sg => sg.id === cleo.signerId)).toBe(false);

    await h.accounts.approve(
      raised.id, blake.signerId,
      sign(approvalMessage(raised), blake.signingSecret), out.viewingKey);

    const after = h.accounts.requireProposal(raised.id, out.viewingKey);
    expect(after.approvals.map(a => a.signerId)).toEqual([blake.signerId]);
    /* The standing was computed, not skipped: `recordStanding` is the only
     * writer of this field and it needed the proposer's role to get here. */
    expect(after.approvalRound).toBeDefined();

    /*
     * **AND THE RECONCILE IS NOT A PERMANENT REFUSAL ANY MORE.** Blake comes
     * back; the gate fires because his approval is on an `open` round; and he
     * is told the true thing rather than handed a `TypeError` for ever.
     */
    await expect(h.accounts.approve(
      raised.id, blake.signerId,
      sign(approvalMessage(raised), blake.signingSecret), out.viewingKey))
      .rejects.toThrow(/already approved/);
  });

  it('AND THE SAME THROUGH A GOVERNANCE DOOR, WHICH IS THE HALF THE FIRST DRAFT MISSED — `T-286`, `S58`', async () => {
    /*
     * **THIS ROUND'S `money-safety-auditor` FOUND THAT THE CASE ABOVE COVERED
     * TWO PROPOSE DOORS OF SIX**, and the four it did not cover are the
     * GOVERNANCE doors — where a proposer being removed between raising and
     * approving is the ordinary case rather than the odd one. The fix now
     * records `proposerRole` at all six; this drives one of the four that had
     * no role at all in the first draft.
     *
     * `proposeVaultThresholdChange` is chosen because it is the one of the four
     * with a live product route (`POST /api/accounts/:id/vault-threshold`).
     */
    const { h, c, blake, cleo } = await threeSigners();
    const VAULT = 'd1'.repeat(32);

    const raised = await h.accounts.proposeVaultThresholdChange(
      c.account.id, c.viewingKey, VAULT, 2, cleo.signerId);

    const out = await removeCleo(h, c);
    expect(h.accounts.open(c.account.id, out.viewingKey).signers
      .some(sg => sg.id === cleo.signerId)).toBe(false);

    await h.accounts.approve(
      raised.id, blake.signerId,
      sign(approvalMessage(raised), blake.signingSecret), out.viewingKey);

    const after = h.accounts.requireProposal(raised.id, out.viewingKey);
    expect(after.approvals.map(a => a.signerId)).toEqual([blake.signerId]);
    expect(after.approvalRound).toBeDefined();
  });

  it('changes the threshold through a round, and both sides move together', async () => {
    const { h, c, ada, blake } = await threeSigners();
    expect((await h.accounts.ledgerStatus(c.account.id))!.threshold).toBe(2);

    const p = await h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 3, ada.signerId);
    await h.accounts.approve(p.id, ada.signerId, sign(approvalMessage(p), ada.signingSecret), c.viewingKey);
    await h.accounts.approve(p.id, blake.signerId, sign(approvalMessage(p), blake.signingSecret), c.viewingKey);
    await h.accounts.setThreshold(c.account.id, c.viewingKey, 3);

    // Both, and they are read from different places on purpose.
    expect((await h.accounts.ledgerStatus(c.account.id))!.threshold).toBe(3);
    expect(h.accounts.open(c.account.id, c.viewingKey).policy.threshold).toBe(3);
    expect(h.accounts.require(c.account.id).threshold).toBe(3);
  });

  it('THE LIE IT USED TO TELL: our copy does not move when the chain refuses', async () => {
    /*
     * The regression that matters, written as the original failure. The old
     * method wrote `policy.threshold` unconditionally; if the chain would not
     * take the change, the product said one thing and the chain did another.
     *
     * Here the round is never approved, so the ledger refuses — and the sealed
     * account must be untouched.
     */
    const { h, c, ada } = await threeSigners();
    const p = await h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 3, ada.signerId);
    await h.accounts.approve(p.id, ada.signerId, sign(approvalMessage(p), ada.signingSecret), c.viewingKey);

    await expect(h.accounts.setThreshold(c.account.id, c.viewingKey, 3))
      .rejects.toThrow(/not enough approvals/);

    expect(h.accounts.open(c.account.id, c.viewingKey).policy.threshold).toBe(2);
    expect((await h.accounts.ledgerStatus(c.account.id))!.threshold).toBe(2);
  });

  it('refuses a threshold above the number of signers, at the earliest point', async () => {
    /*
     * The M-37 hole this feature opens. `addSigner` lets one signer seat
     * another whenever `signerCount < threshold`, so a threshold above the
     * seated count hands that power back — M-37 reopened by a feature that
     * looks like it only makes the account stricter.
     *
     * Refused when the round is PROPOSED, so nobody signs something that was
     * always going to be rejected. The chain refuses it too, which is the test
     * in signer-governance.test.ts.
     */
    const { h, c, ada } = await threeSigners();
    await expect(h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, 4, ada.signerId,
    )).rejects.toThrow(/cannot exceed the 3 signers/);

    expect((await h.accounts.ledgerStatus(c.account.id))!.openProposals).toEqual([]);
    expect(h.accounts.open(c.account.id, c.viewingKey).policy.threshold).toBe(2);
  });

  it('refuses zero, a fraction, and a change to what it already is', async () => {
    const { h, c, ada } = await threeSigners();
    const propose = (n: number) => h.accounts.proposeThresholdChange(
      c.account.id, c.viewingKey, n, ada.signerId);
    await expect(propose(0)).rejects.toThrow(/at least one/);
    await expect(propose(2.5)).rejects.toThrow(/whole number/);
    await expect(propose(2)).rejects.toThrow(/already 2/);
  });

  it('the ledger itself refuses to strand the account, not just the layer above it', async () => {
    /*
     * Added because a mutation survived. `rotate` also refuses this, so the
     * service-level test passed with the ledger's own guard removed — and the
     * ledger's guard is the one that models what the contract does.
     */
    /*
     * A 3-of-3 account, created that way rather than raised with
     * `setThreshold`.
     *
     * The reason USED TO BE that it could not be raised at all: the contract
     * declared `threshold` as a SEALED ledger field, writable once in the
     * constructor. M-102 unsealed it and added a circuit, so raising it is now
     * possible — and would be a second approval round to set up, for a test
     * that is about the strand guard rather than about the threshold.
     */
    const h = harness();
    const c = await h.accounts.create('Northwind Ltd', THREE_SIGNERS, 3);
    const ada = c.secrets[0];
    const cleo = c.secrets[2];
    const account = h.accounts.open(c.account.id, c.viewingKey);
    const goneLeaf = account.signers.find(s => s.id === cleo.signerId)!.leafCommitment!;
    const by = { signerId: ada.signerId, leaf: account.signers[0].leafCommitment! };

    /*
     * The round is opened ON THE LEDGER DIRECTLY, deliberately going around
     * `proposeRemoval`, which now refuses this at the door. That refusal is a
     * courtesy in our own code; this test is about what the thing underneath
     * does when our code is not in the way, which is the only guard that counts
     * against a signer calling the contract themselves.
     */
    await h.ledger.propose(
      c.account.id, SimulatedCommitments.signerRemovePayload(goneLeaf),
      { asset: NO_ASSET, amount: 0n, batchDigest: commit('', ''), salt: newProposalSalt() }, by,
      SimulatedCommitments.noVault());
    const [round] = (await h.ledger.status(c.account.id))!.openProposals;
    for (const s of account.signers) {
      await h.ledger.approve(c.account.id, round.id, { signerId: s.id, leaf: s.leafCommitment! });
    }

    await expect(h.ledger.removeSigner(c.account.id, goneLeaf, round.id, by))
      .rejects.toThrow(/could never approve anything again/);
  });

  it('the LEDGER binds the removal to the leaf that was approved, not just our roster', async () => {
    /*
     * The service-level version of this is above; this one goes around the
     * service, because the roster is our own bookkeeping and worth nothing
     * against somebody calling the chain directly.
     *
     * Its predecessor asserted that the digest covered the SURVIVOR LIST as
     * well, which was a real guard against a removal that seated a set nobody
     * approved. M-106 deleted the list rather than guarding it: nothing is
     * supplied, so nothing can be swapped.
     */
    const { h, c, ada, blake, cleo } = await threeSigners();
    const account = h.accounts.open(c.account.id, c.viewingKey);
    const by = { signerId: ada.signerId, leaf: account.signers[0].leafCommitment! };
    const blakeLeaf = account.signers.find(s => s.id === blake.signerId)!.leafCommitment!;

    const p = await h.accounts.proposeRemoval(
      c.account.id, c.viewingKey, cleo.signerId, ada.signerId);
    await h.accounts.approve(p.id, ada.signerId, sign(approvalMessage(p), ada.signingSecret), c.viewingKey);
    await h.accounts.approve(p.id, blake.signerId, sign(approvalMessage(p), blake.signingSecret), c.viewingKey);

    // Approved to remove Cleo; the ledger is asked to remove Blake, naming the
    // very proposal that approved Cleo's removal.
    await expect(h.ledger.removeSigner(c.account.id, blakeLeaf, p.chainId, by))
      .rejects.toThrow(/not for this removal/);
  });

  it('leaves nothing readable behind, and no leafCommitment anywhere', async () => {
    const { h, c, cleo } = await threeSigners();
    const goneLeaf = h.accounts.open(c.account.id, c.viewingKey)
      .signers.find(s => s.id === cleo.signerId)!.leafCommitment!;
    const out = await removeCleo(h, c);

    const raw = JSON.stringify((h.store as any).data);
    expect(raw).not.toContain(goneLeaf);
    for (const s of h.accounts.open(c.account.id, out.viewingKey).signers) {
      expect(raw).not.toContain(s.leafCommitment!);
    }
    expect(readableStore((h.store as any).data)).not.toContain('Northwind');
  });

  it('the store holds no blinding factor for anybody, sealed or otherwise', async () => {
    /*
     * M-106, and the reason it is worth more than the 13x.
     *
     * M-99 put every signer's blinding factor into the sealed roster, because a
     * removal re-seated the survivors and could not compute their new leaves
     * without it. Decision 0003 says a blinding lives on one device and nowhere
     * else — whoever holds a blinding and a leaf holds the mapping from leaf to
     * person that the on-chain blinding exists to destroy.
     *
     * Sealed is not the same as absent. This asserts absent: the value is not
     * in the store in any form, ciphertext included, because the only copy is
     * the one handed to the signer at creation.
     */
    const { h, c } = await threeSigners();
    await removeCleo(h, c);
    const raw = JSON.stringify((h.store as any).data);
    for (const secret of c.secrets) {
      expect(secret.blinding).toBeTruthy();
      expect(raw).not.toContain(secret.blinding);
    }
  });
});

/**
 * M-125. One account, several currencies.
 *
 * The contract's `assetBalances` is a map because a company owing dollars to
 * one person and pounds to another is the ordinary case — and `execute` moves
 * ONE asset per round, so everything above the boundary has to say which. None
 * of the properties below could be stated before: there was one balance and
 * one number, and 500000 was five thousand pounds, half a USDC, or a rounding
 * error in ether depending on who was reading it.
 */
describe('several assets in one account', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  /** £100,000.00 and 50,000 USDC. Different decimals, deliberately. */
  async function twoAssets() {
    const c = await h.accounts.create('Acme', THREE_SIGNERS, 2);
    return c;
  }

  it('refuses a proposal moving two assets when it is written, not when it settles', async () => {
    /*
     * `execute` moves one balance, so a proposal mixing assets is a proposal
     * the chain can never settle. Refusing it at the moment it is written is
     * the difference between a clear error and a round that collects approvals
     * and is then rejected with the fee already paid.
     */
    const c = await twoAssets();
    await expect(h.accounts.propose({
      accountId: c.account.id, viewingKey: c.viewingKey, kind: 'transfer',
      summary: 'two currencies at once',
      payload: { entries: [
        { id: 'e1', kind: 'transfer', asset: 'GBP', amount: 1_000_00n, counterparty: 'y', memo: '', at: '' },
        { id: 'e2', kind: 'transfer', asset: 'USDC', amount: 1_000000n, counterparty: 'z', memo: '', at: '' },
      ] },
      proposedBy: c.secrets[0].signerId,
    })).rejects.toThrow(/moves 2 assets \(GBP, USDC\), and a round settles exactly one/);
    // Nothing was opened on chain, so nothing has to be cancelled.
    expect((await h.accounts.ledgerStatus(c.account.id))!.openProposals).toEqual([]);
  });

});
