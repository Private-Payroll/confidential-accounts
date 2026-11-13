import { actOnACompanyInTheWallet } from 'vaults-web-shared/keyring.js';
import { changeRoleInTheWallet, changeRoleOutcomeOf, ROLE_STAGE } from 'vaults-web-shared/proposal-in-the-wallet.js';
import type { ActOutcome } from 'vaults-web-shared/wallet-act.js';
import { isSignerRole, mayFile, mayInvite, READER_PURPOSES, RIGHTS_PRESET, ROLES, SIGNER_ROLES, type ReaderRole, type Role, type SignerRole } from '../../../../src/core/roles.js';
import type { Purpose } from '../../../../src/core/sealed-records.js';
import { changeHoldersOf, whatAChangeCosts, type ChangeHolders } from '../../../../src/core/change-costs.js';
import { namedBefore, onStepOf } from './grants-here.js';
import { addressIsPrivate } from './invite.js';
import { CHANGE_ASKED, SEAT_CHANGE } from './change-asked.js';
import { refusalOf, SEAT_REFUSALS, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { seatAndRecordsHere } from './vault-private-money.js';

/*
 * WHO HOLDS A SEAT AND THE ASK OF THE WALLET TO CHANGE A SIGNER'S ROLE. The seats are read from the company's directory with the company
 * key the person's wallet released on this visit, and named by the roster; the change is signed by the person's seat inside the wallet,
 * in the two steps a seat's fixed role makes of it: the seat's removal, then the person invited at the new role. The page holds no
 * seat secret, no company key and no invitation token: the wallet makes the token, keeps it with what the first step confirmed, and
 * shows the invitation's link in its own window. What the page keeps between the two steps is what it asked, in memory for the visit
 * only; the wallet checks the second ask against the first, and never lets the page change the role or the address in between.
 */

/** The roles a signer's seat can be changed to. */
export { SIGNER_ROLES };
export type { ChangeHolders };

/** One of the company's five roles and what it may do, every figure read off the one list of roles and never held here. */
export interface RoleRow {
  readonly role: Role;
  /** A signer role holds a seat; a reader role holds none. */
  readonly seat: boolean;
  readonly mayRaise: boolean;
  readonly mayApprove: boolean;
  readonly mayHold: boolean;
  readonly mayInvite: boolean;
  /** The role files every kind of record the company has, as an admin does. */
  readonly filesEvery: boolean;
  /** The purposes a reader's read grant names; none for a signer, who holds the company key. */
  readonly reads: readonly Purpose[];
}

const rowOf = (role: Role): RoleRow => {
  const signer = (SIGNER_ROLES as readonly string[]).includes(role);
  const rights = signer ? RIGHTS_PRESET[role as SignerRole] : { mayRaise: false, mayApprove: false, mayHold: false };
  return {
    role, seat: signer, ...rights, mayInvite: mayInvite({ role }), filesEvery: mayFile({ role }).length === mayFile({ role: 'admin' }).length,
    reads: signer ? [] : READER_PURPOSES[role as ReaderRole],
  };
};

/** Every role, the signer roles first. */
export const ROLE_TABLE: readonly RoleRow[] = ROLES.map(rowOf);

export const ROLES_READ = { read: 'read', refused: 'refused' } as const;

/** One seat the company's directory holds: its leaf, the name the roster gives its person, the role it was invited at (null for the founding seat), and whether it is the person's own or is being removed. */
export interface SeatHeld {
  readonly leaf: string;
  readonly name: string;
  readonly role: SignerRole | null;
  readonly you: boolean;
  readonly leaving: boolean;
}

export type RolesRead =
  | { readonly of: typeof ROLES_READ.read; readonly seats: readonly SeatHeld[]; readonly holders: ChangeHolders }
  | { readonly of: typeof ROLES_READ.refused; readonly why: ActRefusal };

/** The seats a role change can be made on and the approvals the account holds, or why the directory was not read; nothing is read without the company key released on this visit. */
export async function readRoles(personId: string, companyId: string): Promise<RolesRead> {
  try {
    const here = await seatAndRecordsHere(personId, companyId);
    if (typeof here === 'string') return { of: ROLES_READ.refused, why: here };
    const { dir, holders } = await here.directory();
    const names = new Map(here.opened.signers.flatMap((s) => (s.leafCommitment === null ? [] : [[s.leafCommitment.toLowerCase(), s.name] as const])));
    const held = new Set(holders.seats.map((s) => s.toLowerCase()));
    const seats = dir.seats
      .filter((s) => s.retired === null || held.has(s.seat.toLowerCase()))
      .map((s): SeatHeld => {
        const id = s.seat.toLowerCase();
        return { leaf: id, name: names.get(id) ?? s.person, role: isSignerRole(s.role) ? s.role : null, you: s.seat === here.leaf, leaving: s.retired !== null };
      });
    return {
      of: ROLES_READ.read, seats,
      holders: changeHoldersOf(holders),
    };
  } catch (e) {
    return { of: ROLES_READ.refused, why: refusalOf(e) };
  }
}

/** What a role change makes public, whatever the role: the seat leaving and a seat joining, each read from what a change of who is seated costs, and the approvals each of its two steps needs. */
export function roleChangeCosts(held: ChangeHolders): { readonly leaves: boolean; readonly joins: boolean; readonly needed: number } {
  const out = whatAChangeCosts(held, { kind: CHANGE_ASKED.seating, seat: SEAT_CHANGE.remove });
  const into = whatAChangeCosts(held, { kind: CHANGE_ASKED.seating, seat: SEAT_CHANGE.add });
  return {
    leaves: out.publicFacts.some((f) => f.fact === 'a-seat-leaves'),
    joins: into.publicFacts.some((f) => f.fact === 'a-seat-joins'),
    needed: out.needed,
  };
}

/** What the page can see is wrong with a change before it asks the wallet anything. */
export const ROLE_PROBLEM = { noSeat: 'no-seat', noName: 'no-name', badAddress: 'bad-address', noRole: 'no-role', sameRole: 'same-role', notBegun: 'not-begun' } as const;
type RoleProblem = (typeof ROLE_PROBLEM)[keyof typeof ROLE_PROBLEM];

export const ROLE_WHY = {
  seat: 'seat', removalUnderWay: 'removal-under-way', fewerApprovalsFirst: 'fewer-approvals-first', notAsStarted: 'not-as-started',
  notStartedHere: 'not-started-here', notAnAddress: 'not-an-address', notAsAsked: 'not-as-asked', stopped: 'stopped', other: 'other',
} as const;
export type RoleWhy = (typeof ROLE_WHY)[keyof typeof ROLE_WHY];

const WHY_OF_CODE: Readonly<Record<string, RoleWhy>> = {
  ...Object.fromEntries(SEAT_REFUSALS.map((c) => [c, ROLE_WHY.seat] as const)),
  'removal-under-way': ROLE_WHY.removalUnderWay, 'fewer-approvals-first': ROLE_WHY.fewerApprovalsFirst,
  'not-as-started': ROLE_WHY.notAsStarted, 'not-started-here': ROLE_WHY.notStartedHere,
  'not-an-address': ROLE_WHY.notAnAddress, 'not-a-change-of-role': ROLE_WHY.notAsAsked, refused: ROLE_WHY.notAsAsked,
};

/** A stop after which the removal or the invitation may be part raised, so the page reads the seats again before it asks twice. */
const PARTLY: ReadonlySet<RoleWhy> = new Set<RoleWhy>([ROLE_WHY.stopped, ROLE_WHY.other]);

const CODE = /^act\.change-role\.why\.([a-z-]+)$/u;

function whyOf(refused: string | undefined): RoleWhy {
  if (refused === undefined) return ROLE_WHY.stopped;
  const code = CODE.exec(refused)?.[1];
  return code !== undefined && Object.prototype.hasOwnProperty.call(WHY_OF_CODE, code) ? WHY_OF_CODE[code]! : ROLE_WHY.other;
}

/** The wallet's name for the act that drops a role change it keeps, and the name of the outcome it gives; sent and read, never shown. */
const DROP_ROLE_CHANGE = { act: 'drop-role-change', state: 'state' } as const;

export const CHANGE_ACTED = { done: 'done', stopped: 'stopped', refused: 'refused', problem: 'problem', dropped: 'dropped' } as const;

export type ChangeActed =
  | { readonly of: typeof CHANGE_ACTED.done; readonly stage: string | null; readonly state: string | null; readonly approvals: number | null; readonly needed: number | null }
  | { readonly of: typeof CHANGE_ACTED.stopped; readonly why: RoleWhy; readonly partial: boolean; readonly handedOver: boolean }
  | { readonly of: typeof CHANGE_ACTED.refused; readonly why: ActRefusal }
  | { readonly of: typeof CHANGE_ACTED.problem; readonly problem: RoleProblem }
  | { readonly of: typeof CHANGE_ACTED.dropped; readonly state: string | null };

/** A change the person began: what the wallet was told, which the second step asks again. */
interface BegunChange {
  readonly leaf: string;
  readonly name: string;
  readonly role: SignerRole;
  readonly address: string;
}
/** The changes begun on this visit, by company and seat. Never written to the browser's storage: a reload forgets them, and the page then says to invite the person at the new role. */
const BEGUN = new Map<string, Map<string, BegunChange>>();
/** The changes begun here for one company, by seat, made the first time one is kept. */
const begunFor = (companyId: string): Map<string, BegunChange> => {
  const kept = BEGUN.get(companyId);
  if (kept !== undefined) return kept;
  const made = new Map<string, BegunChange>();
  BEGUN.set(companyId, made);
  return made;
};
const seatOf = (leaf: string): string => leaf.toLowerCase();
const sameAs = (a: BegunChange, b: BegunChange): boolean => a.leaf === b.leaf && a.name === b.name && a.role === b.role && a.address === b.address;

/** The changes begun here for the company whose second step is still to be asked. */
export const startedRoleChanges = (companyId: string): readonly BegunChange[] =>
  [...(BEGUN.get(companyId)?.values() ?? [])].map((v) => ({ leaf: v.leaf, name: v.name, role: v.role, address: v.address }));

function actedOf(ended: ActOutcome): ChangeActed {
  if (ended.of === CHANGE_ACTED.done) return { of: CHANGE_ACTED.done, ...changeRoleOutcomeOf(ended) };
  const why = whyOf(ended.refused);
  return { of: CHANGE_ACTED.stopped, why, partial: PARTLY.has(why), handedOver: ended.relayed > 0 || ended.unconfirmed > 0 };
}

async function askWallet(personId: string, companyId: string, begun: BegunChange, onStep?: (step: number, steps: number) => void): Promise<ChangeActed> {
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return { of: CHANGE_ACTED.refused, why: named };
    const key = seatOf(begun.leaf);
    const kept = BEGUN.get(companyId)?.get(key);
    const acted = actedOf(await changeRoleInTheWallet({ ...named, leaf: begun.leaf, role: begun.role, address: begun.address, personName: begun.name }, ACCOUNT_ORIGIN, onStepOf(onStep)));
    const stage = acted.of === CHANGE_ACTED.done ? acted.stage : null;
    const mayHaveBegun = acted.of === CHANGE_ACTED.done ? stage === ROLE_STAGE.remove : acted.of === CHANGE_ACTED.stopped && acted.partial;
    if (stage === ROLE_STAGE.invite) BEGUN.get(companyId)?.delete(key);
    else if (mayHaveBegun && (kept === undefined || sameAs(kept, begun))) begunFor(companyId).set(key, begun);
    return acted;
  } catch (e) {
    return { of: CHANGE_ACTED.refused, why: refusalOf(e) };
  }
}

/**
 * Asks the wallet to change a seat's role: the seat's removal first, then, on the same ask, the invitation at the new role. The
 * address is the one the person's wallet gave, typed in full and checked as a private one; the name is the roster's. A role that is not
 * a signer's, or is the seat's own, is refused here and the wallet is asked nothing.
 */
export async function changeRole(
  personId: string, companyId: string, asked: { readonly leaf: string; readonly current: string | null; readonly role: string; readonly address: string; readonly name: string },
  onStep?: (step: number, steps: number) => void,
): Promise<ChangeActed> {
  if (asked.leaf.trim() === '') return { of: CHANGE_ACTED.problem, problem: ROLE_PROBLEM.noSeat };
  const name = asked.name.trim();
  const address = asked.address.trim();
  if (name === '') return { of: CHANGE_ACTED.problem, problem: ROLE_PROBLEM.noName };
  if (!isSignerRole(asked.role)) return { of: CHANGE_ACTED.problem, problem: ROLE_PROBLEM.noRole };
  if (asked.role === (asked.current ?? 'admin')) return { of: CHANGE_ACTED.problem, problem: ROLE_PROBLEM.sameRole };
  if (!addressIsPrivate(address)) return { of: CHANGE_ACTED.problem, problem: ROLE_PROBLEM.badAddress };
  return askWallet(personId, companyId, { leaf: asked.leaf.toLowerCase(), name, role: asked.role, address }, onStep);
}

/** Asks the second step of a change begun on this visit, with exactly what the first was asked with. */
export async function continueRoleChange(personId: string, companyId: string, leaf: string, onStep?: (step: number, steps: number) => void): Promise<ChangeActed> {
  const kept = BEGUN.get(companyId)?.get(seatOf(leaf));
  if (kept === undefined) return { of: CHANGE_ACTED.problem, problem: ROLE_PROBLEM.notBegun };
  return askWallet(personId, companyId, { leaf: kept.leaf, name: kept.name, role: kept.role, address: kept.address }, onStep);
}


/**
 * Asks the wallet to drop the role change it keeps for one seat, so a change abandoned before its invitation was filed leaves nothing
 * behind. The wallet sends nothing and changes nothing on the network or in the company's records; a removal already raised stays
 * raised. The page forgets its own note of the change only once the wallet says it holds none (dropped, or not kept), never on a
 * refusal, so a change the wallet still keeps stays listed and can still be continued.
 */
export async function dropRoleChange(personId: string, companyId: string, leaf: string, onStep?: (step: number, steps: number) => void): Promise<ChangeActed> {
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return { of: CHANGE_ACTED.refused, why: named };
    const ended = await actOnACompanyInTheWallet({ name: DROP_ROLE_CHANGE.act, ...named, leaf: leaf.toLowerCase() }, ACCOUNT_ORIGIN, onStepOf(onStep));
    if (ended.of !== CHANGE_ACTED.done) return { of: CHANGE_ACTED.stopped, why: whyOf(ended.refused), partial: false, handedOver: false };
    const state = ended.outcome?.[DROP_ROLE_CHANGE.state];
    if (state === 'dropped' || state === 'not-kept') BEGUN.get(companyId)?.delete(seatOf(leaf));
    return { of: CHANGE_ACTED.dropped, state: typeof state === 'string' ? state : null };
  } catch (e) {
    return { of: CHANGE_ACTED.refused, why: refusalOf(e) };
  }
}
