/**
 * What to do about one contract's maintenance authority, decided before anything is built: settled, build the
 * replacement, or refuse because the chain could not be asked. And, once a replacement is submitted, whether the
 * chain's end state shows it took effect. A plan never re-signs against a chain it did not read.
 */
import { authorityValueRefusals, type MaintenanceRefusal } from './authority-replacement.js';
import {
  compareAuthority, type AuthorityComparison, type AuthorityKey, type AuthorityRead,
} from './contract-authority-read.js';

/**
 * Building a maintenance update by hand. A company's super admins, a committee of their own wallet keys, hold the
 * maintenance authority for the account and the vaults, and the product holds nothing. That authority can replace a
 * contract's verifier keys, so it is a drain key on every vault's unshielded money and is never held by the product.
 *
 * A committee authority switches Midnight's SDK maintenance interface off for that contract. No signing key is
 * stored under a committee (see `submitPartialDeployTx` in `partial-contract.ts`), every SDK maintenance
 * entry point opens by asserting exactly that slot, and `createSignedMaintenanceUpdate` always signs at index 0,
 * a one-signature vote the chain refuses at any threshold above one. So every committee update is built from
 * `ledger-v9`'s own primitives, by `committeeUpdateOf`.
 *
 * This block builds and never submits: it sends no transaction, pays no fee and contacts no chain. It also never
 * touches a signing key, as a parameter, a fixture or a literal. It accepts signatures, which are public once they
 * reach a chain, and verifying keys, which are already on one; no parameter here fits a signing key. Signing
 * happens outside this repository, on the machine that holds the key.
 *
 * What it relies on:
 *   1. The read-back is a ledger property and not an SDK call, so building without the SDK costs nothing in the
 *      ability to verify the work.
 *   2. `compareAuthority` is the "did my change land" test: whole value, end state, counter excluded. It is reused.
 *   3. `unknown` refuses. Treating "the chain could not be asked" as "disagree" would re-sign against a chain
 *      that was never read.
 *
 * Every claim below was taken off `@midnightntwrk/ledger-v9@1.0.0-rc.3` by constructing the object, deploying it
 * into a `LedgerState` and calling `Transaction.wellFormed` with proofs disabled and signature verification on.
 * Nothing was proved, deployed or submitted, no key was generated and no chain was contacted.
 *
 * The version claim is kept as narrow as the evidence. The node's own manifest asks for `=1.0.0`, which a
 * pre-release does not satisfy; what pins the build is its patch entry at the tag `crate-ledger-9.1.0.0-rc.3`,
 * and this package carries the same version string. The npm package ships no source and the `.wasm` carries no
 * version string, so "built from that tag" is the best evidence available and not a measurement. Rust citations
 * below are to `midnight-ledger` at `ledger-9.1.0.0-rc.3`.
 *
 * What the measurements showed:
 *   - A committee of `[K, K, K]` at threshold 3, satisfied by one holder of `K` signing once and attaching that
 *     signature at indices 0, 1 and 2, is well formed. The repeated key in the committee is the bypass.
 *   - A contract whose authority is at threshold 0 accepts a maintenance update carrying no signatures at all.
 *   - The same signature index twice is refused ("transaction is not in normal form"), so the ascending-index
 *     guard does reach ledger 9. The bypass is in the committee list and not in the signature list.
 *   - The new authority's own counter must be `updateCounter + 1`, and it is not the caller's to choose: any
 *     other value, including 0, is refused. So `committeeUpdateOf` derives it and takes no parameter for it.
 *   - `wellFormed` does not check the update's counter against the chain. An update built against counter 1 for a
 *     contract at counter 0 is well formed and fails at apply as a `partialSuccess`, on chain, with the fee spent
 *     (maintenance runs only in the fallible segment). No screen may read a well-formed verdict as "this will land".
 *   - A negative threshold is not refused, it wraps. `-1` installs `4294967295` silently, `-2` gives `4294967294`
 *     and `1.7` truncates to `1`. The product is held off this only because `authorityValueRefusals` refuses a
 *     non-integer as well as a value below one.
 *   - A threshold above the committee size installs: replacing a 1-of-1 with a 2-of-1 is well formed and applies.
 *     The ledger validates nothing about a new authority except its counter and, at apply, its serialized size
 *     against `max_contract_metadata_size` (50,000 bytes by default). Every other refusal below is this code's or
 *     nobody's.
 *
 * The refusals of the authority value itself (the threshold, the committee, repeated and malformed members) live
 * in `authority-replacement.ts`, beside the one function that builds a replacement, so that code a browser runs
 * can reach them without this module. What stays here refuses the verifier keys.
 */

/**
 * WHAT TO DO ABOUT ONE CONTRACT, DECIDED BEFORE ANYTHING IS BUILT.
 *
 * Three actions and not two, for the reason `compareAuthority` has three
 * verdicts. **`refuse` is the load-bearing one**: a plan that turned *the chain
 * could not be asked* into *build it again* would re-sign against a chain it
 * never read and spend a real update on a contract that may already be correct.
 */
export type MaintenancePlan =
  | { action: 'settled'; address: string; why: string; comparison: AuthorityComparison }
  | {
      action: 'build'; address: string; why: string; comparison: AuthorityComparison;
      /** The counter the update is valid against: the one just read off the chain. */
      updateCounter: bigint;
      /** What the contract's counter will be once this update applies. */
      expectedCounter: bigint;
      intended: { committee: AuthorityKey[]; threshold: number };
    }
  | { action: 'refuse'; address: string; why: string; refusals: MaintenanceRefusal[]; comparison?: AuthorityComparison };

/**
 * Plan one contract's authority change.
 *
 * A no-op is not a retry. Resubmitting a byte-identical signed update after it landed hits
 * `ReplayCounterMismatch`, and that error carries only the address, so it cannot say whose update landed. So
 * "did my change land" is asked of the live authority against the intended end state, whole value, before
 * anything is built. Equal: do nothing, which is the correct outcome. Not equal: build against the counter just
 * read, because the counter is inside the signed data and every older signature is dead. Unreadable: refuse.
 *
 * The counter comes from the chain read and from nowhere else, but the freshness of that read is the caller's and
 * this cannot check it. This takes an `AuthorityRead` the caller supplies, and an `AuthorityRead` carries no
 * timestamp and no block height, so a cached read passes a stale counter straight through. What holds is that no
 * counter enters from any source other than that read, and none is a parameter of anything below. A stale one
 * still costs a fee on a recorded on-chain failure, because a rejected maintenance update lands as
 * `partialSuccess` with the fee already taken.
 */
export function planAuthorityReplacement(
  read: AuthorityRead,
  intended: { committee: readonly AuthorityKey[]; threshold: number },
  opts: { emptyCommitteeIsDeliberate: boolean },
): MaintenancePlan {
  const refusals = authorityValueRefusals(intended.committee, intended.threshold, opts);
  if (refusals.length > 0) {
    return {
      action: 'refuse', address: read.address, refusals,
      why: 'the intended end state is not a value this product will install: ' +
        refusals.map((r) => r.code).join(', ') + '. Nothing was built and no chain was consulted ' +
        'for a verdict on it.',
    };
  }

  const pair = {
    committee: intended.committee.map((k) => ({ tag: k.tag, value: k.value })),
    threshold: intended.threshold,
  };
  const comparison = compareAuthority(read, pair);

  /* `unknown` refuses. "The ledger cannot answer" is not "the answer is no", and collapsing the three verdicts
   * into two would build against a chain that was never read. */
  if (comparison.verdict === 'unknown') {
    return {
      action: 'refuse', address: read.address, comparison, refusals: [],
      why: `NOTHING MAY BE BUILT FOR THIS CONTRACT: ${comparison.why} Building anyway would ` +
        'mean signing a counter nobody read, against a contract that may already carry the ' +
        'intended authority. Ask again when the chain answers.',
    };
  }

  if (comparison.verdict === 'agree') {
    return {
      action: 'settled', address: read.address, comparison,
      why: 'the chain already carries the intended end state, so there is nothing to build and ' +
        'nothing to sign. Re-running this change is a no-op here rather than a refusal on chain.',
    };
  }

  const chain = read.state === 'read' ? read.authority : undefined;
  /* Unreachable in practice: `compareAuthority` returns `unknown` for every
   * non-`read` state and that branch returned above. Stated rather than
   * asserted, because a later edit to either function should fail HERE. */
  if (!chain) {
    return {
      action: 'refuse', address: read.address, comparison, refusals: [],
      why: 'the comparison disagreed without a chain value to disagree with, which is a defect ' +
        'in this module rather than a fact about the contract. Nothing was built.',
    };
  }

  return {
    action: 'build', address: read.address, comparison, intended: pair,
    updateCounter: chain.counter,
    expectedCounter: chain.counter + 1n,
    why: `${comparison.why} The update will be built against counter ${chain.counter}, which is ` +
      `the value just read, and the contract's counter becomes ${chain.counter + 1n} if it lands.`,
  };
}

/**
 * The durable per-contract end-state record, written before anything is submitted.
 *
 * A maintenance change has no on-chain handle: it is not a circuit call, it leaves no proposal, and the job
 * runner's recovery branches all miss it. So the intended end state and the target address must be written
 * somewhere a second device reads before anything is submitted, or a device that did not build the change has
 * nothing to compare against.
 *
 * It carries an expected counter. `compareAuthority` deliberately excludes the counter, and that is correct:
 * `ReplaceAuthority` replaces wholesale, so the value is the settlement, and comparing counters would make every
 * settled contract look unsettled for ever. But the counter can never be rolled back or reset (it only stops
 * advancing at `u32::MAX`, where it saturates), which makes it the one monotonic witness the chain offers. Without
 * an expected value, `agree` cannot tell "we installed this" from "somebody replaced it, did something else in the
 * same update, and put an identical authority back". One `MaintenanceUpdate` carries `ReplaceAuthority` and
 * `VerifierKeyInsert` in one `updates` array, which is how a verifier-key swap would be packaged.
 *
 * Nothing secret goes in it. Verifying keys are on a public chain, the address is public and so is the counter.
 * No field here fits a signing key, because a record is a plaintext home for whatever is put in it.
 */
export interface MaintenanceEndStateRecord {
  /** The contract this record is about. One record per contract, never per logical change. */
  address: string;
  /** An operator-facing name, for a screen. Never used in a comparison. */
  label: string;
  committee: AuthorityKey[];
  threshold: number;
  /** The counter the update was signed against — the value read off the chain when it was built. */
  builtAgainstCounter: bigint;
  /** `builtAgainstCounter + 1`. What the contract's counter becomes if this update lands. */
  expectedCounter: bigint;
  /**
   * Entry points whose verifier key this update also writes, by name and by the first eight bytes of the key,
   * because the name alone is what a swap leaves unchanged. A record that says "we wrote `recordPayment`" cannot
   * afterwards say which key was written, so `checkEndState` could report `settled` for an update that also
   * rewrote a verifier key. Eight bytes identify a key to a person and prove nothing: the proof is
   * `compareVerifierKeys` over full bytes against the chain.
   */
  verifierKeyInserts: { operation: string; version: string; fingerprint: string }[];
  /** When it was built, for a person reading a stalled change. Never compared. */
  builtAt: string;
}

/**
 * What the chain says about a record we wrote. Four answers, and the fourth is the one the expected counter
 * buys.
 *
 *   `settled`     — the value matches AND the counter is exactly what we expected.
 *   `not-yet`     — the value does not match; the change has not landed.
 *   `unexplained` — the value matches and the counter does NOT. Something else
 *                   moved this contract. It is not a failure and it is not a
 *                   success, and it must not be printed as either.
 *   `unknown`     — the chain could not be asked.
 */
export type EndStateVerdict = 'settled' | 'not-yet' | 'unexplained' | 'unknown';

export interface EndStateCheck {
  verdict: EndStateVerdict;
  address: string;
  why: string;
  comparison: AuthorityComparison;
}

/**
 * Did the change we recorded actually land, and did anything else happen here?
 *
 * The value half is `compareAuthority` — reused, not rewritten.
 * The counter half is this function's own, and it never turns a `disagree` into
 * an `agree` or the reverse: it only splits `agree` into *settled* and
 * *unexplained*.
 */
export function checkEndState(
  record: MaintenanceEndStateRecord,
  read: AuthorityRead,
): EndStateCheck {
  const comparison = compareAuthority(read, {
    committee: record.committee, threshold: record.threshold,
  });
  if (comparison.verdict === 'unknown') {
    return { verdict: 'unknown', address: record.address, comparison, why: comparison.why };
  }
  if (comparison.verdict === 'disagree') {
    return {
      verdict: 'not-yet', address: record.address, comparison,
      why: `the change recorded for this contract has NOT landed: ${comparison.why}`,
    };
  }
  const actual = read.state === 'read' ? read.authority.counter : undefined;
  if (actual === record.expectedCounter) {
    return {
      verdict: 'settled', address: record.address, comparison,
      why: `the chain carries the recorded end state and its counter is ${actual}, exactly the ` +
        'value this change was expected to leave. Nothing else has been applied here since.',
    };
  }
  return {
    verdict: 'unexplained', address: record.address, comparison,
    why: `THE VALUE MATCHES AND THE COUNTER DOES NOT. Expected ${record.expectedCounter}, the ` +
      `chain carries ${actual}. The counter can never be rolled back or reset, so this contract ` +
      'has taken a maintenance update this record does not account for. One update carries a ' +
      'ReplaceAuthority AND a VerifierKeyInsert in the same array, so an identical authority ' +
      'put back is exactly what a verifier-key swap looks like from here. This is neither a ' +
      'pass nor a failure: a person reads the verifier keys back (`compareVerifierKeys`) before anything else.',
  };
}

/**
 * A signature over a maintenance update, in the shape the runtime uses
 * (`ledger-v9.d.ts:154`). **It is the same `{tag, value}` shape as a key and it
 * is NOT a key**: a signature is public the moment the update reaches a chain,
 * which is why this API accepts one and accepts no signing key anywhere.
 */
export type MaintenanceSignature = AuthorityKey;
