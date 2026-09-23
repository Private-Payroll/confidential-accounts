/**
 * **A COMPANY VAULT'S COMMITTEE: WHO IS ON IT, AND THE ONE UPDATE THAT PUTS IT
 * THERE.**
 *
 * A vault's maintenance authority is a ledger field beside its state: a list of
 * signature keys and how many of them must sign a change to the vault's rules.
 * No circuit can read it, so no vault can refuse anything on the strength of
 * who holds it. What this product can do is make sure that the list is the
 * company's, and this file is the product's one statement of what "the
 * company's" means:
 *
 *   - one key per active signer of the company, each derived by that signer's
 *     own wallet (`midnight-identity/profile/committee-key`);
 *   - at the company's own approval threshold;
 *   - in one order, sorted by key, so the device that builds the update and the
 *     service that checks it compare one value and not two orderings of it.
 *
 * **A VAULT IS DEPLOYED WITH A TEMPORARY KEY AND THEN HANDED TO THIS
 * COMMITTEE.** A deploy and a maintenance update cannot share a transaction:
 * the update is checked against the chain as it stood before the transaction,
 * where the vault does not exist yet. So there are two transactions, at least
 * one block apart, and the temporary key is made on the device that deploys,
 * never leaves it, and signs exactly one update: this one.
 *
 * **THE RULE ABOUT WHICH COMMITTEE MAY BE INSTALLED IS NOT WRITTEN HERE.** It is
 * `authorityValueRefusals`, the refusal every replacement of a contract's
 * authority goes through, and the replacement itself is made by
 * `replaceAuthorityOf` and nowhere else. (An authority written at DEPLOY is
 * checked by `requireMaintenanceAuthority` instead.) What this file adds is only what is particular to a company:
 * every signer has given a key, and each key is one a wallet derives.
 *
 * Imports nothing that loads WebAssembly: the ledger's classes are handed in.
 */
import { authorityValueRefusals, replaceAuthorityOf, type MaintenanceRefusal } from './authority-replacement.js';

export interface CommitteeKey {
  readonly tag: string;
  readonly value: string;
}

export interface Committee {
  readonly committee: readonly CommitteeKey[];
  readonly threshold: number;
}

const KEY = /^[0-9a-f]{64}$/u;

const idOf = (k: CommitteeKey): string => `${k.tag.toLowerCase()}:${k.value.toLowerCase()}`;

/** The refusal a company's signers read, for each way a committee value can be wrong. */
const companySentence = (r: MaintenanceRefusal, threshold: number, signerCount: number): string => {
  switch (r.code) {
    case 'repeated-committee-member':
      return 'two of this company\'s signers gave the same committee key, so the committee would '
        + 'not be the threshold it reads as. No vault is created.';
    case 'malformed-committee-key':
      return 'a committee key this company holds is not one a wallet derives, so the committee '
        + 'cannot be trusted. No vault is created.';
    case 'committee-emptied':
      return 'this company has no signers, so there is nobody to hold its vault\'s rules. No vault is created.';
    default:
      return `this company's threshold is ${threshold} over ${signerCount} signer${signerCount === 1 ? '' : 's'}, `
        + 'which no committee can be. No vault is created.';
  }
};

/**
 * **WHY THERE IS NO COMMITTEE YET, OR `null` WHEN THERE IS ONE.**
 *
 * `keys` holds one entry per active signer, `null` for a signer whose wallet
 * has not given its key. A vault is never deployed while this answers a
 * sentence: no committee, no deploy.
 */
export function whyNoCommittee(input: {
  readonly keys: readonly (CommitteeKey | null)[];
  readonly threshold: number;
  readonly signerCount: number;
}): string | null {
  const { keys, threshold, signerCount } = input;
  if (signerCount < 1) {
    return 'this company has no signers, so there is nobody to hold its vault\'s rules. No vault is created.';
  }
  const given = keys.filter((k): k is CommitteeKey => k !== null);
  if (keys.length !== signerCount || given.length !== signerCount) {
    const missing = signerCount - given.length;
    return `${missing} of this company's ${signerCount} signer${signerCount === 1 ? '' : 's'} `
      + `${missing === 1 ? 'has' : 'have'} not yet opened the company with their wallet here, so `
      + 'the committee that must hold the vault\'s rules is not complete. No vault is created until '
      + 'every signer has opened the company once.';
  }
  for (const k of given) {
    if (k.tag !== 'schnorr' || !KEY.test(k.value)) {
      return 'a committee key this company holds is not one a wallet derives, so the committee '
        + 'cannot be trusted. No vault is created.';
    }
  }
  const refused = authorityValueRefusals(given, threshold, { emptyCommitteeIsDeliberate: false });
  return refused.length === 0 ? null : companySentence(refused[0]!, threshold, signerCount);
}

/** The committee value, in the one order every party uses. Refuses what `whyNoCommittee` refuses. */
export function committeeOf(
  keys: readonly (CommitteeKey | null)[], threshold: number, signerCount: number,
): Committee {
  const why = whyNoCommittee({ keys, threshold, signerCount });
  if (why !== null) throw new Error(why);
  const committee = (keys as CommitteeKey[])
    .map((k) => ({ tag: k.tag, value: k.value.toLowerCase() }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return { committee, threshold };
}

/** Two committee values are the same value: same keys, same order, same threshold. */
export const sameCommittee = (a: Committee, b: Committee): boolean =>
  a.threshold === b.threshold
  && a.committee.length === b.committee.length
  && a.committee.every((k, i) => idOf(k) === idOf(b.committee[i]!));

/** The ledger classes the update is built from. `@midnightntwrk/ledger-v9` satisfies this. */
export interface ReplacementPrimitives {
  ContractMaintenanceAuthority: new (committee: CommitteeKey[], threshold: number, counter?: bigint) => object;
  ReplaceAuthority: new (authority: never) => object;
  MaintenanceUpdate: new (address: string, updates: never[], counter: bigint) => {
    readonly dataToSign: Uint8Array;
    addSignature(index: bigint, signature: never): unknown;
  };
}

/**
 * **THE ONE UPDATE THE TEMPORARY KEY SIGNS.** It replaces the whole authority
 * with the committee. `counter` is the vault's counter as the chain reports it
 * now; the new authority carries the next one, and a signature over this update
 * is worthless against any other counter, any other vault or any other list.
 */
export function committeeReplacement<P extends ReplacementPrimitives>(
  P: P,
  input: { readonly vault: string; readonly counter: bigint; readonly to: Committee },
): InstanceType<P['MaintenanceUpdate']> {
  if (!KEY.test(input.vault.toLowerCase())) {
    throw new Error('a vault is named by its sixty-four character address, and this is not one.');
  }
  if (input.counter < 0n) throw new Error('a maintenance counter is never below zero.');
  const again = whyNoCommittee({
    keys: input.to.committee, threshold: input.to.threshold, signerCount: input.to.committee.length,
  });
  if (again !== null) throw new Error(again);
  const replace = replaceAuthorityOf(P, {
    committee: input.to.committee, threshold: input.to.threshold, updateCounter: input.counter,
    emptyCommitteeIsDeliberate: false,
  });
  return new P.MaintenanceUpdate(input.vault.toLowerCase(), [replace as never], input.counter) as InstanceType<P['MaintenanceUpdate']>;
}
