/*
 * Whether the chain holds a seat now, and the service's readings of the seat a
 * filing, a relay or a signer stands for: read off the company's directory and
 * its account's seats, judging no role and no retirement.
 */
import type { AccountSeats } from 'midnight-identity/profile/records-key';
import type { Hex } from '../core/crypto.js';
import type { Directory, DirectorySeat, FilingRefusal } from './seat-directory.js';

/**
 * Whether the chain, read now, holds `seat`: one rule for a device and the
 * server. Who the seat is - its wallet key - was proved on a member's device by
 * its entry's opening against its leaf when the entry was believed, so the
 * account's committee, which holds only the super admins' keys, is not asked.
 */
export const notOnTheChainNow = (seat: DirectorySeat, chain: AccountSeats): 'seat-not-seated' | null =>
  (chain.seats.includes(seat.seat) ? null : 'seat-not-seated');

/*
 * **THE SERVER'S HALF: A STORE, JUDGING NO ROLE AND NO RETIREMENT.** What the
 * server asks before it keeps a filing: an entry kept for the key that signed
 * it, for a seat the chain holds now. The server keeps every entry for a seat
 * and no retirement, so it asks the chain alone whether a seat is held. Which
 * kinds a role may file, and a retired seat's boundary, are each member's
 * device's to judge as it reads (`filingRefusalOf`); the server keeps what a
 * seat signs.
 */

/** Why the server does not keep a filing: never the role or a retirement, which it does not judge. */
export type ServerSeatRefusal = Exclude<FilingRefusal, 'role-may-not-file' | 'past-its-boundary'>;

/** Of `entries`, one for a seat the chain holds now, or why none: the server's one reading of a seat. */
const heldNow = (entries: readonly DirectorySeat[], chain: AccountSeats | null): DirectorySeat | ServerSeatRefusal => {
  if (entries.length === 0) return 'no-entry';
  if (chain === null) return 'no-account';
  return entries.find((x) => notOnTheChainNow(x, chain) === null) ?? 'seat-not-seated';
};

/**
 * **THE SEAT THE SIGNED-IN PERSON FILES UNDER, ON THE SERVER**: an entry that
 * person filed under the key `publicKey`, for a seat the chain holds now, or
 * why not. `dir` is the directory as the server keeps it, every entry for a
 * seat beside the others, and `chain` the server's read of the chain now, null
 * when the company has no account on a chain the server can read. Asked by
 * person and key together, so a person who entered a seat again under a new
 * key files under either, and never under another's.
 */
export const filerSeatOf = (
  dir: Directory, chain: AccountSeats | null, person: string, publicKey: Hex,
): DirectorySeat | ServerSeatRefusal =>
  heldNow(dir.seats.filter((x) => x.person === person && x.signingKey === publicKey.toLowerCase()), chain);

/**
 * **THE SEAT THAT SIGNED SOMETHING, ON THE SERVER, WHOEVER HANDS IT IN**: an
 * entry kept for the key that signed it, for a seat the chain holds now - and
 * never who is signed in to hand it in. A device that kept another seat's
 * signed entry files it again this way.
 */
export const signerSeatOf = (dir: Directory, chain: AccountSeats | null, publicKey: Hex): DirectorySeat | ServerSeatRefusal =>
  heldNow(dir.seats.filter((x) => x.signingKey === publicKey.toLowerCase()), chain);

/**
 * **THE SEAT THAT SIGNED A VERSION OF A RECORD, IN ONE DIRECTORY**: an entry
 * kept for the key that signed it. What the chain says of the seat is not
 * asked here: `signerSeatOf` asks it of the chain now, and a version judged as
 * the directory stood when it was anchored is judged against the holders that
 * batch names, and within a retired seat's boundary, by each device.
 */
export const filerSeatIn = (dir: Directory, publicKey: Hex): DirectorySeat | ServerSeatRefusal =>
  dir.seats.find((x) => x.signingKey === publicKey.toLowerCase()) ?? 'no-entry';

/** Why a signed-in person may not act on the company's proposals now. */
export type ActingRefusal = 'no-entry' | 'no-account' | 'seat-not-seated';

export const ACTING_REFUSAL: Readonly<Record<ActingRefusal, string>> = Object.freeze({
  'no-entry': 'you hold no seat on this company that its directory believes, so nothing is relayed for you',
  'no-account': 'the company\'s account on the chain could not be read, so whether it holds your seat is not known and nothing is relayed for you',
  'seat-not-seated': 'the company\'s account does not hold your seat now, so nothing is relayed for you',
});

/**
 * **THE SEAT A RELAY IS PAID FOR, ON THE SERVER**: the entry the signed-in
 * person filed under the filing key `filer` their device sent, for a seat the
 * chain holds now, or why they may not act. Asked by person and key together
 * among every entry kept, never by person alone: a person may have filed
 * several. A proposal is raised, approved, withdrawn
 * and carried out only for a seat the account holds now: the chain's read, not
 * a retirement, which the server does not keep. The server judges no role:
 * each member's device judges the role of every proposal's seat as it reads
 * it, and the chain makes its own signer check on every call relayed; this one
 * decides whether this service pays the fee.
 */
export const actingSeatOf = (dir: Directory, chain: AccountSeats | null, person: string, filer: Hex): DirectorySeat | ActingRefusal =>
  heldNow(dir.seats.filter((x) => x.person === person && x.signingKey === String(filer).toLowerCase()), chain);
