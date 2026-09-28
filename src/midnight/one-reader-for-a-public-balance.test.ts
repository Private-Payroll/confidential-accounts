/**
 * **EVERY READ OF A VAULT'S PUBLIC BALANCE GOES THROUGH ONE READER.**
 *
 * The reader is `publicHoldingsOf`, over the vault's contract state as of the
 * contract's latest action. The vault client builds `unshieldedBalance` and
 * `unshieldedHoldings` on it, and every payout check, holdings read and
 * operator door asks those; the company's service calls it once, for the
 * vault's screen, and the page reads only what the service sent.
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

const FILES = WALKED.flatMap((d) => sourceFiles(join(ROOT, d)))
  .map((path) => ({ file: relative(ROOT, path).split('\\').join('/'), code: codeOf(readFileSync(path, 'utf8')) }));

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
/** The page's copy of what the service read. */
const SERVED_LIST = /\bpublicBalances\b/u;

const where = (pattern: RegExp) => FILES.filter((f) => pattern.test(f.code)).map((f) => f.file).sort();
const count = (pattern: RegExp) => Object.fromEntries(FILES
  .map((f) => [f.file, (f.code.match(pattern) ?? []).length] as const)
  .filter(([, n]) => n > 0)
  .sort(([a], [b]) => (a < b ? -1 : 1)));

/** What the broad read above finds that is not a walk over a contract state's balance, each with why. */
const NOT_A_CONTRACT_BALANCE: Record<string, { count: number; why: string }> = {
  'scripts/chain-probe.ts': { count: 2, why: 'a phase code named for the wallet\'s balancing step' },
  'scripts/open-vault-pool.ts': { count: 1, why: 'a sentence printed to the operator' },
  'scripts/pay-from-vault.ts': { count: 1, why: 'a row of the vault client\'s own list, printed' },
  'scripts/run-preview.ts': { count: 2, why: 'a phase code named for the wallet\'s balancing step' },
  'src/core/ledger.ts': { count: 2, why: 'a proof\'s witness, not a contract state' },
  'src/midnight/public-balance.ts': { count: 1, why: 'the one reader' },
  'src/wiring/vault-submission.ts': { count: 2, why: 'a vault deploy is refused unless its starting balance is empty at all, fee token included' },
};

describe('the census can see what it looks for', () => {
  it('matches each way in, as code would spell it', () => {
    /* RED WHEN a pattern is loosened into one that finds nothing, which would pass every file below vacuously. */
    expect(BALANCE_QUERY.test('await provider.queryUnshieldedBalances(vault)')).toBe(true);
    const reads = (code: string) => (code.match(BALANCE_READ) ?? []).length;
    for (const spelled of [
      'if (state.balance instanceof Map)', 'const n = state.balance.get(key)', 'state.balance?.get(k)',
      'for (const [k] of (state as any).balance) void k;', 'const rows = [...state!.balance]',
      'const { balance } = state;', 'const { data, balance: b } = state;', "state['balance'].get(k)",
      'for (const e of getState().balance) {}', 'Object.fromEntries((await ask(v)).balance)',
    ]) expect(reads(spelled), spelled).toBe(1);
    /* And a vault client's own balance call is not a read of a state's balance. */
    expect(reads('before = await ledger.balance(vault, colour);')).toBe(0);
    expect(READER_NAMED.test('return publicHoldingsOf(state)')).toBe(true);
    expect(READER_NAMED.test('import { publicHoldingsOf as read } from x')).toBe(true);
    expect(codeOf('/* publicHoldingsOf(state) */\n// queryUnshieldedBalances()\nconst a = 1;')).not.toMatch(/publicHoldingsOf|queryUnshieldedBalances/u);
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

  it('the reader is named by the vault client and by the service\'s vault view, and by nothing else', () => {
    /* RED WHEN a caller reads the balance off a state itself instead of asking the vault client's reader. */
    expect(where(READER_NAMED).filter((f) => f !== 'src/midnight/public-balance.ts'))
      .toEqual(['src/midnight/vault-ledger.ts', 'src/server/company-vaults.ts']);
  });

  it('on the page, only the vault holdings reader reads the list the service sent', () => {
    /* RED WHEN a screen reads the served list itself and so skips the refusal of a list it cannot read. */
    expect(where(SERVED_LIST).filter((f) => f.startsWith('src/web-legacy/') || f.startsWith('packages/web-shared/')))
      .toEqual(['packages/web-shared/src/device-vault-holdings.ts']);
  });
});
