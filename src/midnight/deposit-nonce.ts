/**
 * **A DEPOSIT'S NONCE, DERIVED FROM A SECRET THE COMPANY ALREADY KEEPS, AND THE
 * CHECK THAT THE COIN IT NAMES HAS NEVER BEEN MADE BEFORE.**
 *
 * A deposit creates a coin addressed to the vault, and the chain keeps only
 * commitments to it, which cannot be inverted. A nonce drawn at random is
 * therefore named by one thing in the world: whatever record wrote it down.
 * Lose that record and the note is unnameable for good.
 *
 * A nonce derived from a company secret, the vault, the coin and the attempt's
 * place in the deposit journal can be found again by anybody holding that
 * secret and the company's own record of what it deposited: each candidate is
 * one commitment computed and one set lookup. That is what lets a vault's notes
 * be rebuilt with nothing of ours (`rebuild-from-records.ts`).
 *
 * ------------------------------------------------------------------------
 * **WHICH SECRET.** The root is thirty-two bytes the company's own wallet
 * already derives for this company: the released company key, a pure function
 * of the person's recovery words and the company's address, stored nowhere and
 * recomputable on any device after any recovery. It is secret, and it has to
 * be: a nonce anybody could compute would let anybody put a guessed salary to
 * the chain and be told whether it is right. **It tells nothing new to whoever
 * can derive it**: that takes the person's recovery words, which already hold
 * their wallet and derive their own payslip keys in this company. Nothing here
 * stores it, sends it anywhere, or writes it down. The operator tools use their
 * wallet seed file as the root instead, expanded under a domain of its own;
 * replacing that file changes every nonce they derive afterwards, and the
 * deposits made before are then named only with the old file or the journal.
 *
 * What it costs, stated where the choice is made:
 *   · the key is the DEPOSITOR's. Without the journal, a deposit is named only
 *     with the words of the person who made it - and so is every change note
 *     that descends from it, which is every note that money ever becomes. A
 *     person who leaves, or loses their words, takes that with them for good;
 *   · it does not rotate. A person who moves to new recovery words derives new
 *     deposits from a new key; the deposits made before are found only with the
 *     old words or the journal;
 *   · a person with no released company key has no root and must not deposit
 *     privately at all. A random nonce in its place is exactly the note that only
 *     a stored record can ever name.
 *
 * ------------------------------------------------------------------------
 * **WHY THE COIN IS PART OF THE NONCE, AND WHY THE CHECK READS THE VAULT'S
 * WHOLE HISTORY.**
 *
 * The version a deposit files is not unique for all time: a restored store, a
 * second store or a replica can hand out the same number again. If the nonce
 * named only the version, a repeated version with a different amount would make
 * two different coins under one nonce: the ledger takes both, and this product's
 * pool, which keeps one note per nonce, cannot hold them and its rebuild refuses
 * them. **With the token and the value in it, a repeated nonce can only ever be
 * a repeated coin.**
 *
 * A repeated coin cannot land: the ledger refuses to create an output whose
 * commitment it has already recorded, spent or not. But it refuses after the
 * transaction has been proved and submitted, and a restored journal names the
 * same coin again whenever a version it hands out again is used for the token
 * and amount the earlier line at that version had. So the check below
 * reads every coin the chain has ever created for this vault - the note set it
 * holds now does not contain a spent one - and a deposit whose coin already
 * exists moves on to the next version before anything is proved.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex, toHex, utf8, type Hex } from '../core/crypto.js';
import type { NoteEvents, VaultTransactions } from './note-index.js';

const KEY_BYTES = 32;
const HEX32 = /^[0-9a-fA-F]{64}$/u;
const MAX_VALUE = (1n << 128n) - 1n;
const MAX_VERSION = Number.MAX_SAFE_INTEGER;

/*
 * The domain of this derivation. The day it changes, every deposit made under
 * the old one is found only by its journal, so a change is a migration and
 * never a patch.
 */
const NONCE_KEY_SALT = utf8('confidential-accounts/deposit-nonce/v1');
const NONCE_TAG = utf8('deposit');

declare const nonceKeyBrand: unique symbol;

/**
 * Thirty-two bytes that name one vault's deposits. Its own type, so it cannot
 * be passed where a wrapping secret, a signing secret or a company key is
 * expected; all four are the same length.
 */
export type DepositNonceKey = Uint8Array & { readonly [nonceKeyBrand]: true };

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
 * `root` is the released company key: the depositor's own, for this company.
 * The vault's address goes in as its one lower-case spelling, so two spellings
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
 * **THE NONCE OF THE DEPOSIT FILED AT `version` OF THE DEPOSIT JOURNAL.**
 *
 * The version is the one the journal actually filed the line under, never the
 * one a writer expected to get: two writers who read the same journal file two
 * different versions, so they derive two different nonces.
 */
export const depositNonceAt = (key: DepositNonceKey, money: DepositMoney, version: number): Hex => {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new Error('a deposit nonce needs the vault\x27s deposit nonce key, and this is not one.');
  }
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
    throw new Error(`a deposit is filed at a whole version from 1, and ${String(version)} is not one.`);
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
  message.set(be(BigInt(version), 8), at);
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
 * **THE REFUSAL WHEN EVERY VERSION TRIED NAMED A COIN THAT ALREADY EXISTS.**
 *
 * Only a deposit journal that has handed out the same versions again can get
 * here, which is a store restored to an earlier point, or two stores for one
 * vault. Every line filed on the way is a harmless attempt that never landed.
 */
export class DepositCoinAlreadyMade extends Error {
  constructor(readonly attempts: number, readonly because: string) {
    super(
      `nothing was deposited: each of the last ${attempts} deposit journal versions named a coin that `
      + `already exists (${because}). The deposit journal is handing out versions it has handed out `
      + 'before, which happens when its store has been restored to an earlier point or a second store '
      + 'is being written for this vault. Nothing was proved and no money moved. Find which store is '
      + 'the current one for this vault and deposit through that one.');
    this.name = 'DepositCoinAlreadyMade';
  }
}
