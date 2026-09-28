import { EVERY_STEP, type SetupFacts } from './steps.js';
import type { StepId } from './step-ids.js';

/** Where each step stands for the wizard: done, skipped for now, or neither. */
export const STANDING = { done: 'done', skipped: 'skipped', open: 'open' } as const;
export type Standing = (typeof STANDING)[keyof typeof STANDING];

/**
 * The steps skipped in this tab, for each company (and for the person before
 * they have one). Kept for this tab only: skipping is "for now".
 */
const skippedIn = new Map<string | null, Set<StepId>>();
export const skippedFor = (company: string | null): Set<StepId> => {
  let s = skippedIn.get(company);
  if (s === undefined) { s = new Set(); skippedIn.set(company, s); }
  return s;
};

/** Where `step` stands: done when the application knows it is, skipped when the person skipped it and it is not done, open otherwise. Skipping a step never makes it done. */
export function standingOf(step: (typeof EVERY_STEP)[number], facts: SetupFacts, skipped: ReadonlySet<StepId>): Standing {
  if (step.done(facts)) return STANDING.done;
  return skipped.has(step.id) ? STANDING.skipped : STANDING.open;
}

/** The first step that is neither done nor skipped, or the last step when every one is. A step asked for by name is taken before this, by the wizard. */
export function firstOpen(facts: SetupFacts, skipped: ReadonlySet<StepId>): StepId {
  return EVERY_STEP.find((s) => standingOf(s, facts, skipped) === STANDING.open)?.id ?? EVERY_STEP[EVERY_STEP.length - 1]!.id;
}

