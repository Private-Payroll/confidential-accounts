/**
 * **APPROVING A PROPOSAL OF THE COMPANY, IN THE WALLET**: one window and one passkey for every kind of proposal the page
 * names (`proposalKinds`). The wallet reads the company and this seat from the chain and the company's records; for a
 * kind whose approval is about what only the seat's keys open, it reads that in the same first step and waits for the
 * person's Confirm of it in the window (`confirmFirst`), before anything is sent. It then does what the company owes
 * first (the upkeep), approves through the one approve step, carries the proposal out where its
 * kind does so here and the approvals are given, and ends with the upkeep's anchor. The page gets back only where the
 * proposal got to, its approvals and the approvals it needs, each read from the chain through this wallet's indexer.
 * A kind that runs on the chain and the person's own wallet alone (a recovery of the company's records) takes its own
 * lines and steps instead, with no upkeep and nothing asked of the service.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import { companyReachFor, keptReach, type CompanyReach } from './company-reach.js';
import type { ActionDefinition, ActionStep, ShownLine, StepContext, Words } from './definition.js';
import { approveStep, approving, confirmFirst, isChainOnly, proposalKinds, type ProposalKindsReach } from './proposal-kinds.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/** What the action reads beside the company; `reachFor` stands in for the company read in tests. */
export type ApproveProposalReach = ProposalKindsReach & {
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
};

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.approve-proposal.why.${key}`, ...(values === undefined ? {} : { values }),
});
const NAMED = ['record', 'proposal', 'kind'] as const;
/** What is checked after the passkey for every kind that runs the shared steps; a chain-only kind lists its own. */
const CHECKS: readonly Words[] = [
  { key: 'act.approve-proposal.check.seat' },
  { key: 'act.approve-proposal.check.same' },
  { key: 'act.approve-proposal.check.one-seat' },
  { key: 'act.approve-proposal.check.chain' },
  UPKEEP_CHECK,
];

export function approveProposalAction(reach: ApproveProposalReach): ActionDefinition {
  const kinds = proposalKinds(reach);
  const kindOf = (intent: ActIntent) => (Object.prototype.hasOwnProperty.call(kinds, intent.fields['kind'] ?? '') ? kinds[intent.fields['kind']!]! : null);
  return Object.freeze({
    headline: 'act.approve-proposal.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => {
      const kind = kindOf(intent);
      if (kind !== null && isChainOnly(kind)) return kind.shown(intent);
      return [
        ...(await kind?.shown(intent) ?? []),
        ...upkeepShown(),
        { key: 'act.approve-proposal.shown.nothing-else', from: 'action' as const },
      ];
    },
    checks: CHECKS,
    checksFor: (intent: ActIntent) => {
      const kind = kindOf(intent);
      return kind !== null && isChainOnly(kind) ? kind.checks : CHECKS;
    },
    check: async (intent) => {
      const kind = kindOf(intent);
      const empty = (k: string) => intent.fields[k] === undefined || intent.fields[k] === '';
      if (kind === null || NAMED.some(empty) || kind.fields.some(empty)) return why('not-a-proposal');
      return kind.check(intent);
    },
    steps: (intent) => {
      const kind = kindOf(intent);
      if (kind === null) return [];
      if (isChainOnly(kind)) return kind.steps(intent);
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const here = approving();
      const seat: ActionStep = {
        title: { key: kind.readsFirst === true ? 'act.approve-proposal.step.seat-and-confirm' : 'act.approve-proposal.step.seat' },
        run: async (ctx) => { await confirmFirst(kind, intent, await read.at(ctx), here, ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, kind.upkeep ?? {});
      const approve = approveStep(kind, intent, read, here, { key: 'act.approve-proposal.step.approve' });
      return [seat, upkeep.first, approve, ...(kind.carry?.(here, read, intent) ?? []), upkeep.last];
    },
  } satisfies ActionDefinition);
}
