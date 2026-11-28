import type { FinalizedTransactionRecipe, FinalizedTx, SignSegment, WalletFacade } from '@midnightntwrk/wallet-sdk';
import { bytesFromBase64 } from './balance-for-page.js';
import { carriedBy } from './carried.js';
import {
  addedMoreThanTheFeeRefusal,
  FEE_TTL_MS,
  FeeRefused,
  paidFromOwnDust,
  type AdoptedAs,
  type OwnFeeUnpaid
} from './sent-straight-to-the-chain.js';

export type { OwnFeeUnpaid };

/*
 * **A FINISHED TRANSACTION WHOSE NETWORK FEE THIS WALLET PAYS FROM ITS OWN DUST, AFTER THE PERSON CONFIRMED THE FEE.**
 * The transaction is one this wallet balanced, signed and proved itself, which the company's service said it could
 * not pay the fee for. The fee is estimated and shown first; nothing is booked before the person confirms it. What is
 * then added may spend DUST and nothing else, no more than the fee shown, and lives no longer than the transaction it
 * pays for.
 */

/** The parts of the wallet's facade the payment of a finished transaction's fee uses. */
export type OwnFeeFacade = Pick<
  WalletFacade,
  | 'dust'
  | 'state'
  | 'adoptTransaction'
  | 'estimateTransactionFee'
  | 'balanceFinalizedTransaction'
  | 'signRecipe'
  | 'finalizeRecipe'
  | 'submitTransaction'
>;

export interface OwnFeeDoors {
  /** The paying account's facade with its DUST part started. */
  readonly facade: () => Promise<OwnFeeFacade>;
  readonly signSegment: () => SignSegment;
}

export interface OwnFeeWay {
  readonly now: () => number;
  readonly stillWanted: () => boolean;
  /** Shows the person the fee, in SPECKs, and resolves true only when they confirm it. */
  readonly confirm: (fee: bigint) => Promise<boolean>;
  /** Called once, just before the transaction is handed to the network: from then on it may have been sent. */
  readonly handedOver: () => void;
}

/** This wallet paid no fee and sent nothing, and why. */
export class OwnFeeNotPaid extends FeeRefused {
  constructor(
    readonly why: OwnFeeUnpaid,
    message: string
  ) {
    super(message);
    this.name = 'OwnFeeNotPaid';
  }
}

const notPaid = (what: string): OwnFeeNotPaid =>
  new OwnFeeNotPaid('not-paid', `${what}, so it paid nothing and sent nothing`);

/** The earliest deadline among a transaction's parts, or null when it names none this wallet can read. */
export function deadlineOf(tx: unknown): number | null {
  const intents = (carriedBy(tx) as { readonly intents?: unknown } | null)?.intents;
  if (!(intents instanceof Map)) return null;
  let earliest: number | null = null;
  for (const intent of intents.values()) {
    const ttl = (intent as { readonly ttl?: unknown } | null)?.ttl;
    if (!(ttl instanceof Date)) return null;
    earliest = earliest === null ? ttl.getTime() : Math.min(earliest, ttl.getTime());
  }
  return earliest;
}

const A_DEPOSIT: AdoptedAs = { part: 'originalTransaction', itself: 'the deposit itself' };

/**
 * **WHY WHAT THIS WALLET WAS ABOUT TO ADD IS NOT ONLY THE FEE SHOWN, OR NULL WHEN IT IS**: the transaction is left as
 * it was, and what is added spends DUST, does nothing else, and spends no more than the person confirmed.
 */
export function moreThanTheShownFeeRefusal(recipe: unknown, original: unknown, shown: bigint): string | null {
  return addedMoreThanTheFeeRefusal(recipe, original, A_DEPOSIT, shown);
}

/**
 * Pays the network fee of `finished` from this wallet's own DUST once the person confirms it, and hands it to the
 * network; resolves with the network's name for the submission. Throws `FeeRefused` (an `OwnFeeNotPaid` where the
 * reason is one of the three) when it paid nothing and sent nothing; any error after `handedOver` means the
 * transaction may have been sent.
 *
 * A refusal after the fee was added gives nothing back: giving back this recipe would free the deposit's private coins
 * too, and the deposit may still be on its way through the service. Its DUST stays booked until its deadline, no later
 * than the deposit's own.
 */
export async function finishedSentWithOwnDust(o: OwnFeeDoors, finished: string, way: OwnFeeWay): Promise<string> {
  return paidFromOwnDust<OwnFeeFacade, FinalizedTx, FinalizedTransactionRecipe, string>({
    facade: () => o.facade(),
    signSegment: () => o.signSegment(),
    stillWanted: () => way.stillWanted(),
    handed: { over: false },
    handedOver: () => way.handedOver(),
    refused: (why, message) => new OwnFeeNotPaid(why, message),
    adopt: (facade) => facade.adoptTransaction(bytesFromBase64(finished), 'Finalized'),
    unadopted: 'this wallet could not read the transaction it finished',
    adoptedAs: A_DEPOSIT,
    ttl: (original) => {
      const lives = deadlineOf(original);
      if (lives === null) throw notPaid('this wallet could not read until when the transaction can be sent');
      if (lives <= way.now()) throw notPaid('the transaction can no longer be sent: its time to live has passed');
      return new Date(Math.min(way.now() + FEE_TTL_MS, lives));
    },
    balance: (facade, original, options) => facade.balanceFinalizedTransaction(original, options),
    confirm: {
      estimate: (facade, original, ttl) => facade.estimateTransactionFee(original, { ttl }),
      asked: (fee) => way.confirm(fee)
    },
    names: { signed: 'the fee', sent: 'transaction' },
    sender: (facade, done) => async () => String(await facade.submitTransaction(done))
  });
}
