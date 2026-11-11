/**
 * **A VERSION OF THE COMPANY'S CHOICE OF SERVICE FILED BY A SEAT WHOSE ROLE MAY NOT FILE IT IS PASSED OVER BY THE
 * READER, AND THE LAST VERSION A SEAT THAT MAY FILE IT FILED IS READ.** The reader is the real one
 * (`serviceVersionsFrom`, `serviceFromVersions`); the judge is a stand-in that gives the real check's own refusal for
 * a role that may not file (`FILING_REFUSAL`), as `judgeIn` gives it, and believes the other seats.
 */
import { describe, it, expect } from 'vitest';
import { newSigningKeypair, unwrapKey, type Hex } from '../../../../src/core/crypto.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import { OUR_SERVICE, openedWithTheCompanyKey, sealCompanyService, type CompanyService } from '../../../../src/midnight/company-service-record.js';
import { FILING_REFUSAL } from '../../../../src/midnight/seat-directory.js';
import { signCompanyFiling, type SealedCompanyRecord } from '../../../../src/midnight/sealed-record-wire.js';
import { serviceFromVersions, serviceVersionsFrom } from './company-reach.js';

const COMPANY = 'acc_choice';
const LEAF = 'ae'.repeat(32) as Hex;
const KEY0 = '0c'.repeat(32) as Hex;
const RECORDS = recordsKeypairFrom(new Uint8Array(32).fill(7));
const me = {
  signerId: LEAF, keyOf: (w: Parameters<typeof unwrapKey>[0]) => unwrapKey(w, RECORDS.secret as Hex) as Hex,
  companyCopy: openedWithTheCompanyKey(COMPANY, () => KEY0),
};
const signers = [{ id: LEAF, wrappingPublicKey: RECORDS.publicKey as Hex }];
const ADA = newSigningKeypair();
const BEA = newSigningKeypair();
/** A seat whose role may not file policy, such as an approver. */
const CYD = newSigningKeypair();
const OWN: CompanyService = { service: 'own', at: 'https://relay.example.com' };
const NONE: CompanyService = { service: 'none' };

const filed = (version: number, by: { secret: string }, choice: CompanyService): SealedCompanyRecord =>
  signCompanyFiling(sealCompanyService({ company: COMPANY, version, sealing: { key: KEY0, epoch: 0 }, choice, signers }), by.secret as Hex);
const judge = (filer: Hex | null): string | null => {
  if (filer === CYD.publicKey) return FILING_REFUSAL['role-may-not-file'];
  return filer !== null && (filer === ADA.publicKey || filer === BEA.publicKey) ? null : 'not a seat this device believes';
};
const doors = (served: SealedCompanyRecord[]) => ({
  company: COMPANY, judge, needed: 2, me, named: served.map((r) => r.version), withheld: null,
  seatedNow: () => true,
});
const read = (served: SealedCompanyRecord[]) => serviceFromVersions(served, doors(served));

describe('A VERSION FILED BY A SEAT THAT MAY NOT FILE IT IS PASSED OVER, NEVER THE REASON THE CHOICE READS UNREAD', () => {
  it('the newest version, filed by such a seat, is passed over and the earlier agreement is read', () => {
    /* RED WHEN: the newest version being one a role may not file leaves the company's choice of service unread. */
    expect(read([filed(1, ADA, OWN), filed(2, BEA, OWN), filed(3, CYD, NONE)])).toEqual({ choice: OWN });
  });

  it('a version in the middle, filed by such a seat, is passed over and the versions around it still agree', () => {
    /* RED WHEN: a named version a role may not file leaves the choice unread, though the seats that may file agree around it. */
    expect(read([filed(1, ADA, OWN), filed(2, CYD, NONE), filed(3, BEA, OWN)])).toEqual({ choice: OWN });
  });

  it('such a seat\'s version does not count toward the seats a choice needs', () => {
    /* RED WHEN: a seat that may not file the choice counts as one of the seats that agreed it. */
    expect(read([filed(1, ADA, OWN), filed(2, CYD, OWN)])).toMatchObject({ choice: OUR_SERVICE, unchosen: expect.stringMatching(/no choice of service has been filed by the 2 seats/u) });
    const served = [filed(1, ADA, OWN), filed(2, BEA, OWN), filed(3, CYD, NONE)];
    const counted = serviceVersionsFrom(served, doors(served));
    /* RED WHEN: the version passed over is counted, or the next version filed is not the one after it. */
    expect('unread' in counted ? [] : counted.versions.map((v) => v.version)).toEqual([1, 2]);
    expect('unread' in counted ? 0 : counted.highest).toBe(3);
  });

  it('a version no seat filed that the check refuses for another reason still leaves the choice unread', () => {
    const stranger = newSigningKeypair();
    /* RED WHEN: passing over a role's version also passes over a version a seat the directory does not hold filed. */
    expect(read([filed(1, ADA, OWN), filed(2, BEA, OWN), filed(3, stranger, NONE)])).toEqual({ unread: 'not a seat this device believes' });
  });
});
