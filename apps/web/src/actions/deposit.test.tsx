// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom, privateAmount, publicAmount } from 'vaults-ui';
import type { AddressesAndBalancesShown } from 'midnight-identity/profile/addresses-and-balances';
import { NIGHT, StaticAssetRegistry, type Asset } from '../../../../src/core/assets.js';
import { DEPOSIT_STEP, type DepositNow, type LastDepositChecked } from '../adapters/deposit.js';
import { ACT_REFUSAL } from '../adapters/refusals.js';
import { SessionProvider, type Session } from '../session.js';
import { VIEWS } from '../pages.js';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { PanelProvider, RightPanel, usePanel } from '../shell/right-panel.js';

/*
 * THE DEPOSIT PANEL, DRAWN WITH ITS REAL PARTS: the account's tokens, the adapter's amount check and its steps. Only what
 * reaches outside is replaced: the wallet's answer about the account, and the deposit the adapter keeps for the vault,
 * which a test sets and changes as the adapter would, and which records every press that reaches it.
 */
const dp = vi.hoisted(() => ({
  now: null as unknown, watchers: new Set<() => void>(), put: [] as unknown[][], started: 0, away: 0, checks: [] as unknown[][],
  checkAnswer: null as unknown, keyHeld: true,
  set(now: unknown) { this.now = now; for (const w of [...this.watchers]) w(); },
}));
const kr = vi.hoisted(() => ({ asked: [] as unknown[][], next: null as Promise<unknown> | null }));
vi.mock('../adapters/account-balances.js', async (real) => ({
  ...(await real<typeof import('../adapters/account-balances.js')>()),
  askForAccountBalances: async (...args: unknown[]) => { kr.asked.push(args); return kr.next; },
}));
const PRIVATE_TOKEN = 'ab'.repeat(32);
const UNNAMED = 'cd'.repeat(32);
const ROWS: Asset[] = [
  { code: NIGHT, symbol: 'NIGHT', name: 'Night', decimals: 6, ledger: { shielded: null, unshielded: NIGHT }, enabled: true, sortOrder: 50 },
  { code: PRIVATE_TOKEN, symbol: 'PRV', name: 'Private token', decimals: 6, ledger: { shielded: PRIVATE_TOKEN, unshielded: null }, enabled: true, sortOrder: 60 },
];
const registry = new StaticAssetRegistry(ROWS);
vi.mock('../adapters/deposit.js', async (real) => {
  const r = await real<typeof import('../adapters/deposit.js')>();
  return {
    ...r,
    depositNow: () => dp.now,
    watchDeposit: (_vault: string, watcher: () => void) => { dp.watchers.add(watcher); return () => { dp.watchers.delete(watcher); }; },
    companyKeyHeldHere: () => dp.keyHeld,
    putMoneyIn: (...args: Parameters<typeof r.putMoneyIn>) => {
      dp.put.push(args);
      const [, , , pick, entry, held] = args;
      const checked = r.amountToPutIn(entry, pick, held, registry);
      if (checked.of === 'refused') return checked;
      if ((dp.now as { of?: string } | null)?.of === 'running') return { of: 'already-running' };
      dp.started += 1;
      const steps = r.depositSteps(pick.kind, dp.keyHeld);
      dp.set({ of: 'running', kind: pick.kind, amount: checked.amount, steps, step: steps[0], n: 1, since: Date.now(), proofs: [] });
      return { of: 'started', ended: new Promise(() => {}) };
    },
    putAwayEndedDeposit: () => { dp.away += 1; dp.set(null); },
    checkMyLastDeposit: async (...args: unknown[]) => { dp.checks.push(args); return dp.checkAnswer; },
  };
});

const { Deposit } = await import('./deposit.js');
const { accountBalancesFrom } = await import('../adapters/account-balances.js');
const { depositSteps } = await import('../adapters/deposit.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const EN = JSON.parse(readFileSync(resolve(HERE, '../locales/en.json'), 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const VAULT = 'ab'.repeat(32);
const PRIVATE_ADDRESS = `mn_shield-addr_test1${'q'.repeat(60)}`;
const HASH_ON_CHAIN = 'ee'.repeat(32);
const MINUTES_AGO = (n: number): number => Date.now() - n * 60_000;
const shown = (): AddressesAndBalancesShown => ({
  addresses: { private: PRIVATE_ADDRESS },
  balances: [
    { token: PRIVATE_TOKEN, amount: '2500000', visibility: 'private' },
    { token: UNNAMED, amount: '5', visibility: 'private' },
    { token: NIGHT, amount: '12000000', visibility: 'public' },
  ],
  read: { private: MINUTES_AGO(2), public: MINUTES_AGO(1) },
});
const session = {
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(),
  viewer: { signedIn: true, view: VIEWS.company, signs: true }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
  choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
} as unknown as Session;

const changed = vi.fn();
const lead = vi.fn();
const panel = (checked: LastDepositChecked | null = null) => (
  <KitProvider languages={LANGUAGES} pick="en">
    <SessionProvider session={session}><Deposit company="c-1" vault={VAULT} leadTo={lead} onChanged={changed} checked={checked} /></SessionProvider>
  </KitProvider>
);
const draw = (checked: LastDepositChecked | null = null) => render(panel(checked));
const q = (c: ParentNode, sel: string) => c.querySelector<HTMLElement>(sel);
const all = (c: ParentNode, sel: string) => [...c.querySelectorAll<HTMLElement>(sel)];
const click = async (el: HTMLElement | null) => { await act(async () => { fireEvent.click(el!); await Promise.resolve(); await Promise.resolve(); }); };
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

/** The panel at the amount: the way from the wallet chosen, the tokens shown, and a row picked. */
async function atTheAmount(row: 'private' | 'public' = 'private') {
  const view = draw();
  await click(q(view.container, '[data-action=choose-method]'));
  await click(q(view.container, '[data-action=show-account-tokens]'));
  await settle();
  const code = row === 'private' ? PRIVATE_TOKEN : NIGHT;
  await click(q(view.container, `[data-token-row="${code}"][data-token-side=${row}] [data-token-choice]`));
  return view;
}
const type = async (c: HTMLElement, value: string) => { await act(async () => { fireEvent.change(q(c, '[data-field=deposit-amount]')!, { target: { value } }); }); };
const putButton = (c: HTMLElement) => q(c, '[data-action=put-money-in]') as HTMLButtonElement;

const privateAmountOf = (units: bigint) => privateAmount(units, 6, 'PRV');
const running = (n: number, kind: 'private' | 'public' = 'private', keyHeld = true): DepositNow => {
  const steps = depositSteps(kind, keyHeld);
  return { of: 'running', kind, amount: kind === 'private' ? privateAmountOf(1_250_000n) : publicAmount(4_000_000n, 6, 'NIGHT'), steps, step: steps[n - 1]!, n, since: Date.now(), proofs: [] };
};
const failed = (over: Partial<Extract<DepositNow, { of: 'failed' }>>): DepositNow => ({
  of: 'failed', kind: 'private', amount: privateAmountOf(1_250_000n), mayHaveBeenSent: false, refusal: ACT_REFUSAL.didNotFinish, reasons: [], ...over,
});

beforeEach(() => {
  dp.now = null; dp.watchers.clear(); dp.put = []; dp.started = 0; dp.away = 0; dp.checks = []; dp.checkAnswer = null; dp.keyHeld = true;
  kr.asked = []; kr.next = Promise.resolve(accountBalancesFrom(shown(), Date.now(), registry));
  changed.mockClear(); lead.mockClear();
});
afterEach(cleanup);

describe('the ways to put money in', () => {
  /* RED WHEN: the panel does not open on a list of ways to put money in, From your wallet is not an entry of it, there is no way back to the list from that way, or choosing it asks the wallet. */
  it('opens on a list of ways, whose entry from the wallet shows the account\'s tokens, and goes back to the list', async () => {
    const view = draw();
    const entries = all(view.container, '[data-deposit-methods] [data-method]');
    expect(entries.map((e) => e.dataset.method)).toEqual(['from-your-wallet']);
    expect(entries[0]!.textContent).toContain('From your wallet');
    expect(q(view.container, '[data-account-tokens]')).toBeNull();
    await click(q(view.container, '[data-action=choose-method]'));
    expect(q(view.container, '[data-account-tokens=not-asked]')).not.toBeNull();
    expect(kr.asked).toHaveLength(0);
    await click(q(view.container, '[data-action=deposit-methods]'));
    expect(q(view.container, '[data-deposit-methods]')).not.toBeNull();
    expect(q(view.container, '[data-account-tokens]')).toBeNull();
  });

  /* RED WHEN: the description of a way is cut short by an ellipsis, or the button that chooses it reads as anything but a sentence of its own, or no longer names the way it chooses to a screen reader. */
  it('shows the whole description of a way, and a button that reads as a sentence and is named for its way', () => {
    const view = draw();
    const entry = q(view.container, '[data-method=from-your-wallet]')!;
    const description = q(entry, '[data-slot=item-description]')!;
    expect(description.textContent).toBe(EN['deposit.method.fromYourWallet.line']);
    expect(description.className).not.toMatch(/(^|\s)line-clamp-[1-9]/u);
    expect(description.className).not.toMatch(/(^|\s)truncate(\s|$)/u);
    const choose = q(entry, '[data-action=choose-method]')!;
    expect(choose.textContent).toBe('Choose this way');
    expect(choose.textContent).not.toContain('From your wallet');
    const named = document.getElementById(choose.getAttribute('aria-describedby')!)!;
    expect(named.textContent).toBe('From your wallet');
  });

  /* RED WHEN: choosing a token asks the wallet, starts a deposit or puts money in before the button "Put money in" is pressed; or the wallet is asked for the account's tokens without its own button. */
  it('asks and sends nothing until Put money in is pressed', async () => {
    const view = draw();
    await click(q(view.container, '[data-action=choose-method]'));
    expect(kr.asked).toHaveLength(0);
    await click(q(view.container, '[data-action=show-account-tokens]'));
    await settle();
    expect(kr.asked).toHaveLength(1);
    await click(q(view.container, `[data-token-row="${PRIVATE_TOKEN}"] [data-token-choice]`));
    await type(view.container, '1');
    expect(dp.put).toHaveLength(0);
    expect(dp.started).toBe(0);
    expect(kr.asked).toHaveLength(1);
    await click(putButton(view.container));
    expect(dp.started).toBe(1);
  });

  /* RED WHEN: the tokens shown again after a refresh keep the earlier pick, so Max or the held amount belongs to a balance the wallet no longer shows. */
  it('drops the token picked when the account\'s tokens are read again', async () => {
    const view = await atTheAmount();
    expect(q(view.container, '[data-deposit-amount]')).not.toBeNull();
    await click(q(view.container, '[data-action=refresh-account-tokens]'));
    await settle();
    expect(q(view.container, '[data-deposit-amount]')).toBeNull();
  });
});

describe('the amount', () => {
  /* RED WHEN: in the right-hand panel, the Put money in press or a refusal of the amount is in the panel's scrolling body instead of its footer (which stays in view), the refusal is below the press, or outside a panel they are not still drawn together, the refusal first. */
  it('puts the press and a refusal in the panel\'s footer, the refusal above the press, and keeps them together outside a panel', async () => {
    const alone = await atTheAmount();
    expect(q(alone.container, '[data-deposit-footer] [data-action=put-money-in]')).not.toBeNull();
    cleanup();
    function Opener() {
      const { open } = usePanel();
      return <button type="button" data-open-panel onClick={() => open({ title: 'Deposit', body: <Deposit company="c-1" vault={VAULT} leadTo={lead} onChanged={changed} checked={null} /> })} />;
    }
    render(
      <KitProvider languages={LANGUAGES} pick="en">
        <SessionProvider session={session}><PanelProvider><Opener /><RightPanel /></PanelProvider></SessionProvider>
      </KitProvider>,
    );
    await click(q(document.body, '[data-open-panel]'));
    await settle();
    await click(q(document.body, '[data-action=choose-method]'));
    await click(q(document.body, '[data-action=show-account-tokens]'));
    await settle();
    await click(q(document.body, `[data-token-row="${PRIVATE_TOKEN}"][data-token-side=private] [data-token-choice]`));
    const footer = q(document.body, '[data-panel] [data-slot=sheet-footer]')!;
    const body = q(document.body, '[data-panel] .overflow-auto')!;
    expect(q(footer, '[data-action=put-money-in]')).toBe(putButton(document.body));
    expect(body.contains(putButton(document.body))).toBe(false);
    expect(q(document.body, '[data-amount-refused]')).toBeNull();
    await type(document.body, '3');
    await click(putButton(document.body));
    const refusal = q(footer, '[data-amount-refused]')!;
    expect(refusal).not.toBeNull();
    expect(body.contains(refusal)).toBe(false);
    expect(refusal.compareDocumentPosition(putButton(document.body)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(q(body, '[data-deposit-amount]')).not.toBeNull();
  });

  /* RED WHEN: an amount above what is held, nothing, nothing typed, or something that is not an amount reaches the wallet, or is refused without its next step on the panel. */
  it('refuses an amount above what is held, nothing, and no amount, on the panel, with the next step, before the wallet is asked', async () => {
    const view = await atTheAmount();
    for (const [typed, why, says] of [
      ['3', 'above-held', EN['deposit.refused.aboveHeld']],
      ['0', 'zero', EN['deposit.refused.zero']],
      ['', 'empty', EN['deposit.refused.nothingTyped']],
      ['twelve', 'not-a-number', EN['deposit.refused.notANumber']],
    ] as const) {
      await type(view.container, typed);
      await click(putButton(view.container));
      const refusal = q(view.container, '[data-amount-refused]')!;
      expect(refusal.dataset.amountRefused, typed).toBe(why);
      expect(refusal.textContent, typed).toContain(says);
      expect(refusal.textContent, typed).toContain(EN['deposit.refused.notAsked']);
      expect(dp.started, typed).toBe(0);
      expect(putButton(view.container).disabled, typed).toBe(false);
    }
    expect(q(view.container, '[data-deposit="running"]')).toBeNull();
  });

  /* RED WHEN: the refusal stays on the panel after the amount is changed, or an amount equal to what is held is refused. */
  it('clears a refusal when the amount changes, and takes exactly what is held', async () => {
    const view = await atTheAmount();
    await type(view.container, '3');
    await click(putButton(view.container));
    expect(q(view.container, '[data-amount-refused]')).not.toBeNull();
    await type(view.container, '2.5');
    expect(q(view.container, '[data-amount-refused]')).toBeNull();
    await click(putButton(view.container));
    expect(dp.started).toBe(1);
  });

  /* RED WHEN: Max puts in anything but the amount the wallet said is held, or does not show what it will put in. */
  it('puts in exactly what is held when Max is pressed, and says how much that is', async () => {
    const view = await atTheAmount();
    await click(q(view.container, '[data-action=deposit-max]'));
    expect(q(view.container, '[data-max-all]')!.textContent).toContain('2.5');
    expect(q(view.container, '[data-max-all]')!.textContent).toContain('PRV');
    await click(putButton(view.container));
    expect(dp.put).toHaveLength(1);
    expect(dp.put[0]!.slice(3)).toEqual([{ code: PRIVATE_TOKEN, kind: 'private' }, expect.any(Symbol), 2_500_000n]);
    expect(dp.started).toBe(1);
  });

  /* RED WHEN: a typed amount is not handed to the adapter as typed, with the pick's side and the held amount, or a public row is put in as a private one. */
  it('hands the adapter what was typed, with the row picked and what the wallet said it holds', async () => {
    const view = await atTheAmount('public');
    await type(view.container, '1.25');
    await click(putButton(view.container));
    expect(dp.put[0]!.slice(1)).toEqual(['c-1', VAULT, { code: NIGHT, kind: 'public' }, '1.25', 12_000_000n]);
  });
});

describe('what the panel says before the press', () => {
  /* RED WHEN: the privacy line of a private deposit says more or less than the sentence the product states, or a public deposit does not say the design's line. */
  it('says exactly the private line for a private deposit, and the public line for a public one', async () => {
    const priv = await atTheAmount('private');
    expect(q(priv.container, '[data-privacy=private]')!.textContent).toBe('The amount and the currency are not shown on the network. That money went into this vault, and when, is public.');
    expect(q(priv.container, '[data-privacy=public]')).toBeNull();
    expect(q(priv.container, '[data-paid-from-public]')).toBeNull();
    cleanup();
    const pub = await atTheAmount('public');
    expect(q(pub.container, '[data-privacy=public]')!.textContent).toBe("Anyone can look up the token, the amount, your wallet's public address and the vault it goes into. Money put in publicly is paid out publicly, and this page cannot make it private later.");
    expect(q(pub.container, '[data-privacy=private]')).toBeNull();
    /* RED WHEN: a public pick does not say that it is paid from the account's public address, which the page does not show, or a private pick says it. */
    expect(q(pub.container, '[data-paid-from-public]')!.textContent).toBe("A public token is paid from this account's public address, which this page does not show.");
  });

  /* RED WHEN: the one window a private deposit opens is not named before the press, with the records it signs, or a second window is named for it in a tab that holds no company key. */
  it('names the one wallet window before it opens, whether or not this tab holds the company key', async () => {
    const PRIVATE_WINDOW = "Your wallet opens to make this deposit from this account: it lists the vault's records it signs for it, and this service pays the network fee. In your wallet, press Approve.";
    dp.keyHeld = false;
    const view = await atTheAmount('private');
    const named = all(view.container, '[data-wallet-window-named]').filter((n) => !n.closest('[data-account-tokens-ask]'));
    expect(named.map((n) => n.textContent)).toEqual([PRIVATE_WINDOW]);
    expect(dp.put).toHaveLength(0);
    cleanup();
    dp.keyHeld = true;
    const held = await atTheAmount('private');
    expect(all(held.container, '[data-deposit-amount] [data-wallet-window-named]').map((n) => n.textContent)).toEqual([PRIVATE_WINDOW]);
    cleanup();
    dp.keyHeld = false;
    const pub = await atTheAmount('public');
    expect(all(pub.container, '[data-deposit-amount] [data-wallet-window-named]').map((n) => n.textContent)).toEqual([
      'Your wallet opens to pay this deposit from this account. This service pays the network fee. In your wallet, press Pay publicly into the vault.',
    ]);
  });

  /* RED WHEN: a press is not shown as taken at once (the button busy and disabled), or a second press sends a second deposit. */
  it('shows the press as taken at once, and a second press sends nothing', async () => {
    const view = await atTheAmount();
    await type(view.container, '1');
    await act(async () => { putButton(view.container).click(); putButton(view.container).click(); await Promise.resolve(); });
    expect(dp.put).toHaveLength(1);
    expect(putButton(view.container).disabled).toBe(true);
    expect(q(view.container, `[data-slot=spinner][aria-label="${EN['deposit.putting']}"]`)).not.toBeNull();
    fireEvent.click(putButton(view.container));
    await settle();
    expect(dp.put).toHaveLength(1);
    expect(dp.started).toBe(1);
  });
});

describe('the steps', () => {
  /* RED WHEN: "step n of m" does not follow the stage the deposit is on, counts a different number of steps than the kind has, or the step is not named. */
  it('says which step of how many runs, following the deposit through its stages', async () => {
    dp.now = running(1);
    const view = draw();
    const at = () => [q(view.container, '[data-step-of]')!.textContent, q(view.container, '[data-step-name]')!.textContent];
    expect(at()).toEqual(['Step 1 of 2', 'Paying in your wallet']);
    await act(async () => { dp.set(running(2)); });
    expect(at()).toEqual(['Step 2 of 2', 'Proving the deposit on this device']);
    await act(async () => { dp.set(running(2, 'public')); });
    expect(at()).toEqual(['Step 2 of 5', 'Proving the deposit on this device']);
    await act(async () => { dp.set(running(4, 'public')); });
    expect(at()).toEqual(['Step 4 of 5', 'Sending the deposit to the network']);
    await act(async () => { dp.set(running(1, 'private', false)); });
    expect(at()).toEqual(['Step 1 of 2', 'Paying in your wallet']);
    expect(all(view.container, '[data-slot=progress-mark]').map((m) => m.dataset.filled)).toEqual(['false', 'false']);
    await act(async () => { dp.set(running(2, 'private', false)); });
    expect(all(view.container, '[data-slot=progress-mark]').map((m) => m.dataset.filled)).toEqual(['true', 'false']);
  });

  /* RED WHEN: a step with no measured usual time says how long it usually takes (or that it depends on other signers), the running time is missing, or a step with one does not say it. */
  it('shows the running time of every step and the usual time only where there is one', async () => {
    dp.now = running(1);
    const view = draw();
    expect(q(view.container, '[data-elapsed]')!.textContent).toBe('Running for 0:00.');
    expect(q(view.container, '[data-usual]')).toBeNull();
    expect(view.container.textContent).not.toContain(EN['stageProgress.noUsual']);
    await act(async () => { dp.set(running(2)); });
    expect(q(view.container, '[data-usual]')).toBeNull();
    await act(async () => { dp.set(running(2, 'public')); });
    expect(q(view.container, '[data-usual]')!.textContent).toBe('This usually takes about 2 seconds.');
    await act(async () => { dp.set(running(3, 'public')); });
    expect(q(view.container, '[data-usual]')).toBeNull();
  });

  /* RED WHEN: while a public deposit is being proved the panel does not name the wallet window that opens next, the amount and token it pays, the press, and who pays the fee; or a private deposit's panel names a window still to come once it was approved. */
  it('names the payment window while proving, with what it pays and what to press', async () => {
    dp.now = running(1);
    const priv = draw();
    expect(q(priv.container, '[data-wallet-open]')!.textContent).toBe('Your wallet is open. Press Approve there to pay.');
    await act(async () => { dp.set(running(2)); });
    expect(q(priv.container, '[data-next-window]')).toBeNull();
    expect(q(priv.container, '[data-wallet-makes]')!.textContent).toBe(EN['deposit.walletMakes']);
    cleanup();
    dp.now = { ...running(2, 'public'), amount: privateAmountOf(1_250_000n) };
    const view = draw();
    expect(q(view.container, '[data-next-window]')!.textContent).toBe('Your wallet opens next to pay 1.25 PRV. You press Pay publicly into the vault there. This service pays the network fee.');
    /* One phrase that flows as text: the sentence's own text and the amount are the paragraph's direct content, not items of a row, so its full stop stays on the amount's line. */
    const next = q(view.container, '[data-next-window]')!;
    expect(next.className).not.toMatch(/(^|\s)(flex|inline-flex|grid)(\s|$)/u);
    const parts = [...next.childNodes].map((n) => (n.nodeType === Node.TEXT_NODE ? 'text' : (n as HTMLElement).dataset.slot)).filter((x, i, xs) => x !== 'text' || xs[i - 1] !== 'text');
    expect(parts).toEqual(['text', 'amount', 'text']);
    expect(next.lastChild!.textContent!.startsWith('.')).toBe(true);
    await act(async () => { dp.set(running(3, 'public')); });
    expect(q(view.container, '[data-next-window]')).toBeNull();
    expect(q(view.container, '[data-wallet-open]')!.textContent).toBe('Your wallet is open. Press Pay publicly into the vault there to pay.');
  });

  /* RED WHEN: closing the panel and opening it again does not show the deposit that is running, or loses where it is up to, or shows the form while one runs. */
  it('shows the same deposit after the panel is closed and opened again', async () => {
    dp.now = running(1);
    const first = draw();
    expect(q(first.container, '[data-step-of]')!.textContent).toBe('Step 1 of 2');
    first.unmount();
    expect(dp.watchers.size).toBe(0);
    await act(async () => { dp.set(running(2)); });
    const second = draw();
    expect(q(second.container, '[data-step-of]')!.textContent).toBe('Step 2 of 2');
    expect(q(second.container, '[data-deposit-methods]')).toBeNull();
    expect(putButton(second.container).disabled).toBe(true);
    expect(dp.started).toBe(0);
  });
});

describe('how it ended', () => {
  const SERVICE_HASH = 'ff'.repeat(32);

  /* RED WHEN: a finished deposit shows anything but the transaction the chain shows, or shows the service's hash, or invents a hash when the chain has not named one. */
  it('shows the transaction the chain shows and never the service\'s hash, and says so when the chain has not named one', async () => {
    dp.now = { of: 'done', kind: 'private', amount: privateAmountOf(1_250_000n), chainTransaction: HASH_ON_CHAIN, notYetSpendable: false, earlier: null };
    const view = draw();
    expect(q(view.container, '[data-chain-transaction]')!.textContent).toBe(HASH_ON_CHAIN);
    expect(view.container.textContent).not.toContain(SERVICE_HASH);
    await act(async () => { dp.set({ of: 'done', kind: 'private', amount: privateAmountOf(1_250_000n), chainTransaction: null, notYetSpendable: true, earlier: null }); });
    expect(q(view.container, '[data-chain-transaction]')).toBeNull();
    expect(q(view.container, '[data-chain-transaction-none]')!.textContent).toBe('The deposit is in the vault. This page has not yet matched it to its transaction.');
    expect(q(view.container, '[data-not-spendable]')!.textContent).toBe('It cannot be used for a payment yet. Check the vault again in a minute.');
    expect(view.container.textContent).not.toMatch(/[0-9a-f]{64}/u);
  });

  /* RED WHEN: the vault's balances are not read again when a deposit finishes, are read again at every redraw, or the earlier deposit found on the way is not said. */
  /* RED WHEN: the panel, as well as the vault page's line about the deposit, tells the page that the deposit finished, so the company's records and the vault's balances are both read again for one deposit. */
  it('leaves telling the page that the deposit finished to the vault page\'s own line, so one deposit is read for once', async () => {
    dp.now = running(6);
    const view = draw();
    const done: DepositNow = { of: 'done', kind: 'private', amount: privateAmountOf(1n), chainTransaction: HASH_ON_CHAIN, notYetSpendable: false, earlier: 'recorded' };
    await act(async () => { dp.set(done); });
    expect(changed).not.toHaveBeenCalled();
    expect(q(view.container, '[data-earlier=recorded]')).not.toBeNull();
  });

  /* RED WHEN: putting more money in after a deposit ends does not put the ended deposit away, or offers the earlier tokens without the account's own refresh press. */
  /* RED WHEN: after a deposit has ended, Put more money in or Try again brings back the way, the token or the amount held that were picked for the deposit before, so an amount is checked, or Max takes, what the account held then. */
  it.each([
    ['done', { of: 'done', kind: 'private', amount: privateAmountOf(1_000_000n), chainTransaction: HASH_ON_CHAIN, notYetSpendable: false, earlier: null }, 'put-more-in'],
    ['failed', failed({ mayHaveBeenSent: false, reasons: ['declined'], refusal: ACT_REFUSAL.declined }), 'try-again'],
  ] as const)('forgets the way and the token picked once a deposit has %s, and asks the wallet again before an amount can be checked', async (_ended, ended, again) => {
    const view = await atTheAmount();
    await type(view.container, '1');
    await click(putButton(view.container));
    expect(dp.started).toBe(1);
    expect(kr.asked).toHaveLength(1);
    await act(async () => { dp.set(ended); });
    await click(q(view.container, `[data-action=${again}]`));
    expect(q(view.container, '[data-deposit-amount]')).toBeNull();
    expect(q(view.container, '[data-deposit-methods]')).not.toBeNull();
    await click(q(view.container, '[data-action=choose-method]'));
    expect(q(view.container, '[data-account-tokens=not-asked]')).not.toBeNull();
    expect(q(view.container, '[data-deposit-amount]')).toBeNull();
    expect(q(view.container, '[data-action=deposit-max]')).toBeNull();
    expect(kr.asked).toHaveLength(1);
  });


  it('offers the account\'s tokens again only through their own press after a deposit', async () => {
    dp.now = { of: 'done', kind: 'private', amount: privateAmountOf(1_250_000n), chainTransaction: HASH_ON_CHAIN, notYetSpendable: false, earlier: null };
    const view = draw();
    await click(q(view.container, '[data-action=put-more-in]'));
    expect(dp.away).toBe(1);
    await click(q(view.container, '[data-action=choose-method]'));
    expect(q(view.container, '[data-account-tokens=not-asked]')).not.toBeNull();
    expect(kr.asked).toHaveLength(0);
  });

  /* RED WHEN: the failure of a deposit that may have reached the network does not say, word for word, to press Check my last deposit first, with each reason joined by "; "; or those words appear when nothing was sent. */
  it('says the failure words exactly when something may have been sent, and only then', async () => {
    dp.now = failed({ mayHaveBeenSent: true, reasons: ['the wallet closed', 'the service did not answer'], refusal: ACT_REFUSAL.didNotFinish });
    const view = draw();
    expect(q(view.container, '[data-failed-words]')!.textContent).toBe(
      'Putting money in did not finish. Before you try again, press Check my last deposit to see whether anything reached the vault. Details for support: the wallet closed; the service did not answer.',
    );
    expect(q(view.container, '[data-nothing-sent]')).toBeNull();
    await act(async () => { dp.set(failed({ mayHaveBeenSent: false, reasons: ['no money was found'], refusal: ACT_REFUSAL.payNotEnough })); });
    expect(q(view.container, '[data-failed-words]')).toBeNull();
    expect(view.container.textContent).not.toContain('Before you try again, press Check my last deposit');
    expect(q(view.container, '[data-refusal=pay-not-enough]')!.textContent).toContain(EN['act.refused.payNotEnough']);
    expect(q(view.container, '[data-nothing-sent]')!.textContent).toBe('Nothing was sent to the network, so no money moved.');
    expect(q(view.container, '[data-action=check-last-deposit]')).toBeNull();
  });

  /* RED WHEN: a refusal where the vault cannot take money does not lead to the setup steps, or leads there for one that setup cannot mend. */
  /* RED WHEN: a public deposit that may have been sent is led with the words for a private one (press Check my last deposit), offers Check my last deposit, which finds only private deposits, or offers Try again before the time until which the same money must not be put in again; or leaves out that time, or that the person looks at the wallet's public balance. */
  it('leads a public deposit that may have been sent with the time not to put the same money in before, and holds Try again until then', async () => {
    const until = Date.now() + 250;
    const sent = (over: Partial<Extract<DepositNow, { of: 'failed' }>>) => failed({
      kind: 'public', amount: publicAmount(4_000_000n, 6, 'NIGHT'), mayHaveBeenSent: true, reasons: ['the public deposit may have been sent, and so on', 'the indexer did not answer'], ...over,
    });
    dp.now = sent({ until });
    const view = draw();
    const words = q(view.container, '[data-failed-words]')!.textContent!;
    expect(words).toMatch(/^This public deposit may have been sent, and this page was not told whether it arrived\. Do not put the same money in again before .*20\d\d.*\. If it has not arrived by then, it never will\. Open your wallet: if its public balance has dropped by this amount and you spent nothing else from it, the vault has it\./u);
    expect(words).toContain('"Check my last deposit" finds only private deposits, so it cannot tell you about this one.');
    expect(words).not.toContain('Before you try again, press Check my last deposit');
    expect(q(view.container, '[data-details]')!.textContent).toBe('Details for support: the indexer did not answer.');
    expect(q(view.container, '[data-action=check-last-deposit]')).toBeNull();
    expect(q(view.container, '[data-action=try-again]')).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(q(view.container, '[data-action=try-again]')).not.toBeNull();
    expect(q(view.container, '[data-action=check-last-deposit]')).toBeNull();
    await act(async () => { dp.set(sent({ until: Date.now() - 1000 })); });
    expect(q(view.container, '[data-action=try-again]')).not.toBeNull();
    expect(q(view.container, '[data-action=check-last-deposit]')).toBeNull();
    await act(async () => { dp.set(sent({ until: Date.now() + 3_600_000 })); });
    expect(q(view.container, '[data-action=try-again]')).toBeNull();
    await act(async () => { dp.set(sent({})); });
    expect(q(view.container, '[data-failed-words]')!.textContent).toContain('Do not put the same money in again until you have looked at your wallet');
    expect(q(view.container, '[data-action=check-last-deposit]')).toBeNull();
    await act(async () => { dp.set(failed({ mayHaveBeenSent: true, reasons: ['x'] })); });
    expect(q(view.container, '[data-action=check-last-deposit]')).not.toBeNull();
    expect(q(view.container, '[data-action=try-again]')).not.toBeNull();
  });


  /* RED WHEN: in a tab that holds no company key, Check my last deposit opens the person's wallet on the first press without saying so first, or does not check on the press that follows the naming. */
  it('names the wallet window before Check my last deposit opens it, in a tab that holds no company key, and checks on the next press', async () => {
    dp.keyHeld = false;
    dp.now = failed({ mayHaveBeenSent: true, reasons: ['x'] });
    dp.checkAnswer = { of: 'checked', deposit: 'none', until: null, notYetSpendable: false, named: 0, unnamed: 0, toName: 0, forSupport: '', deposited: null, unshown: null } satisfies LastDepositChecked;
    const view = draw();
    await click(q(view.container, '[data-action=check-last-deposit]'));
    expect(dp.checks).toHaveLength(0);
    expect(q(view.container, '[data-wallet-window-named]')!.textContent).toBe(
      "Your wallet opens first, to open your company's records on this device. Nothing is paid. In your wallet, press Sign my records key.",
    );
    await click(q(view.container, '[data-action=check-last-deposit]'));
    expect(dp.checks).toEqual([['u1', 'c-1', VAULT]]);
    expect(q(view.container, '[data-check-says]')).not.toBeNull();
    await click(q(view.container, '[data-action=back-to-deposit]'));
    expect(q(view.container, '[data-wallet-window-named]')).toBeNull();
    cleanup();
    dp.now = null;
    const named = render(
      <KitProvider languages={LANGUAGES} pick="en">
        <SessionProvider session={session}><Deposit company="c-1" vault={VAULT} leadTo={lead} onChanged={changed} naming /></SessionProvider>
      </KitProvider>,
    );
    expect(dp.checks).toHaveLength(1);
    expect(q(named.container, '[data-wallet-window-named]')).not.toBeNull();
    await click(q(named.container, '[data-action=check-last-deposit]'));
    expect(dp.checks).toHaveLength(2);
  });


  it('leads to the setup steps only for a refusal they can mend', async () => {
    dp.now = failed({ refusal: ACT_REFUSAL.vaultNotTheCompanys, reasons: ['not adopted'] });
    const view = draw();
    await click(q(view.container, '[data-lead-to=vault]'));
    expect(lead).toHaveBeenCalledWith('vault');
    await act(async () => { dp.set(failed({ refusal: ACT_REFUSAL.declined })); });
    expect(q(view.container, '[data-lead-to]')).toBeNull();
  });

  /* RED WHEN: the failure of a deposit that may have been sent has no Check my last deposit, a second press runs a second check, or the answer is not shown on the panel. */
  it('checks the last deposit from a failed one, once for two presses, and shows the answer', async () => {
    dp.now = failed({ mayHaveBeenSent: true, reasons: ['x'] });
    dp.checkAnswer = { of: 'checked', deposit: 'still-on-its-way', until: Date.UTC(2026, 9, 23, 12, 0), notYetSpendable: false, named: 0, unnamed: 0, toName: 0, forSupport: 'for support', deposited: null, unshown: null } satisfies LastDepositChecked;
    const view = draw();
    await act(async () => { const b = q(view.container, '[data-action=check-last-deposit]')!; b.click(); b.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(dp.checks).toEqual([['u1', 'c-1', VAULT]]);
    expect(q(view.container, '[data-check-says]')!.textContent).toContain('has not reached the vault yet');
    expect(q(view.container, '[data-check-says]')!.textContent).toContain('Do not put the same money in again.');
  });
});

describe('Check my last deposit, as the panel says it', () => {
  const checked = (over: Partial<Extract<LastDepositChecked, { of: 'checked' }>>): LastDepositChecked => ({
    of: 'checked', deposit: 'none', until: null, notYetSpendable: false, named: 0, unnamed: 0, toName: 0, forSupport: '',
    deposited: null, unshown: null, ...over,
  });

  /* RED WHEN: the panel does not say what the check reads (the newest private deposit filed for the vault, and one this browser kept from before) and that a public deposit is checked in the wallet. */
  it('says that a public deposit is checked in the wallet', () => {
    const view = draw(checked({}));
    expect(q(view.container, '[data-private-only]')!.textContent).toBe(
      'This checks the newest private deposit filed for this vault, and one this browser kept from before your wallet made deposits. A public deposit is checked in your wallet, not here.',
    );
  });

  /* RED WHEN: any answer of the check is said as another, or an answer with money not yet usable, or deposits not yet matched, leaves that out. */
  it.each([
    ['none', 'This browser has no deposit into this vault waiting to be seen.'],
    ['already-recorded', "The deposit checked is already in the vault's record."],
    ['never-landed', 'Your last deposit from this browser never reached the vault, and now it never will. No money moved.'],
    ['recorded', 'Your last deposit from this browser has reached the vault and is now in its record.'],
    ['landed-not-recorded', 'Your last deposit from this browser is in the vault, and this page cannot yet read the transfer that brought it in. Check again in a minute.'],
    ['landed-owed-its-record', "The deposit is in the vault, and not yet in its record. The vault's deposit journal names it, so it is not lost; a check here files nothing. Do not put the same money in again."],
    ['journalled-not-seen', 'The newest deposit filed for this vault has not reached the vault yet. It may still arrive. Do not put the same money in again.'],
    ['landed-and-since-spent', 'The deposit reached the vault, and the vault has since paid it out or combined it.'],
  ] as const)('says %s', (state, words) => {
    const view = draw(checked({ deposit: state }));
    expect(q(view.container, '[data-check-says]')!.textContent).toBe(words);
  });

  /* RED WHEN: a deposit on its way does not say when to stop waiting, or an answer hides that its money is not usable yet, how many deposits are unmatched, or what support needs. */
  it('says what is left to say: when to stop waiting, money not yet usable, unmatched deposits, and the details for support', () => {
    const view = draw(checked({ deposit: 'recorded', notYetSpendable: true, unnamed: 2, forSupport: 'Everything the check read.' }));
    expect(q(view.container, '[data-not-spendable]')!.textContent).toBe('It cannot be used for a payment yet.');
    expect(q(view.container, '[data-unnamed]')!.textContent).toBe('2 deposits in the vault are not yet matched to their transactions.');
    expect(q(view.container, '[data-details]')!.textContent).toBe('Details for support: Everything the check read.');
    /* RED WHEN: an amount this check, which files nothing, could name and left for a signer's wallet is not said. */
    expect(q(view.container, '[data-to-name]')).toBeNull();
    cleanup();
    const owed = draw(checked({ deposit: 'none', toName: 1 }));
    expect(q(owed.container, '[data-to-name]')!.textContent).toBe("1 deposit in the vault can be used for payments once a signer's wallet next files this vault's records.");
    cleanup();
    const waiting = draw(checked({ deposit: 'still-on-its-way', until: Date.UTC(2026, 9, 23, 12, 0) }));
    expect(q(waiting.container, '[data-check-says]')!.textContent).toMatch(/^Your last deposit from this browser has not reached the vault yet\. If it has not arrived by .*2026.*, it never will and no money moved\. Do not put the same money in again\.$/u);
  });

  /* RED WHEN: a deposit the check judged is said without what it was, or a token the page does not list is shown with no reason. */
  it('says what the deposit it checked was, or why its amount is not shown', () => {
    const view = draw(checked({ deposit: 'already-recorded', deposited: privateAmountOf(1_500_000n) }));
    expect(q(view.container, '[data-checked-amount]')!.textContent).toMatch(/^1\.5\s*PRV/u);
    expect(q(view.container, '[data-checked-amount] [data-slot=amount][data-visibility=private]')).not.toBeNull();
    cleanup();
    const unlisted = draw(checked({ deposit: 'already-recorded', unshown: 'token-not-listed' }));
    expect(q(unlisted.container, '[data-checked-amount]')).toBeNull();
    expect(q(unlisted.container, '[data-checked-unshown]')!.textContent).toBe('1 amount is in a token this app does not know, so it is not shown.');
  });

  /* RED WHEN: a check the wallet or device refused is shown as a finding, without the refusal's words, or without a way back to the deposit. */
  it('shows a refused check with the refusal\'s words, and goes back to the deposit', async () => {
    const view = draw({ of: 'refused', why: ACT_REFUSAL.notSignedIn, reasons: ['no session'] });
    expect(q(view.container, '[data-refusal=not-signed-in]')!.textContent).toContain(EN['act.refused.notSignedIn']);
    expect(q(view.container, '[data-details]')!.textContent).toBe('Details for support: no session.');
    await click(q(view.container, '[data-action=back-to-deposit]'));
    expect(q(view.container, '[data-deposit-methods]')).not.toBeNull();
  });
});

describe('the deposit steps and their words', () => {
  /* RED WHEN: a step the adapter lists has no words of its own on the panel. */
  it('has words for every step', async () => {
    const seen = new Set<string>();
    dp.now = running(1, 'public');
    const view = draw();
    for (const [kind, count] of [['public', 5], ['private', 2]] as const) {
      for (let n = 1; n <= count; n += 1) {
        await act(async () => { dp.set(running(n, kind)); });
        const name = q(view.container, '[data-step-name]')!.textContent!;
        expect(name.length).toBeGreaterThan(5);
        seen.add(name);
      }
    }
    expect(seen.size).toBe(Object.values(DEPOSIT_STEP).length);
  });
});
