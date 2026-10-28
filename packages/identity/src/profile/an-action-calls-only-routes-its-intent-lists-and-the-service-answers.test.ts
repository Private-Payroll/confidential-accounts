/**
 * What an action may ask the service for is a list the wallet enforces (`ACT_INTENTS`, each intent's `calls`), and a
 * `sends: true` mark is what makes a call count as a transaction handed over. This reads the wallet's action files and
 * the service's route files as text, with comments blanked, and holds the lists to both: an action asks for exactly
 * what its intent lists, every listed route is answered by the service and its router is mounted, and a listed route is
 * marked `sends` exactly when its handler hands a transaction to the chain.
 *
 * What it does not cover, on purpose. Only two actions name their calls in the action file; the other four reach the
 * service through shared page code, so for them it checks only that every `/api/` path an action file names is listed
 * (the one path ending in a variable vault step is checked up to that step). Whether a handler hands a transaction to the
 * chain is read by the name of the helper it calls: a helper renamed to something this list does not hold makes a
 * `sends` route read as not sending, so that direction is weaker than the other. And that a listed route answers
 * something other than "not found" needs the running service, which is not built here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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

describe('an action asks the service only for the routes its intent lists', () => {
  const files = readdirSync(ACTIONS).filter((f) => /\.tsx?$/u.test(f) && !/\.test\./u.test(f));
  const sources = new Map(files.map((f) => [f, read(path.join(ACTIONS, f))] as const));
  const CALLED = new Map<string, string[]>();
  for (const [file, code] of sources) {
    const sites = [...code.matchAll(/\bctx\.call\(\s*['"`](GET|PUT|POST)['"`]\s*,\s*`([^`]*)`/gu)];
    if (sites.length > 0) CALLED.set(file, sites.map((m) => key(m[1]!, asked(m[2]!))));
  }
  const NAMED_IN_THE_ACTION = ['claim-by-address', 'seat-invited'];

  it('claims and seats by invitation ask for exactly the routes they list, no more and no fewer', () => {
    /* RED WHEN: a wallet action asks the service for a route its list does not name, or its list names one it never asks. */
    for (const name of NAMED_IN_THE_ACTION) {
      const listed = [...listedBy(name).keys()].sort();
      const calls = CALLED.get(`${name}.ts`) ?? [];
      expect(listed.length, `${name} lists no calls`).toBeGreaterThan(0);
      expect([...new Set(calls)].sort(), name).toEqual(listed);
      const code = sources.get(`${name}.ts`)!;
      expect((code.match(/\bctx\.call\(/gu) ?? []).length, `${name} asks through a call this check cannot read`).toBe(calls.length);
    }
  });

  it('no other action names a call in its own file, since only these two are held to their file', () => {
    /* RED WHEN: an action starts asking the service by a call written in its own file and no check holds it to its list. */
    expect([...CALLED.keys()].filter((f) => !NAMED_IN_THE_ACTION.includes(f.replace(/\.tsx?$/u, ''))).sort()).toEqual([]);
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
  'pay-key-propose': '/api/accounts/:/creation/pay-key',
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
    const missing = [...listed].filter(([k]) => !answers.has(k)).map(([k, v]) => `${k} (listed by ${[...new Set(v.by)].join(', ')})`);
    expect(missing).toEqual([]);
    const lost = relayed.filter((r) => FINISH_ROUTE[r.split(':')[1]!] === undefined || !answers.has(key('POST', FINISH_ROUTE[r.split(':')[1]!]!)));
    expect(lost).toEqual([]);
    expect(FINISH_COMPANY_RELAYS.length).toBeGreaterThan(0);
  });

  it('every file that answers a listed route is mounted by the service', () => {
    /* RED WHEN: a route file the lists depend on is no longer mounted, so a listed route would answer "not found". */
    const wanted = new Set<string>();
    for (const k of listed.keys()) for (const a of answers.get(k) ?? []) wanted.add(a.file);
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
