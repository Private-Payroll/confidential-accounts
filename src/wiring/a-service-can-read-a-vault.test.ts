/**
 * **A SERVICE THAT CANNOT READ A VAULT REFUSES EVERY ROUND THAT MOVES MONEY,
 * AND BOTH OF THIS PRODUCT'S SERVICES COULD NOT.**
 *
 * The reader itself is pinned next door, over a hand-made client
 * (`src/midnight/vault-holdings.test.ts`). What was never pinned, and is the
 * whole of this file, is the WIRING: that the builder a service is handed
 * produces a reader that reads the chain, that it reads the VAULT's artefacts
 * rather than the account's, that it builds its provider bundle once, that it
 * refuses the question it genuinely cannot answer instead of inventing a
 * number, and that both construction sites actually pass it.
 *
 * **THE LAST ONE IS A TEXT CHECK AND IT IS DELIBERATE.** A service is built at
 * module scope in a file that starts a server, so there is no object to
 * inspect. What can regress is an argument being dropped, and the arguments are
 * countable where they are written. A check that counts them is narrow and
 * true; a check that imported the server would be neither.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountService } from '../core/account.js';
import { SimulatedLedger, SimulatedCommitments, type Ledger } from '../core/ledger.js';
import { FileStore } from '../core/store-file.js';
import { assets as productAssets, ledgerTokenOf } from '../core/assets.js';
import { VaultCannotPayThisProposal } from '../core/vault-holdings.js';
import type { Deployment } from './deployment.js';
import type { Hex } from '../core/crypto.js';

/**
 * **THE PROVIDER BUNDLE IS THE ONE THING A TEST HAS TO SUPPLY**, because it is
 * the only part of this that reaches a network. Everything else below is the
 * product's own code, unmocked.
 *
 * `built` counts the bundles made and `bundles` keeps what each was asked for,
 * so the memoisation and the artefacts path are read off the calls rather than
 * off the source.
 */
const bundles: Array<Record<string, unknown>> = [];
const rows: { value: Array<{ tokenType: string; balance: bigint }> | null } = { value: [] };
/** Set to make the NEXT bundle build fail, the way an unreachable indexer would. */
const failNextBuild = { value: false };

vi.mock('../midnight/providers.js', () => ({
  midnightProviders: async (b: Record<string, unknown>) => {
    bundles.push(b);
    if (failNextBuild.value) {
      failNextBuild.value = false;
      throw new Error('the indexer could not be reached');
    }
    return {
      publicDataProvider: {
        queryUnshieldedBalances: async () => rows.value,
        queryContractState: async () => null,
      },
    };
  },
}));

const { chainVaultHoldingsFor, vaultConfigFor } = await import('./chain.js');
const { holdingsFor } = await import('./product.js');

const VAULT: Hex = 'e3'.repeat(32);
const NIGHT = ledgerTokenOf('NIGHT', 'unshielded');

const DEPLOYMENT: Deployment = {
  network: 'stagenet',
  contractAddress: 'bcb61fef',
  indexerUrl: 'https://indexer.example/api/v4/graphql',
  indexerWsUrl: 'wss://indexer.example/api/v4/graphql/ws',
  nodeUrl: 'https://rpc.example',
  proverUrl: 'http://prover.invalid:1',
  sealedStateRoot: '/nowhere/.midnight/sealed',
  privateStateId: 'confidential-accounts-stagenet',
  zkConfigPath: '/nowhere/contracts/managed',
  vaultZkConfigPath: '/nowhere/contracts/managed-vault',
};

beforeEach(() => { bundles.length = 0; rows.value = []; failNextBuild.value = false; });

/** A service over the simulated ledger, given the reader the product builds. */
const serviceWith = (holds: Array<[string, bigint]>) => {
  rows.value = holds.map(([tokenType, balance]) => ({ tokenType, balance }));
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s116-')), 'db.json'));
  const inner = new SimulatedLedger(SimulatedCommitments);
  const raised = { count: 0 };
  const ledger = new Proxy(inner, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (prop === 'proposeRun') {
        return async (...a: unknown[]) => { raised.count++; return value.apply(target, a); };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Ledger;
  const accounts = new AccountService(
    store, ledger, SimulatedCommitments, productAssets, chainVaultHoldingsFor(DEPLOYMENT));
  return { accounts, raised };
};

const raiseNight = async (h: ReturnType<typeof serviceWith>, amount: bigint) => {
  const created = await h.accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  return h.accounts.proposeRun({
    accountId: created.account.id, viewingKey: created.viewingKey,
    summary: 'paying from the vault',
    payload: { entries: [{
      id: 'e0', kind: 'transfer', asset: 'NIGHT', amount, counterparty: 'payee 0', memo: '', at: '',
    }] },
    asset: 'NIGHT',
    run: {
      root: 'd1'.repeat(32), payees: 1n,
      opensAt: 1_900_000_000n, closesAt: 1_900_086_400n, vault: VAULT,
    },
    payments: [{ payee: { kind: 'unshielded' }, token: NIGHT, amount }],
    proposedBy: created.secrets[0]!.signerId,
  });
};

describe('§1 the reader a service is handed reads the chain, and a run turns on what it says', () => {
  it('REFUSES a public run when the chain says the vault holds less', async () => {
    /* RED WHEN the service is built without the reader, or the reader answers from anywhere
     * but the indexer's figure for this contract. */
    const h = serviceWith([[NIGHT, 9_999_999n]]);
    const failed = await raiseNight(h, 10_000_000n)
      .then(() => null, (e: unknown) => e as VaultCannotPayThisProposal);
    expect(failed).toBeInstanceOf(VaultCannotPayThisProposal);
    expect(failed!.message).toMatch(
      /holds 9\.999999 NIGHT publicly and this proposal asks it to pay 10\.000000/);
    expect(h.raised.count).toBe(0);
  });

  it('RAISES the same run when the chain says the vault holds it', async () => {
    /* RED WHEN the reader refuses what the chain confirms — the half that a refusing
     * reader would pass by refusing everything. */
    const h = serviceWith([[NIGHT, 10_000_000n]]);
    await raiseNight(h, 10_000_000n);
    expect(h.raised.count).toBe(1);
  });

  it('READS THE VAULT\'S ARTEFACTS, NOT THE ACCOUNT\'S', async () => {
    /* RED WHEN the builder passes `d.zkConfigPath`. A client pointed at the wrong
     * contract's assets is confidently wrong rather than absent. */
    const reader = chainVaultHoldingsFor(DEPLOYMENT);
    await reader.held(VAULT, 'unshielded', NIGHT);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.artifactsPath).toBe(DEPLOYMENT.vaultZkConfigPath);
  });

  it('THE VAULT CLIENT\'S CONFIG CARRIES THE VAULT\'S ARTEFACTS, NOT THE ACCOUNT\'S', () => {
    /* RED WHEN the correction is reverted to `configFor(d)`. `configFor` builds
     * the account's path; nothing on a vault client reads the field today, which
     * is exactly why reverting it would be silent. */
    expect(vaultConfigFor(DEPLOYMENT).zkConfigPath).toBe(DEPLOYMENT.vaultZkConfigPath);
    expect(vaultConfigFor(DEPLOYMENT).indexerUrl).toBe(DEPLOYMENT.indexerUrl);
  });

  it('BUILDS ITS PROVIDER BUNDLE ONCE, however many times it is asked', async () => {
    /* RED WHEN the factory is not memoised. The client calls it more than once per
     * question, and an unmemoised factory opens a private-state store per call. */
    const reader = chainVaultHoldingsFor(DEPLOYMENT);
    await reader.held(VAULT, 'unshielded', NIGHT);
    await reader.held(VAULT, 'unshielded', NIGHT);
    await reader.fits(VAULT, [{ payee: { kind: 'unshielded' }, token: NIGHT, amount: 1n }]);
    expect(bundles).toHaveLength(1);
  });

  it('A FAILED BUILD IS NOT REMEMBERED: the next read tries again', async () => {
    /* RED WHEN the memoised promise keeps a rejection. An indexer unreachable at
     * the first read would then make this service tell everybody the vault could
     * not be established until somebody restarted it — a sentence inviting a
     * retry for a failure that can never clear. */
    const reader = chainVaultHoldingsFor(DEPLOYMENT);
    failNextBuild.value = true;
    await expect(reader.held(VAULT, 'unshielded', NIGHT)).rejects.toThrow(/indexer could not be reached/);
    rows.value = [{ tokenType: NIGHT, balance: 3n }];
    expect(await reader.held(VAULT, 'unshielded', NIGHT)).toEqual({ of: 'held', amount: 3n });
    expect(bundles).toHaveLength(2);
  });

  it('REFUSES A PRIVATE BALANCE BY NAME, because a server holds no note pool', async () => {
    /* RED WHEN the pool answers instead of refusing. An empty pool would read as
     * "this vault holds no private money", which is a number nobody measured. */
    const reader = chainVaultHoldingsFor(DEPLOYMENT);
    await expect(reader.held(VAULT, 'shielded', 'aa'.repeat(32)))
      .rejects.toThrow(/asked the note pool to load, and a service holds no vault note pool/);
  });

  it('a public read never asks the note pool at all', async () => {
    /* RED WHEN the public form is routed through the pool: the refusal above would
     * then fire on the path that is supposed to work. */
    const reader = chainVaultHoldingsFor(DEPLOYMENT);
    rows.value = [{ tokenType: NIGHT, balance: 7n }];
    expect(await reader.held(VAULT, 'unshielded', NIGHT)).toEqual({ of: 'held', amount: 7n });
  });
});

describe('§2 the choice of reader is a function, and both services pass what it returns', () => {
  /*
   * **THE POINT OF `holdingsFor` BEING A FUNCTION IS THIS BLOCK.**
   *
   * The previous version of this check counted the arguments at the
   * construction site as TEXT, and its own comment claimed it was red when the
   * server fell back to the refusing reader unconditionally. It was not: an
   * inverted ternary, a dead call, the call left inside a comment and a `||`
   * fallback all passed it, measured. A check that cannot fail for the cause it
   * names is the defect this project has paid for twice.
   *
   * So the choice was lifted out, and these assertions are about the object it
   * hands back.
   */
  const startedAt = (d: Deployment) => ({
    started: true as const, deployment: d, wiring: {} as never,
  });

  it('a process that resolved a deployment gets the chain\'s reader, which asks the indexer', async () => {
    /* RED WHEN the choice is inverted, or the chain branch is dead: the refusing
     * reader throws NoVaultHoldingsReader instead of reading a row. */
    rows.value = [{ tokenType: NIGHT, balance: 5n }];
    const holdings = holdingsFor(startedAt(DEPLOYMENT));
    expect(await holdings.held(VAULT, 'unshielded', NIGHT)).toEqual({ of: 'held', amount: 5n });
    expect(bundles).toHaveLength(1);
  });

  it('a process with no deployment gets the reader that answers nothing, by name', async () => {
    /* RED WHEN a process that never started is handed a reader that would try to
     * reach an indexer it has not got, and answers a number or a timeout instead
     * of saying it cannot be asked. */
    const holdings = holdingsFor({ started: false, refusal: 'no deployment', wiring: {} as never });
    await expect(holdings.held(VAULT, 'unshielded', NIGHT))
      .rejects.toThrow(/was not given a way to read what a vault holds/);
    expect(bundles).toHaveLength(0);
  });

  /*
   * **AND THE TWO CONSTRUCTION SITES, WHICH ARE STILL ONLY TEXT.**
   *
   * A service is built at module scope in a file that starts a server, so the
   * argument LIST cannot be inspected any other way. This counts it and nothing
   * more: what is in the argument is pinned above, by the two cases that run it.
   */
  /**
   * **COMMENTS ARE REMOVED BEFORE ANYTHING IS COUNTED, AND THAT IS NOT
   * TIDINESS.** The previous version of this scan matched inside a comment, so
   * commenting the call out and assigning the refusing reader on the next line
   * passed every assertion below - measured, on this file's own source. A text
   * check that reads commented-out code is a check that passes on the exact
   * edit somebody makes when they are disabling something in a hurry.
   */
  const withoutComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const accountServiceArgs = (path: string): string[] => {
    const src = withoutComments(readFileSync(path, 'utf8'));
    const at = src.indexOf('new AccountService(');
    expect(at, `${path} constructs no AccountService`).toBeGreaterThan(-1);
    expect(src.indexOf('new AccountService(', at + 1),
      `${path} constructs more than one AccountService, so this check no longer knows which`)
      .toBe(-1);
    let depth = 0;
    let current = '';
    const args: string[] = [];
    for (let i = at + 'new AccountService('.length; i < src.length; i++) {
      const c = src[i]!;
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' && depth === 0) { args.push(current); break; }
      else if (c === ')' || c === ']' || c === '}') depth--;
      if (c === ',' && depth === 0) { args.push(current); current = ''; continue; }
      current += c;
    }
    return args.map(a => a.trim());
  };

  it('the server passes five arguments, and the fifth is what the choice returned', () => {
    /* RED WHEN the argument is dropped, or a sixth appears, or the fifth stops
     * being the value `holdingsFor` produced. */
    const args = accountServiceArgs('src/server/index.ts');
    expect(args).toHaveLength(5);
    expect(args[4]).toBe('holdings');
    expect(withoutComments(readFileSync('src/server/index.ts', 'utf8')))
      .toMatch(/const holdings = holdingsFor\(startup\);/);
  });

  it('the standalone build passes the refusing reader BY NAME, because it can reach no chain', () => {
    /* RED WHEN the argument is dropped. It is the same behaviour as the default
     * and that is the point: a decision nobody wrote down is one nobody finds. */
    const args = accountServiceArgs('src/standalone/main.tsx');
    expect(args).toHaveLength(5);
    expect(args[4]).toBe('noVaultHoldingsReader');
  });
});
