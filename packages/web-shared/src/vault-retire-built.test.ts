/**
 * **A VAULT'S RETIRE IS BUILT FROM THE DEVICE AGAINST THE PROPOSAL ITS SIGNERS APPROVED.** The vault marks itself
 * retired and asks the company's account to retire it under the proposal and its salt, so the call carries exactly
 * those two, and the account's state it is proved against is served for that account at that block only. The
 * ledger, the transaction builder and the prover are stand-ins that record what the builder asks.
 */
import { describe, it, expect } from 'vitest';
import type { VaultBuilderDeps } from './vault-builder.js';
import { buildRetire, retireAnswered } from './vault-retire-built.js';

const VAULT = 'cd'.repeat(32);
const ACCOUNT = 'ef'.repeat(32);
const PROPOSAL = 'aa'.repeat(32);
const SALT = 'bb'.repeat(32);
const CHAIN = {
  blockHash: '99'.repeat(32),
  vaultState: new Uint8Array([1]),
  zswapState: new Uint8Array([2]),
  parameters: new Uint8Array([3]),
  accountState: new Uint8Array([4])
};
const hex = (b: unknown) => Buffer.from(b as Uint8Array).toString('hex');

const standIns = () => {
  const asked: Array<{ circuitId: string; contractAddress: string; args: readonly unknown[]; account: unknown }> = [];
  const proved: Array<string | undefined> = [];
  const deps: VaultBuilderDeps = {
    ledger: {
      ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'cpk', encryptionPublicKey: 'epk' }) }
    },
    runtimeState: { deserialize: (b: Uint8Array) => ({ state: b[0] }) },
    contracts: {
      buildDeploy: async () => {
        throw new Error('no deploy here');
      },
      buildCall: async (_zk, call) => {
        asked.push({
          circuitId: call.circuitId,
          contractAddress: call.contractAddress,
          args: call.args ?? [],
          account: call.account
        });
        return { private: { unprovenTx: 'unproven' as never, transaction: null, nextZswapLocalState: null } };
      }
    },
    compiled: {},
    zkConfig: {},
    prove: async (_u: unknown, circuit?: string) => {
      proved.push(circuit);
      return { serialize: () => new Uint8Array([7]) };
    },
    network: 'undeployed',
    random: (n) => new Uint8Array(n).fill(4)
  };
  return { deps, asked, proved };
};

describe('a vault retired from the device that carries it', () => {
  it("CALLS THE VAULT'S RETIRE WITH THE APPROVED PROPOSAL AND ITS SALT, PROVED AGAINST THE ACCOUNT AT THE BLOCK READ", async () => {
    const { deps, asked, proved } = standIns();
    const built = await buildRetire(deps, {
      vault: VAULT.toUpperCase(),
      account: ACCOUNT,
      proposal: PROPOSAL,
      salt: SALT,
      chain: CHAIN
    });
    expect([...built.proven]).toEqual([7]);
    /* RED WHEN: the retire is built as another circuit, or proved as one, so the vault never marks itself retired. */
    expect(asked.map((a) => [a.circuitId, a.contractAddress])).toEqual([['retire', VAULT]]);
    expect(proved).toEqual(['retire']);
    /* RED WHEN: the proposal and the salt swap places, or either is not the one approved. */
    expect(asked[0]!.args.map(hex)).toEqual([PROPOSAL, SALT]);
    /* RED WHEN: the vault's call reads any account but the company's, or its state at any block but the one the call was read at. */
    expect(asked[0]!.account).toEqual({ address: ACCOUNT, state: CHAIN.accountState, blockHash: CHAIN.blockHash });
  });

  it('BUILDS NOTHING FOR A PROPOSAL, A SALT, A VAULT OR AN ACCOUNT THAT IS NOT THIRTY-TWO BYTES', async () => {
    for (const bad of [{ proposal: 'aa' }, { salt: 'zz'.repeat(32) }, { vault: 'cd' }, { account: '' }]) {
      const { deps, asked } = standIns();
      /* RED WHEN: a malformed value reaches the prover, which would spend a proof on a call the chain refuses. */
      await expect(
        buildRetire(deps, { vault: VAULT, account: ACCOUNT, proposal: PROPOSAL, salt: SALT, chain: CHAIN, ...bad })
      ).rejects.toThrow(/nothing was built/u);
      expect(asked).toHaveLength(0);
    }
  });
});

describe('a retire answered in the worker', () => {
  it("IS BUILT AS THE VAULT'S RETIRE UNDER ITS OWN ASK, FROM THE BLOCK READ", async () => {
    const { deps, asked } = standIns();
    const wire = {
      blockHash: CHAIN.blockHash,
      vaultState: 'AQ==',
      zswapState: 'Ag==',
      parameters: 'Aw==',
      accountState: 'BA=='
    };
    const answer = await retireAnswered(deps, {
      id: 3,
      network: 'undeployed',
      ask: 'retire',
      vault: VAULT,
      account: ACCOUNT,
      proposal: PROPOSAL,
      salt: SALT,
      chain: wire
    });
    /* RED WHEN: the worker answers a retire under another ask, or builds it as another circuit. */
    expect(answer).toEqual({ id: 3, ok: true, ask: 'retire', tx: 'Bw==' });
    expect(asked.map((a) => a.circuitId)).toEqual(['retire']);
    expect(asked[0]!.account).toEqual({ address: ACCOUNT, state: new Uint8Array([4]), blockHash: CHAIN.blockHash });
  });
});
