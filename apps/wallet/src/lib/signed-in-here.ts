import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Port } from 'midnight-identity/profile/store';

/**
 * **WHICH WALLET IN THIS BROWSER LAST ANSWERED A PAGE'S SIGN-IN.**
 *
 * A company's key is made from the wallet that gives it: the same company asked
 * of two different wallets is two different keys. A page signs a person in with
 * one wallet and then asks for a company's key, and in a browser holding several
 * wallets the key can be given by another of them - the person picks a passkey,
 * and every wallet's passkey is on the list. The page cannot tell which wallet
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
 */

const PREFIX = 'midnight-identity:signed-in:';
const LABEL = 'midnight-identity/signed-in-origin/v1';

const nameFor = (origin: string): string =>
  `${PREFIX}${bytesToHex(sha256(new TextEncoder().encode(`${LABEL}\n${origin}`))).slice(0, 32)}`;

/** Written when the wallet with fingerprint `wallet` answers a sign-in from `origin`. */
export function rememberSignIn(port: Port, origin: string, wallet: string): void {
  port.setItem(nameFor(origin), JSON.stringify({ wallet }));
}

/** The fingerprint of the wallet that last answered a sign-in from `origin` here, or null when none is recorded. */
export function walletSignedInTo(port: Port, origin: string): string | null {
  const raw = port.getItem(nameFor(origin));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { wallet?: unknown };
    return typeof parsed?.wallet === 'string' ? parsed.wallet : null;
  } catch {
    return null;
  }
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
