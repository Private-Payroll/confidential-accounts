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
  decideWhetherToWrite, assertNoSignerWouldLoseAccess,
  assertThePoolHasNotMovedSinceTheRebuild, linesForAnOperator,
  notesNeedingATransaction, whatTheRebuildWrites, whereTheRecordsAre, settlementsNotYetRecorded,
} from './reconcile-vault-pool-rules.js';
import { NoteDescribedTwice, type PoolRecovery } from '../src/midnight/vault-recovery.js';
import type { Note } from '../src/midnight/vault-notes.js';
import type { Hex } from '../src/core/crypto.js';

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
    const why = (() => {
      try { assertNoSignerWouldLoseAccess(['a', 'c'], ['a'], "this vault's payment journal"); return ''; }
      catch (e) { return (e as Error).message; }
    })();
    expect(
      why,
      'RED WHEN: the refusal sends the reader to a door that does not exist - nothing on this machine removes a signer deliberately, for a pool or a journal',
    ).not.toMatch(/door that exists/);
    expect(why, 'RED WHEN: the refusal stops naming what resolves it').toMatch(/What resolves it: add them back to the signers file and run this again/);
    expect(why, 'RED WHEN: the refusal pretends removing a signer is something the reader can do here').toMatch(/nothing on this machine makes that decision\s+yet/);
    expect(why).toMatch(/^this vault's payment journal is readable by 1 signer/);
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

/*
 * **THE REFUSAL OF A RETIRED VAULT WAS TESTED HERE AND IS NOW TESTED WHERE IT
 * LIVES**, in `src/midnight/vault-record.test.ts`. It moved because it was a
 * rule this one door remembered and nine others did not.
 */

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

/* ------------------------------------------------------------------ *
 * what is written, note by note, and whether a payment can spend it
 * ------------------------------------------------------------------ */

describe('what a rebuild writes, and whether each note it writes can be spent', () => {
  const TX_OLD = '0a'.repeat(32) as Hex;
  const TX_NEW = '0b'.repeat(32) as Hex;
  const TX_CHAIN = '0c'.repeat(32) as Hex;
  const coin = (n: string, value: bigint, createdIn?: Hex): Note => ({
    nonce: n.repeat(32) as Hex, token: 'aa'.repeat(32) as Hex, value, ...(createdIn ? { createdIn } : {}),
  });
  const heldAs = (c: Note) => ({ nonce: c.nonce, token: c.token, value: c.value, commitment: 'cc'.repeat(32) as Hex });

  it('KEEPS the transaction a later version recorded, rather than taking the note from the version that filed it first', () => {
    /*
     * The note was filed at v1 without its transaction; the repair recorded it at v2.
     * The rebuild's held note is v1's object, because the union keeps the first
     * filing of a nonce. The door used to write that object over v2's.
     */
    const versions = [
      { version: 1, notes: [coin('11', 500n)] },
      { version: 2, notes: [coin('11', 500n, TX_NEW)] },
    ];
    const w = whatTheRebuildWrites({
      versions, held: [heldAs(coin('11', 500n))], alsoDropStaleNotes: false, found: [],
    });
    expect(
      w.notes,
      'RED WHEN: a rebuild writes the held note over the newest version\'s entry, so a transaction the repair recorded is lost again and the note is refused at the next payment',
    ).toEqual([coin('11', 500n, TX_NEW)]);
    expect(w.notYetSpendable).toEqual([]);
    expect(w.established).toBe(0);
  });

  it('takes a CORRECTED transaction from the newer version, not the wrong one an older version held', () => {
    const versions = [
      { version: 1, notes: [coin('11', 500n, TX_OLD)] },
      { version: 2, notes: [coin('11', 500n, TX_NEW)] },
    ];
    const w = whatTheRebuildWrites({
      versions, held: [heldAs(coin('11', 500n))], alsoDropStaleNotes: true, found: [],
    });
    expect(
      w.notes[0]!.createdIn,
      'RED WHEN: versions are searched oldest first, so a hash the repair replaced because the chain showed it did not create the note comes back -- a note that reads as healthy and is refused at the spend',
    ).toBe(TX_NEW);
  });

  it('keeps a transaction an OLDER version recorded when the newest version lost it', () => {
    const versions = [
      { version: 1, notes: [coin('11', 500n, TX_OLD)] },
      { version: 2, notes: [coin('11', 500n)] },
    ];
    const w = whatTheRebuildWrites({ versions, held: [heldAs(coin('11', 500n))], alsoDropStaleNotes: false, found: [] });
    expect(
      w.notes,
      'RED WHEN: only the newest version is consulted, so a rebuild that once wrote a note without its transaction makes that loss permanent',
    ).toEqual([coin('11', 500n, TX_OLD)]);
    expect(
      notesNeedingATransaction({ versions, held: [heldAs(coin('11', 500n))] }),
      'RED WHEN: the chain is asked about a note a filed version already names the transaction of',
    ).toEqual([]);
  });

  it('gives a recovered note the transaction the CHAIN established, and counts it as a reason to write', () => {
    const versions = [{ version: 1, notes: [coin('11', 500n, TX_OLD)] }];
    const recovered = coin('22', 150n);
    const needing = notesNeedingATransaction({ versions, held: [heldAs(coin('11', 500n)), heldAs(recovered)] });
    expect(needing, 'RED WHEN: a recovered note is not put to the chain, so it is written with no transaction and cannot be spent')
      .toEqual([{ nonce: recovered.nonce, token: recovered.token, value: 150n }]);
    const w = whatTheRebuildWrites({
      versions, held: [heldAs(coin('11', 500n)), heldAs(recovered)], alsoDropStaleNotes: false,
      found: [{ nonce: recovered.nonce, createdIn: TX_CHAIN }],
    });
    expect(
      w.notes,
      'RED WHEN: what the chain established is not written onto the recovered note -- a note found, named, listed as held and still unreachable',
    ).toEqual([coin('11', 500n, TX_OLD), coin('22', 150n, TX_CHAIN)]);
    expect(w.established, 'RED WHEN: a transaction the chain gave is not counted, so a rebuild whose only news is that note gaining one writes nothing').toBe(1);
    expect(w.notYetSpendable).toEqual([]);
    const d = decideWhetherToWrite({
      recovery: recovery({ held: [note('11', 500n)] }), notesTheNewestVersionClaims: 1,
      alsoDropStaleNotes: false, transactionsEstablished: 1,
    });
    expect(d.do, 'RED WHEN: a note gaining its creating transaction is not a reason to write, so the read that made it spendable is thrown away').toBe('write');
    expect(d.why).toMatch(/1 note\(s\) gain the transaction that created them/);
  });

  it('a transaction the chain gives NEVER replaces one a version recorded', () => {
    const versions = [{ version: 1, notes: [coin('11', 500n, TX_OLD)] }];
    const w = whatTheRebuildWrites({
      versions, held: [heldAs(coin('11', 500n))], alsoDropStaleNotes: false,
      found: [{ nonce: coin('11', 500n).nonce, createdIn: TX_CHAIN }],
    });
    expect(w.notes[0]!.createdIn, 'RED WHEN: the chain\'s answer is preferred to the filed record, so this door quietly becomes a second repair').toBe(TX_OLD);
    expect(w.established).toBe(0);
  });

  it('a note NOTHING names the transaction of is STILL WRITTEN, and listed with its reason', () => {
    const versions = [{ version: 1, notes: [coin('11', 500n, TX_OLD)] }];
    const lost = coin('22', 150n);
    const w = whatTheRebuildWrites({
      versions, held: [heldAs(coin('11', 500n)), heldAs(lost)], alsoDropStaleNotes: false,
      found: [{ nonce: lost.nonce, unresolved: 'the chain could not list the transactions', candidates: [] }],
    });
    expect(
      w.notes.map((n) => n.nonce),
      'RED WHEN: a note without a transaction is left out of the write, which puts money the journal named back to being unnameable',
    ).toEqual([coin('11', 500n).nonce, lost.nonce]);
    expect(w.notes[1]).not.toHaveProperty('createdIn');
    expect(
      w.notYetSpendable,
      'RED WHEN: a note written without its transaction is not listed, so the pool entry reads as ordinary money to the person who wrote it',
    ).toEqual([{ nonce: lost.nonce, value: 150n, why: 'the chain could not list the transactions', candidates: [] }]);
    const unasked = whatTheRebuildWrites({ versions, held: [heldAs(lost)], alsoDropStaleNotes: false, found: [] });
    expect(unasked.notYetSpendable[0]!.why).toMatch(/was not asked/);
  });

  it('lists as not spendable only notes the CHAIN holds, and writes four fields and no others', () => {
    const stale = { ...coin('33', 70n), index: 4n, commitment: 'dd'.repeat(32), attemptedAt: 'x' } as unknown as Note;
    const w = whatTheRebuildWrites({
      versions: [{ version: 1, notes: [stale] }], held: [], alsoDropStaleNotes: false, found: [],
    });
    expect(w.notYetSpendable, 'RED WHEN: a stale note is reported as money a payment cannot spend yet, which it will never be').toEqual([]);
    expect(
      w.notes,
      'RED WHEN: an index, a commitment or any other field a record carried is written into the pool -- a stored index is a number a later spend could be handed',
    ).toEqual([coin('33', 70n)]);
    const dropped = whatTheRebuildWrites({
      versions: [{ version: 1, notes: [stale] }], held: [], alsoDropStaleNotes: true, found: [],
    });
    expect(dropped.notes, 'RED WHEN: dropping stale notes on request no longer drops them').toEqual([]);
  });

  it('a recorded value that is NOT a transaction hash counts as not recorded, so the chain is asked and its answer written', () => {
    const versions = [
      { version: 1, notes: [coin('11', 500n, TX_OLD)] },
      { version: 2, notes: [coin('11', 500n, '0x' as Hex)] },
      { version: 3, notes: [coin('22', 70n, 'abc' as Hex)] },
    ];
    const held = [heldAs(coin('11', 500n)), heldAs(coin('22', 70n))];
    expect(
      notesNeedingATransaction({ versions, held }).map((n) => n.value),
      'RED WHEN: a malformed recorded value is trusted, so the chain is never asked about a note whose spend will be refused after its fees',
    ).toEqual([70n]);
    const w = whatTheRebuildWrites({
      versions, held, alsoDropStaleNotes: false,
      found: [{ nonce: coin('22', 70n).nonce, createdIn: TX_CHAIN }],
    });
    expect(
      w.notes,
      'RED WHEN: a value that is not a hash is written back, or hides the valid hash an older version recorded',
    ).toEqual([coin('22', 70n, TX_CHAIN), coin('11', 500n, TX_OLD)]);
    expect(w.established).toBe(1);
  });

  it('writes the coin the CHAIN holds when the newest version describes that nonce differently, once, with the transaction recorded for that coin', () => {
    const wrong = coin('11', 999n, TX_NEW);
    const right = coin('11', 500n, TX_OLD);
    const versions = [
      { version: 1, notes: [right] },
      { version: 2, notes: [wrong, coin('22', 70n, TX_OLD)] },
    ];
    for (const alsoDropStaleNotes of [false, true]) {
      const w = whatTheRebuildWrites({
        versions, held: [heldAs(right), heldAs(coin('22', 70n))], alsoDropStaleNotes, found: [],
      });
      expect(
        w.notes.filter((n) => n.nonce === right.nonce),
        `RED WHEN: the newest version's description of a nonce the chain settled otherwise is written, or written beside the chain's (drop ${alsoDropStaleNotes})`,
      ).toEqual([right]);
      expect(w.notes.map((n) => n.value).sort((a, b) => Number(a - b))).toEqual([70n, 500n]);
    }
    /* Another colour at the same value is another description, and the chain's is still the one written. */
    const otherColour = { ...right, token: 'bb'.repeat(32) as Hex, createdIn: TX_NEW };
    const colours = whatTheRebuildWrites({
      versions: [{ version: 1, notes: [right] }, { version: 2, notes: [otherColour] }],
      held: [heldAs(right)], alsoDropStaleNotes: false, found: [],
    });
    expect(
      colours.notes,
      'RED WHEN: a description in another colour is taken for the chain\'s coin because the values match',
    ).toEqual([right]);
    /* The chain's answer about the coin it holds is not given to a version's other description of that nonce, and is counted once. */
    const answered = whatTheRebuildWrites({
      versions: [{ version: 1, notes: [coin('11', 999n)] }],
      held: [heldAs(coin('11', 500n))], alsoDropStaleNotes: false,
      found: [{ nonce: coin('11', 500n).nonce, createdIn: TX_CHAIN }],
    });
    expect(answered.notes).toEqual([coin('11', 500n, TX_CHAIN)]);
    expect(
      answered.established,
      'RED WHEN: a note is counted as gaining its transaction twice, once for the description it replaced',
    ).toBe(1);
    const neitherAnswered = whatTheRebuildWrites({
      versions: [{ version: 1, notes: [coin('11', 999n)] }],
      held: [], alsoDropStaleNotes: false,
      found: [{ nonce: coin('11', 500n).nonce, createdIn: TX_CHAIN }],
    });
    expect(
      neitherAnswered.notes,
      'RED WHEN: the transaction the chain named for one coin is written onto a different description of the same nonce',
    ).toEqual([coin('11', 999n)]);
    expect(neitherAnswered.established).toBe(0);
    /* A note the chain holds as the version describes it is still written once, as the version has it. */
    const same = whatTheRebuildWrites({ versions: [{ version: 1, notes: [right] }], held: [heldAs(right)], alsoDropStaleNotes: false, found: [] });
    expect(same.notes).toEqual([right]);
    /* A nonce the chain holds under NO description is left as any stale note is: kept additively, dropped on request. */
    const neither = whatTheRebuildWrites({ versions: [{ version: 2, notes: [wrong] }], held: [], alsoDropStaleNotes: false, found: [] });
    expect(neither.notes).toEqual([wrong]);
  });

  it('prints a note the chain settled ONCE, in its own section, naming every record and which description the chain holds', () => {
    const r = recovery({
      held: [note('11', 500n)], recovered: [note('11', 500n)], stale: [note('11', 999n), note('33', 5n)],
    });
    const lines = linesForAnOperator(r, [], [
      {
        nonce: '11'.repeat(32) as Hex,
        chainHolds: { token: 'aa'.repeat(32) as Hex, value: 500n, records: [{ kind: 'pool version', version: 1 }, { kind: 'deposit journal' }] },
        setAside: [{ token: 'aa'.repeat(32) as Hex, value: 999n, records: [{ kind: 'pool version', version: 2 }] }],
      },
      {
        nonce: '44'.repeat(32) as Hex,
        setAside: [
          { token: 'aa'.repeat(32) as Hex, value: 1n, records: [{ kind: 'pool version', version: 2 }] },
          { token: 'aa'.repeat(32) as Hex, value: 2n, records: [{ kind: 'payment journal' }] },
        ],
      },
    ]);
    const text = lines.join('\n');
    expect(text, 'RED WHEN: the settlement is not counted where the operator reads the counts').toMatch(/notes described two ways, settled by the chain +2/);
    expect(text).toMatch(/RECORDS HERE DESCRIBE THESE NOTES MORE THAN ONE WAY, AND THE CHAIN SAID WHICH IS MONEY/);
    expect(
      text,
      'RED WHEN: the records behind the chain\'s description are not named, so the settlement is not answerable',
    ).toMatch(/1111111111111111…\n +the chain holds this one: +version 1 of the pool, the deposit journal say 500\n +set aside: +version 2 of the pool says 999/);
    expect(text).toMatch(/4444444444444444…\n +the chain holds none of them, so no record here describes money this vault holds now\n +set aside: +version 2 of the pool says 1\n +set aside: +the payment journal says 2/);
    expect(text, 'RED WHEN: the settlement tells anybody to edit or move a record').toMatch(/No record is edited, moved or dropped/);
    expect(
      text,
      'RED WHEN: the chain\'s coin for a settled nonce is also listed as lost, or the set-aside description as stale, so one note is reported three ways',
    ).not.toMatch(/THE POOL HAD LOST THESE/);
    const staleBlock = text.slice(text.indexOf('THE POOL CLAIMED THESE'));
    expect(staleBlock).toContain('3333333333333333');
    expect(staleBlock).not.toContain('1111111111111111');
    /*
     * A nonce the chain holds none of is still written additively as the newest
     * version has it, so it stays in the stale list, where what resolves it is said.
     */
    const withNeither = linesForAnOperator(recovery({ stale: [note('44', 1n)] }), [], [{
      nonce: '44'.repeat(32) as Hex,
      setAside: [{ token: 'aa'.repeat(32) as Hex, value: 1n, records: [{ kind: 'pool version', version: 2 }] }],
    }]).join('\n');
    expect(
      withNeither.slice(withNeither.indexOf('THE POOL CLAIMED THESE')),
      'RED WHEN: a note the rebuild still writes and the chain does not hold is left out of the stale list, so the screen contradicts the write',
    ).toContain('4444444444444444');
    /* Nothing settled, nothing said. */
    expect(linesForAnOperator(r).join('\n')).not.toMatch(/settled by the chain|MORE THAN ONE WAY/);
  });

  it('refuses to build a write with no version under it', () => {
    expect(() => whatTheRebuildWrites({ versions: [], held: [], alsoDropStaleNotes: false, found: [] }))
      .toThrow(/no filed version/);
  });

  it('tells the operator which recovered notes can be spent and which cannot, and what resolves the second', () => {
    const r = recovery({ held: [note('11', 1_000n), note('22', 150n)], recovered: [note('11', 1_000n), note('22', 150n)] });
    const lines = linesForAnOperator(r, [{ nonce: '22'.repeat(32), value: 150n, why: 'the indexer is behind', candidates: [] }]);
    const spendableBlock = lines.slice(lines.findIndex((l) => l.startsWith('THE POOL HAD LOST')));
    const until = spendableBlock.findIndex((l) => l === '');
    const claimedSpendable = spendableBlock.slice(1, until === -1 ? undefined : until).join('\n');
    expect(claimedSpendable).toContain('1111111111111111');
    expect(
      claimedSpendable,
      'RED WHEN: a recovered note nothing names the transaction of is still listed under "they can be spent again"',
    ).not.toContain('2222222222222222');
    const text = lines.join('\n');
    expect(text, 'RED WHEN: a note that cannot be spent yet is not said to be one').toMatch(/A PAYMENT CANNOT SPEND THEM YET/);
    expect(text, 'RED WHEN: the reason for one is not printed beside it').toMatch(/2222222222222222… {3}150 {3}the indexer is behind/);
    expect(text, 'RED WHEN: the section stops naming what resolves it, in terms the reader can act on').toMatch(/run this rebuild again/);
    expect(text).toMatch(/name the transaction\s+that created the note to the repair/);
  });
});

describe('the remedy the rebuild names can be reached from the screen', () => {
  const TX_OLD = 'a1'.repeat(32) as Hex;
  const coin = (n: string, value: bigint, createdIn?: Hex): Note => ({
    nonce: n.repeat(32) as Hex, token: 'aa'.repeat(32) as Hex, value, ...(createdIn ? { createdIn } : {}),
  });
  const heldAs = (c: Note) => ({ nonce: c.nonce, token: c.token, value: c.value, commitment: c.nonce });

  it('prints, in full and on its own line, every transaction a person could name for a note, on a vault with two', () => {
    const versions = [{ version: 1, notes: [coin('11', 500n, TX_OLD)] }];
    const lost = coin('22', 150n);
    const one = 'c1'.repeat(32); const two = 'c2'.repeat(32);
    const w = whatTheRebuildWrites({
      versions, held: [heldAs(coin('11', 500n)), heldAs(lost)], alsoDropStaleNotes: false,
      found: [{
        nonce: lost.nonce,
        unresolved: `none of the 2 transaction(s) answered for it. ${one.slice(0, 16)}… carries it and was refused`,
        candidates: [one, two],
      }],
    });
    expect(w.notYetSpendable[0]!.candidates, 'RED WHEN: the candidates the chain offered are dropped on the way to the screen').toEqual([one, two]);
    const r = recovery({ held: [note('11', 500n), note('22', 150n)], recovered: [note('22', 150n)] });
    const text = linesForAnOperator(r, w.notYetSpendable).join('\n');
    expect(
      text,
      'RED WHEN: the screen tells a person to name the transaction and never prints a whole hash they could name',
    ).toMatch(new RegExp(`\n +could be: +${one}\n +could be: +${two}(\n|$)`));
  });

  it('says so when no transaction the chain lists could be the one, rather than printing nothing', () => {
    const r = recovery({ held: [note('22', 150n)], recovered: [note('22', 150n)] });
    const text = linesForAnOperator(r, [{ nonce: '22'.repeat(32), value: 150n, why: 'none answered', candidates: [] }]).join('\n');
    expect(text).toMatch(/no transaction the chain lists for this vault could be the one/);
  });

  it('bounds the candidates under one note', () => {
    const many = Array.from({ length: 7 }, (_, i) => `d${i}`.repeat(32));
    const r = recovery({ held: [note('22', 150n)], recovered: [note('22', 150n)] });
    const text = linesForAnOperator(r, [{ nonce: '22'.repeat(32), value: 150n, why: 'x', candidates: many }]).join('\n');
    expect(text.match(/could be:/g)).toHaveLength(4);
    expect(text).toMatch(/… and 3 more/);
  });
});

describe('the rebuild\'s own answer about a contradicted note is written down', () => {
  const settledNow = {
    nonce: '11'.repeat(32) as Hex,
    chainHolds: { token: 'aa'.repeat(32) as Hex, value: 500n, records: [{ kind: 'pool version' as const, version: 1 }] },
    setAside: [{ token: 'aa'.repeat(32) as Hex, value: 999n, records: [{ kind: 'pool version' as const, version: 2 }] }],
  };

  it('counts an answer no version records yet, and not one a version already records', () => {
    expect(settlementsNotYetRecorded([settledNow], [{ settled: [] }, {}])).toEqual([settledNow]);
    expect(
      settlementsNotYetRecorded([settledNow], [{ settled: [settledNow] }]),
      'RED WHEN: an answer already written down is counted again, so every rebuild writes a version',
    ).toEqual([]);
    const different = { ...settledNow, chainHolds: { ...settledNow.chainHolds, value: 999n } };
    expect(settlementsNotYetRecorded([settledNow], [{ settled: [different] }])).toEqual([settledNow]);
    expect(
      settlementsNotYetRecorded([{ nonce: settledNow.nonce, setAside: settledNow.setAside }], []),
      'RED WHEN: a nonce the chain holds none of is counted as an answer to record',
    ).toEqual([]);
  });

  it('WRITES when the only difference is an answer the chain gave that no version records', () => {
    const r = recovery({ held: [note('11', 500n)] });
    expect(decideWhetherToWrite({ recovery: r, notesTheNewestVersionClaims: 1, alsoDropStaleNotes: false }).do).toBe('nothing');
    const d = decideWhetherToWrite({
      recovery: r, notesTheNewestVersionClaims: 1, alsoDropStaleNotes: false, settlementsToRecord: 1,
    });
    expect(d.do, 'RED WHEN: a rebuild that settled a nonce writes nothing, so the answer is lost once the coin is spent').toBe('write');
    expect(d.why).toMatch(/no version records the answer yet/);
  });

  it('shows what an earlier version wrote down when the chain holds none of the descriptions now', () => {
    const text = linesForAnOperator(recovery({}), [], [{
      nonce: '11'.repeat(32) as Hex,
      setAside: settledNow.setAside,
      heldWhenFiled: { version: 3, token: 'aa'.repeat(32) as Hex, value: 500n },
    }]).join('\n');
    expect(
      text,
      'RED WHEN: the answer an earlier rebuild wrote down is read back and never shown',
    ).toMatch(/the chain holds none of them[^\n]*\n +when version 3 was filed the chain held the one worth 500; it has been spent since/);
  });
});

describe('a contradiction is printed with the file each record is', () => {
  it('puts the pool version\'s own file beside it, and the whole journal beside a journal line', () => {
    const refused = new NoteDescribedTwice('ab'.repeat(32) as Hex, [
      { record: { kind: 'pool version', version: 4 }, token: 'aa'.repeat(32) as Hex, value: 1n, onChain: true },
      { record: { kind: 'pool version', version: 6 }, token: 'aa'.repeat(32) as Hex, value: 1n, onChain: false },
      { record: { kind: 'payment journal' }, token: 'aa'.repeat(32) as Hex, value: 2n, onChain: true },
    ]);
    const lines = whereTheRecordsAre(refused, {
      poolVersion: (v) => `.midnight/stagenet-vault-pool-x.v${v}.json`,
      depositJournal: '.midnight/stagenet-vault-deposit-journal-x.json',
      paymentJournal: '.midnight/stagenet-vault-payment-journal-x.json',
    });
    expect(
      lines,
      'RED WHEN: a record is printed without the file it is, or with the wrong version\'s file, so the person told to move it moves the wrong one',
    ).toEqual([
      'version 4 of the pool (the chain holds this one): .midnight/stagenet-vault-pool-x.v4.json',
      'version 6 of the pool: .midnight/stagenet-vault-pool-x.v6.json',
      'the payment journal (the chain holds this one): .midnight/stagenet-vault-payment-journal-x.json and its numbered versions',
    ]);
    expect(refused.message, 'every description is named with whether the chain holds it').toMatch(/version 4 of the pool says it is 1 of aaaaaaaaaaaaaaaa… \(the chain holds this one\); version 6 of the pool says it is 1 of aaaaaaaaaaaaaaaa…; the payment journal says it is 2/);
  });
});
