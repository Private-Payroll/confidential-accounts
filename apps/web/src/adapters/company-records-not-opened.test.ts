// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * A COMPANY READ AS A PAGE LOADS NEVER ASKS THE WALLET, and says what it could not open. The keyring and the judges are
 * stood in for; what the adapter does with a company whose key the wallet has not released on this visit is its own.
 */
const t = vi.hoisted(() => ({ opened: null as unknown, notOpened: [] as number[], wallet: 0, withTheWallet: 0, askedFor: [] as unknown[], filed: false }));
vi.mock('./keyring-person.js', () => ({
  keyringFor: async () => true,
  keysOnTheWayIn: async () => ({ signerId: 's1', signingPublicKey: 'a1'.repeat(32) }),
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => ({ id: 'u1' }),
  canOpenCompanies: () => true,
  /* The wallet's window: asked for a company, it releases that company's key, which the quiet judge then holds. */
  openKeysWithWallet: async (_o: unknown, _v: unknown, _a: unknown, _d: unknown, company?: string) => { t.wallet += 1; t.askedFor.push(company); t.notOpened = []; },
  companyKeysForVaults: async () => { t.wallet += 1; throw new Error('the wallet must not be asked'); },
  api: async (path: string) => {
    if (path === '/api/accounts/c1') return t.filed ? { id: 'c1', companyLabel: 'acme', contractAddress: 'ee'.repeat(32) } : { id: 'c1', companyLabel: null, contractAddress: null };
    throw new Error(`no answer for ${path}`);
  },
}));
vi.mock('./filing-judge.js', async (real) => ({
  ...(await real<typeof import('./filing-judge.js')>()),
  openedHere: async () => { t.withTheWallet += 1; return null; },
  companyKeysFor: async () => { t.withTheWallet += 1; throw new Error('a page load must not use the asking judge'); },
  openedQuietly: async () => {
    if (t.opened instanceof Error) throw t.opened;
    return t.opened;
  },
  companyKeysQuietlyFor: async () => ({ epoch: 0, newest: 1, key: '11'.repeat(32), keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }), notOpened: t.notOpened }),
  rosterReadsFor: () => ({}),
  filingJudgeFor: () => async () => Object.assign(() => null, {}),
  directoryHereFor: () => async () => ({ records: { history: new Map(), notYetAnchored: [] } }),
}));

const load = async () => { vi.resetModules(); vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180'); return import('./company-records.js'); };
beforeEach(() => { t.opened = { id: 'c1', name: 'Acme', signers: [], refused: [] }; t.notOpened = []; t.wallet = 0; t.withTheWallet = 0; t.askedFor = []; t.filed = false; });

describe('a company read as a page loads', () => {
  /* RED WHEN: a company whose key the wallet has not released this visit is shown as one that did not finish, with nothing to offer the person. */
  it('says a company whose key the wallet has not released as not opened yet, and asks the wallet for nothing', async () => {
    const { readCompany } = await load();
    const { CompanyKeyNotOpened } = await import('vaults-web-shared/company-key-here.js');
    t.opened = new CompanyKeyNotOpened();
    expect(await readCompany('u1', 'c1')).toEqual({ of: 'refused', why: 'not-opened-yet' });
    expect([t.wallet, t.withTheWallet]).toEqual([0, 0]);
  });

  /* RED WHEN: a company that opens with a copy of its key left unopened does not say which, so a page cannot offer to open it. */
  it('carries the epochs of the key left unopened on a company that does open, and asks the wallet for nothing', async () => {
    const { readCompany } = await load();
    t.notOpened = [2];
    const c = await readCompany('u1', 'c1');
    expect(c.of).toBe('open');
    expect((c as { notOpened?: readonly number[] }).notOpened).toEqual([2]);
    expect([t.wallet, t.withTheWallet]).toEqual([0, 0]);
  });
});

describe('a vault name read as a page loads', () => {
  /* RED WHEN: the name is read through a judge that may open the wallet's window, so a records page opens one on load for a company whose key was changed. */
  it('asks the wallet for nothing, with the company key released or not', async () => {
    const records = await load();
    const { CompanyKeyNotOpened } = await import('vaults-web-shared/company-key-here.js');
    const vault = 'ab'.repeat(32);
    t.filed = true;
    await records.readVaultName('u1', 'c1', vault);
    expect([t.wallet, t.withTheWallet]).toEqual([0, 0]);
    t.opened = new CompanyKeyNotOpened();
    expect(await records.readVaultName('u1', 'c1', vault, records.NAME_NOT_READ)).toBe(records.NAME_NOT_READ);
    expect(await records.readVaultName('u1', 'c1', vault)).toBeNull();
    expect([t.wallet, t.withTheWallet]).toEqual([0, 0]);
  });
});

describe('the one press that asks the wallet', () => {
  /* RED WHEN: the press does not ask the wallet exactly once for the company shown, or the read that follows still leaves the epoch unopened. */
  it('opens the epoch the quiet read left unopened, with the wallet asked exactly once for that company', async () => {
    const { readCompany, openWithYourAccount } = await load();
    t.notOpened = [2];
    expect((await readCompany('u1', 'c1') as { notOpened?: readonly number[] }).notOpened).toEqual([2]);
    expect(t.wallet).toBe(0);
    expect(await openWithYourAccount('u1', 'c1')).toEqual({ of: 'done' });
    expect((await readCompany('u1', 'c1') as { notOpened?: readonly number[] }).notOpened).toEqual([]);
    expect([t.wallet, t.askedFor]).toEqual([1, ['c1']]);
  });
});
