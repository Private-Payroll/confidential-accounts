import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doorProviders, type OwnWallet } from './door-providers.js';
import { transactionSettingsFor } from '../src/midnight/providers.js';
import type { LiveWallet } from './wallet-bringup.js';

/** A wallet that records what it is asked, and carries secret fields the provider set must not reach. */
const recordingWallet = () => {
  const calls: Array<[string, unknown[]]> = [];
  const wallet = {
    supportedEras: ['v9'] as const,
    balanceTx: async (...args: unknown[]) => { calls.push(['balanceTx', args]); return 'balanced' as never; },
    submitTx: async (...args: unknown[]) => { calls.push(['submitTx', args]); return 'tx-id'; },
    getCoinPublicKey: () => 'coin-public',
    getEncryptionPublicKey: () => 'encryption-public',
    zswapSecretKeys: 'SECRET-zswap',
    dustSecretKey: 'SECRET-dust',
    seeds: 'SECRET-seed',
  };
  return { wallet: wallet as unknown as OwnWallet, calls };
};

const bundle = (wallet: OwnWallet) => ({
  config: {
    networkId: 'preprod' as const,
    indexerUrl: 'http://indexer.invalid/api/v4/graphql',
    indexerWsUrl: 'ws://indexer.invalid/api/v4/graphql/ws',
    proverUrl: 'http://prover.invalid',
  },
  artifactsPath: mkdtempSync(join(tmpdir(), 'artefacts-')),
  privateStateId: 'ps',
  storagePassword: async () => 'not-a-secret: a test literal',
  wallet,
});

describe('the provider set of a door whose own wallet pays', () => {
  it('carries the network\'s settings, as the service\'s set does', async () => {
    const { wallet } = recordingWallet();
    const p = await doorProviders(bundle(wallet));
    expect(p.config).toEqual(transactionSettingsFor('preprod'));
    expect([p.walletProvider.supportedEras, p.midnightProvider.supportedEras]).toEqual([['v9'], ['v9']]);
  });

  it('balances through the wallet\'s own balanceTx with the deadline it was given, and submits through its submitTx', async () => {
    const { wallet, calls } = recordingWallet();
    const p = await doorProviders(bundle(wallet));
    const ttl = new Date(1_700_000_000_000);
    await p.walletProvider.balanceTx('unbound' as never, ttl);
    await p.midnightProvider.submitTx('finalized' as never);
    expect(calls).toEqual([['balanceTx', ['unbound', ttl]], ['submitTx', ['finalized']]]);
  });

  it('reaches none of the wallet\'s secret keys or seeds', async () => {
    const { wallet } = recordingWallet();
    const p = await doorProviders(bundle(wallet));
    const reached = JSON.stringify([p.walletProvider, p.midnightProvider, Object.keys(p.walletProvider), Object.keys(p.midnightProvider)]);
    expect(reached).not.toMatch(/SECRET/);
    expect([p.walletProvider.getCoinPublicKey(), p.walletProvider.getEncryptionPublicKey()]).toEqual(['coin-public', 'encryption-public']);
  });
});

describe('a door\'s own wallet balances through the facade\'s published signature', () => {
  /*
   * Checked by the scripts' typecheck, not at run time: the call below must not type-check. The facade takes the
   * transaction and one options object holding the deadline and the token kinds; a keys bag in the options' place
   * would be read as options with no deadline and every token kind balanced.
   * RED WHEN: the wallet a bring-up hands back is untyped again, so a keys bag in the options' place type-checks.
   */
  it('a call that puts the wallet\'s keys where the deadline belongs does not compile', () => {
    const balanceWithKeys = (live: LiveWallet, tx: Parameters<LiveWallet['wallet']['wallet']['balanceUnboundTransaction']>[0]) =>
      live.wallet.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: live.wallet.zswapSecretKeys, dustSecretKey: live.wallet.dustSecretKey },
        // @ts-expect-error the facade's second argument is its options, and it takes no third
        { ttl: new Date() },
      );
    expect(typeof balanceWithKeys).toBe('function');
  });
});
