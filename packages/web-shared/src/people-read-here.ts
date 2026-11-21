/**
 * **A COMPANY'S PEOPLE, READ ON THIS DEVICE WITH NO SEAT SECRET.** Every person's newest record is opened here with
 * the key this device holds for the company's people (`keysByPurpose`) and believed only when a seat this device believes filed it and their history holds; a believed
 * person is payable only while their record names the address its first version was filed with, if any, and, for an
 * unshielded one, with their wallet's signed claim of it checked where the ledger loads (`claimRefusal`). The service
 * only serves sealed records. A page reads people through this alone; filing a change signs with a seat's key and
 * is done in the wallet (`admitHere`, `setStatusHere`, `changePersonHere`).
 */
import { canonical, type Hex } from '../../../src/core/crypto.js';
import { madeByRefusal, openPerson, peopleServed, personVersionsRefusal, whyNotPayable } from '../../../src/core/person-record.js';
import type { RosterEmployee } from '../../../src/core/types.js';
import type { NetworkName } from '../../../src/midnight/network.js';
import { fromCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import { judgeIn, kindAsked, namedHere, type DirectoryRead } from './vault-page-doors.js';
import { keysByPurpose } from './keys-by-purpose.js';
import type { InvitingCompany } from './invitation-on-device.js';
import type { CompanyView } from './company-view.js';
import {
  readAddressClaim, typedAddressIsShielded, type AddressClaimFor, type UnshieldedAddressClaim,
} from 'midnight-identity/profile/address-claim';

/**
 * Why a wallet's claim of an unshielded address, signed with that address's key, does not prove it for this company,
 * record and payslip key, or null when it does. The signature check needs the ledger's WebAssembly, so a page fills it
 * from its vault builder's worker and the wallet with `signedClaimRefusal` itself; either way the same function runs. It
 * is never optional, so no read is built that skips it.
 */
export type ClaimRefusal = (claim: UnshieldedAddressClaim, f: AddressClaimFor) => Promise<string | null>;

/** The company's view as a read of its people or its vendors asks it: its lists, its records by name, and what its people and vendors handed over. */
export type ListsView = Pick<CompanyView<unknown>, 'list' | 'records' | 'handovers' | 'vendorHandovers'>;

/** How the people and vendors are reached: through the company's view, which reads the list and the versions of every record named in one request. */
export type ListsReach = { readonly view: ListsView };

/**
 * What reading the company's people needs of a device, and no more: its keys (never a seat secret), the way it reaches
 * the service (`ListsReach`), the directory this device believes, the network, and where a signed claim of an address
 * is checked. A seat's device (`PeopleDevice`) is one; a page that holds only the company's keys passes this.
 */
interface PeopleReadWith {
  readonly company: Pick<InvitingCompany, 'id' | 'label' | 'viewingKey'>;
  readonly directory: DirectoryRead;
  readonly network: NetworkName;
  readonly claimRefusal: ClaimRefusal;
}
export type PeopleReader = PeopleReadWith & ListsReach;

/** What a claim of the address a person or vendor was added by answers: their company, their record, their payslip key and that address. */
export const claimFor = (
  d: { readonly company: Pick<InvitingCompany, 'label'>; readonly network: NetworkName },
  person: { readonly id: string; readonly invitedAddress?: string | null }, payslipKey: string,
): AddressClaimFor => ({
  company: d.company.label, person: person.id, payslipKey: payslipKey.toLowerCase(),
  address: person.invitedAddress as string, network: d.network,
});

/**
 * The address a person's record was first filed with (`invitedAddress` of version 1, or null when they were
 * invited by link), or a refusal when version 1 is not one this device believes was filed by a seat. Read for
 * every person, whatever the newest version says: a seat that files a version leaving the typed address out
 * must not turn somebody added by address into somebody payable wherever a wallet signs.
 */
export async function typedAddressOf(
  d: PeopleReader, id: string, newest: SealedCompanyRecord | null, judge: ReturnType<typeof judgeIn>,
): Promise<{ readonly typed: string | null } | { readonly refused: string }> {
  const first = newest !== null && newest.version === 1 ? newest : await firstVersionOf(d, id);
  if (first === null || judge(verifiedCompanyFiler(first), 'person', companyRecordKey('person', id), companyRecordEntry(first), false, first.keyEpoch) !== null) {
    return { refused: 'the first version of their record is not one this device believes was filed by a seat, so this device cannot tell how this person was added and will not pay them. Ask a signer to file their record again' };
  }
  const opened = personOpened(d, first);
  return 'why' in opened ? { refused: `the first version of their record does not open here (${opened.why}), so this device cannot tell how this person was added and will not pay them. Filing it again leaves the first version as it is: they are paid from a seat's device that opens it` }
    : { typed: opened.person.invitedAddress ?? null };
}

/**
 * Why a person is not payable on this device for the address they were added by, or null when nothing about it
 * stops them. Their record must name exactly the address version 1 of it was filed with by a seat this device
 * believes, or none when version 1 named none: a later version that names another address, or drops it, is never
 * paid. An unshielded address must be proved by their wallet's claim, signed with that address's key and checked
 * by the reader's `claimRefusal`; a check that cannot be made fails the read. A shielded address has no claim:
 * they were admitted on the fingerprint they read out (`whyNotPayable` refuses a record that rests on a claim of one
 * instead).
 */
async function addedByAddressRefusal(
  d: PeopleReader, rec: SealedCompanyRecord, person: RosterEmployee, judge: ReturnType<typeof judgeIn>,
): Promise<string | null> {
  const first = await typedAddressOf(d, rec.id, rec, judge);
  if ('refused' in first) return first.refused;
  if (first.typed !== (person.invitedAddress ?? null)) {
    return first.typed === null
      ? 'their record names an address they were added by, and its first version names none, so they are not paid at it'
      : 'their record does not name the address it was first filed with, so they are not paid at another';
  }
  if (first.typed === null || typedAddressIsShielded(first.typed)) return null;
  const claim = readAddressClaim(person.addressClaim);
  if (claim === null) return 'their record carries no claim, signed with the key of the address they were added by, that their wallet holds it';
  const why = await d.claimRefusal(claim, claimFor(d, person, person.wrappingPublicKey ?? ''));
  return why === null ? null : `their claim of the address they were added by is refused: ${why}`;
}

/** Version 1 of a person's record, as the service holds it, or null when it holds none. Believed only once judged. */
async function firstVersionOf(d: PeopleReader, id: string): Promise<SealedCompanyRecord | null> {
  const { versions } = await everyVersionAsked(d, 'person', id);
  const first = Array.isArray(versions) && versions.length > 0 ? fromCompanyWire(versions[0], { company: d.company.id, kind: 'person', id }).sealed : null;
  return first !== null && first.version === 1 ? first : null;
}

/** A person as this device read them: the whole entry, the version it is, and whether something waits to be admitted. */
export interface PersonHere {
  readonly person: RosterEmployee;
  readonly version: number;
  readonly handedOver: boolean;
}

type VersionsReader = Pick<PeopleReadWith, 'company'> & ListsReach;

/**
 * Every version of one of the company's people or vendors, as the service answers them: through the company's view,
 * joined with every other record asked in the same turn.
 */
export const everyVersionAsked = async (d: VersionsReader, kind: 'person' | 'vendor', id: string): Promise<Record<string, unknown>> => {
  return ((await d.view.records([{ kind, id, every: true }]))[0] ?? {}) as Record<string, unknown>;
};

/**
 * Asks the view, in one request, for every version of each record named, and waits for its answer, so the reads of
 * them one by one that follow are answered from it. A failure is left to the read of each record, which says why.
 */
export const versionsAskedTogether = async (d: VersionsReader, kind: 'person' | 'vendor', ids: readonly string[]): Promise<void> => {
  if (ids.length === 0) return;
  await Promise.allSettled([d.view.records(ids.map((id) => ({ kind, id, every: true })))]);
};

/** The people as this device read them: those it believes and would pay, those no seat it believes filed, and those active with nothing their own wallet signed for where they are paid. */
export interface PeopleHere {
  readonly people: readonly PersonHere[];
  readonly notBelieved: readonly string[];
  /** People whose newest record the service gave does not read as a person record, each with why: also in `notBelieved`, never read or paid. */
  readonly refused?: readonly { readonly id: string; readonly why: string }[];
  /** Active people whose address or payslip key is not what their own code names (`whyNotPayable`): never read as payable, and made leavers to be added again. */
  readonly notPayable: readonly { readonly here: PersonHere; readonly why: string }[];
}

/**
 * A person's record opened with the key this device holds for the company's people, or why it does not open: a
 * record sealed under another key (another purpose, or an epoch this device cannot reach) is never read as no person.
 */
const personOpened = (d: Pick<PeopleReader, 'company'>, rec: SealedCompanyRecord): { readonly person: RosterEmployee } | { readonly why: string } => {
  try {
    return { person: openPerson(rec, keysByPurpose(d.company.viewingKey).at(rec.keyEpoch)) };
  } catch (e) {
    return { why: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * **EVERY PERSON ON THE COMPANY'S PAYROLL, OPENED HERE.** A version no seat
 * this device believes filed is not opened: it is named in `notBelieved`, so a
 * screen never shows it as a person and never hides that it is there. So is a
 * person the company's records name whom the service did not give at all. An
 * active person, or a leaver with an address, who may still be paid for days
 * before they left, whose address or payslip key is not their own code's is not
 * read as a person either, whoever filed them: they are named in `notPayable`,
 * with why. A version that names a signer other than the seat that filed it is
 * not believed (`madeByRefusal`), and neither is a person any of whose versions
 * rewrites the history the versions before it made (`historyKeptHere`). A
 * person whose record does not read as a person record at all - one filed with
 * the payslip key beside its seal among them - or does not open with this
 * device's people key is refused alone (`refused`, with why), and everybody
 * else is still read.
 */
export async function readPeopleHere(d: PeopleReader): Promise<PeopleHere> {
  const answer = (await d.view.list('people') ?? {}) as Record<string, unknown>;
  const here = await d.directory(kindAsked('company', 'person'));
  const judge = judgeIn(here);
  const people: PersonHere[] = [];
  const notBelieved: string[] = [];
  const notPayable: { here: PersonHere; why: string }[] = [];
  const { people: served, refused: unread } = peopleServed(answer, d.company.id);
  const refused = [...unread];
  for (const { id } of refused) notBelieved.push(id);
  /* A person the company's records name and the service did not give is not believed, never left out unseen. */
  const given = new Set([...served.map(({ rec }) => rec.id), ...refused.map(({ id }) => id)]);
  await versionsAskedTogether(d, 'person', served.flatMap(({ rec }) => (rec.version > 1 ? [rec.id] : [])));
  for (const id of namedHere(here, 'company', 'person')) if (!given.has(id)) notBelieved.push(id);
  for (const { rec, handedOver } of served) {
    if (judge(verifiedCompanyFiler(rec), 'person', companyRecordKey('person', rec.id), companyRecordEntry(rec), true, rec.keyEpoch) !== null) {
      notBelieved.push(rec.id);
      continue;
    }
    const opened = personOpened(d, rec);
    if ('why' in opened) {
      refused.push({ id: rec.id, why: opened.why });
      notBelieved.push(rec.id);
      continue;
    }
    const here: PersonHere = { person: opened.person, version: rec.version, handedOver };
    if (madeByRefusal(here.person, verifiedCompanyFiler(rec)) !== null || (rec.version > 1 && !(await historyKeptHere(d, rec, judge)))) {
      notBelieved.push(rec.id);
      continue;
    }
    const why = here.person.status === 'pending' || (here.person.status === 'leaver' && !here.person.address) ? null
      : whyNotPayable({ ...here.person, status: 'active' }, d.company.label) ?? await addedByAddressRefusal(d, rec, here.person, judge);
    if (why !== null) { notPayable.push({ here, why }); continue; }
    people.push(here);
  }
  return { people, notBelieved, refused, notPayable };
}

/**
 * Whether the person `newest` is, read here over all their versions, keeps the history the versions a seat filed
 * before it made (`personVersionsRefusal`): one read of their versions, made for each person filed more than once
 * each time the people are read. Their first version must be believed.
 */
async function historyKeptHere(d: PeopleReader, newest: SealedCompanyRecord, judge: ReturnType<typeof judgeIn>): Promise<boolean> {
  let recs: SealedCompanyRecord[];
  try {
    const b = await everyVersionAsked(d, 'person', newest.id);
    if (!Array.isArray(b.versions)) return false;
    recs = b.versions.map((w) => fromCompanyWire(w, { company: d.company.id, kind: 'person', id: newest.id }).sealed);
  } catch {
    return false;
  }
  if (recs.length !== newest.version || canonical(recs.at(-1)) !== canonical(newest)) return false;
  const opened: { person: RosterEmployee; filer: Hex | null }[] = [];
  for (const [i, rec] of recs.entries()) {
    const filer = verifiedCompanyFiler(rec);
    if (rec.version !== i + 1) return false;
    /* A version no seat this device believes filed is not part of the company's history: passed over, unless it is the first. */
    if (judge(filer, 'person', companyRecordKey('person', rec.id), companyRecordEntry(rec), i === recs.length - 1, rec.keyEpoch) !== null) {
      if (i === 0) return false;
      continue;
    }
    /* A later version that does not open here (an epoch this device cannot reach) is passed over; a first one refuses the person. */
    const version = personOpened(d, rec);
    if ('why' in version) { if (i === 0) return false; continue; }
    opened.push({ person: version.person, filer });
  }
  return personVersionsRefusal(opened) === null;
}
