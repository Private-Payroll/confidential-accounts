/**
 * Which compiled contract a vault's call into its company account runs. The runtime checks whatever module it is
 * handed against the circuits the vault declares it calls, so these cases hand the vault's own declaration to the
 * runtime's own check, `checkConformance`, rather than restating it.
 */
import { describe, it, expect } from 'vitest';
import { checkConformance, ContractState, type Module } from '@midnight-ntwrk/compact-runtime';
import { accountModuleFor, crossContractInputsFor } from './contract-modules.js';
import { declaredInterfaces } from '../../contracts/managed-vault/contract/index.js';

const ACCOUNT = 'c45b42a29a08ded3c9400cab83d9454b83e122a953848aad1f97a36cd135d996';
const ANOTHER = '90a19bf2cd784d5b52d6264cc0facbef657f2a9be16cf6f510aee4c2d275d484';
const BLOCK = '11'.repeat(32);

describe('the contract a vault\'s call into its account runs', () => {
  it('is the compiled company account, which declares every circuit the vault calls', async () => {
    const thunk = accountModuleFor(ACCOUNT).resolve(ACCOUNT);
    expect(thunk, 'the vault\'s own account was not answered').toBeTypeOf('function');
    const module: Module = await thunk!();
    /* RED WHEN: a vault's call is answered with a contract that is not the company account, and every payment it records fails. */
    const accountInterface = declaredInterfaces.Acct;
    if (!accountInterface) throw new Error('the compiled vault declares no company account it calls');
    expect(checkConformance(accountInterface, module.circuitSignatures)).toEqual({ outcome: 'Conformant' });
  });

  it('is answered whatever case the address is written in', () => {
    /* RED WHEN: an address read in upper case finds no contract, and the vault's call is refused though it names its own account. */
    expect(accountModuleFor(ACCOUNT.toUpperCase()).resolve(ACCOUNT)).toBeTypeOf('function');
    expect(accountModuleFor(ACCOUNT).resolve(ACCOUNT.toUpperCase())).toBeTypeOf('function');
  });

  it('a call naming any other contract finds none, and is refused before it runs', () => {
    /* RED WHEN: a vault circuit calling another company's account is handed a module, and runs against that account. */
    expect(accountModuleFor(ACCOUNT).resolve(ANOTHER)).toBeUndefined();
  });

  it('refuses an account address that is not a contract address', () => {
    /* RED WHEN: a vault is wired to an address no contract can have, and its first call fails with nothing naming why. */
    expect(() => accountModuleFor('acc_1')).toThrow(/"acc_1" is not a contract address/);
    expect(() => accountModuleFor(`0200${ACCOUNT}`)).toThrow(/is not a contract address/);
  });
});

describe('what a vault circuit run directly is given to reach its account', () => {
  it('the account\'s state at the block the call is built on, and no other contract\'s', async () => {
    const asked: string[] = [];
    const state = new ContractState();
    const inputs = crossContractInputsFor(ACCOUNT, async (blockHash) => { asked.push(blockHash); return state; });
    /* RED WHEN: the account's state is read at another block than the call's, and the vault proves against a state the chain never had. */
    expect(await inputs.stateProvider.getContractState(BLOCK, ACCOUNT)).toBe(state);
    expect(asked).toEqual([BLOCK]);
    /* RED WHEN: another contract's state is read for a vault's call, and the call runs against it. */
    expect(await inputs.stateProvider.getContractState(BLOCK, ANOTHER)).toBeUndefined();
    expect(asked).toEqual([BLOCK]);
    /* RED WHEN: the module the call runs is not the one for this account. */
    expect(inputs.moduleProvider.resolve(ACCOUNT)).toBeTypeOf('function');
    expect(inputs.moduleProvider.resolve(ANOTHER)).toBeUndefined();
  });
});
