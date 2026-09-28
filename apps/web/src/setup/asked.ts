import type { StepId } from './step-ids.js';

/*
 * WHAT THE SETUP WIZARD IS ASKED TO OPEN AT, kept apart from the list of steps
 * so a place that only asks for the wizard (the company switcher, the landing
 * page) does not carry the steps' actions with it.
 */

/**
 * What the wizard was asked for, the next time it is shown: the step to open
 * at, and whether it is setting up a new company rather than the one shown.
 */
export interface SetupAsked {
  step: StepId;
  newCompany: boolean;
}

/** Read once, by the wizard. */
let asked: SetupAsked | null = null;

/**
 * Open the wizard at `step` the next time it is shown. "Create a company"
 * asks for a new company, so the wizard sets up that one and not a company
 * the person already signs for.
 */
export function startSetupAt(step: StepId, newCompany = false): void { asked = { step, newCompany }; }

/** What the wizard was asked for, once; null after. */
export function takeAsked(): SetupAsked | null {
  const a = asked;
  asked = null;
  return a;
}
