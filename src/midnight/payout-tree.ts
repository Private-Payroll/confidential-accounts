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
 * A SUM TREE, SO THE ROOT BINDS WHAT THE RUN PAYS IN TOTAL. Every leaf node
 * hashes a payee's leaf with the amount it pays; every inner node hashes both
 * children AND both children's sums; the root hashes the top node, the run's
 * total and the one asset it pays in. Because each sum is inside the node
 * above it, the amounts any set of payments can prove against a root add up to
 * at most the total that root names. A tree that hashed only each node's
 * combined sum would bind nothing: a payment's sibling sum would be whatever
 * the payer said it was.
 *
 * WHY IT CALLS THE CONTRACT'S OWN NODE CIRCUITS AND NOT A HASH FUNCTION OF
 * OURS. The account walks a payment's path with `sumPathRoot`, and a tree
 * built here any other way would produce roots the contract rejects - at
 * payment time, after the approvals were collected and the fees paid. So every
 * node is `sumLeafNode`, `sumInnerNode` or `sumRootOf`, called through
 * `pureCircuits`.
 *
 * DEPTH 16 - 65,536 payees in one run. A subtree with no payees in it is the
 * node 0 with the sum 0, which no payment can open.
 */
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import { toHex, fromHex, type Hex } from '../core/crypto.js';
import { assetIdHex, NO_ASSET, symbolOf, type AssetId, type LedgerForm } from '../core/assets.js';
import {
  recipientOf, type Payee, type PayeeAddress, type PayeeKind,
} from './payee-address.js';
import {
  runSecrets, type PayoutSeed, type RunIdentity, type PayeeSecrets, type PayRecord, type PayRecords,
} from './run-keys.js';

/** The depth the contract is compiled for. Changing one without the other is a payroll that cannot settle. */
export const PAYOUT_TREE_DEPTH = 16;

/** The largest amount a sum in the tree may reach: the contract casts every sum to 128 bits. */
const MAX_SUM = (1n << 128n) - 1n;

/** The element at `i`, or a refusal naming what was missing. Every index here was checked before it is read. */
const at = <T>(xs: readonly T[], i: number, what: string): T => {
  const x = xs[i];
  if (x === undefined) throw new Error(`there is no ${what} at position ${i}`);
  return x;
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
   * payment hashes.
   *
   * Recording a payment takes the leaf's preimage - these details and this
   * nonce - beside the run's salt and the payee's path. `recordPaymentFromVault`
   * cannot see who calls it, so whoever knows all four can record that payment
   * as made without making it. None of those four is published by a payment: the
   * vault hands them to the account inside a call whose arguments travel under
   * a commitment with fresh randomness, and what the account's circuit makes
   * public is the proposal, the vault, the window and the two recorded values. So a
   * watcher learns no leaf, no path and no nonce from a landed payment, and
   * cannot mark anybody else paid. This nonce is one of the things a claim must
   * know that a watcher does not, and the salt, held only under the company's
   * viewing key, is another. (Read from the compiled circuits and the ledger's
   * call format; not yet from the bytes of a landed transaction.)
   *
   * **It must be unguessable, and it is the same for one person, month, kind
   * and occurrence however often a run is drawn.** It is derived from the
   * account's pay-record key, which nobody outside the company holds, and the
   * account records a value made from it with every payment and refuses a
   * second one. Two payees of one run with the same nonce are refused below.
   */
  nonce: Hex;
}

/** One level of a payee's path, in the shape the contract's `SumStep` takes. */
export interface SumStep {
  sibling: bigint;
  siblingSum: bigint;
  goesLeft: boolean;
}

export interface PayoutTree {
  /** What the signers approve: it commits the tree, the total and the asset. */
  root: Hex;
  /** How many payees. Bound into the proposal's payload beside the root. */
  payees: bigint;
  /** Leaf hashes, in tree order. */
  leaves: Hex[];
  /** What each leaf pays, in tree order. */
  amounts: bigint[];
  /** The token the run pays in: what its root commits to, and what the vault hands the account when it pays. */
  asset: Hex;
  /** The sum of `amounts`: what the root binds the run to pay at most. */
  total: bigint;
  /** The top node, which the root hashes beside the total and the token. */
  top: bigint;
  /** One payee's path, from their leaf node up to the top. */
  pathFor(index: number): SumStep[];
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
 * **THE VALUE THE ACCOUNT RECORDS FOR THE PERSON AND MONTH A NONCE STANDS FOR.**
 * The contract's own `paidOnceOf`, called and never derived a second way.
 */
export const paidOnceOfNonce = (nonce: Hex): Hex =>
  toHex(pureCircuits.paidOnceOf(fromHex(nonce)));

/**
 * **THE VALUE THE ACCOUNT RECORDS WHEN THIS LEAF IS PAID.** The contract's own
 * `paidMovementOf`, called and never derived a second way. A payee who holds
 * this value can find out whether they were paid by testing it against the
 * account's public set of completed payments, on their own device, without
 * naming their leaf to anybody.
 */
export const paidMovementOfLeaf = (leaf: Hex): Hex =>
  toHex(pureCircuits.paidMovementOf(fromHex(leaf)));

/** A node of the sum tree and the sum of the amounts under it. */
interface SumNode { node: bigint; sum: bigint }

/** The node standing for a subtree with no payees in it. */
const EMPTY: SumNode = { node: 0n, sum: 0n };

/**
 * Every level of a sum tree over these leaves and amounts, leaves first and the
 * top last. Only nodes with a payee under them are held; the rest are `EMPTY`.
 */
const levelsOf = (leaves: Hex[], amounts: bigint[]): SumNode[][] => {
  if (leaves.length === 0) throw new Error('a payroll run needs at least one payee');
  if (leaves.length > 2 ** PAYOUT_TREE_DEPTH) {
    throw new Error(
      `a run holds at most ${2 ** PAYOUT_TREE_DEPTH} payees; this one has ${leaves.length}`);
  }
  if (amounts.length !== leaves.length) {
    throw new Error(
      `this run has ${leaves.length} payees and ${amounts.length} amounts; every payee is paid one amount`);
  }
  amounts.forEach((a, i) => {
    if (a < 0n) {
      throw new Error(`payee ${i + 1}'s amount is below zero, and a payment is never negative; correct the amount`);
    }
    if (a > MAX_SUM) {
      throw new Error(`payee ${i + 1}'s amount is larger than any payment can be; check the amount and its units`);
    }
  });
  const levels: SumNode[][] = [leaves.map((leaf, i) => ({
    node: pureCircuits.sumLeafNode(fromHex(leaf), at(amounts, i, 'amount')),
    sum: at(amounts, i, 'amount'),
  }))];
  for (let d = 0; d < PAYOUT_TREE_DEPTH; d++) {
    const below = at(levels, d, 'level');
    const above: SumNode[] = [];
    for (let j = 0; j < below.length; j += 2) {
      const left = at(below, j, 'node');
      const right = below[j + 1] ?? EMPTY;
      const sum = left.sum + right.sum;
      /* Refused here as the contract refuses it: a sum past 128 bits cannot be cast back. */
      if (sum > MAX_SUM) throw new Error("this run's total is larger than any run can carry; check the amounts and their units");
      above.push({ node: pureCircuits.sumInnerNode(left.node, left.sum, right.node, right.sum), sum });
    }
    levels.push(above);
  }
  return levels;
};

/**
 * The root of a set of LEAF VALUES at their amounts, in one token.
 *
 * `buildPayoutTree` starts from the payments; this starts from the hashes,
 * because that is all a reporting view ever holds - the leaves are not secret
 * and travel with the run, while the details and nonces behind them do not.
 *
 * What it is for: rebuilding a run's proposal id from the leaves in hand, so a
 * status view can prove it is describing the run it thinks it is rather than a
 * stale payroll with the same number of people in it.
 */
export const rootOfLeaves = (leaves: Hex[], amounts: bigint[], asset: Hex): Hex =>
  sumTreeOfLeaves(leaves, amounts, asset).root;

/**
 * The sum tree over these leaf values at these amounts in one asset: its root,
 * total and top node, and each position's path. It refuses nothing about the
 * leaves themselves; `buildPayoutTree` is the door that does.
 */
export const sumTreeOfLeaves = (
  leaves: Hex[], amounts: bigint[], asset: Hex,
): Pick<PayoutTree, 'root' | 'total' | 'top' | 'pathFor'> => {
  const levels = levelsOf(leaves, amounts);
  const top = at(at(levels, PAYOUT_TREE_DEPTH, 'level'), 0, 'top');
  return {
    root: toHex(pureCircuits.sumRootOf(top.node, top.sum, fromHex(asset))),
    total: top.sum,
    top: top.node,
    pathFor: (index) => {
      at(leaves, index, 'payee');
      const path: SumStep[] = [];
      for (let d = 0; d < PAYOUT_TREE_DEPTH; d++) {
        const here = index >> d;
        const sibling = at(levels, d, 'level')[here ^ 1] ?? EMPTY;
        path.push({ sibling: sibling.node, siblingSum: sibling.sum, goesLeft: (here & 1) === 0 });
      }
      return path;
    },
  };
};

/**
 * **THE ASSET A RUN'S ROOT COMMITS TO IS THE TOKEN ITSELF.** It is exactly what
 * the vault hands the account when it pays: the spent coin's colour for a
 * private payment, the token it sends for a public one. Both forms of a token
 * are the same 32 bytes, so it is also what the account's asset key and a
 * proposal's change are made from, and what a spending policy is looked up by.
 */
export const runAssetOf = (asset: AssetId): Hex => assetIdHex(asset) as Hex;

/** The word a person reads for a form of money. */
const formWord = (form: LedgerForm): string => (form === 'shielded' ? 'private' : 'public');

/**
 * **ONE RUN PAYS ONE TOKEN, IN ONE FORM, AND A RUN THAT WOULD NOT IS REFUSED
 * BEFORE ANYTHING IS BUILT.**
 *
 * A run's root commits to one token, and the vault pays each payment out of
 * the token its leaf names, in the form its payee is paid in. A payment in a
 * different token from the run's is a leaf the account refuses once the money
 * has moved; a run mixing private and public payees is approved as one round
 * over two kinds of money. A payroll with both kinds of payee is raised as two
 * runs side by side, each approved on its own. Refused here, by naming what
 * differs, before anybody signs anything.
 */
export const refuseAMixedRun = (
  facts: readonly Pick<PaymentFacts, 'payee' | 'token'>[], asset: AssetId,
): void => {
  if (asset === NO_ASSET) {
    throw new Error('a run has to name the token it pays in, and this one names no asset. Nothing was built.');
  }
  runAssetOf(asset);
  const forms = [...new Set(facts.map((f) => f.payee.kind))];
  if (forms.length > 1) {
    const first = facts.findIndex((f) => f.payee.kind !== facts[0]!.payee.kind);
    throw new Error(
      `This run has both private and public payments (payment 1 is ${formWord(facts[0]!.payee.kind)}, `
      + `payment ${first + 1} is ${formWord(facts[first]!.payee.kind)}). A run pays one token, one way. `
      + 'Create one run for the private payments and one for the public payments. Each is approved on its own. '
      + 'Nothing was created.');
  }
  const other = facts.findIndex((f) => f.token.toLowerCase() !== asset);
  if (other >= 0) {
    throw new Error(
      `Payment ${other + 1} is in ${symbolOf(facts[other]!.token.toLowerCase())} and this run pays `
      + `${symbolOf(asset)}. A run pays one token. Create a separate run for `
      + `${symbolOf(facts[other]!.token.toLowerCase())}. Nothing was created.`);
  }
};

/**
 * The root of a run's leaves at the amounts its payments name, in the run's
 * token: `rootOfLeaves` over what a run's records already hold. Refuses a set
 * of payments that mixes tokens or forms, as `buildRun` does.
 */
export const rootOfPayments = (leaves: Hex[], facts: readonly PaymentFacts[], asset: AssetId): Hex => {
  refuseAMixedRun(facts, asset);
  return rootOfLeaves(leaves, facts.map((f) => f.amount), runAssetOf(asset));
};

/**
 * Builds the run's tree.
 *
 * Order matters and is the caller's: a payee's index is where their leaf sits,
 * and the path proves membership at that position. Two runs with the same
 * people in a different order are different roots, which is correct - they are
 * different runs.
 */
export const buildPayoutTree = (payments: PayoutLeafInput[], amounts: bigint[], asset: Hex): PayoutTree => {
  if (payments.length === 0) {
    /*
     * Refused here AND on chain - `propose` asserts the same thing. A run
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
   * TWO PAYEES WITH THE SAME LEAF IS ONE PAYEE WHO NEVER GETS PAID.
   *
   * A leaf is the payment's details hashed with that payee's nonce, so two
   * identical leaves mean somebody reused a nonce - or, more likely, generated
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

  /*
   * **TWO PAYEES WITH THE SAME NONCE IS ONE PERSON PAID TWICE FOR ONE MONTH,
   * OR ONE PAYEE WHO NEVER GETS PAID.** The account refuses the second payment
   * whose nonce it has already recorded, whatever its amount or address, so a
   * run listing one person twice for one month - or a payment and its
   * correction both as the first - would be approved and then half refused on
   * chain, late and silently. Refused here, before anybody signs anything.
   */
  const nonces = new Map<string, number>();
  payments.forEach((p, i) => {
    const key = p.nonce.toLowerCase();
    const first = nonces.get(key);
    if (first !== undefined) {
      throw new Error(
        `payees ${first + 1} and ${i + 1} on this run are the same person, paid for the same month. ` +
        'Remove one of them. If both payments are meant, pay the second as a numbered extra');
    }
    nonces.set(key, i);
  });

  const tree = sumTreeOfLeaves(leaves, amounts, asset);
  return {
    ...tree,
    payees: BigInt(payments.length),
    leaves,
    amounts: [...amounts],
    asset,
    indexOf: (leaf) => leaves.indexOf(leaf),
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
   * **AND THE KIND OF MONEY IS READ OFF THE PAYEE, BECAUSE THAT IS WHERE IT
   * ACTUALLY LIVES.**
   *
   * The kind is committed into each LEAF, and the payee's address decides it.
   * **One run pays one token in one form**: `buildRun` refuses payments of
   * more than one kind, so a payroll with both kinds of payee is two runs,
   * raised side by side and each approved on its own.
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
 * `PaymentFacts` carries either kind, because the vault holds both. A run's
 * payments are all of one kind, the form its payees' addresses are; this
 * narrower type is for a caller whose payments must all be private.
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
  path: SumStep[];
  /** The run's token, which its root commits to and every payment on it moves. */
  asset: Hex;
}

export interface PayrollRun {
  tree: PayoutTree;
  identity: RunIdentity;
  facts: PaymentFacts[];
  /** What each payee is paid for, in tree order: the person, the month, the kind and the occurrence. */
  records: PayRecord[];
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
  records: PayRecord[],
  secrets: PayeeSecrets[],
  payments: PayoutLeafInput[],
  originalIndices: number[],
): PayrollRun => ({
  tree,
  identity,
  facts,
  records,
  secrets,
  payments,
  originalIndices,
  payeeArgs: (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= facts.length) {
      throw new Error(`this run has ${facts.length} payees; there is no payee ${index}`);
    }
    return {
      index,
      originalIndex: at(originalIndices, index, 'payee'),
      ...at(facts, index, 'payee'),
      blinding: at(secrets, index, 'payee').blinding,
      nonce: at(secrets, index, 'payee').nonce,
      details: at(payments, index, 'payee').details,
      /* The payee's position in this run's own tree: a retry pays over a tree of only the people it names. */
      leaf: at(tree.leaves, index, 'payee'),
      path: tree.pathFor(index),
      asset: tree.asset,
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
 * id, the pay-record key and what each payee is paid for, and the payroll **in
 * the same order**. Order is part of the run — two
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
  /**
   * **THE ACCOUNT'S PAY-RECORD KEY AND WHAT EACH PAYEE IS PAID FOR.** Each
   * payee's nonce is derived from them, so the account refuses a second payment
   * to one person for one month, kind and occurrence. One record per payment,
   * in the same order.
   */
  pay: PayRecords,
  /** The token the run pays in. Every payment on it moves this token, in one form. */
  asset: AssetId,
): PayrollRun => {
  refuseAMixedRun(facts, asset);
  if (pay.records.length !== facts.length) {
    throw new Error(
      `this run has ${facts.length} payments and says what ${pay.records.length} of them are for; ` +
      'every payment names the person, the month and the kind of pay it is');
  }
  const secrets = runSecrets(seeds, identity, pay);

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
      fromHex(recipientOf(f.payee)), fromHex(f.token), f.amount, fromHex(at(secrets, i, 'payee').blinding))),
    nonce: at(secrets, i, 'payee').nonce,
  }));

  return assemble(
    buildPayoutTree(payments, facts.map((f) => f.amount), runAssetOf(asset)),
    identity, facts, pay.records, secrets, payments, facts.map((_, i) => i));
};

/**
 * A RETRY RUN, FOR THE PEOPLE A RUN DID NOT REACH. V-64.
 *
 * Wifi dies at payee 40 of 50. This builds the run that pays the other ten.
 *
 * **IT REUSES THE ORIGINAL SECRETS, AND THAT IS THE ENTIRE POINT.** A payment's
 * records on chain are its leaf and its nonce, so a person who appears in the
 * original run and in this one cannot be paid twice — whichever transaction
 * lands first wins and the other is refused. Deriving fresh secrets for the
 * retry would produce DIFFERENT leaves, which are different payments, which
 * both settle. That is a double payment built out of a helpful-looking
 * refactor, so the reuse is load-bearing rather than an optimisation.
 *
 * It also means a retry can be approved and submitted while the original run is
 * still open, which is what lets a run's window be days rather than minutes.
 *
 * **AND IT IS RAISED OVER A TREE OF ITS OWN, OF ONLY THE PEOPLE NAMED HERE**,
 * each at the leaf the original run gave them. Its root, total and payee count
 * are those people's, so an approval of a retry authorises paying them and
 * nobody else the original run named, and a spending policy charges a retry
 * its own total. A retry in the same period as its run is charged that total on
 * top of the run's, which counts the same people's money twice against the
 * period's limit; it can refuse a retry, and it pays nobody twice.
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

  refuseAMixedRun(indices.map((i) => at(original.facts, i, 'payee')), original.tree.asset);
  const payments = indices.map((i) => at(original.payments, i, 'payee'));
  const facts = indices.map((i) => at(original.facts, i, 'payee'));
  return assemble(
    buildPayoutTree(payments, facts.map((f) => f.amount), original.tree.asset),
    original.identity,
    facts,
    indices.map((i) => at(original.records, i, 'payee')),
    indices.map((i) => at(original.secrets, i, 'payee')),
    payments,
    indices,
  );
};
