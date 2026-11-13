import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { api } from 'vaults-web-shared/keyring.js';
import { serviceOpenerOfSigner } from 'vaults-web-shared/company-service-here.js';
import { recoveryWindowHere, type WindowReach } from 'vaults-web-shared/recovery-window-here.js';
import { setRecoveryWindowInTheWallet, windowOutcomeOf, WINDOW_STATE } from 'vaults-web-shared/recovery-in-the-wallet.js';
import type { ActOutcome } from 'vaults-web-shared/wallet-act.js';
import type { CompanyKeyHere } from 'vaults-web-shared/company-key-here.js';
import { namedFor } from './create-vault.js';
import { keyringFor } from './keyring-person.js';
import { ACT_REFUSAL, refusalOf, SEAT_REFUSALS, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { seatAndRecordsHere } from './vault-private-money.js';

export { WINDOW_STATE };

export const WINDOW_READ = { read: 'read', unread: 'unread', refused: 'refused' } as const;

/**
 * The company's recovery window as this page reads it from the company's records: the length in force (null for
 * none), and a change still gathering signatures with how many have signed it of how many it needs. The wallet holds
 * the window it kept for the records it checked; this is what the page shows and offers waits within.
 */
export type WindowHeld =
  | {
    readonly of: typeof WINDOW_READ.read; readonly inForce: number | null;
    readonly waiting: { readonly seconds: number; readonly signed: number; readonly needed: number } | null;
  }
  | { readonly of: typeof WINDOW_READ.unread; readonly why: string }
  | { readonly of: typeof WINDOW_READ.refused; readonly why: ActRefusal };

type WindowRead = Awaited<ReturnType<typeof recoveryWindowHere>>;
/** Whether the shared read could not read the window, which it says with why. */
const wasUnread = (got: WindowRead): got is Extract<WindowRead, { readonly unread: string }> => typeof (got as { readonly unread?: unknown }).unread === 'string';

/** Reads the window with the company's key this visit's wallet released. */
export async function readRecoveryWindow(personId: string, companyId: string): Promise<WindowHeld> {
  try {
    const here = await seatAndRecordsHere(personId, companyId);
    if (typeof here === 'string') return { of: WINDOW_READ.refused, why: here };
    const companyKeys: CompanyKeyHere = here.viewingKey;
    const reach: WindowReach = {
      accountId: companyId, api: (path) => api(path), judges: { directoryHereFor: () => here.directory }, label: here.company, account: here.account,
      companyKeys, roster: async () => here.opened, opener: serviceOpenerOfSigner(companyId, here.mine, companyKeys),
    };
    const got = await recoveryWindowHere(reach);
    if (wasUnread(got)) return { of: WINDOW_READ.unread, why: got.unread };
    return {
      of: WINDOW_READ.read, inForce: got.inForce?.seconds ?? null,
      waiting: got.waiting === null ? null : { seconds: got.waiting.seconds, signed: got.waiting.signed, needed: got.waiting.needed },
    };
  } catch (e) {
    return { of: WINDOW_READ.refused, why: refusalOf(e) };
  }
}

export const WINDOW_WHY = {
  seat: 'seat', mayNotStart: 'may-not-start', seatNotBelieved: 'seat-not-believed', keyBeingChanged: 'key-being-changed',
  filedMeanwhile: 'filed-meanwhile', notFiled: 'not-filed', notEntered: 'not-entered', unread: 'unread', stopped: 'stopped', other: 'other',
} as const;
export type WindowWhy = (typeof WINDOW_WHY)[keyof typeof WINDOW_WHY];

const WHY_OF_CODE: Readonly<Record<string, WindowWhy>> = {
  ...Object.fromEntries(SEAT_REFUSALS.map((c) => [c, WINDOW_WHY.seat] as const)),
  'role-may-not-start': WINDOW_WHY.mayNotStart, 'seat-not-believed': WINDOW_WHY.seatNotBelieved, 'key-being-changed': WINDOW_WHY.keyBeingChanged,
  'filed-meanwhile': WINDOW_WHY.filedMeanwhile, 'not-filed': WINDOW_WHY.notFiled, 'not-entered': WINDOW_WHY.notEntered, unread: WINDOW_WHY.unread,
};
const CODE = /^act\.set-recovery-window\.why\.([a-z-]+)$/u;

/** Why the wallet stopped setting the window, by the code of its refusal. */
function windowWhyOf(refused: string | undefined): WindowWhy {
  if (refused === undefined) return WINDOW_WHY.stopped;
  const code = CODE.exec(refused)?.[1];
  return code !== undefined && Object.prototype.hasOwnProperty.call(WHY_OF_CODE, code) ? WHY_OF_CODE[code]! : WINDOW_WHY.other;
}

export const WINDOW_ACTED = { done: 'done', stopped: 'stopped', refused: 'refused' } as const;

export type WindowActed =
  | { readonly of: typeof WINDOW_ACTED.done; readonly state: string | null; readonly signed: number | null; readonly needed: number | null }
  | { readonly of: typeof WINDOW_ACTED.stopped; readonly why: WindowWhy }
  | { readonly of: typeof WINDOW_ACTED.refused; readonly why: ActRefusal };

const actedOf = (ended: ActOutcome): WindowActed =>
  (ended.of === WINDOW_ACTED.done ? { of: WINDOW_ACTED.done, ...windowOutcomeOf(ended) } : { of: WINDOW_ACTED.stopped, why: windowWhyOf(ended.refused) });

/** Sets the window to `seconds`, or signs a change to that length, in the wallet. */
export async function setRecoveryWindow(
  personId: string, companyId: string, seconds: number, onStep?: (step: number, steps: number) => void,
): Promise<WindowActed> {
  try {
    if (ACCOUNT_ORIGIN === '') return { of: WINDOW_ACTED.refused, why: ACT_REFUSAL.notSetUp };
    if (!(await keyringFor(personId))) return { of: WINDOW_ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    const named = await namedFor(companyId);
    if (named === null) return { of: WINDOW_ACTED.refused, why: ACT_REFUSAL.didNotFinish };
    const step = onStep === undefined ? {} : { onStep: (at: { step: number; steps: number }) => onStep(at.step, at.steps) };
    return actedOf(await setRecoveryWindowInTheWallet({
      record: named.record, company: named.company as CompanyLabel, account: named.account as AccountAddress, seconds,
    }, ACCOUNT_ORIGIN, step));
  } catch (e) {
    return { of: WINDOW_ACTED.refused, why: refusalOf(e) };
  }
}

export { durationSaid, windowWhenNoneInForce } from '../../../../src/midnight/recovery-window-record.js';
