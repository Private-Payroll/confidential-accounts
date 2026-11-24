/**
 * **A BODY READ AFTER THE HELD ANSWER IS JUDGED ONCE MORE OVER A FRESH ONE** (`judgedOnce`, `CompanyView.heldAgain`).
 * Another seat enters a newer version of a record between the step's held read and its read of the record's body: the
 * held answer does not name the body, so it is refused as not entered. The view lets go of the held answer once, the
 * judge reads it afresh, and the body is believed from the version the company's records now name. A second refusal
 * refuses, and a view reads held again only once, so a service changing records cannot keep a step reading.
 */
import { describe, it, expect } from 'vitest';
import { newSigningKeypair, newWrappingKeypair, type Hex } from '../../../src/core/crypto.js';
import { sealPool } from '../../../src/midnight/vault-pool.js';
import { FilingNotBelieved, HttpCompanyRecordStore, HttpSealedPoolStore, type FilingJudge } from './http-sealed-pool-store.js';
import { signCompanyFiling, toCompanyWire } from '../../../src/midnight/sealed-record-wire.js';
import { storeReachOver } from '../../../src/testing/writes-over-a-send.js';
import { readRoutesOverSend } from '../../../src/testing/service-routes-in-memory.js';

const ACC = 'acc_held_behind';
const ADA = newSigningKeypair();
const NOT_ENTERED = 'no entry in the company\'s records names it';
const NO_SIGNATURE = 'it carries no valid signature for this record';

const filed = (version: number) => signCompanyFiling({
  company: ACC, kind: 'roster', id: 'roster', version, keyEpoch: 0, sealed: { iv: '11'.repeat(12) as Hex, tag: '22'.repeat(16) as Hex, body: '33' as Hex },
  wrapped: [],
} as never, ADA.secret);

/** A judge made for each held read in turn: `says[i]` is what the i-th read's judge answers, and a held read behind says so. */
const judgesSaying = (...says: (string | null)[]) => {
  const versions: number[] = [];
  let made = 0;
  const fresh = async (): Promise<FilingJudge> => {
    const why = says[Math.min(made, says.length - 1)]!;
    made += 1;
    return Object.assign((_f: unknown, _k: unknown, _key: unknown, read: { version?: number }) => { versions.push(read.version ?? 0); return why; },
      { heldBehind: (w: string) => w === NOT_ENTERED });
  };
  return { fresh, made: () => made, versions };
};

/** The store over one view; `letGo` records each answer the view's `heldAgain` gave. */
const aStore = (judge: () => Promise<FilingJudge>, letGo: boolean[] = []) => {
  const reach = storeReachOver(readRoutesOverSend(
    async () => ({ status: 200, body: { kind: 'roster', id: 'roster', filed: toCompanyWire(filed(2)) } }),
    { directory: 'empty', newest: 'none-entered' }), ACC);
  return new HttpCompanyRecordStore(ACC, { ...reach, heldAgain: async () => { const r = await reach.heldAgain!(); letGo.push(r); return r; } }, ADA.secret, judge);
};

describe('a body read after the held answer', () => {
  it('is believed from the version the company\'s records name once held is read afresh: the run is drawn from the new version', async () => {
    const j = judgesSaying(NOT_ENTERED, null);
    const rec = await aStore(j.fresh).get('roster', 'roster');
    /* RED WHEN: a body entered after the held read is refused, where a fresh held read names it. */
    expect(rec?.version).toBe(2);
    expect(j.made()).toBe(2);
    expect(j.versions).toEqual([2, 2]);
  });

  it('is refused when the fresh held read refuses it too, and the view lets go of held only once', async () => {
    const j = judgesSaying(NOT_ENTERED);
    const letGo: boolean[] = [];
    const store = aStore(j.fresh, letGo);
    /* RED WHEN: a second mismatch is believed, or judged again and again. */
    await expect(store.get('roster', 'roster')).rejects.toBeInstanceOf(FilingNotBelieved);
    expect(j.made()).toBe(2);
    await expect(store.get('roster', 'roster')).rejects.toBeInstanceOf(FilingNotBelieved);
    expect(j.made()).toBe(4);
    /* RED WHEN: the same view lets go of held a second time, so a service changing records keeps a step reading. */
    expect(letGo).toEqual([true, false]);
  });

  it('is judged again over the fresh answer when another read beside it made the view let go first', async () => {
    const j = judgesSaying(NOT_ENTERED, NOT_ENTERED, null);
    const store = aStore(j.fresh);
    const [a, b] = await Promise.allSettled([store.get('roster', 'roster'), store.get('roster', 'roster')]);
    /* RED WHEN: the second of two reads side by side refuses a body the fresh held answer believes, as the view had already let go. */
    expect([a.status, b.status]).toEqual(['fulfilled', 'fulfilled']);
  });

  it('is never read again for a refusal a fresh held read cannot change', async () => {
    const j = judgesSaying(NO_SIGNATURE, null);
    /* RED WHEN: a record no seat signed is judged again, as though a newer held answer could vouch for it. */
    await expect(aStore(j.fresh).get('roster', 'roster')).rejects.toThrow(/no valid signature/u);
    expect(j.made()).toBe(1);
  });
});

describe('a vault\'s record read after the held answer', () => {
  const VAULT = 'ab'.repeat(32);
  const WRAPPING = newWrappingKeypair();
  /** A vault's pool with two versions filed, and a store that reads it through one view, judged by `judge`; `letGo` as `aStore`'s. */
  const aVaultStore = async (judge: () => Promise<FilingJudge>, letGo: boolean[] = []) => {
    const filed: unknown[] = [];
    const routes = readRoutesOverSend(async (path, init) => {
      if (init.method === 'PUT') {
        const wire = JSON.parse(init.body!);
        filed.push(wire);
        return { status: 201, body: { filed: true, record: 'pool', version: wire.version, digest: wire.digest } };
      }
      if (path.endsWith('/versions')) return { status: 200, body: { record: 'pool', versions: filed } };
      return { status: 200, body: { record: 'pool', filed: filed.at(-1) ?? null } };
    }, { directory: 'empty', newest: 'none-entered' });
    const filer = new HttpSealedPoolStore('pool', storeReachOver(routes, ACC), ADA.secret, async () => Object.assign(() => null, {}));
    for (const version of [1, 2]) await filer.put(VAULT, sealPool(VAULT, { notes: [] } as never, [{ id: 'aa'.repeat(32), wrappingPublicKey: WRAPPING.publicKey }], version, 'pool'));
    const reach = storeReachOver(routes, ACC);
    return new HttpSealedPoolStore('pool', { ...reach, heldAgain: async () => { const r = await reach.heldAgain!(); letGo.push(r); return r; } }, null, judge);
  };

  it('is believed from every version the fresh held answer names: the list read once more, after the one let-go', async () => {
    const j = judgesSaying(NOT_ENTERED, null);
    const letGo: boolean[] = [];
    const read = await (await aVaultStore(j.fresh, letGo)).versionsBelieved(VAULT);
    /* RED WHEN: a version entered after the held read is refused from the list, where a fresh held read names it. */
    expect([read.versions.map((v) => v.version), read.refused]).toEqual([[1, 2], []]);
    expect([j.made(), letGo]).toEqual([2, [true]]);
  });

  it('keeps the refusal, and reads held no more, when a fresh held read cannot change it', async () => {
    const j = judgesSaying(NO_SIGNATURE, null);
    const letGo: boolean[] = [];
    const read = await (await aVaultStore(j.fresh, letGo)).versionsBelieved(VAULT);
    /* RED WHEN: a version no seat signed is judged again, as though a newer held answer could vouch for it. */
    expect(read.refused.map((r) => r.why)).toEqual([NO_SIGNATURE, NO_SIGNATURE]);
    expect([j.made(), letGo]).toEqual([1, []]);
  });

  it('reads its newest version through the same one retry: believed over the fresh held answer, a second refusal refused', async () => {
    const once = judgesSaying(NOT_ENTERED, null);
    /* RED WHEN: the newest version of a vault's record, entered after the held read, is refused where a fresh held read names it. */
    expect((await (await aVaultStore(once.fresh)).get(VAULT))?.version).toBe(2);
    expect(once.made()).toBe(2);
    const twice = judgesSaying(NOT_ENTERED);
    const letGo: boolean[] = [];
    /* RED WHEN: a second mismatch over the fresh answer is believed. */
    await expect((await aVaultStore(twice.fresh, letGo)).get(VAULT)).rejects.toBeInstanceOf(FilingNotBelieved);
    expect([twice.made(), letGo]).toEqual([2, [true]]);
  });
});

describe('a record write names only what the record route takes', () => {
  it('refuses a roster or a person before anything is sent, which the record route would refuse', async () => {
    let sent = 0;
    const store = new HttpCompanyRecordStore(ACC, storeReachOver(readRoutesOverSend(async () => { sent += 1; return { status: 200, body: {} }; },
      { directory: 'empty', newest: 'none-entered' }), ACC), ADA.secret, async () => Object.assign(() => null, {}) as never);
    for (const kind of ['roster', 'person'] as const) {
      /* RED WHEN: a person or the roster is sent to the route that refuses both, so the step learns it only from the service. */
      await expect(store.put({ ...filed(1), kind, id: kind === 'roster' ? 'roster' : 'p1' } as never)).rejects.toThrow(/filed by its own route/u);
    }
    expect(sent).toBe(0);
  });
});
