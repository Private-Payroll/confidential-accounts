import type { Hex } from '../../../../src/core/crypto.js';
import {
  createCompanyVault, NOT_BUILT, START_READ_STOP, START_STOP, VaultNotBuilt, VaultNotTheCompanys, VaultStartOwed,
  type SecretKeptHere,
} from '../../../../packages/web-shared/src/vault-operation.js';
import { VaultInfoRefused } from '../../../../packages/web-shared/src/vault-info-here.js';
import { readAccountAddress, readCompanyLabel, readVaultAddress } from 'midnight-identity/profile/company-label';
import { StepRefused, type ActionDefinition, type ActionStep, type StepContext, type Words } from './definition.js';
import { vaultKeysShown, vaultKeysSteps, type VaultKeysReach } from './give-vault-keys.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';
import { readersFrom, recordsKeepingTheSecret, vaultDoorsFor } from './vault-doors-here.js';

export { readersFrom, recordsKeepingTheSecret, vaultDoorsFor };

/*
 * CREATE A VAULT, IN THE WALLET, AS ONE ACTION. It gives this seat's vault keys
 * first, then builds the vault born held by the company's committee, proves
 * and signs every step of its start here - its name, its adoption, its pool,
 * its first secret and each signer's sealed copy - and hands each to the page
 * to send. The vault's secret is made here, kept in this wallet's own store
 * before the company's records are asked to file it, and sealed only to the
 * seats the wallet read on the chain, each one's records key signed by that
 * seat's own wallet and believed in the company's directory; a seat it cannot
 * believe stops the action before anything is approved. Before any of it, the
 * action does what the company is owed of this seat (its key changed, its
 * roster followed); after it, it files each vault's records again for the
 * signers seated since and anchors what was filed (`upkeepSteps`).
 */

/** Where the action keeps a new vault's secret, and how it pauses between reads of the chain. */
export interface CreateVaultReach extends VaultKeysReach {
  readonly secrets: (person: string) => SecretKeptHere;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly indexerHttp: string;
}

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.create-vault.why.${key}`, ...(values === undefined ? {} : { values }),
});

/** The kinds of stop a refused start names to the page with its words' key: the start's own, its reads' and a vault not built. */
const NAMED_TO_THE_PAGE = new Set<string>([...Object.values(START_STOP), ...Object.values(START_READ_STOP), ...Object.values(NOT_BUILT)]);
export const namedCode = (code: string | undefined): string | undefined => (code !== undefined && NAMED_TO_THE_PAGE.has(code) ? code : undefined);

/**
 * The step's refusal for what stopped the vault's creation or start, with the kind of stop the page may be told, and
 * the vault told when one was sent; null for anything else, which the step throws as it came.
 */
export const startRefusalOf = (e: unknown, ctx: Pick<StepContext, 'tell'>): StepRefused | null => {
  if (e instanceof VaultStartOwed) {
    ctx.tell({ vault: String(e.vault).toLowerCase(), ...(e.stoppedAt === undefined ? {} : { stopped: e.stoppedAt }) });
    return new StepRefused(why('start-owed', { says: e.message }), namedCode(e.stoppedAt));
  }
  if (e instanceof VaultNotBuilt) return new StepRefused(why('not-built', { code: e.code, says: e.message }), namedCode(e.code));
  if (e instanceof VaultNotTheCompanys) return new StepRefused(why('not-the-companys', { says: e.message }));
  if (e instanceof VaultInfoRefused) return new StepRefused(why('name-refused', { says: e.message }));
  return null;
};

/** Create a vault: the seat's vault keys given first, then the vault built, started and its secret set, in one action. */
export function createVaultAction(reach: CreateVaultReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.create-vault.headline',
    shown: async (intent) => {
      const named = intent.fields['vault'];
      const readers = intent.fields['readers'];
      /* Read before the passkey from this wallet's own indexer, which needs no seed: how many seats the secret is sealed to. */
      const label = readCompanyLabel(intent.fields['company']);
      const account = readAccountAddress(intent.fields['account']);
      const seated = label === null || account === null ? null
        : await reach.chain().holders(account, label).then((h) => ('key' in h ? null : h.seats.length), () => null);
      return [
        ...vaultKeysShown(intent, 'act.create-vault'),
        ...(named === undefined
          ? [{ key: 'act.create-vault.shown.new', from: 'action' as const }]
          : [
            { key: 'act.create-vault.shown.carry-on', values: { vault: named }, from: 'page' as const },
            { key: 'act.create-vault.shown.carry-on-check', from: 'action' as const },
          ]),
        ...(intent.fields['title'] === undefined ? [] : [{ key: 'act.create-vault.shown.title', values: { title: intent.fields['title']! }, from: 'page' as const }]),
        ...(intent.fields['about'] === undefined ? [] : [{ key: 'act.create-vault.shown.about', values: { about: intent.fields['about']! }, from: 'page' as const }]),
        seated === null
          ? { key: 'act.create-vault.shown.sealed-to-unread', from: 'action' as const }
          : { key: 'act.create-vault.shown.sealed-to', values: { seats: seated }, from: 'wallet' as const },
        ...(readers === undefined ? [] : [{ key: 'act.create-vault.shown.readers', values: { names: readers }, from: 'page' as const }]),
        ...upkeepShown(),
        { key: 'act.create-vault.shown.nothing-else', from: 'action' as const },
      ];
    },
    checks: [
      { key: 'act.create-vault.check.seat' },
      { key: 'act.create-vault.check.readers' },
      { key: 'act.create-vault.check.born-held' },
      { key: 'act.create-vault.check.made-here' },
      UPKEEP_CHECK,
    ],
    check: async (intent, held) => {
      if (held.wallet === undefined) return why('no-record');
      if (intent.fields['record'] === undefined) return why('not-a-company');
      if (intent.fields['vault'] !== undefined && readVaultAddress(intent.fields['vault']) === null) return why('not-a-vault');
      return null;
    },
    steps: (intent) => {
      const keys = vaultKeysSteps(reach, why, 'act.create-vault');
      const start: ActionStep = {
        title: { key: 'act.create-vault.step.start' },
        run: async (ctx) => {
          const { reach: r } = await keys.given(ctx);
          const vault = intent.fields['vault'];
          if (vault !== undefined) ctx.tell({ vault: vault.toLowerCase() });
          /* A new vault is built only once every seat the chain holds can be given its secret, so none is left half set up for want of a signer's keys. */
          if (vault === undefined) await readersFrom(r);
          const title = intent.fields['title'];
          const info = title === undefined ? undefined : { name: title, description: intent.fields['about'] ?? '' };
          try {
            const done = await createCompanyVault(vaultDoorsFor(ctx, r, reach), vault as Hex | undefined, info);
            ctx.tell({ vault: done.vault.toLowerCase(), ...(done.saidCodes === undefined || done.saidCodes.length === 0 ? {} : { said: done.saidCodes.join(',') }) });
            if (done.state === 'awaiting-approvals') {
              ctx.tell({ round: done.awaiting.round, approvals: done.awaiting.approvals, needed: done.awaiting.needed });
            }
          } catch (e) {
            throw startRefusalOf(e, ctx) ?? e;
          }
        },
      };
      const upkeep = upkeepSteps({ reach: keys.company, renew: keys.renew }, reach);
      return [upkeep.first, ...keys.steps, start, upkeep.last];
    },
  } satisfies ActionDefinition);
}
