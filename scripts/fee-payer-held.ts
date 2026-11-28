/**
 * THE FEE PAYER'S WALLET, HELD IN ONE PLACE AND BUILT AGAIN WHEN ITS DUST STOPS FOLLOWING THE CHAIN.
 *
 * The service pays fees from one wallet whose DUST part reads the chain in the background. When that reading fails in a
 * way the wallet does not retry, or the sponsor finds its view stuck behind the chain, every fee would be refused until
 * the service restarted. This holds the wallet behind one function: it watches the wallet's failures, builds the wallet
 * again in the background (from its last saved state, or from the chain itself when a second failure follows soon after
 * the first), and hands the new one over only between two payments, so no payment is balanced by one wallet and
 * finished by another. The wallet's own streams do not report a reading that has died, so its DUST height is also
 * read against the chain's, and a height left behind starts a rebuild. `feePayerHeldFrom` wires this to a wallet the
 * service brought up: how it is built again, where its state is saved, and where its DUST height is read. Nothing here
 * pays, signs or sends; it decides which wallet the sponsor reads.
 */
import { rmSync } from 'node:fs';

import { dustViewCovers } from '../src/midnight/sponsor.js';
import type { NetworkName } from '../src/midnight/network.js';
import { dustCachePath, saveWalletState } from './dust-wallet.js';
import { feePayerViewOf } from './funded-wallets.js';
import type { LiveWallet } from './wallet-bringup.js';

/** The parts of a running wallet the sponsor uses: the provider, its facade, and its two balances. */
export interface HeldParts {
  readonly provider: any;
  readonly facade: any;
  dust(): bigint;
  night(): bigint;
  stop?(): void;
}

export interface FeePayerHolder {
  /** The wallet every payment is made with until the next hand-over. */
  current(): HeldParts;
  /** Starts building the wallet again in the background, once; a second call while one is building does nothing. */
  recover(why: string): void;
  /**
   * Hands over a wallet built since the last payment, if there is one, and answers it; null when there was none.
   * Called only between two payments.
   */
  settle(): HeldParts | null;
  /** Saves the current wallet's state, so a restart of the service starts from it; never while a rebuild is under way. */
  save(): Promise<void>;
  /**
   * Reads the wallet's DUST height against the chain's every `everyMs`; a height that stays below the chain's for
   * `STUCK_MS` starts a rebuild. The wallet's own streams do not report a reading that has died, so this is what does.
   */
  watchHeight(
    read: () => Promise<{ readonly applied: bigint | null; readonly tip: bigint }>,
    everyMs?: number
  ): () => void;
}

export interface HolderDeps {
  /** Builds the wallet again; `fromTheChain` discards its saved state first. */
  readonly rebuild: (fromTheChain: boolean) => Promise<HeldParts>;
  readonly save: (parts: HeldParts) => Promise<unknown>;
  readonly note: (line: string) => void;
  readonly now?: () => number;
}

/** A failure this soon after the last rebuild means the saved state fails the same way, so the next rebuild reads the chain. */
export const AGAIN_SOON_MS = 30 * 60_000;

/** How long the wallet's DUST height may stay below the chain's, without moving, before the wallet is built again. */
export const STUCK_MS = 5 * 60_000;

const say = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 200);

/** Holds the fee payer's wallet; `first` is the wallet the service brought up. */
export function feePayerHeld(first: HeldParts, deps: HolderDeps): FeePayerHolder {
  const now = deps.now ?? Date.now;
  let current = first;
  let built: HeldParts | null = null;
  let building: Promise<void> | null = null;
  let lastRebuiltAt: number | null = null;
  let saving: Promise<void> = Promise.resolve();
  const watches: Array<{ unsubscribe(): void }> = [];

  const holder: FeePayerHolder = {
    current: () => current,
    recover: (why) => {
      if (building !== null || built !== null) return;
      const fromTheChain = lastRebuiltAt !== null && now() - lastRebuiltAt < AGAIN_SOON_MS;
      deps.note(
        `building the fee payer's wallet again ${fromTheChain ? 'from the chain' : 'from its saved state'}: ${why}`
      );
      building = (async () => {
        try {
          const next = await deps.rebuild(fromTheChain);
          lastRebuiltAt = now();
          built = next;
          deps.note("the fee payer's wallet is built again; the next fee is paid with it");
        } catch (e) {
          lastRebuiltAt = now();
          deps.note(
            `building the fee payer's wallet again failed (${say(e)}); the next failure tries again, reading the chain itself`
          );
        }
      })().finally(() => {
        building = null;
      });
    },
    settle: () => {
      if (built === null) return null;
      const old = current;
      current = built;
      built = null;
      watch(current);
      try {
        old.stop?.();
      } catch {
        /* the old wallet is already being let go; its own stop failing changes nothing here */
      }
      void holder.save();
      return current;
    },
    save: () => {
      if (building !== null || built !== null) return saving;
      const parts = current;
      saving = saving.then(async () => {
        try {
          await deps.save(parts);
        } catch (e) {
          deps.note(`the fee payer's state was not saved (${say(e)})`);
        }
      });
      return saving;
    },
    watchHeight: (read, everyMs = 60_000) => {
      let last: bigint | null = null;
      let since = now();
      const timer = setInterval(() => {
        void read().then(
          ({ applied, tip }) => {
            if (dustViewCovers(applied, tip)) {
              last = applied;
              since = now();
              return;
            }
            if (applied !== last) {
              last = applied;
              since = now();
              return;
            }
            if (now() - since >= STUCK_MS) {
              since = now();
              holder.recover(`its DUST height stayed at ${String(applied)} below the chain's ${String(tip)}`);
            }
          },
          () => {
            /* an indexer that does not answer says nothing about the wallet; the next reading asks again */
          }
        );
      }, everyMs);
      (timer as { unref?: () => void }).unref?.();
      return () => clearInterval(timer);
    }
  };

  function watch(parts: HeldParts): void {
    for (const w of watches.splice(0)) {
      try {
        w.unsubscribe();
      } catch {
        /* already closed */
      }
    }
    const failed = (part: string) => (e: unknown) => holder.recover(`its ${part} failed (${say(e)})`);
    const facadeState = parts.facade?.state?.();
    if (facadeState?.subscribe) watches.push(facadeState.subscribe({ next: () => {}, error: failed('wallet') }));
    const dustState = parts.facade?.dust?.state;
    if (dustState?.subscribe) watches.push(dustState.subscribe({ next: () => {}, error: failed('DUST part') }));
  }
  watch(current);
  return holder;
}

/** Where a wallet's state is kept on this machine: the seed it was brought up from, its network, and the repository. */
export interface HeldWalletStore {
  readonly seed: string;
  readonly network: NetworkName;
  readonly root: string;
}

/** The parts of a wallet the service brought up, as the holder keeps them; stopping them stops the wallet. */
const heldPartsOf = (live: LiveWallet): HeldParts => ({
  provider: live.wallet,
  facade: live.wallet.wallet,
  dust: () => live.dust(),
  night: () => live.night(),
  stop: () => {
    live.stop();
    void (live.wallet as any).stop?.().catch(() => undefined);
  }
});

/**
 * Holds the fee payer's wallet the service brought up (`first`): a rebuild brings it up again with `bringUp`, from the
 * chain itself by first dropping its saved DUST state; its state is saved where `store` names; and its DUST height is
 * read against the chain's from its own view.
 */
export function feePayerHeldFrom(
  first: LiveWallet,
  bringUp: () => Promise<LiveWallet>,
  store: HeldWalletStore,
  note: (line: string) => void
): FeePayerHolder {
  const holder = feePayerHeld(heldPartsOf(first), {
    rebuild: async (fromTheChain) => {
      if (fromTheChain) rmSync(dustCachePath(store.root, store.network, store.seed), { force: true });
      return heldPartsOf(await bringUp());
    },
    save: (parts) => saveWalletState(parts.provider, store.seed, store.network, store.root),
    note
  });
  holder.watchHeight(async () => {
    const view = feePayerViewOf(holder.current().facade);
    if (!view) throw new Error("the fee payer's wallet has no DUST view to read");
    const tip = await view.tip();
    return { applied: view.applied(), tip };
  });
  return holder;
}
