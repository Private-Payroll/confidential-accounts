/**
 * PRIVATE STATE IS STAGED AGAINST THE CONTRACT THE CALL IS FOR.
 *
 * The defect this pins: the SDK's private state provider files everything
 * under `${contractAddress}:${privateStateId}`, and the address half is a
 * MUTABLE CLOSURE VARIABLE set by whichever SDK entry point ran last
 * (`midnight-js-level-private-state-provider/dist/index.mjs:767-778`). Until
 * S8c nothing in src/ ever set it, so every stage inherited it — correct while
 * exactly one contract had ever been addressed, and silently wrong the moment
 * there are two. The wrong-prefix failure is not loud: it is either a
 * missing-state error blamed on a missing secret key, or a proof built from
 * another contract's private state.
 *
 * **THE STAGE THESE TESTS DROVE USED TO BE `stageView`, AND `C292`/`S26`
 * REMOVED IT** with the account's balance ledger: it wrote the caller's balance
 * opening — `current` and `next` — for a spend circuit that no longer exists.
 * **`C228` IS A DIFFERENT RULE AND DID NOT GO WITH IT**, so every test below is
 * repointed onto `stageChange`, which is the surviving stage and obeys the
 * identical rule for the identical reason: it reads the account's record,
 * merges into it and writes it back, so an inherited address reads AND
 * overwrites another contract's state. Only the assertions about `current`,
 * `next` and the balance were dropped. Every assertion about addressing is the
 * one that stood here.
 *
 * So the fake provider here is not a convenience stub: it MIRRORS the real
 * provider's addressing semantics — the closure variable, the composed key,
 * the throw when no address was ever set — copied from the lines cited above,
 * because a fake without the semantics could not fail the way the product
 * would. The same rule as the state reader in ledger.test.ts: the fake keeps
 * the property under test real.
 *
 * No node, no proof server, no mocks of the SDK: `stageChange` and
 * `assetBlindingOf` never leave this class. They are private, and reached
 * through the same deliberate seam cast ledger.test.ts uses — the machinery matters while it waits, and a test that only drove
 * public doors could not reach the staging order at all.
 */
import { describe, it, expect } from 'vitest';
import { MidnightLedger, privateStateKey } from './ledger.js';
import type { MidnightConfig, FeeSponsor, SealedStateStore } from './ledger.js';
import type { StateChange } from '../core/ledger.js';
import type { Hex } from '../core/crypto.js';
import { fromHex } from '../core/crypto.js';

const CFG: MidnightConfig = {
  indexerUrl: 'http://indexer', indexerWsUrl: 'ws://indexer', proverUrl: 'http://prover',
  nodeUrl: 'http://node',
  zkConfigPath: new URL('../../contracts/managed', import.meta.url).pathname,
  networkId: 'preview',
  privateStateId: 'confidential-accounts-preview',
};

const ASSET = 'GBP';

/** Two accounts, two contracts. The whole point is that there are two. */
const ADDRESSES: Record<string, string> = {
  alpha: 'addr_alpha',
  beta: 'addr_beta',
};

/*
 * `viewFor` AND `NEXT` STOOD HERE, AND WENT WITH `stageView`.
 *
 * They built a `StateView` and a `StateOpening` — a balance and its salt — for
 * a stage that no longer exists. `StateOpening` is gone from `core/ledger.ts`
 * outright and `StateView` now carries only `{ asset, assetBlinding }`. Nothing
 * about C228 needed either: what the stage WRITES was never the property under
 * test, only where it lands.
 */
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
 * The real provider's addressing semantics, mirrored:
 * a closure address, a composed `${address}:${id}` key, and a refusal when no
 * address was ever set — `index.mjs:767-778` verbatim in behaviour. `trace`
 * records the order of address-sets, reads and writes, because the property
 * under test is not only WHERE state landed but that the address was set
 * BEFORE anything was read.
 */
const levelLikeProvider = () => {
  const store = new Map<string, any>();
  const trace: string[] = [];
  let contractAddress: string | null = null;
  const keyFor = (id: string): string => {
    if (contractAddress === null) {
      throw new Error('Contract address not set. Call setContractAddress() before accessing private state.');
    }
    return `${contractAddress}:${id}`;
  };
  return {
    store,
    trace,
    setContractAddress(address: string): void {
      contractAddress = address;
      trace.push(`address ${address}`);
    },
    async get(id: string): Promise<any> {
      const k = keyFor(id);
      trace.push(`get ${k}`);
      return store.get(k) ?? null;
    },
    async set(id: string, value: any): Promise<void> {
      const k = keyFor(id);
      trace.push(`set ${k}`);
      store.set(k, value);
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
 * one ugly cast per method, in a test, on purpose.
 *
 * A `stageView` seam stood beside these and went with the circuit it fed
 *. `stageChange` is what every test that used it now drives. */
const stageChange = (l: MidnightLedger, accountId: string): Promise<void> =>
  (l as unknown as { stageChange(a: string, c: StateChange): Promise<void> })
    .stageChange(accountId, CHANGE);
const assetBlindingOf = (l: MidnightLedger, accountId: string): Promise<Hex> =>
  (l as unknown as { assetBlindingOf(a: string): Promise<Hex> }).assetBlindingOf(accountId);

describe('C228: private state is addressed per contract, explicitly, before every stage', () => {
  it('sets the account\'s own contract address before the first read, for each account', async () => {
    const provider = levelLikeProvider();
    provider.store.set(physicalKey('alpha'), heldState('alpha', ALPHA_BLINDING));
    provider.store.set(physicalKey('beta'), heldState('beta', BETA_BLINDING));
    const ledger = makeLedger(provider);

    await stageChange(ledger, 'alpha');
    await stageChange(ledger, 'beta');

    /*
     * The order IS the property: with no address ever set, the real provider
     * throws on the first `get`, so a trace that reads before addressing
     * could only pass by inheriting somebody else's address — the defect.
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

  it('a second contract does not read the first\'s private state, even when the provider was left pointing at the first', async () => {
    const provider = levelLikeProvider();
    provider.store.set(physicalKey('alpha'), heldState('alpha', ALPHA_BLINDING));
    provider.store.set(physicalKey('beta'), heldState('beta', BETA_BLINDING));
    const ledger = makeLedger(provider);

    // The C228 shape: an SDK entry point for alpha's contract ran last, and
    // left the provider pointing there. Before S8c, beta's stage would have
    // read alpha's record and written the merge back under alpha's prefix —
    // with a valid proof at the end of it.
    provider.setContractAddress(ADDRESSES.alpha);

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

  /*
   * `it('stageChange follows the same rule')` STOOD HERE AND IS FOLDED INTO THE
   * TEST ABOVE.
   *
   * It existed to show that the stage NOT under test in this file obeyed the
   * same rule as `stageView`. `stageView` is gone, `stageChange` is the stage
   * under test, and its three assertions — beta's marker survives the merge,
   * beta's `changeAmount` lands, alpha's does not — are all made above. Kept as
   * a second copy it would be the same call asserted twice, which reads as two
   * checks and is one.
   */

  it('assetBlindingOf answers with the named account\'s blinding, not the last-addressed contract\'s', async () => {
    const provider = levelLikeProvider();
    provider.store.set(physicalKey('alpha'), heldState('alpha', ALPHA_BLINDING));
    provider.store.set(physicalKey('beta'), heldState('beta', BETA_BLINDING));
    const ledger = makeLedger(provider);
    provider.setContractAddress(ADDRESSES.alpha);

    expect(await assetBlindingOf(ledger, 'beta')).toBe(BETA_BLINDING);
  });

  it('missing state names the contract and both causes, and stages nothing', async () => {
    const provider = levelLikeProvider();
    // Alpha is seated; beta is NOT — and the provider points at alpha, which
    // is exactly the arrangement that used to produce a wrong answer.
    provider.store.set(physicalKey('alpha'), heldState('alpha', ALPHA_BLINDING));
    const ledger = makeLedger(provider);
    provider.setContractAddress(ADDRESSES.alpha);

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
    provider.setContractAddress(ADDRESSES.alpha);

    await expect(stageChange(ledger, 'gamma'))
      .rejects.toThrow('account "gamma" is not deployed on Midnight');
    // In particular it did not fall through to alpha's prefix.
    expect(provider.trace.filter((line) => line.startsWith('get '))).toEqual([]);
  });
});
