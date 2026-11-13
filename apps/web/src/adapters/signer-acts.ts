import { removalOutcomeOf, removeSignerInTheWallet, rotateVaultSecretsInTheWallet, rotationOutcomeOf, REMOVE_SIGNER, ROTATE_VAULT_SECRETS, type VaultsTold } from 'vaults-web-shared/proposal-in-the-wallet.js';
import { admitSignerInTheWallet, approveSignerInTheWallet } from 'vaults-web-shared/signer-in-the-wallet.js';
import { actOnACompanyInTheWallet } from 'vaults-web-shared/keyring.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { mayInvite } from '../../../../src/midnight/seat-directory.js';
import { namedFor } from './create-vault.js';
import { keyringFor } from './keyring-person.js';
import { ACT_REFUSAL, refusalOf, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import type { SignerInvited } from './signers.js';
import { seatAndRecordsHere } from './vault-private-money.js';

/**
 * The acts the signers page asks of the person's wallet: approving a signer invited by address, finishing adding one who took
 * their seat, from a seat just added, giving its own keys to the company, removing a signer, and, from a signer who stays,
 * changing the company's vault secrets after one left.
 */
export const SIGNER_ACT = {
  approve: 'approve-proposal', admit: 'admit-signer', giveKeys: 'give-vault-keys', remove: REMOVE_SIGNER, rotate: ROTATE_VAULT_SECRETS, repair: 'repair-company-key',
  withdraw: 'withdraw-waiting-signer', reissue: 'reissue-invitation', addByCode: 'add-signer-by-code', raise: 'raise-waiting-signer',
} as const;
export type SignerAct = (typeof SIGNER_ACT)[keyof typeof SIGNER_ACT];

/** Every reason the wallet gives for an act it stopped, as the last part of the key it names: `act.<act>.why.<reason>`; `stopped` is no key at all, `other` one this page does not know. */
export const WHY = {
  notACompany: 'not-a-company', noSavedKeys: 'no-saved-keys', noSeat: 'no-seat', seatNotHeld: 'seat-not-held', notOnChain: 'not-on-chain',
  rosterNotOpened: 'roster-not-opened', notAProposal: 'not-a-proposal', notApproved: 'not-approved', withdrawn: 'withdrawn', mayBeSent: 'may-be-sent',
  alreadyCounted: 'already-counted', carriedOut: 'carried-out',
  notASigner: 'not-a-signer', notTheInvited: 'not-the-invited', notAdmitted: 'not-admitted', filedNotEntered: 'filed-not-entered',
  idTaken: 'id-taken', chainUnread: 'chain-unread',
  recordsKeyRefused: 'records-key-refused', entryNotFiled: 'entry-not-filed',
  notARemoval: 'not-a-removal', removalRefused: 'refused', notRaised: 'not-raised', notCarried: 'not-carried', notAsShown: 'not-as-shown',
  notRead: 'not-read', notReadToRaise: 'not-read-to-raise', noSuchSeat: 'no-such-seat', noSuchSeatToRaise: 'no-such-seat-to-raise',
  unreadSeatFirst: 'unread-seat-first', outrun: 'outrun', noPerson: 'no-person', notAVault: 'not-a-vault',
  notRotated: 'not-rotated', waits: 'waits', notThisSeat: 'not-this-seat', notNeeded: 'not-needed', notRepaired: 'not-repaired',
  mayNot: 'may-not', notWithdrawn: 'not-withdrawn', withheld: 'withheld', notASeat: 'not-a-seat', notMade: 'not-made', notTaken: 'not-taken',
  noRole: 'no-role', notACode: 'not-a-code', notWaiting: 'not-waiting', notOpened: 'not-opened', noScope: 'no-scope', noOpening: 'no-opening',
  stopped: 'stopped', other: 'other',
} as const;
export type SignerWhy = (typeof WHY)[keyof typeof WHY];

const SEAT_WHY: readonly SignerWhy[] = [WHY.notACompany, WHY.noSavedKeys, WHY.noSeat, WHY.seatNotHeld, WHY.notOnChain, WHY.rosterNotOpened];
const WHY_OF: Readonly<Record<SignerAct, readonly SignerWhy[]>> = {
  [SIGNER_ACT.approve]: [...SEAT_WHY, WHY.notAProposal, WHY.notApproved, WHY.withdrawn, WHY.mayBeSent, WHY.alreadyCounted, WHY.carriedOut],
  [SIGNER_ACT.admit]: [...SEAT_WHY, WHY.notASigner, WHY.notTheInvited, WHY.notAdmitted, WHY.filedNotEntered, WHY.idTaken, WHY.chainUnread],
  [SIGNER_ACT.giveKeys]: [...SEAT_WHY, WHY.recordsKeyRefused, WHY.entryNotFiled],
  [SIGNER_ACT.remove]: [
    ...SEAT_WHY, WHY.notARemoval, WHY.removalRefused, WHY.notRaised, WHY.notApproved, WHY.notCarried, WHY.mayBeSent, WHY.notAsShown, WHY.notRead,
    WHY.notReadToRaise, WHY.noSuchSeat, WHY.noSuchSeatToRaise, WHY.unreadSeatFirst, WHY.withdrawn, WHY.carriedOut, WHY.alreadyCounted, WHY.outrun,
  ],
  [SIGNER_ACT.rotate]: [...SEAT_WHY, WHY.notAVault, WHY.noPerson],
  [SIGNER_ACT.repair]: [...SEAT_WHY, WHY.notRotated, WHY.waits, WHY.notThisSeat, WHY.notNeeded, WHY.notRepaired],
  [SIGNER_ACT.withdraw]: [...SEAT_WHY, WHY.notASigner, WHY.noOpening, WHY.withheld, WHY.chainUnread, WHY.mayNot, WHY.removalRefused, WHY.notWithdrawn],
  [SIGNER_ACT.reissue]: [...SEAT_WHY, WHY.notASeat, WHY.noOpening, WHY.withheld, WHY.notRead, WHY.notMade, WHY.removalRefused],
  [SIGNER_ACT.addByCode]: [...SEAT_WHY, WHY.notACode, WHY.noRole, WHY.noOpening, WHY.notTaken, WHY.notMade, WHY.removalRefused],
  [SIGNER_ACT.raise]: [
    ...SEAT_WHY, WHY.notASigner, WHY.noOpening, WHY.notWaiting, WHY.notOpened, WHY.noScope, WHY.mayNot, WHY.notRaised, WHY.mayBeSent, WHY.filedNotEntered,
  ],
};

/** Stops after which part of the act may already have gone through, so the press is offered again rather than told as nothing done. */
const PARTLY: Readonly<Record<SignerAct, ReadonlySet<SignerWhy>>> = {
  [SIGNER_ACT.approve]: new Set<SignerWhy>([WHY.mayBeSent, WHY.stopped, WHY.other]),
  [SIGNER_ACT.admit]: new Set<SignerWhy>([WHY.filedNotEntered, WHY.stopped, WHY.other]),
  [SIGNER_ACT.giveKeys]: new Set<SignerWhy>([WHY.entryNotFiled, WHY.stopped, WHY.other]),
  [SIGNER_ACT.remove]: new Set<SignerWhy>([WHY.mayBeSent, WHY.notCarried, WHY.stopped, WHY.other]),
  [SIGNER_ACT.rotate]: new Set<SignerWhy>([WHY.stopped, WHY.other]),
  [SIGNER_ACT.repair]: new Set<SignerWhy>([WHY.notRepaired, WHY.stopped, WHY.other]),
  [SIGNER_ACT.withdraw]: new Set<SignerWhy>([WHY.stopped, WHY.other]),
  [SIGNER_ACT.reissue]: new Set<SignerWhy>([WHY.stopped, WHY.other]),
  [SIGNER_ACT.addByCode]: new Set<SignerWhy>([WHY.stopped, WHY.other]),
  [SIGNER_ACT.raise]: new Set<SignerWhy>([WHY.mayBeSent, WHY.filedNotEntered, WHY.stopped, WHY.other]),
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
  | { readonly of: typeof SIGNER_ACTED.done; readonly state: string | null; readonly removal?: RemovalTold; readonly vaults?: VaultsChangedTold; readonly repair?: { readonly epoch: number | null; readonly upkeep: string | null }; readonly signer?: string }
  | { readonly of: typeof SIGNER_ACTED.stopped; readonly act: SignerAct; readonly why: SignerWhy; readonly partial: boolean; readonly handedOver: boolean; readonly code?: string }
  | { readonly of: typeof SIGNER_ACTED.refused; readonly why: ActRefusal };

/** The names of what the wallet tells the page of where an act got to, besides that it is done. */
export const OUTCOME = { state: 'state', retirementSigned: 'retirementSigned', retirementNeeded: 'retirementNeeded', upkeep: 'upkeep', epoch: 'epoch', signer: 'signer' } as const;

/** Where a removal can stand when the wallet tells it, and the codes it gives for the change of the company's key and of the vault secrets after one. */
export const REMOVAL_STATE = { waiting: 'waiting-for-approvals', ready: 'ready-to-carry', retirement: 'waiting-for-the-retirement', carried: 'carried-out' } as const;
export const ROTATION = ['rotated', 'filed-not-anchored', 'rotated-elsewhere', 'not-needed', 'waits', 'not-this-seat', 'not-rotated', 'not-tried'] as const;
export const VAULT_SECRETS_NOT_STARTED = 'not-started';
/** What the wallet told of a removal: its approvals and bar, the signatures on the leaving seat's retirement and the number it needs (only while the removal waits on it), the company key's change (a code), and the vault secrets' (a code, or how many vaults ended in each state). */
export interface RemovalTold {
  readonly approvals: number | null; readonly needed: number | null; readonly rotation: string | null; readonly vaultSecrets: string | null; readonly vaultSecretsWhy: string | null; readonly vaults: VaultsTold | null;
  readonly retirementSigned: number | null; readonly retirementNeeded: number | null;
}
/** What the wallet told of the vault secrets' change: how many vaults ended in each state. */
export interface VaultsChangedTold { readonly vaults: VaultsTold | null }

/** The code the wallet gives when the chain no longer holds the seat and this device keeps no retirement to file: nothing was sent. */
export const NO_RETIREMENT_TO_FILE = 'no-retirement-to-file';
export const UPKEEP_PARTIAL = 'partial';

const countTold = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const refused = (why: ActRefusal): SignerActed => ({ of: SIGNER_ACTED.refused, why });

type Ended = Awaited<ReturnType<typeof approveSignerInTheWallet>>;
function actedOf(act: SignerAct, ended: Ended): SignerActed {
  if (ended.of === SIGNER_ACTED.done) {
    if (act === SIGNER_ACT.remove) {
      const { state, ...told } = removalOutcomeOf(ended);
      const removal: RemovalTold = {
        ...told, retirementSigned: countTold(ended.outcome?.[OUTCOME.retirementSigned]), retirementNeeded: countTold(ended.outcome?.[OUTCOME.retirementNeeded]),
      };
      return { of: SIGNER_ACTED.done, state, removal };
    }
    if (act === SIGNER_ACT.rotate) {
      const { state, vaults } = rotationOutcomeOf(ended);
      return { of: SIGNER_ACTED.done, state, vaults: { vaults } };
    }
    const state = ended.outcome?.[OUTCOME.state];
    if (act === SIGNER_ACT.repair) {
      const upkeep = ended.outcome?.[OUTCOME.upkeep];
      return { of: SIGNER_ACTED.done, state: typeof state === 'string' ? state : null, repair: { epoch: countTold(ended.outcome?.[OUTCOME.epoch]), upkeep: typeof upkeep === 'string' ? upkeep : null } };
    }
    const signer = ended.outcome?.[OUTCOME.signer];
    return { of: SIGNER_ACTED.done, state: typeof state === 'string' ? state : null, ...(typeof signer === 'string' ? { signer } : {}) };
  }
  const why = whyOf(act, ended.refused);
  return {
    of: SIGNER_ACTED.stopped, act, why, partial: PARTLY[act].has(why), handedOver: ended.relayed > 0 || ended.unconfirmed > 0,
    ...(ended.code === undefined ? {} : { code: ended.code }),
  };
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

/**
 * Asks the wallet to remove the signer whose seat is `leaf` (as the company's list names it), at `threshold` approvals afterwards
 * where one is given. The wallet reads whose seat it is from the company's list, shows it for the person to confirm, raises the
 * removal and carries it out once the network counts the approvals it needs; the page names the seat and nothing more.
 */
export async function removeSigner(
  personId: string, companyId: string, signer: { readonly leaf: string; readonly threshold?: number }, onStep?: (step: number, steps: number) => void,
): Promise<SignerActed> {
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await removeSignerInTheWallet({ ...named, leaf: signer.leaf, ...(signer.threshold === undefined ? {} : { threshold: signer.threshold }) },
      ACCOUNT_ORIGIN, onStep === undefined ? {} : { onStep: (at) => onStep(at.step, at.steps) });
    return actedOf(SIGNER_ACT.remove, ended);
  } catch (e) {
    return refused(refusalOf(e));
  }
}

/** Asks the wallet, from a signer who stays, to change the secret of every vault whose change a removal left owed. */
export async function changeVaultSecrets(personId: string, companyId: string, onStep?: (step: number, steps: number) => void): Promise<SignerActed> {
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await rotateVaultSecretsInTheWallet(named, ACCOUNT_ORIGIN, onStep === undefined ? {} : { onStep: (at) => onStep(at.step, at.steps) });
    return actedOf(SIGNER_ACT.rotate, ended);
  } catch (e) {
    return refused(refusalOf(e));
  }
}


/** Asks the wallet to repair the company's key from this seat. The wallet refuses a seat that does not hold the newest key, one whose role files no proposal, and a repair that waits on a removal's own change of key; each refusal reaches the page as a code. */
export async function repairCompanyKey(personId: string, companyId: string, onStep?: (step: number, steps: number) => void): Promise<SignerActed> {
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await actOnACompanyInTheWallet({ name: SIGNER_ACT.repair, ...named }, ACCOUNT_ORIGIN, onStep === undefined ? {} : { onStep: (at) => onStep(at.step, at.steps) });
    return actedOf(SIGNER_ACT.repair, ended);
  } catch (e) {
    return refused(refusalOf(e));
  }
}


/** Whether this seat is one that repairs the company's key: on the chain, not leaving, a role that may invite and holding the newest key. False when any of it cannot be read, so a repair is never offered on a guess; the wallet checks again before it files anything. */
export async function repairIsOffered(personId: string, companyId: string): Promise<boolean> {
  try {
    const here = await seatAndRecordsHere(personId, companyId);
    if (typeof here === 'string') return false;
    const { dir, holders } = await here.directory();
    const own = dir.seats.find((s) => s.seat === here.leaf);
    return own !== undefined && own.retired === null && mayInvite(own) && holders.seats.some((s) => s.toLowerCase() === here.leaf.toLowerCase())
      && here.viewingKey.epoch === here.viewingKey.newest;
  } catch {
    /* A read that fails offers nothing: ignoring it is safe because the repair is then simply not shown, and the wallet checks the seat again before it files anything. */
    return false;
  }
}

/** Runs one act on a person waiting for a seat, or adding one, with these fields, and reads how it ended. */
async function onAWaitingSigner(
  act: SignerAct, personId: string, companyId: string, fields: Readonly<Record<string, string>>, onStep?: (step: number, steps: number) => void,
): Promise<SignerActed> {
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await actOnACompanyInTheWallet({ name: act, ...named, ...fields }, ACCOUNT_ORIGIN,
      onStep === undefined ? {} : { onStep: (at) => onStep(at.step, at.steps) });
    return actedOf(act, ended);
  } catch (e) {
    return refused(refusalOf(e));
  }
}

/**
 * **WITHDRAWS A PERSON WAITING FOR A SEAT**, from the person's wallet: their request is let go and their invitation's link
 * reads as withdrawn, once the wallet reads on the chain itself that no proposal could still seat them.
 */
export const withdrawWaitingSigner = (personId: string, companyId: string, signer: { readonly id: string; readonly name: string }, onStep?: (step: number, steps: number) => void): Promise<SignerActed> =>
  onAWaitingSigner(SIGNER_ACT.withdraw, personId, companyId, { signer: signer.id, personName: signer.name }, onStep);

/** **SENDS A SEATED SIGNER'S INVITATION AGAIN**, from the person's wallet, which shows the new link in its own window only. */
export const reissueInvitation = (personId: string, companyId: string, signer: { readonly leaf: string; readonly name: string }, onStep?: (step: number, steps: number) => void): Promise<SignerActed> =>
  onAWaitingSigner(SIGNER_ACT.reissue, personId, companyId, { leaf: signer.leaf.toLowerCase(), personName: signer.name }, onStep);

/** A code's seat is made for every right on every vault, so the person is added as an admin, the one role that holds them. */
const ROLE_OF_A_CODE = 'admin';

/** **ADDS A SIGNER FROM THE CODE THEIR OWN WALLET MADE**, as an admin: the wallet files their request and tells its id. */
export const addSignerByCode = (personId: string, companyId: string, asked: { readonly code: string; readonly name: string }, onStep?: (step: number, steps: number) => void): Promise<SignerActed> =>
  onAWaitingSigner(SIGNER_ACT.addByCode, personId, companyId, { code: asked.code.trim(), personName: asked.name, role: ROLE_OF_A_CODE }, onStep);

/** **PROPOSES THE SEAT OF A PERSON WAITING WHO JOINED BY A CODE**, once the fingerprint they read out is the one their request makes. */
export const raiseWaitingSigner = (personId: string, companyId: string, signer: { readonly id: string; readonly name: string; readonly readOut: string }, onStep?: (step: number, steps: number) => void): Promise<SignerActed> =>
  onAWaitingSigner(SIGNER_ACT.raise, personId, companyId, { signer: signer.id, personName: signer.name, readOut: signer.readOut.trim() }, onStep);

