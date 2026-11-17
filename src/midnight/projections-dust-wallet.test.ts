/**
 * **THE DUST WALLET BOTH THE PERSON'S WALLET AND THE SERVICE'S FEE PAYER RUN, AND THE VERSION A NEW ONE STARTS ON.**
 *
 * The version is read from a stand-in indexer that says what it was asked. The wallet is the wallet library's own,
 * on the production fork schedule, started from real keys and never synced: the indexer it would sync from is not
 * there, so all it learns of the chain is what its start asked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { DefaultForkSchedule, NoOpTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk';
import { DustSecretKey as V8DustSecretKey } from '@midnightntwrk/wallet-sdk/ledger/v8';
import { DustSecretKey } from '@midnightntwrk/ledger-v9';
import { projectionsDustWallet, tipProtocolVersion } from './projections-dust-wallet.js';

const TIP = 'https://tip.invalid/api/v4/graphql';

describe('THE VERSION OF THE NETWORK\'S NEWEST BLOCK, WHICH PICKS THE VARIANT A NEW WALLET STARTS ON', () => {
  it('asks the indexer for its newest block and answers its protocol version', async () => {
    const asked: Array<{ url: string; query: string }> = [];
    const post = async (url: string, init: RequestInit) => {
      asked.push({ url, query: (JSON.parse(String(init.body)) as { query: string }).query });
      return { json: async () => ({ data: { block: { protocolVersion: 2001100 } } }) };
    };
    /* RED WHEN: the probe asks for the chain's first block (ledger 8 on preprod), starting the wallet on ledger 8. */
    await expect(tipProtocolVersion('https://i/api?k=1', post)).resolves.toBe(2001100n);
    expect(asked.map((a) => a.url)).toEqual(['https://i/api?k=1']);
    expect(asked[0]!.query).toMatch(/block\s*\{\s*protocolVersion\s*\}/);
    expect(asked[0]!.query).not.toMatch(/offset/);
  });

  it('refuses an answer without a block, or with a version that is not a number', async () => {
    for (const block of [null, {}, { protocolVersion: null }, { protocolVersion: true }, { protocolVersion: [9] }]) {
      const post = async () => ({ json: async () => ({ data: { block } }) });
      /* RED WHEN: an indexer that names no block, or a version that is no number, is read as some version. */
      await expect(tipProtocolVersion('u', post), JSON.stringify(block)).rejects.toThrow(/no newest block/);
    }
  });
});

describe('A NEW PROJECTIONS DUST WALLET STARTS ON THE NEWEST BLOCK\'S LEDGER', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** A projections DUST wallet started from one seed's keys, its newest-block read answered by `tip`. */
  const startedWith = async (tip: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => (String(url) === TIP ? tip() : Promise.reject(new Error('not there')))));
    const seed = new Uint8Array(32).fill(7);
    const Wallet = await projectionsDustWallet({
      networkId: 'undeployed', costParameters: { feeBlocksMargin: 5 },
      indexerClientConnection: { indexerHttpUrl: TIP },
      txHistoryStorage: new NoOpTransactionHistoryStorage(), forks: DefaultForkSchedule,
    });
    const wallet = await Wallet.startWithKeys({ v8: V8DustSecretKey.fromSeed(seed), v9: DustSecretKey.fromSeed(seed) });
    try {
      return (await firstValueFrom(wallet.state)).protocolVersion;
    } finally {
      await wallet.stop();
    }
  };

  it('a wallet whose start reads a newest block past the fork starts on ledger 9, though it never synced', async () => {
    const past = Number(DefaultForkSchedule.v9 + 1100n);
    const version = await startedWith(async () => Response.json({ data: { block: { protocolVersion: past } } }));
    /* RED WHEN: the wallet is built without asking the newest block, so it starts at the chain's first block, on ledger 8. */
    expect(version).toBe(BigInt(past));
  });

  it('a wallet whose start cannot read the newest block starts where the library\'s own would, before the fork', async () => {
    const version = await startedWith(async () => Response.json({ data: { block: null } }));
    /* RED WHEN: a start that learned nothing is placed past the fork anyway. */
    expect(version < DefaultForkSchedule.v9).toBe(true);
  });
});
