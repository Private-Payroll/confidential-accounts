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
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractCandidates, scanFiles, renderReport, runSecretScan,
  assertReportCarriesNoValue, globToRegExp, matchesAny, loadConfig, makeSafePath,
} from './secret-scan.mjs';

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
    write('REPORT-DEPLOY.txt', [
      'DEPLOY  —  a machine-written run record',
      `Your wallet seed is: ${seed}`,
      'done',
    ].join('\n'));

    const cfg = config();
    const { candidates } = extractCandidates(ROOT, cfg as never);
    expect(candidates.some((c) => c.value === seed)).toBe(true);

    const scan = scanFiles(ROOT, ['REPORT-DEPLOY.txt'], candidates, cfg as never);
    expect(scan.secretHits).toHaveLength(1);
    expect(scan.secretHits[0].path).toBe('REPORT-DEPLOY.txt');
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
    write('logs/run.txt', `seed=${seed.toUpperCase()}`);
    const cfg = config();
    const { candidates } = extractCandidates(ROOT, cfg as never);
    const scan = scanFiles(ROOT, ['logs/run.txt'], candidates, cfg as never);
    expect(scan.secretHits).toHaveLength(1);
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
    write('.midnight/notes.txt', `we tried this once: ${v} and it worked`);
    const { candidates } = extractCandidates(ROOT, config() as never);
    expect(candidates.some((c) => c.value === v)).toBe(true);
  });

  it('drops values below the floor and COUNTS them, because a floor nobody can see is a hole', () => {
    write('.midnight/tiny.json', JSON.stringify({ apiKey: 'short' }));
    const out = extractCandidates(ROOT, config() as never);
    expect(out.candidates.some((c) => c.value === 'short')).toBe(false);
    expect(out.tooShort).toBeGreaterThan(0);
  });

  it('names what it could not read instead of passing over it', () => {
    mkdirSync(join(ROOT, '.midnight'), { recursive: true });
    writeFileSync(join(ROOT, '.midnight', 'params.bin'), Buffer.from([1, 2, 0, 3, 4]));
    write('.midnight/big.txt', 'x'.repeat(4096));
    const cfg = config({ secrets: { roots: ['.midnight'], minLength: 12, maxFileBytes: 1024 } });
    const out = extractCandidates(ROOT, cfg as never);
    const why = out.skipped.map((s) => `${s.path} ${s.why}`).join(' | ');
    expect(why).toContain('binary');
    expect(why).toContain('text, and larger than');
  });

  it('names a secret root that is not there — an absent root is not an empty one', () => {
    write('.env', 'A=aaaaaaaaaaaaaaaa\n');
    const out = extractCandidates(ROOT, config() as never);
    expect(out.skipped.some((s) => s.path === '.midnight' && s.why === 'absent')).toBe(true);
  });
});

describe('the report names a place and never the thing it is about', () => {
  it('prints the offending file and line, the SOURCE FILE NAME, and no value', () => {
    const seed = randomBytes(32).toString('hex');
    write('.midnight/wallet.seed', seed);
    const target = write('REPORT-RUN.txt', `line one\nseed ${seed}\n`);
    const result = runSecretScan(ROOT, [target], config() as never);
    expect(result.ok).toBe(false);
    expect(result.report).toContain('REPORT-RUN.txt:2');
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
    const target = write('REPORT-X.txt', 'compiled at /Users/somebody/Projects/thing/src\n');
    const cfg = config({ person: { patterns: ['/Users/somebody'], deriveHomeDirectory: false } });
    const result = runSecretScan(ROOT, [target], cfg as never);
    expect(result.ok).toBe(false);
    expect(result.personPlaces).toBe(1);
    expect(result.report).toContain('REPORT-X.txt:1');
  });

  it('REPORTS the process and does NOT refuse, because that sweep is another round', () => {
    write('.midnight/a.seed', randomBytes(32).toString('hex'));
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
  it('scans exactly what it is handed, and names what it could not open', () => {
    write('.midnight/a.seed', randomBytes(32).toString('hex'));
    const result = runSecretScan(ROOT, ['does/not/exist.txt'], config() as never);
    expect(result.scan.unreadable.map((u) => u.path)).toEqual(['does/not/exist.txt']);
    expect(result.report).toContain('NOT SCANNED');
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
    expect(globToRegExp('*.txt').test('a.txt')).toBe(true);
    expect(globToRegExp('*.txt').test('d/a.txt')).toBe(false);
    expect(globToRegExp('**/*.txt').test('d/e/a.txt')).toBe(true);
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
    for (const n of [4, 8, 12, 16, 24, 32, 64]) expect(result.report).not.toContain(id.slice(0, n));

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
    // NOT A PREFIX EITHER — truncation is not the fix. Four leading characters
    // of a 64-hex commitment is a filter that turns a guess into a search.
    for (const n of [4, 8, 12, 16, 24, 32]) expect(text).not.toContain(value.slice(0, n));
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
    // in the same directory. **It is binary**, so the page names it in the
    // blind-spot block — which is exactly where the path would have carried the
    // value. The first draft of this test wrote it as short text, so it reached
    // the report nowhere and the assertion passed on an empty search.
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
    expect(result.report).toContain('binary');
    noPartOf(result.report, pointer);
  });

  it('gives one value one number wherever it appears, and prints the count', () => {
    const commitment = randomBytes(32).toString('hex');
    write(`.midnight/sealed/default/${commitment}.k0.json`, JSON.stringify({ commitment }));
    write(`.midnight/sealed/default/${commitment}.backup.json`, JSON.stringify({ commitment }));
    const other = randomBytes(32).toString('hex');
    write(`.midnight/sealed/default/${other}.k0.json`, JSON.stringify({ commitment: other }));

    const result = runSecretScan(ROOT, [write('README.md', 'nothing')], config() as never);

    // THE INVARIANT, NOT THE NUMBER. Which value gets `1` is decided by the
    // order the paths happen to be rendered in; what must hold is that ONE
    // VALUE IS ONE NUMBER wherever it appears, and two values are two numbers.
    const labelOn = (suffix: string): string => {
      const m = new RegExp(`<sealed (\\d+)>\\${suffix}`).exec(result.report);
      expect(m, `no label found for ${suffix}`).not.toBeNull();
      return m![1];
    };
    expect(labelOn('.backup.json')).toBe(labelOn('.k0.json'));   // same value, same number
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
