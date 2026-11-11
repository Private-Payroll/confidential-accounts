/**
 * **THE READ GRANTS THIS DEVICE BELIEVES, AND THE PURPOSE KEYS THEY HOLD.** The versions of the company's `grants`
 * record the service serves, each opened with this device's copy of its key and judged against the directory this
 * device believes (`grantsHere`): its filer as every filing is, its signers counted at the chain's seat bar (as the
 * company's records anchored it, for a version they anchor: `grantsCountAsAnchored`), its change in order
 * (`grantsInForceOf`). From the grants in force:
 *   - a reader's own purpose keys, unwrapped from its own wraps (`purposeWrapsHeldFrom`), which the keys-by-purpose seam
 *     answers for a reader in place of the company key; they never answer `formerKeyFor`, so a reader never opens a
 *     person sealed under `payroll` before people had a purpose of their own;
 *   - the readers a spending policy is sealed to beside the seats (`policyReadersIn`);
 *   - the key epoch a believed taking-away was filed at (`revokedAtHere`), which pauses sealing until the key changes.
 * Signing and filing a change is `grants-filed-here.ts`'s, which only a wallet runs.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { unwrapKey } from '../../../src/core/crypto.js';
import type { PurposeKeys, Purpose } from '../../../src/core/sealed-records.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { fromHex } from '../../../src/core/crypto.js';
import {
  GRANTS_RECORD, grantsInForceOf, openGrants, readerIdOf, type Grants, type GrantsCount, type GrantsInForce,
} from '../../../src/midnight/grants-record.js';
import { companyRecordEntry, recordKeyOf } from '../../../src/midnight/record-manifest.js';
import { companyWirePaths, fromCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import type { PoolSigner } from '../../../src/midnight/vault-pool.js';
import { judgeIn, kindAsked, type DirectoryHere, type DirectoryRead } from './vault-page-doors.js';
import { barReadable } from '../../../src/midnight/seat-quorum.js';

/**
 * A reader's purpose keys, by key epoch, unwrapped from the grants in force: what the keys-by-purpose seam answers for a
 * reader. `unopened` names each wrap the grants hold for this reader that did not open with its key.
 */
export interface PurposeWrapsHeld {
  readonly kind: 'purpose-wraps';
  readonly accountId: string;
  readonly byEpoch: ReadonlyMap<number, ReadonlyMap<Purpose, Hex>>;
  readonly unopened: readonly { readonly epoch: number; readonly purpose: Purpose }[];
}

/** Whether what a device holds for reading is a reader's purpose keys, not the company's keys. */
export const isPurposeWraps = (held: unknown): held is PurposeWrapsHeld =>
  typeof held === 'object' && held !== null && (held as { readonly kind?: unknown }).kind === 'purpose-wraps';

/**
 * The purpose keys of one epoch, or of the newest epoch held: each purpose the grant names, and nothing for any other.
 * Never a former key. A purpose whose wrap did not open is named as such where its key is asked for.
 */
export const purposeKeysAt = (held: PurposeWrapsHeld, epoch: number | undefined): PurposeKeys => {
  const at = epoch ?? Math.max(-1, ...held.byEpoch.keys());
  return {
    keyFor: (purpose, accountId) => (accountId !== held.accountId ? null : held.byEpoch.get(at)?.get(purpose) ?? null),
    whyNone: (purpose, accountId) => (accountId !== held.accountId || !held.unopened.some((u) => u.epoch === at && u.purpose === purpose) ? null
      : `the read grants wrap this device a key for the "${purpose}" records of account ${accountId}, and it does not open with `
        + 'this device\'s key, so none of them is read here. A signer takes the grant away and gives it again from their wallet, '
        + 'which wraps every key afresh.'),
  };
};

/** Every epoch's purpose keys a reader holds, oldest first. */
export const purposeKeysOfEveryEpoch = (held: PurposeWrapsHeld): readonly PurposeKeys[] =>
  [...held.byEpoch.keys()].sort((a, b) => a - b).map((e) => purposeKeysAt(held, e));

/** A reader's own purpose keys from the grants in force: its wraps, opened with its wrapping secret; null when the grants name it not. */
export const purposeWrapsHeldFrom = (
  accountId: string, grants: Grants, me: { readonly recipient: string; readonly wrappingSecret: Hex },
): PurposeWrapsHeld | null => {
  const wraps = grants.wraps[readerIdOf(me.recipient)];
  if (wraps === undefined) return null;
  const byEpoch = new Map<number, Map<Purpose, Hex>>();
  const unopened: { epoch: number; purpose: Purpose }[] = [];
  for (const w of wraps) {
    let key: Hex;
    try {
      key = unwrapKey(w.wrap, me.wrappingSecret).toLowerCase() as Hex;
    } catch {
      /* A wrap that does not open with this reader's key opens nothing: it is kept as unopened, and named where that key is asked for. */
      unopened.push({ epoch: w.epoch, purpose: w.purpose });
      continue;
    }
    const at = byEpoch.get(w.epoch) ?? byEpoch.set(w.epoch, new Map()).get(w.epoch)!;
    at.set(w.purpose, key);
  }
  return Object.freeze({ kind: 'purpose-wraps' as const, accountId, byEpoch, unopened });
};

/** What reading the grants needs: every version the service holds, the directory this device believes, and this device's own copy of a version's key. */
export interface GrantsDoors {
  readonly accountId: string;
  readonly versions: () => Promise<readonly SealedCompanyRecord[]>;
  readonly directory: DirectoryRead;
  readonly me: { readonly signerId: string; readonly wrappingSecret: Hex };
}

/** The grants this device believes, and the directory it judged them by. */
interface GrantsHere extends GrantsInForce {
  readonly here: DirectoryHere;
  /** The newest version the service serves: the next version filed is one above it. */
  readonly highest: number;
  /** The ids the version in force is sealed to, seats and readers. */
  readonly inForceSealedTo: readonly string[];
}

/** Why the read grants are not read here: the service did not give a version the company's records name, or the chain's bar was not read. */
class GrantsUnread extends Error {
  constructor(why: string) {
    super(`the company's read grants are not read here, because ${why}`);
    this.name = 'GrantsUnread';
  }
}

/**
 * A version of the grants the company's records name (anchored, or entered and not yet anchored) that the service did
 * not serve, so a taking-away could be hidden; or why the record was not given at all though they name one. Null when
 * every version they name was served.
 */
const grantsWithheldIn = (here: DirectoryHere, served: readonly SealedCompanyRecord[]): string | null => {
  const read = { store: 'company' as const, kind: GRANTS_RECORD.kind, id: GRANTS_RECORD.id };
  if (served.length === 0) return judgeIn(here).withheld?.(read) ?? null;
  const named = [
    ...(here.records.history.get(recordKeyOf(read)) ?? []).map((v) => v.version),
    ...here.records.notYetAnchored.filter((e) => e.store === 'company' && e.kind === read.kind && e.id === read.id).map((e) => e.version),
  ];
  const missing = named.filter((v) => !served.some((r) => r.version === v));
  return missing.length === 0 ? null : `the company's records name version ${Math.max(...missing)} of them and the service did not give it. `
    + 'Reload the page; if it happens again, the service is withholding the company\'s read grants';
};

const AS_ANCHORED_UNREAD = 'who held the company\'s account when the records anchored a version of them could not be read, so no '
  + 'signature on it is counted. Reload the page; if it happens again, the service is withholding the company\'s directory '
  + 'or records';

/**
 * Who counted toward the bar as the company's records anchored a version of the grants: the directory as it stood at
 * the directory version anchored with it, and the seats the chain held and the seat bar as that directory version was
 * anchored. Undefined only for a version the records do not anchor, which is counted against who holds the account
 * now. An anchored version whose count cannot be read here, or served as other bytes than the anchor holds, stops the
 * read (`GrantsUnread`): counted against today instead, a signer removed since could bring back a reader taken away.
 */
const grantsCountAsAnchored = (here: DirectoryHere, filed: readonly SealedCompanyRecord[]) => (version: number): GrantsCount | undefined => {
  const anchored = (here.records.history.get(recordKeyOf({ store: 'company', ...GRANTS_RECORD })) ?? []).find((v) => v.version === version);
  if (anchored === undefined) return undefined;
  const rec = filed.find((r) => r.version === version);
  const held = here.records.held?.(anchored.dirVersion) ?? null;
  const then = held === null ? null : here.at(anchored.dirVersion);
  if (rec === undefined || companyRecordEntry(rec).digest !== anchored.digest || held === null || then === null) {
    throw new GrantsUnread(AS_ANCHORED_UNREAD);
  }
  return { seats: then.dir.seats, held: (seat) => held.seats.includes(seat.seat), bar: held.seatBar };
};

/**
 * **THE GRANTS IN FORCE AS THIS DEVICE BELIEVES THEM.** A version whose filer the directory refuses is not opened. Read
 * whole or not at all: a version the company's records name and the service did not serve, or a chain read with no
 * seat bar, throws (`GrantsUnread`), so no device reads a taking-away as absent.
 */
export async function grantsHere(doors: GrantsDoors): Promise<GrantsHere> {
  const [served, here] = await Promise.all([doors.versions(), doors.directory(kindAsked('company', GRANTS_RECORD.kind))]);
  const judge = judgeIn(here);
  const ours = served.filter((rec) => rec.company === doors.accountId && rec.kind === GRANTS_RECORD.kind && rec.id === GRANTS_RECORD.id);
  const withheld = grantsWithheldIn(here, ours);
  if (withheld !== null) throw new GrantsUnread(withheld);
  if (!barReadable(here.holders)) {
    throw new GrantsUnread('who holds the company\'s account was read without the approvals a change of who is seated needs. Reload the page');
  }
  const filed = ours.filter((rec) =>
    judge(verifiedCompanyFiler(rec), GRANTS_RECORD.kind, companyRecordKey(GRANTS_RECORD.kind, GRANTS_RECORD.id), companyRecordEntry(rec)) === null);
  const judged = grantsInForceOf(doors.accountId, filed.map((rec) => ({ version: rec.version, keyEpoch: rec.keyEpoch, grants: openGrants(rec, doors.me) })), {
    seats: here.dir.seats, held: (seat) => here.holders.seats.includes(seat.seat), bar: Number(here.holders.seatBar),
    newest: (here.dir.rotations ?? []).reduce((n, r) => Math.max(n, r.epoch), 0), asAnchored: grantsCountAsAnchored(here, filed),
  });
  const sealedTo = ours.find((rec) => rec.version === judged.inForce?.version)?.wrapped.map((w) => String(w.signerId).toLowerCase()) ?? [];
  return { ...judged, here, highest: ours.reduce((n, r) => Math.max(n, r.version), 0), inForceSealedTo: sealedTo };
}

/** The readers a spending policy is sealed to beside the seats: each entry of the grants in force that reads `policy`. */
export const policyReadersIn = (grants: Pick<GrantsInForce, 'inForce'>): readonly PoolSigner[] =>
  (grants.inForce?.grants.entries ?? []).filter((e) => e.purposes.includes('policy'))
    .map((e) => ({ id: readerIdOf(e.recipient), wrappingPublicKey: e.recipient }));

/**
 * **THE KEY EPOCH A BELIEVED TAKING-AWAY OF A READ GRANT WAS FILED AT, FROM A SEAT'S DEVICE**, or null when the grants
 * take nothing away. The company's key is owed a change while that epoch is its newest. Never null for "cannot tell":
 * grants withheld, a key the wallet does not release (`released` asks it, where the caller may) or a seat with no
 * entry to open them with throw, so the caller seals nothing new until they can be read.
 */
export async function revokedAtHere(doors: {
  readonly accountId: string; readonly versions: () => Promise<readonly SealedCompanyRecord[]>; readonly directory: DirectoryRead;
  readonly signingPublicKey: string; readonly released: () => Promise<Hex | null>;
}): Promise<number | null> {
  const [versions, read] = await Promise.all([doors.versions(), doors.directory(kindAsked('company', GRANTS_RECORD.kind))]);
  const withheld = grantsWithheldIn(read, versions);
  if (withheld !== null) throw new GrantsUnread(withheld);
  if (versions.length === 0) return null;
  const released = await doors.released();
  if (released === null) {
    throw new GrantsUnread('your wallet has not released the company\'s key on this visit, so they do not open here. Open the company with your wallet');
  }
  const mine = doors.signingPublicKey.toLowerCase();
  const seat = read.dir.seats.find((x) => x.signingKey.toLowerCase() === mine);
  if (seat === undefined) {
    throw new GrantsUnread('this device\'s seat has no entry in the company\'s directory to open them with. Give your vault keys from your wallet, which enters it');
  }
  const opened = await grantsHere({
    accountId: doors.accountId, versions: async () => versions, directory: async () => read,
    me: { signerId: seat.seat, wrappingSecret: recordsKeypairFrom(fromHex(released)).secret.toLowerCase() as Hex },
  });
  return opened.revokedAt;
}

/** Every version of the company's grants record the service serves, each read off the wire as a company record is; none when it serves none. */
export const grantsServedBy = (api: (path: string) => Promise<unknown>, accountId: string) => async (): Promise<readonly SealedCompanyRecord[]> => {
  const b = await api(companyWirePaths.versions(accountId, GRANTS_RECORD.kind, GRANTS_RECORD.id)) as { versions?: unknown } | null;
  return Array.isArray(b?.versions)
    ? b!.versions.map((m) => fromCompanyWire(m, { company: accountId, kind: GRANTS_RECORD.kind, id: GRANTS_RECORD.id }).sealed) : [];
};

/**
 * **A READER'S PURPOSE KEYS, FROM ITS OWN DEVICE.** The newest version of the grants sealed to the reader gives the
 * roster key it opens the company's directory with; the grants are then judged by that directory, and the keys are
 * the reader's own wraps in the grants in force. Null when no version names it. A reader whose grant was taken away
 * holds only the keys wrapped to it before: nothing sealed after the company's key changed opens with them.
 */
export async function readerKeysHere(doors: {
  readonly accountId: string; readonly versions: () => Promise<readonly SealedCompanyRecord[]>;
  readonly directoryFor: (held: PurposeWrapsHeld) => DirectoryRead; readonly me: { readonly recipient: string; readonly wrappingSecret: Hex };
}): Promise<PurposeWrapsHeld | null> {
  const served = await doors.versions();
  const me = { signerId: readerIdOf(doors.me.recipient), wrappingSecret: doors.me.wrappingSecret };
  const newest = [...served].sort((a, b) => b.version - a.version).map((rec) => openGrants(rec, me)).find((g) => g !== null) ?? null;
  const first = newest === null ? null : purposeWrapsHeldFrom(doors.accountId, newest, doors.me);
  if (first === null) return null;
  const g = await grantsHere({ accountId: doors.accountId, versions: async () => served, directory: doors.directoryFor(first), me });
  return g.inForce === null ? null : purposeWrapsHeldFrom(doors.accountId, g.inForce.grants, doors.me);
}
