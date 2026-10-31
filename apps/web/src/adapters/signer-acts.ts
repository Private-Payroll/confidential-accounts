import { admitSignerInTheWallet, approveSignerInTheWallet } from 'vaults-web-shared/signer-in-the-wallet.js';
import { actOnACompanyInTheWallet } from 'vaults-web-shared/keyring.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { namedFor } from './create-vault.js';
import { keyringFor } from './keyring-person.js';
import { ACT_REFUSAL, refusalOf, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import type { SignerInvited } from './signers.js';

/**
 * The acts the signers page asks of the person's wallet: approving a signer invited by address, finishing adding one who took
 * their seat, and, from a seat just added, giving its own keys to the company.
 */
export const SIGNER_ACT = { approve: 'approve-signer', admit: 'admit-signer', giveKeys: 'give-vault-keys' } as const;
export type SignerAct = (typeof SIGNER_ACT)[keyof typeof SIGNER_ACT];

/** Every reason the wallet gives for an act it stopped, as the last part of the key it names: `act.<act>.why.<reason>`; `stopped` is no key at all, `other` one this page does not know. */
export const WHY = {
  notACompany: 'not-a-company', noSavedKeys: 'no-saved-keys', noSeat: 'no-seat', seatNotHeld: 'seat-not-held', notOnChain: 'not-on-chain',
  rosterNotOpened: 'roster-not-opened', notAProposal: 'not-a-proposal', notApproved: 'not-approved', withdrawn: 'withdrawn', mayBeSent: 'may-be-sent',
  alreadyCounted: 'already-counted', carriedOut: 'carried-out',
  notASigner: 'not-a-signer', notTheInvited: 'not-the-invited', notAdmitted: 'not-admitted', filedNotEntered: 'filed-not-entered',
  idTaken: 'id-taken', chainUnread: 'chain-unread',
  recordsKeyRefused: 'records-key-refused', entryNotFiled: 'entry-not-filed',
  stopped: 'stopped', other: 'other',
} as const;
export type SignerWhy = (typeof WHY)[keyof typeof WHY];

const SEAT_WHY: readonly SignerWhy[] = [WHY.notACompany, WHY.noSavedKeys, WHY.noSeat, WHY.seatNotHeld, WHY.notOnChain, WHY.rosterNotOpened];
const WHY_OF: Readonly<Record<SignerAct, readonly SignerWhy[]>> = {
  [SIGNER_ACT.approve]: [...SEAT_WHY, WHY.notAProposal, WHY.notApproved, WHY.withdrawn, WHY.mayBeSent, WHY.alreadyCounted, WHY.carriedOut],
  [SIGNER_ACT.admit]: [...SEAT_WHY, WHY.notASigner, WHY.notTheInvited, WHY.notAdmitted, WHY.filedNotEntered, WHY.idTaken, WHY.chainUnread],
  [SIGNER_ACT.giveKeys]: [...SEAT_WHY, WHY.recordsKeyRefused, WHY.entryNotFiled],
};

/** Stops after which part of the act may already have gone through, so the press is offered again rather than told as nothing done. */
const PARTLY: Readonly<Record<SignerAct, ReadonlySet<SignerWhy>>> = {
  [SIGNER_ACT.approve]: new Set<SignerWhy>([WHY.mayBeSent, WHY.stopped, WHY.other]),
  [SIGNER_ACT.admit]: new Set<SignerWhy>([WHY.filedNotEntered, WHY.stopped, WHY.other]),
  [SIGNER_ACT.giveKeys]: new Set<SignerWhy>([WHY.entryNotFiled, WHY.stopped, WHY.other]),
};

const KEY = /^act\.([a-z-]+)\.why\.([a-z-]+)$/u;

/** The reason in a key the wallet named for this act; a key for another act, an unknown reason or no key is told as such. */
export function whyOf(act: SignerAct, refused: string | undefined): SignerWhy {
  if (refused === undefined) return WHY.stopped;
  const m = KEY.exec(refused);
  const code = m?.[1] === act ? WHY_OF[act].find((c) => c === m[2]) : undefined;
  return code === undefined ? WHY.other : code;
}

export const SIGNER_ACTED = { done: 'done', stopped: 'stopped', refused: 'refused' } as const;
/** `handedOver`: the wallet handed the page transactions before it stopped (sent or not confirmed), whatever the reason, so "nothing was sent" is not true. */
export type SignerActed =
  | { readonly of: typeof SIGNER_ACTED.done; readonly state: string | null }
  | { readonly of: typeof SIGNER_ACTED.stopped; readonly act: SignerAct; readonly why: SignerWhy; readonly partial: boolean; readonly handedOver: boolean }
  | { readonly of: typeof SIGNER_ACTED.refused; readonly why: ActRefusal };

/** The names of what the wallet tells the page of where an act got to, besides that it is done. */
export const OUTCOME = { state: 'state' } as const;
const refused = (why: ActRefusal): SignerActed => ({ of: SIGNER_ACTED.refused, why });

type Ended = Awaited<ReturnType<typeof approveSignerInTheWallet>>;
function actedOf(act: SignerAct, ended: Ended): SignerActed {
  if (ended.of === SIGNER_ACTED.done) {
    const state = ended.outcome?.[OUTCOME.state];
    return { of: SIGNER_ACTED.done, state: typeof state === 'string' ? state : null };
  }
  const why = whyOf(act, ended.refused);
  return { of: SIGNER_ACTED.stopped, act, why, partial: PARTLY[act].has(why), handedOver: ended.relayed > 0 || ended.unconfirmed > 0 };
}

/** What is checked before the wallet is asked: the site is set up, the person is signed in here, the company can be named. */
async function namedBefore(personId: string, companyId: string): Promise<{ record: string; company: CompanyLabel; account: AccountAddress } | ActRefusal> {
  if (ACCOUNT_ORIGIN === '') return ACT_REFUSAL.notSetUp;
  if (!(await keyringFor(personId))) return ACT_REFUSAL.notSignedIn;
  const named = await namedFor(companyId);
  return named === null ? ACT_REFUSAL.didNotFinish : { record: named.record, company: named.company as CompanyLabel, account: named.account as AccountAddress };
}

/** Approves the proposal that invites this signer: the wallet opens that proposal itself and approves only what it invites exactly as shown. */
export async function approveSigner(
  personId: string, companyId: string, invited: SignerInvited, onStep?: (step: number, steps: number) => void,
): Promise<SignerActed> {
  try {
    if (invited.coinKey === null) return refused(ACT_REFUSAL.didNotFinish);
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await approveSignerInTheWallet({
      ...named, proposal: invited.proposal, name: invited.name, role: invited.role, address: invited.address, scope: invited.scope, coinKey: invited.coinKey,
    }, ACCOUNT_ORIGIN, onStep === undefined ? {} : { onStep: (at) => onStep(at.step, at.steps) });
    return actedOf(SIGNER_ACT.approve, ended);
  } catch (e) {
    return refused(refusalOf(e));
  }
}

/** Finishes adding a signer who took their seat: the wallet files the company's list with them in it and gives them the company's key. */
export async function admitSigner(
  personId: string, companyId: string, signer: { readonly id: string; readonly name: string }, onStep?: (step: number, steps: number) => void,
): Promise<SignerActed> {
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await admitSignerInTheWallet({ ...named, signer: signer.id, name: signer.name }, ACCOUNT_ORIGIN,
      onStep === undefined ? {} : { onStep: (at) => onStep(at.step, at.steps) });
    return actedOf(SIGNER_ACT.admit, ended);
  } catch (e) {
    return refused(refusalOf(e));
  }
}

/**
 * Gives this seat's own keys to the company, from a seat just added: the wallet files this seat's entry in the company's
 * directory and its records key, checked against the invitation it joined by and the seats the chain holds, and ends with
 * the upkeep every act of a seat ends with. A vault's secret is given to this seat by the upkeep of the next act of a seat
 * that holds it, never by this act.
 */
export async function giveYourKeys(
  personId: string, companyId: string, onStep?: (step: number, steps: number) => void,
): Promise<SignerActed> {
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await actOnACompanyInTheWallet({ name: SIGNER_ACT.giveKeys, ...named }, ACCOUNT_ORIGIN,
      onStep === undefined ? {} : { onStep: (at) => onStep(at.step, at.steps) });
    return actedOf(SIGNER_ACT.giveKeys, ended);
  } catch (e) {
    return refused(refusalOf(e));
  }
}
