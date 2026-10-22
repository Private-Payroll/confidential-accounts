// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import type { AddressesAndBalancesShown } from 'midnight-identity/profile/addresses-and-balances';
import { NIGHT, StaticAssetRegistry, type Asset } from '../../../../src/core/assets.js';
import { ACT_REFUSAL } from '../adapters/refusals.js';
import type { TokenChosen } from './account-tokens.js';

/*
 * THE ACCOUNT'S TOKENS, DRAWN WITH THE REAL COMPONENT AND THE REAL ADAPTER'S ANSWERS: only the ask of the wallet is
 * replaced by a test, which records every press that reaches it and answers when the test says.
 */
const kr = vi.hoisted(() => ({ asked: [] as unknown[][], next: null as Promise<unknown> | null }));
vi.mock('../adapters/account-balances.js', async (real) => ({
  ...(await real<typeof import('../adapters/account-balances.js')>()),
  askForAccountBalances: async (...args: unknown[]) => { kr.asked.push(args); return kr.next; },
}));

const { AccountTokens, WalletWindowNamed } = await import('./account-tokens.js');
const { accountBalancesFrom } = await import('../adapters/account-balances.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const EN = JSON.parse(readFileSync(resolve(HERE, '../locales/en.json'), 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const PRIVATE_ADDRESS = `mn_shield-addr_test1${'q'.repeat(60)}`;
const PRIVATE_TOKEN = 'ab'.repeat(32);
const UNNAMED = 'cd'.repeat(32);
const ROWS: Asset[] = [
  { code: NIGHT, symbol: 'NIGHT', name: 'Night', decimals: 6, ledger: { shielded: null, unshielded: NIGHT }, enabled: true, sortOrder: 50 },
  { code: PRIVATE_TOKEN, symbol: 'PRV', name: 'Private token', decimals: 6, ledger: { shielded: PRIVATE_TOKEN, unshielded: null }, enabled: true, sortOrder: 60 },
];
const registry = new StaticAssetRegistry(ROWS);
const MINUTES_AGO = (n: number): number => Date.now() - n * 60_000;
const shown = (over: Partial<AddressesAndBalancesShown> = {}): AddressesAndBalancesShown => ({
  addresses: { private: PRIVATE_ADDRESS },
  balances: [
    { token: PRIVATE_TOKEN, amount: '2500000', visibility: 'private' },
    { token: UNNAMED, amount: '5', visibility: 'private' },
    { token: NIGHT, amount: '12000000', visibility: 'public' },
  ],
  read: { private: MINUTES_AGO(2), public: MINUTES_AGO(1) },
  ...over,
});
const answered = (s: AddressesAndBalancesShown = shown()) => Promise.resolve(accountBalancesFrom(s, Date.now(), registry));

const draw = (ui: React.ReactNode = <AccountTokens />) => render(<KitProvider languages={LANGUAGES} pick="en">{ui}</KitProvider>);
const button = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('[data-account-tokens-ask] button')!;
const press = async (c: HTMLElement) => { await act(async () => { fireEvent.click(button(c)); await Promise.resolve(); }); };
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const side = (c: HTMLElement, which: 'private' | 'public') => c.querySelector<HTMLElement>(`[data-token-side=${which}]`)?.closest('[data-side-shown]') ?? c.querySelector<HTMLElement>('[data-side-shown]')!;

beforeEach(() => { kr.asked = []; kr.next = answered(); });
afterEach(cleanup);

describe('the account\'s tokens, before and at the press', () => {
  /* RED WHEN: the wallet is asked before the button is pressed, or the window is not named before it opens. */
  it('asks nothing until the button is pressed, and names the window first', async () => {
    const { container } = draw();
    await settle();
    expect(kr.asked).toHaveLength(0);
    const named = container.querySelector('[data-wallet-window-named]')!;
    expect(named.textContent).toContain(EN['accountTokens.opens']);
    expect(named.textContent).toContain(EN['accountTokens.press']);
    expect(container.querySelector('[data-private-address]')).toBeNull();
    await press(container);
    await settle();
    expect(kr.asked).toHaveLength(1);
  });

  /* RED WHEN: the page hands the ask a name of its own, which is not the name every other ask to the wallet sends: the ask takes its name from the one place that holds it, so a press hands it nothing. */
  it('asks the wallet without a name of its own, which the ask takes from the one place that holds it', async () => {
    const { container } = draw();
    await press(container);
    expect(kr.asked[0]).toEqual([]);
  });

  /* RED WHEN: a press is not shown as taken at once, or a second press while the wallet is open sends another ask. */
  it('shows the press as taken at once, and a second press sends nothing', async () => {
    kr.next = new Promise(() => {});
    const { container } = draw();
    await press(container);
    expect(button(container).disabled).toBe(true);
    expect(container.querySelector(`[data-slot=spinner][aria-label="${EN['accountTokens.waiting']}"]`)).not.toBeNull();
    await press(container);
    fireEvent.click(button(container));
    expect(kr.asked).toHaveLength(1);
  });

  /* RED WHEN: a second press that arrives before the button is greyed gets through. */
  it('holds a second press that arrives before the screen has changed', async () => {
    kr.next = new Promise(() => {});
    const { container } = draw();
    await act(async () => { button(container).click(); button(container).click(); await Promise.resolve(); });
    expect(kr.asked).toHaveLength(1);
  });
});

describe('the account\'s tokens, once shown', () => {
  /* RED WHEN: the address is not labelled as this account's private address, is labelled as what pays (it sits over public tokens too, and where nothing pays), or a public address appears. */
  it('labels the address as the account\'s private address, and shows no public address', async () => {
    const { container } = draw();
    await press(container);
    await settle();
    expect(container.querySelector('[data-private-address]')?.textContent).toBe(PRIVATE_ADDRESS);
    expect(container.querySelector('[data-private-address-label]')?.textContent).toBe("This account's private address");
    expect(container.textContent).not.toMatch(/[Pp]ays from/u);
    expect(container.textContent).not.toMatch(/mn_addr/);
  });

  /* RED WHEN: a public amount shows without the Public pill, or a private amount carries it. */
  it('puts the Public pill on a public amount and none on a private one', async () => {
    const { container } = draw();
    await press(container);
    await settle();
    const pub = container.querySelector(`[data-token-row="${NIGHT}"][data-token-side=public]`)!;
    const priv = container.querySelector(`[data-token-row="${PRIVATE_TOKEN}"][data-token-side=private]`)!;
    expect(pub.querySelector('[data-slot=amount][data-visibility=public] [data-slot=public-pill]')?.textContent).toBe(EN['kit.public.label']);
    expect(pub.textContent).toContain('12');
    expect(priv.querySelector('[data-slot=amount][data-visibility=private]')).not.toBeNull();
    expect(priv.querySelector('[data-slot=public-pill]')).toBeNull();
    expect(priv.textContent).toContain('2.5');
  });

  /* RED WHEN: a side the wallet could not read is shown as zero or as an empty list, or its sibling is dropped with it. */
  it('shows a side not read as not known, never zero', async () => {
    kr.next = answered(shown({ read: { private: null, public: MINUTES_AGO(1) } }));
    const { container } = draw();
    await press(container);
    await settle();
    const notRead = container.querySelector<HTMLElement>('[data-side-shown=not-known]')!;
    expect(notRead.textContent).toContain(EN['accountTokens.private']);
    expect(notRead.textContent).toContain(EN['accountTokens.notKnown']);
    expect(notRead.querySelector('[data-slot=amount]')).toBeNull();
    expect(notRead.querySelector('[data-slot=count-pill]')).toBeNull();
    expect(notRead.textContent).not.toMatch(/\b0\b/);
    expect(container.querySelector(`[data-token-row="${NIGHT}"][data-token-side=public]`)).not.toBeNull();
  });

  /* RED WHEN: a side the wallet read and found empty is told as not known, or a side with nothing held says nothing. */
  it('tells a side read and empty apart from one not read', async () => {
    kr.next = answered(shown({ balances: [] }));
    const { container } = draw();
    await press(container);
    await settle();
    expect(container.querySelectorAll('[data-side-none]')).toHaveLength(2);
    expect(container.querySelector('[data-side-not-known]')).toBeNull();
  });

  /* RED WHEN: tokens this app cannot put in are dropped silently, shown as rows, or counted with the wrong number. */
  it('says in one line how many tokens it cannot put in, and offers none of them', async () => {
    const { container } = draw();
    await press(container);
    await settle();
    const line = container.querySelector('[data-cannot-put-in="1"]')!;
    expect(line.textContent).toBe(EN['accountTokens.cannotPutIn_one']!.replace('{count}', '1'));
    expect(container.querySelectorAll('[data-token-row]')).toHaveLength(2);
    expect(container.querySelector('[data-cannot-put-in="2"]')).toBeNull();
  });

  /* RED WHEN: when each side was read is not said, or both sides are given the same moment. */
  it('says when each side was read', async () => {
    const { container } = draw();
    await press(container);
    await settle();
    const [before, after] = EN['accountTokens.readAt']!.split('{when}');
    const said = (which: 'private' | 'public') => side(container, which).querySelector('[data-slot=section-description]')!.textContent!;
    expect(said('private')).toBe(`${before}2 minutes ago${after}`);
    expect(said('public')).toBe(`${before}1 minute ago${after}`);
  });
});

describe('the account\'s tokens, asked again', () => {
  /* RED WHEN: a refresh does not ask the wallet again, is not named like the first ask, or an answer is kept after the view is closed. */
  it('asks again on a refresh named the same way, and keeps nothing between views', async () => {
    const first = draw();
    await press(first.container);
    await settle();
    expect(first.container.querySelector('[data-wallet-window-named]')?.textContent).toContain(EN['accountTokens.opens']);
    expect(button(first.container).textContent).toBe(EN['accountTokens.refresh']);
    kr.next = answered(shown({ balances: [{ token: NIGHT, amount: '1000000', visibility: 'public' }] }));
    await press(first.container);
    await settle();
    expect(kr.asked).toHaveLength(2);
    expect(first.container.querySelector(`[data-token-row="${PRIVATE_TOKEN}"][data-token-side=private]`)).toBeNull();
    expect(first.container.querySelector(`[data-token-row="${NIGHT}"][data-token-side=public]`)!.textContent).toContain('1');
    first.unmount();

    const second = draw();
    await settle();
    expect(kr.asked).toHaveLength(2);
    expect(second.container.querySelector('[data-private-address]')).toBeNull();
    expect(second.container.querySelector('[data-token-row]')).toBeNull();
    expect(button(second.container).textContent).toBe(EN['accountTokens.ask']);
  });
});

describe('the account\'s tokens, when the wallet does not show them', () => {
  /* RED WHEN: a refusal the person made is not said in the words of that refusal, or another refusal is said as if something had been paid or sent. */
  it('says a refusal in words true of a read that pays nothing, and lets the person ask again', async () => {
    kr.next = Promise.resolve({ of: 'refused', why: ACT_REFUSAL.declined });
    const { container } = draw();
    await press(container);
    await settle();
    expect(container.querySelector(`[data-refusal=${ACT_REFUSAL.declined}]`)?.textContent).toContain(EN['act.refused.declined']);
    expect(container.querySelector('[data-token-row]')).toBeNull();

    kr.next = Promise.resolve({ of: 'refused', why: ACT_REFUSAL.expired });
    await press(container);
    await settle();
    const says = container.querySelector(`[data-refusal=${ACT_REFUSAL.expired}]`)!.textContent!;
    expect(says).toContain(EN['accountTokens.refused']);
    expect(says).not.toContain('A step before it');
    expect(button(container).disabled).toBe(false);
    expect(kr.asked).toHaveLength(2);
  });
});

describe('choosing a token', () => {
  /* RED WHEN: rows can be chosen when the caller did not ask for choosing, or a chosen row is not handed back with its side and token. */
  it('hands back the row chosen with its side, and offers no choosing unless asked', async () => {
    const plain = draw();
    await press(plain.container);
    await settle();
    expect(plain.container.querySelector('[data-token-choice]')).toBeNull();
    plain.unmount();

    const chosen: TokenChosen[] = [];
    const { container } = draw(<AccountTokens choose={(p) => chosen.push(p)} />);
    await press(container);
    await settle();
    const choices = container.querySelectorAll<HTMLElement>('[data-token-choice]');
    expect(choices).toHaveLength(2);
    expect(container.querySelector(`[aria-label="${EN['accountTokens.chooseRow.public']!.replace('{name}', 'Night')}"]`)).not.toBeNull();
    await act(async () => { fireEvent.click(container.querySelector(`[data-token-row="${NIGHT}"][data-token-side=public] [data-token-choice]`)!); });
    expect(chosen).toHaveLength(1);
    expect(chosen[0]).toMatchObject({ side: 'public', token: { visibility: 'public', code: NIGHT, held: 12_000_000n } });
  });
});

describe('a new answer replaces the last', () => {
  /* RED WHEN: a screen that chose a row is not told when a new answer drops the row, so it keeps a choice (and the amount held) the wallet no longer shows. */
  it('tells the screen each time a new answer arrives, which drops the row picked', async () => {
    const told = vi.fn();
    const { container } = draw(<AccountTokens choose={() => {}} onAnswered={told} />);
    await press(container);
    await settle();
    expect(told).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(container.querySelector(`[data-token-row="${PRIVATE_TOKEN}"] [data-token-choice]`)!); });
    kr.next = answered(shown({ balances: [{ token: PRIVATE_TOKEN, amount: '1', visibility: 'private' }] }));
    await press(container);
    await settle();
    expect(told).toHaveBeenCalledTimes(2);
    expect((container.querySelector(`[data-token-row="${PRIVATE_TOKEN}"] [data-token-choice]`) as HTMLElement).getAttribute('data-state')).toBe('unchecked');
  });
});

describe('the window that is named before it opens', () => {
  /* RED WHEN: a window is named without what it is for, or without the button to press in the wallet. */
  it('says what the window is for and what to press in the wallet', () => {
    const { container } = draw(<WalletWindowNamed what="Your wallet opens to pay." press="Pay" />);
    const [before, after] = EN['walletWindow.named']!.split('{what}');
    const text = container.querySelector('[data-wallet-window-named]')!.textContent!;
    expect(text.startsWith(before!)).toBe(true);
    expect(text).toContain('Your wallet opens to pay.');
    expect(text.endsWith(after!.replace('{press}', 'Pay'))).toBe(true);
  });
});

describe('one component in both places', () => {
  const SRC = resolve(HERE, '..');
  const shipping = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? shipping(p) : /\.tsx?$/.test(e.name) && !/\.test\.|\.test-support\./.test(e.name) ? [p] : [];
  });

  /* RED WHEN: a screen asks the wallet for the account's tokens itself, or shows them with a copy of this component, instead of using it; or the account menu loads the tokens with the first page instead of when Balances is pressed. */
  it('asks the wallet for the account\'s tokens in this component only, and the account menu shows this component', () => {
    const files = shipping(SRC).map((p) => ({ p: p.slice(SRC.length + 1), text: readFileSync(p, 'utf8') }));
    expect(files.filter((f) => /askForAccountBalances\s*\(/.test(f.text) && f.p !== 'adapters/account-balances.ts').map((f) => f.p)).toEqual(['actions/account-tokens.tsx']);
    const menu = files.find((f) => f.p === 'shell/account-menu.tsx')!;
    expect(menu.text).toMatch(/import\('\.\.\/actions\/account-tokens\.js'\)/);
    expect(menu.text).toMatch(/<AccountTokens\s*\/>/);
    expect(menu.text).not.toMatch(/from '\.\.\/actions\/account-tokens\.js'/);
  });
});
