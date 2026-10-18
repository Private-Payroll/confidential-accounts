import { describe, it, expect } from 'vitest';
import { removeSignerOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import { judgeIn, type DirectoryHere } from 'vaults-web-shared/vault-page-doors.js';
import { anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import type { Hex } from '../core/crypto.js';
import { companyRecordKey } from '../midnight/seat-directory.js';
import type { RecordsAsked } from '../midnight/records-held.js';
import { aRecordFiledBy } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, anchorDoorsOf, aPolicyFiledBy, ADA, BO, CO, CY, deviceOf, directoryOf, KEY, store,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

/**
 * A signer who leaves is retired with the records-key statement their own wallet signed, or with none. Records the
 * company's anchor already holds are read the same either way; the statement decides only a version that is not yet
 * anchored. This file removes a signer with no statement, so the seat is one whose wallet is not attested, and reads
 * the leaver's anchored record and the same record taken as not yet anchored.
 */

aCompanyWhoseSignersChange();

const ASKED: RecordsAsked = { kinds: [{ store: 'company', kind: 'policy' }, { store: 'company', kind: 'spending-policy' }] };
const POLICY = 'pol_filed_by_cy';

describe('A RETIREMENT\'S RECORDS-KEY STATEMENT IS READ FOR VERSIONS NOT YET ANCHORED, AND FOR NO ANCHORED ONE', () => {
  it('A SIGNER RETIRED WITH NO STATEMENT HAS THEIR ANCHORED RECORD READ AS BEFORE, WHILE THE SAME VERSION TAKEN AS NOT YET ANCHORED IS REFUSED FOR THE MISSING STATEMENT', async () => {
    await CY.entered.enter([await aRecordFiledBy(CY, POLICY)]);
    expect((await anchorTheRecordsHere(anchorDoorsOf(CY))).anchored).toBeGreaterThan(0);
    expect(await aPolicyFiledBy(CY, [ADA, BO, CY])).toBe(1);
    const filedButNotAnchored = (await directoryOf(BO)(ASKED)).records.notYetAnchored.find((e) => e.kind === 'spending-policy')!;
    expect(filedButNotAnchored.filedBy.publicKey.toLowerCase()).toBe(CY.statement.signingKey.toLowerCase());

    const remove = { viewingKey: KEY, leaf: CY.seat, name: 'cy' };
    const withNoStatement = (s: typeof ADA) => ({ ...deviceOf(s), leaversStatement: async () => null });
    expect(await removeSignerOnDevice(withNoStatement(ADA), remove).catch((e: unknown) => e)).toMatchObject({ state: 'waiting-for-approvals' });
    expect(await removeSignerOnDevice(withNoStatement(BO), remove).catch((e: unknown) => e)).toMatchObject({ state: 'done' });

    const retirement = store.directoryFilingsOf(CO).at(-1)!;
    expect(retirement.change).toMatchObject({ kind: 'retire', seat: CY.seat });
    /* RED WHEN: a removal carries a statement the leaver's wallet did not sign, so this file no longer tests a seat retired with none. */
    expect((retirement.change as { statement?: unknown }).statement).toBeUndefined();

    const here: DirectoryHere = await directoryOf(BO)(ASKED);
    const cy = here.dir.seats.find((x) => x.seat === CY.seat)!;
    expect(cy.retired).not.toBeNull();
    expect(here.records.directory.has(retirement.version)).toBe(true);
    /* RED WHEN: a retired seat's wallet counts as attested without the statement its retirement carries, so the statement decides nothing. */
    expect(cy.retiredStatement).toBeUndefined();
    expect(here.another.has(CY.seat)).toBe(true);

    const filer = CY.statement.signingKey as Hex;
    const anchored = [...here.records.history.entries()].find(([k]) => k === `company:policy:${POLICY}`)![1][0]!;
    const readAnchored = { store: 'company', kind: 'policy', id: POLICY, digest: anchored.digest, version: anchored.version } as const;
    /* RED WHEN: an anchored record of a retired seat is refused for the records-key statement its retirement lacks, so a signer's leaving would unread everything they filed that the company's anchor holds. */
    expect(judgeIn(here)(filer, 'policy', companyRecordKey('policy', POLICY), readAnchored, true)).toBeNull();

    const spending = [...here.records.history.keys()].filter((k) => k.startsWith('company:spending-policy:'));
    expect(spending.length).toBe(1);
    const held = here.records.history.get(spending[0]!)![0]!;
    const readSpending = { store: 'company', kind: 'spending-policy', id: filedButNotAnchored.id, digest: held.digest, version: held.version } as const;
    expect(judgeIn(here)(filer, 'spending-policy', companyRecordKey('spending-policy', filedButNotAnchored.id), readSpending, true)).toBeNull();

    /* The same version, taken as entered and not yet anchored. */
    const notYet: DirectoryHere = {
      ...here, records: { ...here.records, history: new Map([...here.records.history].filter(([k]) => k !== spending[0])), notYetAnchored: [filedButNotAnchored] },
    };
    /* RED WHEN: a version of a retired seat that is not yet anchored is believed without the statement its retirement should carry, so a leaver's unanchored filing would be read as attested. */
    expect(judgeIn(notYet)(filer, 'spending-policy', companyRecordKey('spending-policy', filedButNotAnchored.id), readSpending, true))
      .toMatch(/has not attested the records key/u);
    /* RED WHEN: the statement is not what decides it: the same unanchored version is believed once the seat counts as attested. */
    const attested: DirectoryHere = { ...notYet, another: new Set() };
    expect(judgeIn(attested)(filer, 'spending-policy', companyRecordKey('spending-policy', filedButNotAnchored.id), readSpending, true)).toBeNull();
  }, 170_000);
});
