/**
 * **ONE APPROVED LEG'S PAYMENTS, AS THE SERVICE HANDS THEM TO A SIGNER'S DEVICE
 * AND AS THE DEVICE'S BUILDER READS THEM BACK.**
 *
 * Every value is a string: the chain's own 64-bit and 128-bit integers do not
 * survive JSON as numbers, and a payee's merkle path is the runtime's own aligned
 * value, byte string by byte string, so nothing on either side re-describes the
 * path's shape.
 *
 * **WHAT THIS CARRIES IS WHAT THE COMPANY ALREADY READS WITH ITS VIEWING KEY**:
 * who is paid, in what and how much, and the blinding, nonce and path each
 * payment's leaf was built from. It carries no key that opens a note, and none
 * that signs anything - but those three values, beside the run's, are all a
 * vault asks for, so whoever holds them can send that approved payment, to its
 * approved payee and to nobody else. They are handed only to a signed-in member
 * of the company who presents its viewing key.
 */
import { CompactTypeBytes, CompactTypeMerkleTreePath } from '@midnight-ntwrk/compact-runtime';
import { fromHex, toHex, type Hex } from '../core/crypto.js';
import { PAYOUT_TREE_DEPTH, type PaymentFacts, type PayrollRun } from './payout-tree.js';
import type { RunWindow } from './run-status.js';

/** One person's payment in an approved leg. */
export interface PrivatePaymentOnTheWire {
  /** Their position in the leg, as the tree was built. */
  readonly index: number;
  /**
   * How they are paid, which is the kind of their address: `shielded` through
   * the vault's private payout, `unshielded` through its public one. Read off
   * the payment the leg was raised with, never chosen.
   */
  readonly kind: 'shielded' | 'unshielded';
  /** Their address, as they registered it, private or public as `kind` says. */
  readonly payee: string;
  readonly token: Hex;
  /** In the asset's smallest unit, as decimal digits. */
  readonly amount: string;
  readonly blinding: Hex;
  readonly nonce: Hex;
  readonly leaf: Hex;
  /** Their merkle path, as the runtime's aligned value. */
  readonly path: readonly Hex[];
  /** Whether the account already records them paid; `null` when this deployment cannot say. */
  readonly paid: boolean | null;
}

/** What a vault is handed for one approved leg, and every person in it. */
export interface PrivatePaymentOrderOnTheWire {
  readonly asset: string;
  readonly vault: Hex;
  /** The round's identity, as the chain opened it. */
  readonly proposal: Hex;
  readonly salt: Hex;
  readonly root: Hex;
  readonly payees: string;
  /** Seconds since the Unix epoch, as decimal digits. */
  readonly opensAt: string;
  readonly closesAt: string;
  readonly payments: readonly PrivatePaymentOnTheWire[];
}

const pathType = new CompactTypeMerkleTreePath(PAYOUT_TREE_DEPTH, new CompactTypeBytes(32));

/** A payee's merkle path, as the payout tree hands it out, onto the wire. */
export const pathToWire = (path: unknown): Hex[] =>
  (pathType.toValue(path as never) as Uint8Array[]).map((b) => toHex(b));

/** A payee's merkle path back off the wire, in the shape the vault's circuit takes. Refuses anything but that shape. */
export const pathFromWire = (hex: readonly string[]): unknown => {
  if (!Array.isArray(hex) || hex.some((h) => typeof h !== 'string' || !/^(?:[0-9a-f]{2})*$/u.test(h))) {
    throw new Error('this payment\'s merkle path is not a list of byte strings, so nothing was built.');
  }
  const value = hex.map((h) => fromHex(h as Hex));
  const path = pathType.fromValue(value);
  if (value.length !== 0) {
    throw new Error('this payment\'s merkle path carries more than one path, so nothing was built.');
  }
  return path;
};

/**
 * **ONE APPROVED LEG'S PAYMENTS, ASSEMBLED ONLY WHEN THEY ARE THE ONES ITS
 * SIGNERS APPROVED.**
 *
 * `built` is the run rebuilt from the leg's recorded facts and the account's
 * payout seed of the generation the leg was raised under. It is answered only
 * when its leaves are the leaves recorded when the leg was raised, its root is
 * the recorded root, and those leaves rebuild the identity the chain opened the
 * round under. Anything else is a refusal, and nothing is offered to pay:
 * a payment built from leaves nobody approved is refused by the account after
 * the network fee is spent, and a payment built from leaves somebody else
 * approved pays the wrong people.
 */
export function assemblePrivatePayments(input: {
  readonly order: {
    readonly asset: string; readonly vault: Hex; readonly proposal: Hex; readonly salt: Hex;
    readonly root: Hex; readonly payees: bigint; readonly opensAt: bigint; readonly closesAt: bigint;
  };
  /** The leaves recorded when the leg was raised, in tree order. */
  readonly leaves: readonly Hex[];
  readonly window: RunWindow;
  /** The contract's own identity of a round over these leaves in this window. */
  readonly idFrom: (leaves: Hex[], window: RunWindow) => Hex;
  readonly built: Pick<PayrollRun, 'tree' | 'payeeArgs'>;
  readonly facts: readonly PaymentFacts[];
  /** The leaves the account records paid, or `null` when this deployment cannot say. */
  readonly paid: ReadonlySet<string> | null;
  /**
   * **FOR A RETRY: EACH PAYMENT'S POSITION IN THE LEG IT RETRIES**, in the
   * retry's tree order, so every payment is reported against the person the
   * leg numbers it as. Absent for a leg's own round, whose tree order is the
   * leg's.
   */
  readonly indices?: readonly number[];
}): { readonly order: PrivatePaymentOrderOnTheWire } | { readonly refusal: string } {
  const { order, built } = input;
  const leaves = built.tree.leaves;
  const same = leaves.length === input.leaves.length
    && leaves.every((leaf, i) => leaf === input.leaves[i])
    && built.tree.root === order.root
    && built.tree.payees === order.payees
    && input.facts.length === leaves.length
    && input.idFrom([...leaves], input.window) === order.proposal;
  const positions = input.indices;
  if (!same || (positions !== undefined && positions.length !== leaves.length)) {
    return {
      refusal: 'the payments this run would make now are not the ones its signers approved, so nothing is '
        + 'offered to pay. Nothing was sent.',
    };
  }
  /*
   * **EACH PAYMENT GOES OUT IN THE FORM ITS PAYEE'S ADDRESS IS.** The leaf each
   * one is paid against was built by that same kind, so the private payout
   * cannot pay a public payee's leaf and the public payout cannot pay a
   * private one; the device decodes the address again and refuses one whose
   * kind disagrees with this.
   */
  const payments = input.facts.map((fact, i): PrivatePaymentOnTheWire => {
    const args = built.payeeArgs(i);
    return {
      index: positions === undefined ? i : positions[i]!,
      kind: fact.payee.kind,
      payee: fact.payee.bech32,
      token: args.token,
      amount: args.amount.toString(),
      blinding: args.blinding,
      nonce: args.nonce,
      leaf: args.leaf,
      path: pathToWire(args.path),
      paid: input.paid === null ? null : input.paid.has(args.leaf),
    };
  });
  return {
    order: {
      asset: order.asset,
      vault: order.vault,
      proposal: order.proposal,
      salt: order.salt,
      root: order.root,
      payees: order.payees.toString(),
      opensAt: order.opensAt.toString(),
      closesAt: order.closesAt.toString(),
      payments,
    },
  };
}
