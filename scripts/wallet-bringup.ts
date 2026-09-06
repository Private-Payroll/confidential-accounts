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
 * That is the same failure as M-50/M-55/M-58/M-61/M-65 wearing a different
 * hat: one procedure, written twice, and the second copy missing a line. The
 * answer is not to be more careful. It is for there to be one copy.
 *
 * `false` is load bearing, and the reason recorded here for four rounds was
 * wrong. `start(true)` uses the testkit's own sync gate, and that gate DOES
 * return: `syncWallet` is bounded at 90 seconds and throws. **The reason not to
 * call it is stronger than the one that was written.** It gates on
 * `isStrictlyComplete()`, which asks a wallet to outrun a live chain;
 * and it is reached through `waitForFunds`, which can hit the faucet and submit
 * a dust registration — a SPEND, taken by a bring-up on nobody's instruction
 * (`CLAUDE.md` rule 2). Corrected by `S17`'s platform fact-check, which
 * read the testkit rather than this comment.
 */
import type { NetworkName } from '../src/midnight/network.js';
import { installDustWallet, dustCachePath, waitForDustCatchUp, dustCaughtUp, dustProgressOf } from './dust-wallet.js';
import { waitForShieldedScan, type ShieldedWaitOutcome } from './shielded-wallet.js';
import { rmSync } from 'node:fs';
import { sleep } from '../src/midnight/retry.js';

export interface LiveWallet {
  /** The provider, once started. A getter: a cache retry replaces it. */
  readonly wallet: any;
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
  try { if (typeof p?.isCompleteWithin === 'function') return !!p.isCompleteWithin(10n); } catch { /* fall through */ }
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
    st?.dust?.state?.progress ?? st?.dust?.progress,
  ]) if (p && typeof p === 'object') out.push(p);
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
   * needs it — `M-141`. This one is not: only a door that spends or
   * reads a SHIELDED coin needs the shielded scan, and there is no cache for it
   * here, so a scan runs from genesis every time it is asked for. Turning it on
   * for every caller would put a genesis replay in front of `DEPLOY-VAULT`,
   * `FUND-VAULT` and every measurement door, none of which touch a shielded
   * coin — a cost paid by doors that cannot benefit from it, on instruments a
   * session may not re-run.
   *
   * So the DECISION is the caller's and the IMPLEMENTATION is not: there is one
   * wait, in `shielded-wallet.ts`, and no door may write a second. That is the
   * half of `M-104` that actually bites.
   */
  withShielded?: boolean;
  /** Overrides the shielded deadline. See `SHIELDED_SCAN_TIMEOUT_MS` — it is not a measurement. */
  shieldedTimeoutMs?: number;
  onNote?: (message: string) => void;
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
  options: BringUpOptions = {},
): Promise<LiveWallet> {
  const note = options.onNote ?? (() => {});
  const { MidnightWalletProvider } = await import('@midnight-ntwrk/testkit-js');
  const { unshieldedToken } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  const NIGHT = (unshieldedToken() as any).raw;

  let wallet: any = null;
  let latest: any = null;
  let sub: any = null;
  let usedCache = false;
  let waited = 0;
  let shieldedOutcome: ShieldedWaitOutcome | null = null;

  const live: LiveWallet = {
    get wallet() { return wallet; },
    state: () => latest,
    dust: () => { try { return BigInt(latest?.dust?.balance(new Date()) ?? 0n); } catch { return 0n; } },
    night: () => BigInt(latest?.unshielded?.balances?.[NIGHT] ?? 0n),
    synced: () => {
      const found = progresses(latest);
      return found.length > 0 && found.every(complete);
    },
    shieldedScan: () => shieldedOutcome,
    stop: () => { try { sub?.unsubscribe?.(); } catch { /* already gone */ } },
  } as LiveWallet;

  const waitForShielded = () => waitForShieldedScan(live, note, {
    ...(options.shieldedTimeoutMs === undefined ? {} : { timeoutMs: options.shieldedTimeoutMs }),
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
    wallet = await MidnightWalletProvider.build(logger as any, cfg as any, seed);

    usedCache = false;
    if (options.withDust !== false && attempt === 1) {
      const installed = await installDustWallet(wallet, cfg as any, seed, network, root);
      usedCache = installed.how === 'restored';
      note(`dust wallet ${installed.how} — ${installed.detail}`);
    }

    // THE LINE THAT WAS MISSING for four runs. Without it nothing syncs, ever.
    // `false` and never `true`: `start(true)` reaches `waitForFunds`, which can
    // hit the faucet and SUBMIT. See the header — the older reason given here
    // ("M-22, does not return") was refuted by reading the testkit.
    await wallet.start(false);

    latest = null;
    sub = wallet.wallet.state().subscribe({ next: (st: any) => (latest = st) });

    if (options.withDust === false) {
      if (options.withShielded) shieldedOutcome = await waitForShielded();
      return live;
    }

    const bound = usedCache
      ? (options.cachedTimeoutMs ?? 2 * 60_000)
      : (options.coldTimeoutMs ?? 12 * 60_000);
    note(usedCache
      ? 'catching the restored dust wallet up to the tip'
      : 'waiting for the dust wallet to sync from genesis (this is the ~5 minutes)');

    const startedAt = Date.now();
    let printed = 0;
    let timedOut = false;
    while (live.dust() === 0n) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > bound) { timedOut = true; break; }
      if (elapsed - printed >= 10_000) {
        printed = elapsed;
        note(`  ${String(Math.round(elapsed / 1000)).padStart(3)}s  NIGHT ${live.night()}  DUST ${live.dust()}`);
      }
      await sleep(1_000);
    }
    waited = Math.round((Date.now() - startedAt) / 1000);

    if (!timedOut) break;

    if (usedCache) {
      note('  the restored wallet did not reach a DUST balance in time — discarding the cache and syncing from scratch');
      try { rmSync(dustCachePath(root, network, seed), { force: true }); } catch { /* it may already be gone */ }
      live.stop();
      try { await wallet.stop?.(); } catch { /* nothing useful to do */ }
      continue;
    }

    live.stop();
    if (options.requireDust) {
      throw new Error(
        'the dust wallet still reports no DUST after the full deadline.\n' +
          '  The NIGHT was registered during the deploy, so the balance should exist.\n' +
          '  This is most likely the dust wallet failing to sync rather than missing DUST.',
      );
    }
    note(`no DUST after ${waited}s — anything submitted will be rejected as 170`);
    break;
  }

  note(`wallet ready after ${waited}s — NIGHT ${live.night()}, DUST ${live.dust()}`);

  /*
   * A DUST BALANCE IS NOT A SYNCED DUST WALLET, AND THE WAIT LIVES HERE SO NO
   * CALLER CAN OMIT IT.
   *
   * The loop above waits for a BALANCE. A spend proof built from a dust view
   * that has a balance and has not caught up is rejected by the node as
   * `1010: Invalid Transaction: Custom error: 170` — InvalidDustSpendProof.
   *
   * `deploy-preview.ts` called `waitForDustCatchUp` itself, at its own call
   * site, and worked. `deploy-vault.ts` reused THIS function — correctly, per
   * And did not know there was a second step afterwards, so the first
   * vault deploy ever submitted was refused twice with 170: once from a
   * 123-minute-old cache, and again from a wallet freshly synced from genesis
   * in 22 seconds. Neither was stale data. Both were an uncaught-up view.
   *
   * This is `M-141`'s lesson a second time, one layer up: a rule that lives at
   * a call site protects that call site and nothing else. The shared function
   * LOOKED like the whole bring-up, so the next caller reasonably assumed it
   * was. Now it is.
   *
   * `deploy-preview.ts`'s own call is left where it is and becomes a no-op —
   * `waitForDustCatchUp` returns immediately when the view is already caught
   * up — because removing it is a change to the account's live deploy
   * instrument that nothing in a session can re-run.
   */
  if (options.withDust) {
    await waitForDustCatchUp(live, note, (st: any) => {
      const p = dustProgressOf(st);
      if (!p) return 'no dust progress reported yet';
      return `dust ${String(p.synced ?? p.applyGap ?? '?')}/${String(p.total ?? p.sourceGap ?? '?')}`;
    });
    if (dustCaughtUp(dustProgressOf(live.state()))) note('dust wallet caught up');
  }

  /*
   * **AND THE SHIELDED SCAN, WHICH THE DUST CACHE MADE WORSE RATHER THAN
   * BETTER.**
   *
   * The loops above wait for DUST. Nothing anywhere waited for the shielded
   * sub-wallet, and the faster this function returns the less the shielded scan
   * has done: `DEPOSIT-TO-VAULT.command` refused twice on 30 August with `the
   * wallet holds 0 of that colour`, two lines under `wallet ready after 1s`,
   * against a wallet that had held ten trillion of it minutes earlier.
   *
   * `M-141` one layer further along: a rule that lives at a call site protects
   * that call site and nothing else. The wait is one function and it is reached
   * from here.
   */
  if (options.withShielded) shieldedOutcome = await waitForShielded();

  return live;
}
