/**
 * **A VAULT'S FIRST SECRET IS SET FROM THE DEVICE THAT HOLDS IT, WITH THE PATH
 * THAT SHOWS WHERE ITS COPIES END.** The vault takes the secret itself, not only
 * its commitment, and the edge of the tree of copies; a first secret carries no
 * earlier one. The ledger, the transaction builder and the prover are replaced
 * by stand-ins that answer only what the builder may ask, so the arguments the
 * call is built with are read exactly as the circuit would get them.
 */
import { describe, it, expect } from 'vitest';
import { buildSetNonceSecret, type SecretRunOnTheWire, type VaultBuilderDeps } from './vault-builder.js';

const VAULT = 'cd'.repeat(32);
const ACCOUNT = 'ef'.repeat(32);
const SECRET = '5e'.repeat(31) + '00';
const step = (n: number) => ({ sibling: String(n), goesLeft: n % 2 === 0 });

const RUN: SecretRunOnTheWire = {
  vault: VAULT, previous: '00'.repeat(32), commitment: '11'.repeat(32), copiesRoot: '22'.repeat(32), count: '2',
  edge: Array.from({ length: 10 }, (_, i) => step(100 + i)),
  details: '33'.repeat(32), nonce: '44'.repeat(32), salt: '55'.repeat(32), asset: '66'.repeat(32), root: '77'.repeat(32),
  payees: '1', path: [{ sibling: '1', siblingSum: '0', goesLeft: true }],
  copies: [{ reader: '88'.repeat(32), parts: ['01', '02', '03', '04'].map((p) => p.repeat(32)), path: Array.from({ length: 10 }, (_, i) => step(i)) }],
};

const standIns = () => {
  const asked: Array<{ circuitId: string; args: unknown[] }> = [];
  const deps: VaultBuilderDeps = {
    ledger: {
      ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'cpk', encryptionPublicKey: 'epk' }) },
      ZswapChainState: { deserialize: () => ({}) },
      LedgerParameters: { deserialize: () => ({}) },
    },
    runtimeState: { deserialize: () => ({ state: true }) },
    contracts: {
      createUnprovenDeployTxFromVerifierKeys: async () => { throw new Error('no deploy here'); },
      createUnprovenCallTxFromInitialStates: async (_zk: unknown, options: { circuitId: string; args: unknown[] }) => {
        asked.push({ circuitId: options.circuitId, args: options.args });
        return { private: { unprovenTx: 'unproven' } };
      },
    },
    compiled: {},
    zkConfig: {},
    prove: async () => ({ serialize: () => new Uint8Array([1]) }),
    network: 'undeployed',
    random: (n) => new Uint8Array(n).fill(4),
  };
  return { deps, asked };
};
const CHAIN = {
  blockHash: '99'.repeat(32), vaultState: new Uint8Array([1]), zswapState: new Uint8Array([2]),
  parameters: new Uint8Array([3]), accountState: new Uint8Array([4]),
};
const hex = (b: unknown) => Buffer.from(b as Uint8Array).toString('hex');

describe('setting a vault\'s first secret from the device', () => {
  it('BUILDS THE CALL WITH THE EDGE, THE SECRET ITSELF AND NO EARLIER SECRET, in the places the circuit reads them', async () => {
    const { deps, asked } = standIns();
    await buildSetNonceSecret(deps, {
      vault: VAULT, account: ACCOUNT, run: RUN, secret: SECRET, proposal: 'aa'.repeat(32), opensAt: '1', closesAt: '2', chain: CHAIN,
    });
    expect(asked.map((a) => a.circuitId)).toEqual(['setNonceSecret']);
    const args = asked[0]!.args;
    /* RED WHEN the arguments move: the run, the replaced commitment, the commitment, the root and the count come first. */
    expect(hex(args[2])).toBe(RUN.commitment);
    expect(args[4]).toBe(2n);
    /* RED WHEN the edge is dropped or not the run's: the vault refuses a tree that does not show where its copies end. */
    expect(args[5]).toEqual(RUN.edge.map((s) => ({ sibling: BigInt(s.sibling), goesLeft: s.goesLeft })));
    /* RED WHEN the secret and the earlier secret swap, or the secret is not the one handed in. */
    expect(hex(args[6])).toBe(SECRET);
    /* RED WHEN a first secret is built to carry anything: there is no earlier one. */
    expect(hex(args[7])).toBe('00'.repeat(32));
    expect(args).toHaveLength(8);
  });

  it('REFUSES A RUN THAT DOES NOT SHOW WHERE ITS COPIES END, and builds nothing', async () => {
    const { deps, asked } = standIns();
    const short = { ...RUN, edge: RUN.edge.slice(0, 9) };
    /* RED WHEN a run without its full edge is built: the vault would refuse it after the fee. */
    await expect(buildSetNonceSecret(deps, {
      vault: VAULT, account: ACCOUNT, run: short, secret: SECRET, proposal: 'aa'.repeat(32), opensAt: '1', closesAt: '2', chain: CHAIN,
    })).rejects.toThrow(/does not show where its copies end/);
    expect(asked).toEqual([]);
  });
});
