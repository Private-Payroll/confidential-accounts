/**
 * **THE COMPANY'S PROPOSALS TO ADD A SEAT, AS A SIGNER'S DEVICE OPENS THEM.**
 *
 * Each proposal is opened with the company's key of the epoch it was sealed at, and read for what it carries: the
 * request it seats, the invitation the raising seat signed, that seat as an inviter record, the coin key and salt.
 * Nothing here is believed: whether the seat that signed may invite, and whether the person waiting is the one
 * invited, are the callers' to check against the company's directory, inbox and the chain.
 *
 * Pure: the page and the service both import it, and it loads nothing else.
 */
import { keyOf, type KeysHeld } from './company-key.js';
import { parseCanonical, unseal, type Hex, type Sealed } from './crypto.js';
import { openRecord } from './sealed-records.js';
import type { SealedProposal } from './types.js';
import { seatInvitationRefusal, type Inviter, type SignedSeatInvitation } from './invitation.js';
import { proposalFilingRefusal, raiseByOf } from './proposal-filing.js';

const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * **THE INVITATION BEHIND A SEAT, AS THE COMPANY'S PROPOSAL TO ADD IT CARRIES
 * IT**: the one whose seat is `seat`, opened from the company's proposals, each
 * with the company's key of the epoch it was sealed at; null when none carries one for that seat. The proposal
 * carries the invitation naming the seat's leaf, which the person's own
 * directory entry must carry, on every way in. Nothing here is believed: a
 * member's device judges the invitation where it judges the entry.
 */
export const seatInvitationIn = (
  proposals: readonly ProposalOpened[], accountId: string, viewingKey: KeysHeld, seat: string,
): SignedSeatInvitation | null => seatAddedIn(proposals, accountId, viewingKey, seat)?.invited ?? null;

/**
 * **THE SEAT THAT RAISED THE PROPOSAL ADDING `seat`, AS AN INVITER RECORD**:
 * its wallet key, the directory entry its wallet signed and its own seat's
 * opening, as the proposal carries them; null when none carries one. Handed to
 * the person's own wallet on its first records-key ask, which believes it only
 * where that seat is on the account as the wallet reads it, and its opening
 * proves that key for it; nothing here is believed.
 */
export const seatInviterIn = (
  proposals: readonly ProposalOpened[], accountId: string, viewingKey: KeysHeld, seat: string,
): Inviter | null => seatAddedIn(proposals, accountId, viewingKey, seat)?.inviter ?? null;

/** A proposal as an add-signer one is read from: its company, its sealed body, and the key epoch it was sealed at. */
export type ProposalOpened = Pick<SealedProposal, 'accountId' | 'sealed'> & Partial<Pick<SealedProposal, 'keyEpoch'>>;

/** What one opened proposal to add a seat carries: its request id, its invitation, the seat that raised it, its coin key, salt and words. */
interface AddSignerOpened {
  readonly rec: ProposalOpened & Partial<Pick<SealedProposal, 'chainId' | 'createdAt' | 'filedBy'>>;
  readonly signerId: unknown;
  readonly invited?: SignedSeatInvitation;
  readonly inviter?: Inviter;
  readonly coinPublicKey?: unknown;
  /** The salt the proposal's identity is made with, as its sealed body holds it. */
  readonly salt?: unknown;
  /** The words the raising device wrote for it. */
  readonly summary?: unknown;
  /** Why the invitation it carries is not believed, where it carries one that is not. */
  readonly invitationRefused?: string;
}

/** Every proposal to add a seat the key of its own epoch opens, with what it carries; one that key does not open names nothing. */
const addSignersOpened = (
  proposals: readonly (ProposalOpened & Partial<Pick<SealedProposal, 'chainId' | 'createdAt' | 'filedBy'>>)[], accountId: string, viewingKey: KeysHeld,
): AddSignerOpened[] => proposals.flatMap((rec) => {
  try {
    const key = keyOf(viewingKey, rec.keyEpoch);
    const envelope = openRecord<{ kind: string; summary?: unknown; sealedPayload: Sealed }>('proposals', accountId, rec.sealed, key);
    if (envelope.kind !== 'add-signer') return [];
    const body = parseCanonical<{
      signerId?: unknown; invited?: unknown; inviter?: unknown; coinPublicKey?: unknown; __change?: { salt?: unknown } | null;
    }>(unseal(envelope.sealedPayload, key));
    const refused = body.invited === undefined ? null : seatInvitationRefusal(body.invited);
    const invited = refused === null && body.invited !== undefined ? body.invited as SignedSeatInvitation : undefined;
    const inviter = body.inviter as Inviter | undefined;
    return [{
      rec, signerId: body.signerId, ...(invited === undefined ? {} : { invited }), ...(typeof inviter === 'object' && inviter !== null ? { inviter } : {}),
      ...(body.coinPublicKey === undefined ? {} : { coinPublicKey: body.coinPublicKey }),
      ...(typeof body.__change === 'object' && body.__change !== null && body.__change.salt !== undefined ? { salt: body.__change.salt } : {}),
      ...(envelope.summary === undefined ? {} : { summary: envelope.summary }), ...(refused === null ? {} : { invitationRefused: refused }),
    }];
  } catch {
    /* A record its epoch's key does not open, or whose epoch this device cannot reach, names no seat of this company's. */
    return [];
  }
});

/**
 * Every invitation made by address the company's proposals to add a seat carry: the ones that name the proposal
 * raised for the address and no leaf. Which seat each took is the account's history's to say, never this list's.
 */
export const invitationsByAddressIn = (
  proposals: readonly ProposalOpened[], accountId: string, viewingKey: KeysHeld,
): SignedSeatInvitation[] => addSignersOpened(proposals, accountId, viewingKey)
  .map((x) => x.invited)
  .filter((x): x is SignedSeatInvitation => x !== undefined && x.terms.leaf === undefined && x.terms.invite !== undefined && x.terms.proposal !== undefined);

/**
 * One address the company's proposals invite to a seat: the proposal's id on the chain, the coin key it names, the
 * deadline its raise carries (`raiseByOf`), absent when its record does not say when it was written, and the signing
 * key of the seat whose signed filing it is.
 */
export interface AddressInvited {
  readonly chainId: string;
  readonly coinPublicKey: Hex;
  readonly raiseBy?: string;
  readonly filedBy?: string;
}

/**
 * **EVERY ADDRESS A PROPOSAL OF THE COMPANY'S INVITES TO A SEAT, BY ITS COIN KEY**: one entry for each proposal to add
 * a seat that carries a coin key - by address, or for the leaf of a person who joined by a link or a code, whose
 * request carried the coin key their wallet signed - that the key of its own epoch opens, that the seat which raised it signed, that names its id on
 * the chain, and whose coin key makes the very commitment its signed invitation names under the invitation's own
 * salt (`inviteAddressOf`). A proposal whose coin key does not make that commitment names nobody: a seat could
 * otherwise seal one wallet's key beside another's address. Whether each proposal is still open, or which seat it
 * took, is the chain's to say, never this list's.
 */
export const addressesInvitedIn = (
  proposals: readonly (ProposalOpened & Partial<Pick<SealedProposal, 'chainId' | 'createdAt' | 'filedBy'>>)[],
  accountId: string, viewingKey: KeysHeld, inviteAddressOf: (coinPublicKey: Hex, salt: Hex) => Hex,
): AddressInvited[] => addSignersOpened(proposals, accountId, viewingKey).flatMap((x) => {
  const invite = x.invited?.terms.invite;
  const coin = typeof x.coinPublicKey === 'string' ? x.coinPublicKey.toLowerCase() : null;
  if (invite === undefined || coin === null || !HEX64.test(coin)) return [];
  if (typeof x.rec.chainId !== 'string' || proposalFilingRefusal(accountId, x.rec) !== null) return [];
  let made: string;
  try {
    made = String(inviteAddressOf(coin as Hex, invite.salt.toLowerCase() as Hex)).toLowerCase();
  } catch {
    return [];
  }
  if (made !== invite.address.toLowerCase()) return [];
  return [{ chainId: x.rec.chainId.toLowerCase(), coinPublicKey: coin as Hex, ...filedAtOf(x.rec) }];
});

/**
 * When a proposal's raise must land by (`raiseByOf`), absent when its record does not say when it was written, and the
 * signing key of the seat whose signed filing it is.
 */
const filedAtOf = (rec: AddSignerOpened['rec']): { readonly raiseBy?: string; readonly filedBy?: string } => {
  let raiseBy: string | undefined;
  try {
    raiseBy = raiseByOf(rec.createdAt ?? '');
  } catch {
    raiseBy = undefined;
  }
  const filedBy = typeof rec.filedBy?.publicKey === 'string' ? rec.filedBy.publicKey.toLowerCase() : undefined;
  return { ...(raiseBy === undefined ? {} : { raiseBy }), ...(filedBy === undefined ? {} : { filedBy }) };
};

/** One proposal to seat a waiting request: its id on the chain, when its raise must land by, and who filed it. */
export interface SeatProposed {
  readonly chainId: string;
  readonly raiseBy?: string;
  readonly filedBy?: string;
}

/**
 * **EVERY PROPOSAL TO SEAT THE REQUEST `signerId` THAT NAMES ITS ID ON THE CHAIN**: each one this key opens, for that
 * request, whose filing the seat that raised it signed. Which of them the chain still holds open is the chain's to
 * say; the device's own read decides it, never this list.
 */
export const seatProposalsFor = (
  proposals: readonly SealedProposal[], accountId: string, viewingKey: KeysHeld, signerId: string,
): SeatProposed[] => addSignersOpened(proposals, accountId, viewingKey).flatMap((x) => {
  if (x.signerId !== signerId || typeof x.rec.chainId !== 'string' || proposalFilingRefusal(accountId, x.rec) !== null) return [];
  return [{ chainId: x.rec.chainId.toLowerCase(), ...filedAtOf(x.rec) }];
});

/** One proposal to add a seat by address, as a signer's device approves it or admits the seat it took. */
export interface AddSignerByAddress {
  /** The proposal's identity on the chain, which its invitation names. */
  readonly chainId: Hex;
  readonly summary: string;
  readonly invited: SignedSeatInvitation;
  /** The salt the proposal's identity is made with. */
  readonly proposalSalt: Hex;
  /** The coin key of the address the raising device typed, or null when the proposal carries none. */
  readonly coinPublicKey: Hex | null;
  readonly inviter?: Inviter;
}

/**
 * Why the proposal `rec` to add a seat carries an invitation no device believes, as a sentence saying what clears it,
 * or null where it carries none or one that is believed.
 */
export const addSignerInvitationRefusalIn = (rec: ProposalOpened, accountId: string, viewingKey: KeysHeld): string | null => {
  const why = addSignersOpened([rec], accountId, viewingKey)[0]?.invitationRefused;
  return why === undefined ? null : `The proposal the company holds under that name carries an invitation this device does not believe: ${why}. `
    + 'Nothing was approved. Nothing was sent.';
};

/**
 * One proposal to add a seat, as the reading both ways in share it: what `rec` carries when the key of its own epoch
 * opens it, it is filed as a proposal of this company names (`proposalFilingRefusal`), its invitation commits to an
 * address (`invite`) and names the proposal's own identity on the chain, and its salt is one. Null otherwise.
 */
const addSignerFiledIn = (
  rec: ProposalOpened & Partial<Pick<SealedProposal, 'chainId'>>, accountId: string, viewingKey: KeysHeld,
): { readonly x: AddSignerOpened; readonly invited: SignedSeatInvitation; readonly chainId: Hex; readonly salt: Hex } | null => {
  const [x] = addSignersOpened([rec], accountId, viewingKey);
  const t = x?.invited?.terms;
  if (x === undefined || t === undefined || t.invite === undefined || t.proposal === undefined) return null;
  if (typeof x.rec.chainId !== 'string' || proposalFilingRefusal(accountId, x.rec) !== null) return null;
  const chainId = x.rec.chainId.toLowerCase();
  if (t.proposal.toLowerCase() !== chainId) return null;
  const salt = typeof x.salt === 'string' ? x.salt.toLowerCase() : '';
  if (!HEX64.test(salt)) return null;
  return { x, invited: x.invited!, chainId: chainId as Hex, salt: salt as Hex };
};

/**
 * **ONE PROPOSAL TO ADD A SEAT BY ADDRESS, OPENED HERE, OR NULL**: what the proposal `rec` carries when it is read as
 * `addSignerFiledIn` reads it and its invitation names no leaf. Nothing here is believed: whether the seat that signed
 * the invitation may invite, and whether the coin key makes the commitment the invitation names, are the caller's to
 * check, against the company's directory and the account's commitments.
 */
export const addSignerByAddressIn = (
  rec: ProposalOpened & Partial<Pick<SealedProposal, 'chainId'>>, accountId: string, viewingKey: KeysHeld,
): AddSignerByAddress | null => {
  const filed = addSignerFiledIn(rec, accountId, viewingKey);
  if (filed === null || filed.invited.terms.leaf !== undefined) return null;
  const { x } = filed;
  const coin = typeof x.coinPublicKey === 'string' && HEX64.test(x.coinPublicKey.toLowerCase()) ? x.coinPublicKey.toLowerCase() as Hex : null;
  return {
    chainId: filed.chainId, summary: typeof x.summary === 'string' ? x.summary : '', invited: filed.invited, proposalSalt: filed.salt,
    coinPublicKey: coin, ...(x.inviter === undefined ? {} : { inviter: x.inviter }),
  };
};

/** One proposal to seat the leaf of a person who joined by a link or a code, as a signer's device approves it. */
export interface AddSignerByLeaf {
  /** The proposal's identity on the chain, which its invitation names. */
  readonly chainId: Hex;
  /** The invitation the raising seat signed again, naming the leaf, the address it is taken from and the proposal. */
  readonly invited: SignedSeatInvitation;
  /** The salt the proposal's identity is made with. */
  readonly proposalSalt: Hex;
  /** The company's inbox entry of the person waiting for the seat, as the raising device filed it. */
  readonly signerId: string;
  readonly inviter?: Inviter;
}

/**
 * **ONE PROPOSAL TO SEAT A LEAF, OPENED HERE, OR NULL**: what the proposal `rec` carries when it is read as
 * `addSignerFiledIn` reads it, its invitation names a leaf, and it names the person waiting in the company's inbox
 * (`signerId`). Nothing here is believed: whether the person waiting is the one invited, and whether the seat that
 * signed the invitation may invite, are the caller's to check.
 */
export const addSignerByLeafIn = (
  rec: ProposalOpened & Partial<Pick<SealedProposal, 'chainId'>>, accountId: string, viewingKey: KeysHeld,
): AddSignerByLeaf | null => {
  const filed = addSignerFiledIn(rec, accountId, viewingKey);
  if (filed === null || filed.invited.terms.leaf === undefined) return null;
  const { x } = filed;
  if (typeof x.signerId !== 'string' || x.signerId === '') return null;
  return {
    chainId: filed.chainId, invited: filed.invited, proposalSalt: filed.salt, signerId: x.signerId,
    ...(x.inviter === undefined ? {} : { inviter: x.inviter }),
  };
};

/**
 * The proposal adding `seat`: the one whose invitation names that leaf, read by
 * the leaf and never by the order the service lists them in. Where proposals
 * carry two different invitations for one leaf, none is taken: which one the
 * signers approved is not this list's to say.
 */
const seatAddedIn = (
  proposals: readonly ProposalOpened[], accountId: string, viewingKey: KeysHeld, seat: string,
): AddSignerOpened | null => {
  const named = addSignersOpened(proposals, accountId, viewingKey).filter((x) => x.invited?.terms.leaf?.toLowerCase() === seat.toLowerCase());
  return new Set(named.map((x) => x.invited!.signature.toLowerCase())).size === 1 ? named[0]! : null;
};

/**
 * **WHETHER THE CHAIN HOLDS A PROPOSAL TO SEAT THE REQUEST `signerId` OPEN**:
 * one this key opens, for that request, whose id is among the proposals the
 * chain holds open (`openOnTheChain`, as the device's own read of the chain
 * gives them) - approved or not - or one whose id on the chain the seat that
 * raised it did not sign. A request is not withdrawn while one is: the chain
 * could still seat its leaf. What the service writes of a proposal's standing
 * is never asked.
 */
export const seatStillProposedFor = (
  proposals: readonly SealedProposal[], accountId: string, viewingKey: KeysHeld, signerId: string, openOnTheChain: readonly string[],
): boolean => addSignersOpened(proposals, accountId, viewingKey).some((x) => {
  if (x.signerId !== signerId) return false;
  /* Its id on the chain counts only as the seat that raised it signed it; one nobody signed could be any proposal. */
  if (proposalFilingRefusal(accountId, x.rec) !== null) return true;
  return openOnTheChain.some((id) => id.toLowerCase() === String(x.rec.chainId).toLowerCase());
});
