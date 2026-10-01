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
 *   2. Everything a found note became, under each of the vault's nonce
 *      secrets: a note the vault's split journal names was split, and the
 *      journal's entry, unmasked with the secret, is the piece's amount, so
 *      both notes the split kept are named exactly. Any other note may have
 *      paid one of the amounts the company paid, and the change that payment
 *      left is tried for each (its nonce follows from the secret and the
 *      spent note's nullifier, its value is the rest). Found notes are walked
 *      the same way until nothing new is found.
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
 * made, a coin made under a nonce secret the record does not hold, a deposit
 * made with a nonce that was not derived, and a deposit derived from a key that is not one
 * of the vault's epochs (the operator tools derive theirs from their own seed
 * file). Each of those leaves a commitment in the vault's
 * note set that nothing explains, and the rebuild reports it as unexplained.
 */
import type { Hex } from '../core/crypto.js';
import { toHex, fromHex } from '../core/crypto.js';
import type { VaultCoin } from './vault-coins.js';
import { changeNotesOf, splitPiecesOf } from './vault-recovery.js';
import {
  NonceSecretNeeded, nonceCircuitsFrom, secretsOfTheVault, spentNullifierOf, splitPieceAmountOf,
  type VaultNonceCircuits, type VaultNonceSecrets,
} from './vault-coin-nonces.js';
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
  /** How many of them are deposits, notes that stayed (a payment's change, a split's remainder) and split pieces. */
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
  const spendsNothing = {
    noteToSpend: () => { throw new Error('a rebuild computes commitments and spends nothing'); },
    nonceSecret: () => { throw new Error('a rebuild computes commitments and reads no nonce secret'); },
  };
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
  /**
   * **THE VAULT'S NONCE SECRETS**, every one the company's record holds, oldest
   * first, with the commitment the vault holds now. Every change and split piece
   * the vault made takes its nonce from one of them, so a walk of records that
   * name any payment is refused without them.
   */
  readonly nonceSecrets?: VaultNonceSecrets;
  /** The vault's split journal as the chain holds it: masked amount by spent note's nullifier, hex. Required with the secrets. */
  readonly splitJournal?: ReadonlyMap<string, string>;
  /** The vault contract's pure circuits; the compiled contract's own when not given. */
  readonly circuits?: Partial<VaultNonceCircuits>;
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

  /*
   * **WHAT NAMES A COIN THE VAULT MADE, CHECKED BEFORE ANYTHING IS WALKED.** The
   * secrets must include the one the vault holds now, and the split journal
   * must have been read: a journal not read is not a vault that never split.
   */
  let naming: { circuits: VaultNonceCircuits; secrets: readonly Hex[]; journal: Map<string, string> } | undefined;
  if (input.nonceSecrets !== undefined) {
    const circuits = nonceCircuitsFrom(input.circuits
      ?? (await import('../../contracts/managed-vault/contract/index.js')).pureCircuits as unknown as VaultNonceCircuits);
    if (input.splitJournal === undefined) {
      throw new NonceSecretNeeded(
        'the vault\'s split journal was not given. A split\'s pieces are named from it, and a journal '
        + 'not read is not a vault that never split: read it from the chain, where an empty one is a vault with no split.');
    }
    naming = {
      circuits,
      secrets: secretsOfTheVault(circuits, input.vault, input.nonceSecrets),
      journal: new Map([...input.splitJournal].map(([k, v]) => [k.toLowerCase().replace(/^0x/u, ''), v.toLowerCase().replace(/^0x/u, '')])),
    };
  } else if (paidByToken.size > 0) {
    throw new NonceSecretNeeded(
      'the company\'s records name payments, and the change each one left is named only with the vault\'s nonce secret.');
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
   * the lowest one at which its money's coin had never been made, so a deposit
   * at slot `s` sits above `s - 1` earlier coins of its own money on the chain;
   * no deposit to this vault therefore used a slot past `lastDepositSlot` of the
   * count read now. The bound is the vault's, not a number of misses in a row.
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
   * **EVERY COIN MADE FROM A NOTE DEPENDS ONLY ON THE NOTE, THE SECRET AND WHAT
   * LEFT IT.** A note is spent once, so once anything made from it is found
   * nothing else is tried for it. A note the split journal names was split:
   * the entry gives the piece exactly, and the note that stays is named first,
   * then the piece. Any other note is tried against each amount paid in its
   * token, the change worked out once per secret.
   */
  for (let i = 0; naming !== undefined && i < coins.length; i += 1) {
    const note = coins[i]!;
    const nullifier = spentNullifierOf(naming.circuits, input.vault, note);
    const masked = naming.journal.get(nullifier);
    for (const secret of naming.secrets) {
      const under = { circuits: naming.circuits, vault: input.vault, secret };
      if (masked !== undefined) {
        const amount = splitPieceAmountOf(naming.circuits, secret, nullifier, masked, note.value);
        if (amount === undefined) continue;
        const [piece, rest] = splitPiecesOf(note, amount, under);
        const keptRest = !byNonce.has(rest.nonce) && await made(rest) && keep(rest, 'changes');
        const keptPiece = !byNonce.has(piece.nonce) && await made(piece) && keep(piece, 'pieces');
        if (keptRest || keptPiece) break;
        continue;
      }
      let found = false;
      for (const change of changeNotesOf(note, paidByToken.get(note.token) ?? [], under)) {
        if (byNonce.has(change.nonce)) break;
        if (await made(change)) { found = keep(change, 'changes'); break; }
      }
      if (found) break;
    }
  }

  return { coins, found, checks, slots };
};
