/**
 * **THE PAGE'S SEALED STORES FOR A VAULT'S RECORDS AND FOR THE COMPANY'S OWN:
 * READ AND FILED THROUGH THE COMPANY'S VIEW (`ThroughTheView`), NEVER HANDED
 * ANYTHING THEY COULD OPEN.**
 *
 * A vault's pool and journals are opened here, on the person's device, with
 * their own key. A read is one of the view's joined reads; a filing is signed
 * here and sent through the view's one write, which checks that nothing moved
 * first. What comes back is believed only as `sealed-record-wire.ts` has
 * checked it: the record asked for, the version asked for, the bytes the
 * digest names. The class names keep the word `Http` from when these stores
 * sent their own requests.
 *
 * It keeps the promises every `SealedPoolStore` keeps. A version another writer
 * filed first is `VaultPoolVersionAlreadyFiled`, by name, so the pool and the
 * journals retry exactly as they do against any other store. A write whose
 * answer did not arrive is reported as NOT CONFIRMED rather than as failed,
 * because it may have been filed.
 *
 * **EVERY FILING IS SIGNED HERE**, with the signing key of the signer this
 * device acts for, which never leaves the device, and **EVERY RECORD READ HERE
 * IS BELIEVED ONLY IF A SEAT THE COMPANY'S DIRECTORY NAMES SIGNED IT**, checked
 * on this device against the chain as the person's own wallet read it for this
 * read (`FilingJudge`, made fresh for every read by `seat-directory.ts`'s
 * `filingRefusalOf`): an entry the seat's own wallet signed, for a seat the account holds
 * now, whose role may file this record. A version signed by a seat that has
 * left is refused unless a quorum's retirement names it, and the server's word
 * is never what makes a version believed.
 */
import {
  companyRecordEntry,
  signedWithItsEntry,
  vaultRecordEntry,
  type RecordRead
} from '../../../src/midnight/record-manifest.js';
import {
  manifestFollowing,
  recordsEnteredFor,
  type ManifestService,
  type RecordsEntered
} from './record-entered-here.js';
import type { RecordsAsked } from '../../../src/midnight/records-held.js';
import {
  filedTogether,
  notSentInTheBatch,
  vaultFilingNotSent,
  type RecordFiling,
  type VaultFiling,
  type VaultRecordsHeld
} from './vault-records-filed-together.js';
import {
  VaultPoolVersionAlreadyFiled,
  VaultRecordRefused,
  whyThisIsNotASealedPool,
  type FiledPoolVersion,
  type PassedOverVersion,
  type SealedPool,
  type SealedPoolStore
} from '../../../src/midnight/vault-pool.js';
import {
  assertWireVault,
  fromWire,
  signFiling,
  toWire,
  verifiedFiler,
  type WireRecord
} from '../../../src/midnight/sealed-record-wire.js';
import type { Hex } from '../../../src/core/crypto.js';
import { ViewEnded, type CompanyView } from './company-view.js';
import type { CompanyRecordAsked, RecordRouteKind, RecordWrite, VaultRecordAsked } from './records-source.js';
import { CompanyChangedMeanwhile } from './company-view-probe.js';
import { companyRecordKey, vaultRecordKey, type FiledKind } from '../../../src/midnight/seat-directory.js';
import {
  fromCompanyWire,
  toCompanyWire,
  verifiedCompanyFiler,
  SEALED_UNDER_PURPOSE,
  type CompanyRecordKind,
  type SealedCompanyRecord
} from '../../../src/midnight/sealed-record-wire.js';

/**
 * **WHETHER ONE VERSION IS BELIEVED**: null when it is, or the reason it is not.
 * `filer` is the key whose signature over exactly this version verifies, or
 * null; `read` is the record as its entry in the company's records names it;
 * `newest`, that it is read as the record's newest version; `sealedAt`, the
 * company key epoch a record sealed under the company's key names.
 */
export type FilingJudge = ((
  filer: Hex | null,
  kind: FiledKind,
  recordKey: string,
  read: RecordRead,
  newest?: boolean,
  sealedAt?: number
) => string | null) & {
  /**
   * **WHY A RECORD THE SERVICE DID NOT GIVE AT ALL IS NOT READ AS ABSENT**:
   * the company's records name a version of it, or this device cannot read
   * them far enough to say they do not. Null when nothing names it. A judge
   * handed no company records has none.
   */
  readonly withheld?: (read: Pick<RecordRead, 'store' | 'kind' | 'id'>) => string | null;
  /**
   * **WHETHER THE COMPANY'S RECORDS PASSED OVER THIS VERSION**: filed, its
   * entry never entered, and a later version anchored past it. Such a version
   * is said in a list of versions, never believed and never opened. A judge
   * handed no company records says no.
   */
  readonly neverEntered?: (read: Pick<RecordRead, 'store' | 'kind' | 'id'> & { readonly version: number }) => boolean;
  /**
   * **WHETHER THIS VERSION IS PAST THE BOUNDARY ITS SEAT'S LEAVING KEEPS**: a
   * seat retired, or under a raised removal, whose boundary is final, past the
   * last version of `recordKey` it keeps. Such a version is passed over: never
   * believed, never opened, and never in the way of the version below it being
   * read as the newest. A judge handed no company records says no.
   */
  readonly pastItsBoundary?: (filer: Hex | null, recordKey: string, version: number) => boolean;
  /**
   * **WHETHER A HELD READ MADE AFTER THIS ONE COULD ANSWER `why` OTHERWISE**: the version read is entered after the
   * held answer was read, or a newer one is named that the service did not give. A judge that says nothing never has
   * its read made again.
   */
  readonly heldBehind?: (why: string) => boolean;
};

/**
 * **A JUDGE MADE FOR ONE READ, FOR WHAT THAT READ WILL JUDGE**: the company's
 * directory, the chain as the person's own wallet reads it, and the records and
 * kinds `asked` proven against the head on chain in one request. Each is read
 * again for the read, or, when the company's view is open, read once for the
 * whole step or screen and shared by every read in it. A record the read did
 * not ask for is refused, never believed.
 */
export type FreshJudge = (asked?: RecordsAsked) => Promise<FilingJudge>;

/**
 * A store's reads and filings through the company's view: its record's newest version and every version, read with
 * the company's other reads and answered as the record's own read answers them; each filing sent through the view's
 * one write, after its check that nothing moved, and entered in the company's records through the view's manifest.
 */
export interface ThroughTheView {
  readonly vaultRecord: (asked: VaultRecordAsked) => Promise<unknown>;
  readonly companyRecord: (asked: CompanyRecordAsked) => Promise<unknown>;
  readonly file: (w: RecordWrite) => Promise<unknown>;
  /** The view's manifest and company, which a filing is entered through, and why this seat files nothing more. */
  readonly manifest: ManifestService;
  readonly company: string;
  readonly stops?: () => Promise<string | null>;
  /** The view's `heldAgain`: a version refused as newer than the held answer is judged once more over a fresh one. */
  readonly heldAgain?: () => Promise<boolean>;
  /** Where a step's vault filings wait to be sent as one checked batch; absent, each filing is sent when it is made. */
  readonly held?: VaultRecordsHeld;
}

/** A store's reads through a view, with no way to file through it: all a store that only reads is given. */
export type ReadsThroughTheView = Pick<ThroughTheView, 'vaultRecord' | 'companyRecord' | 'company' | 'heldAgain'>;

/** Whether `reach` can file, as well as read. */
export const filesThrough = (reach: ThroughTheView | ReadsThroughTheView): reach is ThroughTheView =>
  typeof (reach as Partial<ThroughTheView>).file === 'function';

/**
 * A store's reads and filings through the step's or screen's view (`held`), each through whichever view it holds at
 * the time. A store that files is given a step's view, which a refused filing ends and which is opened again for the
 * next read (`viewHeldOver`), so a version told taken is read back and entered through a live view. `stops` says why
 * this seat files nothing more, as the entering of a filing asks it (`recordsEnteredFor`).
 */
export const readsJoinedIn = (
  held: {
    current(): Pick<CompanyView<unknown>, 'company' | 'records' | 'vaultRecords' | 'write' | 'manifest' | 'heldAgain'>;
  },
  stops?: () => Promise<string | null>
): ThroughTheView =>
  Object.freeze({
    vaultRecord: async (asked: VaultRecordAsked) => (await held.current().vaultRecords([asked]))[0],
    companyRecord: async (asked: CompanyRecordAsked) => (await held.current().records([asked]))[0],
    file: async (w: RecordWrite) => (await held.current().write([w]))[0],
    manifest: manifestFollowing(held),
    company: held.current().company,
    heldAgain: () => held.current().heldAgain(),
    ...(stops === undefined ? {} : { stops })
  });

/** What the service said when it refused a filing sent through the view, when the refusal carries its answer. */
const refusalOf = (cause: unknown): Record<string, unknown> | null => {
  const body = (cause as { readonly body?: unknown } | null)?.body;
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null;
};

/** Whether a filing through the view was stopped before anything was sent: the company changed, or the view had ended. */
const stoppedBeforeSending = (cause: unknown): boolean =>
  cause instanceof CompanyChangedMeanwhile || cause instanceof ViewEnded;

/** The status a read through the view stands for: the record's own read, answered. */
const ANSWERED = 200;

/** The reason a refusal's answer gives, or that it gave none. */
const said = (body: unknown): string => {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'string' ? e : 'no reason given';
};

/**
 * **HOW A FILING SENT THROUGH THE VIEW FAILED**, as the service's answer says it: refused and not filed when nothing
 * was sent or the service refused it with a 4xx, with the status (null when nothing was sent) and the reason; otherwise,
 * a 5xx, no status or no answer, not confirmed, since it may have been filed. Both stores word their own message from it.
 */
const filingFailureOf = (
  cause: unknown
): { readonly refused: true; readonly status: number | null; readonly why: string } | { readonly refused: false } => {
  const told = cause as {
    readonly status?: unknown;
    readonly thisSendNotSent?: unknown;
    readonly message?: unknown;
  } | null;
  const status = typeof told?.status === 'number' ? told.status : null;
  if (told?.thisSendNotSent !== true && !(status !== null && status >= 400 && status < 500)) return { refused: false };
  const body = refusalOf(cause);
  return { refused: true, status, why: body === null ? String(told?.message ?? 'no reason given') : said(body) };
};

/**
 * **WHETHER THE VERSION THE SERVICE TOLD TAKEN HOLDS THESE BYTES**, read through the view from every version of the
 * record: true, false, or undefined when it could not be read (a view the refused filing ended reads nothing more).
 * `takenIn` finds the version in what the view answered; `digestOf` is the digest of that one.
 */
const takenVersionHolds = async (
  every: () => Promise<unknown>,
  takenIn: (answer: unknown) => unknown,
  digestOf: (taken: unknown) => string,
  digest: string
): Promise<boolean | undefined> => {
  try {
    const taken = takenIn(await every());
    return taken === undefined ? undefined : digestOf(taken) === digest;
  } catch {
    /* A read that failed, or a view the refused filing ended, is no reading: whose version it is stays unknown. */
    return undefined;
  }
};

/** A version a store that only reads was asked to file. Nothing was sent. */
export class ReadFilesNothing extends Error {
  constructor(
    readonly record: string,
    readonly version: number
  ) {
    super(
      `version ${version} of this vault's ${record} was not filed: a read files nothing, and nothing was sent. ` +
        "A seat action in a signer's wallet files it."
    );
    this.name = 'ReadFilesNothing';
  }
}

/**
 * A store that can list the versions of a vault's record the company's records believe, and name each one they refuse,
 * with why (`HttpSealedPoolStore.versionsBelieved`).
 */
interface ListsBelieved {
  versionsBelieved(vault: string): Promise<{
    readonly versions: readonly (FiledPoolVersion | PassedOverVersion)[];
    readonly refused: readonly { readonly version: number; readonly why: string }[];
  }>;
}

/**
 * **EVERY VERSION OF A VAULT'S RECORD THE COMPANY'S RECORDS BELIEVE, EACH REFUSED ONE NAMED**, from a store that can say
 * so (`HttpSealedPoolStore.versionsBelieved`). A store that cannot, the memory and database stores, holds only what was
 * filed through it, so its every version is taken and none is named refused.
 */
export async function versionsBelievedOf(
  store: SealedPoolStore & Partial<ListsBelieved>,
  vault: string
): ReturnType<ListsBelieved['versionsBelieved']> {
  return typeof store.versionsBelieved === 'function'
    ? store.versionsBelieved(vault)
    : { versions: await store.versions(vault), refused: [] };
}

/**
 * **EVERY VERSION OF A VAULT'S RECORD AS FILED, NOT CHECKED FOR WHO FILED IT** (`HttpSealedPoolStore.versionsAsFiled`),
 * for a reader that uses nothing in it before the chain vouches for it. A store that cannot list them so, the memory
 * and database stores, gives its every version.
 */
export async function versionsAsFiledOf(
  store: SealedPoolStore & { versionsAsFiled?(vault: string): Promise<readonly FiledPoolVersion[]> },
  vault: string
): Promise<readonly (FiledPoolVersion | PassedOverVersion)[]> {
  return typeof store.versionsAsFiled === 'function' ? store.versionsAsFiled(vault) : store.versions(vault);
}

export class HttpSealedPoolStore implements SealedPoolStore, ListsBelieved {
  /* A store given a view it cannot file through is given no signing secret either: it only reads. */
  constructor(record: WireRecord, joined: ThroughTheView, signWith: Hex | null, judge: FreshJudge);
  constructor(record: WireRecord, joined: ReadsThroughTheView, signWith: null, judge: FreshJudge);
  constructor(
    private readonly record: WireRecord,
    /** The company's view the newest version and every version are read through, and every filing is sent through. */
    private readonly joined: ThroughTheView | ReadsThroughTheView,
    /**
     * The signing secret of the signer this device files as. It is used here and sent nowhere. Null makes a store that
     * only reads (`recordsReadHere`): every read is the same, and `put` refuses before anything is sent.
     */
    private readonly signWith: Hex | null,
    /** Who this device believes filed a version, asked afresh for each read. */
    private readonly judge: FreshJudge
  ) {
    if (signWith !== null && (typeof signWith !== 'string' || !/^[0-9a-f]{64}$/u.test(signWith))) {
      throw new Error('a sealed record is filed signed, and this device was given no signing key to sign it with.');
    }
  }

  private refuse(what: string, status: number, body: unknown): never {
    throw new Error(
      `this vault's ${this.record} could not be ${what} (the server answered ${status}: ${said(body)}). ` +
        'That is not a record holding nothing. Nothing has been changed on this device; try again once ' +
        'the server answers.'
    );
  }

  async get(vault: string): Promise<SealedPool | null> {
    assertWireVault(vault);
    /* A version this step holds back to file with the rest of its batch is the newest it builds on. */
    const held = filesThrough(this.joined) ? this.joined.held?.newestHeld(this.record, vault) : undefined;
    if (held !== undefined) return held;
    const b = (await this.read(vault, false)) as { record?: unknown; filed?: unknown } | null;
    if (b?.record !== this.record || !('filed' in (b ?? {})))
      this.refuse('read', ANSWERED, { error: 'the answer is not about this record' });
    const newest = b!.filed === null ? null : fromWire(b!.filed, { vault, record: this.record }).sealed;
    const read = await judgedOnce(this.judge, this.asked(vault), this.joined, (judge) => {
      if (newest === null) return { found: this.absent(vault, judge) };
      if (this.pastItsBoundary(newest, judge)) return null;
      this.passedTo.delete(vault);
      return { found: this.believed(newest, judge, true) };
    });
    if (read !== null) return read.found;
    /* The newest version filed is one no device believes: the newest below it that stands is this record's newest. */
    const all = await this.versions(vault);
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const v = all[i]!;
      if (v.neverEntered !== true) return v.sealed;
    }
    return null;
  }

  /**
   * For each vault whose last read passed over versions no device believes, the newest version filed: no write is
   * built on that read until the record is filed again from what the chain vouches for (`passedOverAbove`).
   */
  private readonly passedTo = new Map<string, number>();

  filedPast(vault: string): number | undefined {
    return this.passedTo.get(vault);
  }

  /** Whether `rec` was filed by a seat past the boundary its leaving keeps (`FilingJudge.pastItsBoundary`). */
  private pastItsBoundary(rec: SealedPool, judge: FilingJudge): boolean {
    return (
      judge.pastItsBoundary?.(verifiedFiler(this.record, rec), vaultRecordKey(rec.vault, this.record), rec.version) ===
      true
    );
  }

  /** What a read of one vault's record asks to have proven: that record. */
  private asked(vault: string): RecordsAsked {
    return { records: [{ store: 'vault', kind: this.record, id: vault }] };
  }

  /** Nothing, when the service gave no version and the company's records name none; refused as withheld when they do. */
  private absent(vault: string, judge: FilingJudge): null {
    const why = judge.withheld?.({ store: 'vault', kind: this.record, id: vault }) ?? null;
    if (why !== null) throw new RecordWithheld(this.record, why);
    return null;
  }

  /**
   * The record, if a seat this device believes filed it as this kind of record
   * and it is what the head on chain holds - as the newest version, when it is
   * read as the newest; refused otherwise.
   */
  private believed(rec: SealedPool, judge: FilingJudge, newest: boolean): SealedPool {
    const why = judge(
      verifiedFiler(this.record, rec),
      this.record,
      vaultRecordKey(rec.vault, this.record),
      vaultRecordEntry(this.record, rec),
      newest
    );
    if (why !== null) throw new FilingNotBelieved(this.record, rec.version, why);
    return rec;
  }

  /**
   * **EVERY VERSION AS FILED, NOT CHECKED FOR WHO FILED IT.** For one use only:
   * finding a version whose content the chain itself vouches for (a nonce
   * secret whose commitment is the vault's), so a seated signer can file that
   * content again under its own seat. Nothing read here is used before the
   * chain has vouched for it.
   */
  async versionsAsFiled(vault: string): Promise<readonly FiledPoolVersion[]> {
    return (await this.listed(vault)).map((f) => ({ version: f.wire.version, sealed: f.sealed }));
  }

  /**
   * **EVERY VERSION OF THIS VAULT'S RECORD, THE BELIEVED ONES KEPT AND EACH REFUSED ONE NAMED WITH WHY.** As
   * `versions`, except that a version the company's records do not believe (`FilingNotBelieved`) is left out of
   * `versions` and named in `refused`, so a reader that can do without it keeps every other version. For a rebuild of
   * the vault's notes, which says each refused version; every other reader takes `versions`, which refuses.
   */
  async versionsBelieved(vault: string): ReturnType<ListsBelieved['versionsBelieved']> {
    const filed = await this.listed(vault);
    const first = await this.judge(this.asked(vault));
    const sorted = this.sortedBy(vault, filed, first);
    /* A version refused as newer than the held answer is judged once more over a fresh one (`judgedOnce`). */
    if (!sorted.refused.some((r) => first.heldBehind?.(r.why) === true) || this.joined.heldAgain === undefined)
      return sorted;
    await this.joined.heldAgain();
    return this.sortedBy(vault, filed, await this.judge(this.asked(vault)));
  }

  /** `versionsBelieved`'s list, judged by `judge`. */
  private sortedBy(
    vault: string,
    filed: Awaited<ReturnType<HttpSealedPoolStore['listed']>>,
    judge: FilingJudge
  ): Awaited<ReturnType<ListsBelieved['versionsBelieved']>> {
    /* No version given, where the company's records name one, is a list withheld, not an empty one. */
    if (filed.length === 0) return { versions: this.absent(vault, judge) ?? [], refused: [] };
    /*
     * Every version as one the anchor holds, and the last that stands as the newest: a list the service cut short is
     * refused. A version the company's records passed over is said as such, without its bytes; never the newest. So is
     * one filed past the boundary its seat's leaving keeps, wherever it is in the list; no write is built on a read
     * that passed one over above the newest it answered.
     */
    const passed = filed.map(
      (f, i) =>
        (i < filed.length - 1 &&
          judge.neverEntered?.({ store: 'vault', kind: this.record, id: vault, version: f.wire.version }) === true) ||
        this.pastItsBoundary(f.sealed, judge)
    );
    const newest = passed.lastIndexOf(false);
    if (newest < filed.length - 1) this.passedTo.set(vault, filed[filed.length - 1]!.wire.version);
    else this.passedTo.delete(vault);
    const versions: (FiledPoolVersion | PassedOverVersion)[] = [];
    const refused: { version: number; why: string }[] = [];
    filed.forEach((f, i) => {
      if (passed[i]) {
        versions.push({ version: f.wire.version, neverEntered: true as const });
        return;
      }
      try {
        versions.push({ version: f.wire.version, sealed: this.believed(f.sealed, judge, i === newest) });
      } catch (e) {
        if (!(e instanceof FilingNotBelieved)) throw e;
        refused.push({ version: e.version, why: e.why });
      }
    });
    return { versions, refused };
  }

  /** Every version of this vault's record, as `versionsBelieved` reads them; refused whole when any one is not believed. */
  async versions(vault: string): Promise<readonly (FiledPoolVersion | PassedOverVersion)[]> {
    const { versions, refused } = await this.versionsBelieved(vault);
    if (refused.length > 0) throw new FilingNotBelieved(this.record, refused[0]!.version, refused[0]!.why);
    return versions;
  }

  /** One read of this record, its newest version or every version: joined with the company's other reads, or sent alone. */
  private read(vault: string, every: boolean): Promise<unknown> {
    return this.joined.vaultRecord(every ? { vault, record: this.record, every } : { vault, record: this.record });
  }

  private async listed(vault: string) {
    assertWireVault(vault);
    const b = (await this.read(vault, true)) as { record?: unknown; versions?: unknown } | null;
    if (b?.record !== this.record || !Array.isArray(b.versions)) {
      this.refuse('listed', ANSWERED, { error: "the answer is not a list of this record's versions" });
    }
    const filed = (b!.versions as unknown[]).map((m) => fromWire(m, { vault, record: this.record }));
    filed.forEach((f, i) => {
      if (f.wire.version !== i + 1) {
        this.refuse('listed', ANSWERED, {
          error: `the list names version ${f.wire.version} where version ${i + 1} belongs, so it is not every version, in order`
        });
      }
    });
    return filed;
  }

  /**
   * Files `rec` through the company's view, after its check that nothing moved, and enters it over the view's manifest.
   * Where the view holds this step's filings back (`ThroughTheView.held`), it waits there and is sent with the rest of
   * the batch (`VaultRecordsHeld.sent`).
   */
  async put(vault: string, rec: SealedPool): Promise<void> {
    assertWireVault(vault);
    const unusable = whyThisIsNotASealedPool(rec, vault);
    if (unusable !== null)
      throw new Error(`this is not a sealed record for this vault (${unusable}), so nothing is filed.`);
    const joined = this.joined;
    if (this.signWith === null || !filesThrough(joined)) throw new ReadFilesNothing(this.record, rec.version);
    const signed = signFiling(this.record, rec, this.signWith);
    const filing = this.filingOf(
      joined,
      vault,
      signed,
      recordsEnteredFor(joined.manifest, joined.company, this.signWith, joined.stops)
    );
    if (joined.held !== undefined) {
      joined.held.hold(filing);
      return;
    }
    const [alone] = await filedTogether(async ([w]) => [await joined.file(w!)], [filing]);
    if (alone!.status === 'rejected') throw alone!.reason;
  }

  /**
   * `signed` as a filing through the company's view, entered with `entered`. Stopped by the check, nothing was sent;
   * refused, it was not filed; told the version is taken, the version is read back, and another writer's is a lost race
   * (`VaultPoolVersionAlreadyFiled`); any other failure may have filed it, and is said so.
   */
  private filingOf(joined: ThroughTheView, vault: string, signed: SealedPool, entered: RecordsEntered): VaultFiling {
    const { version } = signed;
    const wire = toWire(this.record, signed);
    return {
      record: this.record,
      vault,
      sealed: signed,
      entered,
      entry: vaultRecordEntry(this.record, signed),
      write: { to: 'vault-record', vault, record: this.record, version, body: wire },
      answered: (answer) => {
        const b = answer as Record<string, unknown> | null;
        if (
          b?.['filed'] !== true ||
          b['record'] !== this.record ||
          b['version'] !== version ||
          b['digest'] !== wire.digest
        ) {
          throw this.notConfirmed(
            version,
            "the server's answer names a different record, version or body than the one sent"
          );
        }
      },
      refused: (cause) => this.refusedAs(joined, vault, wire, version, cause),
      notSent: () => vaultFilingNotSent(this.record, version)
    };
  }

  /** What a refusal of a version sent means; resolves only when the version the service holds is this one. */
  private async refusedAs(
    joined: ThroughTheView,
    vault: string,
    wire: ReturnType<typeof toWire>,
    version: number,
    cause: unknown
  ): Promise<void> {
    if (stoppedBeforeSending(cause)) throw cause;
    const refused = refusalOf(cause);
    if (refused?.['refused'] === 'not-the-next-version' && refused['version'] === version) {
      throw new Error(`version ${version} of this vault's ${this.record} was not filed: ${String(refused['why'])}`);
    }
    if (refused?.['refused'] === 'not-filed' && refused['version'] === version) {
      throw new VaultRecordRefused(
        `version ${version} of this vault's ${this.record} was refused and not filed: ${String(refused['why'])}`
      );
    }
    if (refused?.['refused'] === 'version-already-filed' && refused['version'] === version) {
      /* Whose version it is, read back through the step's view as it is opened again after the refusal, rather than assumed. */
      const mine = await takenVersionHolds(
        () => joined.vaultRecord({ vault, record: this.record, every: true }),
        (every) => {
          const a = every as { record?: unknown; versions?: unknown } | null;
          return a?.record === this.record && Array.isArray(a.versions) ? a.versions[version - 1] : undefined;
        },
        (taken) => fromWire(taken, { vault, record: this.record, version }).wire.digest,
        wire.digest
      );
      if (mine === false) throw new VaultPoolVersionAlreadyFiled(vault, version);
      if (mine === true) return;
      throw this.notConfirmed(version, (cause as Error)?.message ?? String(cause), cause);
    }
    const failure = filingFailureOf(cause);
    if (!failure.refused) throw this.notConfirmed(version, (cause as Error)?.message ?? String(cause), cause);
    throw Object.assign(
      new VaultRecordRefused(
        `version ${version} of this vault's ${this.record} was refused and not filed (${failure.status ?? 'nothing sent'}: ${failure.why}).`
      ),
      { cause }
    );
  }

  private notConfirmed(version: number, why: string, cause?: unknown): Error {
    return new Error(
      `version ${version} of this vault's ${this.record} was not confirmed filed (${why}). It may have been ` +
        'filed: read the record again before deciding anything, and do not file the same change again on ' +
        'the assumption that it was not.',
      cause === undefined ? undefined : { cause }
    );
  }
}

/** A record the company's records name and the service did not give at all, by name, with the reason. Nothing is built as if it were absent. */
export class RecordWithheld extends Error {
  constructor(
    readonly record: string,
    readonly why: string
  ) {
    super(
      `this ${record} was not given, and it is not read as absent, because ${why}. Nothing is built on it. ` +
        'That is not a record holding nothing.'
    );
    this.name = 'RecordWithheld';
  }
}

/** A version this device does not believe, by name, with the reason. Nothing is built on it. */
export class FilingNotBelieved extends Error {
  constructor(
    readonly record: string,
    readonly version: number,
    readonly why: string
  ) {
    super(
      `version ${version} of this ${record} is not believed, because ${why}. Nothing is built on it. ` +
        'That is not a record holding nothing.'
    );
    this.name = 'FilingNotBelieved';
  }
}

/** The write of a signed company record through the records route. */
const writeOfRecord = (
  rec: SealedCompanyRecord & { readonly kind: RecordRouteKind },
  wire: ReturnType<typeof toCompanyWire>
): RecordWrite => ({ to: 'record', kind: rec.kind, id: rec.id, version: rec.version, body: wire });

/** Whether a record is one the company records route files (`RecordRouteKind`). */
const onTheRecordRoute = (rec: SealedCompanyRecord): rec is SealedCompanyRecord & { readonly kind: RecordRouteKind } =>
  rec.kind !== 'person' && rec.kind !== 'roster';

/**
 * **A READ JUDGED, AND JUDGED ONCE MORE OVER A FRESH HELD ANSWER WHEN IT MAY BE BEHIND** (`FilingJudge.heldBehind`):
 * a body read after the held answer, which that answer does not name, is judged again once the view has let go of it
 * (`heldAgain`). The view lets go once; a read beside the one that made it let go is judged again over the same fresh
 * answer. A second refusal refuses, as does any other.
 */
const judgedOnce = async <T>(
  judge: FreshJudge,
  asked: RecordsAsked | undefined,
  reach: Pick<ThroughTheView, 'heldAgain'>,
  use: (judge: FilingJudge) => T | Promise<T>
): Promise<T> => {
  const first = await judge(asked);
  try {
    return await use(first);
  } catch (e) {
    if (!(e instanceof FilingNotBelieved) || first.heldBehind?.(e.why) !== true || reach.heldAgain === undefined)
      throw e;
    await reach.heldAgain();
    return use(await judge(asked));
  }
};

/**
 * **A VERSION OF A COMPANY RECORD THE COMPANY'S RECORDS PASSED OVER**, as a
 * list of its versions says it: filed, its entry never entered, a later version
 * anchored past it. Its bytes are not given, so nothing opens it.
 */
interface CompanyVersionPassedOver {
  readonly company: string;
  readonly kind: CompanyRecordKind;
  readonly id: string;
  readonly version: number;
  readonly neverEntered: true;
}

/**
 * **A COMPANY'S OWN RECORDS, REACHED OVER HTTP**: filed signed by this
 * device's seat, and read back believed only when a seat the directory names
 * filed them, by the same fresh check as a vault's records. Given no signing
 * key it only reads, and refuses to file (`ReadFilesNothing`), as a page that
 * holds no seat secret reads.
 */
export class HttpCompanyRecordStore {
  /* A store given a view it cannot file through is given no signing secret either: it only reads. */
  constructor(company: string, joined: ThroughTheView, signWith: Hex | null, judge: FreshJudge);
  constructor(company: string, joined: ReadsThroughTheView, signWith: null, judge: FreshJudge);
  constructor(
    private readonly company: string,
    /** The company's view every read goes through, and every filing is sent through. */
    private readonly joined: ThroughTheView | ReadsThroughTheView,
    private readonly signWith: Hex | null,
    private readonly judge: FreshJudge
  ) {
    if (signWith !== null && (typeof signWith !== 'string' || !/^[0-9a-f]{64}$/u.test(signWith))) {
      throw new Error('a company record is filed signed, and this device was given no signing key to sign it with.');
    }
  }

  /** One read of a record, its newest version or every version, joined with the company's other reads. */
  private read(asked: CompanyRecordAsked): Promise<unknown> {
    return this.joined.companyRecord(asked);
  }

  private believed(rec: SealedCompanyRecord, judge: FilingJudge, newest: boolean): SealedCompanyRecord {
    /* Only a record sealed under the company's key is held to the key in force at its batch; others name no such key. */
    const sealedAt = SEALED_UNDER_PURPOSE[rec.kind] === undefined ? undefined : rec.keyEpoch;
    const why = judge(
      verifiedCompanyFiler(rec),
      rec.kind,
      companyRecordKey(rec.kind, rec.id),
      companyRecordEntry(rec),
      newest,
      sealedAt
    );
    if (why !== null) throw new FilingNotBelieved(`company's ${rec.kind} record`, rec.version, why);
    return rec;
  }

  /** Nothing, when the service gave no version and the company's records name none; refused as withheld when they do. */
  private absent(kind: CompanyRecordKind, id: string, judge: FilingJudge): null {
    const why = judge.withheld?.({ store: 'company', kind, id }) ?? null;
    if (why !== null) throw new RecordWithheld(`company's ${kind} record`, why);
    return null;
  }

  async get(kind: CompanyRecordKind, id: string): Promise<SealedCompanyRecord | null> {
    const b = (await this.read({ kind, id })) as { kind?: unknown; id?: unknown; filed?: unknown } | null;
    if (b?.kind !== kind || b?.id !== id || !('filed' in (b ?? {}))) {
      throw new Error(
        `this company's ${kind} record could not be read (the server answered ${ANSWERED}: ${said(b)}). That is not a record holding nothing.`
      );
    }
    return judgedOnce(this.judge, { records: [{ store: 'company', kind, id }] }, this.joined, (judge) =>
      b!.filed === null
        ? this.absent(kind, id, judge)
        : this.believed(fromCompanyWire(b!.filed, { company: this.company, kind, id }).sealed, judge, true)
    );
  }

  /**
   * One version of a record, as the service holds it under that number, judged as that version and not as the newest:
   * what is read of a record filed once (a one-off), whatever later version anyone put over it.
   */
  async at(kind: CompanyRecordKind, id: string, version: number): Promise<SealedCompanyRecord | null> {
    const filed = await this.oneOfEvery(kind, id, version);
    const rec = filed === null ? null : fromCompanyWire(filed, { company: this.company, kind, id }).sealed;
    if (rec !== null && rec.version !== version)
      throw new Error(
        `the service gave version ${rec.version} of this company's ${kind} record where version ${version} was asked.`
      );
    return judgedOnce(this.judge, { records: [{ store: 'company', kind, id }] }, this.joined, (judge) =>
      rec === null ? this.absent(kind, id, judge) : this.believed(rec, judge, false)
    );
  }

  /**
   * One version of a record, found among every version the company's view read of it with the company's other reads:
   * what was filed at it, or null when none was. Which record and version it is, is checked where it is opened.
   */
  private async oneOfEvery(kind: CompanyRecordKind, id: string, version: number): Promise<unknown> {
    const every = (await this.read({ kind, id, every: true })) as { readonly versions?: unknown } | null;
    if (!Array.isArray(every?.versions)) {
      throw new Error(
        `version ${version} of this company's ${kind} record could not be read (the service did not answer with its versions). That is not a record holding nothing.`
      );
    }
    return (every.versions as readonly { readonly version?: unknown }[]).find((w) => w?.version === version) ?? null;
  }

  async versions(
    kind: CompanyRecordKind,
    id: string
  ): Promise<readonly (SealedCompanyRecord | CompanyVersionPassedOver)[]> {
    const b = (await this.read({ kind, id, every: true })) as { versions?: unknown } | null;
    if (!Array.isArray(b?.versions)) {
      throw new Error(
        `this company's ${kind} record could not be listed (the server answered ${ANSWERED}: ${said(b)}).`
      );
    }
    const filed = (b!.versions as unknown[]).map((m) => fromCompanyWire(m, { company: this.company, kind, id }).sealed);
    filed.forEach((f, i) => {
      if (f.version !== i + 1)
        throw new Error(
          `the list names version ${f.version} where version ${i + 1} belongs, so it is not every version, in order.`
        );
    });
    return judgedOnce(this.judge, { records: [{ store: 'company', kind, id }] }, this.joined, (judge) => {
      if (filed.length === 0) return this.absent(kind, id, judge) ?? [];
      /* A version the company's records passed over is said as such, without its bytes; never the newest. */
      return filed.map((f, i) =>
        i < filed.length - 1 && judge.neverEntered?.({ store: 'company', kind, id, version: f.version }) === true
          ? { company: this.company, kind, id, version: f.version, neverEntered: true as const }
          : this.believed(f, judge, i === filed.length - 1)
      );
    });
  }

  async put(rec: SealedCompanyRecord): Promise<void> {
    const { joined, onRoute, wire } = this.signedToFile(rec);
    let b: unknown;
    try {
      b = await joined.file(writeOfRecord(onRoute, wire));
    } catch (cause) {
      return this.refusedAs(joined, onRoute, wire, cause);
    }
    this.answeredAs(onRoute, wire, b);
  }

  /**
   * `rec` signed as a filing of a batch sent through the company's view (`filedTogether`), entered with `entered` once
   * it is filed. Its answer and a refusal of it are taken as `put` takes them.
   */
  filingOf(rec: SealedCompanyRecord, entered: RecordsEntered): RecordFiling {
    const { joined, onRoute, wire } = this.signedToFile(rec);
    return {
      write: writeOfRecord(onRoute, wire),
      entry: companyRecordEntry(rec),
      entered,
      answered: (answer) => this.answeredAs(onRoute, wire, answer),
      refused: (cause) => this.refusedAs(joined, onRoute, wire, cause),
      notSent: () => new Error(notSentInTheBatch(`version ${rec.version} of this company's ${rec.kind} record`))
    };
  }

  /* `rec` signed with this seat's key for the company records route, and the view it is filed through; refused when it cannot be. */
  private signedToFile(rec: SealedCompanyRecord): {
    readonly joined: ThroughTheView;
    readonly onRoute: SealedCompanyRecord & { readonly kind: RecordRouteKind };
    readonly wire: ReturnType<typeof toCompanyWire>;
  } {
    if (rec.company !== this.company) throw new Error("that record is another company's, so nothing is filed.");
    const joined = this.joined;
    if (this.signWith === null || !filesThrough(joined)) throw new ReadFilesNothing(rec.kind, rec.version);
    /* The record route refuses a person and the roster, which are filed by their own routes: nothing is sent for either. */
    if (!onTheRecordRoute(rec))
      throw new Error(
        `a company's ${rec.kind} record is filed by its own route, never as a company record, so nothing is filed.`
      );
    return { joined, onRoute: rec, wire: toCompanyWire(signedWithItsEntry(rec, this.signWith)) };
  }

  /* Returns when the service's answer names this version and body as filed; otherwise it is not confirmed. */
  private answeredAs(rec: SealedCompanyRecord, wire: ReturnType<typeof toCompanyWire>, answer: unknown): void {
    const b = answer as Record<string, unknown> | null;
    if (b?.['filed'] === true && b['version'] === rec.version && b['digest'] === wire.digest) return;
    throw new Error(
      `version ${rec.version} of this company's ${rec.kind} record was not confirmed filed. It may have been filed: read it again before deciding anything.`
    );
  }

  /**
   * What a refusal of `wire` sent through the company's view means. Stopped by the check, nothing was sent. Told the
   * version is taken, the version is read back: these bytes are this filing delivered twice, and filed (it resolves);
   * another writer's is a lost race (`VaultPoolVersionAlreadyFiled`); unread, it is not confirmed. A refusal the service
   * gave (another 4xx), or one the check made before anything left, is said as refused and not filed; an answer that
   * never came, or a 5xx, as not confirmed.
   */
  private async refusedAs(
    joined: ThroughTheView,
    rec: SealedCompanyRecord & { readonly kind: RecordRouteKind },
    wire: ReturnType<typeof toCompanyWire>,
    cause: unknown
  ): Promise<void> {
    if (stoppedBeforeSending(cause)) throw cause;
    if (refusalOf(cause)?.['refused'] === 'version-already-filed') {
      /* Whose version it is, read back through the view as it is opened again after the refusal, rather than assumed. */
      const mine = await takenVersionHolds(
        () => joined.companyRecord({ kind: rec.kind, id: rec.id, every: true }),
        (every) => {
          const a = every as { versions?: unknown } | null;
          return Array.isArray(a?.versions)
            ? (a.versions as readonly { readonly version?: unknown }[]).find((w) => w?.version === rec.version)
            : undefined;
        },
        (taken) =>
          fromCompanyWire(taken, { company: this.company, kind: rec.kind, id: rec.id, version: rec.version }).wire
            .digest,
        wire.digest
      );
      if (mine === true) return;
      if (mine === false) throw new VaultPoolVersionAlreadyFiled(rec.id, rec.version);
      throw new Error(
        `version ${rec.version} of this company's ${rec.kind} record was told taken, and whose it is could not be read. It may have been filed: read it again before deciding anything.`,
        { cause }
      );
    }
    const failure = filingFailureOf(cause);
    if (failure.refused) {
      throw new Error(
        `version ${rec.version} of this company's ${rec.kind} record was refused and not filed (${failure.status ?? 'nothing sent'}: ${failure.why}).`,
        { cause }
      );
    }
    throw new Error(
      `version ${rec.version} of this company's ${rec.kind} record was not confirmed filed. It may have been filed: read it again before deciding anything.`,
      { cause }
    );
  }
}
