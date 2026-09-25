/**
 * **WHAT A SIGNER'S OWN DEVICE CHECKS BEFORE IT HANDS ANYTHING TO A COMMITTEE,
 * OR WRAPS A VAULT'S SECRET TO A RECORDS KEY.** Kept apart from the screen so
 * the same checks can be read and driven without one.
 *
 * **THE SEALED ROSTER IS THE ONLY AUTHORITY ON WHICH KEY IS WHOSE.** Every
 * seated signer's committee key and records key are kept in their own roster
 * entry, signed with that entry's signing key, and this device opens the roster
 * itself. So a committee or a records key the service reports is accepted only
 * if the roster names it for a seated signer, and a key that signer's own seat
 * did not sign - one another member put in their name, or one the service
 * reports without touching the roster - is refused before anything is built.
 * **A party holding the viewing key can rewrite the roster itself**, and a
 * roster rewritten whole passes these checks: they make the roster the one
 * authority, and do not make the roster tamper-proof.
 */
import type { Account } from '../core/types.js';
import {
  rosterVaultKeys, whyNotTheRostersCommittee, whyNotTheRostersReaders, type RosterVaultKeys,
} from '../core/vault-keys.js';
import type { Hex } from '../core/crypto.js';

type Key = { tag: string; value: string };

/** The part of the service's answer about a company's authority that this check reads. */
export interface HandoverView {
  readonly committee: { readonly committee: readonly Key[]; readonly threshold: number } | null;
  readonly why: string | null;
  readonly contracts: readonly { readonly seats: readonly { readonly key: Key }[] }[];
}

const same = (a: Key, b: Key) => a.tag.toLowerCase() === b.tag.toLowerCase() && a.value.toLowerCase() === b.value.toLowerCase();

/** The roster this device opened, as the vault keys it names. */
export type Roster = Pick<Account, 'id' | 'signers'>;

/**
 * **WHY THE COMPANY ACCOUNT IS NOT HANDED TO THE COMMITTEE THE SERVICE REPORTS**,
 * or null when it may be. The committee must be exactly the keys the roster
 * names, one per seated signer; this person's own roster entry must carry the
 * key their wallet gives for this company; and the committee must carry it.
 */
export function whyNotHandOver(view: HandoverView, mine: Key, roster: Roster, me: { signerId: string }): string | null {
  if (view.committee === null) return view.why ?? 'this company has no committee yet.';
  const named = rosterVaultKeys(roster);
  const refused = whyNotTheRostersCommittee(view.committee.committee, named);
  if (refused !== null) return `${refused} The account is not handed to it from here.`;
  const myEntry = named.find((r) => r.signerId === me.signerId);
  if (!myEntry?.keys || !same(myEntry.keys.committeeKey, mine)) {
    return 'the company\'s roster does not carry the key your wallet gives for this company as yours: your vault keys '
      + 'were set up from a different wallet, or not yet. Open the company with that wallet, or set them up from '
      + 'Vaults. The account is not handed over from here.';
  }
  if (!view.committee.committee.some((k) => same(k, mine))) {
    return 'the committee this service reports does not carry the key your wallet gives for this company, so the '
      + 'account is not handed to it from here.';
  }
  return null;
}

/** The committee as the roster names it, or the reason it cannot be used. */
export const whyNotTheCommittee = (committee: readonly Key[], roster: Roster): string | null =>
  whyNotTheRostersCommittee(committee, rosterVaultKeys(roster));

/**
 * Whether the records keys the service reports are the roster's: none it does
 * not name, and, when the committee is complete, none it names left out.
 */
export const whyNotTheReaders = (readers: readonly Hex[], roster: Roster, complete = true): string | null =>
  whyNotTheRostersReaders(readers, rosterVaultKeys(roster), { complete });

/**
 * **WHOSE KEY A SEAT HOLDS, FROM THE ROSTER THIS DEVICE OPENED**, or null when
 * the roster names nobody for it. The service does not say, because it keeps
 * no record of whose each key is.
 */
export function holderOf(key: Key, roster: Roster): RosterVaultKeys | null {
  return rosterVaultKeys(roster).find((r) => r.keys !== null && same(r.keys.committeeKey, key)) ?? null;
}
