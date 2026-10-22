// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom, privateAmount } from 'vaults-ui';
import type { Company } from '../adapters/company-records.js';
import { untilPageShown, untilShown } from '../page-shown.test-support.js';

/*
 * THE VAULT PAGE'S DEPOSIT AND CHECK MY LAST DEPOSIT, drawn in the frame over a company's records. The deposit the
 * adapter keeps for the vault is set by the test, as the adapter would, and the check of the last deposit answers what the
 * test says; the panel is the real one.
 */
const state = vi.hoisted(() => ({ company: null as unknown, publicReads: 0, companyReads: 0, priv: { of: 'nothing-yet' } as unknown, pub: { amounts: [], unrecognised: 0 } as unknown }));
const dp = vi.hoisted(() => ({
  now: null as unknown, watchers: new Set<() => void>(), checks: [] as unknown[][], checkGate: null as Promise<unknown> | null, checkAnswer: null as unknown, keyHeld: true,
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
  readVaultPrivateMoney: async () => state.priv,
}));
vi.mock('../adapters/vault-rows.js', async (real) => ({ ...(await real<typeof import('../adapters/vault-rows.js')>()), readVaultRows: async () => [] }));
vi.mock('../adapters/session.js', async (real) => ({ ...(await real<typeof import('../adapters/session.js')>()), companyNamesFor: async () => new Map() }));
vi.mock('../adapters/deposit.js', async (real) => ({
  ...(await real<typeof import('../adapters/deposit.js')>()),
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
const { depositSteps } = await import('../adapters/deposit.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../locales/en.json'), 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const VAULT = 'ab'.repeat(32);
const company = (): Company => ({
  of: 'open', id: 'c-1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }], approvalsNeeded: { of: 'read', value: 1 },
  proposals: { of: 'read', value: [] }, runs: { of: 'read', value: [] }, people: { of: 'read', value: [] },
  vaults: { of: 'read', value: [{ vault: VAULT, createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee' }] },
  invitations: { of: 'read', value: [] },
});

async function draw() {
  window.history.replaceState(null, '', addressOf('vault', { vault: VAULT }));
  const session = {
    person: { id: 'u1', name: 'Priya' }, companies: [{ id: 'c-1', createdAt: '2026-09-01T00:00:00.000Z', signers: 1 }], company: 'c-1',
    chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
    choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
  };
  const view = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session}><Shell current="vault"><PageView id="vault" params={{ vault: VAULT }} /></Shell></SessionProvider>
    </KitProvider>,
  );
  await untilPageShown(view.container);
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return view.container;
}
const q = (c: ParentNode, sel: string) => c.querySelector<HTMLElement>(sel);
const button = (c: ParentNode, action: string) => q(c, `[data-screen=vault] [data-action=${action}]`) as HTMLButtonElement;
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
const running = (n: number) => {
  const steps = depositSteps('private', true);
  return { of: 'running', kind: 'private', amount: privateAmount(1_250_000n, 6, 'PRV'), steps, step: steps[n - 1], n, since: Date.now(), proofs: [] };
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.company = company(); state.publicReads = 0; state.companyReads = 0; state.priv = { of: 'nothing-yet' }; state.pub = { amounts: [], unrecognised: 0 };
  dp.now = null; dp.watchers.clear(); dp.checks = []; dp.checkGate = null; dp.keyHeld = true;
  dp.checkAnswer = { of: 'checked', deposit: 'none', until: null, notYetSpendable: false, named: 0, unnamed: 0, forSupport: '' };
  window.sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the vault page\'s deposit', () => {
  /* RED WHEN: Deposit or Check my last deposit is still shown as not built, cannot be pressed, or Deposit does not open the right-hand panel on the ways to put money in. */
  it('shows Deposit and Check my last deposit ready to press, and Deposit opens the panel on the ways to put money in', async () => {
    const c = await draw();
    for (const action of ['deposit', 'check-last-deposit']) {
      expect(button(c, action).disabled, action).toBe(false);
      expect(button(c, action).hasAttribute('data-soon'), action).toBe(false);
    }
    expect(button(c, 'deposit').textContent).toBe('Deposit');
    expect(document.querySelector('[data-panel]')).toBeNull();
    await act(async () => { fireEvent.click(button(c, 'deposit')); });
    await untilShown(() => document.querySelector('[data-panel] [data-deposit-methods]'), 'the ways to put money in');
    expect(document.querySelector('[data-panel]')!.textContent).toContain('Deposit');
    expect(dp.checks).toHaveLength(0);
  });

  /* RED WHEN: Check my last deposit does not show at once that it was taken, a second press runs a second check, or its answer is not opened in the panel with the words that only private deposits are checked there. */
  it('checks the last deposit once, shows the press as taken, and opens the panel on what was found', async () => {
    let answer!: (v: unknown) => void;
    dp.checkGate = new Promise((r) => { answer = r; });
    const c = await draw();
    await act(async () => { button(c, 'check-last-deposit').click(); button(c, 'check-last-deposit').click(); await Promise.resolve(); });
    expect(dp.checks).toEqual([['u1', 'c-1', VAULT]]);
    expect(button(c, 'check-last-deposit').disabled).toBe(true);
    expect(q(c, `[data-action=check-last-deposit] [data-slot=spinner][aria-label="${EN['deposit.check.waiting']}"]`)).not.toBeNull();
    expect(document.querySelector('[data-panel]')).toBeNull();
    await act(async () => { answer(undefined); });
    await untilShown(() => document.querySelector('[data-panel] [data-deposit=checked]'), 'the answer of the check');
    expect(document.querySelector('[data-panel] [data-check-says]')!.textContent).toBe(EN['deposit.check.nothingWaiting']);
    expect(document.querySelector('[data-panel] [data-private-only]')!.textContent).toContain('A public deposit is checked in your wallet');
    expect(button(c, 'check-last-deposit').disabled).toBe(false);
    expect(dp.checks).toHaveLength(1);
  });

  /* RED WHEN: in a tab that holds no company key, Check my last deposit opens the person's wallet on the page's first press without naming that window first, the naming is not in the panel it opens, or the check does not run on the press that follows. */
  it('names the wallet window before Check my last deposit opens it, in a tab that holds no company key, and checks only on the next press', async () => {
    dp.keyHeld = false;
    const c = await draw();
    await act(async () => { button(c, 'check-last-deposit').click(); await Promise.resolve(); });
    expect(dp.checks).toHaveLength(0);
    await untilShown(() => document.querySelector('[data-panel] [data-wallet-window-named]'), 'the naming of the wallet window');
    expect(document.querySelector('[data-panel] [data-wallet-window-named]')!.textContent).toBe(
      "Your wallet opens first, to open your company's records on this device. Nothing is paid. In your wallet, press Sign my records key.",
    );
    await act(async () => { fireEvent.click(document.querySelector('[data-panel] [data-action=check-last-deposit]')!); await Promise.resolve(); });
    await untilShown(() => document.querySelector('[data-panel] [data-deposit=checked]'), 'the answer of the check');
    expect(dp.checks).toEqual([['u1', 'c-1', VAULT]]);
  });

  /* RED WHEN: a deposit running for this vault is not shown on the page with its step, there is no way back to the panel from it, Check my last deposit stays pressable while it runs, or the line stays after the deposit is put away. */
  it('shows a deposit that runs with its step and a way back to the panel, and holds Check my last deposit meanwhile', async () => {
    const c = await draw();
    expect(q(c, '[data-deposit-strip]')).toBeNull();
    await act(async () => { dp.set(running(3)); });
    expect(q(c, '[data-deposit-strip=running]')!.textContent).toContain('Putting money in: step 3 of 6.');
    expect(q(c, '[data-check-waits]')!.textContent).toBe('Check my last deposit opens once this deposit has ended.');
    expect(button(c, 'check-last-deposit').disabled).toBe(true);
    await act(async () => { dp.set(running(4)); });
    expect(q(c, '[data-deposit-strip]')!.textContent).toContain('step 4 of 6');
    await act(async () => { fireEvent.click(q(c, '[data-action=open-deposit]')!); });
    await untilShown(() => document.querySelector('[data-panel] [data-deposit=running]'), 'the running deposit in the panel');
    expect(document.querySelector('[data-panel] [data-step-of]')!.textContent).toBe('Step 4 of 6');
    await act(async () => { dp.set(null); });
    expect(q(c, '[data-deposit-strip]')).toBeNull();
    expect(button(c, 'check-last-deposit').disabled).toBe(false);
  });

  /* RED WHEN: a deposit that ends while the panel is closed leaves the vault's money as it was read, reads it again for a deposit it has already read it for, or loses the ended deposit from the page before it is read. */
  it('reads the vault\'s money again when a deposit finishes, and keeps the ended deposit on the page', async () => {
    const c = await draw();
    const before = state.publicReads;
    await act(async () => { dp.set(running(6)); });
    expect(state.publicReads).toBe(before);
    const done = { of: 'done', kind: 'private', amount: privateAmount(1_250_000n, 6, 'PRV'), chainTransaction: 'ee'.repeat(32), notYetSpendable: false, earlier: null };
    await act(async () => { dp.set(done); });
    await settle();
    expect(state.publicReads).toBe(before + 1);
    expect(q(c, '[data-deposit-strip=done]')!.textContent).toContain('A deposit has finished.');
    await act(async () => { dp.set(done); });
    await settle();
    expect(state.publicReads).toBe(before + 1);
    await act(async () => { dp.set({ of: 'failed', kind: 'private', amount: privateAmount(1n, 6, 'PRV'), mayHaveBeenSent: true, refusal: 'did-not-finish', reasons: ['x'] }); });
    expect(q(c, '[data-deposit-strip=failed]')!.textContent).toContain('A deposit did not finish.');
  });
});

describe('the page is told once that a deposit finished', () => {
  const done = { of: 'done', kind: 'private', amount: privateAmount(1_250_000n, 6, 'PRV'), chainTransaction: 'ee'.repeat(32), notYetSpendable: false, earlier: null };

  /* RED WHEN: a finished deposit is told to the page again when the vault page is drawn again, so the vault's money is read one more time for a deposit it was already read for. */
  it('does not read the vault\'s money again when the page is drawn again with the same finished deposit', async () => {
    const first = await draw();
    const mount = state.publicReads;
    await act(async () => { dp.set(done); });
    await settle();
    expect(state.publicReads).toBe(mount + 1);
    expect(q(first, '[data-deposit-strip=done]')).not.toBeNull();
    cleanup();
    state.publicReads = 0;
    await draw();
    await settle();
    expect(state.publicReads).toBe(mount);
  });

  /* RED WHEN: one deposit that finishes while the panel is open reads the company's records again as well as the vault's money. */
  it('reads the vault\'s money once, and not the company\'s records, for a deposit that finishes with the panel open', async () => {
    const c = await draw();
    await act(async () => { dp.set(running(6)); });
    await act(async () => { fireEvent.click(q(c, '[data-action=open-deposit]')!); });
    await untilShown(() => document.querySelector('[data-panel] [data-deposit=running]'), 'the running deposit in the panel');
    const money = state.publicReads;
    const records = state.companyReads;
    await act(async () => { dp.set({ ...done }); });
    await settle();
    await untilShown(() => document.querySelector('[data-panel] [data-deposit=done]'), 'the finished deposit in the panel');
    expect(state.publicReads).toBe(money + 1);
    expect(state.companyReads).toBe(records);
  });
});

describe('the money held, and its tabs', () => {
  const tabs = (c: ParentNode) => Object.fromEntries([...c.querySelectorAll<HTMLElement>('[data-part=money] [data-slot=tabs-list] [data-filter]')].map((t) => [t.dataset.filter, t.querySelector('[data-slot=count-pill]')?.textContent ?? null]));

  /* RED WHEN: a vault that holds nothing privately yet (which it truly does) shows no 0 on its tabs, or a side that was read and holds something is not counted. */
  it('counts the sides that were read, 0 for a vault that holds nothing yet', async () => {
    expect(tabs(await draw())).toEqual({ all: '0', private: '0', public: '0' });
    cleanup();
    state.priv = { of: 'held', amounts: [privateAmount(5n, 6, 'PRV')], unrecognised: 0 };
    expect(tabs(await draw())).toEqual({ all: '1', private: '1', public: '0' });
  });

  /* RED WHEN: a private side that was not believed or could not be read shows 0 on its tab or counts in All as if it held nothing, or the public side loses its count for it. */
  it('shows no count for a private side that was not believed or could not be read, and counts the public side', async () => {
    for (const priv of [{ of: 'not-believed' }, { of: 'unreadable', why: 'chain' }]) {
      state.priv = priv;
      expect(tabs(await draw()), JSON.stringify(priv)).toEqual({ all: null, private: null, public: '0' });
      cleanup();
    }
  });

  /* RED WHEN: a public side that could not be read shows 0 on its tab or counts in All as if it held nothing, or the private side loses its count for it. */
  it('shows no count for a public side that could not be read, and counts the private side', async () => {
    state.pub = null;
    expect(tabs(await draw())).toEqual({ all: null, private: '0', public: null });
  });
});
