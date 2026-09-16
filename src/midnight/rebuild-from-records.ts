/**
 * **NAMING A VAULT'S NOTES WITH NOTHING OF OURS: THE COMPANY'S KEY, ITS OWN
 * RECORDS OF WHAT IT DEPOSITED AND PAID, AND THE CHAIN.**
 *
 * A commitment cannot be inverted, so nothing can read a note off the chain.
 * But the search for one is not blind. A company knows what it put in (its
 * bank or exchange records) and what it paid (its payroll), and it keeps both
 * whether or not this product exists. With deposit nonces derived from a key
 * the company holds (`deposit-nonce.ts`), each (version, amount) pair is one
 * candidate coin, and each candidate costs one commitment and one set lookup
 * against every coin the chain has ever created for the vault.
 *
 * **THE WALK.**
 *   1. Deposits: for each version of the deposit journal from 1, every amount
 *      the company deposited is tried under every key it was given. The walk
 *      goes at least as far as the number of coins the chain has created for
 *      the vault, and then stops after `gap` versions in a row at which no key
 *      names anything: an attempt that never landed, a line written before
 *      nonces were derived and a deposit by a person whose key is not given
 *      each leave such a version.
 *   2. Everything a found note became: for each amount the company paid,
 *      the change a payment of that amount left (its nonce follows from the
 *      spent note's, its value is the rest) and the piece a split of that
 *      amount made. Found notes are walked the same way until nothing new is
 *      found.
 *
 * **THIS ONLY PROPOSES.** What it returns is every coin the chain has ever
 * created for this vault that the records can name, spent or not. Which of
 * them the vault holds NOW is `reconcileVaultPool`'s question, put to the
 * vault's own note set, and a coin the chain does not hold is not money
 * whatever this walk found.
 *
 * **WHAT IT CANNOT FIND, SAID RATHER THAN HIDDEN.** An amount the records do
 * not hold to the base unit names nothing, and so does a deposit somebody else
 * made, a split of an amount that is not a payment, and a deposit made with a
 * nonce that was not derived. Each of those leaves a commitment in the vault's
 * note set that nothing explains, and the rebuild reports it as unexplained.
 */
import type { Hex } from '../core/crypto.js';
import { toHex, fromHex } from '../core/crypto.js';
import type { VaultCoin } from './vault-coins.js';
import { changeNoteOf, sentNonceOf } from './vault-recovery.js';
import { depositNonceAt, type DepositNonceKey } from './deposit-nonce.js';

/** What the company recorded, per token, in the token's base units. */
export interface CompanyRecords {
  /** Every amount put into this vault. Repeats are one amount. */
  readonly deposited: ReadonlyArray<{ readonly token: Hex; readonly value: bigint }>;
  /** Every amount paid out of it, to anybody. Repeats are one amount. */
  readonly paid: ReadonlyArray<{ readonly token: Hex; readonly amount: bigint }>;
}

/** What a walk found, and what it cost. */
export interface RecordsWalk {
  /** Every coin found, spent or not, in the order found. */
  readonly coins: readonly VaultCoin[];
  /** How many of them are deposits, changes and split pieces. */
  readonly found: { readonly deposits: number; readonly changes: number; readonly pieces: number };
  /** Candidate coins put to the history. */
  readonly checks: number;
  /** The highest deposit version walked, and the highest at which any key named a coin (0 for none). */
  readonly versions: ReadonlyArray<{ readonly walked: number; readonly lastFound: number }>;
}

/**
 * How many versions in a row may name nothing before the deposit walk stops.
 * Each is one refused or abandoned deposit attempt; a company with more in a
 * row than this passes a larger number.
 */
export const DEPOSIT_VERSION_GAP = 20;

const distinct = <T>(xs: readonly T[], keyOf: (x: T) => string): T[] => {
  const seen = new Map<string, T>();
  for (const x of xs) if (!seen.has(keyOf(x))) seen.set(keyOf(x), x);
  return [...seen.values()];
};

export const walkCompanyRecords = async (input: {
  /** The vault's own address. */
  readonly vault: Hex;
  /** One key per person who has deposited into this vault. */
  readonly keys: readonly DepositNonceKey[];
  readonly records: CompanyRecords;
  /** The ledger's commitment of every coin the chain has ever created for the vault. */
  readonly everCreated: ReadonlySet<string>;
  /** The ledger's commitment of one coin owned by the vault. */
  readonly commitmentOf: (coin: VaultCoin, vault: Hex) => Promise<string> | string;
  readonly gap?: number;
}): Promise<RecordsWalk> => {
  const gap = input.gap ?? DEPOSIT_VERSION_GAP;
  if (!Number.isInteger(gap) || gap < 1) throw new Error('the deposit walk needs a gap of at least one version');
  /*
   * A token is written one way, 64 lower-case hex characters, as the pool writes
   * it: a record in another spelling is refused rather than folded, because a
   * coin carrying a second spelling of its token is a coin the pool compares
   * wrongly.
   */
  const oneSpelling = (token: string) => {
    if (!/^[0-9a-f]{64}$/u.test(token)) {
      throw new Error('a recorded token is not written as 64 lower-case hex characters; correct the record');
    }
  };
  for (const d of input.records.deposited) {
    oneSpelling(d.token);
    if (d.value <= 0n) throw new Error('a recorded deposit of nothing names no coin; correct the record');
  }
  for (const p of input.records.paid) {
    oneSpelling(p.token);
    if (p.amount <= 0n) throw new Error('a recorded payment of nothing names no coin; correct the record');
  }
  const deposited = distinct(input.records.deposited, (d) => `${d.token}:${d.value}`);
  const paidByToken = new Map<string, bigint[]>();
  for (const p of distinct(input.records.paid, (x) => `${x.token}:${x.amount}`)) {
    paidByToken.set(p.token, [...(paidByToken.get(p.token) ?? []), p.amount]);
  }

  let checks = 0;
  const made = async (coin: VaultCoin): Promise<boolean> => {
    checks += 1;
    const c = (await input.commitmentOf(coin, input.vault)).toLowerCase().replace(/^0x/u, '');
    return input.everCreated.has(c);
  };

  const coins: VaultCoin[] = [];
  const byNonce = new Set<string>();
  const found = { deposits: 0, changes: 0, pieces: 0 };
  const keep = (coin: VaultCoin, kind: keyof typeof found): boolean => {
    if (byNonce.has(coin.nonce)) return false;
    byNonce.add(coin.nonce);
    coins.push(coin);
    found[kind] += 1;
    return true;
  };

  /*
   * **ONE WALK OVER THE VERSIONS, FOR EVERY KEY AT ONCE.** A version number
   * belongs to the vault's deposit journal, not to a person: every depositor,
   * every abandoned attempt and every line written before nonces were derived
   * uses one. So the gap is counted over versions at which NO key named a coin.
   * Counted per key, one person's run of deposits would read as a gap for
   * everybody else, and a deposit made after it would never be tried.
   */
  /*
   * **AND NEVER SHORTER THAN THE VAULT'S OWN OUTPUT COUNT.** Every deposit that
   * landed made an output and used a version - one made before nonces were
   * derived, or by a person whose key is not here, included. So at least that
   * many versions are walked before the gap is allowed to end it, however many
   * of them this walk cannot name.
   */
  const floor = input.keys.length > 0 ? input.everCreated.size : 0;
  let lastFound = 0;
  let version = 1;
  for (; input.keys.length > 0 && (version <= floor || version - lastFound <= gap); version += 1) {
    for (const key of input.keys) {
      for (const d of deposited) {
        const coin = { nonce: depositNonceAt(key, d, version), token: d.token, value: d.value };
        if (await made(coin)) {
          keep(coin, 'deposits');
          lastFound = version;
        }
      }
    }
  }
  const versions = [{ walked: version - 1, lastFound }];

  for (let i = 0; i < coins.length; i += 1) {
    const note = coins[i]!;
    for (const amount of paidByToken.get(note.token) ?? []) {
      if (amount >= note.value) continue;
      const change = changeNoteOf(note, amount)!;
      if (!byNonce.has(change.nonce) && await made(change)) keep(change, 'changes');
      const piece = { nonce: toHex(sentNonceOf(fromHex(note.nonce))), token: note.token, value: amount };
      if (!byNonce.has(piece.nonce) && await made(piece)) keep(piece, 'pieces');
    }
  }

  return { coins, found, checks, versions };
};
