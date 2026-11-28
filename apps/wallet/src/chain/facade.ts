import { DefaultForkSchedule, NoOpTransactionHistoryStorage, WalletFacade } from '@midnightntwrk/wallet-sdk';
import type { WalletSeeds } from '@midnightntwrk/wallet-sdk';
import type { DefaultConfiguration, InitParams } from '@midnightntwrk/wallet-sdk-facade';
import type { Identity } from 'midnight-identity';
import { INDEXER_HTTP_URL, INDEXER_WS_URL, NETWORK, NETWORK_ENDPOINTS } from '../config.js';
import { websocketNodeOf } from '../../../../src/core/networks.js';
import { coinPublicKeyOf, shieldedKeysFor, walletFor, walletRestoredFrom } from './balance.js';
import { restorableAs } from './snapshot.js';
import { unshieldedWalletFor } from './unshielded.js';
import { dustWalletFor } from './dust.js';
import { isWalletAccount } from '../accounts/subwallets.js';

/**
 * THE FACADE — the SDK's own vehicle for everything that MOVES money, and
 * the sending rules made concrete: `WalletFacade` composes the
 * three wallets this app already constructs through pinned doors, and it —
 * not this repository — owns balancing, fees, dust registration, proving
 * coordination, finalising and submission. This file only assembles it from
 * the same `walletFor` / `unshieldedWalletFor` / `dustWalletFor` the balance
 * screens run, so the wallet that pays is provably the wallet that is
 * displayed, a property inherited rather than re-proved.
 *
 * WHAT IS DELIBERATELY NOT HERE: no wrapper around the facade's methods, no
 * abstraction over the proving seam. The proving service is ONE injected
 * object with ONE method and the SDK ships four implementations; callers
 * hand one in (the probe injects the in-browser WASM prover; tests that
 * never prove pass none and must never reach it — see `failingProving`).
 *
 * THE NODE, named here because submission needs it: the network record's
 * node over its websocket, dialled by the SDK's Polkadot client, carrying the
 * network's project token where the record asks for one.
 */
export const NODE_RPC_URL = websocketNodeOf(NETWORK_ENDPOINTS);

/**
 * The one configuration object the facade and all three wallets share — the
 * shape the Foundation's developer guide shows, with this app's endpoints.
 * `feeBlocksMargin: 5` is the guide's own value: the safety margin, in
 * blocks of fee drift, added when fees are computed. `forks` says where the
 * chain hands over from one ledger version to the next: the SDK's own
 * schedule for a chain on ledger-v9 from its start, the ledger this wallet
 * builds for.
 */
export const FACADE_CONFIG = {
  networkId: NETWORK,
  costParameters: { feeBlocksMargin: 5 },
  relayURL: new URL(NODE_RPC_URL),
  indexerClientConnection: {
    indexerHttpUrl: INDEXER_HTTP_URL,
    indexerWsUrl: INDEXER_WS_URL
  },
  forks: DefaultForkSchedule
} as const;

/** The proving service the facade is handed: one proof per transaction, at the protocol version it was built for. */
export type FacadeProving = Awaited<ReturnType<NonNullable<InitParams<DefaultConfiguration>['provingService']>>>;

/** A proving service for callers that must never prove: reading balances,
 * estimating, testing construction. If anything reaches it, that is a
 * defect speaking, and it says so instead of proving silently nothing. */
export const failingProving: FacadeProving = {
  prove: () =>
    Promise.reject(
      new Error(
        'this facade was assembled without a prover on purpose — nothing on this ' +
          "path should prove. Inject one of the SDK's proving services to move money."
      )
    )
};

/**
 * The SDK's own injection seams for the facade's services, passed straight
 * through — never wrapped. `WalletFacade.init`'s DEFAULT submission and
 * transaction-lifecycle services dial the node and the indexer during init,
 * so an offline test (and only a test) injects inert ones here; the app and
 * the probe pass nothing and get the SDK's defaults.
 */
export type FacadeServiceOverrides = Partial<
  Pick<
    InitParams<DefaultConfiguration>,
    'submissionService' | 'transactionLifecycleService' | 'fetchBlockData' | 'validationService' | 'clock'
  >
>;

/**
 * The facade over ONE account's three wallets. The caller chooses the
 * prover — that is the whole seam — and `start` is the caller's to invoke:
 * nothing syncs, proves or submits because this function ran.
 *
 * `restoreShieldedFrom` is a sealed checkpoint's snapshot of this account's
 * private part: the part is rebuilt from it and reads only what is new. **It is
 * restored only when it is this account's own, read from this network, and
 * holds nothing in flight** (`restorableAs`); any other snapshot, and one the
 * SDK refuses, is a cache miss, never a dead end, and the part starts from
 * nothing as before. A snapshot of another account would otherwise pay from
 * that account's coins under this one's name.
 */
export async function facadeFor(
  identity: Identity,
  account: number,
  provingService: FacadeProving,
  overrides: FacadeServiceOverrides = {},
  from: { readonly restoreShieldedFrom?: string } = {}
): Promise<WalletFacade> {
  const shielded = async () => {
    if (
      from.restoreShieldedFrom !== undefined &&
      restorableAs(from.restoreShieldedFrom, coinPublicKeyOf(identity, account), NETWORK)
    ) {
      try {
        return walletRestoredFrom(from.restoreShieldedFrom);
      } catch {
        /* a cache miss: the cold door below */
      }
    }
    return walletFor(identity, account);
  };
  return WalletFacade.init({
    /* History is later, audited work — the same no-op every wallet uses, so
     * no fact about payments enters any store through the facade either. */
    configuration: {
      ...FACADE_CONFIG,
      txHistoryStorage: new NoOpTransactionHistoryStorage()
    },
    shielded,
    unshielded: () => unshieldedWalletFor(identity, account),
    dust: () => dustWalletFor(identity, account),
    provingService: () => provingService,
    ...overrides
  });
}

/**
 * **STARTS WHAT A PAGE'S PAYMENT USES, AND NOT THE DUST WALLET.** `start`
 * starts all three wallets and the transaction-lifecycle service, always. A
 * page's deposit balances private or public coins and never DUST - the
 * company's fee payer pays the fee - so reading DUST from the beginning of the
 * chain beside the private read only slows the read the payment waits for
 * (the private read alone takes about half as long as beside the DUST read). Balancing, signing,
 * finishing and letting go all still work on the parts started here, and the
 * transaction-lifecycle service still runs, so a transaction that fails or
 * expires is still let go by it.
 */
export async function startForAPage(
  facade: Pick<WalletFacade, 'shielded' | 'unshielded' | 'transactionLifecycleService'>,
  keys: { readonly shielded: ReturnType<typeof shieldedKeysFor> }
): Promise<void> {
  await Promise.all([
    facade.shielded.start(keys.shielded),
    facade.unshielded.start(),
    facade.transactionLifecycleService.start()
  ]);
}

/**
 * What `facade.start` is started from: the account's own three seeds, the same
 * ones every key this wallet shows is derived from, so the facade derives each
 * ledger version's keys from them itself. Refuses an account that is not a
 * wallet this interface offers.
 */
export const seedsFor = (identity: Identity, account: number): WalletSeeds => {
  if (!isWalletAccount(account)) {
    throw new Error(
      `account ${account} is not a wallet this interface offers` +
        (account === 1 ? ' — account 1 is the authority compartment, never a wallet.' : '.')
    );
  }
  const money = identity.moneyAt(account);
  return { shielded: money.zswap, unshielded: money.night, dust: money.dust };
};
