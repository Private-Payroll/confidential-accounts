/**
 * THE PIN FOR THE DOOR THAT HAS TO EXIST BEFORE THE FIRST COMMIT.
 *
 * ── THE CASE THAT MOTIVATED EVERY LINE OF THIS FILE ──────────────────────
 *
 * A wallet seed — sixty-four hexadecimal characters, no prefix, no header, no
 * punctuation — written into a file whose name matches no ignore rule. **The
 * scanner that stood here before printed `contents clean` over exactly that**,
 * because it knew connection strings, PEM headers and `sk-`/`ghp_`/`AKIA`, and
 * a bare hex run is none of those. On the same night a person looked straight
 * at the same value, reasoned from its shape, and ruled it public.
 *
 * **So the first test below is that case, and it is the one that must stay
 * red if anybody ever replaces extraction with recognition.** A scanner
 * rebuilt out of patterns passes every other test in this file and fails that
 * one, which is the whole point of writing it first.
 *
 * ── EVERY VALUE HERE IS MADE UP, IN THE TEST, AT RUN TIME ────────────────
 *
 * `randomBytes` — never a value read off this repository, never a value typed
 * in from one. A fixture that is a real secret is a real secret in a tracked
 * file, which is `C400` exactly.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractCandidates, scanFiles, renderReport, runSecretScan,
  assertReportCarriesNoValue, globToRegExp, matchesAny, loadConfig, makeSafePath,
  blindSpotsOf, shortReadSkip,
} from './secret-scan.mjs';

/**
 * ── THE HALF A PREFIX CHECK CANNOT DO DETERMINISTICALLY ──────────────────
 *
 * **NO REPORT MAY CARRY A HEX-LOOKING TOKEN THAT IS NOT ITS OWN FURNITURE.**
 *
 * The prefix assertions below ask *is a truncation of THIS value printed*, and
 * that question cannot be asked at four characters without asking it of chance
 * as well: sixteen bits of a `randomBytes` value collide with ordinary English
 * prose. **MEASURED on `scripts/secret-scan.mjs`: 18 distinct hex-only 4-grams
 * (`beca` inside *because*, `defa` inside *default*), and a value forced to
 * begin `beca` turned this file red on an unmodified scanner.** That is
 * `MIG-31`'s class exactly, one site over, and rarer is worse rather than
 * better — a failure at one run in a few thousand is one nobody attributes.
 *
 * So the prefix checks start at eight characters, where a collision is one in
 * four thousand million, **and the four-to-seven range they gave up is covered
 * from the other direction and WITHOUT randomness:** every standalone hex-only
 * token in the report is enumerated and compared against the short list of
 * tokens the report legitimately prints. A renderer that printed six leading
 * characters of a withheld value would put a token on the page that is on no
 * list — whatever the value happened to be that run.
 *
 * **THE LIST IS THE REPORT'S OWN FURNITURE AND IT IS DELIBERATELY SHORT.**
 * Measured with the same enumeration over `scripts/secret-scan.mjs`: three
 * tokens, all of them numbers the page prints about itself. **A NEW ENTRY IS
 * A DELIBERATE ACT** — if this goes red on a change to the scanner's own
 * prose, the token is named in the failure and adding it is one line; if it
 * goes red on anything else, it is a value on a page that must carry none.
 */
const REPORT_FURNITURE: ReadonlySet<string> = new Set(['1024', '8192', '000005']);

const noStrayHexToken = (text: string) => {
  const strays = [...new Set(
    [...text.matchAll(/(?<![0-9A-Za-z])([0-9a-f]{4,63})(?![0-9A-Za-z])/g)].map((m) => m[1]),
  )].filter((t) => !REPORT_FURNITURE.has(t));
  expect(
    strays,
    `the report carries hex-looking token(s) that are not its own furniture: ${strays.join(', ')}\n`
    + 'Either the renderer is printing part of a value, or the page has gained a '
    + 'number of its own and REPORT_FURNITURE needs the one line that says so.',
  ).toEqual([]);
};

/**
 * A NAMED PIPE, WHICH NODE CANNOT CREATE. It is the cheapest thing in a file
 * system that is neither a directory nor a regular file, and the walk's
 * treatment of exactly that is what is under test.
 */
const mkfifoSync = (abs: string) => execFileSync('mkfifo', [abs]);

let ROOT: string;

const write = (rel: string, text: string) => {
  const abs = join(ROOT, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
  return rel;
};

const config = (over: Record<string, unknown> = {}) => ({
  repository: { name: 'fixture', fingerprint: [] },
  secrets: { roots: ['.midnight', '.env'], minLength: 12, ...(over.secrets as object ?? {}) },
  person: { patterns: [], deriveHomeDirectory: false, ...(over.person as object ?? {}) },
  process: { patterns: [], ...(over.process as object ?? {}) },
  ignore: [],
  ...over,
});

const writeConfig = (cfg: unknown) => {
  const p = join(ROOT, 'cfg.json');
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
};

beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'secret-scan-')); });
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('the case the door exists for: a bare 64-hex value in a file nothing excludes', () => {
  it('FINDS IT — and a scanner rebuilt out of token patterns cannot pass this', () => {
    const seed = randomBytes(32).toString('hex');
    write('.midnight/wallet.seed', `${seed}\n`);
    write('shipped/summary.md', [
      'a machine-written run record',
      `Your wallet seed is: ${seed}`,
      'done',
    ].join('\n'));

    const cfg = config();
    const { candidates } = extractCandidates(ROOT, cfg as never);
    expect(candidates.some((c) => c.value === seed)).toBe(true);

    const scan = scanFiles(ROOT, ['shipped/summary.md'], candidates, cfg as never);
    expect(scan.secretHits).toHaveLength(1);
    expect(scan.secretHits[0].path).toBe('shipped/summary.md');
    expect(scan.secretHits[0].lines).toEqual([2]);
    expect(scan.secretHits[0].from.join(' ')).toContain('.midnight/wallet.seed');
  });

  it('carries NO token shape of its own — the value has no prefix, header or delimiter', () => {
    const seed = randomBytes(32).toString('hex');
    expect(/^(sk-|ghp_|AKIA|npg_)/.test(seed)).toBe(false);
    expect(seed).not.toContain('BEGIN');
    expect(seed).not.toContain('://');
    // The same shape as a contract address, which is why shape is not evidence.
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
  });

  it('finds it in either case, because one library prints hex up and another down', () => {
    const seed = randomBytes(32).toString('hex');
    write('.midnight/wallet.seed', seed);
    write('shipped/record.md', `seed=${seed.toUpperCase()}`);
    const cfg = config();
    const { candidates } = extractCandidates(ROOT, cfg as never);
    const scan = scanFiles(ROOT, ['shipped/record.md'], candidates, cfg as never);
    expect(scan.secretHits).toHaveLength(1);
  });
});

describe('a value that resolves to a file in this repository is a path, not a secret', () => {
  /**
   * `/` IS A BASE64 CHARACTER, SO A FILE PATH IS A VALID BASE64 RUN. Route 3
   * reads any such run out of a file in a secret root, and a secret root holds
   * a list of every published path with its purpose - so without this rule
   * every path in the repository is a candidate secret and any file naming one
   * in a comment refuses. That happened on 19 Sep over a real source file.
   *
   * **BOTH HALVES OF THE RULE ARE DRIVEN HERE, AND SO IS EACH WAY IT MUST NOT
   * FIRE**, because a secret scan somebody learns to wave through is worse than
   * no secret scan at all.
   */
  it('does NOT make a candidate of a path that is on disk', () => {
    write('src/thing/module.ts', 'export const a = 1;\n');
    write('.midnight/paths.md', 'src/thing/module.ts\n');
    const { candidates } = extractCandidates(ROOT, config() as never);
    expect(candidates.some((c) => c.value.startsWith('src/thing/module'))).toBe(false);
  });

  it('does NOT make a candidate when the run stops at the dot and the stem still resolves', () => {
    // The base64 run ends before `.ts`, so the value seen is the path without
    // its extension. The parent directory is asked whether anything there is
    // that name plus an extension. This is the exact shape of the 19 Sep case.
    write('src/deep/profile/disclosure.ts', 'export const b = 2;\n');
    write('.midnight/paths.md', 'src/deep/profile/disclosure\n');
    const { candidates } = extractCandidates(ROOT, config() as never);
    expect(candidates.some((c) => c.value === 'src/deep/profile/disclosure')).toBe(false);
  });

  it('STILL makes a candidate of a seed, which has no slash and resolves to nothing', () => {
    const seed = randomBytes(32).toString('hex');
    write('.midnight/wallet.seed', `${seed}\n`);
    const { candidates } = extractCandidates(ROOT, config() as never);
    expect(candidates.some((c) => c.value === seed)).toBe(true);
  });

  it('STILL makes a candidate of a base64 key that CONTAINS a slash and resolves to nothing', () => {
    const key = `ab/cd/${randomBytes(24).toString('base64').replace(/[+=]/g, 'x')}`;
    write('.midnight/api.env', `API_KEY=${key}\n`);
    const { candidates } = extractCandidates(ROOT, config() as never);
    // `=` is a base64 character, so the run swallows the field name with it -
    // the candidate is `API_KEY=ab/cd/...` and not the key alone. What matters
    // here is that the slashes did NOT buy it an exemption.
    expect(candidates.some((c) => c.value.includes(key))).toBe(true);
  });

  it('STILL refuses a real secret that reaches a file which would ship', () => {
    const seed = randomBytes(32).toString('hex');
    write('.midnight/wallet.seed', `${seed}\n`);
    write('shipped/leak.md', `the value is ${seed}\n`);
    const cfg = config();
    const { candidates } = extractCandidates(ROOT, cfg as never);
    const scan = scanFiles(ROOT, ['shipped/leak.md'], candidates, cfg as never);
    expect(scan.secretHits).toHaveLength(1);
  });

  it('does NOT treat a directory as a file, so a directory name is still a candidate', () => {
    // Long enough to clear the minimum length, or it never reaches the rule.
    const dir = 'src/a-directory-long-enough-to-be-a-candidate';
    write(`${dir}/keep.ts`, 'export const c = 3;\n');
    write('.midnight/paths.md', `${dir}\n`);
    const { candidates } = extractCandidates(ROOT, config() as never);
    // It is a DIRECTORY and no `<dir>.<ext>` exists beside it, so the rule must
    // not fire and the value stays a candidate. A rule that exempted directory
    // names would exempt any prefix of any path.
    expect(candidates.some((c) => c.value === dir)).toBe(true);
  });
});

describe('extraction — four routes in, because a shape test is the thing that failed', () => {
  it('takes the WHOLE FILE when it is one token, whatever the token looks like', () => {
    const odd = `zz-${randomBytes(9).toString('base64url')}-qq`;
    write('.midnight/strange.seed', `${odd}\n`);
    const { candidates } = extractCandidates(ROOT, config() as never);
    expect(candidates.some((c) => c.value === odd)).toBe(true);
  });

  it('takes a NAMED FIELD whatever its shape — a passphrase is not hex and not base64', () => {
    const phrase = 'correct horse battery staple and then some';
    write('.midnight/signer.json', JSON.stringify({ label: 'payroll', wrappingSecret: phrase }));
    const { candidates } = extractCandidates(ROOT, config() as never);
    const hit = candidates.find((c) => c.value === phrase);
    expect(hit).toBeDefined();
    expect(hit!.sources[0].field).toBe('wrappingSecret');
  });

  it('takes a named field NESTED inside arrays and objects', () => {
    const v = randomBytes(20).toString('hex');
    write('.midnight/signers.json', JSON.stringify({ signers: [{ id: 1, secretKey: v }] }));
    const { candidates } = extractCandidates(ROOT, config() as never);
    expect(candidates.some((c) => c.value === v)).toBe(true);
  });

  it('takes a dotenv value, and takes it whatever the name says', () => {
    const pw = `pw_${randomBytes(12).toString('hex')}`;
    write('.env', `# a comment\nDATABASE_URL=postgres://u:${pw}@host/db\nPLAIN=${pw}\n`);
    const { candidates } = extractCandidates(ROOT, config() as never);
    expect(candidates.some((c) => c.value.includes(pw))).toBe(true);
  });

  it('takes a hex or base64 run from ANYWHERE in a file in the root, not only from a named field', () => {
    const v = randomBytes(32).toString('hex');
    write('.midnight/notes.md', `we tried this once: ${v} and it worked`);
    const { candidates } = extractCandidates(ROOT, config() as never);
    expect(candidates.some((c) => c.value === v)).toBe(true);
  });

  it('drops values below the floor and COUNTS them, because a floor nobody can see is a hole', () => {
    write('.midnight/tiny.json', JSON.stringify({ apiKey: 'short' }));
    const out = extractCandidates(ROOT, config() as never);
    expect(out.candidates.some((c) => c.value === 'short')).toBe(false);
    expect(out.tooShort).toBeGreaterThan(0);
  });

  /**
   * ── WHAT THIS TEST USED TO ASSERT, AND WHY IT NOW ASSERTS THE OPPOSITE ──
   *
   * It used to require that a file which is binary, or larger than the size
   * limit, was NAMED in `skipped`. That was the right assertion about the wrong
   * behaviour: the run exited clean underneath the naming, so the page said
   * BLIND SPOT and the exit code said pass. **Neither the size of a file nor
   * whether it is text is a reason to stop looking**, so both are read now and
   * the assertion is that their values come out.
   */
  it('reads a file LARGER THAN ONE WINDOW, in windows, instead of giving up on it', () => {
    const seed = randomBytes(32).toString('hex');
    write('.midnight/big.md', `${'x'.repeat(4096)}\n${seed}\n${'y'.repeat(4096)}`);
    const cfg = config({ secrets: { roots: ['.midnight'], minLength: 12, maxFileBytes: 1024, maxValueBytes: 512 } });
    const out = extractCandidates(ROOT, cfg as never);
    expect(out.candidates.map((c) => c.value)).toContain(seed);
    expect(out.skipped).toEqual([]);
    expect(out.partial.map((q) => q.why).join(' ')).toContain('windows');
  });

  it('reads a value that lands ACROSS A WINDOW EDGE, whole, rather than as two halves', () => {
    /*
     * The window is 1024 bytes and the value starts at 1000, so the first
     * window ends in the middle of it. A scanner that took what the window gave
     * it would hold two fragments, and a literal search for either finds
     * nothing: **the boundary would have decided what gets looked for**, which
     * is the same defect as a size limit deciding it.
     *
     * ── THIS PROPERTY HAS TWO INDEPENDENT DEFENCES, AND THE MUTATION THAT
     *    TURNS THIS RED HAD TO REMOVE BOTH ─────────────────────────────────
     *
     * The windows overlap by the longest value the scanner will promise, which
     * alone puts every such value wholly inside some window; and a run that
     * reaches an edge is grown from the file, which alone recovers it too.
     * **Neither one on its own makes this assertion fail, and that is stated
     * here rather than left for somebody to discover** - it was measured, by
     * removing each and watching this stay green.
     */
    const seed = randomBytes(32).toString('hex');
    write('.midnight/straddle.md', `${'.'.repeat(1000)}${seed}${'.'.repeat(3000)}`);
    const cfg = config({ secrets: { roots: ['.midnight'], minLength: 12, maxFileBytes: 1024, maxValueBytes: 512 } });
    const out = extractCandidates(ROOT, cfg as never);
    expect(out.candidates.map((c) => c.value)).toContain(seed);
  });

  it('NAMES a run that crosses an edge and is too long to promise, instead of filing its halves as values', () => {
    /*
     * A run longer than the ceiling, placed where no window contains it. The
     * failure this pins is the quiet one: without growing the run from the
     * file, each window contributes its own FRAGMENT as a candidate - two
     * values that are not the value, searched for literally, matching nothing,
     * and no blind spot recorded anywhere. **The page would say clean and the
     * run would never have been looked for.**
     */
    const run = 'a'.repeat(100);
    write('.midnight/crossing.md', `${'.'.repeat(1900)}${run}${'.'.repeat(200)}`);
    const cfg = config({ secrets: { roots: ['.midnight'], minLength: 12, maxFileBytes: 1024, maxValueBytes: 64 } });
    const out = extractCandidates(ROOT, cfg as never);
    expect(out.tooLong.map((t) => t.path)).toContain('.midnight/crossing.md');
    const fragments = out.candidates.filter((c) => c.value !== run && run.includes(c.value));
    expect(
      fragments.map((c) => c.value.length),
      'a piece of an over-long run was filed as though it were a value',
    ).toEqual([]);
    /**
     * AND THE LENGTH IT REPORTS IS THE RUN'S, NOT THE FRAGMENT'S.
     *
     * **This is the assertion that makes the growing observable at all, and it
     * took a measurement to find that out.** Every other property here survives
     * the growing being removed: a run that no window contains always leaves a
     * first fragment longer than the overlap, so the ceiling check catches it
     * either way. What does NOT survive is the NUMBER - without growing, the
     * page reports the size of the piece one window happened to see and calls
     * it the size of the run, which is a measurement of nothing.
     */
    expect(out.tooLong.find((t) => t.path === '.midnight/crossing.md')?.length).toBe(run.length);
  });

  it('grows a run past an edge and takes it WHOLE when it is within the ceiling', () => {
    /*
     * The window here is smaller than the longest value the scanner will
     * promise, so the overlap cannot be the thing that saves this one: no
     * window is big enough to hold the value at all. Reading outward from the
     * file is the only route, and this is the configuration where that route
     * is the only one.
     */
    const long = 'abcdef0123456789'.repeat(16); // 256 characters of hex
    write('.midnight/wide.md', `${'.'.repeat(300)}${long}${'.'.repeat(150)}`);
    const cfg = config({ secrets: { roots: ['.midnight'], minLength: 12, maxFileBytes: 200, maxValueBytes: 1000 } });
    const out = extractCandidates(ROOT, cfg as never);
    expect(out.candidates.map((c) => c.value)).toContain(long);
    expect(out.tooLong).toEqual([]);
  });

  it('reads a file that is NOT TEXT for the ASCII runs in it, which is where a wallet keeps them', () => {
    /*
     * A database page is binary and the values inside it are not. Until this
     * changed, such a file was skipped whole - and this repository's own wallet
     * state is exactly that shape.
     */
    const seed = randomBytes(32).toString('hex');
    mkdirSync(join(ROOT, '.midnight'), { recursive: true });
    writeFileSync(join(ROOT, '.midnight', 'page.ldb'), Buffer.concat([
      Buffer.from([0, 1, 2, 0, 255]), Buffer.from(`!${seed}:`), Buffer.from([0, 9]),
    ]));
    const out = extractCandidates(ROOT, config({ secrets: { roots: ['.midnight'], minLength: 12 } }) as never);
    expect(out.candidates.map((c) => c.value)).toContain(seed);
    expect(out.skipped).toEqual([]);
    expect(out.partial.map((q) => q.why).join(' ')).toContain('not text');
  });

  it('names a run so long that no window can promise to have seen it whole', () => {
    write('.midnight/enormous.md', 'a'.repeat(6000));
    const cfg = config({ secrets: { roots: ['.midnight'], minLength: 12, maxFileBytes: 1024, maxValueBytes: 256 } });
    const out = extractCandidates(ROOT, cfg as never);
    expect(out.tooLong.length).toBeGreaterThan(0);
    expect(out.tooLong[0].path).toBe('.midnight/enormous.md');
  });

  it('names a secret root that is not there — an absent root is not an empty one', () => {
    write('.env', 'A=aaaaaaaaaaaaaaaa\n');
    const out = extractCandidates(ROOT, config() as never);
    expect(out.skipped.some((s) => s.path === '.midnight' && s.why === 'absent')).toBe(true);
  });
});

describe('what an audit found in the first draft of the change above', () => {
  it('REFUSES over a large JSON file, whose named fields it cannot read without parsing it whole', () => {
    /*
     * THE FIX'S OWN FIRST DEFECT, AND IT REPRODUCED THE THING THE FIX WAS FOR.
     *
     * A file too big for one window had its JSON route skipped, was printed
     * under a heading saying the routes that did not apply COULD NOT have
     * applied, and left the verdict clean. A passphrase in a named field of a
     * large JSON file was therefore never a candidate, never searched for, and
     * reported clean by every stage after it. **The heading asserted the loss
     * had not happened, which is worse than the blind spot it replaced.**
     */
    const phrase = 'correct horse battery staple correct horse battery staple';
    write('.midnight/big.json', JSON.stringify({ note: 'x'.repeat(4096), wallet_seed: phrase }));
    const cfg = config({ secrets: { roots: ['.midnight'], minLength: 12, maxFileBytes: 1024, maxValueBytes: 512 } });
    const out = extractCandidates(ROOT, cfg as never);
    expect(out.candidates.map((c) => c.value)).not.toContain(phrase);
    expect(out.skipped.map((q) => q.kind)).toContain('route-not-run');
    const result = runSecretScan(ROOT, ['README.md'], cfg as never);
    expect(result.ok).toBe(false);
    expect(result.blindSpots.map((b) => b.path)).toContain('.midnight/big.json');
  });

  it('names a CHILD inside a secret root that is not a regular file, the way it names a root', () => {
    /*
     * The root branch of the walk named a thing it could not read; the child
     * loop dropped it. Not read AND not named is a third state the verdict's
     * own rule says cannot exist.
     */
    write('.midnight/ok.seed', randomBytes(32).toString('hex'));
    write('.env', 'A=aaaaaaaaaaaaaaaa\n');
    mkfifoSync(join(ROOT, '.midnight', 'a-pipe'));
    const out = extractCandidates(ROOT, config() as never);
    expect(out.skipped.map((q) => `${q.path} ${q.kind}`)).toContain('.midnight/a-pipe not-regular');
    expect(runSecretScan(ROOT, ['README.md'], config() as never).ok).toBe(false);
  });

  it('records ONE blind spot for one over-long run, not one per alphabet it matched', () => {
    // A run of hexadecimal is also a run of base64. Counted once per pattern it
    // reported two blind spots where one exists - on the page whose entire
    // subject is an honest count of what was not looked at.
    // Delimited by a character in neither alphabet, so BOTH patterns match the
    // same stretch: that is the case the double count came from.
    write('.midnight/long.md', `.${'abcdef0123456789'.repeat(40)}.`);
    const cfg = config({ secrets: { roots: ['.midnight'], minLength: 12, maxFileBytes: 4096, maxValueBytes: 64 } });
    const out = extractCandidates(ROOT, cfg as never);
    expect(out.tooLong).toHaveLength(1);
    expect(out.tooLong[0].length).toBe(640);
    // and the sentence it gives names the ceiling it broke, not a window that
    // did in fact contain it
    const result = runSecretScan(ROOT, ['README.md'], cfg as never);
    const spot = result.blindSpots.find((b) => b.path === '.midnight/long.md');
    expect(spot?.why).toContain('ceiling');
    expect(spot?.why).not.toContain('no window');
  });

  it('treats a read that stopped short of the file as a blind spot, not a quiet partial', () => {
    /*
     * PINNED AS A RULE RATHER THAN AS A RACE. The state it guards against needs
     * a file to shrink underneath a running read, and a rule that can only be
     * exercised that way is a rule nobody ever watches fail. So the rule is its
     * own function and this is the whole of it; what is NOT pinned here is the
     * wiring, and saying so is better than an assertion that implies otherwise.
     */
    expect(shortReadSkip('a/b.md', 100, 100)).toBeNull();
    expect(shortReadSkip('a/b.md', 100, 101)).toBeNull();
    const short = shortReadSkip('a/b.md', 100, 60);
    expect(short?.kind).toBe('short-read');
    expect(short?.why).toContain('100');
    expect(short?.why).toContain('60');
    // and a skip of that kind is a blind spot, not a footnote
    expect(blindSpotsOf({ skipped: [short] }, {}).map((b) => b.path)).toEqual(['a/b.md']);
  });

  it('REFUSES a declared-public value that carries no written reason', () => {
    const addr = randomBytes(32).toString('hex');
    write('.midnight/contract.json', JSON.stringify({ contractAddress: addr }));
    const bare = config({ secrets: { roots: ['.midnight'], minLength: 12, publicValues: [{ value: addr }] } });
    expect(() => extractCandidates(ROOT, bare as never)).toThrow(/NO WRITTEN REASON/);
    const asString = config({ secrets: { roots: ['.midnight'], minLength: 12, publicValues: [addr] } });
    expect(() => extractCandidates(ROOT, asString as never)).toThrow(/NO WRITTEN REASON/);
  });

  it('PRINTS the written reason beside every hit it clears, because the config does not ship', () => {
    const addr = randomBytes(32).toString('hex');
    write('.midnight/contract.json', JSON.stringify({ contractAddress: addr }));
    const target = write('src/known.ts', `export const ADDRESS = '${addr}';\n`);
    const why = 'on-chain data: the chain publishes it, and this is where it was read from';
    const cfg = config({ secrets: { roots: ['.midnight'], minLength: 12, publicValues: [{ value: addr, why }] } });
    const result = runSecretScan(ROOT, [target], cfg as never);
    expect(result.ok).toBe(true);
    expect(result.report).toContain(why);
  });
});

describe('the side that clears the files, where size and encoding used to decide', () => {
  it('finds a value in a shipping file that is NOT TEXT, instead of skipping it', () => {
    /*
     * An image, a font, a compiled artefact. A seed sitting in one of them was
     * skipped and the skip was printed under a heading that said blind spot,
     * over an exit code that said clean.
     */
    const seed = randomBytes(32).toString('hex');
    write('.midnight/a.seed', seed);
    write('.env', 'A=aaaaaaaaaaaaaaaa\n');
    const target = 'assets/logo.bin';
    mkdirSync(join(ROOT, 'assets'), { recursive: true });
    writeFileSync(join(ROOT, target), Buffer.concat([Buffer.from([0, 1, 0, 2]), Buffer.from(seed), Buffer.from([0])]));
    const result = runSecretScan(ROOT, [target], config() as never);
    expect(result.ok).toBe(false);
    expect(result.scan.secretHits.map((h) => h.path)).toContain(target);
    expect(result.blindSpots).toEqual([]);
  });

  it('finds a value PAST the window in a shipping file larger than one window', () => {
    const seed = randomBytes(32).toString('hex');
    write('.midnight/a.seed', seed);
    write('.env', 'A=aaaaaaaaaaaaaaaa\n');
    const target = write('docs/long.md', `${'filler\n'.repeat(400)}${seed}\n${'more\n'.repeat(100)}`);
    const cfg = config({ secrets: { roots: ['.midnight', '.env'], minLength: 12, maxFileBytes: 512, maxValueBytes: 256 } });
    const result = runSecretScan(ROOT, [target], cfg as never);
    expect(result.ok).toBe(false);
    const hit = result.scan.secretHits.find((h) => h.path === target);
    // AND THE LINE NUMBER IS STILL THE FILE'S LINE NUMBER, counted across every
    // window rather than restarted inside the one the value happened to be in.
    expect(hit?.lines).toEqual([401]);
  });

  it('counts one occurrence once, even where two overlapping windows both see it', () => {
    const seed = randomBytes(32).toString('hex');
    write('.midnight/a.seed', seed);
    write('.env', 'A=aaaaaaaaaaaaaaaa\n');
    // Placed inside the region two consecutive windows share.
    const target = write('docs/overlap.md', `${'.'.repeat(400)}${seed}${'.'.repeat(400)}`);
    const cfg = config({ secrets: { roots: ['.midnight', '.env'], minLength: 12, maxFileBytes: 512, maxValueBytes: 256 } });
    const result = runSecretScan(ROOT, [target], cfg as never);
    expect(result.scan.secretHits.find((h) => h.path === target)?.lines).toHaveLength(1);
  });
});

describe('the report names a place and never the thing it is about', () => {
  it('prints the offending file and line, the SOURCE FILE NAME, and no value', () => {
    const seed = randomBytes(32).toString('hex');
    write('.midnight/wallet.seed', seed);
    const target = write('shipped/page.md', `line one\nseed ${seed}\n`);
    const result = runSecretScan(ROOT, [target], config() as never);
    expect(result.ok).toBe(false);
    expect(result.report).toContain('shipped/page.md:2');
    expect(result.report).toContain('.midnight/wallet.seed');
    expect(result.report).not.toContain(seed);
    // and no prefix of it either, which is the half a reviewer forgets
    for (const n of [8, 12, 16, 24, 32]) expect(result.report).not.toContain(seed.slice(0, n));
  });

  it('REFUSES TO HAND BACK a report carrying a value, rather than trusting an author', () => {
    const seed = randomBytes(32).toString('hex');
    const candidates = [{ value: seed, sources: [{ sourceFile: '.midnight/wallet.seed', field: '(whole file)' }], kinds: ['hex'], declaredPublic: false }];
    expect(() => assertReportCarriesNoValue(`all clear: ${seed}`, candidates as never))
      .toThrow(/ABOUT TO WRITE A REPORT CONTAINING A SECRET/);
    expect(() => assertReportCarriesNoValue('all clear', candidates as never)).not.toThrow();
  });

  it('says how many files it read and how many candidates it holds, so a silent run is visible', () => {
    write('.midnight/a.seed', randomBytes(32).toString('hex'));
    // BOTH ROOTS THE CONFIG NAMES EXIST, and that is now load-bearing: a root
    // the config names and the disk does not have is a blind spot and refuses.
    write('.env', 'A=aaaaaaaaaaaaaaaa\n');
    const target = write('README.md', 'nothing here');
    const result = runSecretScan(ROOT, [target], config() as never);
    expect(result.ok).toBe(true);
    expect(result.report).toMatch(/candidate values\s+[1-9]/);
    expect(result.report).toContain('files read');
  });
});

describe('the two non-secret shapes', () => {
  it('REFUSES a home directory, because a file may not name a person', () => {
    write('.midnight/a.seed', randomBytes(32).toString('hex'));
    const target = write('shipped/note.md', 'compiled at /Users/somebody/Projects/thing/src\n');
    const cfg = config({ person: { patterns: ['/Users/somebody'], deriveHomeDirectory: false } });
    const result = runSecretScan(ROOT, [target], cfg as never);
    expect(result.ok).toBe(false);
    expect(result.personPlaces).toBe(1);
    expect(result.report).toContain('shipped/note.md:1');
  });

  it('REPORTS the process and does NOT refuse, because that sweep is another round', () => {
    write('.midnight/a.seed', randomBytes(32).toString('hex'));
    write('.env', 'A=aaaaaaaaaaaaaaaa\n');
    const target = write('src/thing.ts', '// found by S71 and re-measured by SC21\n// the money-safety-auditor said so\n');
    const cfg = config({
      process: { patterns: [
        { name: 'a work-session id', pattern: '\\b(?:S|SC)\\d{1,3}\\b' },
        { name: 'an audit definition name', literal: 'money-safety-auditor' },
      ] },
    });
    const result = runSecretScan(ROOT, [target], cfg as never);
    expect(result.ok).toBe(true);
    expect(result.processPlaces).toBeGreaterThanOrEqual(3);
    expect(result.report).toContain('a work-session id');
    expect(result.report).toContain('an audit definition name');
    expect(result.report).toContain('REPORTED, NEVER REFUSED');
  });
});

describe('the exemptions, each of which is a way this could be quietly switched off', () => {
  it('never matches a value against the file it was read out of', () => {
    const v = `PLACEHOLDER_${randomBytes(8).toString('hex')}`;
    write('.env', `TOKEN=${v}\n`);
    const result = runSecretScan(ROOT, ['.env'], config() as never);
    expect(result.secretPlaces).toBe(0);
  });

  it('exempts a line carrying the marker, and NOTHING else', () => {
    const seed = randomBytes(32).toString('hex');
    write('.midnight/a.seed', seed);
    write('src/fixture.ts', `const a = '${seed}'; // not-a-secret\nconst b = '${seed}';\n`);
    const result = runSecretScan(ROOT, ['src/fixture.ts'], config() as never);
    expect(result.secretPlaces).toBe(1);
    expect(result.scan.secretHits[0].lines).toEqual([2]);
  });

  it('a declared-public value is counted and reported, and does not refuse', () => {
    const addr = randomBytes(32).toString('hex');
    write('.midnight/contract.json', JSON.stringify({ contractAddress: addr, signingKey: randomBytes(32).toString('hex') }));
    const target = write('src/known.ts', `export const ADDRESS = '${addr}';\n`);
    const cfg = config({ secrets: { roots: ['.midnight'], minLength: 12, publicValues: [{ value: addr, why: 'on-chain data, published by the chain itself' }] } });
    const result = runSecretScan(ROOT, [target], cfg as never);
    expect(result.ok).toBe(true);
    expect(result.scan.publicHits).toHaveLength(1);
    expect(result.report).toContain('declared public in the config');
  });

  it('ships with NO declared-public value, because declaring one by its field name is the failure', () => {
    const p = join(ROOT, 'empty.json');
    writeFileSync(p, JSON.stringify({ secrets: { roots: ['.midnight'] } }));
    expect(loadConfig(p).secrets.publicValues).toEqual([]);
  });

  it('refuses a config with no secret roots, because that scanner passes everything', () => {
    const p = join(ROOT, 'bad.json');
    writeFileSync(p, JSON.stringify({ secrets: { roots: [] } }));
    expect(() => loadConfig(p)).toThrow(/secrets.roots is empty/);
  });
});

describe('the file list is the caller’s, and this asks git nothing', () => {
  it('scans exactly what it is handed, and REFUSES over what it could not open', () => {
    write('.midnight/a.seed', randomBytes(32).toString('hex'));
    write('.env', 'A=aaaaaaaaaaaaaaaa\n');
    const result = runSecretScan(ROOT, ['does/not/exist.md'], config() as never);
    expect(result.scan.unreadable.map((u) => u.path)).toEqual(['does/not/exist.md']);
    expect(result.report).toContain('NOT READ AT ALL');
    // AND THE EXIT CODE AGREES WITH THE PAGE. This is the half that was missing:
    // the file was named under a heading that said blind spot, and the run
    // exited clean, so the heading was decoration.
    expect(result.ok).toBe(false);
    expect(result.blindSpots.map((b) => b.path)).toContain('does/not/exist.md');
  });

  it('never shells out — no child process, so it cannot ask git anything', () => {
    const src = readFileSync(new URL('./secret-scan.mjs', import.meta.url), 'utf8');
    expect(/\bexecSync\b|\bspawnSync\b|\bexecFile\b|child_process/.test(src)).toBe(false);
  });

  it('reads no path under a version-control directory', () => {
    const src = readFileSync(new URL('./secret-scan.mjs', import.meta.url), 'utf8');
    expect(/['\"`]\.git\b/.test(src)).toBe(false);
  });
});

describe('the glob matcher, written out because this file is copied into other folders', () => {
  it('matches within a segment, across segments, and a bare directory name', () => {
    expect(globToRegExp('*.md').test('a.md')).toBe(true);
    expect(globToRegExp('*.md').test('d/a.md')).toBe(false);
    expect(globToRegExp('**/*.md').test('d/e/a.md')).toBe(true);
    expect(matchesAny('node_modules/x/y.js', ['node_modules'])).toBe(true);
    expect(matchesAny('src/a.ts', ['node_modules'])).toBe(false);
  });
});

describe('the defects an audit found in the first draft of this file', () => {
  it('applies its own defaults, so a caller with a partial config cannot switch an exemption off', () => {
    const seed = randomBytes(32).toString('hex');
    write('.midnight/a.seed', seed);
    write('src/fixture.ts', `const a = '${seed}'; // not-a-secret\nconst b = '${seed}';\n`);
    // No `marker` anywhere in this config. Before the fix, `scanFiles` read the
    // field raw, the exemption was inert, and the pin passed for the wrong
    // reason — which is the shape of a test that checks nothing.
    const bare = { secrets: { roots: ['.midnight'] }, person: { deriveHomeDirectory: false }, process: {} };
    const result = runSecretScan(ROOT, ['src/fixture.ts'], bare as never);
    expect(result.scan.secretHits[0].lines).toEqual([2]);
  });

  it('SAYS SO when a file is both a secret root and a file it was asked to clear', () => {
    // `.env.example` ships AND is a secret root. Its own values are never
    // searched for inside it, so this scanner cannot clear it — and a page that
    // does not say that reads as a page that checked it.
    write('.env', 'TOKEN=aaaaaaaaaaaaaaaaaaaa\n');
    const result = runSecretScan(ROOT, ['.env'], config() as never);
    expect(result.scan.suppressed.map((x: { path: string }) => x.path)).toEqual(['.env']);
    expect(result.report).toContain('SUPPRESSED');
    expect(result.report).toContain('nothing below has been checked');
  });

  it('names a symbolic link instead of following it into its own parent', () => {
    write('.midnight/real/a.seed', randomBytes(32).toString('hex'));
    symlinkSync(join(ROOT, '.midnight'), join(ROOT, '.midnight', 'latest'));
    const out = extractCandidates(ROOT, config() as never);
    expect(out.skipped.some((x) => x.why.includes('symbolic link'))).toBe(true);
  });

  it('a link whose target IS read under its own name is accounted, and does not refuse', () => {
    /*
     * A dated backup directory beside a `latest` pointing at it. The bytes are
     * read; they are read under the dated name. **Reporting that identically to
     * a link nobody followed would mean the one that costs something reads like
     * the one that costs nothing**, and every run would carry a refusal a
     * reader learns to wave through.
     */
    const seed = randomBytes(32).toString('hex');
    write('.keys-backup/2026-01-01/a.seed', seed);
    write('.env', 'A=aaaaaaaaaaaaaaaa\n');
    symlinkSync(join(ROOT, '.keys-backup', '2026-01-01'), join(ROOT, '.keys-backup', 'latest'));
    const cfg = config({ secrets: { roots: ['.keys-backup', '.env'], minLength: 12 } });
    const result = runSecretScan(ROOT, ['README.md'], cfg as never);
    const link = result.extraction.skipped.find((x) => x.path === '.keys-backup/latest');
    expect(link?.accounted).toBe(true);
    expect(result.blindSpots.map((b) => b.path)).not.toContain('.keys-backup/latest');
  });

  it('accounts for it IDENTICALLY when the repository itself is reached through a link', () => {
    /**
     * ── THE TEST ABOVE PASSED ON SOME MACHINES AND FAILED ON OTHERS, EVERY
     *    TIME, AND THE DEFECT WAS IN THE SHIPPING MODULE ────────────────────
     *
     * `realpathSync` resolved the link and nothing resolved the ROOT, so the
     * two were compared as different kinds of path and no link could ever be
     * accounted for. **On macOS a temporary directory is reached through a
     * symbolic link and on Linux it is not**, so that comparison held in one
     * place and failed in the other - which is the whole of why one assertion
     * disagreed with itself about one unchanged module, without ever being
     * flaky in either place.
     *
     * **AND IT WAS NOT A TEST ARTEFACT.** An unaccounted link is a blind spot,
     * a blind spot makes the verdict refuse, so on such a machine the door
     * refused a tree with nothing wrong with it - the failure that teaches
     * somebody to wave a refusal through.
     *
     * **THIS FIXTURE MAKES THE LINK ITSELF RATHER THAN INHERITING ONE FROM THE
     * PLATFORM**, so it fails in the same place on every machine rather than
     * only on the ones that happen to reach a temporary directory that way.
     */
    const real = join(ROOT, 'real');
    const viaLink = join(ROOT, 'reached-through-a-link');
    const seed = randomBytes(32).toString('hex');
    mkdirSync(join(real, '.keys-backup', '2026-01-01'), { recursive: true });
    writeFileSync(join(real, '.keys-backup', '2026-01-01', 'a.seed'), seed);
    writeFileSync(join(real, '.env'), 'A=aaaaaaaaaaaaaaaa\n');
    writeFileSync(join(real, 'README.md'), 'nothing here\n');
    symlinkSync(join(real, '.keys-backup', '2026-01-01'), join(real, '.keys-backup', 'latest'));
    symlinkSync(real, viaLink);

    const cfg = config({ secrets: { roots: ['.keys-backup', '.env'], minLength: 12 } });
    const result = runSecretScan(viaLink, ['README.md'], cfg as never);

    const link = result.extraction.skipped.find((x) => x.path === '.keys-backup/latest');
    expect(link?.accounted).toBe(true);
    expect(result.blindSpots).toEqual([]);
    expect(result.ok).toBe(true);
    // and the value in the linked-to directory was read, so the accounting is
    // about a directory that really was covered rather than about a comparison
    // that happened to succeed
    expect(result.extraction.candidates.map((c) => c.value)).toContain(seed);
  });

  it('a link whose target is NOT read is a blind spot, and refuses', () => {
    write('.midnight/a.seed', randomBytes(32).toString('hex'));
    write('.env', 'A=aaaaaaaaaaaaaaaa\n');
    const outside = mkdtempSync(join(tmpdir(), 'elsewhere-'));
    mkdirSync(join(outside, 'keys'), { recursive: true });
    symlinkSync(join(outside, 'keys'), join(ROOT, '.midnight', 'elsewhere'));
    const result = runSecretScan(ROOT, ['README.md'], config() as never);
    expect(result.blindSpots.map((b) => b.path)).toContain('.midnight/elsewhere');
    expect(result.ok).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('a secret root the config names and the disk does not have REFUSES, rather than reading as empty', () => {
    /*
     * A folder that moved. The rule that named it stops matching anything and
     * does not say so: the walk finds nothing, extracts nothing, and every
     * later stage reports clean about values it never held. **A guard that
     * stops covering the tree it was written for fails towards silence.**
     */
    write('.env', 'A=aaaaaaaaaaaaaaaa\n');
    const result = runSecretScan(ROOT, ['README.md'], config() as never);
    expect(result.extraction.skipped.some((x) => x.path === '.midnight' && x.why === 'absent')).toBe(true);
    expect(result.blindSpots.map((b) => b.path)).toContain('.midnight');
    expect(result.ok).toBe(false);
  });

  it('takes a value that exists only as a FILE NAME, and then withholds that name from the report', () => {
    /**
     * **THIS IS THE ONLY CASE THAT EXERCISES THE FILE-NAME EXTRACTION ROUTE**,
     * which is why it is kept rather than folded into the renderer cases below.
     * The body here says nothing: no hinted field, no hex run, no single-token
     * file. **The value exists on disk ONLY as the name**, so a scanner that
     * reads contents alone never sees it.
     *
     * It asserted `toContain('elided')` and went stale when the renderer stopped
     * eliding and started numbering. **A test pinned to the wording of a message
     * is pinned to the wrong thing** — so it now asserts the three properties its
     * own title claims, and none of them mentions how the label reads.
     */
    const id = randomBytes(32).toString('hex');
    write(`.midnight/sealed/${id}.json`, '{"note":"a sealed body"}');
    write(`.midnight/sealed/archive/${id}.json`, '{"note":"the same pool, kept"}');
    const target = write('src/uses.ts', `export const POOL = '${id}';\n`);

    const result = runSecretScan(ROOT, [target], config() as never);

    // (0) IT CAME FROM THE NAME. Without this the case could pass on a value the
    //     scanner read out of a body, which is a different route and is covered
    //     elsewhere.
    expect(result.ok).toBe(false);
    expect(result.scan.secretHits[0].from.join(' ')).toContain('(the file name)');

    // (1) THE RAW VALUE IS NOT ON THE PAGE — and not a prefix of it either.
    //     Truncation is not the fix: four leading characters of a 64-hex value
    //     is a filter that turns a guess into a search.
    for (const n of [8, 12, 16, 24, 32, 64]) expect(result.report).not.toContain(id.slice(0, n));
    noStrayHexToken(result.report);

    // (2) THE PLACE IS STILL NAMED. The directory survives whole, the extension
    //     survives whole, and the offending line in the shipping file is given.
    expect(result.report).toContain('src/uses.ts:1');
    expect(result.report).toContain('.midnight/sealed/');
    expect(result.report).toContain('.midnight/sealed/archive/');
    expect(result.report).toContain('.json');

    // (3) THE LABEL IS STABLE. One value is ONE number wherever it appears —
    //     two paths carrying the same pool read as one thing, not two. Asserted
    //     on the label's identity rather than its text, because which noun and
    //     which number it gets depend on the order the paths are rendered in.
    const labels = new Set([...result.report.matchAll(/<[^<>]+ \d+>/g)].map((m) => m[0]));
    expect(labels.size).toBe(1);
    const [label] = [...labels];
    expect(result.report).toContain(`.midnight/sealed/${label}.json`);
    expect(result.report).toContain(`.midnight/sealed/archive/${label}.json`);
  });

  it('takes a dotenv value with a trailing comment, in both forms', () => {
    const pw = `pw_${randomBytes(12).toString('hex')}`;
    write('.env', `API_KEY=${pw} # rotate me\n`);
    const { candidates } = extractCandidates(ROOT, config() as never);
    // The raw right-hand side AND the value with the comment removed. Guessing
    // which one is the secret is the guessing this scanner exists to stop.
    expect(candidates.some((c) => c.value === pw)).toBe(true);
    expect(candidates.some((c) => c.value === `${pw} # rotate me`)).toBe(true);
  });

  it('says when a list of places was cut short, rather than returning a short list', () => {
    const seed = randomBytes(32).toString('hex');
    write('.midnight/a.seed', seed);
    write('src/many.ts', Array.from({ length: 260 }, () => `x = '${seed}';`).join('\n'));
    const result = runSecretScan(ROOT, ['src/many.ts'], config() as never);
    expect(result.scan.secretHits[0].truncated).toBe(true);
    expect(result.report).toContain('THIS LIST IS CUT SHORT');
  });

  it('names, in the report, the transforms it deliberately does not look for', () => {
    write('.midnight/a.seed', randomBytes(32).toString('hex'));
    const result = runSecretScan(ROOT, [write('README.md', 'nothing')], config() as never);
    expect(result.report).toContain('WHAT THIS DOES NOT LOOK FOR');
    expect(result.report).toContain('re-encoded');
    /*
     * TWO MORE THAT THE BLOCK OWES, AND BOTH ARE LIVE IN THIS REPOSITORY.
     *
     * A value printed SHORT: the search is for whole values and the extraction
     * carries a length floor, so a comment illustrating a value by its first
     * and last few characters goes straight past this - and a shipping file
     * here does exactly that.
     *
     * And key material that exists only as RAW BYTES inside a file that is not
     * text: reading such a file for ASCII runs is what changed on 7 Sep, and
     * what it does not reach is bytes that were never characters.
     */
    expect(result.report).toContain('printed short');
    expect(result.report).toContain('raw bytes');
  });
});

describe('when naming the place and disclosing the value are the same act', () => {
  /**
   * **THE CASE THE FIRST REAL RUN FOUND AND THE DESIGN HAD NOT ANTICIPATED.**
   * A sealed pool's file name stem IS the `commitment` inside it, and LevelDB's
   * `CURRENT` holds the name of a file sitting beside it. In both shapes the
   * PATH is the value, so a report that names the file contains the thing the
   * report exists to keep out.
   *
   * **THE FIX IS THE RENDERER AND NOT THE SCAN.** Every case below therefore
   * asserts three things together: the value is still FOUND, the place is still
   * NAMED, and neither the value nor any prefix of it is printed.
   */
  const noPartOf = (text: string, value: string) => {
    expect(text).not.toContain(value);
    /*
     * NOT A PREFIX EITHER — truncation is not the fix. Eight leading characters
     * of a 64-hex commitment is a filter that turns a guess into a search.
     *
     * **IT ASKED FOR FOUR UNTIL 6 Sep, AND FOUR WAS RED ON CORRECT CODE ABOUT
     * ONE RUN IN SIXTEEN THOUSAND.** The values here are `randomBytes`, and
     * ordinary English prose contains hex-valid four-character runs — `defa`
     * inside `default`, `beca` inside `because` — so a value that happened to
     * begin with one made the report *contain a prefix of the value* with the
     * scanner behaving perfectly. **MEASURED: 19 distinct hex-only 4-grams in
     * `scripts/secret-scan.mjs`, and ZERO hex-only 8-grams**; a forced
     * `'defa' + …` commitment turned this file red on an unmodified scanner.
     *
     * **THAT IS THE SAME CLASS AS THE DEFECT THIS FILE WAS JUST REPAIRED FOR
     *, AND RARER IS WORSE, NOT BETTER** — one run in sixteen
     * thousand is a failure nobody will attribute, and it will look like a
     * leak on a green tree. Found by this round's audit.
     *
     * Eight hex characters is thirty-two bits: no word supplies one, and a
     * collision is one run in four thousand million. The property being
     * asserted is unchanged — a prefix is a search filter and must not be
     * printed — only the length at which it stops being an accident.
     */
    for (const n of [8, 12, 16, 24, 32]) expect(text).not.toContain(value.slice(0, n));
    noStrayHexToken(text);
  };

  it('a commitment that is byte-identical to its own file name stem', () => {
    const commitment = randomBytes(32).toString('hex');
    write(`.midnight/sealed/default/${commitment}.k0.json`, JSON.stringify({ commitment, body: 'x'.repeat(40) }));
    const target = write('src/uses.ts', `export const POOL = '${commitment}';\n`);

    const result = runSecretScan(ROOT, [target], config() as never);

    expect(result.ok).toBe(false);                       // still found
    expect(result.report).toContain('src/uses.ts:1');    // the place is still named
    expect(result.report).toContain('.midnight/sealed/default/');
    expect(result.report).toContain('.k0.json');         // the rest of the name survives
    expect(result.report).toContain('<sealed 1>');       // the value became a number
    noPartOf(result.report, commitment);
  });

  it('a LevelDB manifest pointer, where the value is the name of the file beside it', () => {
    // `CURRENT` holds the NAME of the manifest, and the manifest is a real file
    // in the same directory. **It is not text**, so the page names it among the
    // files read for ASCII runs only - which is exactly where the path would
    // have carried the value. The first draft of this test wrote it as short
    // text, so it reached the report nowhere and the assertion passed on an
    // empty search.
    //
    // UNTIL 7 Sep THAT NAMING WAS IN THE BLIND-SPOT BLOCK, because such a file
    // was skipped rather than read. It is read now, it is still named, and the
    // property under test is unchanged: **a path that IS a value is withheld
    // from the page wherever the page prints it.**
    const pointer = 'MANIFEST-000005';
    write('midnight-level-db/CURRENT', `${pointer}\n`);
    write(`midnight-level-db/${pointer}`, '\u0000a binary manifest');
    const target = write('src/uses.ts', `const p = '${pointer}';\n`);

    const cfg = config({ secrets: { roots: ['midnight-level-db'], minLength: 12 } });
    const result = runSecretScan(ROOT, [target], cfg as never);

    expect(result.ok).toBe(false);
    expect(result.report).toContain('src/uses.ts:1');
    expect(result.report).toContain('midnight-level-db/');
    expect(result.report).toContain('<midnight-level-db 1>');
    expect(result.report).toContain('not text');
    noPartOf(result.report, pointer);
  });

  it('gives one value one number wherever it appears, and prints the count', () => {
    const commitment = randomBytes(32).toString('hex');
    write(`.midnight/sealed/default/${commitment}.k0.json`, JSON.stringify({ commitment }));
    write(`.midnight/sealed/default/${commitment}.backup.json`, JSON.stringify({ commitment }));
    const other = randomBytes(32).toString('hex');
    /*
     * **`.k1.json`, AND THE DISTINCT SUFFIX IS THE FIX FOR A TEST THAT FAILED
     * ON ROUGHLY HALF OF ALL RUNS AGAINST AN UNCHANGED TREE.**
     *
     * This third fixture used to end `.k0.json` as well, so TWO paths carried
     * that suffix and `labelOn('.k0.json')` returned whichever of two random
     * 32-byte values the report rendered first — decided by their sort order
     * and by nothing else. **MEASURED before this change: twelve consecutive
     * runs of `npx vitest run scripts/secret-scan.test.ts` with nothing edited
     * between them gave four green and eight red, always this assertion.**
     *
     * **THE INVARIANT BELOW WAS NEVER THE DEFECT. THE LOCATOR WAS**, and a
     * suffix that belongs to exactly one path is what makes `labelOn` a
     * locator rather than a coin toss.
     */
    write(`.midnight/sealed/default/${other}.k1.json`, JSON.stringify({ commitment: other }));

    const result = runSecretScan(ROOT, [write('README.md', 'nothing')], config() as never);

    // THE INVARIANT, NOT THE NUMBER. Which value gets `1` is decided by the
    // order the paths happen to be rendered in; what must hold is that ONE
    // VALUE IS ONE NUMBER wherever it appears, and two values are two numbers.
    const labelOn = (suffix: string): string => {
      /*
       * **IT REFUSES AN AMBIGUOUS SUFFIX RATHER THAN TAKING THE FIRST MATCH,
       * WHICH IS THE HALF THAT STOPS THIS COMING BACK.** Fixing the fixture
       * alone leaves the next person free to add a second path ending the same
       * way, and the failure they would get is `expected '2' to be '1'` — a
       * sentence about the invariant, pointing at code that is correct. Read
       * every match and require exactly one, and the failure names the cause.
       */
      const all = [...result.report.matchAll(new RegExp(`<sealed (\\d+)>\\${suffix}`, 'g'))];
      /*
       * THE MESSAGE BRANCHES, BECAUSE THE TWO FAILURES HAVE NOTHING TO DO WITH
       * EACH OTHER. Zero matches means the report stopped rendering labelled
       * paths at all — a change in the renderer. Two means the fixture has
       * grown a second path with this suffix. One sentence covering both sends
       * whoever reads it to the wrong place, and the whole point of this line
       * is that the failure names the cause. Found by this round's audit.
       */
      expect(
        all.length,
        all.length === 0
          ? `no <sealed N> label on any path ending ${suffix} — the report is not `
            + 'rendering labelled paths, which is the renderer and not the fixture'
          : `${suffix} matches ${all.length} paths in the report — a locator matching two `
            + 'paths answers whichever of them sorted first, which is not a property of '
            + 'the scanner',
      ).toBe(1);
      return all[0][1];
    };
    expect(labelOn('.backup.json')).toBe(labelOn('.k0.json'));   // same value, same number
    // AND THE OTHER DIRECTION, WHICH IS ONLY SAYABLE ONCE EACH SUFFIX HAS ONE
    // PATH: two values are two DIFFERENT numbers, named rather than counted.
    expect(labelOn('.k1.json')).not.toBe(labelOn('.k0.json'));
    const numbers = new Set([...result.report.matchAll(/<sealed (\d+)>/g)].map((m) => m[1]));
    expect(numbers.size).toBe(2);                                // two values, two numbers
    expect(result.report).toContain('2 value(s) withheld from paths on this page.');
    noPartOf(result.report, commitment);
    noPartOf(result.report, other);
  });

  it('withholds a DIRECTORY segment that is a value, not only a file name', () => {
    const id = randomBytes(32).toString('hex');
    write(`.midnight/pools/${id}/body.json`, JSON.stringify({ seedValue: id }));
    const result = runSecretScan(ROOT, [write('README.md', 'nothing')], config() as never);
    expect(result.report).toContain('.midnight/pools/');
    expect(result.report).toContain('/body.json');
    noPartOf(result.report, id);
  });

  it('THE REFUSAL MESSAGE IS THE SAME DISCLOSURE, so it goes through the same renderer', () => {
    const commitment = randomBytes(32).toString('hex');
    const candidates = [{
      value: commitment,
      sources: [{ sourceFile: `.midnight/sealed/default/${commitment}.k0.json`, field: 'commitment' }],
      kinds: ['named-field'],
      declaredPublic: false,
    }];
    let thrown = '';
    try { assertReportCarriesNoValue(`oops ${commitment}`, candidates as never); }
    catch (e) { thrown = String((e as Error).message); }

    expect(thrown).toContain('ABOUT TO WRITE A REPORT CONTAINING A SECRET');
    expect(thrown).toContain('.midnight/sealed/default/');
    expect(thrown).toContain('<sealed 1>');
    noPartOf(thrown, commitment);
  });

  it('leaves a path alone when no segment of it carries a value', () => {
    const safe = makeSafePath([{ value: randomBytes(32).toString('hex'), sources: [], kinds: ['hex'], declaredPublic: false }] as never);
    expect(safe('src/core/ledger.ts')).toBe('src/core/ledger.ts');
    expect(safe.used()).toBe(false);
  });

  it('prints the legend only when something was actually withheld', () => {
    write('.midnight/a.seed', randomBytes(32).toString('hex'));
    const clean = runSecretScan(ROOT, [write('README.md', 'nothing')], config() as never);
    expect(clean.report).not.toContain('withheld from paths');
  });
});
