import { nanoid } from 'nanoid';
import { newBlinding, seal, canonical, type Hex } from './crypto.js';
import { inboxPublicKey, sealRecord } from './sealed-records.js';
import type { RosterSecrets } from './roster-record.js';
import type { Account, PendingSigner, Policy, Role, SealedAccount, ShieldedState, Signer, StateBlinding } from './types.js';
import type { SealedStateAt } from './ledger.js';

/*
 * **WHAT A COMPANY IS FOUNDED WITH, IN ONE PLACE**: its ids, its first seat, its
 * record, its state secrets and their sealing. Used where a company is made -
 * the founding signer's wallet for a company on a chain (`company-founding.ts`),
 * this service for the simulated ledger (`account.ts`, which also re-exports
 * these) - and reaching nothing else, so the wallet founds a company with the
 * same code without carrying the service's account logic.
 */

/**
 * The epoch a brand new account is sealed under.
 *
 * Named rather than written as `0` in two places, because the account record
 * and the state blob have to agree about it or the account is unreadable from
 * the moment it is created.
 */
export const GENESIS_KEY_EPOCH = 0;

/**
 * A policy with no ceilings. The account's threshold is not in it: the chain
 * holds that number and nothing here does.
 */
export const defaultPolicy = (): Policy => ({
  limitsByRole: {},
});

/** Who a seat is founded for: their name, their role and the person's id. */
export interface SignerSpec { name: string; role: Role; userId?: string | null; }

/* ---------------- a company as it is founded ---------------- */

/** A company's id: `acc_` and twelve characters. Made where the company is made. */
export const newAccountId = (): string => 'acc_' + nanoid(12);
/** A signer's id: `sgn_` and ten characters. Made where the seat is made. */
export const newSignerId = (): string => 'sgn_' + nanoid(10);
/** Whether a value is shaped as an id `newAccountId` makes. */
export const isAccountId = (v: unknown): v is string => typeof v === 'string' && /^acc_[A-Za-z0-9_-]{12}$/u.test(v);
/** Whether a value is shaped as an id `newSignerId` makes. */
export const isSignerId = (v: unknown): v is string => typeof v === 'string' && /^sgn_[A-Za-z0-9_-]{10}$/u.test(v);

/**
 * **A SEAT AS ITS COMPANY IS FOUNDED WITH IT**: active, with its two public
 * halves and its leaf. Only the leaf is kept; the blinding that made it stays
 * on the device that holds the seat and is never written down here.
 */
export function seatAtFounding(
  id: string, spec: SignerSpec, keys: { signingPublicKey: Hex; wrappingPublicKey: Hex; leaf: Hex },
): Signer {
  return {
    id, name: spec.name, role: spec.role, status: 'active', userId: spec.userId ?? null,
    signingPublicKey: keys.signingPublicKey, wrappingPublicKey: keys.wrappingPublicKey,
    leafCommitment: keys.leaf,
  };
}

/**
 * **A COMPANY AS IT IS FOUNDED**: its seats, the default policy at its
 * threshold, the viewing key wrapped to each seat, and a recovery rule over
 * every seat. The one shape of a new company, wherever it is made.
 */
export function companyAtItsFounding(input: {
  id: string; name: string; signers: Signer[]; threshold: number;
  wrappedKeys: Account['wrappedKeys']; recoveryThreshold?: number; createdAt: string;
}): Account {
  return {
    id: input.id,
    name: input.name,
    signers: input.signers,
    policy: defaultPolicy(),
    wrappedKeys: input.wrappedKeys,
    recovery: {
      signerIds: input.signers.map(s => s.id),
      threshold: input.recoveryThreshold ?? Math.min(input.threshold, input.signers.length),
    },
    createdAt: input.createdAt,
  };
}

/* ---------------- a company's state secrets, and their sealing ---------------- */

/**
 * **A NEW COMPANY'S STATE SECRETS**: its asset blinding, its first payout seed
 * and its pay-record key, made where this is called. On a chain that is the
 * founding signer's own device; on the simulated ledger, this service. One
 * function, so the two can never make them differently, and so a later
 * re-making of the payout seeds starts from the same shape.
 */
export function newStateBlinding(): StateBlinding {
  return {
    /*
     * Made once, at creation, and never made again, not even by a change of the
     * company's key:
     * every change commitment already approved names an asset through it, so
     * changing it would make an approval in flight unspendable. See
     * `StateBlinding.assetBlinding`.
     */
    assetBlinding: newBlinding(),
    /*
     * The account's first payout seed, made now so that a run raised on the
     * very first day is already rebuildable by every signer rather than by
     * whoever happened to raise it. A change of the company's key on the
     * devices carries a later seed in that change; nothing ever removes this
     * one, so an approved run stays payable across a signer leaving.
     */
    payoutSeeds: [{ epoch: GENESIS_KEY_EPOCH, seed: newBlinding() }],
    /*
     * The key every payment's nonce is derived from, with who is paid and for
     * which month. Made once and kept through every change of the company's
     * key, so a month already paid keeps its nonce when a signer leaves.
     */
    payRecordKey: newBlinding(),
  };
}

/**
 * **A COMPANY'S STATE, SEALED UNDER ITS VIEWING KEY.** The one sealing of it:
 * this service calls it for the simulated ledger, and the founding signer's
 * device calls it when it makes a company on a chain.
 *
 * The blob carries the entry log and the blindings, `assetBlinding` among
 * them, which every proposal needs and which cannot be recomputed from
 * anything else. Nothing proves a current state to anybody.
 *
 * `canonical`, not `JSON.stringify`: an amount is a bigint, which
 * `JSON.stringify` throws on. `canonical` writes `{"$n":"..."}` and
 * `parseCanonical` reads it back; the two are a pair and neither is correct
 * alone.
 */
export function sealState(
  state: ShieldedState,
  blinding: StateBlinding,
  viewingKey: Hex,
  keyEpoch: number,
): SealedStateAt {
  return { keyEpoch, sealed: seal(canonical({ state, blinding }), viewingKey) };
}

/* ---------------- sealing the account ---------------- */

/** What the policy envelope holds. */
export interface PolicySecrets { policy: Policy; recovery: Account['recovery']; }

/**
 * Turns an account into what the database is allowed to hold.
 *
 * Exported, and used by the BROWSER as well as the server, because the server
 * can no longer open one of these. `openAccount` is the other half and they are
 * a pair: everything readable on the stored record is derived here, in one
 * place, from the one copy inside the envelope. `threshold` and `signerCount`
 * are written from the roster and policy rather than passed in, so there is no
 * second copy for them to disagree with.
 *
 * Pending signers arrive as their own argument and are passed through
 * untouched. They are not in the roster and must not be: the only two things
 * that write them are `acceptSignerInvite`, which appends without a key, and
 * `grantAccess`, which folds one into the sealed roster and drops it here.
 */
export function sealAccount(
  account: Account,
  viewingKey: Hex,
  pendingSigners: PendingSigner[],
  keyEpoch = 0,
): SealedAccount {
  // `openAccount` composes pending signers into `signers` so callers see one
  // list. Filtering them back out is what makes the trip there and back lossless.
  const roster = account.signers.filter(s => s.status !== 'pending');
  return {
    id: account.id,
    createdAt: account.createdAt,
    keyEpoch,
    signerCount: roster.length,
    memberUserIds: roster.filter(s => s.userId).map(s => s.userId!),
    pendingSigners,
    wrappedKeys: account.wrappedKeys,
    inboxPublicKey: inboxPublicKey(viewingKey, account.id),
    sealedRoster: sealRecord<RosterSecrets>(
      'roster', account.id, { name: account.name, signers: roster }, viewingKey),
    sealedPolicy: sealRecord<PolicySecrets>(
      'policy', account.id, { policy: account.policy, recovery: account.recovery }, viewingKey),
    /*
     * **CARRIED, NOT RECOMPUTED, AND CARRIED HERE BECAUSE THIS IS WHERE IT
     * WOULD BE LOST.**
     *
     * `save()` rebuilds the stored record from an opened `Account` on every
     * write, so a readable field this function does not copy is written once at
     * creation and gone by the next roster edit. The key that opens this
     * company's keyring is derived from this string: dropping it is dropping
     * the data, not a column. `openAccount` is the other half of that trip
     * there and back and `wallet-unlock.test.ts` watches it survive one.
     */
    contractAddress: account.contractAddress ?? null,
    /*
     * **AND SO DOES ITS PROVENANCE, FOR THE IDENTICAL REASON.**
     * A source dropped on write-back reads as *we do not know*, which
     * fails closed — and a company that silently stops being unlockable is the
     * same lost afternoon as one that never was.
     */
    addressSource: account.addressSource ?? null,
    /*
     * **AND SO DOES THE COMPANY'S LABEL.** Every signer's keys for this company
     * are derived from it; a record that dropped it on write-back would be a
     * company no wallet could open again.
     */
    companyLabel: account.companyLabel ?? null,
    /*
     * **AND SO DOES THE LEDGER THAT WROTE IT, FOR THE SAME REASON AGAIN.**
     *
     * Dropped on write-back it reads as *not known*, which is safe but is a
     * one-way loss: nothing can establish afterwards which ledger opened a
     * company, so the fact is either carried here or gone for good.
     */
    wiring: account.wiring ?? null,
  };
}
