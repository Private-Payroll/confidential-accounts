/**
 * **A COMPANY'S VENDORS, READ AND CHANGED ON A SEAT'S OWN DEVICE.** Each step is one function a screen can call.
 * Vendors, contractors included, are a list of their own: never read with the people on the payroll, sealed under
 * the company's vendors key, and paid by the vendors' side of the one payable check (`whyVendorNotPayable`).
 *
 *   · **reading** (`readVendorsHere`, which needs no seat secret and is kept apart so a page can load it alone):
 *     every vendor the company's records name, each version opened here and believed only when a seat this device believes filed it and the version names that seat as its maker; payable
 *     only while every version names the address the first was filed with, the wallet that handed one over stays the
 *     same, an address moves only with a new code from that wallet (`vendorVersionsRefusal`), and, for an unshielded
 *     typed address they claimed, with their wallet's signed claim of it checked by the reader's `claimRefusal`;
 *   · **admitting** (`admitVendorHere`): what the vendor's own wallet handed over, checked here as a person's is
 *     (`payeeCodeHandedOver`): by link or by a shielded address on the fingerprint read out, by an unshielded address
 *     on the wallet's signed claim;
 *   · **a change** (`changeVendorHere`): their payment terms, their end date or where they stand. Their address is
 *     never changed here.
 *
 * Adding a vendor is inviting one (`inviteHere`), which files their first entry. What is filed is the next version of
 * the entry, sealed and signed here; the service checks who filed it and opens nothing.
 */
import { sealingWith } from '../../../src/core/company-key.js';
import type { Invite } from '../../../src/core/types.js';
import { stopDateRefusal } from '../../../src/core/person-record.js';
import { sealVendor, vendorTermsRefusal, type VendorRecord, type VendorTerms } from '../../../src/core/vendor-record.js';
import { assets as defaultAssets, whyTheMoneyCannotReach } from '../../../src/core/assets.js';
import { signCompanyFiling, toCompanyWire } from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import type { PayeeParts } from 'midnight-identity/profile/join-code';
import { judgeIn, kindAsked } from './vault-page-doors.js';
import { payeeAt } from './invitation-on-device.js';
import { madeHere, payeeCodeHandedOver, raisingWalletOf, type PeopleDevice } from './people-on-device.js';
import { answered, at, believedVersionsOf, readVendorsHere, type VendorHere } from './vendors-read-here.js';

export { readVendorsHere, readVendorsWithKeys, type VendorHere, type VendorsHere } from './vendors-read-here.js';

/** Why a vendor was not changed or admitted, said as what to do. */
export class VendorNotChanged extends Error {
  constructor(why: string) {
    super(`${why} Nothing was filed.`);
    this.name = 'VendorNotChanged';
  }
}

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
  let handed: Awaited<ReturnType<typeof payeeCodeHandedOver>>;
  try { handed = await payeeCodeHandedOver(d, v, box, readOut, typed); } catch (e) { throw new VendorNotChanged(String((e as Error).message).replace(/ Nothing was filed\.$/u, '')); }
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
