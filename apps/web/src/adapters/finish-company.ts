import { lane } from './sends.js';
import {
  canOpenCompanies, companyAwaitingItsSecondPress, finishCompanyInTheWallet, forgetAFinishedCreation,
  takeUpACreationSetAside, type CompanyCreationState,
} from 'vaults-web-shared/keyring.js';
import { CREATION_STANDINGS, READ_FAILURE, STAGE, creationChanged, creationOf, type Stage } from './creation-standing.js';
import { keyringFor } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';

export { STAGE, type Stage };

/*
 * THE SECOND STEP OF CREATING A COMPANY: ONE PRESS, ONE ACTION IN THE WALLET (`openYourWallet`). The wallet builds the
 * account, has it sent and finished, and commits it to its pay-record key, in one window behind one passkey, proving
 * every step itself (`finishCompanyInTheWallet`). Nothing is built, proved or sent without that press: `carryOn` only
 * looks at where the company stands and says what the screen shows. An action that stopped before its end, or a page
 * reloaded after the account was sent, leaves the company "interrupted at step N of M", carried on by the next press
 * of the same action, which the wallet takes up again from its saved keys and what the chain shows. The step shown
 * after a reload is the service's standing, for the screen only; the wallet reads the chain itself.
 */

/** What a look at the company comes to, compared by the code and never shown. */
export const FINISH = {
  waiting: 'waiting', press: 'press', interrupted: 'interrupted', locked: 'locked', cannot: 'cannot', none: 'none',
  signedOut: 'signed-out', unread: 'unread',
} as const;

/** How many steps finishing a company takes in the wallet (`apps/wallet/src/actions/finish-company.ts`). */
export const FINISH_STEPS = 5;

/** How long the screen waits between two looks at a company while its action runs. */
export const CARRY_ON_EVERY_MS = 10_000;

export type Carried =
  | { of: typeof ACTED.done; companyId: string }
  | { of: typeof FINISH.waiting; companyId: string; stage: Stage }
  | { of: typeof FINISH.interrupted; companyId: string; step: number; steps: number }
  | { of: typeof FINISH.press | typeof FINISH.locked | typeof FINISH.cannot | typeof FINISH.signedOut | typeof FINISH.unread; companyId: string }
  | { of: typeof FINISH.none }
  | { of: typeof ACTED.refused; why: ActRefusal; companyId: string | null };

type Pressed =
  | { of: typeof ACTED.done }
  | { of: typeof FINISH.interrupted; step: number; steps: number }
  | { of: typeof ACTED.refused; why: ActRefusal };

/* The look in progress, and the press in progress, for each company; the lane says to the rest of the page that one runs. */
const carries = new Map<string | null, Promise<Carried>>();
const presses = new Map<string | null, Promise<Pressed>>();
/* Where this tab last saw the company's action stop, so the screen says so until the next press. */
const stoppedAt = new Map<string, number>();
function publishTheLane(): void {
  lane.carrying = carries.size === 0 ? null : Promise.allSettled([...carries.values()]);
  lane.pressing = presses.size === 0 ? null : Promise.allSettled([...presses.values()]);
}

/* The standings in which the account's deploy is on the chain. */
const DEPLOY_LANDED: ReadonlySet<CompanyCreationState> = new Set<CompanyCreationState>(['finish-owed', 'finish-expired', 'finish-sent', 'pay-key-owed', 'finished']);

/* A standing whose account was sent and owes the chain a step the wallet takes without this tab holding the saved keys. */
const sentAndCarriedOnWithoutTheKeys = (standing: CompanyCreationState): boolean =>
  CREATION_STANDINGS[standing].owesTheChain && !CREATION_STANDINGS[standing].needsTheKeys;

const stageOf = (standing: CompanyCreationState | null): Stage => (standing === null ? STAGE.read : CREATION_STANDINGS[standing].stage);

/**
 * THE STEP THE SERVICE'S STANDING SAYS THE ACTION REACHED, for the screen only: 1 the account sent, 2 the account
 * finished, 3 to 5 the pay-record key. The wallet never reads this; it works out where it stands from the chain.
 */
const stepOfTheStanding = (standing: CompanyCreationState | null): number => {
  switch (standing) {
    case 'deploy-sent': case 'deploy-expired': case 'finish-owed': case 'finish-expired': case 'finish-sent': return 2;
    case 'pay-key-owed': return 3;
    case 'finished': return FINISH_STEPS;
    default: return 1;
  }
};

/** A creation the wallet shows finished: what this browser kept of it is dropped, if anything still is. */
async function finishedNow(id: string, kept: boolean): Promise<Carried> {
  if (kept) { await forgetAFinishedCreation(id, ACCOUNT_ORIGIN); creationChanged(id); }
  return { of: ACTED.done, companyId: id };
}

async function carry(personId: string, company: string | null): Promise<Carried> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp, companyId: company };
  let id = company;
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn, companyId: company };
    creationChanged(company);
    let creation = await creationOf(company);
    id = creation.company;
    if (id === null) return { of: FINISH.none };
    if (creation.failure === READ_FAILURE.signedOut) return { of: FINISH.signedOut, companyId: id };
    if (creation.failure === READ_FAILURE.failed) return { of: FINISH.unread, companyId: id };
    const standing = creation.standing;
    if (standing !== null && CREATION_STANDINGS[standing].needsTheKeys && !canOpenCompanies()) return { of: FINISH.locked, companyId: id };
    /* A creation set aside whose account the service now reads as landed is taken up again, so it can be finished. */
    if (!creation.kept && standing !== null && DEPLOY_LANDED.has(standing) && await takeUpACreationSetAside(id)) {
      creationChanged(id);
      creation = await creationOf(id);
    }
    if (creation.confirmedFinished) return await finishedNow(id, creation.kept);
    /* While the action runs in this tab, the screen follows it. */
    if (presses.has(id)) return { of: FINISH.waiting, companyId: id, stage: stageOf(standing) };
    if (creation.awaitingSecondPress) {
      const step = Math.max(stoppedAt.get(id) ?? 1, stepOfTheStanding(standing));
      return step > 1 ? { of: FINISH.interrupted, companyId: id, step, steps: FINISH_STEPS } : { of: FINISH.press, companyId: id };
    }
    if (standing === 'finished') return { of: FINISH.waiting, companyId: id, stage: stageOf(standing) };
    /*
     * A tab that holds no saved keys, as after a reload, cannot see whether they keep this creation; the wallet reads
     * them itself and carries on from what the chain shows, so a sent account is one press of the same action away.
     */
    if (!canOpenCompanies() && standing !== null && sentAndCarriedOnWithoutTheKeys(standing)) {
      return { of: FINISH.interrupted, companyId: id, step: Math.max(stoppedAt.get(id) ?? 1, stepOfTheStanding(standing)), steps: FINISH_STEPS };
    }
    /* Not kept in the saved keys this tab holds: started by somebody else, or set aside. Nothing here can finish it. */
    return { of: FINISH.cannot, companyId: id };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e), companyId: id };
  }
}

/**
 * One look at the company: what the screen shows. It sends nothing. A call made while another is running gets that
 * one's answer.
 */
export function carryOn(personId: string, company: string | null): Promise<Carried> {
  const running = carries.get(company);
  if (running !== undefined) return running;
  const mine: Promise<Carried> = carry(personId, company).finally(() => { if (carries.get(company) === mine) carries.delete(company); publishTheLane(); });
  carries.set(company, mine);
  publishTheLane();
  return mine;
}

/**
 * The one press: runs the whole of finishing the company in the wallet, one window and one passkey, whether or not
 * the wallet has read the saved keys for this tab yet (they keep the creation, and the wallet reads them itself). Two presses at once are one press. Hands back
 * done, where the action stopped, or a reason by the refusal's kind.
 */
export async function openYourWallet(personId: string, company: string | null, onStep?: (step: number, steps: number) => void): Promise<Pressed> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
  const running = presses.get(company);
  if (running !== undefined) return running;
  const mine: Promise<Pressed> = (async () => {
    await Promise.allSettled([carries.get(company)]);
    while (lane.holding !== null) await lane.holding;
    return pressed(personId, company, onStep);
  })().finally(() => { if (presses.get(company) === mine) presses.delete(company); publishTheLane(); });
  presses.set(company, mine);
  publishTheLane();
  return mine;
}

async function pressed(personId: string, company: string | null, onStep?: (step: number, steps: number) => void): Promise<Pressed> {
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    /* A tab the wallet has not read the saved keys for runs the action at once, naming the company by the service's
     * record: the wallet finishes only a creation it drew and keeps, in this one window. */
    if (company === null || (canOpenCompanies() && companyAwaitingItsSecondPress(company) === null)) return { of: ACTED.done };
    stoppedAt.delete(company);
    const ended = await finishCompanyInTheWallet(company, ACCOUNT_ORIGIN, {
      onStep: (at) => { onStep?.(at.step, at.steps); },
    });
    creationChanged(company);
    if (ended.of === 'done') return { of: ACTED.done };
    stoppedAt.set(company, ended.step);
    return { of: FINISH.interrupted, step: ended.step, steps: ended.steps };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}
