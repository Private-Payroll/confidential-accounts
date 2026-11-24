/**
 * What an action may ask the service for is a list the wallet enforces (`ACT_INTENTS`, each intent's `calls`), and a
 * `sends: true` mark is what makes a call count as a transaction handed over. This reads the wallet's action files and
 * the service's route files as text, with comments blanked, and holds the lists to both: an action asks for exactly
 * what its intent lists, every listed route is answered by the service and its router is mounted, and a listed route is
 * marked `sends` exactly when its handler hands a transaction to the chain.
 *
 * An action asks the service in its own file in two ways: a call written there (`ctx.call('POST', `...`)`), or a named
 * ask the runner hands the step over its call (`ctx.invitations.offer(...)`, `ctx.creation.payKey(...)`). The route of
 * a named ask is never read from its text: each ask is run here against a stand-in that records the one route it
 * sends, so an ask whose route changes is held to the list with it. A proposal kind's file is held to the list of the
 * action that runs it.
 *
 * What it does not cover, on purpose. Only four actions ask for everything in the action file; the others reach the
 * service through shared page code too, so for them it checks only that every route asked in the file is listed, and
 * that every `/api/` path an action file names is listed (the one path ending in a variable vault step is checked up to
 * that step). Whether a handler hands a transaction to the
 * chain is read by the name of the helper it calls: a helper renamed to something this list does not hold makes a
 * `sends` route read as not sending, so that direction is weaker than the other. And that a listed route answers
 * something other than "not found" needs the running service, which is not built here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ACT_INTENTS, FINISH_COMPANY_RELAYS, type CallRoute } from './act-intents.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ACTIONS = path.join(REPO, 'apps', 'wallet', 'src', 'actions');
const SERVER = path.join(REPO, 'src', 'server');

/** The text with every comment turned to blanks (lines kept), strings and regular expressions left whole. */
const codeOf = (text: string): string => {
  let out = '';
  let last = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/gu, ' ');
      i = stop;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      last = 'x';
      continue;
    }
    if (c === '/' && (last === '' || '(,=:[!&|?{};'.includes(last))) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const ch = text[j]!;
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      last = 'x';
      continue;
    }
    out += c;
    if (!/\s/u.test(c)) last = c;
    i += 1;
  }
  return out;
};

/** Where the call opened at `open` closes, skipping strings and regular expressions; the end of the text when it never does. */
const endOfCall = (code: string, open: number): number => {
  let depth = 0;
  let last = '(';
  let i = open;
  while (i < code.length) {
    const c = code[i]!;
    if (c === '\'' || c === '"' || c === '`') {
      i += 1;
      while (i < code.length && code[i] !== c) i += code[i] === '\\' ? 2 : 1;
      i += 1;
      last = 'x';
      continue;
    }
    if (c === '/' && '(,=:[!&|?{};'.includes(last)) {
      let inClass = false;
      i += 1;
      while (i < code.length) {
        const ch = code[i]!;
        if (ch === '\\') { i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        i += 1;
      }
      i += 1;
      last = 'x';
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    if (!/\s/u.test(c)) last = c;
    i += 1;
  }
  return code.length;
};

const lineOf = (code: string, at: number): number => code.slice(0, at).split('\n').length;
const shapeOf = (route: string): string => route.split('?')[0]!.split('/').map((s) => (s.startsWith(':') ? ':' : s)).join('/');
const asked = (route: string): string => shapeOf(route.replace(/\$\{[^}]*\}/gu, ':'));

interface Intent { readonly calls?: readonly CallRoute[]; readonly relays?: readonly string[] }
const INTENTS = ACT_INTENTS as unknown as Readonly<Record<string, Intent>>;
const NAMES = Object.keys(INTENTS);

const key = (method: string, shape: string): string => `${method} ${shape}`;

/** The intent's calls as distinct method and shape pairs; a route listed twice through a shared list counts once. */
const listedBy = (name: string): Map<string, { sends: boolean }> => {
  const found = new Map<string, { sends: boolean }>();
  for (const c of INTENTS[name]?.calls ?? []) found.set(key(c.method, shapeOf(c.path)), { sends: c.sends === true });
  return found;
};

const read = (file: string): string => codeOf(readFileSync(file, 'utf8'));

/* The id every ask is run with here, read back as a route's variable step. */
const SAMPLE = 'sample_id';
const sampled = (method: string, sent: string): string =>
  key(method, shapeOf(sent.split('?')[0]!.split('/').map((s) => (s === SAMPLE ? ':' : s)).join('/')));

/* The shared files an action's named asks live in, loaded as the wallet loads them (outside this package's sources). */
const shared = (file: string): Promise<Record<string, any>> =>
  import(pathToFileURL(path.join(REPO, 'packages', 'web-shared', 'src', file)).href) as Promise<Record<string, any>>;
const { invitationSource, creationSource, serviceSource } = await shared('records-source.ts');
const RECORDS_SOURCE = readFileSync(path.join(REPO, 'packages', 'web-shared', 'src', 'records-source.ts'), 'utf8');

/** The one route `run` sends through a stand-in call that records it; refused when it sends none, or more than one. */
const routeOfAsk = async (what: string, run: (seen: string[]) => Promise<unknown>): Promise<string> => {
  const seen: string[] = [];
  await run(seen).catch(() => undefined);
  if (seen.length !== 1) throw new Error(`${what} sent ${seen.length} routes where one was expected, so this check cannot read it`);
  return seen[0]!;
};
/* A stand-in call that records the route it is asked, answering as the service answers a read it takes. */
const recorder = (seen: string[]) => (method: string, sent: string) => { seen.push(sampled(method, sent)); return Promise.resolve({ status: 200, body: {} }); };
const invitationAsk = (name: string): Promise<string> => routeOfAsk(`invitationSource().${name}`, (seen) => invitationSource(recorder(seen))[name](SAMPLE, {}));
const creationAsk = (name: string): Promise<string> => routeOfAsk(`creationSource().${name}`, (seen) => creationSource(recorder(seen))[name](SAMPLE, {}));

/* Every ask an action makes over the step's call, by its name: a call written there, or a named ask the runner handed it (an invitation's call to take a seat names the send to the gate, and asks nothing). */
/* Every form an action asks through: the call itself, a named ask, a record source or its call adapter, and the invitation asks handed on whole. */
const ASKS = /\bctx\.(?:call\b|invitations\.(?!seatCall\b)\w+\(|creation\.\w+\()|\bserviceSource\(|\bserviceCallOver\(|\bctx\.invitations\b(?!\.)/gu;

/* A file that hands `ctx.invitations` on whole names here the function it hands them to, so its asks are read in that function. */
const HANDED_ON_TO: Readonly<Record<string, { readonly file: string; readonly fn: string }>> = {
  'add-signer-by-code.ts': { file: path.join(REPO, 'packages', 'web-shared', 'src', 'invitation-by-code.ts'), fn: 'addSignerFromCodeHere' },
};

const sampledAny = (method: string, sent: string): string =>
  key(method, shapeOf(sent.split('?')[0]!.split('/').map((s, i, all) => (s === SAMPLE || /^\d+$/u.test(s) || (all[i - 1] === 'records' && s !== 'read') ? ':' : s)).join('/')));

const unionOf = (name: string): string[] => {
  const m = RECORDS_SOURCE.match(new RegExp(`export type ${name} =\\s*([^;]*);`, 'u'));
  if (m === null) throw new Error(`the type ${name} could not be read from the record source`);
  return [...m[1]!.matchAll(/'([a-z-]+)'/gu)].map((x) => x[1]!);
};

/* One write for each way the record source writes; the route each takes is read by running the real source over a recorder. */
const WRITES = (): Record<string, unknown>[] => {
  const body = {};
  const header = { seq: 1 };
  return [
    { to: 'entries', entries: [] }, { to: 'header', header }, { to: 'directory', filing: { version: 1 } },
    { to: 'record', kind: 'policy', id: SAMPLE, version: 1, body }, { to: 'vault-record', vault: SAMPLE, record: 'notes', version: 1, body },
    { to: 'roster', body }, { to: 'vault-keys', body }, { to: 'admission', signer: SAMPLE, body }, { to: 'readers', body },
    { to: 'proposal-filed', body }, ...unionOf('ProposalAct').map((act) => ({ to: 'proposal', id: SAMPLE, act, body })),
    { to: 'carried', id: SAMPLE, body }, { to: 'proven', tx: SAMPLE },
    { to: 'vault-send', tx: SAMPLE, calls: [{ act: 'deploy' }] },
    ...['handover', 'deposit', 'public-deposit', 'payout', 'merge', 'public-payout'].map((act) => ({ to: 'vault-send', tx: SAMPLE, calls: [{ act, vault: SAMPLE }] })),
    { to: 'invitation', body }, { to: 'signer-withdrawn', signer: SAMPLE, body },
    ...['status', 'details', 'admit'].map((act) => ({ to: 'person', id: SAMPLE, act, body })),
    { to: 'run', body }, { to: 'vendor-admitted', id: SAMPLE, body }, { to: 'fee', body }, { to: 'fee-done', body }, { to: 'self-payee', body },
    ...unionOf('VaultStartStep').map((step) => ({ to: 'vault-start', vault: SAMPLE, step, body })),
    ...['signatures', 'send'].map((act) => ({ to: 'committee-change', act, body })),
  ];
};

/* The arguments each reading method of the record source is run with. */
const READS: Readonly<Record<string, readonly unknown[][]>> = {
  account: [[]], filings: [[]], newest: [[['sample']]], pending: [['0x00']], proofs: [[{ records: [] }]], headers: [[0, 1]],
  records: [[[]]], vaultRecords: [[[]]], handovers: [[[]]], vendorHandovers: [[[]]],
  list: [...RECORDS_SOURCE.match(/const LIST_KINDS = \[([^\]]*)\]/u)![1]!.matchAll(/'([a-z-]+)'/gu)].map((m) => [m[1]!]),
  standing: [[SAMPLE]], callState: [[]], vaultChain: [[SAMPLE]], payoutState: [[SAMPLE]], authority: [[]], committeeChange: [[]], vaultKeys: [[]],
};

/** Every route the record source asks, read by running its reads and each of its writes over a recorder. */
const sourceRoutes = async (): Promise<{ readonly routes: string[]; readonly writes: Record<string, unknown>[] }> => {
  const seen: string[] = [];
  const source = serviceSource((sent: string, init?: { method?: string }) => {
    seen.push(sampledAny(String(init?.method ?? 'GET').toUpperCase(), sent));
    return Promise.resolve({});
  }, SAMPLE) as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const writes = WRITES();
  const runs: (() => Promise<unknown>)[] = [];
  for (const name of Object.keys(source).filter((n) => typeof source[n] === 'function' && n !== 'write')) {
    const withArgs = READS[name];
    if (withArgs === undefined) throw new Error(`the record source reads with ${name}, which this check does not run`);
    for (const args of withArgs) runs.push(() => source[name]!(...args));
  }
  for (const w of writes) runs.push(() => source['write']!(w));
  for (const run of runs) {
    const before = seen.length;
    await run().catch(() => undefined);
    if (seen.length !== before + 1) throw new Error(`a call of the record source sent ${seen.length - before} routes where one was expected, so this check cannot read it`);
  }
  return { routes: seen, writes };
};

/* Every route the record source can ask, and what the company view reads or writes through it. The source is the view's one way to the service, the same for every action, so no action's intent holds it. */
const SOURCE_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  'GET /api/accounts/:': 'the company\'s account record, read for who holds it and how it stands',
  'GET /api/accounts/:/authority': 'who holds the company\'s account on the chain, read to see where it is held',
  'GET /api/accounts/:/call-state': 'the account\'s state before a call, read to build the call on it',
  'GET /api/accounts/:/committee-change': 'the change of the account\'s committee that is owed, read to show it and sign it',
  'GET /api/accounts/:/directory': 'the company\'s directory of seats, read to know who is seated',
  'GET /api/accounts/:/invites': 'the invitations the company has made, read for the people list',
  'GET /api/accounts/:/manifest/tree/headers': 'the record headers anchored so far, read to follow the company\'s records',
  'GET /api/accounts/:/manifest/tree/pending': 'the record entries not yet anchored, read to anchor them',
  'GET /api/accounts/:/people': 'the company\'s people, read for the people list',
  'GET /api/accounts/:/proposals': 'the company\'s proposals, read for the proposals list',
  'GET /api/accounts/:/runs': 'the company\'s payment runs, read for the runs list',
  'GET /api/accounts/:/vault-keys': 'the vault keys the company holds, read to give them to a seat',
  'GET /api/accounts/:/vault-keys/offers': 'the vault keys offered to the company, read to take them in',
  'GET /api/accounts/:/vaults': 'the company\'s vaults, read for the vaults list',
  'GET /api/accounts/:/vaults/:/chain': 'what the chain holds for one vault, read before a vault step',
  'GET /api/accounts/:/vaults/:/payout-state': 'where a vault\'s payout stands, read before paying',
  'POST /api/accounts/:/committee-change/send': 'the signed change of the account\'s committee, sent to the chain',
  'POST /api/accounts/:/committee-change/signatures': 'a seat\'s signature on the change of the account\'s committee, filed',
  'POST /api/accounts/:/fee': 'a fee the company sponsors, asked for',
  'POST /api/accounts/:/fee/done': 'a sponsored fee, reported paid',
  'POST /api/accounts/:/handovers': 'what each person or vendor handed over, read in one batch',
  'POST /api/accounts/:/invites': 'an invitation to a seat or a payee, filed',
  'POST /api/accounts/:/manifest/entries': 'entries of the company\'s records, filed',
  'POST /api/accounts/:/manifest/newest': 'the newest version entered of each record, read in one batch',
  'POST /api/accounts/:/manifest/tree/headers': 'a header of the company\'s records, filed',
  'POST /api/accounts/:/manifest/tree/proofs': 'the proofs of records against an anchored root, read in one batch',
  'POST /api/accounts/:/proposals': 'a proposal, filed',
  'POST /api/accounts/:/proven': 'a proven transaction, handed over to be sent',
  'POST /api/accounts/:/readers': 'the list of readers the signers granted, filed',
  'POST /api/accounts/:/records/read': 'the company\'s records, read in one batch',
  'POST /api/accounts/:/roster': 'the company\'s roster, filed',
  'POST /api/accounts/:/runs': 'a payment run, filed',
  'POST /api/accounts/:/self-payee': 'a person making themselves payable, filed',
  'POST /api/accounts/:/signers/:/admit': 'a signer\'s admission, filed',
  'POST /api/accounts/:/signers/:/withdraw': 'a signer\'s withdrawal, filed',
  'POST /api/accounts/:/vault-records/read': 'the vaults\' records, read in one batch',
  'POST /api/accounts/:/vaults': 'a new vault\'s creation, sent',
  'POST /api/accounts/:/vaults/:/deposit': 'a private deposit into a vault, sent',
  'POST /api/accounts/:/vaults/:/handover': 'a vault\'s handover to the company\'s keys, sent',
  'POST /api/accounts/:/vaults/:/merge': 'a merge of a vault\'s notes, sent',
  'POST /api/accounts/:/vaults/:/payout': 'a private payout from a vault, sent',
  'POST /api/accounts/:/vaults/:/public-deposit': 'a public deposit into a vault, sent',
  'POST /api/accounts/:/vaults/:/public-payout': 'a public payout from a vault, sent',
  'POST /api/accounts/:/vaults/:/start/account': 'the first step of starting a vault, sent',
  'POST /api/accounts/:/vaults/:/start/copy': 'the copy step of starting a vault, sent',
  'POST /api/accounts/:/vaults/:/start/secret': 'the secret step of starting a vault, sent',
  'POST /api/accounts/:/vendors/:/admit': 'a vendor\'s admission, filed',
  'POST /api/employees/:/admit': 'an employee\'s admission, filed',
  'POST /api/people/:/details': 'a person\'s details, filed',
  'POST /api/people/:/status': 'a person\'s status, filed',
  'POST /api/proposals/:/approve': 'a seat\'s approval of a proposal, sent',
  'POST /api/proposals/:/cancel': 'a proposal\'s withdrawal, sent',
  'POST /api/proposals/:/carried': 'a proposal carried out, reported',
  'POST /api/proposals/:/carry': 'a proposal carried out, sent',
  'POST /api/proposals/:/charge': 'a run\'s charge, sent',
  'POST /api/proposals/:/closed': 'a proposal closed, reported',
  'POST /api/proposals/:/retirement': 'a vault\'s retirement, sent',
  'POST /api/proposals/:/send': 'a proposal\'s raise, sent',
  'POST /api/proposals/:/standing': 'where a proposal stands, read',
  'PUT /api/accounts/:/directory/:': 'a version of the company\'s directory, filed',
  'PUT /api/accounts/:/records/:/:/:': 'a version of a company record, filed',
  'PUT /api/accounts/:/vault-keys': 'the vault keys given to a seat, filed',
  'PUT /api/vaults/:/records/:/:': 'a version of a vault\'s record, filed',
});

/** The routes a file hands its invitation asks on to: those the file that asks through them names. */
const handedOnRoutes = async (file: string, code: string): Promise<string[]> => {
  const to = HANDED_ON_TO[file];
  if (to === undefined) throw new Error(`${file} hands its invitation asks on to a function this check is not told of`);
  expect(code, `${file} no longer calls ${to.fn}`).toMatch(new RegExp(`\\b${to.fn}\\(`, 'u'));
  const whole = read(to.file);
  const from = whole.search(new RegExp(`function ${to.fn}\\(`, 'u'));
  if (from < 0) throw new Error(`${to.fn} is not in ${path.basename(to.file)}`);
  const body = whole.slice(from, whole.indexOf('\nexport ', from) < 0 ? undefined : whole.indexOf('\nexport ', from));
  return Promise.all([...body.matchAll(/\.invitations\.(?!seatCall\b)(\w+)\(/gu)].map((m) => invitationAsk(m[1]!)));
};

const askedIn = async (code: string, file: string): Promise<{ readonly literal: string[]; readonly all: string[]; readonly forms: number }> => {
  const literal = [...code.matchAll(/\bctx\.call\(\s*['"`](GET|PUT|POST)['"`]\s*,\s*`([^`]*)`/gu)].map((m) => key(m[1]!, asked(m[2]!)));
  const invited = [...code.matchAll(/\bctx\.invitations\.(?!seatCall\b)(\w+)\(/gu)].map((m) => invitationAsk(m[1]!));
  const created = [...code.matchAll(/\bctx\.creation\.(\w+)\(/gu)].map((m) => creationAsk(m[1]!));
  const handedOnForms = (code.match(/\bctx\.invitations\b(?!\.)/gu) ?? []).length;
  const handedOn = handedOnForms > 0 ? await handedOnRoutes(file, code) : [];
  const sourceForms = (code.match(/\bserviceSource\(|\bserviceCallOver\(/gu) ?? []).length;
  return {
    literal, all: [...literal, ...await Promise.all([...invited, ...created]), ...handedOn],
    forms: literal.length + invited.length + created.length + handedOnForms + sourceForms,
  };
};

describe('an action asks the service only for the routes its intent lists', () => {
  const files = readdirSync(ACTIONS).filter((f) => /\.tsx?$/u.test(f) && !/\.test[.-]/u.test(f));
  const sources = new Map(files.map((f) => [f, read(path.join(ACTIONS, f))] as const));
  /* Each file's calls written there (`WRITTEN`), and every route it asks for, those and its named asks' (`CALLED`). */
  const WRITTEN = new Map<string, string[]>();
  const CALLED = new Map<string, string[]>();
  /* The forms this check parsed in each file, to hold against every form the file spells. */
  const PARSED = new Map<string, number>();
  beforeAll(async () => {
    for (const [file, code] of sources) {
      const { literal, all, forms } = await askedIn(code, file);
      if (literal.length > 0) WRITTEN.set(file, literal);
      if (all.length > 0) CALLED.set(file, all);
      PARSED.set(file, forms);
    }
  });
  const NAMED_IN_THE_ACTION = ['claim-by-address', 'join-by-code', 'seat-invited', 'finish-company'];
  /* The action a file's asks are made for: its own name, or, for a proposal kind's file, the action that runs the kind. */
  const KIND_OF: Readonly<Record<string, string>> = { 'pay-key-kind': 'approve-proposal' };
  const actionOf = (file: string): string => KIND_OF[file.replace(/\.tsx?$/u, '')] ?? file.replace(/\.tsx?$/u, '');

  it('claims, joins, seats by invitation and finishing a company ask for exactly the routes they list, no more and no fewer', () => {
    /* RED WHEN: a wallet action asks the service for a route its list does not name, or its list names one it never asks. */
    for (const name of NAMED_IN_THE_ACTION) {
      const listed = [...listedBy(name).keys()].sort();
      const calls = CALLED.get(`${name}.ts`) ?? [];
      expect(listed.length, `${name} lists no calls`).toBeGreaterThan(0);
      expect([...new Set(calls)].sort(), name).toEqual(listed);
    }
  });

  it('every form an action file asks through is one this check read', () => {
    /* RED WHEN: an action file asks through a form of the step's call, a named ask or a record source that this check does not parse. */
    const unread = [...sources].filter(([file, code]) => (code.match(ASKS) ?? []).length !== PARSED.get(file)).map(([file]) => file);
    expect(unread).toEqual([]);
    expect([...PARSED.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(NAMED_IN_THE_ACTION.length);
  });

  it('the files that build the record source or its call adapter are the ones this check names', () => {
    /* RED WHEN: an action file starts building the record source or its call adapter, so asks through it need reading and listing. */
    const builders = [...sources].filter(([, code]) => /\bserviceSource\(|\bserviceCallOver\(/u.test(code)).map(([file]) => file).sort();
    expect(builders).toEqual(['run.ts', 'step-views.ts', 'upkeep.ts']);
  });

  it('the routes the record source and its builders can ask are the routes listed for it, no more and no fewer', async () => {
    /* RED WHEN: the record source asks a route no list names, or a route listed for it is no longer asked. */
    const builders = [...sources].filter(([, code]) => /\bserviceSource\(/u.test(code)).map(([file]) => file);
    expect(builders.length, 'no action file builds the record source').toBeGreaterThan(0);
    const { routes, writes } = await sourceRoutes();
    const written = RECORDS_SOURCE.slice(RECORDS_SOURCE.indexOf('const written = '), RECORDS_SOURCE.indexOf('export const serviceSource'));
    const covered = new Set(writes.map((w) => w['to']));
    expect([...written.matchAll(/^ {4}case '([a-z-]+)':/gmu)].map((m) => m[1]!).filter((c) => !covered.has(c)), 'a write of the record source this check does not run').toEqual([]);
    const asked = new Set(routes);
    expect([...asked].filter((r) => !Object.hasOwn(SOURCE_ROUTES, r)).sort()).toEqual([]);
    expect(Object.keys(SOURCE_ROUTES).filter((r) => !asked.has(r)).sort()).toEqual([]);
    expect(Object.values(SOURCE_ROUTES).filter((why) => why.trim() === '')).toEqual([]);
  });

  it('no other action writes a call in its own file, since only these are held to their file', () => {
    /* RED WHEN: an action starts asking the service by a call written in its own file and no check holds it to its list. */
    expect([...WRITTEN.keys()].filter((f) => !NAMED_IN_THE_ACTION.includes(f.replace(/\.tsx?$/u, ''))).sort()).toEqual([]);
  });

  it('every other action that asks through a named ask in its own file asks only for routes its intent lists', () => {
    /* RED WHEN: an action asks the service, through a named ask, for a route its intent's list does not name. */
    const unlisted = [...CALLED].filter(([f]) => !NAMED_IN_THE_ACTION.includes(f.replace(/\.tsx?$/u, '')))
      .flatMap(([f, calls]) => calls.filter((c) => !listedBy(actionOf(f)).has(c)).map((c) => `${f}: ${c}`));
    expect(unlisted).toEqual([]);
    expect(CALLED.size).toBeGreaterThan(NAMED_IN_THE_ACTION.length);
  });

  it('every service path an action file names is a route some intent lists', () => {
    /* RED WHEN: an action file names a service path that no intent lists, so the wallet would refuse it while running. */
    const everyShape = new Set<string>();
    for (const name of NAMES) for (const k of listedBy(name).keys()) everyShape.add(k.slice(k.indexOf(' ') + 1));
    const unlisted: string[] = [];
    for (const [file, code] of sources) {
      for (const m of code.matchAll(/(['"`])(\/api\/[^'"`]*)\1/gu)) {
        const spelled = m[2]!.split('?')[0]!.replace(/\$\{[^}]*\}/gu, ':');
        const dynamicStep = spelled.indexOf('::');
        const shape = shapeOf(spelled);
        const ok = dynamicStep < 0
          ? everyShape.has(shape)
          : [...everyShape].some((s) => s.startsWith(`${shapeOf(spelled.slice(0, dynamicStep + 1))}/`));
        if (!ok) unlisted.push(`${file}:${lineOf(code, m.index ?? 0)} ${shape}`);
      }
    }
    expect(unlisted).toEqual([]);
  });
});

interface Answer { readonly file: string; readonly line: number; readonly handler: string }

const serverFiles = readdirSync(SERVER).filter((f) => f.endsWith('.ts') && !/\.test/u.test(f));
const serverCode = new Map(serverFiles.map((f) => [f, read(path.join(SERVER, f))] as const));

/** Every route the service's files answer, by method and shape, with the text of the handler that answers it: from its registration to the end of that call, so a helper written below the last route is not read as its handler. */
const answers = new Map<string, Answer[]>();
for (const [file, code] of serverCode) {
  const bases = new Map<string, string>();
  for (const m of code.matchAll(/\bconst\s+(\w+)\s*=\s*(`[^`]*`|'[^']*')\s*;/gu)) bases.set(m[1]!, m[2]!.slice(1, -1));
  const spelled = (s: string): string => s.replace(/\$\{(\w+)\}/gu, (whole, name: string) => bases.get(name) ?? whole);
  const here = [...code.matchAll(/\b(router|r|app)\s*\.\s*(get|post|put|delete|patch|use)\(\s*(`[^`]*`|'[^']*'|"[^"]*"|[A-Za-z_]\w*)/gu)];
  here.forEach((m, i) => {
    if (m[2] === 'use' || m[2] === 'delete' || m[2] === 'patch') return;
    const raw = m[3]!;
    const route = /^[`'"]/u.test(raw) ? spelled(raw.slice(1, -1)) : bases.get(raw);
    if (route === undefined || !route.startsWith('/')) return;
    const at = key(m[2]!.toUpperCase(), shapeOf(route));
    const stop = Math.min(here[i + 1]?.index ?? code.length, endOfCall(code, (m.index ?? 0) + m[0].indexOf('(')));
    const found = answers.get(at) ?? [];
    found.push({ file, line: lineOf(code, m.index ?? 0), handler: code.slice(m.index ?? 0, stop) });
    answers.set(at, found);
  });
}

const exportedBy = (code: string): string[] => [...code.matchAll(/\bexport\s+(?:async\s+)?(?:const|function)\s+(\w+)/gu)].map((m) => m[1]!);
const LIVE = serverCode.get('index.ts')!;

/** A file's router is mounted when the service's entry point mounts one of its exports, or a mounted file does. */
const mounted = (file: string, seen: ReadonlySet<string> = new Set()): boolean => {
  if (file === 'index.ts') return true;
  if (seen.has(file)) return false;
  const names = exportedBy(serverCode.get(file)!);
  for (const [other, code] of serverCode) {
    if (other === file) continue;
    const uses = names.some((n) => new RegExp(`\\bapp\\s*\\.\\s*use\\(\\s*${n}\\(|\\b${n}\\(\\s*app\\b`, 'u').test(code));
    if (uses && (other === 'index.ts' || mounted(other, new Set([...seen, file])))) return true;
  }
  return false;
};

/* The relays `finish-company` makes are posts to the service: the creation, its second step, and the pay key. */
const FINISH_ROUTE: Readonly<Record<string, string>> = {
  creation: '/api/accounts/:/creation',
  'creation-again': '/api/accounts/:/creation/again',
  'creation-finish': '/api/accounts/:/creation/finish',
  'pay-key-approve': '/api/accounts/:/creation/pay-key',
  'pay-key-seal': '/api/accounts/:/creation/pay-key',
};

describe('every route an action may ask for is answered by the service and its router is mounted', () => {
  const listed = new Map<string, { sends: boolean[]; by: string[] }>();
  for (const name of NAMES) {
    for (const [k, v] of listedBy(name)) {
      const was = listed.get(k) ?? { sends: [], by: [] };
      was.sends.push(v.sends);
      was.by.push(name);
      listed.set(k, was);
    }
  }
  const relayed = [...new Set(NAMES.flatMap((n) => (INTENTS[n]?.relays ?? []).map((label) => `${n}:${label}`)))];

  it('the service answers every listed route, and a relay label that maps to no route stops this check', () => {
    /* RED WHEN: an intent lists a route the service no longer answers, or finish-company relays through a route it lacks. */
    expect(answers.size, 'no route of the service could be read').toBeGreaterThan(50);
    expect(listed.size, 'no listed route could be read').toBeGreaterThan(0);
    const kinds = [...readFileSync(path.join(REPO, 'src/midnight/sealed-record-wire.ts'), 'utf8')
      .match(/COMPANY_RECORD_KINDS\s*=\s*\[([^\]]*)\]/u)![1]!.matchAll(/'([a-z-]+)'/gu)].map((m) => m[1]!);
    expect(kinds, 'the company record kinds could not be read').toContain('roster');
    const answeredAs = (k: string): boolean => answers.has(k) || [...answers.keys()].some((a) => {
      const [am, ap] = [a.slice(0, a.indexOf(' ')), a.slice(a.indexOf(' ') + 1).split('/')];
      const [km, kp] = [k.slice(0, k.indexOf(' ')), k.slice(k.indexOf(' ') + 1).split('/')];
      return am === km && ap.length === kp.length
        && ap.every((seg, i) => seg === kp[i] || (seg === ':' && (kp[i] === ':' || (kp[i - 1] === 'records' && kinds.includes(kp[i]!)))));
    });
    const missing = [
      ...[...listed].filter(([k]) => !answeredAs(k)).map(([k, v]) => `${k} (listed by ${[...new Set(v.by)].join(', ')})`),
      ...Object.keys(SOURCE_ROUTES).filter((k) => !answeredAs(k)).map((k) => `${k} (listed for the record source)`),
    ];
    expect(missing).toEqual([]);
    const lost = relayed.filter((r) => FINISH_ROUTE[r.split(':')[1]!] === undefined || !answers.has(key('POST', FINISH_ROUTE[r.split(':')[1]!]!)));
    expect(lost).toEqual([]);
    expect(FINISH_COMPANY_RELAYS.length).toBeGreaterThan(0);
  });

  it('every file that answers a listed route is mounted by the service', () => {
    /* RED WHEN: a route file the lists depend on is no longer mounted, so a listed route would answer "not found". */
    const wanted = new Set<string>();
    for (const k of [...listed.keys(), ...Object.keys(SOURCE_ROUTES)]) for (const a of answers.get(k) ?? []) wanted.add(a.file);
    for (const r of relayed) for (const a of answers.get(key('POST', FINISH_ROUTE[r.split(':')[1]!] ?? '')) ?? []) wanted.add(a.file);
    expect(LIVE.length).toBeGreaterThan(0);
    expect([...wanted].filter((f) => !mounted(f)).sort()).toEqual([]);
  });

  it('a listed route is marked as sending exactly when its handler hands a transaction to the chain', () => {
    /* RED WHEN: a route that sends a transaction is listed without `sends` (its sending goes uncounted), or one that does not send is marked as sending. */
    const HANDS_ON = /\brelay\(|\bsubmitProven\w*\(|\bawait send\(|\bsendStep\(|\bsendTheRaise\(/u;
    const wrong: string[] = [];
    for (const [k, v] of listed) {
      const handlers = answers.get(k);
      if (handlers === undefined) continue;
      if (new Set(v.sends).size > 1) wrong.push(`${k}: listed as sending by one intent and not by another`);
      const marked = v.sends.some((s) => s);
      const sends = handlers.some((h) => HANDS_ON.test(h.handler));
      if (marked !== sends) wrong.push(`${k}: ${marked ? 'marked' : 'not marked'} as sending, its handler ${sends ? 'hands' : 'does not hand'} a transaction to the chain (${handlers[0]!.file}:${handlers[0]!.line})`);
    }
    expect(wrong).toEqual([]);
  });
});
