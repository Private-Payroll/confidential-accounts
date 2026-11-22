/**
 * **THE COMPANY'S RECORDS ARE READ ONE WAY: THROUGH ITS SOURCE AND ITS VIEW.** Every source file of the page, the
 * wallet and their shared packages is read, comments left out, for a second way to the service or the chain: the
 * transport or a path builder imported outside the records' own files, a request sent by hand, a service path written
 * out, or the chain read around the view's doors. It also holds the inventory of every place a company is read from
 * to what is here: every action the wallet registers and every screen, action panel, shell part and setup step of the
 * page is on it, and nothing on it is gone.
 *
 * While `CENSUS` is true this runs as a census: it lists every file with a second way, and what the way is, and passes.
 * With it false, any second way fails the suite, but one another change owns and finishes, named below with its owner
 * and why (`OWNED_ELSEWHERE`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { describe, expect, it } from 'vitest';
import { COMPANY_VIEW_INVENTORY, type Place, type PlaceKind } from './company-view-inventory.js';

/** While true, the check lists what it finds and passes. */
const CENSUS = false;

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/* The page, the wallet and their packages, and the repository's own `src/core` and `src/midnight` that the device imports. */
const SCANNED = ['apps/web/src', 'apps/wallet/src', 'packages/web-shared/src', 'packages/identity/src', 'src/core', 'src/midnight'];

/** The records' own files: the only files that may name the service's paths or hold its transport. */
const FOUNDATION = new Set([
  'packages/web-shared/src/records-source.ts', 'packages/web-shared/src/service-transport.ts', 'packages/web-shared/src/company-view.ts',
  'packages/web-shared/src/company-view-batch.ts', 'packages/web-shared/src/company-view-probe.ts', 'packages/web-shared/src/company-view-doors.ts',
  'packages/web-shared/src/company-view-on-page.ts', 'packages/web-shared/src/asks-on-page.ts',
  'packages/web-shared/src/person-asks.ts', 'packages/web-shared/src/person-on-page.ts',
  /* The wire's own definitions of the records' paths, which every device and the service name them by. */
  'src/midnight/record-manifest.ts', 'src/midnight/sealed-record-wire.ts',
]);

/**
 * The intent route lists, and the channel that checks a call the wallet hands the page is one of the service's routes:
 * route patterns only, importing nothing that sends.
 */
const ROUTE_LISTS = new Set([
  'packages/identity/src/profile/act-intent-calls.ts', 'packages/identity/src/profile/act-intents.ts', 'packages/identity/src/profile/act-channel.ts',
]);

/** Files that send a request themselves: the service transport, and files whose requests are not the company's service. */
const SENDS_ITSELF = new Set(['packages/web-shared/src/service-transport.ts']);

/**
 * Files that send, and may name a path, because what they ask is not the company's records, each with what it asks:
 * the chain's indexer behind the view's doors, the proving keys and parameters, the payee's own payslips, the
 * development console's error report, the chain indexer's own clients, and words that name a route and send nothing.
 */
const NOT_THE_COMPANYS_SERVICE: Readonly<Record<string, string>> = Object.freeze({
  'apps/wallet/src/chain/company-label-on-chain.ts': 'the chain indexer, read as the view\'s door',
  'packages/web-shared/src/vault-on-chain-here.ts': 'the chain indexer, read as the view\'s door',
  'packages/web-shared/src/key-material.ts': 'the proving keys',
  'apps/wallet/src/chain/key-material.ts': 'the proving keys',
  'apps/wallet/src/chain/vault-builder.ts': 'the account\'s proving keys, checked by digest',
  'packages/web-shared/src/vault-worker-deps.ts': 'the proving keys and parameters, in the worker',
  'packages/web-shared/src/proving-worker-entry.ts': 'the proving material and keys, in the proving worker, which hands its proven call over by the source\'s named ask',
  'packages/web-shared/src/my-payslips.ts': 'the payee\'s own payslips',
  'packages/web-shared/src/error-sink.ts': 'the development console\'s error report',
  'src/core/account.ts': 'the ledger\'s own `fetch` of an account\'s state record, which is no request to the service',
  'src/core/proposal-standing.ts': 'a refusal\'s words, which name the ledger status route to a person and send nothing',
  'src/midnight/contract-history.ts': 'the chain indexer, by the address of the indexer the caller names',
  'src/midnight/indexer-queries.ts': 'the chain indexer, by the address of the indexer the caller names',
  'src/midnight/projections-dust-wallet.ts': 'the chain indexer, by the address of the indexer the caller names',
  'apps/wallet/src/chain/sent-to-the-companys-service.ts': 'the relay the company hosts itself, handed a finished call through the runner\'s one send gate',
});

/**
 * Names that reach the service or the chain, and may be imported only by the records' own files: the calls, the paths,
 * the chain's reads, and the ready-made sources over the calls, each of which reads and writes with no check before a
 * write.
 */
const FOUNDATION_ONLY = new Set([
  'api', 'serviceCall', 'sendOnPage', 'walletCallsOnPage', 'companyWirePaths', 'wirePaths', 'manifestPaths',
  'holdersFromTheWallet', 'walletIndexerFor', 'anchorsOnChainAt',
  'sourceOnPage', 'serviceSource', 'serviceCallOf', 'superAdminOnPage',
]);

/**
 * Names of the records' own files that named callers may import, each with no view by design:
 * - `walletCallsOnPage`: the page's relay of the calls the wallet hands it in an action, sent as the wallet named them,
 *   from the two files that run an action;
 * - `sourceOnPage`: the creation standing reads the account's record of a company to ask the wallet about its key, before
 *   and outside any opening of the company;
 * - `serviceSource` and `serviceCallOf`: the wallet's step views are made over them (step-views.ts), and the upkeep
 *   renders a write into the route it takes over a call that sends nothing, to recognise the step's own sends (upkeep.ts);
 * - `superAdminOnPage`: the super admins' asks, signed by a super admin who may hold no seat and reach the company by a
 *   link, where no view of the company is open.
 */
const NAMED_CALLERS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  walletCallsOnPage: new Set(['packages/web-shared/src/keyring.ts', 'packages/web-shared/src/company-creation.ts']),
  sourceOnPage: new Set(['apps/web/src/adapters/creation-standing.ts']),
  serviceSource: new Set(['apps/wallet/src/actions/step-views.ts', 'apps/wallet/src/actions/upkeep.ts']),
  serviceCallOf: new Set(['apps/wallet/src/actions/step-views.ts']),
  superAdminOnPage: new Set(['apps/web/src/adapters/super-admin-doors.ts']),
});

/** The modules that read the chain directly: only the view's doors may import from them. */
const CHAIN_READS = ['chain/company-chain', 'chain/company-label-on-chain', 'vault-on-chain-here'];

/** The names that read the chain or the wallet's own holders: the view's doors may import them, and nothing else. */
const CHAIN_NAMES = new Set(['holdersFromTheWallet', 'walletIndexerFor', 'anchorsOnChainAt']);

/**
 * The view doors: the wallet's one file that hands the view, and whatever reads the chain before a view exists, the
 * chain's reads; and the page's reads of the chain before a view of the company is open. They may import the chain
 * modules and the chain's names; they may not reach the company's service.
 */
const VIEW_DOORS = new Set([
  'apps/wallet/src/chain/view-doors.ts', 'packages/web-shared/src/chain-before-a-view.ts',
  /* The vault worker's own answers to the chain asks, read at the indexer the wallet names, behind the builder the doors call. */
  'packages/web-shared/src/chain-reads-answered.ts', 'packages/web-shared/src/super-admins-answered.ts',
]);

/**
 * The second ways another change owns and finishes, each with that change and why it stands for now: the only ones the
 * check lets through. One no longer found fails, so the list never names a way that is gone.
 */
const OWNED_ELSEWHERE: readonly { readonly file: string; readonly way: string; readonly owner: string; readonly why: string }[] = Object.freeze([]);

const ownedElsewhere = (w: SecondWay): boolean => OWNED_ELSEWHERE.some((o) => o.file === w.file && o.way === w.way);

/** Ways a page sends a request by itself. */
const SENDING = new Set(['fetch', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource']);

export interface SecondWay { readonly file: string; readonly line: number; readonly way: string }

/** The file's code with every comment blanked, lines kept, as the bundler's own parser finds the comments. */
const codeOnly = (file: string, text: string): string => {
  let out = text;
  for (const c of parseSync(file, text).comments) out = out.slice(0, c.start) + out.slice(c.start, c.end).replace(/[^\n]/g, ' ') + out.slice(c.end);
  return out;
};

const lineAt = (code: string, at: number): number => code.slice(0, at).split('\n').length;

/** The module an import names, as a path from the root when it is relative, without its extension. */
const moduleOf = (file: string, spec: string): string =>
  (spec.startsWith('.') ? posix.normalize(posix.join(dirname(file), spec)) : spec).replace(/\.(js|ts|tsx)$/u, '');

/** Whether an import in `file` names the chain module `c`, written from any folder. */
const readsModule = (file: string, spec: string, c: string): boolean => {
  const m = moduleOf(file, spec);
  return m === c || m.endsWith(`/${c}`);
};

/** Whether `file` is one of the chain modules itself: they read the chain, and may import one another. */
const isChainModule = (file: string): boolean => CHAIN_READS.some((c) => file.replace(/\.tsx?$/u, '').endsWith(`/${c}`));

type Node = { readonly type?: string; readonly start?: number; readonly end?: number; readonly name?: string; readonly value?: unknown; readonly [k: string]: unknown };

/** Every node of a parse tree with its parent and the key it hangs from, in order. */
const walkTree = (n: unknown, parent: Node | null, key: string | null, visit: (node: Node, parent: Node | null, key: string | null) => void): void => {
  if (n === null || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const c of n) walkTree(c, parent, key, visit); return; }
  const node = n as Node;
  visit(node, parent, key);
  for (const [k, v] of Object.entries(node)) if (k !== 'parent' && typeof v === 'object') walkTree(v, node, k, visit);
};
const programOf = (file: string, text: string): Node => parseSync(file, text).program as unknown as Node;

/** One module a file takes names from, by any form of import or re-export: the names it takes, or every name it exports. */
interface ModuleTaken { readonly spec: string; readonly at: number; readonly end: number; readonly names: readonly string[] | 'all' }

const nameOf = (n: unknown): string => String((n as Node).name ?? (n as Node).value);

/** Every module the file imports, re-exports or imports dynamically, read from the parse tree: `import { a }`, a default, a namespace, `export { a } from`, `export * from` and `import()`. Types are left out. */
const modulesTakenBy = (program: Node): ModuleTaken[] => {
  const taken: ModuleTaken[] = [];
  walkTree(program, null, null, (node) => {
    const source = node.source as Node | null | undefined;
    if (source === null || source === undefined || typeof source.value !== 'string') return;
    const at = { spec: source.value, at: node.start!, end: node.end! };
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      const specifiers = (node.specifiers ?? []) as Node[];
      taken.push({ ...at, names: specifiers.some((x) => x.type !== 'ImportSpecifier') ? 'all'
        : specifiers.filter((x) => x.importKind !== 'type').map((x) => nameOf(x.imported)) });
    } else if (node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type') {
      taken.push({ ...at, names: ((node.specifiers ?? []) as Node[]).filter((x) => x.exportKind !== 'type').map((x) => nameOf(x.local)) });
    } else if (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type') {
      taken.push({ ...at, names: 'all' });
    } else if (node.type === 'ImportExpression') {
      taken.push({ ...at, names: 'all' });
    }
  });
  return taken;
};

/** The file a module named in `file` is, when it is one of the repository's own, from the root. */
const fileOf = (file: string, spec: string): string | null => {
  const base = spec.startsWith('.') ? posix.normalize(posix.join(dirname(file), spec))
    : spec.startsWith('vaults-web-shared/') ? `packages/web-shared/src/${spec.slice('vaults-web-shared/'.length)}` : null;
  if (base === null) return null;
  return [base, base.replace(/\.js$/u, '.ts'), base.replace(/\.js$/u, '.tsx')].find((c) => /\.tsx?$/u.test(c) && existsSync(join(ROOT, c))) ?? null;
};

const exportedFoundation = new Map<string, readonly string[]>();
/** The names of `FOUNDATION_ONLY` a module declares or lists as exports: what a namespace import, a default import, `export *` or `import()` of it can reach. */
const foundationExportedBy = (module: string): readonly string[] => {
  if (!exportedFoundation.has(module)) {
    const code = codeOnly(module, readFileSync(join(ROOT, module), 'utf8'));
    exportedFoundation.set(module, [...FOUNDATION_ONLY].filter((n) => new RegExp(`\\bexport\\s+(?:async\\s+)?(?:const|function|class)\\s+${n}\\b|\\bexport\\s*\\{[^}]*\\b${n}\\b`, 'u').test(code)));
  }
  return exportedFoundation.get(module)!;
};

/** Every name and string a file's code writes: a name a module is reached by without being listed in its import is written here as a member, a key or a string. */
const writtenIn = (program: Node): Set<string> => {
  const written = new Set<string>();
  walkTree(program, null, null, (node) => {
    if (node.type === 'Identifier') written.add(node.name!);
    if (node.type === 'Literal' && typeof node.value === 'string') written.add(node.value);
  });
  return written;
};

const importsOf = (code: string, file: string, taken: readonly ModuleTaken[], written: ReadonlySet<string>, found: SecondWay[]): void => {
  for (const m of taken) {
    const line = lineAt(code, m.at);
    const module = fileOf(file, m.spec);
    /* A module taken whole (a namespace, a default, `export *`, `import()`) reaches the names it exports that this file writes. */
    const names = m.names === 'all' ? (module === null ? [] : foundationExportedBy(module).filter((n) => written.has(n))) : m.names;
    const doors = VIEW_DOORS.has(file);
    const mayImport = (x: string): boolean => (doors && CHAIN_NAMES.has(x)) || NAMED_CALLERS[x]?.has(file) === true;
    for (const n of names.filter((x) => FOUNDATION_ONLY.has(x) && !mayImport(x))) found.push({ file, line, way: `imports ${n}` });
    if (!doors && !isChainModule(file) && CHAIN_READS.some((c) => readsModule(file, m.spec, c)) && (m.names === 'all' || m.names.length > 0)) {
      found.push({ file, line, way: `reads the chain around the view (${m.spec})` });
    }
  }
};

/* Where a name that sends is declared or named as a type, not used: a key, a binding, a parameter, an import or export. */
const NOT_A_USE = new Set(['key', 'id', 'params', 'label', 'local', 'imported', 'exported']);

/** Every place a name that sends is used or passed as a value, read from the parse tree: never in a type, a string or a key; a name in square brackets on a member (`globalThis['fetch']`) is a use. */
const sendsIn = (file: string, text: string): { readonly at: number; readonly name: string }[] => {
  const found: { at: number; name: string }[] = [];
  const typed = new Set<Node>();
  walkTree(programOf(file, text), null, null, (node, parent, key) => {
    if (node.type?.startsWith('TS') === true || (parent !== null && typed.has(parent))) { typed.add(node); return; }
    if (node.type === 'Identifier' && SENDING.has(node.name!) && !NOT_A_USE.has(key ?? '') && !(parent?.type ?? '').startsWith('TS')) found.push({ at: node.start!, name: node.name! });
    if (node.type === 'Literal' && typeof node.value === 'string' && SENDING.has(node.value) && key === 'property' && parent?.type === 'MemberExpression' && parent.computed === true) {
      found.push({ at: node.start!, name: node.value });
    }
  });
  return found;
};
/* A string or template holding a service path. */
const PATHS = /(['"`])[^'"`\n]*api\//g;

/** Every second way in one file's code, its comments left out. */
export function secondWaysIn(file: string, text: string): SecondWay[] {
  const found: SecondWay[] = [];
  const code = codeOnly(file, text);
  const foundation = FOUNDATION.has(file);
  const program = programOf(file, text);
  const taken = modulesTakenBy(program);
  if (!foundation) importsOf(code, file, taken, writtenIn(program), found);
  const outsideImports = taken.reduce((c, m) => c.slice(0, m.at) + c.slice(m.at, m.end).replace(/[^\n]/gu, ' ') + c.slice(m.end), code);
  const notTheService = Object.hasOwn(NOT_THE_COMPANYS_SERVICE, file);
  if (!SENDS_ITSELF.has(file) && !notTheService) {
    for (const m of sendsIn(file, text)) found.push({ file, line: lineAt(text, m.at), way: `sends by itself (${m.name})` });
  }
  if (!foundation && !ROUTE_LISTS.has(file) && !notTheService) {
    for (const m of outsideImports.matchAll(PATHS)) found.push({ file, line: lineAt(code, m.index), way: 'names a service path' });
  }
  return found;
}

const sourceFiles = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((name) => {
  const rel = `${dir}/${name}`;
  if (name === 'node_modules' || name.startsWith('.')) return [];
  if (statSync(join(ROOT, rel)).isDirectory()) return sourceFiles(rel);
  return /\.tsx?$/.test(name) && !/\.test(-support)?\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [rel] : [];
});

/** Every source file under `dir`, its tests and test supports included. */
const everyFile = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((name) => {
  const rel = `${dir}/${name}`;
  if (name === 'node_modules' || name.startsWith('.')) return [];
  if (statSync(join(ROOT, rel)).isDirectory()) return everyFile(rel);
  return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [rel] : [];
});

/* The reads and sends the view and the source replaced: none is made again, for the product or for its tests. */
const REPLACED = [
  'directoryFilingsFrom', 'governedCallServiceFor', 'grantsServedBy', 'pageWireSend', 'watchedCalls', 'apiOver',
  'manifestServiceFor', 'treeServiceFor', 'recordsEnteredOver', 'writesThrough',
];

/* The records' own files make the company's view (its class is in company-view-probe.ts): any other object that carries a view's `readBefore` is a view made by hand. */
const THE_VIEW = 'packages/web-shared/src/company-view.ts';

/**
 * Whether `file` builds a company view of its own, as a stand-in with no check before a write, in its code: an object that
 * carries a `readBefore` as a key, a shorthand or a method, a class with one, or one assigned to an object.
 */
export const viewMadeByHandIn = (file: string, text: string): boolean => {
  if (FOUNDATION.has(file) || !text.includes('readBefore')) return false;
  let made = false;
  walkTree(programOf(file, text), null, null, (node) => {
    const named = (k: unknown): boolean => k !== null && typeof k === 'object' && ((k as Node).name === 'readBefore' || (k as Node).value === 'readBefore');
    if ((node.type === 'Property' || node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') && node.computed !== true && named(node.key)) made = true;
    if (node.type === 'AssignmentExpression' && (node.left as Node).type === 'MemberExpression' && named((node.left as Node).property)) made = true;
  });
  return made;
};

/** Each replaced read or send `file` makes again in its code, however it brings the name in: declared, imported under it, a key, a shorthand or exported. */
export const replacedMadeIn = (file: string, text: string): string[] => {
  if (!REPLACED.some((n) => text.includes(n))) return [];
  const names = new Set<string>();
  walkTree(programOf(file, text), null, null, (node) => { if (node.type === 'Identifier' && REPLACED.includes(node.name!)) names.add(node.name!); });
  return REPLACED.filter((n) => names.has(n)).map((n) => `${file} ${n}`);
};

/** Every second way in every file scanned. */
export const census = (): SecondWay[] =>
  SCANNED.flatMap(sourceFiles).flatMap((file) => secondWaysIn(relative(ROOT, join(ROOT, file)), readFileSync(join(ROOT, file), 'utf8')));

const REGISTRY = 'apps/wallet/src/actions/registry.ts';

/** Every intent the wallet registers an action for, read off the registry's own list of actions, comments left out. */
const intentsRegistered = (): string[] => {
  const code = codeOnly(REGISTRY, readFileSync(join(ROOT, REGISTRY), 'utf8'));
  const actions = code.slice(code.indexOf('export const ACTIONS'));
  return [...actions.matchAll(/\n {2}'?([a-z-]+)'?: [A-Za-z]+\(/gu)].map((m) => m[1]!);
};

/** Where each kind of the page's places lives: one place for each source file directly in its folder. */
const PAGE_PARTS: Readonly<Record<Exclude<PlaceKind, 'wallet action'>, string>> = Object.freeze({
  screen: 'apps/web/src/screens', 'action panel': 'apps/web/src/actions', shell: 'apps/web/src/shell', setup: 'apps/web/src/setup',
});

/** Every place the inventory must hold, as `<kind> <name>`. */
export const placesHere = (): string[] => [
  ...intentsRegistered().map((n) => `wallet action ${n}`),
  ...Object.entries(PAGE_PARTS).flatMap(([kind, dir]) => sourceFiles(dir).filter((f) => dirname(f) === dir)
    .map((f) => `${kind} ${posix.basename(f).replace(/\.tsx?$/u, '')}`)),
];

/**
 * What the inventory leaves out (`missing`: a place here it holds no entry for) and what it holds that is not here
 * (`gone`: an entry whose file does not exist, or a wallet action, screen, panel, shell part or setup step that is no
 * longer one).
 */
export const inventoryGaps = (
  inventory: readonly Place[], places: readonly string[], exists: (file: string) => boolean,
): { readonly missing: readonly string[]; readonly gone: readonly string[] } => {
  const held = new Set(inventory.map((p) => `${p.kind} ${p.name}`));
  const here = new Set(places);
  const outsideTheFolders = (p: Place): boolean => p.kind !== 'wallet action' && dirname(p.file) !== PAGE_PARTS[p.kind];
  return {
    missing: places.filter((p) => !held.has(p)),
    gone: inventory.filter((p) => !exists(p.file) || (!here.has(`${p.kind} ${p.name}`) && !outsideTheFolders(p))).map((p) => `${p.kind} ${p.name}`),
  };
};

const fileHere = (file: string): boolean => existsSync(join(ROOT, file));

describe('the company\'s records are read one way', () => {
  it('finds each second way, and nothing in a comment', () => {
    const ways = (text: string, file = 'apps/web/src/adapters/x.ts') => secondWaysIn(file, text).map((w) => w.way);
    expect(ways("import { api } from '../service-transport.js';")).toEqual(['imports api']);
    expect(ways("import { manifestPaths as m } from 'x';")).toEqual(['imports manifestPaths']);
    expect(ways("import type { api } from 'x';")).toEqual([]);
    expect(ways("const r = await fetch('/x');")).toEqual(['sends by itself (fetch)']);
    expect(ways('const send = window.fetch;')).toEqual(['sends by itself (fetch)']);
    expect(ways('navigator.sendBeacon(u);')).toEqual(['sends by itself (sendBeacon)']);
    expect(ways('const p = `/api/accounts/${id}`;')).toEqual(['names a service path']);
    expect(ways("const p = '/api/me';")).toEqual(['names a service path']);
    expect(ways("import { holdersOnChain } from './chain/company-label-on-chain.js';")).toEqual(['reads the chain around the view (./chain/company-label-on-chain.js)']);
    expect(ways("// fetch('/api/x')\n/* manifestPaths */ const a = 1;")).toEqual([]);
    expect(ways("const s = 'é — ü'; /* fetch('/api/x') */ const r = fetch(u);")).toEqual(['sends by itself (fetch)']);
    expect(ways('interface D { fetch: () => void; sendBeacon?: string }')).toEqual([]);
    expect(ways("let f: typeof fetch = g; const t = 'fetch'; type O = { fetch?: typeof fetch }; const o = { fetch: g };")).toEqual([]);
    expect(ways('const T = () => <p>the fetch was refused</p>;', 'apps/web/src/screens/x.tsx')).toEqual([]);
    expect(ways('const go = (f = fetch) => f; h({ fetch }); k(o.fetch);')).toEqual(['sends by itself (fetch)', 'sends by itself (fetch)', 'sends by itself (fetch)']);
    /* RED WHEN: a request is sent through a name in square brackets, which is no identifier to look for. */
    expect(ways("const r = globalThis['fetch']('/x'); const t: { ['fetch']: number } = o;")).toEqual(['sends by itself (fetch)']);
  });

  it('finds a foundation name however a module is taken: a namespace, a default, a re-export, export-all or import()', () => {
    const transport = "'vaults-web-shared/service-transport.js'";
    const ways = (text: string, file = 'apps/web/src/adapters/x.ts') => secondWaysIn(file, text).map((w) => w.way);
    /* RED WHEN: a module that holds the service's transport is taken whole, and its transport used, and nothing says so. */
    expect(ways(`import * as t from ${transport}; t.api('x');`)).toEqual(['imports api']);
    expect(ways(`import t from ${transport}; t.serviceCall('x');`)).toEqual(['imports serviceCall']);
    expect(ways(`export { api } from ${transport};`)).toEqual(['imports api']);
    expect(ways(`export * from ${transport}; const n = 'sendOnPage';`)).toEqual(['imports sendOnPage']);
    expect(ways(`const { serviceCall } = await import(${transport});`)).toEqual(['imports serviceCall']);
    expect(ways(`const t = await import(${transport}); t['api']('x');`)).toEqual(['imports api']);
    /* A module taken whole whose transport is never written is not a way to it; a type import and a type re-export are not either. */
    expect(ways(`import * as t from ${transport}; t.AuthError;`)).toEqual([]);
    expect(ways(`import type { api } from ${transport}; export type { serviceCall } from ${transport};`)).toEqual([]);
    expect(ways(`import { type api, AuthError } from ${transport};`)).toEqual([]);
    /* The chain's own module, taken by import(), is the chain read around the view. */
    expect(ways("const m = await import('./chain/company-label-on-chain.js');")).toEqual(['reads the chain around the view (./chain/company-label-on-chain.js)']);
    expect(ways("const m = await import('./chain/company-label-on-chain.js');", 'apps/wallet/src/chain/view-doors.ts')).toEqual([]);
  });

  it('lets the records\' own files and the route lists hold what they hold', () => {
    expect(secondWaysIn('packages/web-shared/src/records-source.ts', "const p = `/api/${x}`; import { manifestPaths } from 'y';")).toEqual([]);
    expect(secondWaysIn('packages/identity/src/profile/act-intent-calls.ts', "const p = '/api/accounts/:record';")).toEqual([]);
  });

  it('lets a file that asks something other than the company\'s service send and name its path, and nothing more', () => {
    const payslips = 'packages/web-shared/src/my-payslips.ts';
    expect(secondWaysIn(payslips, "const r = await fetch('/api/payslips');")).toEqual([]);
    expect(secondWaysIn(payslips, "import { serviceCall } from './service-transport.js';").map((w) => w.way)).toEqual(['imports serviceCall']);
    for (const file of Object.keys(NOT_THE_COMPANYS_SERVICE)) expect(statSync(join(ROOT, file)).isFile()).toBe(true);
  });

  it('lets the page\'s relay of the wallet\'s calls be imported by the two files that run an action, and nothing else', () => {
    const relay = "import { walletCallsOnPage } from './asks-on-page.js';";
    expect(secondWaysIn('packages/web-shared/src/keyring.ts', relay)).toEqual([]);
    expect(secondWaysIn('packages/web-shared/src/company-creation.ts', relay)).toEqual([]);
    expect(secondWaysIn('apps/web/src/adapters/x.ts', "import { walletCallsOnPage } from 'vaults-web-shared/asks-on-page.js';").map((w) => w.way))
      .toEqual(['imports walletCallsOnPage']);
  });

  it('refuses the ready-made sources to any file but their named callers, so nothing reads or writes around the view', () => {
    const page = 'apps/web/src/adapters/x.ts';
    /* RED WHEN: a page file takes the bare source over the service and writes with no check before the write. */
    expect(secondWaysIn(page, "import { sourceOnPage } from 'vaults-web-shared/company-view-on-page.js';").map((w) => w.way)).toEqual(['imports sourceOnPage']);
    expect(secondWaysIn(page, "import { superAdminOnPage } from 'vaults-web-shared/asks-on-page.js';").map((w) => w.way)).toEqual(['imports superAdminOnPage']);
    expect(secondWaysIn('apps/wallet/src/actions/x.ts', "import { serviceCallOf, serviceSource } from '../records-source.js';").map((w) => w.way))
      .toEqual(['imports serviceCallOf', 'imports serviceSource']);
    expect(secondWaysIn('apps/web/src/adapters/creation-standing.ts', "import { sourceOnPage } from 'vaults-web-shared/company-view-on-page.js';")).toEqual([]);
    expect(secondWaysIn('apps/wallet/src/actions/upkeep.ts', "import { serviceSource } from 'x';")).toEqual([]);
    expect(secondWaysIn('apps/wallet/src/actions/upkeep.ts', "import { serviceCallOf } from 'x';").map((w) => w.way)).toEqual(['imports serviceCallOf']);
    for (const file of new Set(Object.values(NAMED_CALLERS).flatMap((s) => [...s]))) expect(statSync(join(ROOT, file)).isFile()).toBe(true);
  });

  it('lets the wallet\'s view doors read the chain, and nothing more', () => {
    const doors = 'apps/wallet/src/chain/view-doors.ts';
    expect(secondWaysIn(doors, "import { holdersOnChain } from './company-label-on-chain.js'; import { anchorsOnChainAt } from 'x';")).toEqual([]);
    expect(secondWaysIn(doors, "import { serviceCall } from 'x'; const p = '/api/me'; fetch(p);").map((w) => w.way))
      .toEqual(['imports serviceCall', 'sends by itself (fetch)', 'names a service path']);
    expect(secondWaysIn('apps/wallet/src/screens/x.tsx', "import { anchorsOnChainAt } from 'x';").map((w) => w.way)).toEqual(['imports anchorsOnChainAt']);
    expect(secondWaysIn('apps/wallet/src/chain/x.ts', "import { holdersOnChain } from './company-label-on-chain.js';").map((w) => w.way))
      .toEqual(['reads the chain around the view (./company-label-on-chain.js)']);
    expect(secondWaysIn('apps/wallet/src/chain/company-chain.ts', "import { holdersOnChain } from './company-label-on-chain.js';")).toEqual([]);
  });

  it('holds every wallet action, screen, action panel, shell part and setup step in the inventory, and nothing that is gone', () => {
    const inventory: Place[] = [
      { kind: 'wallet action', name: 'invite', file: 'a.ts', reads: 'company' },
      { kind: 'screen', name: 'old', file: 'apps/web/src/screens/old.tsx', reads: 'company' },
      { kind: 'shell', name: 'session', file: 'apps/web/src/session.tsx', reads: 'before' },
      { kind: 'shell', name: 'sign-in-frame', file: 'apps/web/src/sign-in-frame.tsx', reads: 'before' },
      { kind: 'wallet action', name: 'retired', file: 'a.ts', reads: 'company' },
    ];
    const places = ['wallet action invite', 'screen people'];
    const exists = (file: string): boolean => !['apps/web/src/screens/old.tsx', 'apps/web/src/sign-in-frame.tsx'].includes(file);
    /* RED WHEN: a screen the page draws, or an action the wallet registers, is left off the inventory and so never counted. */
    expect(inventoryGaps(inventory, places, exists).missing).toEqual(['screen people']);
    /* RED WHEN: an entry for a screen whose file is gone, or for an action the wallet no longer registers, stays on the inventory. */
    expect(inventoryGaps(inventory, places, exists).gone).toEqual(['screen old', 'shell sign-in-frame', 'wallet action retired']);
    expect(placesHere()).toEqual(expect.arrayContaining(['wallet action invite', 'screen people', 'action panel approve', 'shell menu', 'setup steps']));
    /* RED WHEN: the inventory misses a place a company is read from, or names one that is no longer there. */
    expect(inventoryGaps(COMPANY_VIEW_INVENTORY, placesHere(), fileHere)).toEqual({ missing: [], gone: [] });
  });

  it('keeps no second copy of a read the view or the source makes, for the product or for its tests', () => {
    /* Each sample is split where the name meets its keyword, so this file never reads as making one itself. */
    expect(replacedMadeIn('src/testing/x.ts', 'export const ' + 'apiOver = (c: C) => c;')).toEqual(['src/testing/x.ts apiOver']);
    expect(replacedMadeIn('src/testing/x.ts', '/* const ' + 'treeServiceFor = 1 */ const t = treeServiceOf(s);')).toEqual([]);
    expect(viewMadeByHandIn('src/testing/x.ts', 'const v = { readBefore' + ': () => undefined };')).toBe(true);
    expect(viewMadeByHandIn('src/testing/x.ts', '/* readBefore' + ': none */ const v = view.readBefore(read);')).toBe(false);
    expect(viewMadeByHandIn(THE_VIEW, 'const v = { readBefore' + ': () => undefined };')).toBe(false);
    /* RED WHEN: a stand-in view is made with `readBefore` as a shorthand, a method, a class method or an assignment, which no colon gives away. */
    expect(viewMadeByHandIn('src/testing/x.ts', 'const readBefore = f; const v = { ' + 'readBefore };')).toBe(true);
    expect(viewMadeByHandIn('src/testing/x.ts', 'const v = { ' + 'readBefore(name: N) { return 1; } };')).toBe(true);
    expect(viewMadeByHandIn('src/testing/x.ts', 'class V { ' + 'readBefore(name: N) { return 1; } }')).toBe(true);
    expect(viewMadeByHandIn('src/testing/x.ts', 'v.' + 'readBefore = f;')).toBe(true);
    expect(viewMadeByHandIn('src/testing/x.ts', "const v = { ['" + "readBefore']: f };")).toBe(false);
    expect(viewMadeByHandIn('src/testing/x.ts', 'interface V { ' + 'readBefore(name: N): void }')).toBe(false);
    /* RED WHEN: a replaced read is made again under another form: imported under the name, a key, a shorthand or an export. */
    expect(replacedMadeIn('src/testing/x.ts', "import { read as " + "apiOver } from 'y';")).toEqual(['src/testing/x.ts apiOver']);
    expect(replacedMadeIn('src/testing/x.ts', 'const o = { ' + 'apiOver: f };')).toEqual(['src/testing/x.ts apiOver']);
    expect(replacedMadeIn('src/testing/x.ts', 'const ' + 'apiOver = f; export { ' + 'apiOver };')).toEqual(['src/testing/x.ts apiOver']);
    /* RED WHEN: a test builds its own stand-in for the company's view, which reads and writes with no check before a write. */
    expect([...SCANNED, 'src', 'contracts/test'].flatMap(everyFile).filter((file) => viewMadeByHandIn(file, readFileSync(join(ROOT, file), 'utf8')))).toEqual([]);
    /* RED WHEN: a test support or a product file builds its own copy of a read the view or the source already makes. */
    expect([...SCANNED, 'src', 'contracts/test'].flatMap(everyFile).flatMap((file) => replacedMadeIn(file, readFileSync(join(ROOT, file), 'utf8')))).toEqual([]);
  });

  it(CENSUS ? 'lists every file that reads another way (the census)' : 'finds no file that reads another way', () => {
    const found = census();
    if (CENSUS) {
      const byFile = new Map<string, string[]>();
      for (const w of found) byFile.set(w.file, [...(byFile.get(w.file) ?? []), `${w.line} ${w.way}`]);
      console.log(`${byFile.size} files, ${found.length} second ways\n${[...byFile].map(([f, w]) => `${f}: ${w.join('; ')}`).join('\n')}`);
      expect(byFile.size).toBeGreaterThan(0);
      return;
    }
    expect(found.filter((w) => !ownedElsewhere(w))).toEqual([]);
    for (const o of OWNED_ELSEWHERE) expect(found.some((w) => o.file === w.file && o.way === w.way), `${o.file} no longer ${o.way}`).toBe(true);
  });
});
