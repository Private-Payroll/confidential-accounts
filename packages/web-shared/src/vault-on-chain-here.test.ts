/**
 * **THE VAULT AS THE CHAIN HOLDS IT, READ ON THIS DEVICE.**
 *
 * What runs is the vault worker's own read, over a state of this build's vault
 * as the indexer serves one: made by the vault contract itself, held by a
 * committee key, holding one note, its first secret set and every sealed copy
 * written. The indexer is a stand-in that serves that state and a history; the
 * worker is the product's own handler behind the page's own client, so what
 * crosses is what the page is handed.
 */
import { describe, it, expect } from 'vitest';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as vaultModule from '../../../contracts/managed-vault/contract/index.js';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { readVaultOnChain, vaultChainSourceAt, type VaultChainSource } from './vault-on-chain-here.js';
import { answerVaultAsk, vaultAsDeployed } from './vault-worker-entry.js';
import { vaultBuilderOver, type VaultAnswer } from './vault-worker-client.js';

const VAULT = 'ab'.repeat(32);
const ACCOUNT = 'c0'.repeat(32);
const NOTE = '5e'.repeat(32);
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
const KEY = committeeKeyFor(identityFromSecret(new Uint8Array(32).fill(71)), LABEL) as { tag: string; value: string };
const INDEXER = { indexerUri: 'https://indexer.example/api/v3/graphql', indexerWsUri: 'wss://indexer.example/api/v3/graphql/ws' };
const d = { vault: vaultModule as never, runtimeState: (runtime as never as { ContractState: { deserialize(b: Uint8Array): unknown } }).ContractState };

const R = runtime as unknown as {
  ContractState: { deserialize(b: Uint8Array): any };
  ContractMaintenanceAuthority: new (committee: unknown[], threshold: number, counter: bigint) => unknown;
  StateValue: any; ChargedState: new (v: unknown) => unknown; CompactTypeBytes: new (n: number) => any;
};
const V = vaultModule as unknown as {
  Contract: new (w: unknown) => { initialState(a: unknown, b: unknown): Promise<{ currentContractState: { serialize(): Uint8Array } }> };
  pureCircuits: { copiesWrittenKey(): Uint8Array; secretCommitmentOf(v: Uint8Array, s: Uint8Array): Uint8Array };
};
const bytes = (h: string) => Uint8Array.from(h.match(/../gu)!, (x) => Number.parseInt(x, 16));
const noCircuit = new Proxy({}, { get: () => () => { throw new Error('no circuit runs here'); } });
const made = await new V.Contract(noCircuit).initialState(
  { initialPrivateState: {}, initialZswapLocalState: { coinPublicKey: new Uint8Array(32) } }, { bytes: bytes(ACCOUNT) });

/**
 * This build's vault as the chain would hold it: held by `KEY` alone, holding `notes`, and - when `started` - its first
 * secret's commitment set and the mark the last sealed copy leaves written.
 */
const aVault = (o: { notes: string[]; started: boolean; fewer?: boolean }): { serialize(): Uint8Array } => {
  const state = R.ContractState.deserialize(made.currentContractState.serialize());
  state.maintenanceAuthority = new R.ContractMaintenanceAuthority([KEY], 1, 0n);
  const fields: any[] = state.data.state.asArray();
  const bytes32 = new R.CompactTypeBytes(32);
  const aligned = (b: Uint8Array) => ({ value: bytes32.toValue(b), alignment: bytes32.alignment() });
  let notes = fields[1].asMap();
  for (const n of o.notes) notes = notes.insert(aligned(bytes(n)), R.StateValue.newNull());
  const held = V.pureCircuits.secretCommitmentOf(bytes(VAULT), bytes('51'.repeat(32)));
  const next = fields.map((f, i) => {
    if (i === 1) return R.StateValue.newMap(notes);
    if (o.started && i === 5) return R.StateValue.newCell({ value: [held], alignment: f.asCell().alignment });
    if (o.started && i === 7) return R.StateValue.newMap(f.asMap().insert(aligned(V.pureCircuits.copiesWrittenKey()), R.StateValue.newCell(aligned(held))));
    return f;
  });
  let array = R.StateValue.newArray();
  for (const f of o.fewer ? next.slice(0, -1) : next) array = array.arrayPush(f);
  state.data = new R.ChargedState(array);
  return state;
};

/** The indexer the wallet names, standing in: the state above and a history of one transaction that made an output for the vault. */
const anIndexer = (served: { serialize(): Uint8Array } | null, asked: string[] = []): VaultChainSource => ({
  contractState: async (address) => { asked.push(`state of ${address.slice(0, 4)}`); return served; },
  deployState: async (address) => { asked.push(`deploy of ${address.slice(0, 4)}`); return null; },
  transactions: { of: async (v) => { asked.push(`history of ${v.slice(0, 4)}`); return ['e1'.repeat(32)] as never; } },
  events: {
    eventsOf: async () => [
      { transactionHash: 'e1'.repeat(32), details: { tag: 'zswapOutput', commitment: 'f0'.repeat(32), contract: VAULT, mtIndex: 3n } },
      { transactionHash: 'e1'.repeat(32), details: { tag: 'zswapOutput', commitment: 'f1'.repeat(32), contract: 'cd'.repeat(32), mtIndex: 4n } },
    ],
  },
});

describe('THE VAULT, READ ON THIS DEVICE', () => {
  it('READS THE STATE, THE NOTES, EVERY COIN EVER MADE FOR IT, WHO HOLDS IT AND WHETHER IT IS STARTED, OFF THE STATE THE INDEXER SERVES', async () => {
    const served = aVault({ notes: [NOTE], started: true });
    const read = await readVaultOnChain(d, anIndexer(served), VAULT);
    if (!read.onChain) throw new Error('read as absent');
    /* RED WHEN: the notes are read off another field, or not read at all. */
    expect(read.notes).toEqual([NOTE]);
    expect(read.notesFromThisBuild).toBe(true);
    /* RED WHEN: who holds the vault is not read off the state's own maintenance authority. */
    expect(read.authority).toEqual({ committee: [{ tag: KEY.tag, value: KEY.value.toLowerCase() }], threshold: 1 });
    /* RED WHEN: a vault whose secret is set and every copy written reads as not started. */
    expect(read.started).toBe(true);
    expect(read.account).toBe(ACCOUNT);
    /* RED WHEN: an output made for another contract is counted as one of this vault's coins. */
    expect(read.everCreated).toEqual(['f0'.repeat(32)]);
    /* The state is handed on exactly as served, so what a deposit is built against is what the chain holds. */
    expect(read.state).toBe(Buffer.from(served.serialize()).toString('base64'));
  });

  it('A VAULT WHOSE FIRST SECRET IS NOT SET READS AS NOT STARTED, AND AN EMPTY ONE HOLDS NO NOTES', async () => {
    const read = await readVaultOnChain(d, anIndexer(aVault({ notes: [], started: false })), VAULT);
    /* RED WHEN: `started` is read as true for a vault fresh from its deploy - money then goes into a vault no one can pay out of. */
    expect(read).toMatchObject({ onChain: true, started: false, notes: [] });
  });

  it('AN ADDRESS THE INDEXER HOLDS NO STATE FOR IS NO VAULT, NEVER AN EMPTY ONE, AND ITS HISTORY IS NOT ASKED', async () => {
    const asked: string[] = [];
    /* RED WHEN: a missing state - the reader answers either null or nothing - is read as a vault with no notes. */
    expect(await readVaultOnChain(d, anIndexer(null, asked), VAULT)).toEqual({ onChain: false });
    expect(await readVaultOnChain(d, anIndexer(undefined as never, asked), VAULT)).toEqual({ onChain: false });
    expect(asked).toEqual([`state of ${VAULT.slice(0, 4)}`, `state of ${VAULT.slice(0, 4)}`]);
  });

  it('NOTES ARE NOT HANDED ON FROM A LEDGER OF ANOTHER SHAPE, AND THE READ SAYS WHY', async () => {
    const read = await readVaultOnChain(d, anIndexer(aVault({ notes: [NOTE], started: false, fewer: true })), VAULT);
    /* RED WHEN: the notes of a state laid out another way are handed on - they are then whatever field sits in their place. */
    expect(read).toMatchObject({ onChain: true, notesFromThisBuild: false });
    expect(read).not.toHaveProperty('notes');
    expect((read as { notesWhy?: string }).notesWhy).toMatch(/ledger fields/);
  });

  it('A STATE THAT IS NOT A VAULT\'S READS AS NOT STARTED, PINNED TO NO ACCOUNT, AND WITH NO NOTES', async () => {
    const read = await readVaultOnChain(d, anIndexer(new (runtime as any).ContractState()), VAULT);
    /* RED WHEN: a state the vault's ledger cannot be read from reads as started, or as pinned to an account. */
    expect(read).toMatchObject({ onChain: true, started: false, account: null, notesFromThisBuild: false });
    expect(read).not.toHaveProperty('notes');
  });

  it('A HISTORY THAT CANNOT BE READ IN FULL REFUSES THE READ', async () => {
    const broken: VaultChainSource = { ...anIndexer(aVault({ notes: [], started: true })), transactions: { of: async () => { throw new Error('the indexer did not answer'); } } };
    /* RED WHEN: an unreadable history is read as a vault that never held a coin. */
    await expect(readVaultOnChain(d, broken, VAULT)).rejects.toThrow(/the indexer did not answer/);
  });

  it('THE PAGE ASKS ITS VAULT WORKER, WHICH READS AT THE INDEXER THE WALLET NAMED AND NOWHERE ELSE', async () => {
    const at: unknown[] = [];
    const asked: string[] = [];
    const listeners: Array<(e: { data: unknown }) => void> = [];
    const deps = async () => ({ ...d, chainSourceAt: (i: unknown) => { at.push(i); return anIndexer(aVault({ notes: [NOTE], started: true }), asked); } });
    const client = vaultBuilderOver({
      addEventListener: (_t, l) => { listeners.push(l); },
      postMessage: (message) => {
        void answerVaultAsk(deps as never, message as never).then(
          (a: VaultAnswer) => listeners.forEach((l) => l({ data: a })),
          (e: Error) => listeners.forEach((l) => l({ data: { id: (message as { id: number }).id, ok: false, error: e.message } })));
      },
    }, 'undeployed');
    const read = await client.vaultOnChain({ vault: VAULT, indexer: INDEXER });
    /* RED WHEN: the worker reads at any endpoint but the one the page was handed by the wallet. */
    expect(at).toEqual([INDEXER]);
    expect(asked).toEqual([`state of ${VAULT.slice(0, 4)}`, `history of ${VAULT.slice(0, 4)}`]);
    expect(read).toMatchObject({ onChain: true, notes: [NOTE], started: true });
  });

  it('READS WHAT THE VAULT HOLDS IN PUBLIC MONEY OFF THE SAME STATE, AND SAYS WHY WHEN IT CANNOT', async () => {
    const state = aVault({ notes: [], started: true });
    const token = 'ab'.repeat(32);
    const served = { serialize: () => state.serialize(), balance: new Map<unknown, bigint>([[{ tag: 'unshielded', raw: token }, 4_000_000n], [{ tag: 'shielded', raw: 'cd'.repeat(32) }, 9n]]) };
    /* RED WHEN: the vault's public money is not read off the state this device read, or a private entry is counted as public. */
    expect(await readVaultOnChain(d, anIndexer(served), VAULT)).toMatchObject({ onChain: true, publicBalances: [{ token, amount: '4000000' }] });
    const unreadable = { serialize: () => state.serialize(), balance: new Map<unknown, bigint>([[{ tag: 'unshielded', raw: 'not a token' }, 1n]]) };
    const read = await readVaultOnChain(d, anIndexer(unreadable), VAULT);
    /* RED WHEN: a balance that cannot be read is handed on as holding nothing. */
    expect(read).not.toHaveProperty('publicBalances');
    expect((read as { publicBalancesWhy?: string }).publicBalancesWhy).toMatch(/Skipping it would understate/);
  });

  it('A VAULT\'S DEPLOY IS READ FROM THE CHAIN AT ITS OWN ADDRESS, AND ONE THE CHAIN HOLDS NONE FOR IS NO VAULT THIS COMPANY CAN USE', async () => {
    const asked: string[] = [];
    const refusal = await vaultAsDeployed(d as never, { vault: VAULT, account: ACCOUNT, holders: { committee: [KEY], threshold: 1 } }, anIndexer(null, asked));
    /* RED WHEN: a vault with no deploy on the chain is read as born held, or its deploy is read anywhere but at its own address. */
    expect(refusal).toMatch(/the chain holds no deploy at this vault's address/);
    expect(asked).toEqual([`deploy of ${VAULT.slice(0, 4)}`]);
  });

  it('AN INDEXER ADDRESS THAT CANNOT BE READ OVER HTTP IS REFUSED BEFORE ANYTHING IS ASKED', () => {
    /* RED WHEN: the endpoints are taken as they come - a wallet's misreport is then read from, or fails somewhere less plain. */
    expect(() => vaultChainSourceAt({ indexerUri: 'ftp://indexer.example', indexerWsUri: INDEXER.indexerWsUri })).toThrow(/not an address this can read from over HTTP/);
    expect(() => vaultChainSourceAt({ indexerUri: '', indexerWsUri: '' })).toThrow(/did not say which indexer/);
  });
});
