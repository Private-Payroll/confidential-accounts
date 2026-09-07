/**
 * THE ONE-ENTRY DIFFERENCE, OBSERVED. `T-171`'s ruling, condition (2).
 *
 * `vitest.mutation.config.ts` weakens a guard on purpose: `MUTATE.command` runs
 * under it so that a mutation which changes an `assert` does not trip the doc
 * gate, which would otherwise refuse the whole suite and leave every mutation in that corpus
 * scored as nothing. The ruling allowed that on three conditions, and this file
 * is the second: **the difference between the two configs is exactly one
 * `globalSetup` entry, and everything else is the same.**
 *
 * THE CONFIGS ARE IMPORTED AS MODULES AND THEIR VALUES READ. NOTHING HERE
 * MATCHES TEXT AGAINST A CONFIG, and that is `scripts/artifact-freshness.test.ts`'s
 * correction against itself rather than a preference. Its first version asserted
 * the wiring by reading `vitest.config.ts` as TEXT and matching a regex, and a
 * test-coverage pass found three separate ways to disarm the guard that left
 * the assertion green: comment the key out — a regex matches inside a comment;
 * wrap the call in `try {} catch {}`; put it behind `if (process.env.X)`. A
 * commented-out key is not a value.
 *
 * WHAT THIS FILE CANNOT DO BY READING VALUES, AND SAYS SO RATHER THAN
 * PRETENDING: `MUTATE.command` is a shell script. Whether it passes `--config`
 * is not a value any module exports, so the three assertions about the doors at
 * the bottom read `.command` text — the same instrument, and the same
 * limitation, as `artifact-freshness.test.ts`'s assertions on
 * `contracts/test/simulator.ts`'s import line. They are written to go red on
 * ADDITION as well as on removal: a new `vitest run` inside `MUTATE.command`
 * without the flag, or any OTHER door naming this config, fails them.
 *
 * The last of those is what makes the corrected sentence in `vitest.config.ts`
 * a checked claim rather than a comment. It now reads *only the mutation door
 * passes that flag*, and rule 14 says a sentence claiming what the system does
 * is checked when it is written.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * **IMPORTING THIS IS SAFE, AND THAT IS THE THING BEING TESTED.** `T-348`,
 * Until `S67` every statement in that file was at the top level, so an
 * `import` of it RAN the whole mutation door — which is how `S58` came to leave
 * a mutation live in `src/core/account.ts`. The door now runs only when it is
 * the process's entry point, and the corpus and the journal are exported for
 * readers. If this import ever starts running a suite, that is the regression
 * and this file will take minutes instead of milliseconds.
 */
// @ts-ignore — the harness is plain JavaScript, and it is the door's own source.
import { MUTATIONS, beginMutation, recoverFromLastRun, scoreKills } from './mutate-authority.mjs';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The two entries a mutation run keeps, in the order `vitest.config.ts` wires them. */
const KEPT = ['./scripts/artifact-freshness.globalSetup.ts', './scripts/ledger-limit.globalSetup.ts'];
/** The one it does not. Spelled here independently of the config that removes it. */
const DROPPED = './scripts/doc-freshness.globalSetup.ts';

type Config = {
  test?: {
    globalSetup?: string | string[];
    include?: string[];
    setupFiles?: string | string[];
    env?: Record<string, string>;
  };
} & Record<string, unknown>;

const loadBase = async (): Promise<Config> => (await import('../vitest.config.ts')).default as Config;
const loadMutation = async (): Promise<Config> =>
  (await import('../vitest.mutation.config.ts')).default as Config;

const setups = (c: Config): string[] => {
  const g = c.test?.globalSetup;
  return g === undefined ? [] : Array.isArray(g) ? g : [g];
};

describe('the real config still wires all three guards', () => {
  it('holds artifact-freshness, doc-freshness and ledger-limit — read, not grepped', async () => {
    // AN EXACT ARRAY IN EXACT ORDER, AND THE TIGHTNESS IS THE POINT. The three
    // sibling wiring tests all use `toContain` on this same value, so a FOURTH
    // guard added to `vitest.config.ts` goes red in exactly one place in this
    // repository: here. That is the right place. `vitest.mutation.config.ts`
    // removes an entry from a list it does not control, so the moment somebody
    // adds a guard there is a decision nothing else prompts — DOES A MUTATION
    // RUN KEEP IT? — and it is silent in both directions: a guard that should
    // have been dropped aborts every mutation in the corpus, and one that should have been
    // kept makes every score meaningless. A red test puts that decision in the
    // same turn as the addition, with the diff in front of the person. Rule 27:
    // this line is what enforces it.
    
    // `KEPT` and `DROPPED` are spelled here independently of the config, which
    // is deliberate and is the opposite call from `mustNotAppear` below. There
    // the runtime values ARE the instrument; here the independent spelling is —
    // the same reason `expect(DOC_GATE).toBe(DROPPED)` exists further down.
    expect(setups(await loadBase())).toEqual([KEPT[0], DROPPED, KEPT[1]]);
  });
});

describe('THE DIFFERENCE IS EXACTLY ONE ENTRY — the ruling\'s condition (2)', () => {
  it('drops the doc gate and keeps the other two, in the order they were wired', async () => {
    const wired = setups(await loadMutation());
    expect(wired).not.toContain(DROPPED);
    expect(wired).toContain(KEPT[0]);
    expect(wired).toContain(KEPT[1]);
    // ORDER, not just membership. `scripts/doc-freshness.ts:414-418` records why:
    // artifact-freshness runs FIRST so a missing or stale artifact is reported
    // as a compile problem rather than as a crash inside a later guard. A
    // derivation that reordered the survivors would be a second change.
    expect(wired).toEqual(KEPT);
  });

  it('removes ONE entry — not zero, not two — counted against the real config', async () => {
    const before = setups(await loadBase());
    const after = setups(await loadMutation());
    expect(after).toHaveLength(before.length - 1);
    // Both directions. The first catches a survivor being dropped as well; the
    // second catches an entry being ADDED to the mutation config, which no
    // reading of "removes exactly one" permits.
    expect(before.filter((e) => !after.includes(e))).toEqual([DROPPED]);
    expect(after.filter((e) => !before.includes(e))).toEqual([]);
  });

  it('NOTHING ELSE DIFFERS — every other key of both, compared deeply', async () => {
    // The whole object, not a list of keys somebody remembered to check. A
    // hand-maintained copy passes this on the day it is written and fails it the
    // first time `vitest.config.ts` changes, which is exactly the drift the
    // ruling's condition (1) is about — made loud here instead of silent.
    const base = await loadBase();
    const mutation = await loadMutation();
    const flatten = (c: Config): unknown => ({
      ...c,
      test: { ...c.test, globalSetup: '<compared separately, above>' },
    });
    expect(flatten(mutation)).toEqual(flatten(base));
    expect(Object.keys(mutation).sort()).toEqual(Object.keys(base).sort());
    expect(Object.keys(mutation.test ?? {}).sort()).toEqual(Object.keys(base.test ?? {}).sort());
  });

  it('IS DERIVED AND NOT COPIED — it imports the real config and retypes none of it', async () => {
    // THE ONE ASSERTION THAT CAN TELL CONDITION (1) FROM A CAREFUL COPY. A
    // hand-maintained second config is deeply equal to this one on the day it
    // is written; the test above would pass, and it would drift the first time
    // somebody edited `vitest.config.ts`. So this reads the derived file's own
    // SOURCE and asks whether the values are there at all.
    
    // THE LIST OF THINGS IT MAY NOT CONTAIN IS READ OFF THE REAL CONFIG AT
    // RUNTIME, not typed here. Add a key to `vitest.config.ts` and this check
    // extends itself to it; a list written out here would be the second
    // hand-maintained thing the ruling forbids, one level up.
    
    // WHAT IT CANNOT SEE, said plainly rather than implied: it reads text, and
    // text is the instrument `artifact-freshness.test.ts` was corrected away
    // from for reading VALUES. Nothing here reads a value from text — the
    // assertions on what the configs hold are the module-import ones above.
    // This one asks a different question, about the shape of a file, and it is
    // the same instrument that file's own tests use on
    // `artifact-freshness.globalSetup.ts` and `contracts/test/simulator.ts`.
    
    // REFERENCE IDENTITY WAS THE OTHER CANDIDATE AND WAS REFUSED. A spread
    // carries the very `include` array, so `mutation.test.include === base.test.include`
    // would prove derivation outright — but whether two imports of one module
    // share an instance is a property of the LOADER, and rule 41 records this
    // repository being given two different answers by `tsx` and by `vitest` for
    // exactly that class of question. An assertion that might go red under
    // TEST.command for a reason that is not about the guard is worse than the
    // weaker one that cannot.
    const base = await loadBase();
    const code = readFileSync(join(ROOT, 'vitest.mutation.config.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(code).toContain("from './vitest.config.ts'");

    const setupFiles = base.test?.setupFiles;
    const mustNotAppear = [
      ...(base.test?.include ?? []),
      ...(setupFiles === undefined ? [] : Array.isArray(setupFiles) ? setupFiles : [setupFiles]),
      ...Object.keys(base.test?.env ?? {}),
      ...Object.values(base.test?.env ?? {}),
      // The two guards it KEEPS. Only the one it removes may be named in it,
      // and that one is `DOC_GATE`.
      ...KEPT,
    ];
    // PER-CATEGORY, NOT A MAGIC NUMBER. A floor of "more than four" is a number
    // nobody updates; these track `vitest.config.ts` itself, so a category
    // emptying out is red rather than quietly shrinking the sweep.
    expect(base.test?.include ?? []).not.toHaveLength(0);
    expect(setupFiles).toBeDefined();
    expect(Object.keys(base.test?.env ?? {})).not.toHaveLength(0);
    for (const value of mustNotAppear) expect(code).not.toContain(value);
  });
});

describe('THE DERIVATION REFUSES rather than quietly becoming a copy', () => {
  it('throws when the entry it removes is not there', async () => {
    // AND ONE PROPERTY OF THIS FILE'S ORDER, WRITTEN DOWN SO A REORDER DOES NOT
    // LOSE IT: the tests above call `loadBase()` AFTER `loadMutation()` has been
    // evaluated. So a derivation that mutated the imported base in place —
    // `base.test.globalSetup = dropDocGate(...)` instead of a spread — is caught
    // by them, because they would then read the mutated list. Vitest runs a
    // file's tests in order; under `sequence.concurrent` that guarantee is gone.
    // C238, C263: a subtraction that subtracts nothing is a check that cannot
    // fail. Rename the doc gate and this file must stop the run, not ship a
    // config identical to `vitest.config.ts` under a name saying it is not.
    const { dropDocGate } = await import('../vitest.mutation.config.ts');
    expect(() => dropDocGate([...KEPT])).toThrow(/is not among/);
  });

  it('throws when the entry appears twice, because it would remove two', async () => {
    const { dropDocGate } = await import('../vitest.mutation.config.ts');
    expect(() => dropDocGate([KEPT[0], DROPPED, DROPPED, KEPT[1]])).toThrow(/appears 2 times/);
  });

  it('throws on an empty list — a mutation run with no guard at all', async () => {
    const { dropDocGate } = await import('../vitest.mutation.config.ts');
    expect(() => dropDocGate([])).toThrow(/NO globalSetup at all/);
  });

  it('throws when the REMOVAL empties the list, not only when the input was empty', async () => {
    // The path the first version missed, and an auditor found: a config wiring
    // the doc gate ALONE is a non-empty input, one hit, and an empty result —
    // a mutation run with no guard at all, produced by the function whose
    // comment said it prevented that.
    const { dropDocGate } = await import('../vitest.mutation.config.ts');
    expect(() => dropDocGate([DROPPED])).toThrow(/leaves NO globalSetup at all/);
  });

  it('returns the survivors, in order, when the list is the real one', async () => {
    const { dropDocGate, DOC_GATE } = await import('../vitest.mutation.config.ts');
    // The config removes the string IT names; this file names it independently.
    // A typo in either is a red test rather than a guard that stayed wired.
    expect(DOC_GATE).toBe(DROPPED);
    expect(dropDocGate([KEPT[0], DROPPED, KEPT[1]])).toEqual(KEPT);
  });
});

describe('ONLY THE MUTATION DOOR PASSES THE FLAG — the corrected sentence, checked', () => {
  const CONFIG = 'vitest.mutation.config.ts';

  /**
   * Everything in this repository that could hand `vitest` a config — not only
   * the `.command` files at the root, and not only the ones naming THIS config.
   *
   * THE CORPUS IS WIDER THAN THE FIRST VERSION'S AND AN AUDITOR IS WHY. That
   * version listed `readdirSync(ROOT)` filtered to `.command` and asked which
   * of them contained the literal string `vitest.mutation.config.ts`. Four
   * disarms walked past it: a SECOND derived config under another name, pointed
   * at by any door; a name assembled from a variable; `package.json`'s own
   * `test` script, which `readdirSync` never opens; and `scripts/*.sh`, which
   * `MUTATE.command:127` already calls directly.
   */
  const corpus = (): { file: string; text: string }[] => {
    const files = [
      ...readdirSync(ROOT).filter((f) => f.endsWith('.command')),
      'package.json',
      ...readdirSync(join(ROOT, 'scripts'))
        .filter((f) => f.endsWith('.sh') || f.endsWith('.mjs'))
        .map((f) => join('scripts', f)),
    ];
    return files.map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));
  };

  it('every vitest run inside MUTATE.command carries the flag — COUNTED, not floored', () => {
    // Two today: the baseline at MUTATE.command:1535 and the scoring run at
    // :1739. Both, and exactly both.
    
    // THE FIRST VERSION OF THIS TEST ASSERTED A FLOOR — `runs.length > 0` and a
    // loop over whatever survived the filter — AND AN AUDITOR BROKE IT FOUR
    // WAYS, each leaving it green: put the flag in a TRAILING `#` comment (the
    // filter only excluded lines STARTING with `#`, so the substring matched
    // and the flag was never passed — the exact comment-matching attack this
    // whole file was written to avoid, reproduced inside the one assertion that
    // still had to read text); route one run through a `"$VITEST"` variable,
    // which is the house style in `MUTATE-SESSIONS.command` and so the likeliest
    // real refactor; spell it `vitest --run`; or split it over a backslash
    // continuation. The last three shrink the population the loop iterates, and
    // a loop over a population the edit chose is satisfied by construction.
    
    // So: the invocations are selected by the BINARY, the count is pinned, the
    // flag is matched as an ARGUMENT with a boundary after it, and the line is
    // required to carry exactly one `--config`.
    const text = readFileSync(join(ROOT, 'MUTATE.command'), 'utf8');
    const code = text.split('\n').map((l) => l.replace(/#.*$/, ''));
    // Anything that INVOKES vitest, by any of the spellings this repository
    // uses or would plausibly refactor to — the binary path, `npx`, the two
    // run spellings, or a `$VITEST` variable. `echo` lines are excluded because
    // the report text below names the config in prose, and a sentence about an
    // invocation is not one. (That exclusion was added after this very
    // assertion counted its own new report line as a third run.)
    const invokes = /node_modules\/\.bin\/vitest|npx vitest|\bvitest\s+(run|--run)\b|\$\{?VITEST\}?/;
    const runs = code.filter((l) => invokes.test(l) && !/^\s*echo\b/.test(l));
    expect(runs).toHaveLength(2);
    for (const line of runs) {
      expect(line).toMatch(new RegExp(`--config\\s+${CONFIG.replace(/\./g, '\\.')}(\\s|"|$)`));
      expect(line.match(/--config/g)).toHaveLength(1);
    }
    // AND THEY ARE THE TWO THIS ROUND MEANT. A `$VITEST` assignment line, a
    // backslash continuation or a third invocation all land in `runs` above and
    // fail the flag check; this pins that the two that remain are the baseline
    // and the scoring run rather than any two lines that happened to survive.
    expect(runs.filter((l) => l.includes('BASE_OUT='))).toHaveLength(1);
    expect(runs.filter((l) => l.includes('OUT=') && !l.includes('BASE_OUT='))).toHaveLength(1);
  });

  it('MUTATE.command tells the REPORT — in a block redirected there, above the first score', () => {
    // The ruling's condition (3). A mutation score was never a statement about
    // documentation, and a person reading REPORT-MUTATE.txt must not be able to
    // take it for one.
    
    // THE FIRST VERSION CHECKED THAT EACH SENTENCE SAT ON A LINE BEGINNING
    // `echo "`, AND THAT IS THE `if (process.env.X)` ATTACK ONE LAYER OUT. An
    // auditor showed three edits it passed: wrap the echoes in `if false; then`;
    // move them into a function nobody calls; redirect them to `logs/mutate.log`
    // instead of to the report. So what is asserted now is the BLOCK — that the
    // sentence sits inside a `{ … } >> "$REPORT"` group, that the group opens at
    // column 0 rather than indented inside a conditional or a function, and
    // that it stands above the baseline run, which is the first thing that can
    // produce a verdict.
    const lines = readFileSync(join(ROOT, 'MUTATE.command'), 'utf8').split('\n');
    const at = (phrase: string): number => lines.findIndex((l) => l.includes(phrase) && /^\s*echo "/.test(l));

    const reported = (phrase: string): void => {
      const i = at(phrase);
      expect(i, `"${phrase}" is not echoed anywhere in MUTATE.command`).toBeGreaterThan(-1);
      // Walk back to the group's opening brace, and forward to its close.
      let open = i;
      while (open > 0 && !/^\s*\{\s*$/.test(lines[open])) open -= 1;
      let close = i;
      while (close < lines.length - 1 && !/^\s*\}/.test(lines[close])) close += 1;
      expect(lines[open], `"${phrase}" is not inside a { … } group`).toMatch(/^\{\s*$/);
      expect(lines[close], `"${phrase}"'s group does not go to the report`).toMatch(/^\}\s*>>\s*"\$REPORT"/);
    };

    reported('RUN CONDITIONS: this run used vitest.mutation.config.ts');
    reported('WITHOUT the documentation gate');
    reported('TEST.command is the only');
    reported('Scored without the documentation gate');

    // BEFORE ANY SCORE. The conditions of a run belong above the run, and the
    // first thing that can print a verdict is the baseline.
    
    // **THE `#` IS STRIPPED, AND IT WAS NOT UNTIL `S56` FOUND IT FROM THE OTHER
    // SIDE.** This locator means *the first line that RUNS vitest with the
    // flag*, and a comment runs nothing — but it matched inside one, so a
    // sentence in the header mentioning both words moved `baseline` to the top
    // of the file and turned this case red over a prose edit. That is the exact
    // comment-matching attack the sibling case below already strips for, quoted
    // in its own words: *"the filter only excluded lines STARTING with `#`, so
    // the substring matched and the flag was never passed"*. The two locators
    // now read the same way, which is what they always claimed to.
    const code = (l: string): string => l.replace(/#.*$/, '');
    const baseline = lines.findIndex((l) => /vitest/.test(code(l)) && /--config/.test(code(l)));
    expect(baseline).toBeGreaterThan(-1);
    expect(at('RUN CONDITIONS: this run used vitest.mutation.config.ts')).toBeLessThan(baseline);
  });

  it('NO OTHER RUNNER PASSES --config TO VITEST AT ALL — the sentence, not one filename', () => {
    // `vitest.config.ts` used to say "what keeps it shut is that neither door
    // passes that flag". It now says only the mutation door does. That is a
    // claim about this repository, so it is measured rather than trusted.
    // Rule 14.
    
    // ASSERTED ON THE SHAPE `--config <anything>` AND NOT ON THIS CONFIG'S NAME,
    // because a future door pointed at a SECOND weakened config satisfies the
    // narrow question and breaks the sentence. Vite's own `--config` is a
    // different tool and is allowed: two doors pass one today.
    const offenders: string[] = [];
    for (const { file, text } of corpus()) {
      for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '');
        if (!/--config/.test(line)) continue;
        if (!/vitest/.test(line)) continue; // vite, not vitest — a different tool.
        if (file === 'MUTATE.command' && line.includes(CONFIG)) continue;
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);

    // And the corpus is not empty, or the sweep above passes by having read
    // nothing.
    expect(corpus().length).toBeGreaterThan(20);
    expect(corpus().map((c) => c.file)).toContain('MUTATE.command');
    expect(corpus().map((c) => c.file)).toContain('package.json');
  });

  it('and no SECOND derived config exists — one weakened config, or the sentence is gone', () => {
    // The cheapest disarm the auditor found: another `vitest.*.config.ts` that
    // drops a guard, pointed at by anything. Nothing else in the repository
    // enumerates config files, so this is the only place it can be caught.
    const configs = readdirSync(ROOT).filter((f) => /^vitest\..*config\.ts$/.test(f));
    expect(configs.sort()).toEqual(['vitest.config.ts', 'vitest.mutation.config.ts']);
  });
});

/**
 * **A DOOR THAT REPORTS SOMETHING IT DID NOT CHECK.** `T-295` `P1`, `T-285`
 * `P1`, `S56`, board `2y7g2`.
 *
 * Every `scripts/mutate-*.mjs` harness decided whether its run had happened by
 * asking whether `JSON.parse` threw. **That is the wrong question.** A vitest
 * run that collects NOTHING — a `globalSetup` that threw, a config error, a
 * crashed worker, a test file that failed to COLLECT — still writes a
 * well-formed report: `numTotalTests: 0`, `testResults: []`, `success: false`,
 * exit 1. It parses. `failures` is then `0`, and the harness printed **SURVIVED
 * — the code was broken and every test still passed**, which is the loudest
 * sentence these doors own, about a run in which nothing executed.
 *
 * **MEASURED, `SC15` §2:** `logs/mutate-authority/mutation-22.json` is 483
 * bytes against 32KB for every other artefact of the same run — 0 suites, 0
 * files, 0 assertions against 22 / 7 / 75 — and `AUTHORITY-CHECK` reported it
 * as `1 survived` for three rounds, with the founder told each time to ignore
 * it. **A door a person is trained to ignore has stopped being a door.**
 *
 * **WHY THIS TEST READS TEXT, WHICH THIS FILE ARGUES AGAINST AT LENGTH ABOVE.**
 * The objection at the top of this file is that a value is stronger than a
 * regex, and it is right wherever a value can be read. These harnesses are
 * standalone `.mjs` SCRIPTS that run a suite and `process.exit` on import;
 * there is no value to read without executing a door, which rule 1 forbids.
 * **So this is a text sweep, and it is written as a RATCHET rather than as a
 * claim about behaviour**: it cannot prove a harness scores correctly, only
 * that the guard has not been deleted from the two that have it and has not
 * silently spread its absence to a new one.
 */
describe('NO DOOR SCORES A RUN THAT COLLECTED NOTHING AS A SURVIVOR — T-295, T-285', () => {
  const harnesses = (): { file: string; text: string }[] =>
    readdirSync(join(ROOT, 'scripts'))
      .filter(f => /^mutate-.*\.mjs$/.test(f))
      .sort()
      .map(f => ({ file: `scripts/${f}`, text: readFileSync(join(ROOT, 'scripts', f), 'utf8') }));

  /*
   * The three marks of the guard, all three required. The first is the
   * decision — `ran` means assertions were COLLECTED, not that JSON parsed.
   * The second is the outcome having a name of its own. The third is the
   * sentence that was the defect: a run that measured nothing scored as the
   * loudest of the other three.
   */
  const guarded = (text: string): boolean =>
    text.includes('ran: byFile.length > 0')
    && text.includes('RAN AND MEASURED NOTHING')
    && !text.includes('Treated as SURVIVED')
    && shaped(text);

  /*
   * **THE THREE STRINGS ABOVE ARE NOT ENOUGH, AND `S56`'s OWN test-coverage pass
   * WROTE THE DIFFS THAT PROVE IT.** All three survive `if (collapsed.length)`
   * → `if (false && collapsed.length)`; all three survive moving the
   * `result.failures === 0` branch in front of the collapse branch. So this
   * asks the two structural questions a grep for a sentence cannot: **does the
   * collapse branch come BEFORE the survivor branch, and is the counter
   * incremented INSIDE it?**
   *
   * **WHAT THIS STILL CANNOT SEE, SAID RATHER THAN LEFT TO BE FOUND — RULE 27.**
   * It reads text. A harness that keeps all five markers and guts the code
   * around them passes, and so does one that parks them in a comment. **The
   * only real fix is to make the decision an importable function a test can
   * CALL**, and that is blocked today for a stated reason: these are standalone
   * `.mjs` scripts that run a suite on import, and a new file to hold the shared
   * logic would move `coverage.clientFilesScanned` in `docs/design/edges.json`
   * and refuse the whole suite until `npm run docs` ran. `BACKLOG.md` carries
   * the row. Until then this is a ratchet and it is not a proof.
   */
  const shaped = (text: string): boolean => {
    const gate = text.indexOf('if (collapsed.length) {');
    const survivor = text.indexOf('} else if (result.failures === 0) {');
    const counted = text.indexOf('notRun += 1;');
    return gate > -1 && survivor > gate && counted > gate && counted < survivor;
  };

  /*
   * **THE FOURTEEN `S56` DID NOT FIX, NAMED SO THAT NOTHING JOINS THEM
   * QUIETLY.** They share the defect structurally — it is one `runSuite`
   * copied sixteen times — but only `mutate-authority.mjs` is reachable by the
   * mechanism that has actually fired: it carries the only mutation in the
   * repository whose `from:` text is itself a scanned `pureCircuits` call site
   * recorded in `docs/design/edges.json`, so it is the only one that can throw
   * the doc-freshness gate. **MEASURED — of the 33 source files these sixteen
   * mutate, exactly one appears in `edges.json`.** The rest remain exposed to
   * the second route, which needs no doc gate at all: a mutation that stops a
   * suite file COLLECTING. `BACKLOG.md` carries the row and its destination.
   */
  const STILL_UNGUARDED = [
    'scripts/mutate-app-origin.mjs',
    'scripts/mutate-create-company.mjs',
    'scripts/mutate-deleted-systems.mjs',
    'scripts/mutate-hiring.mjs',
    'scripts/mutate-invitations.mjs',
    'scripts/mutate-password-gone.mjs',
    'scripts/mutate-refusals.mjs',
    'scripts/mutate-self-payee.mjs',
    'scripts/mutate-server-env.mjs',
    'scripts/mutate-wallet-dialog.mjs',
    'scripts/mutate-wallet-sign-in.mjs',
    'scripts/mutate-wallet-unlock.mjs',
    'scripts/mutate-web-sink.mjs',
    'scripts/mutate-web-wasm.mjs',
  ];

  const FIXED = ['scripts/mutate-authority.mjs', 'scripts/mutate-payslip-key.mjs'];

  it('the sweep reads harnesses rather than passing by having read none — C238, C263', () => {
    const found = harnesses().map(h => h.file);
    expect(found.length).toBeGreaterThan(10);
    for (const f of [...FIXED, ...STILL_UNGUARDED]) expect(found).toContain(f);
    expect(harnesses().every(h => h.text.length > 0)).toBe(true);
  });

  it('THE TWO DOORS S56 FIXED REFUSE IT — this case is the one that goes red on a regression', () => {
    for (const file of FIXED) {
      const h = harnesses().find(x => x.file === file);
      expect(h, `${file} is no longer on disk`).toBeDefined();
      expect(
        guarded(h!.text),
        `${file} no longer refuses a run that collected nothing. `
          + 'A survivor is a claim that a line of the money path has no test behind it, '
          + 'and it must never be produced by a run in which no assertion executed.',
      ).toBe(true);
    }
  });

  it('and each of the two keeps vitest\'s own words, which is the only place the reason lives', () => {
    for (const file of FIXED) {
      const { text } = harnesses().find(x => x.file === file)!;
      /*
       * Under mutation 22 the refusal naming the regeneration was
       * printed on stderr and thrown away by an empty `catch`, so the report
       * carried the alarm and not one word of the cause. That is why it cost a
       * round rather than a glance.
       */
      expect(text, `${file} discards the child's output again`)
        .toContain('said = [e?.stderr, e?.stdout]');
      /* And the three counts are three lines, never one sentence. */
      expect(text).toContain('RAN AND MEASURED NOTHING');
      expect(text).toContain('COULD NOT BE APPLIED');
      expect(text).not.toContain('} survived, ${stale} not run.');
    }
  });

  it('and each of the two refuses when two suites share an assertion title — rule 27', () => {
    /*
     * `kills:` is matched by title and nothing else, so a title living in a
     * different file from its mutation's subject would pass both the pre-flight
     * and the scoring match and watch nothing. `SC15` measured that no titles
     * collide today — by naming luck. This is the thing that enforces it.
     */
    for (const file of FIXED) {
      const { text } = harnesses().find(x => x.file === file)!;
      expect(text, `${file}: the title-collision refusal is gone`)
        .toContain('TWO SUITES CARRY THE SAME ASSERTION TITLE');
    }
  });

  it('and the fourteen are still on the list for a reason — fixing one FORCES pruning it', () => {
    /*
     * **WITHOUT THIS THE LIST IS AN ALLOW-LIST, NOT A RATCHET**, and `S56`'s
     * test-coverage pass is right that the difference matters: the day somebody
     * gives `mutate-hiring.mjs` the guard and leaves it named here, the list
     * stops ratcheting for that file in BOTH directions and a later regression
     * on it is invisible. Requiring the list to be exactly the unfixed set
     * means a fix cannot land without deleting its line.
     */
    for (const file of STILL_UNGUARDED) {
      const h = harnesses().find(x => x.file === file);
      expect(h, `${file} is no longer on disk — delete its line here too`).toBeDefined();
      expect(
        guarded(h!.text),
        `${file} HAS the guard now. Delete it from STILL_UNGUARDED in the same turn — `
          + 'a name left on this list is a harness nothing watches any more.',
      ).toBe(false);
    }
  });

  it('AND THE LIST MAY SHRINK, NEVER GROW — a new door does not get to arrive lying', () => {
    const unguarded = harnesses().filter(h => !guarded(h.text)).map(h => h.file).sort();
    const arrivals = unguarded.filter(f => !STILL_UNGUARDED.includes(f));
    expect(
      arrivals,
      'these harnesses score a run that collected nothing as a SURVIVOR and are not on '
        + 'the filed list. Either one of the two S56 fixed has regressed, or a new '
        + 'harness was copied from one that still carries the defect. Give it the guard; '
        + 'do not add it to the list.',
    ).toEqual([]);
  });
});

/*
 * ── THE RECOVERY JOURNAL — `T-348`, `S67` ───────────────────────────────────
 *
 * **AN INSTRUMENT IN THIS REPOSITORY COULD SILENTLY REVERT MONEY-PATH SOURCE
 * AND PRINT A SUCCESS MESSAGE WHILE DOING IT.** It nearly did, on 5 Sep, to the
 * round that found it.
 *
 * `beginMutation` wrote `{path, before}` before every mutation and
 * `recoverFromLastRun` ran FIRST on the next run — before the baseline suite,
 * before any mutation — and did `writeFileSync(held.path, held.before)`
 * **UNCONDITIONALLY. IT COMPARED NOTHING: not a hash, not an mtime, not a
 * length.** `S58`'s killed run left one holding a 168,660-byte snapshot of
 * `src/core/account.ts` taken at 22:11, and that round went on working until
 * 22:39. The next door run would have written the snapshot over the finished
 * file and printed *has been put back before anything else was done*, which
 * reads as a success. **It did not happen only because the stored path was
 * ABSOLUTE and named a container that no longer existed, so the write failed
 * `ENOENT` and took the door down first. A bug saved the tree from a worse
 * bug** — and on any machine where that path resolved, the revert would have
 * been silent.
 *
 * **THESE ARE BEHAVIOURAL, NOT A TEXT RATCHET.** They call the real exported
 * function against a real journal and a real file in a scratch tree, and the
 * assertion that matters in the two refusal cases is that **the file's bytes
 * are unchanged**. The evidence artefact is kept at
 * `logs/mutate-authority/in-flight-STALE-2026-09-05-EVIDENCE.json`.
 */
describe('THE MUTATION JOURNAL REFUSES RATHER THAN REVERTS — T-348', () => {
  const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

  /* Three texts that are pairwise different, standing in for the three states. */
  const BEFORE = 'export const approvedFor = 1;\n// the text the door mutated\n';
  const MUTATED = 'export const approvedFor = 0;\n// the text the door mutated\n';
  const SINCE = 'export const approvedFor = 1;\n// A LATER ROUND WROTE THIS AND IT MUST SURVIVE\n';

  const REL = join('src', 'core', 'account.ts');

  /** A scratch repository: a root, a file at `REL`, and a journal beside it. */
  const scratch = (fileText: string) => {
    const root = mkdtempSync(join(tmpdir(), 's67-journal-'));
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    const at = join(root, REL);
    writeFileSync(at, fileText);
    return { root, at, journal: join(root, 'in-flight.json') };
  };
  const clean = (root: string) => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } };

  /** The record this door writes today, told the truth. */
  const honest = () => ({
    v: 2, file: REL, before: BEFORE, expect: sha(MUTATED), restored: sha(BEFORE),
  });

  it('1. A WRONG PATH IS REFUSED — the exact shape S58\'s killed run left behind', () => {
    /*
     * This record is byte-for-byte the artefact in `logs/`: a `path` key, an
     * absolute path, a whole-file snapshot, and nothing to check either
     * against. **Under the code this replaced it would have written `BEFORE`
     * over `SINCE` and announced a recovery.**
     */
    const { root, at, journal } = scratch(SINCE);
    writeFileSync(journal, JSON.stringify({ path: at, before: BEFORE }));
    const said: string[] = [];
    const verdict = recoverFromLastRun((s: string) => said.push(s), { root, journal });

    expect(verdict.state, 'an unversioned record carries no hash and cannot be trusted').toBe('refused');
    expect(readFileSync(at, 'utf8'), 'THE LATER ROUND\'S WORK WAS OVERWRITTEN').toBe(SINCE);
    expect(said, 'it announced a recovery it did not perform').toEqual([]);
    clean(root);
  });

  it('1b. AND SO IS A VERSIONED RECORD WHOSE PATH CLIMBS OUT OF THE REPOSITORY', () => {
    const { root, at, journal } = scratch(SINCE);
    writeFileSync(journal, JSON.stringify({ ...honest(), file: '/etc/passwd' }));
    const said: string[] = [];
    const verdict = recoverFromLastRun((s: string) => said.push(s), { root, journal });

    expect(verdict.state).toBe('refused');
    expect(readFileSync(at, 'utf8')).toBe(SINCE);
    expect(said).toEqual([]);
    clean(root);
  });

  it('2. A STALE HASH IS REFUSED — somebody has been working here since', () => {
    /*
     * The record is in this door's own format and tells no lie about itself.
     * The file on disk is simply neither text. **That is the case the whole row
     * is about, and the assertion is the file\'s bytes.**
     */
    const { root, at, journal } = scratch(SINCE);
    writeFileSync(journal, JSON.stringify(honest()));
    const said: string[] = [];
    const verdict = recoverFromLastRun((s: string) => said.push(s), { root, journal });

    expect(verdict.state).toBe('refused');
    expect(verdict.why, 'the refusal must say whose work it declined to delete').toMatch(/worked in that file since/);
    expect(readFileSync(at, 'utf8'), 'A LATER ROUND\'S WORK WAS SILENTLY REVERTED').toBe(SINCE);
    expect(said).toEqual([]);
    clean(root);
  });

  it('3. AN HONEST RECORD RECOVERS — the mutation is still there and is put back', () => {
    const { root, at, journal } = scratch(MUTATED);
    writeFileSync(journal, JSON.stringify(honest()));
    const said: string[] = [];
    const verdict = recoverFromLastRun((s: string) => said.push(s), { root, journal });

    expect(verdict.state).toBe('recovered');
    expect(readFileSync(at, 'utf8'), 'the mutation was left in the tree').toBe(BEFORE);
    expect(readFileSync(journal, 'utf8'), 'CLEARED, never deleted — `rm` is refused on this folder').toBe('{}');
    expect(said.join('\n')).toContain('A PREVIOUS RUN WAS KILLED WITH A MUTATION STILL IN THE TREE');
    expect(said.join('\n'), 'it must name the file relatively, not by an absolute path').toContain(REL);
    clean(root);
  });

  it('4. AND A RUN KILLED BETWEEN THE RECORD AND THE WRITE IS NOT TAMPERING', () => {
    /*
     * **THE RECORD IS WRITTEN BEFORE THE MUTATION IS**, so a run killed between
     * those two lines leaves a CLEAN tree and a live record. Without the
     * `restored` branch this honest case would be reported as somebody having
     * worked in the file — a refusal on a door that has nothing wrong with it.
     */
    const { root, at, journal } = scratch(BEFORE);
    writeFileSync(journal, JSON.stringify(honest()));
    const said: string[] = [];
    const verdict = recoverFromLastRun((s: string) => said.push(s), { root, journal });

    expect(verdict.state, 'a clean tree is not a refusal').toBe('nothing');
    expect(readFileSync(at, 'utf8')).toBe(BEFORE);
    expect(readFileSync(journal, 'utf8')).toBe('{}');
    expect(said).toEqual([]);
    clean(root);
  });

  it('5. AN EMPTY OR ABSENT RECORD SAYS NOTHING AT ALL', () => {
    const { root, at, journal } = scratch(SINCE);
    const said: string[] = [];
    expect(recoverFromLastRun((s: string) => said.push(s), { root, journal }).state).toBe('nothing');
    writeFileSync(journal, '{}');
    expect(recoverFromLastRun((s: string) => said.push(s), { root, journal }).state).toBe('nothing');
    expect(readFileSync(at, 'utf8')).toBe(SINCE);
    expect(said).toEqual([]);
    clean(root);
  });

  it('AND WHAT IT WRITES IS RELATIVE AND CARRIES BOTH HASHES — the other half of the fix', () => {
    /*
     * `beginMutation` writes into the door's own `logs/mutate-authority/`, so
     * this reads the record it produced rather than inventing one. A hash of
     * `before` answers *is it already back?*; only a hash of the MUTATED text
     * answers *is this still the file I broke?*, and both are needed to tell
     * the three states apart.
     */
    /*
     * **THIS WRITES A SCRATCH RECORD, NEVER THE DOOR'S LIVE ONE, AND THE FIRST
     * DRAFT OF THIS TEST DID THE OPPOSITE.** `S67`'s own money-safety pass
     * caught it. Writing `logs/mutate-authority/in-flight.json` here names
     * `src/core/account.ts` with a 59-byte `before`; a `try`/`finally` restores
     * it after a failure or a throw **but not after process death**, and vitest
     * runs this file in a worker alongside sixty others. The next door run
     * would then refuse — correctly — while telling a person that *the stored
     * copy of `src/core/account.ts`* is in that file. Acting on that sentence
     * truncates a 173,000-byte file to 59 bytes. **A pin on the mechanism rule
     * 40 exists for, creating rule 40's own failure mode.**
     */
    const { root, journal } = scratch(BEFORE);
    beginMutation(REL, BEFORE, MUTATED, { journal });
    const written = JSON.parse(readFileSync(journal, 'utf8'));
    expect(written.file, 'an absolute path is not portable between the process that wrote it and the machine that reads it').toBe(REL);
    expect(written.file.startsWith('/'), 'the record must not name an absolute path').toBe(false);
    expect(written.expect, 'the hash must be of the MUTATED text').toBe(sha(MUTATED));
    expect(written.restored).toBe(sha(BEFORE));
    expect(written.v).toBe(2);
    expect(
      readFileSync(join(ROOT, 'logs', 'mutate-authority', 'in-flight.json'), 'utf8'),
      'THIS TEST WROTE THE DOOR\'S LIVE RECORD. It must never touch it.',
    ).toBe('{}');
    clean(root);
  });

  it('AND THE DOOR STILL ONLY RUNS WHEN IT IS THE DOOR — importing it measured nothing', () => {
    /*
     * This whole `describe` block imports the harness. If the entry-point guard
     * regresses, that import runs a mutation suite against the real tree — the
     * `S58` incident, reproduced by its own regression test. `MUTATIONS` being
     * readable here is the evidence that it did not.
     */
    expect(Array.isArray(MUTATIONS)).toBe(true);
    expect(MUTATIONS.length).toBeGreaterThan(20);

    const text = readFileSync(join(ROOT, 'scripts', 'mutate-authority.mjs'), 'utf8');
    expect(text, 'the entry-point guard is gone and importing this file runs the door again')
      .toContain('const RUN_AS_DOOR = ');
    expect(text).toContain('if (RUN_AS_DOOR) {');
    /*
     * **AND IT MUST FAIL LOUD RATHER THAN SILENT.** `AUTHORITY-CHECK.command`
     * treats a zero exit as success, so a guard that wrongly decided it had
     * been imported would print nothing, measure nothing and be scored clean.
     */
    expect(text, 'a mis-firing guard would exit 0 having measured nothing, and be scored as a clean run')
      .toContain('its entry-point check did not');
  });
});

/*
 * ── A `kills:` LIST IS A CLAIM, AND UNTIL `S67` NOTHING COULD REFUSE IT ─────
 *
 * `T-337`, raised by `SC19` and its money-safety pass, half-discharged by
 * `S58`, closed here on its actual subject.
 *
 * **AN ENTRY NAMES THE TESTS IT EXPECTS TO DIE. A NAME THAT RAN AND PASSED
 * PRINTED `! EXPECTED TO DIE AND DID NOT` AND FED NO COUNTER** — so the exit
 * code was unaffected and the report still said KILLED. The mutation *was*
 * killed; it was killed by something else. **The entry's claim that a NAMED
 * guard scores that binding could be false for as long as anybody left it
 * there, and the only way it was ever found was somebody re-measuring by
 * hand.** That is `C286`'s shape inside the instrument that exists to catch
 * `C286`'s shape in the product.
 *
 * **THE ASYMMETRY IS DELIBERATE AND WAS MEASURED, NOT ARGUED.** Over-claim is
 * fatal; under-claim (`+ also:`) is counted and printed and is not. `S67`
 * measured the run of 4 Sep 22:56 in `logs/REPORT-MUTATE-AUTHORITY.txt`: **ZERO
 * over-claims, TWENTY-ONE under-claims.** So the over-claim rule holds the tree
 * exactly as it stands, and an under-claim rule would turn the door red on
 * twenty-one lines that describe nothing wrong.
 */
describe('A kills: LIST THAT CREDITS A GUARD WHICH PASSED IS A FAILURE — T-337', () => {
  it('separates the claim that held, the claim that did not, and the unnamed catcher', () => {
    const scored = scoreKills(
      ['names a guard that died', 'names a guard that ran and PASSED'],
      ['names a guard that died', 'died without being named'],
    );
    expect(scored.named).toEqual(['names a guard that died']);
    expect(scored.missed, 'a credited guard that did not fail is the whole row').toEqual(['names a guard that ran and PASSED']);
    expect(scored.extra).toEqual(['died without being named']);
  });

  it('AN ENTRY WHOSE EVERY NAMED GUARD DIED CLAIMS NOTHING WRONG', () => {
    const scored = scoreKills(['a', 'b'], ['a', 'b']);
    expect(scored.missed).toEqual([]);
    expect(scored.extra).toEqual([]);
  });

  it('AND AN ENTRY THAT NAMED NOTHING THAT DIED IS ALL MISSED, NOT SILENTLY EMPTY', () => {
    /*
     * The door already printed *NAMED NO TEST THAT ACTUALLY DIED* for this and
     * counted nothing. It is now the loudest case of the same failure.
     */
    const scored = scoreKills(['a', 'b'], ['something else entirely']);
    expect(scored.named).toEqual([]);
    expect(scored.missed).toEqual(['a', 'b']);
  });

  /*
   * The wiring from that decision to the exit code cannot be exercised without
   * running the door (rule 1), so this half is a ratchet and says so. What it
   * refuses is the regression that matters: the counter being incremented
   * somewhere that does not affect the run's verdict, which is the state
   * `T-337` describes.
   */
  it('THE COUNTER IS FED BY THE MISSED LIST AND REACHES THE EXIT CODE — ratchet, not proof', () => {
    const text = readFileSync(join(ROOT, 'scripts', 'mutate-authority.mjs'), 'utf8');

    const branch = text.indexOf('if (missed.length) {');
    const counted = text.indexOf('wrongClaim += 1;');
    expect(branch, 'the over-claim branch is gone').toBeGreaterThan(-1);
    expect(counted, 'the counter is not incremented inside it').toBeGreaterThan(branch);
    expect(counted - branch, 'the increment has drifted out of the branch').toBeLessThan(200);

    expect(text, 'the fifth outcome has no line in the summary')
      .toContain('NAMED A GUARD THAT RAN AND PASSED');
    /*
     * **THE ONE THAT MATTERS.** `T-337`'s subject is precisely a counter that
     * touches no verdict. Both the summary sentence and the exit status must
     * carry it, or this is decoration.
     */
    expect(text, 'the exit code does not carry wrongClaim, so the claim is still unrefusable')
      .toContain('process.exit(survived + stale + notRun + wrongClaim === 0 && !aborted ? 0 : 1);');
    expect(text).toContain('survived + stale + notRun + wrongClaim === 0 && !aborted\n    ?');
  });

  it('AND THE DOOR TELLS THE READER THERE ARE FOUR NUMBERS, NOT THREE — rule 14', () => {
    const door = readFileSync(join(ROOT, 'AUTHORITY-CHECK.command'), 'utf8');
    expect(door, 'the door still promises three numbers while the harness prints four')
      .toContain('FOUR numbers since S67');
    expect(door).toContain('named a guard that ran and passed');
  });
});

/*
 * ── THE SCANNED EDGE AT `:542`, WHICH WAS HELD BY PROSE AND NOTHING ELSE ────
 *
 * **RULE 27: A PROPERTY THAT HOLDS BECAUSE NOBODY HAS WRITTEN THE CODE THAT
 * WOULD BREAK IT SAYS SO IN THOSE WORDS — OR IT NAMES WHAT ENFORCES IT.**
 * Raised against `S67` by its own money-safety pass.
 *
 * `docs/design/edges.json` records exactly one scanned circuit call site in
 * `scripts/mutate-authority.mjs`, and it is mutation 22's `from:` text. **A
 * single line added ABOVE it makes the generated doc set stale and refuses
 * EVERY test in this repository** until the documents are regenerated. `S67`
 * hit this and paid for it: two import lines moved the site to `:544` and the
 * whole suite went red.
 *
 * What held the line afterwards was three comments asking people not to
 * reformat — an import statement carrying three declarations on one line, and
 * an eighth suite sharing a line with the seventh. **This is what enforces it.**
 */
describe('THE ONE SCANNED EDGE IN THE HARNESS IS WHERE THE DOC SET SAYS IT IS', () => {
  it('edges.json and the file agree about the line, so a reformat goes red HERE and not everywhere', () => {
    const edges = JSON.parse(readFileSync(join(ROOT, 'docs', 'design', 'edges.json'), 'utf8'));
    const sites: string[] = JSON.stringify(edges)
      .match(/scripts\/mutate-authority\.mjs:\d+/g) ?? [];
    expect(sites.length, 'the doc set no longer pins exactly one site in this harness').toBe(1);

    const at = Number(sites[0].split(':')[1]);
    const line = readFileSync(join(ROOT, 'scripts', 'mutate-authority.mjs'), 'utf8').split('\n')[at - 1];
    expect(
      line,
      `docs/design/edges.json pins ${sites[0]}, and that line no longer holds the call it `
        + 'records. A line was added above it. The whole suite is about to be refused by the '
        + 'doc-freshness gate until the documents are regenerated. Move the addition BELOW '
        + 'that line instead, and nothing has to be regenerated at all.',
      /*
       * **ASSEMBLED FROM TWO PIECES SO THIS TEST DOES NOT ITSELF BECOME A
       * SCANNED CALL SITE — and the first draft did.** `scripts/edge-list.ts`
       * walks `src`, `scripts` and `contracts/test` for `.ts`/`.tsx`/`.mjs`,
       * so writing the call whole here added `scripts/mutation-config.test.ts`
       * to `docs/design/edges.json` and refused the entire suite. `S56` had
       * already learnt this in mutation 22's `to:` for the same reason.
       */
    ).toContain('pureCircuits.' + 'signerPublicKey(');
  });
});
