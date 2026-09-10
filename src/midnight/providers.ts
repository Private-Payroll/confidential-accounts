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
 * So the two share one record of what is outstanding, and the operation's owner
 * can say *let go of whatever was booked and not spent*. That is the only link
 * between the two callbacks, it is deliberately the smallest one that works,
 * and there was no link at all before.
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
   * Releases anything a balance booked that no submission took.
   *
   * Called by whoever owns both phases, in a `finally`. Answers how many
   * bookings it let go of, so a caller can assert on it rather than on the
   * absence of a complaint.
   */
  releaseUnspent(): Promise<number>;
}

export const sponsoredProviders = (
  customer: CustomerWallet,
  sponsor: FeeSponsor,
  ttlMinutes = 20,
): SponsoredProviders => {
  /** What has been booked and not yet handed to a submission. */
  const outstanding = new Set<unknown>();

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
        const finalised = await sponsor.addFeeAndFinalise(ownLegsBalanced, deadline);
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
      return released;
    },
  };
};

/**
 * The wallet half on its own.
 *
 * Kept because callers that only need the shape have it, and deliberately NOT
 * the way anything that submits should build its providers: on its own it has
 * no way to release what it booked, which is the whole subject of the comment
 * above. Use `sponsoredProviders` wherever a submission follows.
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
