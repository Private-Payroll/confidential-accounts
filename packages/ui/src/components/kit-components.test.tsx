// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KitProvider } from '../kit-provider.js';
import { languagesFrom } from '../i18n/languages.js';
import { privateAmount, publicAmount, type PrivateAmount, type PublicAmount } from '../format/token-amount.js';
import { Amount, AmountFigureOnly } from './amount.js';
import { AmountState, PrivatePill } from './public-pill.js';
import { formatTimeAgo } from '../format/intl.js';
import { Balance } from './balance.js';
import { ComingSoon } from './coming-soon.js';
import { ConfirmInYourAccount } from './confirm-in-your-account.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.js';

afterEach(cleanup);

/* The tooltip's arrow measures itself with ResizeObserver, which a browser has and this test's page does not. */
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

/* The application's own English file: the words below come from it, and from nothing in the kit. */
const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/web/src/locales/en.json'), 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN, './locales/de.json': {} });
const inKit = (ui: React.ReactNode, pick = 'en') => render(<KitProvider languages={LANGUAGES} pick={pick}>{ui}</KitProvider>);

describe('an amount', () => {
  /* RED WHEN: the figure loses a digit, is not written left to right, or a private amount carries the Public pill. */
  it('is exact, left to right, and private with no pill', () => {
    const { container } = inKit(<Amount value={privateAmount(12_345_678_901_234_567_890n, 6, 'tUSD')} kind="payment" />);
    const figure = container.querySelector('[data-slot=amount] > span[dir=ltr]');
    expect(figure?.textContent).toBe('12,345,678,901,234.56789 tUSD');
    expect(container.querySelector('[data-slot=public-pill]')).toBeNull();
  });

  /* RED WHEN: a public amount has no Public pill, the pill's words are not the English file's, its explanation cannot be opened by a tap, or a payment's pill says the balance wording. Nothing tells Amount it is public but the amount itself. */
  it('carries the Public pill when public, without being told, and explains it on a tap', async () => {
    const { container } = inKit(<Amount value={publicAmount(1n, 0, 'NIGHT')} kind="payment" />);
    expect(container.querySelector('[data-slot=amount]')?.getAttribute('data-visibility')).toBe('public');
    const pill = container.querySelector('[data-slot=public-pill]') as HTMLElement;
    expect(pill.textContent).toBe(EN['kit.public.label']);
    expect(screen.queryAllByText(EN['kit.public.explanation.payment']!)).toEqual([]);
    await act(async () => { fireEvent.click(pill); });
    expect(screen.queryAllByText(EN['kit.public.explanation.payment']!).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(EN['kit.public.explanation.balance']!)).toEqual([]);
  });

  /*
   * RED WHEN: a payment not made yet is explained as one made ("who received
   * it"), a payment made is explained as one to come, or a payment to come
   * uses the balance wording.
   */
  it('explains a payment not made yet as one to come, and only that one', async () => {
    expect(new Set([EN['kit.public.explanation.toBePaid'], EN['kit.public.explanation.payment'], EN['kit.public.explanation.balance']]).size).toBe(3);
    const { container } = inKit(<Amount value={publicAmount(1n, 0, 'NIGHT')} kind="to-be-paid" />);
    await act(async () => { fireEvent.click(container.querySelector('[data-slot=public-pill]')!); });
    expect(screen.queryAllByText(EN['kit.public.explanation.toBePaid']!).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(EN['kit.public.explanation.payment']!)).toEqual([]);
    expect(screen.queryAllByText(EN['kit.public.explanation.balance']!)).toEqual([]);
    cleanup();
    const made = inKit(<Amount value={publicAmount(1n, 0, 'NIGHT')} kind="payment" />);
    await act(async () => { fireEvent.click(made.container.querySelector('[data-slot=public-pill]')!); });
    expect(screen.queryAllByText(EN['kit.public.explanation.toBePaid']!)).toEqual([]);
  });

  /* RED WHEN: the language is not the one shown, so every language gets English grouping. */
  it('is written in the language shown', () => {
    const { container } = inKit(<Amount value={privateAmount(1_234_500n, 2, 'tUSD')} kind="payment" />, 'de');
    expect(container.querySelector('span[dir=ltr]')?.textContent).toBe('12.345 tUSD');
  });

  /* RED WHEN: a bare bigint or a number can be shown as an amount, an amount can be told its visibility, or an amount, private or public, can be shown without saying whether it is a payment or a balance. */
  it('cannot be shown unless it was made as an amount, and says whether it is a payment or a balance', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // @ts-expect-error an amount is made by publicAmount or privateAmount, never a bare bigint
    expect(() => inKit(<Amount value={1n} kind="payment" />)).toThrow(/made by publicAmount or privateAmount, and this is a value of type bigint/);
    // @ts-expect-error nor a number
    expect(() => inKit(<Amount value={1} kind="payment" />)).toThrow(/made by publicAmount or privateAmount, and this is a value of type number/);
    // @ts-expect-error whether an amount is public is read from it, and is never passed in
    inKit(<Amount value={privateAmount(1n, 0, 'tUSD')} visibility="public" kind="payment" />);
    // @ts-expect-error whether it is a payment or a balance is required, so the pill never guesses what public means
    expect(() => inKit(<Amount value={publicAmount(1n, 0, 'tUSD')} />)).toThrow(/a payment, a payment to be made or a balance, and this one is undefined/);
    // @ts-expect-error and on a private amount too
    expect(() => inKit(<Amount value={privateAmount(1n, 0, 'tUSD')} />)).toThrow(/a payment, a payment to be made or a balance, and this one is undefined/);
    vi.restoreAllMocks();
  });

  /*
   * RED WHEN: an amount or a balance takes a class from a screen, which a
   * screen could use to hide the Public pill inside it. Each line is an error
   * the typecheck must report.
   */
  it('takes no class from a screen', () => {
    // @ts-expect-error an amount takes no class
    inKit(<Amount value={privateAmount(1n, 0, 'tUSD')} kind="payment" className="x" />);
    // @ts-expect-error nor does a balance
    inKit(<Balance private={privateAmount(1n, 0, 'tUSD')} public={publicAmount(1n, 0, 'tUSD')} className="x" />);
  });

  /* RED WHEN: a value told it is public, or dressed as one, is shown as public: the pill is written only for an amount made public. */
  it('is public only when made public', () => {
    const { container } = inKit(<Amount value={privateAmount(1n, 0, 'tUSD')} {...{ visibility: 'public' }} kind="payment" />);
    expect(container.querySelector('[data-slot=public-pill]')).toBeNull();
    expect(container.querySelector('[data-slot=amount]')?.getAttribute('data-visibility')).toBe('private');
  });
});

describe('an amount anywhere but in Amount', () => {
  /*
   * RED WHEN: an amount written straight into a screen, as a child, an
   * attribute or text, reaches the page as its digits. React refuses an object
   * as a child, and every other way of making text of one throws, so the page
   * stops instead of showing a figure with no decimals and no Public pill.
   */
  it('cannot reach the page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const amount = privateAmount(12_345_678_901_234_567_890n, 6, 'tUSD');
    // @ts-expect-error an amount is not something React can show
    expect(() => inKit(<span>{amount}</span>)).toThrow(/Objects are not valid as a React child/);
    // @ts-expect-error nor inside a list of children
    expect(() => inKit(<p>{[amount]}</p>)).toThrow(/Objects are not valid as a React child/);
    // @ts-expect-error nor as the value of an attribute
    expect(() => inKit(<span title={amount} />)).toThrow(/shown only by Amount/);
    expect(() => inKit(<span>{`${amount as unknown as string}`}</span>)).toThrow(/shown only by Amount/);
    expect(document.body.textContent).not.toContain('12345678901234567890');
    vi.restoreAllMocks();
  });
});

describe('an amount in a table that says its asset and state in columns of their own', () => {
  /* RED WHEN: the figure alone loses a digit, repeats the token's symbol, carries a pill, or is not written left to right. */
  it('writes the figure alone, exact, with no symbol and no pill', () => {
    const { container } = inKit(<AmountFigureOnly value={publicAmount(120_123_100n, 5, 'NIGHT')} />);
    const figure = container.querySelector('[data-slot=amount-figure]')!;
    expect(figure.textContent).toBe('1,201.231');
    expect(figure.getAttribute('dir')).toBe('ltr');
    expect(figure.getAttribute('data-visibility')).toBe('public');
    expect(container.querySelector('[data-slot=public-pill]')).toBeNull();
  });

  /* RED WHEN: the state is not read from the amount itself: a public amount without the Public pill and its explanation, or a private one without the Private pill. */
  it('says private or public from the amount, with the Public pill\'s explanation', async () => {
    const pub = inKit(<AmountState value={publicAmount(1n, 0, 'NIGHT')} kind="balance" />);
    expect(pub.container.querySelector('[data-slot=public-pill]')?.textContent).toBe(EN['kit.public.label']);
    await act(async () => { fireEvent.click(pub.container.querySelector('[data-slot=public-pill]')!); });
    expect(document.body.textContent).toContain(EN['kit.public.explanation.balance']);
    expect(document.body.textContent).not.toContain(EN['kit.public.explanation.payment']);
    expect(pub.container.querySelector('[data-slot=private-pill]')).toBeNull();
    cleanup();
    const priv = inKit(<AmountState value={privateAmount(1n, 0, 'NIGHT')} kind="balance" />);
    expect(priv.container.querySelector('[data-slot=private-pill]')?.textContent).toBe(EN['kit.balance.private']);
    expect(priv.container.querySelector('[data-slot=public-pill]')).toBeNull();
    cleanup();
    expect(inKit(<PrivatePill />).container.textContent).toBe(EN['kit.balance.private']);
  });
});

describe('how long ago', () => {
  /* RED WHEN: a time ago is said in the wrong unit, rounded up, as a time to come, or not in the language shown. */
  it('says seconds, minutes, hours and days ago, in the language shown', () => {
    const at = new Date('2026-09-29T10:00:00.000Z');
    const later = (ms: number) => new Date(at.getTime() + ms);
    expect(formatTimeAgo(at, at, 'en')).toBe('now');
    expect(formatTimeAgo(at, later(45_000), 'en')).toBe('45 seconds ago');
    expect(formatTimeAgo(at, later(6 * 60_000 + 59_000), 'en')).toBe('6 minutes ago');
    expect(formatTimeAgo(at, later(3 * 3_600_000), 'en')).toBe('3 hours ago');
    expect(formatTimeAgo(at, later(2 * 86_400_000), 'en')).toBe('2 days ago');
    expect(formatTimeAgo(at, later(-5_000), 'en')).toBe('now');
    expect(formatTimeAgo(at, later(6 * 60_000), 'de')).toBe('vor 6 Minuten');
  });
});

describe('a balance', () => {
  /*
   * RED WHEN: the two are added into one figure, the public line has no pill,
   * the private line has one, or "Public" is written on the public line twice:
   * once as a label and once as the pill.
   */
  it('shows private and public on two lines, never a total, and says Public once', () => {
    const { container } = inKit(<Balance private={privateAmount(150n, 2, 'tUSD')} public={publicAmount(25n, 2, 'tUSD')} />);
    const lines = [...container.querySelectorAll('dd')];
    expect(lines.map((d) => [d.querySelector('[data-visibility]')?.getAttribute('data-visibility') ?? d.getAttribute('data-visibility'), d.querySelector('span[dir=ltr]')?.textContent])).toEqual([['private', '1.5 tUSD'], ['public', '0.25 tUSD']]);
    expect(container.textContent).not.toContain('1.75');
    const labels = [...container.querySelectorAll('dt')];
    expect(labels[0]?.textContent).toBe(EN['kit.balance.private']);
    expect(labels.map((d) => d.querySelector('[data-slot=public-pill]') !== null)).toEqual([false, true]);
    expect(container.querySelectorAll('[data-slot=public-pill]').length).toBe(1);
    expect(container.textContent!.split(EN['kit.public.label']!).length - 1).toBe(1);
  });

  /*
   * RED WHEN: the public line of a balance explains itself as a payment. A
   * balance's public amount says anyone can see the account it is in; a
   * payment's, who received it.
   */
  it('explains its public line as a balance, not as a payment', async () => {
    const { container } = inKit(<Balance private={privateAmount(1n, 0, 'tUSD')} public={publicAmount(2n, 0, 'tUSD')} />);
    await act(async () => { fireEvent.click(container.querySelector('[data-slot=public-pill]') as HTMLElement); });
    expect(EN['kit.public.explanation.balance']).not.toBe(EN['kit.public.explanation.payment']);
    expect(screen.queryAllByText(EN['kit.public.explanation.balance']!).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(EN['kit.public.explanation.payment']!)).toEqual([]);
  });

  /*
   * RED WHEN: a public amount can be put on the private side or a private one
   * on the public side, when typechecked or, through a cast, when shown; or
   * the balance grows a prop for a total.
   */
  it('takes a private amount on its private side and a public one on its public side, and no total', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const held: PrivateAmount = privateAmount(1n, 0, 'tUSD');
    const shown: PublicAmount = publicAmount(2n, 0, 'tUSD');
    // @ts-expect-error the two sides swapped do not typecheck
    expect(() => inKit(<Balance private={shown} public={held} />)).toThrow(/private amount on its private side and a public amount on its public side/);
    expect(() => inKit(<Balance private={held} public={held as unknown as PublicAmount} />)).toThrow(/public amount on its public side/);
    expect(() => inKit(<Balance private={shown as unknown as PrivateAmount} public={shown} />)).toThrow(/private amount on its private side/);
    // @ts-expect-error there is no total
    inKit(<Balance private={held} public={shown} total={shown} />);
    vi.restoreAllMocks();
  });
});

describe('the Coming soon pill', () => {
  const explanation = 'An explanation given by the screen.';

  /* RED WHEN: the pill's words are not the English file's, it is not the theme's muted colour, or its explanation does not open on click and on hover. */
  it('reads Coming soon, in the muted colour, and explains itself on click or hover', async () => {
    inKit(<ComingSoon explanation={explanation} />);
    const pill = screen.getByRole('button', { name: EN['kit.comingSoon.label'] });
    expect(pill.className).toMatch(/\bbg-muted\b/);
    expect(pill.className).toMatch(/\btext-muted-foreground\b/);
    expect(screen.queryByText(explanation)).toBeNull();
    await act(async () => { fireEvent.click(pill); });
    expect(screen.getByText(explanation)).toBeTruthy();
    await act(async () => { fireEvent.click(pill); });
    expect(screen.queryByText(explanation)).toBeNull();
    await act(async () => { fireEvent.mouseEnter(pill); });
    expect(screen.getByText(explanation)).toBeTruthy();
  });
});

describe('the confirm step', () => {
  /* RED WHEN: its words are not the English file's, what is confirmed is not shown or not required, an answer is not reported, or it can be answered while busy. */
  it('asks, reports the answer, and waits while busy', () => {
    const onConfirm = vi.fn(); const onCancel = vi.fn();
    const summary = 'What the screen says is being confirmed.';
    // @ts-expect-error what is being confirmed is required, so no approval is asked for with nothing said about it
    void <ConfirmInYourAccount onConfirm={onConfirm} onCancel={onCancel} />;
    const { rerender } = inKit(<ConfirmInYourAccount summary={summary} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByRole('heading').textContent).toBe(EN['kit.confirm.title']);
    expect(screen.getByText(summary)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: EN['kit.confirm.confirm'] }));
    fireEvent.click(screen.getByRole('button', { name: EN['kit.confirm.cancel'] }));
    expect([onConfirm.mock.calls.length, onCancel.mock.calls.length]).toEqual([1, 1]);
    rerender(<KitProvider languages={LANGUAGES} pick="en"><ConfirmInYourAccount summary={summary} onConfirm={onConfirm} onCancel={onCancel} busy /></KitProvider>);
    for (const b of screen.getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the tabs across the top of a page', () => {
  /*
   * RED WHEN: the tabs are not a tab list the browser reads as one, the tab
   * shown is not marked, pressing a tab or an arrow key does not move to it,
   * or only the shown tab's panel is on the page.
   */
  it('are one tab list, mark the tab shown, and move by press and by arrow key', async () => {
    const { container } = inKit(
      <Tabs defaultValue="a">
        <TabsList><TabsTrigger value="a">A</TabsTrigger><TabsTrigger value="b">B</TabsTrigger></TabsList>
        <TabsContent value="a">first</TabsContent><TabsContent value="b">second</TabsContent>
      </Tabs>,
    );
    const list = container.querySelector('[data-slot=tabs-list]') as HTMLElement;
    expect(list.getAttribute('role')).toBe('tablist');
    const [a, b] = [...list.querySelectorAll('[data-slot=tabs-trigger]')] as HTMLElement[];
    expect([a!.getAttribute('aria-selected'), b!.getAttribute('aria-selected')]).toEqual(['true', 'false']);
    expect(container.textContent).toContain('first');
    expect(container.textContent).not.toContain('second');
    await act(async () => { fireEvent.mouseDown(b!, { button: 0 }); });
    expect(b!.getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).toContain('second');
    b!.focus();
    await act(async () => { fireEvent.keyDown(b!, { key: 'ArrowLeft' }); await new Promise((r) => setTimeout(r, 0)); });
    expect(document.activeElement).toBe(a);
  });
});
