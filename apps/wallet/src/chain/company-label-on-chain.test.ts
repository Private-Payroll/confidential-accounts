import { describe, expect, it } from 'vitest';
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { COMPANY_LABEL_ENTRY, companyLabelOf } from 'midnight-identity/profile/company-label';
import type { AccountAddress } from 'midnight-identity/profile/company-label';
import { Contract, ledger, pureCircuits } from '../../../../contracts/managed/contract/index.js';
import { witnesses } from '../../../../contracts/src/witnesses.js';
import { leafOfDevice, privateStateFor } from '../../../../contracts/test/simulator.js';
import { ContractMaintenanceAuthority, ContractState } from '@midnightntwrk/ledger-v9';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  ROLES_FIELD, SIGNER_LEAVES_FIELD, accountCarries, labelInAccountState, labelOnAccount, seatsInAccountState,
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
