import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, Button, Progress, useText } from 'vaults-ui';
import { ACTED, type ActRefusal } from '../adapters/refusals.js';
import { keptCreationLabel } from '../adapters/creation-standing.js';
import { CARRY_ON_EVERY_MS, carryOn, FINISH, openYourWallet, STAGE, startAgain, type Carried, type Stage } from '../adapters/finish-company.js';
import { ActRefused } from '../act-refused.js';
import { useSession } from '../session.js';
import { STEP, type StepProps } from '../setup/step-ids.js';

/** The stages a company passes, in order: its account on the network, the account finished, its pay-record key sealed. */
const STAGES: readonly Stage[] = [STAGE.deploy, STAGE.finish, STAGE.key];

/**
 * FINISH CREATING THE COMPANY: one press of the person's wallet when this tab
 * keeps a company waiting for it, then the company is carried to finished with
 * no further press. While this step is shown it looks at where the company
 * stands every few seconds, takes the step that is owed, and says which stage
 * it waits on; it stops when the step is left and carries on when the person
 * comes back. A refusal stops it until the person tries again. It is finished
 * only when the person's own wallet confirms it, and then the wizard moves on.
 */
export function FinishCompany({ leadTo, onChanged, startNewCompany }: StepProps) {
  const t = useText();
  const { person, company, companiesChanged } = useSession();
  const [carried, setCarried] = useState<Carried | null>(null);
  const [run, setRun] = useState(0);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ActRefusal | null>(null);
  const latest = useRef({ companiesChanged, onChanged });
  latest.current = { companiesChanged, onChanged };
  const finished = useRef(false);

  useEffect(() => {
    if (finished.current) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async (): Promise<void> => {
      const r = await carryOn(person.id, company);
      if (!alive) return;
      setCarried(r);
      if (r.of === ACTED.done) {
        finished.current = true;
        await latest.current.companiesChanged(r.companyId);
        latest.current.onChanged();
      } else if (r.of === FINISH.waiting) {
        timer = setTimeout(() => { void look(); }, CARRY_ON_EVERY_MS);
      }
    };
    void look();
    return () => { alive = false; clearTimeout(timer); };
  }, [person.id, company, run]);

  const newCompany = (): void => { startNewCompany?.(); };
  const press = async (): Promise<void> => {
    setBusy(true);
    const r = await openYourWallet(person.id, company);
    setRefusal(r.of === ACTED.refused ? r.why : null);
    setBusy(false);
    if (r.of === ACTED.done) setRun((n) => n + 1);
  };
  const startOver = async (companyId: string): Promise<void> => {
    setBusy(true);
    const r = await startAgain(person.id, companyId);
    setRefusal(r.of === ACTED.refused ? r.why : null);
    setBusy(false);
    if (r.of === ACTED.done) newCompany();
  };
  const tryAgain = (): void => { setCarried(null); setRun((n) => n + 1); };

  const stage = carried?.of === FINISH.waiting ? carried.stage : STAGE.read;
  const filled = stage === STAGE.shown ? STAGES.length : STAGES.indexOf(stage);
  const stageSays: Record<Stage, string> = {
    [STAGE.deploy]: t('setup.finishCompany.stage.deploy'), [STAGE.finish]: t('setup.finishCompany.stage.finish'),
    [STAGE.key]: t('setup.finishCompany.stage.key'), [STAGE.shown]: t('setup.finishCompany.stage.shown'), [STAGE.read]: t('setup.finishCompany.stage.read'),
  };
  const stageWords = stageSays[stage];
  const wallet = (says: string) => (
    <Alert data-press={carried?.of === FINISH.press ? '' : undefined} data-locked={carried?.of === FINISH.locked ? '' : undefined}>
      <AlertDescription>{says}</AlertDescription>
      <div><Button disabled={busy} onClick={() => { void press(); }} data-action="open-wallet">{t('setup.finishCompany.sign')}</Button></div>
    </Alert>
  );

  const drawn = keptCreationLabel(company);

  return (
    <div className="flex max-w-md flex-col gap-4" data-action="finish-company">
      {drawn === null ? null : <p className="text-sm" data-drawn-label={drawn}>{t('setup.finishCompany.named', { label: drawn })}</p>}
      {carried === null || carried.of === FINISH.waiting ? (
        <div className="flex flex-col gap-2">
          <Progress
            steps={STAGES.map((id, i) => ({ id, done: i < filled }))} getValueLabel={() => stageWords} data-stage-progress
          />
          <p className="text-sm" data-stage={stage}>{stageWords}</p>
          <p className="text-xs text-muted-foreground" data-carries-on>{t('setup.finishCompany.carries')}</p>
        </div>
      ) : null}
      {carried?.of === FINISH.press ? wallet(t('setup.finishCompany.press')) : null}
      {carried?.of === FINISH.locked ? wallet(t('setup.finishCompany.locked')) : null}
      {carried?.of === FINISH.noDeploy ? (
        <Alert data-no-deploy>
          <AlertDescription>{t('setup.createCompany.noDeploy')}</AlertDescription>
          <div><Button disabled={busy} onClick={() => { void startOver(carried.companyId); }} data-action="start-again">{t('setup.createCompany.again')}</Button></div>
        </Alert>
      ) : null}
      {carried?.of === FINISH.cannot ? (
        <Alert data-cannot>
          <AlertDescription>{t('setup.finishCompany.cannot')}</AlertDescription>
          <div><Button onClick={newCompany} data-action="new-company">{t('switcher.create')}</Button></div>
        </Alert>
      ) : null}
      {carried?.of === FINISH.none ? (
        <Alert data-none>
          <AlertDescription>{t('setup.finishCompany.nothing')}</AlertDescription>
          <div>
            <Button variant="outline" onClick={() => leadTo(STEP.createCompany)} data-lead-to={STEP.createCompany}>
              {t('setup.blocked.go', { step: t('setup.step.createCompany.name') })}
            </Button>
          </div>
        </Alert>
      ) : null}
      {carried?.of === ACTED.refused ? (
        <div className="flex flex-col gap-2">
          <ActRefused why={carried.why} />
          <div><Button variant="outline" onClick={tryAgain} data-action="try-again">{t('setup.finishCompany.again')}</Button></div>
        </div>
      ) : null}
      {refusal === null ? null : <ActRefused why={refusal} />}
    </div>
  );
}
