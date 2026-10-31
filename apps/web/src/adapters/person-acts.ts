import { tidyFingerprint } from 'midnight-identity/profile/fingerprint';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { admitPersonInTheWallet, changePersonInTheWallet } from 'vaults-web-shared/person-in-the-wallet.js';
import { assets, type AssetId } from '../../../../src/core/assets.js';
import { EMPLOYEE_CLASSIFICATIONS, type EmployeeClassification } from '../../../../src/core/invitation.js';
import { ADMIT_BY, type AdmitBy } from './company-records.js';
import { namedFor } from './create-vault.js';
import { MADE, PROBLEM as AMOUNT_PROBLEM, TERMS, unitsOf } from './invite.js';
import { keyringFor } from './keyring-person.js';
import { ACT_REFUSAL, refusalOf, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';

/** The two acts a person's or a vendor's record goes through in the wallet. */
export const PERSON_ACT = { admit: 'admit-person', change: 'change-person' } as const;
export type PersonAct = (typeof PERSON_ACT)[keyof typeof PERSON_ACT];

/**
 * Why an act stopped, in the page's own terms. A stop the page prevents by what it asks (a person named wrongly, a status asked
 * with details, an amount missing) is `askedWrongly`: the page cannot get there by a press, and says only that the wallet would not.
 * A stop the wallet gave in a key this page does not know, or none at all, is `other` or `stopped`.
 */
export const WHY = {
  notACompany: 'not-a-company', noSavedKeys: 'no-saved-keys', noSeat: 'no-seat', seatNotHeld: 'seat-not-held', notOnChain: 'not-on-chain',
  rosterNotOpened: 'roster-not-opened', notBelieved: 'not-believed', notFound: 'not-found', notAsShown: 'not-as-shown', notFiled: 'not-filed',
  fingerprintNeeded: 'fingerprint-needed', fingerprintNotNeeded: 'fingerprint-not-needed', notAdmitted: 'not-admitted',
  notChanged: 'not-changed', dateRaised: 'date-raised', termsRaised: 'terms-raised',
  filedNotEntered: 'filed-not-entered', filedNotEnteredNorAnchored: 'filed-not-entered-nor-anchored',
  askedWrongly: 'asked-wrongly', stopped: 'stopped', other: 'other',
} as const;
export type PersonWhy = (typeof WHY)[keyof typeof WHY];

const SEAT: Readonly<Record<string, PersonWhy>> = {
  'not-a-company': WHY.notACompany, 'no-saved-keys': WHY.noSavedKeys, 'no-seat': WHY.noSeat, 'seat-not-held': WHY.seatNotHeld,
  'not-on-chain': WHY.notOnChain, 'roster-not-opened': WHY.rosterNotOpened,
  'not-believed': WHY.notBelieved, 'not-found': WHY.notFound, 'not-as-shown': WHY.notAsShown, 'not-filed': WHY.notFiled,
  'filed-not-entered': WHY.filedNotEntered, 'filed-not-entered-nor-anchored': WHY.filedNotEnteredNorAnchored,
};
const WRONGLY = ['not-a-person', 'no-person'] as const;
/** Each wallet key, after `act.<act>.why.`, as the page's code; a key not listed for the act is `other`. */
const CODE_OF: Readonly<Record<PersonAct, Readonly<Record<string, PersonWhy>>>> = {
  [PERSON_ACT.admit]: {
    ...SEAT, ...Object.fromEntries(WRONGLY.map((k) => [k, WHY.askedWrongly])), 'not-a-fingerprint': WHY.askedWrongly,
    'no-fingerprint': WHY.fingerprintNeeded, 'fingerprint-not-checked': WHY.fingerprintNotNeeded, 'not-admitted': WHY.notAdmitted,
  },
  [PERSON_ACT.change]: {
    ...SEAT, ...Object.fromEntries([...WRONGLY, 'not-for-this-kind', 'cleared-and-given', 'not-a-status', 'not-an-asset', 'no-pay', 'not-terms', 'nothing',
      'status-and-details', 'pay-incomplete', 'no-classification'].map((k) => [k, WHY.askedWrongly])),
    'not-changed': WHY.notChanged, 'date-raised': WHY.dateRaised, 'terms-raised': WHY.termsRaised,
  },
};

/** A stop that may have filed the record or left it not yet entered in the company's records: a second press finishes it, so the page reads again. */
const PARTLY: ReadonlySet<PersonWhy> = new Set<PersonWhy>([WHY.filedNotEntered, WHY.filedNotEnteredNorAnchored, WHY.stopped, WHY.other]);

const KEY = /^act\.([a-z-]+)\.why\.([a-z-]+)$/u;

/** The page's code for a wallet's refusal key, for the act that was run; none given is a stop, and another act's key, or an unknown one, is `other`. */
export function whyOf(act: PersonAct, refused: string | undefined): PersonWhy {
  if (refused === undefined) return WHY.stopped;
  const m = KEY.exec(refused);
  return (m?.[1] === act ? CODE_OF[act][m[2]!] : undefined) ?? WHY.other;
}

/** What a press came to. */
export const PERSON_ACTED = { done: 'done', stopped: 'stopped', refused: 'refused', problem: 'problem' } as const;

/** What the page found wrong with what was typed, before the wallet was asked. */
export const PROBLEM = {
  noFingerprint: 'no-fingerprint', badFingerprint: 'bad-fingerprint', noAmount: 'no-amount', badAmount: 'bad-amount', zeroAmount: 'zero-amount',
  tooManyDecimals: 'too-many-decimals', noAsset: 'no-asset', noDate: 'no-date', badDate: 'bad-date', noClassification: 'no-classification',
} as const;
export type PersonProblem = (typeof PROBLEM)[keyof typeof PROBLEM];

/** `handedOver`: the wallet handed the page transactions before it stopped (sent or not confirmed), whatever the reason, so "nothing was done" is not true. */
export type PersonActed =
  | { readonly of: typeof PERSON_ACTED.done; readonly state: string | null }
  | { readonly of: typeof PERSON_ACTED.stopped; readonly act: PersonAct; readonly why: PersonWhy; readonly partial: boolean; readonly handedOver: boolean }
  | { readonly of: typeof PERSON_ACTED.refused; readonly why: ActRefusal }
  | { readonly of: typeof PERSON_ACTED.problem; readonly problem: PersonProblem };

const refused = (why: ActRefusal): PersonActed => ({ of: PERSON_ACTED.refused, why });
const problem = (why: PersonProblem): PersonActed => ({ of: PERSON_ACTED.problem, problem: why });
const STATE = 'state';
/** The wallet's words for the kind of record an act is for. */
export const PERSON_KIND = { employee: 'employee', vendor: 'vendor' } as const;
export type PersonKind = (typeof PERSON_KIND)[keyof typeof PERSON_KIND];
/** The wallet's word for a person made a leaver, sent and never shown. */
const WIRE = { leaver: 'leaver' } as const;

type Ended = Awaited<ReturnType<typeof admitPersonInTheWallet>>;
function actedOf(act: PersonAct, ended: Ended): PersonActed {
  if (ended.of === PERSON_ACTED.done) {
    const state = ended.outcome?.[STATE];
    return { of: PERSON_ACTED.done, state: typeof state === 'string' ? state : null };
  }
  const why = whyOf(act, ended.refused);
  return { of: PERSON_ACTED.stopped, act, why, partial: PARTLY.has(why), handedOver: ended.relayed > 0 || ended.unconfirmed > 0 };
}

/** The company's record, label and account, and the person signed in, or the refusal that stops the press before the wallet is asked. */
async function namedBefore(personId: string, companyId: string): Promise<{ record: string; company: CompanyLabel; account: AccountAddress } | ActRefusal> {
  if (ACCOUNT_ORIGIN === '') return ACT_REFUSAL.notSetUp;
  if (!(await keyringFor(personId))) return ACT_REFUSAL.notSignedIn;
  const named = await namedFor(companyId);
  return named === null ? ACT_REFUSAL.didNotFinish : { record: named.record, company: named.company as CompanyLabel, account: named.account as AccountAddress };
}

const steps = (onStep?: (step: number, steps: number) => void) => (onStep === undefined ? {} : { onStep: (at: { step: number; steps: number }) => onStep(at.step, at.steps) });

/**
 * Admit a person or a vendor (`kind`, an employee when none is given) who handed their code over. One admitted on a fingerprint is
 * sent the one typed, tidied the way the wallet reads it, or nothing is asked of the wallet when none was typed or it is not one;
 * one admitted on their wallet's signed claim is sent none, whatever was typed, since the wallet refuses a fingerprint it would
 * check against nothing.
 */
export async function admitPerson(
  personId: string, companyId: string, who: { readonly id: string; readonly name: string; readonly kind?: PersonKind; readonly admitBy: AdmitBy; readonly fingerprint?: string },
  onStep?: (step: number, steps: number) => void,
): Promise<PersonActed> {
  try {
    let fingerprint: string | undefined;
    if (who.admitBy === ADMIT_BY.fingerprint) {
      if ((who.fingerprint ?? '').trim() === '') return problem(PROBLEM.noFingerprint);
      const tidy = tidyFingerprint(who.fingerprint!);
      if (tidy === null) return problem(PROBLEM.badFingerprint);
      fingerprint = tidy;
    }
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await admitPersonInTheWallet({ ...named, kind: who.kind ?? PERSON_KIND.employee, person: who.id, name: who.name, ...(fingerprint === undefined ? {} : { fingerprint }) }, ACCOUNT_ORIGIN, steps(onStep));
    return actedOf(PERSON_ACT.admit, ended);
  } catch (e) {
    return refused(refusalOf(e));
  }
}

/** The working times a person can be moved between, as the wallet reads them (the page says each in its own words). */
export const CLASSIFICATIONS = EMPLOYEE_CLASSIFICATIONS;

/** The ways a person's record is changed, each its own act: the wallet refuses a status asked together with details. */
export const CHANGE = { pay: 'pay', classification: 'classification', endDate: 'endDate', leavingDate: 'leavingDate', leave: 'leave' } as const;
export type PersonChange =
  | { readonly kind: typeof CHANGE.pay; readonly amount: string; readonly from: string }
  | { readonly kind: typeof CHANGE.classification; readonly classification: string; readonly from: string }
  | { readonly kind: typeof CHANGE.endDate | typeof CHANGE.leavingDate; readonly day: string | null }
  | { readonly kind: typeof CHANGE.leave; readonly day: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const isDay = (s: string): boolean => DAY.test(s) && !Number.isNaN(Date.parse(s)) && new Date(Date.parse(s)).toISOString().slice(0, 10) === s;

/** A day typed for a change: missing, or not a calendar date. */
const dayProblem = (day: string): PersonProblem | null => (day === '' ? PROBLEM.noDate : isDay(day) ? null : PROBLEM.badDate);

const AMOUNT_PROBLEMS: Readonly<Record<string, PersonProblem>> = {
  [AMOUNT_PROBLEM.noAmount]: PROBLEM.noAmount, [AMOUNT_PROBLEM.zeroAmount]: PROBLEM.zeroAmount, [AMOUNT_PROBLEM.tooManyDecimals]: PROBLEM.tooManyDecimals,
};

/**
 * Change one thing about a person, in their own token for pay. The amount is read in the token's decimals into its smallest unit;
 * a day is a calendar date; a date taken off is cleared, never sent empty; marking a person as left is a status on its own,
 * with a leaving date only when one was typed. The wallet checks the months already raised.
 */
export async function changePerson(
  personId: string, companyId: string, person: { readonly id: string; readonly name: string; readonly asset: string }, change: PersonChange,
  onStep?: (step: number, steps: number) => void,
): Promise<PersonActed> {
  try {
    let asked: Parameters<typeof changePersonInTheWallet>[0]['change'];
    if (change.kind === CHANGE.pay) {
      const asset = assets.find(person.asset as AssetId);
      if (asset === null) return problem(PROBLEM.noAsset);
      const got = unitsOf(change.amount, asset);
      if (got.of !== MADE.units) return problem(AMOUNT_PROBLEMS[got.problem] ?? PROBLEM.badAmount);
      const wrong = dayProblem(change.from);
      if (wrong !== null) return problem(wrong);
      asked = { pay: { amount: got.units, asset: asset.code, from: change.from } };
    } else if (change.kind === CHANGE.classification) {
      const kinds: readonly string[] = EMPLOYEE_CLASSIFICATIONS;
      if (!kinds.includes(change.classification)) return problem(PROBLEM.noClassification);
      const wrong = dayProblem(change.from);
      if (wrong !== null) return problem(wrong);
      asked = { classification: { classification: change.classification as EmployeeClassification, from: change.from } };
    } else if (change.kind === CHANGE.leave) {
      const wrong = change.day === '' ? null : dayProblem(change.day);
      if (wrong !== null) return problem(wrong);
      asked = { status: WIRE.leaver, ...(change.day === '' ? {} : { leavingDate: change.day }) };
    } else {
      const wrong = change.day === null ? null : dayProblem(change.day);
      if (wrong !== null) return problem(wrong);
      asked = { [change.kind]: change.day };
    }
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await changePersonInTheWallet({ ...named, kind: PERSON_KIND.employee, person: person.id, name: person.name, change: asked }, ACCOUNT_ORIGIN, steps(onStep));
    return actedOf(PERSON_ACT.change, ended);
  } catch (e) {
    return refused(refusalOf(e));
  }
}

/** The two things about a vendor that change: how they are paid, and the day they stop being paid. */
export const VENDOR_CHANGE = { terms: 'terms', endDate: 'endDate' } as const;
export type VendorChange =
  | { readonly kind: typeof VENDOR_CHANGE.terms; readonly terms: typeof TERMS.oneOff }
  | { readonly kind: typeof VENDOR_CHANGE.terms; readonly terms: typeof TERMS.monthly; readonly asset: string; readonly amount: string }
  | { readonly kind: typeof VENDOR_CHANGE.endDate; readonly day: string | null };

/**
 * Change one thing about a vendor. Monthly terms are read in the named token's decimals into its smallest unit, and name a token
 * this app knows; one-off terms carry no amount; an end date is a calendar date, and one taken off is cleared, never sent empty.
 * The wallet refuses terms once any month is raised, and an end date in or before a raised month.
 */
export async function changeVendor(
  personId: string, companyId: string, vendor: { readonly id: string; readonly name: string }, change: VendorChange,
  onStep?: (step: number, steps: number) => void,
): Promise<PersonActed> {
  try {
    let asked: Parameters<typeof changePersonInTheWallet>[0]['change'];
    if (change.kind === VENDOR_CHANGE.endDate) {
      const wrong = change.day === null ? null : dayProblem(change.day);
      if (wrong !== null) return problem(wrong);
      asked = { endDate: change.day };
    } else if (change.terms === TERMS.oneOff) {
      asked = { terms: { kind: TERMS.oneOff } };
    } else {
      const asset = assets.find(change.asset as AssetId);
      if (asset === null) return problem(PROBLEM.noAsset);
      const got = unitsOf(change.amount, asset);
      if (got.of !== MADE.units) return problem(AMOUNT_PROBLEMS[got.problem] ?? PROBLEM.badAmount);
      asked = { terms: { kind: TERMS.monthly, asset: asset.code, amount: got.units } };
    }
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await changePersonInTheWallet({ ...named, kind: PERSON_KIND.vendor, person: vendor.id, name: vendor.name, change: asked }, ACCOUNT_ORIGIN, steps(onStep));
    return actedOf(PERSON_ACT.change, ended);
  } catch (e) {
    return refused(refusalOf(e));
  }
}
