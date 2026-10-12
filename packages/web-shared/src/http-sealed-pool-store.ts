/**
 * **THE PAGE'S SEALED STORE: THE PRODUCT'S DATABASE, REACHED OVER HTTP, AND
 * NEVER HANDED ANYTHING IT COULD OPEN.**
 *
 * A vault's pool and journals are opened here, on the person's device, with
 * their own key. What this sends is the sealed record and nothing else, and
 * what it believes back is only what `sealed-record-wire.ts` has checked: the
 * record it asked for, the version it asked for, the bytes the digest names.
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
 * check S): an entry the seat's own wallet signed, for a seat the account holds
 * now, whose role may file this record. A version signed by a seat that has
 * left is refused unless a quorum's retirement names it, and the server's word
 * is never what makes a version believed.
 */
import { companyRecordEntry, vaultRecordEntry, type RecordRead } from '../../../src/midnight/record-manifest.js';
import type { RecordsEntered } from './record-entered-here.js';
import type { RecordsAsked } from '../../../src/midnight/records-held.js';
import {
  VaultPoolVersionAlreadyFiled, VaultRecordRefused, whyThisIsNotASealedPool,
  type FiledPoolVersion, type PassedOverVersion, type SealedPool, type SealedPoolStore,
} from '../../../src/midnight/vault-pool.js';
import {
  assertWireVault, fromWire, signFiling, toWire, verifiedFiler, wirePaths, type WireRecord,
} from '../../../src/midnight/sealed-record-wire.js';
import type { Hex } from '../../../src/core/crypto.js';
import { companyRecordKey, vaultRecordKey, type FiledKind } from '../../../src/midnight/seat-directory.js';
import {
  companyWirePaths, fromCompanyWire, signCompanyFiling, toCompanyWire, verifiedCompanyFiler,
  type CompanyRecordKind, type SealedCompanyRecord,
} from '../../../src/midnight/sealed-record-wire.js';

/**
 * **WHETHER ONE VERSION IS BELIEVED**: null when it is, or the reason it is not.
 * `filer` is the key whose signature over exactly this version verifies, or
 * null; `read` is the record as its entry in the company's records names it;
 * `newest`, that it is read as the record's newest version.
 */
export type FilingJudge = ((filer: Hex | null, kind: FiledKind, recordKey: string, read: RecordRead, newest?: boolean) => string | null) & {
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
};

/**
 * **A JUDGE MADE FRESH FOR ONE READ, FOR WHAT THAT READ WILL JUDGE**: the
 * company's directory read again, the chain read again by the person's own
 * wallet, and the records and kinds `asked` proven against the head on chain in
 * one request, so no read rests on what an earlier one saw. A record the read
 * did not ask for is refused, never believed.
 */
export type FreshJudge = (asked?: RecordsAsked) => Promise<FilingJudge>;

/** How many times a write told its version is taken reads that version back before saying it is not confirmed. */
export const READ_BACK_ATTEMPTS = 3;

/** One request to this product's own server, and its answer. */
export type WireSend = (
  path: string,
  init: { readonly method: 'GET' | 'PUT'; readonly body?: string },
) => Promise<{ readonly status: number; readonly body: unknown }>;

const said = (body: unknown): string => {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'string' ? e : 'no reason given';
};

export class HttpSealedPoolStore implements SealedPoolStore {
  constructor(
    private readonly record: WireRecord,
    private readonly send: WireSend,
    /** The signing secret of the signer this device files as. It is used here and sent nowhere. */
    private readonly signWith: Hex,
    /** Who this device believes filed a version, asked afresh for each read. */
    private readonly judge: FreshJudge,
    /** The one filing call, bound to the vault's company and this seat: a version filed here is entered in the company's records. */
    private readonly entered: RecordsEntered,
  ) {
    if (typeof signWith !== 'string' || !/^[0-9a-f]{64}$/u.test(signWith)) {
      throw new Error('a sealed record is filed signed, and this device was given no signing key to sign it with.');
    }
  }

  private refuse(what: string, status: number, body: unknown): never {
    throw new Error(
      `this vault's ${this.record} could not be ${what} (the server answered ${status}: ${said(body)}). `
      + 'That is not a record holding nothing. Nothing has been changed on this device; try again once '
      + 'the server answers.');
  }

  async get(vault: string): Promise<SealedPool | null> {
    assertWireVault(vault);
    const r = await this.send(wirePaths.newest(vault, this.record), { method: 'GET' });
    if (r.status !== 200) this.refuse('read', r.status, r.body);
    const b = r.body as { record?: unknown; filed?: unknown } | null;
    if (b?.record !== this.record || !('filed' in (b ?? {}))) this.refuse('read', r.status, { error: 'the answer is not about this record' });
    const judge = await this.judge(this.asked(vault));
    if (b!.filed === null) return this.absent(vault, judge);
    return this.believed(fromWire(b!.filed, { vault, record: this.record }).sealed, judge, true);
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
    const why = judge(verifiedFiler(this.record, rec), this.record, vaultRecordKey(rec.vault, this.record),
      vaultRecordEntry(this.record, rec), newest);
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

  async versions(vault: string): Promise<readonly (FiledPoolVersion | PassedOverVersion)[]> {
    const filed = await this.listed(vault);
    const judge = await this.judge(this.asked(vault));
    /* No version given, where the company's records name one, is a list withheld, not an empty one. */
    if (filed.length === 0) return this.absent(vault, judge) ?? [];
    /*
     * Every version as one the anchor holds, and the last as the newest: a list the service cut short is refused.
     * A version the company's records passed over is said as such, without its bytes; never the newest.
     */
    return filed.map((f, i): FiledPoolVersion | PassedOverVersion => (i < filed.length - 1 && judge.neverEntered?.({ store: 'vault', kind: this.record, id: vault, version: f.wire.version }) === true
      ? { version: f.wire.version, neverEntered: true as const }
      : { version: f.wire.version, sealed: this.believed(f.sealed, judge, i === filed.length - 1) }));
  }

  private async listed(vault: string) {
    assertWireVault(vault);
    const r = await this.send(wirePaths.versions(vault, this.record), { method: 'GET' });
    if (r.status !== 200) this.refuse('listed', r.status, r.body);
    const b = r.body as { record?: unknown; versions?: unknown } | null;
    if (b?.record !== this.record || !Array.isArray(b.versions)) {
      this.refuse('listed', r.status, { error: 'the answer is not a list of this record\x27s versions' });
    }
    const filed = (b!.versions as unknown[]).map((m) => fromWire(m, { vault, record: this.record }));
    filed.forEach((f, i) => {
      if (f.wire.version !== i + 1) {
        this.refuse('listed', r.status, {
          error: `the list names version ${f.wire.version} where version ${i + 1} belongs, so it is not every version, in order`,
        });
      }
    });
    return filed;
  }

  async put(vault: string, rec: SealedPool): Promise<void> {
    assertWireVault(vault);
    const unusable = whyThisIsNotASealedPool(rec, vault);
    if (unusable !== null) throw new Error(`this is not a sealed record for this vault (${unusable}), so nothing is filed.`);
    const signed = signFiling(this.record, rec, this.signWith);
    const wire = toWire(this.record, signed);
    let r: { status: number; body: unknown };
    try {
      r = await this.send(wirePaths.file(vault, this.record, rec.version), { method: 'PUT', body: JSON.stringify(wire) });
    } catch (cause) {
      throw this.notConfirmed(rec.version, (cause as Error)?.message ?? String(cause), cause);
    }
    const b = r.body as Record<string, unknown> | null;
    if (r.status === 201) {
      if (b?.filed !== true || b.record !== this.record || b.version !== rec.version || b.digest !== wire.digest) {
        throw this.notConfirmed(rec.version, 'the server\x27s answer names a different record, version or body than the one sent');
      }
      await this.entered.enter([vaultRecordEntry(this.record, signed)]);
      return;
    }
    if (r.status === 409 && b?.refused === 'version-already-filed' && b.version === rec.version) {
      /*
       * **WHOSE VERSION IT IS, ASKED RATHER THAN ASSUMED.** A request sent twice
       * (a retry somewhere between here and the store) finds the version it
       * filed itself already there. Reported as another writer's, a pool write
       * made after money moved would be re-applied to a pool that already holds
       * it, and refused as though the money were unrecorded.
       */
      const mine = await this.whoseVersion(vault, rec.version, wire.digest);
      if (mine === true) {
        /* Its own version, filed by a request sent twice: entered again, which the company's records answer as entered already. */
        await this.entered.enter([vaultRecordEntry(this.record, signed)]);
        return;
      }
      if (mine === undefined) {
        throw this.notConfirmed(rec.version, 'the store says the version is taken, and whose it is could not be read back');
      }
      throw new VaultPoolVersionAlreadyFiled(vault, rec.version);
    }
    if (r.status === 422 && b?.refused === 'not-the-next-version' && b.version === rec.version) {
      throw new Error(`version ${rec.version} of this vault's ${this.record} was not filed: ${String(b.why)}`);
    }
    if (r.status === 422 && b?.refused === 'not-filed' && b.version === rec.version) {
      throw new VaultRecordRefused(`version ${rec.version} of this vault's ${this.record} was refused and not filed: ${String(b.why)}`);
    }
    if (r.status >= 400 && r.status < 500) {
      throw new Error(
        `version ${rec.version} of this vault's ${this.record} was refused and not filed (${r.status}: ${said(b)}).`);
    }
    throw this.notConfirmed(rec.version, `the server answered ${r.status}: ${said(b)}`);
  }

  /**
   * **WHETHER THE TAKEN VERSION HOLDS THESE BYTES**: true, false, or undefined
   * when it could not be read back after `READ_BACK_ATTEMPTS` tries. Only that
   * one version is read.
   */
  private async whoseVersion(vault: string, version: number, digest: string): Promise<boolean | undefined> {
    for (let i = 0; i < READ_BACK_ATTEMPTS; i += 1) {
      try {
        const r = await this.send(wirePaths.one(vault, this.record, version), { method: 'GET' });
        const b = r.body as { record?: unknown; version?: unknown; filed?: unknown } | null;
        if (r.status !== 200 || b?.record !== this.record || b.version !== version || !b.filed) continue;
        return fromWire(b.filed, { vault, record: this.record, version }).wire.digest === digest;
      } catch {
        /* a read that failed or came back malformed is tried again */
      }
    }
    return undefined;
  }

  private notConfirmed(version: number, why: string, cause?: unknown): Error {
    return new Error(
      `version ${version} of this vault's ${this.record} was not confirmed filed (${why}). It may have been `
      + 'filed: read the record again before deciding anything, and do not file the same change again on '
      + 'the assumption that it was not.', cause === undefined ? undefined : { cause });
  }
}

/**
 * **HOW THE PAGE SENDS ONE REQUEST**: to its own origin only, with the sign-in
 * cookie, and saying which person this tab was prepared for, so a sign-in
 * changed in another tab is refused rather than written under.
 */
export const pageWireSend = (
  signedInAs: () => string | null,
  doFetch: typeof fetch = fetch,
): WireSend => async (path, init) => {
  if (!path.startsWith('/api/')) throw new Error('a sealed record is sent to this product\x27s own server and nowhere else');
  const who = signedInAs();
  const r = await doFetch(path, {
    method: init.method,
    ...(init.body === undefined ? {} : { body: init.body }),
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(who ? { 'x-signed-in-as': who } : {}) },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

/** A record the company's records name and the service did not give at all, by name, with the reason. Nothing is built as if it were absent. */
export class RecordWithheld extends Error {
  constructor(readonly record: string, readonly why: string) {
    super(`this ${record} was not given, and it is not read as absent, because ${why}. Nothing is built on it. `
      + 'That is not a record holding nothing.');
    this.name = 'RecordWithheld';
  }
}

/** A version this device does not believe, by name, with the reason. Nothing is built on it. */
export class FilingNotBelieved extends Error {
  constructor(readonly record: string, readonly version: number, readonly why: string) {
    super(`version ${version} of this ${record} is not believed, because ${why}. Nothing is built on it. `
      + 'That is not a record holding nothing.');
    this.name = 'FilingNotBelieved';
  }
}

/**
 * **A COMPANY'S OWN RECORDS, REACHED OVER HTTP**: filed signed by this
 * device's seat, and read back believed only when a seat the directory names
 * filed them, by the same fresh check as a vault's records.
 */
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

export class HttpCompanyRecordStore {
  constructor(
    private readonly company: string,
    private readonly send: WireSend,
    private readonly signWith: Hex,
    private readonly judge: FreshJudge,
  ) {
    if (typeof signWith !== 'string' || !/^[0-9a-f]{64}$/u.test(signWith)) {
      throw new Error('a company record is filed signed, and this device was given no signing key to sign it with.');
    }
  }

  private believed(rec: SealedCompanyRecord, judge: FilingJudge, newest: boolean): SealedCompanyRecord {
    const why = judge(verifiedCompanyFiler(rec), rec.kind, companyRecordKey(rec.kind, rec.id), companyRecordEntry(rec), newest);
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
    const r = await this.send(companyWirePaths.newest(this.company, kind, id), { method: 'GET' });
    const b = r.body as { kind?: unknown; id?: unknown; filed?: unknown } | null;
    if (r.status !== 200 || b?.kind !== kind || b?.id !== id || !('filed' in (b ?? {}))) {
      throw new Error(`this company's ${kind} record could not be read (the server answered ${r.status}: ${said(r.body)}). That is not a record holding nothing.`);
    }
    const judge = await this.judge({ records: [{ store: 'company', kind, id }] });
    if (b!.filed === null) return this.absent(kind, id, judge);
    return this.believed(fromCompanyWire(b!.filed, { company: this.company, kind, id }).sealed, judge, true);
  }

  async versions(kind: CompanyRecordKind, id: string): Promise<readonly (SealedCompanyRecord | CompanyVersionPassedOver)[]> {
    const r = await this.send(companyWirePaths.versions(this.company, kind, id), { method: 'GET' });
    const b = r.body as { versions?: unknown } | null;
    if (r.status !== 200 || !Array.isArray(b?.versions)) {
      throw new Error(`this company's ${kind} record could not be listed (the server answered ${r.status}: ${said(r.body)}).`);
    }
    const filed = (b!.versions as unknown[]).map((m) => fromCompanyWire(m, { company: this.company, kind, id }).sealed);
    filed.forEach((f, i) => {
      if (f.version !== i + 1) throw new Error(`the list names version ${f.version} where version ${i + 1} belongs, so it is not every version, in order.`);
    });
    const judge = await this.judge({ records: [{ store: 'company', kind, id }] });
    if (filed.length === 0) return this.absent(kind, id, judge) ?? [];
    /* A version the company's records passed over is said as such, without its bytes; never the newest. */
    return filed.map((f, i) => (i < filed.length - 1 && judge.neverEntered?.({ store: 'company', kind, id, version: f.version }) === true
      ? { company: this.company, kind, id, version: f.version, neverEntered: true as const }
      : this.believed(f, judge, i === filed.length - 1)));
  }

  async put(rec: SealedCompanyRecord): Promise<void> {
    if (rec.company !== this.company) throw new Error('that record is another company\'s, so nothing is filed.');
    const wire = toCompanyWire(signCompanyFiling(rec, this.signWith));
    let r: { status: number; body: unknown };
    try {
      r = await this.send(companyWirePaths.one(this.company, rec.kind, rec.id, rec.version), { method: 'PUT', body: JSON.stringify(wire) });
    } catch (cause) {
      throw new Error(`version ${rec.version} of this company's ${rec.kind} record was not confirmed filed. It may have been filed: read it again before deciding anything.`, { cause });
    }
    const b = r.body as Record<string, unknown> | null;
    if (r.status === 201 && b?.filed === true && b.version === rec.version && b.digest === wire.digest) return;
    if (r.status === 409 && b?.refused === 'version-already-filed') throw new VaultPoolVersionAlreadyFiled(rec.id, rec.version);
    throw new Error(`version ${rec.version} of this company's ${rec.kind} record was refused and not filed (${r.status}: ${said(b)}).`);
  }
}
