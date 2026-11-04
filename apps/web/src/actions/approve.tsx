import { Button, useText } from 'vaults-ui';
import type { ProposalRow } from '../adapters/company-records.js';
import { approveProposal, canApprove, PROPOSAL_ACTED } from '../adapters/proposal-acts.js';
import { ActedSays, useProposalAct } from '../records/proposal-act.js';
import { PanelFooter } from '../shell/right-panel.js';


/**
 * THE ONE APPROVE, on every list of proposals: asks the person's wallet to approve this proposal, and says what came of it. Nothing is drawn for a proposal
 * the list cannot approve. On a one-off payment the chain holds approved and shows not yet paid it is the same act, pressed as Pay, since the wallet finds
 * it at the bar and only pays it; it says the payment was made only when the wallet says it paid it or found it paid.
 */
export function Approve({ row, size = 'default' }: { row: ProposalRow; size?: 'default' | 'sm' }) {
  const t = useText();
  const act = useProposalAct();
  if (!canApprove(row)) return null;
  const paying = row.status === 'approved';
  const state = act.result?.of === PROPOSAL_ACTED.done ? act.result.state : null;
  const done = !paying ? t('proposal.act.approved') : state === 'paid' || state === 'already-paid' ? t('oneOff.done.paid') : t('proposal.act.notPaid');
  return (
    <PanelFooter>
      <div className="flex flex-col items-start gap-2" data-approve={row.id}>
        <Button size={size} disabled={act.phase !== null || act.done} onClick={() => act.start((person, company, onStep) => approveProposal(person, company, row, onStep))} data-action="approve">
          {paying ? t('proposals.pay') : t('proposals.approve')}
        </Button>
        <ActedSays phase={act.phase} result={act.result} done={done} />
      </div>
    </PanelFooter>
  );
}
