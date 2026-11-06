import { canonical } from '../../../src/core/crypto.js';
import { whyThisOfferIsNotSigned, type SignedOffer, type SignerOffer } from '../../../src/core/invitation.js';
import type { Keyring } from './keyring-blob.js';
import type { KeptSeatInvitation } from './invitation-on-device.js';

/**
 * The keyring with a seat offered by address kept under its invitation's id, and every kept one that has expired by
 * `now` let go. Refuses to write over another invitation kept under the same id: the one kept first may be the only
 * copy of a proposal already raised. The one exception is the same invitation signed again for a new inbox key (see
 * `signedAgain`), which replaces the one kept.
 */
export function withSeatInvitationKept(k: Keyring, kept: KeptSeatInvitation, now: number): Keyring {
  const held = k.seatInvitationsKept ?? {};
  const was = held[kept.id];
  if (was !== undefined && was.offer.signature !== kept.offer.signature && !signedAgain(was, kept)) {
    throw new Error('these saved keys already keep another invitation under this id, so it is not written over. Nothing was changed.');
  }
  const live = Object.fromEntries(Object.entries(held).filter(([id, x]) => id !== kept.id && x.offer.offer.expiresAt > now));
  return { ...k, seatInvitationsKept: { ...live, [kept.id]: kept } };
}

/** The offer with the two things a new company key changes taken out: the inbox key and the seat proof's secret. */
const apartFromTheKey = (signed: SignedOffer): string => {
  const o = signed.offer;
  const forWhom = o.for as SignerOffer;
  return canonical({ ...o, inboxPublicKey: null, for: { ...forWhom, seat: { nonce: forWhom.seat?.nonce } } });
};

/**
 * Whether `now` is `was` signed again for a new company key: the same token, link, company and offer in every word,
 * the inbox key and the seat proof's secret apart (both are made from the company key), the nonce the same, and a
 * signature that verifies for the seat that invited.
 */
const signedAgain = (was: KeptSeatInvitation, now: KeptSeatInvitation): boolean =>
  was.token === now.token && was.link === now.link && was.company === now.company
  && was.offer.offer.for.kind === 'signer' && now.offer.offer.for.kind === 'signer'
  && was.offer.offer.inboxPublicKey !== now.offer.offer.inboxPublicKey
  && apartFromTheKey(was.offer) === apartFromTheKey(now.offer)
  && whyThisOfferIsNotSigned(now.offer) === null;

/** The keyring without the kept invitations under these ids. */
export function withoutSeatInvitationsKept(k: Keyring, ids: readonly string[]): Keyring {
  const left = Object.fromEntries(Object.entries(k.seatInvitationsKept ?? {}).filter(([id]) => !ids.includes(id)));
  return { ...k, seatInvitationsKept: left };
}

interface KeptByAddress {
  /** The one live kept invitation for the address, or null. */
  readonly kept: KeptSeatInvitation | null;
  /** In words, when more than one is live: what the person does to go on. */
  readonly refused: string | null;
  /** The ids of kept invitations for the address that are no longer open, for the caller to let go of. */
  readonly passedOver: readonly string[];
}

/**
 * The invitation this device kept for a seat offered at `address` on `company`, found without the page's token, so a
 * page that lost its token takes up the invitation already raised instead of starting a second one. Only invitations
 * not yet expired at `now` count, and `open` says of each whether it still can be taken: one that is not (its link
 * used or withdrawn, or its proposal closed) is passed over and named in `passedOver`. More than one open is a refusal
 * in words, because there is no telling which the person meant.
 */
export async function keptSeatInvitationForAddress(
  k: Keyring, company: string, address: string, now: number, open: (kept: KeptSeatInvitation) => Promise<boolean>,
): Promise<KeptByAddress> {
  const at = address.trim().toLowerCase();
  const live: KeptSeatInvitation[] = [];
  const passedOver: string[] = [];
  for (const x of Object.values(k.seatInvitationsKept ?? {})) {
    const forWhom = x.offer.offer.for;
    if (x.company !== company || x.offer.offer.expiresAt <= now || forWhom.kind !== 'signer' || forWhom.byAddress?.address.toLowerCase() !== at) continue;
    if (await open(x)) live.push(x);
    else passedOver.push(x.id);
  }
  if (live.length > 1) {
    return { kept: null, passedOver, refused: 'there is more than one invitation kept on this device for this address, so it cannot be told which to take up again: '
      + 'withdraw the proposals of all but one of them from the company\'s open proposals, then press again' };
  }
  return { kept: live[0] ?? null, refused: null, passedOver };
}
