/**
 * What midnight-js stamps on every transaction the service builds: the network it is for, and how long it may wait
 * to land. Both come from one place each (the network record, the intent lifetime), and the provider set carries them
 * with the compiled contract a vault's cross-contract call reaches.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertValidMidnightConfig } from '@midnight-ntwrk/midnight-js-utils';
import { midnightProviders, transactionSettingsFor } from './providers.js';
import { accountModuleFor } from './contract-modules.js';
import { INTENT_LIFETIME_MS } from './intent-lifetime.js';
import type { MidnightConfig, FeeSponsor } from './ledger.js';

const ACCOUNT = 'c45b42a29a08ded3c9400cab83d9454b83e122a953848aad1f97a36cd135d996';

describe('the settings every transaction is built with', () => {
  it('names the network by its record and lives as long as every transaction this application builds', () => {
    const settings = transactionSettingsFor('preprod');
    /* RED WHEN: a transaction is built for another network than the record names, and every address in it is refused. */
    expect(settings.networkId).toBe('preprod');
    /* RED WHEN: a transaction the SDK builds lives a different time from the ones this application builds, and the margins the service sends within no longer hold. */
    expect(settings.ttlSeconds * 1000).toBe(INTENT_LIFETIME_MS);
    /* RED WHEN: the settings are ones midnight-js refuses, and no transaction can be built at all. */
    expect(() => assertValidMidnightConfig(settings)).not.toThrow();
  });

  it('refuses a network there is no record for', () => {
    /* RED WHEN: a network nobody has written a record for is passed to midnight-js, and a transaction is built for it. */
    expect(() => transactionSettingsFor('devnet')).toThrow(/"devnet" is not a network this application has a record for/);
  });
});

describe('the provider set the service builds', () => {
  const bundle = (contractModules?: ReturnType<typeof accountModuleFor>) => ({
    config: {
      networkId: 'preprod', indexerUrl: 'http://indexer.invalid/api/v4/graphql', indexerWsUrl: 'ws://indexer.invalid/api/v4/graphql/ws',
      proverUrl: 'http://prover.invalid', nodeUrl: 'http://node.invalid', zkConfigPath: '', privateStateId: 'ps',
    } as MidnightConfig,
    customer: { coinPublicKey: () => 'c', encryptionPublicKey: () => 'e', balanceOwnLegs: async () => null as never, release: async () => {} },
    sponsor: {} as FeeSponsor,
    artifactsPath: mkdtempSync(join(tmpdir(), 'artefacts-')),
    privateStateId: 'ps',
    storagePassword: async () => 'not-a-secret: a test literal',
    ...(contractModules === undefined ? {} : { contractModules }),
  });

  it('carries the network\'s settings and builds only for ledger 9', async () => {
    const p = await midnightProviders(bundle());
    /* RED WHEN: the provider set carries no settings, and midnight-js refuses every operation before it starts. */
    expect(p.config).toEqual(transactionSettingsFor('preprod'));
    /*
     * RED WHEN: the balance or the submission claims an era it cannot carry, and an operation is refused only after
     * its proof. The proof server proves either era, so the set as a whole carries ledger 9 alone.
     */
    expect([p.proofProvider.supportedEras.includes('v9'), p.walletProvider.supportedEras, p.midnightProvider.supportedEras])
      .toEqual([true, ['v9'], ['v9']]);
  });

  it('a vault\'s provider set reaches its account\'s contract, and an account\'s reaches none', async () => {
    const modules = accountModuleFor(ACCOUNT);
    /* RED WHEN: a vault's cross-contract call is built with no module for its account, and every payment fails naming the call. */
    expect((await midnightProviders(bundle(modules))).contractModuleProvider).toBe(modules);
    expect('contractModuleProvider' in (await midnightProviders(bundle()))).toBe(false);
  });
});
