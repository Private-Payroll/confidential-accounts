import { NoCreationKeptHere, startAnUnfinishedCreationAgain, type StartedAgain } from 'vaults-web-shared/keyring.js';
import { creationChanged } from './creation-standing.js';
import { whileNothingIsSent } from './sends.js';
import { theCreationBuilder } from './vault-builder.js';
import { keyringFor } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';

/** What starting a kept creation again came to - dropped, or why it was kept - compared by the code and never shown. */
export const AGAIN = { landed: 'landed', wait: 'wait', unsure: 'unsure', nothing: 'nothing' } as const;
export type StartedOver =
  | { of: typeof ACTED.done }
  | { of: typeof AGAIN.landed }
  | { of: typeof AGAIN.wait; minutes: number }
  | { of: typeof AGAIN.unsure }
  | { of: typeof AGAIN.nothing }
  | { of: typeof ACTED.refused; why: ActRefusal };

function startedOver(r: StartedAgain): StartedOver {
  if (r.of === 'dropped') return { of: ACTED.done };
  if (r.of === 'on-the-chain') return { of: AGAIN.landed };
  if (r.of === 'may-still-land') return { of: AGAIN.wait, minutes: r.minutes };
  return { of: AGAIN.unsure };
}

/**
 * Starts the kept creation of `companyId` again, so the person can make that company again; with no
 * company, nothing: only the creation named is ever touched. Only what no
 * longer can reach the chain is dropped, and only for the person who started it
 * (the keyring checks both, on the chain as the person's own wallet reads it);
 * what it kept is handed on by its kind, with the refusal by its kind.
 */
export async function startAgain(personId: string, companyId: string | null): Promise<StartedOver> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    const id = companyId;
    if (id === null) return { of: AGAIN.nothing };
    /* After any carry or press in flight ends, and with none starting until this is settled. */
    const r = await whileNothingIsSent(async () => startAnUnfinishedCreationAgain(id, ACCOUNT_ORIGIN, await theCreationBuilder()));
    if (r.of === 'dropped') creationChanged(id);
    return startedOver(r);
  } catch (e) {
    if (e instanceof NoCreationKeptHere) return { of: AGAIN.nothing };
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}
