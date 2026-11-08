import type { ActIntent } from 'midnight-identity/profile/request';
import { readVaultAddress } from 'midnight-identity/profile/company-label';
import type { Hex } from '../../../../src/core/crypto.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { companyReachFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { rotationDoorsIn, UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';
import type { VaultDoorsReach } from './vault-doors-here.js';
import { stillOwed, toldOf, vaultSecretsChangedHere } from './vault-secrets-changed-here.js';

/*
 * CHANGE THE COMPANY'S VAULT SECRETS, IN THE WALLET, AFTER A SIGNER IS REMOVED: the press a signer who stays makes when
 * a vault's secret change is owed (the removal's own change could not finish, or the wallet that carried it was lost).
 * For the vault the page names, or every vault the company's account has adopted on the chain, a new secret is made and
 * kept in this wallet, its run raised with this seat's approval, and, when the approvals it needs are met on this
 * press, set and its sealed copies written. A run already open on the chain is never raised again; a vault that owes
 * nothing is left as it is. Before it, the action does what the company is owed of this seat; after it, the upkeep.
 */

/** What the action reads: the company's chain and builder, and where this wallet keeps a vault's new secret. */
export interface RotateVaultSecretsReach extends VaultDoorsReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  /** Tests only: the company as read, without the chain. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.rotate-vault-secrets.why.${key}`, ...(values === undefined ? {} : { values }),
});

/** The vault the page names, null for every vault, or the words refusing a vault that is not one. */
const vaultAsked = (intent: ActIntent): Hex | null | Words => {
  const named = intent.fields['vault'];
  if (named === undefined) return null;
  const vault = readVaultAddress(named);
  return vault === null ? why('not-a-vault') : (String(vault).toLowerCase() as Hex);
};

/** What changed, as the page is told it: the press's state, and how many vaults ended in each. */
const STATE = { done: 'done', partial: 'partial' } as const;

/** Change the company's vault secrets: the upkeep, the change raised (and carried where its approvals are met), the upkeep. */
export function rotateVaultSecretsAction(reach: RotateVaultSecretsReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.rotate-vault-secrets.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      intent.fields['vault'] === undefined
        ? { key: 'act.rotate-vault-secrets.shown.every-vault', from: 'action' as const }
        : { key: 'act.rotate-vault-secrets.shown.vault', values: { vault: intent.fields['vault'] }, from: 'page' as const },
      { key: 'act.rotate-vault-secrets.shown.what', from: 'action' as const },
      { key: 'act.rotate-vault-secrets.shown.proofs', from: 'action' as const },
      ...upkeepShown(),
      { key: 'act.rotate-vault-secrets.shown.nothing-else', from: 'action' as const },
    ],
    checks: [{ key: 'act.rotate-vault-secrets.check.owed' }, UPKEEP_CHECK],
    check: async (intent) => {
      if (intent.fields['record'] === undefined) return why('not-a-company');
      const v = vaultAsked(intent);
      return v !== null && typeof v === 'object' ? v : null;
    },
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, { vaultSecrets: reach });
      const change: ActionStep = {
        title: { key: 'act.rotate-vault-secrets.step.change' },
        run: async (ctx) => {
          const v = vaultAsked(intent);
          if (v !== null && typeof v === 'object') throw new StepRefused(v);
          const r = await read.at(ctx);
          const changed = await vaultSecretsChangedHere(ctx, r, reach, await rotationDoorsIn(r, r.api), 'raise', v === null ? {} : { vault: v });
          const told = toldOf(changed);
          ctx.tell({ state: stillOwed(changed) ? STATE.partial : STATE.done, ...told });
        },
      };
      return [upkeep.first, change, upkeep.last];
    },
  } satisfies ActionDefinition);
}
