/**
 * **THE JUDGES OF ONE VIEW READ THE COMPANY ONCE BETWEEN THEM.** Two judges and the opening of the company's keys,
 * made in one view, read the directory's filings once, who holds the company once and the anchored records once; the
 * same three without a view read each as often as they did before views, once for every read they make.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { SealedAccount } from '../../../src/core/types.js';
import type { RecordsAsked } from '../../../src/midnight/records-held.js';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import type { JudgeView } from './company-view-judges.js';
import { treeKeptInMemory } from './tree-kept-here.js';
import type { DirectoryHereDeps } from './vault-page-doors.js';

/* Every held read made, with what it was asked; each reads the chain's anchors and the directory it was handed. */
const held = vi.hoisted(() => ({ asked: [] as unknown[] }));
vi.mock('./records-held-here.js', async (real) => {
  const recordsHeldHere = async (
    doors: { onChain: () => Promise<unknown>; directory: () => Promise<unknown> },
    asked: unknown
  ) => {
    held.asked.push(asked);
    await Promise.all([doors.onChain(), doors.directory()]);
    return { records: { asked } };
  };
  return {
    ...(await real<typeof import('./records-held-here.js')>()),
    recordsHeldHere,
    heldFor: (doors: { onChain: () => Promise<unknown> }) => async (directory: unknown, asked: unknown) =>
      (await recordsHeldHere({ ...doors, directory: async () => directory }, asked)).records
  };
});

/* The directory as a judge reads it: its filings, who holds the company and the roster's statements, then its records held. */
const readHere = async (deps: DirectoryHereDeps, asked: RecordsAsked = {}) => {
  await Promise.all([deps.filings(), deps.holders(), deps.attested()]);
  return { dir: { seats: [] }, records: await deps.anchored({} as never, asked) };
};
vi.mock('./vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('./vault-page-doors.js')>()),
  directoryHere: readHere,
  directoryJudge: (deps: DirectoryHereDeps) => async (asked?: RecordsAsked) => {
    await readHere(deps, asked);
    return Object.assign(() => null, {});
  }
}));

/* The company's keys opened with their doors: the directory read, the filings read, and the grants judged. */
vi.mock('./company-key-here.js', async (real) => ({
  ...(await real<typeof import('./company-key-here.js')>()),
  keysInTheFilings: async () => ({ epoch: 0, key: 'aa'.repeat(32), newest: 0 }),
  companyKeyHere: async (doors: {
    records: { directory: () => Promise<unknown> };
    filings: () => Promise<unknown>;
    revoked: () => Promise<unknown>;
  }) => {
    await doors.records.directory();
    await doors.filings();
    await doors.revoked();
    return { epoch: 0, key: 'aa'.repeat(32), newest: 0 };
  }
}));
vi.mock('./purpose-wraps.js', async (real) => ({
  ...(await real<typeof import('./purpose-wraps.js')>()),
  revokedAtHere: async (doors: {
    versions: () => Promise<unknown>;
    directory: (asked: RecordsAsked) => Promise<unknown>;
  }) => {
    await Promise.all([doors.versions(), doors.directory({ kinds: [{ store: 'company', kind: 'grants' }] })]);
    return null;
  }
}));

const { companyJudges } = await import('./company-judges.js');
const { companyViewFor } = await import('./company-view.js');
const { serviceSource } = await import('./records-source.js');

const CO = 'acc_once';
const LABEL = `co_${'a7'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'b7'.repeat(32) as AccountAddress;
const SEAT = 'ab'.repeat(32);
const sealed = { id: CO, companyLabel: LABEL, contractAddress: ACCOUNT, wrappedKeys: [] } as unknown as SealedAccount;
/** Who holds the company: one seat-less account needing one approval. */
const HOLDERS: AccountHoldersRead = {
  account: ACCOUNT,
  committee: [],
  threshold: 1,
  seats: [],
  approvals: 1,
  vaultThresholds: [],
  policyBar: null,
  seatBar: 1,
  adoptedVaults: [],
  founding: '',
  foundingCommittee: []
};
const RUN = { store: 'company' as const, kind: 'run', id: 'r1' };

/** A company's service in memory, counting each request by its path's end; who holds it and its anchors, counted too. */
const aCompany = () => {
  const n = { directory: 0, newest: 0, records: 0, grants: 0, holders: 0, onChain: 0 };
  const filings: unknown[] = [];
  const api = async (path: string, init?: RequestInit): Promise<unknown> => {
    const p = path.split('?')[0]!;
    if (p.includes('/directory/') && init?.method === 'PUT') {
      filings.push(JSON.parse(String(init.body)));
      return {};
    }
    if (p.endsWith('/directory')) {
      n.directory += 1;
      return { filings: [...filings] };
    }
    if (p.endsWith('/manifest/newest')) {
      n.newest += 1;
      return { versions: JSON.parse(String(init?.body)).records.map(() => 0) };
    }
    if (p.endsWith('/records/read')) {
      n.records += 1;
      return { records: [{ kind: 'grants', id: 'read-grants', versions: [] }] };
    }
    if (p.endsWith('/records/grants/read-grants/versions')) {
      n.grants += 1;
      return { versions: [] };
    }
    return {};
  };
  const holders = async (): Promise<AccountHoldersRead> => {
    n.holders += 1;
    return HOLDERS;
  };
  const builder = {
    anchorsOnChain: async () => {
      n.onChain += 1;
      return { landed: [], now: { approvals: 1 } };
    }
  };
  return { n, api, holders, builder };
};

/** The view the last judges built here read through. */
let lastView: JudgeView | null = null;

/** The judges of a seat on the company, reading through its view. */
const judgesOf = (c: ReturnType<typeof aCompany>) => {
  let view: JudgeView | null = null;
  const judges = companyJudges({
    view: () => view!,
    indexer: async () => ({ indexerUri: 'http://indexer', indexerWsUri: 'ws://indexer' }),
    builder: async () => c.builder as never,
    keysFor: () => ({ signerId: 's1', signingPublicKey: SEAT }),
    servedKeyFor: () => 'ee'.repeat(32) as never,
    released: () => 'ff'.repeat(32) as never,
    askReleased: async () => null,
    treeKept: () => treeKeptInMemory(),
    openAccount: async () => null,
    seatsAdmittedFor: async () => new Set(),
    noAccount: () => {
      throw new Error('no account');
    }
  });
  view = companyViewFor(
    serviceSource(c.api, CO),
    {
      holders: c.holders,
      onChain: async () => {
        c.n.onChain += 1;
        return { landed: [], now: { approvals: 1 } } as never;
      },
      builder: { anchorHeads: async () => ({}) as never }
    },
    judges.heldReaderFor(CO, ACCOUNT)
  );
  view.declare({ records: [RUN], kinds: [{ store: 'company', kind: 'grants' }] });
  lastView = view;
  return judges;
};

/** Two judges and the opening of the company's keys, as a step reads them. */
const twoJudgesAndTheKeys = async (judges: ReturnType<typeof companyJudges>) => {
  const keys = await judges.companyKeysFor(CO, sealed, { signingPublicKey: SEAT as never });
  const roster = async () => ({ signers: [] });
  await judges.filingJudgeFor(CO, LABEL, ACCOUNT, keys as never, roster)({ records: [RUN] });
  await judges.filingJudgeFor(CO, LABEL, ACCOUNT, keys as never, roster)({ records: [RUN] });
};

beforeEach(() => {
  held.asked.length = 0;
});

describe('THE JUDGES OF ONE VIEW', () => {
  it('READ THE DIRECTORY, WHO HOLDS THE COMPANY AND ITS ANCHORED RECORDS ONCE BETWEEN THEM', async () => {
    const c = aCompany();
    await twoJudgesAndTheKeys(judgesOf(c));
    /*
     * RED WHEN: a judge or the keys' opening reads the company again inside one view. The view's start reads the
     * filings, who holds the company and the grants' newest version once, and every read after shares them.
     */
    expect(c.n.directory).toBe(1);
    expect(c.n.holders).toBe(1);
    expect(held.asked).toHaveLength(1);
    expect(c.n.onChain).toBe(1);
    expect(c.n.records).toBe(1);
    expect(c.n.grants).toBe(0);
    /* One newest at the view's start, for the grants; one more beside the held read, for the records it proves. */
    expect(c.n.newest).toBe(2);
  });
});

describe('THE RECORD STORES OF ONE VIEW', () => {
  it('READ THE RECORDS ASKED IN ONE TURN IN ONE REQUEST, AND SEND NOTHING THEMSELVES', async () => {
    const { HttpCompanyRecordStore, HttpSealedPoolStore, readsJoinedIn } = await import('./http-sealed-pool-store.js');
    const c = aCompany();
    const asked: {
      path: string;
      body: { records: { vault?: string; record?: string; kind?: string; id?: string }[] };
    }[] = [];
    const api = async (path: string, init?: RequestInit): Promise<unknown> => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      if (path.endsWith('/vault-records/read')) {
        asked.push({ path, body });
        return { records: body.records.map((r: { record: string }) => ({ record: r.record, filed: null })) };
      }
      if (path.endsWith('/manifest/newest')) return { versions: body.records.map(() => 0) };
      if (path.endsWith('/records/read')) {
        asked.push({ path, body });
        return {
          records: body.records.map((r: { kind: string; id: string }) => ({ kind: r.kind, id: r.id, filed: null }))
        };
      }
      return c.api(path);
    };
    const view = companyViewFor(
      serviceSource(api, CO),
      {
        holders: c.holders,
        onChain: async () => ({}) as never,
        builder: { anchorHeads: async () => ({}) as never }
      },
      async () => {
        throw new Error('no held read here');
      }
    );
    const judge = async () => Object.assign(() => null, {});
    const joined = readsJoinedIn({ current: () => view });
    const pool = new HttpSealedPoolStore('pool', joined, null, judge);
    const company = new HttpCompanyRecordStore(CO, joined, null, judge);
    const got = await Promise.all([pool.get('1a'.repeat(32)), pool.get('2b'.repeat(32)), company.get('run', 'r1')]);
    /* RED WHEN: a store reads its record with a request of its own while the company's view is open. */
    expect(got).toEqual([null, null, null]);
    expect(asked.filter((a) => a.path.endsWith('/vault-records/read')).map((a) => a.body.records.length)).toEqual([2]);
    expect(asked.filter((a) => a.path.endsWith('/records/read')).map((a) => a.body.records.length)).toEqual([1]);
  });
});

/** A vault's records kept by a service in memory: filings, entries and the directory, with every request sent. */
const aVaultService = () => {
  const s = { directory: 1, filed: [] as unknown[], newest: new Map<string, number>(), sent: [] as string[] };
  const api = async (path: string, init?: RequestInit): Promise<unknown> => {
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    s.sent.push(`${method} ${path}`);
    if (method === 'PUT') {
      s.filed.push(body);
      return { filed: true, record: 'pool', version: body.version, digest: body.digest };
    }
    if (path.endsWith('/manifest/entries')) {
      for (const e of body.entries) s.newest.set(`${e.store}:${e.kind}:${e.id}`, e.version);
      return {};
    }
    if (path.endsWith('/manifest/newest'))
      return {
        versions: body.records.map(
          (r: { store: string; kind: string; id: string }) => s.newest.get(`${r.store}:${r.kind}:${r.id}`) ?? 0
        )
      };
    if (path.endsWith('/directory'))
      return { filings: Array.from({ length: s.directory }, (_, i) => ({ company: CO, version: i + 1 })) };
    if (path.endsWith('/vault-records/read'))
      return {
        records: body.records.map((r: { record: string }) => ({ record: r.record, filed: s.filed.at(-1) ?? null }))
      };
    return {};
  };
  return { s, api };
};

describe('A STORE READING THROUGH THE VIEW FILES THROUGH IT', () => {
  const VAULT = 'ab'.repeat(32);
  const opened = async () => {
    const { newSigningKeypair, newWrappingKeypair } = await import('../../../src/core/crypto.js');
    const { sealPool } = await import('../../../src/midnight/vault-pool.js');
    const { HttpSealedPoolStore, readsJoinedIn } = await import('./http-sealed-pool-store.js');
    const service = aVaultService();
    const view = companyViewFor(
      serviceSource(service.api, CO),
      {
        holders: async () => HOLDERS,
        onChain: async () => ({}) as never,
        builder: { anchorHeads: async () => ({}) as never }
      },
      async () => {
        throw new Error('no held read here');
      }
    );
    const store = new HttpSealedPoolStore(
      'pool',
      readsJoinedIn({ current: () => view }),
      newSigningKeypair().secret,
      async () => Object.assign(() => null, {})
    );
    const pool = (version: number) =>
      sealPool(
        VAULT,
        { notes: [] } as never,
        [{ id: 'aa'.repeat(32), wrappingPublicKey: newWrappingKeypair().publicKey }],
        version,
        'pool'
      );
    return { service, view, store, pool };
  };

  it('A GET AFTER ITS OWN PUT ANSWERS THE NEW VERSION, AND ITS OWN FILING DOES NOT STOP THE STEP', async () => {
    const { service, view, store, pool } = await opened();
    expect(await store.get(VAULT)).toBeNull();
    await store.put(VAULT, pool(1));
    /* RED WHEN: the view keeps the answer it gave before the store's own filing. */
    expect((await store.get(VAULT))?.version).toBe(1);
    /* RED WHEN: the store's own filing is taken as another signer's change at the next check. */
    await expect(view.stillAsRead()).resolves.toEqual(HOLDERS);
    expect(service.s.newest.get(`vault:pool:${VAULT}`)).toBe(1);
  });

  it('A CHANGE BY ANOTHER SIGNER BEFORE THE PUT STOPS IT, WITH NOTHING SENT', async () => {
    const { CompanyChangedMeanwhile } = await import('./company-view-probe.js');
    const { service, store, pool } = await opened();
    expect(await store.get(VAULT)).toBeNull();
    service.s.directory = 2;
    /* RED WHEN: a store reading through the view files without the view's check first. */
    await expect(store.put(VAULT, pool(1))).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
    expect(service.s.sent.filter((x) => x.startsWith('PUT'))).toEqual([]);
    expect(service.s.filed).toEqual([]);
  });
});

describe('A VIEW OF ANOTHER COMPANY', () => {
  it('IS REFUSED BY NAME, AND NOTHING IS READ THROUGH IT', async () => {
    const c = aCompany();
    const other = companyViewFor(
      serviceSource(c.api, 'acc_other'),
      {
        holders: c.holders,
        onChain: async () => ({}) as never,
        builder: { anchorHeads: async () => ({}) as never }
      },
      async () => {
        throw new Error('no held read here');
      }
    );
    const { judgeReadsOf } = await import('./company-view-judges.js');
    /* RED WHEN: a view handed in for another company is read as this one's. */
    expect(() => judgeReadsOf({ view: () => other }, CO)).toThrow(/acc_other was handed in for company acc_once/u);
    expect(c.n.directory).toBe(0);
  });
});

describe('TWO DIRECTORIES IN ONE VIEW', () => {
  it("EACH HAS ITS RECORDS JUDGED AGAINST ITSELF: ONE BELIEVING ANOTHER SEAT IS NOT GIVEN THE OTHER'S HELD READ", async () => {
    const c = aCompany();
    const judges = judgesOf(c);
    const anchored = judges.anchoredHere(CO, LABEL, ACCOUNT);
    const narrow = { dir: { version: 1, seats: [{ seat: 's1' }] }, holders: HOLDERS } as never;
    const wide = { dir: { version: 1, seats: [{ seat: 's1' }, { seat: 's2' }] }, holders: HOLDERS } as never;
    const judgedNarrow = await anchored(narrow, { records: [RUN] });
    const judgedWide = await anchored(wide, { records: [RUN] });
    /* RED WHEN: the view's one held read, judged against the first directory, is handed to a directory believing other seats. */
    expect(held.asked).toHaveLength(2);
    expect(judgedWide).not.toBe(judgedNarrow);
    /* The same directory read again shares the view's held read. */
    await anchored({ dir: { version: 1, seats: [{ seat: 's1' }] }, holders: HOLDERS } as never, { records: [RUN] });
    expect(held.asked).toHaveLength(2);
  });
});

describe('A HELD READ AFTER THE DIRECTORY CHANGED IN THE VIEW', () => {
  it('IS REFUSED, NEVER JUDGED AGAINST THE DIRECTORY READ BEFORE THE CHANGE', async () => {
    const c = aCompany();
    const judges = judgesOf(c);
    await judges.anchoredHere(
      CO,
      LABEL,
      ACCOUNT
    )({ dir: { version: 0, seats: [] }, holders: HOLDERS } as never, { records: [RUN] });
    const view = lastView!;
    await view.write([{ to: 'directory', filing: { company: CO, version: 1 } as never }]);
    /* RED WHEN: the view's held read, dropped by the write, is read again against the directory handed before it. */
    await expect(view.held()).rejects.toThrow(/directory changed since/u);
  });
});
