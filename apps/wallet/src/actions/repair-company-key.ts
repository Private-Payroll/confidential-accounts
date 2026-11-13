/**
 * **THE COMPANY'S KEY REPAIRED FROM THE WALLET.** When a signer's copy of the company's newest key does not open, a
 * signer whose copy does repairs it: a new key made from the newest one this seat holds, wrapped to every signer who
 * stays, the payout seed kept (`rotateTheCompanyKeyHere` with `repair`). The repair is refused by the shared code for a
 * seat that does not hold the newest key, whose role files no proposal, or while a change of the key or a removal is
 * still being carried out; each refusal is said here with what clears it. Its facts come from the company's directory
 * and anchors as this wallet believes them and from the chain through this wallet's own reads. The act ends with the
 * upkeep, which wraps the company's read grants again to the new key, so readers keep their access.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import { rotateTheCompanyKeyHere } from '../../../../packages/web-shared/src/company-key-here.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { companyReachFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';
import { rotationDoorsIn, UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/** Where the act reads the chain and the company; the wallet's own, or a test's. */
export interface RepairCompanyKeyReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.repair-company-key.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e);

/** The shared code's answers that mean nothing was changed by this seat, each refused in this act's words. */
const DECLINED: ReadonlySet<string> = new Set(['not-rotated', 'waits', 'not-this-seat', 'not-needed']);

/**
 * **REPAIR THE COMPANY'S KEY**: confirmed by the person, then asked of the shared code as a repair between the upkeep's
 * two steps. A change of the key filed during this act's own upkeep is the repair already, and nothing more is filed.
 * Tells `state` (`rotated`, `filed-not-anchored` or `rotated-elsewhere`) and the new key's `epoch`.
 */
export function repairCompanyKeyAction(reach: RepairCompanyKeyReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.repair-company-key.headline',
    shown: async (): Promise<readonly ShownLine[]> => [
      { key: 'act.repair-company-key.shown.what', from: 'action' },
      { key: 'act.repair-company-key.shown.readers', from: 'action' },
      ...upkeepShown(),
      { key: 'act.repair-company-key.shown.nothing-else', from: 'action' },
    ],
    checks: [{ key: 'act.repair-company-key.check.newest' }, UPKEEP_CHECK],
    check: async (intent: ActIntent) => (intent.fields['record'] === undefined ? why('not-a-company') : null),
    steps: (): readonly ActionStep[] => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      let newestAtStart = 0;
      const seat: ActionStep = {
        title: { key: 'act.repair-company-key.step.seat' },
        run: async (ctx) => {
          newestAtStart = (await read.at(ctx)).companyKeys.newest;
          await ctx.confirm([{ key: 'act.repair-company-key.confirm.repair' }]);
        },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const repair: ActionStep = {
        title: { key: 'act.repair-company-key.step.repair' },
        run: async (ctx) => {
          read.renew();
          const r = await read.at(ctx);
          if (r.companyKeys.newest > newestAtStart) {
            ctx.tell({ state: 'rotated-elsewhere', epoch: r.companyKeys.newest });
            return;
          }
          let rotated: Awaited<ReturnType<typeof rotateTheCompanyKeyHere>>;
          try {
            rotated = await rotateTheCompanyKeyHere(await rotationDoorsIn(r, r.api), { repair: true });
          } catch (e) {
            if (e instanceof ActionStopped) throw e;
            throw new StepRefused(why('not-repaired', { says: said(e) }), codeOfError(e));
          }
          if (DECLINED.has(rotated.state)) throw new StepRefused(why(rotated.state, { says: 'why' in rotated ? rotated.why : '' }));
          ctx.tell({ state: rotated.state, ...('epoch' in rotated ? { epoch: rotated.epoch } : {}) });
          read.renew();
        },
      };
      return [seat, upkeep.first, repair, upkeep.last];
    },
  } satisfies ActionDefinition);
}
