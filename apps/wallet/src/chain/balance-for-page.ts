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
 * **A PUBLIC DEPOSIT IS THE ONE OTHER ASK THIS WALLET PAYS.** A call to the
 * vault's public deposit that creates no coin and asks, in its own declared
 * effects, for one public token and one amount: step 1 reads exactly that, step
 * 2 names that token and amount as leaving this wallet's PUBLIC balance, and
 * step 3 balances the public leg only, then checks that what it added spends
 * exactly that amount of that token and pays nothing to anyone but this
 * wallet's own change, before anything is signed. The screen says the deposit
 * is public before the press. Nothing else public is ever paid for a page.
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
  /** This wallet's own public address, as the ledger writes it. Asked only for a public deposit, whose change comes back here. */
  readonly ownPublicAddress?: () => string;
  readonly now?: () => number;
}

/** The only token kinds this wallet ever balances for a page's private deposit. */
export const PAGE_TOKEN_KINDS = ['shielded'] as const;

/** The only token kinds this wallet ever balances for a page's public deposit. */
export const PUBLIC_DEPOSIT_TOKEN_KINDS = ['unshielded'] as const;

/** What the page's transaction asks this wallet to pay: private money for a coin, or public money as it is. */
export type PageAskPays = 'private' | 'public';

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
): { tx: UnboundTransactionLike; leaves: LeavesTheWallet[]; pays: PageAskPays } {
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
  /* A call to the vault's public deposit that creates no coin is read as a public deposit, and only that. */
  if (offers.length === 0 && everyCallIsThePublicDeposit(tx)) return { tx, ...readThePublicDeposit(tx), pays: 'public' };
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
  return { tx, leaves, pays: 'private' };
}

const carriesDustActions = (tx: UnboundTransactionLike): boolean => {
  for (const intent of tx.intents?.values() ?? []) {
    const d = (intent as { dustActions?: { spends?: readonly unknown[]; registrations?: readonly unknown[] } | null }).dustActions;
    if (d !== undefined && d !== null && ((d.spends?.length ?? 0) > 0 || (d.registrations?.length ?? 0) > 0
      || !Array.isArray(d.spends) || !Array.isArray(d.registrations))) return true;
  }
  return false;
};

const entryPointName = (e: unknown): string => (e instanceof Uint8Array ? new TextDecoder().decode(e) : String(e));

const everyCallIsThePublicDeposit = (tx: UnboundTransactionLike): boolean => {
  let calls = 0;
  for (const intent of tx.intents?.values() ?? []) {
    for (const action of intent.actions ?? []) {
      if (entryPointName((action as { entryPoint?: unknown }).entryPoint) !== 'depositUnshielded') return false;
      calls += 1;
    }
  }
  return calls > 0;
};

/**
 * A PUBLIC DEPOSIT, READ FOR ITSELF. One call, asking in its own declared
 * effects for one public token and one amount and for nothing else, and owing
 * exactly that amount of that token and nothing private.
 */
function readThePublicDeposit(tx: UnboundTransactionLike): { leaves: LeavesTheWallet[] } {
  /*
   * **NOTHING ABOUT FEES OR DUST MAY RIDE ALONG.** This wallet signs every part
   * of the transaction its public coins are in, and that signature also
   * authorises any DUST spend or registration the page put there. A deposit
   * carries none: the company's fee payer adds the fee after this wallet is done.
   */
  if (carriesDustActions(tx)) {
    throw new BalanceRefused(
      'what the page sent also spends or registers DUST, and a deposit into a vault does neither: the company '
      + 'pays the network fee after this wallet is done. Nothing has been paid.');
  }
  const actions = [...(tx.intents?.values() ?? [])].flatMap((i) => [...(i.actions ?? [])]);
  if (actions.length !== 1) {
    throw new BalanceRefused(
      'what the page sent calls the vault\'s public deposit more than once, and a deposit is one call. '
      + 'Nothing has been paid.');
  }
  const call = actions[0] as { guaranteedTranscript?: { effects?: unknown } | null; fallibleTranscript?: { effects?: unknown } | null };
  const unreadable = new BalanceRefused(
    'this wallet could not read what the page\'s public deposit asks for, so it will not pay for it. '
    + 'Nothing has been paid.');
  const asks = new Map<string, bigint>();
  let transcripts = 0;
  for (const transcript of [call.guaranteedTranscript, call.fallibleTranscript]) {
    if (transcript === undefined || transcript === null) continue;
    transcripts += 1;
    const e = transcript.effects as Record<string, unknown> | undefined | null;
    if (e === undefined || e === null) throw unreadable;
    for (const k of ['claimedNullifiers', 'claimedShieldedReceives', 'claimedShieldedSpends', 'claimedContractCalls']) {
      if (!Array.isArray(e[k])) throw unreadable;
      if ((e[k] as unknown[]).length !== 0) {
        throw new BalanceRefused(
          'what the page sent asks for more than public money going into the vault. Nothing has been paid.');
      }
    }
    for (const k of ['shieldedMints', 'unshieldedMints', 'unshieldedOutputs', 'claimedUnshieldedSpends', 'unshieldedInputs']) {
      if (!(e[k] instanceof Map)) throw unreadable;
      if (k !== 'unshieldedInputs' && (e[k] as Map<unknown, unknown>).size !== 0) {
        throw new BalanceRefused(
          'what the page sent asks for more than public money going into the vault. Nothing has been paid.');
      }
    }
    for (const [type, value] of e.unshieldedInputs as Map<{ tag?: unknown; raw?: unknown } | null, unknown>) {
      if (type?.tag !== 'unshielded' || typeof value !== 'bigint') throw unreadable;
      const k = String(type.raw).toLowerCase();
      asks.set(k, (asks.get(k) ?? 0n) + value);
    }
  }
  if (transcripts === 0) throw unreadable;
  if (asks.size !== 1) {
    throw new BalanceRefused(
      'what the page sent asks for more than one public token, and a public deposit is one. Nothing has been paid.');
  }
  const [token, amount] = [...asks.entries()][0]!;
  if (!(amount > 0n)) {
    throw new BalanceRefused('what the page sent asks for nothing, so there is nothing to approve. Nothing has been paid.');
  }
  /* What the transaction owes must be exactly what the vault asks for: this token, this amount, nothing private. */
  const owed = new Map<string, bigint>();
  for (const segment of [0, ...(tx.intents?.keys() ?? [])]) {
    for (const [t, imbalance] of tx.imbalances(segment)) {
      if (imbalance >= 0n || t.tag === 'dust') continue;
      if (t.tag !== 'unshielded') {
        throw new BalanceRefused(
          'what the page sent needs private money from this wallet as well, and a public deposit needs none. '
          + 'Nothing has been paid.');
      }
      const k = String(t.raw).toLowerCase();
      owed.set(k, (owed.get(k) ?? 0n) - imbalance);
    }
  }
  if (owed.size !== 1 || owed.get(token) !== amount) {
    throw new BalanceRefused(
      'what the page sent owes something other than what it puts into the vault, and this wallet pays only '
      + 'for what the vault receives. Nothing has been paid.');
  }
  return { leaves: [{ token, amount: amount.toString(), kind: 'unshielded' }] };
}

/**
 * **WHAT A PUBLIC DEPOSIT'S BALANCING ADDED, CHECKED BEFORE ANYTHING IS SIGNED.**
 * The public coins added must spend exactly the approved amount of the approved
 * token, net of change, and every public coin made must come back to this
 * wallet's own address; nothing else may have been added.
 */
export function whyThePublicBalancingIsNotWhatWasApproved(
  recipe: unknown, approved: LeavesTheWallet, own: string,
): string | null {
  const r = recipe as { baseTransaction?: UnboundTransactionLike; balancingTransaction?: unknown } | null;
  if (r === null || typeof r !== 'object' || r.baseTransaction === undefined) {
    return 'this wallet could not read what it was about to add';
  }
  if (r.balancingTransaction !== undefined && r.balancingTransaction !== null) {
    return 'this wallet was about to add more to it than this deposit';
  }
  const base = r.baseTransaction;
  if (carriesDustActions(base) || (base.guaranteedOffer ?? null) !== null
    || (base.fallibleOffer !== undefined && base.fallibleOffer !== null && base.fallibleOffer.size > 0)) {
    return 'this wallet was about to add more to it than this deposit';
  }
  const net = new Map<string, bigint>();
  const bare = (a: unknown) => String(a).toLowerCase().replace(/^0x/u, '');
  for (const intent of r.baseTransaction.intents?.values() ?? []) {
    for (const offer of [intent.guaranteedUnshieldedOffer, intent.fallibleUnshieldedOffer]) {
      if (offer === undefined || offer === null) continue;
      for (const input of (offer.inputs ?? []) as { type?: unknown; value?: unknown }[]) {
        if (typeof input?.value !== 'bigint') return 'this wallet could not read what it was about to add';
        net.set(bare(input.type), (net.get(bare(input.type)) ?? 0n) + input.value);
      }
      for (const output of (offer.outputs ?? []) as { type?: unknown; value?: unknown; owner?: unknown }[]) {
        if (typeof output?.value !== 'bigint') return 'this wallet could not read what it was about to add';
        if (bare(output.owner) !== bare(own)) return 'this wallet was about to pay public money to someone other than itself';
        net.set(bare(output.type), (net.get(bare(output.type)) ?? 0n) - output.value);
      }
    }
  }
  for (const [token, value] of net) {
    if (value === 0n) continue;
    if (token !== bare(approved.token) || value !== BigInt(approved.amount)) {
      return 'this wallet was about to spend a different public amount from the one you approved';
    }
  }
  if (net.get(bare(approved.token)) !== BigInt(approved.amount)) {
    return 'this wallet was about to spend a different public amount from the one you approved';
  }
  return null;
}

/**
 * STEP 3 AND STEP 4. Called on the person's press, with what step 1 read.
 * Answers the finished transaction, as base64.
 */
export async function payForThePage(
  doors: BalanceDoors, tx: UnboundTransactionLike,
  /** What step 1 read, when it read a public deposit. Absent, only private money is paid. */
  approved?: { readonly pays: PageAskPays; readonly leaves: readonly LeavesTheWallet[] },
): Promise<string> {
  const publicly = approved?.pays === 'public';
  let own = '';
  if (publicly) {
    if (approved.leaves.length !== 1 || approved.leaves[0]?.kind !== 'unshielded') {
      throw new BalanceRefused('what you approved is not one public amount, so this wallet pays nothing. Nothing has been paid.');
    }
    if (doors.ownPublicAddress === undefined) {
      throw new BalanceRefused('this wallet could not read its own public address, so it pays nothing publicly. Nothing has been paid.');
    }
    own = doors.ownPublicAddress();
  }
  const facade = await doors.facade();
  const now = doors.now ?? Date.now;
  const recipe = await facade.balanceUnboundTransaction(tx as never, doors.keys(), {
    ttl: new Date(now() + PAGE_TTL_MS),
    tokenKindsToBalance: publicly ? [...PUBLIC_DEPOSIT_TOKEN_KINDS] : [...PAGE_TOKEN_KINDS],
  });
  /* From this line coins are booked, and every way out below lets them go. */
  try {
    if (publicly) {
      const why = whyThePublicBalancingIsNotWhatWasApproved(recipe, approved.leaves[0]!, own);
      if (why !== null) throw new BalanceRefused(`${why}, so it signed nothing. Nothing has been paid.`);
    }
    const signed = await facade.signRecipe(recipe as never, doors.signSegment());
    const finished = await facade.finalizeRecipe(signed as never);
    return base64FromBytes(finished.serialize());
  } catch (e) {
    try { await facade.revert(recipe as never); } catch { /* the original failure is the one to report */ }
    throw e;
  }
}
