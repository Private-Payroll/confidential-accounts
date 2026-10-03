import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import type { RosterVaultKeys } from '../core/vault-keys.js';
import { recordsKeypairFrom } from './company-nonce-secret.js';
import { readerRefusalOf, whyNotTheseReaders, type SecretReadersToCheck } from './secret-readers.js';

/*
 * Every key a vault's secret is sealed to, checked on the device that approves
 * it. Each signer has their own wallet and their own seat on the account; the
 * service stands in for nothing here, because the check reads only what it is
 * handed.
 */
const CO = `co_${'c1'.repeat(32)}` as CompanyLabel;
const leaf = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
const signer = (n: number, name: string, seat = leaf(0x40 + n)) => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const companyKey = new Uint8Array(32).fill(n + 100);
  const committeeKey = committeeKeyFor(identity, CO) as { tag: string; value: string };
  const statement = signRecordsKey(identity, CO, companyKey, seat);
  const entry: RosterVaultKeys = {
    signerId: name.toLowerCase(), userId: name.toLowerCase(), name, filingKey: '00'.repeat(32) as never,
    keys: {
      committeeKey, recordsKey: statement.recordsKey as never,
      recordsKeyStatement: statement.signature as never, recordsKeySeat: statement.seat as never,
    },
  };
  return { identity, companyKey, committeeKey, statement, entry, seat };
};
const ada = signer(1, 'Ada');
const bo = signer(2, 'Bo');
const cy = signer(3, 'Cy');
const all = [ada, bo, cy];

const good = (): SecretReadersToCheck => ({
  company: CO,
  readers: all.map((s) => s.statement.recordsKey),
  roster: all.map((s) => s.entry),
  seats: { committee: all.map((s) => s.committeeKey), threshold: 2, seats: all.map((s) => s.seat) },
  mine: ada.committeeKey,
  vaultCommittee: all.map((s) => s.committeeKey),
});

describe('A SECRET RUN\'S READERS, CHECKED BEFORE THIS DEVICE APPROVES IT', () => {
  it('passes a run sealed to exactly the seated signers, each key signed by their own wallet for their seat', () => {
    expect(whyNotTheseReaders(good())).toBeNull();
    /* The order the run holds them in is the run's own. */
    expect(whyNotTheseReaders({ ...good(), readers: [...good().readers].reverse() })).toBeNull();
    /* The key signed for is the key the company's records are sealed to. */
    expect(ada.statement.recordsKey).toBe(recordsKeypairFrom(ada.companyKey).publicKey);
  });

  it('A KEY THE SERVICE SUBSTITUTES IS REFUSED BEFORE APPROVAL', () => {
    /* The service puts its own records key in Bo's place in the run: nobody's wallet signed it. */
    const theirs = recordsKeypairFrom(new Uint8Array(32).fill(0x5e)).publicKey;
    const readers = [ada.statement.recordsKey, theirs, cy.statement.recordsKey];
    /* RED WHEN: a reader that no signer's wallet signed for passes. */
    expect(whyNotTheseReaders({ ...good(), readers })).toMatch(/no signer of this company signed for/);
    /* And Bo is named as the one left out when the run simply drops them. */
    expect(whyNotTheseReaders({ ...good(), readers: [ada.statement.recordsKey, cy.statement.recordsKey] }))
      .toMatch(/would not be sealed to Bo/);
    /* RED WHEN: one reader listed twice stands in for another. */
    expect(whyNotTheseReaders({ ...good(), readers: [ada.statement.recordsKey, ada.statement.recordsKey, cy.statement.recordsKey] }))
      .toMatch(/sealed twice to the same signer/);
  });

  it('A COPY TO AN UNATTESTED KEY IS REFUSED: the roster\'s key for a signer must carry their wallet\'s signature for their seat', () => {
    const swapped = recordsKeypairFrom(new Uint8Array(32).fill(0x5f)).publicKey;
    /* The service rewrote Bo's roster entry with its own records key and kept Bo's signature beside it. */
    const roster = [ada.entry, { ...bo.entry, keys: { ...bo.entry.keys!, recordsKey: swapped as never } }, cy.entry];
    /* RED WHEN: the statement is not checked against the records key it sits beside. */
    expect(whyNotTheseReaders({ ...good(), roster, readers: [ada.statement.recordsKey, swapped, cy.statement.recordsKey] }))
      .toMatch(/was not signed by Bo's own wallet/);
    /* RED WHEN: the statement is not checked against the seat it sits beside. */
    const moved = [ada.entry, { ...bo.entry, keys: { ...bo.entry.keys!, recordsKeySeat: cy.seat as never } }, cy.entry];
    expect(whyNotTheseReaders({ ...good(), roster: moved })).toMatch(/was not signed by Bo's own wallet/);
    /* RED WHEN: an entry with no statement, or no seat for it, passes. */
    for (const keys of [{ ...bo.entry.keys!, recordsKeyStatement: null }, { ...bo.entry.keys!, recordsKeySeat: null }]) {
      expect(whyNotTheseReaders({ ...good(), roster: [ada.entry, { ...bo.entry, keys }, cy.entry] }))
        .toMatch(/Bo has not signed their records key for their seat/);
    }
    /* RED WHEN: a statement signed by a key the service made, with that key put in as Bo's committee key, passes - the chain does not list it. */
    const impostor = signer(9, 'Bo', bo.seat);
    expect(whyNotTheseReaders({ ...good(), roster: [ada.entry, impostor.entry, cy.entry], readers: [ada.statement.recordsKey, impostor.statement.recordsKey, cy.statement.recordsKey] }))
      .toMatch(/Bo's wallet key is not on the company's committee on the chain/);
    /* RED WHEN: a signer who never gave keys is passed over. */
    expect(whyNotTheseReaders({ ...good(), roster: [ada.entry, { ...bo.entry, keys: null }, cy.entry] }))
      .toMatch(/Bo has not set up their vault keys/);
  });

  it('A SEAT ON THE COMMITTEE IS NEVER ENOUGH: a signer who has left and still holds a seat is refused as a reader', () => {
    /* Cy has left: the account seats two, the committee nobody has changed still lists Cy. */
    const seats = { committee: all.map((s) => s.committeeKey), threshold: 2, seats: [ada.seat, bo.seat] };
    /* RED WHEN: the committee is not held to one key per seat the account holds now. */
    expect(whyNotTheseReaders({ ...good(), seats, roster: [ada.entry, bo.entry] }))
      .toMatch(/committee on the chain has 3 keys and its account seats 2 signers/);
    /* The roster still lists Cy, the run seals to Cy, and the committee was brought down to two without Cy: Cy's key is not on it. */
    const updated = { committee: [ada.committeeKey, bo.committeeKey], threshold: 2, seats: [ada.seat, bo.seat] };
    expect(whyNotTheseReaders({ ...good(), seats: updated, vaultCommittee: updated.committee }))
      .toMatch(/the seat Cy's wallet signed their records key for is not one the company's account holds now/);
    /* RED WHEN: the roster's count is not held to the chain's - one signer dropped from the roster, the run sealed to the rest. */
    expect(whyNotTheseReaders({ ...good(), seats: updated, vaultCommittee: updated.committee, roster: [ada.entry], readers: [ada.statement.recordsKey] }))
      .toMatch(/names 1 signer and its account on the chain seats 2/);
  });

  it('A SWAP AT THE SAME COUNT - CY OUT, DEE IN - WITH CY\'S OLD GENUINE STATEMENT REPLAYED BY THE SERVICE, IS REFUSED', () => {
    /*
     * Cy was replaced by Dee: the account still seats three, and nobody has changed the committee, so it still lists
     * Ada, Bo and Cy. The service serves the roster as it was before, with Cy's genuine statement, and the run seals
     * the new secret to Cy and not to Dee. Every count agrees.
     */
    const dee = signer(4, 'Dee');
    const afterTheSwap = { committee: all.map((s) => s.committeeKey), threshold: 2, seats: [ada.seat, bo.seat, dee.seat] };
    /* RED WHEN: the check counts seats and does not hold each statement's seat to the seats the account holds now. */
    expect(readerRefusalOf({ ...good(), seats: afterTheSwap })).toEqual({
      code: 'seat-not-held', says: expect.stringMatching(/the seat Cy's wallet signed their records key for is not one the company's account holds now/),
    });
  });

  it('A STATEMENT FOR A SEAT NO LONGER HELD IS REFUSED, AND TWO STATEMENTS FOR ONE SEAT ARE TOO', () => {
    /* Bo was seated again (a change of rights): the old seat is gone, the statement still names it. */
    const reseated = { ...good().seats!, seats: [ada.seat, leaf(0x77), cy.seat] };
    /* RED WHEN: a statement for a seat the account no longer holds passes. */
    expect(readerRefusalOf({ ...good(), seats: reseated })?.code).toBe('seat-not-held');
    /* RED WHEN: two entries signed for one seat both count. */
    const twice = signer(2, 'Bo', ada.seat);
    expect(whyNotTheseReaders({ ...good(), roster: [ada.entry, twice.entry, cy.entry], readers: [ada.statement.recordsKey, twice.statement.recordsKey, cy.statement.recordsKey] }))
      .toMatch(/signed for the same seat/);
  });

  it('NOTHING IS ACCEPTED WHILE THE SERVICE\'S TEMPORARY KEY HOLDS THE ACCOUNT OR THE VAULT', () => {
    const temporary = { tag: 'schnorr', value: '77'.repeat(32) };
    /* RED WHEN: an account held by a key that is not on the company's committee is taken as the company's. */
    expect(whyNotTheseReaders({ ...good(), seats: { committee: [temporary], threshold: 1, seats: all.map((s) => s.seat) } }))
      .toMatch(/account is not held by its own committee yet/);
    /* RED WHEN: a vault not yet handed over, or held by another committee, passes. */
    expect(whyNotTheseReaders({ ...good(), vaultCommittee: null })).toMatch(/vault is not held by the same committee/);
    expect(whyNotTheseReaders({ ...good(), vaultCommittee: [temporary] })).toMatch(/vault is not held by the same committee/);
    expect(whyNotTheseReaders({ ...good(), vaultCommittee: [ada.committeeKey, bo.committeeKey, temporary] }))
      .toMatch(/vault is not held by the same committee/);
    /* RED WHEN: a device whose wallet read nothing approves anyway. */
    expect(whyNotTheseReaders({ ...good(), seats: null })).toMatch(/wallet has not read who holds this company's account/);
    /* RED WHEN: a committee listing one key twice is counted as two signers. */
    expect(whyNotTheseReaders({ ...good(), seats: { committee: [ada.committeeKey, ada.committeeKey, bo.committeeKey], threshold: 2, seats: all.map((s) => s.seat) } }))
      .toMatch(/lists one key twice/);
  });

  it('two seated signers giving one wallet key is refused', () => {
    const twin = { ...cy.entry, keys: { ...bo.entry.keys!, recordsKeySeat: cy.seat as never, recordsKeyStatement: signRecordsKey(bo.identity, CO, bo.companyKey, cy.seat).signature as never } };
    expect(whyNotTheseReaders({ ...good(), roster: [ada.entry, bo.entry, twin] })).toMatch(/two seated signers give the same wallet key/);
  });

  it('names the kind of each refusal, so a screen can say what resolves it', () => {
    const code = (over: Partial<SecretReadersToCheck>) => readerRefusalOf({ ...good(), ...over })?.code ?? null;
    const temporary = { tag: 'schnorr', value: '77'.repeat(32) };
    /* RED WHEN: a refusal is filed under a kind whose remedy is not its own. */
    expect(code({})).toBeNull();
    expect(code({ seats: null })).toBe('wallet-read-nothing');
    expect(code({ seats: { committee: [temporary], threshold: 1, seats: all.map((s) => s.seat) } })).toBe('account-not-held');
    expect(code({ vaultCommittee: null })).toBe('vault-not-held');
    expect(code({ seats: { committee: all.map((s) => s.committeeKey), threshold: 2, seats: [ada.seat, bo.seat] } })).toBe('committee-out-of-date');
    expect(code({ roster: [ada.entry, { ...bo.entry, keys: null }, cy.entry] })).toBe('keys-not-given');
    expect(code({ roster: [ada.entry, { ...bo.entry, keys: { ...bo.entry.keys!, recordsKeyStatement: null } }, cy.entry] })).toBe('keys-not-given');
    expect(code({ roster: [ada.entry, { ...bo.entry, keys: { ...bo.entry.keys!, recordsKeySeat: cy.seat as never } }, cy.entry] })).toBe('not-signed');
    expect(code({ seats: { ...good().seats!, seats: [ada.seat, leaf(0x77), cy.seat] } })).toBe('seat-not-held');
    expect(code({ readers: [ada.statement.recordsKey, bo.statement.recordsKey, recordsKeypairFrom(new Uint8Array(32).fill(0x60)).publicKey] })).toBe('reader-not-a-signer');
    expect(code({ readers: [ada.statement.recordsKey, bo.statement.recordsKey] })).toBe('signer-left-out');
  });
});
