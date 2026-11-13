import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * **WHAT A RETIRED VAULT HOLDS IS READ FROM THE CHAIN ALONE.** The service's account record, the wallet's indexer and
 * the vault builder are stood in; the notes and public balances are the vault's state as the chain gives it.
 */
const s = vi.hoisted(() => ({
  sealed: { companyLabel: 'label', contractAddress: 'addr' } as unknown, indexer: { indexerUri: 'i', indexerWsUri: 'w' } as unknown,
  read: null as unknown, throws: false, asked: [] as string[],
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({ ...(await real<typeof import('vaults-web-shared/keyring.js')>()), api: async () => { s.asked.push('account'); return s.sealed; } }));
vi.mock('./filing-judge.js', async (real) => ({ ...(await real<typeof import('./filing-judge.js')>()), walletIndexerFor: async () => { s.asked.push('indexer'); return s.indexer; } }));
vi.mock('./vault-builder.js', async (real) => ({
  ...(await real<typeof import('./vault-builder.js')>()),
  theVaultBuilder: async () => ({ vaultOnChain: async (i: { vault: string }) => { s.asked.push(`vault ${i.vault}`); if (s.throws) throw new Error('no indexer'); return s.read; } }),
}));
/* Each read below is of its own company, since a company's account and indexer are read once and kept for the page. */
let company = 0;
const anotherCompany = (): string => { company += 1; return `c-${company}`; };
const { readRetiredVaultOnChain, emptyOnChain } = await import('./retired-vault-on-chain.js');

const onChain = (over: Record<string, unknown>) => ({ onChain: true, notes: [], publicBalances: [], ...over });
beforeEach(() => { s.asked.length = 0; s.sealed = { companyLabel: 'label', contractAddress: 'addr' }; s.indexer = { indexerUri: 'i', indexerWsUri: 'w' }; s.throws = false; });

describe('what a retired vault holds is read from the chain alone', () => {
  it('a note in the vault\'s pool, or a public balance above nothing, holds money; nothing on both sides is empty', async () => {
    s.read = onChain({ notes: ['ab'.repeat(32)] });
    /* RED WHEN: a note in the vault's pool on the chain is not counted, so a retired vault paid into is hidden. */
    expect(await readRetiredVaultOnChain(anotherCompany(), 'v')).toEqual({ notes: 'holds', public: 'none' });
    s.read = onChain({ publicBalances: [{ token: 't', amount: '0' }, { token: 'u', amount: '7' }] });
    /* RED WHEN: a public balance above nothing is not counted. */
    expect(await readRetiredVaultOnChain(anotherCompany(), 'v')).toEqual({ notes: 'none', public: 'holds' });
    s.read = onChain({ publicBalances: [{ token: 't', amount: '0' }] });
    expect(emptyOnChain(await readRetiredVaultOnChain(anotherCompany(), 'v'))).toBe(true);
  });

  it('a side the chain did not give, or a read that failed, is unread and never empty', async () => {
    const { notes: _n, ...noNotes } = onChain({});
    s.read = noNotes;
    /* RED WHEN: a vault whose notes could not be read is taken as holding none. */
    expect(await readRetiredVaultOnChain(anotherCompany(), 'v')).toEqual({ notes: 'unread', public: 'none' });
    const { publicBalances: _p, ...noPublic } = onChain({});
    s.read = noPublic;
    expect(await readRetiredVaultOnChain(anotherCompany(), 'v')).toEqual({ notes: 'none', public: 'unread' });
    /* RED WHEN: a failed read, a missing indexer, an account the service has not named or a vault not found reads as empty. */
    for (const set of [() => { s.throws = true; }, () => { s.indexer = null; }, () => { s.sealed = {}; }, () => { s.read = { onChain: false }; }]) {
      s.throws = false; s.indexer = { indexerUri: 'i', indexerWsUri: 'w' }; s.sealed = { companyLabel: 'label', contractAddress: 'addr' }; s.read = onChain({});
      set();
      expect(emptyOnChain(await readRetiredVaultOnChain(anotherCompany(), 'v'))).toBe(false);
    }
  });
});

describe('the retired vaults of one company are read through one door', () => {
  it('the company\'s account and the wallet\'s indexer are asked once for all its retired vaults, and each vault is read on its own', async () => {
    s.read = onChain({});
    const c = anotherCompany();
    await Promise.all([readRetiredVaultOnChain(c, 'v1'), readRetiredVaultOnChain(c, 'v2'), readRetiredVaultOnChain(c, 'v3')]);
    /* RED WHEN: every retired vault on the page costs its own read of the company's account and its own ask of the wallet. */
    expect(s.asked.filter((a) => a === 'account' || a === 'indexer')).toEqual(['account', 'indexer']);
    expect(s.asked.filter((a) => a.startsWith('vault')).sort()).toEqual(['vault v1', 'vault v2', 'vault v3']);
  });

  it('a door that could not be read is asked again on the next read, never kept as unread', async () => {
    const c = anotherCompany();
    s.indexer = null;
    expect(emptyOnChain(await readRetiredVaultOnChain(c, 'v'))).toBe(false);
    s.indexer = { indexerUri: 'i', indexerWsUri: 'w' };
    s.read = onChain({});
    /* RED WHEN: a wallet that could not name its indexer once keeps every retired vault of the company unread for the rest of the page. */
    expect(emptyOnChain(await readRetiredVaultOnChain(c, 'v'))).toBe(true);
  });

  it('a public amount written in any other way than a run of zeros is counted as held, never as empty', async () => {
    s.read = onChain({ publicBalances: [{ token: 't', amount: '00' }] });
    expect(emptyOnChain(await readRetiredVaultOnChain(anotherCompany(), 'v'))).toBe(true);
    s.read = onChain({ publicBalances: [{ token: 't', amount: '0x0' }] });
    /* RED WHEN: an amount the page cannot read as a whole number is read as nothing, or throws and hides the vault's other side. */
    expect(await readRetiredVaultOnChain(anotherCompany(), 'v')).toEqual({ notes: 'none', public: 'holds' });
  });
});
