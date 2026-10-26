import { describe, it, expect, vi } from 'vitest';
import { changeThresholdOnDevice, removeSignerOnDevice, seatsLeavingHere } from 'vaults-web-shared/governed-call-on-device.js';
import { anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import { companyKeyHere, rotateTheCompanyKeyHere, CompanyKeyBeingChanged } from 'vaults-web-shared/company-key-here.js';
import { judgeIn } from 'vaults-web-shared/vault-page-doors.js';
import { installErrorSink, type SinkPost, type SinkWindow } from 'vaults-web-shared/error-sink.js';
import { recordsKeypairFrom } from '../midnight/company-nonce-secret.js';
import { fromHex, type Hex } from '../core/crypto.js';
import { purposeKey, type Purpose } from '../core/sealed-records.js';
import { companyRecordKey, FILING_REFUSAL } from '../midnight/seat-directory.js';
import { COMPANY_RECORD_KINDS } from '../midnight/sealed-record-wire.js';
import type { RecordsAsked } from '../midnight/records-held.js';
import type { ManifestEntryBody } from '../midnight/record-manifest.js';
import { aRecordFiledBy, headersAsked, peopleRecords, wire } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, anchorDoorsOf, aPolicyFiledBy, ADA, BO, CO, companyKeyDoorsOf, CY, deviceOf, directoryOf, events, KEY,
  policyReadBy, recordsReadBy, recordsSecretOf, seatsOnTheChain, sentToTheChain, store, walletOf, type Seat,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

/**
 * A signer is removed from the signers' own devices and the company's key is changed on the device of a signer who
 * stays, traced from the raise through the directory and the anchor. The signer who left can neither seal nor open
 * anything after the change, and every signer who stays reads the company under the new key and the older ones. The
 * second half reads every request the devices sent in that trace, every order their anchors handed to the anchor stand-in
 * chain, what the service holds, and every error text, for any key of the company.
 *
 * Every request goes to the service through one `fetch`, which is recorded here before the company is set up.
 */

type Seen = { readonly url: string; readonly headers: string; readonly body: string };
const seen: Seen[] = [];
const realFetch = globalThis.fetch;
vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
  seen.push({ url: String(input), headers: JSON.stringify(Object.fromEntries(new Headers(init?.headers).entries())), body: init?.body === undefined ? '' : String(init.body) });
  return realFetch(input, init);
});

aCompanyWhoseSignersChange();

const EVERY_POLICY: RecordsAsked = { kinds: [{ store: 'company', kind: 'spending-policy' }] };
const EVERY_KIND: RecordsAsked = { kinds: COMPANY_RECORD_KINDS.map((kind) => ({ store: 'company' as const, kind })), everyPending: true };
const PURPOSES: readonly Purpose[] = ['roster', 'policy', 'payroll', 'inbox', 'proposals'];
const STAYING: readonly Seat[] = [ADA, BO];

/** Every error text and refusal the devices produced in the trace, as written. */
const said: string[] = [];
const sayOf = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : JSON.stringify(e));

const forHex = (hex: string): string[] => {
  const h = hex.toLowerCase().replace(/^0x/u, '');
  return [h, Buffer.from(h, 'hex').toString('base64')];
};
/** A body's `tx` is the order a device handed its builder, in base64: its text is read too. */
const readable = (text: string): string[] => {
  const out = [text];
  for (const m of text.matchAll(/"tx":"([A-Za-z0-9+/=]{16,})"/gu)) out.push(Buffer.from(m[1]!, 'base64').toString('utf8'));
  return out;
};
/** The names of the secrets that appear in any of `texts`, in hex or base64. */
const foundIn = (texts: readonly string[], secrets: ReadonlyMap<string, string>): string[] => {
  const all = texts.flatMap(readable).map((t) => t.toLowerCase());
  return [...secrets].filter(([, v]) => v.length >= 32 && forHex(v).some((f) => all.some((t) => t.includes(f.toLowerCase())))).map(([n]) => n);
};

describe('A SIGNER REMOVED AND THE COMPANY\'S KEY CHANGED, TRACED FROM THE SIGNERS\' DEVICES THROUGH THE DIRECTORY AND THE ANCHOR', () => {
  it('CY IS RETIRED AND TAKEN OFF THE CHAIN, BO\'S DEVICE CHANGES THE KEY AND ANCHORS IT, CY SEALS AND OPENS NOTHING AFTER IT, AND ADA AND BO READ, RAISE AND APPROVE UNDER THE NEW KEY', async () => {
    await CY.entered.enter([await aRecordFiledBy(CY, 'pol_filed_by_cy')]);
    expect((await anchorTheRecordsHere(anchorDoorsOf(CY))).anchored).toBeGreaterThan(0);
    expect(await aPolicyFiledBy(CY, [ADA, BO, CY])).toBe(1);
    events.length = 0;
    const remove = { viewingKey: KEY, leaf: CY.seat, name: 'cy' };

    expect(await removeSignerOnDevice(deviceOf(ADA, { changesTheKey: true }), remove)).toMatchObject({ state: 'waiting-for-approvals' });
    const carried = await removeSignerOnDevice(deviceOf(BO, { changesTheKey: true }), remove);
    /* RED WHEN: the device that finishes a removal does not change the company's key, or files the change of the key before the retirement is anchored. */
    expect(carried).toMatchObject({ state: 'done', rotation: { state: 'rotated', epoch: 1, version: 7 } });
    expect(events).toEqual([
      'anchored', 'chain propose', 'chain approve', 'directory 6 retire', 'anchored', `chain amendSigner removing ${CY.seat}`,
      'directory 7 rotate', 'anchored',
    ]);
    expect(seatsOnTheChain()).toEqual([ADA.seat, BO.seat]);

    for (const s of STAYING) {
      const here = await directoryOf(s)();
      expect(here.dir.seats.find((x) => x.seat === CY.seat)!.retiredAt, s.person).toBe(6);
      /* RED WHEN: a change of the key filed after a retirement is not anchored with the company's records, so a device would not believe it. */
      expect(here.dir.rotations?.map((r) => [r.version, r.epoch]), s.person).toEqual([[7, 1]]);
      expect(here.records.directory.has(7), s.person).toBe(true);
    }

    /* RED WHEN: the change of the key is wrapped to the signer who left, so they would open the new key. */
    const rotation = store.directoryFilingsOf(CO).at(-1)!;
    expect(rotation.change.kind).toBe('rotate');
    expect((rotation.change as unknown as { wraps: Array<{ seat: string }> }).wraps.map((w) => w.seat).sort()).toEqual([ADA.seat, BO.seat].sort());

    /* The signer who left. */
    const leaving = companyKeyDoorsOf(CY);
    const theirs = await companyKeyHere({ ...leaving, accountId: CO, material: { signingSecret: CY.signingSecret }, records: deviceOf(CY).records! });
    /* RED WHEN: the signer who left holds the new key, or is let to seal a record under the key in force. */
    expect(theirs.epoch).toBe(0);
    expect(theirs.newest).toBe(1);
    expect(theirs.notSealing).not.toBeNull();
    try { theirs.sealing(); expect.unreachable(); } catch (e) { expect(e).toBeInstanceOf(CompanyKeyBeingChanged); said.push(sayOf(e)); }
    try { theirs.keyAt(1); expect.unreachable(); } catch (e) { expect(String(e)).toMatch(/holds no key of the company at epoch 1/u); said.push(sayOf(e)); }
    const again = await rotateTheCompanyKeyHere({
      ...leaving, accountId: CO, material: { signingSecret: CY.signingSecret }, records: deviceOf(CY).records!, leaving: async () => new Set<string>(),
    });
    expect(again).toMatchObject({ state: 'not-this-seat' });
    said.push(JSON.stringify(again));

    /* Every kind of record the signer who left files after the change: the service refuses to enter it, and a device that was handed it anyway refuses it. */
    const filer = CY.statement.signingKey as Hex;
    const here = await directoryOf(BO)(EVERY_KIND);
    const handedOver: ManifestEntryBody[] = [];
    for (const kind of COMPANY_RECORD_KINDS) {
      const entry = await aRecordFiledBy(CY, `late_${kind}`, kind);
      /* RED WHEN: the service enters a record of any kind that a signer filed after they were taken off the chain. */
      const refused = await CY.entered.enter([entry]).catch((e: unknown) => e);
      expect(String((refused as Error).cause ?? refused), kind).toMatch(/seat the company's account no longer holds/u);
      said.push(sayOf(refused));
      handedOver.push(entry);
    }
    const handed = { ...here, records: { ...here.records, notYetAnchored: handedOver.map((e) => ({ ...e, filedBy: { publicKey: filer, signature: '' } })) as never } };
    for (const entry of handedOver) {
      const why = judgeIn(handed)(filer, entry.kind as never, companyRecordKey(entry.kind as never, entry.id), { store: 'company', kind: entry.kind, id: entry.id, digest: entry.digest, version: 1 }, true);
      /* RED WHEN: a device believes a record of any kind filed by a signer who left, after they left. */
      expect(why, entry.kind).toBe(FILING_REFUSAL['past-its-boundary']);
      said.push(why!);
    }
    expect(handedOver.map((e) => e.kind)).toEqual([...COMPANY_RECORD_KINDS]);

    /* The signers who stay. */
    const staying = new Map<string, Awaited<ReturnType<typeof companyKeyHere>>>();
    for (const s of STAYING) {
      const doors = { ...companyKeyDoorsOf(s), accountId: CO, material: { signingSecret: s.signingSecret }, records: deviceOf(s).records! };
      const keys = await companyKeyHere(doors);
      staying.set(s.person, keys);
      /* RED WHEN: a signer who stays does not hold the new key, or cannot lead back from it to the key the company began with. */
      expect([keys.epoch, keys.newest, keys.notSealing], s.person).toEqual([1, 1, null]);
      expect(keys.keyAt(0), s.person).toBe(KEY);
      expect(keys.seeds.map((x) => x.epoch), s.person).toEqual([1]);
      expect(await seatsLeavingHere(deviceOf(s), keys)).toEqual(new Set());
    }
    expect(staying.get('ada')!.key).toBe(staying.get('bo')!.key);
    expect(staying.get('ada')!.key).not.toBe(KEY);

    for (const s of STAYING) {
      const keys = staying.get(s.person)!;
      /* RED WHEN: a record the company holds from before the change no longer opens on a signer who stays. */
      expect((await recordsReadBy(s, EVERY_POLICY)).records.stopped, s.person).toBeNull();
      expect(await policyReadBy(s, keys).catch((e: unknown) => e), s.person).toMatchObject({ state: 'set', version: 1 });
    }

    /* A policy filed after the change opens on the other signer who stays. It is filed by the test support, so which seats it is sealed to and at which epoch are chosen here, and are pinned where the product's own filer is driven. */
    expect(await aPolicyFiledBy(BO, [ADA, BO])).toBe(2);
    expect((await anchorTheRecordsHere(anchorDoorsOf(BO))).anchored).toBeGreaterThan(0);
    /* RED WHEN: a policy filed after the change of the key and sealed to the seats that stay does not open on a signer who stays. */
    expect(await policyReadBy(ADA, staying.get('ada')!).catch((e: unknown) => e)).toMatchObject({ state: 'set', version: 2 });

    /* A proposal raised under the new key by one signer who stays is approved by the other. */
    expect((await changeThresholdOnDevice(deviceOf(ADA), { viewingKey: staying.get('ada')!, newThreshold: 2, seated: 2 })).state).toBe('done');
    expect(store.listProposals(CO).at(-1)!.keyEpoch).toBe(1);
    const raised = await changeThresholdOnDevice(deviceOf(BO), { viewingKey: staying.get('bo')!, newThreshold: 1, seated: 2 });
    expect(raised.state).toBe('waiting-for-approvals');
    const proposal = store.listProposals(CO).at(-1)!;
    /* RED WHEN: a proposal raised after the change of the key is sealed under the key the company began with. */
    expect(proposal.keyEpoch).toBe(1);
    /* RED WHEN: a signer who stays cannot open and approve a proposal the other raised under the new key, so the change is never carried. */
    expect(await changeThresholdOnDevice(deviceOf(ADA), { viewingKey: staying.get('ada')!, newThreshold: 1, seated: 2 })).toMatchObject({ state: 'done' });
    expect(store.getProposal(proposal.id)!.status).toBe('executed');
  }, 170_000);

  it('NO ADDRESS, HEADER, BODY OR ORDER THE DEVICES SENT, NOTHING THE SERVICE HOLDS AND NO ERROR TEXT CARRIES A KEY OF THE COMPANY AT ANY EPOCH, A KEY MADE FROM IT, THE INBOX SECRET OR A SECRET A WALLET HOLDS', async () => {
    const keys = await companyKeyHere({ ...companyKeyDoorsOf(ADA), accountId: CO, material: { signingSecret: ADA.signingSecret }, records: deviceOf(ADA).records! });
    const companyKeys = [0, 1].map((e) => [e, keys.keyAt(e)] as const);
    const secrets = new Map<string, string>();
    for (const [e, k] of companyKeys) {
      secrets.set(`the company's key at epoch ${e}`, k);
      for (const p of PURPOSES) secrets.set(`the ${p} key made from the key at epoch ${e}`, purposeKey(k, CO, p));
    }
    for (const x of keys.seeds) secrets.set(`the payout seed at epoch ${x.epoch}`, String(x.seed));
    for (const s of [ADA, BO, CY]) {
      const w = walletOf(s);
      secrets.set(`${s.person}'s wallet key`, w.companyKey);
      secrets.set(`${s.person}'s records secret`, recordsSecretOf(s));
      secrets.set(`${s.person}'s records key secret`, recordsKeypairFrom(fromHex(w.companyKey)).secret);
      secrets.set(`${s.person}'s signing secret`, s.signingSecret);
    }
    expect(secrets.size).toBeGreaterThan(20);
    /* RED WHEN: a secret comes back empty or short, so the scan would skip it and pass for a key it never looked for. */
    for (const [name, value] of secrets) expect(value, name).toMatch(/^[0-9a-f]{32,}$/iu);

    expect(seen.length).toBeGreaterThanOrEqual(wire.length);
    expect(wire.length).toBeGreaterThan(20);
    expect(sentToTheChain.length).toBeGreaterThan(0);
    const held = [
      JSON.stringify(store.snapshot()),
      ...[...((peopleRecords as unknown as { filed: Map<string, unknown[]> }).filed).values()].map((v) => JSON.stringify(v)),
    ];
    expect(held.join('').length).toBeGreaterThan(1000);

    /* RED WHEN: a device sends the service the company's key at any epoch, a key made from it, the inbox secret or a secret its wallet holds, in an address, a header or a body, or in the order it hands its builder. */
    expect(foundIn([...seen.flatMap((s) => [s.url, s.headers, s.body]), ...wire], secrets), 'a request').toEqual([]);
    expect(foundIn(sentToTheChain, secrets), 'an order handed to the anchor stand-in').toEqual([]);
    /* RED WHEN: the service is left holding a key of the company in the clear, whatever request put it there. */
    expect(foundIn(held, secrets), 'what the service holds').toEqual([]);
    /* RED WHEN: a device asks a request to carry a header the transport here does not send, or a key in one. */
    expect(headersAsked).toEqual([]);
    expect(foundIn(headersAsked.map((h) => h.headers), secrets), 'a header asked for').toEqual([]);

    /* RED WHEN: an error text a device reports carries a key of the company. */
    expect(said.length).toBeGreaterThan(5);
    expect(foundIn(said, secrets), 'an error text').toEqual([]);
    const posted: SinkPost[] = [];
    const window: SinkWindow = {
      addEventListener: () => undefined, fetch: async () => ({ ok: true }), location: { href: 'https://payroll.example/company' },
      setTimeout: (fn: () => void) => { fn(); return 0; }, console: { error: () => undefined, warn: () => undefined },
    };
    installErrorSink(window, (b) => posted.push(b));
    for (const t of said) window.console.error(t);
    expect(posted.length).toBeGreaterThan(0);
    expect(foundIn(posted.flatMap((p) => p.entries.map((e) => e.message)), secrets), 'what the error sink sends').toEqual([]);
    /* RED WHEN: the error sink sends a key that an error text carried, unredacted. */
    posted.length = 0;
    window.console.error(`boom ${keys.key}`);
    expect(posted.flatMap((p) => p.entries.map((e) => e.message)).join('')).not.toContain(keys.key);
    expect(posted.length).toBe(1);
  });

  it('THE SCAN FINDS A KEY IN HEX, IN BASE64 AND IN AN ORDER\'S TEXT', () => {
    const k = 'ab'.repeat(32);
    const secrets = new Map([['k', k]]);
    /* RED WHEN: the scan stops reading hex, base64 or the text inside an order, so a key sent in one of them would pass. */
    expect(foundIn([`/x?q=${k}`], secrets)).toEqual(['k']);
    expect(foundIn([JSON.stringify({ h: Buffer.from(k, 'hex').toString('base64') })], secrets)).toEqual(['k']);
    expect(foundIn([JSON.stringify({ tx: Buffer.from(JSON.stringify({ order: { k } })).toString('base64') })], secrets)).toEqual(['k']);
    expect(foundIn([JSON.stringify({ tx: Buffer.from(JSON.stringify({ order: { k: 'cd'.repeat(32) } })).toString('base64') })], secrets)).toEqual([]);
  });
});
