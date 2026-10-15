import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import type { RosterVaultKeys } from '../core/vault-keys.js';
import { recordsKeypairFrom } from './company-nonce-secret.js';
import { readerRefusalOf, whyNotTheseReaders, type SecretReadersToCheck } from './secret-readers.js';
import { leafOfTheContract, seatOpenedFor } from '../testing/directory-seats.js';

/*
 * Every key a vault's secret is sealed to, checked on the device that approves
 * it. Each signer has their own wallet and their own seat on the account; the
 * service stands in for nothing here, because the check reads only what it is
 * handed.
 */
const CO = `co_${'c1'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'ac'.repeat(32);
const leaf = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
const signer = (n: number, name: string, given?: string) => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const companyKey = new Uint8Array(32).fill(n + 100);
  const committeeKey = committeeKeyFor(identity, CO) as { tag: string; value: string };
  /* Each signer's seat as a seating device makes it: its leaf commits to their wallet key, and its opening shows that. */
  const { seat: made, opening } = seatOpenedFor(committeeKey, n);
  const seat = given ?? made;
  const statement = signRecordsKey(identity, CO, ACCOUNT as never, companyKey, seat);
  const entry: RosterVaultKeys = {
    signerId: name.toLowerCase(), userId: name.toLowerCase(), name, filingKey: '00'.repeat(32) as never,
    keys: {
      committeeKey, recordsKey: statement.recordsKey as never,
      recordsKeyStatement: statement.signature as never, recordsKeySeat: statement.seat as never,
    },
  };
  return { identity, companyKey, committeeKey, statement, entry, seat, opening };
};
const ada = signer(1, 'Ada');
const bo = signer(2, 'Bo');
const cy = signer(3, 'Cy');
const all = [ada, bo, cy];

const VAULT = '9a'.repeat(32);
/* The vault, as the signer's own wallet read it off the vault: pinned to the account. */
const vaultRead = (over: Partial<{ vault: string; account: string }> = {}) => ({ vault: VAULT, account: ACCOUNT, ...over });
/* The seats the account holds and the vault, as one wallet read them. */
const seatsOf = (seats: readonly string[]) => ({ seats, vault: vaultRead() });

/* The company's directory as this device believes it: each seat's entry with its opening, and the compiled `signerLeaf`. */
const directoryOf = (seats: readonly { seat: string; opening: (typeof ada)['opening'] }[]) =>
  ({ seats: seats.map((s) => ({ seat: s.seat, opening: s.opening, retired: null })), leafOf: leafOfTheContract });
const good = (): SecretReadersToCheck => ({
  company: CO,
  readers: all.map((s) => s.statement.recordsKey),
  roster: all.map((s) => s.entry),
  seats: seatsOf(all.map((s) => s.seat)),
  vault: VAULT,
  account: ACCOUNT,
  directory: directoryOf(all),
});
/* The account as read, with the vault read some other way. */
const withVault = (vault: ReturnType<typeof vaultRead> | null): SecretReadersToCheck => ({ ...good(), seats: { ...good().seats!, vault } });

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
    /* RED WHEN: a statement signed by a key the service made, with that key put in as Bo's wallet key, passes - Bo's seat was not made for it. */
    const impostor = signer(9, 'Bo', bo.seat);
    expect(whyNotTheseReaders({ ...good(), roster: [ada.entry, impostor.entry, cy.entry], readers: [ada.statement.recordsKey, impostor.statement.recordsKey, cy.statement.recordsKey] }))
      .toMatch(/the wallet key that signed Bo's records key is not the one their seat on the company's account was made for/);
    /* RED WHEN: a signer who never gave keys is passed over. */
    expect(whyNotTheseReaders({ ...good(), roster: [ada.entry, { ...bo.entry, keys: null }, cy.entry] }))
      .toMatch(/Bo has not set up their vault keys/);
  });

  it('A SIGNER WHO HAS LEFT IS REFUSED AS A READER, BY THE SEATS THE ACCOUNT HOLDS', () => {
    /* Cy has left: the account seats two. */
    const seats = seatsOf([ada.seat, bo.seat]);
    /* RED WHEN: the two who remain are refused. */
    expect(whyNotTheseReaders({ ...good(), seats, roster: [ada.entry, bo.entry], readers: [ada.statement.recordsKey, bo.statement.recordsKey] })).toBeNull();
    /* RED WHEN: a signer who has left is still a reader. */
    expect(readerRefusalOf({ ...good(), seats })?.code).toBe('seat-not-held');
    const updated = seats;
    expect(whyNotTheseReaders({ ...good(), seats: updated }))
      .toMatch(/the seat Cy's wallet signed their records key for is not one the company's account holds now/);
    /* RED WHEN: the roster's count is not held to the chain's - one signer dropped from the roster, the run sealed to the rest. */
    expect(whyNotTheseReaders({ ...good(), seats: updated, roster: [ada.entry], readers: [ada.statement.recordsKey] }))
      .toMatch(/names 1 signer and its account on the chain seats 2/);
  });

  it('A SWAP AT THE SAME COUNT - CY OUT, DEE IN - WITH CY\'S OLD GENUINE STATEMENT REPLAYED BY THE SERVICE, IS REFUSED', () => {
    /*
     * Cy was replaced by Dee: the account still seats three, and nobody has changed the committee, so it still lists
     * Ada, Bo and Cy. The service serves the roster as it was before, with Cy's genuine statement, and the run seals
     * the new secret to Cy and not to Dee. Every count agrees.
     */
    const dee = signer(4, 'Dee');
    const afterTheSwap = seatsOf([ada.seat, bo.seat, dee.seat]);
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

  it('NO COMMITTEE IS READ: WHOEVER THE SUPER ADMINS PUT ON THE ACCOUNT\'S OR THE VAULT\'S, AT ANY THRESHOLD, CHANGES NOTHING', () => {
    const temporary = { tag: 'schnorr', value: '77'.repeat(32) };
    /*
     * The wallet's read carries committees here as a wallet's read does: one key nobody's seat was made for, one listed
     * twice, the vault's another and at another threshold. RED WHEN: the reader check reads any of them - the account
     * not held by a seat's key, the committee listing a key twice, or the vault not held as the account is.
     */
    for (const committees of [
      { committee: [temporary], threshold: 1, vault: { ...vaultRead(), committee: [temporary], threshold: 1 } },
      { committee: [ada.committeeKey, ada.committeeKey, bo.committeeKey], threshold: 2, vault: { ...vaultRead(), committee: [ada.committeeKey, ada.committeeKey], threshold: 2 } },
      { committee: all.map((s) => s.committeeKey), threshold: 2, vault: { ...vaultRead(), committee: [bo.committeeKey, temporary], threshold: 1 } },
    ]) {
      expect(readerRefusalOf({ ...good(), seats: { ...good().seats!, ...committees } as never })).toBeNull();
    }
    /* RED WHEN: a device whose wallet read nothing approves anyway. */
    expect(whyNotTheseReaders({ ...good(), seats: null })).toMatch(/wallet has not read who holds this company's account/);
  });

  it('THE VAULT IS THE ONE THE SIGNER\'S OWN WALLET READ: none read, another vault read, or one pinned to another account, is refused', () => {
    /* RED WHEN: the vault is taken as held with no read of it by the signer's wallet - from a service's report, say. */
    expect(readerRefusalOf(withVault(null))?.code).toBe('wallet-read-nothing');
    expect(readerRefusalOf({ ...good(), seats: { seats: good().seats!.seats } })?.code).toBe('wallet-read-nothing');
    /* RED WHEN: a read of some other vault, held as it should be, stands in for this one. */
    expect(readerRefusalOf(withVault(vaultRead({ vault: '9b'.repeat(32) })))?.code).toBe('wallet-read-nothing');
    /* RED WHEN: a vault pinned to another company's account passes. */
    expect(readerRefusalOf(withVault(vaultRead({ account: 'ad'.repeat(32) }))))
      .toEqual({ code: 'vault-not-the-companys', says: expect.stringMatching(/belongs to a different company account/) });
    /* Spelled in capitals, it is the same vault and the same account. */
    expect(readerRefusalOf({ ...withVault(vaultRead({ vault: VAULT.toUpperCase() })), account: ACCOUNT.toUpperCase() }))
      .toBeNull();
  });

  it('A STATEMENT A SIGNER\'S WALLET SIGNED FOR ANOTHER ACCOUNT CARRYING THE LABEL IS REFUSED', () => {
    const elsewhere = signRecordsKey(bo.identity, CO, 'ad'.repeat(32) as never, bo.companyKey, bo.seat);
    const boElsewhere = { ...bo.entry, keys: { ...bo.entry.keys!, recordsKeyStatement: elsewhere.signature as never } };
    /* RED WHEN: a statement is checked for any account but the one this device is approving for. */
    expect(readerRefusalOf({ ...good(), roster: [ada.entry, boElsewhere, cy.entry] })?.code).toBe('not-signed');
  });

  it('two seated signers giving one records key is refused', () => {
    /* Bo's roster entry names Ada's records key, signed by Bo's own wallet: two signers, one key, so one copy for two people. */
    const sameKey = { identity: bo.identity, companyKey: ada.companyKey };
    const statement = signRecordsKey(sameKey.identity, CO, ACCOUNT as never, sameKey.companyKey, bo.seat);
    const boTwin = { ...bo.entry, keys: { ...bo.entry.keys!, recordsKey: statement.recordsKey as never, recordsKeyStatement: statement.signature as never } };
    /* RED WHEN: two entries with one records key count as two readers, so the run seals one copy fewer than there are signers. */
    expect(readerRefusalOf({ ...good(), roster: [ada.entry, boTwin, cy.entry], readers: [ada.statement.recordsKey, cy.statement.recordsKey] }))
      .toEqual({ code: 'roster-not-the-chains', says: expect.stringMatching(/two signers give the same records key/) });
  });

  /* Bo's wallet holds a second seat, made for its key, in Cy's place: two seats, one wallet key. */
  const boAgain = seatOpenedFor(bo.committeeKey, 52);
  const boTwice = {
    seats: seatsOf([ada.seat, bo.seat, boAgain.seat]),
    directory: directoryOf([ada, bo, boAgain]),
    twin: { ...cy.entry, keys: { ...bo.entry.keys!, recordsKeySeat: boAgain.seat as never, recordsKeyStatement: signRecordsKey(bo.identity, CO, ACCOUNT as never, bo.companyKey, boAgain.seat).signature as never } },
  };

  it('two seated signers giving one wallet key is refused', () => {
    /* RED WHEN: one wallet key holding two seats counts as two readers. */
    expect(whyNotTheseReaders({ ...good(), seats: boTwice.seats, directory: boTwice.directory, roster: [ada.entry, bo.entry, boTwice.twin] }))
      .toMatch(/two seated signers give the same wallet key/);
  });

  it('names the kind of each refusal, so a screen can say what resolves it', () => {
    const code = (over: Partial<SecretReadersToCheck>) => readerRefusalOf({ ...good(), ...over })?.code ?? null;
    /* RED WHEN: a refusal is filed under a kind whose remedy is not its own. */
    expect(code({})).toBeNull();
    expect(code({ seats: null })).toBe('wallet-read-nothing');
    expect(code({ seats: { ...good().seats!, vault: vaultRead({ account: 'ad'.repeat(32) }) } })).toBe('vault-not-the-companys');
    expect(code({ directory: null })).toBe('wallet-read-nothing');
    expect(code({ roster: [ada.entry, { ...bo.entry, keys: null }, cy.entry] })).toBe('keys-not-given');
    expect(code({ roster: [ada.entry, { ...bo.entry, keys: { ...bo.entry.keys!, recordsKeyStatement: null } }, cy.entry] })).toBe('keys-not-given');
    expect(code({ roster: [ada.entry, { ...bo.entry, keys: { ...bo.entry.keys!, recordsKeySeat: cy.seat as never } }, cy.entry] })).toBe('not-signed');
    expect(code({ seats: { ...good().seats!, seats: [ada.seat, leaf(0x77), cy.seat] } })).toBe('seat-not-held');
    expect(code({ readers: [ada.statement.recordsKey, bo.statement.recordsKey, recordsKeypairFrom(new Uint8Array(32).fill(0x60)).publicKey] })).toBe('reader-not-a-signer');
    expect(code({ readers: [ada.statement.recordsKey, bo.statement.recordsKey] })).toBe('signer-left-out');
    /* The service's roster against the chain's seats: one signer twice, or the roster's count not the chain's. */
    expect(code({ seats: boTwice.seats, directory: boTwice.directory, roster: [ada.entry, bo.entry, boTwice.twin] })).toBe('roster-not-the-chains');
    expect(code({ roster: [ada.entry, bo.entry], readers: [ada.statement.recordsKey, bo.statement.recordsKey] })).toBe('roster-not-the-chains');
  });
});

describe('A READER IS THE WALLET KEY ITS SEAT WAS MADE FOR, AS ITS ENTRY\'S OPENING SHOWS, NEVER THE COMMITTEE', () => {
  it('REFUSES a wallet key that is not the one its seat\'s leaf was made for', () => {
    /* The service puts Mal's statement, for Bo's seat, in Bo's place. */
    const mal = signer(7, 'Bo', bo.seat);
    const withMal = seatsOf(all.map((s) => s.seat));
    const roster = [ada.entry, mal.entry, cy.entry];
    const readers = [ada.statement.recordsKey, mal.statement.recordsKey, cy.statement.recordsKey];
    /* RED WHEN: a key not in its seat's leaf is accepted as a reader. */
    expect(readerRefusalOf({ ...good(), seats: withMal, roster, readers })?.code).toBe('not-signed');
    /* RED WHEN: a directory entry whose opening is not of its seat's leaf proves the key it names. */
    const forged = { ...good().directory!, seats: good().directory!.seats.map((x) => (x.seat === bo.seat ? { ...x, opening: { ...mal.opening, walletKey: mal.committeeKey } } : x)) };
    expect(readerRefusalOf({ ...good(), seats: withMal, roster, readers, directory: forged })?.code).toBe('not-signed');
    /* RED WHEN: a retired seat's entry still proves its key. */
    const retired = { ...good().directory!, seats: good().directory!.seats.map((x) => (x.seat === bo.seat ? { ...x, retired: {} } : x)) };
    expect(readerRefusalOf({ ...good(), directory: retired })?.code).toBe('not-signed');
    /* RED WHEN: with nothing to work the leaves out, an opening proves its key. */
    expect(readerRefusalOf({ ...good(), directory: { ...good().directory!, leafOf: null } })?.code).toBe('not-signed');
  });
});
