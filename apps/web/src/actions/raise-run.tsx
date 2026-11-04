import { useId, useState } from 'react';
import { AlertDescription, Button, Field, FieldError, FieldLabel, FieldLegend, FieldSet, Input, RadioGroup, RadioGroupItem, useText } from 'vaults-ui';
import { PROPOSAL_ACTED, RAISE_RUN_WHY, paymentWindow, raiseRun, RUN_FORM, RUN_LIST, runCurrencies, WINDOW_OF, WINDOW_PROBLEM, type RaiseRunActed, type RaiseRunWhy, type RunForm, type RunList, type WindowProblem } from '../adapters/proposal-acts.js';
import { OPENED, READ } from '../adapters/reads.js';
import { useCompanyRecords } from '../records/company-records.js';
import { ActDone, ActOutcome, ActStopped, type ActPhase } from '../records/proposal-act.js';
import { PanelFooter } from '../shell/right-panel.js';
import { useSession } from '../session.js';

const thisMonth = (): string => new Date().toISOString().slice(0, 7);


/**
 * The panel the payroll page's New run opens. It names a month, whom the run pays, the vault, the currency and form, and the window payments
 * open and close in, which the person gives with no default; it names no people and no total. The wallet draws the run, shows its people and total, and asks the person to confirm there. What the panel
 * shows afterwards is what the wallet answered, kept while the company's records are read again.
 */
export function RaiseRun() {
  const t = useText();
  const id = useId();
  const formId = useId();
  const { person, company: companyId } = useSession();
  const { company, reload } = useCompanyRecords();
  const [month, setMonth] = useState(thisMonth);
  const [list, setList] = useState<RunList>(RUN_LIST.employees);
  const [vaultChosen, setVaultChosen] = useState<string | null>(null);
  const [tokenChosen, setTokenChosen] = useState<string | null>(null);
  const [form, setForm] = useState<RunForm>(RUN_FORM.shielded);
  const [opens, setOpens] = useState('');
  const [closes, setCloses] = useState('');
  const [phase, setPhase] = useState<ActPhase>(null);
  const [result, setResult] = useState<RaiseRunActed | null>(null);
  const open = company?.of === OPENED.open ? company : null;
  const vaultsRead = open?.vaults;
  const vaults = vaultsRead?.of === READ.read ? vaultsRead.value : [];
  const currencies = runCurrencies();
  const vault = vaultChosen ?? vaults[0]?.vault ?? '';
  const token = tokenChosen ?? currencies[0]?.code ?? '';
  const busy = phase !== null;
  const span = paymentWindow(opens, closes, Date.now());
  const raised = result?.of === PROPOSAL_ACTED.done;

  const raise = async (): Promise<void> => {
    const given = paymentWindow(opens, closes, Date.now());
    if (companyId === null || busy || raised || vault === '' || token === '' || given.of !== WINDOW_OF.given) return;
    setResult(null);
    setPhase({ step: 0, steps: 0 });
    const ended = await raiseRun(person.id, companyId, { period: month, list, vault, token, form, opensAt: given.opensAt, closesAt: given.closesAt }, (step, steps) => setPhase({ step, steps }));
    setPhase(null);
    setResult(ended);
    if (ended.of === PROPOSAL_ACTED.done || (ended.of === PROPOSAL_ACTED.stopped && ended.handedOver)) reload();
  };

  return (
    <form id={formId} className="flex max-w-xl flex-col gap-4 text-sm" data-action="raise-run-panel" onSubmit={(e) => { e.preventDefault(); void raise(); }}>
      <FieldSet disabled={busy || raised}>
        <FieldLegend variant="label">{t('raiseRun.month')}</FieldLegend>
        <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} data-field="month" />
      </FieldSet>
      <FieldSet disabled={busy || raised}>
        <FieldLegend variant="label">{t('raiseRun.list')}</FieldLegend>
        <RadioGroup value={list} onValueChange={(v) => setList(v as RunList)} data-field="list">
          {[[RUN_LIST.employees, t('raiseRun.list.employees')], [RUN_LIST.vendors, t('raiseRun.list.vendors')]].map(([k, words]) => (
            <Field key={k} orientation="horizontal">
              <RadioGroupItem value={k!} id={id + k!} data-list={k} />
              <FieldLabel htmlFor={id + k!}>{words}</FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      <FieldSet disabled={busy || raised}>
        <FieldLegend variant="label">{t('raiseRun.vault')}</FieldLegend>
        {vaults.length === 0 ? <p className="text-muted-foreground" data-raise-run-no-vault>{t('raiseRun.noVault')}</p> : (
          <RadioGroup value={vault} onValueChange={setVaultChosen} data-field="vault">
            {vaults.map((v, i) => (
              <Field key={v.vault} orientation="horizontal">
                <RadioGroupItem value={v.vault} id={id + v.vault} data-vault={v.vault} />
                <FieldLabel htmlFor={id + v.vault}>{t('vaults.tile.name', { number: i + 1 })}</FieldLabel>
              </Field>
            ))}
          </RadioGroup>
        )}
      </FieldSet>
      <FieldSet disabled={busy || raised}>
        <FieldLegend variant="label">{t('raiseRun.currency')}</FieldLegend>
        <RadioGroup value={token} onValueChange={setTokenChosen} data-field="currency">
          {currencies.map((c) => (
            <Field key={c.code} orientation="horizontal">
              <RadioGroupItem value={c.code} id={id + c.code} data-token={c.code} />
              <FieldLabel htmlFor={id + c.code}>{c.name}</FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      <FieldSet disabled={busy || raised}>
        <FieldLegend variant="label">{t('raiseRun.form')}</FieldLegend>
        <RadioGroup value={form} onValueChange={(v) => setForm(v as RunForm)} data-field="form">
          {[[RUN_FORM.shielded, t('raiseRun.form.private')], [RUN_FORM.unshielded, t('raiseRun.form.public')]].map(([k, words]) => (
            <Field key={k} orientation="horizontal">
              <RadioGroupItem value={k!} id={id + k!} data-form={k} />
              <FieldLabel htmlFor={id + k!}>{words}</FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      <FieldSet disabled={busy || raised}>
        <FieldLegend variant="label">{t('raiseRun.opens')}</FieldLegend>
        <Input type="datetime-local" value={opens} onChange={(e) => setOpens(e.target.value)} data-field="opens" />
        <FieldLegend variant="label">{t('raiseRun.closes')}</FieldLegend>
        <Input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} data-field="closes" />
        {span.of === WINDOW_OF.given ? null : <FieldError data-window-problem={span.problem}>{windowSays(t, span.problem)}</FieldError>}
      </FieldSet>
      <p className="text-muted-foreground" data-raise-run-note>{t('raiseRun.walletNote')}</p>
      <PanelFooter>
        <div className="flex flex-col gap-4">
          <div>
            <Button type="submit" form={formId} disabled={busy || raised || companyId === null || vault === '' || token === '' || !/^[0-9]{4}-[0-9]{2}$/u.test(month) || span.of !== WINDOW_OF.given} data-action="raise-run">
              {t('raiseRun.raise')}
            </Button>
          </div>
          <Said phase={phase} result={result} />
        </div>
      </PanelFooter>
    </form>
  );
}

function windowSays(t: (key: string) => string, problem: WindowProblem): string {
  return problem === WINDOW_PROBLEM.missing ? t('raiseRun.window.missing') : problem === WINDOW_PROBLEM.past ? t('raiseRun.window.past') : t('raiseRun.window.order');
}

function Said({ phase, result }: { phase: ActPhase; result: RaiseRunActed | null }) {
  const t = useText();
  const says: Record<RaiseRunWhy, string> = {
    [RAISE_RUN_WHY.seat]: t('raiseRun.why.seat'), [RAISE_RUN_WHY.notARun]: t('raiseRun.why.not-a-run'), [RAISE_RUN_WHY.paymentTime]: t('raiseRun.why.window'),
    [RAISE_RUN_WHY.notAsShown]: t('raiseRun.why.not-as-shown'), [RAISE_RUN_WHY.notRaised]: t('raiseRun.why.not-raised'),
    [RAISE_RUN_WHY.mayBeSent]: t('raiseRun.why.may-be-sent'), [RAISE_RUN_WHY.stopped]: t('signers.why.stopped'), [RAISE_RUN_WHY.other]: t('raiseRun.why.other'),
  };
  const ended = result?.of === PROPOSAL_ACTED.done ? result : null;
  const stopped = result?.of === PROPOSAL_ACTED.stopped ? result : null;
  return (
    <ActOutcome phase={phase} refused={result?.of === PROPOSAL_ACTED.refused ? result.why : null}>
      {ended === null ? null : (
        <ActDone data-acted data-raise-state={ended.state ?? ''}>
          {ended.approvals !== null && ended.needed !== null ? t('raiseRun.done.counted', { approvals: ended.approvals, needed: ended.needed }) : t('raiseRun.done')}
        </ActDone>
      )}
      {stopped === null ? null : (
        <ActStopped calm={stopped.why === RAISE_RUN_WHY.mayBeSent || stopped.handedOver} data-raise-stopped={stopped.why}>
          <AlertDescription>{says[stopped.why]}</AlertDescription>
          {stopped.handedOver && stopped.why !== RAISE_RUN_WHY.mayBeSent ? <AlertDescription>{t('signers.sent')}</AlertDescription> : null}
        </ActStopped>
      )}
    </ActOutcome>
  );
}
