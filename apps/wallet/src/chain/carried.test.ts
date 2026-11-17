import { describe, expect, it } from 'vitest';
import { DefaultForkSchedule, DustWallet, NoOpTransactionHistoryStorage, ProtocolVersion, WalletTransaction } from '@midnightntwrk/wallet-sdk';
import { DustSecretKey as V8DustSecretKey } from '@midnightntwrk/wallet-sdk/ledger/v8';
import { BehaviorSubject, map } from 'rxjs';
import * as L from '@midnightntwrk/ledger-v9';
import { actsOnThisWalletsLedger, carriedBy, readOnThisWalletsLedger } from './carried.js';

/** A ledger-v9 transaction the wallet could have built: one deploy, nothing else. */
const aTransaction = () => L.Transaction.fromParts('undeployed', undefined, undefined,
  L.Intent.new(new Date(Date.now() + 60_000)).addDeploy(new L.ContractDeploy(new L.ContractState())));

describe('WHAT A TRANSACTION HANDLE CARRIES, AS THE WALLET READS IT', () => {
  it('a handle of a ledger-v9 transaction gives that transaction back, whatever version it was stamped with', () => {
    const tx = aTransaction();
    for (const version of [ProtocolVersion.MinSupportedVersion, ProtocolVersion.V9NativeForkVersion]) {
      /* RED WHEN: a handle the facade hands back is read as nothing, so every check refuses what the wallet built itself. */
      expect(carriedBy(WalletTransaction.adopt('Unproven', tx, version)), String(version)).toBe(tx);
    }
  });

  it('a handle carrying anything but a ledger-v9 transaction is read as nothing, so every check refuses it', () => {
    const notALedgerTransaction = { serialize: () => new Uint8Array([1]), intents: new Map() };
    /* RED WHEN: what a handle carries reaches the checks without being a ledger-v9 transaction. */
    expect(carriedBy(WalletTransaction.adopt('Finalized', notALedgerTransaction, ProtocolVersion.V9NativeForkVersion))).toBeNull();
  });

  it('a ledger transaction, or a reading of one, is passed on as it is', () => {
    const tx = aTransaction();
    const read = { intents: new Map() };
    expect(carriedBy(tx)).toBe(tx);
    expect(carriedBy(read)).toBe(read);
    expect(carriedBy(undefined)).toBeUndefined();
  });
});

describe('A WALLET THAT COULD NOT ASK THE CHAIN WHERE IT IS HOLDS THE FACADE BEFORE THIS WALLET\'S LEDGER', () => {
  /** A real DUST wallet on the production fork schedule, never synced, whose start asked the chain with `probe`. */
  const startedBy = async (probe: () => Promise<bigint>) => {
    const seed = new Uint8Array(32).fill(7);
    const wallet = await DustWallet({
      networkId: 'undeployed', costParameters: { feeBlocksMargin: 5 },
      indexerClientConnection: { indexerHttpUrl: 'https://rehearsal.invalid/graphql' },
      txHistoryStorage: new NoOpTransactionHistoryStorage(), forks: DefaultForkSchedule,
      chainVersionProbe: probe as never,
    }).startWithKeys({ v8: V8DustSecretKey.fromSeed(seed), v9: L.DustSecretKey.fromSeed(seed) });
    return { state: () => wallet.state.pipe(map((s) => ({ activeProtocolVersion: s.protocolVersion }))) } as never;
  };

  it('a wallet whose start learned the chain is past the fork reads as on this wallet\'s ledger, though it never synced', async () => {
    expect(await actsOnThisWalletsLedger(await startedBy(async () => DefaultForkSchedule.v9 + 1100n))).toBe(true);
  });

  it('a wallet whose start could not reach the chain reads as before the fork, so a path refuses before reading anything', async () => {
    // RED WHEN: the version is measured against a fork schedule other than the production one, which puts ledger-v9 at the start
    expect(await actsOnThisWalletsLedger(await startedBy(async () => { throw new Error('the network did not answer'); }), 200)).toBe(false);
  });
});

describe('THE PART THAT PAYS IS READ UP TO DATE ON THIS WALLET\'S LEDGER BEFORE IT PAYS', () => {
  /** A facade at `at`, moving to the fork after `crossesAfterMs` when given, and a count of the reads made again. */
  const facadeAt = (at: bigint, crossesAfterMs?: number) => {
    const versions = new BehaviorSubject({ activeProtocolVersion: at });
    if (crossesAfterMs !== undefined) setTimeout(() => versions.next({ activeProtocolVersion: DefaultForkSchedule.v9 }), crossesAfterMs);
    return { state: () => versions.asObservable() } as never;
  };
  const counted = () => {
    const reads = { again: 0 };
    return { reads, readUp: async () => { reads.again += 1; } };
  };

  it('a first read made on this ledger is not made again', async () => {
    const { reads, readUp } = counted();
    expect(await readOnThisWalletsLedger(facadeAt(DefaultForkSchedule.v9), readUp, 1_000)).toBe(true);
    /* RED WHEN: the part is read again though its first read was already on this ledger, which only delays the payment. */
    expect(reads.again).toBe(0);
  });

  it('a first read made before the facade crossed the fork is made again once it has crossed', async () => {
    const { reads, readUp } = counted();
    expect(await readOnThisWalletsLedger(facadeAt(DefaultForkSchedule.v9 - 1n, 20), readUp, 1_000)).toBe(true);
    /* RED WHEN: a read finished at the fork is paid from, holding none of the coins received since. */
    expect(reads.again).toBe(1);
  });

  it('a facade that never reaches this ledger answers false, and nothing is read again', async () => {
    const { reads, readUp } = counted();
    /* RED WHEN: a facade on the earlier ledger is let pay, or is read again as if it had crossed. */
    expect([await readOnThisWalletsLedger(facadeAt(DefaultForkSchedule.v9 - 1n), readUp, 50), reads.again]).toEqual([false, 0]);
  });
});
