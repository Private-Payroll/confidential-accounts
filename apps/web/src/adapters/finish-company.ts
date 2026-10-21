import { lane } from './sends.js';
import {
  canOpenCompanies, companyKeptWithNoDeploy, finishCompanyOnTheChain, forgetAFinishedCreation, keptCreationRunsOutSoon,
  openKeysWithWallet, companyAwaitingItsSecondPress, carryTheFirstPressOn, sealThePayRecordKey, signCompanyCreationFromTheWallet,
  type CompanyCreationState,
} from 'vaults-web-shared/keyring.js';
import { CREATION_STANDINGS, READ_FAILURE, STAGE, creationChanged, creationOf, type Stage } from './creation-standing.js';
import { keyringFor } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';
import { theCreationBuilder } from './vault-builder.js';

export { STAGE, type Stage };

/*
 * THE SECOND STEP OF CREATING A COMPANY: one wallet press (`openYourWallet`), then the company is carried to finished
 * with no further press (`carryOn`: one look, and the one step owed). The service's standing only leads; the company
 * is finished only when the person's wallet shows its pay-record key committed, and the creation this browser kept is
 * dropped only by the keyring, which asks the wallet itself. It keeps which companies this page already sent the
 * finishing step for, and the look in progress.
 *
 * A step that ran out of time before it was sent is built again by the keyring, with no press: `builtAgain` is handed
 * on, for the screen to say so.
 */

/** What a look at the company comes to, compared by the code and never shown. */
export const FINISH = {
  waiting: 'waiting', press: 'press', locked: 'locked', cannot: 'cannot', none: 'none', noDeploy: 'no-deploy',
  signedOut: 'signed-out', unread: 'unread',
} as const;

/** How long the screen waits between two looks at a company the chain is still working on. */
export const CARRY_ON_EVERY_MS = 10_000;

export type Carried =
  | { of: typeof ACTED.done; companyId: string }
  | { of: typeof FINISH.waiting; companyId: string; stage: Stage; builtAgain?: true }
  | { of: typeof FINISH.press | typeof FINISH.locked | typeof FINISH.cannot | typeof FINISH.noDeploy | typeof FINISH.signedOut | typeof FINISH.unread; companyId: string }
  | { of: typeof FINISH.none }
  | { of: typeof ACTED.refused; why: ActRefusal; companyId: string | null };

export type Pressed = { of: typeof ACTED.done; builtAgain?: true } | { of: typeof ACTED.refused; why: ActRefusal };

/**
 * The companies this page has sent the finishing step for. The service cannot
 * tell a finishing step sent from one owed, so a company that reads owed again
 * is not sent it again: only a read that it ran out sends it once more.
 */
const sentFinish = new Set<string>();

/** The carries and the wallet presses in flight, each for its own company; `lane` holds one promise that ends when all of them have. */
const carries = new Map<string | null, Promise<Carried>>();
const presses = new Map<string | null, Promise<Pressed>>();
function publishTheLane(): void {
  lane.carrying = carries.size === 0 ? null : Promise.allSettled([...carries.values()]);
  lane.pressing = presses.size === 0 ? null : Promise.allSettled([...presses.values()]);
}

/** How many steps are going out now, for any company; `lane.sending` says whether there is one. */
let goingOut = 0;
const sendingNow = (by: 1 | -1): void => { goingOut += by; lane.sending = goingOut > 0; };

const stageOf = (standing: CompanyCreationState | null): Stage => (standing === null ? STAGE.read : CREATION_STANDINGS[standing].stage);

/** The company is finished: the creation this browser kept, if any, is dropped on the wallet's own read, and the step is done. */
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
    const creation = await creationOf(company);
    id = creation.company;
    if (id === null) return { of: FINISH.none };
    if (creation.failure === READ_FAILURE.signedOut) return { of: FINISH.signedOut, companyId: id };
    if (creation.failure === READ_FAILURE.failed) return { of: FINISH.unread, companyId: id };
    const standing = creation.standing;
    if (standing !== null && CREATION_STANDINGS[standing].needsTheKeys && !canOpenCompanies()) return { of: FINISH.locked, companyId: id };
    if (creation.confirmedFinished) return await finishedNow(id, creation.kept);
    if (standing === 'not-created') {
      if (creation.awaitingSecondPress) return { of: FINISH.press, companyId: id };
      if (companyKeptWithNoDeploy(id) === id) {
        /* A creation whose first post or whose deploy never got made is carried on from where it stopped: nothing is sent to the chain. */
        const builder = await theCreationBuilder();
        let carriedOn = false;
        if (builder !== null) { try { carriedOn = await carryTheFirstPressOn(id, builder); } catch { carriedOn = false; } }
        if (carriedOn && companyAwaitingItsSecondPress(id) !== null) { creationChanged(id); return { of: FINISH.press, companyId: id }; }
        return { of: FINISH.noDeploy, companyId: id };
      }
      return creation.kept ? { of: FINISH.waiting, companyId: id, stage: STAGE.deploy } : { of: FINISH.cannot, companyId: id };
    }
    const waits: Carried = { of: FINISH.waiting, companyId: id, stage: stageOf(standing) };
    /* A creation is being started again: it may be set aside, so nothing is built or sent for it now. */
    if (lane.holding !== null) return waits;
    /* The wallet press sends the deploy itself; a carry that sent a step beside it would pay for the same step twice. */
    if (presses.has(id) && standing !== 'pay-key-owed') return waits;
    /* A step this browser kept with too little life left is built again, never sent as it is, whatever the service reads. */
    const shortOfLife = (standing === 'finish-owed' || standing === 'deploy-sent') && keptCreationRunsOutSoon(id, standing);
    if (standing === 'finish-owed' || standing === 'finish-expired' || standing === 'deploy-expired' || shortOfLife) {
      const again = standing !== 'finish-owed' || shortOfLife;
      if (!again && sentFinish.has(id)) return waits;
      const builder = again ? await theCreationBuilder() : undefined;
      if (builder === null) return { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish, companyId: id };
      if (standing === 'finish-owed' || standing === 'finish-expired') sentFinish.add(id);
      let reached = false;
      let builtAgain = false;
      sendingNow(1);
      try {
        builtAgain = (await finishCompanyOnTheChain(id, builder)).builtAgain === true;
        reached = true;
      } finally {
        sendingNow(-1);
        if (!reached) sentFinish.delete(id);
      }
      creationChanged(id);
      return builtAgain ? { ...waits, builtAgain: true } : waits;
    }
    if (standing === 'pay-key-owed') {
      const builder = await theCreationBuilder();
      if (builder === null) return { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish, companyId: id };
      sendingNow(1);
      try { await sealThePayRecordKey(id, builder); } finally { sendingNow(-1); }
      creationChanged(id);
      const sealed = await creationOf(id);
      return sealed.confirmedFinished ? await finishedNow(id, sealed.kept) : waits;
    }
    return waits;
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e), companyId: id };
  }
}

/**
 * One look at the company and the one step it owes. It refuses by the refusal's
 * kind and takes no step then. A call made while another is running gets that
 * one's answer, so a step is never sent twice at once.
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
 * The one wallet press: opens the saved keys when they are shut, then has the
 * wallet sign the creation this browser keeps waiting for its second press, if
 * there is one. Hands back a reason by the refusal's kind.
 */
export async function openYourWallet(personId: string, company: string | null): Promise<Pressed> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
  /*
   * ONE SEND AT A TIME BETWEEN THE CARRY AND THE PRESS. A carry already sending is waited for, and a carry that starts
   * while the press runs takes no step; both may otherwise ask the service to carry the same deploy at once. Two
   * presses at once are one press.
   */
  const running = presses.get(company);
  if (running !== undefined) return running;
  const mine: Promise<Pressed> = (async () => {
    await Promise.allSettled([carries.get(company)]);
    while (lane.holding !== null) await lane.holding;
    return pressed(personId, company);
  })().finally(() => { if (presses.get(company) === mine) presses.delete(company); publishTheLane(); });
  presses.set(company, mine);
  publishTheLane();
  return mine;
}

async function pressed(personId: string, company: string | null): Promise<Pressed> {
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    const builder = await theCreationBuilder();
    if (builder === null) return { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish };
    if (!canOpenCompanies()) await openKeysWithWallet(ACCOUNT_ORIGIN);
    const signed = company !== null && companyAwaitingItsSecondPress(company) !== null ? await signCompanyCreationFromTheWallet(company, ACCOUNT_ORIGIN, builder) : null;
    creationChanged(company);
    return signed?.builtAgain === true ? { of: ACTED.done, builtAgain: true } : { of: ACTED.done };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}
