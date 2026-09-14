/**
 * **THE REBUILD DOOR'S RULES, PINNED, BECAUSE THE DOOR ITSELF MAY NOT BE RUN.**
 *
 * Rule 1 forbids a session running a `.command`, including the one it has just
 * written, so the door's decisions live in an importable file and are measured
 * here with named mutations. The two worst defects ever found in a door in this
 * project both lived in the half that was outside the typecheck and outside the
 * test glob, where nothing but text matching reached.
 */
import { describe, it, expect } from 'vitest';
import {
  decideWhetherToWrite, assertNoSignerWouldLoseAccess, assertTheVaultIsNotDisposed,
  assertThePoolHasNotMovedSinceTheRebuild, linesForAnOperator,
} from './reconcile-vault-pool-rules.js';
import type { PoolRecovery } from '../src/midnight/vault-recovery.js';

const note = (n: string, value: bigint) => ({
  nonce: n.repeat(32), token: 'aa'.repeat(32), value, commitment: n.repeat(32),
});
const recovery = (r: Partial<PoolRecovery>): PoolRecovery => ({
  held: [], recovered: [], stale: [], unexplained: [], paid: [], ...r,
});
/**
 * **THE DEFAULT IS ADDITIVE, AND THESE TESTS ASK FOR THE DEFAULT.** A rebuild
 * adds notes the chain holds and removes none, because removing one can strand
 * the change note of a payment in flight. `claims` is what the newest filed
 * version holds, which is what a write is judged against.
 */
const decide = (r: PoolRecovery, claims = r.held.length + r.stale.length, alsoDropStaleNotes = false) =>
  decideWhetherToWrite({ recovery: r, notesTheNewestVersionClaims: claims, alsoDropStaleNotes });

describe('whether a rebuild is written at all', () => {
  /**
   * **THE ONE THAT OUTRANKS THE REST. `CLAUDE.md` 28 AND 29.**
   *
   * The chain holds money and the rebuild explained none of it. What it would
   * write is `{ notes: [] }` -- and an empty pool is a CLAIM that this vault has
   * nothing, indistinguishable afterwards from the truth. Every balance, every
   * affordability check and every screen would then agree that a funded treasury
   * is empty.
   */
  it('REFUSES to write when the chain holds notes and the rebuild explained none of them', () => {
    const d = decide(recovery({ unexplained: ['ee'.repeat(32), 'ff'.repeat(32)] }));
    expect(
      d.do,
      'RED WHEN: a rebuild that explains nothing is written anyway, which replaces the record of a treasury with a claim that it is empty -- and nothing afterwards can tell that claim from the truth',
    ).toBe('refuse');
    expect(d.why, 'RED WHEN: the refusal stops saying that this is ignorance rather than a balance of zero, which is the one distinction this whole area exists to keep')
      .toMatch(/empty pool is a claim/i);
    /*
     * **RULE 19: A REFUSAL NAMES WHAT RESOLVES IT, IN TERMS THE READER CAN ACT ON.**
     * Both halves, because either alone is a dead end: where a record might be
     * found, AND that no rebuild can invent one. A person told only the first goes
     * looking forever; told only the second, they stop looking at all.
     */
    expect(d.why, 'RED WHEN: the refusal stops saying where a record of these notes might be found')
      .toMatch(/backup|deposits that created/i);
    /*
     * TWO PHRASES, TWO ASSERTIONS, NOT ONE ALTERNATION. An `|` here would stay
     * green while half the remedy was deleted -- which a mutation did.
     */
    expect(d.why, 'RED WHEN: the refusal stops saying a commitment cannot be inverted, which is the reason no amount of re-running helps')
      .toMatch(/cannot be inverted/i);
    expect(d.why, 'RED WHEN: the refusal stops saying that no rebuild can invent what a note is worth, so somebody keeps re-running this door expecting a different answer')
      .toMatch(/invent what a note is worth/i);
  });

  /**
   * **AND IT FIRES WHATEVER ELSE IS WRONG, WHICH IS THE ORDER THAT MATTERS.**
   *
   * A vault whose records are missing normally ALSO has a pool claiming notes the
   * chain does not hold -- that is the same event seen from the other side. A
   * refusal that only fired when nothing was stale would therefore pass in
   * precisely the case it exists for, and write an empty pool over a treasury.
   * Found by mutation: adding `&& r.stale.length === 0` left every other assertion
   * in this file green.
   */
  it('REFUSES an empty result even when the pool ALSO claims notes the chain does not hold', () => {
    const r = recovery({ stale: [note('99', 5_000n)], unexplained: ['ee'.repeat(32)] });
    expect(
      decide(r, 1, true).do,
      'RED WHEN: the empty-pool refusal is conditioned on nothing being stale, which is exactly the shape a vault with missing records has -- so the refusal passes in the one case it was written for',
    ).toBe('refuse');
  });

  /**
   * **THE CASE THE FIRST VERSION OF THIS FILE GOT WRONG, FOUND BY AN AUDIT OF
   * THIS ROUND.** The refusal was keyed on the chain holding notes the rebuild
   * could not explain. A chain read that answers ZERO notes leaves nothing
   * unexplained -- so the refusal did not fire, and the door wrote an empty pool
   * over a funded vault. `C268`: a partial decode reads as an empty vault, and it
   * reached the one door written to survive it.
   */
  it('REFUSES an empty result when the chain answered NOTHING and the pool claims notes', () => {
    const r = recovery({ stale: [note('99', 5_000n)], unexplained: [] });
    expect(
      decide(r, 1, true).do,
      'RED WHEN: the guard against writing an empty pool is keyed on the same read that came back empty -- a chain answering "no notes" then writes zero over a treasury, and every balance afterwards agrees',
    ).toBe('refuse');
    expect(decide(r, 1, true).do === 'refuse' && (decide(r, 1, true) as { why: string }).why,
      'RED WHEN: the refusal stops telling the operator to read the chain again, which is the one thing that distinguishes an empty answer from an empty vault')
      .toMatch(/read it again/i);
  });

  /**
   * **AND THE DEFAULT CANNOT REACH THAT STATE AT ALL, WHICH IS THE REAL FIX.**
   * Adding notes back can never empty a pool, so the dangerous half is the one
   * that is opt-in.
   */
  it('cannot empty a pool by default, because by default it only adds', () => {
    const d = decide(recovery({ stale: [note('99', 5_000n)] }), 1);
    expect(
      d.do,
      'RED WHEN: removing notes becomes the default again, which is how a rebuild strands the change note of a payment in flight',
    ).toBe('nothing');
    if (d.do !== 'nothing') throw new Error('unreachable');
    expect(d.why, 'RED WHEN: the door stops saying WHY it left a stale note alone, so somebody removes it by hand while a payment is in flight')
      .toMatch(/only safe when nothing is paying/i);
  });

  it('does NOTHING when the pool already says what the chain says', () => {
    const d = decide(recovery({ held: [note('11', 1_000n), note('22', 400n)] }));
    expect(
      d.do,
      'RED WHEN: an agreeing pool is rewritten anyway -- a rewrite of the money is a chance to write half of it, and there is no reason here to take it',
    ).toBe('nothing');
  });

  it('does NOTHING for a vault the chain holds nothing for, rather than calling it empty', () => {
    expect(decide(recovery({})).do).toBe('nothing');
    expect(decide(recovery({})).why,
      'RED WHEN: a never-funded vault and a vault whose records are missing are described the same way')
      .toMatch(/never been funded/i);
  });

  it('WRITES when the chain holds a note the pool had lost', () => {
    const d = decide(recovery({
      held: [note('11', 1_000n), note('22', 400n)], recovered: [note('22', 400n)],
    }));
    expect(
      d.do,
      'RED WHEN: a note the chain holds and the pool has lost is left out of the pool, which is money nothing can spend',
    ).toBe('write');
    if (d.do !== 'write') throw new Error('unreachable');
    expect(d.recovers).toBe(1);
  });

  it('WRITES to drop a note the chain does not hold ONLY when asked to, and then says so', () => {
    const d = decide(recovery({
      held: [note('11', 1_000n)], stale: [note('99', 5_000n)],
    }), 2, true);
    /*
     * RED WHEN: a pool claiming notes the chain has nullified is left alone. Every
     * payment that chose one would be proposed, approved, PAID FOR, and then
     * refused inside the circuit -- two fees for a refusal available free.
     */
    expect(d.do, 'RED WHEN: a stale note is left in the pool, so a later payment pays two fees to be refused by the circuit').toBe('write');
  });

  /**
   * **AND A REBUILD THAT BOTH RECOVERS AND DROPS STILL SAYS WHAT IS LEFT
   * UNEXPLAINED.** A write that fixes two problems out of three, reported as a
   * success, is how somebody stops looking for the third.
   */
  it('carries the unexplained count into a decision to write, rather than dropping it', () => {
    const d = decide(recovery({
      held: [note('11', 1_000n)], recovered: [note('11', 1_000n)], unexplained: ['ee'.repeat(32)],
    }));
    if (d.do !== 'write') throw new Error('expected a write');
    expect(
      d.unexplained,
      'RED WHEN: a rebuild reports success and says nothing about money the vault holds that it could not name, so nobody goes looking for it',
    ).toBe(1);
  });
});

describe('a rebuild never takes away a signer\'s access, and never lands on a pool that moved', () => {
  it('REFUSES when writing would leave a signer unable to read the pool', () => {
    expect(
      () => assertNoSignerWouldLoseAccess(['a', 'b', 'c'], ['a', 'b']),
      'RED WHEN: a repair silently ends a signer\'s access to the record of the company\'s money and reports success -- one matching signer is enough to open the pool and enough to write it back narrower',
    ).toThrow(/no longer lists \(c\)/);
  });

  it('allows a write that keeps every reader, and one that adds a reader', () => {
    expect(() => assertNoSignerWouldLoseAccess(['a', 'b'], ['a', 'b'])).not.toThrow();
    expect(() => assertNoSignerWouldLoseAccess(['a', 'b'], ['a', 'b', 'c'])).not.toThrow();
    expect(() => assertNoSignerWouldLoseAccess(['a', 'a', 'b'], ['a', 'b'])).not.toThrow();
  });

  it('names a dropped signer ONCE however many times the pool lists them', () => {
    /*
     * RED WHEN: the dropped list is not de-duplicated. A pool wrapped twice for one
     * id -- which a re-seal after a partial write can leave -- would then be
     * described as two signers losing access, and a count somebody acts on would be
     * wrong in the refusal that stops a repair.
     */
    const why = (() => {
      try { assertNoSignerWouldLoseAccess(['a', 'c', 'c'], ['a']); return ''; }
      catch (e) { return (e as Error).message; }
    })();
    expect(why, 'RED WHEN: one signer listed twice is reported as two signers losing access')
      .toMatch(/1 signer\(s\).*\(c\)/);
  });

  it('REFUSES a rebuild worked out from a version the pool has since left', () => {
    expect(
      () => assertThePoolHasNotMovedSinceTheRebuild(4, 5),
      'RED WHEN: a whole-pool rebuild is written over a version another writer filed while the chain was being read, which erases what that writer recorded with no refusal',
    ).toThrow(/version 4 .* version 5 now/);
    expect(() => assertThePoolHasNotMovedSinceTheRebuild(5, 5)).not.toThrow();
  });

  it('says to run it again, because a rebuild is not a difference that can be re-applied', () => {
    const why = (() => { try { assertThePoolHasNotMovedSinceTheRebuild(4, 5); return ''; } catch (e) { return (e as Error).message; } })();
    expect(why, 'RED WHEN: the refusal stops saying what resolves it')
      .toMatch(/Run this again/i);
    expect(why, 'RED WHEN: it stops saying WHY re-applying is not available, which is the thing that makes this different from every other write to this pool')
      .toMatch(/no correct merge/i);
  });
});

describe('a vault recorded as disposed of is refused before the chain is asked', () => {
  /**
   * **THE FOUNDER HAD SAID WHICH VAULTS WERE DEAD AND IT WAS NOWHERE ON DISK.**
   * This round measured a rebuild against one of them before learning so. A fact
   * that decides whether a door may touch money belongs in the record the door
   * reads, and then something has to read it.
   */
  it('REFUSES a disposed vault, names why, and names the live one', () => {
    const why = (() => {
      try {
        assertTheVaultIsNotDisposed('payroll-test-2',
          { disposed: true, disposed_why: 'deployed before spendingCaps existed' }, 'payroll-test-3');
        return '';
      } catch (e) { return (e as Error).message; }
    })();
    expect(
      why,
      'RED WHEN: a vault recorded as disposed of is worked against anyway -- its ledger is a field short of what this build compiles, so the note set a read hands back is not its note set, and this door would offer to write an emptier pool than it started from',
    ).toMatch(/DISPOSED OF/);
    expect(why, 'RED WHEN: the refusal stops saying why, so it reads as bureaucracy and somebody works around it')
      .toMatch(/spendingCaps/);
    expect(why, 'RED WHEN: the refusal stops naming the live vault, which is the only thing the reader can act on')
      .toMatch(/"payroll-test-3"/);
    expect(why, 'RED WHEN: it stops saying what reading the wrong field DOES, which is the reason this is a refusal rather than a warning')
      .toMatch(/counting fields/);
  });

  it('allows a vault that is not disposed, and one whose record says nothing either way', () => {
    expect(() => assertTheVaultIsNotDisposed('payroll-test-3', { disposed: false }, 'payroll-test-3')).not.toThrow();
    /*
     * RED WHEN: an absent flag is treated as disposed. Every registry written
     * before this was recorded has no flag at all, and refusing those would refuse
     * every vault on every machine that has not been rewritten.
     */
    expect(() => assertTheVaultIsNotDisposed('older', {}, undefined)).not.toThrow();
  });

  it('still refuses when the registry records no live vault, rather than saying nothing useful', () => {
    const why = (() => {
      try { assertTheVaultIsNotDisposed('dead', { disposed: true }, undefined); return ''; }
      catch (e) { return (e as Error).message; }
    })();
    expect(why, 'RED WHEN: the refusal depends on a live vault being recorded, so a registry without one refuses with no remedy at all')
      .toMatch(/Name it/);
  });
});

describe('what the operator is shown', () => {
  it('names unexplained money loudest, and never prints the vault\'s address', () => {
    const lines = linesForAnOperator(recovery({
      held: [note('11', 1_000n)], recovered: [note('11', 1_000n)],
      stale: [note('99', 5_000n)], unexplained: ['ee'.repeat(32)],
    })).join('\n');

    expect(lines, 'RED WHEN: the four counts stop being four -- they have four different consequences and one list makes a person act on all of them the same way')
      .toMatch(/notes the chain holds that nothing here explains {2,}1/);
    expect(lines, 'RED WHEN: unexplained money stops being described as money the vault holds, so it reads as a tidying-up detail')
      .toMatch(/HOLDS MONEY THIS MACHINE CANNOT NAME/);
    expect(lines, 'RED WHEN: it stops saying that a stale note costs two fees and then a refusal, which is why dropping it is worth a write')
      .toMatch(/refused inside the circuit/);
    /*
     * **`C236` IS NOT GUARDED HERE, AND SAYING SO IS BETTER THAN PRETENDING.** The
     * first version of this test asserted that these lines carry no vault address --
     * which cannot fail, because `linesForAnOperator` is never given one. An
     * auditor called it decorative and was right. What actually keeps a vault's
     * address off the screen is the `forbidden`/`createScreen` mechanism in
     * `scripts/reconcile-vault-pool.ts`, which this file does not reach, and that is
     * a door the session that wrote it may not run.
     *
     * What IS worth pinning here: these lines are built from note nonces and
     * commitments, and the function takes nothing else, so there is nothing for an
     * address to arrive THROUGH.
     */
    expect(
      Object.keys(recovery({})),
      'RED WHEN: a vault address is added to what this function is given, at which point it can reach a screen and the guard against that is in a door nothing here tests',
    ).toEqual(['held', 'recovered', 'stale', 'unexplained', 'paid']);
  });

  it('bounds the lists rather than printing a thousand notes past the top of the window', () => {
    const many = Array.from({ length: 30 }, (_, i) => note(i.toString(16).padStart(2, '0'), BigInt(i + 1)));
    /*
     * **`recovered` IS IN THE FIXTURE NOW, AND IT IS THE LIST THAT WAS UNBOUNDED.**
     * The first version left it empty, so the one list the product printed in full
     * was the one nothing exercised -- and `toHaveLength(2)` below was right for the
     * wrong reason: two was the number of populated BOUNDED lists. An auditor found
     * both halves of that.
     */
    const lines = linesForAnOperator(recovery({
      held: many, recovered: many, stale: many, unexplained: many.map((n) => n.commitment),
    }));
    /*
     * RED WHEN: the lists are unbounded. The four counts at the top are the answer,
     * and a door that scrolls them off the screen has hidden the one line that
     * says how much was not explained.
     */
    /*
     * **THREE LISTS, EIGHT ENTRIES EACH, AND ONE LINE PER LIST SAYING HOW MANY WERE
     * LEFT OUT: TWENTY-SEVEN.** Written as the arithmetic rather than as a round
     * number, because the round number was calibrated when the fixture exercised two
     * lists and would have accepted a third one running to thirty.
     */
    expect(lines.filter((l) => l.startsWith('    ')).length,
      'RED WHEN: any one of the three lists is unbounded, which scrolls the four counts off the top of the window -- and the four counts are where the answer is')
      .toBeLessThanOrEqual(3 * (8 + 1));
    /*
     * RED WHEN: any ONE of the lists is truncated silently. Asserting the phrase
     * once would pass while two of the three under-reported -- which is `C188`'s
     * "guard on some of N" shape, and it is how this very assertion was written
     * the first time.
     */
    expect(
      lines.filter((l) => l.includes('and 22 more')),
      'RED WHEN: a list is cut short without saying so, which under-reports how much is wrong -- and a count lower than the number of lists lets one of them do it silently',
    ).toHaveLength(3);
  });
});
