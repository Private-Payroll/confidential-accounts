import { NoOpTransactionHistoryStorage, WalletFacade } from '@midnightntwrk/wallet-sdk';
import type { DefaultConfiguration, InitParams } from '@midnightntwrk/wallet-sdk-facade';
import type { ProvingService, UnboundTransaction } from '@midnightntwrk/wallet-sdk/proving';
import type { Identity } from 'midnight-identity';
import { INDEXER_HTTP_URL, INDEXER_WS_URL, NETWORK } from '../config.js';
import { secretKeysFor, walletFor } from './balance.js';
import { unshieldedWalletFor } from './unshielded.js';
import { dustSecretKeyFor, dustWalletFor } from './dust.js';

/**
 * THE FACADE — the SDK's own vehicle for everything that MOVES money, and
 * the sending rules made concrete: `WalletFacade` composes the
 * three wallets this app already constructs through pinned doors, and it —
 * not this repository — owns balancing, fees, dust registration, proving
 * coordination, finalising and submission. This file only assembles it from
 * the same `walletFor` / `unshieldedWalletFor` / `dustWalletFor` the balance
 * screens run, so the wallet that pays is provably the wallet that is
 * displayed — the §1.1 property, inherited rather than re-proved.
 *
 * WHAT IS DELIBERATELY NOT HERE: no wrapper around the facade's methods, no
 * abstraction over the proving seam. The proving service is ONE injected
 * object with ONE method and the SDK ships four implementations; callers
 * hand one in (the probe injects the in-browser WASM prover; tests that
 * never prove pass none and must never reach it — see `failingProving`).
 *
 * THE NODE, named here because submission needs it and nothing before it
 * did: `wss://rpc.stagenet.shielded.tools` — the same host family as the
 * indexer, dialled by the SDK's Polkadot client. The endpoint is verified
 * the way the indexer's was: by the probe actually submitting through it
 * (the pattern is the Foundation's own, `wss://rpc.<network>.midnight.network`
 * on preprod, and the stagenet host answers DNS; the first live probe run is
 * the real check, and until then it is an assumption stated in the log).
 */
export const NODE_RPC_URL = 'wss://rpc.stagenet.shielded.tools';

/**
 * The one configuration object the facade and all three wallets share — the
 * shape the Foundation's developer guide shows, with this app's endpoints.
 * `feeBlocksMargin: 5` is the guide's own value: the safety margin, in
 * blocks of fee drift, added when fees are computed.
 */
export const FACADE_CONFIG = {
  networkId: NETWORK,
  costParameters: { feeBlocksMargin: 5 },
  relayURL: new URL(NODE_RPC_URL),
  indexerClientConnection: {
    indexerHttpUrl: INDEXER_HTTP_URL,
    indexerWsUrl: INDEXER_WS_URL,
  },
} as const;

/** A proving service for callers that must never prove: reading balances,
 * estimating, testing construction. If anything reaches it, that is a
 * defect speaking, and it says so instead of proving silently nothing. */
export const failingProving: ProvingService<UnboundTransaction> = {
  prove: () => Promise.reject(new Error(
    'this facade was assembled without a prover on purpose — nothing on this '
    + 'path should prove. Inject one of the SDK\'s proving services to move money.')),
};

/**
 * The SDK's own injection seams for the facade's services, passed straight
 * through — never wrapped. `WalletFacade.init`'s DEFAULT submission and
 * pending-transactions services dial the node and the indexer during init,
 * so an offline test (and only a test) injects inert ones here; the app and
 * the probe pass nothing and get the SDK's defaults.
 */
export type FacadeServiceOverrides = Partial<Pick<
  InitParams<DefaultConfiguration>,
  'submissionService' | 'pendingTransactionsService' | 'fetchBlockData' | 'validationService' | 'clock'
>>;

/**
 * The facade over ONE account's three wallets. The caller chooses the
 * prover — that is the whole seam — and `start` is the caller's to invoke:
 * nothing syncs, proves or submits because this function ran.
 */
export async function facadeFor(
  identity: Identity,
  account: number,
  provingService: ProvingService<UnboundTransaction>,
  overrides: FacadeServiceOverrides = {},
): Promise<WalletFacade> {
  return WalletFacade.init({
    /* History is later, audited work — the same no-op every wallet uses, so
     * no fact about payments enters any store through the facade either. */
    configuration: {
      ...FACADE_CONFIG,
      txHistoryStorage: new NoOpTransactionHistoryStorage(),
    },
    shielded: () => walletFor(identity, account),
    unshielded: () => unshieldedWalletFor(identity, account),
    dust: () => dustWalletFor(identity, account),
    provingService: () => provingService,
    ...overrides,
  });
}

/** What `facade.start` needs, derived the same way everything else is. */
export const facadeKeysFor = (identity: Identity, account: number): {
  shielded: ReturnType<typeof secretKeysFor>;
  dust: ReturnType<typeof dustSecretKeyFor>;
} => ({
  shielded: secretKeysFor(identity, account),
  dust: dustSecretKeyFor(identity, account),
});
