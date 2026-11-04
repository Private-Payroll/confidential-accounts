import { Button, useText } from 'vaults-ui';
import type { ProposalRow } from '../adapters/company-records.js';
import { WHY, withdrawProposal } from '../adapters/proposal-acts.js';
import { ActedSays, useProposalAct } from '../records/proposal-act.js';
import { PanelFooter } from '../shell/right-panel.js';


/** Withdraw, asks the person's wallet to take this proposal back, and says what came of it. */
export function Withdraw({ row }: { row: ProposalRow }) {
  const t = useText();
  const act = useProposalAct();
  return (
    <PanelFooter>
      <div className="flex flex-col items-start gap-2" data-withdraw={row.id}>
        <Button variant="outline" disabled={act.phase !== null || act.done} onClick={() => act.start((person, company, onStep) => withdrawProposal(person, company, row, onStep))} data-action="withdraw">
          {t('proposals.withdraw')}
        </Button>
        <ActedSays
          phase={act.phase} result={act.result} done={t('proposals.withdraw.done')}
          own={{ [WHY.notAsShown]: t('proposals.withdraw.why.not-as-shown'), [WHY.oneOffHeld]: t('proposals.withdraw.why.one-off-held'), [WHY.notWithdrawn]: t('proposals.withdraw.why.not-withdrawn') }}
        />
      </div>
    </PanelFooter>
  );
}
