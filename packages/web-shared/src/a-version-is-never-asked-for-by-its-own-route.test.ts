/**
 * **A STORE READS A RECORD'S VERSIONS THROUGH THE COMPANY'S VIEW, AND NEVER BY THE ROUTE THAT GIVES ONE VERSION.** The
 * company's records and a vault's pool are read, listed, read at a version and read back after a version is told taken
 * through the reads a page makes, over a service call that keeps every request it is sent. No request is a GET of a
 * single version of a record: a version is taken from the list of every version, read in one read of the company's records.
 */
import { describe, expect, it } from 'vitest';
import { newSigningKeypair, newWrappingKeypair } from '../../../src/core/crypto.js';
import { sealPool } from '../../../src/midnight/vault-pool.js';
import { companyWirePaths, wirePaths } from '../../../src/midnight/sealed-record-wire.js';
import { HttpCompanyRecordStore, HttpSealedPoolStore, readsJoinedIn } from './http-sealed-pool-store.js';
import { companyViewFor, viewHeldOver } from './company-view.js';
import { serviceSource, takenOrThrown, type ServiceCall } from './records-source.js';

const COMPANY = 'acc_one_version';
const VAULT = 'ab'.repeat(32);
const SIGNING = newSigningKeypair();
const READERS = [{ id: 'aa'.repeat(32), wrappingPublicKey: newWrappingKeypair().publicKey }];
const believeAll = async () => Object.assign(() => null, {}) as never;

/* The shapes of the two routes that give one version of a record: a company's record's, and a vault's. */
const ONE_VERSION = [
  new RegExp(
    `^${companyWirePaths.one(COMPANY, 'vendor', 'v1', 1).replace('/vendor/v1/1', '/[^/]+/[^/]+/[0-9]+')}$`,
    'u'
  ),
  new RegExp(
    `^${wirePaths.one(VAULT, 'pool', 1).replace(`/${VAULT}/`, '/[^/]+/').replace('/pool/1', '/[^/]+/[0-9]+')}$`,
    'u'
  )
];

/** The company's service as a step's view reaches it, every request kept in `log`: reads answer nothing filed, a filing is told taken. */
const loggingService =
  (log: string[]): ServiceCall =>
  async (path, init) => {
    const method = init?.method ?? 'GET';
    const body =
      init?.body === undefined
        ? undefined
        : (JSON.parse(String(init.body)) as {
            records?: { every?: boolean; kind?: string; id?: string; vault?: string; record?: string }[];
          });
    log.push(`${method} ${path.split('?')[0]}`);
    if (method === 'PUT')
      return takenOrThrown({ status: 409, body: { refused: 'version-already-filed', version: 1, error: 'taken' } });
    if (path.endsWith('/directory')) return { filings: [] };
    if (path.endsWith('/manifest/newest')) return { versions: (body?.records ?? []).map(() => 0) };
    if (path.endsWith('/vault-records/read')) {
      return {
        records: (body?.records ?? []).map((r) =>
          r.every === true ? { record: r.record, versions: [] } : { record: r.record, filed: null }
        )
      };
    }
    if (path.endsWith('/records/read')) {
      return {
        records: (body?.records ?? []).map((r) =>
          r.every === true ? { kind: r.kind, id: r.id, versions: [] } : { kind: r.kind, id: r.id, filed: null }
        )
      };
    }
    return {};
  };

/** The stores over a step's view of the company, opened again after a write it refused, as every step holds one. */
const storesOver = (call: ServiceCall) => {
  const holders = {
    seats: ['a'],
    approvals: 1,
    adoptedVaults: [VAULT],
    threshold: 1,
    committee: [],
    vaultThresholds: [],
    policyBar: null
  };
  const held = viewHeldOver((from) =>
    companyViewFor(
      serviceSource(call, COMPANY),
      {
        holders: async () => holders,
        onChain: async () => ({ landed: [], now: { approvals: 1 } }) as never,
        builder: { anchorHeads: async () => ({}) as never }
      },
      async () => ({}) as never,
      from
    )
  );
  const joined = readsJoinedIn(held);
  return {
    company: new HttpCompanyRecordStore(COMPANY, joined, SIGNING.secret, believeAll),
    pool: new HttpSealedPoolStore('pool', joined, SIGNING.secret, believeAll)
  };
};

const vendor = {
  company: COMPANY,
  kind: 'vendor',
  id: 'v1',
  version: 1,
  keyEpoch: 0,
  wrapped: [],
  sealed: { iv: '11'.repeat(12), tag: '22'.repeat(16), body: '33' }
} as never;

/** Every request in `log` that asks for a single version of a record. */
const asksForOneVersion = (log: readonly string[]): string[] =>
  log.filter((line) => line.startsWith('GET ') && ONE_VERSION.some((shape) => shape.test(line.slice('GET '.length))));

describe("a store reads versions through the company's view, and never by the route of one version", () => {
  it('finds the route of one version in a request log, and no other read', () => {
    /* RED WHEN: this check no longer knows the route that gives one version, so it would pass whatever the stores asked. */
    expect(asksForOneVersion([`GET ${companyWirePaths.one(COMPANY, 'vendor', 'v1', 3)}`])).toHaveLength(1);
    expect(asksForOneVersion([`GET ${wirePaths.one(VAULT, 'pool', 2)}`])).toHaveLength(1);
    expect(
      asksForOneVersion([
        `GET ${companyWirePaths.newest(COMPANY, 'vendor', 'v1')}`,
        `GET ${companyWirePaths.versions(COMPANY, 'vendor', 'v1')}`,
        `GET ${wirePaths.newest(VAULT, 'pool')}`,
        `GET ${wirePaths.versions(VAULT, 'pool')}`,
        `PUT ${companyWirePaths.one(COMPANY, 'vendor', 'v1', 1)}`,
        `POST /api/accounts/${COMPANY}/records/read`
      ])
    ).toEqual([]);
  });

  it("reads a company's record, its list, one version of it and a version told taken without asking for one version", async () => {
    const log: string[] = [];
    const { company } = storesOver(loggingService(log));
    await company.get('vendor', 'v1');
    await company.versions('vendor', 'v1');
    await company.at('vendor', 'v1', 1);
    await company.put(vendor).catch(() => undefined);
    /* RED WHEN: the store asks the service for a single version of a company's record: a request log of one read answers it from its own list. */
    const filing = log.indexOf(`PUT ${companyWirePaths.one(COMPANY, 'vendor', 'v1', 1)}`);
    expect(filing, 'the filing was never sent').toBeGreaterThan(-1);
    expect(
      log.slice(filing).filter((l) => l === `POST /api/accounts/${COMPANY}/records/read`),
      'the taken version was not read back'
    ).toHaveLength(1);
    expect(log.filter((l) => l === `POST /api/accounts/${COMPANY}/records/read`).length).toBeGreaterThanOrEqual(3);
    expect(asksForOneVersion(log)).toEqual([]);
  });

  it("reads a vault's pool, its list and a version told taken without asking for one version", async () => {
    const log: string[] = [];
    const { pool } = storesOver(loggingService(log));
    await pool.get(VAULT);
    await pool.versions(VAULT);
    await pool.put(VAULT, sealPool(VAULT, { notes: [] } as never, READERS, 1, 'pool')).catch(() => undefined);
    /* RED WHEN: the store asks the service for a single version of a vault's record, in a read, a list or the read back of a taken version. */
    const filing = log.findIndex((l) => l.startsWith('PUT '));
    expect(filing, 'the filing was never sent').toBeGreaterThan(-1);
    expect(
      log.slice(filing).filter((l) => l === `POST /api/accounts/${COMPANY}/vault-records/read`),
      'the taken version was not read back'
    ).toHaveLength(1);
    expect(log.filter((l) => l === `POST /api/accounts/${COMPANY}/vault-records/read`).length).toBeGreaterThanOrEqual(
      3
    );
    expect(asksForOneVersion(log)).toEqual([]);
  });
});
