import type { SealedAccount } from '../../../../src/core/types.js';
import type { Hex } from '../../../../src/core/crypto.js';
import {
  api, canOpenCompanies, currentUser, directoryEntryOwed, finishPendingSeat, forgetLocally, keysFor, pendingSeatsFor, reopenSavedKeys, resumeSession,
  type AccountKeys,
} from 'vaults-web-shared/keyring.js';
import { fileTheOwedDirectoryEntry } from 'vaults-web-shared/vault-page-doors.js';
import { fileTheRosterFollowedHere } from 'vaults-web-shared/roster-here.js';
import { recordsEnteredOver } from 'vaults-web-shared/record-entered-here.js';
import { sealPoliciesToNewSignersHere, type PolicyResealDoors } from 'vaults-web-shared/spending-policy-here.js';
import { rotateTheCompanyKeyHere } from 'vaults-web-shared/company-key-here.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { companyKeysFor, rosterReadsFor, rotationDoorsFor } from './filing-judge.js';
import type { CompanyKeys } from '../../../../src/core/company-key.js';
import { readSignIn } from './kept-sign-in.js';
import { tabStorage } from './kept-skips.js';

/*
 * THE SHARED KEYRING, BROUGHT TO THE PERSON SIGNED IN IN THIS TAB.
 *
 * Creating a company, opening one and handing one over are the keyring's
 * work, and it acts only for the person it knows. After a sign-in in this tab
 * it knows them already (`session.ts` hands it the answer). After a reload it
 * knows nobody, and picks the sign-in up from the service, which asks the
 * person nothing. The service does not say again which address the sign-in
 * was for, so the address kept in this tab at the sign-in (`kept-sign-in.ts`)
 * is handed back with it, and the keyring takes it only for the person the
 * service names: a person with nothing saved yet can then create their first
 * company without signing in again. A keyring that knows somebody else
 * forgets them first.
 */

/** Whether the keyring now acts for `personId`: true, or false when the service says somebody else, or nobody, is signed in. It throws when the service cannot be asked. */
export async function keyringFor(personId: string): Promise<boolean> {
  if (currentUser()?.id === personId) return true;
  forgetLocally();
  await resumeSession(readSignIn(tabStorage()));
  return currentUser()?.id === personId;
}

/**
 * THIS PERSON'S KEYS FOR THE COMPANY `companyId`, found on the way into it as
 * the legacy page finds them: keys saved in another tab since this one opened
 * them are read first, and a seat this device published and did not finish
 * saving is finished before anything asks for the company's keys. Nothing to
 * finish is the ordinary case: the company's record is not asked for and
 * nothing is written. A directory entry this person's wallet signed and the
 * directory did not take yet is filed again (`fileTheOwedDirectoryEntry`),
 * sealed with the company's key once this device can open it; a refusal
 * leaves it owed and stops nothing. Where this device holds keys, the
 * company's key is changed from here when a signer's removal is carried out
 * and no change of the key has followed it (`rotateOnTheWayIn`), a roster
 * version every device refuses is followed from here
 * (`followTheRosterOnTheWayIn`), and every spending policy in force is sealed
 * to the signers seated since it was set (`sealPoliciesOnTheWayIn`), where the
 * page hands over what reading the policies needs (`policies`). Null when
 * this device holds no keys for the company.
 */
export async function keysOnTheWayIn(
  companyId: string, sealed: () => Promise<SealedAccount>,
  policies?: (keys: AccountKeys) => Promise<PolicyResealDoors | null>,
): Promise<AccountKeys | null> {
  if (keysFor(companyId) === null && canOpenCompanies()) await reopenSavedKeys();
  if (pendingSeatsFor(companyId).length > 0) await finishPendingSeat(companyId, await sealed());
  const owed = directoryEntryOwed(companyId);
  if (owed.read() !== null) await fileTheOwedDirectoryEntry(api, companyId, owed, ownKeysFor(companyId, sealed), foundingSeatFor(companyId, sealed));
  const keys = keysFor(companyId);
  if (keys !== null) await rotateOnTheWayIn(companyId, sealed, keys);
  if (keys !== null) await followTheRosterOnTheWayIn(companyId, sealed, keys);
  if (keys !== null && policies !== undefined) await sealPoliciesOnTheWayIn(keys, policies);
  return keys;
}

/**
 * **THE COMPANY'S KEY CHANGED ON THE WAY INTO THE COMPANY** (`rotateTheCompanyKeyHere`)
 * by any staying seat whose role may file a proposal, once a signer's removal
 * is carried out on the chain and anchored, so no one device is needed for
 * it. A read, a refusal or a filing that fails stops nothing: the next way in
 * tries again.
 */
const rotateOnTheWayIn = async (companyId: string, sealed: () => Promise<SealedAccount>, keys: AccountKeys): Promise<void> => {
  try {
    const doors = await rotationDoorsFor(companyId, sealed, keys);
    if (doors !== null) await rotateTheCompanyKeyHere(doors);
  } catch {
    /* Not changed now: the next way in reads it again. */
  }
};

/**
 * **EVERY SPENDING POLICY IN FORCE, SEALED TO THE SIGNERS SEATED SINCE, ON THE
 * WAY INTO THE COMPANY** (`sealPoliciesToNewSignersHere`): the same opening
 * filed again, so the chain's commitment and each vault's period total do not
 * change. Only a seat that may file a spending policy and can open the policy
 * in force files anything. A read or a filing that fails stops nothing: the
 * next way in tries again.
 */
const sealPoliciesOnTheWayIn = async (keys: AccountKeys, policies: (keys: AccountKeys) => Promise<PolicyResealDoors | null>): Promise<void> => {
  try {
    const doors = await policies(keys);
    if (doors !== null) await sealPoliciesToNewSignersHere(doors);
  } catch {
    /* Not sealed now: the next way in reads it again. */
  }
};

/**
 * **A ROSTER VERSION EVERY DEVICE REFUSES, FOLLOWED ON THE WAY INTO THE
 * COMPANY** (`fileTheRosterFollowedHere`): the one door out of a roster nobody
 * believes when nobody is waiting for a seat and no vault keys are offered. It
 * reads the roster once, and files only where the newest version is refused
 * for who filed it or for a signer it leaves out, and this seat may file a
 * roster. A read or a filing that fails stops nothing: the company opens as it
 * reads.
 */
const followTheRosterOnTheWayIn = async (companyId: string, sealed: () => Promise<SealedAccount>, keys: AccountKeys): Promise<void> => {
  try {
    const rec = await sealed();
    if (typeof rec.companyLabel !== 'string' || typeof rec.contractAddress !== 'string') return;
    const label = rec.companyLabel as CompanyLabel;
    const account = rec.contractAddress as AccountAddress;
    await fileTheRosterFollowedHere({
      api, accountId: companyId, viewingKey: await companyKeysFor(companyId, rec, keys), signingSecret: keys.signingSecret, label, account,
      reads: rosterReadsFor(companyId, label, account), entered: recordsEnteredOver(api, companyId, keys.signingSecret),
    });
  } catch {
    /* Not followed now: the next way in reads it again. */
  }
};

/** The seat the company's account was deployed with, as the person's own wallet reads it; null where it cannot be read. */
const foundingSeatFor = (companyId: string, sealed: () => Promise<SealedAccount>) => async (): Promise<string | null> => {
  const rec = await sealed();
  if (typeof rec.companyLabel !== 'string' || typeof rec.contractAddress !== 'string') return null;
  return (await rosterReadsFor(companyId, rec.companyLabel as CompanyLabel, rec.contractAddress as AccountAddress).holders()).founding ?? null;
};

/** This device's filing key for the company and the company's keys its directory gives, or null while it cannot open the company's key. */
const ownKeysFor = (companyId: string, sealed: () => Promise<SealedAccount>) => async (): Promise<{ signingSecret: Hex; viewingKey: CompanyKeys } | null> => {
  const keys = keysFor(companyId);
  if (keys === null) return null;
  try {
    return { signingSecret: keys.signingSecret as Hex, viewingKey: await companyKeysFor(companyId, await sealed(), keys) };
  } catch {
    return null;
  }
};
