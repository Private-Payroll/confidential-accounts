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
 *
 * It also reads the view against the network: the indexer's newest DUST event,
 * a strict wait for the view to reach it, and the numbers written down when a
 * fee is not paid.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  appliedOverhead, arrivedOverhead, feeFloorFrom, feeFloorVerdict,
  type FeeFloorReading, type FeeFloorReason,
} from './dust-fee-floor.js';

/**
 * Specks added to every fee so it can never be zero.
 *
 * Against a DUST balance in the 10^18 range this is invisible, and the fees
 * actually quoted on preview have been single digits. Env-overridable because
 * the right value on a real network is a question for whoever operates it.
 */
const REQUESTED_FEE_FLOOR = feeFloorFrom(process.env.MIDNIGHT_DUST_FEE_FLOOR, 1_000_000n);

export const DUST_FEE_FLOOR = REQUESTED_FEE_FLOOR.value;

/**
 * Why the floor is what it is, when the override could not be used.
 *
 * Carried into the reading so the refusal names the variable rather than
 * leaving a person to work out why a door suddenly reports a floor of nothing.
 */
export const DUST_FEE_FLOOR_PROBLEM = REQUESTED_FEE_FLOOR.problem;

export const dustCachePath = (root: string, network: string, masterSeed: string) =>
  join(root, '.wallet-state', `dust-${network}-${masterSeed.slice(0, 16)}.state`);

export type DustInstall = {
  /**
   * 'restored' saved the long sync; 'fresh' did not, but still has the fee
   * floor.
   *
   * **'unchanged' IS THE SEVERE ONE.**
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
 * The installed wallet writes its history to the same store as the one it
 * replaces, which is the store the wallet's own history is read from.
 *
 * It throws for one thing only: a wallet whose history store cannot be found,
 * because a new wallet given a fresh, empty store instead would, as a fee
 * payer, refuse every fee after its first. Otherwise it never throws, but
 * 'unchanged' is NOT a soft outcome. Leaving the SDK's own dust wallet in
 * place leaves a wallet whose fee overhead is nothing, and a fee that can come out at nothing produces a
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
  // The history store the wallet was built with. The builder's configuration
  // field makes a new, empty one each time it is read, so it is taken from the
  // dust wallet being replaced, which shares the store the wallet reads from.
  const historyStore = wallet?.wallet?.dust?.constructor?.configuration?.txHistoryStorage;
  if (!historyStore) {
    throw new Error(
      'the wallet\'s history store could not be found on the DUST wallet it was built with, so no DUST wallet was\n'
        + '  installed. A DUST wallet given a fresh, empty store would never show its own payments in the wallet\'s\n'
        + '  history, and as a fee payer it would refuse every fee after its first. Nothing has been submitted. This is\n'
        + '  a change in the wallet library\'s shape, not a chain or funding problem, and starting again will not clear it.');
  }
  try {
    const tk: any = await import('@midnight-ntwrk/testkit-js');
    const sdk: any = await import('@midnightntwrk/wallet-sdk');
    const { LedgerParameters } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');


    // The configuration the testkit derives from the environment, read off the
    // builder's own public field. Building one by hand would be a second source
    // of truth for the wallet config.
    const baseConfig = tk.FluentWalletBuilder.forEnvironment(cfg).config;
    if (!baseConfig) throw new Error('could not read the wallet configuration off the builder');

    // Mirrors WalletFactory.createDustWallet, with the fee floor changed and the history store kept.
    const dustConfig = {
      ...baseConfig,
      txHistoryStorage: historyStore,
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
      const problem = DUST_FEE_FLOOR_PROBLEM ?? arrived.problem;
      const reading: FeeFloorReading = {
        passed: DUST_FEE_FLOOR,
        arrived: arrived.value,
        applied: applied.value,
        ...(problem ? { problem } : {}),
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
       * The age limit is kept beside the strict wait (`waitForDustAtTip`): a
       * cache far behind the network would make that wait replay hours of
       * events before a run could start, and an old file is cheaper to throw
       * away than to catch up.
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
       * A cache too old to trust falls through to the cold swap below and keeps
       * the fee floor: without it a fee can come out at zero, the balancer
       * selects no dust coin, and the node refuses the transaction for carrying
       * empty dust actions.
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

/**
 * Caught up within ten events of the last highest id the wallet was sent, for
 * the probes that only need a view close enough to try with. It cannot see a
 * stalled subscription, which reports itself complete; paying a fee waits on
 * `waitForDustAtTip` instead, which reads the indexer.
 */
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

/* ------------------------------------------------------------------ *
 * The view against the network: strict, read from the indexer
 * ------------------------------------------------------------------ */

/**
 * The last DUST event a view has applied, or null before the first.
 *
 * The wallet numbers DUST events as the indexer does, and its applied index is
 * the id of the last one it applied, so it is compared directly with the
 * indexer's highest id. Zero means none applied yet.
 */
export const dustAppliedOf = (p: any): bigint | null => {
  try {
    if (p?.appliedIndex === undefined || p?.appliedIndex === null) return null;
    const a = BigInt(p.appliedIndex);
    return a > 0n ? a : null;
  } catch {
    return null;
  }
};

/** How a view stands against the network, for an operator: `dust applied A of H`. */
export const describeDustView = (applied: bigint | null, tip: bigint | null): string =>
  `dust applied ${applied ?? '?'} of ${tip ?? '?'}`;

/** The indexer websocket address an installed DUST wallet syncs from, or null when it names none. */
export const dustIndexerWsOf = (dust: any): string | null => {
  const url = dust?.constructor?.configuration?.indexerClientConnection?.indexerWsUrl;
  return typeof url === 'string' && url !== '' ? url : null;
};

/** The few members of a websocket the tip reader uses, so a test can stand in for the indexer. */
export interface TipSocket {
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

const TIP_QUESTION = 'subscription ($id: Int) { dustLedgerEvents(id: $id) { id maxId } }';

/**
 * **THE NEWEST DUST EVENT THE INDEXER HOLDS, READ NOW.**
 *
 * The indexer has no query for it; every DUST event it streams carries the
 * highest id it holds at the moment it sends it. So this asks for the stream
 * from the view's own applied event (from the start when it has applied none), takes the first answer's
 * highest id and closes. Refuses when the indexer does not answer in time,
 * refuses the question or closes first: a tip that was not read is never
 * taken as reached.
 */
export function dustTipAt(
  wsUrl: string,
  from: bigint | null,
  timeoutMs = 15_000,
  open: (url: string) => TipSocket = (url) => new WebSocket(url, 'graphql-transport-ws') as unknown as TipSocket,
): Promise<bigint> {
  return new Promise<bigint>((resolve, reject) => {
    let socket: TipSocket | null = null;
    let done = false;
    const finish = (error: Error | null, tip?: bigint) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* the answer is already decided */ }
      if (error) reject(error); else resolve(tip!);
    };
    const timer = setTimeout(() => finish(new Error(
      `the indexer did not say how far the network's DUST has got within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    try {
      socket = open(wsUrl);
    } catch (e) {
      finish(new Error(`the indexer could not be reached: ${String((e as Error)?.message ?? e)}`));
      return;
    }
    socket.onopen = () => socket!.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    socket.onmessage = (m) => {
      let said: any;
      try { said = JSON.parse(String(m.data)); } catch { return; }
      if (said?.type === 'connection_ack') {
        socket!.send(JSON.stringify({
          id: '1', type: 'subscribe',
          payload: { query: TIP_QUESTION, variables: { id: from === null ? null : Number(from) } },
        }));
      } else if (said?.type === 'next') {
        const maxId = said?.payload?.data?.dustLedgerEvents?.maxId;
        try {
          finish(null, BigInt(maxId));
        } catch {
          finish(new Error('the indexer answered without its highest DUST event'));
        }
      } else if (said?.type === 'error' || said?.type === 'complete') {
        finish(new Error(`the indexer refused the question: ${JSON.stringify(said?.payload ?? '').slice(0, 200)}`));
      }
    };
    socket.onerror = (ev: any) => finish(new Error(`the indexer could not be reached: ${String(ev?.message ?? 'the connection failed')}`));
    socket.onclose = () => finish(new Error('the indexer closed the connection before it answered'));
  });
}

/** Where the view stood when a strict wait ended. */
export type AtTipOutcome =
  | { readonly ok: true; readonly applied: bigint; readonly tip: bigint }
  | { readonly ok: false; readonly why: string };

export interface AtTipOptions {
  /** How long the applied index may stand still before the view counts as stalled. */
  readonly stallMs?: number;
  /** The most the whole wait may take. */
  readonly totalMs?: number;
  readonly pollMs?: number;
  readonly printMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * **WAITS UNTIL THE VIEW HAS APPLIED EVERY DUST EVENT THE INDEXER HELD WHEN
 * THE WAIT BEGAN, WITH NO TOLERANCE.**
 *
 * A spend proof is checked against the network's DUST trees, so a view even
 * one event short can be refused. It keeps waiting while the applied index
 * moves, and answers not ok when it has stood still for a minute (a stalled
 * subscription reports itself complete, so only movement tells), after twenty
 * minutes in all, or when the indexer cannot say where the network is. It
 * never answers ok on a reading it did not make. Progress is printed as
 * `dust applied A of H`.
 */
export async function waitForDustAtTip(
  live: { state: () => any },
  tipNow: (from: bigint | null) => Promise<bigint>,
  note: (s: string) => void,
  o: AtTipOptions = {},
): Promise<AtTipOutcome> {
  const stallMs = o.stallMs ?? 60_000;
  const totalMs = o.totalMs ?? 20 * 60_000;
  const pollMs = o.pollMs ?? 1_000;
  const printMs = o.printMs ?? 10_000;
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const appliedNow = () => dustAppliedOf(dustProgressOf(live.state()));

  const started = now();
  let tip: bigint;
  try {
    tip = await tipNow(appliedNow());
  } catch (e) {
    return { ok: false, why: `the indexer could not say how far the network's DUST has got: ${String((e as Error)?.message ?? e)}` };
  }
  let last = appliedNow();
  let movedAt = started;
  let printed = started;
  for (;;) {
    const applied = appliedNow();
    if (applied !== null && applied >= tip) return { ok: true, applied, tip };
    const t = now();
    if (applied !== last) { last = applied; movedAt = t; }
    if (t - movedAt >= stallMs) {
      return { ok: false, why: `the wallet's view of the network's DUST has not moved for ${Math.round(stallMs / 1000)} s (${describeDustView(applied, tip)})` };
    }
    if (t - started >= totalMs) {
      return { ok: false, why: `the wallet's view of the network's DUST did not reach the network's within ${Math.round(totalMs / 60_000)} minutes (${describeDustView(applied, tip)})` };
    }
    if (t - printed >= printMs) {
      printed = t;
      note(`  ${String(Math.round((t - started) / 1000)).padStart(3)}s  ${describeDustView(applied, tip)}`);
    }
    await sleep(pollMs);
  }
}

/**
 * The numbers that explain a fee that could not be paid: how far the view has
 * got, the coins free to spend, the coins the wallet library has booked, the
 * coins the ledger state holds unbooked, and the balance. Each reads `?` when
 * it cannot be read; nothing here throws.
 */
export function dustNumbers(state: any, tip: bigint | null): string {
  const dust = state?.dust;
  const count = (read: () => unknown): string => {
    try {
      const v = read();
      return Array.isArray(v) ? String(v.length) : '?';
    } catch {
      return '?';
    }
  };
  let balance = '?';
  try { balance = String(dust.balance(new Date())); } catch { /* stays ? */ }
  return `${describeDustView(dustAppliedOf(dustProgressOf(state)), tip)}; `
    + `${count(() => dust.availableCoins)} coins free to spend, `
    + `${count(() => dust.state.pendingDust)} booked by the wallet, `
    + `${count(() => dust.state.state.utxos)} unbooked in the ledger state; balance ${balance}`;
}

/**
 * The loose wait the probes use: a view within ten events of the last highest
 * id the wallet was sent. A wallet that pays waits on `waitForDustAtTip`
 * instead.
 *
 * A DUST BALANCE IS NOT A SYNCED DUST WALLET, and submitting on the difference
 * is what produces `1010: Invalid Transaction: Custom error: 170` —
 * `InvalidDustSpendProof` in the node's own table. The fee proof is built from
 * the dust wallet's view of generation state; built from a view still catching
 * up, the node rejects it. `balance > 0` goes true long before the wallet is
 * ready, so a balance gate alone passes and then fails at submission.
 *
 * Bounded and non-fatal: if it does not converge it says so loudly and returns,
 * and the probe goes on with a known cause for any refusal.
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
