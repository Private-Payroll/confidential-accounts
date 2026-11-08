/*
 * A private deposit files its coin in the vault's deposit journal before it is built. Every failure from then until
 * the transaction is handed to something that could send it ends that line, so no check says a deposit that cannot
 * land is on its way; a line that cannot be marked is said in the refusal. The built transaction must end inside
 * the deposit's window with the whole margin for clocks kept, however long the build took.
 */
import { describe, expect, it } from 'vitest';
import {
  DEPOSIT_TIME_TO_LIVE_MS, type DepositInFlight, DepositMayOutliveItsWindow, DepositNotYetSeen, type PaymentInFlight,
  checkWhatThisBrowserDeposited, depositIntoCompanyVault, openCompanyVaultPool,
} from './vault-operation.js';
import { DepositLineNotEnded } from './deposit-line-ended.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { MemorySealedPoolStore, openPool, type SealedPool } from '../../../src/midnight/vault-pool.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import {
  ACCOUNT, LABEL, VAULT, builder, inFlightInMemory, indexerOf, nothingToCheck, pacing, serviceFrom, view, walletReadsTheVault,
} from './vault-operation.test-support.js';

const wrapping = recordsKeypairFrom(new Uint8Array(32).fill(6));
const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(6) };
const MONEY = { token: 'ab'.repeat(32) as never, value: 9n };
const NOW = Date.parse('2026-11-07T09:00:00Z');
type Coin = { nonce: string; token: string; value: string };
const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];

/** A deposit journal store whose writes can be refused, as a service that stops answering would. */
class JournalStore extends MemorySealedPoolStore {
  refuse: Error | null = null;
  override async put(vault: string, rec: SealedPool): Promise<void> {
    if (this.refuse !== null) throw this.refuse;
    return super.put(vault, rec);
  }
}

/** One company's records and chain, and one browser on them; `over` replaces a step of the builder or the in-flight record. */
const aCompany = async () => {
  const w = { built: [] as Coin[], asked: 0, sent: 0, now: NOW, ttl: (builtAt: number) => builtAt + 60 * 60_000 };
  const journal = new JournalStore();
  const kept = new Map<WireRecord, MemorySealedPoolStore>([['deposit-journal', journal]]);
  const records = (r: WireRecord) => kept.get(r) ?? kept.set(r, new MemorySealedPoolStore()).get(r)!;
  const service = serviceFrom([], [], {
    chain: async () => view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] }),
    deposit: async () => { w.sent += 1; throw new Error('the connection dropped'); },
  });
  const builtAt: number[] = [];
  const b: VaultBuilderClient = {
    ...builder([]),
    deposit: async (i) => { w.built.push(i.coin); builtAt.push(w.now); return { tx: `P${w.built.length}` }; },
    commitments: async (i) => ({ output: `out:${i.coin.nonce}`, held: `held:${i.coin.nonce}` }),
    readTransaction: async (i) => {
      const n = Number(/^P(\d+)/u.exec(i.transaction)?.[1] ?? 0);
      const coin = w.built[n - 1];
      return {
        identifiers: [], timeToLive: w.ttl(builtAt[n - 1] ?? w.now), calls: [{ address: VAULT, entryPoint: 'deposit', segments: [0] }],
        coinsForContracts: coin === undefined ? [] : [{ contract: VAULT, commitment: `out:${coin.nonce}` }], publicTakes: [],
      };
    },
  };
  const inFlight = inFlightInMemory<DepositInFlight>();
  const doors = {
    ...pacing, ...walletReadsTheVault, service, indexer: indexerOf(service), me, myRecordsKey: 'ff'.repeat(32), records, signers,
    company: LABEL, account: ACCOUNT, builder: b, clock: () => w.now, inFlight, payments: inFlightInMemory<PaymentInFlight>(),
    pay: async (ask: { transaction: string }) => { w.asked += 1; return { transaction: `${ask.transaction}+coins`, leaves: [] }; },
  };
  await openCompanyVaultPool(doors, VAULT, nothingToCheck);
  const lines = async () => {
    const rec = await journal.get(VAULT);
    return rec === null ? [] : (openPool(rec, 'ada', wrapping.secret, { record: 'deposit-journal' }) as { notes: Array<{ nonce: string; ended?: true }> }).notes;
  };
  return { w, doors, journal, inFlight, lines };
};

describe('A DEPOSIT STOPPED AFTER ITS COIN IS FILED AND BEFORE IT IS HANDED OVER', () => {
  it('a deposit whose build fails ends its journal line, and no check says it is on its way', async () => {
    const c = await aCompany();
    const doors = { ...c.doors, builder: { ...c.doors.builder, deposit: async () => { throw new Error('the proof could not be made'); } } };
    await expect(depositIntoCompanyVault(doors, VAULT, MONEY)).rejects.toThrow(/the proof could not be made/u);
    /* RED WHEN: a deposit whose build failed after its coin was filed is left on its way in the vault's journal. */
    expect((await c.lines()).map((l) => l.ended)).toEqual([true]);
    const found = await checkWhatThisBrowserDeposited(c.doors, VAULT, { files: false });
    expect([found.deposit, found.alsoJournalled ?? []]).toEqual([{ state: 'none' }, []]);
    expect([c.w.asked, c.w.sent]).toEqual([0, 0]);
  });

  it('a deposit whose coin cannot be read off the vault worker ends its journal line', async () => {
    const c = await aCompany();
    /* The worker answers while the coin is chosen, and stops once the deposit is built. */
    const doors = { ...c.doors, builder: { ...c.doors.builder, commitments: async (i: Parameters<VaultBuilderClient['commitments']>[0]) => {
      if (c.w.built.length > 0) throw new Error('the vault worker stopped');
      return c.doors.builder.commitments(i);
    } } };
    await expect(depositIntoCompanyVault(doors, VAULT, MONEY)).rejects.toThrow(/the vault worker stopped/u);
    /* RED WHEN: a deposit stopped reading its coin's commitments is left on its way in the vault's journal. */
    expect((await c.lines()).map((l) => l.ended)).toEqual([true]);
  });

  it('a deposit that cannot be kept on this device ends its journal line', async () => {
    const c = await aCompany();
    const doors = { ...c.doors, inFlight: { ...c.inFlight, claim: async () => { throw new Error('this browser\'s storage is full'); } } };
    await expect(depositIntoCompanyVault(doors, VAULT, MONEY)).rejects.toThrow(/storage is full/u);
    /* RED WHEN: a deposit that could not be kept on this device is left on its way in the vault's journal. */
    expect((await c.lines()).map((l) => l.ended)).toEqual([true]);
    expect(c.w.asked).toBe(0);
  });

  it('a line that cannot be marked is said in the refusal, beside what stopped the deposit', async () => {
    const c = await aCompany();
    const stopped = new Error('the proof could not be made.');
    const doors = { ...c.doors, builder: { ...c.doors.builder, deposit: async () => { c.journal.refuse = new Error('the service did not answer'); throw stopped; } } };
    const e = await depositIntoCompanyVault(doors, VAULT, MONEY).catch((x: unknown) => x);
    /* RED WHEN: a line left on its way because it could not be marked is passed over in silence. */
    expect(e).toBeInstanceOf(DepositLineNotEnded);
    expect((e as DepositLineNotEnded).stopped).toBe(stopped);
    expect((e as Error).message).toMatch(/^the proof could not be made\. This deposit's line .* could not be marked as never sent \(the service did not answer\), so until its window passes a check of this vault may say it is still on its way\. It was not sent and cannot arrive\.$/u);
    c.journal.refuse = null;
    expect((await c.lines()).map((l) => l.ended)).toEqual([undefined]);
  });

  it('a stop the deposit already ended its line for still says so when the line cannot be marked', async () => {
    const c = await aCompany();
    c.w.ttl = () => Number.POSITIVE_INFINITY;
    const doors = { ...c.doors, builder: { ...c.doors.builder, deposit: async (i: Parameters<VaultBuilderClient['deposit']>[0]) => {
      c.journal.refuse = new Error('the service did not answer');
      return c.doors.builder.deposit(i);
    } } };
    const e = await depositIntoCompanyVault(doors, VAULT, MONEY).catch((x: unknown) => x);
    /* RED WHEN: a deposit refused for its window whose line could not be marked does not say the line still reads as on its way. */
    expect(e).toBeInstanceOf(DepositLineNotEnded);
    expect((e as DepositLineNotEnded).stopped).toBeInstanceOf(DepositMayOutliveItsWindow);
  });
});

describe('THE BUILT DEPOSIT ENDS INSIDE ITS WINDOW WITH THE WHOLE MARGIN FOR CLOCKS KEPT', () => {
  it('a slow build whose transaction ends past the window counted from its coin\'s filing is not sent, and its line is ended', async () => {
    const c = await aCompany();
    /* The build takes ten minutes and ends a minute past the window counted from when the coin was chosen. */
    c.w.ttl = () => NOW + DEPOSIT_TIME_TO_LIVE_MS + 60_000;
    const doors = { ...c.doors, builder: { ...c.doors.builder, deposit: async (i: Parameters<VaultBuilderClient['deposit']>[0]) => {
      c.w.now += 10 * 60_000;
      return c.doors.builder.deposit(i);
    } } };
    /* RED WHEN: a deposit that could land after a reader whose clock runs ahead says it never will is sent. */
    await expect(depositIntoCompanyVault(doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositMayOutliveItsWindow);
    expect(c.w.asked).toBe(0);
    expect((await c.lines()).map((l) => l.ended)).toEqual([true]);
  });

  it('a transaction ending exactly at the window counted from its coin\'s filing goes ahead', async () => {
    const c = await aCompany();
    c.w.ttl = () => NOW + DEPOSIT_TIME_TO_LIVE_MS;
    /* RED WHEN: a deposit that ends inside its window, with the margin for clocks kept, is refused. */
    await expect(depositIntoCompanyVault(c.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    expect([c.w.asked, c.w.sent]).toEqual([1, 1]);
  });
});
