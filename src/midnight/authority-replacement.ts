/**
 * **WHAT A NEW MAINTENANCE AUTHORITY MUST NOT BE, AND THE ONE FUNCTION THAT
 * BUILDS A REPLACEMENT OF ONE.**
 *
 * These are pure checks over a committee and a threshold, and one constructor
 * over two ledger classes the caller passes in. They need no ledger, no
 * network and no filesystem, and they live in a module of their own so that
 * code which runs in a browser can reach them without loading the whole
 * server-side ledger adapter - which reads compiled artefacts from disk and
 * cannot be evaluated in a browser at all.
 *
 * The ledger adapter imports them from here and re-exports them unchanged, so
 * every existing caller keeps its import.
 */
import type { TaggedKey } from './partial-contract.js';
import { committeeInstallRefusals } from 'midnight-identity/profile/request';
import { LARGEST_COUNTER, largestCounterRefusal } from 'midnight-identity/profile/committee-sign';

/** A signing or verifying key as the runtime structures it. */
type AuthorityKey = TaggedKey;

/** One reason an authority value may not be built. Machine-readable, so a door prints and a test names. */
export interface MaintenanceRefusal {
  code:
    | 'threshold-below-one'
    | 'threshold-above-committee'
    | 'committee-emptied'
    | 'repeated-committee-member'
    | 'committee-over-the-metadata-limit'
    | 'malformed-committee-key'
    | 'unnamed-verifier-key-operation'
    | 'empty-verifier-key'
    | 'unknown-verifier-key-version';
  why: string;
}

/**
 * **THE MOST KEYS A COMMITTEE MAY HOLD AND STILL FIT THE LEDGER'S LIMIT ON A
 * CONTRACT'S AUTHORITY, AT ANY THRESHOLD AND ANY COUNTER.** The ledger refuses
 * a deploy or a replacement whose authority serializes above
 * `max_contract_metadata_size` (`midnight-ledger` `ledger-9.1.0.0-rc.3`,
 * `ledger/src/verify.rs:384-391`, `:1780-1792`; `ledger/src/semantics.rs:1632-1653`),
 * a replacement only once it is applied, after its fee is spent. Read off the
 * ledger's own serialization against its starting limit of 50,000 bytes: each
 * schnorr key is 33 bytes, and at the largest threshold and counter 1,514 keys
 * serialize to 49,974 and 1,515 to 50,007. The figure holds only because
 * `committeeInstallRefusals` installs schnorr keys alone: an ecdsa key is 34
 * bytes, and 1,471 of them already pass the limit. `authority-replacement.test.ts` reads both
 * again from the ledger every run, so this number cannot drift from it.
 */
export const LARGEST_COMMITTEE = 1514;

/**
 * **WHAT A NEW MAINTENANCE AUTHORITY MUST NOT BE**, refused before anything is
 * built so nothing unsafe is ever signed: every reason `committeeInstallRefusals`
 * gives (keys a wallet derives, none twice, a threshold from one to the keys),
 * and a committee too large for the ledger's limit on a contract's
 * authority. Returns every reason, and an empty list when the authority may
 * be built.
 *
 * **THE CHECK IS ON THE PAIR AFTER THE CHANGE, AS ONE UNIT.** There is no
 * instruction that removes one member: a replacement carries a whole authority,
 * applied whole, so removing four of seven and leaving the threshold at five
 * arrives as five of three. A check that fired only on a changed threshold
 * would miss every removal. It runs at every rebuild too, so a change rebuilt
 * against a counter read again is checked again.
 *
 * `emptyCommitteeIsDeliberate` names the one authority the rule does not
 * judge: a contract made deliberately unmaintainable is written with no keys at
 * a threshold of one, which on the chain is the same value as a committee
 * emptied by accident. Only a named choice may produce it, so the flag has no
 * default.
 */
export function authorityValueRefusals(
  committee: readonly AuthorityKey[],
  threshold: number,
  opts: { emptyCommitteeIsDeliberate: boolean },
): MaintenanceRefusal[] {
  const deliberatelyUnmaintainable = committee.length === 0 && opts.emptyCommitteeIsDeliberate;
  const out: MaintenanceRefusal[] = committeeInstallRefusals(committee, threshold)
    .filter((r) => !(deliberatelyUnmaintainable && (r.code === 'committee-emptied' || r.code === 'threshold-above-committee')))
    .map((r) => ({ code: r.code, why: r.why }));
  /* A committee the ledger would refuse for its size, refused here before any fee is spent on it. */
  if (committee.length > LARGEST_COMMITTEE) {
    out.push({
      code: 'committee-over-the-metadata-limit',
      why: `a committee of ${committee.length} keys is more than the ${LARGEST_COMMITTEE} the ledger's limit on a ` +
        'contract\'s authority holds, so the chain would refuse it, a replacement only after its fee was spent.',
    });
  }
  return out;
}

/** The refusals as one throw, for callers that cannot carry on. Returns the pair when there are none. */
export function requireBuildableAuthority(
  committee: readonly AuthorityKey[],
  threshold: number,
  opts: { emptyCommitteeIsDeliberate: boolean },
): { committee: AuthorityKey[]; threshold: number } {
  const refusals = authorityValueRefusals(committee, threshold, opts);
  if (refusals.length > 0) {
    throw new Error(
      'this maintenance authority will not be built:\n' +
        refusals.map((r) => `  - [${r.code}] ${r.why}`).join('\n'),
    );
  }
  return { committee: committee.map((k) => ({ tag: k.tag, value: k.value })), threshold };
}


/** The two ledger classes an authority replacement is made of. `@midnightntwrk/ledger-v9` satisfies this. */
export interface AuthorityReplacementPrimitives {
  ContractMaintenanceAuthority: new (committee: AuthorityKey[], threshold: number, counter?: bigint) => object;
  ReplaceAuthority: new (authority: never) => object;
}

/**
 * **THE ONE PLACE THIS PRODUCT MAKES A REPLACEMENT OF A CONTRACT'S MAINTENANCE
 * AUTHORITY.** Every builder that installs a committee - a vault handed to its
 * company, a company account handed to its super admins, a committee changed
 * after the super admins change, and every rebuild of any of those against a counter
 * read again - reaches the ledger's `ReplaceAuthority` through this function and
 * through no other.
 *
 * **WHY IT HAS TO BE ONE PLACE.** The ledger checks nothing about the authority
 * a replacement installs except its counter and its serialized size (at most
 * `max_contract_metadata_size`, `midnight-ledger` `ledger-9.1.0.0-rc.3`,
 * `ledger/src/semantics.rs:1632-1653`), and it applies the new value whole.
 * There is no instruction that removes one member: removing a member IS a
 * replacement, so a replacement with one field wrong is how a committee reaches
 * a threshold of zero, which anybody at all can then satisfy with no signature.
 * A refusal that lives in one caller is a refusal the next caller walks around.
 *
 * `updateCounter` is the contract's counter as the chain reports it now. The
 * installed authority carries the next one, which the ledger requires exactly,
 * so it is derived here and is never the caller's to choose. Refused at the
 * largest counter the chain holds, which has no next one.
 */
export function replaceAuthorityOf<P extends AuthorityReplacementPrimitives>(
  P: P,
  input: {
    readonly committee: readonly AuthorityKey[];
    readonly threshold: number;
    readonly updateCounter: bigint;
    readonly emptyCommitteeIsDeliberate: boolean;
  },
): object {
  if (typeof input.updateCounter !== 'bigint' || input.updateCounter < 0n) {
    throw new Error('a maintenance counter is a whole number read off the chain, and this is not one. Nothing was built.');
  }
  if (input.updateCounter >= LARGEST_COUNTER) throw new Error(largestCounterRefusal(input.updateCounter));
  const { committee, threshold } = requireBuildableAuthority(
    input.committee, input.threshold,
    { emptyCommitteeIsDeliberate: input.emptyCommitteeIsDeliberate },
  );
  return new P.ReplaceAuthority(
    new P.ContractMaintenanceAuthority(committee, threshold, input.updateCounter + 1n) as never,
  );
}
