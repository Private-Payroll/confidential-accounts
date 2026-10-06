/**
 * **A PERSON ON A COMPANY'S PAYROLL, AS ONE SIGNED COMPANY RECORD.**
 *
 * Every version of a person is a `person` record: sealed under the company's
 * `payroll` purpose key exactly as a payroll entry always was, with where the
 * person stands and their payslip key beside the seal, and signed by the seat
 * that filed it. The newest version is the person; there is no other copy.
 *
 * The service's older payroll code still reads a person as an employee row
 * (`SealedEmployee`), so this file is also the one translation between the
 * two: a row is read off the newest record, and a row that code writes is a
 * new version of the same record. The sealed drop box a payee fills when they
 * accept an invitation is not part of the person: only the payee writes it,
 * and they hold no seat, so it lives on their invitation and is read in beside
 * the record.
 *
 * Pure: the server and the page both import it.
 */
import { sealRecord, openRecord } from './sealed-records.js';
import { joinCodeSignedBy } from 'midnight-identity/profile/join-code';
import { canonical, type Hex } from './crypto.js';
import type { RosterEmployee, SealedEmployee } from './types.js';
import {
  fromCompanyWire, whyThisIsNotACompanyRecord, type CompanyWireVersion, type PersonFacts, type SealedCompanyRecord,
} from '../midnight/sealed-record-wire.js';

/** Everything about a person that is sealed: the whole entry but its id, its company and its two plain facts. */
export type PersonSecrets = Omit<RosterEmployee, 'id' | 'accountId' | 'wrappingPublicKey' | 'status'>;

/** The purpose key a person record is sealed under. */
export const PERSON_PURPOSE = 'payroll' as const;

/** The employee row the older payroll code reads, made from a person's newest record and the drop box on their invitation. */
export const employeeRowOf = (rec: SealedCompanyRecord, inbox: SealedEmployee['inbox']): SealedEmployee => {
  if (rec.kind !== 'person' || rec.facts === undefined) throw new Error(`a ${rec.kind} record is not a person, so it is not read as one.`);
  return {
    id: rec.id, accountId: rec.company, inbox,
    wrappingPublicKey: rec.facts.wrappingPublicKey, status: rec.facts.status,
    keyEpoch: rec.keyEpoch, sealed: rec.sealed,
  };
};

/** Whether a row says anything about the person that their newest record does not: its seal, epoch or a plain fact. */
export const rowChangesThePerson = (rec: SealedCompanyRecord | null, row: SealedEmployee): boolean =>
  rec === null || rec.company !== row.accountId || rec.keyEpoch !== row.keyEpoch
  || rec.facts?.status !== row.status || rec.facts?.wrappingPublicKey !== row.wrappingPublicKey
  || canonical(rec.sealed) !== canonical(row.sealed);

/**
 * **THE NEXT VERSION OF A PERSON, AS A ROW WRITTEN BY THE SERVICE'S OLDER
 * PAYROLL CODE.** It carries no seat's signature, because that code holds no
 * seat's key: a device does not believe it, and the first device to change the
 * person files a signed version over it.
 */
export const personRecordFromRow = (row: SealedEmployee, version: number): SealedCompanyRecord => {
  const rec: SealedCompanyRecord = {
    company: row.accountId, kind: 'person', id: row.id, version, keyEpoch: row.keyEpoch,
    sealed: row.sealed, wrapped: [],
    facts: { status: row.status, wrappingPublicKey: row.wrappingPublicKey },
  };
  const why = whyThisIsNotACompanyRecord(rec, { company: row.accountId, kind: 'person', id: row.id });
  if (why !== null) throw new Error(`that payroll entry cannot be kept as a person record: ${why}.`);
  return rec;
};

/**
 * **A PERSON, SEALED ON THIS DEVICE**, as the next version of their record:
 * everything private under the company's payroll key, the two plain facts
 * beside it. The filer's seat signs it when it is filed.
 */
export const sealPerson = (
  person: RosterEmployee, version: number, keyEpoch: number, viewingKey: Hex,
): SealedCompanyRecord => {
  const { id, accountId, wrappingPublicKey, status, ...secrets } = person;
  const facts: PersonFacts = { status, wrappingPublicKey };
  return {
    company: accountId, kind: 'person', id, version, keyEpoch,
    sealed: sealRecord(PERSON_PURPOSE, accountId, secrets satisfies PersonSecrets, viewingKey), wrapped: [], facts,
  };
};

/**
 * **AN EMPLOYEE ROW, OPENED WITH THE COMPANY'S KEY**: the whole entry, plain
 * facts from beside the seal. The address comes out as it was sealed; the
 * service's payroll code decodes it again before anything is paid to it.
 */
export const openEmployeeRow = (r: SealedEmployee, viewingKey: Hex): RosterEmployee => {
  const secrets = openRecord<PersonSecrets>(PERSON_PURPOSE, r.accountId, r.sealed, viewingKey);
  return { id: r.id, accountId: r.accountId, wrappingPublicKey: r.wrappingPublicKey, status: r.status, ...secrets };
};

/** A person record, opened with the company's key. */
export const openPerson = (rec: SealedCompanyRecord, viewingKey: Hex): RosterEmployee =>
  openEmployeeRow(employeeRowOf(rec, null), viewingKey);

/** One person as the people read answers: their newest record, and whether a payee's hand-over waits on their invitation. */
export interface PersonOnTheWire {
  readonly rec: SealedCompanyRecord;
  readonly handedOver: boolean;
}

/**
 * **THE PEOPLE READ'S ANSWER, READ OFF THE WIRE**: every person's newest
 * record, each checked to be a person record of `company` named as it says.
 * Nothing is opened and nothing is believed here: opening takes the company's
 * key, and whose filing is believed is the reader's to judge.
 */
export const peopleOnTheWire = (answer: unknown, company: string): PersonOnTheWire[] => {
  const people = (answer as { people?: unknown } | null)?.people;
  if (!Array.isArray(people)) throw new Error('the service did not send the company\'s people, so none were read. That is not a payroll with nobody on it.');
  return people.map((row: { filed?: CompanyWireVersion; handedOver?: unknown }) => {
    const id = row?.filed?.id;
    if (typeof id !== 'string') throw new Error('one of the people the service sent is not named, so the list was not read.');
    return { rec: fromCompanyWire(row.filed, { company, kind: 'person', id }).sealed, handedOver: row.handedOver === true };
  });
};

/**
 * **WHY A PERSON IS NOT PAYABLE, OR NULL WHEN THEY ARE.** Only an active
 * person is paid, and only at what their own wallet signed: the code sealed in
 * their record (`payeeCode`) must be a payee's, signed by the wallet that
 * handed it over, for this company, and name exactly the address and payslip
 * key the record pays and seals to. A seat that files a version with another
 * address, or a person carried over with no code, is refused here by every
 * reader - the people read on a device, the screens' read, and (when raising
 * runs moves onto the device) the run builder.
 */
export const whyNotPayable = (person: RosterEmployee, company: string): string | null => {
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
    if (why !== null) throw new Error(`${p.id} is active and not payable, because ${why}, so the people were not read.`);
  }
  return people;
};
