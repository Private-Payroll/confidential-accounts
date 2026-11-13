import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { api } from 'vaults-web-shared/keyring.js';
import { GRANT_STATE, grantOutcomeOf, grantReadInTheWallet, type GrantAsked } from 'vaults-web-shared/proposal-in-the-wallet.js';
import { grantsHere, grantsServedBy } from 'vaults-web-shared/purpose-wraps.js';
import type { ActOutcome } from 'vaults-web-shared/wallet-act.js';
import { canonical } from '../../../../src/core/crypto.js';
import { isReaderRole, READER_ROLES, type ReaderRole } from '../../../../src/core/roles.js';
import { grantsChangeCounted, grantsMessage, narrowsOnly, type GrantEntry } from '../../../../src/midnight/grants-record.js';
import { namedFor } from './create-vault.js';
import { keyringFor } from './keyring-person.js';
import { ACT_REFUSAL, refusalOf, SEAT_REFUSALS, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { seatAndRecordsHere } from './vault-private-money.js';

/*
 * WHO READS THE COMPANY'S RECORDS AND WHAT WAITS FOR MORE SIGNERS, read from the company's read grants with the company key the
 * person's wallet released on this visit, and the asks of the wallet that change them: give a reader access from the code their
 * own wallet made, take it away, and sign a change another signer began. The page holds no seat secret and no company key, and sends
 * nothing to the service; each change is signed by the person's seat inside the wallet.
 */

/** The roles a reader can be given. */
export { READER_ROLES };

export const GRANTS_READ = { read: 'read', refused: 'refused' } as const;

/** One reader the grants hold: who, the role they read as, and the key their wallet made for this company. */
export interface ReaderHeld {
  readonly recipient: string;
  readonly person: string;
  readonly role: ReaderRole;
}

/**
 * A change that has been signed by some of the signers and not yet by enough. `signed` is counted from the signatures themselves,
 * the way the grants are judged, and is null when a signature does not verify; `mine` says whether this seat's own signature is on it.
 */
export interface ChangeWaiting {
  readonly gives: readonly ReaderHeld[];
  readonly takesAway: readonly ReaderHeld[];
  readonly signed: number | null;
  readonly needed: number;
  readonly mine: boolean;
}

export type GrantsRead =
  | { readonly of: typeof GRANTS_READ.read; readonly readers: readonly ReaderHeld[]; readonly waiting: ChangeWaiting | null }
  | { readonly of: typeof GRANTS_READ.refused; readonly why: ActRefusal };

type Grants = Awaited<ReturnType<typeof grantsHere>>;

const heldOf = (e: GrantEntry): ReaderHeld => ({ recipient: e.recipient, person: e.person, role: e.role });

/** The waiting change as what it gives and what it takes away against the grants in force, or null when nothing waits or the bar is unread. */
function waitingOf(g: Grants, accountId: string, ownSeat: string): ChangeWaiting | null {
  const change = g.waiting?.grants;
  const needed = g.here.holders.seatBar;
  if (change === undefined || needed === undefined) return null;
  const base = g.inForce?.grants.entries ?? [];
  const counted = grantsChangeCounted(
    g.here.dir.seats, grantsMessage(accountId, change), change.signatures, (seat) => g.here.holders.seats.includes(seat.seat), narrowsOnly(base, change.entries),
  );
  const own = g.here.dir.seats.find((s) => s.seat === ownSeat)?.signingKey.toLowerCase();
  return {
    gives: change.entries.filter((e) => !base.some((b) => canonical(b) === canonical(e))).map(heldOf),
    takesAway: base.filter((b) => !change.entries.some((e) => e.recipient === b.recipient)).map(heldOf),
    signed: typeof counted === 'string' ? null : counted,
    needed,
    mine: own !== undefined && change.signatures.some((s) => s.publicKey.toLowerCase() === own),
  };
}

/**
 * Reads the grants in force and the change waiting, with this seat's own device records. Refused with the reason when the person's
 * wallet has not released the company's key on this visit, the grants are withheld or cannot be believed, or the seat is not in the
 * company's directory; nothing is read in that case.
 */
export async function readGrants(personId: string, companyId: string): Promise<GrantsRead> {
  try {
    const here = await seatAndRecordsHere(personId, companyId);
    if (typeof here === 'string') return { of: GRANTS_READ.refused, why: here };
    const g = await grantsHere({ accountId: companyId, versions: grantsServedBy((path) => api(path), companyId), directory: here.directory, me: here.mine });
    return { of: GRANTS_READ.read, readers: (g.inForce?.grants.entries ?? []).map(heldOf), waiting: waitingOf(g, companyId, here.leaf) };
  } catch (e) {
    return { of: GRANTS_READ.refused, why: refusalOf(e) };
  }
}

export const GRANT_WHY = {
  seat: 'seat', notACode: 'not-a-code', codeNotSigned: 'code-not-signed', codeAnotherCompany: 'code-another-company', notAsAsked: 'not-as-asked',
  filedMeanwhile: 'filed-meanwhile', notFiled: 'not-filed', stopped: 'stopped', other: 'other',
} as const;
export type GrantWhy = (typeof GRANT_WHY)[keyof typeof GRANT_WHY];

const WHY_OF_CODE: Readonly<Record<string, GrantWhy>> = {
  ...Object.fromEntries(SEAT_REFUSALS.map((c) => [c, GRANT_WHY.seat] as const)),
  'not-a-code': GRANT_WHY.notACode, 'not-a-reader-code': GRANT_WHY.notACode, 'key-from-the-code': GRANT_WHY.notACode,
  'code-not-signed': GRANT_WHY.codeNotSigned, 'code-another-company': GRANT_WHY.codeAnotherCompany,
  'not-a-key': GRANT_WHY.notAsAsked, 'not-a-choice': GRANT_WHY.notAsAsked, 'not-a-reader-role': GRANT_WHY.notAsAsked,
  'filed-meanwhile': GRANT_WHY.filedMeanwhile, 'not-filed': GRANT_WHY.notFiled,
};

/** A stop after which the change may be part filed, so the page reads the grants again before it asks twice. */
const PARTLY: ReadonlySet<GrantWhy> = new Set<GrantWhy>([GRANT_WHY.notFiled, GRANT_WHY.stopped, GRANT_WHY.other]);

const CODE = /^act\.grant-read\.why\.([a-z-]+)$/u;

function grantWhyOf(refused: string | undefined): GrantWhy {
  if (refused === undefined) return GRANT_WHY.stopped;
  const code = CODE.exec(refused)?.[1];
  return code !== undefined && Object.prototype.hasOwnProperty.call(WHY_OF_CODE, code) ? WHY_OF_CODE[code]! : GRANT_WHY.other;
}

export const GRANT_ACTED = { done: 'done', stopped: 'stopped', refused: 'refused', problem: 'problem' } as const;

/** What is wrong with a give typed on the page, before the wallet is asked: no code, or no role a reader can have. */
export const GRANT_PROBLEM = { noCode: 'no-code', noRole: 'no-role' } as const;
type GrantProblem = (typeof GRANT_PROBLEM)[keyof typeof GRANT_PROBLEM];

export type GrantActed =
  | { readonly of: typeof GRANT_ACTED.done; readonly state: string | null; readonly signed: number | null; readonly needed: number | null }
  | { readonly of: typeof GRANT_ACTED.stopped; readonly why: GrantWhy; readonly partial: boolean; readonly handedOver: boolean }
  | { readonly of: typeof GRANT_ACTED.refused; readonly why: ActRefusal }
  | { readonly of: typeof GRANT_ACTED.problem; readonly problem: GrantProblem };

/** Ended means the change is in force, or the wallet's stop with whether anything may already have gone through. */
function actedOf(ended: ActOutcome): GrantActed {
  if (ended.of === GRANT_ACTED.done) return { of: GRANT_ACTED.done, ...grantOutcomeOf(ended) };
  const why = grantWhyOf(ended.refused);
  return { of: GRANT_ACTED.stopped, why, partial: PARTLY.has(why), handedOver: ended.relayed > 0 || ended.unconfirmed > 0 };
}

export async function namedBefore(personId: string, companyId: string): Promise<{ record: string; company: CompanyLabel; account: AccountAddress } | ActRefusal> {
  if (ACCOUNT_ORIGIN === '') return ACT_REFUSAL.notSetUp;
  if (!(await keyringFor(personId))) return ACT_REFUSAL.notSignedIn;
  const named = await namedFor(companyId);
  return named === null ? ACT_REFUSAL.didNotFinish : { record: named.record, company: named.company as CompanyLabel, account: named.account as AccountAddress };
}

export const onStepOf = (onStep?: (step: number, steps: number) => void) => (onStep === undefined ? {} : { onStep: (at: { step: number; steps: number }) => onStep(at.step, at.steps) });

async function askWallet(personId: string, companyId: string, asked: GrantAsked, onStep?: (step: number, steps: number) => void): Promise<GrantActed> {
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return { of: GRANT_ACTED.refused, why: named };
    return actedOf(await grantReadInTheWallet({ ...named, ...asked }, ACCOUNT_ORIGIN, onStepOf(onStep)));
  } catch (e) {
    return { of: GRANT_ACTED.refused, why: refusalOf(e) };
  }
}

/** Gives a reader access from the code their own wallet made for this company; the wallet checks the code and shows who it is for before it signs. */
export async function giveReadAccess(
  personId: string, companyId: string, asked: { readonly code: string; readonly role: string }, onStep?: (step: number, steps: number) => void,
): Promise<GrantActed> {
  const code = asked.code.trim();
  if (code === '') return { of: GRANT_ACTED.problem, problem: GRANT_PROBLEM.noCode };
  if (!isReaderRole(asked.role)) return { of: GRANT_ACTED.problem, problem: GRANT_PROBLEM.noRole };
  return askWallet(personId, companyId, { code, role: asked.role }, onStep);
}

/** Takes a reader's access away, naming their key as the grants in force hold it. */
export const takeAwayReadAccess = (personId: string, companyId: string, recipient: string, onStep?: (step: number, steps: number) => void): Promise<GrantActed> =>
  askWallet(personId, companyId, { takeAway: recipient.toLowerCase() }, onStep);

/** What the grants show after this seat signed a waiting change: in force, this seat's signature on that change, another change, or unread. */
export const CARRIES = { inForce: 'in-force', signed: 'signed', notTheWaitingChange: 'not-the-waiting-change', unread: 'unread' } as const;
export type Carries = (typeof CARRIES)[keyof typeof CARRIES];

/** Whether an ask takes a reader's access away, rather than giving it from a code. */
const takesAway = (asked: GrantAsked): asked is Extract<GrantAsked, { readonly takeAway: string }> => (asked as { readonly takeAway?: string }).takeAway !== undefined;

/** Whether two waiting changes give the same roles to the same readers and take the same readers away, in any order. */
const sameChange = (a: Pick<ChangeWaiting, 'gives' | 'takesAway'>, b: Pick<ChangeWaiting, 'gives' | 'takesAway'>): boolean =>
  a.gives.length === b.gives.length && a.takesAway.length === b.takesAway.length
  && a.gives.every((g) => b.gives.some((h) => h.recipient === g.recipient && h.role === g.role))
  && b.gives.every((g) => a.gives.some((h) => h.recipient === g.recipient && h.role === g.role))
  && a.takesAway.every((r) => b.takesAway.some((h) => h.recipient === r.recipient))
  && b.takesAway.every((r) => a.takesAway.some((h) => h.recipient === r.recipient));

/**
 * Signs the change that waits, with the same ask that made it (a give with the reader's code again, a take-away by the reader's key),
 * then reads the grants again to say whether the change that waits now carries this seat's signature: a code or a role that made a
 * different change does not sign this one, and is told as not the waiting change.
 */
export async function approveWaitingChange(
  personId: string, companyId: string, asked: GrantAsked, waiting: ChangeWaiting, onStep?: (step: number, steps: number) => void,
): Promise<{ readonly acted: GrantActed; readonly carries: Carries | null }> {
  const acted = await askWallet(personId, companyId, takesAway(asked) ? { takeAway: asked.takeAway.toLowerCase() } : { code: asked.code.trim(), role: asked.role }, onStep);
  if (acted.of !== GRANT_ACTED.done) return { acted, carries: null };
  if (acted.state === GRANT_STATE.inForce) return { acted, carries: CARRIES.inForce };
  const now = await readGrants(personId, companyId);
  const w = now.of === GRANTS_READ.read ? now.waiting : null;
  if (now.of !== GRANTS_READ.read) return { acted, carries: CARRIES.unread };
  return { acted, carries: w !== null && w.mine && sameChange(w, waiting) ? CARRIES.signed : CARRIES.notTheWaitingChange };
}
