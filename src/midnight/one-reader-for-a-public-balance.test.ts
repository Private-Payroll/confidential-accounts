/**
 * **EVERY READ OF A VAULT'S PUBLIC BALANCE GOES THROUGH ONE READER.**
 *
 * The reader is `publicHoldingsOf`, over the vault's contract state as of the
 * contract's latest action. The vault client builds `unshieldedBalance` and
 * `unshieldedHoldings` on it, and every payout check, holdings read and
 * operator door asks those; the company's service calls it once, for the
 * vault's view, and the device calls it once, where its worker reads a vault
 * at the indexer the person's own wallet names. The page's screens read only
 * that device read, through the vault holdings reader.
 *
 * This reads the source and fails the day a second way in appears: the
 * indexer's balance query, which answers a vault's deploy rather than its
 * latest state, or a walk over a contract state's balance map written again
 * somewhere else. It is not found by following imports, so it walks the tree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/* Every tree that ships code: the product, its operator doors, the wallet and the shared library. */
const WALKED = ['src', 'scripts', 'apps', 'packages'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/u.test(name) && !/\.test\.(ts|tsx|mts|js|mjs)$/u.test(name)) out.push(path);
  }
  return out;
}

/** The code of a file without its comments, so a sentence about the old query is not read as a call to it. */
const codeOf = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/^\s*\/\/.*$/gmu, '')
  .replace(/\s\/\/\s.*$/gmu, '');

/**
 * A file with the text of every string blanked, found by the bundler's own
 * parser, so a phrase key (`t('kit.balance.public')`) or a sentence is not read
 * as a read of a property. Kept: the code inside a template's `${...}`, and a
 * string that names a property, as a key in brackets (`state['balance']`) or in
 * an object or a destructuring (`{ 'balance': b }`), because each of those is a
 * read. Blanked to spaces of the same length, so nothing after it moves.
 */
function withoutStrings(file: string, text: string): string {
  const parsed = parseSync(file.replace(/\.(m?ts|mjs)$/u, '.ts'), text);
  if (parsed.errors.length > 0) throw new Error(`${file} did not parse: ${parsed.errors[0]!.message}`);
  const spans: [number, number][] = [];
  const visit = (n: unknown, parent: { type?: unknown; [k: string]: unknown } | null): void => {
    if (Array.isArray(n)) { n.forEach((x) => visit(x, parent)); return; }
    if (n === null || typeof n !== 'object') return;
    const node = n as { type?: unknown; value?: unknown; start: number; end: number };
    const namesAProperty = (parent?.type === 'MemberExpression' && parent.property === node) || (parent?.type === 'Property' && parent.key === node);
    if (node.type === 'Literal' && typeof node.value === 'string' && !namesAProperty) spans.push([node.start, node.end]);
    if (node.type === 'TemplateElement') spans.push([node.start, node.end]);
    for (const [k, v] of Object.entries(node)) if (k !== 'type' && v !== null && typeof v === 'object') visit(v, typeof node.type === 'string' ? node as never : parent);
  };
  visit(parsed.program, null);
  let out = text;
  /* Each UTF-16 unit, not each character, becomes a space, so a character outside the basic plane keeps its length. */
  for (const [a, b] of spans) out = out.slice(0, a) + out.slice(a, b).replace(/[^\n]/g, ' ') + out.slice(b);
  return out;
}

const FILES = WALKED.flatMap((d) => sourceFiles(join(ROOT, d)))
  .map((path) => {
    const file = relative(ROOT, path).split('\\').join('/');
    return { file, code: codeOf(withoutStrings(file, readFileSync(path, 'utf8'))) };
  });

/** The indexer's balance query, by name. */
const BALANCE_QUERY = /\bqueryUnshieldedBalances\b/u;
/**
 * Any read of a property called `balance` that is not a call: dotted, optional,
 * after a non-null mark, by a quoted key, or taken out by destructuring. Broad
 * on purpose, so a new walk over a contract state's balance cannot be spelled
 * past it; what it also finds is listed below by file, each with its reason.
 */
const BALANCE_READ = /\??\.\s*balance\b(?!\s*\()|\[\s*['"]balance['"]\s*\]|\{[^{}]*\bbalance\b[^{}]*\}\s*=(?!=)/gu;
/** The one reader, by name: a call, a reference, or an import under another name. */
const READER_NAMED = /\bpublicHoldingsOf\b/u;
/** A vault's public balances, as the page holds them. */
const SERVED_LIST = /\bpublicBalances\b/u;

const where = (pattern: RegExp) => FILES.filter((f) => pattern.test(f.code)).map((f) => f.file).sort();
const count = (pattern: RegExp) => Object.fromEntries(FILES
  .map((f) => [f.file, (f.code.match(pattern) ?? []).length] as const)
  .filter(([, n]) => n > 0)
  .sort(([a], [b]) => (a < b ? -1 : 1)));

/** What the broad read above finds that is not a walk over a contract state's balance, each with why. */
const NOT_A_CONTRACT_BALANCE: Record<string, { count: number; why: string }> = {
  'scripts/chain-probe.ts': { count: 2, why: 'a phase code named for the wallet\'s balancing step' },
  'scripts/run-preview.ts': { count: 2, why: 'a phase code named for the wallet\'s balancing step' },
  'src/core/ledger.ts': { count: 2, why: 'a proof\'s witness, not a contract state' },
  'src/midnight/public-balance.ts': { count: 1, why: 'the one reader' },
  'src/midnight/vault-circuits.ts': { count: 1, why: 'a deploy is refused unless its starting balance is empty' },
};

describe('the census can see what it looks for', () => {
  it('matches each way in, as code would spell it', () => {
    /* RED WHEN a pattern is loosened into one that finds nothing, which would pass every file below vacuously. */
    expect(BALANCE_QUERY.test('await provider.queryUnshieldedBalances(vault)')).toBe(true);
    const reads = (code: string) => (code.match(BALANCE_READ) ?? []).length;
    /* Each is read the way the files below are read: strings blanked, then comments. */
    for (const spelled of [
      'if (state.balance instanceof Map) {}', 'const n = state.balance.get(key)', 'state.balance?.get(k)',
      'for (const [k] of (state as any).balance) void k;', 'const rows = [...state!.balance]',
      'const { balance } = state;', 'const { data, balance: b } = state;', "state['balance'].get(k)",
      "const { 'balance': b } = state;", 'for (const e of getState().balance) {}', 'Object.fromEntries((await ask(v)).balance)',
    ]) expect(reads(codeOf(withoutStrings('x.ts', spelled))), spelled).toBe(1);
    /* And a vault client's own balance call is not a read of a state's balance. */
    expect(reads('before = await ledger.balance(vault, colour);')).toBe(0);
    expect(READER_NAMED.test('return publicHoldingsOf(state)')).toBe(true);
    expect(READER_NAMED.test('import { publicHoldingsOf as read } from x')).toBe(true);
    expect(codeOf('/* publicHoldingsOf(state) */\n// queryUnshieldedBalances()\nconst a = 1;')).not.toMatch(/publicHoldingsOf|queryUnshieldedBalances/u);
    /* A phrase key or a sentence is not a read; a read inside a template's value still is. */
    const kept = withoutStrings('x.tsx', "t('kit.balance.public'); say(\"the .balance\"); `${state.balance} and .balance`;");
    expect(reads(kept)).toBe(1);
    expect(kept).toContain('state.balance');
    /* And a character outside the basic plane in a string moves nothing after it. */
    expect(withoutStrings('x.ts', "const a = '\u{1F600}'; state.balance.get(k);")).toContain('state.balance.get(k);');
    /* And it walked the tree: the reader and its two callers are among what it read. */
    expect(FILES.map((f) => f.file)).toEqual(expect.arrayContaining([
      'src/midnight/public-balance.ts', 'src/midnight/vault-ledger.ts', 'src/server/company-vaults.ts',
      'apps/wallet/src/chain/dust.ts',
    ]));
  });
});

describe('a vault\'s public balance has one way in', () => {
  it('nothing asks the indexer\'s balance query except the platform probe that records its raw answer', () => {
    /*
     * RED WHEN any product file, service route or operator door asks the
     * balance query again. The one file named records what the indexer client
     * answers, beside the transaction it studies, and shows or decides nothing.
     */
    expect(where(BALANCE_QUERY)).toEqual(['scripts/chain-probe.ts']);
  });

  it('nothing but the reader reads a contract state\'s balance', () => {
    /*
     * RED WHEN a new read of a `balance` property appears in any file, or a
     * listed file gains one: each listed read is named with why it is not a
     * walk over `ContractState.balance`, and the count is exact.
     */
    expect(count(BALANCE_READ)).toEqual(Object.fromEntries(
      Object.entries(NOT_A_CONTRACT_BALANCE).map(([file, { count: n }]) => [file, n])));
  });

  it('the reader is named by the vault client, by the service\'s vault view and by the device\'s read of a vault, and by nothing else', () => {
    /* RED WHEN a caller reads the balance off a state itself instead of asking the one reader. */
    expect(where(READER_NAMED).filter((f) => f !== 'src/midnight/public-balance.ts'))
      .toEqual(['packages/web-shared/src/vault-on-chain-here.ts', 'src/midnight/vault-ledger.ts', 'src/server/company-vaults.ts']);
  });

  it('on the page, the device\'s read of a vault writes the list, it crosses from the worker, and only the vault holdings reader reads it', () => {
    /* RED WHEN a screen reads the list itself and so skips the refusal of a list it cannot read. */
    expect(where(SERVED_LIST).filter((f) => f.startsWith('apps/web/') || f.startsWith('packages/web-shared/')))
      .toEqual(['packages/web-shared/src/device-vault-holdings.ts', 'packages/web-shared/src/vault-on-chain-here.ts', 'packages/web-shared/src/vault-worker-client.ts']);
  });
});
