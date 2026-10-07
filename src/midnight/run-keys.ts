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
 * THE NONCE COMES FROM SOMETHING ELSE: WHO IS PAID, FOR WHICH MONTH
 *
 * A payee's BLINDING comes from the run, as above. Their NONCE does not: it is
 * derived from the account's PAY-RECORD KEY and four values - the person, the
 * month, the kind of pay and which payment of that kind this is. The account
 * records a value made from the nonce with every payment and refuses a second
 * one, so the same person cannot be paid twice for one month, at another
 * amount, another address or in the other form, by this run or any other.
 *
 * The pay-record key is not a payout seed. Seeds are appended at every signer
 * removal, and a nonce derived from the seed in force would change at a removal
 * and let a month already paid be paid again. The pay-record key is kept for
 * the life of the account; a signer who leaves can still test whether a named
 * person was paid for a month, and that is accepted.
 *
 * A real second payment for the same person and month is a later OCCURRENCE:
 * 1, 2 and so on, raised with its reason and approved like any run.
 *
 * ------------------------------------------------------------------------
 * WHAT AN ATTACKER GETS FROM A PAID PAYEE
 *
 * Nothing about anybody else. A payment does not publish its nonce - the
 * account records a hash of it - and each payee is handed their own. Every
 * nonce is an HKDF output of the pay-record key; knowing forty of them says
 * nothing about the forty-first, and nothing about the key that produced them.
 *
 * HKDF rather than hashing values together by hand, matching
 * `core/sealed-records.ts`: a hand-rolled construction is the kind of thing
 * that looks fine and is subtly wrong.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { toHex, fromHex, utf8, wrapKey, type Hex } from '../core/crypto.js';

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
  /** The per-payee secret a claim must know, and what the account's record of the person and month is made from. V-43. */
  nonce: Hex;
}

/**
 * The blinding for the payee at `index` of a run.
 *
 * The index is the SALT and the role is the INFO, so no payee's blinding says
 * anything about another's. Each payee is handed their own blinding to find
 * their payment.
 */
export const payeeBlindingOf = (runKey: Hex, index: number): Hex => {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`a payee index is a non-negative integer; got ${index}`);
  }
  return toHex(hkdf(sha256, fromHex(runKey), utf8(String(index)), utf8('payee-blinding'), 32));
};

/**
 * WHAT ONE PAYMENT IS FOR: the person, the month, the kind of pay, and which
 * payment of that kind for that person and month it is.
 */
export interface PayRecord {
  /** The person, by their entry on the company's roster. */
  person: string;
  /** The month, written `YYYY-MM`. Any other spelling is refused, never read. */
  month: string;
  /** What the pay is. */
  kind: string;
  /** 0 for the first payment; a numbered extra is 1, 2 and so on. */
  occurrence: number;
}

/** The account's pay-record key and what each payee of one run is paid for, in tree order. */
export interface PayRecords {
  key: Hex;
  records: PayRecord[];
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * **THE NONCE FOR ONE PAYMENT, FROM THE PAY-RECORD KEY AND WHAT IT IS FOR.**
 *
 * The same person, month, kind and occurrence always give the same nonce, on
 * any signer's device, and the account refuses a second payment carrying it.
 * **A month in any spelling but `YYYY-MM` is refused**, because `2026-9` and
 * `2026-09` would give two nonces for one month, and the second payment would
 * pass.
 */
export const payRecordNonceOf = (key: Hex, record: PayRecord): Hex => {
  if (!record.person.trim()) throw new Error('a payment names the person it pays');
  if (!MONTH.test(record.month)) {
    throw new Error(`"${record.month}" is not a month written YYYY-MM, so the payment cannot be recorded against it`);
  }
  if (!record.kind.trim()) throw new Error('a payment names the kind of pay it is');
  if (!Number.isInteger(record.occurrence) || record.occurrence < 0) {
    throw new Error(`a payment's occurrence is 0 or a later whole number; got ${record.occurrence}`);
  }
  if (fromHex(key).length !== 32) throw new Error('the pay-record key is 32 bytes');
  const info = JSON.stringify([record.person, record.month, record.kind, record.occurrence]);
  return toHex(hkdf(sha256, fromHex(key), utf8('pay-record'), utf8(info), 32));
};

/**
 * Every payee's secrets for a run, in tree order.
 *
 * The whole point of this file in one call: hand it the seed the run was raised
 * under, its identity, the pay-record key and what each payee is paid for, and
 * get back exactly what the builder had — on any admin's machine, a month
 * later, with the original laptop at the bottom of a river.
 */
export const runSecrets = (
  seeds: PayoutSeed[],
  id: RunIdentity,
  pay: PayRecords,
): PayeeSecrets[] => {
  if (pay.records.length < 1) {
    throw new Error('a run has at least one payee; got 0');
  }
  const key = runKeyOf(payoutSeedAt(seeds, id.epoch).seed, id);
  return pay.records.map((record, i) => ({
    blinding: payeeBlindingOf(key, i),
    nonce: payRecordNonceOf(pay.key, record),
  }));
};

/* ------------------------------------------------------------------------
 * THE PAY-RECORD KEY ON CHAIN: ONE COMMITMENT, AND A COPY SEALED TO EACH SIGNER
 * ------------------------------------------------------------------------ */

/** How many 32-byte entries a sealed copy of the key takes on chain. */
export const PAY_KEY_WRAP_PARTS = 4;

/**
 * **THE PAY-RECORD KEY SEALED TO ONE SIGNER, AS THE FOUR 32-BYTE ENTRIES THE
 * ACCOUNT STORES.** The same sealing a viewing key reaches a signer with: a
 * fresh x25519 key agreed with the signer's wrapping key, and AES-GCM over the
 * key. That is 124 bytes - the 32-byte ephemeral key, the 12-byte IV and 80
 * bytes of ciphertext and tag - written as 128 with four zero bytes at the end.
 */
export const sealPayKeyTo = (key: Hex, wrappingPublicKey: Hex): Hex[] => {
  if (fromHex(key).length !== 32) throw new Error('the pay-record key is 32 bytes');
  const w = wrapKey(key.toLowerCase(), wrappingPublicKey);
  const packed = new Uint8Array(32 * PAY_KEY_WRAP_PARTS);
  const parts = [fromHex(w.ephemeral), fromHex(w.iv), fromHex(w.body)];
  if (parts[0]!.length !== 32 || parts[1]!.length !== 12 || parts[2]!.length !== 80) {
    throw new Error('the sealed pay-record key is not the 124 bytes the account stores');
  }
  packed.set(parts[0]!, 0);
  packed.set(parts[1]!, 32);
  packed.set(parts[2]!, 44);
  return Array.from({ length: PAY_KEY_WRAP_PARTS }, (_, i) => toHex(packed.slice(32 * i, 32 * (i + 1))));
};

