// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { VIEWS } from '../pages.js';
import { ENGLISH } from '../english.test-support.js';
import { untilPageShown } from '../page-shown.test-support.js';

/*
 * THE ROLES AND PERMISSIONS PAGE, DRAWN over the real read-access part, with only the grants' read, the asks of the wallet and the
 * company's records stood in for: who is listed as a reader, what a waiting change shows and what a second seat must have to sign
 * it, what a press asks of the wallet, and the words after each answer.
 */
const st = vi.hoisted(() => ({
  read: null as unknown, readAfter: null as unknown, reads: 0, changed: false, keysOpened: 0, gives: [] as unknown[][], aways: [] as unknown[][], approvals: [] as unknown[][],
  gave: null as unknown, away: null as unknown, approved: null as unknown, named: 'not-set-up' as unknown,
}));
vi.mock('../adapters/grants-here.js', async (real) => ({
  ...(await real<typeof import('../adapters/grants-here.js')>()),
  namedBefore: async () => st.named,
  readGrants: async () => { st.reads += 1; return st.changed && st.readAfter !== null ? st.readAfter : st.read; },
  giveReadAccess: async (...a: unknown[]) => { st.changed = true; st.gives.push(a); return st.gave; },
  takeAwayReadAccess: async (...a: unknown[]) => { st.changed = true; st.aways.push(a); return st.away; },
  approveWaitingChange: async (...a: unknown[]) => { st.changed = true; st.approvals.push(a); return st.approved; },
}));
vi.mock('../adapters/roles-here.js', async (real) => ({
  ...(await real<typeof import('../adapters/roles-here.js')>()),
  readRoles: async () => ({ of: 'refused', why: 'no-keys-here' }),
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => ({ of: 'open', id: 'c-1', name: 'Northwind', signers: [], proposals: { of: 'read', value: [] } }),
  openWithYourAccount: async () => { st.changed = true; st.keysOpened += 1; return { of: 'done' }; },
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  companyNamesFor: async () => new Map(),
}));

const { Roles } = await import('./roles.js');
const { SessionProvider } = await import('../session.js');
const { CompanyRecordsProvider } = await import('../records/company-records.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const words = (key: string, values: Record<string, string | number> = {}): string =>
  Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), EN[key] ?? key);
const key = (n: number): string => n.toString(16).padStart(64, '0');
const RHEA = { recipient: key(5), person: 'rhea', role: 'accountant' };
const ABE = { recipient: key(6), person: 'abe', role: 'limited' };
const read = (readers: unknown[], waiting: unknown = null) => ({ of: 'read', readers, waiting });
const waitingOf = (over: Record<string, unknown> = {}) => ({ gives: [ABE], takesAway: [], signed: 1, needed: 2, mine: false, ...over });
const done = (over: Record<string, unknown> = {}) => ({ of: 'done', state: 'waiting-for-signers', signed: 1, needed: 2, ...over });
const turn = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => { await act(async () => { await turn(); await turn(); }); };
const q = (s: string): HTMLElement | null => document.body.querySelector(s);
const press = async (selector: string) => { fireEvent.click(q(selector)!); await settle(); };
const type = async (selector: string, value: string) => { fireEvent.change(q(selector)!, { target: { value } }); await settle(); };
const text = (): string => document.body.textContent ?? '';
const draw = async () => {
  const view = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={{
        person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true },
        chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
      }}
      >
        <CompanyRecordsProvider><Roles /></CompanyRecordsProvider>
      </SessionProvider>
    </KitProvider>,
  );
  await untilPageShown(view.container);
  await settle();
};

beforeEach(() => { st.named = 'not-set-up'; st.read = read([RHEA]); st.readAfter = null; st.reads = 0; st.changed = false; st.keysOpened = 0; st.gives = []; st.aways = []; st.approvals = []; st.gave = done({ state: 'in-force' }); st.away = done({ state: 'in-force' }); st.approved = { acted: done(), carries: 'signed' }; });
afterEach(() => { cleanup(); });

describe('who reads the company\'s records', () => {
  /* RED WHEN: a reader the grants name is not listed with their role and what that role reads, or the page says nobody reads when somebody does. */
  it('lists each reader with their role and what it reads, and the empty case when there are none', async () => {
    st.read = read([RHEA, ABE]);
    await draw();
    const rows = [...document.body.querySelectorAll('[data-reader]')].map((r) => r.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('rhea');
    expect(rows[0]).toContain(EN['roles.reads.accountant']);
    expect(rows[1]).toContain(EN['roles.reads.limited']);
    cleanup();
    st.read = read([]);
    await draw();
    expect(q('[data-readers] [data-slot="empty-state-line"]')!.textContent).toBe(EN['roles.readers.none']);
  });

  /* RED WHEN: the readers are read, or shown, before the wallet has released the company's key, or the page gives no way to release it. */
  it('shows the open-with-your-wallet line when the key is not released, and reads again once it is', async () => {
    st.read = { of: 'refused', why: 'no-keys-here' };
    await draw();
    expect(q('[data-roles-no-keys]')!.textContent).toContain(EN['roles.noKeys']);
    expect(q('[data-readers]')).toBeNull();
    st.readAfter = read([RHEA]);
    await press('[data-action="open-with-your-wallet"]');
    expect(st.keysOpened).toBe(1);
    expect(q('[data-reader]')).not.toBeNull();
  });
});

describe('the reader\'s link', () => {
  /* RED WHEN: the link is not built from the company's own id, label and contract address, is shown before they are known, or holds anything else (a key, a seat). */
  it('is built from the company\'s id, label and contract address, and is not shown until they are known', async () => {
    await draw();
    expect(q('[data-reader-link]')).toBeNull();
    cleanup();
    const label = `co_${'c1'.repeat(32)}`;
    st.named = { record: 'acc_Company00001', company: label, account: 'c0'.repeat(32) };
    await draw();
    const field = q('[data-reader-link] input') as HTMLInputElement;
    expect(field.value).toBe(`${window.location.origin}/read/c-1/${label}/${'c0'.repeat(32)}`);
    expect(q('[data-reader-link] button')!.textContent).toBe(EN['roles.readerLink.copy']);
  });
});

describe('giving and taking away access', () => {
  /* RED WHEN: the role or code typed is not what the wallet is asked, or limited and accountant are not both offered. */
  it('offers limited and accountant and asks the wallet with the code and role chosen', async () => {
    await draw();
    expect(['limited', 'accountant'].every((r) => q(`[data-role="${r}"]`) !== null)).toBe(true);
    expect(q('[data-role-reads="accountant"]')!.textContent).toBe(EN['roles.reads.accountant']);
    await type('[data-field="reader-code"]', 'CODE-TEXT');
    await press('[data-role="accountant"]');
    await press('[data-action="give-read"]');
    expect(st.gives.map((a) => a.slice(0, 3))).toEqual([['u1', 'c-1', { code: 'CODE-TEXT', role: 'accountant' }]]);
    expect(q('[data-grant-done="in-force"]')!.textContent).toContain(EN['roles.done.in-force']);
  });

  /* RED WHEN: a change waiting for more signers is shown as in force, or the count of signers is not said. */
  it('says how many signers have signed after a give that waits', async () => {
    st.gave = done();
    await draw();
    await type('[data-field="reader-code"]', 'x');
    await press('[data-action="give-read"]');
    expect(q('[data-grant-done]')!.textContent).toContain(words('roles.done.waiting', { signed: 1, needed: 2 }));
  });

  /* RED WHEN: a problem the page found before asking is shown as an answer from the wallet, or a stop is shown with the wrong reason. */
  it('says why a give did not go, and whether part of it may have', async () => {
    st.gave = { of: 'problem', problem: 'no-code' };
    await draw();
    await press('[data-action="give-read"]');
    expect(q('[data-grant-problem="no-code"]')!.textContent).toBe(EN['roles.give.problem.no-code']);
    st.gave = { of: 'stopped', why: 'code-not-signed', partial: false, handedOver: false };
    await press('[data-action="give-read"]');
    expect(q('[data-grant-stopped="code-not-signed"]')!.textContent).toContain(EN['roles.why.code-not-signed']);
    expect(q('[data-partial]')).toBeNull();
    st.gave = { of: 'stopped', why: 'not-filed', partial: true, handedOver: false };
    await press('[data-action="give-read"]');
    expect(q('[data-partial]')!.textContent).toBe(EN['roles.partial']);
  });

  /* RED WHEN: a take-away names any key but the listed reader's, or the page does not say what taking a reader away does and does not undo. */
  it('asks the wallet to take away the reader pressed, by their key as the grants hold it', async () => {
    st.read = read([RHEA, ABE]);
    await draw();
    expect(q('[data-take-away-says]')!.textContent).toBe(EN['roles.reader.takeAway.says']);
    await press(`[data-reader="${key(6)}"] [data-action="take-away"]`);
    expect(st.aways.map((a) => a.slice(0, 3))).toEqual([['u1', 'c-1', key(6)]]);
  });

  /* RED WHEN: the readers are not read again after a change went in, so the list shows the old readers. */
  it('reads the readers again after a change', async () => {
    st.read = read([RHEA, ABE]);
    st.readAfter = read([RHEA]);
    await draw();
    await press(`[data-reader="${key(6)}"] [data-action="take-away"]`);
    expect(q(`[data-reader="${key(6)}"]`)).toBeNull();
  });
});

describe('a change waiting for more signers, signed from a second seat', () => {
  /* RED WHEN: a waiting change is not shown with who it is for, how many have signed of how many are needed and whether this seat has. */
  it('shows the waiting give with its count and whether this seat signed', async () => {
    st.read = read([RHEA], waitingOf());
    await draw();
    const row = q('[data-waiting-change="give"]')!;
    expect(row.textContent).toContain(words('roles.waiting.give', { person: 'abe', role: EN['invite.role.limited']! }));
    expect(q('[data-waiting-count]')!.textContent).toBe(words('roles.waiting.count', { signed: 1, needed: 2 }));
    expect(q('[data-waiting-mine="false"]')!.textContent).toBe(EN['roles.waiting.notMine']);
    expect(q('[data-waiting-code-hint]')!.textContent).toBe(EN['roles.waiting.code.hint']);
  });

  /* RED WHEN: a count that could not be made is shown as a number. */
  it('says the count could not be made when it could not', async () => {
    st.read = read([RHEA], waitingOf({ signed: null }));
    await draw();
    expect(q('[data-waiting-count]')!.textContent).toBe(words('roles.waiting.count.unread', { needed: 2 }));
  });

  /* RED WHEN: a give can be signed without the reader's code, or signs with a role other than the waiting change's, or the answer's words are not said. */
  it('needs the reader\'s code to sign a waiting give, signs with the waiting change\'s own role, and says whether it carries this seat\'s signature', async () => {
    st.read = read([RHEA], waitingOf({ gives: [{ ...ABE, role: 'accountant' }] }));
    await draw();
    expect((q('[data-action="sign-waiting"]') as HTMLButtonElement).disabled).toBe(true);
    await type('[data-field="waiting-code"]', 'CODE-AGAIN');
    expect((q('[data-action="sign-waiting"]') as HTMLButtonElement).disabled).toBe(false);
    await press('[data-action="sign-waiting"]');
    expect(st.approvals.map((a) => a.slice(0, 3))).toEqual([['u1', 'c-1', { code: 'CODE-AGAIN', role: 'accountant' }]]);
    expect(q('[data-grant-carries="signed"]')!.textContent).toBe(EN['roles.carries.signed']);
    st.approved = { acted: done({ signed: 1 }), carries: 'not-the-waiting-change' };
    await press('[data-action="sign-waiting"]');
    expect(q('[data-grant-carries="not-the-waiting-change"]')!.textContent).toContain('That is not the waiting change');
  });

  /* RED WHEN: a waiting take-away asks for a code, or does not name the reader it ends. */
  it('signs a waiting take-away by the reader\'s key with no code', async () => {
    st.read = read([RHEA, ABE], waitingOf({ gives: [], takesAway: [ABE] }));
    await draw();
    expect(q('[data-field="waiting-code"]')).toBeNull();
    await press('[data-action="sign-waiting"]');
    expect(st.approvals.map((a) => a.slice(0, 3))).toEqual([['u1', 'c-1', { takeAway: key(6) }]]);
  });

  /* RED WHEN: a waiting change that touches more than one reader can be signed from here by one reader's ask. */
  it('offers no signing of a waiting change that touches more than one reader', async () => {
    st.read = read([RHEA], waitingOf({ gives: [ABE, { ...ABE, recipient: key(7), person: 'zed' }] }));
    await draw();
    expect(q('[data-waiting-many]')!.textContent).toBe(EN['roles.waiting.many']);
    expect(q('[data-action="sign-waiting"]')).toBeNull();
  });

  /* RED WHEN: the page shows a waiting list when nothing waits. */
  it('shows no waiting list when nothing waits', async () => {
    await draw();
    expect(q('[data-waiting-changes]')).toBeNull();
    expect(text()).not.toContain(EN['roles.waiting.title']!);
  });
});
