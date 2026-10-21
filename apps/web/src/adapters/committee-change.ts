import {
  COMMITTEE_CHANGE_REFUSAL, committeeChangeRefusal, signCommitteeChangeOnDevice, type CommitteeChangeView, type CommitteeTarget,
} from 'vaults-web-shared/committee-change-on-device.js';
import {
  api, canOpenCompanies, companyKeysForVaults, holdersFromTheWallet, openKeysWithWallet, signCommitteeChangeFromTheWallet,
} from 'vaults-web-shared/keyring.js';
import { companyRoute, SERVICE } from './handover-state.js';
import { keyringFor } from './keyring-person.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';

/*
 * A SUPER ADMIN SIGNS A CHANGE (`signChange`), when a contract does not hold
 * the committee the company's account holds on the chain. The super admins -
 * each a key on the account's committee as their own wallet reads it - who
 * hold each contract now sign the change in their own accounts
 * (`signCommitteeChangeOnDevice`), the service keeps the signatures, and this
 * device asks it to send each contract once the kept signatures reach that
 * contract's threshold. No roster, seat, signer key or vault-key offer is read
 * for it, so a person with no seat signs as any super admin does.
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

/** The committee key this person's account gives for the company. */
const committeeKeyFor = async (companyId: string): Promise<Key> => (await companyKeysForVaults(companyId, ACCOUNT_ORIGIN)).committeeKey;

/**
 * SIGN THE CHANGE that brings the company's contracts to the committee holding its account, on every contract whose
 * current committee holds this person's wallet key. Their standing is that key on the account's committee as their own
 * wallet reads it; no seat, roster or vault-key offer is read.
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
      return refused(check.code === COMMITTEE_CHANGE_REFUSAL.nothingToSign ? ACT_REFUSAL.nothingToSign : ACT_REFUSAL.committeeDisagrees);
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
