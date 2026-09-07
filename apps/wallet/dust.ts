import { DustWallet, NoOpTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk';
import type { DustWallet as RunningDustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { DustSecretKey, LedgerParameters } from '@midnightntwrk/ledger-v9';
import { DustAddress } from '@midnightntwrk/wallet-sdk-address-format';
import type { Identity } from 'midnight-identity';
import { INDEXER_HTTP_URL, INDEXER_WS_URL, NETWORK } from './config.js';
import { withOwnClock } from './balance.js';
import type { BalanceEngine, BalanceState } from './balance.js';
import { isWalletAccount } from './subwallets.js';
import { describeFailure } from './failure-text.js';

/**
 * THE DUST DOOR, and the reason the wallet has a third balance.
 *
 * Fees on Midnight are paid in DUST, and DUST is not bought or fauceted: it
 * is GENERATED, over time, by NIGHT that has been registered for generation.
 * A wallet holding 5,000 tNIGHT and zero DUST cannot pay for any
 * transaction — which is this wallet's exact situation until registration
 * runs — so before anything can ever send, DUST must exist and be readable.
 * This file is the reading half; registration goes through the SDK's
 * `WalletFacade` (`facade.ts`), never through anything of ours.
 *
 * THE RIGHT DOOR, held to the same bar as the other two (§1.1 of the
 * balances rules, the two-sided method): the Foundation's developer guide
 * initialises the dust wallet as
 *
 *     DustWallet(configuration).startWithSecretKey(
 *       dustSecretKey, LedgerParameters.initialParameters().dust)
 *
 * with the secret key derived at the DUST role of the SAME HD account the
 * other two wallets use — `moneyAt(account).dust`. The trap is the BYTES
 * again: the zswap or night key fed to `DustSecretKey.fromSeed` derives a
 * DUST address no chain event will ever credit, and the wallet reads zero
 * for ever while generation accrues to an address nobody displays. The
 * address-agreement test in `dust.test.ts` pins it: the SDK wallet's own
 * reported address equals `dustAddressFor`, per account, byte for byte —
 * and `dustAddressFor` is the same derivation the test-wallet tool prints,
 * pinned to the library by running it.
 */

const guardAccount = (account: number): void => {
  if (!isWalletAccount(account)) {
    throw new Error(`account ${account} is not a wallet this interface offers`
      + (account === 1 ? ' — account 1 is the authority compartment, never a wallet.' : '.'));
  }
};

/** The HD-derived DUST key for one account — the RIGHT thirty-two bytes. */
export function dustSecretKeyFor(identity: Identity, account: number): DustSecretKey {
  guardAccount(account);
  return DustSecretKey.fromSeed(identity.moneyAt(account).dust);
}

/** The DUST address for one account — where generated DUST is credited. */
export const dustAddressFor = (identity: Identity, account: number): string =>
  DustAddress.encodePublicKey(NETWORK, dustSecretKeyFor(identity, account).publicKey);

/**
 * The dust wallet's configuration. Two fields the other wallets do not
 * carry: `costParameters.feeBlocksMargin` is the safety margin (in blocks of
 * fee drift) the SDK adds when it computes fees — 5 is the value the
 * Foundation's own guide configures — and the wallet takes the chain's
 * initial DUST parameters (`LedgerParameters.initialParameters().dust`),
 * exactly as the guide shows.
 */
export const DUST_CONFIG = {
  networkId: NETWORK,
  costParameters: { feeBlocksMargin: 5 },
  indexerClientConnection: {
    indexerHttpUrl: INDEXER_HTTP_URL,
    indexerWsUrl: INDEXER_WS_URL,
  },
  /* Same reasoning as the other two wallets: history is later, audited work;
   * a no-op keeps every fact about payments out of every store until then. */
  txHistoryStorage: new NoOpTransactionHistoryStorage(),
} as const;

/** The SDK's dust wallet for ONE account, through the right door. Exported
 * so the agreement test, the facade and the probe exercise what the app runs. */
export function dustWalletFor(identity: Identity, account: number): RunningDustWallet {
  guardAccount(account);
  return DustWallet(DUST_CONFIG).startWithSecretKey(
    dustSecretKeyFor(identity, account), LedgerParameters.initialParameters().dust);
}

/**
 * The DUST engine — the same four sentences as the other two, read from the
 * dust wallet's own state stream. One honest difference, said here because
 * the state itself says it: a DUST balance is a FUNCTION OF TIME (registered
 * NIGHT generates continuously), so `synced` reports the balance AT ITS
 * `asOf` moment — which the card already prints — and a re-check reads a
 * larger number without anything having arrived. The `night` field of
 * `BalanceState` carries SPECKs here; the state names the atomic amount,
 * the line that renders it names the token.
 */
const startDustRaw: BalanceEngine = (identity, account, onState) => {
  let stopped = false;
  const tell = (state: BalanceState): void => { if (!stopped) onState(state); };

  tell({ name: 'connecting' });

  let wallet: RunningDustWallet | null = null;
  let subscription: { unsubscribe(): void } | null = null;
  let numberShown = false;
  try {
    wallet = dustWalletFor(identity, account);
    subscription = wallet.state.subscribe({
      next: (state) => {
        const progress = state.progress;
        if (progress.isConnected && progress.isStrictlyComplete()) {
          numberShown = true;
          const asOf = Date.now();
          tell({ name: 'synced', night: state.balance(new Date(asOf)), asOf });
          return;
        }
        if (numberShown) return; /* the established number stands */
        if (!progress.isConnected) {
          tell({ name: 'connecting' });
          return;
        }
        tell({ name: 'syncing', applied: progress.appliedIndex, highest: progress.highestIndex });
      },
      error: (e: unknown) => {
        if (!numberShown) tell({ name: 'failed', message: describeFailure(e) });
      },
    });
    wallet.start(dustSecretKeyFor(identity, account)).catch((e: unknown) => {
      if (!numberShown) tell({ name: 'failed', message: describeFailure(e) });
    });
  } catch (e) {
    tell({ name: 'failed', message: describeFailure(e) });
  }

  return () => {
    stopped = true;
    subscription?.unsubscribe();
    void wallet?.stop().catch(() => { /* already stopping is fine */ });
  };
};

/** The engine the app runs — on the same clock as the other two. */
export const startDustBalance: BalanceEngine = withOwnClock(startDustRaw);
