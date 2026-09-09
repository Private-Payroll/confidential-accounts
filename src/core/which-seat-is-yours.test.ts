/**
 * **WHICH SEAT ON AN ACCOUNT BELONGS TO A SIGNED-IN PERSON, AND WHY GETTING IT
 * WRONG IS A MONEY QUESTION RATHER THAN A NAMING ONE.**
 *
 * A seat is what the contract knows about; a user is what a session knows
 * about. Everything attributable a person does is done as a seat, so a route
 * that cannot resolve the one to the other has only what the caller typed - and
 * a round is judged against the ceiling of the ROLE that raised it. **A caller
 * free to name a seat is a caller free to choose a ceiling.**
 *
 * ── WHY THIS FILE EXISTS BESIDE THE ROUTE TESTS RATHER THAN INSIDE THEM ──
 *
 * The route tests create a company over HTTP, and that door seats the creator
 * at index nought and leaves every other seat belonging to nobody. **So in
 * those tests "the caller's seat" and "the first seat" are the same seat, and
 * an implementation that answered with the first one would pass every case
 * there.** That is not a hypothetical: it was measured, by breaking the
 * resolver to return the first active seat and watching the route tests stay
 * green.
 *
 * The service takes the seats it is given, so here an account can have two
 * seats belonging to two different people - which is what a company looks like
 * once a second signer has accepted an invitation, and the only arrangement in
 * which the two answers come apart.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedCommitments } from './ledger.js';
import type { Ledger } from './ledger.js';
import { AccountService } from './account.js';
import { newSigningKeypair, newWrappingKeypair } from './crypto.js';
import type { Hex } from './crypto.js';

function harness() {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-seat-')), 'db.json'));
  const ledger: Ledger = new SimulatedLedger(SimulatedCommitments);
  return { store, accounts: new AccountService(store, ledger, SimulatedCommitments) };
}

/**
 * Ada holds the FIRST seat and Blake the second, and the roles are as far apart
 * as this product has: **so an answer that is right for the wrong reason - the
 * first seat, the only seat, the admin's seat - is wrong for Blake.**
 */
const aCompany = async (h: ReturnType<typeof harness>) => h.accounts.create('Northwind', [
  { name: 'Ada', role: 'admin', userId: 'usr_ada' },
  { name: 'Blake', role: 'viewer', userId: 'usr_blake' },
], 1);

describe('a person acts as their own seat and as no other', () => {
  /*
   * RED WHEN: the resolver answers with the first seat, the only seat, or any
   * seat that is not the one this user holds. **This is the case the route
   * tests cannot carry**, because their creator always holds seat nought.
   */
  it('answers with the seat that belongs to the person, not the first one', async () => {
    const h = harness();
    const c = await aCompany(h);
    const [ada, blake] = c.account.signers;

    expect(h.accounts.seatOf(c.account.id, c.viewingKey, 'usr_ada')).toBe(ada.id);
    expect(h.accounts.seatOf(c.account.id, c.viewingKey, 'usr_blake')).toBe(blake.id);
    expect(blake.id).not.toBe(ada.id);
  });

  /*
   * **AND THE ROLE MOVES WITH IT, WHICH IS THE HALF THAT IS ABOUT MONEY.**
   *
   * RED WHEN: the resolver stops distinguishing people. The two seats hold the
   * highest and the lowest role there is, so a resolver that answered with
   * either one for both would be handing a viewer an admin's ceiling.
   */
  it('the seat it answers with carries that person\'s own role', async () => {
    const h = harness();
    const c = await aCompany(h);
    const roleOf = (seatId: string) =>
      c.account.signers.find(s => s.id === seatId)!.role;

    expect(roleOf(h.accounts.seatOf(c.account.id, c.viewingKey, 'usr_ada'))).toBe('admin');
    expect(roleOf(h.accounts.seatOf(c.account.id, c.viewingKey, 'usr_blake'))).toBe('viewer');
  });

  /*
   * **IT REFUSES RATHER THAN ANSWERING WITH SOMEBODY.**
   *
   * RED WHEN: an unknown person is given a seat - the first, a default, or the
   * only one. Every caller of this is about to write something attributable,
   * and there is no version of that which is safe to do anonymously.
   */
  it('refuses a person who holds no seat here, rather than picking one', async () => {
    const h = harness();
    const c = await aCompany(h);
    expect(() => h.accounts.seatOf(c.account.id, c.viewingKey, 'usr_nobody'))
      .toThrow(/do not hold a seat on this account/);
  });

  /*
   * RED WHEN: a seat on one account can answer for another. The two companies
   * below share a person, and each has its own seats.
   */
  it('a person\'s seat on one company is not their seat on another', async () => {
    const h = harness();
    const first = await aCompany(h);
    const second = await aCompany(h);

    const here = h.accounts.seatOf(first.account.id, first.viewingKey, 'usr_ada');
    const there = h.accounts.seatOf(second.account.id, second.viewingKey, 'usr_ada');

    expect(here).toBe(first.account.signers[0].id);
    expect(there).toBe(second.account.signers[0].id);
    expect(here).not.toBe(there);
  });

  /*
   * **A SEAT THAT IS NOT ACTIVE IS NOT SOMEBODY'S SEAT YET.**
   *
   * A signer who has accepted an invitation is on the account and holds no key
   * and no authority until an existing signer grants them access. **They are in
   * `account.signers`**, so a resolver that looked only at the person would
   * find them and hand back a seat that cannot act.
   *
   * RED WHEN: the status filter is dropped. Measured before this case existed:
   * dropping it left every other case in this file, and every route case, green
   * - the two harnesses seat everybody active, so the branch was never reached.
   * The membership gate covers this today, which makes it depth rather than the
   * only wall; **undefended depth is still undefended.**
   */
  it('refuses a seat that is on the account but not yet active', async () => {
    const h = harness();
    const c = await aCompany(h);

    /*
     * The roster as it is between accepting an invitation and being granted
     * access: on the account, carrying a person, and not yet able to act.
     * Built through the real door rather than by editing a record, because a
     * pending signer is not simply a signer with a different word on it - it
     * lives outside the sealed roster until access is granted.
     */
    const invite = h.accounts.inviteSigner(c.account.id, 'Cleo', 'cleo@northwind.co', 'approver');
    const sk = newSigningKeypair();
    const wk = newWrappingKeypair();
    const pending = h.accounts.acceptSignerInvite(
      invite.token, 'usr_cleo', sk.publicKey, wk.publicKey, 'ab'.repeat(32));
    expect(pending.status).toBe('pending');

    expect(() => h.accounts.seatOf(c.account.id, c.viewingKey, 'usr_cleo'))
      .toThrow(/do not hold a seat on this account/);

    /* And the active ones still resolve, so the refusal is not blanket. */
    expect(h.accounts.seatOf(c.account.id, c.viewingKey, 'usr_ada'))
      .toBe(c.account.signers[0].id);
  });

  /*
   * **THE MAPPING NEEDS THE VIEWING KEY, AND THAT IS THE PRIVACY PROPERTY
   * RATHER THAN AN INCONVENIENCE.** Which person holds which seat is precisely
   * the pairing the roster is sealed to hide.
   *
   * RED WHEN: the resolver reads the roster from the public record, or accepts
   * a key that is not this company's.
   */
  it('cannot be answered without the company\'s viewing key', async () => {
    const h = harness();
    const c = await aCompany(h);
    const notTheKey = ('cd'.repeat(32)) as Hex;
    expect(() => h.accounts.seatOf(c.account.id, notTheKey, 'usr_ada')).toThrow();
  });
});
