import { describe, it, expect } from 'vitest';
import {
  createCompanyVault, depositIntoCompanyVault, openCompanyVaultPool, DepositNotYetSeen, VaultHandoverOwed,
  DepositNotSent, DepositStillInFlight, DepositLandedNotYetRecorded, settleDepositInFlight, DEPOSIT_TIME_TO_LIVE_MS,
  payPrivatelyFromCompanyVault, PaymentNotYetSeen, PaymentNotAsBuilt, PaymentLandedUnrecorded,
  payPubliclyFromCompanyVault, PublicPaymentNotYetSeen,
  type TemporaryKeys, type VaultChainView, type VaultService, type DepositInFlight, type DepositsInFlight,
} from './vault-operation.js';
import { chooseNoteForPayment, confirmPayment, poolAfterPayment } from './vault-builder.js';
import { vaultNoteCommitment } from '../midnight/note-index.js';
import { SealedNotePool } from '../midnight/vault-pool.js';
import { PaymentJournalInStore } from '../midnight/vault-journal.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../midnight/private-payment-wire.js';
import { vaultBuilderOver, type VaultBuilderClient } from './vault-worker-client.js';
import { MemorySealedPoolStore } from '../midnight/vault-pool.js';
import type { WireRecord } from '../midnight/sealed-record-wire.js';
import { newWrappingKeypair } from '../core/crypto.js';
import { answerVaultAsk, creatingTransactionOfNote } from './vault-worker-entry.js';
import * as vaultModule from '../../contracts/managed-vault/contract/index.js';
import { openNonceSecrets, recordsKeypairFrom, currentDepositNonceKey } from '../midnight/company-nonce-secret.js';
import { depositNonceAt, DepositCoinAlreadyMade } from '../midnight/deposit-nonce.js';

/** Deposits in flight, kept for the length of one test. */
const inFlightInMemory = (kept = new Map<string, DepositInFlight>()): DepositsInFlight => ({
  get: async (v) => kept.get(v) ?? null,
  put: async (v, d) => { kept.set(v, d); },
  forget: async (v) => { kept.delete(v); },
});

/*
 * The order a signer's device runs, with the service and the builder stood in.
 * The same order against the ledger's own state machine is
 * `contracts/test/a-company-vault-from-the-page.test.ts`.
 */
const VAULT = 'ab'.repeat(32);
const ACCOUNT = 'c0'.repeat(32);
const committee = { committee: [{ tag: 'schnorr', value: '11'.repeat(32) }], threshold: 1 };
const pacing = { sleep: async () => {}, waitMs: 3, everyMs: 1 };
/* Stand-in ledger parameters: the header the ledger writes them under, and nothing a ledger could read. */
const PARAMS = btoa('midnight:ledger-parameters[v8]:stand-in');
const view = (over: Partial<VaultChainView>): VaultChainView => ({ vault: VAULT, onChain: true, committee, ...over });

const builder = (log: string[]): VaultBuilderClient => ({
  deploy: async () => { log.push('build deploy'); return { vault: VAULT, temporaryKey: { tag: 'schnorr', value: '77'.repeat(32) }, tx: 'D' }; },
  handover: async (i) => { log.push(`build handover at ${i.counter}`); return { tx: 'H' }; },
  deposit: async (i) => { log.push(`build deposit with ${i.parameters}`); return { tx: 'P' }; },
  commitments: async (i) => ({ output: 'aa'.repeat(32), held: i.coin.nonce === 'ee'.repeat(32) ? 'bb'.repeat(32) : `h${i.coin.nonce.slice(1)}` }),
  chooseNote: async (i) => { log.push('choose'); return chooseNoteForPayment(i); },
  paymentsFit: async () => { throw new Error('a payment out never asks whether a run fits'); },
  afterPayment: async (i) => poolAfterPayment(i),
  confirmPayment: async (i) => confirmPayment(i),
  creatingTransaction: async (i) => creatingTransactionOfNote(i),
  payout: async (i) => {
    log.push(`build payout spending ${i.note.nonce.slice(0, 2)} with ${i.events.length} event(s) at ${i.chain.blockHash}`);
    const rest = BigInt(i.note.value) - BigInt(i.payment.amount);
    return { tx: 'O', spent: i.note.nonce, change: rest === 0n ? null : { nonce: 'cc'.repeat(32), token: i.note.token, value: rest.toString() } };
  },
  payoutPublicly: async (i) => {
    log.push(`build public payout of ${i.payment.amount} to ${i.payment.payee} at ${i.chain.blockHash}`);
    return { tx: 'U' };
  },
  /* No vault operation raises or approves a round. */
  governedCall: async () => { throw new Error('a vault operation asked for a governed call'); },
});
const memoryKeys = (log: string[]) => {
  const held = new Map<string, { tag: string; value: string }>();
  const keys: TemporaryKeys = {
    put: async (v, k) => { log.push('key kept'); held.set(v, k); },
    get: async (v) => held.get(v) ?? null,
    forget: async (v) => { log.push('key forgotten'); held.delete(v); },
  };
  return { keys, held };
};
const serviceFrom = (views: VaultChainView[], log: string[], over: Partial<VaultService> = {}): VaultService => {
  let i = 0;
  return {
    keys: async () => ({ committee, why: null, readers: [] }),
    deploy: async () => { log.push('sent deploy'); return { vault: VAULT, txRef: 'd' }; },
    handover: async () => { log.push('sent handover'); return { txRef: 'h' }; },
    chain: async () => views[Math.min(i++, views.length - 1)]!,
    deposit: async () => { log.push('sent deposit'); return { txRef: 'p', transactionHash: 'ee'.repeat(32) }; },
    payoutState: async (v) => {
      log.push('read the block');
      return { vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: PARAMS, accountState: 'A' };
    },
    events: async (_v, tx) => {
      log.push(`read events of ${tx.slice(0, 2)}`);
      const landed = paymentEvents.get(tx);
      if (landed) return { events: landed };
      if (tx === 'dd'.repeat(32)) throw new Error('the indexer does not hold this transaction yet');
      return { events: [{ transactionHash: tx, details: { tag: 'zswapOutput' } }] };
    },
    payout: async () => { log.push('sent payout'); return { txRef: 'o', transactionHash: 'dd'.repeat(32) }; },
    payoutPublicly: async () => { log.push('sent public payout'); return { txRef: 'u', transactionHash: 'de'.repeat(32) }; },
    ...over,
  };
};
/** The events a landed payment has, by its hash; a test fills this in when its payment lands. */
const paymentEvents = new Map<string, Array<{ transactionHash: string; details: { tag: string; commitment?: string; contract?: string; mtIndex?: string } }>>();
const eventsOfAPayment = async (hash: string, change: { nonce: string; token: string; value: bigint } | null, vault = VAULT) => [
  { transactionHash: hash, details: { tag: 'zswapInput' } },
  { transactionHash: hash, details: { tag: 'zswapOutput', commitment: 'f0'.repeat(32), mtIndex: '11' } },
  ...(change === null ? [] : [{
    transactionHash: hash,
    details: { tag: 'zswapOutput', commitment: await vaultNoteCommitment(change as never, vault as never), contract: vault, mtIndex: '12' },
  }]),
];
const oneKey = view({ authority: { committee: [{ tag: 'schnorr', value: '99'.repeat(32) }], threshold: 1, counter: '0', shape: 'one-key' }, heldByCommittee: false });
const held = view({ heldByCommittee: true, why: null });

describe('CREATING A VAULT', () => {
  it('keeps the temporary key BEFORE the deploy is sent, and forgets it only once the chain says the committee holds the vault', async () => {
    const log: string[] = [];
    const { keys, held: kept } = memoryKeys(log);
    const done = await createCompanyVault({ ...pacing, account: ACCOUNT, service: serviceFrom([oneKey, held], log), builder: builder(log), keys });
    expect(done).toEqual({ vault: VAULT, state: 'held-by-committee' });
    expect(log).toEqual(['build deploy', 'key kept', 'sent deploy', 'build handover at 0', 'sent handover', 'key forgotten']);
    expect(kept.size).toBe(0);
  });

  it('NO COMMITTEE, NOTHING BUILT', async () => {
    const log: string[] = [];
    const service = serviceFrom([], log, { keys: async () => ({ committee: null, why: 'not everybody has given a key.', readers: [] }) });
    await expect(createCompanyVault({ ...pacing, account: ACCOUNT, service, builder: builder(log), keys: memoryKeys(log).keys }))
      .rejects.toThrow('not everybody has given a key.');
    expect(log).toEqual([]);
  });

  it('A DEPLOY THAT MAY HAVE LANDED IS A FAILURE NAMING THE VAULT, AND THE KEY IS KEPT', async () => {
    const log: string[] = [];
    const { keys, held: kept } = memoryKeys(log);
    const service = serviceFrom([], log, { deploy: async () => { throw new Error('the node did not answer'); } });
    const e = await createCompanyVault({ ...pacing, account: ACCOUNT, service, builder: builder(log), keys }).catch((x) => x);
    expect(e).toBeInstanceOf(VaultHandoverOwed);
    expect(e.vault).toBe(VAULT);
    expect(kept.has(VAULT)).toBe(true);
  });

  it('A DEPLOY REFUSED BEFORE IT WAS SENT forgets the key and says why', async () => {
    const log: string[] = [];
    const { keys, held: kept } = memoryKeys(log);
    const service = serviceFrom([], log, {
      deploy: async () => { throw Object.assign(new Error('refused. Nothing was sent.'), { nothingWasSent: true }); },
    });
    await expect(createCompanyVault({ ...pacing, account: ACCOUNT, service, builder: builder(log), keys })).rejects.toThrow('refused. Nothing was sent.');
    expect(kept.size).toBe(0);
  });

  it('A HANDOVER THAT DOES NOT SHOW, OR A VAULT THAT NEVER APPEARS, IS NEVER REPORTED CREATED', async () => {
    const log: string[] = [];
    const neverHeld = await createCompanyVault({
      ...pacing, account: ACCOUNT, service: serviceFrom([oneKey], log), builder: builder(log), keys: memoryKeys(log).keys,
    }).catch((x) => x);
    expect(neverHeld).toBeInstanceOf(VaultHandoverOwed);
    expect(log.filter((l) => l === 'sent handover')).toHaveLength(3);
    const absent = await createCompanyVault({
      ...pacing, account: ACCOUNT, service: serviceFrom([view({ onChain: false })], []), builder: builder([]), keys: memoryKeys([]).keys,
    }).catch((x) => x);
    expect(absent).toBeInstanceOf(VaultHandoverOwed);
    expect(absent.message).toMatch(/has not shown the vault yet/);
  });

  it('A RESUME WITHOUT THE TEMPORARY KEY ON THIS DEVICE STOPS, AND SAYS ONLY THE DEPLOYING DEVICE CAN FINISH', async () => {
    const log: string[] = [];
    const e = await createCompanyVault({
      ...pacing, account: ACCOUNT, service: serviceFrom([oneKey], log), builder: builder(log), keys: memoryKeys(log).keys,
    }, VAULT).catch((x) => x);
    expect(e).toBeInstanceOf(VaultHandoverOwed);
    expect(e.message).toMatch(/only the device that deployed it/);
    expect(log).toEqual([]);
  });

  it('a resume for a vault the committee already holds finishes without building anything', async () => {
    const log: string[] = [];
    await expect(createCompanyVault({ ...pacing, account: ACCOUNT, service: serviceFrom([held], log), builder: builder(log), keys: memoryKeys(log).keys }, VAULT))
      .resolves.toEqual({ vault: VAULT, state: 'held-by-committee' });
    expect(log).toEqual(['key forgotten']);
  });

  it('a vault held by some other committee is not handed over', async () => {
    const log: string[] = [];
    const other = view({ authority: { committee: [], threshold: 2, counter: '3', shape: 'committee' }, heldByCommittee: false, why: 'held by others.' });
    await expect(createCompanyVault({ ...pacing, account: ACCOUNT, service: serviceFrom([other], log), builder: builder(log), keys: memoryKeys(log).keys }, VAULT))
      .rejects.toThrow(/held by others/);
    expect(log).toEqual([]);
  });
});

describe('THE POOL AND A DEPOSIT', () => {
  const wrapping = newWrappingKeypair();
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(3) };
  const stores = () => {
    const s = new Map<WireRecord, MemorySealedPoolStore>();
    return (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
  };
  const poolDoors = (service: VaultService, records = stores()) => ({
    ...pacing, service, me, myRecordsKey: 'ff'.repeat(32), records,
    signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
  });

  it('A POOL IS NOT OPENED FOR A VAULT THE COMMITTEE DOES NOT HOLD, NOR AN EMPTY ONE FOR A VAULT WITH MONEY', async () => {
    await expect(openCompanyVaultPool(poolDoors(serviceFrom([oneKey], [])), VAULT)).rejects.toThrow();
    const records = stores();
    await expect(openCompanyVaultPool(poolDoors(serviceFrom([view({ heldByCommittee: true, everCreated: ['01'] })], []), records), VAULT))
      .rejects.toThrow(/already put money in this vault and it has no pool/);
    expect(await records('pool').get(VAULT)).toBeNull();
  });

  it('A DEPOSIT INTO A VAULT THE COMMITTEE DOES NOT HOLD IS REFUSED BEFORE A COIN IS CHOSEN', async () => {
    const log: string[] = [];
    const records = stores();
    /* The chain has the vault and its state, so the only thing refusing is who holds it. */
    const stillOurs = view({ ...oneKey, state: 'AAAA', notes: [], everCreated: [] });
    await expect(depositIntoCompanyVault({
      ...poolDoors(serviceFrom([stillOurs], log), records), company: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 1n })).rejects.toThrow(/not held by the company's committee/);
    expect(log).toEqual([]);
    expect(await records('deposit-journal').get(VAULT)).toBeNull();
  });

  it('A VAULT THE COMMITTEE HOLDS TAKES NO MONEY WHILE THE COMPANY ACCOUNT IS NOT HELD BY IT, AND THE WALLET IS NEVER ASKED', async () => {
    /* RED WHEN: the `fundable` check in `depositIntoCompanyVault` is removed or moved after the coin is chosen -
     * the log then carries 'build deposit' and 'paid', and the journal holds a coin for a deposit the service refuses. */
    const log: string[] = [];
    const records = stores();
    const vaultOnly = view({
      heldByCommittee: true, fundable: false, state: 'AAAA', notes: [], everCreated: [],
      why: 'this company\'s account is still held by the temporary key it was created with.',
    });
    await openCompanyVaultPool(poolDoors(serviceFrom([vaultOnly], log), records), VAULT);
    await expect(depositIntoCompanyVault({
      ...poolDoors(serviceFrom([vaultOnly], log), records), company: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n })).rejects.toThrow(/account is still held by the temporary key/);
    expect(log).toEqual([]);
    expect(await records('deposit-journal').get(VAULT)).toBeNull();
  });

  it('A DEPOSIT THE CHAIN HAS NOT SHOWN IS NOT RECORDED IN THE POOL, AND SAYS IT MAY STILL LAND', async () => {
    const log: string[] = [];
    const records = stores();
    const ready = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT);
    const e = await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([ready], log), records), company: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x) => x);
    expect(e).toBeInstanceOf(DepositNotYetSeen);
    /* RED WHEN: the deposit is built with anything but the parameters the block read served, or the block is not read. */
    expect(log).toEqual(['read the block', `build deposit with ${PARAMS}`, 'paid', 'sent deposit']);
    expect((await records('pool').versions(VAULT)).length).toBe(1);
    expect(await records('deposit-journal').get(VAULT)).not.toBeNull();
  });

  it('A COIN THE LEDGER HAS ALREADY RECORDED IS REFUSED ON THE DEVICE, WITH THE FAST CHECK, BEFORE ANYTHING IS BUILT', async () => {
    /*
     * The vault's history holds the LEDGER'S OWN commitment (`vaultNoteCommitment`, the ledger's general code) of the
     * coin at each slot this deposit may use, and the device asks the worker's own `commitments`, which answers with the
     * vault's compiled commitment. So the refusal below is the fast check recognising what the ledger recorded.
     */
    const real = (log: string[]): VaultBuilderClient => ({
      ...builder(log),
      commitments: async (i) => {
        const a = await answerVaultAsk(async () => ({ vault: vaultModule }) as never, { id: 1, network: 'undeployed', ask: 'commitments', ...i });
        if (!a.ok || a.ask !== 'commitments') throw new Error('the worker did not answer the commitments');
        return { output: a.output, held: a.held };
      },
    });
    const money = { token: 'ab'.repeat(32) as never, value: 7n };
    const coinAt = async (records: ReturnType<typeof stores>, slot: number) => {
      const opened = openNonceSecrets((await records('nonce-secret').get(VAULT))!, VAULT, recordsKeypairFrom(me.companyKey));
      const nonce = depositNonceAt(currentDepositNonceKey(opened), money, slot);
      return { nonce, token: money.token, value: money.value };
    };
    /* Three coins the chain made, at slots 1, 2 and 3, and the vault holds the coins at 4, 5 and 6 now: with three
     * outputs in the history, 6 is the last slot a deposit may use. */
    const records = stores();
    const empty = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([empty], []), records), VAULT);
    const madeAt = async (slots: number[]) => Promise.all(slots.map(async (n) => vaultNoteCommitment(await coinAt(records, n), VAULT as never)));
    const log: string[] = [];
    const heldAt = async (slots: number[]) => Promise.all(slots.map(async (n) => (await real([]).commitments({
      vault: VAULT, coin: { ...(await coinAt(records, n)), value: money.value.toString() },
    })).held));
    const taken = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: await heldAt([4, 5, 6]), everCreated: await madeAt([1, 2, 3]) });
    const e = await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([taken], log), records), company: ACCOUNT, inFlight: inFlightInMemory(), builder: real(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, money).catch((x) => x);
    /* RED WHEN: the worker's `output` is not the ledger's commitment (the held one, say), or the history is not asked. */
    expect(e).toBeInstanceOf(DepositCoinAlreadyMade);
    expect(log, 'RED WHEN: a coin the ledger has recorded reaches the builder or the wallet').toEqual(['read the block']);

    /* Two of the three taken: the deposit moves to the free slot and builds with that coin. */
    const log2: string[] = [];
    const built: string[] = [];
    const two = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [...await madeAt([1, 3]), 'f1'.repeat(32)] });
    await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([two], log2), records), company: ACCOUNT, inFlight: inFlightInMemory(),
      builder: { ...real(log2), deposit: async (i) => { built.push(i.coin.nonce); return { tx: 'P' }; } },
      pay: async () => ({ transaction: 'X', leaves: [] }),
    }, VAULT, money).catch(() => undefined);
    expect(built, 'RED WHEN: a slot whose coin the ledger recorded is used, or a free one is skipped').toEqual([(await coinAt(records, 2)).nonce]);
  });

  it('A DEPOSIT WHOSE CHAIN PARAMETERS CANNOT BE READ CHOOSES NO COIN, BUILDS NOTHING AND ASKS NO WALLET', async () => {
    const ready = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [] });
    const refusals: Array<[string, Partial<VaultService>]> = [
      ['the block cannot be read', { payoutState: async () => { throw new Error('the chain could not be read'); } }],
      ['the block names no parameters', { payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: '', accountState: 'A' }) }],
      ['the block is another vault\'s', { payoutState: async () => ({ vault: 'ee'.repeat(32) as never, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: PARAMS, accountState: 'A' }) }],
      ['the block\'s parameters are not parameters', { payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: btoa('not parameters at all, just bytes'), accountState: 'A' }) }],
      ['the block\'s parameters are not base64', { payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: '%%%%', accountState: 'A' }) }],
    ];
    for (const [why, over] of refusals) {
      const log: string[] = [];
      const records = stores();
      await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT);
      /* RED WHEN: the parameters are read after the coin is chosen, or a failed or foreign read is let through -
       * the journal then holds a coin, and the log carries 'build deposit' or 'paid'. */
      await expect(depositIntoCompanyVault({
        ...poolDoors(serviceFrom([ready], log, over), records), company: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
        pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
      }, VAULT, { token: 'ab'.repeat(32), value: 7n }), why).rejects.toThrow(/current parameters could not be read.*no coin was chosen/);
      expect(log, why).toEqual([]);
      expect(await records('deposit-journal').get(VAULT), why).toBeNull();
    }
  });
});

describe('A DEPOSIT THAT DOES NOT FINISH', () => {
  const wrapping = newWrappingKeypair();
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(5) };
  const MONEY = { token: 'ab'.repeat(32) as never, value: 7n };
  const HASH = 'e1'.repeat(32);
  type Coin = { nonce: string; token: string; value: string };
  /* Each commitment is over the whole coin, as the ledger's is: a coin read back with the wrong token or value matches nothing. */
  const outputOf = (c: Coin) => `out:${c.nonce}:${c.token}:${c.value}`;
  const heldOf = (c: Coin) => `held:${c.nonce}:${c.token}:${c.value}`;
  /** A chain this test moves by hand: what the vault holds, what it ever made, and each transaction's events. */
  const world = () => {
    const w = {
      notes: [] as string[], everCreated: [] as string[],
      events: new Map<string, Array<{ transactionHash: string; details: { tag: string; commitment?: string; contract?: string; mtIndex?: string } }>>(),
      sent: [] as string[], asked: [] as string[], built: [] as Coin[], eventReads: 0,
      depositAnswer: { txRef: 'p', transactionHash: HASH as string | null },
      sendFails: null as null | Error,
    };
    const service = serviceFrom([], w.asked, {
      chain: async () => view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [...w.notes], everCreated: [...w.everCreated] }),
      deposit: async (_v, tx) => { if (w.sendFails) throw w.sendFails; w.sent.push(tx); return w.depositAnswer; },
      events: async (_v, tx) => {
        w.eventReads += 1;
        const e = w.events.get(tx);
        if (e === undefined) throw new Error('the indexer does not hold this transaction yet');
        return { events: e };
      },
    });
    const b: VaultBuilderClient = {
      ...builder([]),
      deposit: async (i) => { w.built.push(i.coin); return { tx: `P${w.built.length}` }; },
      commitments: async (i) => ({ output: outputOf(i.coin), held: heldOf(i.coin) }),
    };
    /** The chain takes the deposit of `coin` in transaction `hash`. */
    const lands = (coin: Coin, hash = HASH) => {
      w.notes.push(heldOf(coin));
      w.everCreated.push(outputOf(coin));
      w.events.set(hash, [{ transactionHash: hash, details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: VAULT, mtIndex: '4' } }]);
    };
    return { w, service, b, lands };
  };
  const stores = () => {
    const kept = new Map<WireRecord, MemorySealedPoolStore>();
    return (r: WireRecord) => kept.get(r) ?? kept.set(r, new MemorySealedPoolStore()).get(r)!;
  };
  const setUp = async () => {
    const t = world();
    const records = stores();
    const kept = new Map<string, DepositInFlight>();
    let now = 1_000_000;
    const doors = {
      ...pacing, service: t.service, me, myRecordsKey: 'ff'.repeat(32), records,
      signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
      company: ACCOUNT, builder: t.b, inFlight: inFlightInMemory(kept), clock: () => now,
      pay: async (ask: { transaction: string }) => ({ transaction: `${ask.transaction}+coins`, leaves: [] }),
    };
    await openCompanyVaultPool(doors, VAULT);
    const pool = new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret },
      async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }]);
    return { ...t, doors, records, kept, pool, later: (ms: number) => { now += ms; } };
  };

  it('A DEPOSIT THE WALLET FINISHED AND THE SERVICE REFUSED TO SEND SAYS NO MONEY MOVED, AND LEAVES NOTHING IN FLIGHT', async () => {
    const t = await setUp();
    t.w.sendFails = Object.assign(new Error('the fee payer would not take it'), { nothingWasSent: true });
    const e = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: a refused send is reported as a deposit that may still land, or the page stops saying the wallet may hold coins. */
    expect(e).toBeInstanceOf(DepositNotSent);
    expect((e as Error).message).toMatch(/no money moved.*wallet may show part of its balance as held/);
    expect(t.kept.size, 'RED WHEN: a deposit that was never sent is kept in flight, so the next one is refused for nothing').toBe(0);
    const failing = await setUp();
    const walletSaidNo = await depositIntoCompanyVault({ ...failing.doors, pay: async () => { throw new Error('the person closed the wallet'); } }, VAULT, MONEY).catch((x) => x);
    expect((walletSaidNo as Error).message).toMatch(/closed the wallet/);
    expect(failing.kept.size, 'RED WHEN: a deposit the wallet never finished is kept in flight').toBe(0);
  });

  it('A SEND THAT MAY HAVE LANDED IS KEPT IN FLIGHT, BEFORE THE WALLET IS ASKED, AND SAYS THE MONEY MAY HAVE MOVED', async () => {
    const t = await setUp();
    let keptBeforeTheWallet = false;
    t.w.sendFails = new Error('the connection dropped');
    const e = await depositIntoCompanyVault({
      ...t.doors, pay: async (ask) => { keptBeforeTheWallet = t.kept.size === 1; return { transaction: `${ask.transaction}+coins`, leaves: [] }; },
    }, VAULT, MONEY).catch((x) => x);
    expect(e).toBeInstanceOf(DepositNotYetSeen);
    expect((e as Error).message).toMatch(/^the deposit may have been sent/);
    expect(keptBeforeTheWallet, 'RED WHEN: the record of the deposit is written after the wallet is asked, so a closed page loses it').toBe(true);
    expect([...t.kept.values()].map((d) => d.coin), 'RED WHEN: a send that may have landed is forgotten').toEqual([t.w.built[0]]);
  });

  it('A DEPOSIT NOT YET SEEN IS FOUND WHEN IT LANDS: THE NEXT DEPOSIT RECORDS IT FIRST, UNDER ITS OWN TRANSACTION, AND THE POOL MATCHES THE CHAIN', async () => {
    const t = await setUp();
    const first = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    expect(first).toBeInstanceOf(DepositNotYetSeen);
    expect((await t.pool.load(VAULT)).notes, 'the note is not recorded before the chain holds it').toEqual([]);
    const firstCoin = t.w.built[0]!;
    t.lands(firstCoin);
    /* The same money again: its lowest slot is now the first deposit's, which is taken. */
    const second = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    const notes = (await t.pool.load(VAULT)).notes;
    /* RED WHEN: nothing looks for the earlier deposit again - the pool then never holds the note the chain does. */
    expect(notes.find((n) => n.nonce === firstCoin.nonce), 'RED WHEN: the earlier deposit is not recorded once it lands')
      .toMatchObject({ nonce: firstCoin.nonce, value: 7n, createdIn: HASH });
    expect(second, 'the second deposit then goes ahead, and is itself not yet seen').toBeInstanceOf(DepositNotYetSeen);
    expect(t.w.built, 'RED WHEN: the second deposit is not built').toHaveLength(2);
    expect(t.w.built[1]!.nonce, 'RED WHEN: the second deposit of the same money is built from the coin the first one made').not.toBe(firstCoin.nonce);
    /* The pool holds exactly what the chain holds of these deposits. */
    expect(notes.map((n) => heldOf({ nonce: n.nonce, token: n.token, value: n.value.toString() })).sort()).toEqual([...t.w.notes].sort());
  });

  it('WHILE AN EARLIER DEPOSIT CAN STILL LAND, NO SECOND ONE IS BUILT; ONCE IT CAN NO LONGER LAND, IT IS LET GO', async () => {
    const t = await setUp();
    await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
    const before = (await t.records('deposit-journal').versions(VAULT)).length;
    const e = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: a second deposit of the same money is built while the first is unresolved - the same coin, refused after its fee. */
    expect(e).toBeInstanceOf(DepositStillInFlight);
    expect(t.w.built, 'nothing is built for the second deposit').toHaveLength(1);
    expect((await t.records('deposit-journal').versions(VAULT)).length, 'no line is filed for it').toBe(before);
    t.later(DEPOSIT_TIME_TO_LIVE_MS - 1);
    await expect(settleDepositInFlight(t.doors, VAULT), 'RED WHEN: a deposit is let go before it can no longer land').rejects.toBeInstanceOf(DepositStillInFlight);
    t.later(2);
    expect(await settleDepositInFlight(t.doors, VAULT)).toEqual({ state: 'never-landed' });
    expect(t.kept.size).toBe(0);
    expect((await t.pool.load(VAULT)).notes, 'RED WHEN: a deposit that never landed is recorded').toEqual([]);
  });

  it('A FOLLOW-UP RECORDS ONLY WHAT THE VAULT HOLDS, AND ONLY UNDER A TRANSACTION WHOSE EVENTS SHOW IT', async () => {
    /* The chain made the coin and the vault's notes, read a moment apart, do not show it: nothing is recorded, and it is kept. */
    const apart = await setUp();
    await depositIntoCompanyVault(apart.doors, VAULT, MONEY).catch(() => undefined);
    apart.w.everCreated.push(outputOf(apart.w.built[0]!));
    apart.later(DEPOSIT_TIME_TO_LIVE_MS * 2);
    await expect(settleDepositInFlight(apart.doors, VAULT)).rejects.toBeInstanceOf(DepositLandedNotYetRecorded);
    expect((await apart.pool.load(VAULT)).notes, 'RED WHEN: a note the vault\'s notes do not hold is recorded').toEqual([]);
    expect(apart.kept.size, 'RED WHEN: a deposit the chain made is forgotten before it is recorded, however long ago it was sent').toBe(1);
    apart.w.notes.push(heldOf(apart.w.built[0]!));
    apart.w.events.set(HASH, [{ transactionHash: HASH, details: { tag: 'zswapOutput', commitment: outputOf(apart.w.built[0]!), contract: VAULT, mtIndex: '4' } }]);
    expect(await settleDepositInFlight(apart.doors, VAULT)).toMatchObject({ state: 'recorded', note: { createdIn: HASH } });

    /* The vault holds it and the transaction the service named shows some other coin: the note is recorded, with no transaction. */
    const other = await setUp();
    await depositIntoCompanyVault(other.doors, VAULT, MONEY).catch(() => undefined);
    other.w.notes.push(heldOf(other.w.built[0]!));
    other.w.events.set(HASH, [{ transactionHash: HASH, details: { tag: 'zswapOutput', commitment: 'ff'.repeat(32), contract: VAULT, mtIndex: '1' } }]);
    const settled = await settleDepositInFlight(other.doors, VAULT);
    expect(settled.state).toBe('recorded');
    const [note] = (await other.pool.load(VAULT)).notes;
    expect(note?.createdIn, 'RED WHEN: a transaction whose events do not show the note is recorded as its creator').toBeUndefined();
    expect((settled as { notYetSpendable?: string }).notYetSpendable, 'RED WHEN: a note that cannot be paid out yet is recorded silently')
      .toMatch(/does not show this deposit/);

    /* The service could not name the transaction: recorded with no transaction, and it says so. */
    const nameless = await setUp();
    nameless.w.depositAnswer = { txRef: 'p', transactionHash: null };
    const done = await depositIntoCompanyVault({ ...nameless.doors, pay: async (ask) => {
      nameless.w.notes.push(heldOf(nameless.w.built[0]!));
      return { transaction: `${ask.transaction}+coins`, leaves: [] };
    } }, VAULT, MONEY);
    expect(done.note.createdIn, 'RED WHEN: a hash the service never named is recorded').toBeUndefined();
    expect(done.notYetSpendable).toMatch(/could not find out which transfer/);
  });

  it('A DEPOSIT THE VAULT HOLDS WHOSE TRANSACTION CANNOT BE READ YET IS NOT RECORDED UNTIL IT CAN BE, OR UNTIL ITS TIME TO LIVE HAS PASSED', async () => {
    const t = await setUp();
    const e = await depositIntoCompanyVault({ ...t.doors, pay: async (ask) => {
      /* The note lands at once, and the indexer has not got the transaction's events. */
      t.w.notes.push(heldOf(t.w.built[0]!));
      return { transaction: `${ask.transaction}+coins`, leaves: [] };
    } }, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: the note is recorded with the service's hash before the chain's events confirm it. */
    expect(e).toBeInstanceOf(DepositLandedNotYetRecorded);
    expect((await t.pool.load(VAULT)).notes).toEqual([]);
    expect(t.kept.size, 'RED WHEN: it is forgotten while its note is unrecorded').toBe(1);
    await expect(settleDepositInFlight(t.doors, VAULT)).rejects.toBeInstanceOf(DepositLandedNotYetRecorded);
    /* Past its time to live, with the events still unreadable: recorded without a transaction, rather than blocking every later deposit. */
    t.later(DEPOSIT_TIME_TO_LIVE_MS + 1);
    const gaveUp = await settleDepositInFlight(t.doors, VAULT);
    expect(gaveUp, 'RED WHEN: a note the vault holds is kept waiting for ever on a transaction nobody can read')
      .toMatchObject({ state: 'recorded', notYetSpendable: expect.stringMatching(/could not read the transfer/) });
    expect((await t.pool.load(VAULT)).notes[0]?.createdIn).toBeUndefined();
    expect(t.kept.size).toBe(0);

    /* And when the events do come in time, the note is recorded under its own transaction. */
    const u = await setUp();
    await depositIntoCompanyVault({ ...u.doors, pay: async (ask) => {
      u.w.notes.push(heldOf(u.w.built[0]!));
      return { transaction: `${ask.transaction}+coins`, leaves: [] };
    } }, VAULT, MONEY).catch(() => undefined);
    u.w.events.set(HASH, [{ transactionHash: HASH, details: { tag: 'zswapOutput', commitment: outputOf(u.w.built[0]!), contract: VAULT, mtIndex: '4' } }]);
    expect(await settleDepositInFlight(u.doors, VAULT)).toMatchObject({ state: 'recorded', note: { createdIn: HASH } });
    expect(u.kept.size).toBe(0);
  });

  it('EVENTS THE VAULT WORKER CANNOT JUDGE, OR CANNOT JUDGE YET, LEAVE THE DEPOSIT UNRECORDED UNTIL THEY CAN BE, OR UNTIL ITS TIME TO LIVE HAS PASSED', async () => {
    const judges: Array<VaultBuilderClient['creatingTransaction']> = [
      async () => { throw new Error('the part of this page that builds vault transactions stopped'); },
      async () => ({ state: 'unreadable' }),
    ];
    for (const judge of judges) {
      const t = await setUp();
      t.b.creatingTransaction = judge;
      await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
      t.lands(t.w.built[0]!);
      await expect(settleDepositInFlight(t.doors, VAULT),
        'RED WHEN: a deposit whose events were not judged is recorded, or reported as never showing it').rejects.toBeInstanceOf(DepositLandedNotYetRecorded);
      expect((await t.pool.load(VAULT)).notes).toEqual([]);
      expect(t.kept.size).toBe(1);
      t.later(DEPOSIT_TIME_TO_LIVE_MS + 1);
      expect(await settleDepositInFlight(t.doors, VAULT), 'RED WHEN: an unjudged transaction is given the words of a refused one')
        .toMatchObject({ state: 'recorded', notYetSpendable: expect.stringMatching(/could not read the transfer/) });
    }
  });

  it('EVENTS SERVED UNDER ANOTHER TRANSACTION\'S HASH DO NOT NAME THE DEPOSIT\'S', async () => {
    const t = await setUp();
    await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
    t.lands(t.w.built[0]!);
    t.w.events.set(HASH, t.w.events.get(HASH)!.map((e) => ({ ...e, transactionHash: 'e2'.repeat(32) })));
    const settled = await settleDepositInFlight(t.doors, VAULT);
    expect((await t.pool.load(VAULT)).notes[0]?.createdIn,
      'RED WHEN: the page names the transaction from the events it was served rather than the one the service named').toBeUndefined();
    expect((settled as { notYetSpendable?: string }).notYetSpendable).toMatch(/does not show this deposit/);
  });

  it('THE VAULT WORKER NAMES THE CREATING TRANSACTION, REFUSES ONE WHOSE EVENTS DO NOT SHOW THE NOTE, AND CALLS NO EVENTS UNREADABLE', async () => {
    const own = [{ transactionHash: HASH, details: { tag: 'zswapOutput', commitment: 'aa'.repeat(32), contract: VAULT, mtIndex: '4' } }];
    const ask = (commitment: string, events: typeof own) => answerVaultAsk(async () => ({}) as never, {
      id: 3, network: 'undeployed', ask: 'creating-transaction', vault: VAULT, commitment, transactionHash: HASH, events,
    });
    expect(await ask('aa'.repeat(32), own), 'RED WHEN: the worker does not name the transaction its events show')
      .toEqual({ id: 3, ok: true, ask: 'creating-transaction', answer: { state: 'found', createdIn: HASH } });
    expect((await ask('bb'.repeat(32), own) as { answer: unknown }).answer, 'RED WHEN: events that do not show the note are not a refusal')
      .toEqual({ state: 'refused' });
    const another = own.map((e) => ({ ...e, transactionHash: 'e2'.repeat(32) }));
    expect((await ask('aa'.repeat(32), another) as { answer: unknown }).answer,
      'RED WHEN: events from a transaction other than the one named are taken as its own').toEqual({ state: 'refused' });
    expect(creatingTransactionOfNote({ vault: VAULT, commitment: 'aa'.repeat(32), transactionHash: HASH, events: [] }),
      'RED WHEN: no events at all is judged a refusal, which would record the note as never shown').toEqual({ state: 'unreadable' });

    /* Through the page's own client, with every answer copied as a message between threads is. */
    const listeners: Array<(event: { data: unknown }) => void> = [];
    const client = vaultBuilderOver({
      postMessage: (m) => {
        void answerVaultAsk(async () => ({}) as never, m as never).then((a) => listeners.forEach((l) => l({ data: structuredClone(a) })));
      },
      addEventListener: (_type, l) => { listeners.push(l); },
    }, 'undeployed');
    expect(await client.creatingTransaction({ vault: VAULT, commitment: 'aa'.repeat(32), transactionHash: HASH, events: own }),
      'RED WHEN: the page\'s client does not carry the worker\'s answer back').toEqual({ state: 'found', createdIn: HASH });
    expect(await client.creatingTransaction({ vault: VAULT, commitment: 'bb'.repeat(32), transactionHash: HASH, events: own }))
      .toEqual({ state: 'refused' });
  });

  it('A NOTE ANOTHER SIGNER ALREADY RECORDED IS NOT RECORDED TWICE, AND IS SETTLED WITHOUT ASKING THE CHAIN', async () => {
    const t = await setUp();
    await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
    const coin = t.w.built[0]!;
    t.lands(coin);
    const now = await t.pool.load(VAULT);
    await t.pool.save(VAULT, { notes: [...now.notes, { nonce: coin.nonce as never, token: MONEY.token, value: 7n, createdIn: HASH as never }] }, now.readAt);
    const reads = t.w.eventReads;
    expect(await settleDepositInFlight(t.doors, VAULT)).toEqual({ state: 'already-recorded' });
    expect(t.w.eventReads, 'RED WHEN: a deposit already in the record still waits on the chain\'s events').toBe(reads);
    expect((await t.pool.load(VAULT)).notes, 'RED WHEN: a note already in the record is added again').toHaveLength(1);
    expect(t.kept.size).toBe(0);
  });
});

describe('A PRIVATE PAYMENT OUT', () => {
  const wrapping = newWrappingKeypair();
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(3) };
  const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
  const TOKEN = 'ab'.repeat(32);
  const PAID_IN = 'dd'.repeat(32);
  const NOTE = { nonce: '01'.repeat(32), token: TOKEN, value: 500n, createdIn: '0e'.repeat(32) };
  const CHANGE = { nonce: 'cc'.repeat(32), token: TOKEN, value: 300n };
  const NOW = new Date(1_800_000_000_000);
  const order = (over: Partial<PrivatePaymentOrderOnTheWire> = {}, pay: Partial<PrivatePaymentOnTheWire> = {}): {
    order: PrivatePaymentOrderOnTheWire; payment: PrivatePaymentOnTheWire;
  } => {
    const payment: PrivatePaymentOnTheWire = {
      index: 0, kind: 'shielded', payee: 'mn_shield-addr_x', token: TOKEN, amount: '200', blinding: '0b'.repeat(32),
      nonce: '0c'.repeat(32), leaf: '0d'.repeat(32), path: [], paid: false, ...pay,
    };
    return {
      payment,
      order: {
        asset: 'TESTUSD', vault: VAULT, proposal: '0f'.repeat(32), salt: '5a'.repeat(32), root: '9a'.repeat(32),
        payees: '1', opensAt: '1799999000', closesAt: '1800009000', payments: [payment], ...over,
      },
    };
  };
  /** A pool holding one covered note the chain holds, and the doors over them. */
  const setUp = async (note: Record<string, unknown> = NOTE, chainNotes: string[] = [`h${NOTE.nonce.slice(1)}`]) => {
    paymentEvents.clear();
    const log: string[] = [];
    const s = new Map<WireRecord, MemorySealedPoolStore>();
    const records = (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
    await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers)
      .create(VAULT, { notes: [note as never] });
    const held = view({ heldByCommittee: true, fundable: true, notes: chainNotes });
    const doors = (over: Partial<VaultService> = {}, views = [held]) => ({
      ...pacing, now: () => NOW, me, myRecordsKey: 'ff'.repeat(32), records, signers,
      service: serviceFrom(views, log, over), builder: builder(log),
    });
    const pool = () => new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers);
    const notesNow = async () => (await pool().load(VAULT)).notes;
    const journal = async () => (await new PaymentJournalInStore(records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers).open()).attempts;
    return { log, doors, notesNow, journal, pool };
  };
  /** The payment's own events appear once it has been sent. */
  const landsWhenSent = (change: typeof CHANGE | null = CHANGE): Partial<VaultService> => ({
    payout: async () => {
      paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, change));
      return { txRef: 'o', transactionHash: PAID_IN };
    },
  });

  it('WRITES THE PAYMENT DOWN BEFORE IT IS BUILT OR SENT, AND ADVANCES THE POOL ONLY ON THIS PAYMENT\'S OWN EVENTS, UNDER ITS OWN HASH', async () => {
    /* RED WHEN: the journal line moves below the build or the send (the journal read inside the builder stand-in is
     * then empty); the pool is advanced before this payment's own events are read (the log then lacks that read);
     * or the change is saved under anything but this payment's hash. */
    const t = await setUp();
    let journalledBeforeBuild = -1;
    const b = t.doors(landsWhenSent());
    const build = b.builder.payout;
    b.builder.payout = async (i) => { journalledBeforeBuild = (await t.journal()).length; return build(i); };
    const done = await payPrivatelyFromCompanyVault(b, order());
    expect(journalledBeforeBuild).toBe(1);
    expect(t.log).toEqual([
      'choose', 'read events of 0e', 'read the block', 'build payout spending 01 with 1 event(s) at B1', 'read events of dd',
    ]);
    expect(done).toEqual({ txRef: 'o', transactionHash: PAID_IN, spent: NOTE.nonce, change: { ...CHANGE, value: '300' } });
    expect(await t.notesNow()).toEqual([{ ...CHANGE, createdIn: PAID_IN }]);
    const lines = await t.journal();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ spent: { nonce: NOTE.nonce, token: TOKEN, value: 500n }, amount: 200n });
  });

  it('A NOTE SPENT EXACTLY LEAVES NO CHANGE, AND THE POOL LOSES THE NOTE ONCE THE PAYMENT\'S OWN EVENTS SHOW IT', async () => {
    const t = await setUp();
    const done = await payPrivatelyFromCompanyVault(t.doors(landsWhenSent(null)), order({}, { amount: '500' }));
    expect(done.change).toBeNull();
    expect(await t.notesNow()).toEqual([]);
  });

  it('TWO PAYMENTS FROM ONE NOTE FOR ONE AMOUNT: THE ONE WHOSE OWN TRANSACTION THE CHAIN DOES NOT HOLD IS NOT RECORDED AS PAID', async () => {
    /*
     * The other payment landed and made exactly this payment's change coin, so the vault's notes read as though this
     * one had. RED WHEN: the pool is advanced on what the vault holds rather than on this payment's own events - it is
     * then advanced, and its change recorded under a transaction that never landed.
     */
    const t = await setUp();
    const e = await payPrivatelyFromCompanyVault(t.doors({
      payout: async () => {
        paymentEvents.set('a1'.repeat(32), await eventsOfAPayment('a1'.repeat(32), CHANGE));
        return { txRef: 'o', transactionHash: PAID_IN };
      },
    }), order()).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect(await t.notesNow()).toEqual([NOTE]);
  });

  it('A PAYMENT WHOSE OWN EVENTS DO NOT CARRY THE CHANGE, OR PAY NOBODY, IS NOT RECORDED, AND SAYS AT ONCE IT IS NOT AS BUILT', async () => {
    /* RED WHEN: the confirmation stops requiring the change among this transaction's own outputs, or a person's output;
     * or the wait reads a transaction that is there and not as built as "not yet". */
    const noChange = await setUp();
    const e1 = await payPrivatelyFromCompanyVault(noChange.doors({
      payout: async () => { paymentEvents.set(PAID_IN, await eventsOfAPayment(PAID_IN, null)); return { txRef: 'o', transactionHash: PAID_IN }; },
    }), order()).catch((x) => x);
    expect(e1).toBeInstanceOf(PaymentNotAsBuilt);
    expect(e1.message).toMatch(/did not create this note/);
    expect(noChange.log.filter((l) => l === 'read events of dd')).toHaveLength(1);
    expect(await noChange.notesNow()).toEqual([NOTE]);
    const nobody = await setUp();
    const e2 = await payPrivatelyFromCompanyVault(nobody.doors({
      payout: async () => {
        paymentEvents.set(PAID_IN, (await eventsOfAPayment(PAID_IN, CHANGE)).filter((ev) => ev.details.commitment !== 'f0'.repeat(32)));
        return { txRef: 'o', transactionHash: PAID_IN };
      },
    }), order()).catch((x) => x);
    expect(e2).toBeInstanceOf(PaymentNotAsBuilt);
    expect(e2.message).toMatch(/paid nobody/);
    expect(await nobody.notesNow()).toEqual([NOTE]);
  });

  it('THE CONFIRMATION READS ONLY THIS TRANSACTION\'S OWN EVENTS, AND NONE IS NOT AN ANSWER', async () => {
    /* RED WHEN: events of another transaction are accepted among these, or an empty answer is read as landed. */
    const own = await eventsOfAPayment(PAID_IN, CHANGE);
    const change = { ...CHANGE, value: '300' };
    await expect(confirmPayment({ vault: VAULT, transactionHash: PAID_IN, change, events: own }))
      .resolves.toEqual({ state: 'landed', createdIn: PAID_IN });
    const mixed = [...own.slice(0, 2), { ...own[2]!, transactionHash: 'a1'.repeat(32) }];
    await expect(confirmPayment({ vault: VAULT, transactionHash: PAID_IN, change, events: mixed }))
      .resolves.toEqual({ state: 'not-as-built', why: expect.stringMatching(/not all its own/) });
    await expect(confirmPayment({ vault: VAULT, transactionHash: PAID_IN, change: null, events: [] }))
      .resolves.toEqual({ state: 'not-yet' });
    /* The change must be this vault's: the same output for another contract is not it. */
    await expect(confirmPayment({ vault: 'ee'.repeat(32), transactionHash: PAID_IN, change, events: own }))
      .resolves.toMatchObject({ state: 'not-as-built' });
  });

  it('A PERSON THE ACCOUNT ALREADY RECORDS PAID, OR A WINDOW THAT IS NOT OPEN, IS REFUSED BEFORE THE POOL IS OPENED', async () => {
    /* RED WHEN: either early refusal is removed - the log then carries 'choose' and a journal line is written. */
    const paid = await setUp();
    await expect(payPrivatelyFromCompanyVault(paid.doors(), order({}, { paid: true }))).rejects.toThrow(/already records this person paid/);
    const early = await setUp();
    await expect(payPrivatelyFromCompanyVault(early.doors(), order({ opensAt: '1800000001' }))).rejects.toThrow(/not open now/);
    const late = await setUp();
    await expect(payPrivatelyFromCompanyVault(late.doors(), order({ closesAt: '1800000000' }))).rejects.toThrow(/not open now/);
    for (const t of [paid, early, late]) {
      expect(t.log).toEqual([]);
      expect(await t.journal()).toEqual([]);
    }
  });

  it('A VAULT THE COMMITTEE DOES NOT HOLD IS NOT OPENED HERE, AND NOTHING IS WRITTEN', async () => {
    /* RED WHEN: the `heldByCommittee` check is removed - the pool is then opened and a note chosen. */
    const t = await setUp();
    const e = await payPrivatelyFromCompanyVault(t.doors({}, [oneKey]), order()).catch((x) => x);
    expect(e.message).toMatch(/does not read this vault as held by the company's committee/);
    expect(e.message).toMatch(/sign the change in Settings/);
    expect(t.log).toEqual([]);
    expect(await t.journal()).toEqual([]);
  });

  it('A VAULT THE SERVICE WOULD NOT PAY OUT OF IS NOT OPENED HERE, AND NOTHING IS WRITTEN OR PROVED', async () => {
    /*
     * The committee holds the vault, and the company's account is still held by
     * the key it was created with, so the service refuses the payment when it
     * arrives. RED WHEN: the `fundable` check is removed or moved below the
     * journal line - the pool is then opened, a note chosen and a line written
     * for a payment that could never be sent.
     */
    const t = await setUp();
    const notVouched = view({
      heldByCommittee: true, fundable: false, notes: [`h${NOTE.nonce.slice(1)}`],
      why: 'this company\'s account is still held by the temporary key it was created with.',
    });
    /* RED WHEN: the check moves below opening the pool - this door's records are then read at all. */
    const unopened = { ...t.doors({}, [notVouched]), records: () => { throw new Error('the pool was opened'); } };
    const e = await payPrivatelyFromCompanyVault(unopened as never, order()).catch((x) => x);
    expect(e.message).toMatch(/^No payment can be made out of this vault yet/);
    expect(e.message).toMatch(/still held by the temporary key it was created with/);
    expect(e.message).toMatch(/Nothing was sent\./);
    expect(t.log).toEqual([]);
    expect(await t.journal()).toEqual([]);
    /* RED WHEN: a view that says nothing about the account is read as fundable. */
    const unsaid = view({ heldByCommittee: true, notes: [`h${NOTE.nonce.slice(1)}`] });
    await expect(payPrivatelyFromCompanyVault(t.doors({}, [unsaid]), order())).rejects.toThrow(/^No payment can be made out of this vault yet/);
    expect(t.log).toEqual([]);
  });

  it('A NOTE THAT DOES NOT NAME ITS TRANSACTION IS NOT SPENT, AND NOTHING IS WRITTEN OR SENT', async () => {
    /* RED WHEN: the `createdIn` check is removed - the events are then read for `undefined` and a line is journalled. */
    const { createdIn: _none, ...unnamed } = NOTE;
    const t = await setUp(unnamed);
    await expect(payPrivatelyFromCompanyVault(t.doors(), order())).rejects.toThrow(/does not record which transaction created it/);
    expect(t.log).toEqual(['choose']);
    expect(await t.journal()).toEqual([]);
  });

  it('A NOTE THE CHAIN NO LONGER HOLDS IS NOT SPENT AGAIN: A PAYMENT FROM IT LANDED THAT THE RECORD DOES NOT SHOW', async () => {
    /* RED WHEN: the chosen note is not checked against what the chain holds - a line is journalled and a payment built. */
    const t = await setUp(NOTE, [`h${'cc'.repeat(32).slice(1)}`]);
    await expect(payPrivatelyFromCompanyVault(t.doors(landsWhenSent()), order())).rejects.toThrow(/a payment from it has landed that this record does not show/);
    expect(t.log).toEqual(['choose']);
    expect(await t.journal()).toEqual([]);
  });

  it('A PAYMENT WHOSE OWN TRANSACTION THE CHAIN HAS NOT SHOWN LEAVES THE POOL AS IT WAS, AND SAYS THE MONEY MAY HAVE MOVED', async () => {
    /* RED WHEN: the wait is removed or accepts anything - the pool then loses the note the chain still holds. */
    const t = await setUp();
    const e = await payPrivatelyFromCompanyVault(t.doors(), order()).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect(e.message).toMatch(/Do not pay this person again/);
    expect(await t.notesNow()).toEqual([NOTE]);
    expect(await t.journal()).toHaveLength(1);
  });

  it('A SEND THE SERVICE REFUSED CHANGES NOTHING AND SAYS SO; A SEND THAT MAY HAVE LANDED SAYS THE MONEY MAY HAVE MOVED', async () => {
    /* RED WHEN: a failure the service did not mark as nothing sent is passed through as it came - a screen then says
     * the payment did not finish and offers the person again. */
    const t = await setUp();
    const refused = Object.assign(new Error('this is not a private payment. Nothing was sent.'), { nothingWasSent: true });
    await expect(payPrivatelyFromCompanyVault(t.doors({ payout: async () => { throw refused; } }), order()))
      .rejects.toThrow('this is not a private payment. Nothing was sent.');
    const lost = Object.assign(new Error('the node did not answer'), { nothingWasSent: false });
    const e = await payPrivatelyFromCompanyVault(t.doors({ payout: async () => { throw lost; } }), order()).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentNotYetSeen);
    expect(e.message).toMatch(/the node did not answer/);
    expect(await t.notesNow()).toEqual([NOTE]);
  });

  it('A SEND THE SERVICE CANNOT NAME, OR A RECORD THAT CANNOT BE WRITTEN AFTER IT LANDED, SAYS THE MONEY MAY HAVE MOVED', async () => {
    /* RED WHEN: a failure after the send reaches the screen as an ordinary error. */
    const unnamed = await setUp();
    const e1 = await payPrivatelyFromCompanyVault(unnamed.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }), order()).catch((x) => x);
    expect(e1).toBeInstanceOf(PaymentNotYetSeen);
    expect(e1.message).toMatch(/could not name the transaction/);
    expect(await unnamed.notesNow()).toEqual([NOTE]);
    const unwritable = await setUp();
    const b = unwritable.doors(landsWhenSent());
    b.builder.afterPayment = async () => { throw new Error('the pool refused the write'); };
    const e2 = await payPrivatelyFromCompanyVault(b, order()).catch((x) => x);
    /* A part of this page that stops answering after the send is not a payment that did not happen. */
    const stopped = await setUp();
    const c = stopped.doors(landsWhenSent());
    c.builder.confirmPayment = async () => { throw new Error('the part of this page that builds vault transactions stopped'); };
    const e3 = await payPrivatelyFromCompanyVault(c, order()).catch((x) => x);
    expect(e3).toBeInstanceOf(PaymentNotYetSeen);
    expect(e3.message).toMatch(/stopped/);
    /* RED WHEN: a write that fails after the payment was confirmed is reported as a payment not seen. */
    expect(e2).toBeInstanceOf(PaymentLandedUnrecorded);
    expect(e2.message).toMatch(/the pool refused the write/);
    expect(e2.message).toMatch(/The person is paid/);
  });

  it('A NOTE ANOTHER WRITER ADDED WHILE THE PAYMENT PROVED IS KEPT: THE CHANGE IS APPLIED TO THE POOL AS IT STANDS', async () => {
    /* RED WHEN: the save is built on the copy loaded before the payment - it is then refused as a lost race five
     * times over, or, without the version check, the other writer's note is dropped. */
    const t = await setUp();
    const b = t.doors(landsWhenSent());
    const send = b.service.payout;
    b.service.payout = async (v, tx) => {
      const now = await t.pool().load(VAULT);
      await t.pool().save(VAULT, { notes: [...now.notes, { nonce: '02'.repeat(32), token: TOKEN, value: 9n }] }, now.readAt);
      return send(v, tx);
    };
    await payPrivatelyFromCompanyVault(b, order());
    expect((await t.notesNow()).map((n) => n.nonce).sort()).toEqual(['02'.repeat(32), 'cc'.repeat(32)]);
  });
});

describe('A PUBLIC PAYMENT OUT', () => {
  const NOW = new Date(1_800_000_000_000);
  const TOKEN = '00'.repeat(32);
  const order = (pay: Partial<PrivatePaymentOnTheWire> = {}) => {
    const payment: PrivatePaymentOnTheWire = {
      index: 0, kind: 'unshielded', payee: 'mn_addr_x', token: TOKEN, amount: '250', blinding: '0b'.repeat(32),
      nonce: '0c'.repeat(32), leaf: '0d'.repeat(32), path: [], paid: false, ...pay,
    };
    return {
      payment,
      order: {
        asset: 'NIGHT', vault: VAULT, proposal: '0f'.repeat(32), salt: '5a'.repeat(32), root: '9a'.repeat(32),
        payees: '1', opensAt: '1799999000', closesAt: '1800009000', payments: [payment],
      } as PrivatePaymentOrderOnTheWire,
    };
  };
  const doorsFor = (log: string[], answers: Array<boolean | null>, over: Partial<VaultService> = {}) => {
    let i = 0;
    return {
      ...pacing, now: () => NOW,
      service: serviceFrom([view({ heldByCommittee: true, fundable: true })], log, over),
      builder: builder(log),
      paidYet: async () => { log.push('asked the account'); return answers[Math.min(i++, answers.length - 1)]!; },
    };
  };

  it('BUILDS THE VAULT\'S PUBLIC PAYOUT, SENDS IT THROUGH THE PUBLIC DOOR, AND IS DONE WHEN THE ACCOUNT RECORDS IT', async () => {
    const log: string[] = [];
    const done = await payPubliclyFromCompanyVault(doorsFor(log, [false, true]), order());
    /* RED WHEN: a public payment chooses a note, reads a note's events, goes out through the private door, or
     * reports done before the company's account records it. */
    expect(log).toEqual([
      'read the block', 'build public payout of 250 to mn_addr_x at B1', 'sent public payout',
      'asked the account', 'asked the account',
    ]);
    expect(done).toEqual({ txRef: 'u' });
  });

  it('A PRIVATE PAYMENT IS NEVER PAID PUBLICLY, AND A PUBLIC ONE NEVER PRIVATELY', async () => {
    const log: string[] = [];
    /* RED WHEN: the public operation takes a payment the leg names as private - it would send a private payee public money. */
    await expect(payPubliclyFromCompanyVault(doorsFor(log, [true]), order({ kind: 'shielded', payee: 'mn_shield-addr_x' })))
      .rejects.toThrow(/^this payment is not a public one, so it is not paid publicly\. Nothing was sent\.$/);
    expect(log).toEqual([]);
    /* RED WHEN: the private operation takes a payment the leg names as public - it would spend a note on a public payee's leaf. */
    const wrapping = newWrappingKeypair();
    await expect(payPrivatelyFromCompanyVault({
      ...pacing, now: () => NOW, me: { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32) },
      myRecordsKey: 'ff'.repeat(32), records: () => new MemorySealedPoolStore(),
      signers: async () => [], service: serviceFrom([view({ heldByCommittee: true, fundable: true })], log), builder: builder(log),
    }, order())).rejects.toThrow(/^this payment is not a private one, so it is not paid privately\. Nothing was sent\.$/);
    expect(log).toEqual([]);
  });

  it('IS NOT SENT FOR SOMEBODY THE ACCOUNT ALREADY RECORDS PAID, OR OUTSIDE THE APPROVED WINDOW', async () => {
    const log: string[] = [];
    /* RED WHEN: a public payee the account already records paid is offered a second payment. */
    await expect(payPubliclyFromCompanyVault(doorsFor(log, [true]), order({ paid: true })))
      .rejects.toThrow(/already records this person paid/);
    const late = { ...doorsFor(log, [true]), now: () => new Date(1_900_000_000_000) };
    /* RED WHEN: the window the signers approved is not asked before a public payment is built. */
    await expect(payPubliclyFromCompanyVault(late, order())).rejects.toThrow(/only inside the window/);
    expect(log).toEqual([]);
  });

  it('A FAILURE AFTER THE SEND IS NEVER REPORTED AS A PAYMENT THAT DID NOT HAPPEN', async () => {
    const log: string[] = [];
    /* RED WHEN: an account that never records the payment is read as the payment not having been made. */
    const e = await payPubliclyFromCompanyVault(doorsFor(log, [false]), order()).catch((x) => x);
    expect(e).toBeInstanceOf(PublicPaymentNotYetSeen);
    expect(e.message).toMatch(/^the payment may have been sent \(u\) and this device has not seen it land, so it may still land\. Do not pay this person again/);
    /* A refusal before anything was sent says so, and is not dressed up as a payment that may have moved. */
    const refused = Object.assign(new Error('this is not a public payment. Nothing was sent.'), { nothingWasSent: true });
    await expect(payPubliclyFromCompanyVault(doorsFor([], [true], { payoutPublicly: async () => { throw refused; } }), order()))
      .rejects.toBe(refused);
    const lost = await payPubliclyFromCompanyVault(
      doorsFor([], [true], { payoutPublicly: async () => { throw new Error('the socket closed'); } }), order()).catch((x) => x);
    /* RED WHEN: a send that may have reached the chain is reported as nothing sent. */
    expect(lost).toBeInstanceOf(PublicPaymentNotYetSeen);
  });
});
