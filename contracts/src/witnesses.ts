/**
 * The private half of the contract.
 *
 * Every witness here runs on one signer's device, against that device's own
 * store, and its return value enters the proof without ever reaching the chain.
 * This file is the practical expression of decision 0002: Midnight gives each
 * party its own private state and nothing shared, so what is "shared" between
 * signers is the sealed blob and the viewing key that opens it, not this.
 */
import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { pureCircuits, type Ledger } from '../managed/contract/index.js';

/** A Merkle path as the generated contract expects it. */
export interface SignerPath {
  leaf: Uint8Array;
  path: { sibling: { field: bigint }; goes_left: boolean }[];
}

/*
 * `ShieldedView` STOOD HERE, AND WITH IT THE `current`/`next` PAIR ON
 * `AccountPrivateState`.
 *
 * It held one asset's balance and the salt that committed to it, on a signer's
 * device, so the spend circuit could read them as witnesses. The account keeps
 * no balance, the circuit is gone, and the four witnesses that read this type —
 * `assetBalance`, `balanceSalt`, `nextAssetBalance`, `nextBalanceSalt` — are
 * gone from the contract in the same turn.
 *
 * WHAT A DEVICE STILL HOLDS is below: its secret key and blinding, the account's
 * asset blinding, which asset a call concerns, and the change a proposal makes.
 * Those are what a proposal is built and recognised from.
 *
 * The doc that stood here is kept in outline because one line of it is still
 * load-bearing: an amount is an INTEGER IN THE ASSET'S SMALLEST UNIT — five
 * thousand dollars is `500000n`, one ether is `1000000000000000000n`. Nothing
 * at this layer rounds and nothing knows an asset's decimals; that is the
 * registry's job in `src/core/assets.ts` and is deliberately not duplicated
 * here. `changeAmount` carries the same integer under the same rule.
 *
 */

export interface AccountPrivateState {
  secretKey: Uint8Array;
  /**
   * Hides this signer's identity in the tree. Generated on the device, sent to
   * nobody, and as precious as the signing key: without it the signer cannot
   * reproduce their own leaf and cannot act on the account.
   *
   * M-106 put this back where decision 0003 says it belongs. The generation
   * design re-seated every survivor on a removal, and a survivor's new leaf
   * needs their blinding, so the blindings had to be gathered into the sealed
   * roster. Slots re-seat nobody, so nothing off this device needs it again.
   */
  blinding: Uint8Array;
  /**
   * WHICH VAULTS THIS SIGNER MAY ACT ON. Reserved, not yet enforced. V-33.
   *
   * Every signer is seated with `ALL_VAULTS` and no circuit branches on it
   * today. It is here because it is part of the signer's LEAF, and a leaf's
   * shape cannot change later without removing and re-seating every signer on
   * the account — the one operation on a live account holding money that must
   * never be forced.
   *
   * Reserving it now costs 32 bytes inside a commitment. Not reserving it costs
   * a migration of the one thing that must never go wrong.
   */
  scope: Uint8Array;
  /**
   * Hides WHICH ASSETS this account holds.
   *
   * NOT a per-device secret, and the difference from `blinding` above is the
   * whole reason both exist. A signer's blinding stands for one person, so it
   * lives on one device and nowhere else. This one stands for the account:
   * every signer has to derive the same key for the same asset, or two signers
   * proposing in dollars compute two different asset keys, and therefore two
   * different change commitments for the same change.
   *
   * WHAT THAT DIVERGENCE USED TO COST WAS THE ACCOUNT'S MONEY: the two keys
   * were two entries in `assetBalances`, so the account held its money twice
   * under two names, each unspendable by half the signers. That map went with
   * the balance ledger, and nothing opens a change commitment any
   * more, so the cost today is smaller and is not nothing — a proposer's own
   * post-check recomputes the commitment and compares it against the one the
   * chain recorded, and a divergent blinding fails there.
   *
   * So it lives in the sealed shielded state under the account viewing key, and
   * reaches this device the way every other shared secret here does (decision
   * 0002). It is carried through a rotation UNCHANGED — rotating it would make
   * every change commitment already on chain unreproducible by the signers who
   * wrote it, including a run one signature from being presented.
   */
  assetBlinding: Uint8Array;
  /**
   * WHICH ASSET this call concerns: the asset's code, padded to 32 bytes.
   *
   * Set per call rather than per account, because a proposal names one asset.
   * `src/core/assets.ts` owns the encoding; this layer only carries the bytes.
   */
  assetId: Uint8Array;
  proposalSalt: Uint8Array;
  /**
   * The change a proposal makes: how much of `assetId` leaves, and a digest of
   * the entries it appends. M-71, and since M-125 the asset is part of what the
   * signers approve rather than something an executor chose.
   *
   * READ AT ONE END OF A ROUND NOW, NOT BOTH. The proposer committed to them
   * and `execute` was checked against that commitment; `execute` went with the
   * balance ledger, so `propose` is the only circuit that reads these
   * and NOTHING ON CHAIN OPENS WHAT IT COMMITS TO. They still travel between
   * devices in the sealed payload, like every other shared secret here
   * (decision 0002); what still reads them is the proposer's own post-check in
   * `src/midnight/ledger.ts` (`propose`, `proposeRun`), which recomputes the
   * commitment and compares it against the one the chain recorded.
   */
  changeAmount: bigint;
  changeBatchDigest: Uint8Array;
  /**
   * A membership path captured earlier.
   *
   * Normally null, and the path is derived from the tree on demand. Set it to
   * replay a path taken before the tree moved on — which since M-106 is a path
   * that must STOP verifying, because `signers` is a plain MerkleTree and only
   * its current root is accepted. It is also how a test plays a forged path.
   *
   * It only applies to a request for the leaf it actually holds. It used to
   * short-circuit every call, which was harmless while `signerPath` was only
   * ever asked for the caller's own leaf; `removeSigner` now asks for the
   * departing signer's, and a pin that answered that request with somebody
   * else's path would make the test lie rather than fail.
   */
  pinnedPath: SignerPath | null;
  /**
   * Hand back `pinnedPath` for ANY leaf the circuit asks about, not only the
   * one it holds. A TEST SEAM, and it is here because the alternative is
   * shipping unverified asserts.
   *
   * The honest witness below only ever answers with a path it genuinely found,
   * so an honest caller cannot exercise the checks that exist to stop a
   * DISHONEST one — the assert binding a path to the leaf it claims to be for,
   * and the assert that a slot really is vacant. Those two are what stand
   * between the contract and seating a signer on top of a live one, or clearing
   * the slot of somebody nobody voted to remove. Without this flag nothing can
   * make them fire, and a mutation removing either would survive.
   */
  pinAnyLeaf?: boolean;
}

/**
 * What a vacated slot holds, from the CONTRACT'S own definition.
 *
 * Not a TypeScript constant. The marker has to be byte-identical on both sides
 * or a removal writes something the next addition cannot find, and a shared
 * value written twice is this project's oldest failure.
 */
export const VACANT_SLOT: Uint8Array = pureCircuits.vacantSlot();

/**
 * The scope every signer is seated with today, from the CONTRACT'S definition.
 *
 * Not a TypeScript constant, for the same reason `VACANT_SLOT` is not: a
 * sentinel that both sides compute separately is a sentinel that can drift, and
 * a signer seated under one spelling would be unable to prove membership under
 * the other.
 */
export const ALL_VAULTS: Uint8Array = pureCircuits.allVaults();

/**
 * What a proposal names when it concerns no vault — governance, and the
 * account's own internal ledger. V-32.
 */
export const NO_VAULT: Uint8Array = pureCircuits.noVault();

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const same = <PS>(ps: PS) => ps;

export const witnesses = {
  localSecretKey: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, Uint8Array] => [same(privateState), privateState.secretKey],

  signerBlinding: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, Uint8Array] => [same(privateState), privateState.blinding],

  signerScope: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, Uint8Array] => [same(privateState), privateState.scope],

  /**
   * Resolves a path to a leaf in the signer tree.
   *
   * Asked for three things by three callers, and they are one question:
   *
   *   the caller's own leaf     `requireSigner` — prove I am a signer
   *   a departing signer's leaf `removeSigner`  — prove which slot to clear
   *   the vacancy marker        `addSigner`     — prove a slot is free to take
   *
   * The third is what makes slots reusable, and it only works because a
   * removal WRITES the marker rather than blanking the slot. The tree is
   * sparse: an index nobody has written does not exist in it, `pathForLeaf`
   * refuses one outright, and there is consequently no such thing as a proof
   * that a never-used slot is free. Appending is a separate operation for that
   * reason, and it needs no path at all.
   *
   * Throws rather than returning an empty path when there is no answer. An
   * empty path would compute some root, fail `checkRoot`, and produce "not a
   * signer" from the circuit, which is the right outcome by accident. A caller
   * who is not a member should fail here, clearly, on their own device.
   */
  signerPath: (
    { ledger, privateState }: WitnessContext<Ledger, AccountPrivateState>,
    leaf: Uint8Array,
  ): [AccountPrivateState, SignerPath] => {
    const pinned = privateState.pinnedPath;
    if (pinned && (privateState.pinAnyLeaf || sameBytes(pinned.leaf, leaf))) {
      return [same(privateState), pinned];
    }

    const found = ledger.signers.findPathForLeaf(leaf);
    if (found) return [same(privateState), found as unknown as SignerPath];

    if (!sameBytes(leaf, VACANT_SLOT)) {
      throw new Error('you are not a signer on this account');
    }
    throw new Error(
      'no slot on this account has been vacated, so there is none to reuse. Add the signer ' +
        'into a fresh slot instead — the tree only has a path to a slot something has been ' +
        'written to.',
    );
  },

  /* ---------------- which asset ---------------- */

  assetId: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, Uint8Array] => [same(privateState), privateState.assetId],

  assetBlinding: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, Uint8Array] => [same(privateState), privateState.assetBlinding],

  /* ---------------- the round ---------------- */

  proposalSalt: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, Uint8Array] => [same(privateState), privateState.proposalSalt],

  changeAmount: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, bigint] => [same(privateState), privateState.changeAmount],
  changeBatchDigest: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, Uint8Array] => [same(privateState), privateState.changeBatchDigest],
};
