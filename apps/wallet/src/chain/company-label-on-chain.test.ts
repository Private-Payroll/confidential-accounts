import { describe, expect, it } from 'vitest';
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { COMPANY_LABEL_ENTRY, companyLabelOf } from 'midnight-identity/profile/company-label';
import type { AccountAddress } from 'midnight-identity/profile/company-label';
import { Contract, ledger, pureCircuits } from '../../../../contracts/managed/contract/index.js';
import { witnesses } from '../../../../contracts/src/witnesses.js';
import { AccountSimulator, leafOfDevice, privateStateFor } from '../../../../contracts/test/simulator.js';
import { Contract as VaultContract, ledger as vaultLedger } from '../../../../contracts/managed-vault/contract/index.js';
import type { VaultAddress } from 'midnight-identity/profile/company-label';
import { ChargedState, ContractMaintenanceAuthority, ContractState, StateValue } from '@midnightntwrk/ledger-v9';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  ACCOUNT_THRESHOLD_FIELD, ADOPTED_VAULTS_FIELD, ROLES_FIELD, SIGNER_LEAVES_FIELD, VAULT_ACCOUNT_FIELD,
  accountCarries, fromIndexerAt, holdersInAccountState, holdersOnChain, labelInAccountState, labelOnAccount,
  seatsInAccountState, vaultInState, vaultOnChain,
} from './company-label-on-chain.js';

/*
 * The label a company's account carries, read the way this wallet reads it:
 * from the account's serialised state, with the wallet's own ledger package.
 * The state here is the one the real compiled account's constructor produces,
 * so the field this reads and the key it looks under are the contract's own,
 * not a copy that could drift.
 */
const ACCOUNT = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as AccountAddress;
const LABEL_BYTES = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);
/* A label whose last bytes are zero, which is where a trimmed encoding would bite. */
const TRAILING_ZEROS = Uint8Array.from({ length: 32 }, (_, i) => (i < 20 ? i + 1 : 0));

const deployedState = async (label: Uint8Array): Promise<Uint8Array> => {
  const founder = privateStateFor(1);
  const contract = new Contract(witnesses);
  const { currentContractState } = await contract.initialState(
    createConstructorContext(founder, '0'.repeat(64)), leafOfDevice(founder), label);
  return (currentContractState as { serialize(): Uint8Array }).serialize();
};
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('THE LABEL, READ OFF THE ACCOUNT', () => {
  it('the key it looks under is the key the contract writes the label under', () => {
    /* RED WHEN: the wallet's copy of the entry drifts from the contract's own derivation. */
    expect(COMPANY_LABEL_ENTRY).toBe(hexOf(pureCircuits.companyLabelKey()));
  });

  it('reads exactly the label the constructor was given, from the state the constructor produced', async () => {
    /* RED WHEN: the field index, the map, the key or the value's width is read wrong. */
    for (const bytes of [LABEL_BYTES, TRAILING_ZEROS]) {
      const state = await deployedState(bytes);
      expect(labelInAccountState(state)).toBe(companyLabelOf(bytes));
    }
  });

  it('agrees with the contract\'s own decoder about what the account holds', async () => {
    const founder = privateStateFor(1);
    const contract = new Contract(witnesses);
    const { currentContractState } = await contract.initialState(
      createConstructorContext(founder, '0'.repeat(64)), leafOfDevice(founder), LABEL_BYTES);
    const roles = ledger((currentContractState as unknown as { data: never }).data).signerRoles;
    expect(hexOf(roles.lookup(pureCircuits.companyLabelKey()))).toBe(hexOf(LABEL_BYTES));
    expect(ROLES_FIELD).toBe(13);
  });

  it('A READ THAT FAILS IS NEVER AN ANSWER, AND NO ACCOUNT IS NOT A LABEL', async () => {
    const label = companyLabelOf(LABEL_BYTES);
    const state = hexOf(await deployedState(LABEL_BYTES));
    expect(await labelOnAccount(ACCOUNT, async () => state)).toEqual({ of: 'carries', label, seats: seatsInAccountState(Buffer.from(state, 'hex')) });
    expect(accountCarries(await labelOnAccount(ACCOUNT, async () => state), label)).toBe(true);
    /* RED WHEN: a different label is taken as the one asked about. */
    expect(accountCarries(await labelOnAccount(ACCOUNT, async () => state), companyLabelOf(TRAILING_ZEROS))).toBe(false);
    /* RED WHEN: a failed or empty read lets a screen proceed. */
    const none = await labelOnAccount(ACCOUNT, async () => null);
    expect(none).toEqual({ of: 'no-account' });
    expect(accountCarries(none, label)).toBe(false);
    const failed = await labelOnAccount(ACCOUNT, async () => { throw new Error('offline'); });
    expect(failed.of).toBe('unreadable');
    expect(accountCarries(failed, label)).toBe(false);
    const garbage = await labelOnAccount(ACCOUNT, async () => 'abcd');
    expect(garbage.of).toBe('unreadable');
    /* And a label is never read as the account to look at. */
    const asked: string[] = [];
    const notAnAccount = await labelOnAccount(label as unknown as AccountAddress, async (a) => { asked.push(a); return state; });
    expect(notAnAccount.of).toBe('unreadable');
    expect(asked).toEqual([]);
  });
});

describe('WHO HOLDS THE ACCOUNT, READ OFF IT IN THE SAME ANSWER AS ITS LABEL', () => {
  /* A committee key: the public half of a schnorr key, as the chain holds it. */
  const key = (n: number): string => Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(n))).toString('hex');
  /* The deployed account's state, with a committee put on it the way a handover leaves one. */
  const heldBy = async (keys: string[], threshold: number): Promise<Uint8Array> => {
    const state = ContractState.deserialize(await deployedState(LABEL_BYTES));
    state.maintenanceAuthority = new ContractMaintenanceAuthority(keys.map((value) => ({ tag: 'schnorr', value })) as never, threshold, 1n);
    return state.serialize();
  };

  it('reads the committee and its threshold from the account\'s own maintenance authority', async () => {
    const keys = [key(1), key(2)];
    const seats = seatsInAccountState(await heldBy(keys, 2));
    /* RED WHEN: the committee or the threshold is read from anywhere but the account's maintenance authority. */
    expect(seats.committee).toEqual(keys.map((value) => ({ tag: 'schnorr', value })));
    expect(seats.threshold).toBe(2);
  });

  it('reads every seat the account holds now, from the contract\'s own set of seated leaves', async () => {
    const founder = privateStateFor(1);
    const contract = new Contract(witnesses);
    const { currentContractState } = await contract.initialState(
      createConstructorContext(founder, '0'.repeat(64)), leafOfDevice(founder), LABEL_BYTES);
    const leaves = ledger((currentContractState as unknown as { data: never }).data).signerLeaves;
    /* RED WHEN: the field read is not the contract's set of seated leaves, or a seat is read with any other bytes. */
    const seated = [...leaves].map((l: Uint8Array) => Buffer.from(l).toString('hex'));
    expect(seated).toEqual([Buffer.from(leafOfDevice(founder)).toString('hex')]);
    expect(seatsInAccountState(await heldBy([key(1)], 1)).seats).toEqual(seated);
    expect(SIGNER_LEAVES_FIELD).toBe(9);
  });

  it('a read of the account carries who holds it, and a state laid out otherwise is no answer', async () => {
    const state = Buffer.from(await heldBy([key(3)], 1)).toString('hex');
    const read = await labelOnAccount(ACCOUNT, async () => state);
    /* RED WHEN: the read that shows the label drops who holds the account. */
    expect(read.of === 'carries' && read.seats?.committee).toEqual([{ tag: 'schnorr', value: key(3) }]);
  });
});

describe('WHO HOLDS A VAULT, READ OFF THE VAULT ITSELF', () => {
  const VAULT = '9a'.repeat(32) as VaultAddress;
  /* The vault's constructor calls no witness; the contract still asks that both exist. */
  const noWitnesses = { noteToSpend: () => { throw new Error('none'); }, nonceSecret: () => { throw new Error('none'); } };
  const key = (n: number): string => Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(n))).toString('hex');
  /* The state the real compiled vault's constructor produces for this account, with a committee put on it as a handover leaves one. */
  const vaultState = async (account: string, keys: string[] | null, threshold = 1): Promise<Uint8Array> => {
    const { currentContractState } = await new VaultContract(noWitnesses as never).initialState(
      createConstructorContext({} as never, '0'.repeat(64)), { bytes: Buffer.from(account, 'hex') } as never);
    const bytes = (currentContractState as { serialize(): Uint8Array }).serialize();
    if (keys === null) return bytes;
    const state = ContractState.deserialize(bytes);
    state.maintenanceAuthority = new ContractMaintenanceAuthority(keys.map((value) => ({ tag: 'schnorr', value })) as never, threshold, 1n);
    return state.serialize();
  };

  it('reads the account the vault is pinned to, as the vault\'s own decoder does, and who holds it', async () => {
    const bytes = await vaultState(ACCOUNT, [key(1), key(2)], 2);
    const bytesZero = await vaultState('00'.repeat(32), null);
    const read = vaultInState(VAULT, bytes);
    /* RED WHEN: the field read is not the one the vault's constructor writes its account into, or its bytes are read wrong. */
    const { currentContractState } = await new VaultContract(noWitnesses as never).initialState(
      createConstructorContext({} as never, '0'.repeat(64)), { bytes: Buffer.from(ACCOUNT, 'hex') } as never);
    expect(hexOf(vaultLedger((currentContractState as unknown as { data: never }).data).account.bytes)).toBe(ACCOUNT);
    expect(read.account).toBe(ACCOUNT);
    expect(VAULT_ACCOUNT_FIELD).toBe(0);
    /* RED WHEN: the committee or the threshold is read from anywhere but the vault's own maintenance authority. */
    expect(read.committee).toEqual([key(1), key(2)].map((value) => ({ tag: 'schnorr', value })));
    expect(read.threshold).toBe(2);
    expect(read.vault).toBe(VAULT);
    /* RED WHEN: a vault pinned to no account - its account all zeros - is read as pinned to one. */
    expect(() => vaultInState(VAULT, bytesZero)).toThrow(/not laid out as a company's vault/);
    /* An account whose address ends in zero bytes is read back whole. */
    const trailing = `${'5d'.repeat(30)}0000`;
    expect(vaultInState(VAULT, await vaultState(trailing, null)).account).toBe(trailing);
  });

  it('a vault still held by the key it was deployed with reads as that, and an account read as a vault is no answer', async () => {
    const deployedWith = vaultInState(VAULT, await vaultState(ACCOUNT, [key(7)], 1));
    /* RED WHEN: the temporary key's committee is read as anything but its one key. */
    expect(deployedWith.committee).toEqual([{ tag: 'schnorr', value: key(7) }]);
    expect(deployedWith.threshold).toBe(1);
    /* RED WHEN: a company's account, read as if it were a vault, is taken as one. */
    const account = await deployedState(LABEL_BYTES);
    expect(() => vaultInState(VAULT, account)).toThrow(/not laid out as a company's vault/);
    /* RED WHEN: a contract laid out otherwise - one field more than a vault has, its first still an address - is read as a vault. */
    const longer = ContractState.deserialize(await vaultState(ACCOUNT, [key(1)]));
    let fields = (StateValue as any).newArray();
    for (const f of longer.data.state.asArray()!) fields = fields.arrayPush(f);
    longer.data = new ChargedState(fields.arrayPush((StateValue as any).newNull()));
    expect(() => vaultInState(VAULT, longer.serialize())).toThrow(/not laid out as a company's vault/);
  });

  it('A READ THAT FAILS IS NEVER AN ANSWER: no vault, an unreadable answer, and an account in a vault\'s place', async () => {
    const good = hexOf(await vaultState(ACCOUNT, [key(1)]));
    expect(await vaultOnChain(VAULT, async () => good)).toEqual({ of: 'read', holders: vaultInState(VAULT, Buffer.from(good, 'hex')) });
    /* RED WHEN: an empty, failed or garbled read lets a screen sign. */
    expect(await vaultOnChain(VAULT, async () => null)).toEqual({ of: 'no-vault' });
    expect((await vaultOnChain(VAULT, async () => { throw new Error('offline'); })).of).toBe('unreadable');
    expect((await vaultOnChain(VAULT, async () => 'abcd')).of).toBe('unreadable');
    /* RED WHEN: a company's account, read in a vault's place, is read as a vault. */
    expect((await vaultOnChain(VAULT, async () => hexOf(await deployedState(LABEL_BYTES)))).of).toBe('unreadable');
    /* And something that is not an address is never read at all. */
    const asked: string[] = [];
    expect((await vaultOnChain('co_x' as VaultAddress, async (a) => { asked.push(a); return good; })).of).toBe('unreadable');
    expect(asked).toEqual([]);
  });
});

describe('MORE THAN ONE SEAT', () => {
  it('reads every seat of an account that seats two signers, as the account\'s own decoder lists them', async () => {
    const sim = await AccountSimulator.liveAccount([privateStateFor(1), privateStateFor(2)], 2n);
    const bytes = (sim.contractStateForCall as { serialize(): Uint8Array }).serialize();
    const listed = [...sim.ledger.signerLeaves].map((l: Uint8Array) => hexOf(l)).sort();
    /* RED WHEN: only the first seat is read, or a seat is read with any other bytes. */
    expect(listed).toHaveLength(2);
    expect([...seatsInAccountState(bytes).seats].sort()).toEqual(listed);
    expect(listed).toEqual([hexOf(leafOfDevice(privateStateFor(1))), hexOf(leafOfDevice(privateStateFor(2)))].sort());
  });
});

describe('WHO HOLDS THE ACCOUNT, ITS OWN THRESHOLD AND THE VAULTS IT HAS ADOPTED', () => {
  it('reads the account\'s threshold and its adopted vaults as the account\'s own decoder does', async () => {
    const sim = await AccountSimulator.liveAccount([privateStateFor(1), privateStateFor(2)], 2n);
    /* A vault address ending in a zero byte, which the state holds trimmed. */
    const vaults = [Uint8Array.from({ length: 32 }, (_, i) => i + 1), Uint8Array.from({ length: 32 }, (_, i) => (i < 31 ? 0x40 + i : 0))];
    for (const v of vaults) await sim.adoptVault(v, [privateStateFor(1), privateStateFor(2)], 391 + v[0]!);
    const bytes = (sim.contractStateForCall as { serialize(): Uint8Array }).serialize();
    const read = holdersInAccountState(bytes);
    /* RED WHEN: the threshold is read from another field, or its trimmed little-endian bytes are read wrong. */
    expect(read.approvals).toBe(Number(sim.ledger.threshold));
    expect(read.approvals).toBe(2);
    /* RED WHEN: the vaults are read from another field, or one is read with any other bytes. */
    expect([...read.adoptedVaults].sort()).toEqual([...sim.ledger.vaults].map((v: Uint8Array) => hexOf(v)).sort());
    expect(read.adoptedVaults).toContain(hexOf(vaults[1]!));
    expect([ACCOUNT_THRESHOLD_FIELD, ADOPTED_VAULTS_FIELD]).toEqual([5, 7]);
    /* And everything a seats read gives is in it, read in the same answer. */
    expect(read.seats).toEqual(seatsInAccountState(bytes).seats);
  });

  it('a read for an account carrying another label is not an answer, and no account is not unreadable', async () => {
    const state = hexOf(await deployedState(LABEL_BYTES));
    expect((await holdersOnChain(ACCOUNT, companyLabelOf(LABEL_BYTES), async () => state)).of).toBe('read');
    /* RED WHEN: the holders of another company's account are handed back for this label. */
    expect((await holdersOnChain(ACCOUNT, companyLabelOf(TRAILING_ZEROS), async () => state)).of).toBe('other-label');
    expect(await holdersOnChain(ACCOUNT, companyLabelOf(LABEL_BYTES), async () => null)).toEqual({ of: 'no-account' });
  });
});

describe('THE INDEXER\'S ANSWERS, READ AS WHAT THEY ARE', () => {
  const answering = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const withFetch = async <T,>(f: typeof fetch, run: () => Promise<T>): Promise<T> => {
    const was = globalThis.fetch;
    globalThis.fetch = f;
    try { return await run(); } finally { globalThis.fetch = was; }
  };

  it('AN EMPTY STATE IS NO CONTRACT, NOT AN UNREADABLE ONE', async () => {
    /* RED WHEN: an action that left no state is read as a state that will not read, so a screen says to wait where nothing is there. */
    expect(await withFetch(answering({ data: { contract: { state: '' } } }), () => fromIndexerAt('https://indexer.example')('ab'.repeat(32) as AccountAddress))).toBeNull();
    expect(await withFetch(answering({ data: { contract: { state: '' } } }), () => vaultOnChain('9a'.repeat(32) as VaultAddress, fromIndexerAt('https://indexer.example')))).toEqual({ of: 'no-vault' });
    /* And a state that is not hex is still refused. */
    await expect(withFetch(answering({ data: { contract: { state: 'zz' } } }), () => fromIndexerAt('https://indexer.example')('ab'.repeat(32) as AccountAddress))).rejects.toThrow(/not a state/);
  });
});
