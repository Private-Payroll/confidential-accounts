// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { untilPageShown, untilShown } from '../page-shown.test-support.js';
import { PAGES } from '../pages.js';
import { Root } from '../root.js';
import { ENGLISH } from '../english.test-support.js';

/*
 * THE LANDING PAGE'S COMPANIES WHEN A PAGE LOAD COULD NOT OPEN ONE: the company whose key the wallet has not released on this
 * visit says so in its row and is offered the one press that asks the wallet, beside the row and never inside it.
 */
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const state = vi.hoisted(() => ({
  whyNot: new Map<string, string>(), names: new Map<string, string>(), asked: [] as Array<[string, string | null | undefined]>, listed: 0, refusal: null as string | null,
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  whoIsSignedIn: async () => ({ of: 'signed-in', person: { id: 'u1', name: 'Priya' }, companies: [
    { id: 'c-1', createdAt: '2026-09-01T12:00:00.000Z', signers: 2 }, { id: 'c-2', createdAt: '2026-09-02T12:00:00.000Z', signers: 1 },
  ] }),
  approvalsNeededFor: async () => new Map(),
  companyNamesFor: async () => {
    state.listed += 1;
    return Object.assign(new Map(state.names), { whyNot: new Map(state.whyNot) });
  },
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  openWithYourAccount: async (person: string, company?: string | null) => {
    state.asked.push([person, company]);
    if (state.refusal !== null) return { of: 'refused', why: state.refusal };
    state.whyNot.delete('c-1'); state.names.set('c-1', 'Northwind');
    return { of: 'done' };
  },
}));
vi.mock('../adapters/creation-standing.js', async (real) => ({
  ...(await real<typeof import('../adapters/creation-standing.js')>()),
  creationOf: async (id: string | null) => ({ company: id, standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null }),
}));
const EN = ENGLISH;

beforeEach(() => {
  state.whyNot.clear(); state.names.clear(); state.asked = []; state.listed = 0; state.refusal = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function landing() {
  window.history.replaceState(null, '', PAGES.landing.path);
  const view = render(<Root />);
  await untilPageShown(view.container);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return view.container;
}
const q = (c: ParentNode, sel: string) => c.querySelector(sel) as HTMLElement | null;

describe('a company a page load could not open, on the landing page', () => {
  /* RED WHEN: a company the wallet has not opened is listed with no word of it, or another company is offered the press, or the press sits inside the row's own button. */
  it('says "Not opened yet" in the row and offers the press beside it, for that company only', async () => {
    state.whyNot.set('c-1', 'not-opened-yet');
    const c = await landing();
    expect(q(c, '[data-company=c-1] [data-unnamed-why]')?.textContent).toBe(EN['company.notOpenedYet']);
    const press = q(c, '[data-action=open-with-your-wallet]')!;
    expect(press.textContent).toBe('Open with your wallet');
    expect(press.dataset.companyFor).toBe('c-1');
    expect(press.getAttribute('aria-label')).toMatch(/^Open .+ with your wallet$/u);
    /* RED WHEN: the press is nested in the company's button, which is invalid markup and opens the company when pressed. */
    expect(press.closest('[data-company]')).toBeNull();
    expect(press.parentElement).toBe(q(c, '[data-company=c-1]')!.parentElement);
    expect(c.querySelectorAll('[data-action=open-with-your-wallet]').length).toBe(1);
    expect(q(c, '[data-company=c-2] [data-unnamed-why]')?.textContent).not.toBe(EN['company.notOpenedYet']);
  });

  /* RED WHEN: the press asks the wallet for another company or more than once, or the list is not read again, so the row still says it is not opened. */
  it('asks the wallet once for that company, then reads the names again with its key released', async () => {
    state.whyNot.set('c-1', 'not-opened-yet');
    const c = await landing();
    const reads = state.listed;
    /* The adapter loads on demand, the first time the press needs it. */
    await act(async () => { fireEvent.click(q(c, '[data-action=open-with-your-wallet]')!); });
    await untilShown(() => q(c, '[data-company=c-1] [data-company-name]'), 'the company\'s name, once its key is released');
    expect(state.asked).toEqual([['u1', 'c-1']]);
    expect(state.listed).toBe(reads + 1);
    expect(q(c, '[data-action=open-with-your-wallet]')).toBeNull();
    expect(q(c, '[data-company=c-1] [data-company-name]')?.textContent).toBe('Northwind');
    expect(window.location.pathname).toBe(PAGES.landing.path);
  });

  /* RED WHEN: the wallet's refusal of the press is dropped, so the person who declined or whose wallet did not answer sees nothing happen and the row still says it is not opened. */
  it('tells why the press did not open the company, under that company\'s press, and keeps the press', async () => {
    state.whyNot.set('c-1', 'not-opened-yet');
    state.refusal = 'declined';
    const c = await landing();
    await act(async () => { fireEvent.click(q(c, '[data-action=open-with-your-wallet]')!); });
    await untilShown(() => q(c, '[data-company-for=c-1] ~ [role=alert], [data-refused-for=c-1]'), 'the refusal under the press');
    expect(q(c, '[data-refused-for=c-1]')?.textContent).toContain(EN['act.refused.declined']);
    expect(q(c, '[data-action=open-with-your-wallet]')).not.toBeNull();
    expect(q(c, '[data-company=c-1] [data-unnamed-why]')?.textContent).toBe(EN['company.notOpenedYet']);
  });

  /* RED WHEN: a list in which every company opened shows the press. */
  it('offers no press when every company opened', async () => {
    const c = await landing();
    expect(q(c, '[data-action=open-with-your-wallet]')).toBeNull();
  });
});
