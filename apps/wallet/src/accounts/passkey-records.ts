import { fromBase64Url, toBase64Url } from 'midnight-identity/passkey/bytes';
import type { Passkey } from 'midnight-identity/passkey/verify';
import { heldWallets, keyFor } from './wallets-held.js';
import { StorageError } from './record-checks.js';

/* ---- passkeys. Public data: an id, a public key, counters. ---- */

interface StoredPasskey extends Omit<Passkey, 'publicKeySpki' | 'transports'> {
  readonly publicKeySpki: string;
  readonly transports: readonly string[];
}

export function savePasskey(passkey: Passkey, walletId: string): void {
  const all = allPasskeys(walletId).filter((p) => p.credentialId !== passkey.credentialId);
  const stored: StoredPasskey = {
    ...passkey,
    publicKeySpki: toBase64Url(passkey.publicKeySpki),
    transports: [...passkey.transports]
  };
  localStorage.setItem(keyFor(walletId, 'passkeys'), JSON.stringify([...all.map(toStored), stored]));
}

const toStored = (p: Passkey): StoredPasskey => ({
  ...p,
  publicKeySpki: toBase64Url(p.publicKeySpki),
  transports: [...p.transports]
});

/**
 * DAMAGE IS A STATE, NOT AN EMPTY LIST. Returning `[]` for a record
 * that cannot be read told the person with a healthy keyring and a damaged
 * passkey record that their account was on another machine, while the keys
 * sat sealed and intact on this one. A damaged record — the whole of it or
 * any entry in it — raises `record-damaged` like every record in `storage.ts`,
 * so `session.tsx` shows the named-state screen with its doors instead
 * of a wrong sentence. And a read never silently drops an entry: the old
 * skip-on-read meant the next `savePasskey` wrote the skipped entry out of
 * existence, which turned partial damage into permanent loss.
 */
export function allPasskeys(walletId: string): Passkey[] {
  const raw = localStorage.getItem(keyFor(walletId, 'passkeys'));
  if (!raw) return [];

  const damaged = (): StorageError =>
    new StorageError(
      'record-damaged',
      'the record of this browser’s passkeys is damaged and cannot be read. The ' +
        'sealed account here is untouched, but this browser cannot match a passkey to ' +
        'it. Recover from your pieces, or start again.'
    );

  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    throw damaged();
  }
  if (!Array.isArray(stored)) throw damaged();

  const passkeys: Passkey[] = [];
  for (const entry of stored as StoredPasskey[]) {
    if (
      typeof entry?.credentialId !== 'string' ||
      typeof entry?.publicKeySpki !== 'string' ||
      typeof entry?.personHandle !== 'string'
    ) {
      throw damaged();
    }
    try {
      passkeys.push({
        ...entry,
        publicKeySpki: fromBase64Url(entry.publicKeySpki),
        transports: Object.freeze([...(entry.transports ?? [])])
      });
    } catch {
      throw damaged();
    }
  }
  return passkeys;
}

export const passkeyById = (credentialId: string, walletId: string): Passkey | null =>
  allPasskeys(walletId).find((p) => p.credentialId === credentialId) ?? null;

/**
 * WHICH WALLET A CHOSEN CREDENTIAL OPENS, and the reason it has to
 * exist: the browser's chooser offers every credential for this ORIGIN, and
 * this origin now holds several wallets. `passkeyById` asks one compartment;
 * this asks all of them, in the order the list is kept.
 *
 * **A CREDENTIAL THAT OPENS NOTHING IS A NULL, NOT A THROW**, and the caller
 * says the sentence. That state is not hypothetical — a password manager keeps
 * credentials this browser's storage no longer knows about, and it is the
 * `passkey-with-no-wallet` state already seen in the wild.
 *
 * A COMPARTMENT WHOSE PASSKEY RECORD IS DAMAGED DOES NOT STOP THE SEARCH, AND
 * DOES NOT VANISH FROM IT EITHER — and getting this exactly right is the point.
 *
 * `allPasskeys` RAISES `record-damaged` rather than returning `[]`, because
 * an empty list told somebody with a healthy keyring that their account was on
 * another machine. If this function swallowed that, a single-wallet browser
 * with a damaged record would be back to exactly that sentence. So: every
 * compartment is tried, a MATCH anywhere wins — one wallet's unreadable public
 * data must not make the other three unopenable — and if nothing matched and
 * anything was damaged, the damage is raised. The caller turns a null into a
 * sentence and a `StorageError` into the named-state screen, as it always has.
 */
export function walletOfCredential(credentialId: string): {
  readonly walletId: string;
  readonly passkey: Passkey;
} | null {
  let damaged: StorageError | null = null;
  for (const wallet of heldWallets()) {
    let found: Passkey | null = null;
    try {
      found = passkeyById(credentialId, wallet.id);
    } catch (e) {
      if (e instanceof StorageError) damaged ??= e;
      else throw e;
      continue;
    }
    if (found) return { walletId: wallet.id, passkey: found };
  }
  if (damaged !== null) throw damaged;
  return null;
}

/**
 * Replaces the passkey record wholesale with exactly one entry, WITHOUT
 * reading what is there. Lawful in exactly two places, both doors a person
 * pressed: `adoptPasskey` over a DAMAGED record (the person chose
 * "discard it and make a new passkey", and nothing in that store is worth
 * anything: ids and counters, public data), and `startFresh` replacing stale
 * records after the new wallet has landed. The no-rewrite rule
 * is about SILENT repair on a read path; this is neither silent nor a read.
 */
export function resetPasskeyRecordTo(passkey: Passkey, walletId: string): void {
  localStorage.setItem(keyFor(walletId, 'passkeys'), JSON.stringify([toStored(passkey)]));
}

/**
 * Removes the WHOLE passkey record, without reading it. Lawful in exactly one
 * place: the recovery LANDING. The moment the recovered secret is
 * sealed here, every credential on record gates the account this landing just
 * replaced — worth nothing, and worse than nothing: left in place, a cancelled
 * ceremony dropped the person to `locked` behind the OLD credential, and if
 * that credential was gone from the authenticator too they met "the account
 * was made elsewhere" over an account that arrived a second ago. Removing the
 * record on the landing means a cancelled sheet reaches the
 * `account-no-passkey` doorway in EVERY browser, not only an empty one. A
 * door the person pressed — finishing a recovery — never a silent repair.
 */
export function forgetAllPasskeys(walletId: string): void {
  localStorage.removeItem(keyFor(walletId, 'passkeys'));
}

/**
 * Removes one passkey record. Exists for the sign-up rollback: if the secret
 * cannot be saved after a registration, the passkey record must not survive
 * alone — `hasAccount()` would stay false, Welcome would show, and the next
 * create would pass this credential in `excludeCredentials`, which the
 * authenticator refuses — every retry failing identically, for ever.
 */
export function forgetPasskey(credentialId: string, walletId: string): void {
  const kept = allPasskeys(walletId).filter((p) => p.credentialId !== credentialId);
  if (kept.length === 0) {
    localStorage.removeItem(keyFor(walletId, 'passkeys'));
    return;
  }
  localStorage.setItem(keyFor(walletId, 'passkeys'), JSON.stringify(kept.map(toStored)));
}
