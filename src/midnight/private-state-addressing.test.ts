/**
 * Private state is staged against the contract the call is for.
 *
 * Private state is opened per contract (`forContract` in the web app's `private-state.ts`, and the providers'
 * private-state provider), and every key is composed as `${contractAddress}:${privateStateId}`. Staging reads the
 * account's record, merges into it and writes it back, so a read or write that reached the wrong contract's
 * prefix would overwrite another contract's state, and the failure is not loud: it is either a missing-state
 * error blamed on a missing secret key, or a proof built from another contract's private state.
 *
 * The fake provider here is not a convenience stub: it mirrors the real provider's addressing (a store opened
 * per contract, keys composed from the address), because a fake without those semantics could not fail the way
 * the product would.
 *
 * No node, no proof server, no mocks of the SDK: `stageChange` and `assetBlindingOf` never leave this class.
 * They are private, and reached through the same deliberate seam cast `ledger.test.ts` uses, because a test that
 * only drove public entry points could not reach the staging order at all.
 */
import { describe, it, expect } from 'vitest';
import { MidnightLedger, privateStateKey } from './ledger.js';
import type { MidnightConfig, FeeSponsor, SealedStateStore } from './ledger.js';
import type { StateChange } from '../core/ledger.js';
import type { Hex } from '../core/crypto.js';
import { fromHex } from '../core/crypto.js';

import { TEST_TOKEN } from '../testing/assets.js';
const CFG: MidnightConfig = {
  indexerUrl: 'http://indexer', indexerWsUrl: 'ws://indexer', proverUrl: 'http://prover',
  nodeUrl: 'http://node',
  zkConfigPath: new URL('../../contracts/managed', import.meta.url).pathname,
  networkId: 'preview',
  privateStateId: 'confidential-accounts-preview',
};

const ASSET = TEST_TOKEN;

/** Two accounts, two contracts. The whole point is that there are two. */
const ADDRESSES: Readonly<Record<string, string>> & { readonly alpha: string; readonly beta: string } = {
  alpha: 'addr_alpha',
  beta: 'addr_beta',
};

const CHANGE: StateChange = {
  asset: ASSET, amount: 1n, batchDigest: '11'.repeat(32), salt: '22'.repeat(32),
};

const ALPHA_BLINDING = 'aa'.repeat(32) as Hex;
const BETA_BLINDING = 'bb'.repeat(32) as Hex;

/** A seated device's record for one account, distinguishable from the other's. */
const heldState = (marker: string, assetBlinding: Hex) => ({
  secretKey: new TextEncoder().encode(`secret-${marker}`),
  blinding: new Uint8Array(32),
  assetBlinding: fromHex(assetBlinding),
  marker,
});

/**
 * The real provider's addressing, mirrored: the store is opened per contract and every key is composed as
 * `${address}:${id}`, so a read can only ever reach the contract it was opened for. `trace` records each
 * opening, read and write in order.
 */
const levelLikeProvider = () => {
  const store = new Map<string, any>();
  const trace: string[] = [];
  return {
    store,
    trace,
    forContract(address: string) {
      trace.push(`address ${address}`);
      return {
        async get(id: string): Promise<any> {
          const k = `${address}:${id}`;
          trace.push(`get ${k}`);
          return store.get(k) ?? null;
        },
        async set(id: string, value: any): Promise<void> {
          const k = `${address}:${id}`;
          trace.push(`set ${k}`);
          store.set(k, value);
        },
      };
    },
  };
};

const BLOBS: SealedStateStore = {
  put: async () => {},
  get: async () => null,
};

const makeLedger = (provider: ReturnType<typeof levelLikeProvider>): MidnightLedger =>
  new MidnightLedger(
    CFG,
    {} as unknown as FeeSponsor,
    BLOBS,
    async (accountId) => ADDRESSES[accountId] ?? null,
    async () => ({ privateStateProvider: provider }),
    {},
  );

/** The physical key the level store would use for this account's state. */
const physicalKey = (accountId: string): string =>
  `${ADDRESSES[accountId]}:${privateStateKey(CFG.privateStateId, accountId)}`;

/* The seams. Private methods, reached the way ledger.test.ts reaches its own:
 * one cast per method, in a test, on purpose. */
const stageChange = (l: MidnightLedger, accountId: string): Promise<void> =>
  (l as unknown as { stageChange(a: string, c: StateChange): Promise<void> })
    .stageChange(accountId, CHANGE);
const assetBlindingOf = (l: MidnightLedger, accountId: string): Promise<Hex> =>
  (l as unknown as { assetBlindingOf(a: string): Promise<Hex> }).assetBlindingOf(accountId);

describe('private state is opened per contract, explicitly, before every stage', () => {
  it('opens private state for the account\'s own contract before the first read, for each account', async () => {
    const provider = levelLikeProvider();
    provider.store.set(physicalKey('alpha'), heldState('alpha', ALPHA_BLINDING));
    provider.store.set(physicalKey('beta'), heldState('beta', BETA_BLINDING));
    const ledger = makeLedger(provider);

    await stageChange(ledger, 'alpha');
    await stageChange(ledger, 'beta');

    /*
     * The order is the property: private state is opened for the account's own contract before it is read, so
     * a read can only reach that contract.
     */
    expect(provider.trace).toEqual([
      'address addr_alpha',
      `get ${physicalKey('alpha')}`,
      `set ${physicalKey('alpha')}`,
      'address addr_beta',
      `get ${physicalKey('beta')}`,
      `set ${physicalKey('beta')}`,
    ]);
  });

  it('a second contract neither reads nor overwrites the first\'s private state', async () => {
    const provider = levelLikeProvider();
    provider.store.set(physicalKey('alpha'), heldState('alpha', ALPHA_BLINDING));
    provider.store.set(physicalKey('beta'), heldState('beta', BETA_BLINDING));
    const ledger = makeLedger(provider);

    // Both records are held. Staging for beta must read beta's record and write the merge back under beta's
    // prefix, never under alpha's.

    await stageChange(ledger, 'beta');

    // The write landed under beta's prefix, and it is BETA's record — its own
    // secret key and marker survived the merge — not alpha's record renamed.
    const betaStored = provider.store.get(physicalKey('beta'));
    expect(betaStored.marker).toBe('beta');
    expect(new TextDecoder().decode(betaStored.secretKey)).toBe('secret-beta');
    expect(betaStored.changeAmount).toBe(1n);
    expect(betaStored.changeBatchDigest).toEqual(fromHex(CHANGE.batchDigest));

    // And alpha's record is exactly as seeded: beta's stage neither read it
    // nor wrote over it.
    const alphaStored = provider.store.get(physicalKey('alpha'));
    expect(alphaStored.marker).toBe('alpha');
    expect(alphaStored.changeAmount).toBeUndefined();
  });

  it('assetBlindingOf answers with the named account\'s blinding, not another contract\'s', async () => {
    const provider = levelLikeProvider();
    provider.store.set(physicalKey('alpha'), heldState('alpha', ALPHA_BLINDING));
    provider.store.set(physicalKey('beta'), heldState('beta', BETA_BLINDING));
    const ledger = makeLedger(provider);

    expect(await assetBlindingOf(ledger, 'beta')).toBe(BETA_BLINDING);
  });

  it('missing state names the contract and both causes, and stages nothing', async () => {
    const provider = levelLikeProvider();
    // Alpha is seated; beta is NOT — and the provider points at alpha, which
    // is exactly the arrangement that used to produce a wrong answer.
    provider.store.set(physicalKey('alpha'), heldState('alpha', ALPHA_BLINDING));
    const ledger = makeLedger(provider);

    const failure = await stageChange(ledger, 'beta')
      .then(() => null, (e: Error) => e);
    expect(failure).not.toBeNull();
    // It says which contract has nothing staged…
    expect(failure!.message).toContain('under contract addr_beta');
    // …names the second cause the old message hid…
    expect(failure!.message).toContain('different contract address');
    // …and no longer asserts the one cause it used to guess at.
    expect(failure!.message).not.toContain('whose secret key and blinding factor they do not hold');
    // Nothing was written anywhere on the failure path.
    expect(provider.trace.filter((line) => line.startsWith('set '))).toEqual([]);
  });

  it('an undeployed account is a refusal, never an inherited stage', async () => {
    const provider = levelLikeProvider();
    provider.store.set(physicalKey('alpha'), heldState('alpha', ALPHA_BLINDING));
    const ledger = makeLedger(provider);

    await expect(stageChange(ledger, 'gamma'))
      .rejects.toThrow('account "gamma" is not deployed on Midnight');
    // In particular it did not fall through to alpha's prefix.
    expect(provider.trace.filter((line) => line.startsWith('get '))).toEqual([]);
  });
});
