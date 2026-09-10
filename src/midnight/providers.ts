/**
 * The six providers midnight-js needs, assembled the way the SDK expects.
 *
 * This file exists because the previous attempt did not. M-16 tried to build a
 * standalone deploy with sampled keys, purely to time a proof, and failed in
 * six different layers of the SDK before I accepted what it was telling me:
 * this SDK is built to run against a node with a real wallet, and using it any
 * other way is fighting it. Everything here uses it as designed.
 *
 * Five of the six are plumbing. The interesting one is `walletProvider`, which
 * is where decision 0001 stops being a document and becomes code: the customer
 * balances the shielded and unshielded legs of a transaction, and a sponsor we
 * operate balances the dust leg and pays the fee.
 */
import type {
  MidnightProviders,
  WalletProvider,
  MidnightProvider,
} from '@midnight-ntwrk/midnight-js-types';
import type { MidnightConfig, FeeSponsor } from './ledger.js';
import { applyNetworkId } from './network.js';

/**
 * The customer's wallet.
 *
 * Deliberately an interface rather than a concrete wallet. In the hosted
 * product this is a browser wallet the customer controls; in tests it is a
 * seeded wallet; in a CI run it is the wallet CLI. None of those belong in
 * this file.
 */
export interface CustomerWallet {
  coinPublicKey(): string;
  encryptionPublicKey(): string;
  /**
   * Balances the shielded and unshielded legs only, and signs.
   *
   * Must NOT balance dust. The sponsor does that, and the token kinds must not
   * overlap: re-balancing a kind the other party already balanced is a double
   * spend and the node rejects it. This is the single most likely thing to get
   * wrong in the whole fee-sponsorship flow.
   */
  balanceOwnLegs(tx: unknown, ttl: Date): Promise<unknown>;
  /**
   * Releases coins the customer's own balance booked and no submission took.
   *
   * **THIS MEMBER WAS MISSING AND ITS ABSENCE WAS NOT UNTIDINESS. IT MEANT
   * NOTHING ABOVE THIS INTERFACE COULD LET GO OF A COMPANY'S OWN COINS.**
   * Balancing marks coins in-flight in the wallet's own state; finalising
   * records the transaction as pending before anything is submitted; and a
   * transaction that is never submitted never acquires a result, so the
   * vendor's own cleanup - which only acts on transactions the chain answered
   * for - never touches it. Nothing releases it by time either: that sweep is
   * a documented no-op.
   *
   * **THE COINS ARE THE COMPANY'S, WHICH IS WHY THIS IS REQUIRED RATHER THAN
   * OPTIONAL.** The fee payer's side of the same window is released by the fee
   * payer, whose coins are ours. This side strands money on a device we do not
   * operate, where the only repair is a resync somebody has to be asked to
   * perform - and a company whose coins are stranded part way through a payroll
   * run cannot pay anybody. An optional member would mean a wallet could be
   * wired in with no way to release and every caller above would carry on as
   * though there were one.
   *
   * Takes whatever the balancing produced, for the reason the fee payer's
   * equivalent does: which of the recipe and the transaction is in hand depends
   * on how far the attempt got.
   */
  release(booking: unknown): Promise<void>;
}

/**
 * **THE TWO PROVIDERS BELOW ARE ONE THING, AND THIS IS WHY THEY ARE BUILT
 * TOGETHER RATHER THAN SEPARATELY.**
 *
 * The SDK calls `balanceTx` and, some time later and from somewhere else,
 * `submitTx`. They were written as two independent factories, which read
 * naturally and was wrong in one specific way: **balancing books coins, and
 * only submitting spends them.** Everything that can go wrong in between -
 * proving, staging, an expiry, a caller giving up - ends the operation with the
 * booking standing, and nothing afterwards lets go of it. The vendor's
 * time-based sweep is a documented no-op, and its own cleanup only acts on
 * transactions that got an answer from chain sync, which one that was never
 * submitted never gets.
 *
 * So the two share a record of what is outstanding, and the operation's owner
 * can say *let go of whatever was booked and not spent*. That is the only link
 * between the two callbacks, it is deliberately the smallest one that works,
 * and there was no link at all before.
 *
 * **AND THERE ARE TWO RECORDS RATHER THAN ONE, BECAUSE THERE ARE TWO WALLETS.**
 * `balanceTx` is itself two calls: the company balances and signs its own legs,
 * and only then is the fee payer given the result. Each books coins in its own
 * wallet's own state, and a release only ever reaches the wallet that made the
 * booking - so a single record would have let go of the fee budget and left the
 * company's coins standing. **The company's half of this window was open until
 * the change that first supplied a company wallet**, and both halves are closed
 * here and named separately below.
 *
 * **ONE OPERATION AT A TIME, STATED RATHER THAN ASSUMED.** The SDK gives these
 * callbacks nothing to tell one operation from another - no id, no context - so
 * the record below cannot be keyed by operation and is a plain set. That is
 * correct for the way this is driven today: the job queue runs one job at a
 * time, on purpose and for a different reason (the prover is single-threaded).
 * **If anything ever drives two operations through ONE bundle at once, the
 * first one's cleanup would release the second one's booking**, and the fix is
 * a bundle per operation rather than a cleverer record here. Written down
 * because it is the kind of thing that is discovered rather than remembered.
 */
export interface SponsoredProviders {
  walletProvider: WalletProvider;
  midnightProvider: MidnightProvider;
  /**
   * Releases anything EITHER PARTY's balance booked that no submission took.
   *
   * Called by whoever owns both phases, in a `finally`. Answers how many
   * bookings it let go of, so a caller can assert on it rather than on the
   * absence of a complaint.
   *
   * **THE COUNT SPANS BOTH WALLETS.** A single abandoned operation therefore
   * answers two rather than one: the company booked its own legs and the fee
   * payer booked the fee, in two separate wallets, and both have to be let go
   * by the wallet that made them.
   */
  releaseUnspent(): Promise<number>;
}

export const sponsoredProviders = (
  customer: CustomerWallet,
  sponsor: FeeSponsor,
  ttlMinutes = 20,
): SponsoredProviders => {
  /** What the FEE PAYER has booked and not yet handed to a submission. */
  const outstanding = new Set<unknown>();
  /**
   * What the CUSTOMER has booked and not yet handed to a submission.
   *
   * **A SECOND RECORD, AND NOT A SECOND COPY OF THE FIRST.** These are two
   * wallets with two separate local states: releasing the merged transaction
   * against the fee payer's wallet lets go of the fee payer's coins and says
   * nothing about the company's. So the company's own booking is remembered
   * here, separately, and released against the wallet that made it.
   *
   * **AND UNTIL THIS EXISTED THE COMPANY'S HALF OF THE WINDOW WAS OPEN.** The
   * balance below is two calls: the company books, and then the fee payer is
   * given what the company produced. Anything the fee payer's phase throws -
   * a refusal, an expiry, a proof that will not build - ended this function
   * with the company's coins booked and nothing anywhere able to let them go.
   */
  const ownBookings = new Set<unknown>();

  return {
    walletProvider: {
      getCoinPublicKey: () => customer.coinPublicKey() as any,
      getEncryptionPublicKey: () => customer.encryptionPublicKey() as any,

      async balanceTx(tx: any, ttl?: Date) {
        // Both parties must agree on a TTL, and it has to outlive the round trip
        // to the sponsor. Too short and the transaction expires between phases,
        // which presents as an intermittent failure under load.
        const deadline = ttl ?? new Date(Date.now() + ttlMinutes * 60_000);

        const ownLegsBalanced = await customer.balanceOwnLegs(tx, deadline);
        /*
         * **FROM THIS LINE THE COMPANY'S COINS ARE BOOKED.** Recorded before
         * the fee payer is called rather than after, which is the opposite of
         * the line below it and is not an inconsistency: what covers a throw
         * INSIDE `balanceOwnLegs` is that method's own guard, and what covers a
         * throw AFTER it is this record. There is no third place.
         */
        ownBookings.add(ownLegsBalanced);
        let finalised: unknown;
        try {
          finalised = await sponsor.addFeeAndFinalise(ownLegsBalanced, deadline);
        } catch (e) {
          /*
           * The fee payer has already released its own booking inside its own
           * method. This releases the company's, which nothing else can reach,
           * and it does not replace the failure that caused it: a caller handed
           * a complaint about tidying up instead of the error naming what
           * happened is sent to the wrong place entirely.
           */
          ownBookings.delete(ownLegsBalanced);
          try { await customer.release(ownLegsBalanced); } catch { /* see above */ }
          throw e;
        }
        /*
         * Recorded AFTER the call returns, because a throw inside it is already
         * covered: the sponsor's own method books and releases within itself,
         * and recording before would leave this layer trying to release a
         * booking that has already been let go.
         */
        outstanding.add(finalised);
        return finalised as any;
      },
    },

    midnightProvider: {
      async submitTx(tx: any) {
        /*
         * **THE HANDOVER, AND ITS ORDER IS THE POINT.** Forgotten here, BEFORE
         * the submission rather than after it: from this line the sponsor's own
         * `submit` owns what happens to this booking, including releasing it if
         * the submission throws. Clearing it afterwards would leave both layers
         * believing they had to release the same coins, and a second release
         * against a transaction the node may already have accepted is the one
         * mistake in this area that costs more than the booking did.
         */
        outstanding.delete(tx);
        /*
         * **AND THE COMPANY'S BOOKINGS GO WITH IT, BECAUSE A SUBMISSION SPENDS
         * THEM.** The merged transaction carries the company's legs, so once it
         * is on its way those coins are spent rather than booked, and releasing
         * them afterwards would mark spent coins available - the wallet's local
         * state then runs ahead of the chain and the next transaction selects
         * coins that no longer exist.
         *
         * **AND ON A SUBMISSION THAT THROWS THEY ARE FORGOTTEN AND NOT
         * RELEASED, WHICH IS THE OPPOSITE OF WHAT THE FEE PAYER DOES WITH ITS
         * OWN COINS ON THE SAME PATH. THAT IS A DECISION AND IT IS RECORDED AS
         * ONE.**
         *
         * A throw here is not proof the transaction did not land, and the two
         * parties resolve that the two different ways because their wallets are
         * not in the same position. Releasing after a landing does not merely
         * fail to help: the vendor's release clears the pending entry chain
         * sync would have used to repair the local state, and files a rejection
         * that did not happen. **The fee payer's wallet is one we operate, so
         * the repair - a resync - is a thing we do. The company's is on a
         * device we do not operate**, where a resync is a conversation with
         * somebody who does not know they need one, so the self-healing path is
         * worth more here than a booking is. What it costs is a company whose
         * own coins stay marked in flight until that wallet is resynced.
         *
         * **THEY ARE CLEARED WHOLE RATHER THAN BY NAME, AND THAT RESTS ON THE
         * ONE-OPERATION-AT-A-TIME PROPERTY THIS FILE ALREADY STATES.** The SDK
         * gives these callbacks nothing to tell one operation from another, so
         * there is no key to match a submission against the balance that
         * produced it. If anything ever drives two operations through ONE
         * bundle at once, this line releases nothing and instead FORGETS the
         * other operation's booking - the same failure the record above already
         * warns about, and the same fix: a bundle per operation.
         */
        ownBookings.clear();
        const ref = await sponsor.submit(tx);
        return ref.ref as any;
      },
    },

    async releaseUnspent() {
      /*
       * **EACH ONE ON ITS OWN, AND ONLY WHAT ACTUALLY WENT IS FORGOTTEN.** The
       * first version cleared the whole record and then released in a loop, so
       * a single refusal part way through dropped every remaining booking from
       * the record for ever - and the caller swallows the throw, so nothing
       * anywhere would have said so. What is left booked stays in the record,
       * which is the only place a later attempt can find it.
       *
       * **THE ANSWER COUNTS WHAT WAS RELEASED, NOT WHAT WAS TRIED**, because a
       * caller asserting on it is asserting that coins were let go, and a count
       * of attempts is exactly the kind of number that looks like evidence and
       * is not.
       */
      let released = 0;
      /*
       * **THE COUNT IS ONLY WORTH ANYTHING BECAUSE A RELEASE CAN NOW FAIL.**
       * Both parties' `release` used to swallow the vendor's refusal, so the
       * two `catch` arms below were unreachable, this answered a count of
       * ATTEMPTS under the word *released*, and every booking was deleted from
       * the record whether or not anything had been let go. The swallow moved
       * to the call sites that have an original failure to protect; here there
       * is none, so the truth arrives.
       *
       * **THE FEE PAYER'S FIRST, THEN THE COMPANY'S, WHICH IS THE ORDER THEY
       * WERE BOOKED IN REVERSED.** Neither depends on the other - they are two
       * wallets - so the order buys nothing mechanical; it is written down so
       * that a reader of a log sees the outer booking let go before the inner
       * one, which is the order the failure happened in.
       *
       * **AND THE ANSWER IS BOTH PARTIES' COUNT, NOT THE FEE PAYER'S.** A
       * caller asserting on this number is asserting that coins were let go,
       * and after this change coins can be let go on either side.
       */
      for (const b of [...outstanding]) {
        try {
          await sponsor.release(b);
          outstanding.delete(b);
          released += 1;
        } catch {
          /*
           * Kept, and deliberately not re-thrown. This runs on a path that has
           * usually already gone wrong, and the original failure is the one
           * naming what happened - but a booking that could not be released is
           * still outstanding, and saying it was released would be worse than
           * saying nothing.
           */
        }
      }
      for (const b of [...ownBookings]) {
        try {
          await customer.release(b);
          ownBookings.delete(b);
          released += 1;
        } catch {
          /* Kept, for the reason above. These are the company's coins. */
        }
      }
      return released;
    },
  };
};

/**
 * The wallet half on its own.
 *
 * Kept because callers that only need the shape have it, and deliberately NOT
 * the way anything that submits should build its providers: on its own it has
 * no way to release what EITHER PARTY booked, which is the whole subject of the
 * comment above. Use `sponsoredProviders` wherever a submission follows.
 */
export const sponsoredWalletProvider = (
  customer: CustomerWallet,
  sponsor: FeeSponsor,
  ttlMinutes = 20,
): WalletProvider => sponsoredProviders(customer, sponsor, ttlMinutes).walletProvider;

/**
 * Submission. Separate from the wallet because whoever pays the fee is the one
 * who submits, and that is the sponsor rather than the customer.
 *
 * Same caveat as above: built alone, it shares no record with any balance, so
 * nothing it is paired with can release an unspent booking.
 */
export const sponsoredMidnightProvider = (sponsor: FeeSponsor): MidnightProvider => ({
  async submitTx(tx: any) {
    const ref = await sponsor.submit(tx);
    return ref.ref as any;
  },
});

export interface ProviderBundle {
  config: MidnightConfig;
  customer: CustomerWallet;
  sponsor: FeeSponsor;
  /** Where compiled circuits and keys live. `contracts/managed`. */
  artifactsPath: string;
  /** Namespaces the client's private state. One per account. */
  privateStateId: string;
  /**
   * Encrypts the private state store at rest.
   *
   * The SDK requires this, which is the right default and happens to match
   * what we already do: the client vault is sealed under a key derived from
   * the user's password with argon2id, and that key never leaves the device.
   * Feed the same material in here rather than inventing a second secret.
   */
  storagePassword: () => Promise<string>;
}

/**
 * Builds the provider set.
 *
 * Imports are dynamic so that this module can be loaded, and its types
 * checked, in an environment with no node and no proof server. That matters:
 * the standalone build imports the same tree, and a top-level import of the
 * indexer client would break it.
 */
export async function midnightProviders(b: ProviderBundle): Promise<MidnightProviders> {
  const [
    { NodeZkConfigProvider },
    { httpClientProofProvider },
    { levelPrivateStateProvider },
    { indexerPublicDataProvider },
  ] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
    import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
    import('@midnight-ntwrk/midnight-js-level-private-state-provider'),
    import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
  ]);

  // Every wallet and contract operation throws until this is set, with a clear
  // message. Set it once, here, so no caller has to remember.
  
  // This used to read `setNetworkId(ledger.NetworkId[...])`, which passed a
  // NUMBER. The network id is interpolated verbatim into every bech32m address
  // the SDK encodes, so that produced `mn_shield-cpk_2...` where the wallet
  // produces `mn_shield-cpk_preview...`, and every single transaction died
  // inside parseCoinPublicKeyToHex with "Expected 2 address, got preview one".
  // It type-checked because the ledger import was cast to `any`.
  // See network.ts and network.test.ts. Do not reintroduce the enum.
  await applyNetworkId(b.config.networkId);

  const zkConfigProvider = new NodeZkConfigProvider(b.artifactsPath);
  const pair = sponsoredProviders(b.customer, b.sponsor);

  return {
    zkConfigProvider,
    // Positional arguments. The options-object form exists on midnight-js main
    // but not in the published 4.1.1, and passing an object fails with
    // "Invalid URL: [object Object]" from inside the provider.
    proofProvider: httpClientProofProvider(b.config.proverUrl, zkConfigProvider),
    // The signer's own private state: signing key, blinding factor, viewing
    // key. Local by construction, per decision 0002. Nothing here is ever sent.
    privateStateProvider: levelPrivateStateProvider({
      accountId: b.privateStateId,
      privateStateStoreName: b.privateStateId,
      // A plain async function returning the password, per the SDK's own
      // example. Not an object with a get().
      privateStoragePasswordProvider: b.storagePassword as any,
    }),
    publicDataProvider: indexerPublicDataProvider(b.config.indexerUrl, b.config.indexerWsUrl),
    /*
     * Built as a pair, so the balance and the submission share the record of
     * what is booked. `releaseUnspent` travels on the bundle because the SDK's
     * provider shape has nowhere else to put it, and whoever drives an
     * operation calls it in a `finally`.
     */
    walletProvider: pair.walletProvider,
    midnightProvider: pair.midnightProvider,
    releaseUnspent: pair.releaseUnspent,
  } as MidnightProviders;
}
