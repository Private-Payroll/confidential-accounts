import { startingLedgerFrom, vaultBornHeldRefusal } from '../../../src/midnight/vault-circuits.js';
import { VAULT_CIRCUITS } from '../../../src/midnight/vault-contract.js';
import type { Committee } from '../../../src/midnight/vault-committee.js';
import type { WorkerDeps } from './vault-worker-entry.js';

/**
 * **A VAULT AS ITS DEPLOY MADE IT, READ ON THIS DEVICE** before the vault is
 * adopted or its set-up carried on: the state the chain recorded its deploy
 * leaving at the vault's own address, read from the indexer the person's own
 * wallet names, never a deploy anybody serves. Read with the one reading the
 * service makes before paying for a deploy (`vaultBornHeldRefusal`), against
 * this build's keys, each checked against the compiled vault's own digest. Null
 * when the vault was born held. For a vault the company retired and adopts
 * `again`, who holds it and its circuits are read off its state today, against
 * the committee the company holds now (`vaultBornHeldRefusal`'s `now`).
 */
export const vaultAsDeployed = async (
  d: Pick<WorkerDeps, 'ledger' | 'runtimeState' | 'vault' | 'vaultKeys'>,
  ask: { vault: string; account: string; holders: Committee; again?: boolean },
  source: Pick<import('./vault-on-chain-here.js').VaultChainSource, 'deployState' | 'contractState'>,
): Promise<string | null> => {
  const what = 'a vault this company can use';
  const initialState = await source.deployState(ask.vault);
  if (initialState === null || initialState === undefined) {
    return `this is not ${what} yet: the chain holds no deploy at this vault's address. Nothing was sent.`;
  }
  const now = ask.again === true ? await source.contractState(ask.vault) : undefined;
  if (now === null) return `this is not ${what} yet: the chain holds no state at this vault's address. Nothing was sent. Press again in a minute.`;
  const verifierKeys = new Map(await d.vaultKeys.getVerifierKeys(VAULT_CIRCUITS));
  return vaultBornHeldRefusal(initialState, {
    account: ask.account, holders: ask.holders, verifierKeys,
    startingLedgerOf: (state) => startingLedgerFrom(
      d.vault.ledger((d.runtimeState.deserialize((state as { serialize(): Uint8Array }).serialize()) as { data: unknown }).data),
      d.vault.pureCircuits.copiesWrittenKey()),
  }, what, now === undefined ? undefined : { state: now });
};

