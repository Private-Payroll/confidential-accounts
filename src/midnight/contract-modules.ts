/**
 * The compiled contract a vault's circuit runs when it calls into its company account.
 *
 * A vault's payment, batch and retire circuits call the company account the vault was created for. When a circuit
 * makes that call, the runtime asks a module provider which compiled contract implements the contract at the callee's
 * address, and then checks the answer itself: the module must declare every circuit the vault calls, with the same
 * argument and result types, and its verifier keys must be the ones deployed at that address. The provider here
 * answers for one address only, the vault's own account, so a call naming any other contract finds no implementation
 * and is refused before it runs.
 */
import type {
  ContractAddress,
  ContractModuleProvider,
  ContractState,
  CrossContractInputs,
  ModuleThunk,
} from '@midnight-ntwrk/compact-runtime';
import { contractAddressOrRefuse } from '../core/contract-address.js';

/** Loads the compiled company account contract, on the first call that reaches it. */
const loadAccountModule: ModuleThunk = () => import('../../contracts/managed/contract/index.js');

const addressOf = (address: string, what: string): ContractAddress => contractAddressOrRefuse(address, what);

/**
 * The module provider for a vault created for `accountAddress`: it answers the compiled company account contract for
 * that address and nothing for any other. Refuses an address that is not a contract address.
 */
export const accountModuleFor = (accountAddress: string): ContractModuleProvider => {
  const account = addressOf(accountAddress, 'the company account');
  return { resolve: (callee) => (callee.toLowerCase() === account ? loadAccountModule : undefined) };
};

/**
 * What a vault circuit needs to call its company account when it is run directly (`createCircuitContext`): the module
 * provider above, and the account's deployed state at the block the call is built on, read by `accountStateAt`. A
 * call to any other contract is answered with no state and no module, and refused.
 */
export const crossContractInputsFor = (
  accountAddress: string,
  accountStateAt: (blockHash: string) => Promise<ContractState | undefined>,
): CrossContractInputs => {
  const account = addressOf(accountAddress, 'the company account');
  return {
    stateProvider: {
      getContractState: async (blockHash, address) =>
        (address.toLowerCase() === account ? accountStateAt(blockHash) : undefined),
    },
    moduleProvider: accountModuleFor(account),
  };
};
