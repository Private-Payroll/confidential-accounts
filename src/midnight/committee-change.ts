/**
 * **A COMMITTEE CHANGE: WHO JOINS, WHO LEAVES, THE NEW THRESHOLD, AND WHICH OF
 * A COMPANY'S CONTRACTS STILL CARRY THE OLD COMMITTEE.**
 *
 * A company's committee is one key per signer at the company's threshold, and
 * every contract the company has - its account and each vault - holds its own
 * copy of that list on the chain. When a signer joins or leaves, or the
 * threshold moves, every copy has to be replaced, and each replacement must be
 * signed by enough of the keys that copy holds NOW: the chain checks the
 * signatures against the committee on chain, not the one being installed.
 *
 * This file only reads. It builds nothing, signs nothing and holds no key, and
 * it loads no WebAssembly, so a page, a wallet and the service can all ask it
 * the same question and get the same answer.
 */
import type { AuthorityRead } from './ledger.js';
import type { Committee, CommitteeKey } from './vault-committee.js';

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
 * **WHICH OF THE COMPANY'S CONTRACTS CARRY A COMMITTEE OTHER THAN THE COMPANY'S
 * NOW, AND CAN BE CHANGED BY THE KEYS THAT HOLD THEM.**
 *
 * A contract already holding exactly the company's committee owes nothing. One
 * the chain could not be asked about is not changeable, because a change is
 * signed against the counter on the chain and nobody has read it. One still
 * held by the single key it was created with, never changed, is waiting for
 * its handover, which is a different act signed by that key, so it is not
 * offered here. One whose rules need no signature at all, or can never be
 * changed, is named and not offered.
 */
export function contractsOwingAChange(
  reads: ReadonlyArray<{ readonly contract: 'account' | 'vault'; readonly read: AuthorityRead }>,
  company: Committee,
): { readonly owed: ContractOwingAChange[]; readonly notChangeable: ContractNotChangeable[] } {
  const owed: ContractOwingAChange[] = [];
  const notChangeable: ContractNotChangeable[] = [];
  const target = company.committee.map(idOf);
  for (const { contract, read } of reads) {
    const noun = contract === 'account' ? 'the company\'s account' : 'this vault';
    if (read.state !== 'read') {
      notChangeable.push({ contract, address: read.address, why: `the chain could not be asked who holds ${noun}'s rules: ${read.why}` });
      continue;
    }
    const a = read.authority;
    const same = a.threshold === company.threshold && a.committee.length === target.length
      && a.committee.every((k, i) => idOf(k) === target[i]);
    if (same) continue;
    if (a.shape === 'one-key' && a.counter === 0n) {
      notChangeable.push({
        contract, address: read.address,
        why: `${noun} is still held by the key it was created with, so it is handed to the committee first.`,
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
