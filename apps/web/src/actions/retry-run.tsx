import { useId, useState } from 'react';
import { AlertDescription, Amount, AMOUNT_KIND, Button, FieldError, FieldLegend, FieldSet, Input, Section, SectionRow, useText } from 'vaults-ui';
import {
  PROPOSAL_ACTED, RAISE_RUN_WHY, paymentWindow, retryRun, WINDOW_OF, WINDOW_PROBLEM, type RaiseRunActed, type RaiseRunWhy, type WindowProblem,
} from '../adapters/proposal-acts.js';
import type { RunLeg, RunRow } from '../adapters/company-records.js';
import { useCompanyRecords } from '../records/company-records.js';
import { useMonth } from '../records/parts.js';
import { ActDone, ActOutcome, ActStopped, type ActPhase } from '../records/proposal-act.js';
import { PanelFooter } from '../shell/right-panel.js';
import { useSession } from '../session.js';

/**
 * THE RETRY PANEL OF A RUN'S LEG: the people of the leg the chain shows unpaid, named by their place among the leg's leaves, and the
 * window the person types for the retry (opens and closes, neither given a default, Raise waiting for both and for an opening in the
 * future). Raise asks the wallet once; the wallet checks the run, the people, the total and whether the leg can still pay them, shows
 * them, and raises only on the person's Confirm there. The answer stays on screen when the records are read again.
 */
export function RetryRun({ run, leg }: { run: RunRow; leg: RunLeg }) {
  const t = useText();
  const opensId = useId();
  const closesId = useId();
  const formId = useId();
  const month = useMonth();
  const { person, company: companyId } = useSession();
  const { reload } = useCompanyRecords();
  const [opens, setOpens] = useState('');
  const [closes, setCloses] = useState('');
  const [phase, setPhase] = useState<ActPhase>(null);
  const [result, setResult] = useState<RaiseRunActed | null>(null);
  const busy = phase !== null;
  const raised = result?.of === PROPOSAL_ACTED.done;
  const places = leg.unpaid ?? [];
  const total = places.reduce((sum, i) => sum + (leg.amounts?.[i] ?? 0n), 0n);
  const span = paymentWindow(opens, closes, Date.now());

  const raise = async (): Promise<void> => {
    const given = paymentWindow(opens, closes, Date.now());
    if (companyId === null || busy || raised || leg.form === null || given.of !== WINDOW_OF.given) return;
    setResult(null);
    setPhase({ step: 0, steps: 0 });
    const ended = await retryRun(person.id, companyId, {
      run: run.id, period: run.period, list: leg.list, vault: leg.vault, token: leg.asset, form: leg.form, indices: places, total, opensAt: given.opensAt, closesAt: given.closesAt,
    }, (step, steps) => setPhase({ step, steps }));
    setPhase(null);
    setResult(ended);
    if (ended.of === PROPOSAL_ACTED.done || (ended.of === PROPOSAL_ACTED.stopped && ended.handedOver)) reload();
  };

  return (
    <form id={formId} className="flex max-w-xl flex-col gap-4 text-sm" data-action="retry-run-panel" onSubmit={(e) => { e.preventDefault(); void raise(); }}>
      <p data-retry-run-run>{t('retryRun.run', { month: month(run.period), people: t('retryRun.people', { count: places.length }) })}</p>
      <Section title={t('retryRun.who')} empty={null} data-retry-run-people>
        {places.map((i) => (
          <SectionRow key={i} data-retry-person={i}>
            <span>{leg.pays[i]?.name ?? t('records.unrecognisedOne')}</span>
            {leg.pays[i]?.amount == null ? null : <Amount value={leg.pays[i]!.amount!} kind={AMOUNT_KIND.toBePaid} />}
          </SectionRow>
        ))}
      </Section>
      <FieldSet disabled={busy || raised}>
        <FieldLegend variant="label"><label htmlFor={opensId}>{t('retryRun.opens')}</label></FieldLegend>
        <Input id={opensId} type="datetime-local" value={opens} onChange={(e) => setOpens(e.target.value)} data-field="opens" />
        <FieldLegend variant="label"><label htmlFor={closesId}>{t('retryRun.closes')}</label></FieldLegend>
        <Input id={closesId} type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} data-field="closes" />
        {span.of === WINDOW_OF.given ? null : <FieldError data-window-problem={span.problem}>{windowSays(t, span.problem)}</FieldError>}
      </FieldSet>
      <p className="text-muted-foreground" data-retry-run-note>{t('retryRun.walletNote')}</p>
      <PanelFooter>
        <div className="flex flex-col gap-4">
          <div>
            <Button type="submit" form={formId} disabled={busy || raised || companyId === null || leg.form === null || places.length === 0 || span.of !== WINDOW_OF.given} data-action="retry-run">
              {t('retryRun.raise')}
            </Button>
          </div>
          <Said phase={phase} result={result} />
        </div>
      </PanelFooter>
    </form>
  );
}

function windowSays(t: (key: string) => string, problem: WindowProblem): string {
  return problem === WINDOW_PROBLEM.missing ? t('retryRun.window.missing') : problem === WINDOW_PROBLEM.past ? t('retryRun.window.past') : t('retryRun.window.order');
}

function Said({ phase, result }: { phase: ActPhase; result: RaiseRunActed | null }) {
  const t = useText();
  const says: Record<RaiseRunWhy, string> = {
    [RAISE_RUN_WHY.seat]: t('retryRun.why.seat'), [RAISE_RUN_WHY.notARun]: t('retryRun.why.not-a-run'), [RAISE_RUN_WHY.paymentTime]: t('retryRun.why.window'),
    [RAISE_RUN_WHY.notAsShown]: t('retryRun.why.not-as-shown'), [RAISE_RUN_WHY.notRaised]: t('retryRun.why.not-raised'),
    [RAISE_RUN_WHY.mayBeSent]: t('retryRun.why.may-be-sent'), [RAISE_RUN_WHY.stopped]: t('signers.why.stopped'), [RAISE_RUN_WHY.other]: t('retryRun.why.other'),
  };
  const ended = result?.of === PROPOSAL_ACTED.done ? result : null;
  const stopped = result?.of === PROPOSAL_ACTED.stopped ? result : null;
  return (
    <ActOutcome phase={phase} refused={result?.of === PROPOSAL_ACTED.refused ? result.why : null}>
      {ended === null ? null : (
        <ActDone data-acted data-retry-state={ended.state ?? ''}>
          {ended.approvals !== null && ended.needed !== null ? t('retryRun.done.counted', { approvals: ended.approvals, needed: ended.needed }) : t('retryRun.done')}
        </ActDone>
      )}
      {stopped === null ? null : (
        <ActStopped calm={stopped.why === RAISE_RUN_WHY.mayBeSent || stopped.handedOver} data-retry-stopped={stopped.why}>
          <AlertDescription>{says[stopped.why]}</AlertDescription>
          {stopped.handedOver && stopped.why !== RAISE_RUN_WHY.mayBeSent ? <AlertDescription>{t('signers.sent')}</AlertDescription> : null}
        </ActStopped>
      )}
    </ActOutcome>
  );
}
