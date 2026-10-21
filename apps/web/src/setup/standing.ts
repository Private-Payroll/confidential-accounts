import { useCallback, useEffect, useState } from 'react';
import { EVERY_STEP, type SetupFacts } from './steps.js';
import type { StepId } from './step-ids.js';
import { creationChanged, creationHere, creationOf, type CompanyCreation } from '../adapters/creation-standing.js';
import { keepSkips, readSkips, tabStorage } from '../adapters/kept-skips.js';

export { readSkips };

/** Where each step stands for the wizard: done, skipped for now, or neither. */
export const STANDING = { done: 'done', skipped: 'skipped', open: 'open' } as const;
export type Standing = (typeof STANDING)[keyof typeof STANDING];

/**
 * The steps skipped in this tab, for each company (and for the person before
 * they have one). Skipping is "for now": it is kept in the tab's own storage,
 * so a reload keeps it and closing the tab forgets it. Read from that storage
 * the first time it is asked for.
 */
let skippedIn: Map<string | null, Set<StepId>> | null = null;
const skips = (): Map<string | null, Set<StepId>> => (skippedIn ??= readSkips(tabStorage()));

/** The steps skipped for `company`, as kept. Read it; skip a step with `skipStep`. */
export const skippedFor = (company: string | null): Set<StepId> => {
  const all = skips();
  let s = all.get(company);
  if (s === undefined) { s = new Set(); all.set(company, s); }
  return s;
};

/**
 * Skip `step` for `company`, and keep it so a reload of this tab still shows it skipped.
 * A step that cannot be skipped is refused: nothing is kept and false comes back.
 */
export function skipStep(company: string | null, step: StepId): boolean {
  if (EVERY_STEP.find((s) => s.id === step)?.skippable !== true) return false;
  skippedFor(company).add(step);
  keepSkips(tabStorage(), skips());
  return true;
}

/**
 * Where `step` stands: done when the application knows it is, skipped when the person skipped it and it is not done, open otherwise.
 * Skipping a step never makes it done, and a step that cannot be skipped is never skipped, whatever the tab kept.
 */
export function standingOf(step: (typeof EVERY_STEP)[number], facts: SetupFacts, skipped: ReadonlySet<StepId>): Standing {
  if (step.done(facts)) return STANDING.done;
  return step.skippable && skipped.has(step.id) ? STANDING.skipped : STANDING.open;
}

/** The step that holds back the step at `index`: the first step before it that holds later steps back and is not done; null when none does. */
export function blockedBy(index: number, facts: SetupFacts): StepId | null {
  return EVERY_STEP.slice(0, index).find((s) => s.blocksLater === true && !s.done(facts))?.id ?? null;
}

/** Whether `step` is done for good: done, and a step that cannot be undone. The wizard shows it as done and never opens it again. */
export function isDoneForGood(step: (typeof EVERY_STEP)[number], facts: SetupFacts): boolean {
  return step.cannotBeUndone && step.done(facts);
}

/** The first step after the one at `index`, in the list's order, that is not done for good; null when there is none. */
export function nextAfter(index: number, facts: SetupFacts): StepId | null {
  return EVERY_STEP.slice(index + 1).find((s) => !isDoneForGood(s, facts))?.id ?? null;
}

/** The first step that is neither done nor skipped, or the last step when every one is. A step asked for by name is taken before this, by the wizard. */
export function firstOpen(facts: SetupFacts, skipped: ReadonlySet<StepId>): StepId {
  return EVERY_STEP.find((s) => standingOf(s, facts, skipped) === STANDING.open)?.id ?? EVERY_STEP[EVERY_STEP.length - 1]!.id;
}

/** The steps not done yet, in the list's order: what the setup card on Home lists. A skipped step is not done, so it is among them. */
export function stepsLeft(facts: SetupFacts): (typeof EVERY_STEP)[number][] {
  return EVERY_STEP.filter((s) => !s.done(facts));
}

/**
 * Where the shown company stands in being created, for every screen that builds the setup facts: null until it is read,
 * and never another company's reading. `reread` puts the old reading away and reads again, for a step that changed the creation;
 * what this tab keeps shows at once, and what the network said before stays until the new reading comes.
 */
export function useCreationFact(company: string | null): { creation: CompanyCreation | null; reread: (startedCompany?: string) => Promise<void> } {
  const [read, setRead] = useState<{ of: string | null; creation: CompanyCreation } | null>(null);
  const load = useCallback(async (fresh: boolean, startedCompany?: string): Promise<void> => {
    const id = startedCompany ?? company;
    if (fresh) {
      creationChanged(id);
      /* What this tab keeps is known now: a creation just started shows as started before the network is asked, and what was read before is kept until the new reading comes. */
      const here = creationHere(id);
      setRead((was) => ({ of: id, creation: was !== null && was.of === id ? { ...was.creation, company: here.company, kept: here.kept, awaitingSecondPress: here.awaitingSecondPress } : here }));
    }
    const creation = await creationOf(id);
    setRead({ of: id, creation });
  }, [company]);
  useEffect(() => {
    let alive = true;
    void creationOf(company).then((creation) => { if (alive) setRead({ of: company, creation }); });
    return () => { alive = false; };
  }, [company]);
  const reread = useCallback((startedCompany?: string) => load(true, startedCompany), [load]);
  return { creation: read !== null && read.of === company ? read.creation : null, reread };
}
