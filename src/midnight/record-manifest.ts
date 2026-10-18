/**
 * **EVERY RECORD A COMPANY FILES, AND THE ENTRY THAT NAMES IT IN THE COMPANY'S
 * RECORD TREE.**
 *
 * A company's records live in five stores: its own sealed records, each
 * vault's records, its payroll runs, its proposals and its seat directory. The
 * service keeps all of them and is assumed to lie: it could serve an older
 * version of a record, leave one out, or put them in another order. So every
 * filing also gets one entry - naming the record, its version and the digest
 * of exactly what its filer signed, signed in turn by that filer - and the
 * company's account on chain keeps one value, the head, that binds the root of
 * a tree holding each record's newest anchored entry (`record-tree.ts`).
 *
 *   · **an entry** is `{ store, kind, id, version, digest }`, signed by the seat
 *     that filed the record (`signManifestEntry`). Its digest is the SHA-256 of
 *     the message the record's own signature covers in its store, so a record a
 *     device reads is the anchored one exactly when it makes the same digest.
 *   · **who held the account** as the anchoring seat judged a header is named
 *     in it (`BatchHolders`): the approvals the account requires, the root of
 *     its signer tree and the leaf in each slot of that tree. The account's
 *     `anchor` call checks the approvals and the root against the account as
 *     the call runs and refuses otherwise, and binds both into the head.
 *   · **what a read says of a record** is one of `RecordStanding`, worked out
 *     against what that read holds of the tree; the directory as it was
 *     anchored with a header is `DirectoryAsAnchored`.
 *
 * An entry no header holds yet is NOT YET ANCHORED - never forged, and never
 * believed as the newest version; the next anchor from any seat covers it. A
 * record's versions never go back: an entry whose digest an earlier version of
 * the same record already names is never anchored.
 *
 * Pure, and loads no WebAssembly: the server and the page both import it.
 */
import { canonical, sign, signingPublicKeyOf, verify, type Hex } from '../core/crypto.js';
import { RUN_ID, runFilingMessage, type RunToFile } from '../core/run-filing.js';
import { PROPOSAL_ID, proposalFilingMessage, type ProposalFiling } from '../core/proposal-filing.js';
import {
  COMPANY_RECORD_KINDS, companyFilingMessage, digestOfBody, filingMessage, WIRE_RECORDS,
  type CompanyRecordKind, type SealedCompanyRecord, type WireRecord,
} from './sealed-record-wire.js';
import type { SealedPool } from './vault-pool.js';
import { companyRecordKey, vaultRecordKey, type DirectoryFiling, type FiledKind } from './seat-directory.js';

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX128 = /^[0-9a-f]{128}$/u;
const COMPANY_RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/u;

/** The head the account holds before its first anchor: thirty-two zero bytes. */
export const EMPTY_HEAD: Hex = '00'.repeat(32);

/** The five stores a company's records are filed in. */
export const MANIFEST_STORES = ['company', 'vault', 'run', 'proposal', 'directory'] as const;
export type ManifestStore = (typeof MANIFEST_STORES)[number];

/** The one record a company's seat directory is, as its entries name it. */
export const DIRECTORY_RECORD = 'directory';

/** What one entry says: which record, which version, and the digest of what its filer signed. */
export interface ManifestEntryBody {
  readonly store: ManifestStore;
  /** The store's own kind: a company record's kind, a vault record's name, or the store's name for the other three. */
  readonly kind: string;
  /** The record's id: a company record's id, the vault for a vault record, a run's or a proposal's name, or `directory`. */
  readonly id: string;
  readonly version: number;
  /** SHA-256, lower-case hex, of the message the record's own signature covers in its store. */
  readonly digest: Hex;
}

/** A record an entry names, as its store keeps it: the digest of what its filer signed, and that filer's key. */
export interface FiledAs { readonly digest: Hex; readonly filedBy: Hex }

/** One entry as it is entered: signed by the seat that filed the record. */
export interface ManifestEntry extends ManifestEntryBody {
  readonly filedBy: { readonly publicKey: Hex; readonly signature: Hex };
}

/**
 * **WHO HELD THE COMPANY'S ACCOUNT AS THE ANCHORING SEAT JUDGED ITS BATCH**,
 * as its own wallet's indexer showed it: the approvals the account requires,
 * the root of its signer tree as 64 hex digits of the field (big-endian), and
 * the leaf in each slot of that tree from slot 0 up to its first free slot - a
 * removed signer's slot holding the account's vacant-slot leaf. The account's
 * `anchor` call refuses unless the approvals and the root are the account's as
 * it runs; the leaves are believed only when they make that root.
 */
export interface BatchHolders {
  readonly approvals: number;
  readonly signerRoot: Hex;
  readonly signers: readonly Hex[];
}

/** The most slots the account's signer tree has: a tree of height ten. */
export const SIGNER_SLOTS = 1024;

/** Why `value` is not who held an account in the shape a header names it, or null. */
export const batchHoldersShapeRefusal = (value: unknown): string | null => {
  const h = value as Partial<BatchHolders> | null;
  if (h === null || typeof h !== 'object') return 'it does not name who held the account as it was judged';
  if (!Number.isSafeInteger(h.approvals) || (h.approvals as number) < 1) return 'it does not name the approvals the account required';
  if (typeof h.signerRoot !== 'string' || !HEX64.test(h.signerRoot)) return 'it does not name the root of the account\'s signers';
  if (!Array.isArray(h.signers) || h.signers.length === 0 || h.signers.length > SIGNER_SLOTS
    || h.signers.some((x) => typeof x !== 'string' || !HEX64.test(x))) return 'it does not name the leaf in each of the account\'s signer slots';
  return null;
};

/** The manifest's paths on the service, spelled once for both ends. */
export const manifestPaths = {
  /** POST entries to enter. */
  entries: (company: string) => `/api/accounts/${encodeURIComponent(company)}/manifest/entries`,
  /** POST records, answered with the newest version entered for each. */
  newest: (company: string) => `/api/accounts/${encodeURIComponent(company)}/manifest/newest`,
  /** GET every entry newer than its record's leaf at a root (`?root=`). */
  treePending: (company: string) => `/api/accounts/${encodeURIComponent(company)}/manifest/tree/pending`,
  /** The tree's headers: GET a page after a seq (`?after=&limit=`), POST one to keep. */
  treeHeaders: (company: string) => `/api/accounts/${encodeURIComponent(company)}/manifest/tree/headers`,
  /** One read's proofs against one root, in one request. */
  treeProofs: (company: string) => `/api/accounts/${encodeURIComponent(company)}/manifest/tree/proofs`,
};

/** A bound on one request to enter entries, not on a batch: a device with more to enter sends several. */
export const ENTRIES_AT_ONCE = 64;

/* ------------------------------------------------------------------ what each store's entry is */

/** A company record's entry: the digest of what `signCompanyFiling` signs. */
export const companyRecordEntry = (rec: SealedCompanyRecord): ManifestEntryBody => ({
  store: 'company', kind: rec.kind, id: rec.id, version: rec.version, digest: digestOfBody(companyFilingMessage(rec)),
});

/** A vault record's entry: the digest of what `signFiling` signs. */
export const vaultRecordEntry = (record: WireRecord, rec: SealedPool): ManifestEntryBody => ({
  store: 'vault', kind: record, id: rec.vault, version: rec.version, digest: digestOfBody(filingMessage(record, rec)),
});

/**
 * A run's entry: the digest of what `signRunFiling` signs. A run is kept whole
 * and changed in place, so its version is the count of its entries, and the
 * filer names the one after the newest it has seen.
 */
export const runEntry = (company: string, run: RunToFile, version: number): ManifestEntryBody => ({
  store: 'run', kind: 'run', id: run.id, version, digest: digestOfBody(runFilingMessage(company, run)),
});

/** A proposal's entry: the digest of what `signProposalFiling` signs. A proposal is filed once. */
export const proposalEntry = (company: string, f: ProposalFiling): ManifestEntryBody => ({
  store: 'proposal', kind: 'proposal', id: f.id, version: 1, digest: digestOfBody(proposalFilingMessage(company, f)),
});

const DIRECTORY_DOMAIN = 'confidential-accounts/directory-filing/v1';

/**
 * A directory version's entry: the digest of the whole filing, of any kind,
 * with the signatures inside it - the wallet's on an entry, the quorum's on a
 * role or retirement, the one filing seat's on a change of the company's key -
 * since none of them is a record filing's own signature.
 */
export const directoryEntry = (filing: DirectoryFiling): ManifestEntryBody => ({
  store: 'directory', kind: DIRECTORY_RECORD, id: DIRECTORY_RECORD, version: filing.version,
  digest: digestOfBody(canonical({ domain: DIRECTORY_DOMAIN, filing })),
});

/**
 * **WHAT A SEAT'S ROLE MUST LET IT FILE TO ANCHOR A BATCH, OR TO WITNESS A
 * DIRECTORY VERSION.** Anchoring files no record of its own, and a directory
 * version - an entry signed by a wallet, a quorum's change, or one seat's
 * change of the company's key - is no record filing, so it is entered by the
 * device that anchors it. Both are what any seat that may raise or approve
 * does: every role but a viewer's may file a proposal.
 */
export const WITNESSED_AS: FiledKind = 'proposal';

/** What a seat's role must let it file for it to enter this entry: the record's own kind, or `WITNESSED_AS`. */
export const filedKindOfEntry = (e: ManifestEntryBody): FiledKind =>
  e.store === 'company' || e.store === 'vault' ? e.kind as FiledKind
    : e.store === 'directory' ? WITNESSED_AS : e.store;

/** Where a retired seat's last version of this record is counted, as the directory's retirement record names it. */
export const boundaryKeyOfEntry = (e: ManifestEntryBody): string =>
  e.store === 'vault' ? vaultRecordKey(e.id, e.kind as WireRecord)
    : e.store === 'directory' ? DIRECTORY_RECORD
      : companyRecordKey((e.store === 'company' ? e.kind : e.store) as CompanyRecordKind, e.id);

/** One record, across all five stores: what an entry's versions are counted under. */
export const recordKeyOf = (e: Pick<ManifestEntryBody, 'store' | 'kind' | 'id'>): string => `${e.store}:${e.kind}:${e.id}`;

/* ------------------------------------------------------------------ signed */

const ENTRY_DOMAIN = 'confidential-accounts/record-entry/v1';


const bodyOf = (e: ManifestEntryBody): ManifestEntryBody =>
  ({ store: e.store, kind: e.kind, id: e.id, version: e.version, digest: e.digest });

/** The exact text the filer signs for an entry: the company, then the entry. */
export const manifestEntryMessage = (company: string, e: ManifestEntryBody): string =>
  canonical({ domain: ENTRY_DOMAIN, company, ...bodyOf(e) });

/** The entry, signed by the seat that filed its record. The signing secret stays on the device. */
export const signManifestEntry = (company: string, e: ManifestEntryBody, signingSecret: Hex): ManifestEntry => ({
  ...bodyOf(e),
  filedBy: { publicKey: signingPublicKeyOf(signingSecret), signature: sign(manifestEntryMessage(company, e), signingSecret) },
});

/** An entry's id: the SHA-256 of the entry and its signature, which is what a batch names. */
/** The words that mark an entry refused because a later version of its record is already entered: superseded, never anchored. */
export const SUPERSEDED = 'was superseded';

/** Why an entry below a version already entered is never entered: superseded, in words that say what stands. */
export const supersededSaid = (e: Pick<ManifestEntryBody, 'store' | 'id' | 'version'>, newest: number): string =>
  `version ${e.version} of ${e.store} record ${e.id} ${SUPERSEDED}: version ${newest} of it is already in the company's records, `
  + 'so this version will never be anchored. Read the record again for the version that stands';

export const entryIdOf = (e: ManifestEntry): Hex =>
  digestOfBody(canonical({ ...bodyOf(e), filedBy: { publicKey: e.filedBy.publicKey, signature: e.filedBy.signature } }));

/**
 * **WHY THIS IS NOT AN ENTRY OF `company`'S MANIFEST SIGNED BY ITS FILER, OR
 * NULL WHEN IT IS ONE.** Whose key signed it is the directory's question, asked
 * by the caller.
 */
export const manifestEntryRefusal = (company: string, value: unknown): string | null => {
  if (value === null || typeof value !== 'object') return 'it is not an entry';
  const e = value as Partial<ManifestEntry>;
  if (!(MANIFEST_STORES as readonly unknown[]).includes(e.store)) return 'it names no store a company files in';
  if (typeof e.kind !== 'string' || typeof e.id !== 'string') return 'it does not name a record';
  const named = e.store === 'company' ? (COMPANY_RECORD_KINDS as readonly string[]).includes(e.kind) && COMPANY_RECORD_ID.test(e.id)
    : e.store === 'vault' ? (WIRE_RECORDS as readonly string[]).includes(e.kind) && HEX64.test(e.id)
      : e.store === 'run' ? e.kind === 'run' && RUN_ID.test(e.id)
        : e.store === 'proposal' ? e.kind === 'proposal' && PROPOSAL_ID.test(e.id)
          : e.kind === DIRECTORY_RECORD && e.id === DIRECTORY_RECORD;
  if (!named) return `it does not name a record its store keeps`;
  if (!Number.isSafeInteger(e.version) || (e.version as number) < 1) return 'its version is not a whole number from one';
  if (e.store === 'proposal' && e.version !== 1) return 'a proposal is filed once, so its only version is one';
  if (typeof e.digest !== 'string' || !HEX64.test(e.digest)) return 'its digest is not thirty-two bytes of lower-case hex';
  const by = e.filedBy as Partial<ManifestEntry['filedBy']> | undefined;
  if (typeof by?.publicKey !== 'string' || !HEX64.test(by.publicKey) || typeof by.signature !== 'string' || !HEX128.test(by.signature)) {
    return 'it is not signed';
  }
  let ok = false;
  try { ok = verify(manifestEntryMessage(company, e as ManifestEntryBody), by.signature, by.publicKey); } catch { ok = false; }
  return ok ? null : 'its signature does not cover exactly this entry for this company';
};

/* ------------------------------------------------------------------ what a read says of a record */

/**
 * **THE COMPANY'S DIRECTORY AS THE ANCHOR HELD IT WHEN A BATCH WAS ANCHORED**:
 * the newest directory version anchored through that batch, and the digest
 * anchored for each of its versions. Version 0 when none is.
 */
export interface DirectoryAsAnchored { readonly version: number; readonly digests: ReadonlyMap<number, Hex> }

/**
 * **WHAT A DEVICE MAY SAY OF ONE VERSION OF A RECORD IT READ**, against what
 * its read holds of the record tree: the version the anchor holds, an older
 * one, other bytes than the anchored ones at the anchored version, bytes whose
 * entry another seat than the record's own filer signed, a newer one not yet
 * anchored, one no entry names, one the anchor passed over because its entry
 * was never entered while a later version was anchored, or nothing because the
 * read stopped before it.
 */
export type RecordStanding =
  | 'anchored' | 'older-than-anchored' | 'not-the-anchored-bytes' | 'not-the-filers-entry' | 'not-yet-anchored' | 'not-entered'
  | 'past-a-stop' | 'never-entered';

/**
 * One version of a record as a device read it: which record, and the digest of
 * what its filer signed. Its version when the record carries one; a run's bytes
 * carry none, so its version is the one whose entry names those bytes.
 */
export interface RecordRead {
  readonly store: ManifestStore;
  readonly kind: string;
  readonly id: string;
  readonly digest: Hex;
  readonly version?: number;
}

/** What a read holds of a record read: its standing, the version whose entry names it, and the newest version entered. */
export interface RecordStandingRead {
  readonly standing: RecordStanding;
  /** The version whose entry names the bytes read, anchored or not yet; null when none does. */
  readonly version: number | null;
  /** The newest version of the record any entry names, anchored or not yet anchored; 0 when none does. */
  readonly newest: number;
}
