/**
 * **A COMPANY RECORD CARRIES ITS FILER'S OWN ENTRY IN THE COMPANY'S RECORDS.**
 * The seat filing a version signs the record and its entry together
 * (`signedWithItsEntry`), and the entry travels inside the record, outside what
 * the filing signature covers. The service keeps a version only when the entry
 * it carries is its own filer's signature over exactly that version, and any
 * seat's device can then enter a version whose entry never reached the
 * company's records. Nothing here trusts the service: the check is made on the
 * record's own bytes and signatures.
 */
import { companyRecordEntry, manifestEntryRefusal } from './record-manifest.js';
import { verifiedCompanyFiler, type SealedCompanyRecord } from './sealed-record-wire.js';

/**
 * Why the entry a record carries may not be entered for it, or null when it is
 * the record's own filer's signature, for this company, over exactly this
 * version's bytes. A record carrying no entry is refused here too: there is
 * nothing a device could enter for it.
 */
export const carriedEntryRefusal = (rec: SealedCompanyRecord): string | null => {
  const e = rec.entry;
  if (e === undefined) return 'it carries no entry in the company\'s records';
  const why = manifestEntryRefusal(rec.company, e);
  if (why !== null) return `the entry it carries is not one: ${why}`;
  const own = companyRecordEntry(rec);
  if (e.store !== own.store || e.kind !== own.kind || e.id !== own.id || e.version !== own.version || e.digest !== own.digest) {
    return 'the entry it carries names another record, another version or other bytes';
  }
  const filer = verifiedCompanyFiler(rec);
  if (filer === null || e.filedBy.publicKey.toLowerCase() !== filer.toLowerCase()) {
    return 'the entry it carries is not signed by the seat that filed it';
  }
  return null;
};
