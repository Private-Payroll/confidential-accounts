/**
 * **BOTH VERDICTS OF THE INSTRUMENT THAT RULES `C244` ARE REACHABLE, AND THE
 * THIRD ONE DOES NOT COLLAPSE INTO THE SECOND.**
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * The first draft of `scripts/measure-note-index.ts` declared
 * `const located: Located[] = []` and **nothing anywhere pushed to it**, so the
 * *"THE INDEX IS OBTAINABLE"* branch could never be reached and every run that
 * got as far as reading a vault's note set printed *"On this evidence `C244` is
 * LOSS rather than downtime, and the private design has to change"* — whatever
 * the four surfaces had actually returned. **Both typechecks passed.** It was
 * found by an audit reading the file, which is not a mechanism.
 *
 * `C244` is item 4 of `C257`'s launch gate, and a LOSS reading does not merely
 * block: it INSTRUCTS, because payroll is pinned to the private path by product
 * rule. **So an instrument that can only return the redesign verdict is worse
 * than no instrument**, and this is the check that says so out loud.
 *
 * It is the same shape as `C238`'s close: that instrument got a test which
 * fails when its computed ceiling falls outside a measured window.
 *
 * ── AND THE THIRD VERDICT IS THE ONE WITH THE HISTORY ────────────────────
 *
 * *We could not check* and *there is none* are opposite claims with opposite
 * consequences, and collapsing the first into the second is `C110`. Here it has
 * a launch gate behind it: four surfaces that refused for want of a network are
 * not evidence that the index cannot be obtained.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  stageFour, candidatesOf, classifyPair, narrowUpdateVerdict, qualify, siblingOf,
  MOST_CANDIDATES,
  type Attempt, type LeafRange, type NarrowUpdate, type PairReading,
} from './measure-note-index.js';

const SOURCE = readFileSync(fileURLToPath(new URL('./measure-note-index.ts', import.meta.url)), 'utf8');

const nothing: Attempt = { located: [], answered: 0 };

const oneReading: Attempt = {
  located: [{
    commitment: 'aa'.repeat(32),
    index: 7n,
    from: 'Transaction.zswapStartIndex, via contractAction(address:)',
    derivation: 'this action inserted exactly one zswap leaf and the vault holds exactly one '
      + 'commitment, so the pairing is forced',
  }],
  answered: 1,
};

describe('the instrument that rules C244 can return every verdict it declares', () => {
  it('OBTAINABLE is reachable — exit 0 when a surface located an index', () => {
    expect(
      stageFour(oneReading, true),
      'the positive verdict is unreachable. That was this instrument’s first defect: a '
      + 'Located array nothing pushed to, so every run that read a vault printed the LOSS '
      + 'verdict and its instruction to redesign the private settlement.',
    ).toBe(0);
  });

  it('LOSS is reachable — exit 1 when surfaces answered and none located an index', () => {
    expect(
      stageFour({ located: [], answered: 4 }, true),
      'a run where every surface answered and none carried an index must rule, or the '
      + 'instrument cannot say no either',
    ).toBe(1);
  });

  it('UNMEASURED when nothing answered, however many refused — never LOSS', () => {
    expect(
      stageFour(nothing, true),
      'four refusals for want of a network are NOT evidence that the index cannot be '
      + 'obtained. C110: "we could not check" and "there is none" are opposite claims, and '
      + 'this one has a launch gate behind it.',
    ).toBe(3);
  });

  it('UNMEASURED when it never reached the surfaces at all', () => {
    expect(stageFour(nothing, false)).toBe(3);
  });

  it('a reading outranks refusals rather than being cancelled by them', () => {
    /*
     * A surface that answered and three that could not be reached is still a
     * reading. The refusals are printed; they do not overturn what was read.
     */
    expect(stageFour(oneReading, true)).toBe(0);
  });
});

/**
 * **AND THE ASSERTION THAT WOULD ACTUALLY HAVE CAUGHT THE DEFECT.**
 *
 * The branch tests above prove `stageFour` returns what it declares given an
 * `Attempt`. **They would NOT have caught the original bug**, which was one
 * level up: `stageThree` built a `located` array and never pushed to it, so
 * `stageFour` was always handed an empty one and its correctness was beside the
 * point. That is worth saying plainly, because a test that looks like it covers
 * a defect and does not is worse than the absence of one.
 *
 * This is the assertion that covers it, and it is a source-level one for the
 * reason `no-wasm-in-the-page` and `one-wiring-point` are: **an array nobody
 * writes to is not visible to a typechecker or to a unit test of the function
 * that reads it.** Driving `stageThree` would need the indexer stubbed, which is
 * the better test and is not this one.
 */
describe('the array the verdict is read from has a writer', () => {
  it('stageThree pushes into located somewhere', () => {
    const writes = (SOURCE.match(/located\.push\(/g) ?? []).length;
    expect(
      writes,
      'nothing in scripts/measure-note-index.ts pushes into `located`, so the OBTAINABLE '
      + 'verdict is unreachable however the four surfaces answer, and every run that reads '
      + 'a vault prints the LOSS verdict and its instruction to redesign the private '
      + 'settlement. This is the exact defect this file was written for.',
    ).toBeGreaterThan(0);
  });

  it('extracts nothing out of a Debug string by pattern', () => {
    /*
     * An earlier draft picked the first index-shaped number out of the 300
     * characters before a commitment in a `ZswapChainState` Debug dump and said
     * it "stands before it". The adjacency was never established and the format
     * is undocumented. C238 in miniature, in the instrument written to enforce
     *
     *
     * **THE ASSERTION IS ON `.exec(` AND NOT ON THE SENTENCE**, because the
     * sentence still appears in this file and in that file's comments, saying
     * why it was removed. A check that greps prose fails on its own
     * explanation, and the first draft of this test did exactly that.
     */
    const extractions = (SOURCE.match(/\.exec\(/g) ?? []).length;
    expect(
      extractions,
      'scripts/measure-note-index.ts runs a regex against text it read, which is how the '
      + 'Debug-string scrape comes back. A number picked out of an undocumented Debug '
      + 'format is a guess wearing a measurement\x27s clothes, and a wrong index is a '
      + 'transaction the chain refuses with nothing a person can act on. If a match is '
      + 'genuinely needed, it is not on a value the money depends on.',
    ).toBe(0);
  });
});

/**
 * **SURFACES F AND G, AND THE ASSERTION THAT MATTERS IS THAT EACH CAN RETURN
 * EVERY ANSWER IT DECLARES.**
 *
 * This file exists because a surface that can reach only one verdict is worse
 * than no surface — `C263` and `C265` are the same defect found twice in this
 * one instrument, once because nothing wrote to `located` and once because the
 * only writer asked a question the schema refuses. **Both were invisible to a
 * typechecker and to a test of the function that reads the verdict.** So the
 * deciding code for F and G is pure, exported, and driven here from every side.
 *
 * ── AND THE THIRD DEFECT, WHICH IS THE ONE THIS BLOCK IS SHAPED BY ───────
 *
 * G's first draft claimed that the ledger's `MerkleTreeCollapsedUpdate`
 * constructor building over `(i, i)` meant leaf `i` was the vault's, and
 * recorded a `Located` on it. **It is a statement about the PAIR `{i, i^1}`**:
 * `partial_index` hands the height-0 node to `root()` without matching it, and
 * `root()` answers for a collapsed leaf exactly as it does for a live one. On
 * a two-leaf deposit — the case the instrument was built for — both candidates
 * would have read as retained; on a later call, a leaf that is NOT the vault's
 * would have been recorded as its index, with a derivation reading *"the
 * pairing is forced rather than chosen"*. **A wrong index is a transaction the
 * chain refuses with nothing a person can act on**, which is `C244`'s own
 * sentence, produced by the instrument written to rule `C244`.
 *
 * So the tests below pin what G may and may not conclude, and there is no test
 * for an identification, because **G has no identification to make.**
 */

const RANGE: LeafRange = { start: 616n, endExclusive: 618n, txHash: 'ab'.repeat(32) };

const applied = (qualifiedCoins: number): NarrowUpdate => ({
  askedStart: 616n,
  askedEndInclusive: 617n,
  bytes: 96,
  firstFreeBefore: 0n,
  firstFreeAfter: 618n,
  qualifiedCoins,
});

const reading = (
  index: bigint,
  outcome: PairReading['outcome'],
  from = 'E, Block.contractZswapState',
): PairReading => ({ index, outcome, from, detail: 'from a test' });

/** Controls that pass. Every verdict below depends on these being believed. */
const goodControls: PairReading[] = [
  reading(0n, 'PAIR COLLAPSED'),
  reading(1n, 'PAIR COLLAPSED'),
];

describe('the range a settled transaction reports becomes a list of candidates', () => {
  it('names one leaf per index, and the end is EXCLUSIVE', () => {
    expect(candidatesOf(RANGE)).toEqual([616n, 617n]);
  });

  it('an empty range names nothing rather than one leaf', () => {
    /*
     * A transaction that inserted no zswap leaves reports start === end. Reading
     * that as "one candidate at start" would hand G a leaf to ask about that the
     * transaction never created.
     */
    expect(candidatesOf({ ...RANGE, endExclusive: 616n })).toEqual([]);
  });

  it('the pair is the unit, and the sibling is arithmetic rather than a guess', () => {
    expect(siblingOf(616n)).toBe(617n);
    expect(siblingOf(617n)).toBe(616n);
    expect(siblingOf(0n)).toBe(1n);
  });

  it('a ceiling exists at all, so a many-output transaction is refused not half-asked', () => {
    expect(MOST_CANDIDATES).toBeGreaterThan(1);
  });
});

describe('F — the narrow collapsed update returns both of its answers', () => {
  it('A QUALIFIED COIN when applying the update produced one', () => {
    expect(
      narrowUpdateVerdict(applied(1)),
      'this branch is a FALSIFIER of a source reading: apply_collapsed_update carries `coins` '
      + 'across untouched, so it is expected never to fire. It must stay reachable — if the '
      + 'reading is wrong, this is the only thing that would say so.',
    ).toBe('A QUALIFIED COIN');
  });

  it('NO LEAF when it produced none — an answer about the mechanism, not a refusal', () => {
    expect(
      narrowUpdateVerdict(applied(0)),
      'a collapsed update carries digests and no leaf values (merkle_tree.rs:309-315), so a '
      + 'run that applies one and gets no coin has ANSWERED. It must not be counted as a '
      + 'refusal — and the instrument must not count it as evidence either, because it is a '
      + 'property of the type that was applied and not a reading about this vault.',
    ).toBe('NO LEAF');
  });
});

describe('G — one ask, and only two messages mean anything', () => {
  it('a constructor that built means the PAIR was not collapsed', () => {
    expect(classifyPair(616n, { ok: true })).toBe('PAIR NOT COLLAPSED');
  });

  it('PAIR COLLAPSED only when the refusal names the index that was asked about', () => {
    expect(classifyPair(617n, {
      ok: false,
      message: 'attempted update on collapsed sub-tree at 617/0',
    })).toBe('PAIR COLLAPSED');
  });

  it('a refusal about a DIFFERENT index is UNREADABLE, never PAIR COLLAPSED', () => {
    /*
     * The message carries the index. Accepting one that names another leaf
     * would let a refusal about somebody else's leaf exclude ours.
     */
    expect(classifyPair(616n, {
      ok: false,
      message: 'attempted update on collapsed sub-tree at 617/0',
    })).toBe('UNREADABLE');
  });

  it('any refusal this instrument does not recognise is UNREADABLE', () => {
    /*
     * The constructor's throw on a collapsed sub-tree is not in `ledger-v9.d.ts`
     * at all — the declaration admits only out-of-bounds and end-before-start —
     * so this degrade is load-bearing rather than defensive. It must fall to a
     * refusal and never to a wrong answer.
     */
    expect(classifyPair(616n, { ok: false, message: 'attempted update on updated sub-tree at 616/0' }))
      .toBe('UNREADABLE');
    expect(classifyPair(616n, { ok: false, message: 'attempted update without the tree being fully rehashed' }))
      .toBe('UNREADABLE');
    expect(classifyPair(616n, { ok: false })).toBe('UNREADABLE');
  });
});

describe('G — qualifying returns every verdict it declares, and identification is not one', () => {
  it('EXCLUDED when every candidate sits in a pair the vault\x27s tree collapsed', () => {
    const q = qualify([reading(616n, 'PAIR COLLAPSED'), reading(617n, 'PAIR COLLAPSED')], goodControls, [616n, 617n]);
    expect(
      q.verdict,
      'this is the real negative C244 has never had: every candidate read, none of them this '
      + 'vault\x27s, and not a word of it about a JavaScript string. It must be reachable or the '
      + 'instrument can only ever narrow.',
    ).toBe('EXCLUDED');
    expect(q.excluded).toEqual([616n, 617n]);
    expect(q.surviving).toEqual([]);
  });

  it('NARROWED when a pair survives, and it names both halves of what it excluded', () => {
    const q = qualify([
      reading(616n, 'PAIR NOT COLLAPSED'),
      reading(617n, 'PAIR NOT COLLAPSED'),
      reading(618n, 'PAIR COLLAPSED'),
    ], goodControls, [616n, 617n, 618n]);
    expect(q.verdict).toBe('NARROWED');
    expect(q.surviving).toEqual([616n, 617n]);
    expect(
      q.excluded,
      'the exclusions are exact even when the identification is not, and dropping them would '
      + 'throw away the only part of this surface that is decisive',
    ).toEqual([618n]);
  });

  it('a single surviving candidate is STILL only NARROWED, because the pair is the unit', () => {
    /*
     * THE ASSERTION THE FIRST DRAFT FAILED. One candidate left looks like an
     * identification and is not: its merkle sibling is outside the range this
     * transaction reports, was never asked about, and is exactly as likely to
     * be the leaf the constructor answered for.
     */
    const q = qualify([
      reading(616n, 'PAIR NOT COLLAPSED'),
      reading(617n, 'PAIR COLLAPSED'),
    ], goodControls, [616n, 617n]);
    expect(q.verdict).toBe('NARROWED');
    expect(q.surviving).toEqual([616n]);
  });

  it('UNREADABLE when a control did not come back collapsed — every answer is discarded', () => {
    /*
     * A probe that says yes to everything is indistinguishable from a tree that
     * retained everything. The candidates below look like a clean exclusion and
     * must not be read as one.
     */
    const q = qualify(
      [reading(616n, 'PAIR COLLAPSED'), reading(617n, 'PAIR COLLAPSED')],
      [reading(0n, 'PAIR NOT COLLAPSED'), reading(1n, 'PAIR COLLAPSED')],
      [616n, 617n],
    );
    expect(q.verdict).toBe('UNREADABLE');
    expect(q.excluded).toEqual([]);
  });

  it('UNREADABLE when there were no controls at all', () => {
    expect(qualify([reading(616n, 'PAIR COLLAPSED')], [], [616n]).verdict).toBe('UNREADABLE');
  });

  it('UNREADABLE when one candidate could not be read, rather than answering on the rest', () => {
    expect(
      qualify([reading(616n, 'PAIR COLLAPSED'), reading(617n, 'UNREADABLE')], goodControls, [616n, 617n]).verdict,
      'a candidate that could not be read might be the one that is this vault\x27s. Excluding '
      + 'on the strength of the ones that answered is choosing, not reading. C110.',
    ).toBe('UNREADABLE');
  });

  it('UNREADABLE when the two reads of the same tree disagree about one leaf', () => {
    /*
     * A and E are two routes to the same filtered object. If they disagree,
     * that is a finding, and neither gets a casting vote.
     */
    expect(qualify([
      reading(616n, 'PAIR NOT COLLAPSED', 'A, ContractAction.zswapState'),
      reading(616n, 'PAIR COLLAPSED', 'E, Block.contractZswapState'),
      reading(617n, 'PAIR COLLAPSED'),
    ], goodControls, [616n, 617n]).verdict).toBe('UNREADABLE');
  });

  it('two reads agreeing is one reading rather than two', () => {
    const q = qualify([
      reading(616n, 'PAIR COLLAPSED', 'A, ContractAction.zswapState'),
      reading(616n, 'PAIR COLLAPSED', 'E, Block.contractZswapState'),
      reading(617n, 'PAIR COLLAPSED', 'A, ContractAction.zswapState'),
      reading(617n, 'PAIR COLLAPSED', 'E, Block.contractZswapState'),
    ], goodControls, [616n, 617n]);
    expect(q.verdict).toBe('EXCLUDED');
    expect(q.excluded).toEqual([616n, 617n]);
  });

  it('UNREADABLE when nothing was asked', () => {
    expect(qualify([], goodControls, [616n]).verdict).toBe('UNREADABLE');
  });
});

describe('what the new surfaces may and may not do to the verdict', () => {
  it('a surface that answered and located nothing can still rule, and it rules LOSS', () => {
    expect(
      stageFour({ located: [], answered: 1 }, true),
      'the instrument must be able to say no on evidence, or it can only say yes. This is '
      + 'stageFour\x27s own contract and is unchanged by S18; which surfaces are allowed to '
      + 'supply that count is the separate question the two tests below pin.',
    ).toBe(1);
  });

  it('a run where the new surfaces only narrowed is UNMEASURED, never LOSS', () => {
    expect(
      stageFour({ located: [], answered: 0 }, true),
      'F answering NO LEAF is a property of what a collapsed update is, and G narrowing to a '
      + 'pair is the note\x27s pair being FOUND. Counting either towards the tally the LOSS '
      + 'reading is read off would order the private settlement redesigned on evidence that '
      + 'points the other way. C263, C110.',
    ).toBe(3);
  });

  it('B locating an index still outranks everything the new surfaces report', () => {
    expect(stageFour({
      located: [{
        commitment: 'aa'.repeat(32),
        index: 616n,
        from: 'Transaction.zswapStartIndex, via contractAction(address:)',
        derivation: 'one leaf inserted, one commitment held, so the pairing is forced',
      }],
      answered: 1,
    }, true)).toBe(0);
  });
});

describe('G — an exclusion is a claim about EVERY candidate', () => {
  it('a candidate that was never asked about makes the whole surface UNREADABLE', () => {
    /*
     * Found by this round's money-safety pass against this round's own
     * rework. Until this assertion existed, completeness was held only by the
     * `for (const i of cands)` loop several hundred lines from the function
     * that rules — the same "one level up" gap the `located.push` source
     * assertion in this file exists about, now guarding the verdict itself.
     */
    expect(
      qualify([reading(616n, 'PAIR COLLAPSED')], goodControls, [616n, 617n]).verdict,
      'excluding two leaves on the strength of having asked about one is choosing, not '
      + 'reading. C110.',
    ).toBe('UNREADABLE');
  });

  it('a reading for a leaf nobody asked about makes it UNREADABLE too', () => {
    expect(qualify(
      [reading(616n, 'PAIR COLLAPSED'), reading(999n, 'PAIR COLLAPSED')],
      goodControls,
      [616n],
    ).verdict).toBe('UNREADABLE');
  });

  it('asking about nothing is not an exclusion of nothing', () => {
    expect(qualify([reading(616n, 'PAIR COLLAPSED')], goodControls, []).verdict).toBe('UNREADABLE');
  });
});

describe('what G may contribute to the verdict, which is nothing yet', () => {
  it('a run where G excluded every candidate is still UNMEASURED', () => {
    /*
     * G's negative is exact about the tree it was served and the leaves it was
     * asked about, and this round establishes neither. Surface B is not pinned
     * to the depositing transaction — the indexer answers with the LATEST
     * action — and EXCLUDED is reachable ONLY when the range holds no leaf of
     * this vault, so the branch that would count is the branch that fires when
     * the wrong transaction was asked about. And the controls prove the probe
     * can say no while nothing proves it can say yes.
     */
    expect(
      stageFour({ located: [], answered: 0 }, true),
      'until surface B is pinned by transaction hash and a positive control exists, an '
      + 'exclusion must not be able to push a run to the verdict that orders the private '
      + 'settlement redesigned.',
    ).toBe(3);
  });
});
