/**
 * **A RETIRED VAULT ADOPTED AGAIN AFTER THE COMPANY'S SUPER ADMINS CHANGED.** A change of super admins moves every vault
 * the company holds or retired, so a vault deployed before it is held now by the committee the company holds now, and
 * its deploy never will be again. Adopt again reads who holds it off its state today; a first adoption still reads its
 * deploy. The chain is a stand-in that refuses a deploy-held reading of the vault and answers the one made today.
 */
import { describe, expect, it } from 'vitest';
import { VaultNotTheCompanys, createCompanyVault } from './vault-operation.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { ACCOUNT, VAULT, builder, filedAlready, held, pacing, serviceFrom, startDoors, walletReadsTheVault } from './vault-operation.test-support.js';
import type { Hex } from '../../../src/core/crypto.js';

const RETIRED_BY = '0d'.repeat(32) as Hex;
const DEPLOY_HELD = 'this is not a vault this company can use: a vault is held from its first transaction by the company\'s committee, at '
  + 'the company\'s threshold, and this one is held by other keys, at another threshold, or was changed. Nothing was sent.';

/** The chain after the change: read as deployed, the vault is held by other keys; read as it is today, by the company's. */
const movedSince = (log: string[], today: string | null = null): VaultBuilderClient => ({
  ...builder(log),
  vaultAsDeployed: async (i: Parameters<NonNullable<VaultBuilderClient['vaultAsDeployed']>>[0]) => {
    log.push(i.again === true ? 'read who holds it today' : 'read who held it at its deploy');
    return { refusal: i.again === true ? today : DEPLOY_HELD };
  },
});

describe('A RETIRED VAULT ADOPTED AGAIN AFTER ITS SUPER ADMINS CHANGED', () => {
  it('is read as held by the committee the company holds now, and its start carries on to the end', async () => {
    const log: string[] = [];
    const done = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...await filedAlready(), account: ACCOUNT, service: serviceFrom([held], log), builder: movedSince(log), again: RETIRED_BY }, VAULT);
    /* RED WHEN: a vault adopted again is held to its deploy's committee, which no change since can match, so the money paid into it is reached by no device. */
    expect(log).toEqual(['read who holds it today', 'read the block here', 'read the block here']);
    expect(done).toEqual({ vault: VAULT, state: 'started' });
  });

  it('a first adoption is still read off its deploy, and a vault held today by other keys is not adopted again, in words that say what clears it', async () => {
    const log: string[] = [];
    /* RED WHEN: a first adoption stops reading who held the vault at its deploy. */
    const first = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...startDoors(), account: ACCOUNT, service: serviceFrom([held], log), builder: movedSince(log) }, VAULT).catch((x: unknown) => x);
    expect(first).toBeInstanceOf(VaultNotTheCompanys);
    const today = 'this is not a vault this company can use: it is held now by other keys, or at another threshold, than your company\'s super admins hold. '
      + 'Have the super admins make their change again, which moves every vault the company holds or retired, then adopt it again. Nothing was sent.';
    const e = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...startDoors(), account: ACCOUNT, service: serviceFrom([held], log), builder: movedSince(log, today), again: RETIRED_BY }, VAULT)
      .catch((x: Error) => x);
    /* RED WHEN: a vault adopted again and held today by other keys is carried on, or is told to be replaced by a new vault, which leaves its money where it is. */
    expect(e).toBeInstanceOf(VaultNotTheCompanys);
    expect((e as Error).message).toBe(today);
  });
});
