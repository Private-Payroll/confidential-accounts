/**
 * WHERE A PAYROLL RUN'S SECRETS COME FROM. V-63.
 *
 * Every payment of a run needs two secrets that nobody outside the company may
 * learn and that the chain never holds:
 *
 *   the payee's NONCE     without it a watcher who reads one payment's merkle
 *                         path can mark the rest of the payroll paid (V-43)
 *   the payee's BLINDING  without it the payment's "details" are a hash of an
 *                         address, one of a handful of token types and an
 *                         amount, so a watcher can confirm a guess
 *
 * Until this file they were whatever the machine that built the run happened to
 * generate. **That made a five-signer account depend on one laptop being
 * awake**, which a worked example found: A raises the run, B and C
 * approve, A's laptop dies, and nobody — including the company — can pay
 * anybody. No money is lost and nobody is paid, which is not a distinction an
 * employee appreciates. A multisig with a single point of failure is not a
 * multisig.
 *
 * ------------------------------------------------------------------------
 * WHAT IT DERIVES FROM, AND WHY NOT THE OBVIOUS THING
 *
 * The obvious source is the account's VIEWING KEY: every active signer can
 * unwrap it, a removed signer cannot, and `purposeKey` already derives
 * per-purpose keys from it. It is the wrong source here, for one reason:
 * **the viewing key rotates when a signer is removed** (K-4), and a run's
 * leaves are fixed the moment the signers approve them. Derive from a key that
 * rotates and removing a signer strands every run that is already approved and
 * not yet paid — a NEW way to lose access to money, introduced by the fix for
 * a way to lose access to money.
 *
 * So runs derive from a PAYOUT SEED, which lives in the account's sealed
 * shielded state beside the asset blinding — readable by every signer, sealed
 * against everybody else, and re-sealed rather than regenerated when the
 * viewing key rotates.
 *
 * **The seed is versioned and the old ones are kept.** A rotation appends a new
 * seed at the new epoch; runs already raised keep deriving from theirs. That is
 * what lets a removal be immediate for future payrolls without reaching back
 * and breaking an approved one. A removed signer can still derive the runs they
 * could already see and nothing after them, which is exactly what revocation
 * can mean here — the same limit `rotate` documents for the state itself.
 *
 * ------------------------------------------------------------------------
 * WHAT AN ATTACKER GETS FROM A PAID PAYEE
 *
 * Nothing, and this is worth stating because a payment PUBLISHES its payee's
 * nonce. Every nonce is an HKDF output; knowing forty of them says nothing
 * about the forty-first, and nothing about the run key that produced them.
 * The disclosure V-43 permits stays a disclosure of one spent secret.
 *
 * HKDF rather than hashing values together by hand, matching
 * `core/sealed-records.ts`: a hand-rolled construction is the kind of thing
 * that looks fine and is subtly wrong.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { toHex, fromHex, utf8, type Hex } from '../core/crypto.js';

/**
 * One generation of an account's payout seed.
 *
 * `epoch` is the account's key epoch at the moment the seed was created, so it
 * lines up with the epochs `rotate` already writes and there is no second
 * numbering to keep in step.
 */
export interface PayoutSeed {
  epoch: number;
  seed: Hex;
}

/** Everything needed to rebuild a run's secrets, and small enough to write down. */
export interface RunIdentity {
  accountId: string;
  /**
   * What distinguishes this run from every other one on the account.
   *
   * **Not secret, and it must not be treated as though it were.** All the
   * security is in the seed; this only has to be UNIQUE, because two runs
   * sharing an id derive the same nonces, and two payments sharing a leaf mean
   * the second is refused as already made (V-64). A month label is not enough
   * on its own — "2026-09" collides the moment a run is retried — so use
   * something the client guarantees unique, and prove it with a test rather
   * than a convention.
   */
  runId: string;
  /** Which payout seed the run was raised under. */
  epoch: number;
}

/** The seed in force now — the highest epoch, which is not always the last written. */
export const currentPayoutSeed = (seeds: PayoutSeed[]): PayoutSeed => {
  if (seeds.length === 0) {
    throw new Error('this account has no payout seed; it cannot raise a payroll run');
  }
  return seeds.reduce((a, b) => (b.epoch > a.epoch ? b : a));
};

/**
 * The seed a given run was raised under.
 *
 * Fails loudly rather than falling back to the current one. A silent fallback
 * would derive different leaves for a run that already has approvals against
 * the old ones — every payment refused, with nothing to say why.
 */
export const payoutSeedAt = (seeds: PayoutSeed[], epoch: number): PayoutSeed => {
  const found = seeds.find((s) => s.epoch === epoch);
  if (!found) {
    throw new Error(
      `no payout seed for epoch ${epoch}; this run cannot be rebuilt from this account's state`);
  }
  return found;
};

/**
 * The key one run's payments hang off.
 *
 * The account id is the salt, so two accounts never derive the same run key
 * even if a seed were somehow reused; the run id is the info, which is what
 * HKDF's info field is for.
 */
export const runKeyOf = (seed: Hex, id: RunIdentity): Hex =>
  toHex(hkdf(sha256, fromHex(seed), utf8(id.accountId), utf8(`payout-run:${id.runId}`), 32));

/** One payee's two secrets. Both derived, neither stored, neither guessable. */
export interface PayeeSecrets {
  /** Blinds the payment's details — who, what token, how much. */
  blinding: Hex;
  /** The per-payee secret a claim must know. V-43. */
  nonce: Hex;
}

/**
 * The secrets for the payee at `index`.
 *
 * The index is the SALT and the role is the INFO, so the two secrets for one
 * payee are independent of each other and of every other payee's. Deriving both
 * from one hash of the index — say the first and second halves — would mean a
 * leaked nonce leaks the blinding beside it, and a nonce IS published by the
 * payment that spends it.
 */
export const payeeSecretsOf = (runKey: Hex, index: number): PayeeSecrets => {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`a payee index is a non-negative integer; got ${index}`);
  }
  const of = (role: string) =>
    toHex(hkdf(sha256, fromHex(runKey), utf8(String(index)), utf8(`payee-${role}`), 32));
  return { blinding: of('blinding'), nonce: of('nonce') };
};

/**
 * Every payee's secrets for a run, in tree order.
 *
 * The whole point of this file in one call: hand it the seed the run was raised
 * under and its identity, and get back exactly what the builder had — on any
 * admin's machine, a month later, with the original laptop at the bottom of a
 * river.
 */
export const runSecrets = (
  seeds: PayoutSeed[],
  id: RunIdentity,
  payees: number,
): PayeeSecrets[] => {
  if (!Number.isInteger(payees) || payees < 1) {
    throw new Error(`a run has at least one payee; got ${payees}`);
  }
  const key = runKeyOf(payoutSeedAt(seeds, id.epoch).seed, id);
  return Array.from({ length: payees }, (_, i) => payeeSecretsOf(key, i));
};
