/**
 * The dust sub-wallet: cached across runs, and configured so its fee can never
 * come out as zero.
 *
 * TWO PROBLEMS, ONE PLACE.
 *
 * 1. NO PERSISTENCE. Every start replays the chain from genesis to
 *    rebuild the dust wallet's state — 271s to 284s, measured, on every single
 *    run. The DUST is already on chain and already registered; the wallet just
 *    cannot see it until it catches up. `DustWallet(config).restore(serialized)`
 *    resumes instead, but `WalletFactory.createDustWallet` never calls it — it
 *    only ever does `startWithSeed`. So the wallet is built the normal way and
 *    its dust sub-wallet is swapped for one of ours. `WalletFacade.dust` is a
 *    plain public field and `facade.start()` calls `this.dust.start(secretKey)`,
 *    so a restored instance starts in place of a cold one.
 *
 * 2. A ZERO FEE PRODUCES AN INVALID TRANSACTION. `calculateFee` is
 *    `feesWithMargin(...) + additionalFeeOverhead`, and the testkit's default
 *    for that overhead is `0n`. When `feesWithMargin` returns 0 the balancer is
 *    told nothing is owed, selects no dust coin, and the transaction goes out
 *    with an empty `DustActions`. The node refuses it:
 *
 *      ledger/src/dust.rs
 *        if self.spends.is_empty() && self.registrations.is_empty() {
 *            warn!("non-canonical dust actions: empty");
 *            return Err(MalformedTransaction::NotNormalized);   // code 117
 *        }
 *
 *    Observed exactly once in a nine-call run: every call that landed logged
 *    `fees … (last 1)`, and `execute` — the one that failed — logged `last 0`.
 *
 *    A non-zero overhead makes the fee non-zero by construction, so a coin is
 *    always selected and the dust actions are never empty. This is a supported
 *    configuration knob, not another patch: `DustWalletOptions.additionalFeeOverhead`
 *    exists for exactly this, and the testkit simply defaults it to nothing.
 *
 * The overhead is paid, so it is deliberately small. It is a floor, not a tip.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  appliedOverhead, arrivedOverhead, feeFloorVerdict,
  type FeeFloorReading, type FeeFloorReason,
} from './dust-fee-floor.js';

/**
 * Specks added to every fee so it can never be zero.
 *
 * Against a DUST balance in the 10^18 range this is invisible, and the fees
 * actually quoted on preview have been single digits. Env-overridable because
 * the right value on a real network is a question for whoever operates it.
 */
export const DUST_FEE_FLOOR = BigInt(process.env.MIDNIGHT_DUST_FEE_FLOOR || 1_000_000);

export const dustCachePath = (root: string, network: string, masterSeed: string) =>
  join(root, '.wallet-state', `dust-${network}-${masterSeed.slice(0, 16)}.state`);

export type DustInstall = {
  /**
   * 'restored' saved the long sync; 'fresh' did not, but still has the fee
   * floor.
   *
   * **'unchanged' IS THE SEVERE ONE AND THIS COMMENT USED TO SAY IT WAS NOT.**
   * It means no wallet of ours is installed, so the library's own is, and its
   * fee overhead is nothing. That is the floor's absence known with certainty,
   * and callers stop on it.
   *
   * 'refused' means our wallet IS installed but the floor did not check out.
   * Whether a caller stops depends on `reason`: a floor known to be wrong
   * stops a run, a floor that merely could not be read does not.
   */
  how: 'restored' | 'fresh' | 'unchanged' | 'refused';
  detail: string;
  /** What was asked for, what the wallet carries, and what its arithmetic adds. */
  feeFloor?: FeeFloorReading;
  /**
   * Why a 'refused' is refused. **A caller deciding whether to stop switches on
   * this and never re-derives it from `feeFloor`** — the readings do not say on
   * their own which check failed, and a caller that guesses gets it wrong.
   * Absent on the outcomes that took no reading.
   */
  reason?: FeeFloorReason;
};

/**
 * Replaces the facade's dust sub-wallet with one we control.
 *
 * Call between `MidnightWalletProvider.build(...)` and `wallet.start(...)`.
 *
 * Never throws, but 'unchanged' is NOT a soft outcome and this comment used to
 * say it was. Leaving the SDK's own dust wallet in place leaves a wallet whose
 * fee overhead is nothing, and a fee that can come out at nothing produces a
 * transaction carrying no dust spend, which the node refuses as malformed. The
 * downside of being wrong is a run that fails at submission, not the slow sync
 * this function also avoids. Callers treat 'unchanged' as seriously as
 * 'refused': it is the same fact known with more certainty.
 */
export async function installDustWallet(
  wallet: any,
  cfg: any,
  masterSeed: string,
  network: string,
  root: string,
): Promise<DustInstall> {
  try {
    const tk: any = await import('@midnight-ntwrk/testkit-js');
    const sdk: any = await import('@midnightntwrk/wallet-sdk');
    const { LedgerParameters } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');


    // The configuration the testkit derives from the environment, read off the
    // builder's own public field. Building one by hand would be a second source
    // of truth for the wallet config, which is how M-19a happened.
    const baseConfig = tk.FluentWalletBuilder.forEnvironment(cfg).config;
    if (!baseConfig) throw new Error('could not read the wallet configuration off the builder');

    // Mirrors WalletFactory.createDustWallet, with the one field changed.
    const dustConfig = {
      ...baseConfig,
      costParameters: {
        ledgerParams: tk.DEFAULT_DUST_OPTIONS.ledgerParams,
        additionalFeeOverhead: DUST_FEE_FLOOR,
        feeBlocksMargin: tk.DEFAULT_DUST_OPTIONS.feeBlocksMargin,
      },
    };
    const Dust = sdk.DustWallet(dustConfig);

    /*
     * WHAT THE WALLET CARRIES, NOT WHAT WE ASKED FOR.
     *
     * Every path that leaves a dust wallet in place reports through here, and
     * the number it reports is read back off that wallet after the swap, never
     * from the constant above. A swap that silently did not take, or a wallet
     * whose fee arithmetic ignores the floor, refuses the install instead of
     * printing a floor that is not in force.
     */
    let staleNote = '';
    /*
     * LOADED IN ITS OWN GUARD, AND THAT IS NOT TIDINESS.
     *
     * Everything else in this function is wallet SET-UP: if it fails, no wallet
     * of ours is installed, the outer guard answers 'unchanged', and callers
     * stop. These two imports serve a READING. Inside the outer guard, a
     * dependency bump that moved a subpath would answer 'unchanged' and stop
     * every money door in this project because a number could not be measured.
     * A measurement that cannot be taken must never be able to stop a payout,
     * so it fails to null here and the verdict treats a missing applied reading
     * as missing rather than as bad.
     */
    let measureWith: { dustV1: any; ledgerV9: any } | null = null;
    try {
      measureWith = {
        dustV1: await import('@midnightntwrk/wallet-sdk/dust/v1'),
        ledgerV9: await import('@midnightntwrk/ledger-v9'),
      };
    } catch { /* the reading is skipped; the install is not */ }

    const settle = (how: 'restored' | 'fresh', detail: string): DustInstall => {
      const arrived = arrivedOverhead(wallet?.wallet?.dust);
      /*
       * MEASURED ON THE WALLET'S OWN CONFIGURATION, NOT ON OURS.
       *
       * Handing this the local object would make the third number a second
       * reading of the first, so there is no fallback to it: a wallet that will
       * not say what it carries leaves this null, which the verdict treats as
       * missing rather than as bad.
       */
      let applied: { value: bigint | null; problem?: string } = { value: null };
      const installedParams =
        (wallet?.wallet?.dust as any)?.constructor?.configuration?.costParameters;
      if (measureWith && installedParams) {
        applied = appliedOverhead(installedParams, {
          makeTransacting: (c: any, g: any) =>
            measureWith.dustV1.Transacting.makeDefaultTransactingCapability(c, g),
          newTransaction: () =>
            measureWith.ledgerV9.Transaction.fromParts(String(dustConfig.networkId ?? '')),
          params: () => measureWith.ledgerV9.LedgerParameters.initialParameters(),
        });
      }
      const reading: FeeFloorReading = {
        passed: DUST_FEE_FLOOR,
        arrived: arrived.value,
        applied: applied.value,
        ...(arrived.problem ? { problem: arrived.problem } : {}),
      };
      const verdict = feeFloorVerdict(reading);
      return {
        how: verdict.ok ? how : 'refused',
        detail: detail ? `${verdict.line}, ${detail}` : verdict.line,
        feeFloor: reading,
        reason: verdict.reason,
      };
    };

    const cache = dustCachePath(root, network, masterSeed);
    if (existsSync(cache)) {
      /*
       * A CACHE OLDER THAN THIS IS NOT USED.
       *
       * The cache exists to skip a five-minute resync, and that is worth having
       * between runs minutes apart. Across a long gap it is a liability: DUST
       * generation moves continuously, and a state saved yesterday builds a fee
       * proof the node rejects with error 170 — which costs a full run to
       * discover and reads like a wallet problem rather than a stale file.
       *
       * The wait added alongside this cannot catch it. The dust wallet reports
       * its progress as applied/highest, and highest comes back as 0 — unknown —
       * so "have you caught up" cannot be answered honestly and any check on it
       * says yes. An age limit needs no cooperation from the SDK.
       *
       * Three hours is arbitrary but on the safe side of the observed failure:
       * a 17-hour-old cache failed three submissions in a row, and caches
       * minutes old have worked every time.
       */
      const maxAgeMs = Number(process.env.MIDNIGHT_DUST_CACHE_MAX_AGE_MS || 3 * 60 * 60_000);
      const ageMs = Date.now() - statSync(cache).mtimeMs;
      /*
       * A STALE CACHE COSTS THE CACHE, NOT THE FEE FLOOR.
       *
       * This branch used to RETURN here, which left the library's own dust
       * sub-wallet in place — the one built from its defaults, where the
       * overhead is nothing — while reporting the floor as though it had been
       * installed. The floor is the reason this function exists: without it a
       * fee can come out at zero, the balancer selects no dust coin, and the
       * node refuses the transaction for carrying empty dust actions. So a
       * cache too old to trust now falls through to the cold swap below, which
       * is what the next comment already said the rule was.
       */
      const stale = ageMs > maxAgeMs;
      if (stale) {
        const hours = (ageMs / 3_600_000).toFixed(1);
        staleNote =
          `the cached state was ${hours}h old and was NOT used — ` +
          'a stale dust view is rejected by the node as an invalid fee proof (error 170), ' +
          'so this run resyncs from the chain and will take a few minutes longer';
      } else {
        const saved = readFileSync(cache, 'utf8');
        if (saved.trim()) {
          const restored = Dust.restore(saved);
          if (restored) {
            wallet.wallet.dust = restored;
            const mins = (ageMs / 60_000).toFixed(0);
            return settle('restored', `resumed from a state ${mins} min old`);
          }
        }
      }
    }

    // No usable cache: still swap, because the fee floor matters more than the cache.
    const seeds = tk.WalletSeeds.fromMasterSeed(masterSeed);
    const fresh = Dust.startWithSeed(seeds.dust, LedgerParameters.initialParameters().dust);
    if (!fresh) throw new Error('startWithSeed returned nothing');
    wallet.wallet.dust = fresh;
    return settle('fresh', staleNote || 'syncing from genesis (no cache yet)');
  } catch (e: any) {
    return { how: 'unchanged', detail: String(e?.message ?? e).slice(0, 160) };
  }
}

/**
 * Writes the dust wallet's state for the next run.
 *
 * Called as soon as the wallet is usable rather than at the end, so a run that
 * fails later still leaves a cache behind. Never throws.
 */
export async function saveDustState(
  wallet: any,
  masterSeed: string,
  network: string,
  root: string,
): Promise<number | null> {
  try {
    const serialized = await wallet.wallet?.dust?.serializeState?.();
    if (typeof serialized !== 'string' || !serialized) return null;
    const cache = dustCachePath(root, network, masterSeed);
    mkdirSync(join(root, '.wallet-state'), { recursive: true });
    writeFileSync(cache, serialized);
    return serialized.length;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Waiting for the dust wallet to catch up
 * ------------------------------------------------------------------ */

/**
 * Caught up, not identical to the tip.
 *
 * `isStrictlyComplete()` wants appliedIndex === highestIndex, which on a chain
 * that keeps producing blocks asks the wallet to outrun it. The SDK ships
 * `isCompleteWithin(gap)` for exactly this.
 */
/**
 * Whether the wallet will even say how far behind it is.
 *
 * It reports applied/highest, and `highest` comes back as 0 on this network —
 * meaning unknown, not "zero blocks". So `applied >= highest` is trivially true
 * and a completeness check built on it always says yes. Anything relying on
 * `dustCaughtUp` should say "cannot tell" rather than print a tick it has not
 * earned.
 */
export const dustProgressKnown = (p: any): boolean => {
  if (!p) return false;
  if (typeof p.isCompleteWithin === 'function' || typeof p.isStrictlyComplete === 'function') return true;
  const h = p.highestRelevantIndex ?? p.highestIndex ?? p.highestTransactionId;
  return h != null && BigInt(h) > 0n;
};

export const dustCaughtUp = (p: any): boolean => {
  if (!p) return false;
  try { if (typeof p.isCompleteWithin === 'function') return !!p.isCompleteWithin(10n); } catch { /* fall through */ }
  try { if (typeof p.isStrictlyComplete === 'function') return !!p.isStrictlyComplete(); } catch { /* fall through */ }
  const a = p.appliedIndex ?? p.appliedId;
  const h = p.highestRelevantIndex ?? p.highestIndex ?? p.highestTransactionId;
  if (a == null || h == null) return false;
  return BigInt(a) + 10n >= BigInt(h);
};

export const dustProgressOf = (s: any) => s?.dust?.state?.progress ?? s?.dust?.progress;

/**
 * BLOCKS UNTIL THE DUST WALLET HAS CAUGHT UP, and every script that submits a
 * transaction must call it.
 *
 * A DUST BALANCE IS NOT A SYNCED DUST WALLET, and submitting on the difference
 * is what produces `1010: Invalid Transaction: Custom error: 170` —
 * `InvalidDustSpendProof` in the node's own table. The fee proof is built from
 * the dust wallet's view of generation state; built from a view still catching
 * up, the node rejects it. `balance > 0` goes true long before the wallet is
 * ready, so a balance gate alone passes and then fails at submission.
 *
 * THIS LIVED INSIDE `deploy-preview.ts` AS A COMMENT AND A LOOP, which is why
 * it is here now. `chain-probe.ts` was written fresh, copied the balance gate,
 * did not copy the wait, and failed on error 170 at its first submission — the
 * exact failure the comment in the other file describes, rediscovered at the
 * cost of a run. One rule, one place; the oldest lesson in this project.
 *
 * Bounded and non-fatal: if it does not converge it says so loudly and returns,
 * because a run that refuses to start is worse than one that fails with a known
 * cause.
 */
export async function waitForDustCatchUp(
  live: { state: () => any },
  note: (s: string) => void,
  describe: (s: any) => string,
  timeoutMs = 5 * 60_000,
): Promise<boolean> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  if (dustCaughtUp(dustProgressOf(live.state()))) return true;

  note('the dust wallet has a balance but has not finished catching up');
  note('waiting for it, because a spend proof built from a stale view is rejected (error 170)');
  const started = Date.now();
  let printed = 0;
  while (!dustCaughtUp(dustProgressOf(live.state()))) {
    const elapsed = Date.now() - started;
    if (elapsed > timeoutMs) {
      note('\x1b[33mstill not caught up — going ahead, but if this fails with error 170');
      note('that is why, and the fix is to delete .wallet-state and let it resync\x1b[0m');
      return false;
    }
    if (elapsed - printed >= 10_000) {
      printed = elapsed;
      note(`  ${String(Math.round(elapsed / 1000)).padStart(3)}s  ${describe(live.state())}`);
    }
    await sleep(1000);
  }
  return true;
}

/**
 * Throws away a cached dust state so the next start resyncs from scratch.
 *
 * The cache is what makes a run start in seconds instead of five minutes, and
 * it is also what goes stale: a state saved yesterday describes generation the
 * chain has moved past. Deleting it is always safe — it is a cache — and is the
 * right response to error 170 surviving the wait above.
 */
export function discardDustCache(root: string, network: string, masterSeed: string): boolean {
  const path = dustCachePath(root, network, masterSeed);
  try {
    if (existsSync(path)) { unlinkSync(path); return true; }
  } catch { /* a cache we cannot delete is not worth failing over */ }
  return false;
}
