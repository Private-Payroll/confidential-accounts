/**
 * Bringing a wallet up, in one place.
 *
 * WHY THIS EXISTS. `sponsor-test.ts` failed four times running, and every
 * failure was the same shape: it hand-wrote a step that `run-preview.ts`
 * already performed correctly. The config shape, how state arrives, how the two
 * balances are read, and finally the one that mattered —
 *
 *     await wallet.start(false);
 *
 * — which was simply never called, so the wallet was built and never began
 * syncing. It reported DUST from its cache and NIGHT 0 forever, waited out a
 * three-minute sync gate that could never pass, and had its dust proof rejected
 * by the node as `170 InvalidDustSpendProof`.
 *
 * One procedure, written twice, and the second copy missing a line. The
 * answer is not to be more careful. It is for there to be one copy.
 *
 * `false` is load bearing. `start(true)` uses the testkit's own sync gate,
 * which gates on `isStrictlyComplete()` against the last highest id the wallet
 * was sent, and it is reached through `waitForFunds`, which can hit the faucet
 * and submit a dust registration — a SPEND, taken by a bring-up on nobody's
 * instruction.
 */
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import type { NetworkName } from '../src/midnight/network.js';
import {
  buildWalletWithDust,
  facadeAtLedger9,
  registrationSidesSynced,
  dustCachePath,
  waitForDustAtTip,
  networkHeightAt,
  dustIndexerHttpOf,
  describeDustView,
  type AtTipOptions,
  type AtTipOutcome,
  type WalletWithDust
} from './dust-wallet.js';
import { floorKnownAbsent } from './dust-fee-floor.js';
import { waitForShieldedScan, type ShieldedWaitOutcome } from './shielded-wallet.js';
import { rmSync } from 'node:fs';
import { sleep } from '../src/midnight/retry.js';
import { registerNightForDust } from '../src/midnight/dust-registration.js';
import { withTimeout } from './deploy-report.js';
import { loggerWithoutSecret } from './logger-without-secret.js';

export interface LiveWallet {
  /**
   * The testkit's wallet provider, once started. A getter: a cache retry replaces it. Typed, so a call into the
   * wallet facade inside it is checked against the facade's own signatures.
   */
  readonly wallet: MidnightWalletProvider;
  /** The most recent state from the subscription. Null until the first arrives. */
  state(): any;
  /** DUST available now. A method, not a field: dust accrues over time. */
  dust(): bigint;
  /** NIGHT held, read from the balances map by token id. */
  night(): bigint;
  /** Every sub-wallet within ten blocks of the tip. */
  synced(): boolean;
  /**
   * What the shielded wait concluded, or null when this bring-up was not asked
   * to wait for one. A door that reads shielded coins needs it to tell *the
   * scan has not caught up* from *there is no such coin*.
   */
  shieldedScan(): ShieldedWaitOutcome | null;
  stop(): void;
}

/** Within a small gap, not strictly equal: a live chain keeps producing blocks. */
const complete = (p: any): boolean => {
  try {
    if (typeof p?.isCompleteWithin === 'function') return !!p.isCompleteWithin(10n);
  } catch {
    /* fall through */
  }
  const a = p?.appliedIndex ?? p?.appliedId;
  const h = p?.highestRelevantIndex ?? p?.highestIndex ?? p?.highestTransactionId;
  if (a == null || h == null) return false;
  return BigInt(a) + 10n >= BigInt(h);
};

const progresses = (st: any): any[] => {
  const out: any[] = [];
  for (const p of [
    st?.unshielded?.progress ?? st?.unshielded?.state?.progress,
    st?.shielded?.state?.progress ?? st?.shielded?.progress,
    st?.dust?.state?.progress ?? st?.dust?.progress
  ])
    if (p && typeof p === 'object') out.push(p);
  return out;
};

export interface BringUpOptions {
  /** Install the cached dust sub-wallet. Skip for a wallet that has no funds. */
  withDust?: boolean;
  /** How long to wait when the dust state came from cache. Default 2 minutes. */
  cachedTimeoutMs?: number;
  /** How long to wait when syncing from genesis. Default 12 minutes — it measured 284s. */
  coldTimeoutMs?: number;
  /**
   * Throw when DUST never arrives, rather than returning a wallet that cannot
   * pay. On for anything that will submit; off for a wallet expected to be
   * empty.
   */
  requireDust?: boolean;
  /**
   * **WAIT FOR THE SHIELDED SCAN TOO, AND IT IS OFF BY DEFAULT ON PURPOSE.**
   *
   * The dust catch-up below is unconditional because every door that SUBMITS
   * needs it. This one is not: only a door that spends or
   * reads a SHIELDED coin needs the shielded scan to have caught up. The
   * shielded state is cached beside the DUST state (`buildWalletWithDust`), but
   * with no cache, or one too old to use, the scan runs from genesis. Waiting
   * for it in every caller would put that replay in front of every deploy and
   * every measurement door, none of which touch a shielded coin — a cost paid
   * by doors that cannot benefit from it.
   *
   * So the DECISION is the caller's and the IMPLEMENTATION is not: there is one
   * wait, in `shielded-wallet.ts`, and no door may write a second.
   */
  withShielded?: boolean;
  /** Overrides the shielded deadline. See `SHIELDED_SCAN_TIMEOUT_MS` — it is not a measurement. */
  shieldedTimeoutMs?: number;
  /** Overrides how long the DUST view may stand still, and wait in all, before it counts as behind. */
  atTip?: AtTipOptions;
  onNote?: (message: string) => void;
}

/**
 * **WAITS UNTIL A LIVE WALLET'S DUST VIEW HAS APPLIED EVERY EVENT THE INDEXER
 * HOLDS NOW**, reading the indexer the installed DUST wallet syncs from.
 * Answers where it stood; the caller decides whether a view short of the
 * network may go on. Called by the bring-up, and again by a launcher just
 * before it says it is ready.
 */
export async function dustViewAtTip(
  live: Pick<LiveWallet, 'wallet' | 'state'>,
  note: (s: string) => void,
  options: AtTipOptions = {}
): Promise<AtTipOutcome> {
  const http = dustIndexerHttpOf(live.wallet?.wallet?.dust);
  if (http === null)
    return { ok: false, why: "the installed DUST wallet names no indexer to read the network's newest block from" };
  return waitForDustAtTip(live, () => networkHeightAt(http), note, options);
}

/**
 * Builds the wallet with our DUST wallet and its fee floor in it, and stops the run when the floor is known not to be
 * in force.
 */
async function walletWithOurDust(
  logger: unknown,
  cfg: unknown,
  seed: string,
  network: NetworkName,
  root: string,
  note: (s: string) => void
): Promise<WalletWithDust> {
  const built = await buildWalletWithDust(loggerWithoutSecret(logger as any, seed), cfg as any, seed, network, root, {
    note
  });
  const installed = built.installed;
  note(`dust wallet ${installed.how} — ${installed.detail}`);
  /*
   * WHICH OUTCOMES STOP THE RUN, AND WHY IT IS NOT ALL OF THEM.
   *
   * 'refused' with a floor that disagrees is the state where the wallet is
   * KNOWN not to carry the floor, and it stops. A wallet without our DUST
   * wallet at all is never built: the builder throws.
   *
   * A floor that merely could not be READ BACK is different and must not
   * stop anything. The failure it points at is free and loud: a submission
   * refused with no fee taken. The failure a throw creates is that every
   * money door in this project stops working because a library renamed a
   * field. So that case is said as loudly as a refusal and the run goes on.
   */
  if (installed.how === 'refused' && floorKnownAbsent(installed.reason ?? 'unreadable')) {
    try {
      await built.wallet.stop?.();
    } catch {
      /* nothing useful to do */
    }
    throw new Error(
      `the dust wallet set-up did not complete with a fee floor in force: ${installed.detail}\n` +
        '  A fee that can come out at nothing selects no dust coin, and a transaction carrying\n' +
        '  no dust spend is refused by the node as malformed.\n' +
        '  Nothing has been submitted and nothing is at risk. This is a defect in the wallet\n' +
        '  set-up rather than a chain or funding problem, and re-running will not clear it.'
    );
  }
  if (installed.how === 'refused') {
    note('\x1b[33mthe fee floor could not be read back off the wallet, so nothing here can say');
    note('whether it is in force. Going on: if this fails at submission, that is why.\x1b[0m');
  }
  return built;
}

/**
 * **A WALLET WITH NO DUST REGISTERS ITS OWN NIGHT FOR DUST GENERATION, HERE.**
 * Once the wallet has synced (within `bound` ms), a wallet holding no DUST has
 * each of its own NIGHT coins not yet registered registered through the one
 * registration (`registerNightForDust`), which estimates the fee, waits for the
 * coins to have generated it, and names this wallet's own DUST address as the
 * receiver. The NIGHT stays this wallet's: a registration moves no money. A
 * wallet that holds DUST, or has no NIGHT left to register, registers nothing.
 */
async function registerOwnNightWhenNoDust(
  provider: MidnightWalletProvider,
  forkV9: bigint,
  bound: number,
  note: (s: string) => void
): Promise<void> {
  const sides = () => registrationSidesSynced(provider.wallet, forkV9, note);
  const synced = await withTimeout('the wallet syncing before its NIGHT is registered for DUST', bound, sides());
  if (synced.dust.balance(new Date()) > 0n) return;
  const done = await registerNightForDust(
    provider.wallet,
    {
      verifyingKey: provider.unshieldedKeystore.getPublicKey(),
      sign: (payload) => provider.unshieldedKeystore.signDataAsync(payload)
    },
    {
      send: async (recipe) =>
        String(await provider.wallet.submitTransaction(await provider.wallet.finalizeRecipe(recipe))),
      synced: async () => synced
    }
  );
  if ('transaction' in done) {
    note(
      `no DUST, so ${done.registered} of this wallet's own NIGHT coin(s) were registered for DUST generation ` +
        `(fee ${done.fee}, transaction ${done.transaction.slice(0, 24)}…)`
    );
  }
}

/**
 * Why a wallet that must pay still has no DUST at the deadline, naming the cause that fits what it holds: no NIGHT
 * means nothing could be registered to generate DUST; NIGHT means it is registered (here, if it was not already) and
 * the DUST view did not catch up.
 */
export function noDustAfterTheDeadline(night: bigint): string {
  if (night === 0n) {
    return (
      'the wallet still reports no DUST after the full deadline, and it holds no NIGHT.\n' +
      '  DUST is generated by registered NIGHT, so with none there is nothing to register and nothing to pay with.\n' +
      "  What resolves it: send NIGHT to this wallet's address, then start again; it registers that NIGHT itself."
    );
  }
  return (
    'the dust wallet still reports no DUST after the full deadline.\n' +
    `  It holds ${night} NIGHT, registered for DUST generation (here, if it was not already), so a balance should exist.\n` +
    '  This is most likely the dust wallet failing to sync rather than missing DUST.'
  );
}

/** Waits up to `bound` ms for the wallet to report a DUST balance, saying how it goes every ten seconds. */
async function waitForTheDust(
  live: LiveWallet,
  bound: number,
  note: (s: string) => void
): Promise<{ timedOut: boolean; waited: number }> {
  const startedAt = Date.now();
  let printed = 0;
  let timedOut = false;
  while (live.dust() === 0n) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > bound) {
      timedOut = true;
      break;
    }
    if (elapsed - printed >= 10_000) {
      printed = elapsed;
      note(`  ${String(Math.round(elapsed / 1000)).padStart(3)}s  NIGHT ${live.night()}  DUST ${live.dust()}`);
    }
    await sleep(1_000);
  }
  const waited = Math.round((Date.now() - startedAt) / 1000);
  return { timedOut, waited };
}

/** Waits for the DUST view to reach the network's tip, and refuses a wallet that will pay when it does not. */
async function dustViewCaughtUp(
  live: LiveWallet,
  wallet: any,
  options: BringUpOptions,
  note: (s: string) => void
): Promise<void> {
  const at = await dustViewAtTip(live, note, options.atTip);
  if (!('why' in at)) {
    note(`dust wallet caught up: ${describeDustView(at.applied, at.tip)}`);
  } else if (options.requireDust) {
    live.stop();
    try {
      await wallet.stop?.();
    } catch {
      /* the refusal below is what matters */
    }
    throw new Error(
      `${at.why}.\n` +
        '  A fee paid from a view behind the network can be refused by the node, so this wallet is not\n' +
        '  handed on. Nothing has been submitted and nothing is at risk. Start again; if it stops at the\n' +
        "  same place, the indexer or this machine's connection to it is where to look."
    );
  } else {
    note(`\x1b[33m${at.why}; anything this wallet pays may be refused (error 170)\x1b[0m`);
  }
}

/**
 * Build, start, subscribe, and wait until the wallet can actually be used.
 *
 * The order is not arbitrary and was arrived at by failure: the dust wallet is
 * installed BEFORE `start`, because starting first begins a sync the restored
 * state then has to be reconciled against; and the subscription comes AFTER
 * `start`, because a subscription to a wallet that was never started delivers
 * a state that never changes — which reads exactly like a slow network.
 */
export async function bringUpWallet(
  logger: unknown,
  cfg: unknown,
  seed: string,
  network: NetworkName,
  root: string,
  options: BringUpOptions = {}
): Promise<LiveWallet> {
  const note = options.onNote ?? (() => {});
  const { unshieldedToken } = await import('@midnight-ntwrk/midnight-js-protocol/v9');
  const NIGHT = (unshieldedToken() as any).raw;

  let wallet: any = null;
  let latest: any = null;
  let sub: any = null;
  let usedCache = false;
  let forkV9 = 0n;
  let waited = 0;
  let shieldedOutcome: ShieldedWaitOutcome | null = null;

  const live: LiveWallet = {
    get wallet() {
      return wallet;
    },
    state: () => latest,
    dust: () => {
      try {
        return BigInt(latest?.dust?.balance(new Date()) ?? 0n);
      } catch {
        return 0n;
      }
    },
    night: () => BigInt(latest?.unshielded?.balances?.[NIGHT] ?? 0n),
    synced: () => {
      const found = progresses(latest);
      return found.length > 0 && found.every(complete);
    },
    shieldedScan: () => shieldedOutcome,
    stop: () => {
      try {
        sub?.unsubscribe?.();
      } catch {
        /* already gone */
      }
    }
  } as LiveWallet;

  const waitForShielded = () =>
    waitForShieldedScan(live, note, {
      ...(options.shieldedTimeoutMs === undefined ? {} : { timeoutMs: options.shieldedTimeoutMs })
    });

  /*
   * THE RETRY EXISTS FOR THE CACHE, not for the network.
   *
   * The dust sub-wallet has no persistence of its own, so a cold start replays
   * the chain from genesis — measured at 284 seconds, every run, on work that
   * has nothing to do with what is being tested. The cache removes that, and
   * the risk it introduces is a cache that no longer matches the chain: the
   * wallet then sits at zero DUST forever, looking like a slow network.
   *
   * So a restored wallet gets a short deadline and, if it misses, the cache is
   * discarded and the whole bring-up runs again cold. The cache is the only
   * thing that changed, so the cache is the suspect.
   */
  for (let attempt = 1; ; attempt++) {
    usedCache = false;
    forkV9 = 0n;
    /*
     * EVERY ATTEMPT, NOT ONLY THE FIRST.
     *
     * This read `attempt === 1`. The retry exists for a cache that misbehaved,
     * and it builds a whole new wallet — so on attempt 2 the swap never
     * happened, the fee floor was never installed, nothing said so, and the run
     * went on to submit with the library's own wallet and its overhead of
     * nothing. The path fired precisely when the cache had already proved
     * untrustworthy. The cache is skipped on a retry; the floor is not.
     */
    if (options.withDust !== false) {
      const built = await walletWithOurDust(logger, cfg, seed, network, root, note);
      wallet = built.wallet;
      usedCache = built.installed.how === 'restored';
      forkV9 = built.forkV9;
    } else {
      // A wallet that will not pay still gets our DUST wallet: the facade reads its version from the wallets it is
      // built with, and the testkit's unstarted DUST wallet would hold it at ledger 8.
      const built = await buildWalletWithDust(
        loggerWithoutSecret(logger as any, seed),
        cfg as any,
        seed,
        network,
        root,
        { note }
      );
      wallet = built.wallet;
      forkV9 = built.forkV9;
    }

    // THE LINE THAT WAS MISSING for four runs. Without it nothing syncs, ever.
    // `false` and never `true`: `start(true)` reaches `waitForFunds`, which can
    // hit the faucet and SUBMIT. See the header.
    await wallet.start(false);
    // Nothing is written before the facade writes for ledger 9: a restored shielded wallet is there at once, a
    // fresh one only once its replay crosses the fork.
    await facadeAtLedger9(wallet.wallet, forkV9, note);

    latest = null;
    sub = wallet.wallet.state().subscribe({ next: (st: any) => (latest = st) });

    if (options.withDust === false) {
      if (options.withShielded) shieldedOutcome = await waitForShielded();
      return live;
    }

    /* A restored wallet catches up only what happened since it was saved, but through a provider's indexer that has
     * taken longer than two minutes (15 Nov, preprod, a state 97 minutes old); waiting sends nothing, so it waits longer. */
    const bound = usedCache ? (options.cachedTimeoutMs ?? 8 * 60_000) : (options.coldTimeoutMs ?? 12 * 60_000);
    note(
      usedCache
        ? 'catching the restored dust wallet up to the tip'
        : 'waiting for the dust wallet to sync from genesis (this is the ~5 minutes)'
    );

    await registerOwnNightWhenNoDust(wallet, forkV9, bound, note);
    const dust = await waitForTheDust(live, bound, note);
    const timedOut = dust.timedOut;
    waited = dust.waited;

    if (!timedOut) break;

    if (usedCache) {
      note(
        '  the restored wallet did not reach a DUST balance in time — discarding the cache and syncing from scratch'
      );
      try {
        rmSync(dustCachePath(root, network, seed), { force: true });
      } catch {
        /* it may already be gone */
      }
      live.stop();
      try {
        await wallet.stop?.();
      } catch {
        /* nothing useful to do */
      }
      continue;
    }

    live.stop();
    if (options.requireDust) throw new Error(noDustAfterTheDeadline(live.night()));
    note(
      `no DUST after ${waited}s — a transaction it pays for carries no DUST spend and is refused (BalanceCheckOverspend, 138)`
    );
    break;
  }

  note(`wallet ready after ${waited}s — NIGHT ${live.night()}, DUST ${live.dust()}`);

  /*
   * A DUST BALANCE IS NOT A SYNCED DUST WALLET, AND THE WAIT LIVES HERE SO NO
   * CALLER CAN OMIT IT.
   *
   * The loop above waits for a BALANCE. A spend proof built from a dust view
   * that has a balance and has not applied every DUST event the network holds
   * can be rejected by the node as `1010: Invalid Transaction: Custom error:
   * 170`. So the view is waited for against the indexer, strictly, while it
   * moves. A wallet that will pay (`requireDust`) and does not get there is
   * not handed back: the run stops here rather than say it is ready with a
   * view behind the network. Any other wallet is handed back with a warning.
   */
  if (options.withDust) await dustViewCaughtUp(live, wallet, options, note);

  /*
   * **AND THE SHIELDED SCAN, WHICH THE DUST CACHE MADE WORSE RATHER THAN
   * BETTER.**
   *
   * The loops above wait for DUST. Nothing anywhere waited for the shielded
   * sub-wallet, and the faster this function returns the less the shielded scan
   * has done: a deposit door refused twice on 30 August with `the
   * wallet holds 0 of that colour`, two lines under `wallet ready after 1s`,
   * against a wallet that had held ten trillion of it minutes earlier.
   *
   * A rule that lives at a call site protects that call site and nothing else.
   * The wait is one function and it is reached from here.
   */
  if (options.withShielded) shieldedOutcome = await waitForShielded();

  return live;
}
