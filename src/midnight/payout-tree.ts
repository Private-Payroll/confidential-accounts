/**
 * THE PAYOUT TREE. V-41, V-43.
 *
 * A payroll run is ONE proposal covering many payments. What the signers
 * approve is a merkle ROOT over the run's payout leaves — one leaf per person —
 * and the vault pays each person by proving that person's leaf belongs to it.
 * That is what makes a five-person company cost five payments rather than a
 * fixed batch of sixteen.
 *
 * This file builds that tree on the client, because the chain never holds it:
 * only the root travels, inside a commitment.
 *
 * WHY IT USES THE RUNTIME'S OWN TREE AND NOT A HASH FUNCTION OF OURS. The
 * contract checks membership with `merkleTreePathRoot`, which hashes the way
 * the on-chain runtime hashes. A tree built here with sha256, or with the same
 * algorithm written twice, would produce roots the contract rejects — and it
 * would do so at payment time, after the approvals were collected and the fees
 * paid. So the tree is `StateBoundedMerkleTree`, the runtime's own, driven
 * exactly as the generated contract code drives the account's signer tree.
 *
 * DEPTH 16 — 65,536 payees in one run. Measured rather than picked: depth 10
 * costs 4,682 bytes of zkir and depth 20 costs 6,883, so a thousand-fold higher
 * ceiling is 47% of a small circuit and the tree is never stored on chain. See
 * V-42.
 */
import {
  StateBoundedMerkleTree, CompactTypeBytes, CompactTypeMerkleTreePath,
} from '@midnight-ntwrk/compact-runtime';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import { toHex, fromHex, type Hex } from '../core/crypto.js';
import {
  recipientOf, type Payee, type PayeeAddress, type PayeeKind,
} from './payee-address.js';
import {
  runSecrets, type PayoutSeed, type RunIdentity, type PayeeSecrets,
} from './run-keys.js';

/** The depth the contract is compiled for. Changing one without the other is a payroll that cannot settle. */
export const PAYOUT_TREE_DEPTH = 16;

const BYTES32 = new CompactTypeBytes(32);
const aligned = (b: Uint8Array) => ({ value: BYTES32.toValue(b), alignment: BYTES32.alignment() });

/** What the contract takes, and what the chain stores. `Bytes<32>`, always. */
const ROOT_WIDTH = 32;

/**
 * THE ROOT AS THIRTY-TWO BYTES, AND IT IS NOT ALWAYS THIRTY-TWO WITHOUT THIS.
 *
 *
 * `rehash().root()` hands back a FIELD ELEMENT, and the runtime encodes one
 * MINIMALLY: a root whose top byte is zero arrives thirty-one bytes long, about
 * one run in 256. `toHex` then gives sixty-two characters and `fromHex` gives
 * the circuit thirty-one bytes where it declared thirty-two.
 *
 * **A SHORT ROOT FAILS LOUDLY AT EVERY DOOR, AND `C369`'S ROW SAID OTHERWISE.**
 * The row and this round's brief both describe a QUIET half in which a
 * thirty-one-byte root reaches `recordPayment`'s
 * `merkleTreePathRoot(path) == root` and is read as *"that payee is not in the
 * approved run"*. **It cannot.** Every generated binding checks the length
 * before the circuit runs — `recordPayment`'s at
 * `contracts/managed/contract/index.js:610`, `runPayload`'s beside it — so the
 * run cannot be raised, and could not be claimed if it somehow were. Nobody has
 * signed anything and no money is at risk.
 *
 * **THE SILENT FAILURE IS THE OBVIOUS-LOOKING FIX, AND THAT IS WHY THE END IS
 * WRITTEN DOWN HERE.** A root padded at the FRONT is thirty-two bytes: every
 * binding accepts it, `proposeRun` writes it, the signers approve it — and then
 * **every `recordPayment` is refused as "that payee is not in the approved
 * run", after the approvals were collected and the fees paid.** The encoding is
 * little-endian, so the byte a minimal encoding drops is the LAST one.
 * **Measured rather than reasoned: `S41` padded the same root at each end and
 * watched the contract accept the back-padded one and refuse the front-padded
 * one.** `payout-runs.test.ts` pins that against the contract rather than
 * against this comment.
 *
 * **ONE HELPER AND NOT TWO FIXES**, for the reason that outlives the defect:
 * `rootOfLeaves` and `buildPayoutTree` must agree about a root byte for byte or
 * `V-72`'s status view proves nothing. Two independent fixes are `M-104`, in a
 * file that had just demonstrated it.
 *
 * It pads to width rather than by one, because two top zero bytes is the same
 * defect at one run in 65,536, and it REFUSES anything wider instead of
 * truncating: a root the runtime made longer than the circuit takes is not
 * something to quietly cut down to size.
 */
const rootBytesOf = (root: { value: readonly Uint8Array[] }): Uint8Array => {
  const encoded = new Uint8Array(root.value[0]);
  if (encoded.length > ROOT_WIDTH) {
    throw new Error(
      `the payout tree hashed to ${encoded.length} bytes; a run's root is ${ROOT_WIDTH}`);
  }
  const padded = new Uint8Array(ROOT_WIDTH);
  padded.set(encoded);
  return padded;
};

/** One payment, as the run commits to it. */
export interface PayoutLeafInput {
  /**
   * The payment's details, as a commitment: who, in what token, how much,
   * blinded.
   *
   * A HASH RATHER THAN THE PARTS, and the split is the whole privacy story.
   * The VAULT owns the rule that turns a payment into these bytes, because the
   * vault is the only contract that ever sees a recipient. The ACCOUNT — and
   * this file, which builds what the account will check — sees an opaque 32
   * bytes and could not identify a payee if it tried.
   *
   * The blinding inside it is not decoration: without one, the details would be
   * a hash of three guessable values — an address anybody can read off the
   * chain, one of a handful of token types, and an amount somebody may know —
   * so a watcher could confirm a guess about who was paid what.
   */
  details: Hex;
  /**
   * The per-payee NONCE, and the reason this file is not simply a tree of
   * payment hashes. V-43.
   *
   * A claim discloses its merkle path, and a path's level-0 sibling IS the
   * neighbouring leaf's hash. So the first payment of a run publishes a leaf
   * value for somebody who has not been paid yet. If quoting a leaf were enough
   * to claim it, anybody watching could mark the rest of the payroll paid and
   * the account could not refuse them, because a contract cannot see its
   * caller. This nonce is what a claim must know and a watcher cannot learn.
   *
   * **It must be fresh and unguessable per payee.** Deriving it from the
   * payee's identity, or reusing one across a run, reopens exactly the hole it
   * closes.
   */
  nonce: Hex;
}

export interface PayoutTree {
  /** What the signers approve, and what the contract checks membership against. */
  root: Hex;
  /** How many payees. Bound into the proposal's payload beside the root. */
  payees: bigint;
  /** Leaf hashes, in tree order. */
  leaves: Hex[];
  /**
   * The membership proof for one payee, in the shape the circuit takes.
   *
   * `unknown` rather than a named type on purpose: the shape is the generated
   * contract's `MerkleTreePath<16, Bytes<32>>`, and naming it here would be a
   * second declaration of a type the compiler already owns.
   */
  pathFor(index: number): unknown;
  /** Where a payee sits, by leaf. */
  indexOf(leaf: Hex): number;
}

/**
 * One payee's leaf: the payment's details, hashed with that payee's own secret.
 *
 * From the CONTRACT's own circuit rather than recomputed here. The account
 * recomputes this leaf when a payment is claimed, and a client that derived it
 * a second way would build a tree the chain rejects — after the approvals were
 * collected and the fees paid. One definition; see `one-definition.test.ts`.
 */
export const payoutLeafOf = (p: PayoutLeafInput): Hex =>
  toHex(pureCircuits.payoutLeaf(fromHex(p.details), fromHex(p.nonce)));

/**
 * Builds the run's tree.
 *
 * Order matters and is the caller's): a payee's index is where their leaf sits,
 * and the path proves membership at that position. Two runs with the same
 * people in a different order are different roots, which is correct — they are
 * different runs.
 */
/**
 * The root of a set of LEAF VALUES. V-72.
 *
 * `buildPayoutTree` starts from the payments; this starts from the hashes,
 * because that is all a reporting view ever holds — the leaves are not secret
 * and travel with the run, while the details and nonces behind them do not.
 *
 * What it is for: rebuilding a run's proposal id from the leaves in hand, so a
 * status view can prove it is describing the run it thinks it is rather than a
 * stale payroll with the same number of people in it.
 */
export const rootOfLeaves = (leaves: Hex[]): Hex => {
  if (leaves.length === 0) throw new Error('a payroll run needs at least one payee');
  if (leaves.length > 2 ** PAYOUT_TREE_DEPTH) {
    throw new Error(`a run holds at most ${2 ** PAYOUT_TREE_DEPTH} payees`);
  }
  let tree = new StateBoundedMerkleTree(PAYOUT_TREE_DEPTH);
  leaves.forEach((leaf, i) => { tree = tree.update(BigInt(i), aligned(fromHex(leaf))); });
  const root = tree.rehash().root();
  if (!root) throw new Error('the payout tree did not hash');
  return toHex(rootBytesOf(root));
};

export const buildPayoutTree = (payments: PayoutLeafInput[]): PayoutTree => {
  if (payments.length === 0) {
    /*
     * Refused here AND on chain — `proposeRun` asserts the same thing. A run
     * with no payees would collect approvals, cost a fee and settle nothing.
     * Two guards rather than one because this one gives a person a sentence and
     * that one gives an attacker nothing.
     */
    throw new Error('a payroll run needs at least one payee');
  }
  if (payments.length > 2 ** PAYOUT_TREE_DEPTH) {
    throw new Error(
      `a run holds at most ${2 ** PAYOUT_TREE_DEPTH} payees; this one has ${payments.length}`);
  }

  const leaves = payments.map(payoutLeafOf);

  /*
   * TWO PAYEES WITH THE SAME LEAF IS ONE PAYEE WHO NEVER GETS PAID. B10.
   *
   * A leaf is the payment's details hashed with that payee's nonce, so two
   * identical leaves mean somebody reused a nonce — or, more likely, generated
   * one from something that is not unique. The account refuses the second claim
   * as a replay, because from where it stands the two ARE the same payment.
   *
   * The failure is silent and late: the run is approved, most of it pays, and
   * one person is quietly unpayable with no error naming them. Refused here,
   * before anybody signs anything, because a run is cheap to rebuild and an
   * approved run is not.
   */
  const seen = new Map<string, number>();
  leaves.forEach((leaf, i) => {
    const first = seen.get(leaf);
    if (first !== undefined) {
      throw new Error(
        `payees ${first} and ${i} have the same leaf — a nonce has been reused, and the ` +
        `second of them could never be paid`);
    }
    seen.set(leaf, i);
  });

  let tree = new StateBoundedMerkleTree(PAYOUT_TREE_DEPTH);
  leaves.forEach((leaf, i) => { tree = tree.update(BigInt(i), aligned(fromHex(leaf))); });
  const hashed = tree.rehash();

  const rootValue = hashed.root();
  if (!rootValue) throw new Error('the payout tree did not hash');

  /*
   * The root arrives as a field element wrapped in a digest, which is why the
   * contract casts it before comparing — and why it needs padding to the width
   * the circuit declares. One helper, used here and by `rootOfLeaves`.
   */
  const rootBytes = rootBytesOf(rootValue);

  const pathType = new CompactTypeMerkleTreePath(PAYOUT_TREE_DEPTH, BYTES32);

  return {
    root: toHex(rootBytes),
    payees: BigInt(payments.length),
    leaves,
    indexOf: (leaf) => leaves.indexOf(leaf),
    pathFor: (index) => {
      const raw = hashed.pathForLeaf(BigInt(index), aligned(fromHex(leaves[index])));
      if (!raw) throw new Error(`no path for payee ${index}`);
      return pathType.fromValue(raw.value);
    },
  };
};

/* ------------------------------------------------------------------------
 * A WHOLE RUN, BUILT FROM THE ACCOUNT'S SEED RATHER THAN FROM THIS MACHINE
 * ------------------------------------------------------------------------ */

/**
 * One payment, as a person would describe it.
 *
 * `payee` IS THE ADDRESS AND NOT A KEY, and that is the whole of A-1.
 *
 * This interface used to say `recipient: Hex` — the coin public key alone —
 * and the payee's ENCRYPTION key, the one that decides whether they can ever
 * see the payment, was a separate field on `VaultPayment` that nothing outside
 * a test ever filled in. Both `C7` and `V-78` claimed the key "travels in
 * PaymentFacts"; it did not, and rating a risk on a mitigation that was not
 * there is `V-80`.
 *
 * Now there is one value and both halves come out of decoding it, so a payment
 * cannot be built for the right person under a key they cannot read. What it
 * still cannot stop is the wrong person's correct address — `V-78`.
 */
export interface PaymentFacts {
  /**
   * **AND THE KIND OF MONEY LIVES HERE, PER PAYEE, BECAUSE THAT IS WHERE IT
   * ACTUALLY LIVES.**
   *
   * `S6j` established the property from the contract's side: the kind is
   * committed into each LEAF and nothing at the account learns about it, so
   * **one approved run can hold both kinds side by side, payee by payee.** A
   * run-level choice would have been a client inventing a constraint the chain
   * does not have — and worse, a client that could apply the wrong one to
   * everybody at once.
   *
   * `Payee` is a discriminated union whose tag comes out of the same decode as
   * the 32 bytes that go to the circuit, so there is no field here that could
   * name one kind while the address names the other.
   */
  payee: Payee;
  token: Hex;
  amount: bigint;
}

/**
 * **A RUN'S PAYMENTS WHERE EVERY PAYEE IS PRIVATE, SAID IN THE TYPE RATHER THAN
 * IN A COMMENT.**
 *
 * `PaymentFacts` carries either kind, because the vault holds both and one
 * approved run can mix them. **The ROSTER cannot yet**: a roster entry's
 * address comes from the payee's own device through `payeeAddress`, which
 * parses a `shield-addr` and refuses everything else, and nothing in identity
 * has been given a way to record a public one (`V-105`).
 *
 * So `PayrollService.paymentFactsFor` returns this, and the day the roster
 * learns about public payees the change is a compiler error at every site that
 * relied on it rather than a silent widening.
 */
export type ShieldedPaymentFacts = PaymentFacts & { payee: PayeeAddress };

/** What a vault needs to make one payment, beside the proposal's own arguments. */
export interface PayeeArgs extends PaymentFacts {
  index: number;
  /** Where this payee sat in the run these facts came from. Differs from `index` in a retry. */
  originalIndex: number;
  blinding: Hex;
  nonce: Hex;
  details: Hex;
  leaf: Hex;
  path: unknown;
}

export interface PayrollRun {
  tree: PayoutTree;
  identity: RunIdentity;
  facts: PaymentFacts[];
  secrets: PayeeSecrets[];
  payments: PayoutLeafInput[];
  /** Everything needed to pay payee `i`, assembled once and not by the caller. */
  payeeArgs(index: number): PayeeArgs;
  /** Which payee of the ORIGINAL run each position came from. Identity, except in a retry. */
  originalIndices: number[];
}

/**
 * The vault's own `payoutDetails` circuit.
 *
 * PASSED IN, NEVER IMPORTED OR REIMPLEMENTED — the same rule `run-status.ts`
 * follows for `paidMovementOf`. The vault owns what turns a payment into 32
 * opaque bytes, because the vault is the only contract that ever sees a
 * recipient. A second derivation here would build a tree the chain rejects
 * **after the approvals were collected and the fees paid.**
 */
export type DetailsOf = (
  recipient: Uint8Array, token: Uint8Array, amount: bigint, blinding: Uint8Array,
) => Uint8Array;

/**
 * **BOTH OF THE VAULT'S DETAILS CIRCUITS, AND A RUN CANNOT BE BUILT WITH ONE.**
 * `C246`, and it is the client half of the row the contract closed.
 *
 * `S6j` gave the vault `unshieldedPayoutDetails` beside `payoutDetails` — a
 * commitment over FOUR values under `pad(32, "midnight-vault:unshielded:")`
 * rather than three — precisely so that **a leaf built for one kind cannot
 * satisfy the other.** That is worth nothing if the client derives every leaf
 * of a run the same way: the run is then approved for one kind, and the payee
 * whose money is the other kind is unpayable, or — the direction that costs
 * money — payable through the wrong door if the separation were ever weakened.
 *
 * **A `Record` over the union rather than two optional fields**, so the
 * compiler requires both and would require a third the day a third kind exists.
 * `buildRun` indexes it by the PAYEE's own kind; nothing chooses.
 *
 * PASSED IN, NEVER IMPORTED, for `DetailsOf`'s own reason: the vault owns what
 * turns a payment into 32 opaque bytes, and a second derivation here builds a
 * tree the chain rejects after the approvals are collected and the fees paid.
 */
export type DetailsOfKind = Readonly<Record<PayeeKind, DetailsOf>>;

const assemble = (
  tree: PayoutTree,
  identity: RunIdentity,
  facts: PaymentFacts[],
  secrets: PayeeSecrets[],
  payments: PayoutLeafInput[],
  originalIndices: number[],
): PayrollRun => ({
  tree,
  identity,
  facts,
  secrets,
  payments,
  originalIndices,
  payeeArgs: (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= facts.length) {
      throw new Error(`this run has ${facts.length} payees; there is no payee ${index}`);
    }
    return {
      index,
      originalIndex: originalIndices[index],
      ...facts[index],
      blinding: secrets[index].blinding,
      nonce: secrets[index].nonce,
      details: payments[index].details,
      leaf: tree.leaves[index],
      path: tree.pathFor(index),
    };
  },
});

/**
 * BUILDS A RUN THAT ANY ADMIN CAN REBUILD. V-63.
 *
 * Hand it the account's payout seeds, the run's identity and the payroll, and
 * it produces the tree the signers approve and every secret needed to pay it —
 * with **nothing random in it**. Call it again on another admin's machine, with
 * the same payroll, and you get the same root, the same leaves and the same
 * arguments. That is the property the whole file exists for: a run belongs to
 * the account, not to the laptop that raised it.
 *
 * WHAT MUST MATCH FOR A REBUILD TO WORK, stated plainly because a mismatch is
 * silent until payday: the seed at `identity.epoch`, the account id, the run
 * id, and the payroll **in the same order**. Order is part of the run — two
 * runs with the same people in a different order are different roots, which is
 * correct, because they are different runs (see `buildPayoutTree`).
 */
export const buildRun = (
  seeds: PayoutSeed[],
  identity: RunIdentity,
  facts: PaymentFacts[],
  /**
   * **BOTH DERIVATIONS, AND THE PAYEE PICKS.**
   *
   * This used to be a single `DetailsOf` for a whole run, which is `V-103`'s
   * client half: a run built through it was entirely one kind, and the kind it
   * was came from whichever circuit the CALL SITE happened to pass. The leaf is
   * the only place the kind is recorded — `recordPayment` sees 32 opaque bytes —
   * so a call site getting this wrong is an approval that authorises the wrong
   * door, against a real signature, for money that cannot come back.
   */
  detailsOf: DetailsOfKind,
): PayrollRun => {
  const secrets = runSecrets(seeds, identity, facts.length);

  /*
   * **THE DERIVATION AND THE RECIPIENT BYTES COME FROM THE SAME PAYEE, IN THE
   * SAME EXPRESSION** — the move `payee-address.ts` makes for `C7`'s two keys,
   * applied to `C246`'s two key spaces. There is no line here at which a
   * shielded payee's coin key could be committed under the unshielded
   * derivation, because neither value is chosen: both are read off `f.payee`,
   * whose kind came out of the decode that produced its bytes.
   */
  const payments: PayoutLeafInput[] = facts.map((f, i) => ({
    details: toHex(detailsOf[f.payee.kind](
      fromHex(recipientOf(f.payee)), fromHex(f.token), f.amount, fromHex(secrets[i].blinding))),
    nonce: secrets[i].nonce,
  }));

  return assemble(
    buildPayoutTree(payments), identity, facts, secrets, payments,
    facts.map((_, i) => i));
};

/**
 * A RETRY RUN, FOR THE PEOPLE A RUN DID NOT REACH. V-64.
 *
 * Wifi dies at payee 40 of 50. This builds the run that pays the other ten.
 *
 * **IT REUSES THE ORIGINAL SECRETS, AND THAT IS THE ENTIRE POINT.** A payment's
 * paid-once record on chain is its leaf, so a person who appears in the
 * original run and in this one cannot be paid twice — whichever transaction
 * lands first wins and the other is refused. Deriving fresh secrets for the
 * retry would produce DIFFERENT leaves, which are different payments, which
 * both settle. That is a double payment built out of a helpful-looking
 * refactor, so the reuse is load-bearing rather than an optimisation.
 *
 * It also means a retry can be approved and submitted while the original run is
 * still open, which is what lets a run's window be days rather than minutes.
 *
 * The indices are the ORIGINAL run's — `stillToPay(runStatus(...))` returns
 * exactly this list, read from the chain rather than from anyone's memory, so a
 * payment that landed during a timeout is excluded automatically.
 */
export const buildRetryRun = (original: PayrollRun, indices: number[]): PayrollRun => {
  if (indices.length === 0) throw new Error('nothing outstanding to retry');

  const seen = new Set<number>();
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= original.payments.length) {
      throw new Error(`payee ${i} is not in the original run`);
    }
    if (seen.has(i)) throw new Error(`payee ${i} listed twice`);
    seen.add(i);
  }

  const payments = indices.map((i) => original.payments[i]);
  return assemble(
    buildPayoutTree(payments),
    original.identity,
    indices.map((i) => original.facts[i]),
    indices.map((i) => original.secrets[i]),
    payments,
    indices,
  );
};
