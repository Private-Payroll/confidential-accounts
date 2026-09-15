import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SEED_ASSETS, StaticAssetRegistry, assets as productAssets, ledgerFormOf, ledgerTokenOf,
  type Asset, type LedgerForm,
} from './assets.js';

/**
 * **AN ASSET'S LEDGER IDENTITY IS NAMED IN ONE PLACE, THE ASSET'S OWN ROW, AND
 * NOTHING ELSE TURNS AN ASSET INTO A LEDGER TOKEN.**
 *
 * §1 is the shape: any row, in any of the four shapes an asset can have, is
 * answered from the row, so a new asset is a new row. §2 is the registry
 * refusing a row that would make two names for one balance. §3 is the census:
 * it reads the source and fails the day a second place appears.
 */

const FORMS: readonly LedgerForm[] = ['shielded', 'unshielded'];
const tokenFor = (label: string) => createHash('sha256').update(label).digest('hex');

describe('§1 every shape an asset can have is answered from its row', () => {
  /*
   * Rows invented here, with codes no function has ever seen and tokens nobody
   * wrote down. A lookup that knew any asset by name would answer one of them
   * wrongly; the product's registry is not touched.
   */
  const shapes = ['both', 'private only', 'public only', 'neither'] as const;
  const rows: Asset[] = Array.from({ length: 24 }, (_, i) => {
    const shape = shapes[i % 4]!;
    return {
      code: `ZX${i}Q`, name: `invented ${i}`, kind: 'token', decimals: i % 7, chain: 'midnight',
      ledger: {
        shielded: shape === 'both' || shape === 'private only' ? tokenFor(`row ${i} shielded`) : null,
        unshielded: shape === 'both' || shape === 'public only' ? tokenFor(`row ${i} unshielded`) : null,
      },
      enabled: i % 5 !== 0, sortOrder: i,
    };
  });
  const registry = new StaticAssetRegistry(rows);

  it('gives each row exactly its own token in each form it has, and refuses each form it has not', () => {
    for (const row of rows) {
      for (const form of FORMS) {
        const answer = ledgerFormOf(registry.require(row.code), form);
        if (row.ledger[form] === null) {
          /* RED WHEN a form with no token is given a stand-in. */
          expect(answer.of, `${row.code} ${form}`).toBe('no-such-form');
          expect(() => ledgerTokenOf(row.code, form, registry)).toThrow(row.code);
        } else {
          /* RED WHEN the answer is not read off the row: another row's, another form's, or a constant. */
          expect(answer).toEqual({ of: 'token', token: row.ledger[form] });
          expect(ledgerTokenOf(row.code, form, registry)).toBe(row.ledger[form]);
        }
      }
    }
  });

  it('says what the missing form\'s asset CAN do, from its row and not from its name', () => {
    const privateOnly = rows.find(r => r.ledger.shielded && !r.ledger.unshielded)!;
    const publicOnly = rows.find(r => !r.ledger.shielded && r.ledger.unshielded)!;
    const neither = rows.find(r => !r.ledger.shielded && !r.ledger.unshielded)!;
    expect(() => ledgerTokenOf(privateOnly.code, 'unshielded', registry))
      .toThrow(`${privateOnly.code} has no public form on Midnight`);
    expect(() => ledgerTokenOf(privateOnly.code, 'unshielded', registry))
      .toThrow(/It has a private form only\./);
    expect(() => ledgerTokenOf(publicOnly.code, 'shielded', registry))
      .toThrow(/It has a public form only\./);
    expect(() => ledgerTokenOf(neither.code, 'shielded', registry))
      .toThrow(`${neither.code} has no form on Midnight, private or public`);
  });

  it('names, in a refusal, exactly the enabled assets that can be paid in that form', () => {
    const neither = rows.find(r => !r.ledger.shielded && !r.ledger.unshielded)!;
    const payablePrivately = rows.filter(r => r.enabled && r.ledger.shielded).map(r => r.code);
    expect(payablePrivately.length).toBeGreaterThan(1);
    expect(() => ledgerTokenOf(neither.code, 'shielded', registry))
      .toThrow(`Assets that have a private form: ${payablePrivately.join(', ')}.`);
  });

  it('the product registry says only what it knows: NIGHT publicly, one test asset privately', () => {
    const withAForm = productAssets.all().flatMap(a => FORMS
      .filter(f => ledgerFormOf(a, f).of === 'token').map(f => `${a.code} ${f}`));
    /*
     * RED WHEN a row gains a form it has not got, or loses one it has. Two rows
     * in this registry state a token and the rest state null in both forms.
     */
    expect(withAForm).toEqual(['NIGHT unshielded', 'TESTUSD shielded']);
  });

  it('NIGHT STILL HAS NO PRIVATE FORM, and nothing about a test asset changes that', () => {
    /*
     * RED WHEN somebody gives NIGHT a private token. `nativeToken()` is an
     * `UnshieldedTokenType`: there is no private NIGHT on this platform, so a
     * row claiming one is money no mint ever made. It is asserted separately
     * from the list above because the list is about what the registry says and
     * this is about what the platform is.
     */
    expect(productAssets.require('NIGHT').ledger.shielded).toBeNull();
    expect(() => ledgerTokenOf('NIGHT', 'shielded'))
      .toThrow('NIGHT has no private form on Midnight');
  });

  it('THE ONLY ASSET WITH A PRIVATE FORM IS A TEST ONE, and it is refused off its network', async () => {
    const { TEST_SETTLEMENT_MINTED_ON, testAssetsFor, isATestAsset } =
      await import('./assets.js');
    const { NETWORK_IDS, networkRecord } = await import('./networks.js');
    const privately = productAssets.all().filter(a => a.ledger.shielded !== null).map(a => a.code);
    /* RED WHEN a real asset gains a private form without the row being argued for. */
    expect(privately.every(isATestAsset)).toBe(true);
    /* RED WHEN a test asset is admitted on a network whose own record says real
     * money settles there. Asked of every such network rather than of the one
     * name somebody thought to write down. */
    const real = NETWORK_IDS.filter(id => networkRecord(id).kind === 'real');
    expect(real.length).toBeGreaterThan(0);
    for (const id of real) {
      expect(testAssetsFor(id), id).toEqual([]);
      expect(TEST_SETTLEMENT_MINTED_ON, id).not.toContain(id);
    }
  });
});

describe('§2 a registry that would give one balance two names is refused when it is built', () => {
  const base = (over: Partial<Asset>): Asset => ({
    code: 'ZZA', name: 'a', kind: 'token', decimals: 0, chain: 'midnight',
    ledger: { shielded: null, unshielded: null }, enabled: true, sortOrder: 1, ...over,
  });

  it('REFUSES two assets naming the same token in the same form', () => {
    const t = tokenFor('shared');
    /* RED WHEN duplicate tokens are not looked for. */
    expect(() => new StaticAssetRegistry([
      base({ code: 'ZZA', ledger: { shielded: t, unshielded: null } }),
      base({ code: 'ZZB', ledger: { shielded: t, unshielded: null } }),
    ])).toThrow('ZZA and ZZB name the same private token');
    /* The same bytes in the other form are a different token type on the ledger, and are allowed. */
    expect(() => new StaticAssetRegistry([
      base({ code: 'ZZA', ledger: { shielded: t, unshielded: null } }),
      base({ code: 'ZZB', ledger: { shielded: null, unshielded: t } }),
    ])).not.toThrow();
  });

  it.each([
    ['upper case', 'AB'.repeat(32)],
    ['a 0x prefix', '0x' + 'ab'.repeat(31)],
    ['too short', 'ab'.repeat(31)],
    ['not hex', 'zz'.repeat(32)],
  ])('REFUSES a token spelt with %s', (_why, token) => {
    /* RED WHEN a spelling is accepted, which is money a vault asked about by that spelling never holds. */
    expect(() => new StaticAssetRegistry([base({ ledger: { shielded: token, unshielded: null } })]))
      .toThrow('not 64 lower-case hex characters');
  });

  it('REFUSES a row that does not say what the ledger calls it', () => {
    const { ledger: _gone, ...noLedger } = base({});
    expect(() => new StaticAssetRegistry([noLedger as Asset])).toThrow('does not say what the ledger calls it');
    expect(() => ledgerFormOf({ ...base({}), ledger: { shielded: undefined } } as unknown as Asset, 'shielded'))
      .toThrow('does not say whether it has a private form');
  });

  it('the product seed builds, and every row in it states both forms', () => {
    expect(() => new StaticAssetRegistry(SEED_ASSETS)).not.toThrow();
    for (const a of SEED_ASSETS) expect(Object.keys(a.ledger).sort()).toEqual(['shielded', 'unshielded']);
  });
});

/* ------------------------------------------------------------------------ *
 * §3 THE CENSUS
 * ------------------------------------------------------------------------ */

/**
 * Blanks comments and the contents of string literals, keeping every newline
 * and every `${}` expression, so a sentence that mentions a token is not code
 * that makes one.
 */
function strip(src: string): string {
  let out = ''; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i]!; const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    if (c === '\'' || c === '"') {
      out += c; i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += ' '; i++;
      }
      out += c; i++; continue;
    }
    if (c === '`') {
      out += '`'; i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          let depth = 1; let j = i + 2;
          while (j < n && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
          out += '${' + strip(src.slice(i + 2, j - 1)) + '}'; i = j; continue;
        }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += '`'; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

const OPENERS: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
const CLOSERS: Record<string, string> = { '}': '{', ')': '(', ']': '[' };

function enclosingBrace(code: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = code[i]!;
    if (CLOSERS[ch]) depth++;
    else if (OPENERS[ch]) { if (depth === 0) return ch === '{' ? i : -1; depth--; }
  }
  return -1;
}

function matchingClose(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i]!;
    if (OPENERS[ch]) depth++;
    else if (CLOSERS[ch]) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const topLevelOf = (body: string): string => {
  let out = ''; let depth = 0;
  for (const ch of body) {
    if (OPENERS[ch]) { depth++; out += ' '; continue; }
    if (CLOSERS[ch]) { depth--; out += ' '; continue; }
    out += depth === 0 ? ch : ' ';
  }
  return out;
};

const lineAt = (code: string, at: number) => code.slice(0, at).split('\n').length;

/**
 * **EVERY OBJECT LITERAL GIVEN A `token`, WITH THE EXPRESSION IT IS GIVEN.**
 *
 * Every one, and not only those that look like money: whether an object is a
 * payment cannot be read off the spelling of its other keys, and a payment
 * built by spreading another one has no other keys at all. Type literals and
 * destructuring patterns are not producers and are passed over.
 */
function tokenSites(source: string): Array<{ line: number; given: string }> {
  const code = strip(source);
  const sites: Array<{ line: number; given: string }> = [];
  const re = /(?<![\w.$])token\s*(:|(?=[,}\n]))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const open = enclosingBrace(code, m.index);
    if (open < 0 || code[open - 1] === '$') continue;
    const close = matchingClose(code, open);
    if (close < 0) continue;
    const before = code.slice(0, open).trimEnd();
    if (/\b(interface\s+[\w$]+(\s*<[^>]*>)?(\s+extends[^{]*)?|type\s+[\w$]+(\s*<[^>]*>)?\s*=)$/.test(before)) continue;
    let given: string;
    if (m[1] === ':') {
      const rest = code.slice(m.index + m[0].length);
      let depth = 0; let j = 0;
      for (; j < rest.length; j++) {
        const ch = rest[j]!;
        if (OPENERS[ch]) depth++;
        else if (CLOSERS[ch]) { if (depth === 0) break; depth--; }
        else if ((ch === ',' || ch === ';') && depth === 0) break;
      }
      given = rest.slice(0, j).replace(/\s+/g, ' ').trim();
      if (/^(Hex|string|Uint8Array)(\s*\|\s*(null|undefined))?$/.test(given)) continue;
    } else {
      const after = code.slice(close + 1).trimStart();
      if (/^(=(?!>)|:|of\b|in\b|\)\s*=>)/.test(after)) continue;
      given = 'token';
    }
    sites.push({ line: lineAt(code, m.index), given });
  }
  return sites;
}

/** A token read off the one place, or an existing token carried along unchanged. */
const readsTheRowOrCarries = (given: string) =>
  /^ledgerTokenOf\s*\(/.test(given) || /^[\w$]+(\??\.[\w$]+)*\??\.token$/.test(given);

/** Each `assetIdBytes(` call, and whether it is the account's name for an asset. */
function assetIdBytesSites(source: string): Array<{ line: number; accountName: boolean }> {
  const code = strip(source);
  const out: Array<{ line: number; accountName: boolean }> = [];
  const re = /(?<![\w.$])assetIdBytes\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const before = code.slice(Math.max(0, m.index - 80), m.index);
    out.push({
      line: lineAt(code, m.index),
      accountName: /(assetId\s*:\s*|assetKeyOf\s*\(\s*|function\s+)$/.test(before),
    });
  }
  return out;
}

/** Lines holding a literal, or a `'..'.repeat(n)`, equal to one of these tokens. */
function tokenLiterals(source: string, tokens: readonly string[]): number[] {
  const want = new Set(tokens.map(t => t.toLowerCase()));
  const out: number[] = [];
  let m: RegExpExecArray | null;
  const literal = /['"`]([0-9a-fA-F]{64})['"`]/g;
  while ((m = literal.exec(source))) if (want.has(m[1]!.toLowerCase())) out.push(lineAt(source, m.index));
  const repeated = /['"`]([0-9a-fA-F]{1,64})['"`]\s*\.repeat\(\s*(\d+)\s*\)/g;
  while ((m = repeated.exec(source))) {
    if (want.has(m[1]!.repeat(Number(m[2])).toLowerCase())) out.push(lineAt(source, m.index));
  }
  return out;
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const THE_ONE_PLACE = 'src/core/assets.ts';

function shippingSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry === 'node_modules' || entry.startsWith('managed') || entry.startsWith('.')) continue;
        walk(path);
      } else if (/\.(ts|tsx|mts|js|mjs|cjs)$/.test(entry) && !/\.test\.[cm]?[jt]sx?$/.test(entry) && !entry.endsWith('.d.ts')) {
        files.push(relative(ROOT, path));
      }
    }
  };
  for (const dir of ['src', 'scripts', 'contracts/src']) walk(join(ROOT, dir));
  return files;
}

/**
 * **THE PLACES AN OBJECT IS GIVEN A `token` THAT IS NEITHER READ OFF THE ROW NOR
 * CARRIED ALONG, EACH WITH WHY IT IS NOT AN ASSET BECOMING A LEDGER TOKEN.**
 * Keyed by file and expression, not by line, and counted, so a second
 * occurrence in the same file is a new site that somebody has to look at.
 */
const NOT_AN_ASSET_BECOMING_A_TOKEN: Record<string, { count: number; why: string }> = {
  'src/core/account.ts inviteKeyOf(raw)': { count: 1, why: 'the stored key of an invitation' },
  'src/core/account.ts raw': { count: 1, why: 'an invitation\'s secret, handed back once to whoever raised it' },
  'src/core/payroll.ts inviteKeyOf(raw)': { count: 1, why: 'the stored key of an invitation' },
  'src/core/payroll.ts token': { count: 1, why: 'the record of an invitation delivered' },
  'src/core/plugins.ts \' \' + nanoid(24)': { count: 1, why: 'a plug-in\'s capability, minted at random' },
  'src/testing/assets.ts token': { count: 1, why: 'a record of which token a test vault was asked about' },
  'src/web/App.tsx token': { count: 2, why: 'an invitation link shown to whoever raised it' },

  'src/midnight/vault-coins.ts token': { count: 1, why: 'the colour read off a coin in the ledger\'s own state' },
  'src/midnight/vault-ledger.ts token': { count: 1, why: '`toNote` carries the token it is handed into a note' },
  'src/midnight/vault-recovery.ts token': { count: 1, why: '`paidCoinOf` carries the spent note\'s token to the coin it paid' },
  'src/server/index.ts z.string()': { count: 1, why: 'a request schema, which describes a body and makes nothing' },
  'scripts/deposit-to-vault.ts colour': { count: 2, why: 'the colour read off the coin that arrived in the wallet' },
  'scripts/fund-vault.ts colour': { count: 1, why: 'the ledger\'s own native token, read from the ledger at run time' },
  'scripts/measure-call-cost.ts toHex(GBP)': { count: 1, why: 'a colour a measurement mints for itself, never a payment' },
  'scripts/vault-journal.ts token': { count: 1, why: 'the colour read off a journal line this reader has already checked is a coin, carried into the coin proposed to the chain' },
  'scripts/record-a-notes-transaction.ts target.token as Hex': { count: 1, why: 'the token of the note already in the pool, put back into the commitment so it can be compared with the one the chain holds' },
};

/** Files that ask the ledger for its native token at run time, each to compare or deposit what it reads. */
const READS_THE_LEDGERS_NATIVE_TOKEN = [
  'scripts/fund-vault.ts', 'scripts/pay-from-vault.ts', 'scripts/transfer-from-vault.ts',
];

describe('§3 the census: no second place turns an asset into a ledger token', () => {
  const files = shippingSources();
  /*
   * A file whose code never names money, a payee, a vault, the ledger or an
   * asset cannot be building a payment, so its tokens are sign-in sessions,
   * invitations and words of text, and it is passed over. Read on the code with
   * comments and strings blanked, so a sentence about money does not count.
   */
  const namesMoney = (source: string) =>
    /(?<![\w$])(amount|payee|vault|ledger|asset|payout|deposit|nativeToken)/i.test(strip(source));
  const sources = new Map(files
    .map(f => [f, readFileSync(join(ROOT, f), 'utf8')] as const)
    .filter(([, source]) => namesMoney(source)));

  it('reads the source it is meant to read', () => {
    /* RED WHEN the walk silently reads nothing, which is a census that always passes. */
    expect(files.length).toBeGreaterThan(100);
    expect(files.some(f => f.endsWith('.mjs'))).toBe(true);
    for (const f of ['src/core/movement.ts', 'src/core/payroll.ts', 'src/midnight/vault-ledger.ts', 'scripts/fund-vault.ts']) {
      expect(sources.has(f), `${f} names money and is read`).toBe(true);
    }
    for (const f of ['src/core/movement.ts', 'src/core/payroll.ts', 'src/midnight/vault-ledger.ts', 'scripts/fund-vault.ts']) {
      expect(files).toContain(f);
    }
  });

  it('every token an object is given is read off the asset\'s row, carried along, or listed with its reason', () => {
    const unexplained: string[] = [];
    const counted = new Map<string, number>();
    for (const [file, source] of sources) {
      if (file === THE_ONE_PLACE) continue;
      for (const site of tokenSites(source)) {
        if (readsTheRowOrCarries(site.given)) continue;
        const key = `${file} ${site.given}`;
        counted.set(key, (counted.get(key) ?? 0) + 1);
        if (!NOT_AN_ASSET_BECOMING_A_TOKEN[key]) unexplained.push(`${file}:${site.line} token: ${site.given}`);
      }
    }
    expect(unexplained,
      'a payment names its token from ledgerTokenOf in src/core/assets.ts, and from nowhere else').toEqual([]);
    for (const [key, { count }] of Object.entries(NOT_AN_ASSET_BECOMING_A_TOKEN)) {
      expect(counted.get(key) ?? 0, `${key}: a listed site that moved or multiplied`).toBe(count);
    }
  });

  it('the account\'s name for an asset is only ever used as the account\'s name', () => {
    const elsewhere: string[] = [];
    for (const [file, source] of sources) {
      for (const site of assetIdBytesSites(source)) {
        if (!site.accountName && file !== THE_ONE_PLACE) elsewhere.push(`${file}:${site.line}`);
      }
    }
    expect(elsewhere, 'assetIdBytes is the account key\'s input, never a payment\'s token').toEqual([]);
  });

  it('no ledger token in the registry is written out anywhere but its row', () => {
    /*
     * The all-zero value is left out: it is NIGHT's token and also this
     * codebase's ordinary zero sentinel, so a literal of it says nothing about
     * NIGHT. Where one would reach a payment's token, the first census above
     * refuses it, because a literal is neither read off a row nor carried.
     */
    const tokens = productAssets.all()
      .flatMap(a => FORMS.map(f => a.ledger[f]))
      .filter((t): t is string => t !== null && !/^0+$/.test(t));
    const found: string[] = [];
    for (const [file, source] of sources) {
      if (file === THE_ONE_PLACE) continue;
      for (const line of tokenLiterals(source, tokens)) found.push(`${file}:${line}`);
    }
    expect(found).toEqual([]);
  });

  it('only the doors that read the ledger\'s native token ask for it', () => {
    const asking = [...sources].filter(([, s]) => /(?<![\w$])nativeToken\s*(\?\.)?\s*\(/.test(strip(s))).map(([f]) => f);
    expect(asking.sort()).toEqual([...READS_THE_LEDGERS_NATIVE_TOKEN].sort());
  });
});

describe('§3b the census can fail, watched on sources written to fail it', () => {
  it('finds the old payroll producer, a literal, a constant, a smuggled binding, and a spread with no amount beside it', () => {
    expect(tokenSites('const key = { assetId: assetIdBytes(e.asset) };\nreturn { ...facts[i], token: toHex(key.assetId) };')
      .map(s => [s.given, readsTheRowOrCarries(s.given)])).toEqual([['toHex(key.assetId)', false]]);
    expect(tokenSites("x = { payee, token: Buffer.from(e.asset).toString('hex').padEnd(64, '0'), quantity: e.amount };")
      .map(s => readsTheRowOrCarries(s.given))).toEqual([false]);
    const producer = `
      return {
        payee: payrollPayee(person.name, person.address),
        token: toHex(assetIdBytes(e.asset)),
        amount: e.amount,
      };`;
    expect(tokenSites(producer).map(s => s.given)).toEqual(['toHex(assetIdBytes(e.asset))']);
    expect(assetIdBytesSites(producer).map(s => s.accountName)).toEqual([false]);
    const literal = tokenSites(`const f = { payee, token: '${'0'.repeat(64)}', amount: 5n };`);
    expect(literal).toHaveLength(1);
    expect(readsTheRowOrCarries(literal[0]!.given)).toBe(false);
    expect(readsTheRowOrCarries(tokenSites('const f = { payee, token: NIGHT_TOKEN, amount };')[0]!.given)).toBe(false);
    expect(tokenSites('return { payee, token, amount };').map(s => s.given)).toEqual(['token']);
    expect(tokenLiterals(`const x = 'ab'.repeat(32); const y = "${'cd'.repeat(32)}";`, ['ab'.repeat(32), 'cd'.repeat(32)]))
      .toEqual([1, 1]);
  });

  it('passes over what is not a producer: types, patterns, comments and strings', () => {
    expect(tokenSites('interface P { payee: Payee; token: Hex; amount: bigint }')).toEqual([]);
    expect(tokenSites('const f = (xs: ReadonlyArray<{ token: Hex; amount: bigint }>) => xs;')).toEqual([]);
    expect(tokenSites('const { token, amount } = payment;')).toEqual([]);
    expect(tokenSites('for (const { form, token, amount } of asks.values()) {}')).toEqual([]);
    expect(tokenSites('/* { token: toHex(assetIdBytes(x)), amount } */ const s = "token: x, amount: y";')).toEqual([]);
    expect(tokenSites('xs.map(({ token, ...rest }) => ({ ...rest }));')).toEqual([]);
    expect(readsTheRowOrCarries('ledgerTokenOf(e.asset, payee.kind, this.assets)')).toBe(true);
    expect(readsTheRowOrCarries('note.token')).toBe(true);
    expect(assetIdBytesSites('x = { assetId: assetIdBytes(change.asset) }; k = assetKeyOf(assetIdBytes(a), b);')
      .map(s => s.accountName)).toEqual([true, true]);
  });
});
