import type { SignSegment } from '@midnightntwrk/wallet-sdk-facade';
import type { LeavesTheWallet } from 'midnight-identity/profile/balance';

/*
 * PAYING FOR THE COIN LEGS OF A TRANSACTION A COMPANY'S PAGE BUILT.
 *
 * A company's page builds and proves a call into the company's vault and asks
 * this wallet to put in the coins the call needs. This file is the whole of
 * what the wallet does with that ask, in order:
 *
 *  1. READ the transaction for itself. It must be a proven, unbound
 *     transaction whose every action is a call into the one vault the ask
 *     names. A deploy, a maintenance update, or a call into anything else is
 *     refused before a person is shown anything. It must create exactly one
 *     coin, owned by that vault, spend nothing, and move no public money.
 *  2. WORK OUT WHAT LEAVES THIS WALLET from the transaction's own imbalances:
 *     the one shielded token the coin is made of, and how much of it the
 *     transaction consumes beyond what it supplies. That figure is what the
 *     person approves. Nothing the page says about an amount is read.
 *  3. ON A PRESS, balance the shielded leg only, sign what was
 *     added, and finish the transaction. **DUST is never balanced here**: the
 *     network fee is the company's fee payer's, and this wallet does not need
 *     to hold NIGHT or be registered for DUST to answer.
 *  4. If signing or finishing fails, what the balance booked is let go.
 *
 * What this does NOT decide: whether the vault is really the company's, or
 * whether the company's committee holds its rules. The company's service
 * refuses a deposit into a vault whose authority on chain is not the company's
 * committee; this wallet can only show the vault's address.
 */

/** The ledger objects this file reads, structurally, so a test can hand in the real ones. */
export interface LedgerForBalancing {
  Transaction: {
    deserialize(s: 'signature', p: 'proof', b: 'pre-binding', raw: Uint8Array): unknown;
  };
}

/** A shielded offer, reduced to what the wallet reads: who each new coin belongs to, and whether anything is spent. */
export interface ShieldedOfferLike {
  readonly inputs?: readonly unknown[];
  readonly outputs?: readonly { readonly contractAddress?: string }[];
  readonly transients?: readonly unknown[];
}

/** A public offer, reduced to whether it moves anything. */
export interface PublicOfferLike {
  readonly inputs?: readonly unknown[];
  readonly outputs?: readonly unknown[];
}

export interface UnboundTransactionLike {
  intents?: Map<number, {
    actions?: readonly unknown[];
    guaranteedUnshieldedOffer?: PublicOfferLike;
    fallibleUnshieldedOffer?: PublicOfferLike;
  }>;
  guaranteedOffer?: ShieldedOfferLike;
  fallibleOffer?: Map<number, ShieldedOfferLike>;
  imbalances(segment: number): Map<{ tag: string; raw?: string }, bigint>;
}

export interface FacadeForBalancing {
  balanceUnboundTransaction(
    tx: never,
    secretKeys: { shieldedSecretKeys: unknown; dustSecretKey: unknown },
    options: { ttl: Date; tokenKindsToBalance: ('shielded' | 'unshielded' | 'dust')[] },
  ): Promise<unknown>;
  signRecipe(recipe: never, signSegment: SignSegment): Promise<unknown>;
  finalizeRecipe(recipe: never): Promise<{ serialize(): Uint8Array }>;
  revert(recipe: never): Promise<void>;
}

export interface BalanceDoors {
  readonly ledger: () => Promise<LedgerForBalancing>;
  /** Started and synchronised. The wait for this is the person's to see. */
  readonly facade: () => Promise<FacadeForBalancing>;
  readonly keys: () => { shieldedSecretKeys: unknown; dustSecretKey: unknown };
  readonly signSegment: () => SignSegment;
  readonly now?: () => number;
}

/** The only token kinds this wallet ever balances for a page. */
export const PAGE_TOKEN_KINDS = ['shielded'] as const;

/** How long the finished transaction stays valid: long enough for the company's service to pay for it. */
export const PAGE_TTL_MS = 20 * 60_000;

export class BalanceRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BalanceRefused';
  }
}

export const bytesFromBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

export const base64FromBytes = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const sameAddress = (a: unknown, b: string): boolean =>
  typeof a === 'string' && a.toLowerCase().replace(/^0x/u, '') === b.toLowerCase();

/**
 * STEP 1 AND STEP 2. Reads the transaction and says what leaves this wallet, or
 * refuses by throwing `BalanceRefused` with the reason a person can read.
 */
export function readWhatThePageAsks(
  ledger: LedgerForBalancing, transaction: string, vault: string,
): { tx: UnboundTransactionLike; leaves: LeavesTheWallet[] } {
  let tx: UnboundTransactionLike;
  try {
    tx = ledger.Transaction.deserialize('signature', 'proof', 'pre-binding', bytesFromBase64(transaction)) as UnboundTransactionLike;
  } catch {
    throw new BalanceRefused(
      'what the page sent is not a proven transaction this wallet can read, so there is nothing '
      + 'to pay for. Nothing has been paid.');
  }
  if (!(tx.intents instanceof Map) || tx.intents.size === 0) {
    throw new BalanceRefused(
      'what the page sent calls nothing, so there is nothing for this wallet to pay into. '
      + 'Nothing has been paid.');
  }
  let calls = 0;
  for (const intent of tx.intents.values()) {
    for (const action of intent.actions ?? []) {
      const call = action as { address?: unknown; entryPoint?: unknown };
      if (call.entryPoint === undefined || call.address === undefined) {
        throw new BalanceRefused(
          'what the page sent does something other than call a contract - it deploys one or '
          + 'changes one\'s rules - and this wallet only pays into a call. Nothing has been paid.');
      }
      if (!sameAddress(call.address, vault)) {
        throw new BalanceRefused(
          'what the page sent calls a contract other than the vault it names, so what you would '
          + 'be approving is not what the page says. Nothing has been paid.');
      }
      calls += 1;
    }
  }
  if (calls === 0) {
    throw new BalanceRefused('what the page sent calls nothing. Nothing has been paid.');
  }
  /*
   * **WHERE THE MONEY GOES IS READ FROM THE COINS THE TRANSACTION CREATES, NOT
   * FROM WHAT IT CALLS.** Everything this wallet adds pays for every coin the
   * page put in, so a coin the page made for itself beside the deposit would be
   * paid for from here while the screen named only the vault. A deposit creates
   * exactly one coin, owned by the vault, spends nothing of the page's, and
   * moves no public money.
   */
  for (const intent of tx.intents.values()) {
    for (const offer of [intent.guaranteedUnshieldedOffer, intent.fallibleUnshieldedOffer]) {
      if (offer && ((offer.inputs?.length ?? 0) > 0 || (offer.outputs?.length ?? 0) > 0)) {
        throw new BalanceRefused(
          'what the page sent moves public money, and a deposit into a vault moves none. '
          + 'Nothing has been paid.');
      }
    }
  }
  const offers = [tx.guaranteedOffer, ...(tx.fallibleOffer?.values() ?? [])]
    .filter((o): o is ShieldedOfferLike => o !== undefined && o !== null);
  let coins = 0;
  for (const offer of offers) {
    if ((offer.inputs?.length ?? 0) > 0 || (offer.transients?.length ?? 0) > 0) {
      throw new BalanceRefused(
        'what the page sent already spends coins of its own, and a deposit the page builds spends '
        + 'none. Nothing has been paid.');
    }
    for (const output of offer.outputs ?? []) {
      if (!sameAddress(output?.contractAddress, vault)) {
        throw new BalanceRefused(
          'what the page sent creates a coin for someone other than the vault it names, and this '
          + 'wallet would be paying for it. Nothing has been paid.');
      }
      coins += 1;
    }
  }
  if (coins !== 1) {
    throw new BalanceRefused(
      `what the page sent creates ${coins} coins in the vault, and a deposit creates exactly one. `
      + 'Nothing has been paid.');
  }
  const owed = new Map<string, LeavesTheWallet>();
  for (const segment of [0, ...tx.intents.keys()]) {
    for (const [token, imbalance] of tx.imbalances(segment)) {
      if (imbalance >= 0n) continue;
      if (token.tag === 'dust') continue;
      if (token.tag !== 'shielded') {
        throw new BalanceRefused(
          'what the page sent needs public money from this wallet, and a deposit into a vault needs '
          + 'none. Nothing has been paid.');
      }
      const key = `${token.tag}:${String(token.raw)}`;
      const before = owed.get(key);
      const amount = (before === undefined ? 0n : BigInt(before.amount)) - imbalance;
      owed.set(key, { token: String(token.raw), amount: amount.toString(), kind: token.tag });
    }
  }
  const leaves = [...owed.values()];
  if (leaves.length === 0) {
    throw new BalanceRefused(
      'what the page sent needs nothing from this wallet, so there is nothing to approve. '
      + 'Nothing has been paid.');
  }
  if (leaves.length !== 1) {
    throw new BalanceRefused(
      'what the page sent needs more than one kind of token, and a deposit of one coin needs one. '
      + 'Nothing has been paid.');
  }
  return { tx, leaves };
}

/**
 * STEP 3 AND STEP 4. Called on the person's press, with what step 1 read.
 * Answers the finished transaction, as base64.
 */
export async function payForThePage(
  doors: BalanceDoors, tx: UnboundTransactionLike,
): Promise<string> {
  const facade = await doors.facade();
  const now = doors.now ?? Date.now;
  const recipe = await facade.balanceUnboundTransaction(tx as never, doors.keys(), {
    ttl: new Date(now() + PAGE_TTL_MS),
    tokenKindsToBalance: [...PAGE_TOKEN_KINDS],
  });
  /* From this line coins are booked, and every way out below lets them go. */
  try {
    const signed = await facade.signRecipe(recipe as never, doors.signSegment());
    const finished = await facade.finalizeRecipe(signed as never);
    return base64FromBytes(finished.serialize());
  } catch (e) {
    try { await facade.revert(recipe as never); } catch { /* the original failure is the one to report */ }
    throw e;
  }
}
