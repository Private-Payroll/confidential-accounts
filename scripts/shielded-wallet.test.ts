/**
 * **THE WAIT THAT WAS WRITTEN TWICE, AND THE TWO SENTENCES THAT MUST NEVER BE
 * THE SAME SENTENCE.**
 *
 * The defect this file exists for is not an exception or a wrong number. It is
 * that `DEPOSIT-TO-VAULT.command` read a coin list three seconds after the
 * wallet was built, printed `the wallet holds 0 of that colour`, and told a
 * person to wait — against a wallet that had held ten trillion of it minutes
 * earlier. It was right by accident. **The same output for the opposite
 * situation — a coin that does not exist and never will — would send somebody
 * away to wait forever, and no test on a return value catches that.**
 *
 * So the tests here are about WHICH STATE IS NAMED, and about the wait being
 * bounded rather than the SDK's own unbounded one.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  shieldedProgressOf, shieldedProgressKnown, shieldedCaughtUp, describeShieldedProgress,
  shieldedHeldOf, waitForShieldedScan, whyNoCoin, deadlineIsMeasured,
  SHIELDED_DEADLINE_IS_NOT_MEASURED, SHIELDED_SCAN_TIMEOUT_MS, deadlineFromEnv,
  type ShieldedWaitOutcome,
} from './shielded-wallet.js';

/** The SDK's own shape: `isCompleteWithin` over `highestRelevantWalletIndex - appliedIndex`. */
const progress = (applied: bigint, tip: bigint, isConnected = true) => ({
  appliedIndex: applied,
  highestRelevantWalletIndex: tip,
  isConnected,
  isCompleteWithin(maxGap = 50n) {
    const lag = applied > tip ? applied - tip : tip - applied;
    return isConnected && lag <= maxGap;
  },
});

const stateWith = (p: unknown, coins: unknown[] = []) => ({ shielded: { progress: p, availableCoins: coins } });
const balancesWith = (p: unknown, balances: Record<string, bigint>) => ({ shielded: { progress: p, balances } });

/**
 * **A MADE-UP COLOUR. IT IS NOT THE STAGENET TEST TOKEN'S, AND IT USED TO BE.**
 *
 * MEASURED: every use below treats the colour as an OPAQUE KEY — a property
 * name in `balances`, a `type` field on a coin, the argument `whyNoCoin` slices
 * to sixteen characters for a message. Nothing resolves it, nothing reaches a
 * chain for it; the one place a second colour is needed uses `'ff'.repeat(32)`
 * and always has. So the live value bought this file nothing and cost it two
 * things: the folder's scanner reads it out of `.midnight/` and refuses it in a
 * file that ships, and it goes stale the day the test token is re-minted.
 *
 * **IT IS A CONSTANT AND NOT A FIXTURE ON PURPOSE.** A fixture read from
 * `.midnight/` is absent in a clone, and a test that dies for want of a
 * deployment nobody outside this machine can reach is the defect `M-3` and
 * `T-395` already are.
 *
 * **AND IT IS NOT A REPEATING PATTERN, WHICH IS NOT COSMETIC.** The first
 * version of this constant was `'a1'.repeat(32)`, and an audit measured what
 * that cost: **its forty-nine sixteen-character windows collapse to TWO
 * distinct strings**, so `slice(0, 16)` and `slice(4, 20)` are equal and the
 * prefix assertion in the last group below stopped being able to fail. **A
 * uniform placeholder quietly unpins whatever reads a PIECE of it**, and the
 * two properties this file leans on are asserted rather than assumed — see
 * *the placeholder colour is not arbitrary* below.
 */
const COLOUR = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';

describe('the platform decides what caught up means, not this repository', () => {
  it('is NOT caught up before the first batch, even at applied 0 and tip 0', () => {
    /*
     * **THE WHOLE DISTINCTION RESTS ON THIS.** The dust wallet reports `highest`
     * as 0 — unknown — so `applied >= highest` is trivially true and any check
     * built on it says yes forever (`dust-wallet.ts`, `dustProgressKnown`). The
     * shielded wallet does not have that defect: `isConnected` is set only when
     * an event batch is applied, so a wallet that has scanned nothing cannot
     * report itself finished. If this test ever goes green with `false`, the
     * two refusals below stop being distinguishable and this round is undone.
     */
    expect(shieldedCaughtUp(progress(0n, 0n, false))).toBe(false);
    expect(shieldedProgressKnown(progress(0n, 0n, false))).toBe(false);
  });

  it('is caught up within the gap, because a live chain keeps producing blocks', () => {
    expect(shieldedCaughtUp(progress(1_000n, 1_005n))).toBe(true);
    expect(shieldedCaughtUp(progress(1_000n, 1_200n))).toBe(false);
  });

  it('calls the SDK method when there is one and never recomputes over it', () => {
    const spy = vi.fn(() => true);
    expect(shieldedCaughtUp({ isCompleteWithin: spy, isConnected: false })).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it('reads progress from either place the facade hangs it', () => {
    const p = progress(1n, 2n);
    expect(shieldedProgressOf({ shielded: { progress: p } })).toBe(p);
    expect(shieldedProgressOf({ shielded: { state: { progress: p } } })).toBe(p);
    expect(shieldedProgressOf({})).toBeNull();
  });

  it('says nothing rather than zero when the wallet has said nothing', () => {
    expect(describeShieldedProgress(progress(0n, 0n, false))).toMatch(/no event applied yet/i);
    expect(describeShieldedProgress(null)).toMatch(/no progress yet/i);
  });

  it('prints a number that moves', () => {
    // A door that appears to hang is a door a person kills.
    expect(describeShieldedProgress(progress(400n, 1_000n))).toMatch(/600 events behind/);
  });

  /*
   * **THE FALLBACK, WHICH NO TEST ABOVE REACHES.** Every fake in this file
   * carries its own `isCompleteWithin`, so the delegated path is taken and the
   * hand-written arithmetic runs in no test at all. The first draft of that
   * arithmetic defaulted both indices to `0n`, so `|0-0| <= 10` said CAUGHT UP
   * to a wallet that had said nothing — the exact `dustProgressKnown` defect
   * this module's header claims the shielded wallet does not have. Found by
   * `S17`'s money-safety pass; these are the tests that were missing.
   */
  describe('the fallback arithmetic, for a state with no isCompleteWithin', () => {
    it('REFUSES A PROGRESS THAT NAMES NO POSITION, rather than reading it as a zero gap', () => {
      expect(shieldedCaughtUp({ isConnected: true })).toBe(false);
      expect(shieldedCaughtUp({ isConnected: true, appliedIndex: 1n })).toBe(false);
      expect(shieldedCaughtUp({ isConnected: true, highestRelevantWalletIndex: 1n })).toBe(false);
    });

    it('refuses a field spelled the SDK\x27s other way rather than assuming a gap of zero', () => {
      // `highestRelevantIndex` is a real neighbouring field. A one-word slip
      // between it and `highestRelevantWalletIndex` used to make the predicate
      // a constant true with no error anywhere.
      expect(shieldedCaughtUp({ isConnected: true, appliedIndex: 1n, highestRelevantIndex: 9_999n })).toBe(false);
    });

    it('still answers on a progress that names both, and answers correctly', () => {
      expect(shieldedCaughtUp({ isConnected: true, appliedIndex: 995n, highestRelevantWalletIndex: 1_000n })).toBe(true);
      expect(shieldedCaughtUp({ isConnected: true, appliedIndex: 1n, highestRelevantWalletIndex: 1_000n })).toBe(false);
      expect(shieldedCaughtUp({ isConnected: false, appliedIndex: 1_000n, highestRelevantWalletIndex: 1_000n })).toBe(false);
    });

    it('does not print `0 of 0` for a wallet that named no position', () => {
      expect(describeShieldedProgress({ isConnected: true })).toMatch(/names no position/);
      expect(describeShieldedProgress({ isConnected: true })).not.toMatch(/0 of 0/);
    });
  });
});

describe('what the wallet holds of one colour, and when it will not say', () => {
  /*
   * **`null` IS NOT ZERO, AND THE FIRST DRAFT OF THIS MODULE MADE IT ZERO.**
   *
   * It wrapped the whole read in `catch { return 0n; }`, so an unparseable coin
   * value, a colour spelled differently, or a throwing getter zeroed the entire
   * colour — and the door spelled that zero *"there is no such coin … it was
   * already spent."* `C197`, `C268`, `C271`: a read that failed reported as a
   * quantity that is absent. Found by `S17`'s money-safety pass.
   */
  it('USES THE PLATFORM\x27S OWN BALANCE when the state carries one', () => {
    // `ShieldedWalletState.balances` is `getAvailableBalances(state)` — the
    // SDK's own sum over the same coins. Walking the coin list by hand was
    // this module borrowing a predicate and reimplementing the arithmetic.
    expect(shieldedHeldOf(balancesWith(null, { [COLOUR]: 42n, ['ff'.repeat(32)]: 9n }), COLOUR)).toBe(42n);
  });

  it('answers 0n for a colour a readable balances map does not carry', () => {
    // Genuinely none. That is a fact, and it is allowed to be zero.
    expect(shieldedHeldOf(balancesWith(null, { ['ff'.repeat(32)]: 9n }), COLOUR)).toBe(0n);
  });

  it('falls back to the coin list only when there is no balances map', () => {
    const st = stateWith(progress(1n, 1n), [
      { type: COLOUR, value: 40n },
      { coin: { type: COLOUR, value: 2n } },
      { type: 'ff'.repeat(32), value: 999n },
    ]);
    expect(shieldedHeldOf(st, COLOUR)).toBe(42n);
  });

  it('matches the colour case-insensitively', () => {
    expect(shieldedHeldOf(balancesWith(null, { [COLOUR.toUpperCase()]: 5n }), COLOUR)).toBe(5n);
  });

  it('the placeholder colour is not arbitrary, and these are the two things it must stay', () => {
    /*
     * **THE COLOUR IS NOW WHATEVER A ROUND TYPES, NOT WHATEVER THE CHAIN
     * MINTED**, so the properties the tests around it lean on have to be held
     * by something. Without the first, the case-insensitive test above passes
     * on `5n === 5n` with the fold never exercised. Without the second, the
     * `slice(0, 16)` assertion in the last group is vacuous — which is exactly
     * what `'a1'.repeat(32)` did before an audit measured it.
     */
    expect(COLOUR.toUpperCase()).not.toBe(COLOUR);
    const windows = new Set(
      Array.from({ length: COLOUR.length - 15 }, (_, i) => COLOUR.slice(i, i + 16)));
    expect(windows.size).toBe(COLOUR.length - 15);
  });

  it('ANSWERS null, NEVER ZERO, WHEN IT COULD NOT READ', () => {
    /*
     * Each of these produced `0n` in the first draft, and `0n` on a caught-up
     * scan is the sentence *"it was already spent"*. Delete the `null` returns
     * and this is what fails.
     */
    expect(shieldedHeldOf({}, COLOUR)).toBeNull();                       // no shielded state
    expect(shieldedHeldOf(null, COLOUR)).toBeNull();
    expect(shieldedHeldOf({ shielded: {} }, COLOUR)).toBeNull();         // neither balances nor coins
    expect(shieldedHeldOf(stateWith(null, [{ type: COLOUR, value: '1.0' }]), COLOUR)).toBeNull();
    const throwing = { shielded: { get availableCoins(): never { throw new Error('gone'); } } };
    expect(shieldedHeldOf(throwing, COLOUR)).toBeNull();
    const throwingBalances = { shielded: { get balances(): never { throw new Error('gone'); } } };
    expect(shieldedHeldOf(throwingBalances, COLOUR)).toBeNull();
  });

  it('does not let one unreadable coin be reported as a smaller balance', () => {
    // The sum is the thing being funded. A partial sum is a wrong number, not
    // a conservative one — and it would fund a deposit at the wrong size.
    const st = stateWith(null, [{ type: COLOUR, value: 40n }, { type: COLOUR, value: {} }]);
    expect(shieldedHeldOf(st, COLOUR)).toBeNull();
  });
});

describe('the wait is bounded, which the SDK\x27s own wait is not', () => {
  const notes: string[] = [];
  const note = (s: string) => { notes.push(s); };

  it('returns immediately when the scan is already at the tip', async () => {
    const live = { state: () => stateWith(progress(10n, 10n)) };
    const out = await waitForShieldedScan(live, note, { timeoutMs: 50, pollMs: 1 });
    expect(out.reached).toBe('caught-up');
    expect(out.caughtUp).toBe(true);
  });

  it('RETURNS AT THE DEADLINE instead of never returning', async () => {
    /*
     * `ShieldedWalletAPI.waitForSyncedState` is `firstValueFrom(filter(...))`
     * with no deadline. A wallet that never converges never returns from it,
     * which is `M-22` — the reason `wallet.start(true)` is banned in this
     * repository. The predicate is borrowed; the loop is not.
     */
    const live = { state: () => stateWith(progress(1n, 9_999n)) };
    const out = await waitForShieldedScan(live, note, { timeoutMs: 30, pollMs: 5 });
    expect(out.reached).toBe('deadline');
    expect(out.caughtUp).toBe(false);
  });

  it('stops early on the caller\x27s own question, which the mint door asks', async () => {
    // The mint's coin can arrive before the scan reaches the tip. Waiting for
    // the tip anyway would be minutes spent after the answer was known.
    let seen = 0;
    const live = { state: () => stateWith(progress(1n, 9_999n)) };
    const out = await waitForShieldedScan(live, note, {
      timeoutMs: 5_000, pollMs: 1, until: () => ++seen > 3,
    });
    expect(out.reached).toBe('found');
    expect(out.awaitedOwnCoin).toBe(true);
  });

  it('DOES NOT END ON CAUGHT-UP WHEN THE CALLER ASKED ITS OWN QUESTION', async () => {
    /*
     * **THE REGRESSION THIS ROUND ALMOST SHIPPED.** `isCompleteWithin(10n)` is
     * true while up to ten events behind the tip, which is exactly where a coin
     * submitted seconds ago sits. The first draft returned `caught-up` at
     * `waitedMs: 0` against a wallet at the tip, read zero, and printed *"there
     * is no such coin … or it was already spent"* about a coin minted seconds
     * earlier — a five-minute wait for the right thing replaced by a
     * zero-second wait for the wrong one. Found by `S17`'s
     * money-safety pass.
     */
    let polls = 0;
    const live = { state: () => stateWith(progress(1_000n, 1_000n)) };   // at the tip throughout
    const out = await waitForShieldedScan(live, note, {
      timeoutMs: 5_000, pollMs: 1, until: () => ++polls > 4,
    });
    expect(out.reached).toBe('found');
    expect(out.waitedMs).toBeGreaterThan(0);
    expect(out.caughtUp).toBe(true);   // it WAS caught up, and that answered nothing
  });

  it('runs to its deadline rather than declaring a caught-up scan an answer', async () => {
    const live = { state: () => stateWith(progress(1_000n, 1_000n)) };
    const out = await waitForShieldedScan(live, note, {
      timeoutMs: 20, pollMs: 5, until: () => false,
    });
    expect(out.reached).toBe('deadline');
  });

  it('says in its own output that the deadline is not a measurement', async () => {
    notes.length = 0;
    const live = { state: () => stateWith(progress(1n, 9_999n)) };
    await waitForShieldedScan(live, note, { timeoutMs: 20, pollMs: 5 });
    expect(notes.join('\n')).toContain('NOT A MEASUREMENT');
    expect(deadlineIsMeasured).toBe(false);
  });

  it('REFUSES AN UNPARSEABLE OVERRIDE rather than becoming unbounded', () => {
    /*
     * `Number('soon')` is `NaN`, `elapsed > NaN` is false for every elapsed,
     * and the deadline branch becomes unreachable — `M-22` restored by a typo
     * in an environment variable, in the file written to avoid it. Found by
     * `S17`'s money-safety pass. Rule 19: the refusal names a door.
     */
    for (const bad of ['soon', '0', '-1', 'Infinity', '1e400']) {
      expect(() => deadlineFromEnv(bad)).toThrow(/not a positive number of milliseconds/);
      expect(() => deadlineFromEnv(bad)).toThrow(/DEPOSIT-TO-VAULT\.command/);
    }
  });

  it('takes an unset or blank override as the default, and a good one as itself', () => {
    expect(deadlineFromEnv(undefined)).toBe(12 * 60_000);
    expect(deadlineFromEnv('   ')).toBe(12 * 60_000);
    expect(deadlineFromEnv('90000')).toBe(90_000);
  });

  it('has a deadline larger than the five minutes the mint door invented', () => {
    // Not a justification. The inheritance is disclosed in the module's own
    // comment and in the door's output; this only pins that it was not copied.
    expect(SHIELDED_SCAN_TIMEOUT_MS).toBeGreaterThan(5 * 60_000);
    expect(SHIELDED_DEADLINE_IS_NOT_MEASURED).toMatch(/no shielded scan has ever been timed/i);
  });
});

describe('THE SENTENCES, AND NO TWO OF THEM INTERCHANGEABLE', () => {
  const outcome = (over: Partial<ShieldedWaitOutcome>): ShieldedWaitOutcome => ({
    reached: 'deadline', caughtUp: false, known: true, awaitedOwnCoin: false,
    waitedMs: 720_000, describe: 'shielded 400 of 1,000 — 600 events behind', ...over,
  });
  const notCaughtUp = outcome({});
  const caughtUp = outcome({
    reached: 'caught-up', caughtUp: true, waitedMs: 31_000,
    describe: 'shielded 1,000 of 1,000 — 0 events behind',
  });
  const ownCoin = outcome({ awaitedOwnCoin: true, caughtUp: true });

  it('names WHICH state it is holding, in so many words', () => {
    expect(whyNoCoin(COLOUR, notCaughtUp).holding).toMatch(/HAS NOT CAUGHT UP/);
    expect(whyNoCoin(COLOUR, caughtUp).holding).toMatch(/NO SUCH COIN/);
    expect(whyNoCoin(COLOUR, ownCoin).holding).toMatch(/HAS NOT SCANNED IT YET/);
    expect(whyNoCoin(COLOUR, null).holding).toMatch(/NEVER WAITED FOR/);
    expect(whyNoCoin(COLOUR, caughtUp, null).holding).toMatch(/COULD NOT BE READ/);
  });

  it('gives all five a different kind, so a caller cannot collapse two of them', () => {
    const kinds = [
      whyNoCoin(COLOUR, notCaughtUp).kind, whyNoCoin(COLOUR, caughtUp).kind,
      whyNoCoin(COLOUR, ownCoin).kind, whyNoCoin(COLOUR, null).kind,
      whyNoCoin(COLOUR, caughtUp, null).kind,
    ];
    expect(new Set(kinds).size).toBe(5);
  });

  it('NEVER presents a scan that has not caught up as a coin that does not exist', () => {
    const m = whyNoCoin(COLOUR, notCaughtUp).message;
    expect(whyNoCoin(COLOUR, notCaughtUp).kind).toBe('not-caught-up');
    expect(m).toMatch(/NOT THE SAME AS THERE BEING NO SUCH COIN/i);
    expect(m).toMatch(/is not saying the coin is missing/i);
    expect(m).not.toMatch(/there is no such coin\./i);
  });

  it('NEVER SAYS A COIN DOES NOT EXIST TO THE RUN THAT SUBMITTED IT, EVEN AT THE TIP', () => {
    /*
     * The one the audit caught. `caughtUp` is true here and it settles nothing:
     * the caller's own transaction may not be in a block yet.
     */
    const r = whyNoCoin(COLOUR, ownCoin);
    expect(r.kind).toBe('not-scanned-yet');
    expect(r.message).toMatch(/NOT THE TRANSACTION HAVING FAILED/i);
    expect(r.message).toMatch(/will not say the coin does not exist/i);
    expect(r.message).not.toMatch(/already spent/i);
    expect(r.message).not.toMatch(/waiting will not change/i);
  });

  it('does not tell a person to wait when waiting cannot help', () => {
    const m = whyNoCoin(COLOUR, caughtUp).message;
    expect(whyNoCoin(COLOUR, caughtUp).kind).toBe('no-such-coin');
    expect(m).toMatch(/waiting will not change this answer/i);
    expect(m).not.toMatch(/run this door again/i);
  });

  it('CALLS A FAILED READ A FAILED READ, and never a balance of nothing', () => {
    const r = whyNoCoin(COLOUR, caughtUp, null);
    expect(r.kind).toBe('cannot-read');
    expect(r.message).toMatch(/NOT A BALANCE OF NOTHING/i);
    expect(r.message).toMatch(/will not guess/i);
    expect(r.message).not.toMatch(/already spent/i);
    expect(r.message).not.toMatch(/THERE IS NO SUCH COIN/);
  });

  it('says a run that never waited is a defect in the door, not a wait to repeat', () => {
    // The old text told a person to run it again, which would produce the same
    // answer forever. `S17`'s money-safety pass.
    const r = whyNoCoin(COLOUR, null);
    expect(r.kind).toBe('never-waited');
    expect(r.message).toMatch(/defect in the door/i);
    expect(r.message).toMatch(/running it again unchanged/i);
    expect(r.message).not.toMatch(/THE SCAN HAS NOT CAUGHT UP/);
  });

  it('every one of them says nothing was proved and nothing was spent', () => {
    // The run stops four stages before the call in every case, and a person
    // reading a refusal needs that settled before anything else. The
    // in-flight one says it about THIS run only, because a mint did submit.
    for (const r of [notCaughtUp, caughtUp, null]) {
      expect(whyNoCoin(COLOUR, r).message).toMatch(/nothing was proved and nothing was spent/i);
    }
    expect(whyNoCoin(COLOUR, caughtUp, null).message).toMatch(/nothing was proved and nothing was spent/i);
  });

  it('distinguishes a wallet that reported a position from one that reported none', () => {
    const silent = outcome({ known: false, describe: 'no event applied yet' });
    expect(whyNoCoin(COLOUR, silent).message).toMatch(/had not applied a single event/i);
    expect(whyNoCoin(COLOUR, notCaughtUp).message).toMatch(/is reporting a position/i);
  });

  it('quotes the colour it looked for, so a person can check it against the record', () => {
    expect(whyNoCoin(COLOUR, caughtUp).message).toContain(COLOUR.slice(0, 16));
  });
});
