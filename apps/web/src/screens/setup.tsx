import { useCallback, useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Badge, Button, ComingSoon, Progress, SectionLoading, Tabs, TabsContent, TabsList, TabsTrigger, useText } from 'vaults-ui';
import { readHandover, type Handover } from '../adapters/handover-state.js';
import { readVaultRows } from '../adapters/vault-rows.js';
import { SessionProvider, useSession } from '../session.js';
import type { StepId } from '../setup/step-ids.js';
import { firstOpen, isDoneForGood, nextAfter, skippedFor, skipStep, STANDING, standingOf } from '../setup/standing.js';
import { EVERY_STEP, isBuiltStep, takeAsked, type SetupFacts } from '../setup/steps.js';

/**
 * THE SETUP WIZARD: every step in the one list, one at a time. Across the top,
 * the kit's tabs, one to a step, each saying where its step stands; below
 * them, the step; across the bottom, a bar with one mark per step, and "Skip
 * for now" and "Continue". A step not built yet is shown Coming soon, with
 * what it will be.
 *
 * A STEP THAT CANNOT BE UNDONE, ONCE DONE, IS DONE FOR GOOD: its tab says
 * done and cannot be pressed, and the wizard moves on to the next step that
 * is not, so the step's action is never offered again. Every other step,
 * skipped or not, can always be returned to from its tab.
 *
 * WHILE WHAT THE COMPANY HAS DONE IS STILL BEING READ, no step that cannot be
 * undone is offered: its tab cannot be pressed and no step's action is drawn,
 * so a step already done is never shown open, not even for a moment.
 */
export function Setup() {
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
  const [shownWhenAsked] = useState(() => (asked?.newCompany === true ? session.company : undefined));
  const company = shownWhenAsked !== undefined && session.company === shownWhenAsked ? null : session.company;
  const [handover, setHandover] = useState<Handover | null>(null);
  const [vaults, setVaults] = useState<SetupFacts['vaults']>(null);
  const [, setSkips] = useState(0);
  const skipped = skippedFor(company);
  const facts: SetupFacts = { company, handover, vaults };
  const [chosen, setCurrent] = useState<StepId>(() => asked?.step ?? firstOpen(facts, skipped));

  const read = useCallback(async () => {
    const [h, v] = company === null ? [null, null] : await Promise.all([readHandover(person.id, company), readVaultRows(person.id, company)]);
    setHandover(h);
    /* Vaults that could not be read are read as none created: the step stays open, and is never shown done on a guess. */
    setVaults(company === null ? null : v ?? []);
  }, [person.id, company]);
  useEffect(() => { void read(); }, [read]);

  /*
   * The step shown is the one chosen, unless it is done for good: then it is
   * the next step that is not. So the moment a company is created, or handed
   * over, the wizard is on the step after it.
   */
  const chosenIndex = EVERY_STEP.findIndex((s) => s.id === chosen);
  const current = isDoneForGood(EVERY_STEP[chosenIndex]!, facts) ? nextAfter(chosenIndex, facts) ?? chosen : chosen;
  const index = EVERY_STEP.findIndex((s) => s.id === current);
  const step = EVERY_STEP[index]!;
  const standings = EVERY_STEP.map((s) => standingOf(s, facts, skipped));
  const forGood = EVERY_STEP.map((s) => isDoneForGood(s, facts));
  /* The company's handover and vaults are read after the wizard is drawn; until they are, whether a step is done for good is not known. */
  const reading = company !== null && (handover === null || vaults === null);
  const closed = EVERY_STEP.map((s, i) => forGood[i]! || (reading && s.cannotBeUndone));
  const doneCount = standings.filter((s) => s === STANDING.done).length;
  const next = (): void => { const n = nextAfter(index, facts); if (n !== null) setCurrent(n); };
  const skip = (): void => { skipStep(company, current); setSkips((n) => n + 1); next(); };
  /*
   * A step done for good is shown only when no step after it is open (the
   * fallback above). Even then its action is not drawn, so it is never
   * offered twice; nor is any action while the company is still being read.
   */
  const Action = isBuiltStep(step) && !closed[index] ? step.shows.action : null;
  const soon = isBuiltStep(step) ? null : (step.shows as { comingSoon: (x: typeof t) => string }).comingSoon(t);

  return (
    /* Marked as reading, as every page that reads is, so nothing waits on a step drawn before the company is read. */
    <div className="flex min-h-full flex-col gap-6" data-screen="setup" data-reading={reading ? '' : undefined}>
      <Tabs value={current} onValueChange={(v) => setCurrent(v as StepId)}>
        <TabsList aria-label={t('page.setup.name')} data-setup-steps>
          {EVERY_STEP.map((s, i) => (
            <TabsTrigger key={s.id} value={s.id} disabled={closed[i]} data-step={s.id} data-standing={standings[i]} data-done-for-good={forGood[i] ? '' : undefined}>
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
            {soon === null ? null : <ComingSoon explanation={soon} />}
          </div>
          <p className="max-w-prose text-sm text-muted-foreground">{step.line(t)}</p>
          {forGood[index]
            ? <p className="max-w-prose text-sm" data-step-done-for-good>{t('setup.doneForGood')}</p>
            : soon !== null
              ? <p className="max-w-prose text-sm text-muted-foreground" data-coming-soon-step>{soon}</p>
              : Action === null
                ? <SectionLoading rows={2} data-step-reading="" />
                : <SessionProvider session={{ ...session, company }}><Action leadTo={setCurrent} onChanged={() => { void read(); }} /></SessionProvider>}
        </TabsContent>
      </Tabs>
      <footer className="mt-auto flex flex-col gap-3 border-t pt-4" data-setup-bar>
        <Progress
          steps={EVERY_STEP.map((s, i) => ({ id: s.id, done: standings[i] === STANDING.done }))}
          getValueLabel={() => t('setup.progress', { done: doneCount, count: EVERY_STEP.length })}
          data-progress
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground" data-progress-words>{t('setup.progress', { done: doneCount, count: EVERY_STEP.length })}</span>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={!step.skippable || closed[index]} onClick={skip} data-action="skip">{t('setup.skip')}</Button>
            <Button disabled={standings[index] !== STANDING.done || nextAfter(index, facts) === null} onClick={next} data-action="continue">{t('setup.continue')}</Button>
          </div>
        </div>
      </footer>
    </div>
  );
}
