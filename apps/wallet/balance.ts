import { ShieldedWallet } from '@midnightntwrk/wallet-sdk/shielded';
import type {
  ShieldedWallet as RunningShieldedWallet, ShieldedWalletClass,
} from '@midnightntwrk/wallet-sdk/shielded';
import { NoOpTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk';
import { ZswapSecretKeys, shieldedToken } from '@midnightntwrk/ledger-v9';
import type { Identity } from 'midnight-identity';
import { INDEXER_HTTP_URL, INDEXER_WS_URL, NETWORK } from './config.js';
import { loadWalletCheckpoint, saveWalletCheckpoint } from './storage.js';
import { openWalletId } from './wallets-held.js';
import { isWalletAccount } from './subwallets.js';
import { describeFailure } from './failure-text.js';

/**
 * THE WALLET LEARNS WHAT IT HOLDS.
 *
 * Everything here is the SDK's own wallet doing what it already does: sync
 * from the indexer, decrypt locally, report balances, serialise and restore
 * its own state. This file only WIRES it — chooses the door, the endpoints,
 * the checkpoints and the sentences. Nothing in it re-implements syncing,
 * coin tracking or balance arithmetic, which is the first rule.
 *
 * THE DOOR IS THE WHOLE FILE — §1.1. `startWithSeed(bytes)` feeds the
 * bytes STRAIGHT into `ZswapSecretKeys.fromSeed`: no HD derivation, no
 * account, no role — a keypair at no path at all, which is a different
 * wallet from any this app displays. The correct door takes the HD-derived
 * key for the OPEN account: `moneyAt(account).zswap`, the same thirty-two
 * bytes `addressFor` builds the address card from. Get this wrong and the
 * wallet syncs a keypair whose address is never displayed, every subwallet
 * reads zero for ever, and money sits somewhere the interface cannot see.
 * `balance.test.tsx` pins it by asserting the address the wallet itself
 * reports equals the address `addressFor` produces for the same account —
 * per account, byte for byte, for the cold door and the restore door both.
 *
 * PRIVACY, STATED (§1.2 and §7.16): syncing sends the
 * indexer an event number, never a key — decryption is local, and a live
 * probe measured the wire: the viewing key appeared on no request and no
 * frame. The indexer's schema does offer Connect-with-a-viewing-key, which
 * would let its operator read every payment this wallet ever makes; no SDK
 * code path this app uses calls it, the tripwire in `balance.test.tsx`
 * fails if the string enters this repository's CODE (comments are stripped
 * first: the old allowlist exempted exactly the file the offending
 * call would be written in), and the browser probe fails if it ever
 * appears on the wire. What the indexer does learn is the fact of being
 * asked — which is why nothing here runs until the person presses "Check
 * the balance", and why the footer names the host.
 */

/**
 * WHAT THE INTERFACE MAY SAY ABOUT MONEY — §4. Zero and "I do not
 * know" are different sentences, and confusing them is the worst thing this
 * feature can do: a wallet that prints 0 because the indexer was down tells
 * somebody their money is gone. So the states are explicit, `synced` is the
 * ONLY state carrying a number, and it carries the moment it was true of —
 * which is also how a restored checkpoint stays honest: it renders as a
 * number WITH ITS OLD MOMENT, never as a fresh fact.
 */
export type BalanceState =
  /** Starting, and the indexer has not answered. `quietMs` is set by the
   * wallet's own clock once the silence has gone on long enough to
   * say so out loud. */
  | { readonly name: 'connecting'; readonly quietMs?: number }
  /** Events are arriving; the balance is not yet a fact. */
  | { readonly name: 'syncing'; readonly applied: bigint; readonly highest: bigint }
  /** Established at `asOf` — freshly, or from a sealed checkpoint. */
  | { readonly name: 'synced'; readonly night: bigint; readonly asOf: number }
  /** The indexer could not be reached or the sync died. NOT a zero. */
  | { readonly name: 'failed'; readonly message: string };

export type StopBalance = () => void;

/**
 * Starts reading one wallet's balance and reports every state change.
 * Returns the way to stop — switching wallets or leaving the screen must
 * stop the sync, so at most one wallet is ever syncing live and it is the
 * one on screen.
 */
export type BalanceEngine = (
  identity: Identity, account: number, onState: (state: BalanceState) => void,
) => StopBalance;

/** The HD-derived shielded key for one account — the RIGHT thirty-two bytes. */
export const secretKeysFor = (identity: Identity, account: number): ZswapSecretKeys =>
  ZswapSecretKeys.fromSeed(identity.moneyAt(account).zswap);

/** The public name a checkpoint is filed under: the account's own coin
 * public key, so another wallet's cache can never dress this one. */
export const coinPublicKeyOf = (identity: Identity, account: number): string =>
  secretKeysFor(identity, account).coinPublicKey;

const guardAccount = (account: number): void => {
  /* The same wall `ownedAddressFor` holds for display: never sync a slot the
   * picker cannot show — money observed by a wallet the interface cannot
   * open is §2.3's invisible-money trap wearing a sync job. Account 1 is
   * refused one call deeper by `moneyAt` as well. */
  if (!isWalletAccount(account)) {
    throw new Error(`account ${account} is not a wallet this interface offers`
      + (account === 1 ? ' — account 1 is the authority compartment, never a wallet.' : '.'));
  }
};

const configuredWallet = (): ShieldedWalletClass => ShieldedWallet({
  networkId: NETWORK,
  indexerClientConnection: {
    indexerHttpUrl: INDEXER_HTTP_URL,
    indexerWsUrl: INDEXER_WS_URL,
  },
  /* History is later work; the configuration merely requires that a storage
   * exists. A no-op keeps every fact about payments out of every store
   * until history is actually built and audited. */
  txHistoryStorage: new NoOpTransactionHistoryStorage(),
});

/**
 * The SDK's shielded wallet for ONE of this identity's accounts, through the
 * right door, cold. Exported so the address-agreement test and the probe
 * exercise exactly what the app runs, not a copy of it.
 */
export function walletFor(identity: Identity, account: number): RunningShieldedWallet {
  guardAccount(account);
  return configuredWallet().startWithSecretKeys(secretKeysFor(identity, account));
}

/** The same wallet, warmed from a sealed checkpoint — `restore` is the
 * SDK's own; syncing then reads only the delta since the snapshot. */
export function walletRestoredFrom(serialized: string): RunningShieldedWallet {
  return configuredWallet().restore(serialized);
}

/** The shielded native token — tNIGHT — as the balances record keys it. */
const NIGHT_RAW = shieldedToken().raw;

/**
 * The raw engine: checkpoint-first, then the SDK wallet's own state stream,
 * translated into the sentences above; never invents a number.
 *
 * ONCE A NUMBER IS ON SCREEN IT STANDS UNTIL A FRESHER ONE REPLACES IT. A
 * checkpoint renders immediately with its OLD `asOf` — that is what keeps
 * it honest — and the reconnect that follows must not overwrite an
 * established number with "asking…": the moment on the number already says
 * how stale it is, and a fresher `synced` is the only upgrade.
 */
const startBalanceRaw: BalanceEngine = (identity, account, onState) => {
  let stopped = false;
  const tell = (state: BalanceState): void => { if (!stopped) onState(state); };

  /**
   * **WHICH WALLET THIS ENGINE BELONGS TO, DECIDED HERE AND NOWHERE ELSE.**
   *
   * This line is synchronous and runs at the moment the engine starts, which
   * is the moment a person is looking at this wallet. Everything below it is
   * asynchronous: a checkpoint read, a connection to the indexer, and a
   * subscription that goes on firing for as long as the engine lives.
   *
   * `saveWalletCheckpoint` used to take the compartment from a default
   * argument, `openWalletId()`, and a default argument is evaluated WHERE THE
   * CALL RUNS. The call runs inside `subscribe`'s `next`, which fires when a
   * sync completes — after the person may have turned to another wallet. The
   * checkpoint computed for THIS identity was then written into whatever
   * compartment was open when it arrived: this wallet's map of its money in
   * somebody else's compartment, evicting the entry that belonged there, and
   * surviving a removal of the wallet it actually describes.
   *
   * **The identity below is fixed for the life of this engine, and so is
   * this.** They are the same fact and they are captured in the same breath.
   */
  const walletId = openWalletId();

  tell({ name: 'connecting' });

  let wallet: RunningShieldedWallet | null = null;
  let subscription: { unsubscribe(): void } | null = null;
  let numberShown = false;

  void (async (): Promise<void> => {
    const coinPublicKey = coinPublicKeyOf(identity, account);
    const checkpoint = await loadWalletCheckpoint(coinPublicKey, account, walletId);
    if (stopped) return;
    if (checkpoint) {
      numberShown = true;
      tell({ name: 'synced', night: checkpoint.night, asOf: checkpoint.asOf });
    }
    try {
      try {
        wallet = checkpoint
          ? walletRestoredFrom(checkpoint.serialized)
          : walletFor(identity, account);
      } catch {
        /* A checkpoint the SDK refuses (a version drift, a bad blob) is a
         * cache miss, never a dead end: fall back to the cold door. */
        wallet = walletFor(identity, account);
      }
      subscription = wallet.state.subscribe({
        next: (state) => {
          const progress = state.progress;
          if (progress.isConnected && progress.isStrictlyComplete()) {
            numberShown = true;
            const night = state.balances[NIGHT_RAW] ?? 0n;
            const asOf = Date.now();
            tell({ name: 'synced', night, asOf });
            /* The checkpoint that makes the NEXT open cheap — sealed, and a
             * failure to write is a failure to cache, nothing more. */
            try {
              void saveWalletCheckpoint(coinPublicKey, account, {
                serialized: state.serialize(), night, asOf,
              }, walletId).catch(() => {});
            } catch { /* serialisation refused; the next sync tries again */ }
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
      wallet.start(secretKeysFor(identity, account)).catch((e: unknown) => {
        if (!numberShown) tell({ name: 'failed', message: describeFailure(e) });
      });
    } catch (e) {
      if (!numberShown) tell({ name: 'failed', message: describeFailure(e) });
    }
  })();

  return () => {
    stopped = true;
    subscription?.unsubscribe();
    void wallet?.stop().catch(() => { /* already stopping is fine */ });
  };
};

/** When the silence gets said out loud, and when the wallet gives up. */
export const QUIET_AFTER_MS = 10_000;
export const GIVE_UP_AFTER_MS = 45_000;

/**
 * THE WALLET'S OWN CLOCK. A probe measured the reason this
 * exists: 150 seconds of refused connections produced no error on the SDK's
 * state stream — the socket does not report its own death, so the best
 * sentence in the interface ("it is not a zero") sat on a screen nobody
 * could reach. The clock runs while the engine has said nothing but
 * "connecting": after `quietMs` it says out loud that nothing has answered,
 * and after `giveUpMs` it stops the sync itself and gives up into the
 * failed state that already says the right thing. Any other state — a
 * number, progress, a real error — disarms it: the thing being guarded
 * against is exactly and only the silence.
 */
export function withOwnClock(
  engine: BalanceEngine,
  quietMs: number = QUIET_AFTER_MS,
  giveUpMs: number = GIVE_UP_AFTER_MS,
): BalanceEngine {
  return (identity, account, onState) => {
    let onlySilence = true;
    let gaveUp = false;
    let quietSaid = false;
    const quietTimer = setTimeout(() => {
      if (onlySilence && !gaveUp) {
        quietSaid = true;
        onState({ name: 'connecting', quietMs });
      }
    }, quietMs);
    const giveUpTimer = setTimeout(() => {
      if (!onlySilence || gaveUp) return;
      gaveUp = true;
      stopInner();
      onState({
        name: 'failed',
        message: `nothing answered in ${Math.round(giveUpMs / 1000)} seconds — the wallet `
          + 'stopped waiting. The indexer never spoke; the connection is the thing that '
          + 'failed.',
      });
    }, giveUpMs);
    const disarm = (): void => {
      onlySilence = false;
      clearTimeout(quietTimer);
      clearTimeout(giveUpTimer);
    };
    const stopInner = engine(identity, account, (state) => {
      if (gaveUp) return;
      if (state.name !== 'connecting') disarm();
      /* Once the silence has been said out loud, a bare "connecting" from
       * the engine must not quietly unsay it. */
      if (state.name === 'connecting' && quietSaid) {
        onState({ name: 'connecting', quietMs });
        return;
      }
      onState(state);
    });
    return () => {
      disarm();
      gaveUp = true;
      stopInner();
    };
  };
}

/** The engine the app runs: checkpoint-first sync, on the wallet's own clock. */
export const startBalance: BalanceEngine = withOwnClock(startBalanceRaw);

/* The seam the screens read the engines from lives in `balance-context.ts`
 * — it carries this engine AND the unshielded one, and importing it
 * from here would be a cycle. */
