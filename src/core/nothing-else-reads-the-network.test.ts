import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { PAIR_NETWORK } from '../midnight/network.js';
import { NETWORK_IDS } from './networks.js';

/**
 * **A GUARD IS CLOSED WHEN THERE IS NO SECOND SOURCE, NOT WHEN THE CALL SITES
 * HAVE BEEN PATCHED.**
 *
 * A test asset is kept off the networks it may not exist on by asking what
 * network this is. Twenty-eight doors used to answer that question for
 * themselves, each reading the environment and defaulting for itself, and they
 * all agreed - so nothing was visibly wrong until the refusal asked one of the
 * other answers.
 *
 * Patching twenty-eight call sites leaves twenty-eight places that have to keep
 * agreeing. **This file is the thing worth more than the edits**: it fails on
 * the DAY a twenty-ninth appears, in the round that writes it, rather than in
 * whatever round afterwards notices two answers disagreeing.
 *
 * ── HOW IT IS KNOWN TO WORK ───────────────────────────────────────────────
 *
 * Every scan below is a pure function over a map of file to source, and each
 * one is driven twice: once over this repository, where the answer must be
 * empty, and once over a made-up file carrying exactly the shape it hunts,
 * where the answer must name it. **A search that matches nothing passes
 * whether or not it works**, and this repository has shipped that twice.
 *
 * Comments are stripped before any scan, because a paragraph explaining that a
 * file does not read the environment contains the name of the thing it does
 * not read.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The one module allowed to ask the environment what network this is. */
const THE_ONE_READER = join('src', 'midnight', 'network.ts');

/** The one file allowed to state where a network is reached. */
const THE_RECORD = join('src', 'core', 'networks.json');

/**
 * The record's own pin, which compares it against values read off a chain. A
 * pin that took its expected value out of the thing under test would pin
 * nothing, so it is allowed to write the urls out.
 */
const THE_PIN = join('src', 'midnight', 'network.test.ts');

/**
 * This file, which carries the shapes it hunts for in its own controls. They
 * have to exist somewhere it can reach or the controls would be describing a
 * matcher rather than exercising one.
 */
const THIS_FILE = join('src', 'core', 'nothing-else-reads-the-network.test.ts');

/**
 * **THE WALLET IS OUT OF THIS FILE'S REACH AND THAT IS SAID RATHER THAN
 * SILENTLY ARRANGED.** It is a second product, built and shipped separately,
 * and it states its own endpoints in its own configuration. Naming the
 * directory here makes the exception a line somebody can argue with rather
 * than a gap in a glob.
 */
const A_SECOND_PRODUCT = `apps${sep}wallet${sep}`;

/**
 * The files that may write a network name where a fallback would sit.
 *
 * **THE ONE ENTRY THAT IS NOT A RESOLVER DECIDES NOTHING.**
 * `packages/identity/src/wallet/address-shape.ts` says `?? 'mainnet'` when it
 * reports which network an address turned out to be FOR: a mainnet address
 * carries no network segment at all, so the absent segment has to be called
 * something when the refusal is written out.
 */
const MAY_NAME_A_NETWORK: ReadonlySet<string> = new Set([
  THE_ONE_READER, THE_PIN, THIS_FILE,
  join('src', 'core', 'networks.ts'),
  join('packages', 'identity', 'src', 'wallet', 'address-shape.ts'),
]);

/* ------------------------------ the scans ------------------------------- */

type Sources = ReadonlyMap<string, string>;

/**
 * A made-up repository, put through the SAME pipeline the real one goes
 * through.
 *
 * **THE CONTROLS USED TO SKIP `codeOf`**, which is how a stripper that blanked
 * every url got past four of them. A control that does not run the code the
 * claim runs is a control for a different claim.
 */
const planting = (files: ReadonlyArray<readonly [string, string]>): Sources =>
  new Map(files.map(([f, c]) => [f, codeOf(c)] as const));

/** Every way the environment can be asked for this variable, not only the common one. */
const WAYS_TO_READ_THE_ENVIRONMENT = [
  /process\s*\.\s*env\s*\.\s*MIDNIGHT_NETWORK_ID/,
  /import\s*\.\s*meta\s*\.\s*env\s*\.\s*MIDNIGHT_NETWORK_ID/,
  /\[\s*['"`]MIDNIGHT_NETWORK_ID['"`]\s*\]/,
  /\benv\s*\.\s*MIDNIGHT_NETWORK_ID/,
];

export const readsTheEnvironment = (sources: Sources): string[] =>
  [...sources].filter(([f, c]) => f !== THE_ONE_READER && f !== THIS_FILE
    && WAYS_TO_READ_THE_ENVIRONMENT.some(w => w.test(c))).map(([f]) => f).sort();

const FALLS_BACK_TO_A_NETWORK = new RegExp(
  `(?:\\?\\?|\\|\\|)\\s*['"\`](?:${NETWORK_IDS.join('|')})['"\`]`);

export const fallsBackToANetwork = (sources: Sources): string[] =>
  [...sources].filter(([f, c]) => !MAY_NAME_A_NETWORK.has(f)
    && FALLS_BACK_TO_A_NETWORK.test(c)).map(([f]) => f).sort();

/**
 * A host that serves one network.
 *
 * `srs.midnight.network` is deliberately not one: it publishes the trusted
 * setup, which is the same material on every network, so a door naming it is
 * not stating where a network is reached.
 */
const A_MIDNIGHT_HOST = /shielded\.tools|(?<!srs)\.midnight\.network/;

export const writesAnEndpoint = (sources: Sources): string[] =>
  [...sources].filter(([f, c]) => f !== THE_PIN && f !== THIS_FILE
    && !f.startsWith(A_SECOND_PRODUCT)
    && A_MIDNIGHT_HOST.test(c)).map(([f]) => f).sort();

/**
 * **AN ENDPOINT THE ENVIRONMENT CAN STILL OVERRIDE, AND THE FILES THAT HAVE
 * ONE.**
 *
 * The hardcoded urls are gone; the MECHANISM that let one answer ahead of the
 * record is not. `process.env.MIDNIGHT_INDEXER_URL || THE.indexer` still puts a
 * variable in front of the one statement, and neither scan above can see it -
 * one looks for a network name, the other for a hostname, and this is neither.
 *
 * These are diagnostic doors, and pointing one at a local indexer is what the
 * variable is for. So the answer is not to forbid it but to make it VISIBLE:
 * the set is written down, and a new one turns this red in the round that adds
 * it rather than being found later by somebody wondering which indexer a
 * measurement was taken against.
 */
const AN_ENDPOINT_OVERRIDE = /process\s*\.\s*env\s*\.\s*MIDNIGHT_(?:NODE|INDEXER)[A-Z_]*URL/;

export const overridesAnEndpoint = (sources: Sources): string[] =>
  [...sources].filter(([f, c]) => f !== THIS_FILE && AN_ENDPOINT_OVERRIDE.test(c))
    .map(([f]) => f).sort();

/* --------------------------- reading the tree --------------------------- */

/**
 * **EVERYWHERE THIS REPOSITORY KEEPS CODE, AND THE LIST IS THE WHOLE OF WHAT
 * THESE SCANS CAN SEE.**
 *
 * It began as the four directories somebody thought of, which left the
 * repository root's own configuration, the browser probe, the database
 * migrations and the workflow definitions outside every claim in this file. A
 * scan's reach is part of its claim, so the reach is written down and the
 * first assertion below measures it.
 */
const SOURCE_DIRS = [
  '.', 'src', 'scripts', 'contracts/src', 'packages/identity/src', '.midnight', 'apps',
  'browser-proving', 'db', '.github',
];
/**
 * `.yml` and `.yaml` are here because the reach above claims the workflow
 * definitions, and without them that claim was green while the files were
 * still outside every scan.
 */
const SOURCE_EXT = /\.(ts|tsx|mjs|cjs|js|jsx|yml|yaml)$/;
const SKIP_DIR = new Set(['node_modules', 'dist', 'lib', 'managed', 'managed-vault', '.vite-cache']);

function walk(dir: string, out: string[], deep = true): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) { if (deep) walk(full, out); }
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

/**
 * Comments out, newlines kept, so a line number still means something.
 *
 * **IT KNOWS WHERE A STRING IS, AND THAT IS THE WHOLE OF WHY THIS FUNCTION IS
 * LONGER THAN ONE LOOP.** The shorter version treated any `//` as the start of
 * a comment, and every url a door could hardcode begins `https://` - so it
 * blanked the rest of the line and the endpoint scan below was satisfied by
 * nothing at all. **A search that matches nothing passes whether or not it
 * works**, and the control that was supposed to catch that fed its planted
 * files straight to the matcher instead of through here.
 *
 * Template literals are treated as ordinary strings: their `${...}` parts can
 * hold code, and blanking a comment inside one is not worth the machinery when
 * the cost of not blanking it is a false find somebody can read.
 */
export function codeOf(src: string): string {
  let out = ''; let i = 0;
  while (i < src.length) {
    const c = src[i]!; const d = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < src.length) {
        const s = src[i]!;
        out += s;
        i++;
        if (s === '\\') { if (i < src.length) { out += src[i]; i++; } continue; }
        if (s === c) break;
        /* An unterminated string ends at the line, as the parser would have it. */
        if (s === '\n' && c !== '`') break;
      }
      continue;
    }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

const THE_REPOSITORY: Sources = new Map((() => {
  const out: string[] = [];
  /* `.` is walked one level deep: the repository root's own configuration, and
   * not every directory under it a second time. */
  for (const d of SOURCE_DIRS) walk(join(ROOT, d), out, d !== '.');
  return [...new Set(out.map(f => relative(ROOT, f)))].sort()
    .map(f => [f, codeOf(readFileSync(join(ROOT, f), 'utf8'))] as const);
})());

const COMMANDS: readonly string[] = readdirSync(ROOT).filter(n => n.endsWith('.command')).sort();

/**
 * **THE DOORS THEMSELVES, WHICH CARRY TYPESCRIPT INSIDE THEM.**
 *
 * Two of them write a TypeScript helper to disk from a heredoc and run it, and
 * one of those read the environment for a network directly. **No search over
 * `.ts` files finds a line that lives inside a `.command`**, which is how it
 * survived a round that was looking for exactly that line. Shell comments are
 * stripped for the same reason source comments are.
 */
const THE_DOORS: Sources = new Map(COMMANDS.map(n =>
  [n, readFileSync(join(ROOT, n), 'utf8').replace(/^\s*#.*$/gm, ' ')] as const));

/* ------------------------------ the claims ------------------------------ */

describe('§1 one reader of the environment, and the scan that notices a second', () => {
  it('reads a repository that is actually there, so the scans below are not vacuous', () => {
    /* RED WHEN the walk stops finding the source. Every claim in this file is
     * a search, and a search over an empty list is satisfied by nothing. */
    expect(THE_REPOSITORY.size).toBeGreaterThan(300);
    expect([...THE_REPOSITORY.keys()]).toContain(THE_ONE_READER);
    /*
     * **THE SHELL SCRIPTS AT THE ROOT ARE NOT PUBLISHED, SO A CLONE HAS NONE**,
     * and this asserted there were more than fifty of them - so it passed here
     * and failed on a fresh checkout, which is the only place the published
     * repository is ever actually tested. A count that can only be met in one
     * working copy is not a claim about this software.
     *
     * The claim is now conditional AND MEASURED IN BOTH DIRECTIONS: where those
     * scripts exist there are many of them and the scans below mean something;
     * where they do not, that absence is asserted rather than passed over in
     * silence, so this can never be satisfied by a walk that found nothing.
     */
    if (COMMANDS.length > 0) expect(COMMANDS.length).toBeGreaterThan(50);
    else expect(COMMANDS).toEqual([]);
    /*
     * RED WHEN the walk stops reaching the places it was widened to. Each of
     * these was outside every claim in this file until it was named.
     */
    const reached = [...THE_REPOSITORY.keys()];
    for (const outpost of ['vitest.config.ts', 'vite.config.ts']) {
      expect(reached, outpost).toContain(outpost);
    }
    expect(reached.some(f => f.startsWith(`browser-proving${sep}`))).toBe(true);
    /* RED WHEN the workflow definitions fall outside again. They were named in
     * the reach and excluded by the extension list, so the assertion that
     * watched the reach was green while the files were unreachable. */
    expect(reached.some(f => f.endsWith('.yml') || f.endsWith('.yaml'))).toBe(true);
  });

  it('NOTHING BUT THE RESOLVER READS `MIDNIGHT_NETWORK_ID`', () => {
    /* RED WHEN a door reads the environment for a network again. That is the
     * defect this round exists to remove. */
    expect(readsTheEnvironment(THE_REPOSITORY)).toEqual([]);
    /* RED WHEN a door reads it inside the TypeScript it writes to disk and
     * runs, which no search over `.ts` files can see. */
    expect(readsTheEnvironment(THE_DOORS)).toEqual([]);
  });

  it('WATCHED FINDING ONE: the same scan over a file that does read it', () => {
    /*
     * The four spellings, each in its own made-up file, because a scan for one
     * of them is a scan somebody walks past by writing another.
     */
    const planted: Sources = planting([
      ['a/door.ts', "const N = process.env.MIDNIGHT_NETWORK_ID ?? 'stagenet';"],
      ['a/page.ts', 'const N = import.meta.env.MIDNIGHT_NETWORK_ID;'],
      ['a/index.ts', "const N = process.env['MIDNIGHT_NETWORK_ID'];"],
      ['a/wiring.ts', 'const N = env.MIDNIGHT_NETWORK_ID;'],
      ['a/innocent.ts', 'const N = theNetwork();'],
    ]);
    expect(readsTheEnvironment(planted))
      .toEqual(['a/door.ts', 'a/index.ts', 'a/page.ts', 'a/wiring.ts']);
  });

  it('and the resolver really does read it, so the first claim is about something', () => {
    /* RED WHEN the resolver stops being the reader - at which point the scan
     * would pass because nothing reads the variable at all. */
    const resolver = THE_REPOSITORY.get(THE_ONE_READER)!;
    expect(resolver).toMatch(/process\s*\.\s*env/);
    expect(resolver).toContain('MIDNIGHT_NETWORK_ID');
  });

  it('NOTHING FALLS BACK TO A NETWORK NAME OF ITS OWN', () => {
    /*
     * **A FALLBACK IS THE DEFECT WEARING A HELPFUL FACE**, and this is the
     * shape it had: `process.env.SOMETHING || 'stagenet'`. It answers exactly
     * when the real answer is missing, which is the one moment a second copy
     * must not be consulted, and it is invisible while the two agree.
     *
     * RED WHEN a file writes `?? '<a network>'` or `|| '<a network>'` again.
     */
    expect(fallsBackToANetwork(THE_REPOSITORY)).toEqual([]);
    /* RED WHEN a door falls back to a network inside the TypeScript it writes
     * to disk and runs, which no search over `.ts` files can see. */
    expect(fallsBackToANetwork(THE_DOORS)).toEqual([]);
  });

  it('WATCHED FINDING TWO: the same scan over a file that does fall back', () => {
    const planted: Sources = planting([
      ['a/door.ts', "const N = process.env.MIDNIGHT_NETWORK_ID || 'stagenet';"],
      ['a/other.ts', 'const N = asked ?? "preview";'],
      /*
       * **AN EXPLICIT ARGUMENT IS NOT A FALLBACK AND IS NOT BANNED.** This
       * repository deliberately makes callers name the network rather than
       * defaulting it, which is the opposite habit and the right one; a scan
       * that could not tell them apart would be a hundred exceptions.
       */
      ['a/innocent.ts', "payeeOf(address, 'stagenet');"],
    ]);
    expect(fallsBackToANetwork(planted)).toEqual(['a/door.ts', 'a/other.ts']);
  });
});

describe('§2 one statement of where a network is reached', () => {
  it('NO SOURCE FILE WRITES A MIDNIGHT ENDPOINT; THE RECORD IS WHERE THEY LIVE', () => {
    /*
     * RED WHEN a url is typed into a door again. Every one that was there was
     * a fallback, so it answered exactly when the real answer was missing.
     */
    expect(writesAnEndpoint(THE_REPOSITORY)).toEqual([]);
    /* RED WHEN a door prints or fetches an endpoint it built itself. One of
     * them built a faucet url out of the network's name, which is the right
     * host for one network and a host that does not exist for the others -
     * printed to somebody about to send money somewhere. */
    expect(writesAnEndpoint(THE_DOORS)).toEqual([]);
  });

  it('THE FILES THAT LET THE ENVIRONMENT ANSWER AHEAD OF THE RECORD ARE WRITTEN DOWN', () => {
    /*
     * RED WHEN a file gains an endpoint override, or loses one, without the
     * list moving. Every one of these is a diagnostic door where pointing at a
     * local indexer is the point; what must not happen is a new one appearing
     * unremarked, because neither scan above can see the shape.
     */
    /*
     * **BOTH DIRECTIONS, AND ONLY ONE OF THEM IS ABOUT THIS REPOSITORY'S
     * CONTENTS.** This was a literal `toEqual` over what the walk found. The
     * walk reads directories, so in any copy that does not carry one of these
     * eight it went red - with a message saying a file had GAINED OR LOST AN
     * ENDPOINT OVERRIDE when nothing of the sort had happened. A reader meeting
     * that in a clone goes looking for a network defect that is not there.
     *
     * The guard is the first direction and it does not weaken: an override this
     * list does not name is what this is watching for, whatever else changed.
     * The second is intersected with what the walk actually found, so a file
     * this copy does not have is simply not asserted about.
     */
    const WRITTEN_DOWN = [
      join('scripts', 'balance-check.ts'),
      join('scripts', 'chain-alive.ts'),
      join('scripts', 'chain-balance.ts'),
      join('scripts', 'fund-fee-payer.ts'),
      join('scripts', 'indexer-check.ts'),
      join('scripts', 'measure-note-index.ts'),
      join('scripts', 'refresh-reference.ts'),
      join('scripts', 'version-check.ts'),
    ];
    const overriding = overridesAnEndpoint(THE_REPOSITORY);
    expect(
      overriding.filter((f) => !WRITTEN_DOWN.includes(f)),
      'a file overrides an endpoint and this list does not name it',
    ).toEqual([]);
    /*
     * **THE SECOND DIRECTION ASKS THE DISK, NOT THE WALK, AND THAT IS THE WHOLE
     * POINT.** Asking `THE_REPOSITORY.keys()` made both directions depend on the
     * same walk: drop `scripts/` from `SOURCE_DIRS` and all eight overrides
     * vanish, the first direction passes over an empty set, the second passes
     * over nothing, and every assertion here goes green while the tripwire reads
     * no part of the tree it was written for. Measured: 730 files walked becomes
     * 582, eight overrides become zero, and nothing turns red.
     *
     * `existsSync` is an oracle this walk cannot switch off.
     */
    const inThisCopy = (f: string): boolean => existsSync(join(ROOT, f));
    expect(
      WRITTEN_DOWN.filter((f) => inThisCopy(f) && !overriding.includes(f)),
      'a file named here is in this copy and no longer overrides an endpoint',
    ).toEqual([]);
    /* AND THE WALK REACHED THEM, WHICH IS A DIFFERENT CLAIM FROM *IT FOUND
     * NOTHING WRONG*. Every file named here that is in this copy must be in the
     * walked set - so a walk narrowed to exclude their tree turns this red
     * rather than quietly reporting a clean scan of less than it was asked for. */
    const here = new Set(THE_REPOSITORY.keys());
    expect(
      WRITTEN_DOWN.filter((f) => inThisCopy(f) && !here.has(f)),
      'a file named here is in this copy and the walk did not reach it',
    ).toEqual([]);
    /* RED WHEN a door puts a variable in front of the record inside its own
     * inline TypeScript, where no `.ts` search reaches. */
    expect(overridesAnEndpoint(THE_DOORS)).toEqual([]);
  });

  it('WATCHED FINDING FIVE: the override scan finds the shape when it is there', () => {
    const planted: Sources = planting([
      ['a/door.ts', 'const I = process.env.MIDNIGHT_INDEXER_URL || THE.indexer;'],
      ['a/other.ts', 'const N = process.env.MIDNIGHT_NODE_URL ?? THE.node;'],
      ['a/ws.ts', 'const W = process.env.MIDNIGHT_INDEXER_WS_URL || THE.indexerWs;'],
      ['a/innocent.ts', 'const I = endpointsOf(theNetwork()).indexer;'],
    ]);
    expect(overridesAnEndpoint(planted)).toEqual(['a/door.ts', 'a/other.ts', 'a/ws.ts']);
  });

  it('AND THE COMMENT STRIPPER DOES NOT EAT THE URLS IT IS MEANT TO LEAVE', () => {
    /*
     * **THE DEFECT THIS PAIR OF ASSERTIONS EXISTS FOR.** A stripper that
     * treats any `//` as a comment blanks the rest of every line carrying an
     * `https://` url - so the scan above ran over source with no urls in it
     * and was satisfied by nothing.
     *
     * RED WHEN a url stops surviving the strip, which makes every endpoint
     * claim in this file vacuous rather than false.
     */
    const line = "const I = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';";
    expect(codeOf(line)).toContain('shielded.tools');
    expect(codeOf(`${line} // a comment naming indexer.preview.midnight.network`))
      .not.toContain('midnight.network');
    /* RED WHEN a comment stops being stripped, which is the other half: a
     * paragraph explaining that a file reads no environment contains the name
     * of the thing it does not read. */
    expect(codeOf('/* process.env.MIDNIGHT_NETWORK_ID */ const a = 1;'))
      .not.toContain('MIDNIGHT_NETWORK_ID');
    /* A quote inside a comment does not open a string, and a comment marker
     * inside a string does not open a comment. */
    expect(codeOf("// it's fine\nconst u = 'https://rpc.stagenet.shielded.tools';"))
      .toContain('rpc.stagenet.shielded.tools');
  });

  it('WATCHED FINDING THREE: the same scan over a file that does write one', () => {
    const planted: Sources = planting([
      ['a/check.ts', "const I = process.env.X || 'https://indexer.stagenet.shielded.tools/api/v4/graphql';"],
      ['a/probe.ts', "fetch('https://rpc.preview.midnight.network');"],
      ['a/innocent.ts', 'const I = endpointsOf(theNetwork()).indexer;'],
    ]);
    expect(writesAnEndpoint(planted)).toEqual(['a/check.ts', 'a/probe.ts']);
  });

  it('the record carries them, so the scan is not passing over an empty subject', () => {
    /* RED WHEN the record stops being where the endpoints are. */
    const record = readFileSync(join(ROOT, THE_RECORD), 'utf8');
    expect(record).toMatch(/shielded\.tools/);
    expect(record).toMatch(/\.midnight\.network/);
  });
});

describe('§3 the shell hands the value over and no longer decides it', () => {
  /**
   * **A DOOR'S `${MIDNIGHT_NETWORK_ID:-stagenet}` IS NOT A SECOND ANSWER, BUT
   * IT IS A SECOND PLACE THE NAME IS WRITTEN.**
   *
   * It cannot make this application disagree with itself: whatever the shell
   * hands over is either the network this build is compiled for or a refusal.
   * What it can do is go stale. The day the pair moves, every one of these
   * would hand over the old name and every door would refuse - correctly, and
   * in thirty-five separate places, at the moment somebody is trying to run
   * one.
   *
   * So the defaults are pinned here instead, where moving the pair turns one
   * thing red and names the files.
   */
  const defaultsIn = (text: string): string[] =>
    [...text.matchAll(/MIDNIGHT_NETWORK_ID:-([A-Za-z0-9_-]*)\}/g)].map(m => m[1]!);

  it('EVERY DOOR THAT DEFAULTS THE NAME DEFAULTS IT TO THE ONE THIS BUILD IS ON', () => {
    const wrong = COMMANDS.flatMap(name => defaultsIn(readFileSync(join(ROOT, name), 'utf8'))
      .filter(v => v !== PAIR_NETWORK).map(v => `${name}: ${v}`));
    /* RED WHEN the pair moves and the shell defaults do not, or when a door is
     * added that defaults to a network of its own choosing. */
    expect(wrong).toEqual([]);
  });

  it('WATCHED FINDING FOUR: the reader finds a default that disagrees', () => {
    expect(defaultsIn('export MIDNIGHT_NETWORK_ID="${MIDNIGHT_NETWORK_ID:-preview}"')).toEqual(['preview']);
    expect(defaultsIn('NETWORK="${MIDNIGHT_NETWORK_ID:-stagenet}"')).toEqual(['stagenet']);
    expect(defaultsIn('export MIDNIGHT_NETWORK_ID="$NETWORK"')).toEqual([]);
  });

  it('and there are defaults to check, so the pin is about something', () => {
    const withDefaults = COMMANDS.filter(n => defaultsIn(readFileSync(join(ROOT, n), 'utf8')).length > 0);
    /* RED WHEN those scripts stop passing the value, which would make the pin
     * above vacuous rather than satisfied - and skipped, stated, where they are
     * not published at all. The pin itself still runs over whatever is there. */
    if (COMMANDS.length === 0) expect(withDefaults).toEqual([]);
    else expect(withDefaults.length).toBeGreaterThan(20);
  });
});
