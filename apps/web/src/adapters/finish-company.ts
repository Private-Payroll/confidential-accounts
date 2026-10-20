import {
  canOpenCompanies, companyKeptWithNoDeploy, finishCompanyOnTheChain, forgetAnUnsentCreation, forgetAFinishedCreation,
  openKeysWithWallet, companyAwaitingItsSecondPress, companyBeingCreated, sealThePayRecordKey, signCompanyCreationFromTheWallet,
  type CompanyCreationState,
} from 'vaults-web-shared/keyring.js';
import { CREATION_STANDINGS, STAGE, creationChanged, creationOf, type Stage } from './creation-standing.js';
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
 */

/** What a look at the company comes to, compared by the code and never shown. */
export const FINISH = {
  waiting: 'waiting', press: 'press', locked: 'locked', cannot: 'cannot', none: 'none', noDeploy: 'no-deploy',
} as const;

/** How long the screen waits between two looks at a company the chain is still working on. */
export const CARRY_ON_EVERY_MS = 10_000;

export type Carried =
  | { of: typeof ACTED.done; companyId: string }
  | { of: typeof FINISH.waiting; companyId: string; stage: Stage }
  | { of: typeof FINISH.press | typeof FINISH.locked | typeof FINISH.cannot | typeof FINISH.noDeploy; companyId: string }
  | { of: typeof FINISH.none }
  | { of: typeof ACTED.refused; why: ActRefusal; companyId: string | null };

export type Pressed = { of: typeof ACTED.done } | { of: typeof ACTED.refused; why: ActRefusal };

/**
 * The companies this page has sent the finishing step for. The service cannot
 * tell a finishing step sent from one owed, so a company that reads owed again
 * is not sent it again: only a read that it ran out sends it once more.
 */
const sentFinish = new Set<string>();

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
    const standing = creation.standing;
    if (standing !== null && CREATION_STANDINGS[standing].needsTheKeys && !canOpenCompanies()) return { of: FINISH.locked, companyId: id };
    if (creation.confirmedFinished) return await finishedNow(id, creation.kept);
    if (standing === 'not-created') {
      if (creation.awaitingSecondPress) return { of: FINISH.press, companyId: id };
      if (companyKeptWithNoDeploy() === id) return { of: FINISH.noDeploy, companyId: id };
      return creation.kept ? { of: FINISH.waiting, companyId: id, stage: STAGE.deploy } : { of: FINISH.cannot, companyId: id };
    }
    const waits: Carried = { of: FINISH.waiting, companyId: id, stage: stageOf(standing) };
    if (standing === 'finish-owed' || standing === 'finish-expired' || standing === 'deploy-expired') {
      const again = standing !== 'finish-owed';
      if (!again && sentFinish.has(id)) return waits;
      const builder = again ? await theCreationBuilder() : undefined;
      if (builder === null) return { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish, companyId: id };
      if (standing !== 'deploy-expired') sentFinish.add(id);
      let reached = false;
      try {
        await finishCompanyOnTheChain(id, builder);
        reached = true;
      } finally {
        if (!reached) sentFinish.delete(id);
      }
      creationChanged(id);
      return waits;
    }
    if (standing === 'pay-key-owed') {
      const builder = await theCreationBuilder();
      if (builder === null) return { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish, companyId: id };
      await sealThePayRecordKey(id, builder);
      creationChanged(id);
      const sealed = await creationOf(id);
      return sealed.confirmedFinished ? await finishedNow(id, sealed.kept) : waits;
    }
    return waits;
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e), companyId: id };
  }
}

let running: Promise<Carried> | null = null;

/**
 * One look at the company and the one step it owes. It refuses by the refusal's
 * kind and takes no step then. A call made while another is running gets that
 * one's answer, so a step is never sent twice at once.
 */
export function carryOn(personId: string, company: string | null): Promise<Carried> {
  running ??= carry(personId, company).finally(() => { running = null; });
  return running;
}

/**
 * The one wallet press: opens the saved keys when they are shut, then has the
 * wallet sign the creation this browser keeps waiting for its second press, if
 * there is one. Hands back a reason by the refusal's kind.
 */
export async function openYourWallet(personId: string, company: string | null): Promise<Pressed> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    const builder = await theCreationBuilder();
    if (builder === null) return { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish };
    if (!canOpenCompanies()) await openKeysWithWallet(ACCOUNT_ORIGIN);
    if (companyAwaitingItsSecondPress() !== null) await signCompanyCreationFromTheWallet(ACCOUNT_ORIGIN, builder);
    creationChanged(company);
    const kept = companyBeingCreated();
    if (kept !== company) creationChanged(kept);
    return { of: ACTED.done };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}

/**
 * Drops a kept creation whose deploy was never built, so the person can make a
 * company again. The keyring refuses when a deploy is kept or anything was
 * signed or sent, and that refusal is handed on by its kind.
 */
export async function startAgain(personId: string, companyId: string): Promise<Pressed> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    await forgetAnUnsentCreation(companyId);
    creationChanged(companyId);
    return { of: ACTED.done };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}
