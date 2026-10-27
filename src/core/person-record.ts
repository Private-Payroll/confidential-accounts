/**
 * **A PERSON ON A COMPANY'S PAYROLL, AS ONE SIGNED COMPANY RECORD.**
 *
 * Every version of a person is a `person` record: sealed under the company's
 * `payroll` purpose key exactly as a payroll entry always was, with only where
 * the person stands beside the seal, and signed by the seat that filed it. Their
 * payslip key is sealed with the rest, so the service never holds it. The newest version is the person; there is no other copy.
 *
 * The service's older payroll code still reads a person as an employee row
 * (`SealedEmployee`), so this file is also the one translation between the
 * two: a row is read off the newest record, and a row that code writes is a
 * new version of the same record. The sealed drop box a payee fills when they
 * accept an invitation is not part of the person: only the payee writes it,
 * and they hold no seat, so it lives on their invitation and is read in beside
 * the record.
 *
 * It also holds the one payable check over employees and vendors
 * (`whyNotPayable`), dated by the days of a period a payee is payable for, and
 * the rules a change to a person is refused by (`personChanged`). The days and
 * the salary history themselves are read by `payableDaysIn` and `payLinesOf`, re-exported here.
 *
 * Pure: the server and the page both import it.
 */
import { sealRecord, openRecord } from './sealed-records.js';
import { joinCodeSignedBy } from 'midnight-identity/profile/join-code';
import { readAddressClaim, typedAddressIsShielded } from 'midnight-identity/profile/address-claim';
import { canonical, type Hex } from './crypto.js';
import type { EmployeeClassification } from './invitation.js';
import { canonicalPeriod, isCalendarDate, isUtcMoment } from './calendar-days.js';
import { datesOfTheRecordRefusal, outsideTheirDates, payLinesOf, STOPS, stopDateRefusal, type PayableDates } from './payable-days.js';
import { payeeKeysRefusal } from './payee-keys.js';
export {
  classificationOn, datesOfTheRecordRefusal, daysOfPeriod, outsideTheirDates, payableDaysIn, payableDaysOrWhy, payLineFor, payLineOn, payLinesOf,
  periodsPastDraft, stopDateRefusal, type PayableDates, type PayableDays,
} from './payable-days.js';
import type { ClassificationLine, RosterEmployee, SealedEmployee } from './types.js';
import {
  fromCompanyWire, SealedRecordWireRefused, whyThisIsNotACompanyRecord, type CompanyWireVersion, type PersonFacts, type SealedCompanyRecord,
} from '../midnight/sealed-record-wire.js';

/** Everything about a person that is sealed: the whole entry but its id, its company and where they stand, the one plain fact. */
export type PersonSecrets = Omit<RosterEmployee, 'id' | 'accountId' | 'status'>;

/** The purpose key a person record is sealed under. */
export const PERSON_PURPOSE = 'payroll' as const;

/** The employee row the older payroll code reads, made from a person's newest record and the drop box on their invitation. */
export const employeeRowOf = (rec: SealedCompanyRecord, inbox: SealedEmployee['inbox']): SealedEmployee => {
  if (rec.kind !== 'person' || rec.facts === undefined) throw new Error(`a ${rec.kind} record is not a person, so it is not read as one.`);
  return {
    id: rec.id, accountId: rec.company, inbox, status: rec.facts.status,
    keyEpoch: rec.keyEpoch, sealed: rec.sealed,
  };
};

/** Whether a row says anything about the person that their newest record does not: its seal, epoch or where they stand. */
export const rowChangesThePerson = (rec: SealedCompanyRecord | null, row: SealedEmployee): boolean =>
  rec === null || rec.company !== row.accountId || rec.keyEpoch !== row.keyEpoch
  || rec.facts?.status !== row.status
  || canonical(rec.sealed) !== canonical(row.sealed);

/**
 * **THE NEXT VERSION OF A PERSON, AS A ROW WRITTEN BY THE SERVICE'S OLDER
 * PAYROLL CODE.** It carries no seat's signature, because that code holds no
 * seat's key: a device does not believe it, and the first device to change the
 * person files a signed version over it. A payslip key a row still carries in
 * the clear, from a file written before the key was sealed, is not kept: the
 * service cannot seal it, so the person gets slips again once admitted again.
 */
export const personRecordFromRow = (row: SealedEmployee, version: number): SealedCompanyRecord => {
  const rec: SealedCompanyRecord = {
    company: row.accountId, kind: 'person', id: row.id, version, keyEpoch: row.keyEpoch,
    sealed: row.sealed, wrapped: [],
    facts: { status: row.status },
  };
  const why = whyThisIsNotACompanyRecord(rec, { company: row.accountId, kind: 'person', id: row.id });
  if (why !== null) throw new Error(`that payroll entry cannot be kept as a person record: ${why}.`);
  return rec;
};

/**
 * **A PERSON, SEALED ON THIS DEVICE**, as the next version of their record:
 * everything private under the company's payroll key, their payslip key among
 * it, and where they stand beside it. The filer's seat signs it when it is filed.
 */
export const sealPerson = (
  person: RosterEmployee, version: number, keyEpoch: number, viewingKey: Hex,
): SealedCompanyRecord => {
  const { id, accountId, status, ...secrets } = person;
  const facts: PersonFacts = { status };
  return {
    company: accountId, kind: 'person', id, version, keyEpoch,
    sealed: sealRecord(PERSON_PURPOSE, accountId, secrets satisfies PersonSecrets, viewingKey), wrapped: [], facts,
  };
};

/**
 * **AN EMPLOYEE ROW, OPENED WITH THE COMPANY'S KEY**: the whole entry, where
 * the person stands from beside the seal. A record sealed with no payslip key
 * reads as having none. The address comes out as it was sealed; the
 * service's payroll code decodes it again before anything is paid to it.
 */
export const openEmployeeRow = (r: SealedEmployee, viewingKey: Hex): RosterEmployee => {
  const secrets = openRecord<PersonSecrets>(PERSON_PURPOSE, r.accountId, r.sealed, viewingKey);
  return { ...secrets, id: r.id, accountId: r.accountId, status: r.status, wrappingPublicKey: secrets.wrappingPublicKey ?? null };
};

/**
 * A person record, opened with the company's key. Refused when it is not named as an employee or carries a vendor's
 * payment terms, so the people and vendor lists never share an id or a rule.
 */
export const openPerson = (rec: SealedCompanyRecord, viewingKey: Hex): RosterEmployee => {
  const person = openEmployeeRow(employeeRowOf(rec, null), viewingKey);
  if (!person.id.startsWith('emp_')) throw new Error(`${person.name}'s record is not an employee's, so it is not read as one.`);
  if ('terms' in person) throw new Error(`${person.name}'s record carries a vendor's payment terms, so it is not read as an employee: a vendor is a vendor entry.`);
  return person;
};

/** One person as the people read answers: their newest record, and whether a payee's hand-over waits on their invitation. */
export interface PersonOnTheWire {
  readonly rec: SealedCompanyRecord;
  readonly handedOver: boolean;
}

/** The people read's answer: every person whose newest record reads as a person record, and every person refused alone, with why. */
export interface PeopleServed {
  readonly people: PersonOnTheWire[];
  readonly refused: ReadonlyArray<{ readonly id: string; readonly why: string }>;
}

/**
 * **THE PEOPLE READ'S ANSWER, READ OFF THE WIRE**: every person's newest
 * record, each checked to be a person record of `company` named as it says.
 * A person whose record does not read as one - a version filed with the
 * payslip key beside its seal among them - is refused for that person alone,
 * named with why, and never read; everybody else is. Refuses the whole answer
 * only when it is not a list, or names nobody for one of its entries, since
 * then who is missing cannot be said. Nothing is opened and nothing is
 * believed here: opening takes the company's key, and whose filing is
 * believed is the reader's to judge.
 */
export const peopleServed = (answer: unknown, company: string): PeopleServed => {
  const served = (answer as { people?: unknown } | null)?.people;
  if (!Array.isArray(served)) throw new Error('the service did not send the company\'s people, so none were read. That is not a payroll with nobody on it.');
  const people: PersonOnTheWire[] = [];
  const refused: Array<{ id: string; why: string }> = [];
  for (const row of served as Array<{ filed?: CompanyWireVersion; handedOver?: unknown }>) {
    const id = row?.filed?.id;
    if (typeof id !== 'string') throw new Error('one of the people the service sent is not named, so the list was not read.');
    try {
      people.push({ rec: fromCompanyWire(row.filed!, { company, kind: 'person', id }).sealed, handedOver: row.handedOver === true });
    } catch (e) {
      if (!(e instanceof SealedRecordWireRefused)) throw e;
      refused.push({ id, why: e.message });
    }
  }
  return { people, refused };
};

/**
 * The people read's answer as one list, refused whole when anybody in it does not read as a person record
 * (`peopleServed` says who and why). For a reader that shows the people as one table and says it could not
 * read them; the reader a run is drawn from refuses such a person alone (`readPeopleHere`).
 */
export const peopleOnTheWire = (answer: unknown, company: string): PersonOnTheWire[] => {
  const { people, refused } = peopleServed(answer, company);
  if (refused.length > 0) throw new SealedRecordWireRefused(`person ${refused[0]!.id} does not read as a person record (${refused[0]!.why})`);
  return people;
};

/** A record on either list, as far as the payable check reads it. */
export type PayeeOnAList = Pick<RosterEmployee, 'status' | 'payeeCode' | 'handedOverBy' | 'address' | 'wrappingPublicKey' | 'invitedAddress' | 'addressClaim'>
  & PayableDates;

/**
 * **WHY AN EMPLOYEE IS NOT PAYABLE, OR NULL WHEN THEY ARE.** Only an active
 * person is paid, and only at what their own wallet signed: the code sealed in
 * their record (`payeeCode`) must be a payee's, signed by the wallet that
 * handed it over, for this company, and name exactly the address and payslip
 * key the record pays and seals to; and the keys the record pays must be the
 * keys that address names (`payeeKeysRefusal`). A seat that files a version with
 * another address or other keys, or a person carried over with no code, is refused
 * here by every reader - the people read on a device, the screens' read, the draw,
 * the raise, the approval and the payout. A person added by address is
 * paid only at the address that was typed. Added by an unshielded address, only
 * with their wallet's claim of it in their record; its signature is checked where
 * they are read on a device (`readPeopleHere`), which this check cannot do
 * without the ledger. Added by a shielded address, never on a claim: no device can
 * check one, so they are admitted on the fingerprint they read out, as a person
 * invited by link is, and a record that rests on a claim instead is refused.
 * Given a period, a person outside their dates for every day of it is refused too (`outsideTheirDates`).
 * A field a vendor entry carries changes nothing here: an employee is always judged as one.
 */
export const whyNotPayable = (person: PayeeOnAList, company: string, period?: string): string | null =>
  paidAtWhatTheirWalletSigned(person, company) ?? payeeKeysRefusal(person.address) ?? (period === undefined ? null : outsideTheirDates(person, period));

/**
 * **WHY A VENDOR IS NOT PAYABLE, OR NULL WHEN THEY ARE**: the same check as an
 * employee's once their wallet has handed over a code; before that, a vendor added
 * by address is payable at the typed address alone, and one added by link is not
 * payable at all. The keys paid must be the keys the address names, and given a
 * period, a vendor outside their dates for every day of it is refused.
 */
export const whyVendorNotPayable = (vendor: PayeeOnAList, company: string, period?: string): string | null => {
  const why = (vendor.payeeCode ?? null) === null ? paidAtTheTypedAddress(vendor) : paidAtWhatTheirWalletSigned(vendor, company);
  return why ?? payeeKeysRefusal(vendor.address) ?? (period === undefined ? null : outsideTheirDates(vendor, period));
};

/** A vendor with no code yet: active, added by address, and paying exactly the typed address. */
const paidAtTheTypedAddress = (vendor: PayeeOnAList): string | null => {
  if (vendor.status !== 'active') return 'they are not active';
  if (vendor.invitedAddress === undefined || vendor.invitedAddress === null) {
    return 'they were added with no address and their wallet has not claimed one, so nothing names where to pay them';
  }
  return vendor.address?.bech32 === vendor.invitedAddress ? null : 'the address their record pays is not the one they were added by';
};

/** Anybody on either list once their wallet has handed over a code: everything in their record is what that code names. */
const paidAtWhatTheirWalletSigned = (person: PayeeOnAList, company: string): string | null => {
  if (person.status !== 'active') return 'they are not active';
  const code = person.payeeCode ?? null;
  if (code === null) return 'their record carries no code their own wallet signed for where they are paid';
  if (code.parts?.kind !== 'payee' || !joinCodeSignedBy(code)) return 'the code in their record is not a payee\'s code signed by their own wallet';
  if (code.company !== company) return 'the code in their record was signed for another company';
  if (person.handedOverBy === null || code.committeeKey.value.toLowerCase() !== person.handedOverBy.toLowerCase()) {
    return 'the code in their record was not signed by the wallet that handed it over';
  }
  if (person.address?.bech32 !== code.parts.address) return 'the address their record pays is not the one their code names';
  if ((person.wrappingPublicKey ?? '').toLowerCase() !== code.parts.payslipKey.toLowerCase()) {
    return 'the payslip key their record seals to is not the one their code names';
  }
  if (person.invitedAddress !== undefined && person.invitedAddress !== null) {
    if (code.parts.address !== person.invitedAddress) return 'their code names another address than the one they were added by';
    if (typedAddressIsShielded(person.invitedAddress)) {
      if (person.addressClaim !== undefined && person.addressClaim !== null) {
        return 'they were added by a private address, which is admitted on the fingerprint they read out, and their record rests on a claim of it that no device can check';
      }
      return null;
    }
    const claim = readAddressClaim(person.addressClaim);
    if (claim === null) return 'their record carries no claim, signed with the key of the address they were added by, that their wallet holds it';
    if (claim.address !== person.invitedAddress) return 'their claim is of another address than the one they were added by';
  }
  return null;
};

/** What a seat may change about a person after they were invited. A field left out is left as it is; `null` takes a date away. */
export interface PersonChange {
  readonly pay?: { readonly amount: bigint; readonly from: string };
  readonly classification?: { readonly classification: EmployeeClassification; readonly from: string };
  readonly endDate?: string | null;
  readonly leavingDate?: string | null;
}

/** Who made a version and when: the filing seat's signing key, and a UTC moment off its device's clock. */
export interface MadeBy {
  readonly madeBy: Hex;
  readonly madeAt: string;
}

/** The first day after the latest month with a run past draft, or null when no run has gone past draft. */
const firstDayNotRaised = (pastDraft: readonly string[]): string | null => {
  const latest = [...pastDraft].sort().at(-1);
  if (latest === undefined) return null;
  const [y, m] = canonicalPeriod(latest).split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

/**
 * **THE NEXT VERSION OF A PERSON, WITH ONE CHANGE MADE**, or a thrown refusal saying why. A salary or classification
 * line is appended, never rewritten, and may not take effect before the month after the latest month with a run past
 * draft (`pastDraft`), so a month already raised is never paid differently. An end or leaving date may fall inside
 * that latest month and may not leave it out. Every version made here carries who made it and when.
 */
export const personChanged = (person: RosterEmployee, change: PersonChange, pastDraft: readonly string[], made: MadeBy): RosterEmployee => {
  if (change.pay === undefined && change.classification === undefined && change.endDate === undefined && change.leavingDate === undefined) {
    throw new Error('this changes nothing about them');
  }
  const from = firstDayNotRaised(pastDraft);
  const lineRefusal = (day: string, what: string): void => {
    if (!isCalendarDate(day)) throw new Error(`the day a new ${what} applies from is a calendar date such as 2026-07-01`);
    if (from !== null && day < from) {
      throw new Error(`a run has been raised for ${pastDraft.at(-1)}, and months already raised are never paid differently: the new ${what} applies from ${from} or later. Back pay is paid as a separate one-off payment`);
    }
  };
  let next: RosterEmployee = { ...person, ...made };
  if (change.pay !== undefined) {
    if (typeof change.pay.amount !== 'bigint' || change.pay.amount <= 0n) throw new Error('a salary is above nothing, in the token\'s smallest unit');
    lineRefusal(change.pay.from, 'salary');
    next = { ...next, pay: [...payLinesOf(person), { amount: change.pay.amount, from: change.pay.from, ...made }] };
  }
  if (change.classification !== undefined) {
    if (change.classification.classification !== 'full-time' && change.classification.classification !== 'part-time') {
      throw new Error('an employee is full-time or part-time; somebody paid as a contractor is added as a vendor');
    }
    lineRefusal(change.classification.from, 'classification');
    const line: ClassificationLine = { classification: change.classification.classification, from: change.classification.from, ...made };
    next = { ...next, classifications: [...(person.classifications ?? []), line] };
  }
  for (const [field, said] of STOPS) {
    const day = change[field];
    if (day === undefined) continue;
    const why = stopDateRefusal(day, said, pastDraft);
    if (why !== null) throw new Error(why);
    next = { ...next, [field]: day };
  }
  const bad = datesOfTheRecordRefusal(next);
  if (bad !== null) throw new Error(bad);
  return next;
};

/**
 * **WHY A PERSON'S NEWEST VERSION DOES NOT KEEP THEIR HISTORY, OR NULL.** `versions` are every version a seat is
 * believed to have filed, oldest first, each with its `filer`. A version is kept when it names its filer as its maker
 * (`madeByRefusal`), keeps the start date and the amount they were hired at, and its salary and classification
 * histories begin with the last kept version's lines, unchanged and in order, every line it adds naming that version's
 * filer and moment. A version that is not kept is passed over, so a mistake filed and put right does not stand in
 * the way; but the first version and the newest must both be kept. So no seat rewrites, drops or re-signs a line an
 * earlier seat made, and the history every device reads is the one each line's signer made.
 */
export const personVersionsRefusal = (versions: readonly { readonly person: RosterEmployee; readonly filer: string | null }[]): string | null => {
  if (versions.length === 0) return 'no version of them was read';
  let kept: RosterEmployee | null = null;
  let why: string | null = null;
  for (const [i, { person, filer }] of versions.entries()) {
    why = versionRefusal(i + 1, kept, person, filer);
    if (why === null) kept = person;
    else if (i === 0) return why;
  }
  return why;
};

const versionRefusal = (n: number, before: RosterEmployee | null, person: RosterEmployee, filer: string | null): string | null => {
  const made = madeByRefusal(person, filer);
  if (made !== null) return `version ${n} of their record: ${made}`;
  if (before !== null && (person.startDate !== before.startDate || person.baseAmount !== before.baseAmount)) {
    return `version ${n} of their record changes the start date or the amount they were hired at`;
  }
  const lines = (p: RosterEmployee) => ({ pay: payLinesOf(p), classifications: p.classifications ?? [] });
  const now = lines(person);
  const was = before === null ? { pay: [], classifications: [] } : lines(before);
  for (const [kind, said] of [['pay', 'salary'], ['classifications', 'classification']] as const) {
    const old = was[kind] as readonly { readonly madeBy: string | null; readonly madeAt: string | null }[];
    const all = now[kind] as readonly { readonly madeBy: string | null; readonly madeAt: string | null }[];
    if (all.length < old.length || old.some((line, j) => canonical(line) !== canonical(all[j]))) {
      return `version ${n} of their record does not keep the earlier ${said} lines as they were`;
    }
    const added = all.slice(old.length).filter(() => !(kind === 'pay' && person.pay === undefined));
    if (added.some((line) => (line.madeBy === null ? before !== null : line.madeBy.toLowerCase() !== (filer ?? '').toLowerCase() || line.madeAt !== person.madeAt))) {
      return `version ${n} of their record: a ${said} line it adds names another signer or moment than the version`;
    }
  }
  return null;
};

/**
 * Why a version is not believed as made by whom it says, or null: every version names the seat whose signature files
 * it (`filer`) as its maker, and says when it was made as one UTC moment.
 */
export const madeByRefusal = (p: { readonly madeBy?: string; readonly madeAt?: string }, filer: string | null): string | null => {
  if (p.madeBy === undefined) return 'it does not name the seat that made it';
  if (typeof p.madeBy !== 'string' || filer === null || p.madeBy.toLowerCase() !== filer.toLowerCase()) {
    return 'the signer it names as making it is not the seat that filed it';
  }
  if (!isUtcMoment(p.madeAt)) return 'it does not say when it was made as one UTC moment';
  return null;
};

/**
 * **THE PEOPLE A SCREEN IS SHOWN, OR A REFUSAL**: `people` as they are, when
 * every active one is payable at what their own wallet signed; thrown
 * otherwise, so a list that would show somebody as paid at an address they did
 * not give is not read at all.
 */
export const onlyPayableWhenActive = <P extends RosterEmployee>(people: readonly P[], company: string): readonly P[] => {
  for (const p of people) {
    const why = p.status === 'active' ? whyNotPayable(p, company) : null;
    if (why !== null) throw new Error(`${p.name} is active and not payable, because ${why}, so the people were not read.`);
  }
  return people;
};
