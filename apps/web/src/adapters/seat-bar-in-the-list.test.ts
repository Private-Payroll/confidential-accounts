// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * THE SEAT BAR IN THE ONE LIST OF COMPANIES. The wallet's read of the chain is stood in for by the figures it would give;
 * the rule that turns them into the seat bar and its reason is `whatAChangeCosts`'s own (`change-costs.test.ts`).
 */
const chain = vi.hoisted(() => ({ asking: 0, mostAtOnce: 0, asked: [] as string[], accountsRead: [] as string[], approvals: 2, policyBar: null as number | null, vaultThresholds: [] as { vault: string; threshold: number }[], seats: ['a', 'b', 'c'], rows: [] as readonly object[] }));
/* Each company's account as the service keeps it: the list's own row for it. */
vi.mock('vaults-web-shared/service-transport.js', async (real) => (await import('./service-in-memory.test-support.js')).withTheView({
  ...(await real<typeof import('vaults-web-shared/service-transport.js')>()),
  api: async (path: string) => {
    if (path.endsWith('/directory')) return { filings: [] };
    const row = chain.rows.find((r) => path === `/api/accounts/${(r as { id?: string }).id}`);
    if (row !== undefined) chain.accountsRead.push(path);
    return row ?? null;
  },
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => ({ id: 'u1' })}));
vi.mock('vaults-web-shared/company-creation.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/company-creation.js')>()),
  companiesBeingCreated: () => [],
}));
vi.mock('vaults-web-shared/wallet-asks.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-asks.js')>()),
  holdersFromTheWallet: async (_origin: string, ask: { account: string }) => {
    chain.asking += 1; chain.mostAtOnce = Math.max(chain.mostAtOnce, chain.asking); chain.asked.push(ask.account);
    await new Promise((r) => setTimeout(r, 1));
    chain.asking -= 1;
    return { holders: { ...chain, seatBar: 0, committee: [], threshold: 1, adoptedVaults: [] }, indexer: null };
  },
}));

const LABEL = `co_${'c1'.repeat(32)}`;
const row = { id: 'c1', createdAt: 'x', signerCount: 3, threshold: 1, companyLabel: LABEL, contractAddress: 'c0'.repeat(32) };

async function barOfTheList(rows: readonly object[] = [row]) {
  vi.resetModules();
  chain.rows = rows;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: { id: 'u1', name: 'Priya' }, accounts: rows }), { status: 200 })));
  const session = await import('./session.js');
  await session.whoIsSignedIn();
  return [...(await session.approvalsNeededFor('u1')).entries()];
}
afterEach(() => { chain.mostAtOnce = 0; chain.asked = []; chain.accountsRead = []; vi.unstubAllGlobals(); chain.approvals = 2; chain.policyBar = null; chain.vaultThresholds = []; });

describe('the seat bar in the one list of companies', () => {
  /* RED WHEN: the list's figure is the account's approvals while the chain holds a higher policy bar, or the reason names the account or the policy bar when a vault's own bar is what sets it. */
  it('gives the seat bar, not the account threshold, and names the vault that sets it', async () => {
    chain.policyBar = 3; chain.vaultThresholds = [{ vault: 'v1', threshold: 3 }];
    expect(await barOfTheList()).toEqual([['c1', { needed: 3, because: { vault: 'v1' } }]]);
  });

  /* RED WHEN: a policy bar no vault holds is named as the account's or a vault's, or the account's own approvals are named as set by the policy bar. */
  it('names the policy bar when no vault holds the bar, and the account when the account sets it', async () => {
    chain.policyBar = 3;
    expect(await barOfTheList()).toEqual([['c1', { needed: 3, because: 'policy-bar' }]]);
    chain.policyBar = 1;
    expect(await barOfTheList()).toEqual([['c1', { needed: 2, because: 'account' }]]);
  });

  /* RED WHEN: a company whose approvals the wallet could not read is given a figure. */
  it('claims nothing for a figure the wallet could not read', async () => {
    chain.approvals = 0;
    expect(await barOfTheList()).toEqual([]);
  });

  /* RED WHEN: the list asks the wallet about every company at once, so a person in many companies has that many wallet frames and chain reads open on the first draw. */
  it('asks the wallet about one company at a time, each company once, in the list\'s order', async () => {
    const rows = ['c1', 'c2', 'c3'].map((id, i) => ({ ...row, id, contractAddress: `c${i}`.repeat(32) }));
    expect((await barOfTheList(rows)).map(([id]) => id)).toEqual(['c1', 'c2', 'c3']);
    expect(chain.mostAtOnce).toBe(1);
    expect(chain.asked).toEqual(rows.map((r) => r.contractAddress));
  });

  /* RED WHEN: each company's view reads the company's account again to find where it is on the chain, which its row in the list already names. */
  it('reads no company\'s account: each view is opened where the list\'s row names the company on the chain', async () => {
    const rows = ['c1', 'c2', 'c3'].map((id, i) => ({ ...row, id, contractAddress: `c${i}`.repeat(32) }));
    expect((await barOfTheList(rows)).map(([id]) => id)).toEqual(['c1', 'c2', 'c3']);
    expect(chain.asked).toEqual(rows.map((r) => r.contractAddress));
    expect(chain.accountsRead).toEqual([]);
  });

  /* RED WHEN: a company whose read fails stops the companies after it from being read, or is given a figure. */
  it('reads on past a company the wallet could not read', async () => {
    const rows = ['c1', 'c2'].map((id, i) => ({ ...row, id, contractAddress: i === 0 ? null : row.contractAddress }));
    expect((await barOfTheList(rows)).map(([id]) => id)).toEqual(['c2']);
  });
});
