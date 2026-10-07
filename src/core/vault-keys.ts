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
import { recordsKeySignedBy, directoryEntrySignedBy, type DirectoryEntryStatement } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { sign, verify, type Hex } from './crypto.js';
import type { Account, Signer } from './types.js';

export type VaultKey = { readonly tag: string; readonly value: string };

/**
 * One signer's vault keys as the roster keeps them: the two public keys and
 * that signer's signature over them, and the signer's wallet's own signature
 * by the committee key over the records key and the seat the signer holds
 * (`recordsKeyStatement`, `recordsKeySeat`), which a device checks against the
 * committee and the seats the chain lists.
 */
export interface SignedVaultKeys {
  readonly committeeKey: VaultKey;
  readonly recordsKey: Hex;
  readonly signature: Hex;
  readonly recordsKeyStatement?: Hex | null;
  /** The seat on the company's account the statement is signed for. */
  readonly recordsKeySeat?: Hex | null;
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
  accountId: string, signerId: string,
  keys: { committeeKey: VaultKey; recordsKey: Hex; recordsKeyStatement?: Hex | null; recordsKeySeat?: Hex | null }, signingSecret: Hex,
): SignedVaultKeys => ({
  committeeKey: { tag: fold(keys.committeeKey.tag), value: fold(keys.committeeKey.value) },
  recordsKey: fold(keys.recordsKey) as Hex,
  signature: sign(vaultKeysMessage(accountId, signerId, keys), signingSecret),
  ...(keys.recordsKeyStatement && keys.recordsKeySeat
    ? { recordsKeyStatement: fold(keys.recordsKeyStatement) as Hex, recordsKeySeat: fold(keys.recordsKeySeat) as Hex } : {}),
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
  readonly keys: {
    readonly committeeKey: VaultKey; readonly recordsKey: Hex;
    /** The wallet's signature by the committee key over the records key and seat, or null where the entry carries none. */
    readonly recordsKeyStatement: Hex | null;
    /** The seat that statement is signed for, or null where the entry carries none. */
    readonly recordsKeySeat: Hex | null;
  } | null;
}

export function rosterVaultKeys(account: Pick<Account, 'id' | 'signers'>): RosterVaultKeys[] {
  return account.signers.filter((s) => s.status === 'active').map((s) => ({
    signerId: s.id,
    userId: s.userId,
    name: s.name,
    filingKey: fold(s.signingPublicKey) as Hex,
    keys: vaultKeysAreTheSigners(account.id, s)
      ? { committeeKey: { tag: fold(s.vaultKeys!.committeeKey.tag), value: fold(s.vaultKeys!.committeeKey.value) },
          recordsKey: fold(s.vaultKeys!.recordsKey) as Hex,
          recordsKeyStatement: s.vaultKeys!.recordsKeyStatement && s.vaultKeys!.recordsKeySeat ? fold(s.vaultKeys!.recordsKeyStatement) as Hex : null,
          recordsKeySeat: s.vaultKeys!.recordsKeyStatement && s.vaultKeys!.recordsKeySeat ? fold(s.vaultKeys!.recordsKeySeat) as Hex : null }
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

/**
 * Why the records keys the service reports are not exactly the ones the roster
 * names, or null when they are: none the roster does not name, and - once the
 * service reports a complete committee, which is when the vault's secret is
 * wrapped to them - none it names left out.
 */
export function whyNotTheRostersReaders(
  readers: readonly Hex[], roster: readonly RosterVaultKeys[], opts: { complete: boolean } = { complete: true },
): string | null {
  const named = new Set(roster.flatMap((r) => (r.keys === null ? [] : [fold(r.keys.recordsKey)])));
  const stranger = readers.filter((k) => !named.has(fold(k))).length;
  if (stranger > 0) {
    return `this service reports ${stranger} records key(s) the company's own roster does not name, so the vault's secret `
      + 'is not wrapped to them. Reload the page, and if it happens again, contact support.';
  }
  if (!opts.complete) return null;
  const reported = new Set(readers.map(fold));
  const missing = [...named].filter((k) => !reported.has(k)).length;
  return missing === 0 ? null
    : `this service left ${missing} records ${missing === 1 ? 'key' : 'keys'} the company's own roster names out of the `
      + `vault, so ${missing === 1 ? 'that signer' : 'those signers'} could not read the vault's records. The vault is `
      + 'not set up from here. Reload the page, and if it happens again, contact support.';
}

export class VaultKeysNotYours extends Error {
  constructor() {
    super('these vault keys were not set up from your own seat on this company, so they are not kept. Open the '
      + 'company on this device again and set them up from Vaults.');
    this.name = 'VaultKeysNotYours';
  }
}

/**
 * A signer giving their records key again with a statement that does not
 * verify: not signed by the committee key their entry already carries, or for a
 * seat that is not the one the roster holds for them. The statement kept
 * before is kept.
 */
export class RecordsKeyNotSignedForYourSeat extends VaultKeysNotYours {
  constructor() {
    super();
    this.message = 'your records key was not signed by your own wallet for the seat you hold on this company, so it is '
      + 'not kept; any records key given before stays as it was. Open the company with your own wallet on this device and set up its '
      + 'vaults again.';
    this.name = 'RecordsKeyNotSignedForYourSeat';
  }
}

/** A signer giving different vault keys from the ones their roster entry already carries. */
export class VaultKeysAlreadyGiven extends Error {
  constructor() {
    super('you already set up different vault keys for this company, from a different wallet. The first ones are '
      + 'kept and these are not. Open the company with that wallet, or ask the company\'s signers to remove you and '
      + 'invite you again.');
    this.name = 'VaultKeysAlreadyGiven';
  }
}

/** Somebody with no seat on the company giving vault keys for it. */
export class NoSeatToGiveKeysFor extends Error {
  constructor() {
    super('only a signer with access to this company sets up vault keys for it. Ask a signer to grant you access.');
    this.name = 'NoSeatToGiveKeysFor';
  }
}


/**
 * **WHETHER A WALLET'S STATEMENT OVER A RECORDS KEY IS FOR THIS SIGNER'S SEAT**:
 * signed by the committee key the signer gives, over the records key they give,
 * for the seat the roster holds for them, on the company's account, under the
 * company's label.
 */
export const recordsKeyIsForTheSeat = (
  label: CompanyLabel, account: AccountAddress, seat: Pick<Signer, 'leafCommitment'>,
  keys: { readonly committeeKey: VaultKey; readonly recordsKey: Hex }, statement: Hex, signedSeat: Hex,
): boolean => {
  const ownSeat = typeof seat.leafCommitment === 'string' ? seat.leafCommitment.toLowerCase() : null;
  return ownSeat !== null && signedSeat.toLowerCase() === ownSeat
    && recordsKeySignedBy(label, account, { tag: keys.committeeKey.tag, value: keys.committeeKey.value.toLowerCase() },
      { recordsKey: keys.recordsKey.toLowerCase(), seat: signedSeat.toLowerCase(), signature: statement.toLowerCase() });
};

/**
 * **ONE SIGNER'S VAULT KEYS, WRITTEN INTO THEIR OWN ENTRY OF A ROSTER**, or
 * `'already-given'` when the roster holds them already, or a refusal. Refused
 * unless signed with that entry's own signing key, so nobody can put a key in
 * another signer's name without that signer's signing secret. Given once: the
 * same keys again are taken only for a new statement over the records key,
 * which is kept only when it verifies; different keys are refused. Pure: the
 * roster is the caller's, opened on its device.
 */
export function rosterWithVaultKeys<R extends { readonly signers: readonly Signer[] }>(
  roster: R, accountId: string, label: CompanyLabel, account: AccountAddress, signerId: string, given: SignedVaultKeys,
): R | 'already-given' {
  const seat = roster.signers.find((s) => s.id === signerId && s.status === 'active');
  if (seat === undefined) throw new NoSeatToGiveKeysFor();
  if (!vaultKeysAreTheSigners(accountId, { ...seat, vaultKeys: given })) throw new VaultKeysNotYours();
  const statement = given.recordsKeyStatement ?? null;
  const signedSeat = given.recordsKeySeat ?? null;
  let kept: NonNullable<Signer['vaultKeys']>;
  if (seat.vaultKeys) {
    const same = seat.vaultKeys.committeeKey.value.toLowerCase() === given.committeeKey.value.toLowerCase()
      && seat.vaultKeys.recordsKey.toLowerCase() === given.recordsKey.toLowerCase();
    if (!same) throw new VaultKeysAlreadyGiven();
    if (statement === null || signedSeat === null
      || (statement === (seat.vaultKeys.recordsKeyStatement ?? null) && signedSeat === (seat.vaultKeys.recordsKeySeat ?? null))) {
      return 'already-given';
    }
    if (!recordsKeyIsForTheSeat(label, account, seat, seat.vaultKeys, statement, signedSeat)) throw new RecordsKeyNotSignedForYourSeat();
    kept = { ...seat.vaultKeys, recordsKeyStatement: statement, recordsKeySeat: signedSeat };
  } else {
    if (statement !== null && signedSeat !== null && !recordsKeyIsForTheSeat(label, account, seat, given, statement, signedSeat)) {
      throw new RecordsKeyNotSignedForYourSeat();
    }
    kept = {
      committeeKey: { ...given.committeeKey }, recordsKey: given.recordsKey, signature: given.signature,
      ...(statement !== null && signedSeat !== null ? { recordsKeyStatement: statement, recordsKeySeat: signedSeat } : {}),
    };
  }
  return { ...roster, signers: roster.signers.map((s) => (s.id === signerId ? { ...s, vaultKeys: kept } : s)) };
}

/**
 * **A NEW SIGNER'S VAULT KEYS, OFFERED BEFORE THEY CAN FILE THE ROSTER
 * THEMSELVES.** Public keys and signatures only: the keys signed with the
 * signer's own signing key for their roster entry, and the directory entry their
 * own wallet signed for their seat, which names that signing key. It is a
 * waiting slot, never the roster: a seat the company already believes folds it
 * into the roster from its own device, after checking it against the roster it
 * opened (`rosterWithVaultKeys`).
 */
export interface VaultKeysOffer {
  /** The roster entry the keys are signed for. */
  readonly signerId: string;
  /** The signed-in person who offered them. The service's attribution, checked against who is signed in. */
  readonly person: string;
  readonly entry: { readonly committeeKey: VaultKey; readonly statement: DirectoryEntryStatement };
  readonly keys: SignedVaultKeys;
}

/**
 * **AN OFFER AS THE COMPANY KEEPS IT**: the fields an offer has and nothing
 * else a client sent beside them, so what every member is handed back is only
 * what was checked.
 */
export const offerAsKept = (o: VaultKeysOffer): VaultKeysOffer => {
  const st = o.entry.statement;
  const k = o.keys;
  return {
    signerId: o.signerId, person: o.person,
    entry: {
      committeeKey: { tag: o.entry.committeeKey.tag, value: o.entry.committeeKey.value } as VaultKey,
      statement: { account: st.account, signingKey: st.signingKey, wrappingKey: st.wrappingKey, seat: st.seat, signature: st.signature },
    },
    keys: {
      committeeKey: { tag: k.committeeKey.tag, value: k.committeeKey.value } as VaultKey, recordsKey: k.recordsKey, signature: k.signature,
      ...(k.recordsKeyStatement === undefined ? {} : { recordsKeyStatement: k.recordsKeyStatement }),
      ...(k.recordsKeySeat === undefined ? {} : { recordsKeySeat: k.recordsKeySeat }),
    },
  };
};

/**
 * Why `offer` is not one this company keeps, or null: the directory entry its
 * wallet signed must verify for this company's label and account, under the
 * committee key the keys name; the records key must be the one the entry names;
 * and the keys must be signed for the roster entry named, by the signing key
 * the wallet's entry names. Whether the account holds the seat is the chain's
 * question, asked by the caller.
 */
export const vaultKeysOfferRefusal = (
  label: CompanyLabel, account: AccountAddress, accountId: string, offer: unknown,
): string | null => {
  if (typeof offer !== 'object' || offer === null) return 'it is not an offer of vault keys';
  const o = offer as Partial<VaultKeysOffer>;
  if (typeof o.signerId !== 'string' || o.signerId.length === 0 || o.signerId.length > 64) return 'it names no signer';
  const e = o.entry as Partial<VaultKeysOffer['entry']> | undefined;
  const k = o.keys as Partial<SignedVaultKeys> | undefined;
  if (typeof e !== 'object' || e === null || typeof e.statement !== 'object' || e.statement === null || typeof e.committeeKey !== 'object') {
    return 'it carries no directory entry signed by the signer\'s wallet';
  }
  if (typeof k !== 'object' || k === null || typeof k.committeeKey !== 'object' || k.committeeKey === null
    || typeof k.recordsKey !== 'string' || typeof k.signature !== 'string') return 'it carries no signed vault keys';
  if (!directoryEntrySignedBy(label, account, e.committeeKey!, e.statement)) {
    return 'its directory entry is not signed by the signer\'s wallet for this company';
  }
  if (fold(e.committeeKey!.tag) !== fold(k.committeeKey.tag) || fold(e.committeeKey!.value) !== fold(k.committeeKey.value)) {
    return 'its vault keys name another committee key than the wallet that signed its entry';
  }
  if (fold(String(e.statement.wrappingKey)) !== fold(k.recordsKey)) return 'its records key is not the one its entry names';
  let ok = false;
  try { ok = verify(vaultKeysMessage(accountId, o.signerId, k as SignedVaultKeys), k.signature, String(e.statement.signingKey)); } catch { ok = false; }
  return ok ? null : 'its vault keys are not signed by the signing key its own directory entry names';
};
