// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom, publicAmount } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { untilPageShown } from '../page-shown.test-support.js';
import { VIEWS } from '../pages.js';

/*
 * THE PEOPLE WAITING FOR THE FINGERPRINT CHECK, ON HOME AND ON INVITATIONS, over the real adapters and the real wallet wrappers, with only
 * the call to the wallet and the company's records stood in for: who is listed, which control each row has, and what its press asks of the wallet.
 */
vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180'); });
const kr = vi.hoisted(() => ({
  acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown, company: null as unknown, reads: 0, after: null as (() => void) | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => ({ id: 'u1' }),
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => ({ companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) }),
  actOnACompanyInTheWallet: async (intent: Record<string, string>) => { kr.acts.push(intent); kr.after?.(); return kr.ended; },
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => { kr.reads += 1; return kr.company; },
  companyPagesOpen: () => () => {},
}));
vi.mock('../adapters/creation-standing.js', async (real) => ({
  ...(await real<typeof import('../adapters/creation-standing.js')>()),
  creationOf: async () => ({ company: 'c-1', standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null }),
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  companyNamesFor: async () => new Map(),
}));

const { Home } = await import('../screens/home.js');
const { Invitations } = await import('../screens/invitations.js');
const { SessionProvider } = await import('../session.js');
const { PanelProvider, RightPanel } = await import('../shell/right-panel.js');
const { CompanyRecordsProvider } = await import('../records/company-records.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };

const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../locales/en.json'), 'utf8')) as Record<string, string>;
const en = (key: string): string => EN[key] ?? key;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const NIGHT_TOKEN = '00'.repeat(32);
const FINGERPRINT = 'ABCD-EFGH-JKMN-PQRS-TVWX';

const person = (over: Record<string, unknown> = {}) => ({
  id: 'e5', name: 'Eve', title: 'Writer', standing: 'waiting-for-check', pay: publicAmount(1n, 6, 'NIGHT'), paid: 'not-set-up', startedAt: '2026-03-01',
  asset: NIGHT_TOKEN, classification: 'full-time', endDate: null, leavingDate: null, pays: [], classifications: [], admittedAt: null, admitBy: 'fingerprint', notPayable: null, ...over,
});
const vendor = (over: Record<string, unknown> = {}) => ({
  id: 'ven_bb', name: 'Wes', standing: 'waiting-for-check', handedOver: true, termsKind: 'monthly', asset: NIGHT_TOKEN, monthly: publicAmount(2_500_000n, 6, 'NIGHT'), paid: 'not-set-up',
  startedAt: '2026-01-01', endDate: null, admittedAt: null, admitBy: 'fingerprint', notPayable: null, ...over,
});
const vendorsRead = (rows: ReturnType<typeof vendor>[]) => ({ of: 'read', value: { vendors: rows, rows, notBelieved: [], notPayable: [] } });
const records = (over: Record<string, unknown> = {}) => ({
  of: 'open', id: 'c-1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }], approvalsNeeded: { of: 'read', value: 1 },
  proposals: { of: 'read', value: [] }, runs: { of: 'read', value: [] }, vaults: { of: 'read', value: [] }, invitations: { of: 'read', value: [] },
  people: { of: 'read', value: [person()] }, vendors: vendorsRead([vendor()]), ...over,
});

const session = () => ({
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true },
  chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
});
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }); };
const q = (s: string): HTMLElement | null => document.body.querySelector(s);
const qa = (s: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(s)];
const press = async (selector: string) => { fireEvent.click(q(selector)!); await settle(); };
const WHERE = { home: '[data-part=people-waiting]', invitations: '[data-waiting]' } as const;
const draw = async (page: keyof typeof WHERE) => {
  const { container } = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session()}><PanelProvider><CompanyRecordsProvider>{page === 'home' ? <Home /> : <Invitations />}<RightPanel /></CompanyRecordsProvider></PanelProvider></SessionProvider>
    </KitProvider>,
  );
  await untilPageShown(container);
  if (page === 'invitations') { fireEvent.mouseDown(q('[data-tab=waiting]')!, { button: 0 }); await settle(); }
};

beforeEach(() => { kr.acts = []; kr.reads = 0; kr.after = null; kr.company = records(); kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'admitted' } }; });
afterEach(cleanup);

describe.each(['home', 'invitations'] as const)('the people waiting for the fingerprint check, on %s', (page) => {
  const asked = (fields: Record<string, string>) => [{ name: 'admit-person', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), kind: 'employee', person: 'e5', personName: 'Eve', ...fields }];

  /* RED WHEN: a person or a vendor waiting for the check is left out of the list, or listed with a control that is disabled or is not the one admit control. */
  it('lists the employees and the vendors waiting, each with a live control', async () => {
    await draw(page);
    expect(qa(`${WHERE[page]} [data-person]`).map((r) => r.dataset['person'])).toEqual(['e5', 'ven_bb']);
    for (const id of ['e5', 'ven_bb']) {
      const button = q(`${WHERE[page]} [data-person=${id}] button[data-action=check-fingerprint]`) as HTMLButtonElement;
      expect([button.textContent, button.disabled, button.hasAttribute('data-soon')]).toEqual([en('people.checkFingerprint'), false, false]);
    }
  });

  /* RED WHEN: the control does not open the one admit form for that person, asks the wallet for a vendor as an employee, sends something other than the fingerprint typed, or loses its answer when the records are read again. */
  it('opens the admit form in the panel, asks the wallet as the right kind, and keeps the answer after the records are read again', async () => {
    kr.after = () => { kr.company = records({ people: { of: 'read', value: [person({ standing: 'active', admittedAt: '2026-10-29T10:00:00.000Z' })] } }); };
    await draw(page);
    await press(`${WHERE[page]} [data-person=e5] button[data-action=check-fingerprint]`);
    expect(qa('[data-panel] [data-admit]').map((f) => f.dataset['admit'])).toEqual(['e5']);
    fireEvent.change(q('[data-panel] [data-field=fingerprint]')!, { target: { value: ` ${FINGERPRINT.toLowerCase()} ` } });
    await press('[data-panel] [data-action=admit-person]');
    expect(kr.acts).toEqual(asked({ fingerprint: FINGERPRINT }));
    expect(kr.reads).toBe(2);
    expect(q('[data-panel] [data-acted=admit-person]')!.textContent).toBe(en('people.done.admitted').replace('{name}', 'Eve'));
    expect(q(`${WHERE[page]} [data-person=e5]`)).toBeNull();
  });

  it('asks the wallet to admit a vendor as a vendor, and none for a fingerprint when their wallet signed a claim', async () => {
    kr.company = records({ people: { of: 'read', value: [] }, vendors: vendorsRead([vendor({ admitBy: 'claim' })]) });
    await draw(page);
    await press(`${WHERE[page]} [data-person=ven_bb] button[data-action=check-fingerprint]`);
    expect(q('[data-panel] [data-field=fingerprint]')).toBeNull();
    await press('[data-panel] [data-action=admit-person]');
    expect(kr.acts).toEqual(asked({ kind: 'vendor', person: 'ven_bb', personName: 'Wes' }));
  });

  /* RED WHEN: a list says nobody is waiting, or counts, when the people or the vendors could not be read, or the Invite control is hidden or disabled because of it. */
  it('says it could not read, counts nobody, and keeps Invite, when either read failed', async () => {
    for (const over of [{ people: { of: 'unreadable' } }, { vendors: { of: 'unreadable' } }, { vendors: undefined }]) {
      cleanup();
      kr.company = records(over);
      await draw(page);
      expect(q(`${WHERE[page]} [data-unreadable]`)).not.toBeNull();
      expect(q(`${WHERE[page]} [data-person]`)).toBeNull();
      expect(q(`${WHERE[page]} [data-slot=empty-state]`)).toBeNull();
      const invite = q('[data-action=invite]') as HTMLButtonElement | null;
      expect([invite === null, invite?.disabled]).toEqual([false, false]);
    }
  });

  /* RED WHEN: a row does not say whether it is an employee or a vendor, or says it in other words than the Sent links tab. */
  it('says beside each name whether the person is an employee or a vendor, in the words of the sent links', async () => {
    await draw(page);
    expect(qa(`${WHERE[page]} [data-person] [data-kind]`).map((k) => [k.dataset['kind'], k.textContent])).toEqual([['employee', en('invitations.kind.employee')], ['vendor', en('invitations.kind.vendor')]]);
  });
});

describe('the people waiting, on Home, when there are more than it draws', () => {
  /* RED WHEN: Home counts more waiting than it draws and gives no way to the rest, or the way does not go to Invitations, or the Invitations list leaves the fourth out. */
  it('draws the first three, counts all four, and links to Invitations, which lists all four', async () => {
    const four = ['e5', 'e6', 'e7', 'e8'].map((id) => person({ id, name: `Eve ${id}` }));
    kr.company = records({ people: { of: 'read', value: four }, vendors: vendorsRead([]) });
    await draw('home');
    expect(qa('[data-part=people-waiting] [data-person]').map((r) => r.dataset['person'])).toEqual(['e5', 'e6', 'e7']);
    expect(q('[data-part=people-waiting] [data-count]')!.dataset['count']).toBe('4');
    expect(q('[data-part=people-waiting] [data-action=view-all-waiting]')!.getAttribute('href')).toBe('/invitations');
    cleanup();
    await draw('invitations');
    expect(qa('[data-waiting] [data-person]').map((r) => r.dataset['person'])).toEqual(['e5', 'e6', 'e7', 'e8']);
  });
});
