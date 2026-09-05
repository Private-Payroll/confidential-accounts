import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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


/**
 * **THE TWO ARTEFACTS THAT ARE PERMANENT, PUBLIC, AND OUT OF EVERY SWEEP'S
 * REACH: A COMMIT SUBJECT AND A BRANCH NAME.**
 *
 * ── WHY THEY ARE IN THIS FILE ────────────────────────────────────────────
 *
 * The scan above asks what a `.command` PRINTS. These ask what a branch and a
 * commit subject may SAY, and it is the same question about the same kind of
 * thing: **an artefact that describes the job rather than the process, and that
 * nothing can go back and edit.**
 *
 * A file's prose is swept by the sweep. A commit body can be amended before a
 * push. **A merged branch's name is in the record for as long as the repository
 * exists and no pass over any file reaches it** — which makes it the one place
 * where the rule has to be enforced BEFORE the fact or not at all.
 *
 * ── AND THIS FILE IS NOT THE HOME EITHER OF THESE WOULD HAVE CHOSEN ──────
 *
 * Both guards are commit-door guards and they belong with the commit door's
 * other tests, which do not exist: **NOTHING in this repository has ever
 * exercised `scripts/check-commit-subject.sh`** — measured, by searching every
 * `*.test.ts` under `src/`, `scripts/` and `contracts/test/` for its name.
 *
 * **THEY ARE HERE BECAUSE A NEW `.test.ts` UNDER `src/`, `scripts/` OR
 * `contracts/test/` CANNOT BE WRITTEN TODAY.** `docs/design/edges.json` records
 * a count of the files in exactly those three trees, the documentation
 * freshness gate compares it in `globalSetup`, and adding one file makes the
 * gate refuse EVERY `vitest` run in this tree — named-file runs included. The
 * door that clears it is `DOCS.command`, which no session may run.
 *
 * **SO THE PLACEMENT IS A CONSTRAINT AND NOT A JUDGEMENT, AND IT IS WRITTEN
 * DOWN RATHER THAN LEFT TO LOOK LIKE ONE.** When that constraint lifts, these
 * move to a file named after the door, and nothing about them changes.
 *
 * ── THE GUARDS ARE SCRIPTS AND ARE RUN AS SCRIPTS ────────────────────────
 *
 * Neither is read as text and neither is re-implemented here. **A test that
 * greps a guard for a substring passes against a guard wrapped in `if (false)`**
 * — the exact failure an auditor has already demonstrated on
 * `artifact-freshness` in this repository. These run the real file, on real
 * input, and read its exit status.
 *
 * **AND EVERY POSITIVE HAS ITS NEGATIVE.** A guard that stopped refusing passes
 * every positive test there is, so each accepting case below is paired with the
 * refusal it exists to make.
 */
describe('a commit subject and a branch name describe the change, never the process', () => {
  const run = (script: string, arg: string, env: NodeJS.ProcessEnv = {}): { code: number; out: string } => {
    try {
      const out = execFileSync(join(HERE, script), [arg], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  const branch = (name: string) => run('scripts/check-branch-name.sh', name);

  describe('the branch name', () => {
    it('accepts the three shapes the convention names', () => {
      for (const ok of ['feat/take-list-and-secret-scan', 'fix/mutation-harness-journal', 'chore/editorconfig']) {
        const r = branch(ok);
        expect(r.code, `${ok} was refused:\n${r.out}`).toBe(0);
      }
    });

    /*
     * THE ONE THE WHOLE FILE EXISTS FOR. GitHub does not enforce a ruleset on a
     * private repository on the free plan — the API answers `403` and will not
     * even let one be read — so `main` is protected by this refusal or by
     * nothing at all.
     */
    it('REFUSES `main`, and says what it is rather than that the shape is wrong', () => {
      const r = branch('main');
      expect(r.code, 'main was accepted as a branch for a change').toBe(1);
      expect(r.out).toMatch(/PROTECTED BRANCH/);
      // A person told "main is not of the form type/description" fixes the
      // form. A person told what main IS makes a branch. The two are different
      // mistakes and reporting them as one is how a guard gets ignored.
      expect(r.out, 'main was reported as a shape mistake').not.toMatch(/DOES NOT FOLLOW THE CONVENTION/);
    });

    it('REFUSES `master` and `HEAD` the same way', () => {
      for (const name of ['master', 'HEAD']) {
        expect(branch(name).code, `${name} was accepted`).toBe(1);
      }
    });

    it('REFUSES a name with no type, an unknown type, and a type in the wrong case', () => {
      for (const bad of ['take-list-and-secret-scan', 'wip/take-list', 'Feat/take-list']) {
        const r = branch(bad);
        expect(r.code, `${bad} was accepted`).toBe(1);
        expect(r.out).toMatch(/DOES NOT FOLLOW THE CONVENTION/);
      }
    });

    it('REFUSES a description that is not kebab-case', () => {
      for (const bad of ['feat/Take_List', 'feat/take list', 'feat/-leading-hyphen', 'feat/take/list']) {
        expect(branch(bad).code, `${bad} was accepted`).toBe(1);
      }
    });

    /*
     * A BRANCH NAME IS PERMANENT AND PUBLIC AND NO SWEEP REACHES IT, so the
     * work-session id has to be refused before the branch exists or never.
     */
    it('REFUSES a work-session id used as a word', () => {
      for (const bad of ['feat/s71-take-list', 'fix/sc19-ledger', 'chore/mg3-first-pull-request', 'fix/t348-leftover-marker']) {
        const r = branch(bad);
        expect(r.code, `${bad} was accepted`).toBe(1);
        expect(r.out).toMatch(/work-session id/);
      }
    });

    /*
     * THE NEGATIVE CONTROL FOR THAT RULE, AND IT IS THE ONE THAT KEEPS THE
     * GUARD USABLE. A matcher wide enough to catch `s71` is a matcher that
     * catches `8004` and `256` unless it is anchored to this project's own
     * prefixes — and a guard that refuses correct work is a guard people route
     * around, which costs more than the thing it was catching.
     */
    it('and does NOT refuse a real number in a real name', () => {
      for (const ok of ['feat/erc-8004-registry', 'fix/sha-256-digest', 'chore/bump-to-0-33-0']) {
        const r = branch(ok);
        expect(r.code, `${ok} was refused:\n${r.out}`).toBe(0);
      }
    });

    it('REFUSES the vocabulary of how work is organised here', () => {
      for (const bad of ['docs/controller-notes', 'chore/auditor-findings', 'docs/brief-template']) {
        expect(branch(bad).code, `${bad} was accepted`).toBe(1);
      }
    });

    /*
     * AND THE WORDS THIS PRODUCT USES ABOUT ITSELF ARE NOT ON THAT LIST, WHICH
     * IS THE CARE IN IT. `src/api/sessions.ts`, `src/core/founder-payslip.test.ts`
     * and `src/core/a-run-is-not-a-governance-round.test.ts` are the three files
     * that settle it: a branch fixing any of them would be refused by a check
     * that read the word and not the meaning.
     */
    it('and does NOT refuse the product’s own words for round, session and founder', () => {
      for (const ok of ['fix/session-expiry', 'feat/founder-payslip', 'fix/governance-round-window']) {
        const r = branch(ok);
        expect(r.code, `${ok} was refused:\n${r.out}`).toBe(0);
      }
    });

    it('REFUSES being handed nothing at all', () => {
      const r = run('scripts/check-branch-name.sh', '');
      expect(r.code).toBe(1);
    });
  });

  /**
   * **AND THE DOOR ACTUALLY CALLS THEM, WHICH IS THE HALF A GUARD'S OWN TESTS
   * CANNOT SEE.**
   *
   * `scripts/check-branch-name.sh` can be perfect and unreferenced. These read
   * `COMMIT.command` AS TEXT — the only thing available, because exercising it
   * means running git and making a commit — **with its comments stripped
   * first**, so no assertion here can be satisfied by a sentence somebody wrote
   * ABOUT the door instead of by the door. That stripping is
   * `new-vault-door.test.ts`'s lesson: twenty tests stayed green against a
   * prose line once, in this repository.
   *
   * **WEAKER THAN RUNNING IT, AND SAID SO RATHER THAN DRESSED UP.** They catch
   * a guard removed or a call deleted. They cannot catch one made conditional.
   */
  describe('and COMMIT.command wires both guards in', () => {
    // Comments stripped, for the reason above. Positions are read off `body`.
    const body = readFileSync(join(HERE, 'COMMIT.command'), 'utf8').replace(/^\s*#.*$/gm, '');

    /*
     * AND FOR THE ONE ASSERTION BELOW THAT IS ABOUT WHAT THE DOOR RUNS RATHER
     * THAN WHAT IT CONTAINS, THE `echo` LINES GO TOO.
     *
     * `COMMIT.command` PRINTS THE WORDS `git add -A` IN ITS OWN REFUSAL — *this
     * file no longer runs `git add -A`, so it is not waved through* — which is
     * the sentence a person reading a refusal needs and is not a command. A
     * check reading the raw text calls that a breach, and **a guard that
     * refuses the thing it is protecting is a guard somebody deletes.** So the
     * lines that only print are removed alongside the lines that only comment.
     */
    const commands = body.split('\n').filter((l) => !/^\s*echo\b/.test(l)).join('\n');

    it('calls both checkers rather than re-implementing either', () => {
      expect(body, 'COMMIT.command no longer calls the branch-name check')
        .toContain('./scripts/check-branch-name.sh');
      expect(body, 'COMMIT.command no longer calls the commit-subject check')
        .toContain('./scripts/check-commit-subject.sh');
    });

    it('refuses `main` before it stages anything', () => {
      const onMain = body.indexOf('"$CURRENT_BRANCH" = "main"');
      const staging = body.indexOf('git add --');
      expect(onMain, 'COMMIT.command no longer looks at whether HEAD is main').toBeGreaterThan(-1);
      expect(staging, 'COMMIT.command no longer stages a named list').toBeGreaterThan(-1);
      expect(onMain, 'the main check moved after staging, so a refusal leaves a staged index')
        .toBeLessThan(staging);
    });

    /*
     * THIS ONE LINE'S ABSENCE IS TWO RECORDED FAILURES AND NOTHING HAS EVER
     * CHECKED IT. `git add -A` put a live drain key one commit away from a
     * published history, and swept a file nobody had described into a commit
     * that carried two separate pieces of work.
     */
    it('never stages the whole tree, and stages a named list instead', () => {
      expect(commands, 'COMMIT.command stages the whole tree again')
        .not.toMatch(/git add\s+(-A|--all)\b/);
      // AND THE POSITIVE HALF, OR THE ABOVE IS ALSO TRUE OF A FILE THAT STAGES
      // NOTHING AT ALL — including one somebody has emptied.
      expect(commands, 'COMMIT.command no longer stages the declared list')
        .toMatch(/xargs -0 git add --/);
    });

    /*
     * ONE LETTER, OPPOSITE MEANINGS. Lower-case `d` EXCLUDES deletions from the
     * undeclared check — a deletion publishes nothing and demanding it be
     * declared refuses a correct commit. Upper case selects only them, which is
     * how the removals get printed. Swapping the two silently reverses both.
     */
    it('excludes deletions from the undeclared check and prints them separately', () => {
      /*
       * READ AT THE TWO CALL SITES, NOT ANYWHERE IN THE FILE.
       *
       * **THE FIRST VERSION OF THIS TEST ASSERTED ONLY THAT EACH STRING WAS
       * PRESENT SOMEWHERE**, which is satisfied by either call site — so
       * EXCHANGING THE TWO LETTERS left both assertions green while the
       * undeclared-file check came to inspect only deletions, and every added
       * file nobody declared went in silently — the second of those two
       * failures in full, under a green suite, with the test claiming in its
       * own comment to hold the property it did not. Found by the audit.
       */
      // ANCHORED AT A LINE START, so a future variable whose name merely ENDS
      // in one of these cannot be picked up instead.
      const site = (variable: string): string => {
        const m = new RegExp(`^${variable}=""[\\s\\S]*?done < <\\(git diff --cached[^)]*\\)`, 'm').exec(commands);
        expect(m, `no \`${variable}\` loop reading git diff --cached in COMMIT.command`).not.toBeNull();
        return m![0];
      };

      // AND THERE ARE EXACTLY TWO OF THESE LOOPS. A third, inserted between a
      // variable and its own `done`, would be what `site` returned — so the
      // count is asserted rather than assumed.
      expect(
        [...commands.matchAll(/done < <\(git diff --cached/g)].length,
        'COMMIT.command has gained or lost a `git diff --cached` read-loop',
      ).toBe(2);
      // Lower case EXCLUDES deletions: an addition or a modification must be
      // declared, and a deletion publishes nothing so it is not asked to be.
      expect(site('UNDECLARED'), 'the undeclared check no longer excludes deletions')
        .toContain('--diff-filter=d');
      // Upper case SELECTS only deletions, which is what gets printed.
      expect(site('DELETED'), 'nothing lists the paths a commit removes')
        .toContain('--diff-filter=D');
      // AND THE OTHER DIRECTION EXPLICITLY, so the pair cannot be exchanged.
      expect(site('UNDECLARED'), 'the undeclared check now inspects only deletions')
        .not.toContain('--diff-filter=D');
      expect(site('DELETED'), 'the removal listing now excludes the removals')
        .not.toContain('--diff-filter=d');
    });
  });

  describe('the commit subject', () => {
    const subject = (text: string, env: NodeJS.ProcessEnv = {}): { code: number; out: string } => {
      const f = join(tmpdir(), `commit-subject-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
      writeFileSync(f, `${text}\n\nA body, which this check does not read.\n`);
      try {
        return run('scripts/check-commit-subject.sh', f, env);
      } finally {
        rmSync(f, { force: true });
      }
    };

    it('accepts a conforming subject', () => {
      const r = subject('feat: refuse a tree containing any value from the secret roots');
      expect(r.code, r.out).toBe(0);
    });

    /*
     * RULE 60'S LENGTH LIMIT, AND THIS FILE USED TO ARGUE AGAINST IT.
     *
     * `scripts/check-commit-subject.sh` said in its own header that there was no
     * length limit, because *a limit that refuses is a rule nobody agreed to*.
     * **That stopped being true when the maximum was written down as a rule with
     * the measurement behind it: the last three subjects this project wrote were
     * 108, 73 and 119 characters.** The first half of the old argument survives
     * and is why this REFUSES rather than truncating.
     */
    it('REFUSES a subject over 72 characters, and accepts one at exactly 72', () => {
      const head = 'feat: ';
      const at72 = head + 'x'.repeat(72 - head.length);
      const at73 = head + 'x'.repeat(73 - head.length);
      expect(at72.length).toBe(72);
      expect(at73.length).toBe(73);
      expect(subject(at72).code, 'a 72-character subject was refused').toBe(0);
      const over = subject(at73);
      expect(over.code, 'a 73-character subject was accepted').toBe(1);
      expect(over.out).toMatch(/73 characters/);
    });

    /*
     * MEASURED IN CHARACTERS, NOT BYTES — AND THE ANSWER IS THE SAME ON EVERY
     * MACHINE, WHICH IS THE HALF THAT WAS NEARLY GOT WRONG.
     *
     * **AN EARLIER VERSION OF THIS COMMENT SAID BASH'S `${#S}` COUNTS BYTES
     * WHILE `wc -m` DOES NOT. MEASURED: THAT IS FALSE** — the two agree in
     * both locales, and it is the LOCALE that decides rather than the tool.
     *
     * `wc -m` counts bytes under a `C` locale and characters under a UTF-8 one.
     * **The first fix set a locale, and `C.UTF-8` exists on most Linux and not
     * on macOS while `en_US.UTF-8` is the other way round** — so the same
     * subject would have been accepted on one machine and refused on the other,
     * and this test would have been red on one filesystem and green on another.
     * This project has twice dismissed one of those as flakiness.
     *
     * So both locales are exercised here, against a subject that is 72
     * CHARACTERS and 84 BYTES, and the two must agree.
     */
    it('counts an em dash as one character, and gives the same answer in any locale', () => {
      const head = 'feat: ';
      const dashes = 6;
      const text = head + '—'.repeat(dashes) + 'x'.repeat(72 - head.length - dashes);
      expect([...text].length, 'the fixture is not 72 characters').toBe(72);
      expect(Buffer.byteLength(text, 'utf8'), 'the fixture is not multi-byte').toBeGreaterThan(72);
      for (const locale of ['C', 'en_US.UTF-8', 'C.UTF-8']) {
        const r = subject(text, { LC_ALL: locale, LANG: locale });
        expect(r.code, `refused under LC_ALL=${locale}:\n${r.out}`).toBe(0);
        expect(r.out, `a different count under LC_ALL=${locale}`).toContain('(72 characters)');
      }
    });

    it('REFUSES a prose sentence, an unknown type, a round name as a scope and a trailing full stop', () => {
      for (const bad of [
        'Refuse a tree containing any value from the secret roots',
        'wip: refuse a tree',
        'feat(s71): refuse a tree',
        'feat: refuse a tree.',
      ]) {
        const r = subject(bad);
        expect(r.code, `"${bad}" was accepted`).toBe(1);
      }
    });
  });
});
