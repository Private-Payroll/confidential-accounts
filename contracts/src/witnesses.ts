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
   * This was put back where decision 0003 says it belongs. The generation
   * design re-seated every survivor on a removal, and a survivor's new leaf
   * needs their blinding, so the blindings had to be gathered into the sealed
   * roster. Slots re-seat nobody, so nothing off this device needs it again.
   */
  blinding: Uint8Array;
  /**
   * WHAT THIS SIGNER MAY DO, as their leaf commits to it.
   *
   * `ALL_VAULTS` is every right on every vault. Anything else is the hash of
   * the rights record in `rights` below (`rightsScopeOf`), and the contract
   * checks it when this signer raises, approves or holds a run. A governance
   * proposal is never checked against it: a seat is enough to raise and approve
   * one, so no set of rights can leave the company unable to change them back.
   *
   * It is part of the signer's LEAF, so changing it is a re-seat: the old leaf
   * is replaced by a new one in the same slot, and the chain counts that as a
   * removal.
   */
  scope: Uint8Array;
  /**
   * The rights record `scope` is the hash of, for a seat given rights rather
   * than every right on every vault. Absent, or null, for a seat with
   * `ALL_VAULTS`. Held on this device only; the chain sees its hash inside the
   * leaf and nothing else.
   */
  rights?: SignerRights | null;
  /**
   * What the runs this device acts on open to, keyed by the run's id in hex:
   * the payload, the vault and the salt. A seat with rights proves with it that
   * the run's vault is one it may act on. A seat with `ALL_VAULTS` is asked too
   * and answers with nothing, which the contract never reads.
   */
  runOpenings?: Record<string, RunOpening>;
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
   * the entries it appends. The asset is part of what the signers approve
   * rather than something an executor chose.
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
   * replay a path taken before the tree moved on — which is now a path
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
  /**
   * The opening of the spending policy a run is charged against: its terms and
   * the blinding its commitment was made under. Only a device that clears a run
   * needs it, and only a signer holds it.
   */
  policy?: PolicyOpening | null;
  /**
   * What the vault has already been charged in the period a run is charged to,
   * which the account's stored total for that period must open to. Zero when
   * nothing has been charged to the period yet.
   */
  periodSpent?: bigint;
}

/**
 * What a signer seated with rights may do: raise runs, approve runs and hold
 * runs, on every vault or on up to four named ones. There is no right to stop a
 * run before its window, because any signer may.
 */
export interface SignerRights {
  mayRaise: boolean;
  mayApprove: boolean;
  mayHold: boolean;
  everyVault: boolean;
  /** Up to four vault addresses. Fewer are padded with 32 zero bytes, which name no vault. */
  vaults: Uint8Array[];
}

/** What a run's id opens to: the payload its signers approved, the vault it names and its salt. */
export interface RunOpening {
  payload: Uint8Array;
  vault: Uint8Array;
  salt: Uint8Array;
}

/** How many vaults a rights record can name. */
export const RIGHTS_VAULT_PLACES = 4;

/** What a company-wide run names in place of a vault. */
const COMPANY_WIDE: Uint8Array = pureCircuits.companyWide();

/**
 * Refuses a rights record the contract could not hold, or one naming company-wide runs as a
 * vault; returns it with its vaults padded to four.
 */
export const rightsRecordOf = (rights: SignerRights): SignerRights => {
  if (rights.vaults.length > RIGHTS_VAULT_PLACES) {
    throw new Error(
      `a signer's rights can name at most ${RIGHTS_VAULT_PLACES} vaults; give this signer every vault, ` +
        'or name fewer');
  }
  for (const v of rights.vaults) {
    if (v.length !== 32) throw new Error('a vault in a signer\'s rights must be a 32-byte address');
    // A company-wide run may be paid by nearly every vault, so naming it would read as one place
    // and act as almost all of them; the contract treats such a place as naming nothing.
    if (v.every((byte, i) => byte === COMPANY_WIDE[i])) {
      throw new Error(
        'a signer\'s rights cannot name company-wide runs as if they were one vault, because nearly ' +
          'every vault may pay them; give this signer every vault, or name the vaults themselves');
    }
  }
  const vaults = [...rights.vaults];
  while (vaults.length < RIGHTS_VAULT_PLACES) vaults.push(new Uint8Array(32));
  return { ...rights, vaults };
};

/** The scope a leaf commits to for this rights record, from the contract's own definition. */
export const scopeOfRights = (rights: SignerRights): Uint8Array =>
  pureCircuits.rightsScopeOf(rightsRecordOf(rights));

/** What a seat with `ALL_VAULTS` answers when the contract asks for a rights record: nothing granted. */
const NO_RIGHTS: SignerRights = rightsRecordOf({
  mayRaise: false, mayApprove: false, mayHold: false, everyVault: false, vaults: [],
});

const NO_OPENING: RunOpening = {
  payload: new Uint8Array(32), vault: new Uint8Array(32), salt: new Uint8Array(32),
};

const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** One band of a spending policy: a run whose total is at most `ceiling` needs `approvals`. */
export interface PolicyBand {
  ceiling: bigint;
  approvals: bigint;
}

/**
 * A vault's spending policy for one token, as the contract opens it: four
 * bands, a limit per period, and the periods, which run for `periodLength`
 * seconds from `periodStart`.
 */
export interface PolicyOpening {
  terms: {
    bands: PolicyBand[];
    periodLimit: bigint;
    periodStart: bigint;
    periodLength: bigint;
  };
  blinding: Uint8Array;
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
 * account's own internal ledger.
 */
export const NO_VAULT: Uint8Array = pureCircuits.noVault();

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const same = <PS>(ps: PS) => ps;

/** The account's address as the 32 bytes the contract hashes. Refuses anything else. */
const accountBytes = (address: string): Uint8Array => {
  const hex = address.startsWith('0x') ? address.slice(2) : address;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`this account's address is not 32 bytes of hex, so no withdraw secret can be worked out for it: ${address}`);
  }
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
};

/** A signer's withdraw secret for one proposal on this account, from the contract's own definition. */
const withdrawSecretFor = (
  { privateState, contractAddress }: WitnessContext<Ledger, AccountPrivateState>,
  proposal: Uint8Array,
): Uint8Array => pureCircuits.withdrawSecretOf(privateState.secretKey, accountBytes(contractAddress), proposal);

export const witnesses = {
  localSecretKey: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, Uint8Array] => [same(privateState), privateState.secretKey],

  signerBlinding: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, Uint8Array] => [same(privateState), privateState.blinding],

  signerScope: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, Uint8Array] => [same(privateState), privateState.scope],

  /**
   * This signer's rights record. Asked of every seat when it raises, approves
   * or holds a run; a seat with `ALL_VAULTS` answers with nothing granted and
   * the contract never reads it. A seat with rights and no record on this
   * device is refused here, before anything is proved.
   */
  signerRights: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, SignerRights] => {
    if (privateState.rights) return [same(privateState), rightsRecordOf(privateState.rights)];
    if (!sameBytes(privateState.scope, ALL_VAULTS)) {
      throw new Error(
        'this device does not hold the rights your seat was given, so it cannot raise, approve or hold a run. ' +
          'Restore your seat on this device from your backup, or use the device you were seated from.');
    }
    return [same(privateState), NO_RIGHTS];
  },

  /**
   * What one run's id opens to. Asked when a signer approves or holds a run;
   * only a seat with rights needs a true answer, and one that has none for the
   * run proves nothing and is refused by the contract.
   */
  runOpening: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>, proposal: Uint8Array):
    [AccountPrivateState, RunOpening] =>
    [same(privateState), privateState.runOpenings?.[hexOf(proposal)] ?? NO_OPENING],

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

  /* ---------------- withdrawing a proposal ---------------- */

  /**
   * The key a new proposal is stored with: the hash of this signer's withdraw
   * secret for it. Only the signer who raised a governance proposal can later
   * produce the secret, so only they can withdraw it.
   *
   * Nothing new is kept on the device. The secret is worked out again from the
   * signer's secret key, the account and the proposal's id, so a restored device
   * can still withdraw what it raised. The id is fresh for every raise because
   * its salt is, so no two proposals share a key and the stored keys do not link
   * one proposer's proposals together.
   */
  withdrawKey: (context: WitnessContext<Ledger, AccountPrivateState>, proposal: Uint8Array):
    [AccountPrivateState, Uint8Array] =>
    [same(context.privateState), pureCircuits.withdrawKeyOf(withdrawSecretFor(context, proposal))],

  /** This signer's withdraw secret for one proposal. Never leaves the proof. */
  withdrawSecret: (context: WitnessContext<Ledger, AccountPrivateState>, proposal: Uint8Array):
    [AccountPrivateState, Uint8Array] => [same(context.privateState), withdrawSecretFor(context, proposal)],

  /* ---------------- charging a run to its period ---------------- */

  /** The opening of the policy being set, or the one a run is charged against. Refuses a device that holds none. */
  policyOpening: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, PolicyOpening] => {
    if (!privateState.policy) {
      throw new Error(
        'this device holds no opening of the vault\'s spending policy, so it can neither set that policy ' +
          'nor charge a run to its period. Open the policy on this device, or ask a signer who holds it.');
    }
    return [same(privateState), privateState.policy];
  },

  /** What the vault has already been charged in the run's period. */
  periodSpent: ({ privateState }: WitnessContext<Ledger, AccountPrivateState>):
    [AccountPrivateState, bigint] => [same(privateState), privateState.periodSpent ?? 0n],
};
