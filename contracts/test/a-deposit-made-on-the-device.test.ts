/**
 * **A DEPOSIT'S RECORD MADE ON THE DEVICE, FILED THROUGH THE MOUNTED ROUTE, AND
 * THE VAULT REBUILT FROM THE COMPANY'S SECRET AND ITS OWN AMOUNTS, WITH A NOTE
 * THAT COMES BACK SPENT.**
 *
 * Three signers, each with their own recovery words. Every record is made on a
 * signer's device and filed, signed, through the server's own mount of the
 * records route, which decides who may file from the vault's pinned account.
 * The vault is the real compiled contract, run in process; the device builds
 * each call itself.
 *
 *   · Ada starts the vault's nonce secret, wrapped to Ada and Bo.
 *   · Ada and Bo both deposit; one of Ada's attempts is abandoned; payments leave
 *     a change, and a change of a change.
 *   · Bo leaves: a new epoch, wrapped to Ada. Carol joins and is given it.
 *   · Ada deposits under the new epoch.
 *   · The pool and both journals are thrown away. What is left is the chain,
 *     the company's own amounts, and the filed versions of the nonce secret.
 *   · **Carol, who deposited nothing and joined last, rebuilds the vault from
 *     her own words**, and a rebuilt note is spent.
 *   · Bo, from his words, names what was made before he left and nothing after.
 *
 * **WHAT THIS DOES NOT SHOW**: where the nonce secret's filed versions survive
 * this product. Here they are handed to the rebuild as the bytes the server
 * filed. The spend uses index 0, because the simulator keeps no commitment
 * tree. Nothing here reaches a real chain, a real indexer or a browser.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { identityFromWords, newWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import {
  Contract as Vault, ledger as vaultLedger, pureCircuits as vaultCircuits,
} from '../managed-vault/contract/index.js';
import { pureCircuits } from '../managed/contract/index.js';
import { AccountSimulator, privateStateFor, change, type Change } from './simulator.js';
import { buildPayoutTree, type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { changeCoinOf } from '../../src/midnight/vault-coins.js';
import {
  reconcileVaultPool, commitmentForNote, changeNonceOf, describeRecovery,
} from '../../src/midnight/vault-recovery.js';
import { smallestNoteCovering, type Note } from '../../src/midnight/vault-notes.js';
import { type NoteEvents, type ServedEvent, type VaultTransactions } from '../../src/midnight/note-index.js';
import {
  MemorySealedPoolStore, SealedNotePool, type FiledPoolVersion, type PoolSigner,
} from '../../src/midnight/vault-pool.js';
import { PaymentJournalInStore } from '../../src/midnight/vault-journal.js';
import { vaultOutputHistoryFrom } from '../../src/midnight/deposit-nonce.js';
import {
  walkCompanyRecords, compiledOutputCommitment, type CompanyRecords,
} from '../../src/midnight/rebuild-from-records.js';
import {
  openNewestNonceSecrets, depositNonceKeysOf, rotateNonceSecret, admitToNonceSecret, recordsKeypairFrom,
} from '../../src/midnight/company-nonce-secret.js';
import type { WireRecord } from '../../src/midnight/sealed-record-wire.js';
import { HttpSealedPoolStore, type WireSend } from '../../src/web/http-sealed-pool-store.js';
import {
  depositCoinOnThisDevice, startVaultNonceSecretOnThisDevice, recordsReaderOf, type DeviceSigner,
} from '../../src/web/deposit-on-device.js';
import { mountVaultRecords, vaultAccountFromTheIndexer, type CompanyRoster } from '../../src/server/vault-records-authority.js';
import { UNLOCK_PURPOSE, UNLOCK_WINDOW_MS, unlockAsk } from '../../src/core/wallet-unlock.js';
import {
  toHex, fromHex, newWrappingKeypair, newSigningKeypair, type Hex,
} from '../../src/core/crypto.js';

const VAULT_NOW = 1_800_000_000;
const WIN_FROM = BigInt(VAULT_NOW - 3_600);
const WIN_UNTIL = BigInt(VAULT_NOW + 3_600);
const BLOCK = '0'.repeat(64);
const bytes = (n: number) => new Uint8Array(32).fill(n);
const A = privateStateFor(1);
const B = privateStateFor(2);
const GBP = bytes(0x9b);
const PAYEE = bytes(0x0a);
const NO_INDEX_YET = 0n;
const RECORDS: readonly WireRecord[] = ['pool', 'deposit-journal', 'payment-journal', 'nonce-secret'];

/** The key a person's wallet releases for the company, from their words alone, through the wallet's own code. */
const releasedCompanyKey = (words: string, company: string): Uint8Array => {
  const ask = parseAsk(unlockAsk({
    name: 'Confidential Accounts',
    rdns: 'social.lemonade.confidential-accounts',
    purpose: UNLOCK_PURPOSE,
    nonce: 'derivation-has-no-conversation',
    expiresAt: 0 + UNLOCK_WINDOW_MS,
    company,
  }), 'https://payroll.example', 0);
  if (ask.kind !== 'unlock') throw new Error(`built a ${ask.kind}, not an unlock`);
  return unlockKeyFor(identityFromWords(words), ask);
};

interface VaultPrivate { notes: Note[] }

const vaultWitnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }, token: Uint8Array, amount: bigint) => {
    const n = smallestNoteCovering(ctx.privateState.notes, toHex(token), amount);
    if (n === undefined) throw new Error(`the device's pool has no note covering ${amount}`);
    return [ctx.privateState, {
      nonce: fromHex(n.nonce), color: fromHex(n.token), value: n.value, mt_index: n.index ?? NO_INDEX_YET,
    }];
  },
};

describe('a deposit whose record is made on the device', () => {
  let sim: AccountSimulator;
  let vault: Vault<VaultPrivate>;
  let vaultAddr: Hex;
  let vaultState: any;
  let priv: VaultPrivate;
  let company: string;
  let chainLog: Array<{ hash: Hex; made: { nonce: Hex; token: Hex; value: bigint } | undefined; index: bigint }>;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let serverStores: Map<WireRecord, MemorySealedPoolStore>;
  let members: string[];
  /** Every request body any device sent, exactly as sent. */
  let sent: string[];
  let bodyReadBeforeSignIn: boolean;

  const provider = () => ({
    getContractState: async (_b: string, address: unknown) =>
      String(address) === String(sim.address) ? (sim.contractStateForCall as never) : undefined,
  });
  const ctx = (circuit: string) => createCircuitContext<VaultPrivate>(
    circuit, vaultAddr as never, BLOCK, vaultState, priv,
    provider() as never, undefined, undefined, VAULT_NOW, BLOCK);
  const charged = () => (vaultState?.constructor?.name === 'ContractState' ? vaultState.data : vaultState);
  const chainNotes = (): Hex[] => [...vaultLedger(charged() as never).notes].map((c: Uint8Array) => toHex(c));
  const held = (coin: { nonce: Hex; token: Hex; value: bigint }) => commitmentForNote(vaultCircuits, vaultAddr, coin);
  const logCall = (r: { context: { callContext: { currentZswapLocalState: unknown } } }) => {
    const hash = (chainLog.length + 1).toString(16).padStart(64, '0') as Hex;
    chainLog.push({ hash, made: changeCoinOf(r.context.callContext.currentZswapLocalState, vaultAddr), index: BigInt(100 + chainLog.length) });
  };
  /* The ledger's commitment of an output, from the compiled contract's runtime: what its circuits claim and the ledger checks. */
  const outputCommitment = (coin: { nonce: Hex; token: Hex; value: bigint }): string => toHex((vault as any)._coinCommitment_0(
    { nonce: fromHex(coin.nonce), color: fromHex(coin.token), value: coin.value },
    { is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: fromHex(vaultAddr) } }));
  const theChain = (): { transactions: VaultTransactions; events: NoteEvents } => ({
    transactions: { of: async () => [...chainLog].reverse().map((t) => t.hash) },
    events: {
      eventsOf: async (tx) => {
        const t = chainLog.find((x) => 'hash' in tx && x.hash === tx.hash);
        if (!t) throw new Error(`the test chain holds no transaction ${JSON.stringify(tx)}`);
        const events: ServedEvent[] = [{ transactionHash: t.hash, details: { tag: 'zswapInput' } }];
        if (t.made) {
          events.push({ transactionHash: t.hash, details: { tag: 'zswapOutput', commitment: outputCommitment(t.made), contract: vaultAddr, mtIndex: t.index } });
        }
        return events;
      },
    },
  });

  const approvedRun = async (to: Uint8Array, amount: bigint, seed: number, c: Change) => {
    const leaves: PayoutLeafInput[] = [{ details: toHex(vaultCircuits.payoutDetails(to, GBP, amount, bytes(0x40))), nonce: toHex(bytes(seed)) }];
    const tree = buildPayoutTree(leaves);
    const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL);
    const vaultBytes = fromHex(vaultAddr);
    await sim.as(sim.applying(A, c)).proposeRun({ root: fromHex(tree.root), payees: tree.payees, from: WIN_FROM, until: WIN_UNTIL, vault: vaultBytes });
    const id = sim.proposalId(payload, c.salt, vaultBytes);
    await sim.as(sim.applying(A, c)).approve(id);
    await sim.as(sim.applying(B, c)).approve(id);
    return { tree, id };
  };
  const pay = async (amount: bigint, seed: number) => {
    const c = change(0n, seed);
    const run = await approvedRun(PAYEE, amount, seed, c);
    const r = await vault.impureCircuits.payout(
      ctx('payout'), run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL,
      c.salt, PAYEE, GBP, amount, bytes(0x40), bytes(seed), run.tree.pathFor(0) as never);
    vaultState = r.context.callContext.currentQueryContext.state;
    logCall(r);
    return r;
  };

  /* ---------------------------- the people ---------------------------- */
  interface Person {
    readonly name: string;
    readonly words: string;
    readonly device: DeviceSigner;
    readonly signing: ReturnType<typeof newSigningKeypair>;
    readonly wrapping: ReturnType<typeof newWrappingKeypair>;
  }
  const personNamed = (name: string): Person => {
    const words = newWords().join(' ');
    const wrapping = newWrappingKeypair();
    return {
      name, words, wrapping, signing: newSigningKeypair(),
      device: { signerId: name, wrappingSecret: wrapping.secret, companyKey: releasedCompanyKey(words, company) },
    };
  };
  let ada: Person; let bo: Person; let carol: Person;
  /*
   * Who the pool and the journals are wrapped to. Nobody is taken off: taking a
   * signer's access to those records away is not built, and they refuse a write
   * that would. Carol is added when she joins.
   */
  let poolReaders: string[];
  const poolSigners = (): PoolSigner[] => [ada, bo, carol].filter((p) => poolReaders.includes(p.name))
    .map((p) => ({ id: p.name, wrappingPublicKey: p.wrapping.publicKey }));

  const sendAs = (p: Person): WireSend => async (path, init) => {
    if (init.body !== undefined) sent.push(init.body);
    const r = await fetch(base + path, {
      method: init.method, ...(init.body === undefined ? {} : { body: init.body }),
      headers: { 'content-type': 'application/json', 'x-test-person': p.name },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  /* The roster's signing keys, as a device opens them from the company's sealed roster. */
  const roster = async () => new Set([ada, bo, carol].map((p) => p.signing.publicKey));
  const recordsOf = (p: Person) => (record: WireRecord) => new HttpSealedPoolStore(record, sendAs(p), p.signing.secret, roster);

  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(VAULT_NOW);
    company = String(sim.address);
    vault = new Vault<VaultPrivate>(vaultWitnesses as never);
    vaultAddr = sampleContractAddress() as never as Hex;
    const init = await vault.initialState(createConstructorContext({} as VaultPrivate, BLOCK), { bytes: fromHex(company) } as never);
    vaultState = init.currentContractState;
    priv = { notes: [] };
    chainLog = [];
    sent = [];
    bodyReadBeforeSignIn = false;
    ada = personNamed('ada'); bo = personNamed('bo'); carol = personNamed('carol');
    members = ['ada', 'bo'];
    poolReaders = ['ada', 'bo'];

    /* The server, mounted the way the product mounts it. */
    serverStores = new Map(RECORDS.map((r) => [r, new MemorySealedPoolStore()]));
    const app = express();
    const signedIn: express.RequestHandler = (req, res, next) => {
      if (req.body !== undefined) bodyReadBeforeSignIn = true;
      const p = req.headers['x-test-person'];
      if (typeof p !== 'string') { res.status(401).json({ error: 'not signed in' }); return; }
      (req as { userId?: string }).userId = p;
      next();
    };
    const companies = (): CompanyRoster[] => [{ id: 'acc_company', contractAddress: company, memberUserIds: members }];
    mountVaultRecords(app, {
      signedIn,
      records: { of: (r) => serverStores.get(r)! },
      accountOf: vaultAccountFromTheIndexer({
        queryContractState: async (a) => (a === vaultAddr ? { data: charged() } : null),
      }),
      companies,
      /* Each person files only under the key they gave, as the product binds it. */
      filingKeyOf: (_company, person) => [ada, bo, carol].find((p) => p.name === person)?.signing.publicKey ?? null,
    });
    /* The API's general parser, after the mount, as the product has it. */
    app.use(express.json({ limit: '1mb' }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  /** A device at work: deposits it builds itself, payments it journals first. */
  const deviceOf = (p: Person) => {
    const records = recordsOf(p);
    const pool = new SealedNotePool(records('pool'), { signerId: p.name, wrappingSecret: p.wrapping.secret }, async () => poolSigners());
    const payments = new PaymentJournalInStore(records('payment-journal'), vaultAddr,
      { id: p.name, wrappingSecret: p.wrapping.secret }, async () => poolSigners());
    const record = async (next: (notes: Note[]) => Note[]) => {
      const now = await pool.load(vaultAddr);
      await pool.save(vaultAddr, { notes: next(now.notes) }, now.readAt);
      priv = { notes: (await pool.load(vaultAddr)).notes };
    };
    const deposit = async (value: bigint, opts: { abandon?: boolean } = {}) => {
      const everCreated = await vaultOutputHistoryFrom(theChain()).everCreated(vaultAddr);
      const { coin, epoch } = await depositCoinOnThisDevice({
        vault: vaultAddr, money: { token: toHex(GBP), value }, me: p.device,
        signers: async () => poolSigners(), records,
        chain: { everCreated, outputCommitmentOf: outputCommitment, heldNow: (c) => chainNotes().includes(held(c)) },
      });
      if (opts.abandon) return { coin, epoch };
      /* The device builds the call with the coin it chose. */
      const r = await vault.impureCircuits.deposit(ctx('deposit'), { nonce: fromHex(coin.nonce), color: fromHex(coin.token), value: coin.value });
      vaultState = r.context.callContext.currentQueryContext.state;
      logCall(r);
      await record((notes) => [...notes, { ...coin, index: NO_INDEX_YET }]);
      return { coin, epoch };
    };
    const payOut = async (amount: bigint, seed: number) => {
      const spent = smallestNoteCovering(priv.notes, toHex(GBP), amount)!;
      await payments.record(vaultAddr, { spent: { nonce: spent.nonce, token: spent.token, value: spent.value }, amount, attemptedAt: 'now' });
      const r = await pay(amount, seed);
      const kept = changeCoinOf(r.context.callContext.currentZswapLocalState, vaultAddr);
      await record((notes) => [...notes.filter((n) => n.nonce !== spent.nonce), ...(kept ? [{ ...kept, index: NO_INDEX_YET }] : [])]);
      return { spent, kept };
    };
    return { pool, deposit, payOut, records };
  };

  const rebuildAs = async (p: Person, filedSecrets: readonly FiledPoolVersion[], records: CompanyRecords) => {
    const started = performance.now();
    const words = releasedCompanyKey(p.words, company);
    const opened = openNewestNonceSecrets(filedSecrets, vaultAddr, recordsKeypairFrom(words));
    const everCreated = await vaultOutputHistoryFrom(theChain()).everCreated(vaultAddr);
    const walk = await walkCompanyRecords({
      vault: vaultAddr, keys: depositNonceKeysOf(opened), records, everCreated,
      commitmentOf: await compiledOutputCommitment(),
    });
    const rebuilt = reconcileVaultPool({ vault: vaultAddr, chain: chainNotes(), versions: [], named: walk.coins, circuits: vaultCircuits });
    return { opened, walk, rebuilt, ms: performance.now() - started };
  };

  it('A DEPOSIT\'S RECORD MADE ON THE DEVICE, FILED THROUGH THE MOUNTED ROUTE, AND THE VAULT REBUILT BY A SIGNER WHO DEPOSITED NOTHING, WITH A NOTE THAT COMES BACK SPENT', async () => {
    const adas = deviceOf(ada);
    await startVaultNonceSecretOnThisDevice(vaultAddr, ada.device, [recordsReaderOf(bo.device.companyKey)], adas.records, new Set(chainNotes()));
    await adas.pool.create(vaultAddr, { notes: [] });

    const first = await adas.deposit(1_000n);
    const second = await adas.deposit(400n);
    await adas.deposit(5_000n, { abandon: true });
    const bos = deviceOf(bo);
    const byBo = await bos.deposit(1_000n);
    expect(byBo.coin.nonce, 'RED WHEN: two deposits of one amount share a coin').not.toBe(first.coin.nonce);
    expect([first.epoch, byBo.epoch], 'both deposited under the one secret the company holds').toEqual([1, 1]);

    const toOne = await adas.payOut(250n, 0xb1);     // 400 -> change 150
    expect(toOne.spent.nonce).toBe(second.coin.nonce);
    await adas.payOut(700n, 0xa1);                   // a 1,000 -> change 300
    const toThree = await adas.payOut(100n, 0xc1);   // 150 -> change 50, a change of a change
    expect(toThree.spent.nonce, 'the setup meant to spend the 150 here').toBe(toOne.kept!.nonce);

    /* Bo leaves: a new epoch, wrapped to Ada, made on Ada's device. Carol joins and is given it. */
    const secrets = adas.records('nonce-secret');
    const adasKey = recordsKeypairFrom(ada.device.companyKey);
    const rotated = rotateNonceSecret((await secrets.get(vaultAddr))!, vaultAddr, adasKey,
      { remaining: [recordsReaderOf(ada.device.companyKey)], leaving: [recordsReaderOf(bo.device.companyKey)] });
    await secrets.put(vaultAddr, rotated);
    members = ['ada', 'carol'];
    poolReaders = ['ada', 'bo', 'carol'];
    await secrets.put(vaultAddr, admitToNonceSecret(rotated, vaultAddr, adasKey, [recordsReaderOf(carol.device.companyKey)]));
    await expect(bos.deposit(10n), 'RED WHEN: a signer who has left can still file for the vault').rejects.toThrow(/403/);

    const afterRotation = await adas.deposit(600n);
    expect(afterRotation.epoch, 'RED WHEN: a deposit after a signer left is made under a secret they know').toBe(2);
    const before = priv.notes.map((n) => n.value).sort((a, b) => Number(a - b));
    expect(before).toEqual([50n, 300n, 600n, 1_000n]);

    /* ------------- NOTHING THE SERVER HOLDS IS A NONCE, A SECRET OR A KEY ------------- */
    const allSecrets = openNewestNonceSecrets(await secrets.versions(vaultAddr), vaultAddr, adasKey).secrets;
    const never = [
      ...[first, second, byBo, afterRotation].map((d) => d.coin.nonce), ...allSecrets,
      ...[ada, bo, carol].flatMap((p) => [toHex(p.device.companyKey), recordsKeypairFrom(p.device.companyKey).secret, p.signing.secret, p.wrapping.secret]),
    ];
    const everythingTheServerSaw = sent.join('\n');
    for (const secret of never) {
      expect(everythingTheServerSaw.includes(secret), 'RED WHEN: a nonce, a nonce secret or a key reaches the server in any request').toBe(false);
    }

    /* ------------- THE COMPANY'S BOOKS, AND THE FILED NONCE SECRET ------------- */
    const books: CompanyRecords = {
      deposited: [1_000n, 400n, 1_000n, 600n].map((value) => ({ token: toHex(GBP), value })),
      paid: [250n, 700n, 100n].map((amount) => ({ token: toHex(GBP), amount })),
    };
    const filedSecrets = await serverStores.get('nonce-secret')!.versions(vaultAddr);
    expect(filedSecrets.map((v) => v.version)).toEqual([1, 2, 3]);

    /* ------------- THE POOL AND BOTH JOURNALS GONE ------------- */
    for (const r of ['pool', 'deposit-journal', 'payment-journal'] as const) serverStores.set(r, new MemorySealedPoolStore());
    priv = { notes: [] };
    await expect(adas.pool.load(vaultAddr), 'nothing of the pool is left to read').rejects.toThrow(/no pool for it at all/);

    /* ------------- CAROL REBUILDS FROM HER OWN WORDS ------------- */
    const byCarol = await rebuildAs(carol, filedSecrets, books);
    expect(byCarol.opened.epoch, 'RED WHEN: a signer who joined later is not given every epoch').toBe(2);
    expect(byCarol.walk.found, 'RED WHEN: a deposit by anybody, or a change a spent note became, is not named').toEqual({ deposits: 4, changes: 3, pieces: 0 });
    expect(byCarol.rebuilt.unexplained, `RED WHEN: a note the vault holds is not named: ${describeRecovery(byCarol.rebuilt)}`).toEqual([]);
    expect(byCarol.rebuilt.held.map((n) => n.value).sort((a, b) => Number(a - b)), 'RED WHEN: the rebuild holds anything but what the vault holds')
      .toEqual(before);
    const rebuiltChange = byCarol.rebuilt.held.find((n) => n.value === 50n)!;
    expect(rebuiltChange.nonce, 'RED WHEN: the change of a change is rebuilt under any nonce but the one the chain made').toBe(toThree.kept!.nonce);
    expect(byCarol.ms, 'the whole rebuild, words to held notes, took well under a minute here').toBeLessThan(60_000);

    /* ------------- AND A REBUILT NOTE COMES BACK SPENT ------------- */
    priv = { notes: byCarol.rebuilt.held.map((n) => ({ nonce: n.nonce, token: n.token, value: n.value, index: NO_INDEX_YET })) };
    const paymentsBefore = vaultLedger(charged() as never).payments;
    const r = await pay(40n, 0xd1);                  // the smallest note covering 40 is the rebuilt 50
    expect(vaultLedger(charged() as never).payments, 'RED WHEN: the rebuilt note does not spend').toBe(paymentsBefore + 1n);
    const left = changeCoinOf(r.context.callContext.currentZswapLocalState, vaultAddr)!;
    expect(left.value, 'RED WHEN: a note other than the rebuilt change was spent').toBe(10n);
    expect(left.nonce).toBe(toHex(changeNonceOf(fromHex(rebuiltChange.nonce))));
    expect(chainNotes(), 'RED WHEN: the rebuilt note is still in the vault after it was spent').not.toContain(held(rebuiltChange));

    /* ------------- BO, WHO LEFT, KEEPS WHAT HE HAD AND NOTHING MADE AFTER ------------- */
    const byBoAfter = await rebuildAs(bo, filedSecrets, books);
    expect(byBoAfter.opened.epoch, 'RED WHEN: a signer who left is handed the epoch made after').toBe(1);
    const theNewDeposit = held(afterRotation.coin);
    expect(byBoAfter.rebuilt.unexplained, 'RED WHEN: a signer who left can name a deposit made after they left').toContain(theNewDeposit);
    expect(byBoAfter.rebuilt.held.some((n) => n.nonce === afterRotation.coin.nonce)).toBe(false);
  });

  it('A STRANGER\'S WORDS OPEN NOTHING, AND NOBODY BUT A SIGNER OF THE VAULT\'S COMPANY FILES ANYTHING', async () => {
    const adas = deviceOf(ada);
    await startVaultNonceSecretOnThisDevice(vaultAddr, ada.device, [], adas.records, new Set());
    const filed = await serverStores.get('nonce-secret')!.versions(vaultAddr);
    const stranger = personNamed('mallory');
    expect(() => openNewestNonceSecrets(filed, vaultAddr, recordsKeypairFrom(stranger.device.companyKey)),
      'RED WHEN: somebody the secret was never wrapped to opens it').toThrow(/no version filed for this vault has a copy/);
    await expect(deviceOf(stranger).records('pool').get(vaultAddr), 'RED WHEN: a person who is not a signer of the vault\'s company reads its records')
      .rejects.toThrow(/403/);
    await expect(startVaultNonceSecretOnThisDevice(vaultAddr, ada.device, [], adas.records, new Set()),
      'RED WHEN: a second secret can be started for a vault that has one').rejects.toThrow(/already has a nonce secret/);
    /* A large body is read only after the sign-in, and one from a signer is read whole, past the API's general limit. */
    const big = JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) });
    const nobody = await fetch(`${base}/api/vaults/${vaultAddr}/records/pool/1`, { method: 'PUT', body: big, headers: { 'content-type': 'application/json' } });
    expect(nobody.status, 'RED WHEN: somebody who is not signed in can make the server read a large body').toBe(401);
    const fromAda = await fetch(`${base}/api/vaults/${vaultAddr}/records/pool/1`, {
      method: 'PUT', body: big, headers: { 'content-type': 'application/json', 'x-test-person': 'ada' },
    });
    expect(fromAda.status, 'RED WHEN: the general body limit refuses a vault record before the route reads it').toBe(400);
    expect(bodyReadBeforeSignIn, 'RED WHEN: a body is read before the sign-in has decided who is asking').toBe(false);
    const elsewhere = sampleContractAddress() as never as Hex;
    await expect(adas.records('pool').get(elsewhere), 'RED WHEN: a vault the chain does not know is served to anybody').rejects.toThrow(/403/);
  });
});
