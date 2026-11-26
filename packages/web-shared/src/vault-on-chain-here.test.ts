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
import { describe, it, expect, vi } from 'vitest';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as vaultModule from '../../../contracts/managed-vault/contract/index.js';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { accountPresenceAt, accountAtOneBlockOver, contractStatesAt, STATES_AT_ONCE, atOneBlockOver, readAccountCallChain, readVaultOnChain, readVaultsOnChain, vaultChainSourceAt, type BlockReader, type VaultChainSource } from './vault-on-chain-here.js';
import { answerVaultAsk } from './vault-worker-entry.js';
import { vaultAsDeployed } from './vault-as-deployed.js';
import { newestTimeToLive, readTransaction } from './vault-builder.js';
import { everyVaultAnswered, vaultBuilderOver, type VaultAnswer } from './vault-worker-client.js';
import { existsSync, readFileSync } from 'node:fs';
import * as accountModule from '../../../contracts/managed/contract/index.js';
import { DEPLOYED_CIRCUITS } from '../../../src/midnight/deferral.js';
import { contractStateAt } from '../../../src/midnight/contract-state-at.js';
import { NoteIndexUnaskable, NoteIndexUnreadable, type ServedEvent } from '../../../src/midnight/note-index.js';
import { HISTORIES_AT_ONCE } from '../../../src/midnight/indexer-queries.js';
import * as L from '@midnightntwrk/ledger-v9';
import { keyFileAround } from '../../../src/testing/an-operation-holding.js';

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
  CompactTypeBoolean: { toValue(b: boolean): unknown; alignment(): unknown };
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
 * secret's commitment set and the mark the last sealed copy leaves written; when `retired`, carrying the mark its own
 * retire writes.
 */
const aVault = (o: { notes: string[]; started: boolean; fewer?: boolean; split?: [string, string]; retired?: boolean }): { serialize(): Uint8Array } => {
  const state = R.ContractState.deserialize(made.currentContractState.serialize());
  state.maintenanceAuthority = new R.ContractMaintenanceAuthority([KEY], 1, 0n);
  const fields: any[] = state.data.state.asArray();
  const bytes32 = new R.CompactTypeBytes(32);
  const aligned = (b: Uint8Array) => ({ value: bytes32.toValue(b), alignment: bytes32.alignment() });
  let notes = fields[1].asMap();
  for (const n of o.notes) notes = notes.insert(aligned(bytes(n)), R.StateValue.newNull());
  const bool = R.CompactTypeBoolean;
  const held = V.pureCircuits.secretCommitmentOf(bytes(VAULT), bytes('51'.repeat(32)));
  const next = fields.map((f, i) => {
    if (i === 1) return R.StateValue.newMap(notes);
    if (o.retired === true && i === fields.length - 1) return R.StateValue.newCell({ value: bool.toValue(true), alignment: bool.alignment() });
    if (o.started && i === 5) return R.StateValue.newCell({ value: [held], alignment: f.asCell().alignment });
    if (o.split !== undefined && i === 6) return R.StateValue.newMap(f.asMap().insert(aligned(bytes(o.split[0])), R.StateValue.newCell(aligned(bytes(o.split[1])))));
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
  /* One block, and as of it the commitment tree, the vault's state, the parameters and the account's state; none while there is no vault. */
  atOneBlock: async (vault, account) => {
    asked.push(`block for ${vault.slice(0, 4)} and ${account.slice(0, 4)}`);
    if (served === null || served === undefined) return null;
    return { blockHash: 'b1'.repeat(32), zswap: bytesOf('zswap'), vault: served, parameters: bytesOf('parameters'), account: bytesOf('account') };
  },
});
const bytesOf = (t: string) => ({ serialize: () => new TextEncoder().encode(t) });
/** The page's own client over the worker's own handler, with the indexer the worker reads at stood in by `source`. */
const aClient = (source: () => VaultChainSource, at: unknown[]) => {
  const listeners: Array<(e: { data: unknown }) => void> = [];
  const deps = async () => ({ ...d, chainSourceAt: (i: unknown) => { at.push(i); return source(); } });
  return vaultBuilderOver({
    addEventListener: (_t, l) => { listeners.push(l); },
    postMessage: (message) => {
      void answerVaultAsk(deps as never, message as never).then(
        (a: VaultAnswer) => listeners.forEach((l) => l({ data: a })),
        (e: Error) => listeners.forEach((l) => l({ data: { id: (message as { id: number }).id, ok: false, error: e.message } })));
    },
  }, 'undeployed');
};

describe('THE VAULT, READ ON THIS DEVICE', () => {
  it('READS THE STATE, THE NOTES, EVERY COIN EVER MADE FOR IT AND WHETHER IT IS STARTED, OFF THE STATE THE INDEXER SERVES, AND NEVER WHO HOLDS IT', async () => {
    const served = aVault({ notes: [NOTE], started: true });
    const read = await readVaultOnChain(d, anIndexer(served), VAULT);
    if (!read.onChain) throw new Error('read as absent');
    /* RED WHEN: the notes are read off another field, or not read at all. */
    expect(read.notes).toEqual([NOTE]);
    expect(read.notesFromThisBuild).toBe(true);
    /* RED WHEN: the read money goes in and out on carries who holds the vault, which no payment or deposit waits on. */
    expect(Object.keys(read)).not.toContain('authority');
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

  it('THE READ CARRIES THE SECRET\'S COMMITMENT AND THE SPLIT JOURNAL THE VAULT HOLDS, AND NEITHER FROM A LEDGER OF ANOTHER SHAPE', async () => {
    const read = await readVaultOnChain(d, anIndexer(aVault({ notes: [NOTE], started: true, split: ['5e'.repeat(32), '3a'.repeat(32)] })), VAULT);
    /* RED WHEN: the commitment or the split journal is read off another field, or not read: a split's pieces are then named by nothing. */
    expect(read).toMatchObject({
      nonceCommitment: Buffer.from(V.pureCircuits.secretCommitmentOf(bytes(VAULT), bytes('51'.repeat(32)))).toString('hex'),
      splitJournal: [['5e'.repeat(32), '3a'.repeat(32)]],
    });
    const other = await readVaultOnChain(d, anIndexer(aVault({ notes: [NOTE], started: true, fewer: true })), VAULT);
    /* RED WHEN: a ledger of another shape hands on a commitment or a split journal, which would be whatever field sits there, or an empty one. */
    expect(other).not.toHaveProperty('nonceCommitment');
    expect(other).not.toHaveProperty('splitJournal');
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

  it('WHAT A STEP OUT OF THE VAULT IS BUILT ON IS READ BY THE WORKER AT THE WALLET\'S INDEXER, BOTH CONTRACTS AT ONE BLOCK', async () => {
    const at: unknown[] = [];
    const asked: string[] = [];
    const state = aVault({ notes: [NOTE], started: true });
    const chain = await aClient(() => anIndexer(state, asked), at).chainAtOneBlock({ vault: VAULT, account: ACCOUNT, indexer: INDEXER });
    /* RED WHEN: the worker reads the block anywhere but at the indexer the page was handed by the wallet. */
    expect(at).toEqual([INDEXER]);
    /* RED WHEN: the account read is any but the one the page named, or the vault any but the one asked. */
    expect(asked).toEqual([`block for ${VAULT.slice(0, 4)} and ${ACCOUNT.slice(0, 4)}`]);
    const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
    /* RED WHEN: any of the four is taken from somewhere but the one block read, or two of them are swapped. */
    expect(chain).toEqual({
      blockHash: 'b1'.repeat(32), vaultState: b64(state.serialize()), zswapState: b64(bytesOf('zswap').serialize()),
      parameters: b64(bytesOf('parameters').serialize()), accountState: b64(bytesOf('account').serialize()),
    });
    /* RED WHEN: a block that holds no vault is answered as an empty one rather than as not read yet. */
    expect(await aClient(() => anIndexer(null, []), []).chainAtOneBlock({ vault: VAULT, account: ACCOUNT, indexer: INDEXER })).toBeNull();
  });

  it('THE INDEXER IS ASKED FOR ONE BLOCK FIRST, AND BOTH CONTRACTS ARE READ AS OF THAT BLOCK; A CONTRACT IT HOLDS AT NONE IS NOT READ YET', async () => {
    const asked: string[] = [];
    /* A stand-in for the indexer package's reader, answering only the three reads asked of it, each with bytes that name it. */
    type AtBlock = { readonly blockHash: string };
    const reader = (o: { block?: boolean; vault?: boolean; account?: boolean } = {}): BlockReader => ({
      queryBlock: async () => { asked.push('block'); return o.block === false ? null : { hash: 'b7'.repeat(32) }; },
      queryZSwapAndContractState: async (address: string, at: AtBlock) => {
        asked.push(`tree, state and parameters of ${address.slice(0, 4)} at ${at.blockHash.slice(0, 4)}`);
        return o.vault === false ? null
          : { protocolVersion: 1, zswapChainState: bytesOf('zswap'), contractState: bytesOf('vault'), ledgerParameters: bytesOf('parameters') };
      },
      queryContractState: async (address: string, at: AtBlock) => {
        asked.push(`state of ${address.slice(0, 4)} at ${at.blockHash.slice(0, 4)}`);
        return o.account === false ? null : { protocolVersion: 1, contractState: bytesOf('account'), ledgerParameters: bytesOf('other parameters') };
      },
    }) as unknown as BlockReader;
    const read = await atOneBlockOver(reader(), VAULT, ACCOUNT);
    /* RED WHEN: either contract is read at any moment but the block named first, or the account read is not the one asked. */
    expect(asked).toEqual(['block', `tree, state and parameters of ${VAULT.slice(0, 4)} at b7b7`, `state of ${ACCOUNT.slice(0, 4)} at b7b7`]);
    /* RED WHEN: the three the vault's read answers are taken in any other order. */
    expect([read!.blockHash, ...[read!.zswap, read!.vault, read!.parameters, read!.account].map((b) => new TextDecoder().decode(b.serialize()))])
      .toEqual(['b7'.repeat(32), 'zswap', 'vault', 'parameters', 'account']);
    /* RED WHEN: a block, a vault or an account the indexer does not hold is answered as anything but not read yet. */
    for (const o of [{ block: false }, { vault: false }, { account: false }]) expect(await atOneBlockOver(reader(o), VAULT, ACCOUNT), JSON.stringify(o)).toBeNull();
  });

  it('A CONTRACT\'S STATE AND ITS DEPLOY ARE THE STATES THE INDEXER READ, DECODED HERE, AND ONE IT HOLDS NONE OF IS NOT READ YET', async () => {
    const { SerializedContractState } = await import('@midnight-ntwrk/midnight-js-types');
    const held = new runtime.ContractState();
    const served = { protocolVersion: 1, contractState: SerializedContractState.fromBytes('v9', held.serialize()) };
    const asked: string[] = [];
    vi.resetModules();
    vi.doMock('./public-data.js', async (original) => ({
      ...await original<object>(),
      publicDataProviderFor: async () => ({
        queryContractState: async (address: string) => { asked.push(`state of ${address.slice(0, 4)}`); return address === VAULT ? served : null; },
        queryDeployContractState: async (address: string) => { asked.push(`deploy of ${address.slice(0, 4)}`); return address === VAULT ? served : null; },
      }),
    }));
    try {
      const { vaultChainSourceAt: sourceAt } = await import('./vault-on-chain-here.js');
      const source = sourceAt(INDEXER);
      const state = await source.contractState(VAULT);
      const deploy = await source.deployState(VAULT);
      /* RED WHEN: a state is handed on as the indexer's read, which has no maintenance authority or circuits to check, rather than decoded. */
      expect(typeof (state as { operation?: unknown }).operation).toBe('function');
      expect(typeof (deploy as { operation?: unknown }).operation).toBe('function');
      expect(state!.serialize()).toEqual(held.serialize());
      /* RED WHEN: a contract the indexer holds no state or deploy for is answered as anything but not read yet. */
      expect(await source.contractState(ACCOUNT)).toBeNull();
      expect(await source.deployState(ACCOUNT)).toBeNull();
      expect(asked).toEqual([`state of ${VAULT.slice(0, 4)}`, `deploy of ${VAULT.slice(0, 4)}`, `state of ${ACCOUNT.slice(0, 4)}`, `deploy of ${ACCOUNT.slice(0, 4)}`]);
    } finally {
      vi.doUnmock('./public-data.js');
      vi.resetModules();
    }
  });

  it('WHAT A CALL TO THE ACCOUNT ALONE IS BUILT ON - ITS STATE AND THE LEDGER\'S PARAMETERS AT ONE BLOCK - IS READ AT THE WALLET\'S INDEXER', async () => {
    const asked: string[] = [];
    type AtBlock = { readonly blockHash: string };
    const reader = (o: { block?: boolean; account?: boolean } = {}): BlockReader => ({
      queryBlock: async () => { asked.push('block'); return o.block === false ? null : { hash: 'b7'.repeat(32) }; },
      queryZSwapAndContractState: async (address: string, at: AtBlock) => {
        asked.push(`tree, state and parameters of ${address.slice(0, 4)} at ${at.blockHash.slice(0, 4)}`);
        return o.account === false ? null
          : { protocolVersion: 1, zswapChainState: bytesOf('zswap'), contractState: bytesOf('account'), ledgerParameters: bytesOf('parameters') };
      },
      queryContractState: async () => { asked.push('a state alone'); return null; },
    }) as unknown as BlockReader;
    const read = await accountAtOneBlockOver(reader(), ACCOUNT);
    /* RED WHEN: the account is read at any moment but the block named first, or its parameters from another read. */
    expect(asked).toEqual(['block', `tree, state and parameters of ${ACCOUNT.slice(0, 4)} at b7b7`]);
    expect([read!.blockHash, ...[read!.account, read!.parameters].map((b) => new TextDecoder().decode(b.serialize()))])
      .toEqual(['b7'.repeat(32), 'account', 'parameters']);
    /* RED WHEN: a block or an account the indexer does not hold is answered as anything but not read yet. */
    for (const o of [{ block: false }, { account: false }]) expect(await accountAtOneBlockOver(reader(o), ACCOUNT), JSON.stringify(o)).toBeNull();
    const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
    const source = { accountAtOneBlock: (a: string) => accountAtOneBlockOver(reader(), a) } as unknown as VaultChainSource;
    /* RED WHEN: the call state crosses as anything but the block and base64 of the two it was read as. */
    expect(await readAccountCallChain(source, ACCOUNT)).toEqual({
      blockHash: 'b7'.repeat(32), accountState: b64(bytesOf('account').serialize()), parameters: b64(bytesOf('parameters').serialize()),
    });
    /* RED WHEN: a source that cannot read the account alone is answered as an account at no block. */
    await expect(readAccountCallChain({} as VaultChainSource, ACCOUNT)).rejects.toThrow(/cannot read the company's account/);
  });

  it('A TRANSACTION\'S EVENTS AND THE ONE THAT CREATED AN OUTPUT ARE READ BY THE WORKER AT THE WALLET\'S INDEXER, ONLY THE VAULT\'S OWN', async () => {
    const at: unknown[] = [];
    const client = aClient(() => anIndexer(aVault({ notes: [], started: true })), at);
    /* RED WHEN: an index crosses as anything but its decimal digits, or an event's owner is dropped on the way. */
    expect(await client.eventsOf({ transactionHash: 'e1'.repeat(32), indexer: INDEXER })).toEqual([
      { transactionHash: 'e1'.repeat(32), details: { tag: 'zswapOutput', commitment: 'f0'.repeat(32), contract: VAULT, mtIndex: '3' } },
      { transactionHash: 'e1'.repeat(32), details: { tag: 'zswapOutput', commitment: 'f1'.repeat(32), contract: 'cd'.repeat(32), mtIndex: '4' } },
    ]);
    expect(await client.createdBy({ vault: VAULT, commitment: 'f0'.repeat(32), indexer: INDEXER }))
      .toMatchObject({ transactionHash: 'e1'.repeat(32), events: [{ details: { mtIndex: '3' } }, { details: { mtIndex: '4' } }] });
    /* RED WHEN: an output another contract owns answers for this vault. */
    expect(await client.createdBy({ vault: VAULT, commitment: 'f1'.repeat(32), indexer: INDEXER })).toBeNull();
    expect(at).toEqual([INDEXER, INDEXER, INDEXER]);
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

  it('READS THE VAULT\'S OWN RETIRED MARK, WHICH ITS DEPOSITS REFUSE ON, AND NONE FROM A LEDGER OF ANOTHER SHAPE', async () => {
    /* RED WHEN: the mark the vault's retire writes is not read, so a retired vault is read as taking deposits. */
    expect(await readVaultOnChain(d, anIndexer(aVault({ notes: [], started: true, retired: true })), VAULT))
      .toMatchObject({ onChain: true, retired: true });
    expect(await readVaultOnChain(d, anIndexer(aVault({ notes: [], started: true })), VAULT)).toMatchObject({ retired: false });
    /* RED WHEN: a mark read off a ledger of another shape is handed on as the vault's. */
    const other = await readVaultOnChain(d, anIndexer(aVault({ notes: [], started: true, fewer: true })), VAULT);
    expect(other).not.toHaveProperty('retired');
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

/* Every circuit's verifying key exactly as this build compiled it, read off the key files beside each compiled contract. */
const keyOf = (folder: 'managed-vault' | 'managed', circuit: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../../contracts/${folder}/keys/${circuit}.verifier`, import.meta.url)));
const VAULT_VK = (vaultModule as unknown as { expectedVk: Record<string, string> }).expectedVk;
const ACCOUNT_VK = (accountModule as unknown as { expectedVk: Record<string, string> }).expectedVk;
/* These checks need this build's compiled keys: a build without them (CI's test job) runs them in its keys job. */
const HAS_KEYS = Object.keys(VAULT_VK).length > 0 && Object.keys(ACCOUNT_VK).length > 0
  && existsSync(new URL('../../../contracts/managed-vault/keys/payout.verifier', import.meta.url))
  && existsSync(new URL('../../../contracts/managed/keys/setPolicy.verifier', import.meta.url));
const Rt = runtime as unknown as { ContractOperation: new () => { verifierKey: Uint8Array } };

/** A state whose circuits carry the given keys: `keys` maps a circuit name to its key, or to null for a circuit with no key. */
const withKeys = (state: any, keys: Record<string, Uint8Array | null>): any => {
  for (const [name, key] of Object.entries(keys)) {
    const op = new Rt.ContractOperation();
    if (key !== null) op.verifierKey = key;
    state.setOperation(name, op);
  }
  return R.ContractState.deserialize(state.serialize());
};
const thisBuilds = (folder: 'managed-vault' | 'managed', vk: Record<string, string>) =>
  Object.fromEntries(Object.keys(vk).map((c) => [c, keyOf(folder, c)]));
const aVaultOfThisBuild = (keys: Record<string, Uint8Array | null> = {}) =>
  withKeys(aVault({ notes: [NOTE], started: true }), { ...thisBuilds('managed-vault', VAULT_VK), ...keys });
const anAccountOfThisBuild = (keys: Record<string, Uint8Array | null> = {}) =>
  withKeys(new (runtime as any).ContractState(), { ...thisBuilds('managed', ACCOUNT_VK), ...keys });
/** An indexer that serves the vault's state at the vault and the account's at the account, and says what it was asked. */
const vaultAndAccount = (vault: unknown, account: unknown, asked: string[] = []): VaultChainSource => {
  const plain = anIndexer(vault as never, asked);
  return {
    ...plain,
    contractState: async (address) => {
      asked.push(`state of ${address.slice(0, 4)}`);
      return (address === VAULT ? vault : address === ACCOUNT ? account : null) as never;
    },
  };
};
const withAccount = { ...d, accountExpectedVk: ACCOUNT_VK };
const flipped = (b: Uint8Array) => { const c = b.slice(); c[c.length - 1] = c.at(-1)! ^ 1; return c; };

describe.skipIf(!HAS_KEYS)('MONEY GOES IN OR OUT ONLY WHERE EVERY CIRCUIT OF THE VAULT AND ITS ACCOUNT IS THIS APP\'S [needs contracts/managed-vault/keys and contracts/managed/keys; `npm run compact` then `npm run compact:vault -- --full` build them]', () => {
  it('A VAULT AND AN ACCOUNT WHOSE EVERY CIRCUIT IS THIS BUILD\'S READ AS THIS BUILD\'S', async () => {
    const asked: string[] = [];
    const read = await readVaultOnChain(withAccount, vaultAndAccount(aVaultOfThisBuild(), anAccountOfThisBuild(), asked), VAULT, ACCOUNT);
    /* RED WHEN: a vault or an account of this very build is refused, so no money could ever go in. */
    expect(read).toMatchObject({ onChain: true, circuits: null, accountCircuits: null });
    /* RED WHEN: the account is read anywhere but at the account the ask named. */
    expect(asked).toContain(`state of ${ACCOUNT.slice(0, 4)}`);
  });

  it('A VAULT ONE OF WHOSE CIRCUITS CARRIES ANOTHER KEY IS NOT THIS BUILD\'S, AND THE CIRCUIT IS NAMED', async () => {
    const read = await readVaultOnChain(withAccount,
      vaultAndAccount(aVaultOfThisBuild({ deposit: keyOf('managed-vault', 'payout') }), anAccountOfThisBuild()), VAULT, ACCOUNT);
    /* RED WHEN: only the circuits' names are compared - a vault whose deposit accepts other proofs then takes money. */
    expect(read).toMatchObject({ circuits: { circuit: 'deposit' } });
    expect((read as { circuits: { why: string } }).circuits.why).toMatch(/'deposit' circuit is not the one this app's build compiled/);
  });

  it('A VAULT OR AN ACCOUNT ONE OF WHOSE CIRCUITS HIDES A SECOND KEY IN ITS OTHER SLOT IS NOT THIS BUILD\'S, AND THE CIRCUIT IS NAMED', async () => {
    /* This build's key stays in the slot the ledger's own reading shows; a key of the older proving system goes beside it. */
    const hiding = (state: any, circuit: string): any => {
      const op = state.operation(circuit);
      op.verifierKey = keyFileAround('a key nobody compiled', 'older');
      state.setOperation(circuit, op);
      return R.ContractState.deserialize(state.serialize());
    };
    const vault = await readVaultOnChain(withAccount, vaultAndAccount(hiding(aVaultOfThisBuild(), 'payout'), anAccountOfThisBuild()), VAULT, ACCOUNT);
    /* RED WHEN: a vault's circuits are judged by the one key the ledger's own reading shows - money then goes into a vault that pays out on another statement. */
    expect(vault).toMatchObject({ circuits: { circuit: 'payout' }, accountCircuits: null });
    const account = await readVaultOnChain(withAccount, vaultAndAccount(aVaultOfThisBuild(), hiding(anAccountOfThisBuild(), 'recordPaymentFromVault')), VAULT, ACCOUNT);
    /* RED WHEN: the account's circuits are judged the same way. */
    expect(account).toMatchObject({ circuits: null, accountCircuits: { circuit: 'recordPaymentFromVault' } });
  });

  it('A VAULT WITH A CIRCUIT THIS BUILD DOES NOT HAVE, OR A CIRCUIT WITH NO KEY, IS NOT THIS BUILD\'S', async () => {
    const extra = await readVaultOnChain(d, vaultAndAccount(aVaultOfThisBuild({ sweep: keyOf('managed-vault', 'payout') }), null), VAULT);
    /* RED WHEN: the set of circuits is not compared - a vault with an added way out of it then takes money. */
    expect(extra).toMatchObject({ circuits: { circuit: null } });
    expect((extra as { circuits: { why: string } }).circuits.why).toMatch(/circuits other than the vault's own/);
    const keyless = await readVaultOnChain(d, vaultAndAccount(aVaultOfThisBuild({ payout: null }), null), VAULT);
    /* RED WHEN: a circuit with no key on the chain counts as this build's. */
    expect(keyless).toMatchObject({ circuits: { circuit: 'payout' } });
  });

  it('A VAULT OR AN ACCOUNT WITH ONE OF THIS BUILD\'S CIRCUITS REMOVED IS NOT THIS BUILD\'S', async () => {
    /* The same vault, and an account, holding every circuit this build has but one: every one left carries its own key. */
    const without = (data: unknown, folder: 'managed-vault' | 'managed', vk: Record<string, string>, gone: string) => {
      const state = new (runtime as any).ContractState();
      if (data !== undefined) state.data = data;
      const { [gone]: _gone, ...left } = thisBuilds(folder, vk);
      return withKeys(state, left);
    };
    const vault = without((aVault({ notes: [NOTE], started: true }) as unknown as { data: unknown }).data, 'managed-vault', VAULT_VK, 'payout');
    const account = without(undefined, 'managed', ACCOUNT_VK, 'recordPaymentFromVault');
    const noPayout = await readVaultOnChain(withAccount, vaultAndAccount(vault, anAccountOfThisBuild()), VAULT, ACCOUNT);
    /* RED WHEN: a circuit this build has but the vault lacks is skipped - money then goes into a vault no payment can leave. */
    expect((noPayout as { circuits: { why: string } }).circuits.why).toMatch(/circuits other than the vault's own/);
    const noRecord = await readVaultOnChain(withAccount, vaultAndAccount(aVaultOfThisBuild(), account), VAULT, ACCOUNT);
    /* RED WHEN: an account missing one of this build's circuits passes, so the vault's payments have no account step to record them. */
    expect((noRecord as { accountCircuits: { why: string } }).accountCircuits.why).toMatch(/circuits other than the account's own/);
  });

  it('THE VAULT IS HELD AGAINST THE DIGESTS THE COMPILED VAULT ITSELF CARRIES, AND A BUILD WITH NONE REFUSES', async () => {
    const otherDigest = { ...d, vault: { ...(vaultModule as object), expectedVk: { ...VAULT_VK, payout: '00'.repeat(32) } } as never };
    /* RED WHEN: the vault is held against any copy of the digests but the compiled vault's own. */
    expect(await readVaultOnChain(otherDigest, vaultAndAccount(aVaultOfThisBuild(), null), VAULT)).toMatchObject({ circuits: { circuit: 'payout' } });
    const none = { ...d, vault: { ...(vaultModule as object), expectedVk: {} } as never };
    const read = await readVaultOnChain(none, vaultAndAccount(aVaultOfThisBuild(), null), VAULT);
    /* RED WHEN: a build that carries no digests checks nothing and passes every vault. */
    expect((read as { circuits: { why: string } }).circuits.why).toMatch(/built without the digests of the vault's circuits/);
  });

  it('AN ACCOUNT ONE OF WHOSE CIRCUITS IS NOT THIS BUILD\'S, ONE THE CHAIN DOES NOT HOLD, OR ONE NOT CHECKABLE HERE IS REFUSED', async () => {
    const other = await readVaultOnChain(withAccount,
      vaultAndAccount(aVaultOfThisBuild(), anAccountOfThisBuild({ setPolicy: flipped(keyOf('managed', 'setPolicy')) })), VAULT, ACCOUNT);
    /* RED WHEN: the account's circuits are not checked - its vault then pays out on approvals its own circuits never asked for. */
    expect(other).toMatchObject({ circuits: null, accountCircuits: { circuit: 'setPolicy' } });
    const absent = await readVaultOnChain(withAccount, vaultAndAccount(aVaultOfThisBuild(), null), VAULT, ACCOUNT);
    /* RED WHEN: an account the chain holds no state for is passed as if its circuits were this build's. */
    expect((absent as { accountCircuits: { why: string } }).accountCircuits.why).toMatch(/the chain shows no company account/);
    const unchecked = await readVaultOnChain(d, vaultAndAccount(aVaultOfThisBuild(), anAccountOfThisBuild()), VAULT, ACCOUNT);
    /* RED WHEN: a worker that was not given the account's digests passes the account. */
    expect((unchecked as { accountCircuits: { why: string } }).accountCircuits.why).toMatch(/built without the digests of the account's circuits/);
  });

  it('THE ACCOUNT\'S CIRCUITS THIS DEVICE HOLDS AN ACCOUNT TO ARE THE ONES THE SERVICE DEPLOYS IT WITH', () => {
    /* RED WHEN: a circuit is deployed with the account but this build carries no digest for it, or the other way round - every account is then refused. */
    expect(Object.keys(ACCOUNT_VK).sort()).toEqual([...DEPLOYED_CIRCUITS].sort());
  });

  it('A READ THAT NAMES NO ACCOUNT DOES NOT ASK FOR ONE, AND SAYS NOTHING OF ONE', async () => {
    const asked: string[] = [];
    const read = await readVaultOnChain(withAccount, vaultAndAccount(aVaultOfThisBuild(), anAccountOfThisBuild(), asked), VAULT);
    /* RED WHEN: a start or a rebuild, which name no account, reads one anyway. */
    expect(asked).not.toContain(`state of ${ACCOUNT.slice(0, 4)}`);
    expect('accountCircuits' in read).toBe(false);
  });

  it('THE PAGE\'S ASK NAMES THE ACCOUNT AND THE WORKER CHECKS IT', async () => {
    const listeners: Array<(e: { data: unknown }) => void> = [];
    const asked: string[] = [];
    const deps = async () => ({ ...withAccount, chainSourceAt: () => vaultAndAccount(aVaultOfThisBuild(), anAccountOfThisBuild(), asked) });
    const client = vaultBuilderOver({
      addEventListener: (_t, l) => { listeners.push(l); },
      postMessage: (message) => {
        void answerVaultAsk(deps as never, message as never).then(
          (a: VaultAnswer) => listeners.forEach((l) => l({ data: a })),
          (e: Error) => listeners.forEach((l) => l({ data: { id: (message as { id: number }).id, ok: false, error: e.message } })));
      },
    }, 'undeployed');
    const read = await client.vaultOnChain({ vault: VAULT, account: ACCOUNT, indexer: INDEXER });
    /* RED WHEN: the worker drops the account the page named, so the account is never checked. */
    expect(read).toMatchObject({ circuits: null, accountCircuits: null });
    expect(asked).toContain(`state of ${ACCOUNT.slice(0, 4)}`);
  });
});


describe('WHETHER THE COMPANY\'S ACCOUNT IS ON THE CHAIN, READ ON THIS DEVICE BY THE CHAIN\'S OWN TIME', () => {
  const INDEXER = 'https://indexer.example/api/v4/graphql';
  const answering = (status: number, body: unknown): typeof fetch =>
    (async () => ({ ok: status < 400, status, json: async () => body }) as Response) as typeof fetch;
  const BLOCK = { height: 950444, timestamp: 1_792_492_326_000 };

  it('SAYS NOT HELD ONLY ON A CLEAN ANSWER THAT NAMES THE NEWEST BLOCK AND HOLDS NO CONTRACT, AND HELD WHEN IT HOLDS ONE', async () => {
    /* RED WHEN: an indexer that holds no contract at the address is read as held, or its block time is lost. */
    expect(await accountPresenceAt(INDEXER, 'ab'.repeat(32), answering(200, { data: { block: BLOCK, contractAction: null } })))
      .toEqual({ held: false, blockHeight: BLOCK.height, blockTime: BLOCK.timestamp });
    expect(await accountPresenceAt(INDEXER, 'ab'.repeat(32), answering(200, { data: { block: BLOCK, contractAction: { __typename: 'ContractCall' } } })))
      .toEqual({ held: true, blockHeight: BLOCK.height, blockTime: BLOCK.timestamp });
  });

  it('THROWS, NEVER SAYS NOT HELD, WHEN THE INDEXER IS DOWN, REFUSES, NAMES NO BLOCK OR DOES NOT ANSWER FOR THE ADDRESS', async () => {
    const cases: Array<[string, typeof fetch]> = [
      ['a server error', answering(503, { data: { block: BLOCK, contractAction: null } })],
      ['an error in the reply', answering(200, { errors: [{ message: 'x' }], data: null })],
      ['no data', answering(200, {})],
      ['no block', answering(200, { data: { block: null, contractAction: null } })],
      ['a block with no time', answering(200, { data: { block: { height: 1 }, contractAction: null } })],
      ['no answer for the address', answering(200, { data: { block: BLOCK } })],
      ['a network failure', (async () => { throw new Error('offline'); }) as typeof fetch],
    ];
    /* RED WHEN: any failure of the read is taken for "no contract here", which sets a landed creation aside. */
    for (const [what, f] of cases) await expect(accountPresenceAt(INDEXER, 'ab'.repeat(32), f), what).rejects.toThrow();
  });

  it('READS THE NEWEST TIME TO LIVE OF THE KEPT TRANSACTIONS FROM THEIR BYTES, AND NULL WHEN ANY CANNOT BE READ', () => {
    const at = (d: Date | undefined | 'bad') => d;
    const ttls: Record<string, Date | undefined | 'bad'> = { a: at(new Date(1_000)), b: at(new Date(5_000)), c: at('bad'), d: at(undefined) };
    const ledger = { Transaction: { deserialize: (_a: string, _b: string, _c: string, bytes: Uint8Array) => {
      const v = ttls[Buffer.from(bytes).toString()];
      if (v === 'bad') throw new Error('not a transaction');
      return { intents: new Map([[1, { ttl: v }]]) };
    } } };
    const bytes = (...k: string[]) => k.map((x) => new Uint8Array(Buffer.from(x)));
    /* RED WHEN: the earlier of the two times is taken, so a step still live is counted as run out. */
    expect(newestTimeToLive({ ledger } as never, bytes('a', 'b'))).toBe(5_000);
    expect(newestTimeToLive({ ledger } as never, bytes('a', 'c'))).toBeNull();
    expect(newestTimeToLive({ ledger } as never, bytes('b', 'd'))).toBeNull();
    expect(newestTimeToLive({ ledger } as never, [])).toBeNull();
  });

  it('READS A TRANSACTION AS FINISHED OR NOT YET BOUND, WITH ITS IDENTIFIERS, ITS EARLIEST TIME TO LIVE AND THE PART EACH CALL RUNS IN', () => {
    const call = (address: string, entryPoint: unknown, parts: { g?: boolean; f?: boolean }) => ({
      address, entryPoint, ...(parts.g ? { guaranteedTranscript: { effects: {} } } : {}), ...(parts.f ? { fallibleTranscript: { effects: {} } } : {}),
    });
    /* The deposit's own intent lives an hour; the fee merged in beside it, twenty minutes. */
    const finished = {
      identifiers: () => ['00aa', '00bb'],
      intents: new Map<number, unknown>([
        [7, { ttl: new Date(60_000), actions: [call('AB'.repeat(32), new TextEncoder().encode('depositUnshielded'), { g: true })] }],
        [2, { ttl: new Date(20_000), actions: [] }],
      ]),
    };
    const unbound = { identifiers: () => ['00cc'], intents: new Map([[3, { ttl: new Date(9_000), actions: [call('cd'.repeat(32), 'payout', { f: true }), call('ef'.repeat(32), 'split', { g: true, f: true })] }]]) };
    const read: string[] = [];
    const ledger = (bound: unknown, notBound: unknown) => ({ Transaction: { deserialize: (_s: string, _p: string, b: string) => {
      read.push(b);
      const tx = b === 'binding' ? bound : notBound;
      if (tx === undefined) throw new Error('not a transaction');
      return tx;
    } } });
    const one = new Uint8Array([1]);
    /* RED WHEN: a transaction the service merged its fee into is read as living as long as the deposit's own part, or cannot be read at all. */
    expect(readTransaction({ ledger: ledger(finished, undefined) } as never, one)).toEqual({
      identifiers: ['00aa', '00bb'], timeToLive: 20_000,
      calls: [{ address: 'ab'.repeat(32), entryPoint: 'depositUnshielded', segments: [0] }],
      coinsForContracts: [], publicTakes: null, publicDeposits: [{ vault: 'ab'.repeat(32), refused: 'unread' }],
    });
    /* RED WHEN: a transaction proved and not yet bound cannot be read, so a payment cannot name itself before it is sent. */
    read.length = 0;
    expect(readTransaction({ ledger: ledger(undefined, unbound) } as never, one)).toEqual({
      identifiers: ['00cc'], timeToLive: 9_000,
      calls: [{ address: 'cd'.repeat(32), entryPoint: 'payout', segments: [3] }, { address: 'ef'.repeat(32), entryPoint: 'split', segments: [0, 3] }],
      coinsForContracts: [], publicTakes: null, publicDeposits: [],
    });
    expect(read).toEqual(['binding', 'pre-binding']);
    /* RED WHEN: bytes that are no transaction, or an intent with no time, are read as a transaction that has run out. */
    expect(readTransaction({ ledger: ledger(undefined, undefined) } as never, one)).toBeNull();
    expect(readTransaction({ ledger: ledger({ identifiers: () => [], intents: new Map([[1, { ttl: undefined, actions: [] }]]) }, undefined) } as never, one)?.timeToLive).toBeNull();
    /* RED WHEN: the step of a company's creation whose fee sits in an intent of its own is read as already run out. */
    expect(newestTimeToLive({ ledger: ledger(finished, undefined) } as never, [one])).toBe(20_000);
  });

  it('READS EVERY PRIVATE COIN A TRANSACTION CREATES FOR A CONTRACT AND EVERY PUBLIC TOKEN ITS CALLS TAKE IN, AND SAYS SO WHEN EITHER CANNOT BE READ', () => {
    const ledgerOf = (tx: unknown) => ({ Transaction: { deserialize: () => tx } });
    const one = new Uint8Array([1]);
    const takes = (entries: Array<[{ tag: string; raw: string }, unknown]>) => ({ effects: { unshieldedInputs: new Map(entries) } });
    const tx = {
      identifiers: () => ['00aa'],
      intents: new Map<number, unknown>([[1, { ttl: new Date(9_000), actions: [
        { address: 'AB'.repeat(32), entryPoint: 'depositUnshielded', guaranteedTranscript: takes([[{ tag: 'unshielded', raw: 'CD'.repeat(32) }, 40n]]) },
      ] }]]),
      /* The vault's coin, the wallet's own change (no contract), and a coin made and spent inside the transaction for another contract. */
      guaranteedOffer: { outputs: [{ contractAddress: 'AB'.repeat(32), commitment: '0x' + 'E1'.repeat(32) }, { contractAddress: undefined, commitment: 'e2'.repeat(32) }], transients: [] },
      fallibleOffer: new Map([[1, { outputs: [], transients: [{ contractAddress: 'ef'.repeat(32), commitment: 'e3'.repeat(32) }] }]]),
    };
    /* RED WHEN: a coin created for a contract in either part is missed, the wallet's change is counted as one, or a public token a call takes in is not read. */
    const read = readTransaction({ ledger: ledgerOf(tx) } as never, one)!;
    /* RED WHEN: a coin made and spent inside the transaction reads as one its contract holds. */
    expect(read.coinsForContracts).toEqual([{ contract: 'ab'.repeat(32), commitment: 'e1'.repeat(32) }, { contract: 'ef'.repeat(32), commitment: 'e3'.repeat(32), madeAndSpent: true }]);
    expect(read.publicTakes).toEqual([{ address: 'ab'.repeat(32), entryPoint: 'depositUnshielded', colour: 'cd'.repeat(32), amount: '40' }]);
    /* RED WHEN: an offer or a transcript this cannot read is taken for one that creates or takes nothing. */
    expect(readTransaction({ ledger: ledgerOf({ ...tx, guaranteedOffer: { outputs: 'x' } }) } as never, one)!.coinsForContracts).toBeNull();
    expect(readTransaction({ ledger: ledgerOf({ ...tx, fallibleOffer: [] }) } as never, one)!.coinsForContracts).toBeNull();
    expect(readTransaction({ ledger: ledgerOf({ ...tx, guaranteedOffer: { outputs: [{ contractAddress: 'ab'.repeat(32) }] } }) } as never, one)!.coinsForContracts).toBeNull();
    const unreadCall = { ...tx, intents: new Map([[1, { ttl: new Date(9_000), actions: [{ address: 'ab'.repeat(32), entryPoint: 'deposit', guaranteedTranscript: { effects: {} } }] }]]) };
    expect(readTransaction({ ledger: ledgerOf(unreadCall) } as never, one)!.publicTakes).toBeNull();
    const shieldedTake = { ...tx, intents: new Map([[1, { ttl: new Date(9_000), actions: [{ address: 'ab'.repeat(32), entryPoint: 'deposit', guaranteedTranscript: takes([[{ tag: 'shielded', raw: 'cd'.repeat(32) }, 1n]]) }] }]]) };
    expect(readTransaction({ ledger: ledgerOf(shieldedTake) } as never, one)!.publicTakes).toBeNull();
  });

  it('IS ANSWERED BY THE WORKER FROM THE INDEXER THE ASK NAMES, WITH THE TIME TO LIVE OF THE TRANSACTIONS ASKED ABOUT', async () => {
    const at: unknown[] = [];
    const ledger = { Transaction: { deserialize: () => ({ intents: new Map([[1, { ttl: new Date(42_000) }]]) }) } };
    const source = { accountPresence: async () => ({ held: false, blockHeight: 7, blockTime: 99_000 }) } as unknown as VaultChainSource;
    const listeners: Array<(e: { data: unknown }) => void> = [];
    const deps = async () => ({ ...d, ledger, chainSourceAt: (i: unknown) => { at.push(i); return source; } });
    const client = vaultBuilderOver({
      addEventListener: (_t, l) => { listeners.push(l); },
      postMessage: (message) => {
        void answerVaultAsk(deps as never, message as never).then(
          (answer) => listeners.forEach((l) => l({ data: answer })),
          (e: Error) => listeners.forEach((l) => l({ data: { id: (message as { id: number }).id, ok: false, error: e.message } })));
      },
    }, 'undeployed');
    const indexer = { indexerUri: 'https://wallet-named.example/api', indexerWsUri: 'wss://wallet-named.example/ws' };
    /* RED WHEN: the worker reads the chain at another indexer than the one the ask names, or drops the time to live. */
    expect(await client.accountPresence!({ account: 'ab'.repeat(32), indexer, transactions: [Buffer.from('x').toString('base64')] }))
      .toEqual({ held: false, blockHeight: 7, blockTime: 99_000, ttl: 42_000 });
    expect(at).toEqual([indexer]);
  });
});

describe('EVERY VAULT A STEP READS, READ TOGETHER ON THIS DEVICE', () => {
  const OTHER = 'ad'.repeat(32);
  const NONE = 'ae'.repeat(32);
  /* The indexer standing in, answering many states at once: each request named in `asked`, and no state read alone. */
  const together = (states: Record<string, { serialize(): Uint8Array } | null>, asked: string[]): VaultChainSource => ({
    ...anIndexer(null, asked),
    contractState: async (address) => { asked.push(`state of ${address.slice(0, 4)} alone`); return states[address] ?? null; },
    contractStates: async (addresses) => { asked.push(`states of ${addresses.map((a) => a.slice(0, 4)).join(' ')}`); return addresses.map((a) => states[a] ?? null); },
  });
  const states = { [VAULT]: aVault({ notes: [NOTE], started: true }), [OTHER]: aVault({ notes: [], started: false }), [ACCOUNT]: aVault({ notes: [], started: false }) };

  it('THE STATES OF EVERY VAULT AND OF THE ACCOUNT GO IN ONE REQUEST, AND EACH VAULT IS ANSWERED AS A READ OF IT ALONE ANSWERS IT', async () => {
    const asked: string[] = [];
    const reads = await aClient(() => together(states, asked), []).vaultsOnChain({ vaults: [VAULT, OTHER, NONE], account: ACCOUNT, indexer: INDEXER });
    /* RED WHEN: each vault's state, or the account's, is read in a request of its own. */
    expect(asked.filter((a) => a.startsWith('state'))).toEqual([`states of ${VAULT.slice(0, 4)} ${OTHER.slice(0, 4)} ${NONE.slice(0, 4)} ${ACCOUNT.slice(0, 4)}`]);
    const alone = (vault: string) => readVaultOnChain(d, together(states, []), vault, ACCOUNT);
    /* RED WHEN: a vault read together is answered otherwise than a read of it alone, or one the indexer holds no state for is read as a vault. */
    expect(reads).toEqual([await alone(VAULT), await alone(OTHER), { onChain: false }]);
    expect(reads[0]).toMatchObject({ notes: [NOTE], started: true });
  });

  it('A STATE READ TOGETHER IS THE STATE THE SDK\'S OWN READ OF IT ALONE GIVES, FROM THE SAME ANSWER OF THE INDEXER', async () => {
    const hexOf = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
    const state = hexOf(states[VAULT]!.serialize());
    const block = { protocolVersion: 2_000_000, ledgerParameters: hexOf(L.LedgerParameters.initialParameters().serialize()) };
    /* The SDK's provider, its client answering its one query for a state alone as the indexer answers it. */
    const { IndexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
    const client = { query: async () => ({ data: { block, contract: { state } } }) };
    const alone = await contractStateAt(new IndexerPublicDataProvider({ client } as never, 1_000), VAULT);
    const answering = (async () => new Response(JSON.stringify({ data: { block, c0: { state } } }), { status: 200 })) as unknown as typeof fetch;
    const [together] = await contractStatesAt(INDEXER.indexerUri, [VAULT], answering);
    /* RED WHEN: the batched read dates or decodes a state otherwise than the SDK's read of one state does. */
    expect(Array.from(together!.serialize())).toEqual(Array.from(alone!.serialize()));
  });

  it('AN ANSWER THAT LEAVES A VAULT OUT, OR ANSWERS FOR ANOTHER, IS REFUSED, NEVER READ AS NO VAULT', () => {
    const read = { onChain: false } as const;
    expect(everyVaultAnswered([VAULT, OTHER], [{ vault: VAULT, read }, { vault: OTHER, read }])).toEqual([read, read]);
    /* RED WHEN: a vault missing from the worker's answer is taken as no vault there. */
    expect(() => everyVaultAnswered([VAULT, OTHER], [{ vault: VAULT, read }])).toThrow(/did not answer for every vault/u);
    expect(() => everyVaultAnswered([VAULT, OTHER], [{ vault: VAULT, read }, { vault: NONE, read }])).toThrow(/did not answer for every vault/u);
  });

  it('THE INDEXER IS ASKED FOR THE STATES IN AS FEW REQUESTS AS ITS QUERY COMPLEXITY ALLOWS, DATED BY THE NEWEST BLOCK, AND AN ADDRESS THAT IS NOT ONE, OR AN ANSWER LEAVING ONE OUT OR REFUSING, IS A THROW', async () => {
    const sent: string[] = [];
    const params = Array.from(L.LedgerParameters.initialParameters().serialize(), (b) => b.toString(16).padStart(2, '0')).join('');
    const B = { protocolVersion: 2_000_000, ledgerParameters: params };
    const answering = (data: unknown, o: { status?: number; errors?: unknown } = {}) => (async (_u: unknown, init?: { body?: unknown }) => {
      sent.push(String(init?.body));
      return new Response(JSON.stringify({ data, ...(o.errors === undefined ? {} : { errors: o.errors }) }), { status: o.status ?? 200 });
    }) as typeof fetch;
    const hex = Array.from(states[VAULT]!.serialize(), (b) => b.toString(16).padStart(2, '0')).join('');
    const got = await contractStatesAt(INDEXER.indexerUri, [VAULT, NONE], answering({ block: B, c0: { state: hex }, c1: null }));
    /* RED WHEN: the states are asked one request at a time, or not beside the block and its parameters that date them. */
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!).query).toMatch(/block \{ protocolVersion ledgerParameters \} c0: contract\(address: \$a0\) \{ state \} c1: contract\(address: \$a1\)/u);
    /* RED WHEN: the served state is not decoded as the state the indexer holds, or a contract it holds none of is read as one. */
    expect(Array.from(got[0]!.serialize())).toEqual(Array.from(states[VAULT]!.serialize()));
    expect(got[1]).toBeNull();
    /* RED WHEN: a contract left out of the answer, a refusal, a failed request or an undated state is read as no contract there. */
    await expect(contractStatesAt(INDEXER.indexerUri, [VAULT, NONE], answering({ block: B, c0: null }))).rejects.toThrow(/left a contract out/u);
    await expect(contractStatesAt(INDEXER.indexerUri, [VAULT], answering(null, { errors: [{ message: 'no' }] }))).rejects.toThrow(/refused/u);
    await expect(contractStatesAt(INDEXER.indexerUri, [VAULT], answering(null, { status: 502 }))).rejects.toThrow(/502/u);
    await expect(contractStatesAt(INDEXER.indexerUri, [VAULT], answering({ c0: { state: hex } }))).rejects.toThrow(/no block to date it/u);
    await expect(contractStatesAt(INDEXER.indexerUri, [VAULT], answering({ block: { ...B, protocolVersion: 9_000_000 }, c0: { state: hex } }))).rejects.toThrow();
    await expect(contractStatesAt(INDEXER.indexerUri, [VAULT], answering({ block: B, c0: { state: 'zz' } }))).rejects.toThrow(/not hex/u);
    /* RED WHEN: a block's ledger parameters are not read, so a block of another era than its parameters dates the states. */
    await expect(contractStatesAt(INDEXER.indexerUri, [VAULT], answering({ block: { protocolVersion: 2_000_000 }, c0: { state: hex } }))).rejects.toThrow(/no ledger parameters/u);

    /* RED WHEN: an address that is not a contract's is named in a request, which the indexer refuses whole. */
    sent.length = 0;
    await expect(contractStatesAt(INDEXER.indexerUri, [VAULT, 'zz'.repeat(31)], answering({ block: B, c0: { state: hex }, c1: null }))).rejects.toThrow(/not a contract's address/u);
    expect(sent).toEqual([]);

    /* 150 contracts, each answered by its own alias: every even one holds a state, every odd one none. */
    const many = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(64, '0'));
    sent.length = 0;
    const eachPart = (async (_u: unknown, init?: { body?: unknown }) => {
      sent.push(String(init?.body));
      const { variables } = JSON.parse(String(init?.body)) as { variables: Record<string, string> };
      const data = Object.fromEntries(Object.entries(variables).map(([k, a]) => [`c${k.slice(1)}`, parseInt(a, 16) % 2 === 0 ? { state: hex } : null]));
      return new Response(JSON.stringify({ data: { block: B, ...data } }), { status: 200 });
    }) as typeof fetch;
    const read = await contractStatesAt(INDEXER.indexerUri, many, eachPart);
    /* RED WHEN: the contracts are asked in one request past the indexer's query complexity, which it refuses whole. */
    expect(sent.map((b) => Object.keys((JSON.parse(b) as { variables: object }).variables).length)).toEqual([STATES_AT_ONCE, 150 - STATES_AT_ONCE]);
    /* RED WHEN: a part's answers are put back out of the order asked. */
    expect(read.map((r) => r !== null)).toEqual(many.map((_, i) => i % 2 === 0));
  });
  /* Each vault's history as the indexer serves it in one request: the transactions of each with their events. */
  const madeFor = (vault: string, commitment: string): ServedEvent[] => [
    { transactionHash: 'e1'.repeat(32), details: { tag: 'zswapOutput', commitment, contract: vault, mtIndex: 3n } },
    { transactionHash: 'e1'.repeat(32), details: { tag: 'zswapOutput', commitment: 'f9'.repeat(32), contract: 'cd'.repeat(32), mtIndex: 4n } },
  ];
  const historiesOf = (asked: string[], answer: (part: readonly string[]) => ReadonlyArray<ServedEvent[] | null>): Pick<VaultChainSource, 'histories'> => ({
    histories: { eventsOfEvery: async (part) => { asked.push(`histories of ${part.map((a) => a.slice(0, 4)).join(' ')}`); return answer(part); } },
  });

  it('EVERY VAULT\'S HISTORY GOES IN ONE REQUEST, AND EACH VAULT HOLDS THE COINS A READ OF ITS HISTORY ALONE GIVES', async () => {
    const asked: string[] = [];
    /* Each request answered with the events the indexer above serves for a vault's one transaction, read alone. */
    const source = { ...together(states, asked), ...historiesOf(asked, (part) => part.map(() => madeFor(VAULT, 'f0'.repeat(32)))) };
    const reads = await readVaultsOnChain(d, source, [VAULT, OTHER, NONE], ACCOUNT);
    /* RED WHEN: a vault's history is read in a request of its own, or one the indexer holds no state for is asked. */
    expect(asked.filter((a) => a.startsWith('histor'))).toEqual([`histories of ${VAULT.slice(0, 4)} ${OTHER.slice(0, 4)}`]);
    /* RED WHEN: the coins read together are not the ones the vault's own history gives, read alone. */
    const alone = async (vault: string) => (await readVaultOnChain(d, together(states, []), vault, ACCOUNT));
    expect(reads.map((r) => r.read)).toEqual([await alone(VAULT), await alone(OTHER), { onChain: false }]);
    expect(reads[0]!.read).toMatchObject({ everCreated: ['f0'.repeat(32)] });
  });

  it('THE HISTORIES ARE ASKED IN PARTS THE INDEXER\'S QUERY COMPLEXITY TAKES, AND EACH PART\'S ANSWERS STAY WITH THEIR VAULTS', async () => {
    const asked: string[] = [];
    const many = Array.from({ length: 40 }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
    const source = {
      ...together(Object.fromEntries(many.map((v) => [v, states[OTHER]!])), asked),
      ...historiesOf(asked, (part) => part.map((v) => madeFor(v, v.slice(0, 62) + 'ff'))),
    };
    const reads = await readVaultsOnChain(d, source, many);
    /* RED WHEN: more vaults are asked in one request than its complexity takes, or one at a time. */
    expect(asked.filter((a) => a.startsWith('histor')).map((a) => a.split(' ').length - 2)).toEqual([HISTORIES_AT_ONCE, 40 - HISTORIES_AT_ONCE]);
    /* RED WHEN: a part's answers are put back against other vaults. */
    expect(reads.map((r) => (r.read as { everCreated: readonly string[] }).everCreated)).toEqual(many.map((v) => [v.slice(0, 62) + 'ff']));
  });

  it('A VAULT WHOSE LIST MAY BE CUT SHORT IS READ ALONE, AND SO IS EVERY VAULT WHEN THE QUESTION ASKED TOGETHER FAILS; A HISTORY THAT CANNOT BE READ ALONE EITHER STOPS THE READ', async () => {
    const asked: string[] = [];
    const short = { ...together(states, asked), ...historiesOf(asked, (part) => part.map((v) => (v === VAULT ? null : madeFor(v, 'f0'.repeat(32))))) };
    const reads = await readVaultsOnChain(d, short, [VAULT, OTHER]);
    /* RED WHEN: a vault whose list one request cannot vouch for is read as holding only what that list shows. */
    expect(asked.filter((a) => a.startsWith('history'))).toEqual([`history of ${VAULT.slice(0, 4)}`]);
    expect(reads.map((r) => (r.read as { everCreated: readonly string[] }).everCreated)).toEqual([['f0'.repeat(32)], ['f0'.repeat(32)]]);

    asked.length = 0;
    const unaskable = { ...together(states, asked), histories: { eventsOfEvery: async () => { asked.push('histories'); throw new NoteIndexUnaskable('no such field'); } } };
    /* RED WHEN: an indexer that will not take the question asked together leaves the vaults unread, or read as holding nothing. */
    expect((await readVaultsOnChain(d, unaskable, [VAULT, OTHER])).map((r) => (r.read as { everCreated: readonly string[] }).everCreated)).toEqual([['f0'.repeat(32)], []]);
    expect(asked.filter((a) => a.startsWith('histor'))).toEqual(['histories', `history of ${VAULT.slice(0, 4)}`, `history of ${OTHER.slice(0, 4)}`]);

    asked.length = 0;
    const unreadable = { ...together(states, asked), histories: { eventsOfEvery: async () => { asked.push('histories'); throw new NoteIndexUnreadable('query is too complex'); } } };
    /* RED WHEN: a request asked together that fails (as one past the indexer's size limits does) stops the read, where each vault read alone answers. */
    expect((await readVaultsOnChain(d, unreadable, [VAULT, OTHER])).map((r) => (r.read as { everCreated: readonly string[] }).everCreated)).toEqual([['f0'.repeat(32)], []]);
    expect(asked.filter((a) => a.startsWith('histor'))).toEqual(['histories', `history of ${VAULT.slice(0, 4)}`, `history of ${OTHER.slice(0, 4)}`]);

    const neither = { ...unreadable, transactions: { of: async () => { throw new NoteIndexUnreadable('the indexer could not be asked'); } } };
    /* RED WHEN: a vault whose history cannot be read together or alone is taken as having made no coins. */
    await expect(readVaultsOnChain(d, neither, [VAULT])).rejects.toThrow(NoteIndexUnreadable);
  });
});
