import type * as Runtime from '@midnight-ntwrk/compact-runtime';
import { contractCallsOf } from '../../../../packages/web-shared/src/contract-call-built.js';

/**
 * The signer-tree pieces of the contract runtime: a holder is read off the
 * account's signer tree, and checked against the root it names, with these.
 */
export const accountTreeOf = (runtime: typeof Runtime) => ({
  StateBoundedMerkleTree: runtime.StateBoundedMerkleTree,
  CompactTypeBytes: runtime.CompactTypeBytes,
  CompactTypeMerkleTreeDigest: runtime.CompactTypeMerkleTreeDigest,
});

/**
 * What every contract builder in this wallet loads, each when it is first
 * needed: the ledger, the contract runtime, the contract compiler's runtime,
 * the company account as this build compiled it with its witnesses, and the
 * contract calls built over them. A call names the network it is built for
 * each time it is made, so nothing here is fixed to one network.
 */
export const contractPieces = async () => {
  const [ledger, runtime, contracts, compactJs, account, accountWitnesses, types, providers, modules] = await Promise.all([
    import('@midnightntwrk/ledger-v9'),
    import('@midnight-ntwrk/compact-runtime'),
    import('@midnight-ntwrk/midnight-js-contracts'),
    import('@midnight-ntwrk/compact-js'),
    import('../../../../contracts/managed/contract/index.js'),
    import('../../../../contracts/src/witnesses.js'),
    import('@midnight-ntwrk/midnight-js-types'),
    import('../../../../src/midnight/providers.js'),
    import('../../../../src/midnight/contract-modules.js'),
  ]);
  const registry = await import('../../../../contracts/managed-registry/contract/index.js');
  return {
    ledger,
    runtime,
    compactJs,
    account,
    accountWitnesses,
    registry,
    contracts: contractCallsOf({
      contracts, types, ledger, ContractState: runtime.ContractState, settingsFor: providers.transactionSettingsFor,
      accountModuleFor: modules.accountModuleFor,
    }),
  };
};
