/**
 * **A COMPANY'S VENDORS, READ AND CHANGED ON A SEAT'S OWN DEVICE.** Each step is one function a screen can call.
 * Vendors, contractors included, are a list of their own: never read with the people on the payroll, sealed under
 * the company's vendors key, and paid by the vendors' side of the one payable check (`whyVendorNotPayable`).
 *
 *   · **reading** (`readVendorsHere`): every vendor the company's records name, each version opened here and
 *     believed only when a seat this device believes filed it and the version names that seat as its maker; payable
 *     only while every version names the address the first was filed with, the wallet that handed one over stays the
 *     same, an address moves only with a new code from that wallet (`vendorVersionsRefusal`), and, for an unshielded
 *     typed address they claimed, with their wallet's signed claim of it checked here;
 *   · **admitting** (`admitVendorHere`): what the vendor's own wallet handed over, checked here as a person's is
 *     (`payeeCodeHandedOver`): by link or by a shielded address on the fingerprint read out, by an unshielded address
 *     on the wallet's signed claim;
 *   · **a change** (`changeVendorHere`): their payment terms, their end date or where they stand. Their address is
 *     never changed here.
 *
 * Adding a vendor is inviting one (`inviteHere`), which files their first entry. What is filed is the next version of
 * the entry, sealed and signed here; the service checks who filed it and opens nothing.
 */
import { keyOf, sealingWith, type KeysHeld } from '../../../src/core/company-key.js';
import type { Invite } from '../../../src/core/types.js';
import { madeByRefusal, stopDateRefusal, whyVendorNotPayable } from '../../../src/core/person-record.js';
import {
  openVendor, sealVendor, vendorTermsRefusal, vendorVersionsRefusal, type VendorRecord, type VendorTerms,
} from '../../../src/core/vendor-record.js';
import { assets as defaultAssets, whyTheMoneyCannotReach } from '../../../src/core/assets.js';
import { fromCompanyWire, signCompanyFiling, toCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import { readAddressClaim, typedAddressIsShielded } from 'midnight-identity/profile/address-claim';
import { unshieldedClaimRefusal } from 'midnight-identity/profile/address-claim-signed';
import type { PayeeParts } from 'midnight-identity/profile/join-code';
import { judgeIn, kindAsked, namedHere } from './vault-page-doors.js';
import { InvitationRefused, payeeAt, type InvitingCompany } from './invitation-on-device.js';
import { claimFor, madeHere, payeeCodeHandedOver, raisingWalletOf, type PeopleDevice } from './people-on-device.js';

/** One vendor as this device read them: the newest version of their entry, and its version number. */
export interface VendorHere {
  readonly vendor: VendorRecord;
  readonly version: number;
}

/** The vendors as this device read them: those it believes and would pay, those it does not believe, and those active and not payable, with why. */
export interface VendorsHere {
  readonly vendors: readonly VendorHere[];
  readonly notBelieved: readonly string[];
  readonly notPayable: readonly { readonly here: VendorHere; readonly why: string }[];
}

/** Why a vendor was not changed or admitted, said as what to do. */
export class VendorNotChanged extends Error {
  constructor(why: string) {
    super(`${why} Nothing was filed.`);
    this.name = 'VendorNotChanged';
  }
}

const answered = (r: { status: number; body: unknown }, ok: number): Record<string, unknown> => {
  const b = (r.body ?? {}) as Record<string, unknown>;
  if (r.status !== ok) {
    throw new InvitationRefused(r.status, typeof b.refused === 'string' ? b.refused : null,
      typeof b.error === 'string' ? b.error : `the service answered ${r.status} and said nothing, so nothing is known to have been filed.`);
  }
  return b;
};
const at = (d: { readonly company: { readonly id: string } }, path: string) => `/api/accounts/${encodeURIComponent(d.company.id)}${path}`;

/**
 * What reading the company's vendors needs of a device, and no more: the company and the keys it holds, a way to send
 * reads to the service, the company's records as this device believes them, and the network addresses are read on.
 * A seat's device passes itself (`PeopleDevice`); a wallet that only checks a payment against a vendor passes this.
 */
interface VendorsReader {
  readonly company: Pick<InvitingCompany, 'id' | 'label' | 'viewingKey'>;
  readonly send: (path: string, init: { readonly method: 'GET' }) => Promise<{ readonly status: number; readonly body: unknown }>;
  readonly directory: PeopleDevice['directory'];
  readonly network: PeopleDevice['network'];
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
async function believedVersionsOf(d: VendorsReader, id: string, judge: ReturnType<typeof judgeIn>): Promise<VendorRecord[] | null> {
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
const claimRefusalHere = (d: VendorsReader, v: VendorRecord): string | null => {
  const typed = v.invitedAddress ?? null;
  if (typed === null || typedAddressIsShielded(typed) || (v.payeeCode ?? null) === null) return null;
  const claim = readAddressClaim(v.addressClaim)!;
  const refused = unshieldedClaimRefusal(claim, claimFor(d, v, v.wrappingPublicKey ?? ''), d.network as never);
  return refused === null ? null : `their claim of the address they were added by is refused: ${refused}`;
};

/**
 * Why an active vendor is not paid, or null: the payable check for vendors (`whyVendorNotPayable`, dated when `period` is given),
 * their address across their versions (`vendorVersionsRefusal`), and, once they claimed an unshielded typed address,
 * their wallet's claim of it, whose signature is checked here.
 */
const vendorNotPayableHere = (d: VendorsReader, versions: readonly VendorRecord[], period?: string): string | null => {
  const v = versions.at(-1)!;
  return whyVendorNotPayable(v, d.company.label, period) ?? vendorVersionsRefusal(versions) ?? claimRefusalHere(d, v);
};

/**
 * Why a vendor who is pending or has left has no address of record, or null: the same rules fix their address as an
 * active vendor's - their address across their versions (`vendorVersionsRefusal`), and, when their record names an
 * address, the address they were added by or their own wallet's signed code for it, its keys and their wallet's claim
 * (`whyVendorNotPayable` with their standing and dates aside). A vendor with no address yet has none to check.
 */
const addressOfRecordRefusalHere = (d: VendorsReader, versions: readonly VendorRecord[]): string | null => {
  const v = versions.at(-1)!;
  const why = vendorVersionsRefusal(versions);
  if (why !== null || v.address === null) return why;
  return whyVendorNotPayable({ ...v, status: 'active' }, d.company.label) ?? claimRefusalHere(d, v);
};

/**
 * **EVERY VENDOR ON THE COMPANY'S VENDOR LIST, OPENED HERE.** The vendors are the ones the company's records name;
 * each is read over all its versions. One whose versions the service did not give, or any version of which this
 * device does not believe, is named in `notBelieved`. An active one who is not payable, whoever filed them, is named
 * in `notPayable` with why; so is one who is pending or has left whose address is not their address of record
 * (`addressOfRecordRefusalHere`), so nothing ever pays them at an address the rules do not fix. Given a period, a
 * vendor outside their dates for all of it is not payable either.
 */
export async function readVendorsHere(d: VendorsReader, period?: string): Promise<VendorsHere> {
  const here = await d.directory(kindAsked('company', 'vendor'));
  const judge = judgeIn(here);
  const vendors: VendorHere[] = [];
  const notBelieved: string[] = [];
  const notPayable: { here: VendorHere; why: string }[] = [];
  for (const id of namedHere(here, 'company', 'vendor')) {
    const versions = await believedVersionsOf(d, id, judge);
    if (versions === null) { notBelieved.push(id); continue; }
    const vendor = versions.at(-1)!;
    const one: VendorHere = { vendor, version: versions.length };
    const why = vendor.status === 'active' ? vendorNotPayableHere(d, versions, period) : addressOfRecordRefusalHere(d, versions);
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
  company: Pick<InvitingCompany, 'id' | 'label'>, keys: KeysHeld, reads: Omit<VendorsReader, 'company'>, period?: string,
): Promise<VendorsHere> => readVendorsHere({ ...reads, company: { ...company, viewingKey: keys } }, period);

/** The next version of a vendor, sealed and signed here and filed at `path` under `field`, then entered in the company's records. */
const filedAndEntered = async (
  d: PeopleDevice, path: string, method: 'POST' | 'PUT', field: 'vendor' | null, vendor: VendorRecord, version: number,
): Promise<VendorRecord> => {
  const filed: VendorRecord = { ...vendor, ...madeHere(d.signingSecret) };
  const sealing = sealingWith(d.company.viewingKey, d.company.keyEpoch);
  const rec = signCompanyFiling(sealVendor(filed, version, sealing.epoch, sealing.key), d.signingSecret);
  const wire = toCompanyWire(rec);
  answered(await d.send(path, { method, body: JSON.stringify(field === null ? wire : { [field]: wire }) }), 201);
  await d.entered.enter([companyRecordEntry(rec)]);
  return filed;
};

/**
 * **ADMITTING A VENDOR: WHERE THEIR OWN WALLET SAYS TO PAY THEM, AND THE KEY THEIR PAYSLIPS ARE SEALED TO.** What they
 * handed over is checked here exactly as a person's is (`payeeCodeHandedOver`): by link, or by a shielded typed
 * address, on the fingerprint they read out (`readOut`); by an unshielded typed address, on their wallet's claim of
 * it. Refused when their invitation was taken back, when nobody is recorded raising it, when another active vendor is
 * paid at what the same wallet handed over, or when their monthly payments cannot reach the address.
 */
export async function admitVendorHere(d: PeopleDevice, here: VendorHere, readOut: string): Promise<VendorRecord> {
  const v = here.vendor;
  if ((v.payeeCode ?? null) !== null) throw new VendorNotChanged(`${v.name} has already been admitted.`);
  if (v.status === 'leaver') throw new VendorNotChanged(`${v.name} is no longer a vendor of this company. Add them again.`);
  const box = answered(await d.send(at(d, `/vendors/${encodeURIComponent(v.id)}/handover`), { method: 'GET' }), 200).inbox as Invite['handover'];
  if (!box) throw new VendorNotChanged(`${v.name} has not handed anything over yet, so there is nothing to admit.`);
  const read = await readVendorsHere(d);
  const versions = await believedVersionsOf(d, v.id, judgeIn(await d.directory(kindAsked('company', 'vendor'))));
  if (versions === null || versions.length !== here.version) {
    throw new VendorNotChanged(`${v.name}'s entry is not one this device believes as it was read. Read the vendors again.`);
  }
  const typed = versions[0]!.invitedAddress ?? null;
  if (typed !== (v.invitedAddress ?? null)) {
    throw new VendorNotChanged(`${v.name}'s entry does not name the address its first version was filed with, so they are not admitted. Add them again.`);
  }
  let handed: ReturnType<typeof payeeCodeHandedOver>;
  try { handed = payeeCodeHandedOver(d, v, box, readOut, typed); } catch (e) { throw new VendorNotChanged(String((e as Error).message).replace(/ Nothing was filed\.$/u, '')); }
  const { code, claim } = handed;
  const invites = answered(await d.send(at(d, '/invites'), { method: 'GET' }), 200) as unknown as (Invite & { subjectId?: string })[];
  const invite = (Array.isArray(invites) ? invites : []).filter((i) => i.subjectId === v.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (invite === undefined) throw new VendorNotChanged(`there is no invitation on record for ${v.name}, so there is no way to tell who set this address. Add them again.`);
  if (typeof invite.revokedAt === 'string') throw new VendorNotChanged(`${v.name}'s invitation was taken back before this was admitted. Add them again if they are still a vendor.`);
  if (!invite.createdBy) throw new VendorNotChanged('nothing records who raised this invitation, so nothing says the address was set by the vendor rather than by whoever invited them. Add them again.');
  const raisedBy = await raisingWalletOf(d, invite.createdBy);
  if (typed === null && v.email === null && raisedBy !== code.committeeKey.value) {
    throw new VendorNotChanged('this entry is not addressed to an email address, and two different wallets opened and accepted its invitation, so nobody can say whose it is. Add them again.');
  }
  const wallet = code.committeeKey.value;
  if (read.vendors.some((o) => o.vendor.id !== v.id && o.vendor.status === 'active' && o.vendor.handedOverBy === wallet)) {
    throw new VendorNotChanged('the wallet that signed this is already paid as another vendor of this company. One vendor gets one entry: mark the other a leaver first.');
  }
  let address: VendorRecord['address'];
  try { address = payeeAt((code.parts as PayeeParts).address, d.network); } catch (e) {
    throw new VendorNotChanged(`the address in what they handed over is not one money can be sent to on this network: ${(e as Error).message}`);
  }
  if (v.terms.kind === 'monthly') {
    const unreachable = whyTheMoneyCannotReach((d.registry ?? defaultAssets).require(v.terms.asset), address.kind);
    if (unreachable !== null) throw new VendorNotChanged(`not admitted. ${unreachable}`);
  }
  const admitted: VendorRecord = {
    ...v, status: 'active', address, wrappingPublicKey: (code.parts as PayeeParts).payslipKey, payeeCode: code,
    handedOverBy: wallet, admittedBy: d.signedInAs, admittedAt: new Date().toISOString(),
    ...(claim !== null ? { addressClaim: claim } : {}),
  };
  return filedAndEntered(d, at(d, `/vendors/${encodeURIComponent(v.id)}/admit`), 'POST', 'vendor', admitted, here.version + 1);
}

/** What a seat may change about a vendor: their payment terms, their end date (`null` takes it away), or where they stand. */
export interface VendorChange {
  readonly terms?: VendorTerms;
  readonly endDate?: string | null;
  readonly status?: 'active' | 'leaver';
}

/**
 * **A CHANGE TO A VENDOR**, filed as the next version of their entry by this seat. New terms apply to the next run
 * drawn. An end date may not leave out the latest month with a run past draft (`pastDraft`, read as
 * `periodsPastDraftHere` reads them). Active only for a vendor with somewhere to be paid. A vendor who may have been
 * paid leaves on their end date, which must be set and obey the same rule, so they are paid for exactly the days it
 * gives; one still waiting to be admitted is made a leaver at once. Their address is never changed here: it moves
 * only with what their own wallet hands over, or as a new entry.
 */
export async function changeVendorHere(
  d: PeopleDevice, here: VendorHere, change: VendorChange, pastDraft: () => Promise<readonly string[]>,
): Promise<VendorRecord> {
  const v = here.vendor;
  if (change.terms === undefined && change.endDate === undefined && change.status === undefined) throw new VendorNotChanged('This changes nothing about them.');
  let next: VendorRecord = { ...v };
  if (change.terms !== undefined) {
    const why = vendorTermsRefusal(change.terms);
    if (why !== null) throw new VendorNotChanged(`${v.name} is not changed: ${why}.`);
    next = { ...next, terms: change.terms };
  }
  if (change.endDate !== undefined) {
    const why = stopDateRefusal(change.endDate, 'end date', await pastDraft());
    if (why !== null) throw new VendorNotChanged(`${v.name} is not changed: ${why}.`);
    if (change.endDate !== null && change.endDate < v.startDate) throw new VendorNotChanged(`${v.name} is not changed: an end date is on or after their start date, ${v.startDate}.`);
    next = { ...next, endDate: change.endDate };
  }
  if (change.status !== undefined) {
    if (change.status === 'active' && next.address === null) {
      throw new VendorNotChanged(`${v.name} has no address on file, so there is nowhere to pay them and nothing to make active.`);
    }
    if (change.status === 'leaver' && v.status !== 'pending') {
      const end = next.endDate ?? null;
      if (end === null) {
        throw new VendorNotChanged(`${v.name} has no end date, so the days they are paid for are not known and they would go unpaid for them. Give the day their work ends and mark them a leaver again.`);
      }
      const why = stopDateRefusal(end, 'end date', await pastDraft());
      if (why !== null) throw new VendorNotChanged(`${v.name} is not made a leaver: ${why}.`);
    }
    next = { ...next, status: change.status };
  }
  return filedAndEntered(d, at(d, `/records/vendor/${encodeURIComponent(v.id)}/${here.version + 1}`), 'PUT', null, next, here.version + 1);
}
