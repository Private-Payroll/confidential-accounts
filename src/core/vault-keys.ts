/**
 * **WHICH VAULT KEYS BELONG TO WHICH SIGNER IS SAID BY THE SEALED ROSTER, AND BY
 * NOTHING ELSE.**
 *
 * A signer gives two public keys for a company's vaults: the committee key they
 * sit on every vault's committee with, and the records key a vault's nonce
 * secret is wrapped to for them. The third, the filing key every sealed record
 * they file is signed with, is their roster signing key itself, so it needs no
 * statement of its own.
 *
 * The two are kept in the signer's own entry in the sealed roster, signed with
 * that signer's roster signing key. So:
 *
 *   - a device reads every signer's keys from a roster it opened itself, and
 *     accepts one only if the signature is that signer's. A key the service
 *     reports and no roster entry names is refused, and no member can put a key
 *     in another signer's entry without that signer's signing secret. The
 *     roster itself is sealed under the company's viewing key, so a party that
 *     holds that key can rewrite an entry whole, its signing key included, and
 *     nothing here can tell;
 *   - what the service keeps outside the roster is an index with no names in it
 *     - every committee key, every records key and every filing key of the
 *     company's seated signers, each list sorted by value - which is enough to
 *     assemble a committee and to refuse a filing from a key the company never
 *     gave, and says nothing about who holds which.
 *
 * Pure, so the page and the service ask the same questions of the same record.
 */
import { sign, verify, type Hex } from './crypto.js';
import type { Account, Signer } from './types.js';

export type VaultKey = { readonly tag: string; readonly value: string };

/** One signer's vault keys as the roster keeps them: the two public keys and that signer's signature over them. */
export interface SignedVaultKeys {
  readonly committeeKey: VaultKey;
  readonly recordsKey: Hex;
  readonly signature: Hex;
}

/** What the service keeps about a company's vault keys, with nobody's name on any of it. */
export interface CompanyVaultKeyIndex {
  readonly accountId: string;
  /** How many seated signers the index was made from, and how many of them had given keys. */
  readonly signerCount: number;
  readonly committeeKeys: readonly VaultKey[];
  readonly readers: readonly Hex[];
  readonly filers: readonly Hex[];
}

const fold = (h: string): string => h.trim().toLowerCase();

/** The statement a signer signs: this company, this seat, these two keys. */
export const vaultKeysMessage = (accountId: string, signerId: string, keys: { committeeKey: VaultKey; recordsKey: Hex }): string =>
  `midnight-accounts:vault-keys:v1:${accountId}:${signerId}:${fold(keys.committeeKey.tag)}:${fold(keys.committeeKey.value)}:${fold(keys.recordsKey)}`;

/** Signs one's own vault keys with one's roster signing secret. */
export const signVaultKeys = (
  accountId: string, signerId: string, keys: { committeeKey: VaultKey; recordsKey: Hex }, signingSecret: Hex,
): SignedVaultKeys => ({
  committeeKey: { tag: fold(keys.committeeKey.tag), value: fold(keys.committeeKey.value) },
  recordsKey: fold(keys.recordsKey) as Hex,
  signature: sign(vaultKeysMessage(accountId, signerId, keys), signingSecret),
});

/** Whether a roster entry's vault keys are signed by that entry's own signing key. */
export const vaultKeysAreTheSigners = (accountId: string, signer: Pick<Signer, 'id' | 'signingPublicKey' | 'vaultKeys'>): boolean =>
  signer.vaultKeys !== undefined && signer.vaultKeys !== null
  && verify(vaultKeysMessage(accountId, signer.id, signer.vaultKeys), signer.vaultKeys.signature, signer.signingPublicKey);

/** One seated signer's vault keys, read from the roster: null where they gave none or what is there is not theirs. */
export interface RosterVaultKeys {
  readonly signerId: string;
  readonly userId: string | null;
  readonly name: string;
  readonly filingKey: Hex;
  readonly keys: { readonly committeeKey: VaultKey; readonly recordsKey: Hex } | null;
}

export function rosterVaultKeys(account: Pick<Account, 'id' | 'signers'>): RosterVaultKeys[] {
  return account.signers.filter((s) => s.status === 'active').map((s) => ({
    signerId: s.id,
    userId: s.userId,
    name: s.name,
    filingKey: fold(s.signingPublicKey) as Hex,
    keys: vaultKeysAreTheSigners(account.id, s)
      ? { committeeKey: { tag: fold(s.vaultKeys!.committeeKey.tag), value: fold(s.vaultKeys!.committeeKey.value) },
          recordsKey: fold(s.vaultKeys!.recordsKey) as Hex }
      : null,
  }));
}

const byValue = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The index the service keeps, made from the roster: sorted, and with no names. */
export function vaultKeyIndexOf(account: Pick<Account, 'id' | 'signers'>): CompanyVaultKeyIndex {
  const roster = rosterVaultKeys(account);
  const given = roster.flatMap((r) => (r.keys === null ? [] : [r.keys]));
  return {
    accountId: account.id,
    signerCount: roster.length,
    committeeKeys: given.map((k) => k.committeeKey).sort((a, b) => byValue(a.value, b.value)),
    readers: given.map((k) => k.recordsKey).sort(byValue),
    filers: roster.map((r) => r.filingKey).sort(byValue),
  };
}

const idOf = (k: VaultKey): string => `${fold(k.tag)}:${fold(k.value)}`;

/**
 * **WHY A COMMITTEE THE SERVICE REPORTS IS NOT THE ONE THE ROSTER NAMES**, or
 * null when it is. Every seated signer must have given keys the roster says are
 * theirs, and the committee must be exactly those keys: none missing, none
 * added, none twice.
 */
export function whyNotTheRostersCommittee(
  committee: readonly VaultKey[], roster: readonly RosterVaultKeys[],
): string | null {
  const unsigned = roster.filter((r) => r.keys === null).length;
  if (unsigned > 0) {
    return `${unsigned} of this company's ${roster.length} signers ${unsigned === 1 ? 'has' : 'have'} not set up vault `
      + 'keys that the company\'s own roster says are theirs. Each of them opens Vaults on their own device and sets '
      + 'them up; until then no vault is created, funded or handed over.';
  }
  const named = new Set(roster.map((r) => idOf(r.keys!.committeeKey)));
  const reported = committee.map(idOf);
  if (new Set(reported).size !== reported.length) {
    return 'the committee this service reports names one key twice, so it is not the company\'s. Nothing was '
      + 'created or funded; reload the page, and if it happens again, contact support.';
  }
  const stranger = reported.filter((k) => !named.has(k)).length;
  if (stranger > 0) {
    return `the committee this service reports carries ${stranger} key(s) the company's own roster does not name, so it `
      + 'is not the company\'s. Nothing was created or funded; reload the page, and if it happens again, contact support.';
  }
  if (reported.length !== named.size) {
    return `the committee this service reports has ${reported.length} key(s) and the company's own roster names `
      + `${named.size}, so it is not the company's. Reload the page; if a signer has just joined or left, wait for `
      + 'them to set up their vault keys.';
  }
  return null;
}

/** Why the records keys the service reports are not all ones the roster names, or null when they are. */
export function whyNotTheRostersReaders(readers: readonly Hex[], roster: readonly RosterVaultKeys[]): string | null {
  const named = new Set(roster.flatMap((r) => (r.keys === null ? [] : [fold(r.keys.recordsKey)])));
  const stranger = readers.filter((k) => !named.has(fold(k))).length;
  return stranger === 0 ? null
    : `this service reports ${stranger} records key(s) the company's own roster does not name, so the vault's secret `
      + 'is not wrapped to them. Reload the page, and if it happens again, contact support.';
}
