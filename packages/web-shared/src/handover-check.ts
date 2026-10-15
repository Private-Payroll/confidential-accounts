/**
 * **WHAT A SIGNER'S OWN DEVICE CHECKS BEFORE IT WRAPS A VAULT'S SECRET TO A
 * RECORDS KEY.** Kept apart from the screen so
 * the same checks can be read and driven without one.
 *
 * **THE SEALED ROSTER IS THE ONLY AUTHORITY ON WHICH RECORDS KEY IS WHOSE.**
 * Every seated signer's records key is kept in their own roster entry, signed
 * with that entry's signing key, and this device opens the roster itself. So a
 * records key the service reports is accepted only if the roster names it for
 * a seated signer. **A party holding the viewing key can rewrite the roster
 * itself**, and a roster rewritten whole passes these checks: they make the
 * roster the one authority, and do not make the roster tamper-proof.
 *
 * **THE COMMITTEE IS NEVER JUDGED BY THE ROSTER.** The committee is the super
 * admins' keys, the company's own choice: a key no signer holds, a board
 * member's say, is as good as any, so nothing here compares a committee with
 * the signers' keys.
 */
import type { Account } from '../../../src/core/types.js';
import { rosterVaultKeys, whyNotTheRostersReaders, type RosterVaultKeys } from '../../../src/core/vault-keys.js';
import type { Hex } from '../../../src/core/crypto.js';

type Key = { tag: string; value: string };

const same = (a: Key, b: Key) => a.tag.toLowerCase() === b.tag.toLowerCase() && a.value.toLowerCase() === b.value.toLowerCase();

/**
 * The roster this device opened, as the vault keys it names, with the seats
 * the chain holds that no entry it believes names (`rosterBelievedHere`).
 */
export type Roster = Pick<Account, 'id' | 'signers'> & { readonly notBelieved: readonly string[] };

/**
 * **WHY NOTHING IS BUILT FOR A COMMITTEE FROM THIS ROSTER**, or null when the
 * roster names a signer this device believes at every seat the chain holds. A
 * seat it does not is a signer left out of whatever would be built.
 */
export const whyNotWhole = (roster: Roster): string | null => {
  const n = roster.notBelieved.length;
  return n === 0 ? null
    : `the company's roster, as this device believes it, shows no signer for ${n} seat${n === 1 ? '' : 's'} the `
      + 'company\'s account holds on the chain, so nothing is built for a committee from it. Each signer without an '
      + 'entry opens the company on their own device and sets up their vault keys; if they have, reload the page.';
};

/**
 * Whether the records keys the service reports are the roster's: the roster
 * believed at every seat, none it does not name, and none it names left out.
 * Read from the signers' own roster alone, whatever holds the company's account.
 */
export const whyNotTheReaders = (readers: readonly Hex[], roster: Roster): string | null =>
  whyNotWhole(roster) ?? whyNotTheRostersReaders(readers, rosterVaultKeys(roster));

/**
 * **WHOSE KEY A SEAT HOLDS, FROM THE ROSTER THIS DEVICE OPENED**, or null when
 * the roster names nobody for it. The service does not say, because it keeps
 * no record of whose each key is.
 */
export function holderOf(key: Key, roster: Roster): RosterVaultKeys | null {
  return rosterVaultKeys(roster).find((r) => r.keys !== null && same(r.keys.committeeKey, key)) ?? null;
}
