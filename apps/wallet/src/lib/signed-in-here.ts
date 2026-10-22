import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Port } from 'midnight-identity/profile/store';

/**
 * **WHICH WALLET IN THIS BROWSER LAST ANSWERED A PAGE'S SIGN-IN.**
 *
 * A company's key is made from the wallet that gives it: the same company asked
 * of two different wallets is two different keys. A page signs a person in with
 * one wallet and then asks for a company's key, and in a browser holding several
 * wallets the key can be given by another of them - the person can choose
 * another wallet from the list, or use another wallet's passkey. The page cannot tell which wallet
 * answered. For a person with nothing saved yet, that key seals their first
 * company's only keys, and the wallet they signed in with can then never open
 * them.
 *
 * So a wallet notes, when it answers a sign-in, that it answered that page, and
 * a wallet asked for a company's key by a page whose last sign-in another wallet
 * here answered does not give it.
 *
 * **WHAT IT IS AND IS NOT EVIDENCE OF.** The wallet is named by its fingerprint -
 * eight bytes derived one way from its secret, the value this browser's list of
 * wallets already keeps in the clear - so a wallet moved to another slot, removed
 * and brought back, or answering in a window whose open wallet has changed is
 * still itself, and a new wallet in an old slot is not mistaken for the old one.
 * The page is named by a digest of its origin, which is easy to guess, so that
 * keeps the list out of plain sight and nothing more. It records what a wallet
 * ANSWERED, not what the page did with it: a sign-in the page then refused, or a
 * page still signed in from before any record was kept, is not what it says. And
 * it is this browser's only: a page signed in to from another browser leaves none
 * here, and then nothing is refused.
 *
 * **IT ALSO NAMES THE WALLET'S PLACE IN THIS BROWSER**, its wallet id, so a
 * later ask from that page opens that wallet and offers only its passkeys
 * before anything is unlocked: the fingerprint alone can only be compared once
 * a wallet is open. The id is a place, and a place can be emptied and given to
 * a new wallet, so `signedInWalletHere` trusts it only while this browser's
 * list of wallets gives the same fingerprint for that place, or gives no
 * fingerprint for it yet. A record written before the id was kept has none,
 * and gains it the next time that wallet answers the page (`noteWalletId`).
 *
 * **AND THE WALLET PICKED FOR A PAGE NO SIGN-IN NAMES.** When an ask from a
 * page with no usable sign-in record is answered by a wallet the person picked
 * from the list, the pick is kept for that page (`rememberPick`), so the list
 * is not offered again. It decides only which wallet's passkey is asked for;
 * it is never evidence of who signed in, and `whyNotThisWallet` does not read it.
 */

const PREFIX = 'midnight-identity:signed-in:';
const LABEL = 'midnight-identity/signed-in-origin/v1';

const nameFor = (origin: string): string =>
  `${PREFIX}${bytesToHex(sha256(new TextEncoder().encode(`${LABEL}\n${origin}`))).slice(0, 32)}`;

interface SignInRecord {
  readonly wallet: string;
  readonly walletId: string | null;
}

function readRecord(port: Port, origin: string): SignInRecord | null {
  const raw = port.getItem(nameFor(origin));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { wallet?: unknown; walletId?: unknown };
    if (typeof parsed?.wallet !== 'string') return null;
    return { wallet: parsed.wallet, walletId: typeof parsed.walletId === 'string' ? parsed.walletId : null };
  } catch {
    return null;
  }
}

/**
 * Written when the wallet with fingerprint `wallet` answers a sign-in from `origin`; `walletId`, when given, is
 * that wallet's place in this browser.
 */
export function rememberSignIn(port: Port, origin: string, wallet: string, walletId?: string): void {
  port.setItem(nameFor(origin), JSON.stringify(walletId === undefined ? { wallet } : { wallet, walletId }));
}

/** The fingerprint of the wallet that last answered a sign-in from `origin` here, or null when none is recorded. */
export function walletSignedInTo(port: Port, origin: string): string | null {
  return readRecord(port, origin)?.wallet ?? null;
}

/**
 * What this browser can say, before any wallet is open, about which wallet answered `origin`'s last sign-in:
 * `none` when nothing is recorded; `no-place` for a record written before the wallet's place was kept, with the
 * place of the held wallet whose fingerprint it names (or null when none does); `here` with the place of a wallet
 * still held here; and `gone` when the wallet it names is no longer held in this browser.
 */
export type SignedInHere =
  | { readonly of: 'none' }
  | { readonly of: 'no-place'; readonly matches: string | null }
  | { readonly of: 'here'; readonly walletId: string }
  | { readonly of: 'gone' };

/** One wallet in this browser's list: its place and the fingerprint the list keeps for it in the clear, if written. */
export interface HeldPlace { readonly id: string; readonly fingerprint: string | null }

/**
 * Reads `origin`'s sign-in record against `held`, this browser's list of wallets. A wallet whose fingerprint the
 * list has not written down yet is taken as the one its place names.
 */
export function signedInWalletHere(port: Port, origin: string, held: readonly HeldPlace[]): SignedInHere {
  const record = readRecord(port, origin);
  if (record === null) return { of: 'none' };
  if (record.walletId === null) {
    return { of: 'no-place', matches: held.find((wallet) => wallet.fingerprint === record.wallet)?.id ?? null };
  }
  const place = held.find((wallet) => wallet.id === record.walletId);
  if (place === undefined || (place.fingerprint !== null && place.fingerprint !== record.wallet)) return { of: 'gone' };
  return { of: 'here', walletId: place.id };
}

const PICK_PREFIX = 'midnight-identity:picked-for:';

/** Keeps the wallet the person picked from the list to answer `origin`, by its place and its fingerprint if known. */
export function rememberPick(port: Port, origin: string, walletId: string, fingerprint: string | null): void {
  port.setItem(`${PICK_PREFIX}${nameFor(origin).slice(PREFIX.length)}`, JSON.stringify({ walletId, fingerprint }));
}

/**
 * The place of the wallet picked for `origin`, while it is still held with the same fingerprint (or none written
 * yet); null when there is no pick, or it no longer names a wallet held here.
 */
export function pickedHere(port: Port, origin: string, held: readonly HeldPlace[]): string | null {
  const raw = port.getItem(`${PICK_PREFIX}${nameFor(origin).slice(PREFIX.length)}`);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { walletId?: unknown; fingerprint?: unknown };
    if (typeof parsed?.walletId !== 'string') return null;
    const place = held.find((wallet) => wallet.id === parsed.walletId);
    if (place === undefined) return null;
    if (typeof parsed.fingerprint === 'string' && place.fingerprint !== null && place.fingerprint !== parsed.fingerprint) return null;
    return place.id;
  } catch {
    return null;
  }
}

/**
 * Adds `walletId` to a record written before places were kept, when the wallet with fingerprint `wallet` is the
 * one it names. A record that names another wallet, or already has a place, is left as it is.
 */
export function noteWalletId(port: Port, origin: string, wallet: string, walletId: string): void {
  const record = readRecord(port, origin);
  if (record === null || record.walletId !== null || record.wallet !== wallet) return;
  rememberSignIn(port, origin, wallet, walletId);
}

/**
 * **WHY THIS WALLET MUST NOT GIVE `origin` A COMPANY'S KEY, OR NULL.** Refused
 * only when the record names a different wallet: an unreadable or missing record
 * refuses nothing, because it cannot say who answered.
 */
export function whyNotThisWallet(port: Port, origin: string, wallet: string): string | null {
  const answered = walletSignedInTo(port, origin);
  if (answered === null || answered === wallet) return null;
  return `The last sign-in to ${origin} from this browser was answered by another of the wallets `
    + 'held here. A company\'s key is made from the wallet that gives it, so this wallet\'s key '
    + 'is not the one that page is expecting, and anything saved under it could only ever be '
    + 'opened with this wallet. Open the wallet you signed in to that page with - the one that '
    + 'answered its last sign-in here, unless the page did not accept that sign-in. Signing in to that '
    + 'page again with this wallet also works, but signing out of it first drops anything it has '
    + 'not finished saving, such as a company that is not finished.';
}
