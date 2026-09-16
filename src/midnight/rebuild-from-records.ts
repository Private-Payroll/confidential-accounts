/**
 * **NAMING A VAULT'S NOTES WITH NOTHING OF OURS: THE COMPANY'S KEY, ITS OWN
 * RECORDS OF WHAT IT DEPOSITED AND PAID, AND THE CHAIN.**
 *
 * A commitment cannot be inverted, so nothing can read a note off the chain.
 * But the search for one is not blind. A company knows what it put in (its
 * bank or exchange records) and what it paid (its payroll), and it keeps both
 * whether or not this product exists. With deposit nonces derived from a key
 * the company holds (`deposit-nonce.ts`), each (slot, amount) pair is one
 * candidate coin, and each candidate costs one commitment and one set lookup
 * against every coin the chain has ever created for the vault.
 *
 * **THE WALK.**
 *   1. Deposits: for each slot from 1 to the vault's output count plus
 *      `DEPOSIT_SLOT_ATTEMPTS` (`lastDepositSlot`), every amount the company
 *      deposited is tried under every epoch of the vault's nonce secret. That
 *      is every slot any deposit to this vault can have used, however many
 *      attempts were abandoned or refused, so the walk has no gap to guess.
 *   2. Everything a found note became: for each amount the company paid,
 *      the change a payment of that amount left (its nonce follows from the
 *      spent note's, its value is the rest) and the piece a split of that
 *      amount made. Found notes are walked the same way until nothing new is
 *      found.
 *
 * **ASK THE CONTRACT, NOT THE LEDGER'S GENERAL CODE.** Each candidate is one
 * commitment. The vault's own compiled contract computes the same value the
 * ledger records for a contract-owned output (`compiledOutputCommitment`), at
 * a small fraction of the cost of building a ledger output to read it off.
 *
 * **THIS ONLY PROPOSES.** What it returns is every coin the chain has ever
 * created for this vault that the records can name, spent or not. Which of
 * them the vault holds NOW is `reconcileVaultPool`'s question, put to the
 * vault's own note set, and a coin the chain does not hold is not money
 * whatever this walk found.
 *
 * **WHAT IT CANNOT FIND, SAID RATHER THAN HIDDEN.** An amount the records do
 * not hold to the base unit names nothing, and so does a deposit somebody else
 * made, a split of an amount that is not a payment, a deposit made with a
 * nonce that was not derived, and a deposit derived from a key that is not one
 * of the vault's epochs (the operator tools derive theirs from their own seed
 * file). Each of those leaves a commitment in the vault's
 * note set that nothing explains, and the rebuild reports it as unexplained.
 */
import type { Hex } from '../core/crypto.js';
import { toHex, fromHex } from '../core/crypto.js';
import type { VaultCoin } from './vault-coins.js';
import { changeNotesOf, sentNonceOf } from './vault-recovery.js';
import { depositNonceAt, lastDepositSlot, type DepositNonceKey } from './deposit-nonce.js';

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
  /** The last deposit slot walked, which the vault's output count decides, and the last at which a coin was named (0 for none). */
  readonly slots: { readonly walked: number; readonly lastFound: number };
}

/**
 * **THE LEDGER'S COMMITMENT OF A COIN OWNED BY A VAULT, COMPUTED BY THE VAULT'S
 * OWN COMPILED CONTRACT.** The same function its deposit and payout circuits
 * use to claim the outputs they make, which the ledger checks against the
 * outputs it records; so it answers what the ledger answers, without building a
 * ledger output for every candidate.
 */
export const compiledOutputCommitment = async (): Promise<(coin: VaultCoin, vault: Hex) => string> => {
  const { Contract } = await import('../../contracts/managed-vault/contract/index.js');
  /* The one witness the contract requires, which a commitment never reaches. */
  const spendsNothing = { noteToSpend: () => { throw new Error('a rebuild computes commitments and spends nothing'); } };
  const contract = new Contract(spendsNothing as never) as unknown as {
    _coinCommitment_0?: (
      coin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
      recipient: { is_left: boolean; left: { bytes: Uint8Array }; right: { bytes: Uint8Array } },
    ) => Uint8Array;
  };
  const commit = contract._coinCommitment_0;
  if (typeof commit !== 'function') {
    throw new Error(
      'the compiled vault contract no longer carries the commitment function a rebuild asks, so no '
      + 'candidate can be checked. Nothing is proposed. Rebuild the contract artefacts this build expects.');
  }
  const noUser = new Uint8Array(32);
  /* A walk asks about one vault many times; its bytes are made once per vault asked about. */
  let asked: { vault: Hex; recipient: { is_left: boolean; left: { bytes: Uint8Array }; right: { bytes: Uint8Array } } } | null = null;
  return (coin, vault) => {
    if (asked === null || asked.vault !== vault) {
      asked = { vault, recipient: { is_left: false, left: { bytes: noUser }, right: { bytes: fromHex(vault) } } };
    }
    return toHex(commit.call(contract,
      { nonce: fromHex(coin.nonce), color: fromHex(coin.token), value: coin.value }, asked.recipient));
  };
};

const distinct = <T>(xs: readonly T[], keyOf: (x: T) => string): T[] => {
  const seen = new Map<string, T>();
  for (const x of xs) if (!seen.has(keyOf(x))) seen.set(keyOf(x), x);
  return [...seen.values()];
};

export const walkCompanyRecords = async (input: {
  /** The vault's own address. */
  readonly vault: Hex;
  /** One key per epoch of the vault's nonce secret, every epoch the company has had. */
  readonly keys: readonly DepositNonceKey[];
  readonly records: CompanyRecords;
  /** The ledger's commitment of every coin the chain has ever created for the vault. */
  readonly everCreated: ReadonlySet<string>;
  /** The ledger's commitment of one coin owned by the vault. */
  readonly commitmentOf: (coin: VaultCoin, vault: Hex) => Promise<string> | string;
}): Promise<RecordsWalk> => {
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
   * **EVERY SLOT A DEPOSIT CAN HAVE USED, FOR EVERY EPOCH AT ONCE.** A slot is
   * the vault's output count when the deposit was prepared, plus its attempt,
   * and that count only grows; so no deposit to this vault used a slot past
   * `lastDepositSlot` of the count read now. The bound is the vault's, not a
   * number of misses in a row.
   */
  const last = input.keys.length > 0 ? lastDepositSlot(input.everCreated.size) : 0;
  let lastFound = 0;
  for (let slot = 1; slot <= last; slot += 1) {
    for (const key of input.keys) {
      for (const d of deposited) {
        const coin = { nonce: depositNonceAt(key, d, slot), token: d.token, value: d.value };
        if (!byNonce.has(coin.nonce) && await made(coin)) {
          keep(coin, 'deposits');
          lastFound = slot;
        }
      }
    }
  }
  const slots = { walked: last, lastFound };

  /*
   * **A CHANGE'S NONCE, AND A PIECE'S, DEPEND ONLY ON THE NOTE THEY CAME FROM**,
   * so each is worked out once per note, and only one change and one piece can
   * exist per note: once one is found, the other amounts are not tried.
   */
  for (let i = 0; i < coins.length; i += 1) {
    const note = coins[i]!;
    const amounts = paidByToken.get(note.token) ?? [];
    for (const change of changeNotesOf(note, amounts)) {
      if (byNonce.has(change.nonce)) break;
      if (await made(change)) keep(change, 'changes');
    }
    const pieceNonce = toHex(sentNonceOf(fromHex(note.nonce)));
    for (const amount of amounts) {
      if (amount >= note.value || byNonce.has(pieceNonce)) continue;
      const piece = { nonce: pieceNonce, token: note.token, value: amount };
      if (await made(piece)) keep(piece, 'pieces');
    }
  }

  return { coins, found, checks, slots };
};
