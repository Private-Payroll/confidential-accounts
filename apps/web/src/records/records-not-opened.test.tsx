// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { ENGLISH } from '../english.test-support.js';
import { VIEWS } from '../pages.js';
import { SessionProvider } from '../session.js';
import { DEFAULT_PREFERENCES } from '../preferences.js';

/*
 * A COMPANY THE WALLET HAS NOT OPENED ON THIS VISIT, ON THE COMPANY'S PAGES. A page load never asks the wallet; what is sealed
 * under a key it has not released says it is not opened yet, with the one press that asks the wallet, after which the
 * records are read again.
 */
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const state = vi.hoisted(() => ({
  /* What the records read answers before the wallet is asked, and after. */
  before: null as unknown, after: null as unknown, asked: [] as Array<string | null>, reads: 0, pressed: false, pagesOpen: [] as string[], press: { of: 'done' } as unknown,
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => { state.reads += 1; return state.pressed ? state.after : state.before; },
  openWithYourAccount: async (_person: string, company: string | null = state.pagesOpen.at(-1) ?? null) => { state.asked.push(company); state.pressed = true; return state.press; },
  companyPagesOpen: (id: string) => { state.pagesOpen.push(id); return () => { state.pagesOpen.splice(state.pagesOpen.lastIndexOf(id), 1); }; },
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  companyNamesFor: async () => Object.assign(new Map<string, string>(), { whyNot: new Map<string, string>() }),
}));

const { WithRecords } = await import('./parts.js');
const { CompanyRecordsProvider } = await import('./company-records.js');
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const open = (over: Record<string, unknown> = {}) => ({ of: 'open', id: 'c-1', name: 'Northwind', signers: [], ...over });

function draw() {
  const session = {
    person: { id: 'u1', name: 'Priya' }, companies: [{ id: 'c-1', createdAt: '2026-09-01T00:00:00.000Z', signers: 1 }], company: 'c-1',
    chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
    choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
  };
  return render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session as never}>
        <CompanyRecordsProvider><WithRecords>{(c) => <p data-shown>{c.name}</p>}</WithRecords></CompanyRecordsProvider>
      </SessionProvider>
    </KitProvider>,
  ).container;
}
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
const q = (c: ParentNode, sel: string) => c.querySelector(sel) as HTMLElement | null;

beforeEach(() => { state.asked = []; state.reads = 0; state.pressed = false; state.press = { of: 'done' }; });
afterEach(() => { cleanup(); });

describe('a company not opened yet', () => {
  /* RED WHEN: a company whose key the wallet has not released is shown with no way to open it, or the press does not ask the wallet once for that company and read again. */
  it('says it is not opened yet with the one press, which asks the wallet once for this company and then reads the records again', async () => {
    state.before = { of: 'refused', why: 'not-opened-yet' };
    state.after = open();
    const c = draw();
    await settle();
    expect(q(c, '[data-records=not-opened-yet]')?.textContent).toContain(EN['records.notOpened.says']);
    expect(q(c, '[data-action=open-with-your-wallet]')?.textContent).toBe('Open with your wallet');
    expect(q(c, '[data-shown]')).toBeNull();
    expect(state.reads).toBe(1);
    await act(async () => { fireEvent.click(q(c, '[data-action=open-with-your-wallet]')!); await new Promise((r) => setTimeout(r, 20)); });
    expect(state.asked).toEqual(['c-1']);
    expect(state.reads).toBe(2);
    expect(q(c, '[data-shown]')?.textContent).toBe('Northwind');
    expect(q(c, '[data-records=not-opened-yet]')).toBeNull();
  });

  /* RED WHEN: a company that opens with a copy of its key left unopened shows its records with no word of it, or no way to open the rest. */
  it('shows an open company\'s records with a notice and the same press when part of its key is not opened', async () => {
    state.before = open({ notOpened: [1] });
    state.after = open({ notOpened: [] });
    const c = draw();
    await settle();
    expect(q(c, '[data-records-notice=not-opened-yet]')?.textContent).toContain(EN['records.notOpened.some']);
    expect(q(c, '[data-shown]')?.textContent).toBe('Northwind');
    await act(async () => { fireEvent.click(q(c, '[data-action=open-with-your-wallet]')!); await new Promise((r) => setTimeout(r, 20)); });
    expect(state.asked).toEqual(['c-1']);
    expect(q(c, '[data-records-notice]')).toBeNull();
    expect(q(c, '[data-shown]')?.textContent).toBe('Northwind');
  });

  /* RED WHEN: a company with nothing left unopened shows the notice, or the press is offered on records that opened whole. */
  it('shows no notice and no press on a company that opened whole', async () => {
    state.before = open({ notOpened: [] });
    const c = draw();
    await settle();
    expect(q(c, '[data-records-notice]')).toBeNull();
    expect(q(c, '[data-action=open-with-your-wallet]')).toBeNull();
    expect(q(c, '[data-shown]')?.textContent).toBe('Northwind');
  });

  /* RED WHEN: the wallet turning the press down leaves the person with no word of why, or the page stops offering the press. */
  it('says why when the wallet does not open it, and keeps offering the press', async () => {
    state.before = { of: 'refused', why: 'not-opened-yet' };
    state.after = { of: 'refused', why: 'not-opened-yet' };
    state.press = { of: 'refused', why: 'declined' };
    const c = draw();
    await settle();
    await act(async () => { fireEvent.click(q(c, '[data-action=open-with-your-wallet]')!); await new Promise((r) => setTimeout(r, 20)); });
    expect(state.asked).toEqual(['c-1']);
    expect(q(c, '[data-action=open-with-your-wallet]')).not.toBeNull();
  });
});
