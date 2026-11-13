/**
 * **A READER'S WALLET DECIDES THE READ GRANTS IN FORCE AS THE COMPANY'S DEVICES DO.** Over the versions sealed to the
 * reader, `inForceForAReader` must answer what `grantsInForceOf` answers over every version: two changes at one
 * sequence are decided by the first at the bar, whichever order they were filed in; a take-away the company counts only
 * by signers who have since left is in force for the reader too; a version it cannot open breaks the fold, and a grant
 * given again after it is judged at the bar on its own.
 */
import { describe, expect, it } from 'vitest';
import { newSymmetricKey, sign, signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import { purposeKey } from '../../../src/core/sealed-records.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { entriesInOrder, grantEntryOf, grantsInForceOf, grantsMessage, purposeWrapsFor, type GrantEntry, type Grants } from '../../../src/midnight/grants-record.js';
import type { DirectorySeat } from '../../../src/midnight/seat-directory.js';
import { inForceForAReader } from './purpose-wraps.js';

const CO = 'acc_reader_fold';
const seatOf = (n: number): { secret: Hex; seat: DirectorySeat } => {
  const secret = newSymmetricKey();
  return {
    secret,
    seat: {
      seat: n.toString(16).padStart(64, '0'), person: `p${n}`, signingKey: signingPublicKeyOf(secret).toLowerCase() as Hex,
      wrappingKey: 'ab'.repeat(32) as Hex, role: 'admin', retired: null, committeeKey: { tag: 'schnorr', value: n.toString(16).padStart(64, '0') },
    },
  };
};
const A = seatOf(1);
const B = seatOf(2);
const QUORUM = { seats: [A.seat, B.seat], held: () => true, bar: 2, newest: 0 };
const KEY = newSymmetricKey();
const RHEA = grantEntryOf({ recipient: recordsKeypairFrom(new Uint8Array(32).fill(5)).publicKey, person: 'rhea', role: 'limited' });
const ABE = grantEntryOf({ recipient: recordsKeypairFrom(new Uint8Array(32).fill(6)).publicKey, person: 'abe', role: 'limited' });

/** A version of the grants: `entries` at `sequence`, signed by `by`, each entry's keys wrapped to it. */
const version = (v: number, sequence: number, entries: readonly GrantEntry[], by: readonly { secret: Hex }[] = [A, B]) => {
  const ordered = entriesInOrder(entries);
  const message = grantsMessage(CO, { sequence, entries: ordered });
  const grants: Grants = {
    sequence, entries: ordered, signatures: by.map((s) => ({ publicKey: signingPublicKeyOf(s.secret).toLowerCase() as Hex, signature: sign(message, s.secret) })),
    wraps: purposeWrapsFor(ordered, (_e, purpose) => purposeKey(KEY, CO, purpose), 0),
  };
  return { version: v, keyEpoch: 0, grants };
};

describe('THE READER FOLDS THE GRANTS AS THE COMPANY DOES', () => {
  it('two changes at one sequence: the first at the bar decides, in either order they were filed', () => {
    const given = version(1, 1, [RHEA]);
    for (const [first, second] of [[[RHEA, ABE], []], [[], [RHEA, ABE]]] as const) {
      const all = [given, version(2, 2, first), version(3, 2, second)];
      const company = grantsInForceOf(CO, all, QUORUM).inForce;
      /* RED WHEN: the reader's wallet keeps the last of two changes at one sequence where the company keeps the first. */
      expect(inForceForAReader(CO, all, QUORUM)?.version).toBe(company?.version);
      expect(company?.version).toBe(2);
    }
  });

  it('a take-away the company counts only with a signer who has since left is in force for the reader too', () => {
    const C = seatOf(3);
    /* A has left: retired in the directory, off the chain. */
    const gone = { seats: [{ ...A.seat, retired: {} }, B.seat, C.seat], held: (s: DirectorySeat) => s.seat !== A.seat.seat, bar: 2, newest: 0 };
    const all = [version(1, 1, [RHEA, ABE], [B, C]), version(2, 2, [ABE], [A, B])];
    /* The company: a change that only narrows counts the signer who left. */
    expect(grantsInForceOf(CO, all, gone).inForce?.version).toBe(2);
    /* RED WHEN: the reader judges the take-away alone, below the bar, and keeps its old grant. */
    expect(inForceForAReader(CO, all, gone)?.version).toBe(2);
  });

  it('across a version it cannot open, a grant given again is judged at the bar on its own', () => {
    const opened = [version(1, 1, [RHEA]), version(2, 2, []), version(4, 4, [RHEA, ABE])];
    expect(inForceForAReader(CO, opened, QUORUM)?.version).toBe(4);
    /* RED WHEN: one seat alone gives a reader back across the gap. */
    expect(inForceForAReader(CO, [...opened.slice(0, 2), version(4, 4, [RHEA, ABE], [A])], QUORUM)?.version).toBe(2);
  });
});
