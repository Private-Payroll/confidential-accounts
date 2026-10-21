/**
 * **A ROSTER FILED AGAIN BEFORE THE COMPANY'S FIRST ANCHOR GOES IN AFTER ITS
 * FOUNDING RECORDS.** The first anchor must hold the company's first state and
 * first roster, entered by the founding seat; a later roster entered alone
 * before that anchor would leave them below it. So while nothing is anchored,
 * a roster filed from the founding seat's device is entered with them first.
 */
import { describe, expect, it } from 'vitest';
import { withTheFoundingFirst } from './roster-here.js';
import { sealRoster } from '../../../src/core/roster-record.js';
import { signedFoundingState } from '../../../src/core/founding-state.js';
import { newStateBlinding, sealState } from '../../../src/core/account.js';
import { newSigningKeypair, newSymmetricKey, type Hex } from '../../../src/core/crypto.js';
import { companyWirePaths, signCompanyFiling, toCompanyWire, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';

const CO = 'acc_founded_here';
const KEY = newSymmetricKey();
const FOUNDER = newSigningKeypair();
const ANOTHER = newSigningKeypair();
const rosterBy = (secret: Hex, version: number): SealedCompanyRecord => signCompanyFiling(sealRoster(CO, {
  name: 'Acme', signers: [{ id: 'sig_one', leafCommitment: 'cd'.repeat(32), userId: 'one', name: 'one', status: 'active', signingPublicKey: 'ef'.repeat(32), wrappingPublicKey: 'ab'.repeat(32), role: 'admin' } as never],
}, version, 0, KEY), secret);
const stateBy = (secret: Hex) => signedFoundingState(CO, sealState({ entries: [] }, newStateBlinding(), KEY, 0), secret);

/** The service as a device asks it for a company's first state and first roster. */
const serving = (kept: readonly SealedCompanyRecord[]) => async (path: string): Promise<unknown> => {
  const rec = kept.find((r) => path === companyWirePaths.one(CO, r.kind as never, r.id, 1));
  return { filed: rec === undefined ? null : toCompanyWire(rec) };
};

describe('A ROSTER FILED BEFORE THE FIRST ANCHOR', () => {
  const third = companyRecordEntry(rosterBy(FOUNDER.secret, 3));

  it('goes in after the company\'s first state and first roster while nothing is anchored, from the seat that founded it', async () => {
    const state = stateBy(FOUNDER.secret);
    const first = rosterBy(FOUNDER.secret, 1);
    const d = { api: serving([state, first]), accountId: CO, signingSecret: FOUNDER.secret };
    /* RED WHEN: a later roster is entered alone before the first anchor, leaving the founding roster below it for good. */
    expect(await withTheFoundingFirst(d, true, third)).toEqual([companyRecordEntry(state), companyRecordEntry(first), third]);
    /* RED WHEN: the founding records go in again with every roster filed once the company is anchored. */
    expect(await withTheFoundingFirst(d, false, third)).toEqual([third]);
  });

  it('goes in alone from a seat that did not found the company, and when nothing was founded with it', async () => {
    const d = { api: serving([stateBy(ANOTHER.secret), rosterBy(ANOTHER.secret, 1)]), accountId: CO, signingSecret: FOUNDER.secret };
    /* RED WHEN: a seat enters records another seat founded the company with - the service refuses the whole entry. */
    expect(await withTheFoundingFirst(d, true, third)).toEqual([third]);
    expect(await withTheFoundingFirst({ ...d, api: serving([]) }, true, third)).toEqual([third]);
  });

  it('goes in alone when the founding records cannot be read, so the version filed is still entered', async () => {
    const d = { api: async () => { throw Object.assign(new Error('the service did not answer'), { status: 503 }); }, accountId: CO, signingSecret: FOUNDER.secret };
    /* RED WHEN: a read of the founding records that fails leaves the roster just filed out of the company's records, with the service's refusal shown. */
    expect(await withTheFoundingFirst(d, true, third)).toEqual([third]);
  });
});
