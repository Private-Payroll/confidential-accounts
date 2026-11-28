/**
 * The three compiled contracts, built here with no device behind them, and the state each starts with when deployed.
 * Working out a frozen fact reads no private state, so every witness refuses; the account's device state is filled
 * in whole so a renamed or added field cannot compile until the record's list of them is written again.
 */
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';

import * as Account from '../managed/contract/index.js';
import * as Vault from '../managed-vault/contract/index.js';
import * as Registry from '../managed-registry/contract/index.js';
import { witnesses as accountWitnesses, type AccountPrivateState } from '../src/witnesses.js';
import type { RecordedContract } from './frozen-facts.js';

const ZERO = new Uint8Array(32);
export const NO_KEY = '00'.repeat(32);
const refuse = (): never => {
  throw new Error('working out a frozen fact reads no private state');
};
const VAULT_WITNESSES: Vault.Witnesses<null> = { noteToSpend: refuse, nonceSecret: refuse };

/** Every field of what a device keeps for an account, each present. */
export const DEVICE: Required<AccountPrivateState> = {
  secretKey: ZERO,
  blinding: ZERO,
  scope: ZERO,
  rights: { mayRaise: false, mayApprove: false, mayHold: false, everyVault: false, vaults: [] },
  invite: { coinSecretKey: ZERO, addressSalt: ZERO },
  runOpenings: {},
  assetBlinding: ZERO,
  assetId: ZERO,
  proposalSalt: ZERO,
  changeAmount: 0n,
  changeBatchDigest: ZERO,
  pinnedPath: { leaf: ZERO, path: [] },
  pinAnyLeaf: false,
  policy: { terms: { bands: [], periodLimit: 0n, periodStart: 0n, periodLength: 0n }, blinding: ZERO },
  periodSpent: 0n,
  legTaken: 0n
};

/** What a device keeps for each contract; the vault and the registry keep nothing of their own. */
export const DEVICE_STATE: Readonly<Record<RecordedContract, object>> = { account: DEVICE, vault: {}, registry: {} };

export const newAccount = () => new Account.Contract<AccountPrivateState>(accountWitnesses);
export const newVault = () => new Vault.Contract<null>(VAULT_WITNESSES);

/** The state a newly deployed contract starts with. */
export async function initialStateOf(contract: RecordedContract) {
  if (contract === 'account') {
    return (
      await newAccount().initialState(
        createConstructorContext(DEVICE, NO_KEY),
        Uint8Array.from(ZERO).fill(1),
        Uint8Array.from(ZERO).fill(2)
      )
    ).currentContractState;
  }
  if (contract === 'vault')
    return (await newVault().initialState(createConstructorContext(null, NO_KEY), { bytes: ZERO }))
      .currentContractState;
  return (await new Registry.Contract<null>({}).initialState(createConstructorContext(null, NO_KEY)))
    .currentContractState;
}

export const PURE: Readonly<Record<RecordedContract, object>> = {
  account: Account.pureCircuits,
  vault: Vault.pureCircuits,
  registry: Registry.pureCircuits
};

/** Calls one of a compiled contract's own circuit functions by its compiled name; refuses a name the build lacks. */
export async function compiledCall(contract: object, method: string, args: readonly unknown[]): Promise<unknown> {
  const fn: unknown = Reflect.get(contract, method);
  if (typeof fn !== 'function')
    throw new Error(`the compiled contract has no ${method}, so the fact it works out cannot be read`);
  return await Reflect.apply(fn, contract, args);
}
