import { useCallback, useEffect, useId, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert, AlertDescription, Badge, Button, ComingSoon, Progress, SectionLoading, Tabs, TabsContent, TabsList, TabsTrigger, useText } from 'vaults-ui';
import { readVaultRows } from '../adapters/vault-rows.js';
import { CompanyRecordsProvider } from '../records/company-records.js';
import { SessionProvider, useSession } from '../session.js';
import { STEP, type StepId } from '../setup/step-ids.js';
import { blockedBy, firstOpen, isDoneForGood, nextAfter, skippedFor, skipStep, STANDING, standingOf, useCreationFact, useInvitedFact } from '../setup/standing.js';
import { EVERY_STEP, isBuiltStep, takeAsked, type SetupFacts } from '../setup/steps.js';

/**
 * THE SETUP WIZARD: every step in the one list, one at a time. Across the top,
 * the kit's tabs, one to a step, each saying where its step stands; below
 * them, the step; across the bottom, a bar with one mark per step, and "Skip
 * for now" and "Continue". A step not built yet is shown Coming soon, with
 * what it will be; a step built except for one part shows that part Coming soon
 * beside its action.
 *
 * A STEP THAT CANNOT BE UNDONE, ONCE DONE, IS DONE FOR GOOD: its tab says
 * done and cannot be pressed, and the wizard moves on to the next step that
 * is not, so the step's action is never offered again. Every other step,
 * skipped or not, can always be returned to from its tab.
 *
 * A STEP THAT HOLDS THE LATER ONES BACK (finishing the company) KEEPS THEM
 * SHUT UNTIL IT IS DONE, and says so rather than hiding them: each later tab
 * stays pressable but is marked unavailable, and its panel gives the reason
 * and a button to the step that opens it, in place of the step. Skip and
 * Continue, when they cannot be used, say why beside them. A step that cannot
 * be skipped is never skipped.
 *
 * WHILE WHAT THE COMPANY HAS DONE IS STILL BEING READ, no step that cannot be
 * undone is offered: its tab cannot be pressed and no step's action is drawn,
 * so a step already done is never shown open, not even for a moment. The step
 * the wizard opens at is chosen again when that reading arrives, unless the
 * person, or whoever opened the wizard, had already chosen one.
 *
 * THE WIZARD BRINGS ITS OWN READ OF THE COMPANY'S RECORDS, because the focused
 * frame it is drawn in holds none, and two steps read them: the signers step
 * (its component) and the People step's done fact.
 */
export function Setup() {
  return <CompanyRecordsProvider><SetupSteps /></CompanyRecordsProvider>;
}

function SetupSteps() {
  const t = useText();
  const session = useSession();
  const { person } = session;
  const [asked] = useState(() => takeAsked());
  /*
   * A NEW COMPANY IS SET UP, NOT THE ONE SHOWN. When the wizard was opened to
   * create a company, the company shown then is none of its business: the
   * wizard, and every step in it, see no company until the new one is created
   * and shown.
   */
  const [shownWhenAsked, setShownWhenAsked] = useState(() => (asked?.newCompany === true ? session.company : undefined));
  const company = shownWhenAsked !== undefined && session.company === shownWhenAsked ? null : session.company;
  const [vaults, setVaults] = useState<SetupFacts['vaults']>(null);
  const [, setSkips] = useState(0);
  const skipped = skippedFor(company);
  const [started, setStarted] = useState<string | null>(null);
  const creationCompany = company ?? started;
  const { creation, reread } = useCreationFact(creationCompany);
  const { invited, reload: reloadRecords } = useInvitedFact(company);
  const facts: SetupFacts = { company, vaults, creation, invited };
  const [chosen, setCurrent] = useState<StepId>(() => asked?.step ?? firstOpen(facts, skipped));
  /* Whether the step shown was chosen, by the person or by whoever opened the wizard, rather than picked from what was known at the start. */
  const [moved, setMoved] = useState(asked !== null);
  const choose = (id: StepId): void => { setMoved(true); setCurrent(id); };
  const startNewCompany = (): void => { setStarted(null); setShownWhenAsked(session.company); choose(STEP.createCompany); };
  const skipWhyId = useId();
  const continueWhyId = useId();

  const read = useCallback(async () => {
    const v = company === null ? null : await readVaultRows(person.id, company);
    /* Vaults that could not be read are read as none created: the step stays open, and is never shown done on a guess. */
    setVaults(company === null ? null : v ?? []);
  }, [person.id, company]);
  useEffect(() => { void read(); }, [read]);

  /*
   * The step shown is the one chosen, unless it is done for good: then it is
   * the next step that is not. So the moment a company is created, or finished,
   * the wizard is on the step after it.
   */
  const chosenIndex = EVERY_STEP.findIndex((s) => s.id === chosen);
  const current = isDoneForGood(EVERY_STEP[chosenIndex]!, facts) ? nextAfter(chosenIndex, facts) ?? chosen : chosen;
  const index = EVERY_STEP.findIndex((s) => s.id === current);
  const step = EVERY_STEP[index]!;
  const standings = EVERY_STEP.map((s) => standingOf(s, facts, skipped));
  const forGood = EVERY_STEP.map((s) => isDoneForGood(s, facts));
  /* What the company has done is read after the wizard is drawn; until it is, whether a step is done for good is not known. */
  const reading = creation === null || (company !== null && vaults === null);
  /* Once what is known arrives, a wizard nobody has steered opens at the first step neither done nor skipped, as that now reads. */
  useEffect(() => { if (!reading && !moved) setCurrent(firstOpen(facts, skipped)); }, [reading]);
  const closed = EVERY_STEP.map((s, i) => forGood[i]! || (reading && s.cannotBeUndone));
  const doneCount = standings.filter((s) => s === STANDING.done).length;
  const blocker = reading ? null : blockedBy(index, facts);
  const blockedStep = blocker === null ? null : EVERY_STEP.find((s) => s.id === blocker)!;
  const waitsFor = blockedStep === null ? '' : blockedStep.name(t);
  const waits = t('setup.blocked', { step: waitsFor });
  const next = (): void => { const n = nextAfter(index, facts); if (n !== null) choose(n); };
  const skip = (): void => { skipStep(company, current); setSkips((n) => n + 1); next(); };
  /* Why Skip and Continue cannot be used, or null when they can; the first reason that holds. */
  const skipWhy = !step.skippable ? t('setup.skip.cannot')
    : blocker !== null ? waits
      : forGood[index] ? t('setup.skip.done')
        : closed[index] ? t('setup.skip.reading')
          : null;
  const continueWhy = blocker !== null ? waits
    : standings[index] !== STANDING.done ? t('setup.continue.notDone')
      : nextAfter(index, facts) === null ? t('setup.continue.last')
        : null;
  /*
   * A step done for good is shown only when no step after it is open (the
   * fallback above). Even then its action is not drawn, so it is never
   * offered twice; nor is any action while the company is still being read.
   */
  /* The same reason for both buttons (a blocked step) is said once, and both buttons are tied to it. */
  const oneWhy = skipWhy !== null && skipWhy === continueWhy;
  const continueDescribedBy = oneWhy ? skipWhyId : continueWhyId;

  const Action = isBuiltStep(step) && !closed[index] ? step.shows.action : null;
  const soon = isBuiltStep(step) ? null : (step.shows as { comingSoon: (x: typeof t) => string }).comingSoon(t);
  const alsoSoon = isBuiltStep(step) && step.alsoSoon !== undefined ? step.alsoSoon(t) : null;

  return (
    /* Marked as reading, as every page that reads is, so nothing waits on a step drawn before the company is read. */
    <div className="flex min-h-full flex-col gap-6" data-screen="setup" data-reading={reading ? '' : undefined}>
      <Tabs value={current} onValueChange={(v) => choose(v as StepId)}>
        <TabsList aria-label={t('page.setup.name')} data-setup-steps>
          {EVERY_STEP.map((s, i) => (
            <TabsTrigger
              key={s.id} value={s.id} disabled={closed[i]} aria-disabled={!reading && blockedBy(i, facts) !== null ? true : undefined} className="aria-disabled:opacity-50"
              data-step={s.id} data-standing={standings[i]} data-done-for-good={forGood[i] ? '' : undefined}
            >
              <HugeiconsIcon icon={s.icon} strokeWidth={2} className="size-4" />
              <span>{s.name(t)}</span>
              {standings[i] === STANDING.done ? <Badge variant="secondary" data-done>{t('setup.done')}</Badge> : null}
              {standings[i] === STANDING.skipped ? <Badge variant="outline" data-skipped>{t('setup.skipped')}</Badge> : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={current} className="flex flex-col gap-4" data-current-step={step.id}>
          <div className="flex flex-wrap items-center gap-2">
            <HugeiconsIcon icon={step.icon} strokeWidth={2} className="size-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold">{step.name(t)}</h1>
            {soon === null || blocker !== null ? null : <ComingSoon explanation={soon} />}
            {alsoSoon === null || blocker !== null || Action === null ? null : <ComingSoon explanation={alsoSoon} />}
          </div>
          <p className="max-w-prose text-sm text-muted-foreground">{step.line(t)}</p>
          {forGood[index]
            ? <p className="max-w-prose text-sm" data-step-done-for-good>{t('setup.doneForGood')}</p>
            : blockedStep !== null
              ? (
                <Alert className="max-w-prose" data-step-blocked={blockedStep.id}>
                  <AlertDescription>{waits}</AlertDescription>
                  <div><Button variant="outline" onClick={() => choose(blockedStep.id)} data-lead-to={blockedStep.id}>{t('setup.blocked.go', { step: waitsFor })}</Button></div>
                </Alert>
              )
            : soon !== null
              ? <p className="max-w-prose text-sm text-muted-foreground" data-coming-soon-step>{soon}</p>
              : Action === null
                ? <SectionLoading rows={2} data-step-reading="" />
                : (
                  <>
                    <SessionProvider session={{ ...session, company }}><Action leadTo={choose} onChanged={(startedCompany) => { if (startedCompany !== undefined) setStarted(startedCompany); reloadRecords(); void read(); void reread(startedCompany); }} creation={creationCompany} startNewCompany={startNewCompany} /></SessionProvider>
                    {alsoSoon === null ? null : <p className="max-w-prose text-sm text-muted-foreground" data-also-soon>{alsoSoon}</p>}
                  </>
                )}
        </TabsContent>
      </Tabs>
      <footer className="mt-auto flex flex-col gap-3 border-t pt-4" data-setup-bar>
        <Progress
          steps={EVERY_STEP.map((s, i) => ({ id: s.id, done: standings[i] === STANDING.done }))}
          getValueLabel={() => t('setup.progress', { done: doneCount, count: EVERY_STEP.length })}
          data-progress
        />
        <span className="text-sm text-muted-foreground" data-progress-words>{t('setup.progress', { done: doneCount, count: EVERY_STEP.length })}</span>
        {skipWhy === null && continueWhy === null ? null : (
          <div className="flex flex-col gap-1" data-why-bar>
            {skipWhy === null ? null : <span id={skipWhyId} className="text-xs text-muted-foreground" data-why-disabled={oneWhy ? 'skip continue' : 'skip'}>{skipWhy}</span>}
            {continueWhy === null || oneWhy ? null : <span id={continueWhyId} className="text-xs text-muted-foreground" data-why-disabled="continue">{continueWhy}</span>}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" disabled={skipWhy !== null} aria-describedby={skipWhy === null ? undefined : skipWhyId} onClick={skip} data-action="skip">{t('setup.skip')}</Button>
          <Button disabled={continueWhy !== null} aria-describedby={continueWhy === null ? undefined : continueDescribedBy} onClick={next} data-action="continue">{t('setup.continue')}</Button>
        </div>
      </footer>
    </div>
  );
}
