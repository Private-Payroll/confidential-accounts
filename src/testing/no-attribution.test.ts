import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * **WHAT A COMMAND PRINTS DESCRIBES THE JOB IT RAN, AND NAMES NOBODY.**
 * `docs/NEXT.md` X7 §3.
 *
 * ── WHY THE TEST IS THE DELIVERABLE AND THE EDIT IS NOT ──────────────────
 *
 * Thirty-four `.command` files printed a line addressed to whoever was to be
 * told the run had finished. Deleting those lines takes a morning and lasts
 * until the next script is written from the shape of the one beside it, which
 * is exactly how thirty-four of them came to say it. **This repository is going
 * public**, so the line has to become unwritable rather than absent, and only a
 * check can do that.
 *
 * A command says what it did and where its report is, and stops.
 *
 * ── ONE REPOSITORY. THIS ONE. `X19b`. ────────────────────────────────────
 *
 * **THIS CHECK USED TO WALK `Identity/` AS A SECOND ROOT, AND THAT WAS A
 * STANDING CHECK IN ONE REPOSITORY POLICING ANOTHER.** It worked only because
 * the two happen to share a tree today, and they are being published as
 * separate repositories. At that point it has two futures and both are bad:
 * it fails for everyone who clones either one, or — **worse, because it is
 * silent** — `readdirSync` finds a folder that is not there, the scan reads
 * nothing, and a green test means the wallet's commands were never looked at.
 *
 * **What made it visible was the wallet correcting its own attribution guard.**
 * The reworded guard names `CLAUDE.md`, this check flagged it, and the
 * exemption — which is by FULL TEXT — correctly stopped covering it. Both
 * failures were this check doing its job on a repository whose decisions are
 * not its own to hold.
 *
 * **THE WALLET NEEDS ITS OWN EQUIVALENT AND DOES NOT HAVE ONE YET. Until it
 * does, NOTHING CHECKS ITS `.command` FILES**, and that window opened when this
 * edit landed. The handover, and what a wallet-side copy has to carry, is in
 * `docs/build-log.md` under `X19b`.
 *
 * ── WHAT IT SCANS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────
 *
 * **The `.command` files at this repository's root, and nothing else yet.**
 *
 * **THE PROSE OF THE TRACKED TREE WAS CLEANED SEPARATELY AND THIS DOES NOT
 * CHECK IT.** What still carries the word by necessity is file NAMES —
 * `CLAUDE.md` and `.claude/agents/` are read by tooling at those paths — and
 * the matcher data below, which has to contain what it matches. Widening this
 * check to those is not a text change, so it is reported rather than smuggled
 * in under a green test. **A check that claims more ground than it holds is
 * worse than a narrow one**, because the ground it does not hold stops being
 * looked at.
 *
 * ── THE EXEMPTION MECHANISM IS KEPT, AND IT IS EMPTY ─────────────────────
 *
 * A commit-message guard `grep`s for these words, so its own text contains
 * them, so a scan like this one flags it. Such a line is exempt **by its full
 * text — not by file, not by line number** — which is what makes a reworded
 * guard lose its exemption instead of keeping it silently.
 *
 * **THIS REPOSITORY HAS NO SUCH GUARD, so the list is empty, and that is a
 * measurement rather than an oversight.** `COMMIT.command` here contains no
 * attribution check at all (`T-23`, raised by `R3` when it was briefed to fix
 * one and found there was nothing to fix), and no `.command` at this root
 * matches any pattern below. The two lines that used to be exempt were
 * `Identity/COMMIT.command`'s and `Identity/INIT-REPO.command`'s: the wallet's
 * guard, and they left with the wallet's scope.
 *
 * The machinery stays because the day `T-23` is answered here, a guard appears
 * whose own text trips this scan — **the check goes red, and adding the
 * exemption is then a deliberate act with the full line written down.** The
 * mechanism is exercised in memory below rather than against a file, so it
 * cannot rot into an exemption nobody applies.
 */

const HERE = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The words an attribution uses.
 * **This list is matcher data: it has to contain the words it rejects.**
 * `\b` on the initials so the two-letter one is caught while `said`, `chain`
 * and `plain` are not — a matcher that cries wolf is one somebody turns off.
 */
const FORBIDDEN = [
  /claude/i,
  /anthropic/i,
  /co-authored-by/i,
  /generated with/i,
  /\bai[- ](generated|assisted|written)\b/i,
  /\bassistant\b/i,
  /\bchatbot\b/i,
];

/**
 * **EXEMPT BY FULL TEXT, AND CURRENTLY EMPTY.** See the note above: this
 * repository has no commit-message attribution guard to exempt. A line goes in
 * here whole, trimmed only of indentation, so that a line which merely starts
 * the same way is not covered by it.
 */
const GUARDS: ReadonlySet<string> = new Set<string>([]);

interface Hit { where: string; line: string }

/**
 * The decision, for one line, in one place.
 *
 * Split out so the exemption path is exercised by the control below against a
 * line held in memory, rather than only against whatever happens to be on disk.
 * The scan and the control therefore share the code they are both about.
 */
const flagged = (line: string, exempt: ReadonlySet<string>): boolean =>
  !exempt.has(line.trim()) && FORBIDDEN.some(rx => rx.test(line));

/** Every `.command` directly at this repository's root. The root is flat. */
const commandsIn = (folder: string): string[] =>
  readdirSync(join(HERE, folder))
    .filter(n => n.endsWith('.command'))
    .sort()
    .map(n => join(folder, n));

const attributionsIn = (files: readonly string[]): Hit[] => {
  const hits: Hit[] = [];
  for (const rel of files) {
    const lines = readFileSync(join(HERE, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (flagged(line, GUARDS)) hits.push({ where: `${rel}:${i + 1}`, line: line.trim() });
    });
  }
  return hits;
};

const PAYROLL = commandsIn('.');

describe('no command names an assistant', () => {
  /*
   * A count, first. Without it "no attributions found" is also what a wrong
   * path, a bad extension filter and an empty folder all look like — three ways
   * to pass while reading nothing. **That third one is exactly how this check
   * would have died quietly once the two repositories separated**, which is why
   * the count is asserted and not assumed. The number is a lower bound so
   * adding a script does not turn this red for the wrong reason.
   */
  it('reads this repository, and there is something in it to read', () => {
    expect(PAYROLL.length, 'no .command files found at this repository root')
      .toBeGreaterThan(30);
  });

  it('THE ONE THAT MATTERS: no command in this repository prints an attribution', () => {
    expect(attributionsIn(PAYROLL)).toEqual([]);
  });

  /*
   * THE POSITIVE CONTROL, and it is not decoration. Without it the case above
   * is also satisfied by a pattern that matches nothing — which is how a check
   * like this rots: someone rewrites the line in a way the regex misses and the
   * suite stays green. This puts the exact line back, in memory, and requires
   * the matcher to find it.
   */
  it('and the check fails when the line is put back', () => {
    /* The exact deleted line, verbatim, because a positive control that is not
     * the real thing controls for nothing. */
    const line = '  echo "  ${BOLD}Just tell Claude it is done.${OFF} It reads the file itself."';
    expect(FORBIDDEN.some(rx => rx.test(line)), 'the deleted line is not matched any more')
      .toBe(true);
    expect(flagged(line, GUARDS), 'an attribution is exempt from its own check').toBe(true);
  });

  /*
   * THE EXEMPTION MECHANISM IS ITSELF CHECKED, AND IT IS CHECKED IN MEMORY.
   *
   * It used to be checked by reading two files in the OTHER repository and
   * counting the exempt lines in them — which is the reach this round removed,
   * and which would have been the last thing left pointing at `Identity/`.
   *
   * What is worth keeping is not those two strings; it is the PROPERTY they
   * demonstrated on the day the wallet reworded its guard: **an exemption is
   * the whole line, so a guard that changes by one character stops being
   * exempt and is flagged like anything else.** That is asserted here against
   * lines this test owns, so it holds whatever any repository's guard says
   * today, and it holds while the list is empty.
   */
  it('and an exemption is the whole line, so a reworded guard loses it', () => {
    const guard =
      "if grep -Eiq 'co-authored-by|claude|anthropic' COMMIT-MESSAGE.md; then";
    const reworded = guard.replace('COMMIT-MESSAGE.md', 'MESSAGE.md');

    /* Unexempted, a guard trips this scan — which is what forces the exemption
     * to be written down rather than assumed. */
    expect(flagged(guard, new Set())).toBe(true);

    const exempt = new Set([guard]);
    expect(flagged(guard, exempt), 'an exempt guard is still being flagged').toBe(false);
    expect(flagged(reworded, exempt), 'a reworded guard kept its exemption').toBe(true);

    /* And the list this repository actually applies is empty, on purpose. */
    expect([...GUARDS], 'an exemption appeared without a guard to justify it').toEqual([]);
  });
});
