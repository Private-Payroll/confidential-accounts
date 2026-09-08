/**
 * **THE SHIELDED SUB-WALLET'S SCAN, AND THE ONE PLACE ANYTHING WAITS FOR IT.**
 *
 * WHY THIS FILE EXISTS. Two doors needed a shielded coin and each answered the
 * question its own way. `mint-test-token.ts` polled for five minutes;
 * `deposit-to-vault.ts` read the coin list once, about three seconds after the
 * wallet was built, and threw. The mint's copy was the one that worked, and the
 * deposit refused twice in a row on 30 August with `the wallet holds 0 of that
 * colour` against a wallet that had held ten trillion of it minutes earlier.
 *
 * That is `M-104`'s shape again — one procedure, written twice, and the second
 * copy missing the part that mattered — and `M-141`'s answer applies: one copy,
 * and it lives where a caller cannot omit it.
 *
 * **AND THE BRING-UP MADE IT WORSE, NOT BETTER.** `wallet-bringup.ts` gates on
 * DUST and on nothing else. The dust cache exists so a run starts in seconds
 * instead of five minutes — and every second it saves is a second the shielded
 * scan has not had. The failing run's own report reads `wallet ready after 1s`
 * two lines above `the wallet holds 0 of that colour`. **A faster bring-up is a
 * younger shielded scan.**
 *
 * ------------------------------------------------------------------
 * WHAT THE PLATFORM ALREADY DOES, READ BEFORE ANY OF THIS WAS WRITTEN
 * ------------------------------------------------------------------
 *
 * Not asking this is the failure this
 * project has paid most for, so it was asked first.
 *
 * 1. **THE PREDICATE IS THE PLATFORM'S AND IS NOT REIMPLEMENTED HERE.**
 *    `@midnightntwrk/wallet-sdk-abstractions/SyncProgress` defines caught-up as
 *
 *        isConnected && |highestRelevantWalletIndex - appliedIndex| <= maxGap
 *
 *    and every state carries it as `progress.isCompleteWithin(gap)`. This file
 *    calls that method and falls back to the same arithmetic only if it is
 *    absent.
 *
 * 2. **THE PLATFORM HAS TWO WAITS. ONE IS UNBOUNDED AND THE OTHER DECIDES ON
 *    A RULE THIS REPOSITORY HAS ALREADY REJECTED.**
 *
 *    `ShieldedWalletAPI.waitForSyncedState(allowedGap = 0n)` is
 *    `rx.firstValueFrom(state.pipe(filter(isCompleteWithin)))` — no deadline,
 *    no output, and a wallet that never converges never returns from it.
 *
 *    **AND THE TESTKIT'S `syncWallet` IS BOUNDED AND DOES PRINT** — 90 seconds,
 *    a line per emission, `rx.timeout` on the end. An earlier draft of this
 *    comment said the SDK offered none of that, which was false and is
 *    corrected here by `S17`'s platform fact-check. It is still not called,
 *    for reasons that are about this chain rather than about it being absent:
 *    it gates on `isStrictlyComplete()`, which asks a wallet to outrun a live
 *    chain; it THROWS rather than returning which state it ended in,
 *    and this round exists because those states must be told apart; and it is
 *    reached through `wallet.start(true)`, whose `waitForFunds` can hit the
 *    faucet and submit a dust registration — a spend, which no door may take
 *    on its own (`CLAUDE.md` rule 2).
 *
 *    **So the predicate is borrowed and the loop is not**, and what is written
 *    here is a bound that returns an outcome instead of throwing one away.
 *
 * 3. **THE SHIELDED WALLET CAN PERSIST AND IN THIS REPOSITORY IT DOES NOT.**
 *    `ShieldedWalletAPI.serializeState()` and `ShieldedWalletClass.restore()`
 *    exist, exactly as the dust wallet's do. Nothing here calls either: the
 *    only cache in this repository is the DUST cache (`dust-wallet.ts`). See
 *    `deadlineIsMeasured` below — this is what makes the deadline a guess.
 *
 * ------------------------------------------------------------------
 * WHY THIS PROGRESS CAN BE TRUSTED — AND WHY THE FIRST DRAFT'S REASON WAS WRONG
 * ------------------------------------------------------------------
 *
 * **THE READING IS SOUND AND IT IS SOUND FOR BOTH SUB-WALLETS:**
 *
 *   · `isConnected` is set only when an event batch is applied — SDK
 *     `wallet-sdk-shielded/dist/v1/Sync.js:155`, in `applyUpdate`, and it is the
 *     only assignment of `true` in the package. Until then the platform's own
 *     predicate is FALSE, so a wallet that has scanned nothing cannot report
 *     itself caught up.
 *   · `highestRelevantWalletIndex` is `lastUpdate.maxId`, which the indexer
 *     computes as `SELECT MAX(id) FROM ledger_events WHERE grouping = $1`
 *     (`midnight-indexer/indexer-api/src/infra/storage/ledger_events.rs:58`).
 *     It is the chain's tip, not a per-batch maximum, and it moves. **It is
 *     chain-wide and not wallet-relevant despite its name** — a progress line,
 *     never "how many of my coins are left".
 *   · A restored wallet is deserialised with `isConnected: false` and
 *     `highestRelevantWalletIndex: 0n` (`v1/Serialization.js:75`), so it is not
 *     caught up until its own first batch either.
 *
 * **WHAT IS NOT TRUE, AND THE FIRST DRAFT OF THIS FILE SAID IT:** that the dust
 * sub-wallet is different. It is not. `wallet-sdk-dust-wallet/dist/v1/Sync.js`
 * assigns `isConnected` and `maxId` at the same points, and
 * `RunningV1Variant.js`'s progress block is identical text in both packages.
 * **The `/0` in every archived report of this project is a READER defect in
 * this repository, not a sub-wallet difference** — `dust-wallet.ts:199` and
 * five other sites read `highestRelevantIndex ?? highestIndex ??
 * highestTransactionId`, none of which the SDK ever assigns, while the field it
 * does assign appears in none of them. `REPORT-CHAIN-PROBE.txt:38` prints
 * `dust 3195/0` and `shielded 3177/0` side by side, which settles it.
 *
 * Found by `S17`'s platform fact-check, against this file. The conclusion
 * survives the correction — the platform's predicate is honest here — but the
 * reason given for it was a comparison that does not exist.
 *
 * **That is what makes the refusals distinguishable.** *The scan has not caught
 * up* and *there is no such coin* are different states of a value this wallet
 * reports honestly, not two readings of the same silence.
 *
 * ------------------------------------------------------------------
 * WHAT IS STILL OWED, AND IT IS BIGGER THAN THIS FILE
 * ------------------------------------------------------------------
 *
 * Two things the platform offers that this round did not take, both recorded
 * rather than started because `ROUND-S17.md` says a round that grows is wrong:
 *
 *   · **A SHIELDED STATE CACHE WOULD DELETE THE DEADLINE RATHER THAN JUSTIFY
 *     IT.** `ShieldedWallet.restore` exists, and the testkit ships a whole
 *     provider for it — `WalletSaveStateProvider`, with `save`/`load`, gzip and
 *     a seed-derived filename. `WalletFacade.shielded` is a plain public field,
 *     the same swap `dust-wallet.ts` already performs for dust. The twelve
 *     minutes below are the cost of not having done it.
 *   · **THE MINT DOOR'S QUESTION HAS AN EXACT ANSWER AND ASKS A HEURISTIC
 *     INSTEAD.** `watchForTxData(txId)` returns the block a transaction landed
 *     in, `TransactionStatus` reports a FAILED one in a single round trip, and
 *     `Transaction.zswapLedgerEvents` gives the event ids to compare against
 *     `appliedIndex` — which is *my transaction has been applied* with no gap
 *     and no deadline at all. `mint-test-token.ts` already builds the provider
 *     that does the first of these.
 *
 * Not asking whether the platform already
 * does it is the failure this project has paid most for. It was asked about the
 * predicate and about the wait. **It was not asked about the replay, and the
 * replay is the part that costs twelve minutes.**
 */
import { sleep } from '../src/midnight/retry.js';

/** Blocks of slack allowed against the tip. A live chain keeps producing them. */
export const SHIELDED_GAP = 10n;

/**
 * The bound, and **it is not a measurement.** `deadlineIsMeasured` is `false`
 * and the doors print that sentence rather than hiding it.
 *
 * It is 12 minutes because that is `wallet-bringup.ts`'s `coldTimeoutMs` — the
 * bound this repository already uses for a sync from genesis, sized against a
 * DUST replay measured at 271–284 seconds. **The shielded scan is also a replay
 * from genesis** (point 3 above: nothing persists shielded state here, so
 * `appliedIndex` is `0` every run and the indexer streams from the very start —
 * SDK `v1/Sync.js`, `resumeFrom = appliedIndex - 1n` with `id: null`), over a
 * different event stream, with a trial decryption per output. **Nothing here
 * has ever timed one.**
 *
 * So the inheritance is disclosed rather than laundered: it is the dust
 * wallet's number, it is the only genesis-replay duration this project has
 * measured, and it is larger than the five minutes the mint door invented.
 * `MIDNIGHT_SHIELDED_SCAN_TIMEOUT_MS` overrides it.
 */
export function deadlineFromEnv(raw: string | undefined): number {
  /*
   * **AN UNPARSEABLE OVERRIDE IS A REFUSAL, NOT A DEFAULT AND NOT A `NaN`.**
   *
   * `Number('soon')` is `NaN`, `elapsed > NaN` is false for every elapsed, and
   * the deadline branch below becomes unreachable — which is `M-22`, the
   * unbounded wait this whole file exists to avoid, restored by one typo in an
   * environment variable. Found by `S17`'s money-safety pass, against
   * this file. Exported so a test drives it directly rather than reloading a
   * module. Rule 19: the refusal names the door.
   */
  if (raw === undefined || raw.trim() === '') return 12 * 60_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `MIDNIGHT_SHIELDED_SCAN_TIMEOUT_MS is set to ${JSON.stringify(raw)}, which is not a ` +
      'positive number of milliseconds. A wait with no usable deadline does not return, and a ' +
      'door that does not return is worse than one that refuses.\n' +
      'Unset it and open DEPOSIT-TO-VAULT.command or MINT-TEST-TOKEN.command again.');
  }
  return parsed;
}

export const SHIELDED_SCAN_TIMEOUT_MS =
  deadlineFromEnv(process.env.MIDNIGHT_SHIELDED_SCAN_TIMEOUT_MS);

/** **NO SHIELDED SCAN HAS BEEN TIMED IN THIS REPOSITORY.** */
export const deadlineIsMeasured = false;

export const SHIELDED_DEADLINE_IS_NOT_MEASURED =
  'THE DEADLINE ABOVE IS NOT A MEASUREMENT. No shielded scan has ever been timed here; ' +
  'it inherits the dust wallet\x27s genesis-replay bound, which was measured on a different ' +
  'sub-wallet and a different event stream. The elapsed time this run prints is the first ' +
  'reading of it.';

/** The shielded state's progress, wherever the facade hangs it. */
export const shieldedProgressOf = (state: any): any =>
  state?.shielded?.progress ?? state?.shielded?.state?.progress ?? null;

/**
 * Whether the wallet will say anything at all about how far behind it is.
 *
 * `isConnected` goes true on the first applied batch and never before, so this
 * separates *nothing has been scanned yet* from *the scan reports a position*.
 */
export const shieldedProgressKnown = (p: any): boolean => {
  if (!p) return false;
  if (typeof p.isConnected === 'boolean') return p.isConnected;
  return typeof p.isCompleteWithin === 'function';
};

/** The platform's own definition, called and not reimplemented. */
export const shieldedCaughtUp = (p: any, gap: bigint = SHIELDED_GAP): boolean => {
  if (!p) return false;
  // Delegated when present, and the fallback is also taken when it THROWS —
  // stricter than the SDK either way, so it can only produce false negatives.
  try { if (typeof p.isCompleteWithin === 'function') return !!p.isCompleteWithin(gap); } catch { /* fall through */ }
  /*
   * **THE SDK'S STATIC `SyncProgress.isCompleteWithin(data, gap)` TAKES A PLAIN
   * OBJECT AND WAS READ BEFORE THIS WAS WRITTEN.** It is not called because it
   * does `BigInt(Math.abs(Number(h - a)))` unguarded, which throws on exactly
   * the partial data this branch exists for. `S17`'s platform fact-check.
   *
   * **THE FALLBACK DEFAULTED BOTH INDICES TO ZERO AND THEREFORE SAID YES TO
   * SILENCE** — `|0 - 0| <= 10` — which is exactly the `dustProgressKnown`
   * defect the header above claims this wallet does not have, reintroduced
   * here. Found by `S17`'s money-safety pass, against this file, and
   * no test reached the branch because every fake carried its own
   * `isCompleteWithin`.
   *
   * `wallet-bringup.ts:52-54` gets this right forty lines away: an absent index
   * is UNKNOWN and unknown is not caught up. A missing field must never read as
   * a zero-length gap.
   */
  try {
    if (p.isConnected !== true) return false;
    const rawA = p.appliedIndex;
    const rawH = p.highestRelevantWalletIndex;
    if (rawA === undefined || rawA === null || rawH === undefined || rawH === null) return false;
    const a = BigInt(rawA);
    const h = BigInt(rawH);
    return (a > h ? a - h : h - a) <= gap;
  } catch { return false; }
};

/** A number that moves, so a door that is waiting does not look like a door that has hung. */
export const describeShieldedProgress = (p: any): string => {
  if (!p) return 'the shielded wallet reports no progress yet';
  if (!shieldedProgressKnown(p)) return 'no event applied yet — the scan has not delivered its first batch';
  try {
    const rawA = p.appliedIndex;
    const rawH = p.highestRelevantWalletIndex;
    // Never `?? 0n`: a missing index printed as zero reads as a position.
    if (rawA === undefined || rawA === null || rawH === undefined || rawH === null) {
      return 'the shielded wallet reports itself connected and names no position';
    }
    const a = BigInt(rawA);
    const h = BigInt(rawH);
    const behind = h > a ? h - a : 0n;
    return `shielded ${a.toLocaleString()} of ${h.toLocaleString()} — ${behind.toLocaleString()} events behind`;
  } catch { return 'the shielded progress could not be read as numbers'; }
};

/**
 * **WHAT THE WALLET HOLDS OF ONE COLOUR — OR `null`, WHICH IS NOT ZERO.**
 *
 * **ONE COPY, AND THE FIRST DRAFT OF IT WAS A `C271`.** `deposit-to-vault.ts`
 * and `mint-test-token.ts` each had their own and they had already drifted; the
 * shared replacement then wrapped the whole read in `catch { return 0n; }`, so
 * a coin whose value would not parse, a colour spelled differently, or a
 * throwing getter zeroed the entire colour — and the door spelled that zero
 * *"there is no such coin … it was already spent."* Found by `S17`'s
 * money-safety pass, against this file. A
 * read that failed must never be reported as a quantity that is absent.
 *
 * **SO `null` MEANS COULD NOT READ AND `0n` MEANS GENUINELY NONE**, and every
 * caller has to say which it is holding.
 *
 * **AND THE PLATFORM'S OWN ANSWER IS USED FIRST.** `ShieldedWalletState.balances`
 * is `getAvailableBalances(state)` — the SDK's own sum over the same available
 * coins, keyed by raw token type. Walking `availableCoins` by hand was this
 * file borrowing the platform's predicate and reimplementing its arithmetic in
 * the same breath. The walk survives only as a fallback for a state that
 * carries coins and no balances map.
 *
 * **`balances` IS `getAvailableBalances`, WHICH EXCLUDES PENDING OUTPUTS**
 * (`getTotalBalances` is the one that includes them). That is what both callers
 * want — a coin that cannot yet be spent cannot fund a deposit — but it is a
 * choice and not an accident.
 *
 * **NOT AN IDENTIFICATION AND NEVER USED AS ONE.** Which coin a run created is
 * answered by the call itself; this answers only whether the wallet has SEEN a
 * colour, which is a different question with a different failure.
 */
export const shieldedHeldOf = (state: any, colour: string): bigint | null => {
  const wanted = String(colour ?? '').toLowerCase();
  if (!wanted) return null;
  let shielded: any;
  try { shielded = state?.shielded; } catch { return null; }
  if (!shielded) return null;

  try {
    const balances = shielded.balances;
    if (balances && typeof balances === 'object') {
      let total: bigint | null = null;
      for (const [key, value] of Object.entries(balances)) {
        if (String(key).toLowerCase() !== wanted) continue;
        total = (total ?? 0n) + BigInt(value as any);
      }
      return total ?? 0n;
    }
  } catch { return null; }

  /*
   * **UNREACHABLE AGAINST A REAL `ShieldedWalletState`, AND KEPT ANYWAY.**
   * `balances` is a getter that always returns an object — `{}` when there are
   * no coins — so the branch above always takes, and a throwing getter returns
   * `null` before this line. What reaches here is a state that is not the
   * SDK's: a partial object, or a fake. It stays because returning `null` for
   * an unrecognised shape is the whole point of this function, and it is
   * labelled rather than presented as a live path. `S17`'s
   * platform fact-check.
   */
  try {
    const coins = shielded.availableCoins;
    if (coins === undefined || coins === null) return null;
    let total = 0n;
    for (const entry of [...coins]) {
      const c: any = (entry as any)?.coin ?? entry;
      if (String(c?.type ?? '').toLowerCase() !== wanted) continue;
      total += BigInt(c.value);   // a value that will not parse throws out to null
    }
    return total;
  } catch { return null; }
};

export type ShieldedWaitOutcome = {
  /** `caught-up` reached the tip; `found` satisfied `until` first; `deadline` ran out. */
  readonly reached: 'caught-up' | 'found' | 'deadline';
  /** The platform's predicate at the moment the wait ended. */
  readonly caughtUp: boolean;
  /** Whether the wallet said anything about its position at all. */
  readonly known: boolean;
  /**
   * **THE CALLER WAS WAITING FOR ITS OWN IN-FLIGHT COIN**, so a caught-up scan
   * settles nothing about whether that coin exists. `whyNoCoin` refuses to
   * reach a verdict on existence when this is true. See `until` below.
   */
  readonly awaitedOwnCoin: boolean;
  readonly waitedMs: number;
  readonly describe: string;
};

export interface ShieldedWaitOptions {
  /**
   * **THE CALLER'S OWN QUESTION, AND WHEN IT IS GIVEN IT IS THE ONLY WAY OUT
   * BUT THE DEADLINE.**
   *
   * The mint door asks *has my coin arrived*, about a transaction it submitted
   * seconds ago. **Caught-up must NOT end that wait.** `isCompleteWithin(10n)`
   * is true while up to ten events behind the tip, which is precisely where a
   * just-submitted coin lives — so the first draft of this file returned
   * `caught-up` at `waitedMs: 0`, read zero, and printed *"there is no such
   * coin … or it was already spent"* about a coin minted seconds earlier. It
   * replaced a five-minute wait for the right thing with a zero-second wait for
   * the wrong one. Found by `S17`'s money-safety pass, against this
   * file.
   *
   * So with `until` the exits are `found` and `deadline`; without it they are
   * `caught-up` and `deadline`.
   */
  until?: () => boolean;
  timeoutMs?: number;
  gap?: bigint;
  /** Between polls. The scan is minutes long; a tighter loop buys nothing. */
  pollMs?: number;
}

/**
 * **BLOCKS UNTIL THE SHIELDED SCAN HAS CAUGHT UP, AND NEVER LONGER THAN ITS
 * DEADLINE.** Bounded and non-fatal, like `waitForDustCatchUp`: it returns what
 * happened and the caller writes the sentence, because the two callers refuse
 * for different reasons and only one of them refuses at all.
 */
export async function waitForShieldedScan(
  live: { state: () => any },
  note: (s: string) => void,
  options: ShieldedWaitOptions = {},
): Promise<ShieldedWaitOutcome> {
  const gap = options.gap ?? SHIELDED_GAP;
  const timeoutMs = options.timeoutMs ?? SHIELDED_SCAN_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 2_000;
  const until = options.until;

  const outcome = (reached: ShieldedWaitOutcome['reached'], waitedMs: number): ShieldedWaitOutcome => {
    const p = shieldedProgressOf(live.state());
    return {
      reached,
      caughtUp: shieldedCaughtUp(p, gap),
      known: shieldedProgressKnown(p),
      awaitedOwnCoin: until !== undefined,
      waitedMs,
      describe: describeShieldedProgress(p),
    };
  };

  /** With a caller's own question, reaching the tip is not an answer to it. */
  const satisfied = (): boolean =>
    until ? until() : shieldedCaughtUp(shieldedProgressOf(live.state()), gap);

  if (satisfied()) return outcome(until ? 'found' : 'caught-up', 0);

  note('waiting for the shielded sub-wallet to scan — it has no cache here, so it replays from genesis every run');
  note(`  deadline ${Math.round(timeoutMs / 1000)}s. ${SHIELDED_DEADLINE_IS_NOT_MEASURED}`);

  const started = Date.now();
  let printed = 0;
  for (;;) {
    const elapsed = Date.now() - started;
    if (satisfied()) return outcome(until ? 'found' : 'caught-up', elapsed);
    if (elapsed > timeoutMs) return outcome('deadline', elapsed);
    if (elapsed - printed >= 10_000) {
      printed = elapsed;
      note(`  ${String(Math.round(elapsed / 1000)).padStart(4)}s  ${describeShieldedProgress(shieldedProgressOf(live.state()))}`);
    }
    await sleep(pollMs);
  }
}

/**
 * **THE SENTENCES, AND NO TWO OF THEM ARE INTERCHANGEABLE.**
 *
 * A door holding no coin of a colour is in one of five states, and they do not
 * have the same remedy — waiting fixes two of them, nothing fixes one, and two
 * are the door's own fault rather than the chain's. **Printing the wrong one
 * either tells a person their money is gone while it is arriving, or sends
 * them away to wait for a coin that will never come.**
 *
 * `S17` asked for two. The money-safety pass found three more hiding
 * inside them — a read that failed, a wait that never ran, and a caller asking
 * about a coin it had just submitted, for which *there is no such coin* is
 * never a sound verdict at all.
 *
 * `kind` is what a caller branches on; `holding` is the state named in so many
 * words, which is the round's requirement that the door say WHICH ONE it is
 * holding.
 */
export type NoCoinReason = {
  readonly kind: 'cannot-read' | 'never-waited' | 'not-scanned-yet' | 'not-caught-up' | 'no-such-coin';
  readonly holding: string;
  readonly message: string;
};

const NOTHING_SPENT =
  'Nothing was proved and nothing was spent by this run.';

/**
 * @param held  what `shieldedHeldOf` answered — `null` means the coin list
 *              could not be read, which is not a balance of nothing.
 */
export function whyNoCoin(
  colour: string,
  outcome: ShieldedWaitOutcome | null,
  held: bigint | null = 0n,
): NoCoinReason {
  const shortColour = `${String(colour ?? '').slice(0, 16)}…`;

  if (held === null) {
    return {
      kind: 'cannot-read',
      holding: 'THE COIN LIST COULD NOT BE READ',
      message:
        'THE COIN LIST COULD NOT BE READ, AND THAT IS NOT A BALANCE OF NOTHING. The wallet\x27s ' +
        'shielded state did not answer with a number this door could use, so it does not know ' +
        `whether it holds any of colour ${shortColour} and will not guess.\n` +
        `${NOTHING_SPENT} This is a fault in this machine\x27s wallet or in this door, not a ` +
        'statement about the chain.',
    };
  }

  if (!outcome) {
    return {
      kind: 'never-waited',
      holding: 'THE SHIELDED SCAN WAS NEVER WAITED FOR',
      message:
        'THE SHIELDED SCAN WAS NEVER WAITED FOR BY THIS RUN, so this door has no idea whether ' +
        `it holds any of colour ${shortColour}. It is not saying the coin is missing and it is ` +
        'not saying the scan is behind.\n' +
        'This is a defect in the door rather than a condition to wait out: the wallet was ' +
        'brought up without asking for the shielded wait, and running it again unchanged ' +
        `produces this same answer forever.\n${NOTHING_SPENT}`,
    };
  }

  if (outcome.awaitedOwnCoin) {
    /*
     * **THE CALLER SUBMITTED THIS COIN ITSELF, SO EXISTENCE IS NOT ON THE
     * TABLE.** A caught-up scan means within ten events of the tip, and a coin
     * submitted seconds ago is exactly what sits in that window.
     */
    return {
      kind: 'not-scanned-yet',
      holding: 'THE WALLET HAS NOT SCANNED IT YET',
      message:
        'THE WALLET HAS NOT SCANNED IT YET, AND THAT IS NOT THE TRANSACTION HAVING FAILED. ' +
        `${outcome.describe}, after ${Math.round(outcome.waitedMs / 1000)}s.\n` +
        'THIS DOOR WILL NOT SAY THE COIN DOES NOT EXIST. It submitted it itself, and a scan ' +
        'that has reached the tip says nothing about a transaction that may not be in a block ' +
        `yet.\n${SHIELDED_DEADLINE_IS_NOT_MEASURED}`,
    };
  }

  if (outcome.caughtUp) {
    return {
      kind: 'no-such-coin',
      holding: 'THERE IS NO SUCH COIN',
      message:
        `THERE IS NO SUCH COIN. The shielded scan HAS caught up — ${outcome.describe} — and this ` +
        `wallet holds nothing of colour ${shortColour}.\n` +
        'Waiting will not change this answer. Either the coin was never minted to this wallet\x27s ' +
        `own coin public key, or it was already spent. ${NOTHING_SPENT}`,
    };
  }

  return {
    kind: 'not-caught-up',
    holding: 'THE SCAN HAS NOT CAUGHT UP',
    message:
      'THE SCAN HAS NOT CAUGHT UP, AND THAT IS NOT THE SAME AS THERE BEING NO SUCH COIN. ' +
      `${outcome.describe}, after ${Math.round(outcome.waitedMs / 1000)}s.\n` +
      (outcome.known
        ? 'The wallet is reporting a position and had not reached the tip when the deadline passed.'
        : 'The wallet had not applied a single event when the deadline passed, so it has not yet ' +
          'said anything about where it is.') + '\n' +
      'THIS DOOR IS NOT SAYING THE COIN IS MISSING. It is saying it cannot see far enough to ' +
      `answer. ${SHIELDED_DEADLINE_IS_NOT_MEASURED}\n` +
      `${NOTHING_SPENT} Run this door again — it reaches nothing until this check passes.`,
  };
}
