/**
 * The providers midnight-js builds, proves, balances and submits a transaction through, on the service's side.
 *
 * The company's wallet balances the shielded and unshielded legs of a transaction and signs; the fee payer the
 * service runs then adds the DUST, pays the fee and submits. The wallet and submit providers serve the ledger 9 era
 * only and say so (the proof server's provider also serves an earlier one), so midnight-js, which checks every provider
 * in the set, refuses an operation of any other era before it proves anything. The network a
 * transaction is built for, and how long it may wait to land, come from the one network record and the one intent
 * lifetime; nothing here holds a second copy of either.
 */
import {
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
  type LedgerTransaction,
  type MidnightConfig as TransactionSettings,
  type MidnightProvider,
  type MidnightProviders,
  type WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import type { ContractModuleProvider } from '@midnight-ntwrk/compact-runtime';
import { bytesToHex } from '@noble/hashes/utils.js';
import { networkRecord } from '../core/networks.js';
import { INTENT_LIFETIME_MS } from './intent-lifetime.js';
import type { MidnightConfig, FeeSponsor } from './ledger.js';

/**
 * What midnight-js stamps on every transaction it builds: the network, named by its record's key, and the intent
 * lifetime this application builds every transaction with. Refuses a network with no record.
 */
export const transactionSettingsFor = (network: string): TransactionSettings => ({
  networkId: networkRecord(network).id,
  ttlSeconds: INTENT_LIFETIME_MS / 1000,
});

/**
 * The network id the providers were built for, from their transaction settings. Refuses providers that carry
 * none, because a transaction built without the right id is refused by the chain after its proof is paid for.
 */
export const networkIdOf = (providers: { config?: { networkId?: string } }): string => {
  const id = providers.config?.networkId;
  if (typeof id !== 'string' || id === '') {
    throw new Error('these providers name no network, so no transaction can be built with them. '
      + 'Build them with midnightProviders, which takes the network from its record.');
  }
  return id;
};

/** Anything that writes itself out as a transaction's bytes: a ledger transaction or a sealed handle. */
export interface Serializable {
  serialize(): Uint8Array;
}

/**
 * The company's wallet, as the service's providers reach it.
 *
 * An interface rather than a concrete wallet: a browser wallet the company controls, or a test wallet.
 */
export interface CustomerWallet {
  coinPublicKey(): string;
  encryptionPublicKey(): string;
  /**
   * Balances the shielded and unshielded legs only, and signs. Handed the proven transaction as the ledger 9
   * `Transaction` object; answers with the finalised transaction, which the fee payer reads from its bytes.
   *
   * Must NOT balance DUST. The fee payer does that, and the token kinds must not overlap: balancing a kind the other
   * party already balanced spends twice and the node refuses it.
   */
  balanceOwnLegs(tx: Serializable, ttl: Date): Promise<Serializable>;
  /**
   * Gives back the coins the company's own balance booked when no submission took them. Required, because the coins
   * are the company's: without it a booking that was never submitted stays marked in flight on a device the service
   * does not operate, until that wallet is resynced. Takes whatever `balanceOwnLegs` answered.
   */
  release(booking: unknown): Promise<void>;
}

/**
 * A balance and a submission sharing one record of what is booked.
 *
 * Balancing books coins and only submitting spends them, and midnight-js calls the two at different times. Anything
 * that ends an operation in between (a proof that fails, an expiry, a caller giving up) leaves the booking standing,
 * and nothing in the wallets releases a transaction that was never submitted. So the two share a record, and the
 * operation's owner calls `releaseUnspent` in a `finally`.
 *
 * There are two records because there are two wallets: the company books its own legs, the fee payer books the fee,
 * and a release reaches only the wallet that made the booking.
 *
 * One operation at a time per bundle: the callbacks carry nothing to tell one operation from another, so the
 * company's record is cleared whole on submission. Two operations driven through ONE bundle at once would have the
 * first one's submission forget the second one's booking; the answer is a bundle per operation.
 */
export interface SponsoredProviders {
  walletProvider: WalletProvider;
  midnightProvider: MidnightProvider;
  /**
   * Releases what EITHER party booked that no submission took, and answers how many bookings were released (not how
   * many were tried). An abandoned operation answers two: one booking in each wallet.
   */
  releaseUnspent(): Promise<number>;
}

const ledger9 = () => import('@midnightntwrk/ledger-v9');

/** The bytes of a transaction a wallet answered with, refused by name when the answer is not a transaction. */
const bytesOf = (answer: unknown, who: string): Uint8Array => {
  const serialize = (answer as { serialize?: unknown } | null)?.serialize;
  if (typeof serialize !== 'function') {
    throw new Error(`${who} answered with something that is not a transaction, so nothing was submitted.`);
  }
  const bytes: unknown = serialize.call(answer);
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`${who} answered with a transaction that would not serialize, so nothing was submitted.`);
  }
  return bytes;
};

export const sponsoredProviders = (customer: CustomerWallet, sponsor: FeeSponsor): SponsoredProviders => {
  /** What the FEE PAYER has booked and not yet handed to a submission, by the bytes of the transaction it finalised. */
  const outstanding = new Map<string, unknown>();
  /** What the COMPANY has booked and not yet handed to a submission. */
  const ownBookings = new Set<unknown>();

  const walletProvider = createLedger9WalletProvider({
    getCoinPublicKey: () => customer.coinPublicKey(),
    getEncryptionPublicKey: () => customer.encryptionPublicKey(),

    async balanceTx(tx: LedgerTransaction<'Unbound', 'v9'>, ttl?: Date) {
      /* Both parties stamp one deadline, so the transaction cannot expire between the two halves of its balance. */
      const deadline = ttl ?? new Date(Date.now() + INTENT_LIFETIME_MS);
      const { Transaction } = await ledger9();
      const ownLegsBalanced = await customer.balanceOwnLegs(tx.deserialize({ v9: Transaction }), deadline);
      /*
       * From here the company's coins are booked. A throw inside `balanceOwnLegs` is that method's own to release;
       * a throw after it is covered by this record.
       */
      ownBookings.add(ownLegsBalanced);
      let finalised: unknown;
      try {
        finalised = await sponsor.addFeeAndFinalise(ownLegsBalanced, deadline);
      } catch (e) {
        /*
         * The fee payer has released its own booking inside its own method; this releases the company's. A release
         * that also fails is not reported in place of the failure that caused it, which names what happened.
         */
        ownBookings.delete(ownLegsBalanced);
        try { await customer.release(ownLegsBalanced); } catch { /* the fee payer's failure is the one rethrown */ }
        throw e;
      }
      /* Recorded after the call returns: a throw inside it is the fee payer's own to release. */
      let bytes: Uint8Array;
      try {
        bytes = bytesOf(finalised, 'the fee payer');
      } catch (e) {
        /* An answer that cannot be submitted still booked the fee; the company's booking stays in its record. */
        try { await sponsor.release(finalised); } catch { /* the refusal of the answer is the failure rethrown */ }
        throw e;
      }
      outstanding.set(bytesToHex(bytes), finalised);
      return bytes;
    },
  });

  const midnightProvider = createLedger9MidnightProvider(async (tx) => {
    const key = bytesToHex(tx.serialize());
    const booked = outstanding.get(key);
    /*
     * Forgotten BEFORE the submission: from here the fee payer's own `submit` owns this booking, including its
     * release if the submission throws. Forgetting it afterwards would leave two layers each releasing the same coins,
     * against a transaction the node may already have accepted.
     */
    outstanding.delete(key);
    /*
     * The company's bookings go too, because the submitted transaction carries its legs and spends them. On a
     * submission that throws they are forgotten, not released: a throw is no proof the transaction did not land, and
     * releasing after a landing clears the pending entry the company's wallet would repair itself from. What it costs
     * is a company whose coins stay marked in flight until its wallet resyncs.
     */
    ownBookings.clear();
    const ref = await sponsor.submit(booked ?? tx);
    return ref.ref;
  });

  return {
    walletProvider,
    midnightProvider,

    async releaseUnspent() {
      /*
       * Each booking on its own, and only what was released is forgotten: a release that is refused stays in the
       * record, the only place a later attempt can find it. Not rethrown, because this runs on a path that has
       * usually already failed and that failure is the one naming what happened. The fee payer's first, then the
       * company's: the outer booking let go before the inner one.
       */
      let released = 0;
      for (const [key, booking] of [...outstanding]) {
        try {
          await sponsor.release(booking);
          outstanding.delete(key);
          released += 1;
        } catch { /* kept in the record for a later attempt, for the reason above */ }
      }
      for (const booking of [...ownBookings]) {
        try {
          await customer.release(booking);
          ownBookings.delete(booking);
          released += 1;
        } catch { /* kept in the record for a later attempt; these are the company's coins */ }
      }
      return released;
    },
  };
};

/** What every provider set is built from, whoever pays for its transactions. */
export interface ContractProviderBundle {
  /** The network the transactions are built for, the proof server and the indexer. */
  config: Pick<MidnightConfig, 'networkId' | 'proverUrl' | 'indexerUrl' | 'indexerWsUrl'>;
  /** Where the compiled contract's circuits and keys live. */
  artifactsPath: string;
  /** Names the store the private state of this account is kept in. */
  privateStateId: string;
  /** Encrypts the private state store at rest. */
  storagePassword: () => Promise<string>;
  /**
   * Which compiled contract a cross-contract call reaches: a vault's provider set carries the one for its company
   * account (`accountModuleFor`), and an account's carries none, because no account circuit calls another contract.
   */
  contractModules?: ContractModuleProvider;
}

export interface ProviderBundle extends ContractProviderBundle {
  config: MidnightConfig;
  customer: CustomerWallet;
  sponsor: FeeSponsor;
}

/** A provider set without the two members that balance and submit, which depend on who pays. */
export type ContractProviders = Omit<MidnightProviders, 'walletProvider' | 'midnightProvider'>;

/** The provider set, with the release of whatever an abandoned operation left booked. */
export type ServiceProviders = MidnightProviders & Pick<SponsoredProviders, 'releaseUnspent'>;

/**
 * The indexer's public data provider at `indexer`, in the form 5.0.0 prefers (its options object; the positional form
 * is deprecated and kept only for backward compatibility). Every provider set reads the chain through this, and so
 * does anything that only reads a contract's public state.
 */
export async function publicDataProviderAt(
  indexer: Pick<MidnightConfig, 'indexerUrl' | 'indexerWsUrl'>,
): Promise<MidnightProviders['publicDataProvider']> {
  const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
  return indexerPublicDataProvider({ queryURL: indexer.indexerUrl, subscriptionURL: indexer.indexerWsUrl });
}

/**
 * Builds the members of a provider set that do not depend on who pays: the transaction settings, the circuits'
 * keys, the proof server, the private state store and the indexer. Imported dynamically, so loading this module
 * (and checking its types) needs no node, no indexer and no proof server.
 */
export async function contractProviders(b: ContractProviderBundle): Promise<ContractProviders> {
  const [
    { NodeZkConfigProvider },
    { httpClientProofProvider },
    { levelPrivateStateProvider },
    publicDataProvider,
  ] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
    import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
    import('@midnight-ntwrk/midnight-js-level-private-state-provider'),
    publicDataProviderAt(b.config),
  ]);

  const zkConfigProvider = new NodeZkConfigProvider(b.artifactsPath);

  return {
    config: transactionSettingsFor(b.config.networkId),
    zkConfigProvider,
    proofProvider: httpClientProofProvider({ url: b.config.proverUrl, zkConfigProvider }),
    /* The signer's own private state stays on this machine; nothing in it is sent. */
    privateStateProvider: levelPrivateStateProvider({
      accountId: b.privateStateId,
      privateStateStoreName: b.privateStateId,
      privateStoragePasswordProvider: b.storagePassword,
    }),
    publicDataProvider,
    ...(b.contractModules === undefined ? {} : { contractModuleProvider: b.contractModules }),
  };
}

/**
 * Builds the service's provider set: the company's wallet balances its own legs and the fee payer adds the fee and
 * submits.
 */
export async function midnightProviders(b: ProviderBundle): Promise<ServiceProviders> {
  const pair = sponsoredProviders(b.customer, b.sponsor);
  return {
    ...(await contractProviders(b)),
    walletProvider: pair.walletProvider,
    midnightProvider: pair.midnightProvider,
    releaseUnspent: pair.releaseUnspent,
  };
}
