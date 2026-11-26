/**
 * **TAKING AN INVITATION ON THE INVITEE'S OWN DEVICE.** The invitee's device
 * opens the link, believes the offer only when the seat that invited signed it,
 * and accepts as a payee or as a signer, or makes a signer's code, or keeps a
 * re-issued invitation, sending the service only what is sealed to the
 * company's inbox. Sending an invitation is in `invitation-on-device.ts`.
 */
import { type KeysHeld } from '../../../src/core/company-key.js';
import { canonical, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { sealToInbox } from '../../../src/core/sealed-records.js';
import { acceptanceProofOf, invitationIdOf, InvitationNotOpened, offerExpiredRefusal, openOffer, replacedBy, SUPER_ADMIN_JOINS_BY_THE_COMMITTEE, tokenOfLink, type InvitationKind, type InvitationOffer, type Inviter, type SignedOffer, type SignedSeatInvitation } from '../../../src/core/invitation.js';
import type { PendingSignerPayload } from '../../../src/core/types.js';
import type { LeafScheme } from '../../../src/core/signer-leaf.js';
import type { SealedHandover } from '../../../src/core/invite-handover.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { writeJoinCode, type JoinCode, type PayeeParts, type SignerParts } from 'midnight-identity/profile/join-code';
import { payeeCodeFingerprint, seatKeyFingerprint } from 'midnight-identity/profile/fingerprint';
import { seatRequestFingerprint } from './seat-request-fingerprint.js';
import { acceptSeatOnThisDevice, type AcceptedSeat, type SeatDoors } from './accept-seat.js';
import type { WalletKey } from '../../../src/core/seat-opening.js';
import { seatAddressSignedFor, type InviteAddressOf, type SeatAddress } from '../../../src/core/seat-address.js';
import { typedAddressIsShielded } from 'midnight-identity/profile/address-claim';
import { answered, replacedFor, type InvitationSend, type Reissued } from './invitation-on-device.js';
import { invitationSource, type InvitationSource } from './records-source.js';

/** The invitation's own asks, made over `send`. */
const asksOver = (send: InvitationSend): InvitationSource =>
  invitationSource((method, path, body) => send(path, { method, ...(body === undefined ? {} : { body }) }));

/** An invitation this device opened: the token its link carried, the offer its inviter signed, and which kind it is. */
interface OpenedInvitation {
  readonly token: Hex;
  readonly signed: SignedOffer;
  readonly expiresAt: string;
  /** The kind the offer's own signed content says it is; a re-issued seat invitation is a signer's. */
  readonly kind: InvitationKind;
}

/** Refuses an offer past the expiry its inviter signed, on this device's clock, whatever the service says. */
const refuseAnExpiredOffer = (offer: InvitationOffer): void => {
  const why = offerExpiredRefusal(offer, Date.now());
  if (why !== null) throw new InvitationNotOpened(why);
};

/**
 * **AN INVITATION OPENED ON THE INVITEE'S DEVICE.** Believed only when the seat
 * that invited signed the offer, for the company's label and account it names.
 * Whether that seat is on that account, and its opening shows it was made for
 * the inviter's wallet key, is asked of the chain by the invitee's own wallet
 * before anything is signed for it.
 */
export async function openInvitationHere(link: string, send: InvitationSend): Promise<OpenedInvitation> {
  return openInvitationThrough(link, asksOver(send));
}

/** An invitation opened as `openInvitationHere` opens it, its offer asked of `asks`. */
export async function openInvitationThrough(link: string, asks: Pick<InvitationSource, 'offer'>): Promise<OpenedInvitation> {
  const token = tokenOfLink(link);
  if (token === null) throw new InvitationNotOpened('it is not a whole invitation link');
  const b = answered(await asks.offer(invitationIdOf(token)), 200);
  const offer = b.offer as Sealed | undefined;
  if (offer === undefined || typeof b.expiresAt !== 'string') throw new InvitationNotOpened('the service sent no sealed offer');
  const signed = openOffer(offer, token);
  refuseAnExpiredOffer(signed.offer);
  /* A re-issue is kept by the service as a signer's invitation: it opens nothing on its own and names a seat already held. */
  const kind = signed.offer.for.kind === 'reissue' ? 'signer' : signed.offer.for.kind;
  if (kind !== b.kind) throw new InvitationNotOpened('it is not the kind of invitation the service says it is');
  return { token, signed, expiresAt: b.expiresAt, kind };
}

/**
 * **A PAYEE ACCEPTS, AN EMPLOYEE OR A VENDOR, HANDING OVER THEIR CODE.**
 * `code` is the one their own wallet signed for this company
 * (`askWalletForAJoinCode`), the same package a pasted code hands over; it is
 * sealed here to the inbox key the signed offer names and sent with the proof
 * only the token gives. Returns the fingerprint of the address they are paid
 * at, for them to read to whoever admits them. An employee added by a shielded
 * address accepts this way too, with a code for exactly that address; one added
 * by an unshielded address claims from their wallet instead (`claimIntentOf`).
 * Refuses a seat's offer, and a super admin's, which joins under the committee's
 * own rules.
 */
export async function acceptAsPayeeHere(opened: OpenedInvitation, code: JoinCode, send: InvitationSend): Promise<{ readonly fingerprint: string }> {
  const o = opened.signed.offer;
  if (o.for.kind === 'super-admin') throw new Error(SUPER_ADMIN_JOINS_BY_THE_COMMITTEE);
  if (o.for.kind !== 'employee' && o.for.kind !== 'vendor') throw new Error('that invitation offers a seat, not pay, so it is not accepted as a payee.');
  refuseAnExpiredOffer(o);
  if (code.parts.kind !== 'payee' || code.company !== o.label) {
    throw new Error('that code is not a payee\'s code for the company this invitation is from, so nothing was sent.');
  }
  const typed = o.for.kind === 'employee' ? (o.for as { address?: unknown }).address : undefined;
  if (typeof typed === 'string' && !typedAddressIsShielded(typed)) {
    throw new Error('this invitation was made by the public address you gave, so it is claimed from the wallet that holds that address, with no code to read out. Nothing was sent.');
  }
  if (typeof typed === 'string' && (code.parts as PayeeParts).address !== typed) {
    throw new Error('this invitation was made by the private address you gave, and the code names another address, so nothing was sent. Hand over a code for the address you gave.');
  }
  answered(await asksOver(send).acceptPayee(invitationIdOf(opened.token), {
    acceptance: acceptanceProofOf(opened.token), handover: payeeHandoverOf(code, o.inboxPublicKey), kind: o.for.kind,
  }), 201);
  return { fingerprint: payeeCodeFingerprint(code as JoinCode & { parts: PayeeParts }) };
}

/**
 * What a person or vendor added by an unshielded address asks their wallet to do (`claim-by-address`): the company,
 * its record, the invitation's token and the address that was typed. The wallet opens the inviter-signed offer itself
 * with the token and takes the inbox key, the record and the address from it; nothing here is trusted beyond naming
 * what to claim. Throws for an invitation not made by address, and for one made by a shielded address, which is
 * accepted with the wallet's code and the fingerprint read out (`acceptAsPayeeHere`).
 */
export function claimIntentOf(opened: OpenedInvitation): { readonly name: 'claim-by-address' } & Readonly<Record<string, string>> {
  const o = opened.signed.offer;
  refuseAnExpiredOffer(o);
  if (o.for.kind !== 'employee' && o.for.kind !== 'vendor') throw new Error('that invitation offers a seat, not pay, so it is not claimed as a payee.');
  const address = (o.for as { address?: unknown }).address;
  if (typeof address !== 'string') {
    throw new Error('this invitation was not made by an address, so it is accepted with your wallet\'s code and the fingerprint read out.');
  }
  if (typedAddressIsShielded(address)) {
    throw new Error('this invitation was made by a private address, so it is accepted with your wallet\'s code for that address and the fingerprint read out.');
  }
  return Object.freeze({
    name: 'claim-by-address' as const, company: o.label, account: String(o.account), record: o.company, token: opened.token, address,
  });
}

/** The company a signer's invitation was filed to, as the service holds it; null when it holds none. */
type FiledTo = { readonly id: string; readonly label: string | null; readonly account: string | null } | null;

/**
 * **WHY THIS DEVICE MAKES NO SEAT FOR AN OFFER**: the offer names another
 * company id, label or account than the company its seat request would be
 * filed to, so the leaf would be made for one company and the request sent to
 * another. Null when they are the same.
 */
const offerNotForTheCompanyRefusal = (o: SignedOffer['offer'], filedTo: FiledTo): string | null =>
  filedTo !== null && filedTo.id === o.company && filedTo.label === o.label
    && typeof filedTo.account === 'string' && filedTo.account.toLowerCase() === String(o.account).toLowerCase()
    ? null
    : 'this invitation names another company account or label than the company its seat request would be filed to, so no seat was made '
      + 'and nothing was sent. Ask the person who invited you for a new invitation.';

/** The company the service says this invitation was filed to, asked with the proof only the link gives. */
const filedToOf = async (opened: OpenedInvitation, send: InvitationSend): Promise<FiledTo> => {
  const b = answered(await asksOver(send).filedTo(invitationIdOf(opened.token), { acceptance: acceptanceProofOf(opened.token) }), 200);
  const c = b.company as Record<string, unknown> | null | undefined;
  return typeof c === 'object' && c !== null && typeof c.id === 'string'
    ? { id: c.id, label: typeof c.label === 'string' ? c.label : null, account: typeof c.account === 'string' ? c.account : null }
    : null;
};

/**
 * **A SIGNER ACCEPTS, THROUGH THE ONE SEAT PATH.** Their keys are made and kept
 * on this device (`doors.newKeys`, `doors.seal`), the leaf committing to the
 * wallet key their own wallet gives for the company the offer names
 * (`walletKey`, asked with the offer's label and account) - once the company
 * the seat request is filed to is the one the offer names
 * (`offerNotForTheCompanyRefusal`), and only for the person the invitation
 * names; the public halves, the leaf and its opening, the proof of their keys,
 * the name and role the offer gave them, and who the seat is for as the
 * inviting seat signed it, and the address their own wallet signed that they
 * take the seat with (`seatAddress`), are sealed here to the company's inbox
 * key and filed as the seat request. An address the wallet did not sign for
 * this seat, or that its coin key does not make, is refused before anything
 * is sent.
 * Returns, with the seat, the fingerprint of the keys for the person to read
 * to whoever seats them. Refuses an offer of pay, and a super admin's, which
 * joins under the committee's own rules.
 */
export async function acceptAsSignerHere(
  opened: OpenedInvitation, commitments: LeafScheme & { readonly inviteAddressOf: InviteAddressOf }, doors: Omit<SeatDoors, 'publish'>, send: InvitationSend,
  /** The sign-in accepting it: sealed into the request, and held to the member the company would make of it when it is seated. */
  person: string,
  /** The person's own wallet key for the company, asked of their wallet with the offer's label and account. */
  walletKey: (company: { readonly accountId: string; readonly label: CompanyLabel; readonly account: AccountAddress }) => Promise<WalletKey>,
  /**
   * The address the person's own wallet takes the seat with: its coin key and a salt, signed under `walletKey` for the
   * company and the seat's leaf, the address made from them (`signSeatAddress`). The chain seats whoever holds the
   * address the proposal names, so it is never anybody else's to choose; this device works it out again from the coin
   * key (`commitments.inviteAddressOf`) and checks the signature before anything is sent.
   */
  seatAddress: (company: { readonly accountId: string }, leaf: Hex) => Promise<SeatAddress>,
): Promise<AcceptedSeat & { readonly fingerprint: string }> {
  const o = opened.signed.offer;
  if (o.for.kind === 'super-admin') throw new Error(SUPER_ADMIN_JOINS_BY_THE_COMMITTEE);
  if (o.for.kind !== 'signer') throw new Error('that invitation offers pay, not a seat, so it is not accepted as a signer.');
  refuseAnExpiredOffer(o);
  /* A seat goes to the person invited: a link opened under another sign-in makes no seat and sends nothing. */
  if (o.for.invited.terms.person !== person) {
    throw new Error('this invitation is for somebody else, so no seat was made and nothing was sent. Sign in as the person it '
      + 'was sent to, or ask whoever invited you for an invitation of your own.');
  }
  const notThisCompany = offerNotForTheCompanyRefusal(o, await filedToOf(opened, send));
  if (notThisCompany !== null) throw new Error(notThisCompany);
  const key = await walletKey({ accountId: o.company, label: o.label, account: o.account });
  const offer = o.for;
  let fingerprint = '';
  const seated = await acceptSeatOnThisDevice(o.company, commitments, {
    ...doors,
    /* The inviter's signed entry is kept with the material, for this person's first records-key ask. */
    /* And who the seat is for, kept until this person's own directory entry carries it. */
    seal: (seat) => doors.seal({ ...seat, invitedBy: o.inviter, invited: offer.invited }),
    publish: async (payload) => {
      /* Who the seat is for, as the seat that invited signed it, travels with the keys for every approving device to check. */
      const signed = seatAddressSignedFor(await seatAddress({ accountId: o.company }, payload.leafCommitment), key, o.company, payload.leafCommitment,
        (c, salt) => commitments.inviteAddressOf(c, salt));
      if (typeof signed === 'string') throw new Error(WALLET_SIGNED_NO_ADDRESS);
      const waiting: PendingSignerPayload = { name: offer.name, role: offer.role, ...payload, person, invited: offer.invited, seatAddress: signed };
      fingerprint = seatRequestFingerprint(waiting);
      const b = answered(await asksOver(send).acceptSigner(invitationIdOf(opened.token), {
        acceptance: acceptanceProofOf(opened.token), waiting: sealToInbox(waiting, o.inboxPublicKey),
      }), 201);
      if (typeof b.id !== 'string') throw new Error('the service did not say which seat request it filed, so this device cannot finish it.');
      return { id: b.id };
    },
  }, key, { accountId: o.company, nonce: offer.seat.nonce, secret: offer.seat.secret, person, invitationId: offer.invited.terms.invitation }, offer.invited.terms);
  return { ...seated, fingerprint };
}

/** Why a seat request is not sent when the wallet's address for it does not check, and what clears it. */
const WALLET_SIGNED_NO_ADDRESS = 'your wallet did not sign, for this seat, an address made from its own coin key, so no seat '
  + 'request was sent. No wallet signs that address yet; that comes with joining by a link in the wallet. Ask whoever invited you '
  + 'to invite you by your private address instead.';

/** Why no code is made when the wallet's address for the seat does not check, and what clears it. */
const WALLET_SIGNED_NO_ADDRESS_IN_A_CODE = 'your wallet did not sign, for this seat, an address made from its own coin key, so no code '
  + 'was made. No wallet adds that address to a code yet; that comes with joining by a code in the wallet. Ask the company to '
  + 'invite you by your private address instead.';

/* ------------------------------------------------------------------ codes */

/**
 * **WHAT A PAYEE HANDS OVER, WHICHEVER WAY THEY JOIN**: their code, sealed to
 * the company's inbox key. Accepting a link hands it over from the payee's own
 * device; adding them from a pasted code hands over the same code from the
 * device that pasted it. An admitting device opens one package either way.
 */
export const payeeHandoverOf = (code: JoinCode, inboxPublicKey: Hex): SealedHandover => sealToInbox(code, inboxPublicKey);

/**
 * **A SIGNER'S CODE, MADE ON THEIR OWN DEVICE THROUGH THE ONE SEAT PATH.** The
 * keys are made and kept here (`doors`); their public halves and leaf go out
 * as a code their wallet signs (`sign`), with the leaf's opening and the
 * address their wallet signed for the seat (`seatAddress`) beside it,
 * instead of as a seat request: the seat request is filed by whoever pastes
 * the code. Returns the code and the fingerprint the person reads to them.
 */
export async function makeSignerCodeHere(
  accountId: string, commitments: LeafScheme & { readonly inviteAddressOf: InviteAddressOf }, doors: Omit<SeatDoors, 'publish' | 'promote'>,
  sign: (parts: SignerParts) => Promise<JoinCode>,
  /** The person's own wallet key for the company, as their wallet gave it: the key the seat's leaf commits to. */
  walletKey: WalletKey,
  /** The address the person's own wallet takes the seat with, made from its coin key and signed for the company and the leaf (`signSeatAddress`). */
  seatAddress: (company: { readonly accountId: string }, leaf: Hex) => Promise<SeatAddress>,
): Promise<{ readonly code: string; readonly fingerprint: string }> {
  let made: JoinCode | null = null;
  await acceptSeatOnThisDevice(accountId, commitments, {
    ...doors,
    publish: async (payload) => {
      const signed = await sign({ kind: 'signer', signingPublicKey: payload.signingPublicKey, wrappingPublicKey: payload.wrappingPublicKey, leafCommitment: payload.leafCommitment });
      /* The leaf's opening and the address ride beside the signature: each proves itself against the leaf the wallet signed. */
      const address = seatAddressSignedFor(await seatAddress({ accountId }, payload.leafCommitment), walletKey, accountId, payload.leafCommitment,
        (c, salt) => commitments.inviteAddressOf(c, salt));
      if (typeof address === 'string') throw new Error(WALLET_SIGNED_NO_ADDRESS_IN_A_CODE);
      made = { ...signed, opening: payload.opening, seatAddress: address };
      return { id: null };
    },
    promote: async () => { throw new Error('a seat made for a code is bound to its seat once that seat is filed, not here.'); },
  }, walletKey);
  const code = made as JoinCode | null;
  if (code === null || code.parts.kind !== 'signer') throw new Error('the wallet made no code, so there is nothing to give.');
  return { code: writeJoinCode(code), fingerprint: seatKeyFingerprint(code.parts) };
}

/* ------------------------------------------------------------------ an inviter who left */

/**
 * **THE SEAT HANDED TO A PERSON'S WALLET AS THEIR INVITER**: of the one this
 * device kept from the invitation it accepted (or a re-issue of it) and the
 * one the proposal that seated them carries, the first whose seat the account
 * holds now, as the person's own wallet read it (`onTheChain`); the kept one
 * when neither is. An inviter who has left is passed over for one who has
 * not, and a person added from a code, who kept none, is handed the seat that
 * raised their proposal.
 */
export const inviterForTheWallet = (
  kept: Inviter | undefined, carried: Inviter | null, onTheChain: readonly string[],
): Inviter | undefined => {
  const held = (x: Inviter | null | undefined): x is Inviter =>
    x != null && typeof x.statement?.seat === 'string' && onTheChain.some((s) => s.toLowerCase() === x.statement.seat.toLowerCase());
  if (held(kept)) return kept;
  if (held(carried)) return carried;
  return kept ?? carried ?? undefined;
};

/**
 * **A RE-ISSUED INVITATION, TAKEN ON THE PERSON'S OWN DEVICE.** Taken only for
 * the person signed in and for this device's own seat: the seat that signed it
 * and the invitation are kept together (`keep`), in place of the inviter and
 * invitation this device kept, for their wallet's next records-key ask and
 * their own directory entry. Refused when the seat that re-issued it is not
 * one the chain holds now, so an inviter who left after sending it is never
 * kept. Nothing is sent.
 */
export async function takeTheReissueHere(
  opened: OpenedInvitation, mine: { readonly accountId: string; readonly person: string; readonly seat: string; readonly companyKeys: KeysHeld },
  /** The company's proposals: the one that seated this device's seat carries the invitation the re-issue must replace. */
  proposals: Reissued['proposals'],
  /** The seats the chain holds now, as this device reads it. */
  onTheChain: readonly string[],
  keep: (reissued: { readonly inviter: Inviter; readonly invited: SignedSeatInvitation }) => Promise<void>,
): Promise<void> {
  const o = opened.signed.offer;
  if (o.for.kind !== 'reissue') throw new Error('that invitation does not re-issue an invitation for a seat, so nothing was kept.');
  const t = o.for.invited.terms;
  if (o.company !== mine.accountId || t.person !== mine.person) {
    throw new Error('that re-issued invitation is for somebody else, or another company, so nothing was kept. Sign in as the person it was sent to.');
  }
  if (t.leaf?.toLowerCase() !== mine.seat.toLowerCase()) {
    throw new Error('that re-issued invitation names another seat than the one this device holds for you, so nothing was kept.');
  }
  /* Only exactly the invitation your seat was proposed under, signed again: the same person, name, role and seat. */
  const original = replacedFor(proposals, mine.accountId, mine.companyKeys, mine.seat);
  const replaced = replacedBy(o.for.invited);
  if (original === null || replaced === null || canonical(replaced) !== canonical(original)) {
    throw new Error('that re-issued invitation is not the one your seat was proposed under, for the same name and role, so nothing was kept. '
      + 'Ask the signer who sent it to re-issue it again.');
  }
  if (!onTheChain.some((x) => x.toLowerCase() === o.inviter.statement.seat.toLowerCase())) {
    throw new Error('the signer who sent this re-issued invitation no longer holds a seat on the company\'s account, so nothing was kept. '
      + 'Ask a signer whose seat the account holds to send it again.');
  }
  await keep({ inviter: o.inviter, invited: o.for.invited });
}
