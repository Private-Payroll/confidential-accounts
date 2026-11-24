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
 * Why the proving worker sends to hand over: it posts the proven call it made to the company's proven route, through the
 * source's own ask for it (`provenHandedOver`), with the send it hands `sendOver`. It names no service path itself.
 */
const THE_WORKERS_HAND_OVER = 'the worker posts the proven call it made to the company\'s proven route; only that path';

/**
 * The one send of a file that hands a call over, by the function the send is handed to, with why: that send may take
 * the hand-over's ask; every other send in the file goes through the rule for sends as in any file, and the file names
 * no service path.
 */
const WORKER_HAND_OVER: Readonly<Record<string, { readonly to: string; readonly why: string }>> = Object.freeze({
  'packages/web-shared/src/proving-worker-entry.ts': { to: 'sendOver', why: THE_WORKERS_HAND_OVER },
});

/**
 * Sends that are not the company's service, one by one, in a file that also hands a call over (`WORKER_HAND_OVER`), by
 * the function each send is handed to, with what it asks.
 */
const SENDS_NOT_TO_THE_SERVICE: Readonly<Record<string, ReadonlyMap<string, string>>> = Object.freeze({
  'packages/web-shared/src/proving-worker-entry.ts': new Map([
    ['preimageOver', 'the job\'s preimage, fetched at the relative location the job names, on the application\'s own origin, never the company\'s records'],
    ['httpKeyMaterialSource', 'the proving keys'],
  ]),
});

/**
 * Names that reach the service or the chain, and may be imported only by the records' own files: the calls, the paths,
 * the chain's reads, the ready-made sources over the calls, each of which reads and writes with no check before a
 * write, the page's openers of a view, the page's read through a view opened apart from the screen's own opening, and
 * the makers of the asks and doors that reach the service with no view (the invitee's, a creation's, a super admin's
 * and a person's asks, the proving worker's hand-over, and the tree and manifest doors over a source).
 */
const FOUNDATION_ONLY = new Set([
  'api', 'serviceCall', 'serviceAnswered', 'walletCallsOnPage', 'companyWirePaths', 'wirePaths', 'manifestPaths',
  'holdersFromTheWallet', 'walletIndexerFor', 'anchorsOnChainAt',
  'sourceOnPage', 'serviceSource', 'serviceCallOf', 'superAdminOnPage', 'readThroughAViewOf', 'openOnPage', 'openViewOf',
  'invitationOnPage', 'creationOnPage',
  'invitationSource', 'creationSource', 'provenHandedOver', 'superAdminAsks', 'creationAsks', 'personAsks', 'treeServiceOf', 'manifestServiceOf',
]);

/** A fresh opening the screen makes after its own write: one opening for both waits for the page's refresh after a wallet action. */
const AFTER_ITS_OWN_WRITE = 'a fresh opening after the screen\'s own write, which reads the company as the write left it; one opening for both waits for the page\'s refresh after a wallet action';

/**
 * The names of the records' own files that named callers may import, each caller with why it reads with no view, or
 * with a view of its own beside the screen's. A caller with no reason fails the check.
 */
const NAMED_CALLERS: Readonly<Record<string, ReadonlyMap<string, string>>> = Object.freeze({
  walletCallsOnPage: new Map([
    ['packages/web-shared/src/keyring.ts', 'the page\'s relay of the calls the wallet hands it in an action, sent as the wallet named them'],
    ['packages/web-shared/src/company-creation.ts', 'the page\'s relay of the calls the wallet hands it while it creates a company'],
  ]),
  sourceOnPage: new Map([
    ['apps/web/src/adapters/creation-standing.ts', 'a company being created has no account on the chain yet, so no view of it can be opened'],
  ]),
  serviceSource: new Map([
    ['apps/wallet/src/actions/step-views.ts', 'the wallet\'s step views are made over it'],
    ['apps/wallet/src/actions/upkeep.ts', 'the upkeep renders a write into the route it takes over a call that sends nothing, to recognise the step\'s own sends'],
  ]),
  serviceCallOf: new Map([['apps/wallet/src/actions/step-views.ts', 'the wallet\'s step views are made over it']]),
  invitationSource: new Map([
    ['apps/wallet/src/actions/run.ts', 'the runner makes the invitee door a step is handed: an invitee asks before any membership, so holds no company to open a view of; what a step reads through it, or where it hands it on, is named in INVITEE_DOOR_USE_BY'],
    ['packages/web-shared/src/invitation-taken-on-device.ts', 'the invitee\'s own device takes an invitation before any membership, so holds no company to open a view of'],
  ]),
  creationSource: new Map([
    ['apps/wallet/src/actions/run.ts', 'the runner makes the creation door a step is handed: a company being created has no account on the chain yet, so no view of it can be opened'],
  ]),
  provenHandedOver: new Map([['packages/web-shared/src/proving-worker-entry.ts', THE_WORKERS_HAND_OVER]]),
  invitationOnPage: new Map([
    ['apps/web/src/adapters/join.ts', 'an invitee asks for the invitation before any membership, so holds no company to open a view of'],
  ]),
  creationOnPage: new Map([
    ['packages/web-shared/src/company-creation.ts', 'a company being created has no account on the chain yet, so no view of it can be opened'],
  ]),
  superAdminOnPage: new Map([
    ['apps/web/src/adapters/super-admin-doors.ts', 'a super admin need not be a member, so holds no view; a stale ask is refused on the chain, and no money moves'],
  ]),
  readThroughAViewOf: new Map([
    ['apps/web/src/adapters/deposit.ts', 'a public deposit outlives its panel, so it reads adoption again on its own view before a send'],
    ['apps/web/src/adapters/grants-here.ts', AFTER_ITS_OWN_WRITE],
    ['apps/web/src/adapters/handover-state.ts', AFTER_ITS_OWN_WRITE],
    ['apps/web/src/adapters/session.ts', 'the list of the person\'s companies is read by no screen\'s opening: each company through a view of its own, ended once read'],
  ]),
  openOnPage: new Map([
    ['apps/web/src/adapters/filing-judge.ts', 'the page\'s one opener of a view, over the page\'s own doors and judges: every opening a screen holds is made here'],
    ['apps/web/src/adapters/reader-judge.ts', 'a reader holds no seat, so its view of the company is opened over the reader\'s own judges, not a member\'s'],
  ]),
  openViewOf: new Map([
    ['apps/web/src/records/company-records.tsx', 'the screen\'s one opening: the provider opens the view every tile of the screen reads through, and ends it'],
  ]),
});

/** Why a wallet that the chain no longer seats reads the company's directory through the invitee door, with no view. */
const A_SEAT_THE_CHAIN_REMOVED = 'the reader is a wallet whose seat the chain no longer holds, so it holds no seat that opens a view of the '
  + 'company; the wallet reads the chain first, and the served directory decides only for a seat the chain has already removed, so it can '
  + 'only make this wallet set aside, and keep, saved keys that sign for nothing on the chain, or refuse (the signature check on a served '
  + 'retirement stops a careless service, not a dishonest one)';

/** Why an invitee reads the offer of the invitation it holds through the invitee door. */
const AN_INVITEE_ASKS = 'an invitee reads the offer of the invitation it holds before any membership, so holds no company to open a view of';

/** The reads made through the invitee door (`InvitationSource`), which reach the service with no view. */
const INVITEE_DOOR_READS = new Set(['filings', 'offer']);

/** A use of the invitee door that is no call of one of its asks: the door passed as a value, held under another name, taken apart or bound. */
const HANDED_ON = 'hands the door on';

/** Why the code-joining step hands the invitee door to the code's acceptance. */
const THE_CODES_OWN_ASKS = 'it hands the door to addSignerFromCodeHere (invitation-by-code.ts), which takes only its acceptSigner and acceptPayee '
  + 'asks (`Pick<InvitationSource, \'acceptSigner\' | \'acceptPayee\'>`): the invitee\'s own acceptance, which reads nothing of the company';

/**
 * Each use of the invitee door, by what it is (a read it makes, or the door handed on), with each file that makes it, how
 * many times, and why it reads with no view: the door goes to every step the runner starts (`invitationSource`, named for
 * run.ts), so what a step reads through it, or where it hands it, is named here. A call of one of the door's other asks
 * (the invitee's own acceptance and seat, which read nothing of the company) is seen and needs no name. A use that is not
 * named, one more than named, or one named and no longer made fails the check.
 */
const INVITEE_DOOR_USE_BY: Readonly<Record<string, ReadonlyMap<string, { readonly times: number; readonly why: string }>>> = Object.freeze({
  filings: new Map([['apps/wallet/src/actions/seat-invited.ts', { times: 1, why: A_SEAT_THE_CHAIN_REMOVED }]]),
  offer: new Map([
    ['apps/wallet/src/actions/claim-by-address.ts', { times: 1, why: AN_INVITEE_ASKS }],
    ['apps/wallet/src/actions/join-by-code.ts', { times: 1, why: AN_INVITEE_ASKS }],
    ['apps/wallet/src/actions/take-reissue.ts', { times: 1, why: AN_INVITEE_ASKS }],
    ['apps/wallet/src/actions/seat-invited.ts', { times: 1, why: AN_INVITEE_ASKS }],
    ['apps/wallet/src/actions/invite.ts', { times: 2, why: 'the inviter\'s own invitation, read by its id: the filed offer is opened against the token this '
      + 'wallet kept, and the view\'s invitations list does not carry the offer (its route leaves it out); whether a kept link is still open is the '
      + 'service\'s own answer at the same route, which the list does not give' }],
  ]),
  [HANDED_ON]: new Map([['apps/wallet/src/actions/add-signer-by-code.ts', { times: 1, why: THE_CODES_OWN_ASKS }]]),
});

/*
 * Where the invitee door goes: the wallet's runner makes it for each step, and the shared code a step calls may be handed
 * it. The page's `invitations` is the view's list of the company's invitations, read through the view, never this door.
 */
const WHERE_THE_INVITEE_DOOR_GOES = ['apps/wallet/src', 'packages/web-shared/src'];

/* Where a name is a binding or a key, never the door itself: a property's name, a key, a declared name, a parameter, an import or export. */
const NOT_THE_DOOR = new Set(['property', 'key', 'id', 'params', 'local', 'imported', 'exported', 'label']);

/**
 * Each use of the invitee door `file` makes in its code, one line for each: a read it makes (a call of `filings` or
 * `offer` on the door), or `HANDED_ON` for any other use but a call of one of its asks: the door (`invitations`, a
 * property or a name) passed as a value, bound to another name, taken out of the step's context or taken apart by a
 * destructuring, or one of its asks taken off it uncalled (`.call`, `.bind`, a name bound to it).
 */
export const inviteeDoorUsesIn = (file: string, text: string): string[] => {
  if (!text.includes('invitations')) return [];
  const up = new Map<Node, { readonly parent: Node | null; readonly key: string | null }>();
  const doors: Node[] = [];
  const found: string[] = [];
  walkTree(programOf(file, text), null, null, (node, parent, key) => {
    up.set(node, { parent, key });
    if (node.type?.startsWith('TS') === true || (parent?.type ?? '').startsWith('TS')) return;
    const member = node.type === 'MemberExpression' && nameOf(node.property) === 'invitations' && (node.computed !== true || (node.property as Node).type === 'Literal');
    const named = node.type === 'Identifier' && node.name === 'invitations' && !NOT_THE_DOOR.has(key ?? '') && !(parent?.type === 'Property' && up.get(parent)?.parent?.type === 'ObjectPattern');
    if (member || named) doors.push(node);
    if (node.type === 'Property' && parent?.type === 'ObjectPattern' && nameOf(node.key) === 'invitations') found.push(`${HANDED_ON} ${file}`);
  });
  for (const door of doors) {
    const { parent, key } = up.get(door)!;
    const asked = parent?.type === 'MemberExpression' && key === 'object' && parent.computed !== true ? nameOf(parent.property) : null;
    const called = asked !== null && up.get(parent!)?.key === 'callee' && up.get(parent!)?.parent?.type === 'CallExpression';
    if (!called) found.push(`${HANDED_ON} ${file}`);
    else if (INVITEE_DOOR_READS.has(asked)) found.push(`${asked} ${file}`);
  }
  return found;
};

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
const sendsIn = (file: string, text: string): { readonly at: number; readonly name: string; readonly to: string | null }[] => {
  const found: { at: number; name: string; node: Node }[] = [];
  const typed = new Set<Node>();
  const up = new Map<Node, { readonly parent: Node | null; readonly key: string | null }>();
  walkTree(programOf(file, text), null, null, (node, parent, key) => {
    up.set(node, { parent, key });
    if (node.type?.startsWith('TS') === true || (parent !== null && typed.has(parent))) { typed.add(node); return; }
    if (node.type === 'Identifier' && SENDING.has(node.name!) && !NOT_A_USE.has(key ?? '') && !(parent?.type ?? '').startsWith('TS')) found.push({ at: node.start!, name: node.name!, node });
    if (node.type === 'Literal' && typeof node.value === 'string' && SENDING.has(node.value) && key === 'property' && parent?.type === 'MemberExpression' && parent.computed === true) {
      found.push({ at: node.start!, name: node.value, node });
    }
  });
  return found.map(({ at, name, node }) => ({ at, name, to: handedTo(node, up) }));
};

/* Where a send is handed on: the function it is an argument of, as it is or bound, or a property of an object that is one; null for any other use. */
const HANDED_THROUGH = new Set(['MemberExpression', 'CallExpression', 'Property', 'ObjectExpression', 'ChainExpression', 'AwaitExpression']);
const handedTo = (use: Node, up: ReadonlyMap<Node, { readonly parent: Node | null; readonly key: string | null }>): string | null => {
  for (let at = up.get(use); at?.parent !== null && at !== undefined; at = up.get(at.parent)) {
    if (at.parent.type === 'CallExpression' && at.key === 'arguments') return pathOf(at.parent.callee);
    if (!HANDED_THROUGH.has(at.parent.type ?? '')) return null;
  }
  return null;
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
    const named = (to: string | null): boolean => to !== null && (WORKER_HAND_OVER[file]?.to === to || SENDS_NOT_TO_THE_SERVICE[file]?.has(to) === true);
    for (const m of sendsIn(file, text)) if (!named(m.to)) found.push({ file, line: lineAt(text, m.at), way: `sends by itself (${m.name})` });
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

/* The makers of a record source: a write called on what one returns goes to the service with no check before it. */
const SOURCE_MAKERS = new Set(['serviceSource', 'sourceOnPage', 'sourceOf']);

/* The doors made over a record source that write on it (the tree's header filing, the manifest's entry): made over one, they write with no check before it. */
const WRITERS_OVER_A_SOURCE = new Set(['treeServiceOf', 'manifestServiceOf']);

/* Why a test writes the tree and the manifest over a record source: what it tests is the anchor, the tree or their routes, which no view stands in front of. */
const THE_ANCHORS_OWN_WRITES = 'it files headers and enters entries through the tree and manifest doors over the company\'s source on purpose, as an '
  + 'anchor does: what it tests is the anchor, the tree or their routes, under no view';
/* Why a test hands a device the manifest door it enters its filings through, made over a record source. */
const ENTERED_AS_A_DEVICE_ENTERS = 'the device it runs is handed the manifest door it enters its filings through, made over the company\'s source, '
  + 'and what it checks is what was entered';

/* How a test writes on a record source: straight on it (`direct`), or through a tree or manifest door made over it (`door`). */
type WriteOnASource = 'direct' | 'door';
const THROUGH_A_DOOR = ' through a door';

/*
 * A test file that writes on a record source, each with how and why: a file named for writing through a door is still refused
 * a write straight on a source, and a file named for a way it no longer writes is refused as stale. The view's own module and
 * `writesOver` write through a view, so name none.
 */
const WRITES_ON_A_SOURCE: Readonly<Record<string, { readonly how: readonly WriteOnASource[]; readonly why: string }>> = Object.freeze({
  'packages/web-shared/src/company-view.test.ts': { how: ['direct', 'door'], why: 'one case asks the source itself to write a transaction of more calls than its vault routes file: the refusal is the source\'s own, made before any view is asked; another makes the tree door over a source to see it refuse another company\'s ask before anything is asked of the service' },
  'packages/identity/src/profile/an-action-calls-only-routes-its-intent-lists-and-the-service-answers.test.ts': { how: ['direct'], why: 'it runs each write of a source made over a recorder that answers every call with nothing, to list the routes the source asks: nothing is filed and no company is read, so no view has a check to make' },
  'src/server/a-company-whose-signers-change-on-the-chain.test-support.ts': { how: ['door'], why: 'the chain double hands the tree and manifest doors over the company\'s source as an anchor\'s doors, so the tests run on it anchor as a device\'s anchor does' },
  'src/testing/record-tree-double.ts': { how: ['door'], why: 'the record tree double files the headers it builds through a tree door over the company\'s source, standing in for an anchor' },
  'packages/web-shared/src/a-read-that-hangs-ends-at-twenty-seconds.test.ts': { how: ['door'], why: 'it makes the tree and manifest doors over a source whose transport never answers, to end a read that hangs: nothing is written' },
  'src/server/a-company-of-two-seats.test-support.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/a-company-seats-its-signers-from-a-device.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/a-directory-change-is-anchored-and-kept-by-the-device-that-files-it.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/a-directory-change-is-counted-against-who-held-the-account-when-it-was-anchored.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/a-directory-version-never-entered-is-filed-again.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/a-read-is-proven-for-what-it-asks.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/a-record-is-believed-only-as-the-anchor-holds-it.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/a-roster-believes-a-wallet-only-as-its-seat-proves-it.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/a-roster-entry-is-believed-on-its-own-signers-witnesses.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/a-write-is-held-to-the-waiting-entry-its-read-saw.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/an-anchor-reads-and-writes-through-one-view-of-the-company.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/record-manifest-route.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/the-records-are-anchored-from-a-device.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/the-records-open-after-their-signers-change.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'src/server/what-a-second-device-believes-is-what-the-anchor-holds.test.ts': { how: ['door'], why: THE_ANCHORS_OWN_WRITES },
  'contracts/test/a-company-vault-from-the-page.test.ts': { how: ['door'], why: ENTERED_AS_A_DEVICE_ENTERS },
  'contracts/test/a-private-payment-from-the-page.test.ts': { how: ['door'], why: ENTERED_AS_A_DEVICE_ENTERS },
  'contracts/test/a-run-is-raised-approved-and-paid-on-the-signers-devices.test.ts': { how: ['door'], why: ENTERED_AS_A_DEVICE_ENTERS },
  'contracts/test/a-vaults-committee-changes-with-its-signers.test.ts': { how: ['door'], why: ENTERED_AS_A_DEVICE_ENTERS },
  'src/server/a-person-invited-is-seated-on-the-chain-filed-and-anchored-and-believed-by-every-device.test.ts': { how: ['door'], why: ENTERED_AS_A_DEVICE_ENTERS },
  'src/server/every-filing-is-entered-in-the-company-records.test.ts': { how: ['door'], why: ENTERED_AS_A_DEVICE_ENTERS },
});

/** How a finding of `sourceWritesIn` writes: through a door, or straight on the source. */
const howOf = (w: string): WriteOnASource => (w.endsWith(THROUGH_A_DOOR) ? 'door' : 'direct');

/** The writes on a record source among `writes` that no entry of `WRITES_ON_A_SOURCE` names, for their file and how they write. */
export const writesNotNamed = (writes: readonly string[]): string[] => writes.filter((w) => WRITES_ON_A_SOURCE[w.split(':')[0]!]?.how.includes(howOf(w)) !== true);

const isTestFile = (file: string): boolean => /\.test(-support)?\.tsx?$/u.test(file) || file.startsWith('src/testing/');

const PEELED = new Set(['AwaitExpression', 'ParenthesizedExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'ChainExpression']);
/** An expression without the wrappers that leave its value as it was: an await, parentheses, a type assertion, an optional chain. */
const peeled = (n: unknown): Node | null => {
  let e = n as Node | null | undefined;
  while (e !== null && e !== undefined && PEELED.has(e.type ?? '')) e = (e.expression ?? e.argument) as Node;
  return e ?? null;
};
/** The dotted name of a name or a chain of property names (`s`, `holder.source`), or null for any other expression. */
const pathOf = (n: unknown): string | null => {
  const e = peeled(n);
  if (e?.type === 'Identifier') return e.name!;
  if (e?.type !== 'MemberExpression' || e.computed === true) return null;
  const object = pathOf(e.object);
  return object === null ? null : `${object}.${nameOf(e.property)}`;
};

/** The functions a file declares by name, a declaration or a name bound to an arrow or function expression, each by its name. */
const functionsDeclaredIn = (program: Node): Map<string, Node> => {
  const named = new Map<string, Node>();
  walkTree(program, null, null, (node) => {
    const init = node.type === 'VariableDeclarator' ? peeled(node.init) : null;
    if (node.type === 'FunctionDeclaration' && node.id !== null) named.set(nameOf(node.id), node);
    else if (init !== null && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') && (node.id as Node).type === 'Identifier') named.set(nameOf(node.id), init);
  });
  return named;
};
/** What a function returns: the body of an arrow that is an expression, or the value of each `return` in it. */
const returnedBy = (fn: Node): Node[] => {
  const body = fn.body as Node;
  if (body.type !== 'BlockStatement') return [body];
  const values: Node[] = [];
  walkTree(body, null, null, (node) => { if (node.type === 'ReturnStatement' && node.argument !== null) values.push(node.argument as Node); });
  return values;
};

/**
 * What a file makes a record source of: the makers (`SOURCE_MAKERS`, as imported under another name or taken by a name, and each
 * function declared in the file that returns a source) and the names and property paths that hold one: a name bound to one,
 * assigned one after it was declared, a property of an object made of one or assigned one, and a parameter of a function the file
 * calls with one. Returns whether an expression is a source.
 */
const recordSourcesIn = (program: Node): ((n: unknown) => boolean) => {
  const [makers, held, functions] = [new Set(SOURCE_MAKERS), new Set<string>(), functionsDeclaredIn(program)];
  const made = (n: unknown): boolean => {
    const e = peeled(n);
    const maker = e?.type === 'CallExpression' ? pathOf(e.callee) : null;
    return (maker !== null && makers.has(maker)) || (pathOf(e) !== null && held.has(pathOf(e)!));
  };
  let grew = true;
  const add = (into: Set<string>, name: string | null): void => { if (name !== null && !into.has(name)) { into.add(name); grew = true; } };
  const learn = (node: Node): void => {
    if (node.type === 'ImportSpecifier' && makers.has(nameOf(node.imported))) add(makers, nameOf(node.local));
    if (node.type === 'AssignmentExpression' && node.operator === '=' && made(node.right)) add(held, pathOf(node.left));
    if (node.type === 'VariableDeclarator') {
      const [id, init] = [pathOf(node.id), peeled(node.init)];
      if (id !== null && init !== null && pathOf(init) !== null && makers.has(pathOf(init)!)) add(makers, id);
      else if (id !== null && made(init)) add(held, id);
      for (const p of init?.type === 'ObjectExpression' ? (init.properties as Node[]) : []) if (id !== null && p.type === 'Property' && p.computed !== true && made(p.value)) add(held, `${id}.${nameOf(p.key)}`);
    }
    const passedTo = node.type === 'CallExpression' ? functions.get(pathOf(node.callee) ?? '') : undefined;
    ((passedTo?.params ?? []) as Node[]).forEach((param, i) => { if (made((node.arguments as Node[])[i])) add(held, pathOf(param)); });
  };
  while (grew) {
    grew = false;
    walkTree(program, null, null, learn);
    for (const [name, fn] of functions) if (returnedBy(fn).some(made)) add(makers, name);
  }
  return made;
};

/**
 * Each `.write(` `file` calls in its code on a record source made in the file, however the source is held: the maker's result, a
 * name it was bound or assigned to, a parameter of a function called with it, what a function the file declares returns, a property
 * of an object, or a maker imported under another name; a `write` taken off one by `.call`, `.apply` or `.bind`, or by a destructuring;
 * and a tree or manifest door made over one (`treeServiceOf`, `manifestServiceOf`, or either imported under another name), which
 * files headers and enters entries by writing on it.
 */
export const sourceWritesIn = (file: string, text: string): string[] => {
  if (!text.includes('write') && ![...WRITERS_OVER_A_SOURCE].some((n) => text.includes(n))) return [];
  const program = programOf(file, text);
  const made = recordSourcesIn(program);
  const writers = new Set(WRITERS_OVER_A_SOURCE);
  walkTree(program, null, null, (node) => { if (node.type === 'ImportSpecifier' && WRITERS_OVER_A_SOURCE.has(nameOf(node.imported))) writers.add(nameOf(node.local)); });
  const isWrite = (member: Node | null): member is Node =>
    member?.type === 'MemberExpression' && nameOf(member.property) === 'write' && (member.computed !== true || (member.property as Node).type === 'Literal');
  const found: string[] = [];
  walkTree(program, null, null, (node) => {
    const callee = peeled(node.callee);
    const taken = node.type === 'VariableDeclarator' && (node.id as Node).type === 'ObjectPattern' && made(node.init)
      && ((node.id as Node).properties as Node[]).some((p) => p.type === 'Property' && nameOf(p.key) === 'write');
    const called = node.type === 'CallExpression' && callee?.type === 'MemberExpression';
    const direct = called && isWrite(callee) && made(callee.object);
    const asked = called && ['call', 'apply', 'bind'].includes(nameOf(callee.property)) && isWrite(peeled(callee.object)) && made(peeled(callee.object)!.object);
    const wrapped = node.type === 'CallExpression' && writers.has(pathOf(node.callee) ?? '') && made((node.arguments as Node[])[0]);
    if (taken || direct || asked || wrapped) found.push(`${file}:${lineAt(text, node.start!)} writes on a record source${taken || direct || asked ? '' : THROUGH_A_DOOR}`);
  });
  return found;
};

const PAIRS_IN = 'packages/web-shared/src';
const THE_POPUPS_WINDOW = 'the page\'s window the wallet\'s popup opens on, not a company\'s view or send; the read is made with or without one';
const THE_VAULTS_CHAIN_VIEW = 'what the chain holds for one vault, read again from the chain when none is given; not a company\'s view or send';
/* The doors a reader may take with or without, none of them a company view or send: each file, the type it takes and why. */
const NOT_A_COMPANY_VIEW_PAIR: Readonly<Record<string, ReadonlyMap<string, string>>> = Object.freeze({
  'packages/web-shared/src/chain-before-a-view.ts': new Map([['Openable', THE_POPUPS_WINDOW]]),
  'packages/web-shared/src/company-creation.ts': new Map([['Openable', THE_POPUPS_WINDOW]]),
  'packages/web-shared/src/vault-notes-here.ts': new Map([['VaultChainView', THE_VAULTS_CHAIN_VIEW]]),
  'packages/web-shared/src/vault-payment-settled.ts': new Map([['VaultChainView', THE_VAULTS_CHAIN_VIEW]]),
  'packages/web-shared/src/vault-private-deposit.ts': new Map([['VaultChainView', THE_VAULTS_CHAIN_VIEW]]),
  'packages/web-shared/src/what-this-device-made.ts': new Map([['AccountLedgerView', 'the company account\'s ledger as the chain holds it, none when it was not read; not a company\'s view or send']]),
});

/* A `view`, `send` or `api` taken as optional or as `| undefined` or `| null` (either side), or a view's type taken so: the type it takes is whichever group matched. */
const OPTIONAL_PAIR = new RegExp([
  String.raw`\b(?:view|send|api)\s*\?\s*:\s*([^,;)=\n]*)`,
  String.raw`\b(?:view|send|api)\s*:\s*([^,;)=\n|]*?)\s*\|\s*(?:undefined|null)\b`,
  String.raw`\b(?:view|send|api)\s*:\s*(?:undefined|null)\s*\|\s*([^,;)=\n]*)`,
  String.raw`:\s*([A-Za-z_]*View(?:Held)?\b(?:<[^>]*>)?)\s*\|\s*(?:undefined|null)\b`,
  String.raw`:\s*(?:undefined|null)\s*\|\s*([A-Za-z_]*View(?:Held)?\b(?:<[^>]*>)?)`,
].join('|'), 'gu');
const typeTaken = (m: RegExpMatchArray): string => (m.slice(1).find((g) => g !== undefined) ?? '').trim();

/** Each place `file` takes a company's view or send as a with-or-without pair in its code, the doors named in `NOT_A_COMPANY_VIEW_PAIR` let through. */
export const optionalViewPairsIn = (file: string, text: string): string[] => {
  const code = codeOnly(file, text);
  return [...code.matchAll(OPTIONAL_PAIR)]
    .map((m) => ({ at: m.index, type: typeTaken(m) }))
    .filter((p) => NOT_A_COMPANY_VIEW_PAIR[file]?.has(p.type) !== true)
    .map((p) => `${file}:${lineAt(code, p.at)} takes an optional ${p.type}`);
};

const OPTIONAL_PAIR_OF = (code: string, type: string): boolean =>
  [...code.matchAll(OPTIONAL_PAIR)].some((m) => typeTaken(m) === type);

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
    expect(ways(`export * from ${transport}; const n = 'serviceAnswered';`)).toEqual(['imports serviceAnswered']);
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
    expect(secondWaysIn(page, "import { invitationOnPage, creationOnPage } from 'vaults-web-shared/asks-on-page.js';").map((w) => w.way))
      .toEqual(['imports invitationOnPage', 'imports creationOnPage']);
    expect(secondWaysIn('apps/web/src/adapters/join.ts', "import { invitationOnPage } from 'vaults-web-shared/asks-on-page.js';")).toEqual([]);
    expect(secondWaysIn('packages/web-shared/src/company-creation.ts', "import { creationOnPage } from './asks-on-page.js';")).toEqual([]);
    expect(secondWaysIn('apps/wallet/src/actions/upkeep.ts', "import { serviceSource } from 'x';")).toEqual([]);
    expect(secondWaysIn('apps/wallet/src/actions/upkeep.ts', "import { serviceCallOf } from 'x';").map((w) => w.way)).toEqual(['imports serviceCallOf']);
    for (const file of new Set(Object.values(NAMED_CALLERS).flatMap((s) => [...s.keys()]))) expect(statSync(join(ROOT, file)).isFile()).toBe(true);
    /* RED WHEN: a page file opens a view of its own beside the screen's, with no reason named for it. */
    expect(secondWaysIn(page, "import { readThroughAViewOf } from './filing-judge.js';").map((w) => w.way)).toEqual(['imports readThroughAViewOf']);
    expect(secondWaysIn('apps/web/src/adapters/deposit.ts', "import { readThroughAViewOf } from './filing-judge.js';")).toEqual([]);
  });

  it('refuses the makers of the asks and doors that reach the service with no view to any file but their named callers', () => {
    const makers = ['invitationSource', 'creationSource', 'provenHandedOver', 'superAdminAsks', 'creationAsks', 'personAsks', 'treeServiceOf', 'manifestServiceOf'];
    const step = 'apps/wallet/src/actions/x.ts';
    /* The records' own file as a wallet step names it; held apart from the import, so no reader of this file takes it for one. */
    const recordsSource = '../../../../packages/web-shared/src/records-source.js';
    /* RED WHEN: a file outside the records' own files makes an ask or a door of its own over the service, which nothing names. */
    for (const m of makers) expect(secondWaysIn(step, `import { ${m} } from '${recordsSource}';`).map((w) => w.way), m).toEqual([`imports ${m}`]);
    expect(secondWaysIn('apps/wallet/src/actions/run.ts', "import { creationSource, invitationSource } from 'x';")).toEqual([]);
    expect(secondWaysIn('packages/web-shared/src/invitation-taken-on-device.ts', "import { invitationSource } from './records-source.js';")).toEqual([]);
    expect(secondWaysIn('packages/web-shared/src/proving-worker-entry.ts', "import { provenHandedOver } from './records-source.js';")).toEqual([]);
    expect(secondWaysIn('packages/web-shared/src/invitation-taken-on-device.ts', "import { creationSource } from './records-source.js';").map((w) => w.way)).toEqual(['imports creationSource']);
  });

  it('names why beside every use of the invitee door, counted in each file, and finds the door however it is held', () => {
    const step = 'apps/wallet/src/actions/x.ts';
    const uses = (text: string): string[] => inviteeDoorUsesIn(step, text).map((x) => x.slice(0, -step.length - 1)).sort();
    /* RED WHEN: a step reads the company's directory or an invitation's offer through the invitee door, and the check does not see it, or sees two reads as one. */
    expect(uses('await ctx.invitations.filings(company);')).toEqual(['filings']);
    expect(uses('await ctx.invitations.offer(a);\nawait ctx.invitations.offer(b);')).toEqual(['offer', 'offer']);
    /* RED WHEN: the door is held under another name, taken apart, bound or passed on, and a read through it is not seen. */
    expect(uses('const door = ctx.invitations;\nawait door.offer(id);')).toEqual([HANDED_ON]);
    expect(uses('const { offer } = ctx.invitations;\nawait offer(id);')).toEqual([HANDED_ON]);
    expect(uses('const { invitations } = ctx;\nawait invitations.offer(id);')).toEqual([HANDED_ON, 'offer']);
    expect(uses('await ctx.invitations.offer.call(null, id);')).toEqual([HANDED_ON]);
    expect(uses('const f = ctx.invitations.filings.bind(ctx.invitations);')).toEqual([HANDED_ON, HANDED_ON]);
    expect(uses('take({ invitations: ctx.invitations }); give(ctx.invitations);')).toEqual([HANDED_ON, HANDED_ON]);
    /* A call of the door's own asks, a read on anything else, and a type that names the door are no use to name. */
    expect(uses('await ctx.invitations.acceptPayee(id, b); ctx.invitations.seatCall(i); view.filings(); kept.offer(id); interface S { readonly invitations: X }')).toEqual([]);
    const counted = (lines: readonly string[]): Map<string, number> => lines.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
    const found = counted(WHERE_THE_INVITEE_DOOR_GOES.flatMap(sourceFiles).flatMap((file) => inviteeDoorUsesIn(file, readFileSync(join(ROOT, file), 'utf8'))));
    const named = new Map(Object.entries(INVITEE_DOOR_USE_BY).flatMap(([use, by]) => [...by].map(([file, { times }]): [string, number] => [`${use} ${file}`, times])));
    /* RED WHEN: a file uses the invitee door in a way not named for it, or more times than named, so a company is read beside its view with no reason. */
    expect([...found].filter(([use, times]) => named.get(use) !== times)).toEqual([]);
    /* RED WHEN: a file is named for a use of the invitee door it no longer makes, so the list holds a reason for nothing. */
    expect([...named.keys()].filter((use) => !found.has(use))).toEqual([]);
    expect(Object.values(INVITEE_DOOR_USE_BY).flatMap((by) => [...by.values()]).filter(({ why }) => why.trim() === '')).toEqual([]);
  });

  it('lets the proving worker send to hand its proven call over, and name no service path of its own', () => {
    const worker = 'packages/web-shared/src/proving-worker-entry.ts';
    expect(secondWaysIn(worker, 'const r = await fetchImpl(path); sendOver(scope.fetch.bind(scope)); preimageOver(scope.fetch.bind(scope));')).toEqual([]);
    expect(secondWaysIn(worker, 'httpKeyMaterialSource(base, { cache, fetchImpl: scope.fetch.bind(scope) });')).toEqual([]);
    /* RED WHEN: a send of the worker's that is not the hand-over's, nor one named for what it asks, is let through. */
    expect(secondWaysIn(worker, 'const g = scope.fetch.bind(scope); other(scope.fetch); const r = await fetch(u);').map((w) => w.way))
      .toEqual(['sends by itself (fetch)', 'sends by itself (fetch)', 'sends by itself (fetch)']);
    /* RED WHEN: the worker names a service path of its own, so it can send to any route beside the hand-over. */
    expect(secondWaysIn(worker, "sendOver(fetch); const p = '/api/accounts/x/records';").map((w) => w.way)).toEqual(['names a service path']);
    expect(secondWaysIn(worker, "import { serviceCall } from './service-transport.js';").map((w) => w.way)).toEqual(['imports serviceCall']);
    expect(Object.hasOwn(NOT_THE_COMPANYS_SERVICE, worker)).toBe(false);
    for (const [file, { why }] of Object.entries(WORKER_HAND_OVER)) {
      expect(statSync(join(ROOT, file)).isFile()).toBe(true);
      expect(why.trim()).not.toEqual('');
    }
    /* RED WHEN: a send is named for a function nothing in the file hands a send to, so the list holds a reason for nothing. */
    for (const [file, by] of Object.entries(SENDS_NOT_TO_THE_SERVICE)) {
      const to = new Set(sendsIn(file, readFileSync(join(ROOT, file), 'utf8')).map((m) => m.to));
      expect([...by].filter(([name, why]) => !to.has(name) || why.trim() === '').map(([name]) => name), file).toEqual([]);
      expect(to.has(WORKER_HAND_OVER[file]?.to ?? null), file).toBe(true);
    }
  });

  it('names why beside every file a ready-made source or a view of its own is let through to', () => {
    const unnamed = Object.entries(NAMED_CALLERS).flatMap(([name, callers]) => [...callers].filter(([, why]) => why.trim() === '').map(([file]) => `${name} ${file}`));
    /* RED WHEN: a file is let read around the screen's view with no reason written beside it. */
    expect(unnamed).toEqual([]);
  });

  it('refuses a reader that takes a company view or send as a with-or-without pair, and lets through only the doors named', () => {
    const page = 'packages/web-shared/src/x.ts';
    expect(optionalViewPairsIn(page, 'export const read = (id: string, view?: CompanyView) => id;')).toEqual([`${page}:1 takes an optional CompanyView`]);
    expect(optionalViewPairsIn(page, 'interface Doors { readonly send?: (path: string) => Promise<unknown>; readonly api?: ServiceCall }')).toHaveLength(2);
    expect(optionalViewPairsIn(page, 'const f = (given: CompanyView | undefined, held: ViewHeld<X> | undefined) => given;')).toHaveLength(2);
    /* RED WHEN: a view or send taken as `| null`, or with the empty side first, passes as a door that is always given. */
    expect(optionalViewPairsIn(page, 'const f = (view: CompanyView | null, send: null | ServiceCall, api: Api | undefined, other: undefined | PageView) => 1;')).toHaveLength(4);
    expect(optionalViewPairsIn(page, '/* view?: CompanyView */ const f = (view: CompanyView) => view; const s = { send: g };')).toEqual([]);
    for (const [file, types] of Object.entries(NOT_A_COMPANY_VIEW_PAIR)) {
      for (const type of types.keys()) expect(optionalViewPairsIn(file, `const f = (view?: ${type}) => 1;`), `${file} ${type}`).toEqual([]);
      expect(optionalViewPairsIn(file, 'const f = (view?: CompanyView) => 1;')).toHaveLength(1);
      expect([...types.values()].every((why) => why.trim() !== '')).toBe(true);
    }
    /* RED WHEN: a file in the shared code takes a company's view or send as optional, so a read can go with the view or around it. */
    const files = sourceFiles(PAIRS_IN);
    expect(files.flatMap((file) => optionalViewPairsIn(file, readFileSync(join(ROOT, file), 'utf8')))).toEqual([]);
    /* RED WHEN: a door named as let through is no longer taken as optional where it is named, so the list holds a reason for nothing. */
    for (const [file, types] of Object.entries(NOT_A_COMPANY_VIEW_PAIR)) {
      const code = codeOnly(file, readFileSync(join(ROOT, file), 'utf8'));
      for (const type of types.keys()) expect(OPTIONAL_PAIR_OF(code, type), `${file} ${type}`).toBe(true);
    }
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

  it('finds no test that writes on a record source, directly or through a tree or manifest door made over one, but the files named with why', () => {
    const test = 'src/server/x.test.ts';
    /* RED WHEN: a test writes on a source made over the service, directly or through a name it was bound to, with no check before the write. */
    expect(sourceWritesIn(test, 'await serviceSource(call, co).write(w);')).toEqual([`${test}:1 writes on a record source`]);
    expect(sourceWritesIn(test, 'const s = serviceSource(call, co);\nawait s.write(w);')).toEqual([`${test}:2 writes on a record source`]);
    expect(sourceWritesIn(test, 'const s = await sourceOnPage(co); await s["write"](w);')).toHaveLength(1);
    expect(sourceWritesIn(test, 'const s = sourceOf(doors); s.write(w);')).toHaveLength(1);
    /* RED WHEN: a write on a record source is hidden by how the source is held: assigned after its declaration, passed in as a parameter, returned by a helper, destructured, held in a property, made by a maker imported under another name, or written through `.call`. */
    const at = (line: number): string[] => [`${test}:${line} writes on a record source`];
    expect(sourceWritesIn(test, 'let s;\ns = serviceSource(call, co);\nawait s.write(w);')).toEqual(at(3));
    expect(sourceWritesIn(test, 'const put = (s) => s.write(w);\nput(serviceSource(call, co));')).toEqual(at(1));
    expect(sourceWritesIn(test, 'function put(s) { return s.write(w); }\nput(sourceOf(doors));')).toEqual(at(1));
    expect(sourceWritesIn(test, 'const src = serviceSource(call, co);\nconst put = (s) => s.write(w);\nput(src);')).toEqual(at(2));
    expect(sourceWritesIn(test, 'const mk = () => serviceSource(call, co);\nconst s = mk();\ns.write(w);')).toEqual(at(3));
    expect(sourceWritesIn(test, 'function mk() { return sourceOf(doors); }\nmk().write(w);')).toEqual(at(2));
    expect(sourceWritesIn(test, 'const { write } = serviceSource(call, co);\nwrite(w);')).toEqual(at(1));
    expect(sourceWritesIn(test, 'const holder = { source: serviceSource(call, co) };\nholder.source.write(w);')).toEqual(at(2));
    expect(sourceWritesIn(test, 'const holder = {};\nholder.source = serviceSource(call, co);\nholder.source.write(w);')).toEqual(at(3));
    expect(sourceWritesIn(test, "import { serviceSource as ss } from './x.js';\nss(call, co).write(w);")).toEqual(at(2));
    expect(sourceWritesIn(test, 'const s = serviceSource(call, co);\ns.write.call(s, w);')).toEqual(at(2));
    expect(sourceWritesIn(test, 'const s = serviceSource(call, co);\nawait s.write.apply(s, [w]);')).toEqual(at(2));
    /* RED WHEN: a tree or manifest door made over a record source files a header or enters an entry, and no write is seen. */
    const door = (line: number): string[] => [`${test}:${line} writes on a record source${THROUGH_A_DOOR}`];
    expect(sourceWritesIn(test, 'const tree = treeServiceOf(serviceSource(call, co));')).toEqual(door(1));
    expect(sourceWritesIn(test, "import { manifestServiceOf as m } from './x.js';\nconst s = serviceSource(call, co);\nawait m(s).enter(co, e);")).toEqual(door(3));
    expect(sourceWritesIn(test, 'const tree = treeServiceOf(view); const m = manifestServiceOf(source);')).toEqual([]);
    /* RED WHEN: a write on a view, or on anything that is not a record source, is found for the way a source is held. */
    expect(sourceWritesIn(test, 'const put = (s) => s.write(w);\nput(view);')).toEqual([]);
    expect(sourceWritesIn(test, 'const mk = () => view;\nmk().write(w);')).toEqual([]);
    expect(sourceWritesIn(test, 'const { write } = view;\nwrite(w);')).toEqual([]);
    expect(sourceWritesIn(test, 'const holder = { source: view };\nholder.source.write(w);')).toEqual([]);
    expect(sourceWritesIn(test, '// serviceSource(call, co).write(w)\nconst v = companyViewFor(serviceSource(call, co), d, h); await v.write([w]); kept.write(co, x);')).toEqual([]);
    const files = [...SCANNED, 'src', 'contracts/test'].flatMap(everyFile).filter(isTestFile);
    const named = 'src/server/record-manifest-route.test.ts';
    /* RED WHEN: a write straight on a source passes in a file named only for writing through a door. */
    expect(writesNotNamed([`${named}:9 writes on a record source`, `${named}:9 writes on a record source${THROUGH_A_DOOR}`])).toEqual([`${named}:9 writes on a record source`]);
    const writes = files.flatMap((file) => sourceWritesIn(file, readFileSync(join(ROOT, file), 'utf8')));
    /* RED WHEN: a file writes on a record source with no name, or in a way it is not named for. */
    expect(writesNotNamed(writes)).toEqual([]);
    /* RED WHEN: a file is named for a way of writing on a source it no longer makes, so the entry would let a new write through unseen. */
    expect(Object.entries(WRITES_ON_A_SOURCE).flatMap(([file, { how }]) => how.filter((h) => !writes.some((w) => w.split(':')[0] === file && howOf(w) === h)).map((h) => `${file} ${h}`))).toEqual([]);
    expect(Object.entries(WRITES_ON_A_SOURCE).filter(([file, { why }]) => why.trim() === '' || !fileHere(file))).toEqual([]);
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
