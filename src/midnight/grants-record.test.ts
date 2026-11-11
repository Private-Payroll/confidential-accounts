/**
 * **THE READ GRANTS RECORD, JUDGED VERSION BY VERSION.** A change counts once seats at the seat bar signed it, one
 * wallet one vote; changes follow one another in order, and an older change filed again is not believed; a version
 * wraps each entry's purposes for every key epoch up to its own, to exactly the entries signed; a taking-away names
 * the key epoch it was filed at. Pure: no service, no chain.
 */
import { describe, expect, it } from 'vitest';
import { newSymmetricKey, sign, signingPublicKeyOf, type Hex } from '../core/crypto.js';
import { purposeKey } from '../core/sealed-records.js';
import { recordsKeypairFrom } from './company-nonce-secret.js';
import {
  entriesInOrder, grantEntryOf, grantsChangeRefusal, grantsInForceOf, grantsMessage, openGrants, purposeWrapsFor, readerIdOf,
  sealGrants, takesAway, wrapsRefusal, type GrantEntry, type Grants,
} from './grants-record.js';
import type { DirectorySeat } from './seat-directory.js';

const CO = 'acc_grants';
/** A seat of the directory: its filing key, and the wallet its committee key names. */
const seatOf = (n: number, wallet = n): { secret: Hex; seat: DirectorySeat } => {
  const secret = newSymmetricKey();
  return {
    secret,
    seat: {
      seat: n.toString(16).padStart(64, '0'), person: `p${n}`, signingKey: signingPublicKeyOf(secret).toLowerCase() as Hex,
      wrappingKey: 'ab'.repeat(32) as Hex, role: 'admin', retired: null, committeeKey: { tag: 'schnorr', value: wallet.toString(16).padStart(64, '0') },
    },
  };
};
const A = seatOf(1);
const B = seatOf(2);
const B_SAME_WALLET = seatOf(3, 2);
const SEATS = [A.seat, B.seat, B_SAME_WALLET.seat];
const QUORUM = { seats: SEATS, held: () => true, bar: 2, newest: 1 };
const reader = (fill: number) => recordsKeypairFrom(new Uint8Array(32).fill(fill));
const RHEA = reader(5);
const ABE = reader(6);
const KEYS = [newSymmetricKey(), newSymmetricKey()];
const keyAt = (epoch: number, purpose: Parameters<typeof purposeKey>[2]) => purposeKey(KEYS[epoch]!, CO, purpose);

/** A version of the grants: `entries` at `sequence`, signed by `by`, its keys wrapped up to `keyEpoch` to `wrapped` (every entry, unless given). */
const version = (
  v: number, sequence: number, entries: readonly GrantEntry[], by: readonly { secret: Hex }[], keyEpoch = 0, wrapped?: readonly GrantEntry[],
) => {
  const ordered = entriesInOrder(entries);
  const message = grantsMessage(CO, { sequence, entries: ordered });
  const grants: Grants = {
    sequence, entries: ordered, signatures: by.map((s) => ({ publicKey: signingPublicKeyOf(s.secret).toLowerCase() as Hex, signature: sign(message, s.secret) })),
    wraps: purposeWrapsFor(wrapped ?? ordered, keyAt, keyEpoch),
  };
  return { version: v, keyEpoch, grants };
};
const limited = (r: typeof RHEA, person: string) => grantEntryOf({ recipient: r.publicKey, person, role: 'limited' });

describe('THE READ GRANTS IN FORCE', () => {
  it('a change counts at the seat bar, one wallet one vote, and a change gathering signatures waits', () => {
    const one = version(1, 1, [limited(RHEA, 'r1')], [A], 0, []);
    /* RED WHEN: a change one seat signed is in force below the bar. */
    expect(grantsInForceOf(CO, [one], QUORUM)).toMatchObject({ inForce: null, waiting: { version: 1 } });
    /* RED WHEN: two seats of one wallet count twice. */
    expect(grantsInForceOf(CO, [version(1, 1, [limited(RHEA, 'r1')], [B, B_SAME_WALLET], 0, [])], QUORUM).inForce).toBeNull();
    /* RED WHEN: a retired seat, or one the chain no longer holds, counts. */
    expect(grantsInForceOf(CO, [version(1, 1, [limited(RHEA, 'r1')], [A, B], 0, [])], { ...QUORUM, held: (s) => s.seat !== B.seat.seat }).inForce).toBeNull();
    const both = version(2, 1, [limited(RHEA, 'r1')], [A, B]);
    expect(grantsInForceOf(CO, [one, both], QUORUM)).toMatchObject({ inForce: { version: 2 }, waiting: null, revokedAt: null });
  });

  it('a version below the bar wraps no key to a recipient the quorum has not agreed to, and is never sealed to it', () => {
    const first = version(1, 1, [limited(RHEA, 'r1')], [A, B]);
    /* RED WHEN: a change one signer asked for carries the new recipient's purpose keys before the quorum agrees. */
    const early = version(2, 2, [limited(RHEA, 'r1'), limited(ABE, 'r2')], [A]);
    expect(grantsInForceOf(CO, [first, early], QUORUM)).toMatchObject({ waiting: null, refused: new Map([[2, 'wraps-not-the-entries']]) });
    const waits = version(2, 2, [limited(RHEA, 'r1'), limited(ABE, 'r2')], [A], 0, [limited(RHEA, 'r1')]);
    expect(grantsInForceOf(CO, [first, waits], QUORUM)).toMatchObject({ inForce: { version: 1 }, waiting: { version: 2 } });
    const rec = sealGrants({ company: CO, version: 2, keyEpoch: 0, grants: waits.grants, seats: [] });
    expect(rec.wrapped.map((w) => w.signerId)).toEqual([readerIdOf(RHEA.publicKey)]);
    /* The signer whose signature reaches the bar wraps the new recipient's keys. */
    const reached = version(3, 2, [limited(RHEA, 'r1'), limited(ABE, 'r2')], [A, B]);
    expect(grantsInForceOf(CO, [first, waits, reached], QUORUM)).toMatchObject({ inForce: { version: 3 }, waiting: null });
  });

  it('a version names no key epoch the directory has not reached', () => {
    const first = version(1, 1, [limited(RHEA, 'r1')], [A, B]);
    /* RED WHEN: a signer files the grants again at a key epoch the company never reached, freezing every later change. */
    const inflated = version(2, 1, [limited(RHEA, 'r1')], [A, B], 1);
    expect(grantsInForceOf(CO, [first, inflated], { ...QUORUM, newest: 0 })).toMatchObject({ inForce: { version: 1 }, refused: new Map([[2, 'epoch-not-reached']]) });
    expect(grantsInForceOf(CO, [first, inflated], QUORUM).inForce?.version).toBe(2);
  });

  it('changes follow in order: the next one or the one in force wrapped again; an older change filed again is not believed', () => {
    const first = version(1, 1, [limited(RHEA, 'r1')], [A, B]);
    const second = version(2, 2, [limited(RHEA, 'r1'), limited(ABE, 'r2')], [A, B]);
    const takenAway = version(3, 3, [limited(ABE, 'r2')], [A, B]);
    /* An older change, still carrying its signers' signatures, filed again by a seat. */
    const replayed = { ...first, version: 4 };
    const judged = grantsInForceOf(CO, [first, second, takenAway, replayed], QUORUM);
    /* RED WHEN: a signed change from before is believed again, giving back a grant the signers took away. */
    expect(judged.inForce?.version).toBe(3);
    expect(judged.refused.get(4)).toBe('not-the-next-change');
    /* RED WHEN: a taking-away names no key epoch, so no device knows the key is owed a change. */
    expect(judged.revokedAt).toBe(0);
    /* The change in force wrapped again at a later key epoch is believed; at an earlier one it is not. */
    const again = version(5, 3, [limited(ABE, 'r2')], [A, B], 1);
    expect(grantsInForceOf(CO, [first, second, takenAway, again], QUORUM).inForce).toMatchObject({ version: 5, keyEpoch: 1 });
    const back = version(6, 3, [limited(ABE, 'r2')], [A, B], 0);
    expect(grantsInForceOf(CO, [first, second, takenAway, again, back], QUORUM).refused.get(6)).toBe('not-the-next-change');
    /* A device that opens only later versions, as a reader does, starts from the first it opens. */
    expect(grantsInForceOf(CO, [{ ...first, grants: null }, second], QUORUM)).toMatchObject({ inForce: { version: 2 } });
  });

  it('a version the records anchored is counted as they anchored it: a signer of a taking-away removed later never brings the reader back', () => {
    const C = seatOf(4);
    const asAnchored = { seats: [...SEATS, C.seat], held: () => true, bar: 2 };
    /* Today A has left: retired in the directory, off the chain, and the bar is three. */
    const today = {
      seats: [{ ...A.seat, retired: {} }, B.seat, B_SAME_WALLET.seat, C.seat], held: (s: DirectorySeat) => s.seat !== A.seat.seat, bar: 3, newest: 1,
    };
    const granted = version(1, 1, [limited(RHEA, 'r1')], [B, C]);
    const takenAway = version(2, 2, [], [A, B]);
    const anchored = grantsInForceOf(CO, [granted, takenAway], { ...today, asAnchored: () => asAnchored });
    /* RED WHEN: a version the records anchored is counted against today's seats and bar, so the reader taken away is in force again. */
    expect(anchored).toMatchObject({ inForce: { version: 2, grants: { entries: [] } }, revokedAt: 0 });
    /* A version not yet anchored is counted against who holds the account now: a grant A signed before leaving does not count A. */
    const givesAbe = version(2, 2, [limited(RHEA, 'r1'), limited(ABE, 'r2')], [A, B]);
    const notYet = grantsInForceOf(CO, [granted, givesAbe], { ...today, bar: 2, asAnchored: (v) => (v === 1 ? asAnchored : undefined) });
    /* RED WHEN: a grant not yet anchored counts a seat that has left, so a reader is let in without the signers who stay. */
    expect(notYet.inForce?.version).toBe(1);
  });

  it('a taking-away whose signer is removed before or with its anchoring stays in force: the reader it took away never comes back', () => {
    const C = seatOf(4);
    const granted = version(1, 1, [limited(RHEA, 'r1'), limited(ABE, 'r2')], [B, C]);
    const takenAway = version(2, 2, [limited(ABE, 'r2')], [A, B]);
    /* A was removed: retired in the directory, off the chain. */
    const gone = { seats: [{ ...A.seat, retired: {} }, B.seat, B_SAME_WALLET.seat, C.seat], held: (s: DirectorySeat) => s.seat !== A.seat.seat, bar: 2, newest: 1 };
    /* RED WHEN: a taking-away not yet anchored when its signer was removed is counted without that signer, and Rhea is in force again. */
    expect(grantsInForceOf(CO, [granted, takenAway], gone)).toMatchObject({ inForce: { version: 2, grants: { entries: [{ person: 'r2' }] } }, revokedAt: 0 });
    /* RED WHEN: anchored in the same batch as A's retirement, it is counted at a directory that holds A retired, and Rhea is back. */
    expect(grantsInForceOf(CO, [granted, takenAway], { ...gone, asAnchored: (v) => (v === 2 ? gone : undefined) }).inForce?.version).toBe(2);
    /* A change that only narrows still needs the bar: one signature, of a seat that has left, takes nothing away. */
    const alone = version(2, 2, [limited(ABE, 'r2')], [A]);
    expect(grantsInForceOf(CO, [granted, alone], gone)).toMatchObject({ inForce: { version: 1 }, refused: new Map([[2, 'below-quorum']]) });
    /* RED WHEN: a change that gives anything is counted with a seat that has left, so a leaver lets a reader in. */
    const widens = version(2, 2, [limited(RHEA, 'r1'), { ...limited(ABE, 'r2'), purposes: ['roster', 'policy', 'proposals', 'people'] }], [A, B]);
    expect(grantsInForceOf(CO, [granted, widens], gone).inForce?.version).toBe(1);
  });

  it('a version is held to its one shape and to wraps of exactly its entries, for every key epoch up to its own', () => {
    const good = version(1, 1, [limited(RHEA, 'r1')], [A, B], 1);
    expect(wrapsRefusal(good.grants, 1)).toBeNull();
    /* RED WHEN: a version leaves an epoch unwrapped, or wraps a reader the signers did not sign. */
    expect(wrapsRefusal(good.grants, 2)).toBe('wraps-not-the-entries');
    expect(wrapsRefusal({ ...good.grants, wraps: { ...good.grants.wraps, [readerIdOf(ABE.publicKey)]: [] } }, 1)).toBe('wraps-not-the-entries');
    /* RED WHEN: an entry carries a purpose no reader role reads, one purpose twice or none, or entries are out of order or name one person twice. */
    expect(grantsChangeRefusal({ sequence: 1, entries: [{ ...limited(RHEA, 'r1'), purposes: ['roster', 'vaults'] }] })).toBe('not-grants');
    expect(grantsChangeRefusal({ sequence: 1, entries: [{ ...limited(RHEA, 'r1'), purposes: ['roster', 'roster'] }] })).toBe('not-grants');
    expect(grantsChangeRefusal({ sequence: 1, entries: [{ ...limited(RHEA, 'r1'), purposes: [] }] })).toBe('not-grants');
    /* RED WHEN: an entry is judged against what its role reads today, so changing what a role reads unbelieves every grant already filed. */
    expect(grantsChangeRefusal({ sequence: 1, entries: [{ ...limited(RHEA, 'r1'), purposes: ['roster', 'policy'] }] })).toBeNull();
    expect(grantsChangeRefusal({ sequence: 1, entries: [{ ...limited(RHEA, 'r1'), purposes: ['roster', 'policy', 'proposals', 'people'] }] })).toBeNull();
    const twoEntries = entriesInOrder([limited(RHEA, 'r1'), limited(ABE, 'r2')]);
    expect(grantsChangeRefusal({ sequence: 1, entries: [...twoEntries].reverse() })).toBe('not-grants');
    expect(grantsChangeRefusal({ sequence: 1, entries: entriesInOrder([limited(RHEA, 'same'), limited(ABE, 'same')]) })).toBe('not-grants');
    expect(grantsChangeRefusal({ sequence: 1, entries: twoEntries })).toBeNull();
  });

  it('a version opens for every seat and reader it is sealed to and nobody else, and a taking-away is a lost entry or a lost purpose', () => {
    const v = version(1, 1, [limited(RHEA, 'r1')], [A, B]);
    const rec = sealGrants({ company: CO, version: 1, keyEpoch: 0, grants: v.grants, seats: [{ id: A.seat.seat, wrappingPublicKey: reader(9).publicKey }] });
    expect(openGrants(rec, { signerId: readerIdOf(RHEA.publicKey), wrappingSecret: RHEA.secret })?.sequence).toBe(1);
    expect(openGrants(rec, { signerId: A.seat.seat, wrappingSecret: reader(9).secret })?.sequence).toBe(1);
    /* RED WHEN: a reader the version is not sealed to opens it. */
    expect(openGrants(rec, { signerId: readerIdOf(ABE.publicKey), wrappingSecret: ABE.secret })).toBeNull();
    expect(takesAway([limited(RHEA, 'r1')], [])).toBe(true);
    expect(takesAway([grantEntryOf({ recipient: RHEA.publicKey, person: 'r1', role: 'accountant' })], [limited(RHEA, 'r1')])).toBe(true);
    expect(takesAway([limited(RHEA, 'r1')], [grantEntryOf({ recipient: RHEA.publicKey, person: 'r1', role: 'accountant' })])).toBe(false);
  });
});
