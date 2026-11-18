/**
 * The dust sub-wallet: cached across runs, and configured so its fee can never
 * come out as zero.
 *
 * TWO PROBLEMS, ONE PLACE.
 *
 * 1. NO PERSISTENCE. Every start without a cache replays the chain's DUST
 *    events to rebuild the dust wallet's state — 271s to 284s, measured on an
 *    earlier, smaller network, on every single run; on preprod, from the
 *    first event, hours. So the DUST wallet syncs by projections instead
 *    (`projectionsDustWallet` in src/midnight/projections-dust-wallet.ts), and
 *    its view is judged by the block its last pass reached (`dustViewHeight`
 *    in src/midnight/sponsor.ts). The
 *    DUST is already on chain and already registered; the wallet just cannot
 *    see it until it catches up. `restore(serialized)` resumes
 *    instead, but `WalletFactory.createDustWallet` never calls it — it only
 *    ever does `startWithSeed`. So `buildWalletWithDust` builds the wallet as
 *    the testkit does, with our DUST wallet, restored when it can be, in the
 *    facade from the start.
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
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  appliedOverhead, arrivedOverhead, feeFloorFrom, feeFloorVerdict,
  type FeeFloorReading, type FeeFloorReason,
} from './dust-fee-floor.js';
import { dustViewCovers, dustViewHeight } from '../src/midnight/sponsor.js';
import { projectionsDustWallet } from '../src/midnight/projections-dust-wallet.js';

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

/**
 * Where the DUST wallet's state is cached. The name says the sync that wrote it: a snapshot written by event replay,
 * from before the DUST wallet synced by projections, would restore as an event-replay wallet, so it is never read.
 */
export const dustCachePath = (root: string, network: string, masterSeed: string) =>
  join(root, '.wallet-state', `dust-projections-${network}-${masterSeed.slice(0, 16)}.state`);

/** How the indexer is asked over HTTP: a POST, answered with a body read as JSON. */
type IndexerPost = (url: string, init: RequestInit) => Promise<{ json(): Promise<unknown> }>;

/** The newest block the indexer holds, read now: `fields` of it, by GraphQL over HTTP. */
async function newestBlock(indexerHttpUrl: string, fields: string, post: IndexerPost): Promise<Readonly<Record<string, unknown>>> {
  const answer = await post(indexerHttpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `query { block { ${fields} } }` }),
  });
  const block = ((await answer.json()) as { data?: { block?: Readonly<Record<string, unknown>> | null } } | null)?.data?.block;
  if (!block) throw new Error('the indexer named no newest block');
  return block;
}

/**
 * The height of the newest block the indexer holds, read now: what a DUST view must cover before a fee is paid
 * from it (`dustViewCovers`). Refuses when the indexer does not answer or names no block.
 */
export async function networkHeightAt(indexerHttpUrl: string, post: IndexerPost = fetch): Promise<bigint> {
  const height = (await newestBlock(indexerHttpUrl, 'height', post)).height;
  if (height === undefined || height === null) throw new Error('the indexer named no newest block');
  /* Whatever BigInt reads, as before: a height it cannot read throws here. */
  return BigInt(height as bigint | boolean | number | string);
}

/**
 * Prints a sub-wallet's progress (applied and highest) every `everyMs` until it is synced, then once that it is
 * (and calls `onSynced`), then nothing. Returns a function that stops it early. The timer never keeps the process alive.
 */
export function reportSync(
  subWallet: any, label: string, note: (line: string) => void, everyMs = 10_000, onSynced: () => unknown = () => {},
): () => void {
  let latest: any = null;
  const started = Date.now();
  const subscription = subWallet?.state?.subscribe?.({ next: (s: any) => { latest = s?.progress ?? null; } });
  const stop = () => { clearInterval(timer); try { subscription?.unsubscribe?.(); } catch { /* already closed */ } };
  const timer = setInterval(() => {
    const seconds = String(Math.round((Date.now() - started) / 1000)).padStart(3);
    let synced = false;
    try { synced = !!latest?.isStrictlyComplete?.(); } catch { /* unreadable reads as not synced */ }
    if (synced) {
      note(`  ${seconds}s  ${label} synced`);
      stop();
      try { void Promise.resolve(onSynced()).catch(() => {}); } catch { /* a failed save costs the cache, not the run */ }
      return;
    }
    note(`  ${seconds}s  ${label} syncing: ${latest?.appliedIndex ?? '?'} of ${latest?.highestRelevantWalletIndex ?? '?'}`);
  }, everyMs);
  (timer as any).unref?.();
  return stop;
}

export type DustInstall = {
  /**
   * 'restored' saved the long sync; 'fresh' did not, but still has the fee floor. 'refused' means our wallet IS
   * built but the floor did not check out. Whether a caller stops depends on `reason`: a floor known to be wrong
   * stops a run, a floor that merely could not be read does not. A wallet without our DUST wallet is never built.
   */
  how: 'restored' | 'fresh' | 'refused';
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
 * How the shielded wallet applies the network's events: a hundred at a time rather than the library's ten. The
 * shielded wallet has only event replay, and the ledger 9 fork carried its state across, so it replays from the
 * first event on any network; each step rehashes its tree and publishes a new state, as the DUST wallet's does.
 */
export const SHIELDED_READ = { batchUpdates: { size: 100 } } as const;

/** What a wallet was built with and how its DUST wallet came to be. */
export interface WalletWithDust {
  /** The testkit's wallet provider, around a facade built with our DUST wallet. */
  readonly wallet: any;
  readonly installed: DustInstall;
  /** The protocol version ledger 9 begins at on this network, as the wallet was configured. */
  readonly forkV9: bigint;
}

/**
 * Whether a saved DUST snapshot records the projections sync. One that does not was written before the wallet
 * finished its first pass, and is not saved: restored, it would start as an event-replay wallet.
 */
export const recordsProjections = (serialized: string): boolean => {
  try {
    return JSON.parse(serialized)?.syncKind === 'projections';
  } catch {
    return false;
  }
};

/** Reads the fee floor back off the DUST wallet a built wallet carries, and judges it. */
async function feeFloorOf(wallet: any, networkId: string, how: 'restored' | 'fresh', detail: string): Promise<DustInstall> {
  let measureWith: { dustV1: any; ledgerV9: any } | null = null;
  try {
    measureWith = {
      dustV1: await import('@midnightntwrk/wallet-sdk/dust/v1'),
      ledgerV9: await import('@midnightntwrk/ledger-v9'),
    };
  } catch { /* the reading is skipped; the wallet is not */ }
  const arrived = arrivedOverhead(wallet?.wallet?.dust);
  let applied: { value: bigint | null; problem?: string } = { value: null };
  const installedParams = (wallet?.wallet?.dust as any)?.constructor?.configuration?.costParameters;
  if (measureWith && installedParams) {
    applied = appliedOverhead(installedParams, {
      makeTransacting: (c: any, g: any) => measureWith.dustV1.Transacting.makeDefaultTransactingCapability(c, g),
      newTransaction: () => measureWith.ledgerV9.Transaction.fromParts(networkId),
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
}

/** Where the shielded or unshielded wallet's state is cached, beside the DUST wallet's. */
export const walletCachePath = (root: string, network: string, masterSeed: string, surface: 'shielded' | 'unshielded') =>
  join(root, '.wallet-state', `${surface}-${network}-${masterSeed.slice(0, 16)}.state`);

/**
 * Starts a wallet from its cache when the cache is young enough and the library accepts it, otherwise afresh. A
 * cache older than MIDNIGHT_DUST_CACHE_MAX_AGE_MS (three hours unless set) is not used: a 17-hour-old DUST cache
 * failed three submissions in a row with error 170, and caches minutes old have worked every time. A cache the
 * library refuses is named: the file is what is wrong, and this run's save replaces it.
 */
async function fromCache(
  what: string, cache: string, restore: (saved: string) => any, start: () => Promise<any>,
): Promise<{ wallet: any; how: 'restored' | 'fresh'; detail: string }> {
  let why = '';
  if (existsSync(cache)) {
    /* The age limit is the DUST wallet's (its stale view built proofs the node refused); a shielded or unshielded
     * state resumes from where it was saved at any age, and replaying ledger 8 instead costs about eight minutes. */
    const maxAgeMs = Number(process.env.MIDNIGHT_DUST_CACHE_MAX_AGE_MS || 3 * 60 * 60_000);
    const ageMs = Date.now() - statSync(cache).mtimeMs;
    if (what === 'DUST' && ageMs > maxAgeMs) {
      why = `the cached ${what} state was ${(ageMs / 3_600_000).toFixed(1)}h old and was NOT used — a stale view `
        + 'builds a proof the node rejects (error 170), so this run resyncs';
    } else {
      const saved = readFileSync(cache, 'utf8');
      try {
        const restored = saved.trim() ? restore(saved) : null;
        if (restored) return { wallet: restored, how: 'restored', detail: `resumed from a state ${(ageMs / 60_000).toFixed(0)} min old` };
      } catch (e: any) {
        why = `the cached ${what} state in ${cache} was refused by the wallet library (${String(e?.message ?? e).slice(0, 120)}); `
          + 'the file is what is wrong, not the wallet or the fee floor. It was not used, this run resyncs, and '
          + 'its save replaces the file; to keep it, move it aside before then';
      }
    }
  }
  const wallet = await start();
  if (!wallet) throw new Error(`the wallet library returned no ${what} wallet`);
  return { wallet, how: 'fresh', detail: why || 'no cache yet' };
}

/**
 * Builds the wallet the way the testkit does, with our DUST wallet in it from the start.
 *
 * The facade reads its protocol version from the three wallets it is built with, and writes every transaction for
 * the lowest of them; a DUST wallet swapped in afterwards is never read, and the one it replaced, never started,
 * holds the facade at whatever version it was created at. So the facade is built here, from the shielded and
 * unshielded wallets as the testkit makes them (the shielded one reading as SHIELDED_READ says) and our DUST wallet:
 * the fee floor, the wallet's own history store, and the projections sync.
 *
 * The DUST wallet and the shielded wallet print their progress every ten seconds
 * through `options.note` (the console unless given) until each is synced.
 *
 * Throws when the history store cannot be found or the DUST wallet cannot be built: a wallet without our DUST
 * wallet has no fee floor, and a fee that can come out at nothing is refused by the node as malformed.
 */
export async function buildWalletWithDust(
  logger: unknown,
  cfg: any,
  masterSeed: string,
  network: string,
  root: string,
  options: { note?: (line: string) => void } = {},
): Promise<WalletWithDust> {
  const note = options.note ?? ((line: string) => console.log(line));
  const tk: any = await import('@midnight-ntwrk/testkit-js');
  const sdk: any = await import('@midnightntwrk/wallet-sdk');
  const { LedgerParameters } = await import('@midnight-ntwrk/midnight-js-protocol/v9');
  const builder = tk.FluentWalletBuilder.forEnvironment(cfg);
  const baseConfig = builder?.config;
  if (!baseConfig) throw new Error('could not read the wallet configuration off the testkit\'s builder');
  if (!baseConfig.txHistoryStorage) {
    throw new Error(
      'the wallet configuration carries no history store, so no wallet was built. A DUST wallet given a fresh,\n'
        + '  empty store would never show its own payments in the wallet\'s history, and as a fee payer it would refuse\n'
        + '  every fee after its first. Nothing has been submitted. This is a change in the testkit\'s shape, not a\n'
        + '  chain or funding problem, and starting again will not clear it.');
  }
  const seeds = tk.WalletSeeds.fromMasterSeed(masterSeed);
  const keystore = sdk.createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, builder.networkId);
  const shieldedConfig = { ...baseConfig, ...SHIELDED_READ };
  const shieldedFile = walletCachePath(root, network, masterSeed, 'shielded');
  const shieldedStart = await fromCache('shielded', shieldedFile,
    (saved) => sdk.ShieldedWallet(shieldedConfig).restore(saved),
    () => tk.WalletFactory.createShieldedWallet(shieldedConfig, seeds.shielded));
  const shielded = shieldedStart.wallet;
  note(`shielded wallet ${shieldedStart.how} — ${shieldedStart.detail}`);
  // As WalletFactory.createUnshieldedWallet builds it: its own, empty history store.
  const unshieldedStart = await fromCache('unshielded', walletCachePath(root, network, masterSeed, 'unshielded'),
    (saved) => sdk.UnshieldedWallet({
      ...baseConfig,
      txHistoryStorage: new sdk.InMemoryTransactionHistoryStorage(sdk.WalletEntrySchema, sdk.mergeWalletEntries),
    }).restore(saved),
    () => tk.WalletFactory.createUnshieldedWallet(baseConfig, keystore));
  const unshielded = unshieldedStart.wallet;
  note(`unshielded wallet ${unshieldedStart.how} — ${unshieldedStart.detail}`);
  // Mirrors WalletFactory.createDustWallet, with the fee floor set.
  const dustConfig = {
    ...baseConfig,
    costParameters: {
      ledgerParams: tk.DEFAULT_DUST_OPTIONS.ledgerParams,
      additionalFeeOverhead: DUST_FEE_FLOOR,
      feeBlocksMargin: tk.DEFAULT_DUST_OPTIONS.feeBlocksMargin,
    },
  };
  const Dust = await projectionsDustWallet(dustConfig);
  const dustStart = await fromCache('DUST', dustCachePath(root, network, masterSeed), (saved) => Dust.restore(saved),
    () => Dust.startWithSeed(seeds.dust, LedgerParameters.initialParameters().dust));
  const started = { dust: dustStart.wallet, how: dustStart.how, detail: dustStart.detail };
  const facade = await tk.WalletFactory.createWalletFacade(baseConfig, shielded, unshielded, started.dust);
  const wallet = await tk.MidnightWalletProvider.withWallet(logger, cfg, facade, seeds, keystore);
  reportSync(started.dust, 'dust wallet', note);
  // Saved the moment it is synced, so a run stopped after the replay keeps it.
  reportSync(shielded, 'shielded wallet', note, 10_000, () => saveState(shieldedFile, shielded));
  const how = started.how === 'fresh'
    ? `${started.detail}, syncing by projections (this wallet's own DUST, read from the indexer)`
    : started.detail;
  return {
    wallet,
    installed: await feeFloorOf(wallet, String(dustConfig.networkId ?? ''), started.how, how),
    forkV9: BigInt(baseConfig.forks?.v9 ?? 0),
  };
}

/**
 * Waits until the facade writes for ledger 9, with a line every `printMs` saying the version it is at. The facade
 * writes every transaction for the lowest version its three wallets have reached, so until a shielded wallet
 * replaying ledger 8 events has crossed the fork, anything written is written for ledger 8 and the node refuses it.
 */
export async function facadeAtLedger9(
  facade: any,
  forkV9: bigint,
  note: (line: string) => void,
  o: { pollMs?: number; printMs?: number; now?: () => number; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  const started = now();
  let printed = started;
  while (BigInt(facade.currentVersion()) < forkV9) {
    if (now() - printed >= (o.printMs ?? 10_000)) {
      printed = now();
      note(`  ${String(Math.round((printed - started) / 1000)).padStart(3)}s  the wallet writes for protocol version `
        + `${facade.currentVersion()}, not yet ledger 9 (${forkV9}); the shielded wallet is still replaying ledger 8`);
    }
    await sleep(o.pollMs ?? 1_000);
  }
}

/**
 * Waits for what a NIGHT registration reads and needs: the facade writing for ledger 9, then the unshielded and DUST
 * sides synced. Not the shielded side's sync: a registration reads none of it. But the facade writes every
 * transaction for the lowest version its three wallets have reached, so a shielded wallet still replaying ledger 8
 * events would have the registration written for ledger 8, which the node refuses; that much is waited for, with a
 * line every `printMs` saying the version the facade is at.
 */
export async function registrationSidesSynced(
  facade: any,
  forkV9: bigint,
  note: (line: string) => void,
  o: { pollMs?: number; printMs?: number; now?: () => number; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<{ unshielded: any; dust: any }> {
  await facadeAtLedger9(facade, forkV9, note, o);
  const [unshielded, dust] = await Promise.all([facade.unshielded.waitForSyncedState(), facade.dust.waitForSyncedState()]);
  return { unshielded, dust };
}

/** Writes one wallet's serialized state to `file`; answers its size, or null when there was none. Never throws. */
async function saveState(file: string, subWallet: any): Promise<number | null> {
  try {
    const serialized = await subWallet?.serializeState?.();
    if (typeof serialized !== 'string' || !serialized) return null;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serialized);
    return serialized.length;
  } catch {
    return null;
  }
}

/**
 * Writes the DUST, shielded and unshielded wallets' state for the next run, each to its own file; the DUST state
 * only when its snapshot records the projections sync (`recordsProjections`). Answers the bytes written in all, or
 * null when nothing was.
 *
 * Called as soon as the wallet is usable rather than at the end, so a run that fails later still leaves a cache
 * behind. Never throws.
 */
export async function saveWalletState(
  wallet: any,
  masterSeed: string,
  network: string,
  root: string,
): Promise<number | null> {
  let dustFile: string | null = null;
  try {
    const serialized = await wallet?.wallet?.dust?.serializeState?.();
    if (typeof serialized === 'string' && recordsProjections(serialized)) {
      dustFile = dustCachePath(root, network, masterSeed);
    }
  } catch { /* no DUST state to save */ }
  const sizes = await Promise.all([
    dustFile ? saveState(dustFile, wallet.wallet.dust) : Promise.resolve(null),
    saveState(walletCachePath(root, network, masterSeed, 'shielded'), wallet?.wallet?.shielded),
    saveState(walletCachePath(root, network, masterSeed, 'unshielded'), wallet?.wallet?.unshielded),
  ]);
  const written = sizes.filter((n): n is number => n !== null);
  return written.length ? written.reduce((a, b) => a + b, 0) : null;
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
 * Whether a DUST view has caught up since a wait began at block `movedFrom`: a complete reading covering a later
 * block (`dustViewCovers`). A pass reports progress before its state update lands, so a complete reading at the
 * block the wait began at may be from before the pass that would show the newest DUST.
 */
export const dustCaughtUp = (p: unknown, movedFrom: bigint): boolean => dustViewCovers(dustViewHeight(p), movedFrom + 1n);

export const dustProgressOf = (s: any) => s?.dust?.state?.progress ?? s?.dust?.progress;

/** The block height a DUST view's last pass recorded, finished or not, read now: where a catch-up wait begins. */
export const dustMovedFrom = (s: any): bigint => {
  try { return BigInt(dustProgressOf(s)?.highestIndex ?? 0n); } catch { return 0n; }
};

/* ------------------------------------------------------------------ *
 * The view against the network: strict, read from the indexer
 * ------------------------------------------------------------------ */

/** How a view stands against the network, for an operator: `dust view at block C of N`. */
export const describeDustView = (covered: bigint | null, tip: bigint | null): string =>
  `dust view at block ${covered ?? '?'} of ${tip ?? '?'}`;

/** The indexer address an installed DUST wallet syncs from, or null when it names none. */
export const dustIndexerHttpOf = (dust: any): string | null => {
  const url = dust?.constructor?.configuration?.indexerClientConnection?.indexerHttpUrl;
  return typeof url === 'string' && url !== '' ? url : null;
};

/** Where the view stood when a strict wait ended. */
export type AtTipOutcome =
  | { readonly ok: true; readonly applied: bigint; readonly tip: bigint }
  | { readonly ok: false; readonly why: string };

export interface AtTipOptions {
  /** How long the view's block may stand still before the view counts as stalled. */
  readonly stallMs?: number;
  /** The most the whole wait may take. */
  readonly totalMs?: number;
  readonly pollMs?: number;
  readonly printMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * **WAITS UNTIL THE VIEW COVERS THE NEWEST BLOCK THE INDEXER HELD WHEN THE WAIT BEGAN, WITH NO TOLERANCE.**
 *
 * A spend proof is checked against the network's DUST trees, so a view even one block short can be refused. The
 * view's block is judged as everywhere (`dustViewHeight`, `dustViewCovers`): the block a finished pass reached, while
 * the view reports itself complete. It keeps waiting while that block moves, and answers not ok when it has stood
 * still for a minute, after twenty minutes in all, or when the indexer cannot say where the network is. It never
 * answers ok on a reading it did not make. Progress is printed as `dust view at block C of N`.
 */
export async function waitForDustAtTip(
  live: { state: () => any },
  tipNow: () => Promise<bigint>,
  note: (s: string) => void,
  o: AtTipOptions = {},
): Promise<AtTipOutcome> {
  const stallMs = o.stallMs ?? 60_000;
  const totalMs = o.totalMs ?? 20 * 60_000;
  const pollMs = o.pollMs ?? 1_000;
  const printMs = o.printMs ?? 10_000;
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const appliedNow = () => dustViewHeight(dustProgressOf(live.state()));

  const started = now();
  let tip: bigint;
  try {
    tip = await tipNow();
  } catch (e) {
    return { ok: false, why: `the indexer could not say how far the network's DUST has got: ${String((e as Error)?.message ?? e)}` };
  }
  let last = appliedNow();
  let movedAt = started;
  let printed = started;
  for (;;) {
    const applied = appliedNow();
    if (applied !== null && dustViewCovers(applied, tip)) return { ok: true, applied, tip };
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
  return `${describeDustView(dustViewHeight(dustProgressOf(state)), tip)}; `
    + `${count(() => dust.availableCoins)} coins free to spend, `
    + `${count(() => dust.state.pendingDust)} booked by the wallet, `
    + `${count(() => dust.state.state.utxos)} unbooked in the ledger state; balance ${balance}`;
}

/**
 * The bounded wait the probes and the deploy use: a view that has caught up
 * since the wait began (`dustCaughtUp`). A fee payer waits on `waitForDustAtTip`
 * instead, which reads the network's newest block.
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
  o: { sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {},
): Promise<boolean> {
  const sleep = o.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  const movedFrom = dustMovedFrom(live.state());
  const caughtUp = () => dustCaughtUp(dustProgressOf(live.state()), movedFrom);
  if (caughtUp()) return true;

  note('the dust wallet has a balance but has not finished catching up');
  note('waiting for it, because a spend proof built from a stale view is rejected (error 170)');
  const started = now();
  let printed = 0;
  while (!caughtUp()) {
    const elapsed = now() - started;
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

