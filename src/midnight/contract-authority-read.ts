/**
 * What maintenance authority a deployed contract carries on the chain, read from its state, and whether it is
 * the one the company meant to install. The comparison answers agree, disagree or unknown: a chain that could
 * not be read is unknown, never agreement, so nothing is built or signed on a guess.
 */
import { authorityIn } from 'midnight-identity/profile/contract-authority';
import type { MaintenanceAuthorityChoice } from './partial-contract.js';

/**
 * What authority a deployed contract carries on chain, and whether it is the one the company meant to install.
 * Reading it back is what makes a half-applied change detectable: an authority that is installed and never read
 * back has proved nothing.
 *
 * It is a read. It signs nothing, submits nothing, changes nothing and touches no key, and it does not decide
 * which authority is right.
 *
 * It reads a ledger property and not an SDK entry point. Choosing a committee switches Midnight's SDK
 * maintenance interface off for that contract, permanently: no signing key is stored under a committee (see
 * `requireMaintenanceAuthority`), and every SDK maintenance entry point opens by asserting exactly that slot. A
 * read-back built on one would work for `single-key` and stop working for a committee. So this reads the state
 * `publicDataProvider.queryContractState` returns, a deserialized `ContractState` whose `.maintenanceAuthority`
 * exposes `.committee`, `.threshold` and `.counter`. No signing key is consulted, so a committee costs nothing a
 * single key does not. It serves any contract address, the vaults as well as the account.
 *
 * Measured, in two parts. Live, on all three contracts deployed on stagenet (one GraphQL query each, nothing
 * signed or submitted): the account answered a committee of one at threshold 1, counter 0, over 11 entry points,
 * and the two vaults answered the same shape over 4; the verifying key derived from each choice file matched the
 * contract's on-chain key exactly. For a committee, which is on no disk and so cannot be read live: a
 * `ContractState` carrying 2-of-3, 3-of-3 and empty committees round-trips through the indexer's own
 * deserializer with committee, threshold and counter intact. The read does not depend on the kind of authority.
 *
 * The chain carries a value and not a kind. There is no `single-key` on chain: the SDK's single key is a
 * committee of one at threshold one, and the three kinds `MaintenanceAuthorityChoice` names (committee, single key,
 * unmaintainable) are all that one struct: a committee and a threshold. A `single-key` authority over key A and a `committee` of `[A]` at threshold 1 serialize
 * to the same bytes, so `authorityShapeOf` reports the shape of the value and nothing may read `one-key` as
 * "the choice was `single-key`".
 *
 * That is why the comparison is over the value and not the label: the live authority against the intended end
 * state, not against a counter. `ReplaceAuthority` replaces wholesale, so "did my change land" is a whole-value
 * equality test and not a diff. The counter is deliberately excluded. It increments once per applied update, so
 * a byte-identical resubmission hits `ReplayCounterMismatch`, and that error carries only the address and cannot
 * say whose update landed. Comparing counters would make a settled contract look unsettled for ever. The counter
 * is part of the serialized value (0 and 7 differ in bytes), so excluding it is a decision made here.
 *
 * The answer has three states and not two: the two agree, they disagree, or the chain could not be asked. "The
 * ledger cannot answer" is not "the answer is no". `chainHolds` in `src/core/account.ts` solves the same problem
 * and this copies its shape. A contract the provider holds nothing for is `unknown`, not `disagree`:
 * `queryContractState` answers `null` both for an address with no contract and for an indexer that has not
 * caught up to the block that deployed one, and reading `null` as "your change did not land" would report a
 * definite negative from an ambiguous answer. The read keeps `absent` and `unreachable` apart, so a caller that
 * wants the distinction has it.
 */

/**
 * The shape of an authority value, which is all the chain carries.
 *
 * `one-key` is named for what it is rather than for a kind, because it is what `single-key` and a committee of
 * one at threshold one both look like on chain.
 *
 * `anyone` exists so the most dangerous value on chain is never reported under the name of the safest. A
 * threshold of zero is not "unmaintainable": the ledger's only functional read of `threshold` is a check that
 * the update carries at least that many signatures, so at 0 a maintenance update with no signatures at all is
 * well formed and anybody in the world can rewrite that contract's rules. (Committee membership is still checked
 * for any signature that is attached, so an out-of-range seat or a wrong signature is still refused; what is
 * missing is any requirement to attach one.) A threshold of zero is therefore `anyone` however many keys the
 * committee lists, and never `no-one`, which is the word for a contract nobody can ever change, nor `committee`.
 */
export type AuthorityShape = 'anyone' | 'no-one' | 'one-key' | 'committee';

/** A signing or verifying key as the runtime structures it. */
export type AuthorityKey = import('./partial-contract.js').TaggedKey;

/** A contract's maintenance authority exactly as the chain holds it. */
export interface OnChainAuthority {
  /** The committee's verifying keys, IN CHAIN ORDER — the order is part of the value. */
  committee: AuthorityKey[];
  threshold: number;
  /** Replay protection. Read and reported; never compared. */
  counter: bigint;
  shape: AuthorityShape;
  /**
   * The committee lists one key more than once, so its threshold is not what it looks like.
   * Measured on ledger 9, the build the chain runs: one signature value attached at three seats holding the
   * same key satisfies `[K,K,K]` at threshold 3 and the transaction is well formed. `committee` is a plain list of
   * Schnorr or ECDSA keys and nothing requires its entries to be distinct; the data a signer signs covers the
   * address, the updates and the counter and not the signer index, so one signature is valid at every index whose
   * slot holds that key. A committee of `[K, K, K]` at threshold 3 is satisfied by the single holder of `K`
   * signing once and attaching it at indices 0, 1 and 2, which are strictly ascending, so the ordering check
   * passes. `requireMaintenanceAuthority` checks the committee's size and the threshold's range and does not check
   * for duplicates, so this is read back and reported rather than assumed away.
   */
  hasDuplicateMembers: boolean;
}

/**
 * Four states, because the read has four honest answers and the comparison's
 * three are built from them rather than guessed at.
 */
export type AuthorityRead =
  | { state: 'read'; address: string; authority: OnChainAuthority }
  /** The provider answered and holds no contract state at this address. */
  | { state: 'absent'; address: string; why: string }
  /** The provider could not be asked, or threw. NEVER read as an answer. */
  | { state: 'unreachable'; address: string; why: string }
  /** State came back in a shape this does not recognise. Refuses; never guesses. */
  | { state: 'unreadable'; address: string; why: string };

/**
 * The shape of a value, from the value alone.
 *
 * A threshold above the committee size is the state the runtime documents as
 * valid and impossible to satisfy — *"If the threshold is greater than the
 * number of committee members, it is impossible for them to sign anything"* —
 * so it is `no-one` however many keys are listed. **MEASURED: the constructor
 * accepts it**, so this is a state that can exist and not a hypothetical.
 */
export function authorityShapeOf(
  committee: readonly AuthorityKey[], threshold: number,
): AuthorityShape {
  /* FIRST, and it must stay first: a threshold below one is satisfied by no
   * signatures at all, whatever the committee holds. */
  if (threshold < 1) return 'anyone';
  if (committee.length === 0) return 'no-one';
  if (threshold > committee.length) return 'no-one';
  if (committee.length === 1 && threshold === 1) return 'one-key';
  return 'committee';
}

/**
 * The authority off a `ContractState`, or a refusal naming what was missing.
 *
 * What counts as a readable authority is `authorityIn`'s to say, once; this adds
 * the shape and whether a key is listed twice. Every key's digits come back in
 * lower case, so a comparison against a key written in another case folds that
 * side. Structural rather than typed against the runtime class, so this boundary
 * states what it relies on and a mismatch cannot flow through as an `any`.
 */
export function authorityFromContractState(
  state: unknown,
): OnChainAuthority | { why: string } {
  const read = authorityIn(state);
  if ('why' in read) return { why: read.why };
  const committee = read.committee.map((k) => ({ tag: k.tag, value: k.value }));
  const distinct = new Set(committee.map((k) => `${k.tag.toLowerCase()}:${k.value}`));
  return {
    committee, threshold: read.threshold, counter: read.counter,
    shape: authorityShapeOf(committee, read.threshold),
    hasDuplicateMembers: distinct.size !== committee.length,
  };
}

/**
 * Just enough of a public data provider to ask one question, so the caller passes
 * the real one and a test passes a function. Named rather than `any` so a change
 * in the provider is a compile error here.
 */
export type ContractStateReader = (address: string) => Promise<unknown>;

/**
 * What authority this deployed contract carries on chain.
 *
 * A read: one query, nothing signed, nothing submitted, no key touched. A throw from the provider is
 * `unreachable` and never `absent`, because those are different answers.
 */
export async function readContractAuthority(
  read: ContractStateReader, address: string,
): Promise<AuthorityRead> {
  let state: unknown;
  try {
    state = await read(address);
  } catch (e) {
    return {
      state: 'unreachable', address,
      why: `the chain could not be asked: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (state === null || state === undefined) {
    return {
      state: 'absent', address,
      why: 'the provider answered and holds no contract state at this address — either nothing ' +
        'is deployed there, or the indexer has not caught up to the block that deployed it. ' +
        'It is not evidence that an authority is wrong.',
    };
  }
  const authority = authorityFromContractState(state);
  if ('why' in authority) return { state: 'unreadable', address, why: authority.why };
  return { state: 'read', address, authority };
}

/**
 * The on-chain value a maintenance-authority choice is meant to produce: a committee as given, a single key as a
 * committee of its verifying key at threshold one, and the unmaintainable choice as an empty committee at
 * threshold one (the ledger's own `ContractMaintenanceAuthority::new()`). It is restated here so a comparison can
 * be made without deploying anything.
 *
 * A `single-key` choice holds a signing key and the chain carries its verifying key, so a derivation is unavoidable.
 * `deriveVerifyingKey` is passed in rather than imported, because it is the runtime's and this module must stay
 * loadable without WASM. Measured against live contracts: the key derived from the choice is the key on chain,
 * exactly.
 */
export function intendedAuthorityValue(
  choice: MaintenanceAuthorityChoice,
  deriveVerifyingKey: (signingKey: AuthorityKey) => AuthorityKey,
): { committee: AuthorityKey[]; threshold: number } {
  switch (choice.kind) {
    case 'committee':
      /*
       * A threshold below one is refused here and not only in `requireMaintenanceAuthority`. A 0 typed into a
       * choice would otherwise make this return `threshold: 0`, the chain carry 0, and `compareAuthority` answer
       * `agree` over a contract anybody in the world can maintain. A comparator that agrees about a value neither
       * side should ever hold is worse than one that refuses, and this function is exported, so a caller that
       * skips `requireMaintenanceAuthority` must not get there.
       */
      if (!Number.isInteger(choice.threshold) || choice.threshold < 1) {
        throw new Error(
          `a maintenance authority at threshold ${choice.threshold} is not a committee. Set ` +
            'the threshold to at least one and no more than the number of keys in the ' +
            'committee. A threshold ABOVE the committee size is the unmaintainable state — ' +
            'say { kind: "unmaintainable" } deliberately if that is the intent, rather than ' +
            'reaching it by arithmetic. A threshold BELOW one is WORLD-WRITABLE, not ' +
            'unmaintainable: MEASURED on `@midnightntwrk/ledger-v9@1.0.0-rc.3`, a maintenance ' +
            'update carrying NO SIGNATURES AT ALL is well-formed against an authority at ' +
            'threshold zero, so anybody at all could replace this contract\'s verifier keys ' +
            'while holding nothing. Committee membership IS still checked — a signature at an ' +
            'out-of-range seat is refused, and so is a wrong signature at a valid seat — what ' +
            'is missing is any requirement to attach one. This refuses rather than comparing ' +
            'the value against the chain.',
        );
      }
      return {
        committee: choice.committee.map((k) => ({ tag: k.tag, value: k.value })),
        threshold: choice.threshold,
      };
    case 'single-key': {
      const vk = deriveVerifyingKey(choice.signingKey);
      return { committee: [{ tag: vk.tag, value: vk.value }], threshold: 1 };
    }
    case 'unmaintainable':
      return { committee: [], threshold: 1 };
  }
}

/**
 * Three states, not two. `unknown` means the chain could not be asked and nothing may be concluded from it: not
 * that the authority is wrong, and not that it is right. Collapsing it into a yes or a no is how a change gets
 * built against a chain that was never read.
 */
export type AuthorityVerdict = 'agree' | 'disagree' | 'unknown';

export interface AuthorityComparison {
  verdict: AuthorityVerdict;
  address: string;
  /** Always present. On `unknown` it says why the chain could not answer. */
  why: string;
  /** The chain's value, when there was one. */
  onChain?: OnChainAuthority;
  /** The value the choice on disk is meant to produce. */
  intended?: { committee: AuthorityKey[]; threshold: number };
}

const sameAuthorityKey = (a: AuthorityKey, b: AuthorityKey) =>
  a.tag.toLowerCase() === b.tag.toLowerCase() &&
  a.value.toLowerCase() === b.value.toLowerCase();

const authorityMultiset = (ks: readonly AuthorityKey[]) =>
  ks.map((k) => `${k.tag.toLowerCase()}:${k.value.toLowerCase()}`).sort().join('|');

/**
 * Does the chain carry what we meant to install? A half-applied change across several contracts is silent at
 * both ends unless something asks this question, per contract.
 *
 * Order is part of the value and is reported as such. The same three keys in a different order serialize to
 * different bytes. Two committees with the same members in a different order authorise exactly the same signers,
 * so calling that `disagree` is defensible only if the reason is said out loud, because "fixing" it would spend
 * a real update replacing a value with an equivalent one. It is `disagree` here, because a wholesale replace is
 * a whole-value test, and `why` names it so a caller decides knowingly.
 *
 * The counter is not compared: the comparison is against the end state, never against a counter.
 */
export function compareAuthority(
  read: AuthorityRead,
  intended: { committee: AuthorityKey[]; threshold: number },
): AuthorityComparison {
  if (read.state !== 'read') {
    return {
      verdict: 'unknown', address: read.address, intended,
      why: `the chain could not be asked what authority this contract carries — ${read.why}`,
    };
  }
  const chain = read.authority;
  const base = { address: read.address, onChain: chain, intended };

  if (chain.threshold !== intended.threshold) {
    return {
      ...base, verdict: 'disagree',
      why: `the chain carries threshold ${chain.threshold} and the intended end state is ` +
        `${intended.threshold}.`,
    };
  }
  if (chain.committee.length !== intended.committee.length) {
    return {
      ...base, verdict: 'disagree',
      why: `the chain carries ${chain.committee.length} key(s) and the intended end state has ` +
        `${intended.committee.length}.`,
    };
  }
  const inOrder = chain.committee.every((k, i) => sameAuthorityKey(k, intended.committee[i]!));
  if (inOrder) {
    return {
      ...base, verdict: 'agree',
      why: 'the chain carries the intended authority: same keys, same order, same threshold. ' +
        `Its replay counter is ${chain.counter}, which is not part of this comparison.`,
    };
  }
  if (authorityMultiset(chain.committee) === authorityMultiset(intended.committee)) {
    return {
      ...base, verdict: 'disagree',
      why: 'SAME MEMBERS, DIFFERENT ORDER. The same people can sign either way, so nothing is ' +
        'newly at risk — but the on-chain VALUE differs, and a wholesale replace is a ' +
        'whole-value test. Reordering the intended list to match the chain settles it without a ' +
        'transaction; installing it costs a real update that changes who can sign by nothing.',
    };
  }
  return {
    ...base, verdict: 'disagree',
    why: 'the chain carries a DIFFERENT SET OF KEYS from the intended end state at the same ' +
      'threshold. Whoever these keys belong to can replace the verifier keys, and so ' +
      'the rules, this contract obeys.',
  };
}
