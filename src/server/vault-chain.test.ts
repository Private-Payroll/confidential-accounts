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
import { describe, it, expect } from 'vitest';
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

describe('THE CHAIN READER\'S LOOKUP OF THE TRANSACTION THAT CREATED AN OUTPUT', () => {
  it('SAYS THE CHAIN COULD NOT BE ASKED, NEVER THAT NO TRANSACTION CREATED IT', async () => {
    /* RED WHEN: an indexer that does not answer is read as an empty history - a payment on its way is then let go. */
    await expect(chain.createdBy!('ab'.repeat(32), 'cd'.repeat(32))).rejects.toThrow(/could not be asked/);
  });
});
