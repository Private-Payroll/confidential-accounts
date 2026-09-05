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

/**

/**
 * ── `SHIP.command` — THE CHAIN, AND WHAT PINS IT ──────────────────────────
 *
 * **WHY THESE ARE IN THIS FILE, WHICH IS NAMED FOR SOMETHING ELSE.** `C393`
 * forbids a NEW `.ts` under `src/`, `scripts/` or `contracts/test/`:
 * `docs/design/edges.json` records their file count, the freshness gate
 * compares it before any worker evaluates a test module, and one new file
 * refuses EVERY `vitest` run in this tree — including a named-file one. The
 * door that clears it is `DOCS.command`, which no session may run. The branch
 * and commit guards above went into this file for that reason and recorded it
 * as `MIG-32`; **this follows that precedent and deepens it, which is said
 * here rather than left to look deliberate.**
 *
 * **THEY READ THE DOOR AS TEXT, AND THAT IS WEAKER THAN RUNNING IT.** Running
 * `SHIP.command` means running the suite, making a commit and pushing a
 * branch. So these catch a step deleted, two steps swapped, a `git` command
 * appearing where none belongs, a guard whose body has gone, and a name that
 * has gone stale in one of the two places that carry it.
 *
 * **AND EVERY ONE OF THEM WAS PLANTED AGAINST BEFORE IT WAS TRUSTED**, on
 * copies outside the repository. Nine of the first draft's assertions could
 * not fail — the audit found six of them after the round found three — and the
 * comments below name the specific change each survived, because an assertion
 * whose weakness is written down is one the next round can widen rather than
 * inherit. `T-411`.
 */
describe('SHIP.command composes the doors and reimplements none of them', () => {
  const raw = readFileSync(join(HERE, 'SHIP.command'), 'utf8');
  /** Comments only. What the door RUNS lives here; what it SAYS does not. */
  const noComments = raw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  /*
   * Comments AND `echo` lines stripped, for `COMMIT.command`'s reason one
   * level up: this door's whole job is to print other doors' names, so a check
   * reading the raw text would be satisfied by a sentence ABOUT the chain
   * instead of by the chain.
   */
  const ship = noComments.split('\n').filter((l) => !/^\s*echo\b/.test(l)).join('\n');
  /** Only what a person reads off the screen. */
  const screen = raw.split('\n').filter((l) => /^\s*(echo|printf)\b/.test(l)).join('\n');

  /** The five steps, in the order the chain runs them. */
  const CHAIN = [
    'TEST.command',
    'COMMIT.command',
    'PUSH-BRANCH.command',
    'PR-OPEN.command',
  ];
  /** The two doors step 1 runs, and the trees each one owns. */
  const KEY_DOORS = ['BUILD-KEYS.command', 'COMPILE-VAULT.command'];

  it('reads a door that is actually there', () => {
    /*
     * THE FLOOR IS ON THE CODE, NOT ON THE FILE. Measured: this door's comment
     * header alone is nearly 3 KB, so a byte count over the whole file is a
     * floor the prose meets on its own.
     */
    expect(ship.replace(/\s+/g, '').length, 'SHIP.command has no code in it, or was not read')
      .toBeGreaterThan(1500);
    expect(ship, 'nothing in SHIP.command runs a door').toContain('run_door');
  });

  it('runs each door exactly once, and in the order the chain declares', () => {
    let previous = -1;
    for (const door of CHAIN) {
      const sites = [...ship.matchAll(new RegExp(`run_door "${door}"`, 'g'))];
      expect(sites.length, `SHIP.command runs ${door} ${sites.length} times, not once`).toBe(1);
      const at = ship.indexOf(`run_door "${door}"`);
      expect(at, `${door} runs before the step ahead of it in the chain`).toBeGreaterThan(previous);
      previous = at;
    }
  });

  /*
   * **THE STEP THAT CARRIES `T-406`.** A standing check went red and STAYED
   * red across three rounds that each added a door — because the only person
   * who ever sees the suite cannot act on it, and nothing in the path he walks
   * stopped him. `COMMIT.command` asks WHICH CODE its report describes and
   * deliberately not whether that report was green, which is right and is not
   * changed. **This is the first thing in this project that makes a red result
   * unavoidable on the path somebody actually walks:** the suite runs before
   * the commit, and a red one ends the chain with nothing committed.
   */
  it('stops the chain on a red suite, before anything is committed', () => {
    const from = ship.indexOf('run_door "TEST.command"');
    const to = ship.indexOf('run_door "COMMIT.command"');
    expect(from, 'the chain no longer runs the suite').toBeGreaterThan(-1);
    expect(to, 'the chain no longer runs the commit door').toBeGreaterThan(from);
    const between = ship.slice(from, to);
    /*
     * **THREE SPELLINGS OF THIS COULD NOT FAIL, AND EACH WAS FOUND BY PLANTING
     * THE BREAK RATHER THAN BY READING IT** — `T-411`.
     *   · `toContain('TEST_STATUS')` plus `toContain('finish 1')` is satisfied
     *     by `if false; then … finish 1 … fi`. So the condition is spelled out.
     *   · The condition being spelled out is satisfied by `TEST_STATUS=0`
     *     inserted one line later. So the assignment is counted: there is
     *     exactly ONE, and it is the door's own exit code.
     *   · Neither says the stop prints anything, so a stop nobody can act on
     *     passes. Hence the two strings read out of the report.
     */
    const assignments = [...between.matchAll(/^\s*TEST_STATUS=/gm)];
    expect(assignments.length, 'TEST_STATUS is assigned more than once, so the suite’s answer can be overwritten')
      .toBe(1);
    expect(between, 'TEST_STATUS no longer holds the suite door’s own exit code')
      .toContain('TEST_STATUS=$?');
    expect(between, 'the chain no longer stops when the suite answers non-zero')
      .toMatch(/if \[ "\$TEST_STATUS" -ne 0 \]; then/);
    expect(between, 'a non-zero suite no longer ends the chain').toContain('finish 1');
    expect(between, 'the chain no longer prints which tests failed').toContain('FAIL');
    expect(between, 'the chain no longer prints the counts').toContain('Test Files');
  });

  /*
   * THE MERGE IS NOT IN THE CHAIN, AND IT IS THE ONE OMISSION WORTH A TEST.
   * It is the step where somebody reads a diff before it becomes the history,
   * and a chain that took it would have removed the only human check in the
   * loop.
   *
   * **THE POSITIVE HALF READS THE SCREEN AND NOT THE FILE**, because reading
   * the file is satisfied by a comment: deleting all four `echo` lines that
   * name the merge door left this green, measured. A door that names the next
   * step only in a comment names it to nobody.
   */
  it('stops at the link and never merges', () => {
    expect(ship, 'SHIP.command now merges the pull request itself').not.toContain('PR-MERGE');
    expect(screen, 'SHIP.command no longer tells anybody where the merge happens')
      .toContain('PR-MERGE.command');
  });

  /*
   * IT COMPOSES. Every `git` command in this chain belongs to the door that
   * has always run it, and a second copy of a door's guard is a second thing
   * to keep true — which is the whole argument for this file existing.
   *
   * **THIS READS THE COMMENT-STRIPPED TEXT AND NOT THE `echo`-STRIPPED ONE**,
   * because the most natural way to grow a `git` command here is inside an
   * `echo`, and command substitution in an `echo` RUNS. Measured: three real
   * git invocations added that way were invisible to the first spelling.
   */
  it('runs no `git` of its own', () => {
    /*
     * **THE BOUNDARY IS A WORD BOUNDARY AND NOT A CHARACTER CLASS.** The first
     * spelling required one of `; & | ( \`` or whitespace before `git`, so
     * `/usr/bin/git rev-parse` was invisible — measured. `\bgit\s` catches a
     * git reached by any path, and `legit ` is not a word ending in `git`
     * followed by a space at a boundary.
     */
    const gitLines = noComments.split('\n').filter((l) => /\bgit\s/.test(l));
    expect(gitLines, `SHIP.command has grown git commands of its own:\n  ${gitLines.join('\n  ')}`)
      .toEqual([]);
  });

  /*
   * NO DOOR IS RUN EXCEPT THROUGH `run_door`, which is what puts every one of
   * them behind the same missing-file refusal, the same closed stdin and the
   * same stop.
   *
   * **THREE HOLES WERE PLANTED AND ALL THREE WERE REAL:** it excluded any line
   * CONTAINING `run_door`, so a trailing comment saying so was enough; it
   * required a literal `./`, so `bash STAGENET-RESET.command` was invisible;
   * and requiring a word boundary before the name missed `D=./PR-OPEN.command`.
   * **SO IT NOW MATCHES THE NAME ANYWHERE ON THE LINE** and subtracts only the
   * three shapes that are legitimate — the `run_door` call itself, a `case` arm
   * in the report table, and `run_door`'s own body. A deploy door and a
   * chain-state reset went in through the first two of those holes.
   */
  it('invokes no door except through run_door', () => {
    /*
     * THREE SHAPES, AND THEY ARE THE THREE WAYS A DOOR BECOMES A COMMAND.
     * `run_door` reaches its door through `"./$door"`, so no legitimate line
     * in this file writes `./` in front of a door's NAME — which makes (a) an
     * exact test rather than a heuristic. Naming a door inside a string, as
     * `REBUILD=` and `STOPPED_AT=` do, is not running it and is not matched by
     * any of the three, and nor is a `case` arm in the report table — (c)
     * excludes the `)` that makes one.
     */
    const INVOCATION = [
      /\.\/[A-Z][A-Z0-9-]*\.command\b/,                                   // (a) an explicit path
      /(?:^|[\s;&|(])(?:bash|sh|source|exec|\.)\s+[A-Z][A-Z0-9-]*\.command\b/, // (b) handed to an interpreter
      /^\s*[A-Z][A-Z0-9-]*\.command\b(?!\))/,                             // (c) the first word on the line
    ];
    /*
     * (d) A DOOR REACHED THROUGH A VARIABLE — the spelling `run_door` itself
     * uses, so it is the one an edit is most likely to copy. Measured:
     * `EXTRA=STAGENET-RESET.command` then `"./$EXTRA"` matched none of the
     * three shapes above, because none of them appears on the invoking line.
     * So every variable assigned a door name is collected, and any OTHER line
     * that runs `"./$THAT"` is a door run outside `run_door`.
     */
    const doorVars = [...ship.matchAll(/^\s*(\w+)=(?:"|')?(?:\.\/)?[A-Z][A-Z0-9-]*\.command\b/gm)]
      .map((m) => m[1])
      .filter((v) => v !== 'door');
    const viaVariable = (l: string): boolean =>
      doorVars.some((v) => new RegExp(`(?:^|[\\s;&|(])"?\\.\\/\\$\\{?${v}\\}?"?`).test(l));
    const direct = ship.split('\n')
      .filter((l) => INVOCATION.some((rx) => rx.test(l)) || viaVariable(l))
      .filter((l) => !/"\.\/\$door"|-x "\.\/\$door"/.test(l))            // run_door itself
      .filter((l) => !/^\s*\w+=/.test(l) || INVOCATION.some((rx) => rx.test(l)));
    expect(direct, `a door is named as a command outside run_door:\n  ${direct.join('\n  ')}`)
      .toEqual([]);
  });

  /*
   * THE REPORT NAMED BESIDE A STOP IS THE REPORT THAT DOOR ACTUALLY WRITES.
   * A chain that sends somebody to a file that moved is worse than one naming
   * none, and this is the half nothing else can see: both halves are correct
   * on their own and only their agreement matters.
   *
   * **IT NAMES THE DOORS RATHER THAN COUNTING THEM.** A floor of `> 4` over
   * six arms tolerates one door losing its report entirely — measured, by
   * deleting the commit door's arm, which left a stop at step 3 naming no
   * report at all.
   */
  it('names, for every door it runs, the report that door itself writes', () => {
    const arms = new Map(
      [...ship.matchAll(/^\s*([A-Z0-9-]+\.command)\)\s*echo "([^"]+)"/gm)]
        .map((m) => [m[1], m[2]] as [string, string]),
    );
    for (const door of [...CHAIN, ...KEY_DOORS]) {
      const report = arms.get(door);
      expect(report, `SHIP.command names no report for ${door}, so a stop there sends nobody anywhere`)
        .toBeDefined();
      const text = readFileSync(join(HERE, door), 'utf8');
      const own = /^(?:REPORT|LOG)="(?:\$\(pwd\)\/)?([^"]+)"/m.exec(text);
      expect(own, `${door} no longer declares a report of its own`).not.toBeNull();
      expect(own![1], `SHIP.command sends a reader to ${report} and ${door} writes ${own![1]}`)
        .toBe(report);
    }
  });

  /*
   * STEP 1 IS PINNED BY ITS USE, NOT BY ITS VOCABULARY.
   *
   * **THE FIRST SPELLING SURVIVED THE DELETION OF THE ENTIRE STEP**, measured:
   * it asserted that each key door's NAME appeared in the file, and the
   * `report_for` case table names both of them anyway. So this asserts the
   * mechanism — each tree is asked whether it needs rebuilding, each door is
   * put into `REBUILD`, and `REBUILD` is what gets run.
   *
   * The two trees and their doors are declared in `scripts/artifact-scan.ts`,
   * which has held that pairing since before this door existed; neither door's
   * name says which contract it covers, and that is how somebody finds out one
   * failed run at a time.
   */
  it('rebuilds each contract with the door artifact-scan names for it', () => {
    const scan = readFileSync(join(HERE, 'scripts/artifact-scan.ts'), 'utf8');
    const specs = [...scan.matchAll(/managed:\s*'([^']+)',\s*\n\s*keyDoor:\s*'([^']+)'/g)]
      .map((m) => ({ managed: m[1], door: m[2] }));
    expect(specs.length, 'scripts/artifact-scan.ts no longer declares a key door per contract').toBe(2);
    expect(specs.map((s) => s.door).sort(), 'the key doors have moved apart in the two files')
      .toEqual([...KEY_DOORS].sort());

    /*
     * **THE PAIRING, NOT THE PRESENCE — AND THAT IS THIS ROUND'S SECOND AUDIT.**
     * The first spelling asked only that both trees were examined and both
     * door names appeared somewhere in a `REBUILD=` line. Measured: SWAPPING
     * THE TWO DOORS left it green — and the pairing is the single fact the
     * doors' names do not carry, which is the whole reason this test exists.
     *
     * So the door reads the pairing off a `case` table of its own, and this
     * compares that table with `artifact-scan`'s arm for arm.
     */
    const table = new Map(
      [...ship.matchAll(/^\s*(contracts\/[a-z-]+)\)\s*echo "([^"]+)"/gm)]
        .map((m) => [m[1], m[2]] as [string, string]),
    );
    expect([...table.keys()].sort(), 'SHIP.command no longer declares a door per contract tree')
      .toEqual(specs.map((x) => x.managed).sort());
    for (const { managed, door } of specs) {
      expect(table.get(managed), `SHIP.command sends ${managed} to ${table.get(managed)} and artifact-scan says ${door}`)
        .toBe(door);
    }
    // Each tree is actually asked the question, and the table is what selects
    // the door — not a name typed a second time beside it.
    /*
     * `(?![-\w])` AND NOT `\b`, AND THE DIFFERENCE IS A WHOLE TREE. `-` is a
     * word boundary, so `contracts/managed\b` matches inside
     * `contracts/managed-vault` — and the account's assertion was satisfied by
     * the VAULT's line. Measured: naming `BUILD-KEYS.command` directly instead
     * of reading it from the table stayed green.
     */
    const exact = (t: string): string => `${t.replace(/[/\-]/g, (c) => `\\${c}`)}(?![-\\w])`;
    for (const { managed } of specs) {
      expect(ship, `nothing asks whether ${managed} needs rebuilding`)
        .toMatch(new RegExp(`why_rebuild [^\\n]*${exact(managed)}`));
      expect(ship, `${managed}'s door is named again instead of read from the table`)
        .toMatch(new RegExp(`REBUILD=[^\\n]*key_door_for ${exact(managed)}`));
    }
    expect(ship, 'the rebuild list is built and never run').toContain('run_door "$d"');
  });

  /*
   * AND THE CHAIN'S ONE EFFECT ON THE DOORS IT RUNS. Three of them end by
   * waiting for a key press, which is right alone and wrong mid-chain.
   *
   * **THE MATCH IS BOUNDED BY THE BLOCK, AND THAT IS THE FIX FOR A REGEX THAT
   * READ STRAIGHT PAST A `fi`** — measured: moving the `read` below the `fi`
   * in all three doors, so every one of them waits for a key press under the
   * flag, left the first spelling green.
   */
  it('exports SHIP_CHAIN, and the doors that wait for a key press read it', () => {
    expect(ship, 'SHIP.command no longer exports SHIP_CHAIN').toMatch(/^export SHIP_CHAIN=1$/m);
    for (const door of ['TEST.command', 'BUILD-KEYS.command', 'COMPILE-VAULT.command']) {
      const text = readFileSync(join(HERE, door), 'utf8');
      expect(text, `${door} no longer honours SHIP_CHAIN, so the chain stops at its key press`)
        .toMatch(/\[ -[zn] "\$SHIP_CHAIN" \]/);
      // `(?:(?!\n\s*fi\b)[\s\S])*?` — anything that is not the closing `fi`.
      /*
       * **COUNTED, NOT FOUND.** Two spellings failed here and both were
       * measured. A line-anchored `fi` exclusion walked straight past
       * `: ; fi` on one line; and finding ONE guarded `read` says nothing
       * about a SECOND one sitting outside the guard, which is the shape that
       * actually leaves a window waiting. So: every `read` in the door is
       * counted, every guarded one is counted, and they must be the same
       * number.
       */
      const guardedReads =
        [...text.matchAll(/if \[ -z "\$SHIP_CHAIN" \]; then(?:(?!\bfi\b)[\s\S])*?\n\s*read [-\w]/g)].length;
      const allReads = [...text.matchAll(/^\s*read [-\w]/gm)].length;
      expect(allReads, `${door} no longer waits for a key press at all`).toBeGreaterThan(0);
      expect(guardedReads, `${door} has ${allReads} key press(es) and ${guardedReads} inside its SHIP_CHAIN guard`)
        .toBe(allReads);
    }
  });
});

/**
 * ── `COMMIT.command` PUTS YOU BACK ON `main` ITSELF ───────────────────────
 *
 * Nothing used to, so every piece of work after a merge taken on the website
 * started on the previous one's branch — and met a refusal a person who does
 * not type `git` cannot clear. Read as text, with comments stripped, for the
 * reason the block above gives.
 */
describe('COMMIT.command handles the branch a merge left behind', () => {
  const raw = readFileSync(join(HERE, 'COMMIT.command'), 'utf8');
  const body = raw.replace(/^\s*#.*$/gm, '');
  const commands = body.split('\n').filter((l) => !/^\s*echo\b/.test(l)).join('\n');
  const screen = raw.split('\n').filter((l) => /^\s*(echo|printf)\b/.test(l)).join('\n');

  /*
   * The whole guarded block. **ANCHORED ON THE FETCH RATHER THAN ON A CLAUSE
   * THE ASSERTIONS BELOW ALSO TEST** — an anchor that names a clause makes
   * every assertion about that clause true by construction, which is how one
   * of these came to be dead. Measured: with the old anchor, removing
   * `!= "main"` from the condition failed the not-null check and never the
   * assertion written for it.
   */
  const CONDITION = /if \[[\s\S]{0,400}?git fetch origin[\s\S]{0,400}?; then/;
  const condition = (): string => {
    const m = CONDITION.exec(commands);
    expect(m, 'COMMIT.command no longer measures whether this branch is already in `main`').not.toBeNull();
    return m![0];
  };
  const block = (): string => {
    const at = commands.search(CONDITION);
    expect(at, 'COMMIT.command no longer moves you off a branch that is already in `main`')
      .toBeGreaterThan(-1);
    const end = commands.indexOf('CURRENT_BRANCH="main"', at);
    expect(end, 'the branch move never reaches `main`').toBeGreaterThan(at);
    return commands.slice(at, end);
  };

  it('measures CONTENT against origin/main, never commit ids', () => {
    // A squash merge rewrites the commits, so two ids prove nothing about two
    // trees. `git diff --name-only A..B` compares the trees.
    expect(condition(), 'the already-merged measurement no longer diffs the trees')
      .toContain('git diff --name-only origin/main..HEAD');
    expect(condition(), 'the already-merged measurement compares commit ids again')
      .not.toMatch(/rev-list|merge-base|rev-parse HEAD/);
  });

  /*
   * `git diff` AGAINST A REF THAT IS NOT THERE PRINTS ITS COMPLAINT ON STDERR
   * AND NOTHING ON STDOUT. With stderr discarded, the emptiness test would
   * read *no ref at all* as *nothing left behind* and move somebody off their
   * own work.
   *
   * **ORDER IS NOT ENOUGH, AND THAT WAS MEASURED.** Wrapping the verify in
   * `{ … || true; }` leaves it textually first and gates nothing. So the two
   * are asserted as one `&&` chain: the verify's answer is what the diff hangs
   * off, not merely a line above it.
   */
  it('verifies origin/main exists, as the guard on the diff and not merely above it', () => {
    expect(condition(), 'the origin/main verify no longer gates the diff that follows it')
      .toMatch(/git rev-parse --verify --quiet origin\/main > \/dev\/null \\\n\s*&& \[ -z "\$\(git diff --name-only origin\/main\.\.HEAD/);
  });

  /*
   * IT CAN ONLY TURN A REFUSAL INTO A SUCCESS. It runs in the case that was an
   * outright refusal a moment ago — a branch that is neither `main` nor the
   * declared one — so a person offline is never stopped from committing on the
   * branch they declared. Take either clause out and a fetch stands in front
   * of every commit.
   */
  it('runs only where the door refused a moment ago, so being offline never blocks a commit', () => {
    expect(condition(), 'the branch move no longer excludes the declared branch')
      .toContain('"$CURRENT_BRANCH" != "$BRANCH"');
    expect(condition(), 'the branch move no longer excludes `main` itself')
      .toContain('"$CURRENT_BRANCH" != "main"');
    expect(condition(), 'the branch move no longer excludes `master`')
      .toContain('"$CURRENT_BRANCH" != "master"');
    // AND THERE IS EXACTLY ONE FETCH IN THIS DOOR, so it cannot have escaped
    // the guard into the path every commit takes.
    expect([...commands.matchAll(/git fetch\b/g)].length, 'COMMIT.command has gained a second fetch')
      .toBe(1);
  });

  it('carries uncommitted work across and proves afterwards that it did', () => {
    // Refusing on any modified tracked file is what made the deadlock; git's
    // own `checkout` refusal is the guard, and the digests say so rather than
    // assume it.
    expect(block(), 'the branch move forces or discards').not.toMatch(/--force|git stash|checkout -f/);
    /*
     * **FOUR SPELLINGS OF THIS HAVE BEEN WRONG AND EVERY ONE WAS FOUND BY
     * PLANTING THE BREAK** — `T-411`, and this is the assertion standing
     * between a person and losing uncommitted work.
     *   · `/shasum -a 256|sha256sum/` survived deleting either half of the
     *     two-platform pair.
     *   · Counting digest sites survived deleting one platform spelling at
     *     both sites, which produces an EMPTY digest on the other machine —
     *     and two empty digests compare equal.
     *   · Asserting that the comparison APPEARS survived deleting the body of
     *     the branch it opens, so the door printed *DO NOT RUN ANYTHING ELSE*
     *     and carried straight on to commit.
     * So: one digest site carrying both spellings, taken before and after, and
     * a mismatch that reaches a stop.
     */
    const before = block().indexOf('MOVE_BEFORE="$(dirty_digest)"');
    const move = block().indexOf('git checkout main');
    const after = block().indexOf('MOVE_AFTER="$(dirty_digest)"');
    expect(before, 'nothing digests the uncommitted paths before the switch').toBeGreaterThan(-1);
    expect(after, 'nothing digests them again afterwards').toBeGreaterThan(-1);
    expect(before, 'the before-digest is taken after the switch, which measures nothing')
      .toBeLessThan(move);
    expect(after, 'the after-digest is taken before the switch, which measures nothing')
      .toBeGreaterThan(move);
    // ONE SITE, BOTH PLATFORM SPELLINGS. `sha256sum` is not on macOS and
    // `shasum` is not on every Linux; a site left with one of them digests
    // nothing on the other machine and says it digested.
    const sites = [...block().matchAll(/shasum -a 256 "\$f" 2>\/dev\/null \|\| sha256sum "\$f"/g)];
    expect(sites.length, 'the digest site has gone, or has lost one of its two platform spellings')
      .toBe(1);
    /*
     * AND A SYMLINK IS READ AS A LINK. `-f` FOLLOWS ONE, so under `-f` alone a
     * symlink was digested as its TARGET and retargeting it at a different
     * file with the same bytes compared equal — a link that moved, under a
     * line saying nothing had. Measured by this round's audit.
     */
    expect(block(), 'a symlink is digested as its target again, so retargeting it is invisible')
      .toContain('[ -L "$f" ]');
    // The line that reads the link is an `echo`, so it is read off `body` —
    // `commands` has the `echo` lines stripped.
    expect(body, 'the symlink branch no longer reads what the link points at')
      .toContain('readlink "$f"');
    // AND THE LIST IS NUL-SEPARATED, because `git diff --name-only` C-quotes
    // any path outside ASCII and a quoted path matches nothing.
    expect(block(), 'the uncommitted paths are read in a form git quotes')
      .toMatch(/git diff --name-only -z; git diff --cached --name-only -z/);
    // AND THE MISMATCH REACHES A STOP. A guard whose body is deleted prints a
    // contradiction and commits anyway.
    /*
     * **AND THE `fi` IS EXCLUDED ANYWHERE, NOT ONLY AT THE START OF A LINE.**
     * Measured: closing the branch with `: ; fi` on one line and re-opening it
     * as `if false; then` left a line-anchored version green — the match ran
     * past the closed block and found the `exit 1` in the dead one.
     */
    expect(block(), 'a file that changed under the switch no longer stops the commit')
      .toMatch(/if \[ "\$MOVE_BEFORE" != "\$MOVE_AFTER" \]; then(?:(?!\bfi\b)[\s\S])*?exit 1/);
  });

  it('moves you before it stages anything', () => {
    // The offset is taken from inside the block, not from the whole file: a
    // stray earlier `CURRENT_BRANCH="main"` satisfied the first spelling with
    // the real move deleted. Measured.
    const at = commands.search(CONDITION);
    const move = commands.indexOf('CURRENT_BRANCH="main"', at);
    const staging = commands.indexOf('git add --');
    expect(move, 'the branch move is gone').toBeGreaterThan(at);
    expect(staging, 'COMMIT.command no longer stages a named list').toBeGreaterThan(-1);
    expect(move, 'the branch move happens after staging, which is not a branch it can move off')
      .toBeLessThan(staging);
  });

  /*
   * NOTHING TO COMMIT IS NEITHER A SUCCESS NOR A REFUSAL, AND BOTH HALVES OF
   * THAT WERE FOUND BY AUDIT — the second inside the fix for the first.
   *
   *   · IT EXITED 0. Right when a person reads the sentence, wrong the day a
   *     chain reads the number: `SHIP.command` went on to push and to open a
   *     pull request over a commit that never happened, and its closing page
   *     said THE PULL REQUEST IS OPEN.
   *   · IT THEN EXITED 1, WHICH MADE THE CHAIN UNREPEATABLE. Commit, fail at
   *     the push on a minute of bad network, fix it, double-click again — and
   *     the second run stops here for ever, with the push and the pull request
   *     unreachable from the door written to reach them.
   *
   * So: 3, and `SHIP.command` carries on. This asserts both ends, because
   * either alone is a number nothing reads.
   */
  it('answers nothing-to-commit with its own code, and the chain carries on', () => {
    const arm = /if git diff --cached --quiet; then(?:(?!\bfi\b)[\s\S])*?exit (\d)/.exec(commands);
    expect(arm, 'COMMIT.command no longer notices that there is nothing to commit').not.toBeNull();
    expect(arm![1], 'nothing-to-commit reports plain success, or is indistinguishable from a refusal')
      .toBe('3');

    const ship = readFileSync(join(HERE, 'SHIP.command'), 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l) && !/^\s*echo\b/.test(l)).join('\n');
    const from = ship.indexOf('run_door "COMMIT.command"');
    const to = ship.indexOf('run_door "PUSH-BRANCH.command"');
    expect(to, 'the chain no longer pushes after committing').toBeGreaterThan(from);
    const between = ship.slice(from, to);
    expect(between, 'the chain does not read the commit door’s answer at all')
      .toContain('COMMIT_STATUS=$?');
    expect(between, 'the chain no longer recognises nothing-to-commit, so it cannot be run twice')
      .toMatch(/\[ "\$COMMIT_STATUS" -eq 3 \]/);
    expect(between, 'the chain no longer stops on a refusal from the commit door')
      .toMatch(/\[ "\$COMMIT_STATUS" -ne 0 \][\s\S]*?finish 1/);
  });

  /*
   * `T-415`. The door printed *the repo is not on GitHub yet* twice on every
   * run, and it has been on GitHub since 5 Sep. It is screen text and reaches
   * no commit message, which is why it was waved through twice — and it was
   * the last thing a person read after every commit, telling them to do
   * nothing when the next step was a door.
   *
   * **THE POSITIVE HALF READS THE SCREEN.** Reading the whole file was
   * satisfied by a comment, measured: deleting the only `echo` that names the
   * push door left it green, which is `T-415`'s own defect in the other
   * direction.
   */
  it('does not say the repository is not on GitHub yet', () => {
    const stale = raw.split('\n').filter((l) => /not on GitHub yet/i.test(l));
    expect(stale, `COMMIT.command says something untrue about the world:\n  ${stale.join('\n  ')}`)
      .toEqual([]);
    expect(screen, 'nothing a person reads after a commit names the door that pushes the branch')
      .toContain('PUSH-BRANCH.command');
  });
});
