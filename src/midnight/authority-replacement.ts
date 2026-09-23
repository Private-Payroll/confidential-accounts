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

/** A signing or verifying key as the runtime structures it. */
type AuthorityKey = TaggedKey;

/** True when a value is a `{ tag, value }` key with both parts strings. */
export const isAuthorityKey = (k: unknown): k is AuthorityKey =>
  !!k && typeof k === 'object' &&
  typeof (k as AuthorityKey).tag === 'string' && typeof (k as AuthorityKey).value === 'string';

/** One reason an authority value may not be built. Machine-readable, so a door prints and a test names. */
export interface MaintenanceRefusal {
  code:
    | 'threshold-below-one'
    | 'threshold-above-committee'
    | 'committee-emptied'
    | 'repeated-committee-member'
    | 'malformed-committee-key'
    | 'unnamed-verifier-key-operation'
    | 'empty-verifier-key'
    | 'unknown-verifier-key-version';
  why: string;
}

/**
 * WHAT MUST BE REFUSED BEFORE ANYTHING IS BUILT, SO NOTHING UNSAFE IS EVER SIGNED:
 * a threshold below one, and a committee that repeats a key.
 *
 * **THE CHECK IS ON THE POST-CHANGE PAIR, AS ONE UNIT, AND THAT IS THE WHOLE
 * REASON THE REMOVAL CASE IS NOT A SEPARATE CASE.** There is no *remove a member*
 * instruction: `ReplaceAuthority` carries a whole authority applied wholesale. So
 * removing four of seven and leaving the threshold at five arrives at the chain
 * as `ReplaceAuthority(committee=[3], threshold=5)` — byte-indistinguishable from
 * somebody typing 5-of-3. **A check that fires only when the THRESHOLD FIELD
 * CHANGED misses the removal path entirely**, which is why this takes the pair
 * and never a diff.
 *
 * **AND IT RUNS AT EVERY REBUILD, NOT ONCE WHEN A PERSON PRESSED SOMETHING.**
 * The recovery path rebuilds the payload against a freshly read counter, so a
 * check placed in whatever assembles the transaction is a check the recovery path
 * walks around. `buildMaintenanceInstruction` calls this every time it runs.
 *
 * `emptyCommitteeIsDeliberate` exists because an empty committee arrived at BY
 * REMOVAL is byte-identical to the deliberate `unmaintainable` choice
 * (`partial-contract.ts:315` writes `([], 1, 0n)`; the ledger's own default is the
 * same shape). **Neither the product nor the chain can tell them apart
 * afterwards, so only a named choice may produce it** — and the flag has no
 * default, because a default is how the accident happens.
 */
export function authorityValueRefusals(
  committee: readonly AuthorityKey[],
  threshold: number,
  opts: { emptyCommitteeIsDeliberate: boolean },
): MaintenanceRefusal[] {
  const out: MaintenanceRefusal[] = [];

  for (const [i, k] of committee.entries()) {
    if (!isAuthorityKey(k) || k.tag.trim() === '' || k.value.trim() === '') {
      out.push({
        code: 'malformed-committee-key',
        why: `committee member [${i}] is not a {tag, value} verifying key with both parts set. ` +
          'A committee is a literal list of keys inside the contract and nothing on chain will ' +
          'ever repair a bad entry: the seat is simply one nobody can sign for.',
      });
    }
  }

  /* FIRST AND IT MUST STAY FIRST. MEASURED on ledger 9: a contract at
   * threshold 0 accepts a maintenance update carrying NO SIGNATURES AT ALL, and
   * `wellFormed` returns cleanly. `verify.rs:1789` at LEDGER 8.2 — `signatures.len()
   * < threshold` — is the only functional read of `threshold` in that crate, so
   * `0 < 0` is false. **It is NOT that membership goes unchecked: measured on ledger
   * 9, a signature at an out-of-range seat is still refused at threshold zero and so
   * is a wrong one at a valid seat. What is missing is any REQUIREMENT to attach
   * one.** THIS IS NOT THE UNMAINTAINABLE STATE. IT IS ITS OPPOSITE: anybody in the
   * world can rewrite that contract's rules, for nothing, holding nothing. */
  if (!Number.isInteger(threshold) || threshold < 1) {
    out.push({
      code: 'threshold-below-one',
      why: `threshold ${threshold} is WORLD-WRITABLE, not unmaintainable. MEASURED on ` +
        '`@midnightntwrk/ledger-v9@1.0.0-rc.3`: a maintenance update carrying NO SIGNATURES AT ' +
        'ALL is well-formed against an authority at threshold zero, so anybody could replace ' +
        'this contract\'s verifier keys while holding nothing at all.',
    });
  }

  /* A REPEATED KEY, MEASURED ON LEDGER 9 RATHER THAN READ OFF 8.2. A
   * committee of `[K, K, K]` at threshold 3 is satisfied by the single holder of
   * `K` signing ONCE and attaching that one signature at indices 0, 1 and 2:
   * WELL-FORMED. The signed data covers address, updates and counter and NOT the
   * signer index, so one signature value is valid at every seat holding that key;
   * the indices are strictly ascending, so the normal-form guard passes. **An
   * M-of-N with a repeated key is not an M-of-N, and nothing on chain says so.**
   * `requireMaintenanceAuthority` (`partial-contract.ts:174-205`) checks the
   * committee's SIZE and the threshold's RANGE and does not check this. */
  const seen = new Map<string, number>();
  for (const [i, k] of committee.entries()) {
    if (!isAuthorityKey(k)) continue;
    const id = `${k.tag.toLowerCase()}:${k.value.toLowerCase()}`;
    const first = seen.get(id);
    if (first === undefined) { seen.set(id, i); continue; }
    out.push({
      code: 'repeated-committee-member',
      why: `committee seats [${first}] and [${i}] hold the SAME key, so this is not a ` +
        `${threshold}-of-${committee.length}. MEASURED on ledger 9: one holder signs ONCE and ` +
        'attaches that one signature at every seat holding their key, which is well-formed. ' +
        'The threshold this reads as is not the threshold it buys.',
    });
  }

  /* `2.6`, and the runtime documents this state as valid: *"If the threshold is
   * greater than the number of committee members, it is impossible for them to
   * sign anything"*. MEASURED: installing a 2-of-1 is well-formed and applies. It
   * is `no-one` for ever, and it is reachable by REMOVING members without
   * touching the threshold. */
  /* **AND THE ONE EXEMPTION, WHICH A TEST FOUND BY GOING RED.**
   * The deliberate `unmaintainable` choice IS an over-threshold state:
   * `partial-contract.ts:315` writes `([], 1, 0n)` and `intendedAuthorityValue`
   * projects `{ kind: 'unmaintainable' }` to `{ committee: [], threshold: 1 }`.
   * So `1 > 0` is true of the chosen state exactly as it is true of the
   * accident, and a refusal without this exemption refuses the one authority
   * kind this repository has always been able to express. **The named choice is
   * the only thing that separates them — which is the same sentence
   * `committee-emptied` is built on, one line down, and it is the reason that
   * flag exists at all.** A 2-of-1 is still refused: the exemption is for the
   * EMPTY committee and for nothing else. */
  const deliberatelyUnmaintainable = committee.length === 0 && opts.emptyCommitteeIsDeliberate;
  if (Number.isInteger(threshold) && threshold > committee.length && !deliberatelyUnmaintainable) {
    out.push({
      code: 'threshold-above-committee',
      why: `threshold ${threshold} over a committee of ${committee.length} can never be met, so ` +
        'this contract would become permanently unmaintainable — and MEASURED on ledger 9 it ' +
        'installs without complaint. It is reachable by REMOVING members and leaving the ' +
        'threshold alone, which is why this is checked on the pair and not on what changed.',
    });
  }

  if (committee.length === 0 && !opts.emptyCommitteeIsDeliberate) {
    out.push({
      code: 'committee-emptied',
      why: 'this would leave an EMPTY committee, which is byte-identical on chain to the ' +
        'deliberate `unmaintainable` choice. Nothing afterwards — not this product and not the ' +
        'chain — can tell an emptied committee from a chosen one, so only a named choice may ' +
        'produce it.',
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
 * company, a company account handed to its signers, a committee changed after
 * a signer joins or leaves, and every rebuild of any of those against a counter
 * read again - reaches the ledger's `ReplaceAuthority` through this function and
 * through no other.
 *
 * **WHY IT HAS TO BE ONE PLACE.** The ledger checks nothing about the authority
 * a replacement installs except its counter, and it applies the new value whole.
 * There is no instruction that removes one member: removing a member IS a
 * replacement, so a replacement with one field wrong is how a committee reaches
 * a threshold of zero, which anybody at all can then satisfy with no signature.
 * A refusal that lives in one caller is a refusal the next caller walks around.
 *
 * `updateCounter` is the contract's counter as the chain reports it now. The
 * installed authority carries the next one, which the ledger requires exactly,
 * so it is derived here and is never the caller's to choose.
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
  const { committee, threshold } = requireBuildableAuthority(
    input.committee, input.threshold,
    { emptyCommitteeIsDeliberate: input.emptyCommitteeIsDeliberate },
  );
  return new P.ReplaceAuthority(
    new P.ContractMaintenanceAuthority(committee, threshold, input.updateCounter + 1n) as never,
  );
}
