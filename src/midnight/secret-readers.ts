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
 *   - **is that committee key on the company's account, on the chain?** The
 *     committee is read by this signer's own wallet, from the chain, just
 *     before the secret run, never taken from the service;
 *   - **is its signer one of the company's signers now?** A signer who has left
 *     keeps their seat on every contract nobody has changed since, so a seat on
 *     the committee is never enough by itself: the seat their wallet signed for
 *     must be one the account holds now, as the same wallet read it, each seat
 *     signed for once, and the committee must have exactly one key per seat.
 *
 * It also refuses outright while the company's own committee does not hold the
 * account - while the service's temporary key still does, before the handover -
 * and while the vault is not held by that same committee with the same
 * threshold: nothing either signed is accepted until then. Who holds the vault,
 * and which account it is pinned to, is what the same signer's wallet read off
 * the vault itself, never the service's report of it.
 *
 * Every refusal is a sentence a person can act on. Pure: it reads nothing and
 * sends nothing.
 */
import { recordsKeySignedBy } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { RosterVaultKeys } from '../core/vault-keys.js';

type Key = { readonly tag: string; readonly value: string };

/** Who holds one of the company's vaults, as this signer's own wallet read it off the vault itself. */
export interface VaultAsTheWalletRead {
  /** The vault read, 64 hex characters. */
  readonly vault: string;
  /** The account the vault's own state says it is pinned to, 64 hex characters. */
  readonly account: string;
  readonly committee: readonly Key[];
  readonly threshold: number;
}

/** Who holds the company's account, as this signer's own wallet read it from the chain: its committee and every seat. */
export interface SeatsAsTheWalletRead {
  readonly committee: readonly Key[];
  readonly threshold: number;
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
  /** This signer's own committee key, from their wallet. */
  readonly mine: Key;
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
 * account again, the company's account or vault being handed to its
 * committee, the committee being brought up to date, a signer giving their
 * keys from their own wallet, or nothing a person here can do.
 */
/** Why a set of readers is refused, one of a fixed set a screen turns into its own words. */
export const READER_REFUSAL = {
  walletReadNothing: 'wallet-read-nothing', accountNotHeld: 'account-not-held', vaultNotHeld: 'vault-not-held',
  committeeOutOfDate: 'committee-out-of-date', keysNotGiven: 'keys-not-given', notSigned: 'not-signed',
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
  const committee = seats.committee.map(idOf);
  const onCommittee = new Set(committee);
  if (onCommittee.size !== committee.length) {
    return refused('committee-out-of-date', 'the committee on the chain lists one key twice, so it is not one key per signer. Nothing is approved '
      + 'until the company\'s committee is put right.');
  }
  if (!onCommittee.has(idOf(input.mine))) {
    return refused('account-not-held', 'the company\'s account is not held by its own committee yet - the chain does not list your key on it - '
      + 'so nobody\'s key can be checked against it. Finish handing the company\'s account to its committee first; if it '
      + 'has been handed over since you opened the company, open the company with your wallet again.');
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
  const vault = held.committee.map(idOf);
  if (vault.length !== committee.length || vault.some((k) => !onCommittee.has(k))
    || new Set(vault).size !== vault.length || held.threshold !== seats.threshold) {
    return refused('vault-not-held', 'this vault is not held by the same committee as the company\'s account, so its secret is not approved '
      + 'from here. Finish handing the vault to the company\'s committee first.');
  }
  const seated = new Set(seats.seats.map(fold));
  if (committee.length !== seated.size) {
    return refused('committee-out-of-date', `the company's committee on the chain has ${plural(committee.length, 'key', 'keys')} and its account seats `
      + `${plural(seated.size, 'signer', 'signers')}, so somebody who has left still holds a seat or somebody new `
      + 'has none yet. Bring the committee up to date with the signers before approving a secret.');
  }

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
    if (!onCommittee.has(id)) {
      return refused('committee-out-of-date', `${entry.name}'s wallet key is not on the company's committee on the chain, so their copy of the secret `
        + 'cannot be checked. Bring the committee up to date with the signers before approving a secret.');
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
