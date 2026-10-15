import { AnotherPersonError, api, AuthError } from 'vaults-web-shared/keyring.js';
import { keyringFor } from './keyring-person.js';

/*
 * WHERE A COMPANY STANDS ON BEING HELD BY ITS COMMITTEE, READ FROM THE
 * SERVICE'S ACCOUNT OF WHAT THE CHAIN SAYS (`GET /api/accounts/:id/authority`
 * and, when a change is owed, `/committee-change`).
 *
 * The service explains itself in sentences, which are never handed on; the
 * state is read from the answer's shape alone, into one of a fixed set a
 * screen says in its own words.
 */

/** Where a company stands. */
export const HANDOVER = {
  /** The company has no contract on the chain the service can read yet. */
  notOnChain: 'not-on-chain',
  /** Every contract listed is held by the committee holding the account. */
  held: 'held',
  /** A vault is still held by the super admins from before they last changed: the super admins who hold it now sign the change. Payments go on throughout. */
  changeOwed: 'change-owed',
  /** The account is held by keys no committee of the company holds, in a way nothing here can change. */
  heldByOtherKeys: 'held-by-other-keys',
  /** The chain could not be read. */
  unreadable: 'unreadable',
  /** The service could not be asked. */
  unreachable: 'unreachable',
  /** The person is no longer signed in here. */
  notSignedIn: 'not-signed-in',
  /** Somebody else has signed in on this browser since. */
  anotherPerson: 'another-person',
} as const;

export type Handover =
  | { of: typeof HANDOVER.notOnChain | typeof HANDOVER.held | typeof HANDOVER.heldByOtherKeys | typeof HANDOVER.unreadable | typeof HANDOVER.unreachable | typeof HANDOVER.notSignedIn | typeof HANDOVER.anotherPerson }
  | { of: typeof HANDOVER.changeOwed; signed: readonly { have: number; required: number }[] };

/** The part of the service's answer this reads: the super admins' side alone, no signer, count or threshold of theirs. */
interface Authority {
  company: { address: string } | null;
  committee: unknown;
  contracts: readonly { read: string; heldByTheCompany: boolean }[];
  change: { possible: boolean };
}
interface ChangeOwed { contracts: readonly { signedIndexes: readonly number[]; required: number }[] }

/** The service's words for the chain's answer and a contract's shape, compared and never shown; and its addresses. */
export const SERVICE = {
  read: 'read',
  company: '/api/accounts/', authority: '/authority', change: '/committee-change',
  signatures: '/committee-change/signatures', send: '/committee-change/send', post: 'POST',
} as const;

/** The service's address for `route` of the company `companyId`. */
export const companyRoute = (companyId: string, route = ''): string => SERVICE.company + companyId + route;

/**
 * WHERE THE SERVICE'S ANSWER LEAVES THE COMPANY, by its shape alone, the first
 * match winning: not on the chain; a change owed (with how many have signed,
 * from `owed`); held by the committee holding the account; the chain
 * unreadable; otherwise held by keys nothing here can change. Nothing of the
 * signers is read: who holds the company's contracts is the super admins'.
 */
export function handoverFrom(a: Authority, owed: ChangeOwed | null): Handover {
  if (a.company === null) return { of: HANDOVER.notOnChain };
  if (a.change.possible) return { of: HANDOVER.changeOwed, signed: (owed?.contracts ?? []).map((c) => ({ have: c.signedIndexes.length, required: c.required })) };
  const account = a.contracts[0];
  if (account === undefined || account.read !== SERVICE.read) return { of: HANDOVER.unreadable };
  if (a.committee !== null && account.heldByTheCompany === true) return { of: HANDOVER.held };
  return { of: HANDOVER.heldByOtherKeys };
}

/**
 * Where a failure to read leaves the company, told apart by its kind and
 * never by its words: the person signed out, or somebody else signed in, in
 * this browser; the service not reached at all; or the service answering
 * with a refusal, which is a reading that did not happen.
 */
export function failureOf(e: unknown): Handover {
  if (e instanceof AnotherPersonError) return { of: HANDOVER.anotherPerson };
  if (e instanceof AuthError) return { of: HANDOVER.notSignedIn };
  if (e instanceof TypeError) return { of: HANDOVER.unreachable };
  return { of: HANDOVER.unreadable };
}

/**
 * WHERE THE COMPANY `companyId` STANDS, for the person `personId`. The two
 * reads are asked first and their answer read after, so an answer of a shape
 * this does not know is unreadable, never taken for the service not being
 * reached.
 */
export async function readHandover(personId: string, companyId: string): Promise<Handover> {
  let authority: Authority;
  let owed: ChangeOwed | null;
  try {
    if (!(await keyringFor(personId))) return { of: HANDOVER.notSignedIn };
    authority = await api(companyRoute(companyId, SERVICE.authority)) as Authority;
    owed = authority?.change?.possible === true ? await api(companyRoute(companyId, SERVICE.change)) as ChangeOwed : null;
  } catch (e) {
    return failureOf(e);
  }
  try {
    return handoverFrom(authority, owed);
  } catch {
    return { of: HANDOVER.unreadable };
  }
}
