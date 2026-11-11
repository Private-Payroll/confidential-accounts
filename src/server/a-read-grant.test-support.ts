/**
 * **READERS AND THE SIGNERS' WALLETS THAT GRANT THEM, IN THE COMPANY WHOSE SIGNERS CHANGE.** Two readers' devices, each
 * with the records key its wallet released for Acme; and what a seat's wallet files a change of the read grants and a
 * spending policy through, as `a-company-whose-signers-change-on-the-chain.test-support.ts` holds the company.
 */
import type { Hex } from '../core/crypto.js';
import { recordsKeypairFrom } from '../midnight/company-nonce-secret.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import type { SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { companyKeyHere } from 'vaults-web-shared/company-key-here.js';
import { HttpCompanyRecordStore } from 'vaults-web-shared/http-sealed-pool-store.js';
import { readerKeysHere, type PurposeWrapsHeld } from 'vaults-web-shared/purpose-wraps.js';
import type { GrantsFilingDoors } from 'vaults-web-shared/grants-filed-here.js';
import { directoryHere, judgeIn, readersIn } from 'vaults-web-shared/vault-page-doors.js';
import type { CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import { acmeDirectoryDeps } from './a-company-of-two-seats.test-support.js';
import {
  ADA, BO, CO, companyKeyDoorsOf, CY, deviceOf, directoryOf, grantsKept, recordsSecretOf, sendAs, type Seat,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

/** One version filed by `s`'s device through the service and entered under its key. */
const filedBy = async (s: Seat, rec: SealedCompanyRecord): Promise<void> => {
  await new HttpCompanyRecordStore(CO, sendAs(s.person), s.signingSecret as Hex, async () => judgeIn(await directoryOf(s)())).put(rec);
  await s.entered.enter([companyRecordEntry(rec)]);
};

/** A reader's device: the key its wallet released for Acme, and the records key the grants wrap its purpose keys to. */
export const readerOf = (fill: number, person: string) => {
  const pair = recordsKeypairFrom(new Uint8Array(32).fill(fill));
  return { person, recipient: pair.publicKey.toLowerCase() as Hex, wrappingSecret: pair.secret.toLowerCase() as Hex };
};
export const RHEA = readerOf(77, 'rhea');
export const ABE = readerOf(78, 'abe');

/** `s`'s company keys, as its device finds them. */
export const keysOf = (s: Seat) => companyKeyHere({ ...companyKeyDoorsOf(s), accountId: CO, material: { signingSecret: s.signingSecret }, records: deviceOf(s).records! });

/** What `s`'s wallet files a change of the grants through: the grants as the service keeps them, its keys, the seats it believes, and its filing. */
export const grantsDoorsOf = async (s: Seat): Promise<GrantsFilingDoors> => ({
  accountId: CO, versions: grantsKept, directory: directoryOf(s), me: { signerId: s.seat, wrappingSecret: recordsSecretOf(s) },
  signingSecret: s.signingSecret as Hex, keys: await keysOf(s), seats: () => readersIn(directoryOf(s)).signers(),
  file: async (rec) => {
    await filedBy(s, rec);
  },
});

/** The reader's purpose keys as its own device reads them, the directory opened with the roster key its newest grant wraps. */
export const readerKeys = (r: typeof RHEA): Promise<PurposeWrapsHeld | null> => readerKeysHere({
  accountId: CO, versions: grantsKept, me: r,
  directoryFor: (held) => (asked) => directoryHere({ ...acmeDirectoryDeps([ADA, BO, CY]), viewingKey: held }, asked),
});

/** The company records `s`'s device reseals a policy through: read as its seat, with the policy readers it believes, filed and entered under its key. */
export const policyFilingOf = async (s: Seat): Promise<CompanyRecordsHere> => {
  const records = deviceOf(s).records as CompanyRecordsHere;
  return {
    ...records,
    spendingPolicies: {
      ...records.spendingPolicies!,
      file: (rec: SealedCompanyRecord) => filedBy(s, rec),
    },
  };
};
