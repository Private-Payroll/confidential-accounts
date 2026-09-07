import {
  NoOpTransactionHistoryStorage, PublicKey, UnshieldedWallet, createKeystore,
} from '@midnightntwrk/wallet-sdk';
import type { UnshieldedWallet as RunningUnshieldedWallet } from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import type { UnshieldedKeystore } from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import { nativeToken } from '@midnightntwrk/ledger-v9';
import type { Identity } from 'midnight-identity';
import { INDEXER_HTTP_URL, INDEXER_WS_URL, NETWORK } from '../config.js';
import { withOwnClock } from './balance.js';
import type { BalanceEngine, BalanceState } from './balance.js';
import { isWalletAccount } from '../accounts/subwallets.js';
import { describeFailure } from '../lib/failure-text.js';

/**
 * THE UNSHIELDED DOOR, and the reason it matters.
 *
 * Midnight has three kinds of address, and `MoneyKeys` already derives the
 * key behind each: `zswap` (shielded), `night` (unshielded), `dust` (fees).
 * Until this file the wallet built an address for ONE of them and read a
 * balance for ONE of them — and the Foundation's faucet documentation says
 * plainly that the faucet *"rejects shielded and DUST addresses"*. So the
 * only address this wallet offered was the one the ordinary route cannot
 * pay, and NIGHT arriving the normal way landed where the wallet read zero.
 *
 * THE RIGHT DOOR, found the way §1.1 of the balances rules teaches, and
 * pinned the same way. The SDK's own path — used by its `V1Builder` and by
 * testkit's wallet facade — is:
 *
 *     createKeystore({ kind: 'schnorr', secret: nightKey }, networkId)
 *       → PublicKey.fromKeyStore(keystore)
 *       → UnshieldedWallet(configuration).startWithPublicKey(publicKey)
 *
 * Two traps live one argument away, both pinned in `balance.test.tsx`:
 * the KIND — the same thirty-two bytes under `'ecdsa'` produce a DIFFERENT
 * address, so a wrong kind is money at an address this wallet never shows —
 * and the BYTES, which must be the HD-derived NIGHT key for the account
 * (`moneyAt(account).night`), never the zswap key and never the raw secret.
 * The address-agreement test asks the SDK wallet for its own address and
 * compares it byte for byte with `unshieldedAddressFor`, per account.
 */

const guardAccount = (account: number): void => {
  if (!isWalletAccount(account)) {
    throw new Error(`account ${account} is not a wallet this interface offers`
      + (account === 1 ? ' — account 1 is the authority compartment, never a wallet.' : '.'));
  }
};

/** The SDK's keystore over the HD-derived NIGHT key — schnorr, the SDK's
 * own choice for NIGHT (its `V1Builder` and testkit both use it). */
export function unshieldedKeystoreFor(identity: Identity, account: number): UnshieldedKeystore {
  guardAccount(account);
  return createKeystore(
    { kind: 'schnorr', secret: identity.moneyAt(account).night }, NETWORK);
}

/** The address ordinary NIGHT transfers — and the faucet — pay into. */
export const unshieldedAddressFor = (identity: Identity, account: number): string =>
  unshieldedKeystoreFor(identity, account).getBech32Address().asString();

/**
 * Both ends, never only the head — the rule, applied to the unshielded
 * string the same way `shortPayee` applies it to the shielded one. (That
 * function takes a `PayeeAddress` and this is a plain bech32, so the five
 * lines are restated here rather than the type loosened there.)
 */
export const shortUnshielded = (bech32: string): string => {
  const at = bech32.lastIndexOf('1');
  const payload = at > 0 ? bech32.slice(at + 1) : bech32;
  const network = at > 0 ? bech32.slice(0, at + 1) : '';
  return `${network}${payload.slice(0, 8)}…${payload.slice(-8)}`;
};

/** The unshielded wallet for ONE account, through the right door. Exported
 * so the agreement test and the probe exercise what the app runs. */
export function unshieldedWalletFor(
  identity: Identity, account: number,
): RunningUnshieldedWallet {
  return UnshieldedWallet({
    networkId: NETWORK,
    indexerClientConnection: {
      indexerHttpUrl: INDEXER_HTTP_URL,
      indexerWsUrl: INDEXER_WS_URL,
    },
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
  }).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystoreFor(identity, account)));
}

/** Unshielded NIGHT, as the balances record keys it. */
const NIGHT_UNSHIELDED_RAW = nativeToken().raw;

/**
 * The unshielded engine — the same four sentences as the shielded one
 * (`balance.ts`), read from the unshielded wallet's own state stream. No
 * checkpoint yet: the unshielded sync is a UTXO read rather than a
 * decrypt-everything scan, and caching it is future work said out loud in
 * the log rather than assumed.
 */
const startUnshieldedRaw: BalanceEngine = (identity, account, onState) => {
  let stopped = false;
  const tell = (state: BalanceState): void => { if (!stopped) onState(state); };

  tell({ name: 'connecting' });

  let wallet: RunningUnshieldedWallet | null = null;
  let subscription: { unsubscribe(): void } | null = null;
  let numberShown = false;
  try {
    wallet = unshieldedWalletFor(identity, account);
    subscription = wallet.state.subscribe({
      next: (state) => {
        const progress = state.progress;
        if (progress.isConnected && progress.isStrictlyComplete()) {
          numberShown = true;
          tell({
            name: 'synced',
            night: state.balances[NIGHT_UNSHIELDED_RAW] ?? 0n,
            asOf: Date.now(),
          });
          return;
        }
        if (numberShown) return; /* the established number stands */
        if (!progress.isConnected) {
          tell({ name: 'connecting' });
          return;
        }
        /* The unshielded progress names its numbers differently: applied
         * TRANSACTION id and the highest the indexer has reported. */
        tell({ name: 'syncing', applied: progress.appliedId, highest: progress.highestTransactionId });
      },
      error: (e: unknown) => {
        if (!numberShown) tell({ name: 'failed', message: describeFailure(e) });
      },
    });
    wallet.start().catch((e: unknown) => {
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

/** The engine the app runs — on the same clock as the shielded one. */
export const startUnshieldedBalance: BalanceEngine = withOwnClock(startUnshieldedRaw);
