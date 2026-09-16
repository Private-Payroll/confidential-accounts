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
 */
import {
  VaultPoolVersionAlreadyFiled, whyThisIsNotASealedPool,
  type FiledPoolVersion, type SealedPool, type SealedPoolStore,
} from '../midnight/vault-pool.js';
import {
  assertWireVault, fromWire, toWire, wirePaths, type WireRecord,
} from '../midnight/sealed-record-wire.js';

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
  constructor(private readonly record: WireRecord, private readonly send: WireSend) {}

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
    if (b!.filed === null) return null;
    return fromWire(b!.filed, { vault, record: this.record }).sealed;
  }

  async versions(vault: string): Promise<readonly FiledPoolVersion[]> {
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
    return filed.map((f) => ({ version: f.wire.version, sealed: f.sealed }));
  }

  async put(vault: string, rec: SealedPool): Promise<void> {
    assertWireVault(vault);
    const unusable = whyThisIsNotASealedPool(rec, vault);
    if (unusable !== null) throw new Error(`this is not a sealed record for this vault (${unusable}), so nothing is filed.`);
    const wire = toWire(this.record, rec);
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
      const mine = await this.versions(vault).then(
        (all) => all.some((v) => v.version === rec.version && toWire(this.record, v.sealed).digest === wire.digest),
        () => undefined,
      );
      if (mine === true) return;
      if (mine === undefined) {
        throw this.notConfirmed(rec.version, 'the store says the version is taken, and whose it is could not be read back');
      }
      throw new VaultPoolVersionAlreadyFiled(vault, rec.version);
    }
    if (r.status === 422 && b?.refused === 'not-the-next-version' && b.version === rec.version) {
      throw new Error(`version ${rec.version} of this vault's ${this.record} was not filed: ${String(b.why)}`);
    }
    if (r.status >= 400 && r.status < 500) {
      throw new Error(
        `version ${rec.version} of this vault's ${this.record} was refused and not filed (${r.status}: ${said(b)}).`);
    }
    throw this.notConfirmed(rec.version, `the server answered ${r.status}: ${said(b)}`);
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
