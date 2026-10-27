/**
 * **A COMPANY'S PEOPLE, READ AND CHANGED ON A SEAT'S OWN DEVICE.** Each step is
 * one function a screen can call.
 *
 *   · **reading** (`readPeopleHere`): every person's newest record, opened
 *     here with the company's key, believed only when a seat this device
 *     believes filed it, and payable only while their record names the address
 *     its first version was filed with, if any, and, for an unshielded one, with
 *     their wallet's signed claim of it checked here (`addedByAddressRefusal`);
 *   · **a status** (`setStatusHere`): active only for somebody with somewhere
 *     to be paid, or a leaver;
 *   · **a change** (`changePersonHere`): a salary or classification line, an
 *     end date or a leaving date, refused when it would change a month a run
 *     has already been raised for (`personChanged`);
 *   · **admitting** (`admitHere`): the decision that makes somebody payable.
 *     Every check the service used to make with the company's key is made here,
 *     on what the payee handed over, before anything is filed: it is their code,
 *     signed by their own wallet for this company, sealed to the company's
 *     inbox in force or named waiting by the change of key that replaced an
 *     older one (`answerOpenedWith`); the fingerprint they read
 *     out is the one of the address in it, and, for a person added by a
 *     shielded address, that address is the one typed; for a person added by an
 *     unshielded address, their wallet's signed claim proves the address that
 *     was typed and nothing is read out; their invitation was not taken back
 *     and somebody is recorded as raising it; nobody else on the payroll is
 *     payable as the same person - the same wallet or the same email; a record
 *     with no email was raised and redeemed by one wallet; and the money can
 *     reach the address;
 *   · **making yourself payable** (`makeMyselfPayableHere`): the same checks,
 *     on the code your own wallet signed.
 *
 * What is filed is the next version of the person's record, sealed and signed
 * here, naming the seat that made it and when (`madeBy`, `madeAt`); a version
 * that names a signer other than its filer is not believed. The service checks
 * who filed it and what the route is for, and opens nothing.
 */
import { keyOf, sealingWith } from '../../../src/core/company-key.js';
import { canonical, randomBytes, signingPublicKeyOf, toHex, type Hex } from '../../../src/core/crypto.js';
import { AnswerToAnOldInvitation, answerOpenedWith } from '../../../src/core/answer-opened.js';
import {
  madeByRefusal, openPerson, peopleServed, personChanged, personVersionsRefusal, sealPerson, stopDateRefusal, whyNotPayable, type MadeBy, type PersonChange,
} from '../../../src/core/person-record.js';
import { isCalendarDate, utcMomentOf } from '../../../src/core/invitation.js';
import { earliestStopOf } from '../../../src/core/payable-days.js';
import { assets as defaultAssets, whyTheMoneyCannotReach, type AssetRegistry } from '../../../src/core/assets.js';
import type { Invite, RosterEmployee } from '../../../src/core/types.js';
import type { Payee } from '../../../src/midnight/payee-address.js';
import type { NetworkName } from '../../../src/midnight/network.js';
import {
  signCompanyFiling, toCompanyWire, verifiedCompanyFiler,
} from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import type { RecordsEntered } from './record-entered-here.js';
import { joinCodeSignedBy, type JoinCode, type PayeeParts } from 'midnight-identity/profile/join-code';
import { payeeCodeFingerprint, tidyFingerprint } from 'midnight-identity/profile/fingerprint';
import { judgeIn, kindAsked, namedHere, seatNotBelievedHere, type DirectoryRead } from './vault-page-doors.js';
import { InvitationRefused, payeeAt, type InvitationSend, type InvitingCompany } from './invitation-on-device.js';
import {
  readAddressClaim, readClaimedHandover, typedAddressIsShielded, type AddressClaim, type AddressClaimFor,
} from 'midnight-identity/profile/address-claim';
import { unshieldedClaimRefusal } from 'midnight-identity/profile/address-claim-signed';
import { readJoinParts } from 'midnight-identity/profile/join-code';
import { fromCompanyWire, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';

/** What a device acting on a company's people needs: the company opened, its seat, and how it reaches the service. */
export interface PeopleDevice {
  readonly company: InvitingCompany;
  /** This seat's filing key: every version filed here is signed with it. */
  readonly signingSecret: Hex;
  /** The id the person acting signed in with. */
  readonly signedInAs: string;
  readonly send: InvitationSend;
  /** The company's directory as this device believes it, read afresh for every step (`directoryHere`): who filed a version, and whose wallet a seat's is. */
  readonly directory: DirectoryRead;
  readonly network: NetworkName;
  readonly registry?: AssetRegistry;
  /** The one filing call, bound to this company and this seat: every version filed here is entered in the company's records. */
  readonly entered: RecordsEntered;
}

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
async function typedAddressOf(
  d: PeopleDevice, id: string, newest: SealedCompanyRecord | null, judge: ReturnType<typeof judgeIn>,
): Promise<{ readonly typed: string | null } | { readonly refused: string }> {
  const first = newest !== null && newest.version === 1 ? newest : await firstVersionOf(d, id);
  if (first === null || judge(verifiedCompanyFiler(first), 'person', companyRecordKey('person', id), companyRecordEntry(first), false, first.keyEpoch) !== null) {
    return { refused: 'the first version of their record is not one this device believes was filed by a seat, so this device cannot tell how this person was added and will not pay them. Ask a signer to file their record again' };
  }
  return { typed: openPerson(first, keyOf(d.company.viewingKey, first.keyEpoch)).invitedAddress ?? null };
}

/**
 * Why a person is not payable on this device for the address they were added by, or null when nothing about it
 * stops them. Their record must name exactly the address version 1 of it was filed with by a seat this device
 * believes, or none when version 1 named none: a later version that names another address, or drops it, is never
 * paid. An unshielded address must be proved by their wallet's claim, signed with that address's key and checked
 * here. A shielded address has no claim: they were admitted on the fingerprint they read out (`whyNotPayable`
 * refuses a record that rests on a claim of one instead).
 */
async function addedByAddressRefusal(
  d: PeopleDevice, rec: SealedCompanyRecord, person: RosterEmployee, judge: ReturnType<typeof judgeIn>,
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
  const why = unshieldedClaimRefusal(claim, claimFor(d, person, person.wrappingPublicKey ?? ''), d.network as never);
  return why === null ? null : `their claim of the address they were added by is refused: ${why}`;
}

/** Version 1 of a person's record, as the service holds it, or null when it holds none. Believed only once judged. */
async function firstVersionOf(d: PeopleDevice, id: string): Promise<SealedCompanyRecord | null> {
  const b = answered(await d.send(at(d, `/records/person/${encodeURIComponent(id)}/1`), { method: 'GET' }), 200);
  if (b.filed === null || b.filed === undefined) return null;
  return fromCompanyWire(b.filed as never, { company: d.company.id, kind: 'person', id }).sealed;
}

/** A person as this device read them: the whole entry, the version it is, and whether something waits to be admitted. */
export interface PersonHere {
  readonly person: RosterEmployee;
  readonly version: number;
  readonly handedOver: boolean;
}

/** Thrown when this device will not make a change; nothing was filed, and the message says what resolves it. */
export class PersonNotChanged extends Error {
  constructor(why: string) {
    super(`${why} Nothing was filed.`);
    this.name = 'PersonNotChanged';
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
const at = (d: PeopleDevice, path: string) => `/api/accounts/${encodeURIComponent(d.company.id)}${path}`;

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
 * the payslip key beside its seal among them - is refused alone (`refused`,
 * with why), and everybody else is still read.
 */
export async function readPeopleHere(d: PeopleDevice): Promise<PeopleHere> {
  const answer = answered(await d.send(at(d, '/people'), { method: 'GET' }), 200);
  const here = await d.directory(kindAsked('company', 'person'));
  const judge = judgeIn(here);
  const people: PersonHere[] = [];
  const notBelieved: string[] = [];
  const notPayable: { here: PersonHere; why: string }[] = [];
  const { people: served, refused } = peopleServed(answer, d.company.id);
  for (const { id } of refused) notBelieved.push(id);
  /* A person the company's records name and the service did not give is not believed, never left out unseen. */
  const given = new Set([...served.map(({ rec }) => rec.id), ...refused.map(({ id }) => id)]);
  for (const id of namedHere(here, 'company', 'person')) if (!given.has(id)) notBelieved.push(id);
  for (const { rec, handedOver } of served) {
    if (judge(verifiedCompanyFiler(rec), 'person', companyRecordKey('person', rec.id), companyRecordEntry(rec), true, rec.keyEpoch) !== null) {
      notBelieved.push(rec.id);
      continue;
    }
    const here: PersonHere = { person: openPerson(rec, keyOf(d.company.viewingKey, rec.keyEpoch)), version: rec.version, handedOver };
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

/** Who makes a version on this device, and when: this seat's signing key, and this device's clock as one UTC moment. */
export const madeHere = (signingSecret: Hex): MadeBy => ({ madeBy: signingPublicKeyOf(signingSecret), madeAt: utcMomentOf(Date.now()) });

/**
 * Whether the person `newest` is, read here over all their versions, keeps the history the versions a seat filed
 * before it made (`personVersionsRefusal`): one read of their versions, made for each person filed more than once
 * each time the people are read. Their first version must be believed.
 */
async function historyKeptHere(d: PeopleDevice, newest: SealedCompanyRecord, judge: ReturnType<typeof judgeIn>): Promise<boolean> {
  let recs: SealedCompanyRecord[];
  try {
    const b = answered(await d.send(at(d, `/records/person/${encodeURIComponent(newest.id)}/versions`), { method: 'GET' }), 200);
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
    try { opened.push({ person: openPerson(rec, keyOf(d.company.viewingKey, rec.keyEpoch)), filer }); } catch { if (i === 0) return false; }
  }
  return personVersionsRefusal(opened) === null;
}

/**
 * **A VERSION OF A PERSON, SEALED AND SIGNED ON THIS DEVICE, FILED AT `path`
 * AND ENTERED IN THE COMPANY'S RECORDS** - the one filing call - once the
 * service has kept it. Returns the version as filed, naming this seat as its maker.
 */
const filedAndEntered = async (
  d: PeopleDevice, path: string, person: RosterEmployee, version: number, made: MadeBy = madeHere(d.signingSecret),
): Promise<RosterEmployee> => {
  const filed: RosterEmployee = { ...person, ...made };
  const sealing = sealingWith(d.company.viewingKey, d.company.keyEpoch);
  const rec = signCompanyFiling(sealPerson(filed, version, sealing.epoch, sealing.key), d.signingSecret);
  answered(await d.send(path, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(rec) }) }), 201);
  await d.entered.enter([companyRecordEntry(rec)]);
  return filed;
};

/**
 * **WHERE A PERSON STANDS**: active only for somebody with somewhere to be
 * paid - which is admitting's to give, not this - or a leaver. Somebody still
 * waiting to be admitted, never paid, is made a leaver at once: withdrawing
 * them is the way out of an invitation that can never be admitted. Anybody
 * else leaves on a day: the leaving date given here, or the leaving or end date
 * their record holds, so they are paid for exactly the days they worked
 * (`payableDaysOrWhy`). Refused, before anything is signed, when no such day is
 * known, when it is before their start date, or when it would leave out a month
 * that already has a run past draft (`stopDateRefusal`, read through
 * `leaving.pastDraft`, as a leaving date set on its own is).
 */
export async function setStatusHere(
  d: PeopleDevice, here: PersonHere, status: 'active' | 'leaver',
  leaving?: { readonly leavingDate?: string; readonly pastDraft: () => Promise<readonly string[]> },
): Promise<RosterEmployee> {
  const p = here.person;
  if (status === 'active' && !p.address) {
    throw new PersonNotChanged(`${p.name} has no address on file, so there is nowhere to pay them and nothing to make active. An address comes from their own wallet when they accept, and becomes payable when it is admitted.`);
  }
  let next: RosterEmployee = { ...p, status };
  if (status === 'leaver' && p.status !== 'pending') {
    if (leaving === undefined) {
      throw new PersonNotChanged(`${p.name} is made a leaver on the day they leave, checked against the months already raised, and this page gave neither. Give their leaving date and mark them a leaver again.`);
    }
    next = leaving.leavingDate === undefined ? next : { ...next, leavingDate: leaving.leavingDate };
    const stop = earliestStopOf(next);
    if (stop === null) {
      throw new PersonNotChanged(`${p.name} has no leaving date or end date, so the days they worked are not known and they would go unpaid for them. Give their leaving date and mark them a leaver again.`);
    }
    if (isCalendarDate(stop.day) && stop.day < p.startDate) throw new PersonNotChanged(`${p.name}'s ${stop.said}, ${stop.day}, is before their start date, ${p.startDate}.`);
    const why = stopDateRefusal(stop.day, stop.said, await leaving.pastDraft());
    if (why !== null) throw new PersonNotChanged(`${p.name} is not made a leaver: ${why}.`);
  }
  return filedAndEntered(d, `/api/people/${encodeURIComponent(p.id)}/status`, next, here.version + 1);
}


/**
 * **A CHANGE TO A PERSON AFTER THEY WERE INVITED**: a salary line, a classification line, an end date or a leaving
 * date, filed as the next version of their record by this seat. `pastDraft` reads the months that have a run past
 * draft (`periodsPastDraftHere`); a line taking effect inside one of them, or a date that would leave one out, is
 * refused before anything is signed (`personChanged`), so a month already raised is never paid differently. Where
 * they stand is not changed here: that is `setStatusHere`'s.
 */
export async function changePersonHere(
  d: PeopleDevice, here: PersonHere, change: PersonChange, pastDraft: () => Promise<readonly string[]>,
): Promise<RosterEmployee> {
  const made = madeHere(d.signingSecret);
  let next: RosterEmployee;
  try {
    next = personChanged(here.person, change, await pastDraft(), made);
  } catch (e) {
    throw new PersonNotChanged(`${here.person.name} is not changed: ${String((e as Error)?.message ?? e).replace(/\.?\s*$/u, '')}.`);
  }
  return filedAndEntered(d, `/api/people/${encodeURIComponent(here.person.id)}/details`, next, here.version + 1, made);
}

/** The address a payee's code names, decoded as the platform decodes one, at this device's network. */
const payeeOfCode = (parts: PayeeParts, network: NetworkName): Payee => {
  try {
    return payeeAt(parts.address, network);
  } catch (e) {
    throw new PersonNotChanged(`the address in this code is not one money can be sent to on this network: ${(e as Error).message}`);
  }
};

/** The checks a payee's code passes before it makes anybody payable, whichever way it arrived. */
const refuseACodeThatCannotBePaid = (
  d: PeopleDevice, person: RosterEmployee, code: JoinCode, read: PeopleHere,
): Payee => {
  /*
   * One payable record per person is checked against every person on the
   * payroll; a record no seat this device believes filed cannot be opened to
   * check, so nothing is made payable while one is there.
   */
  if (read.notBelieved.length > 0) {
    throw new PersonNotChanged(`the payroll holds ${read.notBelieved.length} record(s) no seat this device believes filed (${read.notBelieved.join(', ')}), so whether this person is already payable cannot be checked. A signer files those people again from their own device first.`);
  }
  const activeNotPayable = read.notPayable.filter((x) => x.here.person.status === 'active');
  if (activeNotPayable.length > 0) {
    throw new PersonNotChanged(`the payroll holds ${activeNotPayable.length} active record(s) whose address or payslip key is not what their own wallet signed (${activeNotPayable.map((x) => x.here.person.name).join(', ')}), so whether this person is already payable cannot be checked. Mark those people leavers, and add them again.`);
  }
  const others = read.people;
  if (code.parts.kind !== 'payee' || !joinCodeSignedBy(code) || code.company !== d.company.label) {
    throw new PersonNotChanged('what was handed over is not a payee\'s code signed by their own wallet for this company. An invitation is accepted once: mark this person a leaver and invite them again.');
  }
  const wallet = code.committeeKey.value;
  const same = (a: string) => a.trim().toLowerCase();
  const clash = others.find((p) => p.person.id !== person.id && p.person.status === 'active'
    && ((p.person.handedOverBy !== null && p.person.handedOverBy === wallet)
      || (p.person.email !== null && person.email !== null && same(p.person.email) === same(person.email))));
  if (clash !== undefined) {
    throw new PersonNotChanged(`${person.email ?? 'the person whose wallet signed this'} is already payable on this company. One person gets one payable record, because two records is two salaries. To pay them at a different address, mark the existing record a leaver and add them again.`);
  }
  const address = payeeOfCode(code.parts, d.network);
  const unreachable = whyTheMoneyCannotReach((d.registry ?? defaultAssets).require(person.asset), address.kind);
  if (unreachable !== null) throw new PersonNotChanged(`not admitted. ${unreachable} An invitation is accepted once: mark this person a leaver and invite them again, to accept with an address that can be paid.`);
  return address;
};

/**
 * **THE CODE A PAYEE HANDED OVER, OPENED AND CHECKED ON THIS DEVICE**, with their wallet's claim of the address they
 * were added by when it is an unshielded one. `box` is what waits on their invitation, sealed to the company's inbox;
 * `typed` is the address version 1 of their record was filed with, or null for somebody invited by link. Throws,
 * with what to do, when it does not open with the company's key, is not a payee's code signed for this company,
 * names another record or another address than the typed one, rests on a claim of a shielded address, carries an
 * unshielded claim not signed with the typed address's key, or, when no claim is checked, has another fingerprint
 * than the one read out. People and vendors are admitted through it alike.
 */
export function payeeCodeHandedOver(
  d: PeopleDevice, who: { readonly id: string; readonly name: string; readonly invitedAddress?: string | null },
  box: NonNullable<Invite['handover']>, readOut: string, typed: string | null,
): { readonly code: JoinCode; readonly claim: AddressClaim | null } {
  const byAddress = typed !== null;
  const byClaim = typed !== null && !typedAddressIsShielded(typed);
  let code: JoinCode;
  let opened: unknown;
  try { opened = answerOpenedWith<unknown>(d.company.viewingKey, box, d.company.id).value; } catch (e) {
    if (e instanceof AnswerToAnOldInvitation) {
      throw new PersonNotChanged('what was handed over was sealed to the company\'s key from before it changed, and the signer who changed the key did not find it waiting, so it is not admitted. An invitation is accepted once: mark this person a leaver and invite them again.');
    }
    throw new PersonNotChanged('what was handed over does not open with this company\'s key, so it was sealed for somebody else. An invitation is accepted once: mark this person a leaver and invite them again.');
  }
  const claimed = readClaimedHandover(opened);
  if (byAddress && !byClaim && claimed !== null) {
    throw new PersonNotChanged(`${who.name} was added by a private address, which is admitted on the fingerprint they read out, and what was handed over is a claim of it that no device can check. An invitation is accepted once: mark this person a leaver and add them again.`);
  }
  if (byClaim) {
    const given = claimed === null ? null : claimed.code as JoinCode;
    const parts = given === null ? null : readJoinParts(given.parts);
    const read = given !== null && parts !== null && joinCodeSignedBy(given) && given.company === d.company.label ? { ...given, parts } : null;
    if (read === null || read.parts.kind !== 'payee') {
      throw new PersonNotChanged(`${who.name} was added by address, and what was handed over is not their wallet's claim of it with a payee's code for this company. An invitation is accepted once: mark this person a leaver and add them again.`);
    }
    code = read;
    if (code.person !== who.id || (code.parts as PayeeParts).address !== typed) {
      throw new PersonNotChanged(`what was handed over names another address or record than the one ${who.name} was added by, so it is not admitted. Mark this person a leaver and add them again.`);
    }
    const why = unshieldedClaimRefusal(claimed!.claim, claimFor(d, who, (code.parts as PayeeParts).payslipKey), d.network as never);
    if (why !== null) throw new PersonNotChanged(`the claim of the address ${who.name} was added by is refused: ${why}. Nothing they handed over is used.`);
  } else {
    code = opened as JoinCode;
    if (byAddress && (code?.person !== who.id || code?.parts?.kind !== 'payee' || (code.parts as PayeeParts).address !== typed)) {
      throw new PersonNotChanged(`what was handed over names another address or record than the private address ${who.name} was added by, so it is not admitted. Mark this person a leaver and add them again.`);
    }
  }
  if (code?.parts?.kind !== 'payee' || (!byClaim && tidyFingerprint(readOut) !== payeeCodeFingerprint(code as JoinCode & { parts: PayeeParts }))) {
    throw new PersonNotChanged('the fingerprint this person read out is not the fingerprint of the code that arrived, so the address or payslip key is not the one their wallet showed them. An invitation is accepted once: mark this person a leaver and invite them again; if it does not match a second time, the page they accepted on is not ours.');
  }
  return { code, claim: byClaim ? claimed!.claim : null };
}

/**
 * **ADMITTING A PERSON: THE DECISION THAT MAKES THEM PAYABLE, MADE HERE.**
 * `readOut` is the fingerprint the payee read off their own device; it must be
 * the fingerprint of the address in what they handed over. Whether they were
 * added by address, and which, is read from version 1 of their record. A person
 * added by a shielded address reads out their fingerprint too, of a code naming
 * exactly the typed address: no device can check a proof that a wallet holds a
 * shielded address. A person added by an unshielded address reads out nothing:
 * what they handed over must be their wallet's claim of the address that was
 * typed, signed with its key and checked here, and `readOut` is not read.
 */
export async function admitHere(d: PeopleDevice, here: PersonHere, readOut: string): Promise<RosterEmployee> {
  const id = here.person.id;
  if (here.person.status === 'active') throw new PersonNotChanged(`${here.person.name} has already been admitted.`);
  const box = answered(await d.send(`/api/employees/${encodeURIComponent(id)}/handover`, { method: 'GET' }), 200).inbox as Invite['handover'];
  if (!box) throw new PersonNotChanged(`${here.person.name} has not handed anything over yet, so there is nothing to admit.`);
  /* Version 1 is the record being admitted when nothing was filed for them since the invitation; otherwise it is read. */
  const first = here.version === 1 ? { typed: here.person.invitedAddress ?? null }
    : await typedAddressOf(d, id, null, judgeIn(await d.directory(kindAsked('company', 'person'))));
  if ('refused' in first) throw new PersonNotChanged(`${here.person.name} is not admitted: ${first.refused}.`);
  if (first.typed !== (here.person.invitedAddress ?? null)) {
    throw new PersonNotChanged(`${here.person.name}'s record does not name the address its first version was filed with, so they are not admitted. Mark this person a leaver and add them again.`);
  }
  const typed = first.typed;
  const byAddress = typed !== null;
  const { code, claim } = payeeCodeHandedOver(d, here.person, box, readOut, typed);
  const invites = answered(await d.send(at(d, '/invites'), { method: 'GET' }), 200) as unknown as (Invite & { subjectId?: string })[];
  const invite = (Array.isArray(invites) ? invites : []).filter((i) => i.subjectId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (invite === undefined) throw new PersonNotChanged(`there is no invitation on record for ${here.person.name}, so there is no way to tell who set this address. Invite them again rather than admitting it.`);
  if (typeof invite.revokedAt === 'string') {
    throw new PersonNotChanged('this invitation was taken back before this was admitted, so admitting it would put somebody on the payroll whose hire was called off. Withdraw this person, and invite them again if the hire is back on.');
  }
  if (!invite.createdBy) {
    throw new PersonNotChanged('nothing records who raised this invitation, so nothing says the address was set by the payee rather than by whoever invited them. Mark this person a leaver, then invite them again.');
  }
  const raisedBy = await raisingWalletOf(d, invite.createdBy);
  if (!byAddress && here.person.email === null && raisedBy !== code.committeeKey.value) {
    throw new PersonNotChanged('this record is not addressed to an email address, and two different wallets opened and accepted its invitation, so nobody can say whose it is. Mark this person a leaver and invite them again.');
  }
  const address = refuseACodeThatCannotBePaid(d, here.person, code, await readPeopleHere(d));
  const admitted: RosterEmployee = {
    ...here.person, status: 'active', address, wrappingPublicKey: (code.parts as PayeeParts).payslipKey, payslipKeyFrom: code.company,
    handedOverBy: code.committeeKey.value, admittedBy: d.signedInAs, admittedAt: new Date().toISOString(),
    selfRaised: raisedBy === code.committeeKey.value, payeeCode: code,
    ...(claim !== null ? { addressClaim: claim } : {}),
  };
  return filedAndEntered(d, `/api/employees/${encodeURIComponent(id)}/admit`, admitted, here.version + 1);
}

/**
 * The committee key of the seat whose sign-in raised an invitation, from the
 * company's directory as this device believes it (`seatNotBelievedHere`, the
 * one rule for a seat): null when that person holds no seat it believes now.
 */
export async function raisingWalletOf(d: PeopleDevice, person: string): Promise<string | null> {
  const here = await d.directory();
  const seat = here.dir.seats.find((x) => x.person === person && seatNotBelievedHere(here, x) === null);
  return seat?.committeeKey?.value.toLowerCase() ?? null;
}

/** What a signer making themselves payable enters about their pay. */
interface MyPay {
  readonly name: string;
  readonly title: string;
  readonly asset: string;
  readonly baseAmount: bigint;
  readonly startDate: string;
}

/**
 * **A SIGNER MAKES THEMSELVES PAYABLE**, with the code their own wallet signed
 * for where they are paid: the checks admitting makes, then their first
 * person record, active, filed from here. Nobody else's sign-in is involved.
 */
export async function makeMyselfPayableHere(d: PeopleDevice, code: JoinCode, pay: MyPay): Promise<RosterEmployee> {
  if (typeof pay.baseAmount !== 'bigint' || pay.baseAmount <= 0n) throw new PersonNotChanged('pay is above nothing, in the token\'s smallest unit.');
  if (!isCalendarDate(pay.startDate)) throw new PersonNotChanged('the day you start paying yourself from is not a date: a start date is a calendar date such as 2026-07-01.');
  const raisedBy = await raisingWalletOf(d, d.signedInAs);
  if (raisedBy === null || raisedBy !== code.committeeKey.value) {
    throw new PersonNotChanged('this code is not signed by the wallet your seat on this company was entered with, so it is not yours to be paid by.');
  }
  const made = madeHere(d.signingSecret);
  const person: RosterEmployee = {
    id: `emp_${toHex(randomBytes(10))}`, accountId: d.company.id, name: pay.name, email: null, title: pay.title,
    asset: pay.asset, baseAmount: pay.baseAmount, startDate: pay.startDate, status: 'active', wrappingPublicKey: null,
    handedOverBy: null, admittedBy: null, admittedAt: null, selfRaised: true, address: null,
    pay: [{ amount: pay.baseAmount, from: pay.startDate, ...made }],
  };
  const address = refuseACodeThatCannotBePaid(d, person, code, await readPeopleHere(d));
  const payable: RosterEmployee = {
    ...person, address, wrappingPublicKey: (code.parts as PayeeParts).payslipKey, payslipKeyFrom: code.company,
    handedOverBy: code.committeeKey.value, admittedBy: d.signedInAs, admittedAt: new Date().toISOString(), payeeCode: code,
  };
  return filedAndEntered(d, at(d, '/self-payee'), payable, 1, made);
}
