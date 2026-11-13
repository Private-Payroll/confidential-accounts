/**
 * **A SIGNER'S ROLE CHANGES BY THE SEAT'S REMOVAL AND AN INVITATION BY ADDRESS AT THE NEW ROLE.** No change to the
 * company's directory gives a seat another role: a seat keeps the role and rights its invitation gave, so a new role
 * is a new seat, approved as any invitation is. This file decides, from the company's directory as this device
 * believes it and the seats the chain holds, which of the two steps comes next, and refuses a role or an address the
 * change cannot be made to. The removal and the invitation themselves are the ordinary ones.
 */
import { isReaderRole, isSignerRole, mayFile, type Role, type SignerRole } from '../../../src/core/roles.js';
import { roleChangeKeyOf, type Keyring } from './keyring-blob.js';
import { directoryChangeMessage, type QuorumChange } from '../../../src/midnight/seat-directory.js';
import { signaturesRefusal } from '../../../src/midnight/seat-quorum.js';

/**
 * The step a role change of `leaf` is at: `remove` while the chain holds the seat and the directory has not retired
 * it; `removal-under-way` once the directory has retired it and the chain still holds it, until the removal is carried
 * out; `invite` once the chain no longer holds it, when the person is invited again at the new role.
 */
type RoleChangeStage = 'remove' | 'removal-under-way' | 'invite';

/** Which step a role change of `leaf` is at, from the directory's seats as believed here and the seats the chain holds. */
export const roleChangeStageOf = (
  seats: ReadonlyArray<{ readonly seat: string; readonly retired: unknown }>, held: readonly string[], leaf: string,
): RoleChangeStage => {
  const l = leaf.toLowerCase();
  if (!held.some((x) => x.toLowerCase() === l)) return 'invite';
  const entry = seats.find((x) => x.seat.toLowerCase() === l);
  return entry !== undefined && entry.retired !== null ? 'removal-under-way' : 'remove';
};

/** What a seat of `role` may file, as the one role list gives it: the founding seat (`null`) files what an admin files. */
const filesOf = (role: Role | null): string => mayFile({ role }).join();

/**
 * Why a seat holding `now` cannot be changed to `role`, or null. A reader holds no seat on the chain, so a signer
 * becomes one by the seat's removal and a read grant; a role no seat can hold is refused; and the role the seat
 * already holds is no change, the founding seat (`null`) counting as an admin because it files what an admin files.
 * With no seat to compare (`undefined`, once the seat is removed), any signer role is let through.
 */
export const roleAskedRefusal = (role: unknown, now: Role | null | undefined): string | null => {
  if (isReaderRole(role)) {
    return 'limited and accountant people read the company\'s records and hold no seat, so a signer\'s seat is not changed into '
      + 'one. To make this signer a reader, remove them first with Remove. Read access is given on the Roles tab in Settings';
  }
  if (!isSignerRole(role)) return 'the role asked for is not one a seat of a company can hold: choose admin, approver or initiator';
  if (now !== undefined && filesOf(now) === filesOf(role)) return `that seat already holds the role ${role}, so there is nothing to change`;
  return null;
};

/** Whether the address given is tied to the seat by the company's list of signers. */
type AddressTie = 'tied' | 'untied';

/**
 * Whether the address whose coin key is `addressCoin` is the one the seat was invited at: `tied` where the company's
 * list of signers records the seat's coin key and it is this one, `untied` where it records none (a founding seat, or
 * one taken by a link), and why not where it records another, since the person invited again would not be the one
 * removed.
 */
export const addressTieOf = (seatCoin: string | undefined, addressCoin: string): AddressTie | string => {
  if (seatCoin === undefined) return 'untied';
  if (seatCoin.toLowerCase() === addressCoin.toLowerCase()) return 'tied';
  return 'the address given is not the one this seat was invited at, as the company\'s list of signers records it, so the '
    + 'person invited again would not be the one removed. Give the address of the wallet that holds the seat';
};

/**
 * Why the invitation that follows the removal of `leaf` may not be raised from these saved keys for the address whose
 * coin key is `coinPublicKey` at `role`, or null: it is held to what this wallet confirmed when it raised the removal,
 * so a page cannot send another person or another role at the second press. With nothing kept here, the signer who
 * raised the removal invites the person; with another address or role, the one confirmed is asked for again.
 */
export const keptRoleChangeRefusal = (
  k: Keyring, accountId: string, leaf: string, coinPublicKey: string, role: SignerRole,
): 'not-started-here' | 'not-as-started' | null => {
  const kept = k.roleChangesKept?.[roleChangeKeyOf(accountId, leaf)];
  if (kept === undefined) return 'not-started-here';
  return kept.coinPublicKey !== coinPublicKey.toLowerCase() || kept.role !== role ? 'not-as-started' : null;
};

/** A field of a value read off the wire, or undefined where it is not an object. */
const fieldOf = (x: unknown, name: string): unknown => (typeof x === 'object' && x !== null ? Reflect.get(x, name) : undefined);

/** Whether a change read off the wire is shaped as a retirement: a seat, a whole threshold of at least one, and a list of signatures. */
const isRetirement = (c: unknown): c is QuorumChange => fieldOf(c, 'kind') === 'retire' && typeof fieldOf(c, 'seat') === 'string'
  && Number.isSafeInteger(fieldOf(c, 'threshold')) && Number(fieldOf(c, 'threshold')) >= 1 && Array.isArray(fieldOf(c, 'signatures'));

/**
 * Whether the company's directory, as served, holds the retirement of `leaf`: a retirement naming the seat whose
 * every signature verifies, signed by at least its own threshold of seats the directory's entries name. Its own
 * threshold, not the chain's bar now: the directory refuses a retirement filed below the chain's bar at the time
 * (`threshold-not-the-chains`, seat-directory.ts), and a bar raised after the removal must not lock the person out of
 * coming back. A removed seat's wallet cannot read the bar as the retirement was anchored. A wallet whose seat the
 * chain no longer shows sets that seat aside only when this agrees, so one read of the chain that leaves a live seat
 * out never moves it. The entries' proofs are not opened here, since a removed seat holds no newer key.
 */
export const retiredInTheDirectory = (company: string, filings: readonly unknown[], leaf: string): boolean => {
  const l = leaf.toLowerCase();
  const named = new Set(filings.flatMap((f) => {
    const c = fieldOf(f, 'change');
    const key = fieldOf(fieldOf(fieldOf(c, 'entry'), 'statement'), 'signingKey');
    return fieldOf(c, 'kind') === 'claim' && typeof key === 'string' ? [key.toLowerCase()] : [];
  }));
  return filings.some((f) => {
    const c = fieldOf(f, 'change');
    if (!isRetirement(c) || c.seat.toLowerCase() !== l) return false;
    const at = Number(fieldOf(f, 'signedAt') ?? fieldOf(f, 'version'));
    if (!Number.isSafeInteger(at) || signaturesRefusal(directoryChangeMessage(company, at, c), c.signatures) !== null) return false;
    return c.signatures.filter((x) => named.has(String(x.publicKey).toLowerCase())).length >= c.threshold;
  });
};
