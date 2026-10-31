import type { ActIntent } from 'midnight-identity/profile/request';
import type { Hex } from '../../../../src/core/crypto.js';
import type { Role } from '../../../../src/core/types.js';
import {
  ApprovalNotOwed, approveSeatInvitationOnDevice, InvitationNotBound, nothingWasSentBy, NothingToApprove, WithdrawnWhileSent, withCompanyKeys,
} from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { NotOpenedOnThisDevice } from '../../../../packages/web-shared/src/round-opened-here.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { companyReachFor, governanceDoorsFor, keptReach, type CompanyChain, type CompanyReach, type Handed } from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/*
 * APPROVING A SIGNER INVITED BY ADDRESS, IN THE WALLET. Another seat raised the proposal to seat a private address; the
 * page names that proposal and what it invites, in its own words, and this wallet approves it with its own seat only
 * when the proposal it opens itself invites exactly that: the name, the role, the commitment to the address, the rights
 * and the coin key shown, the coin key making that commitment, and a wallet holding no seat here and no other open invitation.
 * It raises nothing: a proposal the chain has not raised is refused with nothing sent. The person invited takes the
 * seat from their own wallet once the approvals reach the bar. An approval the chain already counts for this seat (a
 * raise counts its raiser's), and a proposal the chain has already carried out, are refused in words of their own that
 * say what is pressed next. Every refusal carries the kind of error that caused it as its code, for the page's report.
 */

/** What the approve action reads the company with: the wallet's own chain and builder, the account's commitments and its waits. */
export interface ApproveSignerReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The account's commitments, which make an address's commitment and the rights of every vault. */
  readonly commitments: () => Promise<{ inviteAddressOf(coinPublicKey: Hex, salt: Hex): Hex; allVaults(): Hex }>;
  /** Stands in for the wallet's own read of the company, in tests. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
  readonly waitMs?: number;
  readonly everyMs?: number;
}

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.approve-signer.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e);
const NAMED = ['record', 'proposal', 'personName', 'role', 'address', 'scope', 'coinKey'] as const;
const ROLES: readonly Role[] = ['admin', 'approver', 'initiator', 'viewer'];
const roleOf = (x: string | undefined): Role | null => (ROLES as readonly (string | undefined)[]).includes(x) ? x as Role : null;

/** The action that approves, with this wallet's seat, a proposal another seat raised to seat a private address. */
export function approveSignerAction(reach: ApproveSignerReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.approve-signer.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => {
      const f = intent.fields;
      const all = await reach.commitments().then((c) => c.allVaults().toLowerCase(), () => null);
      return [
        { key: 'act.approve-signer.shown.name', values: { name: f['personName'] ?? '' }, from: 'page' },
        ...(roleOf(f['role']) === null ? [] : [{ key: `act.approve-signer.shown.role.${roleOf(f['role'])!}`, from: 'page' as const }]),
        { key: 'act.approve-signer.shown.address', values: { address: f['address'] ?? '' }, from: 'page' },
        { key: 'act.approve-signer.shown.coin-key', values: { coinKey: f['coinKey'] ?? '' }, from: 'page' },
        all !== null && (f['scope'] ?? '').toLowerCase() === all
          ? { key: 'act.approve-signer.shown.every-vault', from: 'action' }
          : { key: 'act.approve-signer.shown.scope', values: { scope: f['scope'] ?? '' }, from: 'page' },
        { key: 'act.approve-signer.shown.checks', from: 'action' },
        { key: 'act.approve-signer.shown.approve', from: 'action' },
        ...upkeepShown(),
        { key: 'act.approve-signer.shown.nothing-else', from: 'action' },
      ];
    },
    checks: [
      { key: 'act.approve-signer.check.seat' },
      { key: 'act.approve-signer.check.same' },
      { key: 'act.approve-signer.check.one-seat' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => (NAMED.some((k) => intent.fields[k] === undefined || intent.fields[k] === '') || roleOf(intent.fields['role']) === null
      ? why('not-a-proposal') : null),
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = {
        title: { key: 'act.approve-signer.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const approve: ActionStep = {
        title: { key: 'act.approve-signer.step.approve' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const f = intent.fields;
          const commitments = await reach.commitments();
          const handed: Handed = { over: false };
          const doors = governanceDoorsFor(r, (ms) => reach.pause(ms, ctx.signal), handed, {
            ...(reach.waitMs === undefined ? {} : { waitMs: reach.waitMs }), ...(reach.everyMs === undefined ? {} : { everyMs: reach.everyMs }),
          });
          try {
            const done = await approveSeatInvitationOnDevice(doors, withCompanyKeys({
              shown: { proposal: f['proposal']!, name: f['personName']!, role: roleOf(f['role'])!, address: f['address']!, scope: f['scope']!, coinPublicKey: f['coinKey']! },
            }, r.companyKeys), (c, salt) => commitments.inviteAddressOf(c, salt));
            const count = done.round?.approvalCount;
            ctx.tell({ state: done.state, ...(typeof count === 'number' ? { approvals: count } : {}) });
          } catch (e) {
            if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
            const code = codeOfError(e);
            if (e instanceof WithdrawnWhileSent) throw new StepRefused(why('withdrawn'), code);
            if (e instanceof ApprovalNotOwed) throw new StepRefused(why(e.why === 'counted' ? 'already-counted' : 'carried-out'), code);
            if (e instanceof NothingToApprove || e instanceof InvitationNotBound || e instanceof NotOpenedOnThisDevice) {
              throw new StepRefused(why(handed.over ? 'may-be-sent' : 'not-approved', { says: said(e) }), code);
            }
            throw new StepRefused(why(!handed.over || nothingWasSentBy(e) ? 'not-approved' : 'may-be-sent', { says: said(e) }), code);
          }
        },
      };
      return [upkeep.first, seat, approve, upkeep.last];
    },
  } satisfies ActionDefinition);
}
