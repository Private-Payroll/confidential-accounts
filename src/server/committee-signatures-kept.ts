/**
 * **THE SIGNATURES THE SERVICE KEEPS FOR A CHANGE OF WHO HOLDS A COMPANY'S CONTRACTS.**
 *
 * Per company, contract and counter, the service keeps each committee proposed and the signatures over it that counted
 * against the committee holding that contract on the chain, so super admins can sign on different devices and at
 * different times and one of them sends the change. Each place on that committee signs for one committee at a time: a
 * place's newer signature takes it off any other committee kept, and a committee no place still signs is dropped, so
 * what is kept never outgrows the committee and a change abandoned by its signers never stands in another's way. For a
 * vault, a committee the company's account does not hold now is dropped when another is kept, since a vault's change is
 * sent only to the committee the account holds. A request keeps anything only when a signature it gave counts
 * (`aGivenSignatureCounts`): signatures that count for nothing grow nothing here.
 */
import type { CollectedCommitteeSignatures } from '../core/store.js';
import { bare as fold } from '../midnight/account-deploy.js';
import type { PlaceSignature } from '../midnight/company-authority.js';
import { sameCommittee, type Committee } from '../midnight/vault-committee.js';

/** Where the signatures are kept, per company and contract. */
export interface CommitteeSignaturesStore {
  getCommitteeSignatures(accountId: string, address: string): CollectedCommitteeSignatures | null;
  putCommitteeSignatures(c: CollectedCommitteeSignatures): void;
}

/** What the routes of a change of the committee read and write of the signatures kept. */
export const committeeSignaturesKept = (deps: { readonly store: CommitteeSignaturesStore }) => {
  /*
   * **THE SIGNATURES KEPT FOR ONE CONTRACT'S UPDATE TO `to`, AT `counter`.**
   * Signatures kept for a counter the chain has moved past are never handed on:
   * they can never count again.
   */
  const keptRecord = (accountId: string, address: string, counter: bigint): CollectedCommitteeSignatures | null => {
    const kept = deps.store.getCommitteeSignatures(accountId, address);
    return kept !== null && kept.counter === counter.toString() && Array.isArray(kept.proposed) ? kept : null;
  };
  const keptFor = (accountId: string, address: string, counter: bigint, to: Committee): PlaceSignature[] =>
    (keptRecord(accountId, address, counter)?.proposed.find((p) => sameCommittee(p.to as Committee, to))?.signatures ?? [])
      .map((x) => ({ index: x.index, signature: { tag: x.signature.tag, value: x.signature.value } }));
  /**
   * Keeps `counted` as the signatures for `to` at `counter`, and whether an update at that counter was sent. The places
   * in `counted` come off every other committee kept, a committee left with no signature is dropped, and, when
   * `sendable` is given (a vault's: whether the account holds that committee now), so is every other one it refuses.
   */
  const keep = (
    accountId: string, address: string, counter: bigint, to: Committee, counted: readonly PlaceSignature[], sentAt?: string | null,
    sendable?: (other: Committee) => boolean,
  ) => {
    const before = keptRecord(accountId, address, counter);
    const places = new Set(counted.map((c) => c.index));
    const others = (before?.proposed ?? [])
      .filter((p) => !sameCommittee(p.to as Committee, to) && (sendable === undefined || sendable(p.to as Committee)))
      .map((p) => ({ to: p.to, signatures: p.signatures.filter((x) => !places.has(x.index)) }))
      .filter((p) => p.signatures.length > 0);
    deps.store.putCommitteeSignatures({
      accountId, address: fold(address), counter: counter.toString(),
      proposed: [...others, {
        to: { committee: to.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: to.threshold },
        signatures: counted.map((c) => ({ index: c.index, signature: { tag: c.signature.tag, value: c.signature.value } })),
      }],
      sentAt: sentAt === undefined ? before?.sentAt ?? null : sentAt,
    });
  };
  return { keptRecord, keptFor, keep };
};

/** Words for signatures refused because none of those given counted: what lets them be kept. */
export const NONE_COUNTS = 'none of the signatures given counts under the committee holding this contract on the chain, so nothing was kept. '
  + 'A key on that committee signs the update from its wallet, at the counter the chain holds the contract at.';

/** Whether at least one signature a request gave is among those that counted. */
export const aGivenSignatureCounts = (given: readonly PlaceSignature[], counted: readonly PlaceSignature[]): boolean =>
  given.some((g) => counted.some((c) => c.index === g.index && c.signature.tag.toLowerCase() === g.signature.tag.toLowerCase()
    && fold(c.signature.value) === fold(g.signature.value)));
