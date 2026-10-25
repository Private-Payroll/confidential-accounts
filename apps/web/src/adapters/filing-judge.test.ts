// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorDoors } from 'vaults-web-shared/records-anchored-here.js';

/*
 * THE COMPANY'S RECORDS AS THIS PAGE READS THEM. The page's vault worker and
 * the person's wallet are stood in for; what is checked is what this adapter
 * hands each read: the company it is for, where the account's anchors are
 * read - the indexer the person's own wallet names, and only there - and the
 * keys a page opens and seals with. The page anchors nothing and changes no
 * key: those are done by a seat action in the person's wallet.
 */
const t = vi.hoisted(() => ({
  indexer: { indexerUri: 'https://indexer.wallet.example/api', indexerWsUri: 'wss://indexer.wallet.example/ws' } as { indexerUri: string; indexerWsUri: string } | null,
  held: [] as Array<Record<string, unknown>>,
  asked: [] as Array<{ account: string; indexer: unknown }>,
  builder: null as Error | null,
  vouched: [] as unknown[],
  paths: [] as string[],
}));
vi.mock('./vault-builder.js', () => ({
  theVaultBuilder: async () => {
    if (t.builder !== null) throw t.builder;
    return {
      anchorsOnChain: async (i: { account: string; indexer: unknown }) => { t.asked.push(i); return [{ head: 'aa'.repeat(32) }]; },
      anchorHeads: async () => ({ after: [] }),
      anchor: async () => ({ tx: '' }),
      vouchedRunIdentity: async (run: unknown) => { t.vouched.push(run); return 'ff'.repeat(32); },
    };
  },
}));
vi.mock('vaults-web-shared/records-anchored-here.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/records-anchored-here.js')>()),
  heldFor: (doors: Record<string, unknown>) => async () => { t.held.push(doors); return { held: undefined }; },
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  holdersFromTheWallet: async () => ({ holders: {}, indexer: t.indexer }),
  api: async (path: string) => { t.paths.push(path); throw new Error('the service is stood in for'); },
}));

const judged = await import('./filing-judge.js');
const { rosterReadsFor } = judged;

const LABEL = `co_${'a7'.repeat(32)}`;
const ACCOUNT = 'b7'.repeat(32);

beforeEach(() => {
  t.held.length = 0; t.asked.length = 0; t.builder = null; t.vouched.length = 0; t.paths.length = 0;
  t.indexer = { indexerUri: 'https://indexer.wallet.example/api', indexerWsUri: 'wss://indexer.wallet.example/ws' };
});

describe('THE COMPANY A READ IS FOR', () => {
  it('READS THE COMPANY FOR ITS VIEWING KEY AT THE COMPANY\'S OWN ADDRESS ON THE SERVICE', async () => {
    await rosterReadsFor('acc_northwind', LABEL as never, ACCOUNT as never).anchored({} as never, {});
    const vouching = t.held[0]!.vouching as AnchorDoors['vouching'];
    await expect(vouching!.runs(['ee'.repeat(32)])).rejects.toThrow(/stood in for/u);
    /* RED WHEN: the company is read at any address but its own - another company's key would open its runs. */
    expect(t.paths).toEqual(['/api/accounts/acc_northwind']);
  });
});

describe('THE ACCOUNT\'S ANCHORS, READ AT THE INDEXER THE PERSON\'S OWN WALLET NAMES', () => {
  it('A WALLET THAT NAMES NO INDEXER IS SAID SO, AND NOTHING IS READ ANYWHERE ELSE', async () => {
    t.indexer = null;
    await rosterReadsFor('acc_northwind', LABEL as never, ACCOUNT as never).anchored({} as never, {});
    /* RED WHEN: with no indexer from the wallet, the anchors are read elsewhere - the service's, or a default. */
    await expect((t.held[0]!.onChain as AnchorDoors['onChain'])()).rejects.toThrow(/your wallet did not name the indexer it reads the chain through/u);
    expect(t.asked).toEqual([]);
  });
});

describe('EVERY READ OF A COMPANY\'S RECORDS ON THIS PAGE', () => {
  it('READS THEM AGAINST THE HEAD THE ACCOUNT\'S HISTORY HOLDS AT THE WALLET\'S INDEXER, AND IS HANDED NOTHING OF THE SERVICE\'S CHAIN READ', async () => {
    await rosterReadsFor('acc_northwind', LABEL as never, ACCOUNT as never).anchored({} as never, {});
    const [doors] = t.held;
    /* RED WHEN: the screens' reads are handed the service's chain read - the head would be the service's word again. */
    expect(doors).not.toHaveProperty('service');
    expect(doors!.accountId).toBe('acc_northwind');
    /* RED WHEN: the screens' reads take the account's anchors from anywhere but the wallet's indexer, for this account. */
    expect(await (doors!.onChain as AnchorDoors['onChain'])()).toEqual([{ head: 'aa'.repeat(32) }]);
    expect(t.asked).toEqual([{ account: ACCOUNT, indexer: t.indexer }]);
  });

  it('A DEVICE NEW TO THE COMPANY IS HANDED THE RUNS THAT MAY VOUCH FOR A HEAD, EACH RUN\'S IDENTITY MADE BY THE ACCOUNT\'S FUNCTIONS IN THE PAGE\'S WORKER', async () => {
    await rosterReadsFor('acc_northwind', LABEL as never, ACCOUNT as never).anchored({} as never, {});
    const vouching = t.held[0]!.vouching as AnchorDoors['vouching'];
    const run = { root: 'ab'.repeat(32), payees: '1', opensAt: '1', closesAt: '2', required: '0', vault: 'cd'.repeat(32), head: '1a'.repeat(32), r: '2b'.repeat(32) };
    /* RED WHEN: a read on this page starts from its first header though runs vouch for a later head, or makes a run's identity anywhere but the worker. */
    expect(await vouching!.identity(run)).toBe('ff'.repeat(32));
    expect(t.vouched).toEqual([run]);
  });
});

describe('THE KEY EVERY PAGE OPENS AND SEALS WITH', () => {
  it('COMES FROM THE COMPANY\'S DIRECTORY: NO PAGE TAKES A KEY FROM THE SERVICE\'S COPY BUT AS THIS SEAT\'S SERVED COPY TO BE CHECKED', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = join(process.cwd(), 'apps/web/src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const at = join(dir, name);
        if (statSync(at).isDirectory()) walk(at);
        else if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$|\.test-support\.tsx?$/u.test(name)) files.push(at);
      }
    };
    walk(root);
    /* The judges every page reads a company with are built in shared code from this page's doors: read there too. */
    files.push(join(process.cwd(), 'packages/web-shared/src/company-judges.ts'));
    const uses = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (
      /\b(?:viewingKeyFor|servedKeyFor)\(|\bunwrapKey\(/u.test(line) && !/^\s*(\*|\/\/|\/\*)/u.test(line) ? [{ file: relative(root, f), line: i + 1, text: line.trim() }] : [])));
    /*
     * RED WHEN: a page passes the service's copy of the key, unchecked, as the key a record is opened or sealed with,
     * instead of the company's keys its directory gives (`companyKeysFor`). The judges take it only as this seat's
     * served copy, to be checked against the directory, and as the key the roster record is first opened with.
     */
    const judges = relative(root, files[files.length - 1]!);
    expect(uses.filter((u) => !(u.file === 'adapters/filing-judge.ts' && /served: async \(\) => viewingKeyFor\(/u.test(u.text))
      && !(u.file === judges && (/served: async \(\) => d\.servedKeyFor\(/u.test(u.text) || /^served = d\.servedKeyFor\(rec\);$/u.test(u.text))))).toEqual([]);
    expect(uses.length).toBeGreaterThan(0);
  });

  it('IS ALWAYS THE COMPANY\'S KEYS, NEVER A BARE KEY: EVERY PAGE HANDS SHARED CODE ONLY WHAT `companyKeysFor` MAKES', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = join(process.cwd(), 'apps/web/src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const at = join(dir, name);
        if (statSync(at).isDirectory()) walk(at);
        else if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$|\.test-support\.tsx?$/u.test(name)) files.push(at);
      }
    };
    walk(root);
    const code = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((line, i) => ({ file: relative(root, f), line: i + 1, text: line.trim() })))
      .filter((l) => !/^(\*|\/\/|\/\*)/u.test(l.text));
    /* RED WHEN: a page names the type that takes a bare key, so a key the service served could be handed on as the company's keys. */
    expect(code.filter((l) => /\bKeysHeld\b/u.test(l.text))).toEqual([]);
    /*
     * Every key a page hands to shared code is made by `companyKeysFor`, or is a name the page declared as the company's
     * keys (typed `CompanyKeys` or `CompanyKeyHere`, which a bare key does not satisfy) and passes on as it is.
     * RED WHEN: a page passes a bare key - the served copy, a key the wallet released, a literal - where the company's keys go.
     */
    const handed = code.flatMap((l) => [...l.text.matchAll(/\b(viewingKey|companyKeys)\s*[:=]\s*([^,;)}]+)/gu)].map((m) => ({ ...l, value: m[2]!.trim() })));
    const fromTheDirectory = /^(await companyKeysFor\(|CompanyKeys\b|CompanyKeyHere\b)/u;
    expect(handed.filter((h) => !fromTheDirectory.test(h.value)).map((h) => `${h.file}:${h.line} ${h.value}`)).toEqual([]);
    expect(handed.length).toBeGreaterThan(5);
  });
});

describe('OPENING A COMPANY ON THIS PAGE', () => {
  it('ANCHORS NOTHING AND CHANGES NO KEY: THE PAGE HOLDS NO DOOR FOR EITHER', () => {
    /* RED WHEN: the page can again start an anchor or a change of the company's key, signed with no press in a seat action's window. */
    expect(Object.keys(judged).filter((k) => /anchor|rotation/iu.test(k))).toEqual([]);
  });
});
