import { useCallback, useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Tick02Icon } from '@hugeicons/core-free-icons';
import { Badge, Button, ComingSoon, useText } from 'vaults-ui';
import { readHandover, type Handover } from '../adapters/handover-state.js';
import { SessionProvider, useSession } from '../session.js';
import type { StepId } from '../setup/step-ids.js';
import { firstOpen, skippedFor, STANDING, standingOf } from '../setup/standing.js';
import { EVERY_STEP, isBuiltStep, takeAsked, type SetupFacts } from '../setup/steps.js';

/**
 * THE SETUP WIZARD: every step in the one list, one at a time. The step fills
 * the page; beside it, every step with where it stands, so any can be
 * returned to; across the bottom, a bar with one mark per step, and "Skip for
 * now" and "Continue". A step not built yet is shown Coming soon, with what it
 * will be.
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
  const [, setSkips] = useState(0);
  const skipped = skippedFor(company);
  const facts: SetupFacts = { company, handover };
  const [current, setCurrent] = useState<StepId>(() => asked?.step ?? firstOpen(facts, skipped));

  const read = useCallback(async () => {
    setHandover(company === null ? null : await readHandover(person.id, company));
  }, [person.id, company]);
  useEffect(() => { void read(); }, [read]);

  const index = EVERY_STEP.findIndex((s) => s.id === current);
  const step = EVERY_STEP[index]!;
  const standings = EVERY_STEP.map((s) => standingOf(s, facts, skipped));
  const doneCount = standings.filter((s) => s === STANDING.done).length;
  const next = (): void => { const n = EVERY_STEP[index + 1]; if (n !== undefined) setCurrent(n.id); };
  const skip = (): void => { skipped.add(current); setSkips((n) => n + 1); next(); };
  const Action = isBuiltStep(step) ? step.shows.action : null;

  return (
    <div className="flex min-h-full flex-col gap-6" data-screen="setup">
      <div className="flex flex-col gap-6 md:flex-row">
        <ol className="flex flex-col gap-1 md:w-64" data-setup-steps>
          {EVERY_STEP.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                className={s.id === current ? 'flex w-full items-center gap-2 rounded-md bg-muted px-2 py-1.5 text-start text-sm' : 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted'}
                aria-current={s.id === current ? 'step' : undefined}
                onClick={() => setCurrent(s.id)}
                data-step={s.id}
                data-standing={standings[i]}
              >
                <HugeiconsIcon icon={s.icon} strokeWidth={2} className="size-4 text-muted-foreground" />
                <span className="flex-1">{s.name(t)}</span>
                {standings[i] === STANDING.done ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" /> : null}
                {standings[i] === STANDING.skipped ? <Badge variant="outline" data-skipped>{t('setup.skipped')}</Badge> : null}
              </button>
            </li>
          ))}
        </ol>
        <section className="flex flex-1 flex-col gap-4" data-current-step={step.id}>
          <div className="flex flex-wrap items-center gap-2">
            <HugeiconsIcon icon={step.icon} strokeWidth={2} className="size-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold">{step.name(t)}</h1>
            {isBuiltStep(step) ? null : <ComingSoon explanation={(step.shows as { comingSoon: (x: typeof t) => string }).comingSoon(t)} />}
          </div>
          <p className="max-w-prose text-sm text-muted-foreground">{step.line(t)}</p>
          {Action === null
            ? <p className="max-w-prose text-sm text-muted-foreground" data-coming-soon-step>{(step.shows as { comingSoon: (x: typeof t) => string }).comingSoon(t)}</p>
            : <SessionProvider session={{ ...session, company }}><Action leadTo={setCurrent} onChanged={() => { void read(); }} /></SessionProvider>}
        </section>
      </div>
      <footer className="mt-auto flex flex-col gap-3 border-t pt-4" data-setup-bar>
        <div
          className="flex gap-1"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={EVERY_STEP.length}
          aria-valuenow={doneCount}
          aria-valuetext={t('setup.progress', { done: doneCount, count: EVERY_STEP.length })}
          data-progress
        >
          {EVERY_STEP.map((s, i) => (
            <span
              key={s.id}
              className={standings[i] === STANDING.done ? 'h-1.5 flex-1 rounded-full bg-primary' : 'h-1.5 flex-1 rounded-full bg-muted'}
              data-mark={s.id}
              data-standing={standings[i]}
            />
          ))}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground" data-progress-words>{t('setup.progress', { done: doneCount, count: EVERY_STEP.length })}</span>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={!step.skippable} onClick={skip} data-action="skip">{t('setup.skip')}</Button>
            <Button disabled={standings[index] !== STANDING.done || index === EVERY_STEP.length - 1} onClick={next} data-action="continue">{t('setup.continue')}</Button>
          </div>
        </div>
      </footer>
    </div>
  );
}

