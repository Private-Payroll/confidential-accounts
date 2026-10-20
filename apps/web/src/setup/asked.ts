import { HOME } from '../pages.js';
import { go } from '../router.js';
import { creationOfCompany } from './creation-on-demand.js';
import { STEP, type StepId } from './step-ids.js';

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

/**
 * Open a company from a list of companies: choose it as the open one, the way the list does, and, when the creation
 * adapter marks it not finished, ask the wizard to open at "Finish creating the company" and go there. A company with no
 * mark, an unknown one and one whose read failed open as the list opens them. The mark comes from the adapter's one cached
 * read, so this never waits on the service before the company is chosen.
 */
export function openCompany(id: string, choose: () => void): void {
  choose();
  void creationOfCompany(id).then((creation) => {
    if (creation.mark === null) return;
    startSetupAt(STEP.finishCompany);
    go(HOME.setup);
  });
}


/** What the wizard was asked for, once; null after. */
export function takeAsked(): SetupAsked | null {
  const a = asked;
  asked = null;
  return a;
}
