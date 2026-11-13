import type { ActIntent } from 'midnight-identity/profile/request';
import { InvitationRefused, SeatMayNotInvite, type InvitationSend } from '../../../../packages/web-shared/src/invitation-on-device.js';
import {
  withdrawalReadsHere, withdrawWaitingSignerHere, type WaitingReads, type WithdrawalReads,
} from '../../../../packages/web-shared/src/waiting-signer-withdrawn.js';
import { RecordWithheld } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { chainTimeOf } from './chain-time.js';
import { companyReachFor, governanceRecordsFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { invitingSeatOf } from './invite.js';
import { ActionStopped } from './run.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/*
 * WITHDRAWING SOMEBODY WAITING FOR A SEAT, IN THE WALLET. A person whose request for a seat reached the company but whom
 * no proposal has seated is let go with this wallet's seat, so the same person can be invited again: the withdrawal is
 * signed here and the service drops the request and marks the invitation it answered withdrawn. It is refused, before
 * anything is signed, while a proposal to seat them could still be carried out: one the chain holds open, approved or
 * not, or one written down whose raise may still land, as this wallet reads the chain itself. Such a proposal is
 * withdrawn first; nothing here changes anything on the chain. A seat that may not invite, or one the chain does not
 * hold now, withdraws nobody, and so does a request that is not for the name the person was shown.
 */

/** What the withdrawal reads the company with: the wallet's own chain and builder. */
export interface WithdrawWaitingSignerReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  /** Stands in for the wallet's own read of the company, in tests. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

/** Where the withdrawal got to, as the action tells the page. */
export const WITHDRAW_STATE = { withdrawn: 'withdrawn' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.withdraw-waiting-signer.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e);

/** The action that withdraws, with this wallet's seat, a person waiting for a seat whom no proposal can still seat. */
export function withdrawWaitingSignerAction(reach: WithdrawWaitingSignerReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.withdraw-waiting-signer.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      { key: 'act.withdraw-waiting-signer.shown.name', values: { name: intent.fields['personName'] ?? '' }, from: 'page' },
      { key: 'act.withdraw-waiting-signer.shown.checks', from: 'action' },
      { key: 'act.withdraw-waiting-signer.shown.withdraw', from: 'action' },
      ...upkeepShown(),
      { key: 'act.withdraw-waiting-signer.shown.nothing-else', from: 'action' },
    ],
    checks: [
      { key: 'act.withdraw-waiting-signer.check.seat' },
      { key: 'act.withdraw-waiting-signer.check.chain' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => (['record', 'signer', 'personName'].some((k) => (intent.fields[k] ?? '') === '') ? why('not-a-signer') : null),
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = {
        title: { key: 'act.withdraw-waiting-signer.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const withdraw: ActionStep = {
        title: { key: 'act.withdraw-waiting-signer.step.withdraw' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const signerId = intent.fields['signer']!;
          const inviting = await invitingSeatOf(ctx, r, (k) => why(k));
          const records = governanceRecordsFor(r);
          const asked: WithdrawalReads = { ...records, chainTime: chainTimeOf(r) };
          let reads: WaitingReads;
          try {
            reads = await withdrawalReadsHere(asked, r.sealed, r.accountId, r.companyKeys, signerId);
          } catch (e) {
            if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
            if (e instanceof RecordWithheld) throw new StepRefused(why('withheld', { says: said(e) }), codeOfError(e));
            throw new StepRefused(why('chain-unread', { says: said(e) }), codeOfError(e));
          }
          const send: InvitationSend = (path, init) => ctx.call(init.method, path, init.body);
          try {
            await withdrawWaitingSignerHere({ id: r.accountId, companyKeys: r.companyKeys }, inviting, signerId, reads, send, intent.fields['personName']!);
          } catch (e) {
            if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
            if (e instanceof SeatMayNotInvite) throw new StepRefused(why('may-not', { says: said(e) }), codeOfError(e));
            if (e instanceof InvitationRefused) throw new StepRefused(why('refused', { says: said(e) }), codeOfError(e));
            throw new StepRefused(why('not-withdrawn', { says: said(e) }), codeOfError(e));
          }
          read.renew();
          ctx.tell({ state: WITHDRAW_STATE.withdrawn });
        },
      };
      return [upkeep.first, seat, withdraw, upkeep.last];
    },
  } satisfies ActionDefinition);
}
