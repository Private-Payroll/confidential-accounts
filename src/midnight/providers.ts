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
 * Wallet provider implementing two-phase balancing.
 *
 * The SDK calls `balanceTx` and expects a finalised transaction back. What
 * happens in between is our business: the customer balances what they own, the
 * sponsor adds the fee, and the customer never learns that DUST exists.
 */
export const sponsoredWalletProvider = (
  customer: CustomerWallet,
  sponsor: FeeSponsor,
  ttlMinutes = 20,
): WalletProvider => ({
  getCoinPublicKey: () => customer.coinPublicKey() as any,
  getEncryptionPublicKey: () => customer.encryptionPublicKey() as any,

  async balanceTx(tx: any, ttl?: Date) {
    // Both parties must agree on a TTL, and it has to outlive the round trip
    // to the sponsor. Too short and the transaction expires between phases,
    // which presents as an intermittent failure under load.
    const deadline = ttl ?? new Date(Date.now() + ttlMinutes * 60_000);

    const ownLegsBalanced = await customer.balanceOwnLegs(tx, deadline);
    return sponsor.addFeeAndFinalise(ownLegsBalanced, deadline) as any;
  },
});

/**
 * Submission. Separate from the wallet because whoever pays the fee is the one
 * who submits, and that is the sponsor rather than the customer.
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
  //
  // This used to read `setNetworkId(ledger.NetworkId[...])`, which passed a
  // NUMBER. The network id is interpolated verbatim into every bech32m address
  // the SDK encodes, so that produced `mn_shield-cpk_2...` where the wallet
  // produces `mn_shield-cpk_preview...`, and every single transaction died
  // inside parseCoinPublicKeyToHex with "Expected 2 address, got preview one".
  // It type-checked because the ledger import was cast to `any`.
  // See network.ts and network.test.ts. Do not reintroduce the enum.
  await applyNetworkId(b.config.networkId);

  const zkConfigProvider = new NodeZkConfigProvider(b.artifactsPath);

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
    walletProvider: sponsoredWalletProvider(b.customer, b.sponsor),
    midnightProvider: sponsoredMidnightProvider(b.sponsor),
  } as MidnightProviders;
}
