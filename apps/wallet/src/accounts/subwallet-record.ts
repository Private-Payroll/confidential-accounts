import { toBase64Url } from 'midnight-identity/passkey/bytes';
import { fingerprintOf } from 'midnight-identity/recovery/pieces';
import type { Secret } from 'midnight-identity/keys/derivation';
import { isWalletAccount } from './subwallets.js';
import { keyFor } from './wallets-held.js';
import { slotOf, slotToWrite } from './record-shelf.js';
import { isNamed, isRealNumber } from './record-checks.js';

/* ---- subwallet names, and which wallet was open last. ----
 *
 * DECORATION, BY DESIGN — the second trap. A name
 * is not a function of the secret, so this record is a convenience this
 * browser keeps and the design survives losing: the slots always exist and
 * are always offered (`subwallets.ts`), so a vanished name is a label to
 * re-type, never money out of reach. That is why damage here is treated as
 * ABSENCE and not as a `broken` state — unlike the keyring, there is nothing
 * behind this record to lose. The no-silent-rewrite rule is about reads
 * that destroy; this read repairs nothing and the next save simply writes a
 * whole new record.
 *
 * The same discipline still applies: the record names its account by
 * fingerprint and is DEFAULTS for any other. A browser that held wallet B
 * and now holds wallet A must not dress A's subwallets in B's names —
 * "Savings" over somebody else's account 3 is exactly the wrong-wallet
 * payment §3 exists to prevent.
 */

export interface SubwalletRecord {
  readonly fingerprint: string;
  /** Account number (as a string key) → the person's name for it. */
  readonly names: Readonly<Record<string, string>>;
  /** The account open when this record was last written. */
  readonly lastUsed: number;
}

const EMPTY_SUBWALLETS: Omit<SubwalletRecord, 'fingerprint'> =
  Object.freeze({ names: Object.freeze({}), lastUsed: 0 });

function parseSubwallets(raw: string): SubwalletRecord | null {
  let parsed: SubwalletRecord;
  try {
    parsed = JSON.parse(raw) as SubwalletRecord;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (!isNamed(parsed.fingerprint)) return null;
  if (!isRealNumber(parsed.lastUsed) || !Number.isInteger(parsed.lastUsed)) return null;
  if (parsed.lastUsed < 0 || parsed.lastUsed === 1) return null;
  if (typeof parsed.names !== 'object' || parsed.names === null
    || Array.isArray(parsed.names)) return null;
  for (const [account, name] of Object.entries(parsed.names)) {
    if (!/^\d+$/u.test(account) || account === '1') return null;
    if (typeof name !== 'string') return null;
  }
  return parsed;
}

/**
 * The names and last-used wallet FOR THIS SECRET — or the defaults, for no
 * record, a damaged record, or another account's. Never throws: losing this
 * record loses labels, not money, and the screens must keep working.
 */
export function loadSubwallets(secret: Secret): Omit<SubwalletRecord, 'fingerprint'> {
  const slot = slotOf(secret);
  if (slot === null) return EMPTY_SUBWALLETS;
  const raw = localStorage.getItem(keyFor(slot, 'subwallets'));
  if (!raw) return EMPTY_SUBWALLETS;
  const parsed = parseSubwallets(raw);
  if (!parsed) return EMPTY_SUBWALLETS;
  if (parsed.fingerprint !== toBase64Url(fingerprintOf(secret))) return EMPTY_SUBWALLETS;
  return { names: parsed.names, lastUsed: parsed.lastUsed };
}

/**
 * The account names and the fingerprint as stored for one wallet here, WITHOUT a secret to check them against, or
 * null for no record or a damaged one. The same rule as `walletNameOnRecord`: it is for a screen talking ABOUT a
 * wallet before its passkey opens it, and it decides nothing. The window before the passkey names a wallet's accounts
 * with it, and keeps the fingerprint with the account picked so the opened wallet can be checked against it; a caller
 * that knows the wallet's fingerprint from elsewhere uses the names only when the two agree.
 */
export function subwalletsOnRecord(walletId: string): Pick<SubwalletRecord, 'names' | 'fingerprint'> | null {
  const raw = localStorage.getItem(keyFor(walletId, 'subwallets'));
  if (!raw) return null;
  const parsed = parseSubwallets(raw);
  return parsed === null ? null : { names: parsed.names, fingerprint: parsed.fingerprint };
}

function saveSubwallets(
  secret: Secret, next: Omit<SubwalletRecord, 'fingerprint'>,
): void {
  const record: SubwalletRecord = {
    fingerprint: toBase64Url(fingerprintOf(secret)),
    names: next.names,
    lastUsed: next.lastUsed,
  };
  localStorage.setItem(keyFor(slotToWrite(secret), 'subwallets'), JSON.stringify(record));
}

/**
 * Names or renames one wallet. An empty name removes the label — the slot
 * falls back to its own fixed name and stays offered; a slot cannot be named
 * out of existence. Account 1 is refused loudly: nothing may teach the
 * interface to treat the authority compartment as a wallet, even as a label.
 *
 * THE SECOND WRITER NOW AGREES WITH THE FIRST ABOUT WHAT AN ACCOUNT
 * IS. `saveLastUsedWallet` was widened to `isWalletAccount` and this
 * one was left as it was, because the change named one writer and one line.
 * A LATER READING named the other: *"the two writers should not disagree about what
 * an account is."* Until this line, they did — `saveSubwalletName(secret, 12,
 * 'Savings')` reached the disk and `parseSubwallets` read it back happily,
 * so the record could carry a name for a slot no screen offers and no
 * `loadSubwallets` caller would ever show. A label is not money, which is why
 * this is defence in depth rather than a fix; but a record that can hold a
 * fact nothing can display is a record two readers can disagree about, and
 * Trouble is what disagreement about which wallet is which costs.
 *
 * THE SET COMES FROM `subwallets.ts`, NOT FROM A BOUND WRITTEN HERE — same
 * reason given: that file says growing the slot count later is "safe and
 * additive", and a hardcoded `<= 11` here would make every new slot
 * unnameable the moment somebody grew it.
 */
export function saveSubwalletName(secret: Secret, account: number, name: string): void {
  if (!isWalletAccount(account)) {
    throw new Error(`subwallet names live at accounts 0 and 2–11; got ${account}. `
      + (account === 1
        ? 'Account 1 is the authority compartment, not a wallet.'
        : 'That is not a slot this interface offers.'));
  }
  const current = loadSubwallets(secret);
  const names = { ...current.names };
  const trimmed = name.trim();
  if (trimmed === '') delete names[String(account)];
  else names[String(account)] = trimmed;
  saveSubwallets(secret, { names, lastUsed: current.lastUsed });
}

/**
 * Remembers which wallet is open, so the app opens into it next time.
 *
 * THE WRITER IS NOW AS STRICT AS THE READER, and this is defence in
 * depth rather than a fix: nothing displayed today disagrees with what is open.
 * The guard used to refuse non-integers, negatives and account 1 and NOTHING
 * ELSE, so account 12 reached the disk happily while `useWallets` silently
 * opened the main wallet instead — the record and the screen naming different
 * wallets with nothing said, which is a disagreement moved into the chrome.
 * `isWalletAccount` is the one definition of `{0} ∪ [2,11]` and it MOVES WITH
 * THE LIST: `subwallets.ts` says growing the slot count later is safe and
 * additive, and a hardcoded `> 11` here would have made every new slot
 * unopenable at the moment somebody grew it.
 *
 * WHAT THIS COSTS, said rather than left to be discovered: `shell/wallets.ts`'s
 * own guard is now REDUNDANT for the fixed set, so deleting it no longer turns
 * any test red. Two walls cannot both be mutation-pinned; the CLAIM is pinned
 * by this one, and `wallets.test.ts` says so where it used to say the opposite.
 */
export function saveLastUsedWallet(secret: Secret, account: number): void {
  if (!isWalletAccount(account)) {
    throw new Error(`a wallet is account 0 or 2–11; got ${account}. `
      + (account === 1
        ? 'Account 1 is the authority compartment, not a wallet.'
        : 'That is not a slot this interface offers.'));
  }
  const current = loadSubwallets(secret);
  saveSubwallets(secret, { names: current.names, lastUsed: account });
}
