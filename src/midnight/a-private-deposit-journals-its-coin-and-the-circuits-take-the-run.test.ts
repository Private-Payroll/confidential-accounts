/*
 * A private deposit journals its coin before the call, the product's store keeps what the
 * client wrote, and the circuits take the run, the path and the secret as they stand.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sealedOf } from './vault-pool.js';
import { DepositCoinAlreadyMade, depositNonceAt, depositNonceKeyFor } from './deposit-nonce.js';
import { pureCircuits as vaultCircuits } from '../../contracts/managed-vault/contract/index.js';
import { readFileSync } from 'node:fs';
import { toHex } from '../core/crypto.js';
import { BY, EVENTS, eventsInUse, GBP, harness, itemAt, NIGHT, PATH, PAYEE, payHash, payment, PUBLIC_PAYEE, SECRET, VAULT } from './a-vault-ledger-on-a-fake-chain.test-support.js';

/**
 * **JOURNALLING A DEPOSIT IS THE LEDGER'S, NOT A HABIT OF ONE DOOR.** The same
 * four facts the payment's journal is held to: the coin is recorded, before the
 * call, whole, and a ledger with nowhere to record it refuses rather than
 * deposits.
 */
describe('a private deposit journals its coin before the call', () => {
  const MONEY = { token: GBP, value: 500n };
  const COIN = { nonce: '77'.repeat(32), ...MONEY };

  it('REFUSES A VAULT CARRYING ITS OWN RETIRED MARK BEFORE ANY COIN IS JOURNALLED OR ANY CALL MADE', async () => {
    const { ledger, depositsJournalled, calls } = harness({ notes: [], retired: true });
    /* RED WHEN: a private deposit into a retired vault journals a coin and calls the vault, which refuses it. */
    await expect(ledger.deposit(VAULT, MONEY, BY)).rejects.toThrow(/this vault has been retired, so it takes no more money/);
    expect(depositsJournalled).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('records the coin it is about to create, whole, BEFORE the deposit call and before the pool write', async () => {
    const { ledger, depositsJournalled, calls, current } = harness({ notes: [] });
    await ledger.deposit(VAULT, MONEY, BY);
    expect(depositsJournalled).toHaveLength(1);
    expect(
      itemAt(depositsJournalled, 0).callsMadeSoFar,
      'RED WHEN: the deposit\'s line is written after the call -- a nonce recorded after the money moved is not on disk when the process stops in between, which is the only moment this record exists for',
    ).toBe(0);
    expect(itemAt(depositsJournalled, 0).savesMadeSoFar).toBe(0);
    expect(itemAt(depositsJournalled, 0).slot, 'RED WHEN: the first slot is not the one after everything the chain has made for this vault').toBe(1);
    expect(calls.map((c) => c.circuit)).toEqual(['deposit']);
    expect(
      itemAt(depositsJournalled, 0).coin,
      'RED WHEN: the line is not the coin the call creates -- a different nonce or value names a note the chain never held, and the real one stays unnameable',
    ).toEqual(COIN);
    expect(Number.isNaN(Date.parse(itemAt(depositsJournalled, 0).attemptedAt))).toBe(false);
    expect(current().notes.map((n) => n.nonce)).toEqual([COIN.nonce]);
  });

  it('CALLS THE CONTRACT WITH THE COIN THE CLAIM RETURNED, and with no nonce of its own', async () => {
    const { ledger, calls, current } = harness({ notes: [], depositNonces: ['5a'.repeat(32)] });
    await ledger.deposit(VAULT, MONEY, BY);
    const made: any = itemAt(calls, 0).args[0];
    expect(
      toHex(made.nonce),
      'RED WHEN: the deposit is made under any nonce but the one its claim filed -- a note whose line names another coin can only be named by luck',
    ).toBe('5a'.repeat(32));
    expect(current().notes.map((n) => n.nonce)).toEqual(['5a'.repeat(32)]);
  });

  it('A COIN THE CHAIN HAS ALREADY MADE AND SPENT IS NOT ATTEMPTED AGAIN: the claim moves on, and the coin made is the next one', async () => {
    /*
     * A deposit of the same amount landed, and was spent, after this one read
     * the vault: the coin at this slot exists and is in no note set now, so only
     * the vault's whole history can see it. The ledger would refuse to create it
     * again, after the proof and the submission; this refuses it before either,
     * passes over that slot with no line filed, and claims the next.
     */
    const { ledger, calls, current, depositsJournalled } = harness({ notes: [], history: ['77'.repeat(32)] });
    await ledger.deposit(VAULT, MONEY, BY);
    expect(
      depositsJournalled.map((d) => d.coin.nonce),
      'RED WHEN: the coin the chain already made is claimed, or a line is filed for it',
    ).toEqual(['78'.repeat(32)]);
    expect(
      depositsJournalled.map((d) => d.slot),
      'RED WHEN: the slot claimed is not the lowest one whose coin was never made',
    ).toEqual([2]);
    expect(
      toHex((itemAt(calls, 0).args[0] as any).nonce),
      'RED WHEN: the history is not read, or only the notes held NOW are, so a spent coin is attempted a second time',
    ).toBe('78'.repeat(32));
    expect(calls).toHaveLength(1);
    expect(current().notes.map((n) => n.nonce)).toEqual(['78'.repeat(32)]);
  });

  it('a coin the POOL already holds under that nonce, or the vault HOLDS NOW, is not made again either', async () => {
    const pooled = harness({ notes: [{ nonce: '77'.repeat(32), value: 9n }] });
    const outcome = await pooled.ledger.deposit(VAULT, MONEY, BY).then(() => 'deposited', (e: unknown) => String(e));
    expect(
      [outcome, pooled.calls.map((c) => toHex((c.args[0] as any).nonce))],
      'RED WHEN: a nonce the pool already holds is deposited under, so the pool write refuses after the money has moved',
    ).toEqual(['deposited', ['78'.repeat(32)]]);

    const held = harness({ notes: [], chain: [{ nonce: '77'.repeat(32), value: 500n }], history: [] });
    await held.ledger.deposit(VAULT, MONEY, BY);
    expect(
      held.depositsJournalled.map((d) => d.coin.nonce),
      'RED WHEN: a coin the vault holds now is claimed a second time',
    ).toEqual(['78'.repeat(32)]);
    expect(held.calls.every((c) => toHex((c.args[0] as any).nonce) !== '77'.repeat(32))).toBe(true);
  });

  it('REFUSES, AND CALLS NOTHING, when every slot tried names a coin that already exists', async () => {
    /* Slots 1 to 3 made before; the vault holds the coins at 4, 5 and 6 now; a rebuild of three outputs walks to 6. */
    const { ledger, calls, saves, depositsJournalled } = harness({
      notes: [], history: ['77'.repeat(32), '78'.repeat(32), '79'.repeat(32)],
      chain: ['7a', '7b', '7c'].map((h) => ({ nonce: h.repeat(32), value: MONEY.value })),
    });
    const refused = await ledger.deposit(VAULT, MONEY, BY).then(() => undefined, (e: unknown) => e);
    expect(refused, 'RED WHEN: the claims stop being bounded, or the last collision is deposited anyway')
      .toBeInstanceOf(DepositCoinAlreadyMade);
    expect((refused as Error).message, 'RED WHEN: the refusal stops naming what resolves it')
      .toMatch(/read the vault again, and deposit again/);
    expect(calls, 'RED WHEN: a refused deposit reaches the contract').toEqual([]);
    expect(saves).toHaveLength(0);
    expect(depositsJournalled, 'RED WHEN: a line is filed although no slot a rebuild walks was free').toEqual([]);
  });

  it('REFUSES a private deposit by name when the ledger has nowhere to write the coin, and calls nothing', async () => {
    const { ledger, calls, saves } = harness({ notes: [], depositJournal: 'none' });
    await expect(
      ledger.deposit(VAULT, MONEY, BY),
      'RED WHEN: a ledger built without a deposit journal deposits anyway -- the first private deposit through any caller but the door reopens the crash window with nothing red',
    ).rejects.toThrow(/nowhere to write it/);
    await expect(ledger.deposit(VAULT, MONEY, BY), 'RED WHEN: the refusal stops naming what resolves it, in terms the reader can act on')
      .rejects.toThrow(/Construct the ledger with a deposit journal/);
    expect(calls, 'RED WHEN: the refusal arrives after the call').toEqual([]);
    expect(saves).toHaveLength(0);
  });

  it('REFUSES by name when the ledger cannot read what the chain has made for the vault, and FILES NOTHING', async () => {
    for (const history of ['none', 'unreadable'] as const) {
      const { ledger, calls, depositsJournalled } = harness({ notes: [], history });
      await expect(
        ledger.deposit(VAULT, MONEY, BY),
        `RED WHEN (${history}): a deposit goes ahead without knowing whether its coin already exists`,
      ).rejects.toThrow(history === 'none' ? /Construct the ledger with the vault's output history/ : /cannot be listed/);
      expect(calls).toEqual([]);
      expect(depositsJournalled, `RED WHEN (${history}): the history is read after a line is filed, so every unreadable read leaves a line`).toHaveLength(0);
    }
  });

  it('a deposit journal that cannot be written STOPS the deposit with nothing spent', async () => {
    const { ledger, calls, saves } = harness({ notes: [], depositJournal: 'refuses' });
    await expect(ledger.deposit(VAULT, MONEY, BY))
      .rejects.toThrow(/deposit journal cannot be written/);
    expect(calls, 'RED WHEN: a journal failure is swallowed and the deposit goes ahead unjournalled').toEqual([]);
    expect(saves).toHaveLength(0);
  });

  it('a deposit of nothing journals NOTHING: the pre-flight comes first', async () => {
    const { ledger, depositsJournalled, calls } = harness({ notes: [] });
    await expect(ledger.deposit(VAULT, { token: GBP, value: 0n }, BY)).rejects.toThrow(/not a deposit/);
    expect(calls).toEqual([]);
    expect(
      depositsJournalled,
      'RED WHEN: the line is written before the pre-flight, so every refused deposit leaves a line naming a coin nobody tried to make',
    ).toHaveLength(0);
  });

  it('a PUBLIC deposit writes no deposit line and needs no deposit journal', async () => {
    const { ledger, depositsJournalled, calls } = harness({ poolThrows: true, depositJournal: 'none' });
    await ledger.depositUnshielded(VAULT, { token: NIGHT, amount: 10n }, BY);
    expect(calls.map((c) => c.circuit)).toEqual(['depositUnshielded']);
    expect(depositsJournalled, 'RED WHEN: a public deposit is journalled or refused for want of a journal -- it creates no note').toHaveLength(0);
  });

  it('a PRIVATE PAYMENT needs no deposit journal, and a deposit needs no payment journal', async () => {
    const paying = harness({ depositJournal: 'none' });
    await expect(paying.ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET)).resolves.toBeDefined();
    const depositing = harness({ notes: [], journal: 'none' });
    await expect(depositing.ledger.deposit(VAULT, MONEY, BY)).resolves.toBeDefined();
    expect(depositing.depositsJournalled).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * THE PRODUCT'S OWN STORE, WATCHED FROM THE CLIENT. A pool created, a
 * deposit recorded into it and a private payment made against it, through
 * `VaultLedger` with the pool and both journals kept in the product's
 * database - and then everything read back by a second connection that
 * shares nothing with the first, and rebuilt from.
 * ------------------------------------------------------------------ */
const STORE_DB = process.env.TEST_DATABASE_URL;
(STORE_DB ? describe : describe.skip)('the product\'s store, from where a person stands', () => {
  const OWN_DB = 'ca_test_vault_client';
  let admin: any;
  let url: string;

  beforeAll(async () => {
    const { default: postgres } = await import('postgres');
    admin = postgres(STORE_DB!, { onnotice: () => {} });
    const [row] = await admin`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${OWN_DB}`;
    if (row.n === 0) await admin.unsafe(`CREATE DATABASE "${OWN_DB}"`);
    const u = new URL(STORE_DB!);
    u.pathname = `/${OWN_DB}`;
    url = u.toString();
    /*
     * THIS DATABASE IS THIS TEST'S ALONE, AND IT STARTS EMPTY. The vault's
     * address is a constant of this file, so a record left by an earlier run
     * would make `create` refuse. A table is dropped, which its triggers do not
     * stop, and nothing else uses this database.
     */
    const own = postgres(url, { onnotice: () => {} });
    const [me] = await own`SELECT current_database() AS db`;
    if (me?.db !== OWN_DB) throw new Error(`refusing to run: connected to ${me?.db}, not ${OWN_DB}`);
    await own`DROP TABLE IF EXISTS vault_sealed_records`;
    await own.unsafe(readFileSync('db/migrations/0002_vault_sealed_records.sql', 'utf8'));
    await own.end({ timeout: 2 });
  });
  afterAll(async () => { if (admin) await admin.end({ timeout: 2 }); });

  it('CREATES, DEPOSITS AND PAYS through the ledger with every record in the database, and a second connection rebuilds the vault from them', async () => {
    const { default: postgres } = await import('postgres');
    const { openVaultRecords, NOTHING_IS_KEPT_ELSEWHERE } = await import('../db/vault-records.js');
    const { SealedNotePool, openPool } = await import('./vault-pool.js');
    const { PaymentJournalInStore, DepositJournalInStore, attemptsFromJournalVersions } = await import('./vault-journal.js');
    const { reconcileVaultPool, commitmentForNote } = await import('./vault-recovery.js');
    const { newWrappingKeypair } = await import('../core/crypto.js');

    const k = newWrappingKeypair();
    const signers = async () => [{ id: 'kc', wrappingPublicKey: k.publicKey }];
    const opener = { id: 'kc', wrappingSecret: k.secret };
    const nonces = depositNonceKeyFor(new Uint8Array(32).fill(7), VAULT);
    const DERIVED = depositNonceAt(nonces, { token: GBP, value: 500n }, 1);
    const one = postgres(url, { onnotice: () => {} });
    const other = postgres(url, { onnotice: () => {} });
    try {
      const records = await openVaultRecords(one, { refuseToCreate: NOTHING_IS_KEPT_ELSEWHERE });
      const h = harness({
        notes: [],
        poolExists: false,
        keptIn: {
          pool: new SealedNotePool(records.of('pool'), { signerId: 'kc', wrappingSecret: k.secret }, signers),
          payments: new PaymentJournalInStore(records.of('payment-journal'), VAULT, opener, signers),
          deposits: new DepositJournalInStore(records.of('deposit-journal'), VAULT, opener, signers, nonces),
        },
      });

      await h.ledger.openPool(VAULT);
      await h.ledger.deposit(VAULT, { token: GBP, value: 500n }, BY, eventsInUse);
      const paid = await h.ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);
      if (paid.kind !== 'shielded') throw new Error('a private payee was paid through another door');
      expect(paid.spentNote).toBe(DERIVED);

      /* A second connection, and a store object that shares nothing with the one that wrote. */
      const theirs = await openVaultRecords(other, { refuseToCreate: NOTHING_IS_KEPT_ELSEWHERE });
      const versions = await theirs.of('pool').versions(VAULT);
      expect(
        versions.map((v) => v.version),
        'RED WHEN: the pool the client created, deposited into and paid from is not the record the database holds - one version per write',
      ).toEqual([1, 2, 3]);
      const now = openPool(sealedOf(versions[2]!), 'kc', k.secret);
      expect(now.notes.map((n) => [n.value, n.createdIn]),
        'RED WHEN: the change note the payment made is not what the store now says the vault holds').toEqual([[300n, payHash(1)]]);

      const attempted = attemptsFromJournalVersions({
        deposits: await theirs.of('deposit-journal').versions(VAULT),
        payments: await theirs.of('payment-journal').versions(VAULT),
        opener,
      });
      expect(attempted.deposits, 'RED WHEN: the deposit was made without its coin written down first, in the store')
        .toEqual([{ nonce: DERIVED, token: GBP, value: 500n }]);
      expect(attempted.payments, 'RED WHEN: the payment moved money without its amount written down first, in the store')
        .toEqual([{ spent: { nonce: DERIVED, token: GBP, value: 500n }, amount: 200n }]);

      /* And the rebuild, from nothing but what the store holds and what the chain holds. */
      const change = now.notes[0]!;
      const rebuilt = reconcileVaultPool({
        vault: VAULT as never,
        chain: [commitmentForNote(vaultCircuits as never, VAULT as never, change)],
        versions: versions.map((v) => ({ version: v.version, notes: openPool(sealedOf(v), 'kc', k.secret).notes })),
        attempted,
        circuits: vaultCircuits as never,
      });
      expect(rebuilt.held.map((n) => n.value)).toEqual([300n]);
      expect(rebuilt.unexplained).toEqual([]);
    } finally {
      await one.end({ timeout: 2 });
      await other.end({ timeout: 2 });
    }
  });
});

/*
 * **THE APPROVED RUN, THE PAYEE'S PATH AND THE VAULT'S SECRET REACH THE CIRCUIT
 * AS THE CONTRACT TAKES THEM.**
 *
 * Both payment circuits take the run as one value, and the account rebuilds
 * the proposal and the run's root from it. A field dropped or swapped here is a
 * payment the account refuses after a proof and a fee; a secret not handed over
 * is a private payment that cannot be proved at all.
 */
describe('the run, the path and the secret, as the vault circuits take them', () => {
  const expectedRun = () => ({
    proposal: Buffer.from('11'.repeat(32), 'hex'), runVault: Buffer.from(VAULT, 'hex'),
    root: Buffer.from('22'.repeat(32), 'hex'), payees: 3n,
    opensAt: 1_800_000_000n, closesAt: 1_800_604_800n, required: 2n,
    salt: Buffer.from('33'.repeat(32), 'hex'), nonce: Buffer.from('66'.repeat(32), 'hex'),
    asset: Buffer.from(GBP, 'hex'), path: PATH,
  });
  const asPlain = (run: any) => Object.fromEntries(Object.entries(run).map(([k, v]) =>
    [k, v instanceof Uint8Array ? toHex(v) : v]));

  it('a private payment hands the circuit the whole run, the payee, and the vault\'s current secret', async () => {
    const { ledger, calls, secretsRead } = harness();
    await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);
    const call = calls.find((c) => c.circuit === 'payout')!;
    /* RED WHEN a field of the run is dropped, renamed, swapped with another, or a step of the path is lost or rewritten. */
    expect(asPlain(call.args[0])).toEqual(asPlain(expectedRun()));
    /* RED WHEN the recipient, token, amount or blinding moves, or is taken from somewhere other than the payment. */
    expect([toHex(call.args[1] as Uint8Array), toHex(call.args[2] as Uint8Array), call.args[3], toHex(call.args[4] as Uint8Array)])
      .toEqual([PAYEE.coinPublicKey, GBP, 200n, '55'.repeat(32)]);
    /* RED WHEN the secret the caller supplied is not the one the circuit is handed. */
    expect(secretsRead).toEqual([SECRET]);
  });

  it('a public payment hands its circuit the same run, and never reads a secret', async () => {
    const { ledger, calls, secretsRead } = harness({ poolThrows: true });
    await ledger.payout(VAULT, { ...payment(200n), payee: PUBLIC_PAYEE, token: NIGHT }, BY);
    const call = calls.find((c) => c.circuit === 'payoutUnshielded')!;
    /* RED WHEN the public payment builds its run differently from the private one. */
    expect(asPlain(call.args[0])).toEqual(asPlain(expectedRun()));
    /* RED WHEN the token, amount or blinding moves on the public path. */
    expect([toHex(call.args[2] as Uint8Array), call.args[3], toHex(call.args[4] as Uint8Array)])
      .toEqual([NIGHT, 200n, '55'.repeat(32)]);
    expect(secretsRead).toEqual([]);
  });

  it('REFUSES a private payment given no nonce secret, before a note is chosen or anything is written down', async () => {
    const { ledger, calls, saves, journalled } = harness();
    /* RED WHEN a private payment goes ahead, or reaches the journal, without the vault's secret. */
    await expect(ledger.payout(VAULT, payment(200n), BY, EVENTS))
      .rejects.toThrow(/none was given\. Nothing is proved or paid\. Open the company\x27s nonce secret/);
    expect(calls).toEqual([]);
    expect(saves).toEqual([]);
    expect(journalled).toEqual([]);
  });

  it('REFUSES a secret that is not 32 bytes, or is all zeros, before anything is written down', async () => {
    for (const bad of ['51'.repeat(31), '00'.repeat(32), 'zz'.repeat(32)]) {
      const { ledger, calls, journalled } = harness();
      /* RED WHEN a secret of the wrong shape is passed through to the circuit. */
      await expect(ledger.payout(VAULT, payment(200n), BY, EVENTS, bad as never), bad)
        .rejects.toThrow(/not a 32-byte secret/);
      expect(calls).toEqual([]);
      expect(journalled).toEqual([]);
    }
  });

  it('REFUSES a path that is not sixteen steps, on either kind of payment, before anything is called', async () => {
    for (const p of [
      { ...payment(200n), path: PATH.slice(1) },
      { ...payment(200n), payee: PUBLIC_PAYEE, token: NIGHT, path: [...PATH, PATH[0]!] },
    ]) {
      const { ledger, calls, journalled } = harness({ poolThrows: p.payee === PUBLIC_PAYEE });
      /* RED WHEN a path of the wrong length is handed to either circuit. */
      await expect(ledger.payout(VAULT, p, BY, EVENTS, SECRET)).rejects.toThrow(/path in the run's sum tree has 16 steps/);
      expect(calls).toEqual([]);
      expect(journalled).toEqual([]);
    }
  });

  it('REFUSES a step that is not a node, a sum and a side', async () => {
    const { ledger, calls } = harness();
    const broken = PATH.map((step, d) => (d === 5 ? { ...step, siblingSum: 7 as never } : step));
    /* RED WHEN a step of the wrong shape is passed through to the circuit. */
    await expect(ledger.payout(VAULT, { ...payment(200n), path: broken }, BY, EVENTS, SECRET))
      .rejects.toThrow(/step 5 of this payee's path is not a node, a sum and a side/);
    expect(calls).toEqual([]);
  });
});

