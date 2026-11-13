/**
 * **A VAULT'S RETIRE IS BUILT FROM THE DEVICE AGAINST THE PROPOSAL ITS SIGNERS APPROVED.** The vault refuses while it
 * holds money and then asks the company's account to retire it under the proposal and its salt, so the call carries
 * exactly those two, and the account's state it is proved against is served for that account at that block only. The
 * ledger, the transaction builder and the prover are stand-ins that record what the builder asks.
 */
import { describe, it, expect } from 'vitest';
import type { VaultBuilderDeps } from './vault-builder.js';
import { buildForgetUnshielded, buildRetire, retireAnswered } from './vault-retire-built.js';

const VAULT = 'cd'.repeat(32);
const ACCOUNT = 'ef'.repeat(32);
const PROPOSAL = 'aa'.repeat(32);
const SALT = 'bb'.repeat(32);
const CHAIN = {
  blockHash: '99'.repeat(32), vaultState: new Uint8Array([1]), zswapState: new Uint8Array([2]),
  parameters: new Uint8Array([3]), accountState: new Uint8Array([4]),
};
const hex = (b: unknown) => Buffer.from(b as Uint8Array).toString('hex');

const standIns = () => {
  const asked: Array<{ circuitId: string; contractAddress: string; args: unknown[]; served: (a: string, at?: { blockHash?: string }) => Promise<unknown> }> = [];
  const proved: Array<string | undefined> = [];
  const deps: VaultBuilderDeps = {
    ledger: {
      ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'cpk', encryptionPublicKey: 'epk' }) },
      ZswapChainState: { deserialize: () => ({}) },
      LedgerParameters: { deserialize: () => ({}) },
    },
    runtimeState: { deserialize: (b: Uint8Array) => ({ state: b[0] }) },
    contracts: {
      createUnprovenDeployTxFromVerifierKeys: async () => { throw new Error('no deploy here'); },
      createUnprovenCallTxFromInitialStates: async (
        _zk: unknown, options: { circuitId: string; contractAddress: string; args: unknown[] }, _epk: unknown,
        read: { publicDataProvider: { queryContractState: (a: string, at?: { blockHash?: string }) => Promise<unknown> } },
      ) => {
        asked.push({ ...options, served: read.publicDataProvider.queryContractState });
        return { private: { unprovenTx: 'unproven' } };
      },
    },
    compiled: {},
    zkConfig: {},
    prove: async (_u: unknown, circuit?: string) => { proved.push(circuit); return { serialize: () => new Uint8Array([7]) }; },
    network: 'undeployed',
    random: (n) => new Uint8Array(n).fill(4),
  };
  return { deps, asked, proved };
};

describe('a vault retired from the device that carries it', () => {
  it('CALLS THE VAULT\'S RETIRE WITH THE APPROVED PROPOSAL AND ITS SALT, PROVED AGAINST THE ACCOUNT AT THE BLOCK READ', async () => {
    const { deps, asked, proved } = standIns();
    const built = await buildRetire(deps, { vault: VAULT.toUpperCase(), account: ACCOUNT, proposal: PROPOSAL, salt: SALT, chain: CHAIN });
    expect([...built.proven]).toEqual([7]);
    /* RED WHEN: the retire is built as another circuit, or proved as one, so the vault's own emptiness check never runs. */
    expect(asked.map((a) => [a.circuitId, a.contractAddress])).toEqual([['retire', VAULT]]);
    expect(proved).toEqual(['retire']);
    /* RED WHEN: the proposal and the salt swap places, or either is not the one approved. */
    expect(asked[0]!.args.map(hex)).toEqual([PROPOSAL, SALT]);
    /* RED WHEN: the account's state is served for another contract or another block than the one the call was read at. */
    expect(await asked[0]!.served(ACCOUNT, { blockHash: CHAIN.blockHash })).toEqual({ state: 4 });
    expect(await asked[0]!.served(VAULT, { blockHash: CHAIN.blockHash })).toBeNull();
    expect(await asked[0]!.served(ACCOUNT, { blockHash: '98'.repeat(32) })).toBeNull();
  });

  it('BUILDS NOTHING FOR A PROPOSAL, A SALT, A VAULT OR AN ACCOUNT THAT IS NOT THIRTY-TWO BYTES', async () => {
    for (const bad of [{ proposal: 'aa' }, { salt: 'zz'.repeat(32) }, { vault: 'cd' }, { account: '' }]) {
      const { deps, asked } = standIns();
      /* RED WHEN: a malformed value reaches the prover, which would spend a proof on a call the chain refuses. */
      await expect(buildRetire(deps, { vault: VAULT, account: ACCOUNT, proposal: PROPOSAL, salt: SALT, chain: CHAIN, ...bad }))
        .rejects.toThrow(/nothing was built/u);
      expect(asked).toHaveLength(0);
    }
  });
});

describe('a public token taken off a vault\'s list before its retire', () => {
  const TOKEN = '01'.repeat(32);
  it('CALLS THE VAULT\'S FORGETUNSHIELDED WITH THAT ONE TOKEN, PROVED AGAINST THE BLOCK READ', async () => {
    const { deps, asked, proved } = standIns();
    const built = await buildForgetUnshielded(deps, { vault: VAULT, account: ACCOUNT, token: TOKEN.toUpperCase(), chain: CHAIN });
    expect([...built.proven]).toEqual([7]);
    /* RED WHEN: the token is taken off the list by another circuit, or another contract, so the vault's own check that it holds none is skipped. */
    expect(asked.map((a) => [a.circuitId, a.contractAddress])).toEqual([['forgetUnshielded', VAULT]]);
    expect(proved).toEqual(['forgetUnshielded']);
    /* RED WHEN: the call names another token than the one the vault lists at nothing. */
    expect(asked[0]!.args.map(hex)).toEqual([TOKEN]);
  });

  it('BUILDS NOTHING FOR A TOKEN, A VAULT OR AN ACCOUNT THAT IS NOT THIRTY-TWO BYTES', async () => {
    for (const bad of [{ token: '01' }, { token: 'zz'.repeat(32) }, { vault: 'cd' }, { account: '' }]) {
      const { deps, asked } = standIns();
      /* RED WHEN: a malformed token reaches the prover, which would spend a proof on a call the chain refuses. */
      await expect(buildForgetUnshielded(deps, { vault: VAULT, account: ACCOUNT, token: TOKEN, chain: CHAIN, ...bad }))
        .rejects.toThrow(/nothing was built/u);
      expect(asked).toHaveLength(0);
    }
  });

  it('IS ANSWERED IN THE WORKER UNDER ITS OWN ASK, NEVER AS A RETIRE', async () => {
    const { deps, asked } = standIns();
    const wire = { blockHash: CHAIN.blockHash, vaultState: 'AQ==', zswapState: 'Ag==', parameters: 'Aw==', accountState: 'BA==' };
    const answer = await retireAnswered(deps, { id: 3, network: 'undeployed', ask: 'forget-unshielded', vault: VAULT, account: ACCOUNT, token: TOKEN, chain: wire });
    /* RED WHEN: a forget ask is built as the vault's retire, which the vault refuses while the token is still listed. */
    expect(answer).toEqual({ id: 3, ok: true, ask: 'forget-unshielded', tx: 'Bw==' });
    expect(asked.map((a) => a.circuitId)).toEqual(['forgetUnshielded']);
  });
});
