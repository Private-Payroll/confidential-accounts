import type { ActIntent } from 'midnight-identity/profile/request';
import { newInvitationToken } from '../../../../src/core/invitation.js';
import type { Hex } from '../../../../src/core/crypto.js';
import {
  InvitationNotMade, InvitationRefused, reissueInvitationHere, SeatMayNotInvite, type InvitationSend, type InvitingCompany,
} from '../../../../packages/web-shared/src/invitation-on-device.js';
import { withCompanyKeys } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { companyReachFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { proposalsAndSeatsOf } from './proposals-and-seats-read.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { invitingSeatOf } from './invite.js';
import { ActionStopped } from './run.js';
import { watchFor } from '../keyring/nothing-secret-crosses.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/*
 * SENDING A SIGNER'S INVITATION AGAIN, IN THE WALLET, FOR A PERSON WHOSE INVITER LEFT. The chain already seats them, but
 * the invitation their seat was proposed under names a seat the account no longer holds, so their own wallet keeps no
 * account on it and their entry is not believed. This wallet's seat signs that same invitation again - the same person,
 * name, role, vaults, seat and proposal, naming the one it replaces - under a new link, which only this window shows: the
 * page never sees it, beside the name that invitation carries rather than the one the page gave. It gives no new seat. Refused before anything is signed when this seat may not invite or the chain
 * does not hold it, when the invitation would offer vaults beyond this seat's own, when the company's proposals carry no
 * one invitation for that seat, or when the chain does not hold that seat now.
 */

/** What the re-issue reads the company with: the wallet's own chain and builder. */
export interface ReissueInvitationReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  /** Stands in for the wallet's own read of the company, in tests. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

/** Where the re-issue got to, as the action tells the page. */
export const REISSUE_STATE = { reissued: 'reissued' } as const;

const HEX64 = /^[0-9a-f]{64}$/u;
const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.reissue-invitation.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e);

/** The action that signs again, with this wallet's seat, the invitation a seated person was proposed under. */
export function reissueInvitationAction(reach: ReissueInvitationReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.reissue-invitation.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      { key: 'act.reissue-invitation.shown.name', values: { name: intent.fields['personName'] ?? '' }, from: 'page' },
      { key: 'act.reissue-invitation.shown.same', from: 'action' },
      { key: 'act.reissue-invitation.shown.link', from: 'action' },
      ...upkeepShown(),
      { key: 'act.reissue-invitation.shown.nothing-else', from: 'action' },
    ],
    checks: [
      { key: 'act.reissue-invitation.check.seat' },
      { key: 'act.reissue-invitation.check.invitation' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => (['record', 'personName'].some((k) => (intent.fields[k] ?? '') === '') || !HEX64.test(intent.fields['leaf'] ?? '')
      ? why('not-a-seat') : null),
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = {
        title: { key: 'act.reissue-invitation.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const reissue: ActionStep = {
        title: { key: 'act.reissue-invitation.step.reissue' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const inviting = await invitingSeatOf(ctx, r, (k) => why(k));
          const { proposals, onTheChain } = await proposalsAndSeatsOf(r, why);
          const company: InvitingCompany = withCompanyKeys({
            id: r.accountId, name: (await r.roster()).name, label: r.label, account: r.account, keyEpoch: r.companyKeys.epoch,
          }, r.companyKeys);
          const token = newInvitationToken();
          watchFor(token);
          const send: InvitationSend = (path, init) => ctx.call(init.method, path, init.body);
          let link: string;
          let name: string;
          try {
            ({ link, name } = await reissueInvitationHere(company, inviting, {
              leaf: intent.fields['leaf']!.toLowerCase() as Hex, proposals, onTheChain,
            }, ctx.asker.origin, send, { token }));
          } catch (e) {
            if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
            if (e instanceof SeatMayNotInvite || e instanceof InvitationNotMade) throw new StepRefused(why('not-made', { says: said(e) }), codeOfError(e));
            if (e instanceof InvitationRefused) throw new StepRefused(why('refused', { says: said(e) }), codeOfError(e));
            throw new StepRefused(why('not-made', { says: said(e) }), codeOfError(e));
          }
          ctx.tell({ state: REISSUE_STATE.reissued });
          ctx.show({ key: 'act.reissue-invitation.over.link', values: { name, link } });
        },
      };
      return [upkeep.first, seat, reissue, upkeep.last];
    },
  } satisfies ActionDefinition);
}
