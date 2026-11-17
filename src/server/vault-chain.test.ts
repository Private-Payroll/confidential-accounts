/**
 * **THE CHAIN READER VOUCHES FOR A VAULT'S NOTES ONLY WHEN ITS LEDGER IS THIS
 * BUILD'S SHAPE.**
 *
 * What runs is the reader the service is built with, handed a vault's state
 * the way the indexer hands one over: this build's own vault contract's
 * starting state, and the same state with a field fewer, which is how a vault
 * deployed from an earlier build reads. Nothing is asked of an indexer; the one
 * named here is not there.
 */
import { describe, it, expect, vi } from 'vitest';
import { ChargedState, ContractState, StateValue } from '@midnight-ntwrk/compact-runtime';
import { vaultChainFromTheIndexer } from './vault-chain.js';

const { Contract } = await import('../../contracts/managed-vault/contract/index.js') as unknown as {
  Contract: new (w: unknown) => { initialState(a: unknown, b: unknown): Promise<{ currentContractState: ContractState }> };
};
const noCircuit = new Proxy({}, { get: () => () => { throw new Error('no circuit runs here'); } });
const built = await new Contract(noCircuit).initialState(
  { initialPrivateState: {}, initialZswapLocalState: { coinPublicKey: new Uint8Array(32) } }, { bytes: new Uint8Array(32) });
const thisBuilds = built.currentContractState;
/* The same ledger with its last field gone. */
const fields = thisBuilds.data.state.asArray()!;
let fewer = StateValue.newArray();
for (const f of fields.slice(0, -1)) fewer = fewer.arrayPush(f);
const anotherBuilds = new ContractState();
anotherBuilds.data = new ChargedState(fewer);

const chain = await vaultChainFromTheIndexer({ url: 'http://127.0.0.1:9/nothing-here', wsUrl: 'ws://127.0.0.1:9/nothing-here' });

describe('THE CHAIN READER\'S CHECK OF A VAULT\'S SHAPE', () => {
  it('passes this build\'s own vault', async () => {
    /* RED WHEN: the check refuses the shape this build deploys - every signer's device then refuses every private raise. */
    await expect(chain.ledgerIsThisBuilds!(thisBuilds)).resolves.toBeUndefined();
    expect(chain.notesOf(thisBuilds)).toEqual([]);
  });

  it('refuses a vault whose ledger holds a field fewer, saying how it differs', async () => {
    /* RED WHEN: the check is missing or passes anything - a device then compares its record with some other field. */
    await expect(chain.ledgerIsThisBuilds!(anotherBuilds)).rejects.toThrow(new RegExp(`${fields.length - 1} ledger fields`, 'u'));
  });
});

describe('THE CHAIN READER\'S LIST OF THE VAULTS A COMPANY\'S ACCOUNT HOLDS', () => {
  it('SAYS THE CHAIN COULD NOT BE ASKED, NEVER THAT THE ACCOUNT LISTS NO VAULT', async () => {
    /* RED WHEN: an indexer that does not answer is read as an account listing no vault. */
    await expect(chain.accountVaults!('ab'.repeat(32) as never)).rejects.toThrow(/could not be asked which vaults/);
  });
});

describe('THE CHAIN READER\'S LOOKUP OF THE TRANSACTION THAT CREATED AN OUTPUT', () => {
  it('SAYS THE CHAIN COULD NOT BE ASKED, NEVER THAT NO TRANSACTION CREATED IT', async () => {
    /* RED WHEN: an indexer that does not answer is read as an empty history - a payment on its way is then let go. */
    await expect(chain.createdBy!('ab'.repeat(32), 'cd'.repeat(32))).rejects.toThrow(/could not be asked/);
  });
});

describe('THE CHAIN READER\'S ACCOUNT AT ONE BLOCK, WHICH A RAISE OR AN APPROVAL IS BUILT ON', () => {
  it('READS THE ACCOUNT AT THE BLOCK THE INDEXER NAMES FIRST AND HANDS EACH STATE OVER AS BASE64 OF ITS BYTES', async () => {
    const held = 'c0'.repeat(32);
    const asked: string[] = [];
    const bytes = (s: string) => ({ serialize: () => new TextEncoder().encode(s) });
    vi.resetModules();
    vi.doMock('../midnight/providers.js', async (original) => ({
      ...await original<object>(),
      publicDataProviderAt: async () => ({
        queryBlock: async () => { asked.push('block'); return { hash: 'b7'.repeat(32) }; },
        queryZSwapAndContractState: async (address: string, at: { blockHash: string }) => {
          asked.push(`${address.slice(0, 4)} at ${at.blockHash.slice(0, 4)}`);
          return address === held ? { contractState: bytes('account'), ledgerParameters: bytes('parameters'), zswapChainState: bytes('zswap') } : null;
        },
      }),
    }));
    try {
      const { vaultChainFromTheIndexer: over } = await import('./vault-chain.js');
      const read = await over({ url: 'http://127.0.0.1:9/nothing-here', wsUrl: 'ws://127.0.0.1:9/nothing-here' });
      const b64 = (s: string) => Buffer.from(s).toString('base64');
      /* RED WHEN: the state a call is built on crosses as anything but the block and base64 of the account and the parameters read at it. */
      expect(await read.accountCallState!(held as never)).toEqual({ blockHash: 'b7'.repeat(32), accountState: b64('account'), parameters: b64('parameters') });
      /* RED WHEN: the account is read at any moment but the block named first. */
      expect(asked).toEqual(['block', 'c0c0 at b7b7']);
      /* RED WHEN: an account the chain does not hold at that block is answered as an account. */
      expect(await read.accountCallState!('ab'.repeat(32) as never)).toBeNull();
    } finally {
      vi.doUnmock('../midnight/providers.js');
      vi.resetModules();
    }
  });
});

describe('THE CHAIN READER\'S VAULT AND ACCOUNT AT ONE BLOCK, WHICH A STEP OUT OF THE VAULT IS BUILT ON', () => {
  it('READS BOTH CONTRACTS AT THE BLOCK THE INDEXER NAMES FIRST AND HANDS EACH STATE OVER AS BASE64 OF ITS BYTES', async () => {
    const vault = 'ab'.repeat(32);
    const account = 'c0'.repeat(32);
    const asked: string[] = [];
    const bytes = (s: string) => ({ serialize: () => new TextEncoder().encode(s) });
    vi.resetModules();
    vi.doMock('../midnight/providers.js', async (original) => ({
      ...await original<object>(),
      publicDataProviderAt: async () => ({
        queryBlock: async () => { asked.push('block'); return { hash: 'b7'.repeat(32) }; },
        queryZSwapAndContractState: async (address: string, at: { blockHash: string }) => {
          asked.push(`tree, state and parameters of ${address.slice(0, 4)} at ${at.blockHash.slice(0, 4)}`);
          return address === vault ? { contractState: bytes('vault'), ledgerParameters: bytes('parameters'), zswapChainState: bytes('zswap') } : null;
        },
        queryContractState: async (address: string, at: { blockHash: string }) => {
          asked.push(`state of ${address.slice(0, 4)} at ${at.blockHash.slice(0, 4)}`);
          return address === account ? { contractState: bytes('account') } : null;
        },
      }),
    }));
    try {
      const { vaultChainFromTheIndexer: over } = await import('./vault-chain.js');
      const read = await over({ url: 'http://127.0.0.1:9/nothing-here', wsUrl: 'ws://127.0.0.1:9/nothing-here' });
      const b64 = (s: string) => Buffer.from(s).toString('base64');
      /* RED WHEN: a step is built on anything but the block and base64 of the vault, the tree, the parameters and the account read at it. */
      expect(await read.payoutState!(vault as never, account as never)).toEqual({
        blockHash: 'b7'.repeat(32), vaultState: b64('vault'), zswapState: b64('zswap'), parameters: b64('parameters'), accountState: b64('account'),
      });
      /* RED WHEN: either contract is read at any moment but the block named first. */
      expect(asked).toEqual(['block', 'tree, state and parameters of abab at b7b7', 'state of c0c0 at b7b7']);
      /* RED WHEN: a vault or an account the chain does not hold at that block is answered as a state to build on. */
      expect([await read.payoutState!(account as never, account as never), await read.payoutState!(vault as never, vault as never)]).toEqual([null, null]);
    } finally {
      vi.doUnmock('../midnight/providers.js');
      vi.resetModules();
    }
  });
});
