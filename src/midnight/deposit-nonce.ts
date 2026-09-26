/**
 * **A DEPOSIT'S NONCE, DERIVED FROM THE COMPANY'S OWN SECRET FOR THE VAULT, AND
 * THE CHECK THAT THE COIN IT NAMES HAS NEVER BEEN MADE BEFORE.**
 *
 * A deposit creates a coin addressed to the vault, and the chain keeps only
 * commitments to it, which cannot be inverted. A nonce drawn at random is
 * therefore named by one thing in the world: whatever record wrote it down.
 * Lose that record and the note is unnameable for good.
 *
 * A nonce derived from a secret the company holds, the vault, the coin and a
 * SLOT the vault itself bounds can be found again by anybody holding that
 * secret and the company's own record of what it deposited: each candidate is
 * one commitment computed and one set lookup (`rebuild-from-records.ts`).
 *
 * ------------------------------------------------------------------------
 * **WHICH SECRET.** The root is one epoch of the vault's nonce secret
 * (`company-nonce-secret.ts`): thirty-two random bytes that belong to the
 * company, not to whoever deposits, wrapped to every signer under a key each
 * signer derives from their own recovery words. Any signer opens it; a signer
 * who leaves takes nothing with them, because every other signer still opens
 * it; and when one leaves, a new epoch begins and every earlier one is kept, so
 * older deposits keep their names. It is secret, and it has to be: a nonce
 * anybody could compute would let anybody put a guessed salary to the chain and
 * be told whether it is right.
 *
 * ------------------------------------------------------------------------
 * **THE SLOT, AND WHY IT IS BOUNDED BY THE VAULT RATHER THAN BY A GUESS.**
 *
 * A deposit's slot is the lowest slot, from 1, at which the coin its money
 * would make has never been created for the vault (`claimNewDepositCoin`).
 * Only coins of that same money at lower slots can push it up, so every
 * deposit that ever lands used a slot no larger than the vault's final output
 * count plus `DEPOSIT_SLOT_ATTEMPTS`, and a rebuild that walks that far has
 * tried every slot any deposit could have used. An attempt that never lands
 * consumes nothing: the next deposit of the same money finds that slot free
 * and uses it.
 *
 * Two deposits of one amount made before either lands name the same coin. Only one of them can land: the ledger refuses to create an
 * output whose commitment it has already recorded, spent or not, and it
 * refuses the whole transaction, so the other moves no money. What that costs
 * is one proof made for nothing.
 *
 * ------------------------------------------------------------------------
 * **WHY THE COIN IS PART OF THE NONCE, AND WHY THE CHECK READS THE VAULT'S
 * WHOLE HISTORY.**
 *
 * If the nonce named only the slot, two deposits of different amounts at one
 * slot would make two different coins under one nonce: the ledger takes both,
 * and this product's pool, which keeps one note per nonce, cannot hold them.
 * **With the token and the value in it, a repeated nonce can only ever be a
 * repeated coin.**
 *
 * A repeated coin cannot land, but the ledger says so only after the
 * transaction has been proved and submitted. So the check below reads every
 * coin the chain has ever created for this vault - the note set it holds now
 * does not contain a spent one - and a deposit whose coin already exists moves
 * to the next slot before anything is proved.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex, toHex, utf8, type Hex } from '../core/crypto.js';
import type { NoteEvents, VaultTransactions } from './note-index.js';
import type { DepositJournal } from './vault-ledger.js';

const KEY_BYTES = 32;
const HEX32 = /^[0-9a-fA-F]{64}$/u;
const MAX_VALUE = (1n << 128n) - 1n;
const MAX_SLOT = Number.MAX_SAFE_INTEGER;

/*
 * The domain of this derivation. The day it changes, every deposit made under
 * the old one is found only by its journal, so a change is a migration and
 * never a patch. `v2` expands a vault's nonce secret and counts slots. `v1`
 * expanded one person's key and counted journal versions; a deposit derived
 * under it is named by its journal line.
 */
const NONCE_KEY_SALT = utf8('confidential-accounts/deposit-nonce/v2');
const NONCE_TAG = utf8('deposit');

declare const nonceKeyBrand: unique symbol;

/**
 * Thirty-two bytes that name one vault's deposits. Its own type, so it cannot
 * be passed where a wrapping secret, a signing secret or a company key is
 * expected; all four are the same length.
 */
export type DepositNonceKey = Uint8Array & { readonly [nonceKeyBrand]: true };

/** A coin a deposit creates: its nonce, token and value. */
export interface DepositCoin {
  readonly nonce: Hex;
  readonly token: Hex;
  readonly value: bigint;
}

/** What a deposit moves: a token and an amount in the token's base units. */
export interface DepositMoney {
  readonly token: Hex;
  readonly value: bigint;
}

const hex32 = (what: string, h: unknown): Uint8Array => {
  if (typeof h !== 'string' || !HEX32.test(h)) {
    throw new Error(`${what} is not sixty-four hex characters, so no deposit nonce is derived from it.`);
  }
  return fromHex(h.toLowerCase());
};

/**
 * **THE KEY ONE VAULT'S DEPOSIT NONCES ARE DERIVED FROM.**
 *
 * `root` is one epoch of the vault's nonce secret, opened by a signer
 * (`openNonceSecrets`). The vault's address goes in as its one lower-case spelling, so two spellings
 * of one vault never derive two keys.
 */
export const depositNonceKeyFor = (root: Uint8Array, vault: Hex): DepositNonceKey => {
  if (!(root instanceof Uint8Array) || root.length !== KEY_BYTES) {
    throw new Error(
      `a deposit nonce key is derived from a ${KEY_BYTES}-byte secret, and this is not one. `
      + 'Nothing is derived and nothing is deposited. Unlock the company with its wallet again, '
      + 'so the key the wallet releases for it is the one used.');
  }
  if (root.every((b) => b === 0)) {
    throw new Error(
      'the secret a deposit nonce would be derived from is all zeros, which is no secret: '
      + 'anybody could derive the same nonces and test a guessed amount against the chain. '
      + 'Nothing is derived and nothing is deposited.');
  }
  const v = hex32('the vault\x27s address', vault);
  return hkdf(sha256, root, NONCE_KEY_SALT, utf8(toHex(v)), KEY_BYTES) as DepositNonceKey;
};

const be = (value: bigint, bytes: number): Uint8Array => {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = bytes - 1; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};

/**
 * **HOW FAR PAST THE VAULT'S OUTPUT COUNT A REBUILD WALKS**, and so the
 * margin above that count within which a deposit looks for a free slot. It is
 * the bound, not a tuning: a deposit allowed past it is one a rebuild cannot
 * find.
 */
export const DEPOSIT_SLOT_ATTEMPTS = 3;

/**
 * **HOW LONG A CLAIMED SLOT STAYS TAKEN WITHOUT THE CHAIN HAVING MADE ITS
 * COIN.** A deposit's call can land for an hour after it is built, and it is
 * built after its slot is claimed; this is that hour, the quarter of an hour a
 * block clock and a device clock may disagree by, and as long again for the
 * build and the wallet. A line older than this is a deposit that can no longer
 * land, so its slot is free again. Every slot a claim can take is still at or
 * below `lastDepositSlot` of the history as read, so a skipped slot never puts
 * a deposit where a rebuild's walk does not reach.
 */
export const DEPOSIT_CLAIM_LIVE_MS = 150 * 60_000;

/**
 * **ANOTHER DEPOSIT OF THE SAME MONEY CLAIMED THIS SLOT A MOMENT AGO**, from
 * this browser or another, and it may still land. Its coin would be this coin,
 * so the next slot is tried.
 */
export class DepositSlotTaken extends Error {
  constructor(readonly slot: number) {
    super(`another deposit of this same amount into this vault started a moment ago and may still arrive (slot ${slot})`);
    this.name = 'DepositSlotTaken';
  }
}

/**
 * **THE HIGHEST SLOT ANY DEPOSIT TO A VAULT CAN HAVE USED**, given every coin
 * the chain has ever created for it.
 */
export const lastDepositSlot = (everCreatedCount: number): number => {
  if (!Number.isSafeInteger(everCreatedCount) || everCreatedCount < 0) {
    throw new Error(`a vault has created a whole number of coins, and ${String(everCreatedCount)} is not one.`);
  }
  return everCreatedCount + DEPOSIT_SLOT_ATTEMPTS;
};

/**
 * **THE NONCE OF A DEPOSIT OF `money` AT `slot`.**
 *
 * The slot is the lowest one at which this money's coin has never been made
 * for the vault (`claimNewDepositCoin`). Nothing else chooses it.
 */
export const depositNonceAt = (key: DepositNonceKey, money: DepositMoney, slot: number): Hex => {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new Error('a deposit nonce needs the vault\x27s deposit nonce key, and this is not one.');
  }
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT) {
    throw new Error(`a deposit takes a whole slot from 1, and ${String(slot)} is not one.`);
  }
  if (typeof money.value !== 'bigint' || money.value <= 0n || money.value > MAX_VALUE) {
    throw new Error('a deposit moves a positive amount the ledger can hold, and this one does not.');
  }
  const token = hex32('the deposit\x27s token', money.token);
  const message = new Uint8Array(NONCE_TAG.length + 1 + 32 + 16 + 8);
  let at = 0;
  message.set(NONCE_TAG, at); at += NONCE_TAG.length;
  message[at] = 0; at += 1;
  message.set(token, at); at += 32;
  message.set(be(money.value, 16), at); at += 16;
  message.set(be(BigInt(slot), 8), at);
  return toHex(hmac(sha256, key, message));
};

/* ------------------------------------------------------------------ *
 * every coin the chain has ever made for a vault
 * ------------------------------------------------------------------ */

/**
 * **THE LEDGER'S COMMITMENT OF EVERY COIN THE CHAIN HAS EVER CREATED FOR ONE
 * VAULT**, spent or not.
 *
 * It answers the whole history or it throws. A short answer is the one
 * dangerous answer: a coin missing from it is a coin a deposit can make again.
 */
export interface VaultOutputHistory {
  everCreated(vault: Hex): Promise<ReadonlySet<string>>;
}

const bare = (hex: string): string => hex.trim().toLowerCase().replace(/^0x/u, '');

/**
 * The history, read from the chain: every transaction that acted on the
 * vault, and every output each one created that the vault owns. The list of
 * transactions refuses to answer short, and a transaction that cannot be read
 * stops the read rather than being skipped.
 */
export const vaultOutputHistoryFrom = (chain: {
  readonly transactions: VaultTransactions;
  readonly events: NoteEvents;
}): VaultOutputHistory => ({
  async everCreated(vault) {
    const mine = bare(vault);
    const hashes = await chain.transactions.of(vault);
    const made = new Set<string>();
    for (const hash of hashes) {
      const served = await chain.events.eventsOf({ hash });
      for (const e of served) {
        if (e.details.tag !== 'zswapOutput') continue;
        if (typeof e.details.contract !== 'string' || bare(e.details.contract) !== mine) continue;
        if (typeof e.details.commitment !== 'string') {
          throw new Error(
            'an output the chain created for this vault was served without its commitment, so the '
            + 'list of coins this vault has ever held has a hole in it. Nothing is deposited; read '
            + 'again.');
        }
        made.add(bare(e.details.commitment));
      }
    }
    return made;
  },
});

/**
 * The history a `VaultLedger` has when it is given none: one that refuses a
 * private deposit by name, before anything is filed or proved.
 */
export const noVaultOutputHistory = (): VaultOutputHistory => ({
  everCreated: async () => {
    throw new Error(
      'a private deposit first checks that the coin it is about to make has never been made for '
      + 'this vault before, and this ledger was given no way to read what the chain has created for '
      + 'it. Nothing is filed, proved or deposited. Construct the ledger with the vault\x27s output '
      + 'history, read from the indexer, and deposit again.');
  },
});

/**
 * **WHY THIS COIN MUST NOT BE MADE, OR `null` WHEN IT MAY.**
 *
 * Three places a coin can already be, each asked with what the caller has
 * already read: the pool, the vault's notes now, and every coin the chain has
 * ever created for the vault.
 */
export const whyThisCoinIsNotNew = (seen: {
  readonly poolHoldsTheNonce: boolean;
  readonly heldNow: boolean;
  readonly createdBefore: boolean;
}): string | null => {
  if (seen.createdBefore) {
    return 'the chain has already created this exact coin for this vault, and the ledger refuses '
      + 'to create it again';
  }
  if (seen.heldNow) return 'the vault already holds this exact coin';
  if (seen.poolHoldsTheNonce) return 'this vault\x27s pool already holds a note under this nonce';
  return null;
};

/**
 * **THE REFUSAL WHEN EVERY SLOT TRIED NAMED A COIN THAT ALREADY EXISTS.**
 *
 * Every slot up to the vault's output count plus `DEPOSIT_SLOT_ATTEMPTS` named
 * a coin that already exists, which only deposits of this same amount can do.
 * No line is filed for a slot that is passed over.
 */
export class DepositCoinAlreadyMade extends Error {
  constructor(readonly attempts: number, readonly because: string) {
    super(
      `nothing was deposited: every slot this deposit may use named a coin that already exists `
      + `(${because}). Deposits of this same amount are landing while this one is `
      + 'being prepared, or the chain was read from an indexer that is behind. Nothing was proved and '
      + 'no money moved. Wait for the other deposits to finish, read the vault again, and deposit '
      + 'again.');
    this.name = 'DepositCoinAlreadyMade';
  }
}

/**
 * **CHOOSE A DEPOSIT'S COIN: THE LOWEST SLOT WHOSE COIN HAS NEVER BEEN MADE,
 * THEN ONE LINE FOR IT.**
 *
 * One function, for every place a private deposit's coin is chosen (the
 * ledger and the device), so the order is written once:
 *
 *   1. the vault's history is already read (`everCreated`);
 *   2. from slot 1 upward, the coin this money would make at each slot is
 *      derived here, without filing anything, and the first one that the
 *      chain has never created, the vault does not hold and the pool does not
 *      name is the one used;
 *   3. a line is filed in the deposit journal for that slot alone, and the
 *      coin it files must be the coin derived in step 2;
 *   4. no slot free up to `lastDepositSlot` of the history as read is
 *      `DepositCoinAlreadyMade`.
 *
 * **WHY THE LOWEST FREE SLOT AND NOT THE OUTPUT COUNT.** A slot taken from the
 * vault's output count as the device read it grows with every output the
 * indexer served, including outputs the chain later drops, and one pushed past
 * the rebuild's walk is named by its journal alone. The lowest free slot is
 * pushed up only by coins of this exact money at the slots below it, and those
 * are this company's own earlier deposits of the same amount. So a deposit that
 * lands at slot `s` sits above `s - 1` coins of its own money, every one of them
 * in the history unless it too was dropped; the history when the rebuild reads
 * it therefore holds at least `s` coins, this one included, and the walk, which
 * runs to that count plus `DEPOSIT_SLOT_ATTEMPTS`, reaches it unless more of
 * those same-amount coins were dropped than `DEPOSIT_SLOT_ATTEMPTS` plus every
 * other coin the vault holds.
 *
 * **A SLOT ANOTHER DEPOSIT CLAIMED A MOMENT AGO IS ALSO PASSED OVER**
 * (`DepositSlotTaken`), and that coin may never be made. So the sentence above
 * holds less the slots passed over that way; what still holds whatever is
 * passed over is the bound: no slot past `lastDepositSlot` of the history as
 * read is ever claimed, and the history only grows, so the walk reaches every
 * slot a claim can take, unless outputs the chain later drops made the history
 * read here longer than the one the rebuild reads.
 *
 * Nothing here calls the contract. The caller calls it with the coin returned,
 * and with nothing else.
 */
export const claimNewDepositCoin = async (input: {
  readonly vault: string;
  readonly money: DepositMoney;
  readonly journal: DepositJournal;
  /** The nonce this vault's deposit of `money` has at `slot`: the derivation the journal files under. */
  readonly nonceAt: (money: DepositMoney, slot: number) => Hex;
  readonly everCreated: ReadonlySet<string>;
  /** The ledger's commitment of a coin owned by this vault, lower-case hex. */
  readonly outputCommitmentOf: (coin: DepositCoin) => Promise<string> | string;
  readonly heldNow: (coin: DepositCoin) => Promise<boolean> | boolean;
  readonly poolHoldsTheNonce: (nonce: Hex) => Promise<boolean> | boolean;
  /** A last check before the coin is used, which may throw; the pool's own pre-flight. */
  readonly accept?: (coin: DepositCoin) => Promise<void> | void;
  readonly now?: () => string;
}): Promise<{ readonly coin: DepositCoin; readonly slot: number }> => {
  const last = lastDepositSlot(input.everCreated.size);
  let because = '';
  for (let slot = 1; slot <= last; slot += 1) {
    const derived: DepositCoin = { nonce: input.nonceAt(input.money, slot), token: input.money.token, value: input.money.value };
    /* The history first: it is a set lookup, and it is where almost every taken slot is found. */
    if (input.everCreated.has(bare(await input.outputCommitmentOf(derived)))) {
      because = whyThisCoinIsNotNew({ poolHoldsTheNonce: false, heldNow: false, createdBefore: true })!;
      continue;
    }
    const why = whyThisCoinIsNotNew({
      poolHoldsTheNonce: await input.poolHoldsTheNonce(derived.nonce),
      heldNow: await input.heldNow(derived),
      createdBefore: false,
    });
    if (why !== null) { because = why; continue; }
    let claimed: Awaited<ReturnType<DepositJournal['claim']>>;
    try {
      claimed = await input.journal.claim(
        input.vault, input.money, slot, (input.now ?? (() => new Date().toISOString()))());
    } catch (cause) {
      /* By name: the journal may be another module's copy. Another deposit holds this slot; the next is tried. */
      if (!(cause instanceof Error && cause.name === 'DepositSlotTaken')) throw cause;
      because = cause.message;
      continue;
    }
    const { coin } = claimed;
    if (coin.nonce.toLowerCase() !== derived.nonce.toLowerCase() || coin.token.toLowerCase() !== derived.token.toLowerCase()
      || coin.value !== derived.value) {
      throw new Error(
        'nothing was deposited and no money moved: the deposit journal filed a different coin from the one '
        + 'chosen for this deposit, which is a fault in the product and not something you did. Reload the page '
        + 'and try once more; if this comes back, stop and report it.');
    }
    await input.accept?.(coin);
    return { coin, slot };
  }
  throw new DepositCoinAlreadyMade(last, because);
};
