import type { SealedAccount } from '../../../../src/core/types.js';
import { whyNotHandOver } from 'vaults-web-shared/handover-check.js';
import {
  COMMITTEE_CHANGE_REFUSAL, committeeChangeRefusal, signCommitteeChangeOnDevice, type CommitteeChangeView,
} from 'vaults-web-shared/committee-change-on-device.js';
import {
  api, canOpenCompanies, companyKeysForVaults, openAccount, openKeysWithWallet, signCommitteeChangeFromTheWallet, viewingKeyFor,
  type AccountKeys,
} from 'vaults-web-shared/keyring.js';
import { companyRoute, SERVICE } from './handover-state.js';
import { keyringFor, keysOnTheWayIn } from './keyring-person.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { Fault, FAULT } from '../faults.js';
import { giveTheVaultKeys } from './vault-keys.js';

/*
 * HANDING A COMPANY TO ITS COMMITTEE, OVER THE SHARED STEPS, IN THEIR ORDER.
 *
 * 1. EVERY SIGNER GIVES THEIR VAULT KEYS. The committee is one key per
 *    signer, each from that signer's own account, written into their own
 *    entry of the sealed roster and signed there (`giveVaultKeys`). This
 *    person gives theirs here; the others give theirs from their own devices.
 * 2. THE HANDOVER. The service's answer is read afresh, and this device checks
 *    the committee it names against the roster it opens itself, and that this
 *    person's own entry carries the key their account gives
 *    (`whyNotHandOver`). Only then is the service asked to hand the company
 *    account to exactly that committee.
 * 3. A CHANGE, when the committee has changed since. The signers who hold
 *    each contract now sign the change in their own accounts
 *    (`signCommitteeChangeOnDevice`), and the service sends it once enough
 *    have.
 *
 * Nothing here decides anything the shared steps do not: a check that refuses
 * is a refusal here, in a fixed reason, and its words are never handed on.
 */

export type Acted = { of: typeof ACTED.done } | { of: typeof ACTED.refused; why: ActRefusal };

type Key = { tag: string; value: string };

const refused = (why: ActRefusal): Acted => ({ of: ACTED.refused, why });

/**
 * THIS PERSON'S KEYS FOR THE COMPANY, AND THE COMPANY AS THIS DEVICE OPENS IT.
 * The keys saved for this person are opened with their account when this tab
 * has not opened them yet, read again when they do not hold this company, and
 * a seat this device did not finish is finished first.
 */
async function opened(personId: string, companyId: string): Promise<{ keys: AccountKeys; roster: () => Promise<NonNullable<ReturnType<typeof openAccount>>>; viewingKey: ReturnType<typeof viewingKeyFor> } | ActRefusal> {
  if (ACCOUNT_ORIGIN === '') return ACT_REFUSAL.notSetUp;
  if (!(await keyringFor(personId))) return ACT_REFUSAL.notSignedIn;
  if (!canOpenCompanies()) await openKeysWithWallet(ACCOUNT_ORIGIN);
  const keys = await keysOnTheWayIn(companyId, async () => await api(companyRoute(companyId)) as SealedAccount);
  if (keys === null) return ACT_REFUSAL.noKeysHere;
  const sealed = await api(companyRoute(companyId));
  const roster = async () => {
    const account = openAccount(await api(companyRoute(companyId)));
    /* The keys for this company were found just above, so it opens; a company that does not is a fault in this code. */
    if (account === null) throw new Fault(FAULT.companyDidNotOpen);
    return account;
  };
  return { keys, roster, viewingKey: viewingKeyFor(sealed) };
}

/** The committee key this person's account gives for the company. */
const committeeKeyFor = async (companyId: string): Promise<Key> => (await companyKeysForVaults(companyId, ACCOUNT_ORIGIN)).committeeKey;

/** GIVE THIS PERSON'S VAULT KEYS for the company. The service keeps the first set a signer gives. */
export async function giveMyVaultKeys(personId: string, companyId: string): Promise<Acted> {
  try {
    const o = await opened(personId, companyId);
    if (typeof o === 'string') return refused(o);
    const given = await giveTheVaultKeys(companyId, o.keys, o.viewingKey, o.roster);
    if (given.of === ACTED.refused) return refused(given.why);
    return { of: ACTED.done };
  } catch (e) {
    return refused(refusalOf(e));
  }
}

/** HAND THE COMPANY ACCOUNT TO THE COMMITTEE this device has checked against its own roster. */
export async function handOver(personId: string, companyId: string): Promise<Acted> {
  try {
    const o = await opened(personId, companyId);
    if (typeof o === 'string') return refused(o);
    const fresh = await api(companyRoute(companyId, SERVICE.authority));
    if (whyNotHandOver(fresh, await committeeKeyFor(companyId), await o.roster(), { signerId: o.keys.signerId }) !== null) {
      return refused(ACT_REFUSAL.rosterDisagrees);
    }
    /* The committee checked here is the one sent, and the service installs only that one. */
    await api(companyRoute(companyId, SERVICE.handover), { method: SERVICE.post, body: JSON.stringify({ committee: fresh.committee }) });
    return { of: ACTED.done };
  } catch (e) {
    return refused(refusalOf(e));
  }
}

/** SIGN THE CHANGE that brings the company's contracts to its committee as it stands now, on every contract this person holds a seat on. */
export async function signChange(personId: string, companyId: string): Promise<Acted> {
  try {
    const o = await opened(personId, companyId);
    if (typeof o === 'string') return refused(o);
    const view = async () => await api(companyRoute(companyId, SERVICE.change)) as CommitteeChangeView;
    /*
     * The shared step's own check, asked first so that a refusal comes back as
     * a refusal rather than a thrown error; the step asks it again before the
     * account is asked to sign. "Nothing to sign" is told from the other
     * refusals by the code the check gives, never by its sentence.
     */
    const [now, mine, roster] = [await view(), await committeeKeyFor(companyId), await o.roster()];
    const me = { signerId: o.keys.signerId };
    const check = committeeChangeRefusal(now, mine, roster, me);
    if (check !== null) {
      return refused(check.code === COMMITTEE_CHANGE_REFUSAL.nothingToSign ? ACT_REFUSAL.nothingToSign : ACT_REFUSAL.rosterDisagrees);
    }
    await signCommitteeChangeOnDevice({
      view,
      walletKey: () => committeeKeyFor(companyId),
      roster: o.roster,
      askWallet: (ask) => signCommitteeChangeFromTheWallet(ACCOUNT_ORIGIN, ask),
      send: async (body) => await api(companyRoute(companyId, SERVICE.signatures), { method: SERVICE.post, body: JSON.stringify(body) }),
    }, me);
    return { of: ACTED.done };
  } catch (e) {
    return refused(refusalOf(e));
  }
}
