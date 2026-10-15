/**
 * **EVERY KEY A VAULT'S SECRET IS SEALED TO, CHECKED ON THE DEVICE THAT
 * APPROVES IT, AGAINST WHAT THE CHAIN SAYS AND WHAT EACH SIGNER'S OWN WALLET
 * SIGNED.**
 *
 * A vault keeps its secret as one sealed copy per signer, so that any signer
 * holding only their recovery words and the chain can open it. A copy sealed
 * to a key nobody holds is written, counts toward opening the vault, and opens
 * for nobody: the promise fails without anyone noticing. The list of keys comes
 * through this product's service, and the service is not trusted with it. So
 * before a device raises or approves a secret run, it asks of every key the run
 * seals a copy to:
 *
 *   - **was it signed by its signer's own wallet?** Each signer's wallet signs
 *     their records key for the company, and the seat they hold on its account,
 *     with their committee key (`records-key.ts` in the identity library), a
 *     key whose secret half never leaves that wallet;
 *   - **is that wallet key the one its seat was made for?** A seat's leaf
 *     commits to the wallet key of the person who holds it, and the seat's own
 *     entry in the company's directory carries the opening that shows it
 *     (`walletKeyProvedBy`, against the leaf the account holds);
 *   - **is its signer one of the company's signers now?** The seat their
 *     wallet signed for must be one the account holds now, as this signer's
 *     own wallet read it just before the secret run, each seat signed for
 *     once, and every seat the account holds must have a reader.
 *
 * **NO COMMITTEE IS READ HERE.** The account's committee, and a vault's,
 * holds the super admins' keys, and a reader need not be one: who may read a
 * secret is the seats the account holds and what each one's wallet signed,
 * never who holds the account's or the vault's maintenance. The vault itself
 * must be pinned to this company's account, as the same signer's wallet read
 * it off the vault, never the service's report of it.
 *
 * Every refusal is a sentence a person can act on. Pure: it reads nothing and
 * sends nothing.
 */
import { recordsKeySignedBy } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { RosterVaultKeys } from '../core/vault-keys.js';
import { walletKeyProvedBy, type LeafOf, type SeatOpening } from '../core/seat-opening.js';

type Key = { readonly tag: string; readonly value: string };

/** Who holds one of the company's vaults, as this signer's own wallet read it off the vault itself. */
export interface VaultAsTheWalletRead {
  /** The vault read, 64 hex characters. */
  readonly vault: string;
  /** The account the vault's own state says it is pinned to, 64 hex characters. */
  readonly account: string;
}

/**
 * The company's directory as this device believes it: each seat's entry with
 * the opening this device opened from it, and what this device's vault worker
 * made of each opening with the account's own `signerLeaf`.
 */
export interface DirectoryAsBelieved {
  readonly seats: readonly { readonly seat: string; readonly opening?: SeatOpening; readonly retired: unknown }[];
  readonly leafOf: LeafOf | null;
}

/** Who holds the company's account, as this signer's own wallet read it from the chain: every seat. */
export interface SeatsAsTheWalletRead {
  /** Every seat the account holds now, 64 lower-case hex characters each. */
  readonly seats: readonly string[];
  /** Who holds the vault being approved, as the same wallet read it; null or absent when it read none. */
  readonly vault?: VaultAsTheWalletRead | null;
}

export interface SecretReadersToCheck {
  /** The company's label, which every signer's records key is signed for. */
  readonly company: CompanyLabel;
  /** The records keys the secret run seals a copy to, exactly as the run holds them. */
  readonly readers: readonly string[];
  /** Every seated signer's vault keys, from the roster this device opened. */
  readonly roster: readonly RosterVaultKeys[];
  /** Who holds the account, as this signer's wallet read it; null when it read nothing. */
  readonly seats: SeatsAsTheWalletRead | null;
  /** The company's directory as this device believes it: where each reader's seat's opening comes from. */
  readonly directory: DirectoryAsBelieved | null;
  /** The vault whose secret this is, 64 hex characters: the wallet's read must be of this one. */
  readonly vault: string;
  /** The company's account, 64 hex characters: the vault must be pinned to it. */
  readonly account: string;
}

const fold = (h: string): string => String(h).trim().toLowerCase();
const idOf = (k: Key): string => `${fold(k.tag)}:${fold(k.value)}`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * **WHAT KIND OF THING STOPPED A SECRET RUN**, so a screen can say it in a
 * person's own language and point at what resolves it: the wallet reading the
 * account again, a signer giving their keys from their own wallet, or nothing
 * a person here can do.
 */
/** Why a set of readers is refused, one of a fixed set a screen turns into its own words. */
export const READER_REFUSAL = {
  walletReadNothing: 'wallet-read-nothing', keysNotGiven: 'keys-not-given', notSigned: 'not-signed',
  seatNotHeld: 'seat-not-held', rosterNotTheChains: 'roster-not-the-chains', readerNotASigner: 'reader-not-a-signer',
  signerLeftOut: 'signer-left-out', vaultNotTheCompanys: 'vault-not-the-companys',
} as const;
export type ReaderRefusalCode = (typeof READER_REFUSAL)[keyof typeof READER_REFUSAL];

export interface ReaderRefusal {
  readonly code: ReaderRefusalCode;
  readonly says: string;
}

const refused = (code: ReaderRefusalCode, says: string): ReaderRefusal => ({ code, says });

/**
 * **WHY THIS DEVICE MUST NOT APPROVE A SECRET SEALED TO THESE READERS**, or
 * null when every reader checks out. The first reason found is the one given.
 */
export function whyNotTheseReaders(input: SecretReadersToCheck): string | null {
  return readerRefusalOf(input)?.says ?? null;
}

/** The same check, with the kind of refusal beside its sentence. */
export function readerRefusalOf(input: SecretReadersToCheck): ReaderRefusal | null {
  const { seats } = input;
  if (seats === null) {
    return refused('wallet-read-nothing', 'your wallet has not read who holds this company\'s account on the chain, so the people this vault\'s '
      + 'secret is sealed to cannot be checked. Open the company with your wallet again, then try again.');
  }
  const directory = input.directory;
  if (directory === null) {
    return refused('wallet-read-nothing', 'the company\'s directory could not be read, so whose seat each of the people this vault\'s secret is '
      + 'sealed to holds cannot be checked. Reload the page, then try again.');
  }
  /* The wallet key each seat's opening proves for it, by seat: the one place a reader's wallet key is read from. */
  const provedBySeat = new Map<string, string>();
  for (const x of directory.seats) {
    if (x.retired !== null || x.opening === undefined) continue;
    const proved = walletKeyProvedBy(x.opening, x.seat, directory.leafOf);
    if (proved !== null) provedBySeat.set(fold(x.seat), idOf(proved));
  }
  const held = seats.vault ?? null;
  if (held === null || fold(held.vault) !== fold(input.vault)) {
    return refused('wallet-read-nothing', 'your wallet has not read who holds this vault on the chain, so the people its secret is '
      + 'sealed to cannot be checked. Open the company with your wallet again, then try again.');
  }
  if (fold(held.account) !== fold(input.account)) {
    return refused('vault-not-the-companys', 'this vault, as your wallet read it on the chain, belongs to a different company account '
      + 'from this one, so its secret is not approved from here. Nothing is approved; contact support.');
  }
  const seated = new Set(seats.seats.map(fold));

  /* The roster's seated signers, each with the wallet's statement over their records key and seat checked here. */
  const byCommittee = new Map<string, { recordsKey: string; name: string }>();
  const seatsSigned = new Set<string>();
  for (const entry of input.roster) {
    const keys = entry.keys;
    if (keys === null) {
      return refused('keys-not-given', `${entry.name} has not set up their vault keys from their own wallet yet, so no secret can be sealed to `
        + 'them. They open the company\'s vaults on their own device once; then try again.');
    }
    if (keys.recordsKeyStatement === null || keys.recordsKeySeat === null) {
      return refused('keys-not-given', `${entry.name} has not signed their records key for their seat from their own wallet `
        + 'yet, so no secret can be sealed to them. They open the company\'s vaults on their own device once and finish '
        + 'setting this vault up from there; then try again.');
    }
    if (!recordsKeySignedBy(input.company, fold(input.account) as AccountAddress, keys.committeeKey,
      { recordsKey: fold(keys.recordsKey), seat: fold(keys.recordsKeySeat), signature: fold(keys.recordsKeyStatement) })) {
      return refused('not-signed', `the key ${entry.name}'s copy of the secret would be sealed to was not signed by ${entry.name}'s own `
        + 'wallet, so it may not be theirs. Nothing is approved. They open the company with their wallet once to sign '
        + 'it again; if it still fails, contact support.');
    }
    if (!seated.has(fold(keys.recordsKeySeat))) {
      return refused('seat-not-held', `the seat ${entry.name}'s wallet signed their records key for is not one the company's `
        + `account holds now, so ${entry.name} may have left, or been seated again since. Nothing is approved. If they are `
        + 'still a signer, they open the company\'s vaults on their own device once to sign it for the seat they hold now.');
    }
    if (seatsSigned.has(fold(keys.recordsKeySeat))) {
      return refused('roster-not-the-chains', 'two signers\' records keys are signed for the same seat, so the list of '
        + 'signers is not one this device can trust. Nothing is approved; contact support.');
    }
    seatsSigned.add(fold(keys.recordsKeySeat));
    const id = idOf(keys.committeeKey);
    if (provedBySeat.get(fold(keys.recordsKeySeat)) !== id) {
      return refused('not-signed', `the wallet key that signed ${entry.name}'s records key is not the one their seat on the company's account `
        + 'was made for, as the opening in their entry in the company\'s directory shows it, so their copy of the secret may not be theirs. '
        + 'Nothing is approved. They open the company\'s vaults on their own device once to enter their seat again; if it still fails, '
        + 'contact support.');
    }
    if (byCommittee.has(id)) {
      return refused('roster-not-the-chains', 'two seated signers give the same wallet key, so the list of signers is not one this device can trust. '
        + 'Nothing is approved; contact support.');
    }
    byCommittee.set(id, { recordsKey: fold(keys.recordsKey), name: entry.name });
  }
  if (byCommittee.size !== seated.size) {
    return refused('roster-not-the-chains', `the company's own list of signers names ${plural(byCommittee.size, 'signer', 'signers')} and its account `
      + `on the chain seats ${seated.size}, so the list is out of date or has been changed. Nothing is approved; `
      + 'reload the page, and if it happens again, contact support.');
  }

  /* Now the run's own readers: exactly one per seated signer, and nothing else. */
  const readers = input.readers.map(fold);
  const expected = new Map([...byCommittee.values()].map((v) => [v.recordsKey, v.name]));
  if (expected.size !== byCommittee.size) {
    return refused('roster-not-the-chains', 'two signers give the same records key, so one copy of the secret would stand '
      + 'for two people. Nothing is approved; contact support.');
  }
  const extra = readers.filter((r) => !expected.has(r)).length;
  if (extra > 0) {
    return refused('reader-not-a-signer', `this secret would also be sealed to ${plural(extra, 'key', 'keys')} that no signer of this company signed `
      + 'for, so somebody else could read it. Nothing is approved; reload the page, and if it happens again, contact support.');
  }
  if (new Set(readers).size !== readers.length) {
    return refused('reader-not-a-signer', 'this secret would be sealed twice to the same signer, so its copies do not match the signers. Nothing is approved.');
  }
  const missing = [...expected.entries()].filter(([k]) => !readers.includes(k)).map(([, name]) => name);
  if (missing.length > 0) {
    return refused('signer-left-out', `this secret would not be sealed to ${missing.join(', ')}, so ${missing.length === 1 ? 'they' : 'those signers'} `
      + 'could not open the vault\'s records from their own recovery words. Nothing is approved; reload the page, and if '
      + 'it happens again, contact support.');
  }
  return null;
}
