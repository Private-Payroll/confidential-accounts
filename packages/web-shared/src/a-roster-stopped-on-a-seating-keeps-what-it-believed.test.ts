import { describe, expect, it } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountAddress } from 'midnight-identity/profile/company-label';
import type { Account, Signer } from '../../../src/core/types.js';
import type { RosterWitnesses } from '../../../src/core/roster-record.js';
import { seatingRefusedHolding, seatingRefusedRead } from './roster-seating-refused.js';

/*
 * **A ROSTER READ THAT STOPS ON A SEAT IT CANNOT TELL AS ANY SEAT KEEPS WHAT IT BELIEVED**, so the removal of that
 * seat, the one change that clears the stop, can still be counted. What it keeps is judged entry by entry on each
 * signer's witnesses, as every believed read is; any other error carries nothing.
 */

const SEATS = ['a1', 'a2', 'a3'].map((x) => x.repeat(32));
const signer = (i: number, o: Partial<Signer> = {}): Signer => ({
  id: `s${i}`, name: ['Ada', 'Bo', 'Cy'][i]!, status: 'active', leafCommitment: SEATS[i]!, signingPublicKey: `0${i}`.repeat(32), userId: `usr_${i}`, ...o,
}) as Signer;
const witnesses: RosterWitnesses = {
  accountId: 'acc_1', label: drawCompanyLabel(), account: 'c0'.repeat(32) as AccountAddress, seatsOnTheChain: SEATS,
  /* Ada's seat has its own directory entry; Bo's has none, and Bo is not this device's own seat. */
  directory: [{ seat: SEATS[0]!, signingKey: '00'.repeat(32), committeeKey: { tag: 't', value: 'v' }, retired: false, role: null, person: 'usr_0' }],
  own: null,
};
const opened = { id: 'acc_1', name: 'Acme', signers: [signer(0), signer(1)] } as unknown as Account;

describe('A ROSTER READ STOPPED ON A SEAT IT CANNOT TELL KEEPS WHAT IT BELIEVED', () => {
  it('the stop carries the signers believed on their own witnesses, the entries refused, the seats left out and the seats it could not tell', () => {
    const stop = new Error('stops');
    /* RED WHEN: the stop handed in is not the one thrown, so what it carries is lost. */
    expect(seatingRefusedHolding(stop, { opened, witnesses, waited: new Set([SEATS[1]!]) }, [SEATS[2]!.toUpperCase()])).toBe(stop);
    const held = seatingRefusedRead(stop);
    /* RED WHEN: an entry with no directory entry of its own is kept as a believed signer, so it would count as an approver. */
    expect(held?.account.signers.map((x) => x.name)).toEqual(['Ada']);
    expect(held?.account.refused).toEqual([{ signerId: 's1', name: 'Bo', why: 'no-entry-of-their-own' }]);
    /* RED WHEN: a seat on the chain no believed signer names is not listed as left out, so a count would go ahead past it. */
    expect(held?.account.notBelieved).toEqual([SEATS[1], SEATS[2]]);
    expect(held?.account.waited).toEqual([SEATS[1]]);
    /* RED WHEN: the seats it could not tell are not kept, or not in lower case, so the removal of one is not recognised. */
    expect(held?.unread).toEqual([SEATS[2]]);
  });

  it('any other error, or nothing thrown at all, carries no read', () => {
    /* RED WHEN: a stop for any other reason is read as carrying signers to count a removal from. */
    expect([seatingRefusedRead(new Error('stops')), seatingRefusedRead(null), seatingRefusedRead('stops')]).toEqual([null, null, null]);
  });
});
