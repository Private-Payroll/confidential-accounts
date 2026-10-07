/**
 * **A COMPANY'S SIGNERS AS ONE OF ITS OWN RECORDS: SEALED AND SIGNED ON A
 * SEAT'S DEVICE, ONE VERSION AT A TIME.**
 *
 * Who holds a seat, their name and role as the company knows them, the public
 * keys their device made, the leaf the chain holds for them and the vault keys
 * they gave - sealed under the company's roster key, which every signer's
 * device works out from the viewing key, and signed by the seat that filed the
 * version. The service files a version only for a seat of the company whose
 * role may file a roster (check S), and opens none.
 *
 * Pure: the page and the service both import it.
 */
import { directoryEntrySignedBy } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { Hex } from './crypto.js';
import { canonical } from './crypto.js';
import { openRecord, sealRecord } from './sealed-records.js';
import type { Signer } from './types.js';
import { vaultKeysAreTheSigners } from './vault-keys.js';
import {
  signCompanyFiling, verifiedCompanyFiler, whyThisIsNotACompanyRecord, type SealedCompanyRecord,
} from '../midnight/sealed-record-wire.js';

/** The one id a company's roster is filed under. */
export const ROSTER_ID = 'signers';

/** What a roster holds: the company's name and its seated signers. Those waiting for a seat are in its inbox. */
export interface RosterSecrets { name: string; signers: Signer[] }

/** One version of a company's roster, sealed under its roster key and not yet signed. */
export const sealRoster = (
  company: string, roster: RosterSecrets, version: number, keyEpoch: number, viewingKey: Hex,
): SealedCompanyRecord => ({
  company, kind: 'roster', id: ROSTER_ID, version, keyEpoch,
  sealed: sealRecord<RosterSecrets>('roster', company, { name: roster.name, signers: roster.signers.filter((s) => s.status !== 'pending') }, viewingKey),
  wrapped: [],
});

/** A company's roster record, opened with its viewing key. */
export const openRoster = (rec: Pick<SealedCompanyRecord, 'company' | 'sealed'>, viewingKey: Hex): RosterSecrets =>
  openRecord<RosterSecrets>('roster', rec.company, rec.sealed, viewingKey);

/** The key epoch a company's first roster is sealed at: the one it is founded at. */
const FOUNDING_ROSTER_EPOCH = 0;

/**
 * **A COMPANY'S FIRST ROSTER, AS ITS FOUNDING SIGNER'S DEVICE FILES IT**:
 * version 1 at the founding epoch, the founding signer's entry only, signed by
 * their seat. Filed with the company itself, so a company's signers are never
 * held anywhere but in its roster records.
 */
export const signedFoundingRoster = (company: string, roster: RosterSecrets, viewingKey: Hex, signingSecret: Hex): SealedCompanyRecord =>
  signCompanyFiling(sealRoster(company, roster, 1, FOUNDING_ROSTER_EPOCH, viewingKey), signingSecret);

/**
 * Why `rec` is not this company's first roster signed by the seat with
 * `foundingSigningKey`, or null when it is.
 */
export const foundingRosterRefusal = (rec: unknown, company: string, foundingSigningKey: string): string | null => {
  const shape = whyThisIsNotACompanyRecord(rec, { company, kind: 'roster', id: ROSTER_ID });
  if (shape !== null) return shape;
  const r = rec as SealedCompanyRecord;
  if (r.version !== 1) return 'it is not the first version of the company\'s roster';
  if (r.keyEpoch !== FOUNDING_ROSTER_EPOCH) return 'it is not sealed at the epoch a company is founded at';
  const filer = verifiedCompanyFiler(r);
  if (filer === null) return 'it is not signed, or its signature does not cover it';
  if (filer.toLowerCase() !== String(foundingSigningKey).toLowerCase()) return 'it is signed by a seat other than the founding signer\'s';
  return null;
};

/** Whether two rosters say the same thing, field for field. */
export const sameRoster = (a: RosterSecrets, b: RosterSecrets): boolean =>
  canonical({ name: a.name, signers: a.signers.filter((s) => s.status !== 'pending') })
  === canonical({ name: b.name, signers: b.signers.filter((s) => s.status !== 'pending') });

/**
 * **THE SIGNERS ARE A RECORD THEIR SEATS SIGN, SO NOTHING HERE WRITES THEM.**
 * Thrown by a write that would change a company's signers once they are its
 * roster record: only a seat's device files the next version.
 */
export class RosterIsASignedRecord extends Error {
  constructor() {
    super('this company\'s signers are a record its seats sign, so they change only from a signer\'s own device. '
      + 'Nothing was written.');
    this.name = 'RosterIsASignedRecord';
  }
}

/* ------------------------------------------------------------------ which entries a device believes */

/**
 * **WHY A DEVICE DOES NOT BELIEVE ONE ENTRY OF A ROSTER IT OPENED.** The
 * roster is filed whole by one seat, so the seat that filed it is not who an
 * entry is believed from: each entry is held to its own signer's witnesses.
 * Each is a sentence a person can act on.
 */
export const ROSTER_ENTRY_REFUSAL = Object.freeze({
  'seat-not-on-the-chain': 'the seat it names is not one the company\'s account holds on the chain now',
  'no-entry-of-their-own': 'no entry their own wallet signed for that seat names a key yet. They are shown once they open the '
    + 'company on their own device and set up their vault keys',
  'not-their-signing-key': 'the signing key it gives is not the one their own wallet signed for that seat',
  'wallet-taken': 'the wallet that signed its entry already signed another signer\'s entry, and a wallet holds one seat',
  'vault-keys-not-theirs': 'its vault keys are not signed by that signer\'s own signing key, or name another wallet than '
    + 'the one that signed their entry',
  'rights-not-the-chains': 'it gives rights the chain did not seat it with: every seat the company makes is seated with '
    + 'every right',
} as const);
export type RosterEntryRefusal = keyof typeof ROSTER_ENTRY_REFUSAL;

/** A seat's entry in the company's directory, as the device that reads the roster believes it. */
export interface DirectoryWitness {
  readonly seat: string;
  readonly signingKey: string;
  readonly committeeKey: { readonly tag: string; readonly value: string };
}

/** What a device holds each roster entry to: the chain its own wallet read, the directory it believes, its own key. */
export interface RosterWitnesses {
  readonly accountId: string;
  readonly label: CompanyLabel;
  readonly account: AccountAddress;
  /** Every seat the company's account holds now, as the person's own wallet read it. */
  readonly seatsOnTheChain: readonly string[];
  /** The company's directory as this device believes it. */
  readonly directory: readonly DirectoryWitness[];
  /**
   * This device's own roster entry and the signing key its own secret makes.
   * The device's own key material is the witness for its own entry before its
   * wallet has signed one: what lets a new signer find their seat to set up
   * their vault keys.
   */
  readonly own?: { readonly signerId?: string | null; readonly signingPublicKey: string } | null;
}

const low = (h: unknown): string => String(h ?? '').toLowerCase();
const walletOf = (k: { readonly tag: string; readonly value: string } | null | undefined): string =>
  (k ? `${low(k.tag)}:${low(k.value)}` : '');

/** Every right on every vault: how every seat the company makes is seated (the all-vaults scope its leaf commits to). */
const seatedWithEveryRight = (rights: Signer['rights']): boolean =>
  rights === undefined || rights === null || (rights as { every?: unknown }).every === true;

/**
 * **WHY THIS DEVICE DOES NOT BELIEVE ONE ROSTER ENTRY, OR NULL WHEN IT DOES.**
 *
 * An entry is believed only when:
 *   · the seat it names is one the company's account holds now;
 *   · the signing key it gives is the one its signer's own wallet signed for
 *     that seat: the believed directory's entry for the seat, else the entry
 *     the signer's wallet signed and the roster keeps beside their vault keys,
 *     made by a wallet that signed no other signer's entry (else, for this
 *     device's own entry only, the key its own secret makes);
 *   · its vault keys, where it has them, are signed by that signing key and
 *     name the wallet that signed the entry;
 *   · it gives the rights the chain seated it with, which for every seat the
 *     company makes is every right: the chain holds a leaf, and the leaf of
 *     every seat raised is made under the scope of all vaults.
 * `others` is every other entry of the same roster, for the one-wallet rule.
 */
export function rosterEntryRefusal(s: Signer, w: RosterWitnesses, others: readonly Signer[] = []): RosterEntryRefusal | null {
  return rosterEntryJudged(s, w, others).why;
}

/**
 * `rosterEntryRefusal`, with the wallet the entry was believed on: the one
 * that signed its signer's entry, or null when the entry is believed on this
 * device's own key alone. Null `why` means believed.
 */
const rosterEntryJudged = (
  s: Signer, w: RosterWitnesses, others: readonly Signer[],
): { readonly why: RosterEntryRefusal | null; readonly wallet: string | null } => {
  const no = (why: RosterEntryRefusal) => ({ why, wallet: null });
  const seat = typeof s.leafCommitment === 'string' ? s.leafCommitment.toLowerCase() : null;
  if (seat === null || !w.seatsOnTheChain.some((x) => low(x) === seat)) return no('seat-not-on-the-chain');
  const key = low(s.signingPublicKey);
  const inDirectory = w.directory.find((d) => low(d.seat) === seat) ?? null;
  const kept = s.directoryEntry ?? null;
  let wallet: string | null = null;
  if (inDirectory !== null) {
    if (low(inDirectory.signingKey) !== key) return no('not-their-signing-key');
    wallet = walletOf(inDirectory.committeeKey);
  }
  if (kept !== null) {
    const st = kept.statement;
    if (typeof st !== 'object' || st === null || low(st.seat) !== seat || low(st.signingKey) !== key
      || !directoryEntrySignedBy(w.label, w.account, kept.committeeKey, st)) return no('not-their-signing-key');
    if (wallet !== null && wallet !== walletOf(kept.committeeKey)) return no('not-their-signing-key');
    if (wallet === null) {
      const mine = walletOf(kept.committeeKey);
      const taken = w.directory.some((d) => low(d.seat) !== seat && walletOf(d.committeeKey) === mine)
        || others.some((o) => o.id !== s.id && (walletOf(o.directoryEntry?.committeeKey) === mine || walletOf(o.vaultKeys?.committeeKey) === mine));
      if (taken) return no('wallet-taken');
      wallet = mine;
    }
  }
  if (wallet === null) {
    const isOwn = w.own !== undefined && w.own !== null && typeof w.own.signerId === 'string' && w.own.signerId === s.id
      && low(w.own.signingPublicKey) === key;
    if (!isOwn) return no('no-entry-of-their-own');
  }
  if (s.vaultKeys !== undefined && s.vaultKeys !== null) {
    if (!vaultKeysAreTheSigners(w.accountId, s)) return no('vault-keys-not-theirs');
    if (wallet !== null && walletOf(s.vaultKeys.committeeKey) !== wallet) return no('vault-keys-not-theirs');
  }
  if (!seatedWithEveryRight(s.rights)) return no('rights-not-the-chains');
  return { why: null, wallet };
};

/** One roster entry a device did not believe: who it names, and why. */
export interface RefusedEntry { readonly signerId: string; readonly name: string; readonly why: RosterEntryRefusal }

/**
 * **THE ROSTER AS A DEVICE BELIEVES IT**: every seated entry that passes
 * `rosterEntryRefusal`, and each one that does not, with why. A refused entry
 * is not shown and nothing is built on it; a person waiting for a seat is not
 * a roster entry and is left as it is.
 */
export function believedSigners(
  signers: readonly Signer[], w: RosterWitnesses,
): { readonly believed: Signer[]; readonly refused: RefusedEntry[]; readonly wallets: Readonly<Record<string, string>> } {
  const seated = signers.filter((s) => s.status === 'active');
  const believed: Signer[] = [];
  const refused: RefusedEntry[] = [];
  const wallets: Record<string, string> = {};
  for (const s of signers) {
    if (s.status !== 'active') { believed.push(s); continue; }
    const { why, wallet } = rosterEntryJudged(s, w, seated);
    if (why !== null) { refused.push({ signerId: s.id, name: s.name, why }); continue; }
    believed.push(s);
    if (wallet !== null) wallets[low(s.leafCommitment)] = wallet;
  }
  return { believed, refused, wallets };
}

/**
 * **THE SEATS THE CHAIN HOLDS THAT NO BELIEVED ENTRY OF A ROSTER NAMES.** A
 * committee, a reader list or a count of approvers is built only from a roster
 * for which this is empty: a seat the chain holds whose signer the roster does
 * not show is a signer left out of whatever is built from it.
 */
export const seatsNotBelieved = (believed: readonly Signer[], seatsOnTheChain: readonly string[]): string[] =>
  [...new Set(seatsOnTheChain.map(low))].filter((seat) =>
    !believed.some((s) => s.status === 'active' && low(s.leafCommitment) === seat));
