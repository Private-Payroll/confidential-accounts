import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SEED_ASSETS } from '../../../src/core/assets.js';
import {
  amountsMadeOutsideTheAdapters, amountsOutsideTheComponent, arbitraryValues, codesUnder, colourValues, declaredBy, namedOutside, stylesReachingIntoComponents, englishSentences, filesUnder, gapsThatDiffer, hasPhrase,
  inlineStyles, isShippingCode, keysAskedFor, missingPhrases, paletteClasses, pathsIntoTheKit, physicalClasses, SCREEN_FORMATTERS,
  secondCn, THE_WAY_THROUGH, undeclaredImports, waysIntoSharedCode, wordingCensus, wordingInCode, type Source,
} from 'vaults-ui/rules/source-rules.test-support';
import { WORKERS } from '../vite.config.js';

/*
 * THE APPLICATION HELD TO THE KIT'S RULES, AND ITS LANGUAGE FILES TO EACH
 * OTHER. Each rule's function is shown finding what it is for in the kit's
 * `rules/source-rules.test.ts`; here it runs over the application as it is.
 *
 * WHAT IS READ: every file of the application's own source, and every module
 * the page reaches, found by walking the page the way the bundler does
 * (`scripts/browser-graph.ts`). The wording, amount, colour and left-or-right
 * rules refuse by default, and read the application's own files, its page and
 * stylesheet, and the kit's files the page reaches. The shared browser code the
 * page reaches is not written for this application alone: it is held to no
 * call of a number formatter (`formatTokenAmount`, `NumberFormat`,
 * `toLocaleString`, `toFixed`, ...), its other conversions are not read, and it
 * is held to no English sentence where the page reaches it other than through
 * an adapter.
 *
 * THE ADAPTERS, `apps/web/src/adapters/`, are the only files that reach the
 * shared browser code, the product's own code, the service or the wallet.
 * They are the application's own files, so every rule above reads them too,
 * and a test below walks what they reach from a page of their own, so what
 * they reach is read whether or not a screen imports them yet. Each adapter's
 * own test shows it hands a screen no words.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string): Source => ({ path: p, text: readFileSync(ROOT + p, 'utf8') });
const OWN = filesUnder(ROOT, 'apps/web/src', isShippingCode).map(read);
const CONFIG = read('apps/web/vite.config.ts');
const STYLE = filesUnder(ROOT, 'apps/web', (p) => /\.(css|html)$/.test(p) && !p.includes('/dist/')).map(read);
const CODES = new Set(SEED_ASSETS.map((a) => a.code));
const LOCALES = 'apps/web/src/locales';
const languageFiles = () => readdirSync(ROOT + LOCALES).filter((n) => n.endsWith('.json')).sort();
const messagesOf = (name: string) => JSON.parse(readFileSync(`${ROOT}${LOCALES}/${name}`, 'utf8')) as Record<string, string>;

/*
 * The walk is loaded by its address rather than imported by name, so that it
 * is typechecked where it lives, under the scripts' settings, and not a second
 * time under this application's stricter ones. What is used of it is typed here.
 */
interface BuildGraph { entries: string[]; files: string[]; staticNode: unknown[]; dynamicNode: unknown[]; unresolved: { file: string; specifier: string }[] }
interface Walker {
  BROWSER_BUILDS: { name: string }[];
  walkBuild: (build: unknown, root: string) => Promise<BuildGraph>;
  importsOf: (file: string, source: string) => Promise<{ specifier: string }[]>;
}
const ADAPTERS = 'apps/web/src/adapters';
/**
 * PACKAGES OF THE MIDNIGHT SDK THE ADAPTERS MAY REACH, because they are plain
 * JavaScript and load no WebAssembly, each with why it is reached. The test
 * below holds each to that.
 */
const PLAIN_SDK: Readonly<Record<string, string>> = {
  '@midnightntwrk/wallet-sdk-hd': 'the shared keyring reaches the account\'s key derivation through midnight-identity, as the legacy page does; it is @scure/bip32 and @scure/bip39, with no WebAssembly',
};
const WALKER = new URL('../../../scripts/browser-graph.ts', import.meta.url).href;

/**
 * THE WORKERS THE APPLICATION STARTS, by their entry's path from the
 * repository root: the build's own list (`vite.config.ts`). The walk starts
 * from each as it does from the page. What a worker reaches runs in the
 * worker, never on the page, so the rules about what the page may load or
 * show read the page's side alone.
 */
const WORKER_ENTRIES = Object.keys(WORKERS).map((p) => relative(ROOT, join(ROOT, 'apps/web', p)));
/**
 * THE PAGE'S SIDE ALONE: the walk with each worker's entry, as the file that
 * starts it names it, stood in for by a module the walk reads anyway and that
 * imports nothing (`adapters/reads.ts`), so the walk stops where the worker
 * begins. Each worker is named by the file that starts it and the address it
 * starts it by.
 */
const STARTED_BY: Readonly<Record<string, { file: string; as: string }>> = {
  'packages/web-shared/src/vault-worker-entry.ts': { file: 'packages/web-shared/src/vault-worker-client.ts', as: './vault-worker-entry.js' },
  'packages/web-shared/src/vault-proof-worker-entry.ts': { file: 'packages/web-shared/src/vault-proof-workers.ts', as: './vault-proof-worker-entry.js' },
};
const STAND_IN = 'apps/web/src/adapters/reads.ts';
const pageSideOf = <B extends { alias: unknown[] }>(build: B): B =>
  ({ ...build, alias: [...build.alias, ...Object.values(STARTED_BY).map((w) => ({ find: w.as, replacement: STAND_IN }))] });

let graph: BuildGraph;
let pageGraph: BuildGraph;
let reached: Source[];
/** The shared browser code the page itself reaches, the workers' code left out. */
let sharedOnThePage: Source[];
beforeAll(async () => {
  const { BROWSER_BUILDS, walkBuild } = (await import(WALKER)) as Walker;
  const web = BROWSER_BUILDS.find((b) => b.name === 'web');
  if (web === undefined) throw new Error('scripts/browser-graph.ts lists no build named web');
  graph = await walkBuild(web, ROOT);
  pageGraph = await walkBuild(pageSideOf(web as unknown as { alias: unknown[] }) as unknown as typeof web, ROOT);
  reached = graph.files.filter(isShippingCode).map(read);
  sharedOnThePage = pageGraph.files.filter((p) => p.startsWith('packages/web-shared/') && isShippingCode(p)).map(read);
});
/**
 * What the adapters reach, walked from a page of their own that loads every
 * adapter and nothing else. Walked once and kept.
 */
const adapterGraphs = new Map<string, Promise<BuildGraph>>();
/** What the adapters reach, workers and all, or (`pageSide`) on the page's side alone. */
function adaptersWalk(pageSide = false): Promise<BuildGraph> {
  const key = String(pageSide);
  if (!adapterGraphs.has(key)) {
    adapterGraphs.set(key, (async () => {
      const { BROWSER_BUILDS, walkBuild } = (await import(WALKER)) as Walker;
      const found = BROWSER_BUILDS.find((b) => b.name === 'web')!;
      const web = pageSide ? pageSideOf(found as unknown as { alias: unknown[] }) as unknown as typeof found : found;
      const adapters = OWN.map((f) => f.path).filter((p) => p.startsWith(`${ADAPTERS}/`));
      const dir = mkdtempSync(join(tmpdir(), 'adapters-'));
      try {
        const page = join(dir, 'index.html');
        writeFileSync(page, adapters.map((p) => `<script type="module" src="${relative(dirname(page), ROOT + p)}"></script>`).join('\n'));
        return await walkBuild({ ...web, name: 'adapters', pages: [relative(ROOT, page)] }, ROOT);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })());
  }
  return adapterGraphs.get(key)!;
}

/**
 * SHARED MODULES THE PAGE REACHES THAT WRITE A FIGURE INTO A SENTENCE ONLY THE
 * LEGACY PAGE SHOWS, each with the one formatter it calls and why none of it
 * reaches a screen here. The adapter that reaches it hands a screen a code
 * for every answer, never a sentence, and its own test shows that.
 */
const SENTENCES_FOR_THE_LEGACY_PAGE: Readonly<Record<string, { writes: string; times: number; why: string }>> = {
  'packages/web-shared/src/vault-operation.ts': {
    writes: 'toLocaleString',
    times: 4,
    why: 'the time a deposit or a payment still on its way can no longer land, written into the sentences of two errors and of a check\'s summary; creating a vault (adapters/create-vault.ts) reaches the module and hands a screen a code for each answer',
  },
};

/** The application's code and the kit's code its page reaches, each once. */
const ownAndKit = () => [...new Map([...OWN, ...reached.filter((f) => f.path.startsWith('packages/ui/'))].map((f) => [f.path, f])).values()];

describe('the application is read', () => {
  /* RED WHEN: the walk or the file list reads nothing, or stops at an import it cannot follow, so a rule passes over less than the page. */
  it('reads its own code and the whole of what its page reaches', async () => {
    expect(OWN.map((f) => f.path)).toContain('apps/web/src/main.ts');
    expect(graph.entries).toEqual(['apps/web/src/main.ts', ...WORKER_ENTRIES]);
    expect(graph.unresolved).toEqual([]);
    /* RED WHEN: a worker the build starts is not named where the page's side is walked apart from it, or the page's side still reaches a worker's own code. */
    expect(Object.keys(STARTED_BY).sort()).toEqual([...WORKER_ENTRIES].sort());
    for (const [entry, w] of Object.entries(STARTED_BY)) {
      expect(readFileSync(ROOT + w.file, 'utf8'), entry).toContain(`new Worker(new URL('${w.as}', import.meta.url)`);
      expect(pageGraph.files, entry).not.toContain(entry);
    }
    /*
     * RED WHEN: a file on the page's side names a worker's entry other than to
     * start it, which the stand-in would hide: every import of that address,
     * static or waiting, is refused, and only the start of the worker is let
     * through.
     */
    const { importsOf } = (await import(WALKER)) as Walker;
    const named: string[] = [];
    for (const f of pageGraph.files) {
      for (const e of (await importsOf(ROOT + f, readFileSync(ROOT + f, 'utf8'))) as { specifier: string; worker?: boolean }[]) {
        if (Object.values(STARTED_BY).some((w) => w.as === e.specifier) && e.worker !== true) named.push(`${f} ${e.specifier}`);
      }
    }
    expect(named).toEqual([]);
    expect(pageGraph.entries).toEqual(['apps/web/src/main.ts', STAND_IN]);
    expect(pageGraph.files).toContain('packages/web-shared/src/vault-worker-client.ts');
    expect(STYLE.map((f) => f.path)).toContain('apps/web/index.html');
    /* RED WHEN: the page reaches a file of the application or the kit the rules do not read (a `.jsx`, a `.mjs`). */
    expect(graph.files.filter((p) => /^(apps\/web|packages\/ui)\//.test(p) && !isShippingCode(p))).toEqual([]);
  });

  /* RED WHEN: the refusing rules read nothing of the application, so they pass over it because they saw nothing to refuse. */
  it('reads every string the refusing rules look at, the application\'s own among them', () => {
    const census = wordingCensus(ownAndKit(), CODES);
    expect(census.read).toBeGreaterThan(150);
    const own = wordingCensus(OWN, CODES);
    expect(own.byPosition).toEqual(expect.objectContaining({ module: expect.any(Number), 'translation key': expect.any(Number), 'element id': 1 }));
    expect(ownAndKit().map((f) => f.path)).toEqual(expect.arrayContaining(['apps/web/src/main.ts', 'packages/ui/src/components/amount.tsx']));
  });
});

describe('every rule, over the application', () => {
  /* RED WHEN: an application file imports a package its package.json does not declare. */
  it('declares every package it imports', async () => {
    const pkg = readFileSync(ROOT + 'apps/web/package.json', 'utf8');
    expect(await undeclaredImports(OWN, declaredBy(pkg))).toEqual([]);
    const withDev = new Set([...declaredBy(pkg), ...Object.keys((JSON.parse(pkg) as { devDependencies?: object }).devDependencies ?? {})]);
    expect((await undeclaredImports([CONFIG], withDev)).filter((b) => !b.what.startsWith('node:'))).toEqual([]);
  });

  /* RED WHEN: a file outside the adapters imports the shared browser package, reaches the product's code by a path, calls the network or talks to the wallet. */
  it('reaches shared code, the service and the wallet only through its adapters', async () => {
    const adapters = OWN.filter((f) => f.path.startsWith(`${ADAPTERS}/`));
    expect(adapters.map((f) => f.path)).toContain(`${ADAPTERS}/vault-public-money.ts`);
    expect(await waysIntoSharedCode(OWN, ROOT, 'apps/web/src', ADAPTERS), THE_WAY_THROUGH).toEqual([]);
    /* Read as if they were screens, the adapters' own ways in are named, so the rule is reading them and not passing over them. */
    expect((await waysIntoSharedCode(adapters, ROOT, 'apps/web/src', null)).map((b) => b.what)).toEqual(expect.arrayContaining(['imports vaults-web-shared/device-vault-holdings.js']));
  });

  /* RED WHEN: a file outside the adapters makes an amount, so its decimals would be typed instead of read from the token's record. */
  it('makes amounts only in its adapters', () => {
    expect(amountsMadeOutsideTheAdapters(OWN, ROOT, ADAPTERS)).toEqual([]);
    expect(amountsMadeOutsideTheAdapters(OWN, ROOT, null).map((b) => b.path)).toContain(`${ADAPTERS}/vault-public-money.ts`);
  });

  /*
   * RED WHEN: an adapter reaches a Node built-in, a module the walk cannot
   * follow, or a package of the Midnight SDK, whose WebAssembly must not load
   * in the page; or the walk stops reaching the shared reader and so passes for
   * reading nothing. The adapters are walked from a page of their own, because
   * no page the application serves reaches them until a screen imports one.
   */
  it('has adapters that reach nothing a page cannot load', async () => {
    const { importsOf } = (await import(WALKER)) as Walker;
    const adapters = OWN.map((f) => f.path).filter((p) => p.startsWith(`${ADAPTERS}/`));
    /* Walked whole, the adapters start the workers the build names and no others. */
    expect((await adaptersWalk()).entries).toEqual([...adapters, ...WORKER_ENTRIES]);
    const g = await adaptersWalk(true);
    expect(g.entries).toEqual(adapters);
    expect([g.staticNode, g.dynamicNode, g.unresolved]).toEqual([[], [], []]);
    expect(g.files).toEqual(expect.arrayContaining(['packages/web-shared/src/device-vault-holdings.ts', 'packages/web-shared/src/wallet-sign-in.ts', 'src/core/assets.ts']));
    const packages = new Set<string>();
    for (const f of g.files) for (const e of await importsOf(f, readFileSync(ROOT + f, 'utf8'))) if (!/^[./]/.test(e.specifier)) packages.add(e.specifier);
    expect([...packages].filter((p) => /^@midnight(ntwrk|-ntwrk)\//.test(p) && !(p in PLAIN_SDK))).toEqual([]);
  });

  /*
   * RED WHEN: a package let through as plain JavaScript ships WebAssembly,
   * depends on another package of the SDK, or is let through without a reason;
   * or one is listed that the adapters no longer reach.
   */
  it('lets through only packages of the SDK that load no WebAssembly, each with why', async () => {
    const { importsOf } = (await import(WALKER)) as Walker;
    const g = await adaptersWalk(true);
    const packages = new Set<string>();
    for (const f of g.files) for (const e of await importsOf(f, readFileSync(ROOT + f, 'utf8'))) if (!/^[./]/.test(e.specifier)) packages.add(e.specifier);
    for (const [name, why] of Object.entries(PLAIN_SDK)) {
      expect(packages, name).toContain(name);
      expect(why.length, name).toBeGreaterThan(20);
      const dir = realpathSync(ROOT + 'node_modules/' + name);
      expect(filesUnder(dir, '.', (p) => p.endsWith('.wasm')), name).toEqual([]);
      /* Nor WebAssembly carried inside its JavaScript. */
      const scripts = filesUnder(dir, '.', (p) => /\.(c|m)?js$/.test(p) && !p.includes('node_modules'));
      expect(scripts.length, name).toBeGreaterThan(0);
      expect(scripts.filter((p) => /\bWebAssembly\./.test(readFileSync(join(dir, p), 'utf8'))), name).toEqual([]);
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
      expect(Object.keys(pkg.dependencies ?? {}).filter((d) => /^@midnight(ntwrk|-ntwrk)\//.test(d)), name).toEqual([]);
    }
  });

  /* RED WHEN: the application reaches into the kit's folder by a path instead of by the kit's name, for a value or only for a type. */
  it('reaches the kit only as vaults-ui', async () => {
    expect(await pathsIntoTheKit([...OWN, CONFIG], ROOT, 'packages/ui')).toEqual([]);
  });

  /* RED WHEN: the application declares a cn, or imports the cn package or what cn is made of. */
  it('has no cn of its own', async () => {
    expect(await secondCn(OWN, 'packages/ui/src/lib/utils.ts')).toEqual([]);
  });

  /* RED WHEN: a colour value, a palette colour or an arbitrary value that is not a token is written in any string of the application, its stylesheet or its page, or a colour is set inline. */
  it('has no colour outside the theme', () => {
    expect(colourValues([...OWN, ...STYLE])).toEqual([]);
    expect(paletteClasses([...OWN, ...STYLE])).toEqual([]);
    expect(arbitraryValues([...OWN, ...STYLE])).toEqual([]);
    expect(inlineStyles([...OWN, ...STYLE])).toEqual([]);
  });

  /*
   * RED WHEN: the application names a part of a kit component, or writes a
   * class that reaches inside an element it did not write, in its code, its
   * stylesheet or its page: the Public pill is such a part, and a class that
   * reached it could hide it.
   */
  it('styles only the elements it writes', () => {
    expect(stylesReachingIntoComponents([...OWN, ...STYLE])).toEqual([]);
    expect(namedOutside(OWN, 'AmountFigure', [])).toEqual([]);
    /* The figure alone, with no Public pill, only where a column of the same row says whether it is public. */
    expect(namedOutside(OWN, 'AmountFigureOnly', ['apps/web/src/screens/vault.tsx'])).toEqual([]);
  });

  /* RED WHEN: the application, its stylesheet or its page spaces, aligns or places by left and right. */
  it('has no left or right', () => {
    expect(physicalClasses([...OWN, ...STYLE])).toEqual([]);
  });

  /* RED WHEN: a string with a letter stands, in the application, its page, its stylesheet or the kit its page reaches, anywhere not named as a position; the page's title included. */
  it('shows no wording that is not in a language file', () => {
    expect(wordingInCode([...ownAndKit(), ...STYLE], CODES)).toEqual([]);
  });

  /*
   * RED WHEN: a module of the shared browser code the page reaches other than
   * through an adapter carries an English sentence a screen could show.
   *
   * Shared code reached through an adapter is not read for sentences: the
   * legacy application shows its words, so it keeps them, and each adapter's
   * own test shows that none of them is handed to a screen. What is read is
   * the shared code the page reaches that the adapters do not, which the
   * rule above, that only the adapters reach shared code, keeps empty; so a
   * shared module reached any other way is read, and its sentences refused.
   */
  it('reaches no English sentence in the shared browser code outside the adapters', async () => {
    const throughAdapters = new Set((await adaptersWalk()).files);
    const shared = reached.filter((f) => f.path.startsWith('packages/web-shared/'));
    /* The page does reach shared code with sentences in it, all of it through the adapters: the rule is not passing for want of reading any. */
    expect(englishSentences(shared).length).toBeGreaterThan(0);
    /* The rule: no shared module the page reaches is reached other than through an adapter, so there is no shared code outside them to hold a sentence. */
    expect(shared.filter((f) => !throughAdapters.has(f.path)).map((f) => f.path)).toEqual([]);
  });

  /*
   * RED WHEN: the application turns any value into text or a number, or shared
   * browser code its page reaches puts a figure on a screen, anywhere but the
   * kit's amount component; or a shared module named below as writing only
   * sentences the legacy page shows writes a figure some other way, or no
   * longer writes one and is still named.
   */
  it('shows an amount only through the amount component', () => {
    expect(amountsOutsideTheComponent(ownAndKit(), undefined, ADAPTERS)).toEqual([]);
    const found = amountsOutsideTheComponent(sharedOnThePage).filter((b) => SCREEN_FORMATTERS.has(b.what));
    expect(found.filter((b) => !(b.path in SENTENCES_FOR_THE_LEGACY_PAGE))).toEqual([]);
    for (const [path, what] of Object.entries(SENTENCES_FOR_THE_LEGACY_PAGE)) {
      /* Each let through is a time, written by the date's own formatter on a line that makes the date, and there are exactly as many as named: a number formatted there is refused. */
      const lines = readFileSync(ROOT + path, 'utf8').split('\n');
      const here = found.filter((b) => b.path === path);
      expect(here.map((b) => b.what), path).toEqual(Array(what.times).fill(what.writes));
      for (const b of here) expect(lines[b.line - 1], `${path}:${b.line}`).toMatch(/new Date\([^()]*\)\.toLocaleString\(\)/);
      expect(what.why.length, path).toBeGreaterThan(40);
    }
  });

  /* RED WHEN: an entry of CODES for the application names a declaration it does not have, so it lets through whatever is written under that name later. */
  it('names, in CODES, only declarations the application has', () => {
    expect(wordingCensus(OWN, CODES).codes.filter((c) => c.startsWith('apps/web/'))).toEqual(codesUnder('apps/web'));
    expect(codesUnder('apps/web').length).toBeGreaterThan(0);
  });

  /* RED WHEN: the application asks for a key the English file lacks, or builds a key at run time. */
  it('asks only for keys the English file has', () => {
    const english = messagesOf('en.json');
    const asked = OWN.flatMap((f) => keysAskedFor(f).map((k) => ({ path: f.path, ...k })));
    expect(asked.filter((k) => k.key === null || !hasPhrase(english, k.key))).toEqual([]);
  });
});

describe('the language files', () => {
  /* RED WHEN: the English file is gone or renamed, so every language would be compared with nothing. */
  it('has the English file', () => {
    expect(languageFiles()).toContain('en.json');
    expect(Object.keys(messagesOf('en.json')).length).toBeGreaterThan(0);
  });

  /* RED WHEN: a language file lacks a phrase or a plural form its language needs, or has one English does not. */
  it('gives every language every phrase', () => {
    const english = messagesOf('en.json');
    expect(languageFiles().flatMap((n) => missingPhrases(english, n.replace(/\.json$/, ''), messagesOf(n)))).toEqual([]);
  });

  /* RED WHEN: a phrase has other gaps in a language than in English. */
  it('gives every phrase the same gaps in every language', () => {
    const english = messagesOf('en.json');
    expect(languageFiles().flatMap((n) => gapsThatDiffer(english, n.replace(/\.json$/, ''), messagesOf(n)))).toEqual([]);
  });

  /* RED WHEN: a phrase is empty, or a value is not text. */
  it('has text for every phrase', () => {
    for (const n of languageFiles()) for (const [k, v] of Object.entries(messagesOf(n))) expect(typeof v === 'string' && v.trim().length > 0, `${n} ${k}`).toBe(true);
  });
});
