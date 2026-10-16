/**
 * **A WALLET HOLDS ONE SEAT AT A TIME, AND A SEAT ITS COMPANY RETIRED HOLDS NONE.**
 * A device believes a signer's roster entry on their seat's own entry in the
 * company's directory, whose opening proves the wallet the seat was made for.
 * A seat the company's directory retired has given its wallet up, so the
 * person who left can be seated again under a new leaf, with the same wallet,
 * and the directory then holds the new seat's entry. Every entry here is
 * signed by a real wallet.
 */
import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSigningKeypair, type Hex } from './crypto.js';
import { believedSigners, rosterEntryRefusal, seatsNotBelieved, seatsStaying, type RosterWitnesses } from './roster-record.js';
import type { Signer } from './types.js';
import { seatOpenedFor } from '../testing/directory-seats.js';

const CO = 'acc_left';
const LABEL = `co_${'c2'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'ad'.repeat(32) as AccountAddress;

/** `person`'s seat at the leaf made from `leaf`, held by the wallet made from `n`, and the roster entry naming it. */
const seatOf = (person: string, n: number, leaf: number) => {
  const identity = identityFromSecret(new Uint8Array(32).fill(n));
  const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
  const { seat } = seatOpenedFor(committeeKey, leaf);
  const signing = newSigningKeypair();
  const statement = signDirectoryEntry(identity, LABEL, ACCOUNT, new Uint8Array(32).fill(n + 100), signing.publicKey, seat);
  const signer: Signer = {
    id: `sgn_${person}_${leaf}`, leafCommitment: seat as Hex, userId: person, name: person, status: 'active',
    signingPublicKey: signing.publicKey, wrappingPublicKey: statement.wrappingKey as Hex, role: 'admin',
    directoryEntry: { committeeKey, statement },
  };
  return { seat, committeeKey, signing, signer };
};

/* Ada stays; Bo held a seat, was retired, and his own wallet is seated again under a new leaf. */
const ADA = seatOf('ada', 1, 1);
const BO_BEFORE = seatOf('bo', 2, 2);
const BO_AGAIN = seatOf('bo', 2, 22);

/** What a device holds the roster to: Bo's earlier seat in its directory retired or not, and his new seat's own entry there or not. */
const witnesses = (boRetired: boolean, againEntered = true): RosterWitnesses => ({
  accountId: CO, label: LABEL, account: ACCOUNT, seatsOnTheChain: [ADA.seat, BO_AGAIN.seat],
  directory: [
    { seat: ADA.seat, signingKey: ADA.signing.publicKey, committeeKey: ADA.committeeKey, retired: false, role: 'admin' as const, person: 'ada' },
    { seat: BO_BEFORE.seat, signingKey: BO_BEFORE.signing.publicKey, committeeKey: BO_BEFORE.committeeKey, retired: boRetired, role: 'admin' as const, person: 'bo' },
    ...(againEntered ? [{ seat: BO_AGAIN.seat, signingKey: BO_AGAIN.signing.publicKey, committeeKey: BO_AGAIN.committeeKey, retired: false, role: 'admin' as const, person: 'bo' }] : []),
  ],
});

describe('A WALLET WHOSE SEAT WAS RETIRED IS BELIEVED IN THE ROSTER UNDER ITS NEW SEAT', () => {
  /*
   * The directory itself refuses a second entry for a wallet a seat not retired holds (`key-taken`), so its entry for
   * the new seat is there only once the earlier one is retired. The roster keeps no copy of that rule.
   */
  it('THE SAME WALLET, SEATED AGAIN UNDER A NEW LEAF, IS BELIEVED AS ITS NEW SEAT\'S OWN DIRECTORY ENTRY PROVES IT', () => {
    /* RED WHEN: the roster holds a wallet to one seat by a copy of the directory's rule, so the wallet can never be seated again. */
    expect(rosterEntryRefusal(BO_AGAIN.signer, witnesses(true))).toBeNull();
    /* The leaver's own entry, not yet dropped from the roster, is for a seat the chain no longer holds. */
    expect(rosterEntryRefusal(BO_BEFORE.signer, witnesses(true))).toBe('seat-not-on-the-chain');
  });

  it('THE ENTRY THE WALLET SIGNED, KEPT BESIDE THE NEW SEAT, DOES NOT SEAT IT WITHOUT THE NEW SEAT\'S OWN DIRECTORY ENTRY', () => {
    /* RED WHEN: a kept entry's wallet is believed before the new seat's own opening proves it. */
    expect(rosterEntryRefusal(BO_AGAIN.signer, witnesses(true, false))).toBe('no-entry-of-their-own');
  });
});

describe('A SEAT AN ANCHORED RETIREMENT RETIRED HAS NO ROSTER ENTRY, AND IS NOT COUNTED, EVEN WHILE THE CHAIN STILL HOLDS IT', () => {
  /* Bo's first seat is retired by an anchored retirement; the chain has not taken his leaf off yet. */
  const stillHeld: RosterWitnesses = { ...witnesses(true, false), seatsOnTheChain: [ADA.seat, BO_BEFORE.seat], retired: [BO_BEFORE.seat] };

  it('THE RETIRED SEAT\'S ENTRY IS REFUSED FOR GOOD, AND THE ONE WHO STAYS IS BELIEVED', () => {
    /* RED WHEN: a retired seat's roster entry is still believed while the chain holds its leaf, so it stays a reader and a counted signer. */
    expect(rosterEntryRefusal(BO_BEFORE.signer, stillHeld)).toBe('seat-retired');
    expect(rosterEntryRefusal(ADA.signer, stillHeld)).toBeNull();
    expect(believedSigners([ADA.signer, BO_BEFORE.signer], stillHeld).believed.map((x) => x.id)).toEqual([ADA.signer.id]);
  });

  it('THE ROSTER IS COUNTED AGAINST THE SEATS THAT STAY, SO DROPPING THE RETIRED ENTRY LEAVES NO SIGNER OUT', () => {
    /* RED WHEN: the seat retired but still on the chain is counted, so a roster without its entry is refused as leaving a signer out. */
    expect(seatsStaying(stillHeld)).toEqual([ADA.seat]);
    expect(seatsNotBelieved([ADA.signer], seatsStaying(stillHeld))).toEqual([]);
    /* The control: with no retirement anchored, the same roster leaves Bo's seat out. */
    expect(seatsNotBelieved([ADA.signer], seatsStaying({ ...stillHeld, retired: [] }))).toEqual([BO_BEFORE.seat.toLowerCase()]);
  });
});
