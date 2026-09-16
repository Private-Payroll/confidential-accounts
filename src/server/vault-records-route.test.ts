/**
 * **THE PAGE'S STORE AND THE SERVER'S ROUTE, TALKING OVER REAL HTTP.** The
 * route is mounted in a throwaway app behind a stand-in for the sign-in, and
 * the page's store is the one the page uses. The pool and both journals run
 * over it unchanged: a lost race is retried by name, every filing is signed and
 * checked, and nothing on the server can open what it keeps.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { vaultRecordsRoutes, VAULT_RECORD_BODY_LIMIT, type MayTouchVaultRecords } from './vault-records-route.js';
import { HttpSealedPoolStore, pageWireSend, type WireSend } from '../web/http-sealed-pool-store.js';
import {
  MemorySealedPoolStore, SealedNotePool, sealPool, VaultPoolVersionAlreadyFiled, VaultRecordRefused,
  type SealedPoolStore,
} from '../midnight/vault-pool.js';
import { DepositJournalInStore, PaymentJournalInStore } from '../midnight/vault-journal.js';
import { depositNonceAt, depositNonceKeyFor } from '../midnight/deposit-nonce.js';
import { signFiling, toWire, type WireRecord } from '../midnight/sealed-record-wire.js';
import { newSigningKeypair, newWrappingKeypair, type Hex } from '../core/crypto.js';

const VAULT = 'ab'.repeat(32);
const THEIRS = 'cd'.repeat(32);
const GBP = 'aa'.repeat(32);
const KEY = depositNonceKeyFor(new Uint8Array(32).fill(5), VAULT);

let base = '';
let server: ReturnType<express.Express['listen']>;
let stores: Record<WireRecord, MemorySealedPoolStore>;
let loseNext = 0;
let refuseNext: string | null = null;
const asked: Array<{ person: string; vault: string; record: WireRecord; act: string; filer?: Hex }> = [];

const mayTouch: MayTouchVaultRecords = async (person, vault, record, act, filer) => {
  asked.push({ person, vault, record, act, ...(filer === undefined ? {} : { filer }) });
  return person === 'ada' && vault === VAULT;
};
const ADA = newSigningKeypair();
const BOB = newSigningKeypair();
const roster = async (): Promise<ReadonlySet<Hex>> => new Set([ADA.publicKey]);
const pageStore = (record: WireRecord, send: WireSend, key: Hex = ADA.secret) => new HttpSealedPoolStore(record, send, key, roster);

beforeAll(async () => {
  stores = {
    pool: new MemorySealedPoolStore(), 'deposit-journal': new MemorySealedPoolStore(),
    'payment-journal': new MemorySealedPoolStore(), 'nonce-secret': new MemorySealedPoolStore(),
  };
  /*
   * A lost race, as a real store loses one: another writer's version is filed
   * first, and then this one is refused.
   */
  const racy = (inner: MemorySealedPoolStore, record: WireRecord): SealedPoolStore => ({
    get: (v) => inner.get(v),
    versions: (v) => inner.versions(v),
    at: (v, n) => inner.at(v, n),
    put: async (v, rec) => {
      if (loseNext > 0) {
        loseNext -= 1;
        const page = record === 'payment-journal' ? { attempts: [] } : { notes: [] };
        await inner.put(v, signFiling(record, sealPool(v, page as never, await signers(), rec.version, record), ADA.secret));
        throw new VaultPoolVersionAlreadyFiled(v, rec.version);
      }
      if (refuseNext !== null) { const why = refuseNext; refuseNext = null; throw new VaultRecordRefused(why); }
      return inner.put(v, rec);
    },
  });
  const app = express();
  app.use(express.json({ limit: VAULT_RECORD_BODY_LIMIT }));
  /* The stand-in for the sign-in: the person is whoever the header names, and nobody without it. */
  app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') req.userId = p; next(); });
  app.use(vaultRecordsRoutes({ records: { of: (r) => racy(stores[r], r) }, mayTouch }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const sendAs = (person: string | null): WireSend => async (path, init) => {
  const r = await fetch(base + path, {
    method: init.method, ...(init.body === undefined ? {} : { body: init.body }),
    headers: { 'content-type': 'application/json', ...(person ? { 'x-test-person': person } : {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const signer = newWrappingKeypair();
const signers = async () => [{ id: 'ada', wrappingPublicKey: signer.publicKey }];
const opener = { id: 'ada', wrappingSecret: signer.secret };

describe('a vault\'s sealed records, from the page to the server and back', () => {
  it('A POOL AND BOTH JOURNALS RUN OVER IT UNCHANGED, every version filed signed by the signer who filed it', async () => {
    const pool = new SealedNotePool(pageStore('pool', sendAs('ada')), { signerId: 'ada', wrappingSecret: signer.secret }, signers);
    await pool.create(VAULT, { notes: [] });
    const journal = new DepositJournalInStore(pageStore('deposit-journal', sendAs('ada')), VAULT, opener, signers, KEY);
    const claimed = await journal.claim(VAULT, { token: GBP, value: 500n }, 1, 't');
    expect(claimed.coin.nonce, 'RED WHEN: the nonce is not derived from the slot the claim was given')
      .toBe(depositNonceAt(KEY, { token: GBP, value: 500n }, 1));
    expect(asked.filter((a) => a.act === 'file').every((a) => a.filer === ADA.publicKey),
      'RED WHEN: the answer about who may file is not told whose signature the filing carries').toBe(true);
    expect((await stores['deposit-journal'].versions(VAULT))[0]!.sealed.filedBy?.publicKey, 'RED WHEN: the store keeps a filing without who signed it')
      .toBe(ADA.publicKey);
    const read = await pool.load(VAULT);
    await pool.save(VAULT, { notes: [{ ...claimed.coin }] }, read.readAt);
    expect((await pool.load(VAULT)).notes.map((n) => n.value)).toEqual([500n]);
    expect((await stores.pool.versions(VAULT)).map((v) => v.version), 'RED WHEN: the server did not file what the page sent').toEqual([1, 2]);

    const listed = await pageStore('pool', sendAs('ada')).versions(VAULT);
    expect(listed.map((v) => v.version)).toEqual([1, 2]);
    expect(listed[1]!.sealed, 'RED WHEN: the bytes read back are not the bytes filed').toEqual((await stores.pool.versions(VAULT))[1]!.sealed);
  });

  it('A VERSION ANOTHER WRITER FILED FIRST COMES BACK BY NAME, so the journal files the next one', async () => {
    const payments = new PaymentJournalInStore(pageStore('payment-journal', sendAs('ada')), VAULT, opener, signers);
    loseNext = 1;
    await payments.record(VAULT, { spent: { nonce: '01'.repeat(32), token: GBP, value: 9n }, amount: 1n, attemptedAt: 'x' });
    expect(loseNext).toBe(0);
    const store = pageStore('deposit-journal', sendAs('ada'));
    const before = (await store.versions(VAULT)).length;
    loseNext = 1;
    const journal = new DepositJournalInStore(store, VAULT, opener, signers, KEY);
    const claimed = await journal.claim(VAULT, { token: GBP, value: 700n }, 4, 'y');
    expect(claimed.coin.nonce).toBe(depositNonceAt(KEY, { token: GBP, value: 700n }, 4));
    expect((await store.versions(VAULT)).length, 'RED WHEN: a 409 is not VaultPoolVersionAlreadyFiled by name, so the claim is not retried at the version after the other writer\'s').toBe(before + 2);
    const direct = pageStore('deposit-journal', sendAs('ada'));
    const taken = sealPool(VAULT, { notes: [] }, await signers(), before + 1, 'deposit-journal');
    await expect(direct.put(VAULT, taken), 'RED WHEN: filing a taken version is anything but the named refusal')
      .rejects.toBeInstanceOf(VaultPoolVersionAlreadyFiled);
    await expect(direct.put(VAULT, sealPool(VAULT, { notes: [] }, await signers(), before + 5, 'deposit-journal')),
      'RED WHEN: a gap is filed, or reported as anything but a refusal').rejects.toThrow(/was not filed: the next version of this record is \d+, so nothing has been written/);
  });

  it('A FILING NOBODY SIGNED, OR SIGNED FOR ANOTHER RECORD, IS REFUSED BEFORE THE STORE IS ASKED', async () => {
    const before = (await stores.pool.versions(VAULT)).length;
    const rec = sealPool(VAULT, { notes: [] }, await signers(), before + 1);
    const at = `/api/vaults/${VAULT}/records/pool/${before + 1}`;
    const unsigned = await sendAs('ada')(at, { method: 'PUT', body: JSON.stringify(toWire('pool', rec)) });
    expect(unsigned.status, 'RED WHEN: anybody holding the signers\' public keys can file a record that opens').toBe(403);
    expect(String((unsigned.body as { error?: string }).error)).toMatch(/Sign the record with your signing key/);
    const forJournal = signFiling('deposit-journal', rec, ADA.secret);
    const moved = await sendAs('ada')(at, { method: 'PUT', body: JSON.stringify(toWire('pool', forJournal)) });
    expect(moved.status, 'RED WHEN: a signature over one record kind is accepted for another').toBe(403);
    const other = signFiling('pool', rec, ADA.secret);
    const tampered = { ...other, wrapped: [...other.wrapped, { ...other.wrapped[0]!, signerId: 'eve' }] };
    const changed = await sendAs('ada')(at, { method: 'PUT', body: JSON.stringify(toWire('pool', tampered)) });
    expect(changed.status, 'RED WHEN: a signed record can have a reader added after it was signed').toBe(403);
    expect((await stores.pool.versions(VAULT)).length).toBe(before);
  });

  it('A RECORD SIGNED BY A KEY THE ROSTER DOES NOT HOLD IS FILED BY THE SERVER AND NOT BELIEVED BY THE DEVICE', async () => {
    /* The server cannot open the roster, so it cannot tell whose key this is; the device can. */
    const bobsDevice = pageStore('nonce-secret', sendAs('ada'), BOB.secret);
    await bobsDevice.put(VAULT, sealPool(VAULT, { notes: [] }, await signers(), 1, 'nonce-secret'));
    expect((await stores['nonce-secret'].versions(VAULT))).toHaveLength(1);
    await expect(pageStore('nonce-secret', sendAs('ada')).get(VAULT),
      'RED WHEN: a well-formed record from a key that is not a signer\'s is believed').rejects.toThrow(/signed by a key the roster does not hold/);
    await expect(pageStore('nonce-secret', sendAs('ada')).versions(VAULT)).rejects.toThrow(/not believed/);
    const unsigned: WireSend = async () => ({ status: 200, body: { record: 'pool', filed: toWire('pool', sealPool(VAULT, { notes: [] }, await signers(), 1)) } });
    await expect(pageStore('pool', unsigned).get(VAULT), 'RED WHEN: an unsigned record a store hands back is believed')
      .rejects.toThrow(/carries no valid signature/);
  });

  it('A RECORD WHOSE SIGNATURE DOES NOT VERIFY IS NOT BELIEVED, whatever key it names', async () => {
    const signed = signFiling('pool', sealPool(VAULT, { notes: [] }, await signers(), 1), ADA.secret);
    const forged = { ...signed, filedBy: { publicKey: ADA.publicKey, signature: signed.filedBy!.signature.replace(/^./u, (c) => (c === '0' ? '1' : '0')) } };
    const store: WireSend = async () => ({ status: 200, body: { record: 'pool', filed: toWire('pool', forged) } });
    await expect(pageStore('pool', store).get(VAULT), 'RED WHEN: the device believes the key a record names without checking the signature')
      .rejects.toThrow(/carries no valid signature/);
    const moved = { ...signed, version: 1, sealed: sealPool(VAULT, { notes: [] }, await signers(), 1).sealed };
    const swapped: WireSend = async () => ({ status: 200, body: { record: 'pool', versions: [toWire('pool', moved)] } });
    await expect(pageStore('pool', swapped).versions(VAULT), 'RED WHEN: a signature is believed over a body it does not cover')
      .rejects.toThrow(/carries no valid signature/);
  });

  it('A VERSION FILED BY A SIGNER WHO HAS SINCE LEFT IS STILL THE VAULT\'S RECORD, and the others go on reading and writing', async () => {
    const vault = 'ef'.repeat(32);
    const kept = new MemorySealedPoolStore();
    const direct: WireSend = async (path, init) => {
      if (init.method === 'GET') {
        const one = path.match(/\/(\d+)$/u);
        if (one) { const r = await kept.at(vault, Number(one[1])); return { status: 200, body: { record: 'pool', version: Number(one[1]), filed: r && toWire('pool', r) } }; }
        if (path.endsWith('/versions')) return { status: 200, body: { record: 'pool', versions: (await kept.versions(vault)).map((v) => toWire('pool', v.sealed)) } };
        const r = await kept.get(vault);
        return { status: 200, body: { record: 'pool', filed: r && toWire('pool', r) } };
      }
      const w = JSON.parse(init.body!);
      await kept.put(vault, JSON.parse(w.body));
      return { status: 201, body: { filed: true, record: 'pool', version: w.version, digest: w.digest } };
    };
    const everOnTheRoster = async () => new Set([ADA.publicKey, BOB.publicKey]);
    const bos = new HttpSealedPoolStore('pool', direct, BOB.secret, everOnTheRoster);
    const adas = new HttpSealedPoolStore('pool', direct, ADA.secret, everOnTheRoster);
    const pool = (store: HttpSealedPoolStore) => new SealedNotePool(store, { signerId: 'ada', wrappingSecret: signer.secret }, signers);
    await pool(bos).create(vault, { notes: [] });
    /* Bo has left: the server refuses him from here on, and the roster no longer lists him. */
    const read = await pool(adas).load(vault);
    await expect(pool(adas).save(vault, { notes: [] }, read.readAt),
      'RED WHEN: one signer leaving stops every other signer reading and writing the vault\'s records').resolves.toBeUndefined();
    expect((await adas.versions(vault)).map((v) => v.sealed.filedBy?.publicKey)).toEqual([BOB.publicKey, ADA.publicKey]);
  });

  it('A JOURNAL PAST A MEGABYTE IS STILL FILED: a fifty-person payroll passes that in under two years', async () => {
    const store = pageStore('payment-journal', sendAs('ada'));
    const next = (await store.versions(VAULT)).length + 1;
    const attempts = Array.from({ length: 2_500 }, (_, i) => ({
      spent: { nonce: i.toString(16).padStart(64, '0'), token: GBP, value: 1_000_000n + BigInt(i) }, amount: 250_000n, attemptedAt: '2026-09-16T00:00:00.000Z',
    }));
    const big = sealPool(VAULT, { attempts } as never, await signers(), next, 'payment-journal');
    expect(JSON.stringify(big).length, 'the setup meant a record over a megabyte').toBeGreaterThan(1_048_576);
    await expect(store.put(VAULT, big), 'RED WHEN: the route refuses a journal once it passes the general body limit').resolves.toBeUndefined();
  });

  it('A STORE\'S DEFINITE REFUSAL IS ANSWERED AS ONE, not as a write that may have happened', async () => {
    const before = (await stores.pool.versions(VAULT)).length;
    refuseNext = 'the operator tools keep this vault\'s records in files';
    const refused = await pageStore('pool', sendAs('ada')).put(VAULT, sealPool(VAULT, { notes: [] }, await signers(), before + 1))
      .then(() => null, (e: unknown) => e as Error);
    expect(refused?.name, 'RED WHEN: a refusal that will not change is reported as not confirmed, so the device waits and tries again').toBe('VaultRecordRefused');
    expect(refused?.message).toMatch(/operator tools keep/);
    expect(refused?.message).not.toMatch(/not confirmed/);
  });

  it('REFUSES a person who is not signed in, a person the answer says may not, and a vault spelled another way', async () => {
    const nobody = await sendAs(null)(`/api/vaults/${VAULT}/records/pool`, { method: 'GET' });
    expect(nobody.status, 'RED WHEN: a vault\'s records are served to nobody').toBe(401);
    const stranger = await sendAs('bob')(`/api/vaults/${VAULT}/records/pool`, { method: 'GET' });
    expect(stranger.status, 'RED WHEN: the answer to who may read is not asked, or not obeyed').toBe(403);
    await expect(pageStore('pool', sendAs('bob')).get(VAULT)).rejects.toThrow(/403: this person may not read/);
    const filing = await sendAs('bob')(`/api/vaults/${VAULT}/records/pool/9`, {
      method: 'PUT', body: JSON.stringify(toWire('pool', signFiling('pool', sealPool(VAULT, { notes: [] }, await signers(), 9), BOB.secret))),
    });
    expect(filing.status, 'RED WHEN: a person who may not file can file').toBe(403);
    expect(asked.some((a) => a.person === 'bob' && a.act === 'file'), 'RED WHEN: filing is gated by the read answer').toBe(true);
    const upper = await sendAs('ada')(`/api/vaults/${VAULT.toUpperCase()}/records/pool`, { method: 'GET' });
    expect(upper.status, 'RED WHEN: a second spelling of a vault reaches a store').toBe(400);
    const theirs = await sendAs('ada')(`/api/vaults/${THEIRS}/records/pool`, { method: 'GET' });
    expect(theirs.status).toBe(403);
  });

  it('REFUSES a filing whose path, message and record disagree about the version, and files nothing', async () => {
    const before = (await stores.pool.versions(VAULT)).length;
    const rec = signFiling('pool', sealPool(VAULT, { notes: [] }, await signers(), before + 1), ADA.secret);
    const at = (v: number) => `/api/vaults/${VAULT}/records/pool/${v}`;
    const wrongPath = await sendAs('ada')(at(before + 2), { method: 'PUT', body: JSON.stringify(toWire('pool', rec)) });
    expect(wrongPath.status, 'RED WHEN: the version in the path is not checked against the message').toBe(400);
    const asJournal = await sendAs('ada')(at(before + 1), { method: 'PUT', body: JSON.stringify(toWire('deposit-journal', rec)) });
    expect(asJournal.status, 'RED WHEN: a journal is filed as the pool').toBe(400);
    expect((await stores.pool.versions(VAULT)).length).toBe(before);
  });

  it('A FILING SENT TWICE IS THE PAGE\'S OWN, NOT A LOST RACE: the page reads back that one version, and tries the read again before giving up', async () => {
    const store = pageStore('payment-journal', sendAs('ada'));
    const next = (await store.versions(VAULT)).length + 1;
    const rec = sealPool(VAULT, { notes: [] }, await signers(), next, 'payment-journal');
    let sends = 0;
    const reads: string[] = [];
    const twice: WireSend = async (path, init) => {
      if (init.method === 'PUT') { sends += 1; await sendAs('ada')(path, init); }
      else reads.push(path);
      return sendAs('ada')(path, init);
    };
    await expect(pageStore('payment-journal', twice).put(VAULT, rec),
      'RED WHEN: the device\'s own filing, answered 409 on a repeat, is reported as another writer\'s').resolves.toBeUndefined();
    expect(sends).toBe(1);
    expect(reads, 'RED WHEN: a lost race reads back every version rather than the one it lost').toEqual([`/api/vaults/${VAULT}/records/payment-journal/${next}`]);
    const other = sealPool(VAULT, { notes: [] }, await signers(), next, 'payment-journal');
    await expect(store.put(VAULT, other), 'RED WHEN: another writer\'s version is taken for this device\'s own')
      .rejects.toBeInstanceOf(VaultPoolVersionAlreadyFiled);
    let failures = 2;
    const flaky: WireSend = async (path, init) => {
      if (init.method === 'GET' && failures > 0) { failures -= 1; throw new Error('the read was cut off'); }
      return sendAs('ada')(path, init);
    };
    await expect(pageStore('payment-journal', flaky).put(VAULT, rec),
      'RED WHEN: a read-back that fails once is reported as not confirmed instead of being tried again').resolves.toBeUndefined();
    const blind: WireSend = async (path, init) => (init.method === 'PUT' ? sendAs('ada')(path, init) : { status: 502, body: {} });
    await expect(pageStore('payment-journal', blind).put(VAULT, sealPool(VAULT, { notes: [] }, await signers(), next, 'payment-journal')),
      'RED WHEN: a taken version whose owner cannot be read back is reported as settled either way').rejects.toThrow(/not confirmed filed/);
  });

  it('SERVES ONE VERSION, or null for a version not filed', async () => {
    const one = await sendAs('ada')(`/api/vaults/${VAULT}/records/pool/1`, { method: 'GET' });
    expect(one.status).toBe(200);
    expect((one.body as { version: number; filed: { version: number } }).filed.version).toBe(1);
    const none = await sendAs('ada')(`/api/vaults/${VAULT}/records/pool/999`, { method: 'GET' });
    expect((none.body as { filed: unknown }).filed, 'RED WHEN: a version not filed is served as something').toBeNull();
    const bad = await sendAs('ada')(`/api/vaults/${VAULT}/records/pool/0`, { method: 'GET' });
    expect(bad.status).toBe(400);
    const stranger = await sendAs('bob')(`/api/vaults/${VAULT}/records/pool/1`, { method: 'GET' });
    expect(stranger.status, 'RED WHEN: one version is served to a person who may not read').toBe(403);
  });

  it('A REPLY ABOUT ANOTHER VERSION IS NOT A FILING: the page says it is not confirmed', async () => {
    const liar: WireSend = async () => ({ status: 201, body: { filed: true, record: 'pool', version: 99, digest: 'x' } });
    await expect(pageStore('pool', liar).put(VAULT, sealPool(VAULT, { notes: [] }, await signers(), 1)),
      'RED WHEN: a 201 about another version is believed').rejects.toThrow(/not confirmed filed/);
    const cut: WireSend = async () => { throw new Error('connection reset'); };
    await expect(pageStore('pool', cut).put(VAULT, sealPool(VAULT, { notes: [] }, await signers(), 1)),
      'RED WHEN: a write whose answer never came is reported as not filed').rejects.toThrow(/It may have been filed/);
    const short: WireSend = async () => ({ status: 200, body: { record: 'pool', versions: [toWire('pool', signFiling('pool', sealPool(VAULT, { notes: [] }, await signers(), 2), ADA.secret))] } });
    await expect(pageStore('pool', short).versions(VAULT), 'RED WHEN: a list missing version 1 is believed')
      .rejects.toThrow(/not every version, in order/);
    const absent: WireSend = async () => ({ status: 404, body: { error: 'gone' } });
    await expect(pageStore('pool', absent).get(VAULT), 'RED WHEN: a failed read is answered as no record')
      .rejects.toThrow(/not a record holding nothing/);
  });

  it('the route cannot be built without an answer to who may touch which vault, and nothing in it can open a record', () => {
    expect(() => vaultRecordsRoutes({ records: { of: () => new MemorySealedPoolStore() } } as never),
      'RED WHEN: the route can be built open to every signed-in person').toThrow(/only with an answer to who may read and file/);
    const src = readFileSync(new URL('./vault-records-route.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src, 'RED WHEN: the server side imports anything that opens a sealed record').not.toMatch(/openPool|unwrapKey|unseal|wrappingSecret|SealedNotePool/);
  });

  it('the page\'s store cannot be made without a signing key to file with', () => {
    expect(() => new HttpSealedPoolStore('pool', sendAs('ada'), '' as Hex, roster), 'RED WHEN: a store that would file unsigned records can be built').toThrow(/no signing key/);
  });

  it('the page sends only to its own server, with its cookie and the person it was prepared for', async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await pageWireSend(() => 'ada', fake)('/api/vaults/x', { method: 'GET' });
    expect(r).toEqual({ status: 200, body: { ok: 1 } });
    expect(sent[0]!.init.credentials).toBe('same-origin');
    expect((sent[0]!.init.headers as Record<string, string>)['x-signed-in-as']).toBe('ada');
    await expect(pageWireSend(() => 'ada', fake)('https://elsewhere.example/api', { method: 'GET' }),
      'RED WHEN: a sealed record can be sent anywhere but this product\'s own server').rejects.toThrow(/nowhere else/);
  });
});
