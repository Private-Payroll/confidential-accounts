/**
 * **NOTHING ON THE PRODUCT PATH REACHES A SIMULATED IMPLEMENTATION DIRECTLY.**
 *
 * This is the round's owed check made standing. A sweeping change is
 * verified by looking for what should be GONE, not by re-running what changed.
 * The change was collapsing four selection sites into `selection.ts`, so the
 * check is a search for a fifth — and a search anybody has to remember to run is
 * a check that stops being run.
 *
 * ── WHY THIS ONE READS THE SOURCE, WHERE ITS NEIGHBOURS BUILD ────────────
 *
 * `no-password-in-the-bundle.test.ts` and `no-wasm-in-the-page.test.ts` both
 * argue, at length and correctly, that reading the source is a WEAKER claim than
 * asking the bundler — a grep says the text is not in one tree, not that the
 * browser never downloads it. **That argument does not transfer here, and the
 * reason is worth stating rather than assuming.** Their claim is about what ends
 * up in a file a browser downloads. This claim is about WHERE A DECISION IS
 * TAKEN, and a bundle cannot answer it: `SimulatedCommitments` is in the built
 * page either way, because the selector puts it there. What must not exist is a
 * second place that reaches for it. That is a fact about the source, so the
 * source is the right thing to read.
 *
 * ── WHAT IT STRIPS BEFORE IT LOOKS, AND WHY THAT IS NOT CHEATING ─────────
 *
 * Comments and string literals are removed first. These names are DISCUSSED all
 * over this repository — `src/core/payroll.ts` explains that the reason nothing
 * has lost money today is that the server still runs `SimulatedLedger`, and
 * `src/midnight/ledger.ts` throws an error whose text names it. A check that
 * counted prose would fail on the next honest comment, and a check that fails
 * for a reason nobody believes is a check that gets deleted. What is left after
 * stripping is code, and code is what the invariant is about.
 *
 * ── AND IT ASSERTS A PRESENCE, WHICH IS WHAT MAKES THE ABSENCE MEAN ANYTHING ──
 *
 * "No file reaches a simulated implementation" is also true of a walk that found
 * no files, a pattern that matches nothing, and a stripper that ate the whole
 * file. So the selector itself is asserted to still reach all three, and the
 * walk is asserted to have read a plausible number of files.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
/*
 * **A TEST NAMES ITS OWN WORLD OUT LOUD**, which is the same reason `sources()`
 * below excludes `*.test.ts` from the walk. These three are imported so the
 * last test in this file can assert on the OBJECT the product is handed rather
 * than on the text of the literal that built it.
 */
import { MidnightCommitments } from '../midnight/commitments.js';
import { wiring, observerView } from './selection.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));

const NAMES = /Simulated(Ledger|ProofSystem|Commitments)/;

/**
 * **THE SEAM A TEST USES TO DRIVE THE SERVER'S ROUTES OVER A DOUBLE, AND THE
 * NAME NO SHIPPED MODULE MAY SPEAK.**
 *
 * The product cannot write to a chain without a wallet, so the routes where
 * approval-signature verification, invitation sealing and payee disclosure live
 * are exercised by handing the entry point a whole boundary implementation the
 * test built itself. **That is a test naming its own world, which is what the
 * walk below exists to distinguish from a second decision hidden in the
 * product.**
 *
 * It is searched by exactly the same walk, with exactly the same exclusion of
 * test files, and with one allowed mention: the file that defines it.
 */
const THE_SEAM = /handInWiring/;

const SEAM_DEFINER = 'wiring/handed-in.ts';

/**
 * The files allowed to name one, and why each is allowed.
 *
 * `core/ledger.ts` DEFINES them, and that is now the ONLY entry.
 *
 * **`wiring/selection.ts` WAS THE SECOND AND IS NOT ANY MORE, WHICH IS THE
 * WHOLE OF WHAT CHANGED HERE.** It was allowed because it was the one place
 * that CHOSE the simulated set. The product selects the chain, so it chooses
 * nothing simulated, and an allow-list entry that no longer excuses anything is
 * an entry that will one day excuse something. **The simulated implementations
 * are a test double: they are still defined, still exercised by the files this
 * walk excludes, and reached by no module the product runs.**
 *
 * **`core/account.ts` USED TO BE A THIRD, AND R3 DELETED THE ENTRY RATHER THAN
 * EMPTYING IT.** It was allowed because `commitments` was a DEFAULT parameter
 * there and the import fed the default; R3 made the argument required, the
 * default's value went with it, and the import went with that. Its only
 * remaining mention of a simulated implementation is prose, which `stripped`
 * blanks. An allow-list entry that no longer excuses anything is an entry that
 * will one day excuse something, so there are two names here and there is no
 * empty third.
 */
const ALLOWED = new Set([
  'core/ledger.ts',
]);

/**
 * Block comments, line comments, then quoted strings of all three kinds.
 *
 * **BLANKED RATHER THAN DELETED, AND THAT IS NOT A STYLE CHOICE.** The first
 * version replaced each match with a single space, which collapses a
 * twenty-line comment into one line and shifts every line number after it. The
 * check still passed and still failed correctly — and the file:line it would
 * have printed while failing named the wrong line, in a repository whose
 * standing complaint about its own citations is that they were checked by
 * reading rather than by opening. Every non-newline character becomes a space,
 * so the stripped text is the same shape as the file.
 *
 * **AND THE QUOTE PASS WAS BLIND TO 395 LINES OF THE TREE IT SEARCHES.**
 * `T-280` `P1`, found by `S46`'s test-coverage pass with planted text, re-measured
 * here. The single pattern this replaces —
 * `/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g` — accepted an apostrophe as an
 * OPENING delimiter with no context at all, and its body matched `\n`. So
 * `company's` in JSX prose opened a string that ran to the next apostrophe
 * ANYWHERE in the file, and — the half that does the damage — every genuine
 * literal after that false close was then mis-paired. **In `web/App.tsx` that
 * blanked 293 lines in 42 runs from `:1377` to `:2733` of a 2,743-line file:
 * the back half of the one file `C175` is half about was not being read at
 * all.** `web/Join.tsx` 57, `web/Auth.tsx` 45. **Measured 363 wholly blanked
 * and 32 partly; the row's filed 338 is low and its per-file breakdown does
 * not sum to itself.**
 *
 * **THE FIX IS THAT NO STRING PASS MAY CROSS A NEWLINE, AND THE ORDER OF THE
 * TWO IS PART OF IT.** Quotes first, with a body that cannot contain a newline
 * and an opener that refuses to follow an identifier character, `)` or `]` —
 * no valid string literal begins immediately after one, and every prose
 * apostrophe does. Then backticks, also bounded to one line.
 *
 * **THE FIRST VERSION OF THIS FIX TOOK TEMPLATES FIRST AND LET THEM SPAN
 * LINES, AND `S56`'s OWN test-coverage pass BROKE IT IN THREE WAYS** — a backtick
 * inside a `'…'` string, a backtick in a TRAILING `//` comment (only
 * whole-line comments are blanked above), and one stray backtick with no
 * partner. Each opened a template span that ran to the next backtick anywhere
 * and hid the code between. **That is `T-280` again on a different delimiter,
 * inside the fix for `T-280`** — which is why the order and the newline
 * exclusion are both load-bearing and why the controls below plant all three.
 *
 * **THE PRICE, PAID DELIBERATELY: the INTERIOR of a genuine multi-line
 * template is no longer blanked and is READ as code.** That is the safe
 * direction — text this no longer blanks is text the search now sees, so the
 * change can add an offender and cannot hide one, and a mis-opened quote costs
 * its own line rather than the rest of the file. **MEASURED across all 88
 * walked files: zero offenders either way**, and it also removes the reason
 * `db/migrate.ts` and `core/sessions.ts` scored .8475 and .8619 on the ratio
 * control below; both are 1.0000 now.
 */
const blank = (m: string): string => m.replace(/[^\n]/g, ' ');

const stripped = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank)
    .replace(/(?<![A-Za-z0-9_$)\]])(['"])(?:\\.|(?!\1)[^\n\\])*\1/g, blank)
    .replace(/`(?:\\.|[^`\\\n])*`/g, blank);

const sources = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...sources(full)); continue; }
    if (!/\.tsx?$/.test(name)) continue;
    /*
     * Tests are excluded on purpose. A test names its own world out loud —
     * `new SimulatedLedger()` in a test is the test SAYING which implementation
     * it is exercising, which is the opposite of a hidden second decision.
     */
    if (/\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
};

describe('one wiring point', () => {
  const files = sources(SRC);

  it('read the tree it thinks it read', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.map(f => relative(SRC, f))).toContain('wiring/selection.ts');
  });

  /**
   * **THE POSITIVE CONTROL HAD TO BE REPLACED RATHER THAN DELETED, AND THE
   * REASON IS THE POINT OF IT.**
   *
   * It used to assert that `wiring/selection.ts` names all three simulated
   * implementations - which proved the search below could see something,
   * because the one file exempt from that search was known to contain them.
   * **The selector reaches none of them now**, so that control would assert the
   * opposite of what is true, and simply removing it would leave the search
   * below with nothing behind it: a check that finds no offenders in a tree
   * that contains none is indistinguishable from a check that cannot read.
   *
   * So the control moves onto the DETECTOR instead of onto a file. Planted
   * text, through the same `stripped` pass and the same pattern the walk uses,
   * in every place a real one could appear.
   */
  it('the search can see a simulated implementation when there is one to see', () => {
    const planted = [
      "import { SimulatedLedger } from '../core/ledger.js';",
      'const l = new SimulatedProofSystem();',
      'export const scheme = SimulatedCommitments;',
    ];
    for (const line of planted) {
      expect(NAMES.test(stripped(line)), `the walk cannot see: ${line}`).toBe(true);
    }
    /*
     * **AND THE NEGATIVE HALF, WHICH IS WHERE A DETECTOR GOES WRONG QUIETLY.**
     * A pattern that matched the word in prose would report offenders that are
     * comments, and whoever met that would widen the allow-list to shut it up.
     */
    expect(NAMES.test(stripped('/* SimulatedLedger is the test double. */'))).toBe(false);
    expect(NAMES.test(stripped("const why = 'SimulatedLedger';"))).toBe(false);
  });

  /**
   * **AND THE FILE THAT USED TO BE THE EXEMPTION IS NOW HELD TO THE RULE.**
   *
   * This is not covered by the walk below as a special case - it is covered
   * because it is no longer on the allow-list, and the walk includes it. This
   * case says so out loud, so that whoever puts it back on the list meets a
   * second red rather than a green suite. **Measured: with the entry restored
   * AND a simulated import added, this case still fails.**
   */
  it('the selector names no simulated implementation at all', () => {
    const code = stripped(readFileSync(join(SRC, 'wiring/selection.ts'), 'utf8'));
    expect(NAMES.test(code),
      'the selector reaches a simulated implementation again; the product selects the chain '
      + 'and the simulated set is a test double')
      .toBe(false);
  });

  /**
   * **THE CONTROL `T-280` NEEDED AND DID NOT HAVE, AND IT IS THE POINT OF THE
   * ROUND THAT WROTE IT.** `S56`, board `2y7g2`.
   *
   * The search below was green for as long as it has existed while it could not
   * read 395 lines of the tree it walks — 293 of them in `web/App.tsx`, one of
   * the four files `C175` exists because of. **Nothing in this repository would
   * have caught that.** The two controls above assert PRESENCE over
   * `wiring/selection.ts` — **the one file that could not trip the bug is the
   * file the controls read.** (It has six prose apostrophes, at
   * `src/wiring/selection.ts:67`, `:87`, `:88`, `:125`, `:142` and `:177`;
   * every one is inside a block comment the first pass blanks before the quote
   * pass runs. An earlier draft of this sentence said it had none — `S56`'s
   * test-coverage pass counted. Right conclusion, wrong reason, rule 14.)
   *
   * **A DETECTOR WHOSE GREEN IS CHEAP NEEDS A CONTROL THAT COSTS SOMETHING**,
   * and the three below are it: the exact failure on a fixture, the same
   * failure on the real tree, and a negative control that the fix did not buy
   * its sight by blanking less than it must.
   */
  it('a prose apostrophe does not blind the search — T-280, on a fixture and on the tree', () => {
    /*
     * **THE EXACT FAILURE, WRITTEN OUT.** Two apostrophes in JSX prose, nine
     * lines apart, with real code between them. The old pattern opened a string
     * at the first, closed it at the second, and blanked everything in between
     * — and then read every genuine literal in the rest of the file with the
     * quotes paired the wrong way round, which is what turned 8 false matches
     * into 395 blind lines.
     */
    const fixture = [
      "      <p>Your company's payroll is ready.</p>",   // opens, under the old pattern
      '      <span>Nothing here should disappear.</span>',
      '      {rows.map(r => (',
      '        <Row key={r.id} />',
      '      ))}',
      '      const planted = new SimulatedLedger(SimulatedCommitments);',
      '      <span>Nor should this.</span>',
      '      {done ? <Ok /> : <Wait />}',
      "      <p>and it doesn't close until here.</p>",  // closes, under the old pattern
    ].join('\n');
    const seen = stripped(fixture);

    /* The line the guard exists to find is READ, not blanked. */
    expect(seen.split('\n')[5]).toContain('new SimulatedLedger(');
    expect(NAMES.test(seen.split('\n')[5])).toBe(true);

    /*
     * And `blank`'s promise still holds: same number of lines, same columns, so
     * the `file:line` this test would print names the line it means.
     */
    expect(seen.split('\n')).toHaveLength(fixture.split('\n').length);
    expect(seen).toHaveLength(fixture.length);

    /*
     * **THE NEGATIVE CONTROL, AND IT IS NOT DECORATION.** Reading more is only
     * correct if the things that MUST be blanked still are. A name inside a
     * genuine literal is a mention, not a second wiring point, and if this
     * stopped being blanked the search above would go red on prose and be
     * turned off by whoever it inconvenienced.
     */
    const literals = [
      "const label = 'SimulatedLedger';",
      'const other = "SimulatedProofSystem";',
      'const tpl = `a template naming SimulatedCommitments`;',
      "const esc = 'it\\'s a SimulatedLedger by name only';",
      '/* a block comment naming SimulatedLedger */',
      '  // a line comment naming SimulatedProofSystem',
    ];
    for (const line of literals) {
      expect(NAMES.test(stripped(line)), `still blanked: ${line}`).toBe(false);
    }
    /* And the sanity of that loop: the same names ARE found when they are code. */
    expect(NAMES.test(stripped('const l = new SimulatedLedger(x);'))).toBe(true);

    /*
     * **AND THE SAME FAILURE ON THE OTHER DELIMITER, WHICH THE FIRST VERSION OF
     * THIS FIX STILL HAD.** `S56`'s own test-coverage pass planted these three and
     * showed the guard blind to two of them: a backtick inside a `'…'` string,
     * a backtick in a TRAILING `//` comment — only whole-line comments are
     * blanked — and one stray backtick with no partner anywhere. Each opened a
     * template span that ran to the next backtick and swallowed the code
     * between. Three plants, one assertion each, on the line that matters.
     */
    const cascades = [
      ["  const hint = 'press ` for the console';",
        '  const evil = new SimulatedLedger(SimulatedCommitments);',
        "  const tail = 'and ` again';"],
      ['  const a = 1; // press ` to open',
        '  const evil = new SimulatedProofSystem();',
        '  const b = 2; // and ` again'],
      ['  const a = 1; // a stray ` here',
        '  const evil = new SimulatedCommitments();',
        '  const c = 3;'],
      /*
       * **AND ONE PLANT PER DEFENCE, BECAUSE `S56` MEASURED ITS OWN CONTROL AND
       * FOUND IT WEAKER THAN IT LOOKED.** The stripper's quote pass has two
       * independent guards — the body may not cross a newline, and the opener
       * may not follow an identifier character — and with only the plants above,
       * **removing EITHER ONE ALONE left every case in this file green.** Only
       * removing both did anything, which means neither was measured.
       *
       * This one is the NEWLINE BOUND on its own: an odd `"` in prose has no
       * partner on its line, so a line-bounded pass simply does not match and
       * the code below stays readable. Let the body cross a newline and it runs
       * to the next one anywhere and swallows what is between. **The quote is
       * preceded by a space on purpose — after a digit or a letter the
       * lookbehind refuses it and this plant would measure that guard instead,
       * which is the next assertion's job.**
       */
      ['  const label = <p>status: "open</p>;',
        '  const evil = new SimulatedLedger(SimulatedCommitments);',
        '  const other = <p>and "closed</p>;'],
    ];
    for (const plant of cascades) {
      const middle = stripped(plant.join('\n')).split('\n')[1];
      expect(NAMES.test(middle), `a stray delimiter blinded the line after: ${plant[0]}`).toBe(true);
    }

    /*
     * **AND THE LOOKBEHIND ON ITS OWN**, which no multi-line plant can reach:
     * with the newline bound in place, a mis-opened apostrophe costs at most its
     * own line — so the only way to see it is a line where the code sits BETWEEN
     * two prose apostrophes. `company's` … `isn't` is what JSX prose looks like
     * and it is what the bug was made of.
     */
    const oneLine = "      <p>the company's {new SimulatedLedger(x)} isn't ready</p>";
    expect(
      NAMES.test(stripped(oneLine)),
      'a prose apostrophe blanked code on its own line',
    ).toBe(true);

    /*
     * **THE PRICE, ASSERTED SO IT IS A DECISION AND NOT A SURPRISE.** Because no
     * string pass may cross a newline, the INTERIOR of a genuine multi-line
     * template is read as code rather than blanked. That is the fail-open
     * direction — it can only add an offender — and this pins it so a later
     * round meets it as a stated choice.
     */
    const template = ['const q = `', '  SELECT * FROM t', '`;'].join('\n');
    expect(stripped(template).split('\n')[1]).toBe('  SELECT * FROM t');

    /*
     * **THE SAME CLAIM ON THE REAL TREE, WHICH IS WHERE IT WENT WRONG.**
     * A line carrying no quote character at all and not opening a comment is
     * code; the fraction of those a file keeps is how much of it the search can
     * see. **MEASURED 4 Sep, before and after: `web/Auth.tsx` .718 → .982,
     * `web/App.tsx` .798 → .955, `web/Join.tsx` .827 → .986.** The floor is set
     * at .90 — below every file today and above all three as they were, so this
     * case goes red on the tree if the cascade comes back, without pinning a
     * symbol somebody may rename.
     */
    for (const rel of ['web/App.tsx', 'web/Join.tsx', 'web/Auth.tsx']) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      const raw = text.split('\n');
      const seenLines = stripped(text).split('\n');
      let counted = 0;
      let kept = 0;
      raw.forEach((line, i) => {
        if (line.trim() === '') return;
        if (/['"`]/.test(line)) return;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        counted += 1;
        if (seenLines[i] === line) kept += 1;
      });
      expect(counted, `${rel} has quoteless code lines to measure`).toBeGreaterThan(50);
      expect(kept / counted, `${rel}: the search can only read ${kept} of ${counted} quoteless code lines`)
        .toBeGreaterThan(0.9);
    }
  });

  /**
   * **AND THE SEAM IS SEARCHED BY THE SAME WALK, WHICH IS THE WHOLE OF WHAT
   * KEEPS IT OUT OF A SHIPPED BUILD.**
   *
   * A test hands the entry point a boundary implementation it built itself, so
   * that the routes a wallet-less deployment cannot exercise are still
   * exercised. **A shipped module doing the same thing would be the rehearsal
   * coming back in through the door marked *for tests*** - and nothing about
   * the shape of such a module would say so.
   *
   * So the name is refused everywhere the simulated implementations are
   * refused, on the same terms, and the file that defines it is its only
   * allowed mention.
   */
  it('no shipped module takes the seam that hands a test its own boundary', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (rel === SEAM_DEFINER) continue;
      const code = stripped(readFileSync(file, 'utf8'));
      code.split('\n').forEach((line, i) => {
        if (THE_SEAM.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders,
      `these hand the entry point a boundary implementation from the product path, which is `
      + `the rehearsal coming back through a door marked for tests:\n${offenders.join('\n')}`)
      .toEqual([]);

    /* The control: the walk can see the name when a module speaks it. */
    expect(THE_SEAM.test(stripped("handInWiring(mySet);"))).toBe(true);
    /* And the definer is in the walk, so the exemption above is doing work. */
    expect(files.map(f => relative(SRC, f).split('\\').join('/'))).toContain(SEAM_DEFINER);
  });

  it('no other file on the product path names a simulated implementation in code', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (ALLOWED.has(rel)) continue;
      const code = stripped(readFileSync(file, 'utf8'));
      code.split('\n').forEach((line, i) => {
        if (NAMES.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    /*
     * The message matters as much as the assertion: whoever sees this red is
     * being told that a second selection has appeared, not that a name is
     * banned. The fix is to take what it needs from `wiring()`.
     */
    expect(offenders, `these reach a simulated implementation directly instead of through wiring():\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  /**
   * **THE LEDGER AND THE SERVICE GET THE SAME SCHEME OBJECT, FROM ONE FIELD.**
   * `T-209` `P2`.
   *
   * `AccountService` is handed `wiring().commitments`; the ledger is built by
   * `wiring().createLedger()`. **Before `S46` those were two separate
   * references to the same name, three lines apart in `selection.ts`** — and
   * after `S44` a mismatched pair no longer merely disagrees, it raises
   * governance rounds no ledger will execute (`src/core/ledger.ts:1047-1055`
   * states the requirement as a comment and only as a comment).
   *
   * This reads the source for the same reason the checks above do: the claim
   * is about **where a decision is taken**, which no built artifact can answer.
   *
   * **AND IT IS DELIBERATELY NARROW.** It pins the PRODUCT path — the one
   * object `wiring()` returns. It says nothing about a caller that constructs
   * the pair by hand with two different schemes, which needs `SimulatedLedger`
   * itself to read the scheme from the same place or refuse a stranger.
   * `SimulatedLedger` is `2y7f2b`'s file and not `S46`'s, so that half is
   * `T-278` and is not claimed here. Rule 27: what enforces it today is that
   * nobody has written the code that would break it.
   */
  /**
   * **THE IMPORT LIST IS READ FROM THE SOURCE AND NOT FROM THE STRIPPED TEXT,
   * AND THE FIRST VERSION OF THIS CASE GOT IT WRONG.**
   *
   * `stripped` blanks string literals - which is every import path - so a
   * search for `'./chain.js'` in stripped text can never match anything, and
   * the case was green for a reason that had nothing to do with what it
   * claimed. **It was the control below that said so**, which is the only
   * reason it was not shipped as a check that cannot fail.
   *
   * So this reads import SPECIFIERS out of the raw source. Raw text cannot be
   * searched loosely either: the selector's own prose names `node:fs` while
   * explaining why it must not import it, and a substring search over the raw
   * source would report the sentence as the offence.
   */
  const specifiers = (text: string): string[] =>
    [...text.matchAll(/^\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/gm)]
      .map(m => m[1]!);

  it('the selector does not import these named modules, and the build is what covers the '
    + 'rest', () => {
    /*
     * **THIS IS THE CHEAP HALF OF A GUARD THAT ALREADY EXISTS AND COSTS THREE
     * MINUTES.** `src/web/no-wasm-in-the-page.test.ts` builds the page and
     * reports what went into it, which is the account of the graph worth
     * having. It is also the slowest thing in this suite, and the mistake it
     * catches is a one-line import.
     *
     * **THE FAILURE: `src/web/main.tsx` IMPORTS THIS MODULE.** Anything that
     * builds a chain ledger reaches a sealed-state store on a filesystem, so an
     * import of it here puts `node:fs` in a browser bundle - which does not
     * build - and the contract's whole runtime into the page. A dynamic import
     * does not help: measured, an entry reaching the chain set pulled the same
     * 25 WebAssembly modules behind `await import()` as it did statically,
     * because a bundler resolves both.
     */
    /*
     * **WHAT THIS MEASURES, WHICH IS NARROWER THAN WHAT IT PROTECTS.** It reads
     * `import ... from '<x>'` and `export ... from '<x>'` specifiers and refuses
     * four names. **It cannot see a side-effect import (`import './chain.js'`),
     * a dynamic `await import()`, a re-export, or a reach into
     * `../midnight/ledger.js` by some other path** - each of those puts a ledger
     * in the page just as effectively.
     *
     * Those are covered, and covered better, by
     * `src/web/no-wasm-in-the-page.test.ts`, which builds the page and asserts
     * its WebAssembly list exactly - every route above reaches
     * `@midnightntwrk/ledger-v9` and that case names it. **This one is the cheap
     * end: it catches the mistake somebody actually makes, in milliseconds
     * rather than in a build.**
     */
    const found = specifiers(readFileSync(join(SRC, 'wiring/selection.ts'), 'utf8'));
    const banned = found.filter(spec =>
      spec === './chain.js' || spec === './product.js' || spec === './deployment.js'
      || spec.startsWith('node:'));
    expect(banned,
      `the module the page loads imports ${banned.join(', ')}, and anything that carries a `
      + 'ledger puts a filesystem and the contract runtime into a browser bundle')
      .toEqual([]);

    /*
     * **THE CONTROL, AND IT HAS ALREADY EARNED ITS PLACE.** It is what caught
     * the first version of this case reading text in which no import path can
     * appear.
     */
    expect(found,
      'the selector no longer takes its scheme from the contract, so the check above is '
      + 'reading a file whose imports it cannot see')
      .toContain('../midnight/commitments.js');

    /* And the pattern refuses a banned specifier when there is one to refuse. */
    expect(specifiers("import { chainWiring } from './chain.js';\n")).toEqual(['./chain.js']);
  });

  /**
   * **AND THE SAME CLAIM ABOUT THE OBJECT, NOT THE TEXT.**
   *
   * The checks above read source, because the claim they make is about **where
   * a decision is taken**, which no built artefact can answer. This one reads
   * the object the product is actually handed, because a text pattern over a
   * literal cannot see a rebinding - two one-line edits inside the selector
   * were once demonstrated that produce a mismatched pair on the product path
   * and leave every text check green.
   *
   * **IT PINS TODAY'S SELECTION DELIBERATELY.** The selection line is the whole
   * of what changing the wiring means, so a change of selection is a deliberate
   * edit, and this is one of the places it must pass through. That is the
   * intent, not an oversight.
   */
  it('the OBJECT the product is handed is the chain selection and the contract\'s scheme', () => {
    const chosen = wiring();
    /* One object, not a fresh one per call - otherwise identity means nothing. */
    expect(wiring()).toBe(chosen);
    expect(chosen.name).toBe('chain');
    /*
     * **IDENTITY AND NOT EQUIVALENCE - `toBe`, not `toEqual`.** Two objects
     * that answer the same today and diverge tomorrow are exactly the second
     * definition this product forbids, and a structural compare would call them
     * the same. Measured: replacing the scheme with a spread copy of itself
     * turns this red and turns nothing else red.
     */
    expect(chosen.commitments).toBe(MidnightCommitments);
  });

  /**
   * **A LEDGER IS NOT BUILT HERE, AND THE REFUSAL IS THE ASSERTION.**
   *
   * The module the page loads cannot hold a ledger - see the import check
   * above - so asking it for one is asking a build that has resolved no
   * deployment. **What comes back is a sentence naming the four facts that are
   * missing, not a ledger that looks ready.**
   *
   * The message is asserted and not merely the throw. A refusal whose words do
   * not name what is missing sends whoever reads it to look in the wrong place,
   * and this one is read by somebody holding a browser console.
   */
  it('asking the selector for a ledger refuses, and names what is missing', () => {
    const chosen = wiring();
    expect(() => chosen.createLedger()).toThrow(/has not resolved a deployment/);
    expect(() => chosen.createProofSystem()).toThrow(/has not resolved a deployment/);
    for (const fact of ['contract', 'indexer', 'node', 'proof server']) {
      expect(() => chosen.createLedger()).toThrow(new RegExp(fact));
    }
  });

  /**
   * **AND THE EVIDENCE ROUTE REFUSES RATHER THAN ANSWERING PARTLY.**
   *
   * A public observer view existed only on the simulated ledger. Under the
   * chain selection there is nothing to answer it with, and the decision about
   * what a chain SHOULD answer has not been taken. **The failure this pins is
   * the route serving the half it can compute**, which would be a
   * privacy-evidence route showing less than it claims to.
   */
  it('the public observer view refuses, and says the shape is undecided', () => {
    expect(() => observerView(null as never)).toThrow(/public observer view/);
    expect(() => observerView(null as never)).toThrow(/has not been decided/);
  });
});
