import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, Button, Progress, useText } from 'vaults-ui';
import { ACT_REFUSAL, ACTED, type ActRefusal } from '../adapters/refusals.js';
import { keptCreationLabel, SERVICE_READ_BOUND_SECONDS } from '../adapters/creation-standing.js';
import { CARRY_ON_EVERY_MS, carryOn, FINISH, openYourWallet, STAGE, type Carried, type Stage } from '../adapters/finish-company.js';
import { ActRefused } from '../act-refused.js';
import { proofsRunning } from '../adapters/proofs-running.js';
import { lane } from '../adapters/sends.js';
import { COMPANY_PHASE, COMPANY_USUAL_SECONDS, stageTimeNoter, type CompanyPhase } from '../adapters/usual-times.js';
import { secondsSince, StageProgress, useStageSince, useTicker } from '../stage-progress.js';
import { StartAgain, StartAgainWords } from './start-again.js';
import { useSession } from '../session.js';
import { STEP, type StepProps } from '../setup/step-ids.js';

/** How soon a company is looked at again when what came back was another company's. */
const LOOK_AGAIN_MS = 1_000;

/** The stages a company passes, in order: its account on the network, the account finished, its pay-record key sealed. */
const STAGES: readonly Stage[] = [STAGE.deploy, STAGE.finish, STAGE.key];

/**
 * FINISH CREATING THE COMPANY: one press, and the person's wallet runs the
 * whole of it in one window, showing each step there; this step shows which
 * step the wallet is on. Nothing is sent without the press. An action that
 * stopped before its end, here or before a reload, shows as "interrupted at
 * step N of M" with a press that runs the same action again, in one window,
 * and the wallet carries on from what the chain shows. It is finished only
 * when the person's own wallet confirms it, and then the wizard moves on.
 */
export function FinishCompany({ leadTo, onChanged, startNewCompany, creation }: StepProps) {
  const t = useText();
  const { person, company: openCompany, companiesChanged, signOut } = useSession();
  const company = openCompany ?? creation ?? null;
  /* What was read is kept with the company it was read for: another company's reading is never this one's. */
  const [got, setGot] = useState<{ for: string | null; carried: Carried } | null>(null);
  const carried: Carried | null = got !== null && got.for === company ? got.carried : null;
  const setCarried = (next: Carried | null): void => { setGot(next === null ? null : { for: company, carried: next }); };
  const [run, setRun] = useState(0);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ for: string | null; why: ActRefusal } | null>(null);
  const refusal: ActRefusal | null = refused !== null && refused.for === company ? refused.why : null;
  /* The step the wallet says its action is on, while the press runs. */
  const [running, setRunning] = useState<{ step: number; steps: number } | null>(null);
  const latest = useRef({ companiesChanged, onChanged });
  latest.current = { companiesChanged, onChanged };
  const finished = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (finished.current === company) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async (): Promise<void> => {
      const r = await carryOn(person.id, company);
      if (!alive) return;
      /* A reading of another company is not this one's: it is dropped and this company is looked at again. */
      if (r.of !== FINISH.none && typeof r.companyId === 'string' && r.companyId !== company) {
        timer = setTimeout(() => { void look(); }, LOOK_AGAIN_MS);
        return;
      }
      setCarried(r);
      if (r.of === ACTED.done) {
        finished.current = company;
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
    const r = await openYourWallet(person.id, company, (step, steps) => { setRunning({ step, steps }); });
    setRefused(r.of === ACTED.refused ? { for: company, why: r.why } : null);
    setBusy(false);
    setRunning(null);
    if (r.of === FINISH.interrupted && company !== null) setCarried({ of: FINISH.interrupted, companyId: company, step: r.step, steps: r.steps });
    if (r.of === ACTED.done) setRun((n) => n + 1);
  };
  const tryAgain = (): void => { setCarried(null); setRun((n) => n + 1); };

  const stage = carried?.of === FINISH.waiting ? carried.stage : STAGE.read;
  const filled = stage === STAGE.shown ? STAGES.length : STAGES.indexOf(stage);
  const stageSays: Record<Stage, string> = {
    [STAGE.deploy]: t('setup.finishCompany.stage.deploy'), [STAGE.finish]: t('setup.finishCompany.stage.finish'),
    [STAGE.key]: t('setup.finishCompany.stage.key'), [STAGE.shown]: t('setup.finishCompany.stage.shown'), [STAGE.read]: t('setup.finishCompany.stage.read'),
  };
  const stageWords = stageSays[stage];
  const { now, proofStartedAt } = useTicker(proofsRunning);
  const phase: CompanyPhase = proofStartedAt !== null ? COMPANY_PHASE.proving : lane.sending === true ? COMPANY_PHASE.sending : COMPANY_PHASE.waiting;
  const phaseSince = useStageSince(stage, phase);
  const noteStageTime = useRef(stageTimeNoter());
  const timedStage = stage === STAGE.read ? null : [stage, phase];
  useEffect(() => {
    noteStageTime.current(timedStage, proofStartedAt ?? phaseSince, COMPANY_USUAL_SECONDS[phase]);
  }, [stage, phase]);
  useEffect(() => () => { noteStageTime.current(null, 0, null); }, []);
  const phaseSays: Record<CompanyPhase, string> = {
    [COMPANY_PHASE.proving]: t('setup.finishCompany.phase.proving'),
    [COMPANY_PHASE.sending]: t('setup.finishCompany.phase.sending'),
    [COMPANY_PHASE.waiting]: t('setup.finishCompany.phase.waiting'),
  };
  const wallet = (says: string) => (
    <Alert data-press={carried?.of === FINISH.press ? '' : undefined} data-locked={carried?.of === FINISH.locked ? '' : undefined}>
      <AlertDescription>{says}</AlertDescription>
      <div><Button disabled={busy} onClick={() => { void press(); }} data-action="open-wallet">{t('setup.finishCompany.sign')}</Button></div>
      {carried?.of === FINISH.press || carried?.of === FINISH.locked ? <StartAgain companyId={company} /> : null}
    </Alert>
  );

  const drawn = keptCreationLabel(company);
  const signInAgain = (
    <div><Button onClick={signOut} data-action="sign-in-again">{t('setup.finishCompany.signInAgain')}</Button></div>
  );

  return (
    <div className="flex max-w-md flex-col gap-4" data-action="finish-company">
      {drawn === null ? null : <p className="text-sm" data-drawn-label={drawn}>{t('setup.finishCompany.named', { label: drawn })}</p>}
      {running !== null ? <p className="text-sm" data-wallet-step={running.step}>{t('setup.finishCompany.running', { step: running.step, steps: running.steps })}</p> : null}
      {carried === null || carried.of === FINISH.waiting ? (
        <div className="flex flex-col gap-2">
          <Progress
            steps={STAGES.map((id, i) => ({ id, done: i < filled }))} getValueLabel={() => stageWords} data-stage-progress
          />
          <p className="text-sm" data-stage={stage}>{stageWords}</p>
          {stage === STAGE.read ? null : (
            <StageProgress
              stage={phase} words={phaseSays[phase]} elapsedSeconds={secondsSince(now, proofStartedAt ?? phaseSince)}
              usualSeconds={COMPANY_USUAL_SECONDS[phase]}
            />
          )}
          <p className="text-xs text-muted-foreground" data-carries-on>{t('setup.finishCompany.carries')}</p>
          {carried === null ? null : <StartAgain companyId={company} />}
        </div>
      ) : null}
      {carried?.of === FINISH.press ? wallet(t('setup.finishCompany.press')) : null}
      {carried?.of === FINISH.locked ? wallet(t('setup.finishCompany.locked')) : null}
      {carried !== null && carried.of === FINISH.interrupted ? (
        <Alert data-interrupted={carried.step}>
          <AlertDescription>{t('setup.finishCompany.interrupted', { step: carried.step, steps: carried.steps })}</AlertDescription>
          <div><Button disabled={busy} onClick={() => { void press(); }} data-action="continue">{t('setup.finishCompany.continue')}</Button></div>
        </Alert>
      ) : null}
      {carried?.of === FINISH.cannot ? (
        <Alert data-cannot>
          <AlertDescription>{t('setup.finishCompany.cannot')}</AlertDescription>
          <div><Button onClick={newCompany} data-action="new-company">{t('switcher.create')}</Button></div>
          <StartAgain companyId={company} />
        </Alert>
      ) : null}
      {carried?.of === FINISH.signedOut ? (
        <Alert data-signed-out>
          <AlertDescription>{t('setup.finishCompany.signedOut')}</AlertDescription>
          {signInAgain}
        </Alert>
      ) : null}
      {carried?.of === FINISH.unread ? (
        <Alert data-unread>
          <AlertDescription>{t('setup.finishCompany.unread', { seconds: SERVICE_READ_BOUND_SECONDS })}</AlertDescription>
          <div><Button variant="outline" onClick={tryAgain} data-action="try-again">{t('setup.finishCompany.again')}</Button></div>
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
          {carried.why === ACT_REFUSAL.notSignedIn ? signInAgain : null}
          <div><Button variant="outline" onClick={tryAgain} data-action="try-again">{t('setup.finishCompany.again')}</Button></div>
          <StartAgain companyId={company} />
        </div>
      ) : null}
      {refusal === null ? null : <ActRefused why={refusal} />}
      {refusal === ACT_REFUSAL.notSignedIn ? signInAgain : null}
      <StartAgainWords shown={company} onStartNew={startNewCompany === undefined ? undefined : newCompany} />
    </div>
  );
}
