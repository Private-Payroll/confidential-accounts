import { useState } from 'react';
import { AlertDescription, Button, useText } from 'vaults-ui';
import { PAY_RUN_WHY, payRun, PROPOSAL_ACTED, WHY, type PayRunActed, type PayRunWhy } from '../adapters/proposal-acts.js';
import type { RunLeg, RunRow } from '../adapters/company-records.js';
import { useCompanyRecords } from '../records/company-records.js';
import { useMonth } from '../records/parts.js';
import { ActDone, ActOutcome, ActStopped, type ActPhase } from '../records/proposal-act.js';
import { PublicFacts } from '../records/public-facts.js';
import { PanelFooter } from '../shell/right-panel.js';
import { useSession } from '../session.js';

/**
 * PAY ONE LEG OF AN APPROVED RUN, in the shell's panel: it shows the run and what paying makes public on the network (`PublicFacts`)
 * before Pay, asks the wallet once for the leg shown when Pay is pressed, and keeps the wallet's own answer on screen: how many were
 * paid and are still owed, a leg the network already shows paid, one still waiting for approvals, or the reason it stopped. It is
 * drawn in the panel and never under the page's records: they are read again after a payment and stand empty while they read, which
 * would take the result with them.
 */
export function PayRun({ run, leg, vaultName }: { run: RunRow; leg: RunLeg; vaultName: string }) {
  const t = useText();
  const month = useMonth();
  const { person, company } = useSession();
  const { reload } = useCompanyRecords();
  const [phase, setPhase] = useState<ActPhase>(null);
  const [result, setResult] = useState<PayRunActed | null>(null);
  const busy = phase !== null;
  /* After the wallet's own answer that everyone is paid, or already shown paid, nothing is left to pay and Pay is not offered again. */
  const nothingLeft = result?.of === PROPOSAL_ACTED.done && (result.state === 'paid' || result.state === 'already-paid');

  const pay = async (): Promise<void> => {
    if (company === null || busy || leg.proposal === null) return;
    setResult(null);
    setPhase({ step: 0, steps: 0 });
    const ended = await payRun(person.id, company, {
      proposal: leg.proposal, run: run.id, period: run.period, list: leg.list, vault: leg.vault, token: leg.asset, form: leg.form, payees: leg.people, total: leg.total,
    }, (step, steps) => setPhase({ step, steps }));
    setPhase(null);
    setResult(ended);
    if (ended.of === PROPOSAL_ACTED.done || (ended.of === PROPOSAL_ACTED.stopped && (ended.partial || ended.handedOver))) reload();
  };

  return (
    <div className="flex flex-col gap-4 text-sm" data-action="pay-run-panel">
      <p data-pay-run-run>{t('payRun.run', { month: month(run.period), people: t('payRun.people', { count: leg.people }), vault: vaultName })}</p>
      <PublicFacts leg={leg} vaultName={vaultName} />
      <p className="text-muted-foreground" data-pay-run-note>{t('payRun.walletNote')}</p>
      <PanelFooter>
        <div className="flex flex-col gap-4">
          <div>
            <Button type="button" disabled={busy || nothingLeft || company === null || leg.form === null || leg.proposal === null} data-action="pay-run" onClick={() => { void pay(); }}>
              {t('payRun.pay')}
            </Button>
          </div>
          <Said phase={phase} result={result} />
        </div>
      </PanelFooter>
    </div>
  );
}

function Said({ phase, result }: { phase: ActPhase; result: PayRunActed | null }) {
  const t = useText();
  const says: Partial<Record<PayRunWhy, string>> = {
    [WHY.seat]: t('payRun.why.seat'), [WHY.notAProposal]: t('payRun.why.not-a-proposal'), [WHY.notAsShown]: t('payRun.why.not-as-shown'),
    [WHY.notRaised]: t('payRun.why.not-raised'), [WHY.closed]: t('payRun.why.closed'), [WHY.withdrawn]: t('payRun.why.withdrawn'),
    [PAY_RUN_WHY.notOpenYet]: t('payRun.why.not-open-yet'), [PAY_RUN_WHY.windowClosed]: t('payRun.why.window-closed'),
    [PAY_RUN_WHY.notPayable]: t('payRun.why.not-payable'), [PAY_RUN_WHY.stopped]: t('payRun.why.pay-stopped'),
    [PAY_RUN_WHY.stoppedUnseen]: t('payRun.why.pay-stopped-unseen'), [PAY_RUN_WHY.notAsBuilt]: t('payRun.why.payment-not-as-built'),
    [PAY_RUN_WHY.notPaid]: t('payRun.why.not-paid'), [WHY.mayBeSent]: t('payRun.why.may-be-sent'), [WHY.stopped]: t('signers.why.stopped'),
  };
  const ended = result?.of === PROPOSAL_ACTED.done ? result : null;
  const stopped = result?.of === PROPOSAL_ACTED.stopped ? result : null;
  const doneWords = (r: NonNullable<typeof ended>): string => {
    const { state, paid, owed, unseen } = r;
    return state === 'already-paid' ? t('payRun.done.already')
      : state === 'awaiting-approvals' ? t('payRun.done.awaiting')
        : paid === null || owed === null ? t('payRun.done.unknown')
          : state === 'paid' && owed === 0 ? t('payRun.done.paid', { count: paid })
            : unseen !== null && unseen > 0 ? t('payRun.done.partly.unseen', { paid, owed, unseen }) : t('payRun.done.partly', { paid, owed });
  };
  return (
    <ActOutcome phase={phase} refused={result?.of === PROPOSAL_ACTED.refused ? result.why : null}>
      {ended === null ? null : <ActDone data-acted data-pay-state={ended.state ?? ''}>{doneWords(ended)}</ActDone>}
      {stopped === null ? null : (
        <ActStopped calm={stopped.partial || stopped.handedOver} data-pay-stopped={stopped.why}>
          <AlertDescription>{says[stopped.why] ?? t('payRun.why.other')}</AlertDescription>
          {stopped.paid !== null && stopped.owed !== null ? <AlertDescription data-pay-counts>{t('payRun.counts', { paid: stopped.paid, owed: stopped.owed })}</AlertDescription> : null}
          {stopped.handedOver && !stopped.partial ? <AlertDescription>{t('signers.sent')}</AlertDescription> : null}
        </ActStopped>
      )}
    </ActOutcome>
  );
}
