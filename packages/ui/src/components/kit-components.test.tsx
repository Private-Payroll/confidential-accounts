// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KitProvider } from '../kit-provider.js';
import { languagesFrom } from '../i18n/languages.js';
import { Amount } from './amount.js';
import { Balance } from './balance.js';
import { ComingSoon } from './coming-soon.js';
import { ConfirmInYourAccount } from './confirm-in-your-account.js';

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
    const { container } = inKit(<Amount value={12_345_678_901_234_567_890n} decimals={6} code="USDC" visibility="private" />);
    const figure = container.querySelector('[data-slot=amount] > span[dir=ltr]');
    expect(figure?.textContent).toBe('12,345,678,901,234.567890 USDC');
    expect(container.querySelector('[data-slot=public-pill]')).toBeNull();
  });

  /* RED WHEN: a public amount has no Public pill, the pill's words are not the English file's, or its explanation cannot be opened by a tap. */
  it('carries the Public pill when public, and explains it on a tap', async () => {
    const { container } = inKit(<Amount value={1n} decimals={0} code="NIGHT" visibility="public" />);
    const pill = container.querySelector('[data-slot=public-pill]') as HTMLElement;
    expect(pill.textContent).toBe(EN['kit.public.label']);
    expect(screen.queryAllByText(EN['kit.public.explanation']!)).toEqual([]);
    await act(async () => { fireEvent.click(pill); });
    expect(screen.queryAllByText(EN['kit.public.explanation']!).length).toBeGreaterThan(0);
  });

  /* RED WHEN: the language is not the one shown, so every language gets English grouping. */
  it('is written in the language shown', () => {
    const { container } = inKit(<Amount value={1_234_500n} decimals={2} code="EUR" visibility="private" />, 'de');
    expect(container.querySelector('span[dir=ltr]')?.textContent).toBe('12.345,00 EUR');
  });

  /* RED WHEN: an amount with no visibility, or another word for it, can be shown. */
  it('cannot be shown without saying private or public', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // @ts-expect-error visibility is required, with no default
    expect(() => inKit(<Amount value={1n} decimals={0} code="USDC" />)).toThrow(/private or public, and this one is undefined/);
    // @ts-expect-error visibility is private or public
    expect(() => inKit(<Amount value={1n} decimals={0} code="USDC" visibility="hidden" />)).toThrow(/this one is hidden/);
    // @ts-expect-error an amount is a bigint, never a number
    expect(() => inKit(<Amount value={1} decimals={0} code="USDC" visibility="private" />)).toThrow(/bigint/);
    vi.restoreAllMocks();
  });
});

describe('a balance', () => {
  /* RED WHEN: the two are added into one figure, the public line has no pill, or the private line has one. */
  it('shows private and public on two lines and never a total', () => {
    const { container } = inKit(<Balance private={{ value: 150n, decimals: 2, code: 'USDC' }} public={{ value: 25n, decimals: 2, code: 'USDC' }} />);
    const amounts = [...container.querySelectorAll('[data-slot=amount]')];
    expect(amounts.map((a) => [a.getAttribute('data-visibility'), a.querySelector('span[dir=ltr]')?.textContent])).toEqual([['private', '1.50 USDC'], ['public', '0.25 USDC']]);
    expect(container.textContent).not.toContain('1.75');
    expect([...container.querySelectorAll('dt')].map((d) => d.textContent)).toEqual([EN['kit.balance.private'], EN['kit.balance.public']]);
    expect(amounts.map((a) => a.querySelector('[data-slot=public-pill]') !== null)).toEqual([false, true]);
  });

  /* RED WHEN: the balance grows a prop for a total. */
  it('has no prop for a total', () => {
    const h = { value: 1n, decimals: 0, code: 'USDC' };
    // @ts-expect-error there is no total
    inKit(<Balance private={h} public={h} total={h} />);
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
