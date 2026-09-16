/**
 * A LIVE WALLET, ADAPTED INTO THE TWO PARTIES THE PRODUCT KNOWS ABOUT.
 *
 * The product does not know what a wallet is. It knows a COMPANY - which
 * balances the legs it owns, signs them, and lets go of what it booked - and a
 * FEE PAYER, which balances the fee, submits, lets go of what it booked, and
 * says what it expected to pay and what it paid. Everything a wallet actually
 * is lives on this side of that line.
 *
 * -- WHY IT IS HERE AND NOT UNDER `src/` ------------------------------------
 *
 * Bringing a wallet up is the one procedure in this repository with a written
 * record of what happens when it exists twice: the second copy is missing a
 * line, reports plausible numbers, and fails four runs later somewhere else.
 * There is one bring-up, next door, and this adapter sits beside it rather than
 * inviting a second.
 *
 * -- THE ONE RULE THAT DECIDES WHETHER ANY OF THIS WORKS --------------------
 *
 * **THE TWO PARTIES' TOKEN KINDS MUST NOT OVERLAP.** Re-balancing a kind the
 * other has already balanced is a double spend and the node rejects the whole
 * transaction. Neither set is chosen here: both are constants owned by the
 * layers that use them, and this file passes neither an argument nor a default.
 *
 * -- WHAT IS DELIBERATELY NOT DECIDED HERE ----------------------------------
 *
 * **THE FEE PAYER'S OWN WALLET IS THE ONLY THING IN THE SYSTEM WITH SPEND
 * AUTHORITY**, so what it is allowed to be asked for is decided by the seam it
 * satisfies and not by what a facade happens to offer. Every member below
 * exists because that seam requires it. Nothing extra is exposed, and in
 * particular no method that could move a coin on anybody's instruction but the
 * product's.
 */
import { SponsoredCustomerWallet, type BalancingWallet } from '../src/midnight/wallet.js';
import { WalletFeeSponsor, type SponsorWallet } from '../src/midnight/sponsor.js';
import type { SponsoredFeeSink } from '../src/midnight/sponsored-fees.js';
import type { FeeCeiling } from '../src/midnight/fee-ceiling.js';
import type { FundedParties } from '../src/wiring/write-capability-for-deployment.js';

/**
 * What a bring-up hands over, in the terms this file needs.
 *
 * `provider` is the testkit's wallet provider and `facade` is the wallet inside
 * it. They are two objects because the SDK puts the keys and the public halves
 * on one and the balancing calls on the other, and pretending otherwise is how
 * a shape gets guessed.
 */
export interface LiveWalletParts {
  readonly provider: any;
  readonly facade: any;
  /** Reads the two balances, so the fee payer can report remaining capacity. */
  dust(): bigint;
  night(): bigint;
}

/**
 * What a submitted transaction actually cost, read from the chain.
 *
 * **IT ANSWERS `null` FOR EVERY FAILURE, INCLUDING TAKING TOO LONG.** It runs
 * after the money has moved. The question it asks is answered by an indexer
 * that has to see the transaction in a block first, and the call it uses waits
 * indefinitely by its own contract - it can say *yes, eventually*, and it can
 * never say *no*. So it is bounded here, and a reading that did not arrive is
 * recorded as a reading that did not arrive.
 *
 * **THE NUMBER IS THE CHAIN'S `paidFees` AND NOTHING ELSE.** A difference of
 * wallet balances is not this number: it lags its own spend, dust regenerates
 * from held NIGHT while nothing is happening, and a second sponsored
 * transaction in the window contaminates it.
 */
export function paidFeeFrom(
  publicDataProvider: any,
  waitMs = 60_000,
): (ref: string) => Promise<bigint | null> {
  return async (ref: string) => {
    try {
      const answered = await Promise.race([
        publicDataProvider.watchForTxData(ref),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs)),
      ]);
      const paid = (answered as any)?.fees?.paidFees;
      if (paid === undefined || paid === null || paid === '') return null;
      return BigInt(paid);
    } catch {
      return null;
    }
  };
}

/**
 * The fee payer's wallet.
 *
 * Every member is bound straight off the facade rather than re-wrapped in a
 * hand-written lambda, because the shapes the SDK publishes are real and three
 * of the bugs in this flow's first run were shapes somebody guessed while `any`
 * kept the compiler quiet.
 */
export function sponsorWalletOver(
  w: LiveWalletParts,
  paidFee: (ref: string) => Promise<bigint | null>,
): SponsorWallet {
  const facade = w.facade;
  return {
    shieldedSecretKeys: w.provider.zswapSecretKeys,
    dustSecretKey: w.provider.dustSecretKey,
    balanceFinalizedTransaction: facade.balanceFinalizedTransaction.bind(facade),
    finalizeRecipe: facade.finalizeRecipe.bind(facade),
    submitTransaction: (tx: unknown) => w.provider.submitTx(tx as never),
    /*
     * What releases coins the fee payer booked and did not spend. Nothing else
     * does: the vendor's time-based sweep is a documented no-op and its own
     * cleanup only acts on transactions the chain answered for.
     */
    revert: async (booking: unknown) => { await facade.revert(booking as never); },
    /*
     * The whole fee, including the leg the fee payer is about to add. The
     * cheaper call beside it in the vendor's interface prices the transaction
     * alone and says so - which for a fee payer is the wrong number rather than
     * a rough one, because the leg it omits is the only leg being paid for.
     */
    estimateFee: (tx: unknown, ttl: Date) =>
      facade.estimateTransactionFee(tx as never, w.provider.dustSecretKey, { ttl }),
    paidFee,
    balances: async () => ({ dust: w.dust(), night: w.night() }),
  };
}

/**
 * The company's wallet.
 *
 * **IT IS HANDED A DUST KEY AND WILL NEVER USE ONE**, and that is worth a
 * sentence rather than a shrug: the secrets bag the balancing call takes has a
 * slot for one, and the kinds this side balances do not include dust, so the
 * slot is filled and the value is never read. The day this class needs a dust
 * key to work, fee sponsorship has failed and the design needs rewriting rather
 * than patching.
 */
export function customerWalletOver(w: LiveWalletParts): SponsoredCustomerWallet {
  const facade = w.facade;
  const wallet: BalancingWallet = {
    balanceUnboundTransaction: facade.balanceUnboundTransaction.bind(facade),
    balanceFinalizedTransaction: facade.balanceFinalizedTransaction.bind(facade),
    signRecipe: facade.signRecipe.bind(facade),
    finalizeRecipe: facade.finalizeRecipe.bind(facade),
    submitTransaction: (tx: unknown) => w.provider.submitTx(tx as never),
    /*
     * **THE COINS THIS RELEASES ARE THE COMPANY'S.** The fee payer's are ours,
     * and a booking of ours that is stranded costs us a little of the fee
     * budget; one of theirs is stranded on a device we do not operate, where
     * the only repair is a resync somebody has to be asked to perform.
     */
    revert: async (booking: unknown) => { await facade.revert(booking as never); },
  };
  return new SponsoredCustomerWallet(
    wallet,
    {
      shieldedSecretKeys: w.provider.zswapSecretKeys,
      dustSecretKey: w.provider.dustSecretKey,
    },
    (payload) => w.provider.unshieldedKeystore.signDataAsync(payload),
    {
      coinPublicKey: w.provider.getCoinPublicKey(),
      encryptionPublicKey: w.provider.getEncryptionPublicKey(),
    },
  );
}

/**
 * The fee payer over a live wallet, with its record and its ceiling.
 *
 * **THE FEE RECORD IS REQUIRED HERE, AND THAT IS WHY THIS FUNCTION EXISTS.**
 * The fee payer takes its record as an optional argument, because a script
 * driving that seam by hand may have nowhere to put one. A process that pays
 * for the product's transactions is not that script: what each sponsored
 * transaction cost, and which company it was for, cannot be read back off a
 * shielded transaction afterwards, so a fee payer built without a record loses
 * it for good. Taking the record as a required parameter makes that a compile
 * error rather than a missing file noticed a month later.
 *
 * **THE CEILING IS REQUIRED TOO**, and the fee payer refuses to be built
 * without one: it is the most one transaction may spend from this wallet.
 *
 * **THE FEE PAYER IS `WalletFeeSponsor` AND NOTHING ELSE**, whose balancing
 * call names dust as the only kind it pays for. A hand-built fee payer here
 * would be one argument away from paying the company's own legs out of ours.
 */
export function feePayerOver(
  payer: LiveWalletParts,
  paidFee: (ref: string) => Promise<bigint | null>,
  feeRecord: SponsoredFeeSink,
  onPay: (info: { fee?: bigint; remaining?: bigint }) => void,
  ceiling: FeeCeiling,
): WalletFeeSponsor {
  if (!feeRecord || typeof feeRecord.record !== 'function') {
    throw new Error(
      'a fee payer was about to be built with nowhere to record what it pays. Which company '
      + 'a sponsored transaction was for cannot be recovered from the transaction afterwards, '
      + 'so nothing was built and nothing was spent.');
  }
  return new WalletFeeSponsor(sponsorWalletOver(payer, paidFee), ceiling, onPay, feeRecord);
}

/**
 * Two live wallets, turned into the pair the product is handed.
 *
 * The fee payer is built by `feePayerOver` above, so the record and the
 * ceiling it requires are required here as well.
 */
export function fundedPartiesOver(
  payer: LiveWalletParts,
  company: LiveWalletParts,
  paidFee: (ref: string) => Promise<bigint | null>,
  feeRecord: SponsoredFeeSink,
  onPay: (info: { fee?: bigint; remaining?: bigint }) => void,
  ceiling: FeeCeiling,
): FundedParties {
  return {
    sponsor: feePayerOver(payer, paidFee, feeRecord, onPay, ceiling),
    customer: customerWalletOver(company),
  };
}
