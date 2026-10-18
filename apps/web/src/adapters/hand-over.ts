import type { SealedAccount } from '../../../../src/core/types.js';
import type { BelievedAccount } from 'vaults-web-shared/roster-here.js';
import {
  COMMITTEE_CHANGE_REFUSAL, committeeChangeRefusal, signCommitteeChangeOnDevice, type CommitteeChangeView, type CommitteeTarget,
} from 'vaults-web-shared/committee-change-on-device.js';
import {
  api, canOpenCompanies, companyKeysForVaults, holdersFromTheWallet, openKeysWithWallet, signCommitteeChangeFromTheWallet,
  type AccountKeys,
} from 'vaults-web-shared/keyring.js';
import { companyRoute, SERVICE } from './handover-state.js';
import { keyringFor, keysOnTheWayIn } from './keyring-person.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { Fault, FAULT } from '../faults.js';
import { giveTheVaultKeys } from './vault-keys.js';
import { companyKeysFor, openedHere } from './filing-judge.js';
import type { CompanyKeyHere } from 'vaults-web-shared/company-key-here.js';

/*
 * TWO PRESSES FOR A COMPANY, EACH ITS OWN SYSTEM, NEITHER WAITING ON THE OTHER.
 *
 * - A SIGNER GIVES THEIR VAULT KEYS (`giveMyVaultKeys`): their keys, from their
 *   own account, sealed and offered, then folded into their own entry of the
 *   roster by a seat the company believes (`offerVaultKeysHere`,
 *   `foldOffersHere`). They decide who a vault's secret is sealed to, never who
 *   holds the company's contracts.
 * - A SUPER ADMIN SIGNS A CHANGE (`signChange`), when a contract does not hold
 *   the committee the company's account holds on the chain. The super admins -
 *   each a key on the account's committee as their own wallet reads it - who
 *   hold each contract now sign the change in their own accounts
 *   (`signCommitteeChangeOnDevice`), the service keeps the signatures, and this
 *   device asks it to send each contract once the kept signatures reach that
 *   contract's threshold. No roster, seat, signer key or vault-key offer is read
 *   for it, so a person with no seat signs as any super admin does.
 *
 * Nothing here decides anything the shared steps do not: a check that refuses
 * is a refusal here, in a fixed reason, and its words are never handed on.
 */

export type Acted = { of: typeof ACTED.done } | { of: typeof ACTED.refused; why: ActRefusal };

type Key = { tag: string; value: string };

const refused = (why: ActRefusal): Acted => ({ of: ACTED.refused, why });

/**
 * WHY NOTHING IS DONE FOR THIS PERSON FROM THIS PAGE, or null when they are
 * signed in on a page set up with an account to sign with. Nothing of any
 * company is read.
 */
async function signedInHere(personId: string): Promise<ActRefusal | null> {
  if (ACCOUNT_ORIGIN === '') return ACT_REFUSAL.notSetUp;
  if (!(await keyringFor(personId))) return ACT_REFUSAL.notSignedIn;
  return null;
}

/**
 * THIS PERSON'S KEYS FOR THE COMPANY, AND THE COMPANY AS THIS DEVICE OPENS IT.
 * The keys saved for this person are opened with their account when this tab
 * has not opened them yet, read again when they do not hold this company, and
 * a seat this device did not finish is finished first. Only a signer's own
 * steps need these; the super admins' steps never do.
 */
async function opened(personId: string, companyId: string): Promise<{ keys: AccountKeys; roster: () => Promise<BelievedAccount>; viewingKey: CompanyKeyHere } | ActRefusal> {
  const notHere = await signedInHere(personId);
  if (notHere !== null) return notHere;
  if (!canOpenCompanies()) await openKeysWithWallet(ACCOUNT_ORIGIN);
  const keys = await keysOnTheWayIn(companyId, async () => await api(companyRoute(companyId)) as SealedAccount);
  if (keys === null) return ACT_REFUSAL.noKeysHere;
  const sealed = await api(companyRoute(companyId));
  const roster = async () => {
    const account = await openedHere(await api(companyRoute(companyId)) as SealedAccount);
    /* The keys for this company were found just above, so it opens; a company that does not is a fault in this code. */
    if (account === null) throw new Fault(FAULT.companyDidNotOpen);
    return account;
  };
  return { keys, roster, viewingKey: await companyKeysFor(companyId, sealed as SealedAccount, keys) };
}

/** The committee key this person's account gives for the company. */
const committeeKeyFor = async (companyId: string): Promise<Key> => (await companyKeysForVaults(companyId, ACCOUNT_ORIGIN)).committeeKey;

/** GIVE THIS PERSON'S VAULT KEYS for the company: sealed and offered, kept for this person's own claim on their seat. */
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

/**
 * SIGN THE CHANGE that brings the company's contracts to the committee holding its account, on every contract this
 * person holds a seat on. Their standing is their own wallet key on the account's committee as that wallet reads it;
 * no company keys of a signer, no roster and no vault-key offer are read.
 */
export async function signChange(personId: string, companyId: string): Promise<Acted> {
  try {
    const notHere = await signedInHere(personId);
    if (notHere !== null) return refused(notHere);
    /* The page's saved keys are opened so this person's wallet can be asked for its key for the company. */
    if (!canOpenCompanies()) await openKeysWithWallet(ACCOUNT_ORIGIN);
    const view = async () => await api(companyRoute(companyId, SERVICE.change)) as CommitteeChangeView;
    /*
     * The shared step's own check, asked first so that a refusal comes back as
     * a refusal rather than a thrown error; the step asks it again before the
     * account is asked to sign. "Nothing to sign" is told from the other
     * refusals by the code the check gives, never by its sentence.
     */
    const released = await companyKeysForVaults(companyId, ACCOUNT_ORIGIN);
    /*
     * The committee a change may install is the one holding the company's account on the chain, as this person's own
     * wallet reads it, and never one made from the signers or the roster. No change of the super admins in progress
     * is read here, so the account's committee is the only target.
     */
    const targetNow = async (): Promise<CommitteeTarget> => {
      const { holders } = await holdersFromTheWallet(ACCOUNT_ORIGIN, { company: released.company, account: released.account });
      return { account: { committee: holders.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: holders.threshold }, inProgress: null };
    };
    const [now, mine, target] = [await view(), released.committeeKey, await targetNow()];
    const check = committeeChangeRefusal(now, mine, target);
    if (check !== null) {
      return refused(check.code === COMMITTEE_CHANGE_REFUSAL.nothingToSign ? ACT_REFUSAL.nothingToSign : ACT_REFUSAL.rosterDisagrees);
    }
    await signCommitteeChangeOnDevice({
      view,
      walletKey: () => committeeKeyFor(companyId),
      target: targetNow,
      askWallet: (ask) => signCommitteeChangeFromTheWallet(ACCOUNT_ORIGIN, ask),
      send: async (body) => await api(companyRoute(companyId, SERVICE.signatures), { method: SERVICE.post, body: JSON.stringify(body) }),
      sendNow: async (update) => await api(companyRoute(companyId, SERVICE.send), { method: SERVICE.post, body: JSON.stringify(update) }),
    });
    return { of: ACTED.done };
  } catch (e) {
    return refused(refusalOf(e));
  }
}
