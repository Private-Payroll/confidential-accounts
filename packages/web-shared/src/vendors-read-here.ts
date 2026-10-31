/**
 * **A COMPANY'S VENDORS, READ ON THIS DEVICE WITH NO SEAT SECRET.** Every vendor the company's records name is read
 * over all its versions, each opened here with the company's key and believed only when a seat this device believes
 * filed it and the version names that seat as its maker. A believed vendor is payable only while every version names
 * the address the first was filed with, and, for an unshielded address they claimed, with their wallet's signed claim
 * of it checked where the ledger loads (`claimRefusal`). A page reads vendors through this alone; admitting or
 * changing one signs with a seat's key and is done in the wallet (`admitVendorHere`, `changeVendorHere`).
 */
import { keyOf, type KeysHeld } from '../../../src/core/company-key.js';
import { madeByRefusal, whyVendorNotPayable } from '../../../src/core/person-record.js';
import { openVendor, vendorVersionsRefusal, type VendorRecord } from '../../../src/core/vendor-record.js';
import type { NetworkName } from '../../../src/midnight/network.js';
import { fromCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import { readAddressClaim, typedAddressIsShielded } from 'midnight-identity/profile/address-claim';
import { judgeIn, kindAsked, namedHere, type DirectoryRead } from './vault-page-doors.js';
import { InvitationRefused, type InvitingCompany } from './invitation-on-device.js';
import { claimFor, type ClaimRefusal } from './people-read-here.js';

/** One vendor as this device read them: the newest version of their entry, and its version number. */
export interface VendorHere {
  readonly vendor: VendorRecord;
  readonly version: number;
  /**
   * Whether the service holds a hand-over waiting to be admitted for this vendor. Set only when the read was asked for it
   * (`readVendorsHere`'s `handedOver` option) and the vendor is pending with no code yet; absent when not asked, not pending, or
   * the service did not answer.
   */
  readonly handedOver?: boolean;
}

/** The vendors as this device read them: those it believes and would pay, those it does not believe, and those active and not payable, with why. */
export interface VendorsHere {
  readonly vendors: readonly VendorHere[];
  readonly notBelieved: readonly string[];
  readonly notPayable: readonly { readonly here: VendorHere; readonly why: string }[];
}

/** The service's answer as a body, or the refusal it gave when it did not answer `ok`. */
export const answered = (r: { status: number; body: unknown }, ok: number): Record<string, unknown> => {
  const b = (r.body ?? {}) as Record<string, unknown>;
  if (r.status !== ok) {
    throw new InvitationRefused(r.status, typeof b.refused === 'string' ? b.refused : null,
      typeof b.error === 'string' ? b.error : `the service answered ${r.status} and said nothing, so nothing is known to have been filed.`);
  }
  return b;
};
/** A path under the company on the service. */
export const at = (d: { readonly company: { readonly id: string } }, path: string) => `/api/accounts/${encodeURIComponent(d.company.id)}${path}`;

/**
 * What reading the company's vendors needs of a device, and no more: the company and the keys it holds, a way to send
 * reads to the service, the company's records as this device believes them, the network addresses are read on, and
 * where a wallet's signed claim of an address is checked. A seat's device passes itself (`PeopleDevice`); a page, or a
 * wallet that only checks a payment against a vendor, passes this.
 */
interface VendorsReader {
  readonly company: Pick<InvitingCompany, 'id' | 'label' | 'viewingKey'>;
  readonly send: (path: string, init: { readonly method: 'GET' }) => Promise<{ readonly status: number; readonly body: unknown }>;
  readonly directory: DirectoryRead;
  readonly network: NetworkName;
  readonly claimRefusal: ClaimRefusal;
}

/** Every version of the vendor `id` the service gives, oldest first, each read as the record it says it is. */
async function versionsOf(d: VendorsReader, id: string): Promise<SealedCompanyRecord[]> {
  const b = answered(await d.send(at(d, `/records/vendor/${encodeURIComponent(id)}/versions`), { method: 'GET' }), 200);
  if (!Array.isArray(b.versions)) throw new Error('the service did not send the vendor\'s versions');
  return b.versions.map((w) => fromCompanyWire(w, { company: d.company.id, kind: 'vendor', id }).sealed);
}

/**
 * Every version of a vendor opened here, oldest first, or null when any is not believed: each must be the next
 * version, filed by a seat the company's records hold as filing it, and name that seat as its maker.
 */
export async function believedVersionsOf(d: VendorsReader, id: string, judge: ReturnType<typeof judgeIn>): Promise<VendorRecord[] | null> {
  let recs: SealedCompanyRecord[];
  try { recs = await versionsOf(d, id); } catch { return null; }
  if (recs.length === 0) return null;
  const opened: VendorRecord[] = [];
  for (const [i, rec] of recs.entries()) {
    const filer = verifiedCompanyFiler(rec);
    if (rec.version !== i + 1
      || judge(filer, 'vendor', companyRecordKey('vendor', id), companyRecordEntry(rec), i === recs.length - 1, rec.keyEpoch) !== null) return null;
    let v: VendorRecord;
    try { v = openVendor(rec, keyOf(d.company.viewingKey, rec.keyEpoch)); } catch { return null; }
    if (madeByRefusal(v, filer) !== null) return null;
    opened.push(v);
  }
  return opened;
}

/** Why the wallet's claim of the unshielded address a vendor was added by is refused, or null when there is none to check or it holds. */
const claimRefusalHere = async (d: VendorsReader, v: VendorRecord): Promise<string | null> => {
  const typed = v.invitedAddress ?? null;
  if (typed === null || typedAddressIsShielded(typed) || (v.payeeCode ?? null) === null) return null;
  const claim = readAddressClaim(v.addressClaim)!;
  const refused = await d.claimRefusal(claim, claimFor(d, v, v.wrappingPublicKey ?? ''));
  return refused === null ? null : `their claim of the address they were added by is refused: ${refused}`;
};

/**
 * Why an active vendor is not paid, or null: the payable check for vendors (`whyVendorNotPayable`, dated when `period` is given),
 * their address across their versions (`vendorVersionsRefusal`), and, once they claimed an unshielded typed address,
 * their wallet's claim of it, whose signature is checked by the reader's `claimRefusal`.
 */
const vendorNotPayableHere = async (d: VendorsReader, versions: readonly VendorRecord[], period?: string): Promise<string | null> => {
  const v = versions.at(-1)!;
  return whyVendorNotPayable(v, d.company.label, period) ?? vendorVersionsRefusal(versions) ?? await claimRefusalHere(d, v);
};

/**
 * Why a vendor who is pending or has left has no address of record, or null: the same rules fix their address as an
 * active vendor's - their address across their versions (`vendorVersionsRefusal`), and, when their record names an
 * address, the address they were added by or their own wallet's signed code for it, its keys and their wallet's claim
 * (`whyVendorNotPayable` with their standing and dates aside). A vendor with no address yet has none to check.
 */
const addressOfRecordRefusalHere = async (d: VendorsReader, versions: readonly VendorRecord[]): Promise<string | null> => {
  const v = versions.at(-1)!;
  const why = vendorVersionsRefusal(versions);
  if (why !== null || v.address === null) return why;
  return whyVendorNotPayable({ ...v, status: 'active' }, d.company.label) ?? await claimRefusalHere(d, v);
};

/** Whether the service holds a hand-over for this vendor (one GET); undefined when it did not answer. */
async function handoverWaitsHere(d: VendorsReader, id: string): Promise<boolean | undefined> {
  try {
    return answered(await d.send(at(d, `/vendors/${encodeURIComponent(id)}/handover`), { method: 'GET' }), 200).inbox != null;
  } catch {
    return undefined;
  }
}

/**
 * **EVERY VENDOR ON THE COMPANY'S VENDOR LIST, OPENED HERE.** The vendors are the ones the company's records name;
 * each is read over all its versions. One whose versions the service did not give, or any version of which this
 * device does not believe, is named in `notBelieved`. An active one who is not payable, whoever filed them, is named
 * in `notPayable` with why; so is one who is pending or has left whose address is not their address of record
 * (`addressOfRecordRefusalHere`), so nothing ever pays them at an address the rules do not fix. Given a period, a
 * vendor outside their dates for all of it is not payable either. Given `handedOver`, each pending vendor with no code
 * is also asked of the service whether a hand-over waits (one GET each); callers that do not ask send nothing more.
 */
export async function readVendorsHere(d: VendorsReader, period?: string, options?: { readonly handedOver?: boolean }): Promise<VendorsHere> {
  const here = await d.directory(kindAsked('company', 'vendor'));
  const judge = judgeIn(here);
  const vendors: VendorHere[] = [];
  const notBelieved: string[] = [];
  const notPayable: { here: VendorHere; why: string }[] = [];
  for (const id of namedHere(here, 'company', 'vendor')) {
    const versions = await believedVersionsOf(d, id, judge);
    if (versions === null) { notBelieved.push(id); continue; }
    const vendor = versions.at(-1)!;
    const waiting = options?.handedOver === true && vendor.status === 'pending' && (vendor.payeeCode ?? null) === null
      ? await handoverWaitsHere(d, id) : undefined;
    const one: VendorHere = { vendor, version: versions.length, ...(waiting === undefined ? {} : { handedOver: waiting }) };
    const why = vendor.status === 'active' ? await vendorNotPayableHere(d, versions, period) : await addressOfRecordRefusalHere(d, versions);
    if (why !== null) { notPayable.push({ here: one, why }); continue; }
    vendors.push(one);
  }
  return { vendors, notBelieved, notPayable };
}

/**
 * `readVendorsHere` for a reader that holds the company's keys as `keys`, as the doors that read one-offs do
 * (`OneOffsHere.keys`): a wallet checking a payment against a vendor, which opens their entries with the company's
 * key it already holds and sends nothing of it anywhere.
 */
export const readVendorsWithKeys = (
  company: Pick<InvitingCompany, 'id' | 'label'>, keys: KeysHeld, reads: Omit<VendorsReader, 'company'>, period?: string, options?: { readonly handedOver?: boolean },
): Promise<VendorsHere> => readVendorsHere({ ...reads, company: { ...company, viewingKey: keys } }, period, options);
