/**
 * **THE NONCE OF EVERY COIN THE VAULT MAKES, WORKED OUT ON A DEVICE THAT HOLDS
 * THE VAULT'S NONCE SECRET.**
 *
 * The vault never takes a nonce from its caller. Each coin a payment or a split
 * makes takes `freshNonceOf(tag, secret, spent)`: a tag for the kind of coin, the
 * vault's nonce secret current when the call was made, and the nullifier of the
 * note the call spent. So naming such a coin again, after a lost device or a
 * stop between a payment and the pool write, needs three things: the spent
 * note, the amount, and the secret.
 *
 *   payee coin   freshNonceOf(payeeNonceTag,  secret, spent)   the amount paid
 *   change       freshNonceOf(changeNonceTag, secret, spent)   what the note held less the amount
 *   split piece  freshNonceOf(splitNonceTag,  secret, spent)   the amount the split journal records
 *   remainder    freshNonceOf(restNonceTag,   secret, spent)   what the note held less the piece
 *
 * **EVERY DERIVATION HERE IS THE VAULT CONTRACT'S OWN PURE CIRCUIT**, handed in
 * by the caller, never a second copy of it: a coin derived a shade differently
 * from the one the vault made is a coin nobody can spend.
 *
 * **A ROTATED VAULT HAS HELD SEVERAL SECRETS.** The company's nonce-secret
 * record keeps every one, oldest first, and a coin is named under each of them
 * in turn: a candidate made under the wrong secret has a commitment the chain
 * does not hold, so the chain chooses and nothing is guessed. What is checked
 * first is that the secrets given are this vault's at all: one of them must be
 * the secret whose commitment the vault holds now. A record that holds none of
 * them is refused by name, because naming coins from it would report the
 * vault's newest money as money nobody can explain.
 */
import { toHex, fromHex, type Hex } from '../core/crypto.js';
import type { VaultCoin } from './vault-coins.js';

/** A coin as the vault contract's pure circuits take it. */
interface RawCoin { nonce: Uint8Array; color: Uint8Array; value: bigint }

/** The vault contract's own pure circuits a device names new coins with. */
export interface VaultNonceCircuits {
  noteNullifierOf(vault: Uint8Array, coin: RawCoin): Uint8Array;
  freshNonceOf(tag: Uint8Array, secret: Uint8Array, spent: Uint8Array): Uint8Array;
  payeeNonceTag(): Uint8Array;
  changeNonceTag(): Uint8Array;
  splitNonceTag(): Uint8Array;
  restNonceTag(): Uint8Array;
  secretCommitmentOf(vault: Uint8Array, secret: Uint8Array): Uint8Array;
  splitMaskOf(secret: Uint8Array, spent: Uint8Array): Uint8Array;
  unmaskedAmountOf(masked: Uint8Array, mask: Uint8Array): bigint;
}

/**
 * **THE VAULT'S NONCE SECRETS, AS A DEVICE SUPPLIES THEM**: every secret the
 * company's nonce-secret record holds (`OpenedNonceSecrets.secrets`), oldest
 * first, and the commitment the vault holds on chain now (`nonceCommitment`).
 */
export interface VaultNonceSecrets {
  readonly secrets: readonly Hex[];
  readonly commitment: Hex;
}

/** The kinds of coin a vault makes from a note it spends. */
export type MadeCoin = 'payee' | 'change' | 'split' | 'rest';

const HEX32 = /^[0-9a-f]{64}$/u;
const MOST_A_COIN_HOLDS = (1n << 128n) - 1n;

/**
 * **REFUSED: NONE OF THE SECRETS GIVEN IS THE ONE THE VAULT HOLDS NOW.** Nothing
 * is named. The record opened is older than the vault's current secret, or it
 * is another vault's.
 */
export class NonceSecretNotTheVaults extends Error {
  constructor(readonly vault: Hex, readonly tried: number) {
    super(
      `none of the ${tried} nonce secret(s) given is the one vault ${vault} holds now, so no coin a `
      + 'payment or a split made is named from them and nothing is derived. The record they came from '
      + 'is older than the vault\'s current secret, or it belongs to another vault. Open the newest '
      + 'version of the company\'s nonce-secret record for this vault and run this again; the money '
      + 'is on chain and stays where it is.');
    this.name = 'NonceSecretNotTheVaults';
  }
}

/**
 * **REFUSED: A COIN THE VAULT MADE WAS ASKED FOR WITHOUT WHAT NAMES IT.** The
 * vault's nonce secret, or the circuits that use it, were not given.
 */
export class NonceSecretNeeded extends Error {
  constructor(what: string) {
    super(
      `${what} Every coin a payment or a split makes takes its nonce from the vault's nonce secret and `
      + 'the spent note, so nothing is derived without it. Open the company\'s nonce-secret record '
      + 'for this vault and give its secrets, with the vault\'s commitment as the chain holds it.');
    this.name = 'NonceSecretNeeded';
  }
}

/** The circuits, checked to be all there, so a missing one is a refusal and never a wrong nonce. */
export const nonceCircuitsFrom = (c: Partial<VaultNonceCircuits> | undefined): VaultNonceCircuits => {
  const needed: (keyof VaultNonceCircuits)[] = [
    'noteNullifierOf', 'freshNonceOf', 'payeeNonceTag', 'changeNonceTag', 'splitNonceTag', 'restNonceTag',
    'secretCommitmentOf', 'splitMaskOf', 'unmaskedAmountOf',
  ];
  const missing = needed.filter((k) => typeof c?.[k] !== 'function');
  if (missing.length > 0) {
    throw new NonceSecretNeeded(
      `the vault contract's circuits were given without ${missing.join(', ')}, so no new coin can be named.`);
  }
  return c as VaultNonceCircuits;
};

/**
 * **THE SECRETS TO NAME COINS WITH, ONCE ONE OF THEM IS SHOWN TO BE THE VAULT'S
 * CURRENT SECRET.** Oldest first, as given. Throws `NonceSecretNotTheVaults`
 * when none is.
 */
export const secretsOfTheVault = (circuits: VaultNonceCircuits, vault: Hex, given: VaultNonceSecrets): readonly Hex[] => {
  if (!HEX32.test(vault)) throw new Error('a vault is named by 64 lower-case hex characters, and this is not one. Nothing is derived.');
  const commitment = String(given?.commitment ?? '').toLowerCase().replace(/^0x/u, '');
  if (!HEX32.test(commitment)) {
    throw new NonceSecretNeeded('the vault\'s nonce commitment was not given as the chain holds it (64 hex characters).');
  }
  if (/^0{64}$/u.test(commitment)) {
    throw new NonceSecretNotTheVaults(vault, given.secrets.length);
  }
  if (!Array.isArray(given.secrets) || given.secrets.length === 0) {
    throw new NonceSecretNeeded('no nonce secret was given.');
  }
  for (const s of given.secrets) {
    if (typeof s !== 'string' || !HEX32.test(s)) {
      throw new NonceSecretNeeded('a nonce secret was given that is not 64 lower-case hex characters.');
    }
  }
  const vaultBytes = fromHex(vault);
  const current = given.secrets.some((s) => toHex(circuits.secretCommitmentOf(vaultBytes, fromHex(s))) === commitment);
  if (!current) throw new NonceSecretNotTheVaults(vault, given.secrets.length);
  return [...given.secrets];
};

/** The nullifier the ledger records when the vault spends this note: what every coin made from it is keyed by. */
export const spentNullifierOf = (circuits: VaultNonceCircuits, vault: Hex, spent: VaultCoin): Hex =>
  toHex(circuits.noteNullifierOf(fromHex(vault), {
    nonce: fromHex(spent.nonce), color: fromHex(spent.token), value: spent.value,
  }));

/** The nonce of one kind of coin the vault made from the note with this nullifier, under one secret. */
export const madeCoinNonce = (circuits: VaultNonceCircuits, kind: MadeCoin, secret: Hex, spent: Hex): Hex => {
  const tag = kind === 'payee' ? circuits.payeeNonceTag()
    : kind === 'change' ? circuits.changeNonceTag()
      : kind === 'split' ? circuits.splitNonceTag() : circuits.restNonceTag();
  return toHex(circuits.freshNonceOf(tag, fromHex(secret), fromHex(spent)));
};

/**
 * **THE PIECE A SPLIT CUT, READ FROM THE VAULT'S SPLIT JOURNAL WITH ONE SECRET**,
 * or nothing when that secret does not open the entry to an amount the split
 * could have cut from a note of `holding`: more than nothing and less than the
 * note. A wrong secret lifts the mask to a number far outside that range.
 */
export const splitPieceAmountOf = (
  circuits: VaultNonceCircuits, secret: Hex, spent: Hex, masked: Hex, holding: bigint,
): bigint | undefined => {
  const mask = circuits.splitMaskOf(fromHex(secret), fromHex(spent));
  const amount = circuits.unmaskedAmountOf(fromHex(masked), mask);
  if (amount <= 0n || amount > MOST_A_COIN_HOLDS || amount >= holding) return undefined;
  return amount;
};
