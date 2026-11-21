/**
 * THE ACCOUNT AN ASK THAT PAYS PAYS FROM, PICKED ONCE IN THE WINDOW BEFORE THE PASSKEY: an action that pays, or a
 * payment the page asks this wallet to balance.
 *
 * The window lists every wallet here with its accounts; the person picks one; the passkey opens that wallet; the
 * opened window pays from that account and from nothing else. The pick is kept here, in this page's memory, for the
 * one ask it was made for (the ask as the window showed it, compared whole), so a page that changes its ask after
 * the passkey has no pick. It is never written to storage, so nothing pays from a value kept from an earlier ask.
 *
 * IT IS TAKEN ONCE, as the approval before the passkey is. The first delivery of the ask that reads it takes it, and
 * reads it again on every render; any other delivery, the very same ask sent again included, finds no pick and the
 * pick is forgotten, so an ask repeated while the wallet is open goes back to the window before the passkey.
 *
 * After the passkey the opened wallet is checked against the pick: by the fingerprint of its secret when the wallet
 * picked had one on record, and otherwise by its place in this browser. A wallet that is not the one picked pays
 * nothing.
 */

/**
 * The account this wallet offers the asking site, worked out once the wallet is open: what an ask that pays only a
 * call's network fee pays from until the person picks another account.
 */
export const OFFERED = 'offered-to-the-site';

/** An account picked by its number, or the account offered to the asking site. */
export type PickedAccount = number | typeof OFFERED;

/** What was picked: the wallet's place here, its fingerprint when one is on record, and the account in it. */
export interface PayingPick {
  readonly walletId: string;
  readonly fingerprint: string | null;
  readonly account: PickedAccount;
}

/** Which account the opened wallet pays from, or why it pays from none. */
export type PaysFrom =
  | { readonly of: 'picked'; readonly account: PickedAccount }
  | { readonly of: 'not-picked' }
  | { readonly of: 'another-wallet' };

/* `takenBy` is the delivered ask that read the pick first: the same object on every render of that delivery. */
let kept: { readonly ask: string; readonly pick: PayingPick; readonly takenBy: object | null } | null = null;

/** Keeps the pick made for this ask, replacing any earlier one. */
export function keepPayingPick(ask: unknown, pick: PayingPick): void {
  kept = { ask: JSON.stringify(ask), pick: { ...pick }, takenBy: null };
}

/** Forgets the pick, as a Decline does. */
export function forgetPayingPick(): void {
  kept = null;
}

/**
 * The account the opened wallet pays from for this delivered ask, checked against the wallet that was picked. The first
 * delivery to read the pick takes it; a later delivery finds none.
 */
export function paysFrom(ask: object, opened: { readonly walletId: string; readonly fingerprint: string }): PaysFrom {
  if (kept === null || kept.ask !== JSON.stringify(ask)) return { of: 'not-picked' };
  if (kept.takenBy !== null && kept.takenBy !== ask) {
    kept = null;
    return { of: 'not-picked' };
  }
  kept = { ...kept, takenBy: ask };
  const { pick } = kept;
  const same = pick.fingerprint !== null ? pick.fingerprint === opened.fingerprint : pick.walletId === opened.walletId;
  return same ? { of: 'picked', account: pick.account } : { of: 'another-wallet' };
}
