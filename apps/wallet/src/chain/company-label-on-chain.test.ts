import { describe, expect, it } from 'vitest';
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { COMPANY_LABEL_ENTRY, companyLabelOf } from 'midnight-identity/profile/company-label';
import type { AccountAddress } from 'midnight-identity/profile/company-label';
import { Contract, ledger, pureCircuits } from '../../../../contracts/managed/contract/index.js';
import { witnesses } from '../../../../contracts/src/witnesses.js';
import { AccountSimulator, COMPANY_LABEL, change, leafOfDevice, privateStateFor } from '../../../../contracts/test/simulator.js';
import { Contract as VaultContract, ledger as vaultLedger } from '../../../../contracts/managed-vault/contract/index.js';
import type { VaultAddress } from 'midnight-identity/profile/company-label';
import { ChargedState, ContractMaintenanceAuthority, ContractState, StateValue } from '@midnightntwrk/ledger-v9';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  ACCOUNT_THRESHOLD_FIELD, ADOPTED_VAULTS_FIELD, MOVEMENTS_FIELD, OPEN_PROPOSALS_FIELD, ROLES_FIELD, SIGNER_LEAVES_FIELD, VAULT_ACCOUNT_FIELD,
  accountCarries, deployFromIndexerAt, foundingInDeployState, fromIndexerAt, holdersInAccountState, holdersOnChain,
  labelInAccountState, labelOnAccount, paymentsInAccountState, rolesInAccountState, seatsInAccountState, vaultInState, vaultOnChain,
} from './company-label-on-chain.js';
import { PAY_KEY_COMMITMENT_ENTRY } from 'midnight-identity/profile/records-key';

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
/* The founding signer's committee key: the one key a company's account is deployed held by. */
const FOUNDING_KEY = Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(41))).toString('hex');
/** The state a company's deploy leaves: the constructor's, held by the founding signer's committee key alone. */
const deployHeld = async (label: Uint8Array, keys: string[] = [FOUNDING_KEY]): Promise<Uint8Array> => {
  const state = ContractState.deserialize(await deployedState(label));
  state.maintenanceAuthority = new ContractMaintenanceAuthority(keys.map((value) => ({ tag: 'schnorr', value })) as never, keys.length, 0n);
  return state.serialize();
};

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
    const state = hexOf(await deployHeld(LABEL_BYTES));
    expect((await holdersOnChain(ACCOUNT, companyLabelOf(LABEL_BYTES), async () => state, async () => state)).of).toBe('read');
    /* RED WHEN: the holders of another company's account are handed back for this label. */
    expect((await holdersOnChain(ACCOUNT, companyLabelOf(TRAILING_ZEROS), async () => state, async () => state)).of).toBe('other-label');
    expect(await holdersOnChain(ACCOUNT, companyLabelOf(LABEL_BYTES), async () => null, async () => null)).toEqual({ of: 'no-account' });
  });
});

describe('THE FOUNDING SEAT, READ FROM THE ACCOUNT\'S DEPLOY AND NEVER FROM WHO HOLDS A SLOT NOW', () => {
  const [F, B, C, D] = [privateStateFor(1), privateStateFor(2), privateStateFor(3), privateStateFor(4)];
  /* The label the simulator's accounts are deployed with. */
  const LABEL = companyLabelOf(COMPANY_LABEL);

  /** A proposal over `payload` raised by `by` under `seed`'s salt and approved by `approvers`; its id and salt. */
  const approved = async (sim: AccountSimulator, by: typeof F, payload: Uint8Array, seed: number, approvers: Array<typeof F>) => {
    const c = change(0n, seed);
    await sim.as(sim.applying(by, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);
    for (const a of approvers) await sim.as(a).approve(id);
    return { id, by: sim.applying(by, c) };
  };

  /** The founding signer removed by two of three, and D put into the slot the founding signer left - the first slot - by the two left. */
  const founderReplaced = async (): Promise<AccountSimulator> => {
    const sim = await AccountSimulator.liveAccount([F, B, C], 2n);
    const removal = await approved(sim, F, pureCircuits.removeSignerPayload(sim.leafOf(F)), 611, [F, B]);
    await sim.as(removal.by).removeSigner(sim.leafOf(F), removal.id);
    const seating = await approved(sim, B, pureCircuits.signerAddPayload(sim.leafOf(D)), 612, [B, C]);
    await sim.as(seating.by).addSigner(sim.leafOf(D), seating.id, true);
    return sim;
  };

  it('THE ONE SEAT THE DEPLOY SEATED IS THE FOUNDING SEAT, AND A DEPLOY OF ANOTHER LABEL OR MORE SEATS IS NO ANSWER', async () => {
    const deploy = await deployHeld(COMPANY_LABEL);
    /* RED WHEN: the founding seat or its committee key is read from anything but the deploy's one seated leaf and its own committee. */
    expect(foundingInDeployState(deploy, LABEL)).toEqual({ seat: hexOf(leafOfDevice(F)), committee: [{ tag: 'schnorr', value: FOUNDING_KEY }] });
    /* RED WHEN: a deploy of another company's account names this company's founding signer. */
    expect(() => foundingInDeployState(deploy, companyLabelOf(TRAILING_ZEROS))).toThrow(/does not carry this company's label/);
    /* RED WHEN: a deploy held by no committee names a founding committee, so any entry for the seat would be believed. */
    const unheld = await deployedState(COMPANY_LABEL);
    expect(() => foundingInDeployState(unheld, LABEL)).toThrow(/held by no committee/);
    /* RED WHEN: a state with two seats is read as a deploy, so whichever is listed first is taken as the founding signer. */
    const two = await AccountSimulator.liveAccount([F, B], 2n);
    expect(() => foundingInDeployState((two.contractStateForCall as { serialize(): Uint8Array }).serialize(), LABEL))
      .toThrow(/did not seat exactly one signer/);
  });

  it('A FOUNDER REMOVED AND ANOTHER SEAT IN THE FIRST SLOT: THE FOUNDING SEAT IS STILL THE DEPLOY\'S', async () => {
    const sim = await founderReplaced();
    /* The chain as it is now: the founding signer gone, D seated in the founding signer's slot. */
    expect(sim.slotOf(D)).toBe(0n);
    const now = hexOf((sim.contractStateForCall as { serialize(): Uint8Array }).serialize());
    const deploy = hexOf(await deployHeld(COMPANY_LABEL));
    const read = await holdersOnChain(ACCOUNT, LABEL, async () => now, async () => deploy);
    if (read.of !== 'read') throw new Error(`not read: ${JSON.stringify(read)}`);
    /* RED WHEN: the founding seat is read as whoever holds the first slot now, or as any seat held now. */
    expect(read.holders.founding).toBe(hexOf(leafOfDevice(F)));
    /* RED WHEN: the founding committee is read as whoever holds the account now rather than whoever the deploy was held by. */
    expect(read.holders.foundingCommittee).toEqual([{ tag: 'schnorr', value: FOUNDING_KEY }]);
    expect(read.holders.seats).not.toContain(read.holders.founding);
    expect([...read.holders.seats].sort()).toEqual([B, C, D].map((d) => hexOf(sim.leafOf(d))).sort());
    /* RED WHEN: an account the indexer holds no deploy for is answered with a founding seat. */
    expect(await holdersOnChain(ACCOUNT, LABEL, async () => now, async () => null))
      .toEqual({ of: 'unreadable', why: 'the indexer holds no deploy for that account.' });
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

  it('THE DEPLOY IS READ AS THE ACCOUNT\'S ONE DEPLOY ACTION, AND ANYTHING ELSE IS NO DEPLOY', async () => {
    const read = () => deployFromIndexerAt('https://indexer.example')('ab'.repeat(32) as AccountAddress);
    let asked = '';
    const asking = (body: unknown) => (async (_u: unknown, init: { body: string }) => {
      asked = init.body;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    /* RED WHEN: the read asks for anything but the contract's deploy action, so a call's or an update's state is taken as the deploy's. */
    expect(await withFetch(asking({ data: { contract: { actions: [{ state: 'abcd' }] } } }), read)).toBe('abcd');
    expect(JSON.parse(asked).query).toMatch(/actions\(type: DEPLOY, limit: 1\) \{ state \}/);
    /* RED WHEN: no contract is read as a deploy, or none or two deploy actions are read as one. */
    expect(await withFetch(answering({ data: { contract: null } }), read)).toBeNull();
    await expect(withFetch(answering({ data: { contract: { actions: [] } } }), read)).rejects.toThrow(/one deploy/);
    await expect(withFetch(answering({ data: { contract: { actions: [{ state: 'ab' }, { state: 'cd' }] } } }), read)).rejects.toThrow(/one deploy/);
    await expect(withFetch(answering({ data: { contract: { actions: [{ state: 'zz' }] } } }), read)).rejects.toThrow(/not a state/);
    await expect(withFetch(answering({ errors: [{ message: 'no' }] }), read)).rejects.toThrow('the indexer refused the read.');
  });

  it('AN INDEXER THAT FAILS, REFUSES OR ANSWERS WITH NOTHING IS NEVER A LABEL', async () => {
    const read = () => fromIndexerAt('https://indexer.example')('ab'.repeat(32) as AccountAddress);
    const status = (code: number) => (async () => new Response('{}', { status: code })) as unknown as typeof fetch;
    /* RED WHEN: an answer the indexer marked as failed is read as a state. */
    await expect(withFetch(status(502), read)).rejects.toThrow('the indexer answered 502.');
    /* RED WHEN: an answer carrying errors is read past them. */
    await expect(withFetch(answering({ errors: [{ message: 'no' }], data: { contract: { state: 'abcd' } } }), read)).rejects.toThrow('the indexer refused the read.');
    /* RED WHEN: no contract at the address is read as an unreadable one, or as a state. */
    expect(await withFetch(answering({ data: { contract: null } }), read)).toBeNull();
    /* RED WHEN: a state that is not a string is taken as one. */
    await expect(withFetch(answering({ data: { contract: { state: 12 } } }), read)).rejects.toThrow(/not a state/);
    /* And through the label reader, a failure is unreadable and never a label. */
    const label = await withFetch(status(500), () => labelOnAccount(ACCOUNT, fromIndexerAt('https://indexer.example')));
    expect(label).toEqual({ of: 'unreadable', why: 'the indexer answered 500.' });
  });
});

describe('A LABEL ENTRY THAT HOLDS ZERO', () => {
  it('IS NO LABEL, NEVER THE LABEL OF ALL ZEROES', async () => {
    /* The constructor refuses a zero label, so the deployed state's entry is set to zero here, as the state holds it: its zero bytes dropped. */
    const zeroed = ContractState.deserialize(await deployedState(LABEL_BYTES));
    const fields = zeroed.data.state.asArray()!;
    const roles = fields[ROLES_FIELD]!.asMap()!;
    const key = roles.keys().find((k) => hexOf(k.value[0]!) === COMPANY_LABEL_ENTRY)!;
    const { alignment } = roles.get(key)!.asCell()!;
    const entries = StateValue.newMap(roles.insert(key, StateValue.newCell({ value: [new Uint8Array(0)], alignment })));
    let rebuilt = (StateValue as any).newArray();
    fields.forEach((f, i) => { rebuilt = rebuilt.arrayPush(i === ROLES_FIELD ? entries : f); });
    zeroed.data = new ChargedState(rebuilt);
    const state = hexOf(zeroed.serialize());
    /* RED WHEN: an entry written as zero is read as a company's label. */
    expect(labelInAccountState(Buffer.from(state, 'hex'))).toBeNull();
    expect(await labelOnAccount(ACCOUNT, async () => state)).toEqual({ of: 'no-label' });
  });
});

describe('WHAT THE ACCOUNT RECORDS ABOUT PAYMENTS, READ WITH NO PRESS', () => {
  it('the key the pay-record key commitment is looked up under is the key the contract writes it under', () => {
    /* RED WHEN: the wallet's copy of the entry drifts from the contract's own derivation. */
    expect(PAY_KEY_COMMITMENT_ENTRY).toBe(hexOf(pureCircuits.payKeyCommitmentKey()));
  });

  it('reads the account\'s record of payments from the field the account\'s own decoder reads it from', async () => {
    const sim = await AccountSimulator.liveAccount([privateStateFor(1), privateStateFor(2)], 2n);
    const state = ContractState.deserialize((sim.contractStateForCall as { serialize(): Uint8Array }).serialize());
    const fields = state.data.state.asArray()!;
    /* RED WHEN: payments are read from any field but the one the contract's decoder calls its record of payments. */
    expect(MOVEMENTS_FIELD).toBe(4);
    expect(fields[MOVEMENTS_FIELD]!.asMap()!.keys().length).toBe(Number(sim.ledger.movements.size()));
    const asked = ['a1'.repeat(32), 'b2'.repeat(32)];
    /* A new account has paid nobody, committed to no pay-record key and holds nothing open. */
    expect(paymentsInAccountState(state.serialize(), asked)).toEqual({ payKeyCommitment: null, held: [], openRounds: [], entries: 0 });
    /* RED WHEN: a state that is not a company's account is read as one that paid nobody. */
    expect(() => paymentsInAccountState(new Uint8Array([1, 2, 3]), asked)).toThrow();
  });

  it('READS EVERY PROPOSAL THE ACCOUNT HOLDS OPEN, AND HOW MANY ENTRIES ITS RECORD OF PAYMENTS HOLDS, FROM THE FIELDS THE CONTRACT KEEPS THEM IN', async () => {
    const sim = await AccountSimulator.liveAccount([privateStateFor(1), privateStateFor(2)], 2n);
    await sim.propose(new Uint8Array(32).fill(7));
    await sim.propose(new Uint8Array(32).fill(8));
    const state = ContractState.deserialize((sim.contractStateForCall as { serialize(): Uint8Array }).serialize());
    const fields = state.data.state.asArray()!;
    const open = [...sim.ledger.openProposals].map(([id]) => hexOf(id)).sort();
    /* RED WHEN: the open proposals are read from any field but the one the contract keeps them in. */
    expect(OPEN_PROPOSALS_FIELD).toBe(2);
    expect(open).toHaveLength(2);
    expect(fields[OPEN_PROPOSALS_FIELD]!.asMap()!.keys().length).toBe(Number(sim.ledger.openProposals.size()));
    const read = paymentsInAccountState(state.serialize(), ['a1'.repeat(32)]);
    /* RED WHEN: a proposal the account holds open is left out of the read, or one it does not hold is added. */
    expect(read.openRounds).toEqual(open);
    /* RED WHEN: the count of the record's entries is anything but how many the account holds. */
    expect(read.entries).toBe(Number(sim.ledger.movements.size()));
  });

  it('A HOLDERS READ THAT ASKS ABOUT PAYMENTS ANSWERS THEM IN THE SAME READ, AND ONE THAT DOES NOT ANSWERS NOTHING ABOUT THEM', async () => {
    const state = hexOf(await deployHeld(LABEL_BYTES));
    const asked = ['c3'.repeat(32)];
    const withPayments = await holdersOnChain(ACCOUNT, companyLabelOf(LABEL_BYTES), async () => state, async () => state, asked);
    /* RED WHEN: the payments asked about are dropped from the answer, or read from another state than the holders. */
    expect(withPayments).toMatchObject({ of: 'read', payments: { payKeyCommitment: null, held: [] } });
    const without = await holdersOnChain(ACCOUNT, companyLabelOf(LABEL_BYTES), async () => state, async () => state);
    /* RED WHEN: a read nobody asked payments of says anything about them. */
    expect(without.of === 'read' && 'payments' in without).toBe(false);
  });
});

describe('WHAT THE ACCOUNT HOLDS UNDER ENTRIES OF ITS MAP OF ROLES, READ WITH NO PRESS', () => {
  it('reads each entry asked from the field the contract keeps its map of roles in, the thirty-two bytes it holds or nothing, in the order asked', async () => {
    const NOT_HELD = 'c3'.repeat(32);
    for (const label of [LABEL_BYTES, TRAILING_ZEROS]) {
      const state = await deployedState(label);
      /* The constructor writes the company's label under its entry: an entry the contract itself wrote. */
      const read = rolesInAccountState(state, [NOT_HELD, COMPANY_LABEL_ENTRY]);
      /* RED WHEN: an entry is read from another field, its value is cut short where it ends in zeroes, or the order asked is not kept. */
      expect(read).toEqual([{ key: NOT_HELD, value: null }, { key: COMPANY_LABEL_ENTRY, value: hexOf(label) }]);
    }
    /* RED WHEN: a state that is not a company's account is read as one holding nothing. */
    expect(() => rolesInAccountState(new Uint8Array([1, 2, 3]), [NOT_HELD])).toThrow();
  });

  it('A HOLDERS READ THAT ASKS ABOUT ENTRIES ANSWERS THEM IN THE SAME READ, AND ONE THAT DOES NOT ANSWERS NOTHING ABOUT THEM', async () => {
    const state = hexOf(await deployHeld(LABEL_BYTES));
    const read = await holdersOnChain(ACCOUNT, companyLabelOf(LABEL_BYTES), async () => state, async () => state, undefined, [COMPANY_LABEL_ENTRY]);
    /* RED WHEN: the entries asked about are dropped from the answer, or read from another state than the holders. */
    expect(read).toMatchObject({ of: 'read', roles: [{ key: COMPANY_LABEL_ENTRY, value: hexOf(LABEL_BYTES) }] });
    expect(read.of === 'read' && 'payments' in read).toBe(false);
    const both = await holdersOnChain(ACCOUNT, companyLabelOf(LABEL_BYTES), async () => state, async () => state, ['a1'.repeat(32)], [COMPANY_LABEL_ENTRY]);
    expect(both).toMatchObject({ of: 'read', payments: { held: [] }, roles: [{ key: COMPANY_LABEL_ENTRY }] });
    const without = await holdersOnChain(ACCOUNT, companyLabelOf(LABEL_BYTES), async () => state, async () => state);
    /* RED WHEN: a read nobody asked entries of says anything about them. */
    expect(without.of === 'read' && 'roles' in without).toBe(false);
  });
});
