// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountKeys } from 'vaults-web-shared/keyring.js';
import type { AnchorDoors } from 'vaults-web-shared/records-anchored-here.js';
import type { SealedAccount } from '../../../../src/core/types.js';

/*
 * THE ONE-A-DAY ANCHOR AS THIS PAGE STARTS IT, AND THE ACCOUNT'S ANCHORS AS IT
 * READS THEM. The page's vault worker, the person's wallet and the anchor
 * itself are stood in for; what is checked is what this adapter hands each:
 * which keys reach the anchor, the company it is for, and where the account's
 * anchors are read - the indexer the person's own wallet names, and only there.
 */
const t = vi.hoisted(() => ({
  indexer: { indexerUri: 'https://indexer.wallet.example/api', indexerWsUri: 'wss://indexer.wallet.example/ws' } as { indexerUri: string; indexerWsUri: string } | null,
  doors: [] as AnchorDoors[],
  held: [] as Array<Record<string, unknown>>,
  asked: [] as Array<{ account: string; indexer: unknown }>,
  builder: null as Error | null,
  vouched: [] as unknown[],
  paths: [] as string[],
  filed: [] as Array<{ company: string; filing: unknown }>,
  /* While set, the company as the page opens it and who its roster admitted, as a change of the company's key reads it. */
  rotation: null as { admitted: ReadonlySet<string> | Error; asked: unknown[] } | null,
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
  anchoredOnTheWayIn: async (doors: AnchorDoors) => { t.doors.push(doors); return { anchored: 0, head: '00'.repeat(32) }; },
  heldFor: (doors: Record<string, unknown>) => async () => { t.held.push(doors); return { held: undefined }; },
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  holdersFromTheWallet: async () => ({ holders: {}, indexer: t.indexer }),
  api: async (path: string) => { t.paths.push(path); throw new Error('the service is stood in for'); },
  ...(await (async () => {
    const real = await import('vaults-web-shared/keyring.js');
    const when = <F extends (...a: never[]) => unknown>(stood: F, own: F) => ((...a: never[]) => (t.rotation === null ? own(...a) : stood(...a))) as F;
    return {
      keysFor: when((() => ({ signerId: 's1', signingSecret: '01'.repeat(32) })) as never, real.keysFor),
      viewingKeyFor: when((() => '05'.repeat(32)) as never, real.viewingKeyFor),
      companyKeyReleasedFor: when((() => null) as never, real.companyKeyReleasedFor),
      /* The believed roster names one seat the roster as admitted does not, so a door that reads the wrong one says so. */
      openAccount: when((async () => ({ signers: [{ status: 'active', leafCommitment: 'aa'.repeat(32) }], notBelieved: [] })) as never, real.openAccount),
      seatsAdmittedFor: when((async (rec: unknown) => {
        t.rotation!.asked.push(rec);
        if (t.rotation!.admitted instanceof Error) throw t.rotation!.admitted;
        return t.rotation!.admitted;
      }) as never, real.seatsAdmittedFor),
    };
  })()),
}));
vi.mock('vaults-web-shared/vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/vault-page-doors.js')>()),
  fileDirectoryFiling: async (_api: unknown, company: string, filing: unknown) => { t.filed.push({ company, filing }); },
  directoryFilingsFrom: async (...a: unknown[]) => (t.rotation === null
    ? (await real<typeof import('vaults-web-shared/vault-page-doors.js')>()).directoryFilingsFrom(...(a as [never, never])) : []),
}));

const { anchoredOnTheWayInFor, anchorsOnChainFor, NOT_ANCHORED, rosterReadsFor, rotationDoorsFor } = await import('./filing-judge.js');
const english = (await import('../locales/en.json')).default as Record<string, string>;

const LABEL = `co_${'a7'.repeat(32)}`;
const ACCOUNT = 'b7'.repeat(32);
const sealed = { id: 'acc_northwind', companyLabel: LABEL, contractAddress: ACCOUNT } as unknown as SealedAccount;
const keys = {
  signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32),
} as unknown as AccountKeys;
const roster = async () => ({ signers: [] });

beforeEach(() => {
  t.doors.length = 0; t.held.length = 0; t.asked.length = 0; t.builder = null; t.vouched.length = 0; t.paths.length = 0; t.filed.length = 0;
  t.indexer = { indexerUri: 'https://indexer.wallet.example/api', indexerWsUri: 'wss://indexer.wallet.example/ws' };
});

describe('THE ONE-A-DAY ANCHOR, AS THIS PAGE STARTS IT ON THE WAY INTO A COMPANY', () => {
  it('HANDS THE ANCHOR THIS SEAT\'S OWN THREE KEYS, EACH IN ITS PLACE, FOR THIS COMPANY, AND THE ACCOUNT\'S ANCHORS AT THE WALLET\'S INDEXER', async () => {
    expect(await anchoredOnTheWayInFor(sealed, keys, roster)).toEqual({ anchored: 0, head: '00'.repeat(32) });
    const [doors] = t.doors;
    /* RED WHEN: a key reaches the anchor in another's place - a batch signed or a call proved under the wrong key. */
    expect(doors!.material).toEqual({ signingSecret: '01'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32) });
    /* RED WHEN: the anchor is started for another company than the one entered. */
    expect(doors!.accountId).toBe('acc_northwind');
    /* RED WHEN: the account's anchors are read anywhere but the indexer the person's own wallet names, or for another account. */
    expect(await doors!.onChain()).toEqual([{ head: 'aa'.repeat(32) }]);
    expect(t.asked).toEqual([{ account: ACCOUNT, indexer: t.indexer }]);
  });

  it('A COMPANY WITH NO ACCOUNT ON THE CHAIN, OR A WORKER THAT DOES NOT START, IS ANSWERED, NEVER THROWN', async () => {
    /* RED WHEN: a company with no account is anchored, its answer is thrown into the page's entry, or it is answered with anything but its code. */
    expect(await anchoredOnTheWayInFor({ ...sealed, contractAddress: undefined } as unknown as SealedAccount, keys, roster))
      .toEqual({ notAnchored: NOT_ANCHORED.noAccount });
    /* RED WHEN: the English file has no words for that code. */
    expect(english['records.notAnchored.noAccount']).toMatch(/not on the network/u);
    t.builder = new Error('the vault worker did not start');
    /* RED WHEN: a failure building the anchor's doors is thrown - entering the company would reject unseen. */
    await expect(anchoredOnTheWayInFor(sealed, keys, roster)).resolves.toEqual({ notAnchored: 'the vault worker did not start' });
    t.builder = 'not an error' as unknown as Error;
    /* RED WHEN: a failure thrown as something other than an error is thrown on, or answered with a code the English file has no words for. */
    await expect(anchoredOnTheWayInFor(sealed, keys, roster)).resolves.toEqual({ notAnchored: 'did-not-finish' });
    expect(english['act.refused.didNotFinish']).toBeTruthy();
    expect(t.doors).toEqual([]);
  });

  it('FILES A CHANGE OF THE DIRECTORY AGAIN FOR THIS COMPANY, BY THE ONE WAY A FILING IS SENT', async () => {
    await anchoredOnTheWayInFor(sealed, keys, roster);
    /* A filing naming another company, so a filing sent by the company it names, not the one entered, shows. */
    const filing = { company: 'acc_other', version: 3, change: { kind: 'claim' } };
    await t.doors[0]!.fileDirectory!(filing as never);
    /* RED WHEN: the anchor's filing of a change goes any way but the shared one, for another company, or hands on another filing. */
    expect(t.filed).toEqual([{ company: 'acc_northwind', filing }]);
  });

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
    /* RED WHEN: with no indexer from the wallet, the anchors are read elsewhere - the service's, or a default. */
    await expect(anchorsOnChainFor(LABEL as never, ACCOUNT as never)()).rejects.toThrow(/your wallet did not name the indexer it reads the chain through/u);
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
    /* RED WHEN: the one-a-day anchor, on the way in, reads from the first header where a run vouches for a later one. */
    await anchoredOnTheWayInFor(sealed, keys, roster);
    expect(t.doors[0]!.vouching).toBeDefined();
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
    const uses = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (
      /\bviewingKeyFor\(|\bunwrapKey\(/u.test(line) && !/^\s*(\*|\/\/|\/\*)/u.test(line) ? [{ file: relative(root, f), line: i + 1, text: line.trim() }] : [])));
    /*
     * RED WHEN: a page passes the service's copy of the key, unchecked, as the key a record is opened or sealed with,
     * instead of the company's keys its directory gives (`companyKeysFor`).
     */
    expect(uses.filter((u) => !(u.file === 'adapters/filing-judge.ts' && /served: async \(\) => viewingKeyFor\(/u.test(u.text)))).toEqual([]);
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

describe('A CHANGE OF THE COMPANY\'S KEY, AS THIS PAGE READS WHO THE ROSTER ADMITTED', () => {
  it('reads it afresh from the roster as admitted, not from the entries this page believes, and a failed read reaches the change', async () => {
    t.rotation = { admitted: new Set(['dd'.repeat(32)]), asked: [] };
    try {
      let reads = 0;
      const doors = (await rotationDoorsFor('acc_northwind', async () => { reads += 1; return sealed; }, keys))!;
      const before = reads;
      /* RED WHEN: the change of key takes who was admitted from the entries the directory proves, which leaves out a seat admitted and not yet entered. */
      expect(await doors.admitted!()).toEqual(new Set(['dd'.repeat(32)]));
      /* RED WHEN: who was admitted is read once when the doors are made rather than afresh for each change of the key. */
      expect([reads - before, t.rotation.asked]).toEqual([1, [sealed]]);
      t.rotation.admitted = new Error('the roster was withheld');
      /* RED WHEN: a roster read that fails is answered as admitting nobody instead of reaching the change, which then waits. */
      await expect(doors.admitted!()).rejects.toThrow(/withheld/u);
    } finally {
      t.rotation = null;
    }
  });
});
