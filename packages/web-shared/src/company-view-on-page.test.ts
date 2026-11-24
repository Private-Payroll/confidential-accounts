/*
 * The company's view as the page opens it: the service's transport and the person's wallet are stood in for, and what
 * is checked is how often each is asked for one view, and that each opening is a view of its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const t = vi.hoisted(() => ({
  paths: [] as string[], wallet: 0, sealed: { id: 'c1', companyLabel: 'co_1', contractAddress: 'acct1' } as Record<string, unknown>,
  indexer: { indexerUri: 'i', indexerWsUri: 'w' } as unknown, adopted: [] as string[],
}));
vi.mock('./service-transport.js', async (real) => ({
  ...(await real<typeof import('./service-transport.js')>()),
  serviceCall: async (path: string, init?: RequestInit) => {
    t.paths.push(path);
    if (/^\/api\/accounts\/c\d$/u.test(path)) return { ...t.sealed, id: path.slice(-2) };
    if (path.endsWith('/directory')) return { filings: [] };
    if (path.endsWith('/manifest/newest')) return { versions: (JSON.parse(String(init?.body)) as { records: unknown[] }).records.map(() => 0) };
    if (path.endsWith('/vaults')) return { rows: [] };
    if (init?.method === 'POST' && path.endsWith('/manifest/entries')) return { ok: true };
    throw new Error(`nothing is served at ${path}`);
  },
}));
vi.mock('./wallet-asks.js', async (real) => ({
  ...(await real<typeof import('./wallet-asks.js')>()),
  holdersFromTheWallet: async () => { t.wallet += 1; return { holders: { seats: ['s1'], approvals: 1, adoptedVaults: t.adopted, committee: [], threshold: 1, vaultThresholds: [], policyBar: null }, indexer: t.indexer }; },
}));

const page = await import('./company-view-on-page.js');
const { ViewEnded } = await import('./company-view.js');
const doors: Parameters<typeof page.openOnPage>[1] = {
  walletOrigin: 'https://wallet.example',
  builder: async () => { throw new Error('no read here asks the builder'); },
  held: () => async () => { throw new Error('no read here asks what the anchor holds'); },
  directory: async () => { throw new Error('no read here asks for the directory believed'); },
};
const accountReads = (): number => t.paths.filter((p) => p === '/api/accounts/c1').length;

beforeEach(() => {
  t.paths.length = 0; t.wallet = 0; t.adopted = []; t.indexer = { indexerUri: 'i', indexerWsUri: 'w' };
  t.sealed = { id: 'c1', companyLabel: 'co_1', contractAddress: 'acct1' };
});

describe('one view of a company on the page', () => {
  it('reads the account once and asks the wallet once, however many tiles read through it', async () => {
    const view = page.openOnPage('c1', doors);
    const [sealed, account, holders, indexer, again, vaults] = await Promise.all([
      page.accountOnPage(view), view.account(), view.holders(), page.indexerOnPage(view), view.holders(), view.list('vaults'),
    ]);
    expect([(sealed as { id: string }).id, account === sealed, holders === again, indexer, vaults]).toEqual(['c1', true, true, t.indexer, { rows: [] }]);
    /* RED WHEN: the wallet's door reads the account apart from the view, so every view costs two reads of it. */
    expect(accountReads()).toBe(1);
    /* RED WHEN: the indexer, or a second tile's holders, costs another ask of the wallet in the same view. */
    expect(t.wallet).toBe(1);
    expect(await page.onTheChain(view)).toEqual({ company: 'co_1', account: 'acct1' });
  });

  it('names a company with no account on the chain from its account alone, and reads nothing else of it', async () => {
    t.sealed = { id: 'c1' };
    const view = page.openOnPage('c1', doors);
    expect(await page.onTheChain(view)).toBeNull();
    expect(((await page.accountOnPage(view)) as { id: string }).id).toBe('c1');
    /* RED WHEN: a company with no account on the chain is read through a view as if somebody held it. */
    await expect(view.list('vaults')).rejects.toBeInstanceOf(page.NotOnTheChainYet);
    expect(t.wallet).toBe(0);
  });
});

describe('the check before a write, on the page', () => {
  it('reads the account again from the service, so signers another seat changed meanwhile stop the write', async () => {
    t.sealed = { id: 'c1', companyLabel: 'co_1', contractAddress: 'acct1', keyEpoch: 1, pendingSigners: [], wrappedKeys: [], roster: { version: 1 } };
    const view = page.openOnPage('c1', doors);
    await page.accountOnPage(view);
    t.sealed = { ...t.sealed, roster: { version: 2 } };
    /* RED WHEN: the check is answered from the page's own kept account, so a vault's keys are sealed to a roster that changed. */
    await expect(view.write([{ to: 'entries', entries: [] }])).rejects.toMatchObject({ moved: ['the company\'s account'] });
  });
});

describe('the page keeps nothing beside its view', () => {
  it('carries the wallet\'s indexer in the holders, and a fresh read naming another indexer, nothing else moved, stops no write', async () => {
    const view = page.openOnPage('c1', doors);
    expect(await page.indexerOnPage(view)).toEqual(t.indexer);
    t.indexer = { indexerUri: 'another', indexerWsUri: 'another-ws' };
    /* RED WHEN: the check compares who holds the company with the indexer it was read through, so a wallet that moved indexers stops every write. */
    await expect(view.write([{ to: 'entries', entries: [] }])).resolves.toHaveLength(1);
    expect(t.wallet).toBe(2);
  });

  it('reads nothing once ended: not the indexer, not where the company is, not a vault', async () => {
    const view = page.openOnPage('c1', doors);
    await view.holders();
    view.end('the page moved on');
    /* RED WHEN: a read kept beside the view still answers after the view ended. */
    await expect(page.indexerOnPage(view)).rejects.toBeInstanceOf(ViewEnded);
    await expect(page.onTheChain(view)).rejects.toBeInstanceOf(ViewEnded);
    await expect(page.vaultOnPage(view, 'v1', t.indexer as never)).rejects.toBeInstanceOf(ViewEnded);
  });

  it('opened where the company is on the chain, reads no account to find it', async () => {
    const view = page.openOnPage('c1', doors, { company: 'co_1' as never, account: 'acct1' as never });
    await Promise.all([view.holders(), page.indexerOnPage(view)]);
    /* RED WHEN: a view opened from a row that names the company on the chain reads the company's account again to find it. */
    expect([accountReads(), t.wallet]).toEqual([0, 1]);
  });

  it('writes nothing through a view opened at a place on the chain the company\'s own account does not name', async () => {
    const wrong = page.openOnPage('c1', doors, { company: 'co_1' as never, account: 'acct2' as never });
    await wrong.holders();
    /* RED WHEN: the check before a write takes the place the opener named without the company's account naming it. */
    await expect(wrong.stillAsRead()).rejects.toThrow();
    expect(wrong.endedAs).toBe('refused');
    const right = page.openOnPage('c1', doors, { company: 'co_1' as never, account: 'acct1' as never });
    await right.holders();
    await right.stillAsRead();
    expect(right.ended).toBeNull();
  });
});

describe('each opening is a view of its own', () => {
  it('opens a new view each time, keeps none, and an ended one reads nothing while the next reads afresh', async () => {
    const first = page.openOnPage('c1', doors);
    await first.holders();
    const second = page.openOnPage('c1', doors);
    /* RED WHEN: the page keeps the views it opened and hands the same one out again, so a screen reads through a view it does not hold. */
    expect(second).not.toBe(first);
    first.end('the page moved on');
    /* RED WHEN: a view ended by the screen that held it still serves what it read. */
    await expect(first.holders()).rejects.toThrow(/the page moved on/u);
    /* RED WHEN: ending one view ends another opening's, or a new view serves what the one before it read. */
    expect(second.ended).toBeNull();
    await second.holders();
    expect([t.wallet, accountReads()]).toEqual([2, 2]);
  });
});

describe('the vaults on the chain, read through the view', () => {
  /* The builder standing in: each ask's vaults in `asked`, and whether it named the account in `named`. */
  const aBuilder = () => {
    const b = { asked: [] as string[][], named: [] as boolean[] };
    return Object.assign(b, {
      vaultsOnChain: async (i: { vaults: readonly string[]; account?: string }) => {
        b.asked.push([...i.vaults]);
        b.named.push(i.account !== undefined);
        return i.vaults.map((state) => ({ onChain: true, state }));
      },
    });
  };

  it('reads every vault the account adopted in one ask for every tile of the opening, and again only when asked again', async () => {
    t.adopted = ['V1', 'v2', 'v3'];
    const b = aBuilder();
    const view = page.openOnPage('c1', { ...doors, builder: async () => b as never });
    const read = (vault: string, round?: number) => page.vaultOnPage(view, vault, t.indexer as never, round).then((r) => (r as { state?: string }).state);
    expect(await read('v2')).toBe('v2');
    expect(await Promise.all([read('v1'), read('v3')])).toEqual(['v1', 'v3']);
    /* RED WHEN: a tile reads its vault alone, or asks the account's circuits a page never shows. */
    expect([b.asked, b.named]).toEqual([[['v2', 'v1', 'v3']], [false]]);
    await read('v1');
    /* RED WHEN: a second tile of the same opening asks the chain again for a vault the view read. */
    expect(b.asked).toHaveLength(1);
    expect(await Promise.all([read('v1', 1), read('v3', 1)])).toEqual(['v1', 'v3']);
    /* RED WHEN: a press that reads the vault again is shown what was read before it. */
    expect(b.asked).toEqual([['v2', 'v1', 'v3'], ['v1', 'v2', 'v3']]);
    await page.vaultOnPage(page.openOnPage('c1', { ...doors, builder: async () => b as never }), 'v1', t.indexer as never);
    /* RED WHEN: another opening is served this opening's reads. */
    expect(b.asked).toHaveLength(3);
  });

  it('hands out a new round for each press, and each round asks the chain once', async () => {
    t.adopted = ['v1'];
    const b = aBuilder();
    const view = page.openOnPage('c1', { ...doors, builder: async () => b as never });
    const rounds = [page.vaultRoundOnPage(view), page.vaultRoundOnPage(view)];
    /* RED WHEN: two presses in one opening are handed the same round, so the second is shown the first one's answer. */
    expect(rounds).toEqual([1, 2]);
    for (const round of [...rounds, ...rounds]) await page.vaultOnPage(view, 'v1', t.indexer as never, round);
    expect(b.asked).toEqual([['v1'], ['v1']]);
  });
});
