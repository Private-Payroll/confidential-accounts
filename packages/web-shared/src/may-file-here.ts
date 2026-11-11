/**
 * **WHETHER THIS DEVICE'S OWN SEAT MAY FILE A RECORD OF A KIND, ASKED BEFORE ANYTHING IS SENT.**
 * The one check a device makes of its own seat before it files a company record (`seatMayFileIn`): the directory this
 * device believes holds a seat under the signing key, that seat is one this device believes (`seatNotBelievedHere`),
 * and its role files the kind (`mayFile`). The service judges no role; every reader does, and refuses what a role may
 * not file, so a filing refused here would only have been refused by every device that read it. Each caller below
 * says the refusal in its own words.
 */
import { MAY_FILE, ROLES, mayFile, type FiledKind } from '../../../src/core/roles.js';
import { refusalSaid } from '../../../src/core/vault-approvers.js';
import type { DirectorySeat } from '../../../src/midnight/seat-directory.js';
import { seatNotBelievedHere, type DirectoryHere } from './vault-page-doors.js';

/** Why this device's own seat may not file a kind: it is in no directory entry, this device does not believe it, or its role does not file the kind. */
type MayNotFile =
  | { readonly refused: 'no-seat' }
  | { readonly refused: 'not-believed'; readonly off: string }
  | { readonly refused: 'role'; readonly seat: DirectorySeat };

/** **THE SEAT THAT SIGNS WITH `signingKey` IN THE DIRECTORY `here`, IF IT MAY FILE A RECORD OF `kind`**, or why not. */
export const seatMayFileIn = (here: DirectoryHere, signingKey: string, kind: FiledKind): DirectorySeat | MayNotFile => {
  const key = signingKey.toLowerCase();
  const mine = here.dir.seats.find((x) => x.signingKey.toLowerCase() === key);
  if (mine === undefined) return { refused: 'no-seat' };
  const off = seatNotBelievedHere(here, mine);
  if (off !== null) return { refused: 'not-believed', off };
  return mayFile(mine).includes(kind) ? mine : { refused: 'role', seat: mine };
};

/** Why the seat may not file, in a sentence with no capital and no stop: `roleMayNot` when its role is why. */
export const mayNotFileSaid = (no: MayNotFile, roleMayNot: string): string => {
  if (no.refused === 'no-seat') return 'the company\'s directory, as this device reads it, holds no seat under your keys';
  if (no.refused === 'not-believed') return `your seat is not one this device believes: ${no.off}`;
  return roleMayNot;
};

/** The seat that signs with `signingKey`, if it may file a record of `kind`; otherwise why not, `roleMayNot` when its role is why. */
export const seatThatMayFileHere = (here: DirectoryHere, signingKey: string, kind: FiledKind, roleMayNot: string): DirectorySeat | string => {
  const s = seatMayFileIn(here, signingKey, kind);
  return 'refused' in s ? mayNotFileSaid(s, roleMayNot) : s;
};

/** The roles whose seats file a kind, as the one role list gives them. */
const rolesThatFile = (kind: FiledKind): readonly string[] => ROLES.filter((r) => MAY_FILE[r].includes(kind));

/**
 * **WHY THE SEAT THAT SIGNS WITH `signingKey` MAY NOT FILE A RECORD OF `kind`, OR NULL WHEN IT MAY**, in words that name
 * what resolves it. `why` is that the seat is in no directory entry, that this device does not believe it, or that its
 * role does not file the kind. `read` is the directory read the caller already holds or makes.
 */
export async function mayFileHere(read: () => Promise<DirectoryHere>, signingKey: string, kind: FiledKind): Promise<{ readonly why: MayNotFile['refused']; readonly says: string } | null> {
  const s = seatMayFileIn(await read(), signingKey, kind);
  if (!('refused' in s)) return null;
  const files = `(${rolesThatFile(kind).join(', ')})`;
  const says = s.refused === 'role'
    ? `Your seat's role, ${String(s.seat.role)}, may not file ${kind} records. A seat whose role may file them ${files} must make this change.`
    : `${refusalSaid(mayNotFileSaid(s, ''))}. A seat this device believes, whose role files ${kind} records ${files}, must make this change.`;
  return { why: s.refused, says };
}
