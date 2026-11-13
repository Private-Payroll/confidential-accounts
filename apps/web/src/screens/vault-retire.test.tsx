// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom, publicAmount } from 'vaults-ui';
import type { Company } from '../adapters/company-records.js';
import { untilPageShown, untilShown } from '../page-shown.test-support.js';
import { ENGLISH } from '../english.test-support.js';
import { StaticAssetRegistry } from '../../../../src/core/assets.js';
import { accountBalancesFrom } from '../adapters/account-balances.js';

/*
 * **A VAULT IS RETIRED, AND A RETIRED VAULT ADOPTED AGAIN, FROM ITS PAGE.** The company's records, the vault's money and
 * the wallet are stood in; the page is drawn whole, so the presses are read where a person would find them.
 */
const state = vi.hoisted(() => ({
  company: null as unknown, publicReads: 0, companyReads: 0, privateReads: 0, priv: { of: 'nothing-yet' } as unknown, pub: { amounts: [], unrecognised: 0 } as unknown,
  /* What the chain itself holds in the retired vault, read with no record and no company key; null keeps the read running. */
  chain: { notes: 'none', public: 'none' } as unknown,
  /* Who is told when the person's wallet releases a company's key to this tab. */
  released: new Set<(accountId: string) => void>(),
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  watchCompanyKeyReleased: (watch: (accountId: string) => void) => { state.released.add(watch); return () => { state.released.delete(watch); }; },
}));
const dp = vi.hoisted(() => ({
  now: null as unknown, watchers: new Set<() => void>(), put: [] as unknown[][], checks: [] as unknown[][], checkGate: null as Promise<unknown> | null, checkAnswer: null as unknown, keyHeld: true,
  set(now: unknown) { this.now = now; for (const w of [...this.watchers]) w(); },
}));
vi.mock('../adapters/creation-standing.js', async (real) => ({
  ...(await real<typeof import('../adapters/creation-standing.js')>()),
  creationOf: async () => ({ company: 'c-1', standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null }),
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => { state.companyReads += 1; return state.company; },
  readVaultPublicMoney: async () => { state.publicReads += 1; return state.pub; },
  readVaultName: async () => null,
}));
vi.mock('../adapters/handover-state.js', async (real) => ({
  ...(await real<typeof import('../adapters/handover-state.js')>()),
  readHandover: async () => ({ of: 'held' }),
}));
vi.mock('../adapters/vault-private-money.js', async (real) => ({
  ...(await real<typeof import('../adapters/vault-private-money.js')>()),
  readVaultPrivateMoney: async () => { state.privateReads += 1; return state.priv; },
}));
vi.mock('../adapters/retired-vault-on-chain.js', async (real) => ({
  ...(await real<typeof import('../adapters/retired-vault-on-chain.js')>()),
  readRetiredVaultOnChain: () => (state.chain === null ? new Promise(() => {}) : Promise.resolve(state.chain)),
}));
vi.mock('../adapters/vault-rows.js', async (real) => ({ ...(await real<typeof import('../adapters/vault-rows.js')>()), readVaultRows: async () => [] }));
vi.mock('../adapters/session.js', async (real) => ({ ...(await real<typeof import('../adapters/session.js')>()), companyNamesFor: async () => new Map() }));
vi.mock('../adapters/account-balances.js', async (real) => ({
  ...(await real<typeof import('../adapters/account-balances.js')>()),
  askForAccountBalances: async () => accountBalancesFrom(
    {
      addresses: { private: `mn_shield-addr_test1${'q'.repeat(60)}` },
      balances: [{ token: 'ab'.repeat(32), amount: '2500000', visibility: 'private' }],
      read: { private: Date.now(), public: Date.now() },
    },
    Date.now(), new StaticAssetRegistry([{ code: 'ab'.repeat(32), symbol: 'PRV', name: 'Private token', decimals: 6, ledger: { shielded: 'ab'.repeat(32), unshielded: null }, enabled: true, sortOrder: 60 }]),
  ),
}));
vi.mock('../adapters/deposit.js', async (real) => ({
  ...(await real<typeof import('../adapters/deposit.js')>()),
  putMoneyIn: (...args: unknown[]) => { dp.put.push(args); return { of: 'vault-refused', standing: args[7] }; },
  depositNow: () => dp.now,
  watchDeposit: (_vault: string, watcher: () => void) => { dp.watchers.add(watcher); return () => { dp.watchers.delete(watcher); }; },
  companyKeyHeldHere: () => dp.keyHeld,
  checkMyLastDeposit: async (...args: unknown[]) => { dp.checks.push(args); if (dp.checkGate !== null) await dp.checkGate; return dp.checkAnswer; },
}));

const { PageView } = await import('../app.js');
const { Shell } = await import('../shell/shell.js');
const { SessionProvider } = await import('../session.js');
const { DEFAULT_PREFERENCES } = await import('../preferences.js');
const { addressOf } = await import('../router.js');
const { VIEWS } = await import('../pages.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const VAULT = 'ab'.repeat(32);
const RETIRE = {
  id: 'prp_retire', kind: 'retire-vault', status: 'executed', raisedBy: 's1', approvals: 1, needed: 1, raisedAt: '2026-10-01T00:00:00.000Z', pays: null,
  asks: { kind: 'retire-vault', vault: VAULT },
};
const company = (row: Record<string, unknown>, proposals: unknown[] = []): Company => ({
  of: 'open', id: 'c-1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }], approvalsNeeded: { of: 'read', value: 1 },
  proposals: { of: 'read', value: proposals }, runs: { of: 'read', value: [] }, people: { of: 'read', value: [] },
  vaults: { of: 'read', value: [{ vault: VAULT, createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee', ...row }] },
  invitations: { of: 'read', value: [] },
} as Company);

async function draw(page: 'vault' | 'vaults' = 'vault') {
  window.history.replaceState(null, '', page === 'vault' ? addressOf('vault', { vault: VAULT }) : addressOf('vaults', {}));
  const session = {
    person: { id: 'u1', name: 'Priya' }, companies: [{ id: 'c-1', createdAt: '2026-09-01T00:00:00.000Z', signers: 1 }], company: 'c-1',
    chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
    choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
  };
  const view = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session}><Shell current={page}><PageView id={page} params={page === 'vault' ? { vault: VAULT } : {}} /></Shell></SessionProvider>
    </KitProvider>,
  );
  await untilPageShown(view.container);
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return view.container;
}
const q = (c: ParentNode, sel: string) => c.querySelector<HTMLElement>(sel);
const button = (c: ParentNode, action: string) => q(c, `[data-screen=vault] [data-action=${action}]`) as HTMLButtonElement;
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.company = company({ adopted: true }); state.publicReads = 0; state.companyReads = 0; state.privateReads = 0; state.priv = { of: 'nothing-yet' }; state.pub = { amounts: [], unrecognised: 0 };
  state.chain = { notes: 'none', public: 'none' };
  dp.now = null; dp.watchers.clear(); dp.put = []; dp.checks = []; dp.checkGate = null; dp.keyHeld = true;
  dp.checkAnswer = { of: 'checked', deposit: 'none', until: null, notYetSpendable: false, named: 0, unnamed: 0, toName: 0, forSupport: '', deposited: null, unshown: null, earlier: [] };
  window.sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('a vault retired and adopted again from its page', () => {
  it('a vault the company\'s account holds shows Retire as not built yet, and pressing it opens nothing', async () => {
    const c = await draw();
    const retire = button(c, 'retire-vault');
    /* RED WHEN: the wallet holds no key to prove a retire and the vault page still offers a Retire button that can be pressed, which promises an action every press refuses. */
    expect([retire.textContent, retire.disabled, retire.hasAttribute('data-soon')]).toEqual([EN['vault.retire'], true, true]);
    await act(async () => { fireEvent.click(retire); });
    await settle();
    /* RED WHEN: pressing the Retire that is not built yet opens the retire panel, or the page offers Adopt again on a vault that is not retired. */
    expect(document.querySelector('[data-panel] [data-retire-vault]')).toBeNull();
    expect(q(c, '[data-action=adopt-again]')).toBeNull();
  });

  it('a retired vault holding money offers Adopt again under the retire that retired it, and one holding nothing offers nothing', async () => {
    state.company = company({ retired: true }, [RETIRE]);
    state.pub = { amounts: [publicAmount(5_000_000n, 6, 'PUB')], unrecognised: 0 };
    let c = await draw();
    await untilShown(() => q(c, '[data-screen=vault] [data-action=adopt-again]'), 'Adopt again');
    /* RED WHEN: a retired vault is offered Retire again, which the chain would refuse. */
    expect(q(c, '[data-action=retire-vault]')).toBeNull();
    cleanup();
    state.pub = { amounts: [], unrecognised: 0 };
    state.chain = { notes: 'none', public: 'none' };
    c = await draw();
    /* RED WHEN: a retired vault that holds nothing is offered Adopt again, or one is offered with no retire carried out to adopt it again under. */
    expect(q(c, '[data-action=adopt-again]')).toBeNull();
    cleanup();
    state.company = company({ retired: true }, []);
    state.pub = { amounts: [publicAmount(5_000_000n, 6, 'PUB')], unrecognised: 0 };
    c = await draw();
    expect(q(c, '[data-action=adopt-again]')).toBeNull();
  });

  it('a retired vault paid into after its retire, by a note no record here names, is listed and offered Adopt again', async () => {
    state.company = company({ retired: true }, [RETIRE]);
    state.priv = { of: 'nothing-yet' };
    state.chain = { notes: 'holds', public: 'none' };
    let c = await draw();
    /* RED WHEN: a note that reached a retired vault after its retire is hidden because this device's note record does not name it, so the money has no way out. */
    await untilShown(() => q(c, '[data-screen=vault] [data-action=adopt-again]'), 'Adopt again');
    /* RED WHEN: a retired vault's page offers paying from it, putting money in or checking a deposit, which the wallet refuses for a vault the account no longer holds. */
    for (const action of ['pay-someone', 'deposit', 'check-last-deposit']) expect(q(c, `[data-screen=vault] [data-action=${action}]`), action).toBeNull();
    cleanup();
    c = await draw('vaults');
    /* RED WHEN: the vaults list drops a retired vault the chain shows holding a note. */
    await untilShown(() => q(c, `[data-vault="${VAULT}"]`), 'the retired vault on the list');
    cleanup();
    state.company = company({ adopted: true });
    c = await draw();
    expect(q(c, '[data-screen=vault] [data-action=pay-someone]')).not.toBeNull();
  });

  it('a retired vault whose chain cannot be read, or is still being read, stays listed with Adopt again and says it may hold money', async () => {
    state.company = company({ retired: true }, [RETIRE]);
    for (const chain of [{ notes: 'unread', public: 'none' }, { notes: 'none', public: 'unread' }, null]) {
      state.chain = chain;
      const c = await draw();
      /* RED WHEN: a retired vault is hidden, or offered nothing, because a side of what it holds could not be read or is still being read. */
      await untilShown(() => q(c, '[data-screen=vault] [data-action=adopt-again]'), 'Adopt again');
      /* RED WHEN: a side that could not be read is shown as holding nothing. */
      if (chain !== null) expect(q(c, '[data-screen=vault] [data-retired-may-hold]')).not.toBeNull();
      cleanup();
    }
  });
});
