/**
 * **A VERSION ANOTHER WRITER FILED FIRST, TOLD THROUGH THE COMPANY'S VIEW, IS A LOST RACE.** A store filing a vault's
 * record through the view, told the version is taken, reads that version back through the view: another writer's
 * bytes are a lost race the caller can build on again, its own bytes (a request sent twice) are entered, and a version
 * that cannot be read back is said as not confirmed. A company's record filed through the view is read back the same way.
 */
import { describe, expect, it } from 'vitest';
import { newSigningKeypair, newWrappingKeypair } from '../../../src/core/crypto.js';
import { sealPool, VaultPoolVersionAlreadyFiled } from '../../../src/midnight/vault-pool.js';
import { HttpCompanyRecordStore, HttpSealedPoolStore, readsJoinedIn, type ThroughTheView } from './http-sealed-pool-store.js';
import { companyViewFor, viewHeldOver } from './company-view.js';
import { serviceSource, takenOrThrown, type ServiceCall } from './records-source.js';

const VAULT = 'ab'.repeat(32);
const SIGNING = newSigningKeypair();
const READERS = [{ id: 'aa'.repeat(32), wrappingPublicKey: newWrappingKeypair().publicKey }];
const believeAll = async () => Object.assign(() => null, {}) as never;

/** The wire a store hands the view's write for `pool`. */
const wireOf = async (pool: ReturnType<typeof sealPool>): Promise<unknown> => {
  let wire: unknown;
  const view: ThroughTheView = {
    vaultRecord: async () => { throw new Error('nothing is read'); },
    companyRecord: async () => { throw new Error('no company record is read'); },
    file: async (w) => {
      wire = (w as { readonly body: unknown }).body;
      return { filed: true, record: 'pool', version: 1, digest: (wire as { digest: string }).digest };
    },
    manifest: { newest: async () => [0], enter: async () => {} },
    company: 'acc_taken',
  };
  await new HttpSealedPoolStore('pool', view, SIGNING.secret, believeAll).put(VAULT, pool);
  return wire;
};

/** A view that refuses the filing with the version taken, and answers every version of the record with `taken` (or cannot be read). */
const viewWith = (taken: unknown | 'unreadable', entered: string[]): ThroughTheView => ({
  vaultRecord: async (asked) => {
    if (taken === 'unreadable' || asked.every !== true) throw new Error('this read of the company has ended');
    return { record: 'pool', versions: [taken] };
  },
  companyRecord: async () => { throw new Error('no company record is read'); },
  file: async () => { throw Object.assign(new Error('the version is taken'), { body: { refused: 'version-already-filed', version: 1 } }); },
  manifest: { newest: async () => [0], enter: async () => { entered.push('entered'); } },
  company: 'acc_race',
});

describe('a version taken, told through the view', () => {
  const mine = sealPool(VAULT, { notes: [] } as never, READERS, 1, 'pool');
  const theirs = sealPool(VAULT, { notes: [{ nonce: '01'.repeat(32), token: '02'.repeat(32), value: '5' }] } as never, READERS, 1, 'pool');
  const storeOver = (view: ThroughTheView) => new HttpSealedPoolStore('pool', view, SIGNING.secret, believeAll);

  /* RED WHEN: another writer's version is said as one that may have been filed, so the caller's rebuild on the newest never runs. */
  it('is a lost race when the version holds another writer\'s bytes', async () => {
    const entered: string[] = [];
    await expect(storeOver(viewWith(await wireOf(theirs), entered)).put(VAULT, mine)).rejects.toThrow(VaultPoolVersionAlreadyFiled);
    expect(entered).toEqual([]);
  });

  /* RED WHEN: this device's own version, filed by a request sent twice, is taken for another's, or left unentered. */
  it('is entered when the version holds this store\'s own bytes', async () => {
    const entered: string[] = [];
    await storeOver(viewWith(await wireOf(mine), entered)).put(VAULT, mine);
    expect(entered).toEqual(['entered']);
  });

  /* RED WHEN: a version that could not be read back is said as a lost race or as filed. */
  it('is not confirmed when the version cannot be read back', async () => {
    const e = await storeOver(viewWith('unreadable', [])).put(VAULT, mine).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(VaultPoolVersionAlreadyFiled);
    expect((e as Error).message).toMatch(/was not confirmed filed/);
  });
});

/**
 * The company's service as a step's own view reaches it: the filing answered `version-already-filed`, every version of
 * the record answered with `taken` (the bytes the filing sent when `taken` is 'mine'), and every request kept in `asked`.
 */
const serviceTaking = (taken: unknown | 'mine', asked: string[]): ServiceCall => {
  let sent: unknown = null;
  return async (path, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as { records?: unknown[] };
    asked.push(`${method} ${path.split('?')[0]}`);
    if (method === 'PUT') {
      sent = body;
      return takenOrThrown({ status: 409, body: { refused: 'version-already-filed', version: 1, error: 'taken' } });
    }
    if (path.endsWith('/directory')) return { filings: [] };
    if (path.endsWith('/manifest/newest')) return { versions: (body?.records ?? []).map(() => 0) };
    if (path.endsWith('/vault-records/read')) return { records: (body?.records ?? []).map(() => ({ record: 'pool', versions: [taken === 'mine' ? sent : taken] })) };
    return {};
  };
};

/** A store filing through a step's view of the company over `call`, opened again after a write it refused, as every step holds one. */
const storeThroughAStepsView = (call: ServiceCall) => {
  const holders = { seats: ['a'], approvals: 1, adoptedVaults: [VAULT], threshold: 1, committee: [], vaultThresholds: [], policyBar: null };
  const held = viewHeldOver((from) => companyViewFor(serviceSource(call, 'acc_race'), {
    holders: async () => holders, onChain: async () => ({ landed: [], now: { approvals: 1 } }) as never, builder: { anchorHeads: async () => ({}) as never },
  }, async () => ({}) as never, from));
  return new HttpSealedPoolStore('pool', readsJoinedIn(held), SIGNING.secret, believeAll);
};

describe('a version taken, told through a step\'s own view of the company, which the refusal ends', () => {
  const mine = sealPool(VAULT, { notes: [] } as never, READERS, 1, 'pool');
  const theirs = sealPool(VAULT, { notes: [{ nonce: '01'.repeat(32), token: '02'.repeat(32), value: '5' }] } as never, READERS, 1, 'pool');

  /* RED WHEN: the read-back goes through the view the refusal ended, so a request delivered twice is said as not confirmed and never entered. */
  it('reads the version back through the view opened again, and enters it when it holds this store\'s own bytes', async () => {
    const asked: string[] = [];
    await storeThroughAStepsView(serviceTaking('mine', asked)).put(VAULT, mine);
    expect(asked).toContain('POST /api/accounts/acc_race/vault-records/read');
    expect(asked.at(-1)).toBe('POST /api/accounts/acc_race/manifest/entries');
  });

  /* RED WHEN: another writer's version, read back through the view opened again, is said as one that may have been filed. */
  it('is a lost race when the version read back holds another writer\'s bytes', async () => {
    const asked: string[] = [];
    await expect(storeThroughAStepsView(serviceTaking(await wireOf(theirs), asked)).put(VAULT, mine)).rejects.toThrow(VaultPoolVersionAlreadyFiled);
    expect(asked).not.toContain('POST /api/accounts/acc_race/manifest/entries');
  });
});

describe('a filing refused through the view, said as the service answered it', () => {
  const mine = sealPool(VAULT, { notes: [] } as never, READERS, 1, 'pool');
  const refusing = (thrown: object): ThroughTheView => ({
    vaultRecord: async () => { throw new Error('nothing is read'); },
    companyRecord: async () => { throw new Error('no company record is read'); },
    file: async () => { throw Object.assign(new Error('the filing was not taken'), thrown); },
    manifest: { newest: async () => [0], enter: async () => { throw new Error('nothing is entered'); } },
    company: 'acc_refused',
  });
  const filed = (thrown: object) => new HttpSealedPoolStore('pool', refusing(thrown), SIGNING.secret, believeAll).put(VAULT, mine);

  /* RED WHEN: a filing the service refused, or one stopped before it was sent, is said as one that may have been filed. */
  it('is refused and not filed for a 4xx, or when nothing was sent', async () => {
    await expect(filed({ status: 403, body: { error: 'this seat may not file' } })).rejects.toThrow(/was refused and not filed \(403: this seat may not file\)/);
    await expect(filed({ thisSendNotSent: true })).rejects.toThrow(/was refused and not filed \(nothing sent: the filing was not taken\)/);
  });

  /* RED WHEN: a filing whose outcome is not known is said as refused, so the change is filed again over it. */
  it('is not confirmed for a 5xx or no status', async () => {
    await expect(filed({ status: 503, body: { error: 'busy' } })).rejects.toThrow(/was not confirmed filed/);
    await expect(filed({})).rejects.toThrow(/was not confirmed filed/);
  });
});

describe('a version of a company\'s record taken, told through the view', () => {
  const COMPANY = 'acc_taken';
  const roster = (body: string) => ({
    company: COMPANY, kind: 'roster', id: 'roster', version: 1, keyEpoch: 0, wrapped: [],
    sealed: { iv: '11'.repeat(12), tag: '22'.repeat(16), body },
  }) as never;
  const storeOver = (view: ThroughTheView) => new HttpCompanyRecordStore(COMPANY, view, SIGNING.secret, believeAll);
  /** The wire the store hands the view's write for `rec`. */
  const companyWireOf = async (rec: never): Promise<unknown> => {
    let wire: unknown;
    await storeOver({
      vaultRecord: async () => { throw new Error('nothing is read'); },
      companyRecord: async () => { throw new Error('nothing is read'); },
      file: async (w) => {
        wire = (w as { readonly body: unknown }).body;
        return { filed: true, version: 1, digest: (wire as { digest: string }).digest };
      },
      manifest: { newest: async () => [0], enter: async () => {} },
      company: COMPANY,
    }).put(rec);
    return wire;
  };
  /** A view that refuses the filing with the version taken, and answers every version of the record with `taken` (or cannot be read). */
  const takenAs = (taken: unknown | 'unreadable'): ThroughTheView => ({
    vaultRecord: async () => { throw new Error('no vault record is read'); },
    companyRecord: async (asked) => {
      if (taken === 'unreadable' || asked.every !== true) throw new Error('this read of the company has ended');
      return { kind: 'roster', id: 'roster', versions: [taken] };
    },
    file: async () => { throw Object.assign(new Error('the version is taken'), { body: { refused: 'version-already-filed', version: 1 } }); },
    manifest: { newest: async () => [0], enter: async () => {} },
    company: COMPANY,
  });
  const mine = roster('33');
  const theirs = roster('44');

  /* RED WHEN: this device's own version, filed by a request delivered twice, is taken for another writer's. */
  it('is filed when the version holds this store\'s own bytes', async () => {
    await expect(storeOver(takenAs(await companyWireOf(mine))).put(mine)).resolves.toBeUndefined();
  });

  /* RED WHEN: another writer's version is said as this store's own, or as one that may have been filed. */
  it('is a lost race when the version holds another writer\'s bytes', async () => {
    await expect(storeOver(takenAs(await companyWireOf(theirs))).put(mine)).rejects.toThrow(VaultPoolVersionAlreadyFiled);
  });

  /* RED WHEN: a version that could not be read back is said as a lost race or as filed. */
  it('is not confirmed when the version cannot be read back', async () => {
    const e = await storeOver(takenAs('unreadable')).put(mine).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(VaultPoolVersionAlreadyFiled);
    expect((e as Error).message).toMatch(/could not be read\. It may have been filed/);
  });
});
