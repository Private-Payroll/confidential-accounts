/**
 * **A COMMITTEE CHANGE: WHO JOINS, WHO LEAVES, THE NEW THRESHOLD, AND WHICH OF
 * A COMPANY'S CONTRACTS STILL CARRY ANOTHER COMMITTEE.**
 *
 * A company's committee is its super admins' keys at their own threshold, and
 * every contract the company has - its account and each vault - holds its own
 * copy of that list on the chain, the account's being the one the others must
 * equal. When the super admins change, every copy has to be replaced, and each
 * replacement must be signed by enough of the keys that copy holds NOW: the
 * chain checks the signatures against the committee on chain, not the one
 * being installed. No signer, threshold or bar of the signers moves it.
 *
 * This file only reads. It builds nothing, signs nothing and holds no key, and
 * it loads no WebAssembly, so a page, a wallet and the service can all ask it
 * the same question and get the same answer.
 */
import type { AuthorityRead } from './ledger.js';
import type { Committee, CommitteeKey } from './vault-committee.js';
import { whyNotInstallable } from 'midnight-identity/profile/request';

const idOf = (k: CommitteeKey): string => `${k.tag.toLowerCase()}:${k.value.toLowerCase()}`;

/** What a change does to one committee, in the order a person reads it. */
export interface CommitteeDifference {
  /** Keys on the new committee and not on the one that holds the contract now. */
  readonly joins: readonly CommitteeKey[];
  /** Keys on the committee now and not on the new one. They lose their seat when the change lands. */
  readonly leaves: readonly CommitteeKey[];
  /** Keys on both. */
  readonly stays: readonly CommitteeKey[];
  readonly thresholdNow: number;
  readonly thresholdAfter: number;
}

/** Who joins, who leaves and the threshold before and after, between two committees. */
export function committeeDifference(now: Committee, after: Committee): CommitteeDifference {
  const before = new Set(now.committee.map(idOf));
  const next = new Set(after.committee.map(idOf));
  return {
    joins: after.committee.filter((k) => !before.has(idOf(k))),
    leaves: now.committee.filter((k) => !next.has(idOf(k))),
    stays: after.committee.filter((k) => before.has(idOf(k))),
    thresholdNow: now.threshold,
    thresholdAfter: after.threshold,
  };
}

/** One of a company's contracts whose committee is not the company's, and what holds it now. */
export interface ContractOwingAChange {
  readonly contract: 'account' | 'vault';
  readonly address: string;
  /** The counter the change must be signed against: the one on the chain now. */
  readonly counter: bigint;
  /** The committee that holds the contract now, in chain order. It is the one that signs. */
  readonly now: Committee;
}

/** A contract that cannot be brought to the company's committee by its signers, and why. */
export interface ContractNotChangeable {
  readonly contract: 'account' | 'vault';
  readonly address: string;
  readonly why: string;
}

/**
 * **WHICH OF THE COMPANY'S CONTRACTS CARRY A COMMITTEE OTHER THAN `target`,
 * AND CAN BE CHANGED BY THE KEYS THAT HOLD THEM.** `target` is the committee
 * every contract must hold: the account's as the chain holds it, or the super
 * admins' change in progress (`superAdminsHere` reads both). A target the one
 * install rule refuses (`whyNotInstallable`) is never offered: every contract
 * the chain could be asked about is named as not changeable, with the rule's
 * reason.
 *
 * A contract already holding exactly the target owes nothing. One
 * the chain could not be asked about is not changeable, because a change is
 * signed against the counter on the chain and nobody has read it. One the
 * company's records do not hold as born held by its committee is named and
 * not offered: a change signed by whoever holds it would not make it the
 * company's. A born-held contract still held by the founding seat's one key,
 * never changed, is offered like any other: that is the super admins' first
 * change. One whose rules need no signature at all, or can never be changed,
 * is named and not offered.
 */
export function contractsOwingAChange(
  reads: ReadonlyArray<{ readonly contract: 'account' | 'vault'; readonly read: AuthorityRead; readonly bornHeld: boolean }>,
  target: Committee,
): { readonly owed: ContractOwingAChange[]; readonly notChangeable: ContractNotChangeable[] } {
  const owed: ContractOwingAChange[] = [];
  const notChangeable: ContractNotChangeable[] = [];
  const notInstallable = whyNotInstallable(target);
  const keys = notInstallable === null ? target.committee.map(idOf) : [];
  for (const { contract, read, bornHeld } of reads) {
    const noun = contract === 'account' ? 'the company\'s account' : 'this vault';
    if (read.state !== 'read') {
      notChangeable.push({ contract, address: read.address, why: `the chain could not be asked who holds ${noun}'s rules: ${read.why}` });
      continue;
    }
    if (notInstallable !== null) {
      notChangeable.push({ contract, address: read.address, why: `${noun} is not changed to that committee: ${notInstallable}` });
      continue;
    }
    const a = read.authority;
    const same = a.threshold === target.threshold && a.committee.length === keys.length
      && a.committee.every((k, i) => idOf(k) === keys[i]);
    if (same) continue;
    if (!bornHeld) {
      notChangeable.push({
        contract, address: read.address,
        why: `${noun} was not created here held by the company's committee, so a change signed by whoever holds it `
          + 'would not make it the company\'s.',
      });
      continue;
    }
    if (a.shape === 'anyone' || a.shape === 'no-one') {
      notChangeable.push({
        contract, address: read.address,
        why: a.shape === 'anyone'
          ? `anybody can change ${noun}'s rules without a signature, so a change signed by the company's signers proves nothing.`
          : `nobody can ever sign a change to ${noun}'s rules: its threshold is above the number of keys that hold it.`,
      });
      continue;
    }
    owed.push({
      contract, address: read.address, counter: a.counter,
      now: { committee: a.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: a.threshold },
    });
  }
  return { owed, notChangeable };
}

/**
 * **WHICH SEAT A KEY SIGNS AT**, or `null` when it holds none. A key listed
 * twice signs at every seat it holds, because the chain checks each seat on its
 * own and one signature verifies at each; the seats are returned in order.
 */
export function seatsOf(key: CommitteeKey, now: Committee): number[] {
  const id = idOf(key);
  return now.committee.flatMap((k, i) => (idOf(k) === id ? [i] : []));
}
