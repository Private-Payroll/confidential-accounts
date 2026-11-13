// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { VIEWS } from '../pages.js';
import { ENGLISH } from '../english.test-support.js';
import { untilPageShown } from '../page-shown.test-support.js';

/*
 * THE READER'S TWO PAGES, DRAWN over the real words and parts, with only what the reader's wallet and the company's records answer
 * stood in for: what a reader who opens payroll is shown, what an access that does not include payroll says, what a check of the
 * access does when it finds the access gone (the rows are cleared, the app is told, and the sign-up page says why), and what the
 * sign-up page asks of the wallet.
 */
const st = vi.hoisted(() => ({
  opened: null as unknown, checked: null as unknown, asked: null as unknown, code: null as unknown,
  reads: 0, checks: 0, codes: [] as unknown[][], went: [] as unknown[][], readerOpened: 0,
}));
vi.mock('../adapters/reader-open.js', async (real) => ({
  ...(await real<typeof import('../adapters/reader-open.js')>()),
  readOpened: async () => { st.reads += 1; return st.opened; },
  openAsReader: async () => { st.checks += 1; return st.checked; },
  askForReaderKeys: async () => st.asked,
}));
vi.mock('../adapters/reader-join-code.js', () => ({
  readerCodeFromTheWallet: async (...a: unknown[]) => { st.codes.push(a); return st.code; },
}));
vi.mock('../router.js', async (real) => ({
  ...(await real<typeof import('../router.js')>()),
  go: (...a: unknown[]) => { st.went.push(a); },
}));

const { Reader, ReaderSignUp } = await import('./reader.js');
const { SessionProvider } = await import('../session.js');
const { CurrentPageProvider } = await import('../router.js');
const { VisitorProvider } = await import('../visitor.js');
const { rememberWhyNotOpen } = await import('../adapters/reader-open.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const LABEL = `co_${'c1'.repeat(32)}`;
const PARAMS = { id: 'c-9', label: LABEL, account: 'c0'.repeat(32) };
const session = () => ({
  person: { id: 'u1', name: 'Rhea' }, companies: [], company: null, chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.employee, signs: false, reads: ['c-9'] },
  chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
  readerOpened: () => { st.readerOpened += 1; },
});
const run = (id: string, period: string) => ({ id, period, payees: [{ id: 'e1', name: 'Ana', amount: null, paid: 'privately' }], currencies: [], legs: [], unrecognised: 0 });
const proposal = { id: 'p1', kind: 'payroll', status: 'open', raisedBy: 'Sam', raiserNotBelieved: null, approvals: 0, needed: 1, raisedAt: '2026-09-21T00:00:00.000Z', pays: null };
const open = (over: Record<string, unknown> = {}) => ({
  of: 'open', company: { of: 'open', id: 'c-9', label: LABEL, runs: { of: 'read', value: { rows: [run('r1', '2026-10'), run('r0', '2026-09')], unreadable: [] } }, proposals: { of: 'read', value: [proposal] }, ...over },
});
const turn = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => { await act(async () => { await turn(); await turn(); }); };
const q = (s: string): HTMLElement | null => document.body.querySelector(s);
const press = async (selector: string) => { fireEvent.click(q(selector)!); await settle(); };
const text = (): string => document.body.textContent ?? '';
const drawReader = async (params: Record<string, string> = PARAMS) => {
  const view = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session()}><CurrentPageProvider id="reader" params={params}><Reader /></CurrentPageProvider></SessionProvider>
    </KitProvider>,
  );
  await untilPageShown(view.container);
  await settle();
};
const drawSignUp = async (visitor = false, params: Record<string, string> = PARAMS) => {
  const page = <CurrentPageProvider id="readerSignUp" params={params}><ReaderSignUp /></CurrentPageProvider>;
  const view = render(
    <KitProvider languages={LANGUAGES} pick="en">
      {visitor ? <VisitorProvider signedInNow={async () => {}}>{page}</VisitorProvider> : <SessionProvider session={session()}>{page}</SessionProvider>}
    </KitProvider>,
  );
  await untilPageShown(view.container);
  await settle();
};

beforeEach(() => {
  st.opened = open(); st.checked = open(); st.asked = { of: 'held' }; st.code = { of: 'done', text: 'mnjoin1.abc' };
  st.reads = 0; st.checks = 0; st.codes = []; st.went = []; st.readerOpened = 0;
});
afterEach(() => { cleanup(); });

describe('a reader who opens payroll', () => {
  /* RED WHEN: an accountant's runs and proposals, read with the keys the wallet gave, are not shown, or the company is named by anything but the end of its label. */
  it('is shown the payroll runs and the proposals its access reads, the company named by the end of its label', async () => {
    await drawReader();
    expect([...document.body.querySelectorAll('[data-run]')].map((r) => r.getAttribute('data-run'))).toEqual(['r1', 'r0']);
    expect(q('[data-proposal="p1"]')).not.toBeNull();
    expect(text()).toContain(EN['reader.company']!.replace('{end}', LABEL.slice(-6)));
    expect(q('[data-reader-as-of]')!.textContent).toBe(EN['reader.asof']);
    expect(st.checks).toBe(0);
  });

  /* RED WHEN: a limited reader, whose access names no payroll, is shown a broken payroll list instead of being told payroll is not in its access. */
  it('is told payroll is not in its access when its access names no payroll, and still sees the proposals', async () => {
    st.opened = open({ runs: { of: 'not-in-access' } });
    await drawReader();
    expect(q('[data-reader-runs]')!.textContent).toContain(EN['reader.runs.notInAccess']);
    expect(q('[data-run]')).toBeNull();
    expect(q('[data-proposal="p1"]')).not.toBeNull();
  });

  /* RED WHEN: a run the reader's keys do not open is dropped without a word, or makes the runs that do open disappear. */
  it('is told how many runs its keys did not open, beside the ones they did', async () => {
    st.opened = open({ runs: { of: 'read', value: { rows: [run('r0', '2026-09')], unreadable: [{ id: 'r2', period: '2026-11' }] } } });
    await drawReader();
    expect(q('[data-run="r0"]')).not.toBeNull();
    expect(q('[data-runs-not-opened="1"]')!.textContent).toContain(EN['reader.runs.someNotOpened_one']!.replace('{count}', '1'));
  });
});

describe('a reader whose access is taken away', () => {
  /* RED WHEN: a check that finds the access gone leaves the rows on the page, does not tell the app, or does not go back to the page that says why. */
  it('has the rows cleared, the app told and the sign-up page opened, which says why', async () => {
    await drawReader();
    expect(q('[data-run]')).not.toBeNull();
    st.checked = { of: 'closed', why: 'taken-away' };
    await press('[data-action="check-access"]');
    expect(st.checks).toBe(1);
    expect(q('[data-run]')).toBeNull();
    expect(q('[data-proposal]')).toBeNull();
    expect(st.readerOpened).toBe(1);
    expect(st.went).toEqual([['readerSignUp', true, PARAMS]]);
    cleanup();
    await drawSignUp();
    expect(q('[data-reader-closed="taken-away"]')!.textContent).toContain(EN['reader.why.taken-away']);
    /* RED WHEN: a reader taken away is not told that a signer giving read access again clears it. */
    expect(EN['reader.why.taken-away']).toMatch(/To get access again, ask a signer to give it from their wallet/u);
    /* RED WHEN: the reason is kept for a second visit to the page instead of being told once. */
    cleanup();
    await drawSignUp();
    expect(q('[data-reader-closed]')).toBeNull();
  });

  /* RED WHEN: a reader who opens the page with no keys held is shown anything, or is left on a page that cannot read. */
  it('is sent to the sign-up page when this visit holds no keys for the company', async () => {
    st.opened = { of: 'closed', why: 'no-keys' };
    await drawReader();
    expect(q('[data-run]')).toBeNull();
    expect(st.went).toEqual([['readerSignUp', true, PARAMS]]);
    expect(st.readerOpened).toBe(1);
  });

  /* RED WHEN: a wallet that could not be asked (a window closed) is taken for an access taken away, so the rows are cleared and the reader sent away. */
  it('keeps what is shown, and says why, when the wallet could not be asked', async () => {
    await drawReader();
    st.checked = { of: 'refused', why: 'declined' };
    await press('[data-action="check-access"]');
    expect(q('[data-run]')).not.toBeNull();
    expect(q('[data-refusal="declined"]')).not.toBeNull();
    expect(st.went).toEqual([]);
    expect(st.readerOpened).toBe(0);
  });
});

describe('the reader\'s sign-up page', () => {
  /* RED WHEN: an address that is not a reader's link opens a page that asks the wallet for something, or does not say to ask a signer for the link. */
  it('says to ask a signer for the reader link when the address names no company', async () => {
    await drawSignUp(false, { id: 'c-9', label: 'x1', account: 'x1' });
    expect(q('[data-reader-no-link]')!.textContent).toBe(EN['reader.noLink']);
    expect(q('[data-action="make-code"]')).toBeNull();
  });

  /* RED WHEN: a visitor is offered the code or the company before signing in, or no way to sign in. */
  it('offers a visitor the sign-in and nothing the wallet would make before it', async () => {
    await drawSignUp(true);
    expect(q('[data-reader-sign-in] [data-action="sign-in"]')).not.toBeNull();
    expect(q('[data-action="make-code"]')).toBeNull();
    expect(q('[data-action="open-company"]')).toBeNull();
  });

  /* RED WHEN: the reader's code is asked for another company or person than the link and the sign-in name, or its text is not shown, or a refusal is not told. */
  it('asks the wallet for the reader code of the company the link names and shows its text', async () => {
    await drawSignUp();
    await press('[data-action="make-code"]');
    expect(st.codes).toEqual([['u1', { id: 'c-9', label: LABEL, account: 'c0'.repeat(32) }, EN['app.title']]]);
    expect((q('[data-field="reader-code-text"]') as HTMLTextAreaElement).value).toBe('mnjoin1.abc');
    st.code = { of: 'refused', why: 'declined' };
    await press('[data-action="make-code"]');
    expect(q('[data-field="reader-code-text"]')).toBeNull();
    expect(q('[data-refusal="declined"]')).not.toBeNull();
  });

  /* RED WHEN: keys the wallet gave do not take the reader to its page and tell the app, or a wallet that gave none still does. */
  it('opens the reader\'s page once the wallet gave keys, and says why when it gave none', async () => {
    await drawSignUp();
    st.asked = { of: 'closed', why: 'not-a-reader-here' };
    await press('[data-action="open-company"]');
    expect(st.went).toEqual([]);
    expect(q('[data-reader-closed="not-a-reader-here"]')!.textContent).toContain(EN['reader.why.not-a-reader-here']);
    st.asked = { of: 'held' };
    await press('[data-action="open-company"]');
    expect(st.readerOpened).toBe(1);
    expect(st.went).toEqual([['reader', false, PARAMS]]);
  });
});

/* A kept reason is the sign-up page's to tell once; remembering an open company clears it. */
describe('the reason a company did not open', () => {
  it('is forgotten when the company opens again', async () => {
    rememberWhyNotOpen('c-9', { of: 'closed', why: 'no-grant' });
    rememberWhyNotOpen('c-9', { of: 'open', company: open().company as never });
    await drawSignUp();
    expect(q('[data-reader-closed]')).toBeNull();
  });
});
