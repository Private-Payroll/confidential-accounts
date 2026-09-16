/**
 * **THE PAGE'S STORE AND THE SERVER'S ROUTE, TALKING OVER REAL HTTP.** The
 * route is mounted in a throwaway app behind a stand-in for the sign-in, and
 * the page's store is the one the page uses. The pool and both journals run
 * over it unchanged: a lost race is retried by name, a deposit claim files the
 * version its nonce is derived from, and nothing on the server can open what
 * it keeps.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { vaultRecordsRoutes, type MayTouchVaultRecords } from './vault-records-route.js';
import { HttpSealedPoolStore, pageWireSend, type WireSend } from '../web/http-sealed-pool-store.js';
import {
  MemorySealedPoolStore, SealedNotePool, sealPool, VaultPoolVersionAlreadyFiled, type SealedPoolStore,
} from '../midnight/vault-pool.js';
import { DepositJournalInStore, PaymentJournalInStore } from '../midnight/vault-journal.js';
import { depositNonceAt, depositNonceKeyFor } from '../midnight/deposit-nonce.js';
import { toWire, type WireRecord } from '../midnight/sealed-record-wire.js';
import { newWrappingKeypair } from '../core/crypto.js';

const VAULT = 'ab'.repeat(32);
const THEIRS = 'cd'.repeat(32);
const GBP = 'aa'.repeat(32);
const KEY = depositNonceKeyFor(new Uint8Array(32).fill(5), VAULT);

let base = '';
let server: ReturnType<express.Express['listen']>;
let stores: Record<WireRecord, MemorySealedPoolStore>;
let loseNext = 0;
const asked: Array<{ person: string; vault: string; record: WireRecord; act: string }> = [];

const mayTouch: MayTouchVaultRecords = async (person, vault, record, act) => {
  asked.push({ person, vault, record, act });
  return person === 'ada' && vault === VAULT;
};

beforeAll(async () => {
  stores = { pool: new MemorySealedPoolStore(), 'deposit-journal': new MemorySealedPoolStore(), 'payment-journal': new MemorySealedPoolStore() };
  const racy = (inner: MemorySealedPoolStore): SealedPoolStore => ({
    get: (v) => inner.get(v),
    versions: (v) => inner.versions(v),
    put: async (v, rec) => {
      if (loseNext > 0) { loseNext -= 1; throw new VaultPoolVersionAlreadyFiled(v, rec.version); }
      return inner.put(v, rec);
    },
  });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  /* The stand-in for the sign-in: the person is whoever the header names, and nobody without it. */
  app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') req.userId = p; next(); });
  app.use(vaultRecordsRoutes({ records: { of: (r) => racy(stores[r]) }, mayTouch }));
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
  it('A POOL AND BOTH JOURNALS RUN OVER IT UNCHANGED, and the deposit\'s nonce is the one of the version the server filed', async () => {
    const pool = new SealedNotePool(new HttpSealedPoolStore('pool', sendAs('ada')), { signerId: 'ada', wrappingSecret: signer.secret }, signers);
    await pool.create(VAULT, { notes: [] });
    const journal = new DepositJournalInStore(new HttpSealedPoolStore('deposit-journal', sendAs('ada')), VAULT, opener, signers, KEY);
    const claimed = await journal.claim(VAULT, { token: GBP, value: 500n }, 't');
    expect(claimed.coin.nonce, 'RED WHEN: the nonce is not derived from the version the server filed')
      .toBe(depositNonceAt(KEY, { token: GBP, value: 500n }, 1));
    const read = await pool.load(VAULT);
    await pool.save(VAULT, { notes: [{ ...claimed.coin }] }, read.readAt);
    expect((await pool.load(VAULT)).notes.map((n) => n.value)).toEqual([500n]);
    expect((await stores.pool.versions(VAULT)).map((v) => v.version), 'RED WHEN: the server did not file what the page sent').toEqual([1, 2]);

    const listed = await new HttpSealedPoolStore('pool', sendAs('ada')).versions(VAULT);
    expect(listed.map((v) => v.version)).toEqual([1, 2]);
    expect(listed[1]!.sealed, 'RED WHEN: the bytes read back are not the bytes filed').toEqual((await stores.pool.versions(VAULT))[1]!.sealed);
  });

  it('A VERSION ANOTHER WRITER FILED FIRST COMES BACK BY NAME, so the journal files the next one and derives its nonce from THAT', async () => {
    const payments = new PaymentJournalInStore(new HttpSealedPoolStore('payment-journal', sendAs('ada')), VAULT, opener, signers);
    loseNext = 1;
    await payments.record(VAULT, { spent: { nonce: '01'.repeat(32), token: GBP, value: 9n }, amount: 1n, attemptedAt: 'x' });
    expect(loseNext).toBe(0);
    const store = new HttpSealedPoolStore('deposit-journal', sendAs('ada'));
    const before = (await store.versions(VAULT)).length;
    loseNext = 1;
    const journal = new DepositJournalInStore(store, VAULT, opener, signers, KEY);
    const claimed = await journal.claim(VAULT, { token: GBP, value: 700n }, 'y');
    expect(
      claimed.coin.nonce,
      'RED WHEN: a 409 is not VaultPoolVersionAlreadyFiled by name, or the retry keeps the nonce of the version it lost',
    ).toBe(depositNonceAt(KEY, { token: GBP, value: 700n }, before + 1));
    const direct = new HttpSealedPoolStore('deposit-journal', sendAs('ada'));
    const taken = sealPool(VAULT, { notes: [] }, await signers(), before + 1);
    await expect(direct.put(VAULT, taken), 'RED WHEN: filing a taken version is anything but the named refusal')
      .rejects.toBeInstanceOf(VaultPoolVersionAlreadyFiled);
    await expect(direct.put(VAULT, sealPool(VAULT, { notes: [] }, await signers(), before + 5)),
      'RED WHEN: a gap is filed, or reported as anything but a refusal').rejects.toThrow(/was not filed: the next version of this record is \d+, so nothing has been written/);
  });

  it('REFUSES a person who is not signed in, a person the answer says may not, and a vault spelled another way', async () => {
    const nobody = await sendAs(null)(`/api/vaults/${VAULT}/records/pool`, { method: 'GET' });
    expect(nobody.status, 'RED WHEN: a vault\'s records are served to nobody').toBe(401);
    const stranger = await sendAs('bob')(`/api/vaults/${VAULT}/records/pool`, { method: 'GET' });
    expect(stranger.status, 'RED WHEN: the answer to who may read is not asked, or not obeyed').toBe(403);
    await expect(new HttpSealedPoolStore('pool', sendAs('bob')).get(VAULT)).rejects.toThrow(/403: this person may not read/);
    const filing = await sendAs('bob')(`/api/vaults/${VAULT}/records/pool/9`, {
      method: 'PUT', body: JSON.stringify(toWire('pool', sealPool(VAULT, { notes: [] }, await signers(), 9))),
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
    const rec = sealPool(VAULT, { notes: [] }, await signers(), before + 1);
    const at = (v: number) => `/api/vaults/${VAULT}/records/pool/${v}`;
    const wrongPath = await sendAs('ada')(at(before + 2), { method: 'PUT', body: JSON.stringify(toWire('pool', rec)) });
    expect(wrongPath.status, 'RED WHEN: the version in the path is not checked against the message').toBe(400);
    const asJournal = await sendAs('ada')(at(before + 1), { method: 'PUT', body: JSON.stringify(toWire('deposit-journal', rec)) });
    expect(asJournal.status, 'RED WHEN: a journal is filed as the pool').toBe(400);
    expect((await stores.pool.versions(VAULT)).length).toBe(before);
  });

  it('A FILING SENT TWICE IS THE PAGE\'S OWN, NOT A LOST RACE: the second answer is a 409, and the page reads back whose version it is', async () => {
    const store = new HttpSealedPoolStore('payment-journal', sendAs('ada'));
    const next = (await store.versions(VAULT)).length + 1;
    const rec = sealPool(VAULT, { notes: [] }, await signers(), next);
    let sends = 0;
    const twice: WireSend = async (path, init) => {
      if (init.method === 'PUT') { sends += 1; await sendAs('ada')(path, init); }
      return sendAs('ada')(path, init);
    };
    await expect(new HttpSealedPoolStore('payment-journal', twice).put(VAULT, rec),
      'RED WHEN: the device\'s own filing, answered 409 on a repeat, is reported as another writer\'s').resolves.toBeUndefined();
    expect(sends).toBe(1);
    const other = sealPool(VAULT, { notes: [] }, await signers(), next);
    await expect(store.put(VAULT, other), 'RED WHEN: another writer\'s version is taken for this device\'s own')
      .rejects.toBeInstanceOf(VaultPoolVersionAlreadyFiled);
    const blind: WireSend = async (path, init) => (init.method === 'PUT' ? sendAs('ada')(path, init) : { status: 502, body: {} });
    await expect(new HttpSealedPoolStore('payment-journal', blind).put(VAULT, sealPool(VAULT, { notes: [] }, await signers(), next)),
      'RED WHEN: a taken version whose owner cannot be read back is reported as settled either way').rejects.toThrow(/not confirmed filed/);
  });

  it('A REPLY ABOUT ANOTHER VERSION IS NOT A FILING: the page says it is not confirmed', async () => {
    const liar: WireSend = async () => ({ status: 201, body: { filed: true, record: 'pool', version: 99, digest: 'x' } });
    await expect(new HttpSealedPoolStore('pool', liar).put(VAULT, sealPool(VAULT, { notes: [] }, await signers(), 1)),
      'RED WHEN: a 201 about another version is believed').rejects.toThrow(/not confirmed filed/);
    const cut: WireSend = async () => { throw new Error('connection reset'); };
    await expect(new HttpSealedPoolStore('pool', cut).put(VAULT, sealPool(VAULT, { notes: [] }, await signers(), 1)),
      'RED WHEN: a write whose answer never came is reported as not filed').rejects.toThrow(/It may have been filed/);
    const short: WireSend = async () => ({ status: 200, body: { record: 'pool', versions: [toWire('pool', sealPool(VAULT, { notes: [] }, await signers(), 2))] } });
    await expect(new HttpSealedPoolStore('pool', short).versions(VAULT), 'RED WHEN: a list missing version 1 is believed')
      .rejects.toThrow(/not every version, in order/);
    const absent: WireSend = async () => ({ status: 404, body: { error: 'gone' } });
    await expect(new HttpSealedPoolStore('pool', absent).get(VAULT), 'RED WHEN: a failed read is answered as no record')
      .rejects.toThrow(/not a record holding nothing/);
  });

  it('the route cannot be built without an answer to who may touch which vault, and nothing in it can open a record', () => {
    expect(() => vaultRecordsRoutes({ records: { of: () => new MemorySealedPoolStore() } } as never),
      'RED WHEN: the route can be built open to every signed-in person').toThrow(/only with an answer to who may read and file/);
    const src = readFileSync(new URL('./vault-records-route.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src, 'RED WHEN: the server side imports anything that opens a sealed record').not.toMatch(/openPool|unwrapKey|unseal|wrappingSecret|SealedNotePool/);
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
