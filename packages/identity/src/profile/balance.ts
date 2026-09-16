import type { BalanceRequest } from './request.js';
import { usableOrigin } from './origin.js';

/**
 * WHAT A WALLET HANDS BACK WHEN A PERSON AGREES TO PAY FOR A TRANSACTION.
 *
 * `transaction` is the finished transaction: the page's call, the coins this
 * wallet added for it, and this wallet's signatures over what it added. It is
 * not yet paid for on the network; the company's fee payer adds that and sends
 * it.
 *
 * `leaves` is what the wallet worked out leaves it, per token, from the
 * transaction itself - the figure the person approved. The page reads it to say
 * what happened; it is never an input to anything the wallet did.
 */
export const BALANCED_SCHEMA = 'midnight-identity/balanced/v1';

export interface LeavesTheWallet {
  /** The token's own identifier as the ledger writes it. */
  readonly token: string;
  /** Whole base units, as decimal digits. */
  readonly amount: string;
  readonly kind: 'shielded' | 'unshielded';
}

export interface BalancedAnswer {
  readonly schema: typeof BALANCED_SCHEMA;
  /** OBSERVED. A convenience for the requester, never an authority. */
  readonly origin: string;
  readonly company: string;
  readonly vault: string;
  readonly nonce: string;
  readonly at: number;
  /** Base64 of the finished transaction. */
  readonly transaction: string;
  readonly leaves: readonly LeavesTheWallet[];
}

export class BalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BalanceError';
  }
}

/** The message a person's press produces. The only thing that builds one. */
export function balancedAnswerFor(
  ask: BalanceRequest, transaction: string, leaves: readonly LeavesTheWallet[], at: number,
): BalancedAnswer {
  if (!usableOrigin(ask.requester.origin)) {
    throw new BalanceError('this wallet could not tell who asked, so nothing has been paid.');
  }
  return Object.freeze({
    schema: BALANCED_SCHEMA,
    origin: ask.requester.origin,
    company: ask.company,
    vault: ask.vault,
    nonce: ask.nonce,
    at,
    transaction,
    leaves: Object.freeze(leaves.map((l) => Object.freeze({ ...l }))),
  });
}

export type BalancedRead =
  | { readonly ok: true; readonly transaction: string; readonly leaves: readonly LeavesTheWallet[] }
  | {
    readonly ok: false;
    readonly code: 'not-an-answer' | 'origin-mismatch' | 'nonce-mismatch' | 'other-transaction';
    readonly says: string;
  };

const DIGITS = /^(0|[1-9][0-9]{0,38})$/u;
const TOKEN = /^[0-9a-f]{64}$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/**
 * THE PAGE'S SIDE. Every expectation is the page's own: where it is, the nonce
 * it chose, and the company and vault it asked about.
 */
export function readBalancedAnswer(
  message: unknown,
  expecting: {
    readonly atOrigin: string;
    readonly expectingNonce: string;
    readonly company: string;
    readonly vault: string;
  },
): BalancedRead {
  const body = message as Partial<BalancedAnswer> | null;
  if (typeof body !== 'object' || body === null || body.schema !== BALANCED_SCHEMA) {
    return { ok: false, code: 'not-an-answer', says: 'that is not a paid transaction.' };
  }
  if (body.origin !== expecting.atOrigin) {
    return {
      ok: false, code: 'origin-mismatch',
      says: `this was paid for ${String(body.origin)} and arrived at ${expecting.atOrigin}. It is refused.`,
    };
  }
  if (body.nonce !== expecting.expectingNonce) {
    return { ok: false, code: 'nonce-mismatch', says: 'this answers a different request from the one that was sent.' };
  }
  if (String(body.company).toLowerCase() !== expecting.company.toLowerCase()
    || String(body.vault).toLowerCase() !== expecting.vault.toLowerCase()) {
    return {
      ok: false, code: 'other-transaction',
      says: 'this pays into a different company or vault from the one that was asked about. It is refused.',
    };
  }
  if (typeof body.transaction !== 'string' || body.transaction.length === 0
    || body.transaction.length % 4 !== 0 || !BASE64.test(body.transaction)) {
    return { ok: false, code: 'not-an-answer', says: 'the paid transaction in this answer cannot be read.' };
  }
  if (!Array.isArray(body.leaves) || !body.leaves.every((l) => typeof l === 'object' && l !== null
    && TOKEN.test(String((l as LeavesTheWallet).token))
    && DIGITS.test(String((l as LeavesTheWallet).amount))
    && ((l as LeavesTheWallet).kind === 'shielded' || (l as LeavesTheWallet).kind === 'unshielded'))) {
    return { ok: false, code: 'not-an-answer', says: 'this answer does not say what left the wallet.' };
  }
  if (typeof body.at !== 'number' || !Number.isSafeInteger(body.at)) {
    return { ok: false, code: 'not-an-answer', says: 'that is not a paid transaction.' };
  }
  return {
    ok: true,
    transaction: body.transaction,
    leaves: body.leaves.map((l) => ({ token: l.token, amount: l.amount, kind: l.kind })),
  };
}
