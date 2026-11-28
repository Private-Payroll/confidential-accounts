/**
 * **A VAULT OR A COMPANY ACCOUNT CREATED, BUILT AND PROVED IN THE VAULT WORKER**: the vault's deploy and its
 * hand-over to its committee, a vault deployed already held, the account's deploy and the step that finishes it,
 * and a creation carried again.
 */
import {
  buildAccountDeploy,
  buildCommitteeHandover,
  buildVaultBornHeld,
  buildVaultDeploy,
  creationCarriedAgain,
  finishedCreation,
  type VaultBuilderDeps
} from './vault-builder.js';
import { fromBase64, toBase64 } from './base64-bytes.js';
import { CREATION_STEPS } from '../../../src/midnight/deferral.js';
import type { VaultAnswer, VaultAsk } from './vault-worker-client.js';
import type { WorkerDeps } from './vault-worker-deps.js';

/** The asks that create a vault or a company account; any other ask is answered elsewhere, so this gives undefined. */
export const creationAnswered = async (
  d: WorkerDeps,
  withNetwork: VaultBuilderDeps,
  ask: VaultAsk
): Promise<VaultAnswer | undefined> => {
  switch (ask.ask) {
    case 'deploy': {
      const built = await buildVaultDeploy(withNetwork, { account: ask.account });
      return {
        id: ask.id,
        ok: true,
        ask: 'deploy',
        vault: built.vault,
        temporaryKey: built.temporaryKey,
        tx: toBase64(built.proven)
      };
    }
    case 'account-deploy': {
      const built = await buildAccountDeploy({ ...withNetwork, accountKeys: d.accountKeys } as never, {
        foundingLeaf: ask.foundingLeaf,
        label: ask.label,
        foundingKey: ask.foundingKey
      });
      const insert = await d.accountKeys.getVerifierKeys(CREATION_STEPS.second);
      return {
        id: ask.id,
        ok: true,
        ask: 'account-deploy',
        account: built.address,
        tx: toBase64(built.proven),
        insert: insert.map(([circuit, key]) => ({ circuit, key: toBase64(key) }))
      };
    }
    case 'finished-creation': {
      const keys = new Map(await d.accountKeys.getVerifierKeys(CREATION_STEPS.second));
      const built = await finishedCreation(withNetwork, { account: ask.account, keys, signature: ask.signature });
      return { id: ask.id, ok: true, ask: 'finished-creation', tx: toBase64(built.proven) };
    }
    case 'born-held-vault': {
      const built = await buildVaultBornHeld(withNetwork, { account: ask.account, holders: ask.holders });
      return { id: ask.id, ok: true, ask: 'born-held-vault', vault: built.address, tx: toBase64(built.proven) };
    }
    case 'handover': {
      const built = await buildCommitteeHandover(withNetwork, {
        vault: ask.vault,
        counter: BigInt(ask.counter),
        temporaryKey: ask.temporaryKey,
        to: ask.to
      });
      return { id: ask.id, ok: true, ask: 'handover', tx: toBase64(built.proven) };
    }
    case 'creation-again': {
      const again = await creationCarriedAgain(withNetwork, {
        deploy: fromBase64(ask.deploy),
        insert: fromBase64(ask.insert)
      });
      return {
        id: ask.id,
        ok: true,
        ask: 'creation-again',
        account: again.account,
        deploy: toBase64(again.deploy),
        insert: toBase64(again.insert)
      };
    }
    default:
      return undefined;
  }
};
