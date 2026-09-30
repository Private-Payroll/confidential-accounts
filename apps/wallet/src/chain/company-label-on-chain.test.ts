import { describe, expect, it } from 'vitest';
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { COMPANY_LABEL_ENTRY, companyLabelOf } from 'midnight-identity/profile/company-label';
import type { AccountAddress } from 'midnight-identity/profile/company-label';
import { Contract, ledger, pureCircuits } from '../../../../contracts/managed/contract/index.js';
import { witnesses } from '../../../../contracts/src/witnesses.js';
import { leafOfDevice, privateStateFor } from '../../../../contracts/test/simulator.js';
import { ROLES_FIELD, accountCarries, labelInAccountState, labelOnAccount } from './company-label-on-chain.js';

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
    expect(await labelOnAccount(ACCOUNT, async () => state)).toEqual({ of: 'carries', label });
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
