/**
 * THE SUBWALLET SLOTS — the fixed set, and nothing else.
 *
 * THE CONVENTION THAT KEEPS MONEY VISIBLE, stated once and held by a test:
 * **the slots always exist and are always offered.** A name is not a function
 * of the secret and this build has no chain to scan, so after a recovery the
 * wallet knows the secret and cannot know how many subwallets were in use or
 * what they were called. If the LIST were stored, a subwallet holding money
 * could vanish from the screen of the very person who owns it. So the list is
 * a constant: the same ten slots in every browser, before and after recovery,
 * named or not. Names are decoration this browser remembers (`storage.ts`),
 * losable without losing money.
 *
 * THE SLOTS START AT ACCOUNT 2 AND THE GAP IS NOT A STYLE CHOICE. Account 0
 * is the main wallet. Account 1 is the authority compartment — a "subwallet"
 * there would carry a NIGHT spending key byte-identical to the authority
 * root, the same trap reproduced by a feature. The library refuses account 1 at the
 * only door (`moneyAt`); this file never builds a list that reaches it; and
 * `subwallets.test.ts` derives every slot on this list and asserts none of
 * them equals any authority key, so a rearranged list goes red rather than
 * quietly re-opening the worst failure there is.
 *
 * WHY TEN. The count is arbitrary; that it NEVER SHRINKS is not. A person
 * can only ever have used a slot this list offered, so money can only sit in
 * the first ten — and any future build that offers fewer makes some of it
 * invisible. Growing the list later is safe and additive.
 */

const FIRST_SUBWALLET_ACCOUNT = 2;
const SUBWALLET_COUNT = 10;

/** The main wallet. Account 0, unchanged, for ever. */
export const MAIN_ACCOUNT = 0;

/** Accounts 2–11. Never 0 (the main wallet), never 1 (the authority). */
export const SUBWALLET_ACCOUNTS: readonly number[] = Object.freeze(
  Array.from({ length: SUBWALLET_COUNT }, (_, i) => FIRST_SUBWALLET_ACCOUNT + i));

/** Every account the interface will ever offer. */
export const WALLET_ACCOUNTS: readonly number[] =
  Object.freeze([MAIN_ACCOUNT, ...SUBWALLET_ACCOUNTS]);

/** How many subwallets the picker shows before “Show more”. */
export const OFFERED_UP_FRONT = 5;

export const isWalletAccount = (account: number): boolean =>
  WALLET_ACCOUNTS.includes(account);

/**
 * The slot NUMBER a person sees — “Subwallet 1” lives at account 2. The
 * account number is a derivation detail; the slot number is the name of the
 * seat. Only valid for subwallet accounts.
 */
export const slotNumberOf = (account: number): number => account - 1;

/** What an unnamed slot is called. Stable, so it survives recovery. */
export function defaultNameOf(account: number): string {
  if (account === MAIN_ACCOUNT) return 'Main wallet';
  return `Subwallet ${slotNumberOf(account)}`;
}

/** The name to show: the person's, or the slot's own. */
export function displayNameOf(
  account: number, names: Readonly<Record<string, string>>,
): string {
  const named = names[String(account)]?.trim();
  return named ? named : defaultNameOf(account);
}

/**
 * EVERY WALLET HAS ITS OWN COLOUR, fixed by slot and never by name — part of
 * the §3 rule that switching must be unmistakable. Two subwallets with
 * similar names still get visibly different frames, and the colours come
 * back identical after a recovery because they are a function of the slot.
 * Decoration only: every fact also appears as text.
 */
export function hueOf(account: number): number {
  if (account === MAIN_ACCOUNT) return 231; /* the app's own accent */
  const HUES = [160, 35, 305, 200, 0, 55, 260, 120, 20, 180] as const;
  return HUES[(account - FIRST_SUBWALLET_ACCOUNT) % HUES.length]!;
}
