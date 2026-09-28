// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom, privateAmount, publicAmount } from 'vaults-ui';
import type { Company, CompanyRecords, PersonRow, ProposalRow, RunRow } from '../adapters/company-records.js';

/*
 * THE COMPANY PAGES THAT READ, DRAWN IN THE FRAME at their own addresses,
 * over records handed to them as the adapter hands them: what each page shows,
 * what it marks public, what it says when a read failed, and that every action
 * not built yet is shown, disabled, with the Coming soon pill.
 */
const state = vi.hoisted(() => ({
  company: null as unknown, handover: { of: 'vault-keys-missing', signers: 1 } as unknown, publicMoney: null as unknown,
  opened: 0, names: new Map<string, string>(),
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => state.company,
  openWithYourAccount: async () => { state.opened += 1; return { of: 'done' }; },
  readVaultPublicMoney: async () => state.publicMoney,
}));
vi.mock('../adapters/handover-state.js', async (real) => ({
  ...(await real<typeof import('../adapters/handover-state.js')>()),
  readHandover: async () => state.handover,
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  companyNamesFor: async () => state.names,
}));

const { PageView } = await import('../app.js');
const { Shell } = await import('../shell/shell.js');
const { SessionProvider } = await import('../session.js');
const { DEFAULT_PREFERENCES } = await import('../preferences.js');
const { addressOf } = await import('../router.js');
const { PAGES, VIEWS } = await import('../pages.js');
const { skipStep, skippedFor } = await import('../setup/standing.js');
const { takeAsked } = await import('../setup/steps.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EN = JSON.parse(readFileSync(`${SRC}/locales/en.json`, 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const VAULT = 'ab'.repeat(32);

const NIGHT = (units: bigint, how: 'private' | 'public') => (how === 'private' ? privateAmount(units, 6, 'NIGHT') : publicAmount(units, 6, 'NIGHT'));
const RUN: RunRow = {
  id: 'r1', period: '2026-10', status: 'proposed', settledAt: null,
  payees: [
    { id: 'e1', name: 'Ana', amount: NIGHT(5_000_000n, 'private'), paid: 'privately' },
    { id: 'e2', name: 'Bo', amount: NIGHT(2_000_000n, 'public'), paid: 'publicly' },
    { id: 'e3', name: 'Cy', amount: NIGHT(1_000_000n, 'public'), paid: 'not-known' },
  ],
  currencies: [{ code: 'NIGHT', privately: NIGHT(5_000_000n, 'private'), publicly: NIGHT(2_000_000n, 'public') }],
  legs: [{ code: 'NIGHT', vault: VAULT, payees: 2 }], unrecognised: 0,
};
/* Paid out of another vault, so a vault's payouts are told apart from every run's. */
const PAID_RUN: RunRow = { ...RUN, id: 'r0', period: '2026-09', status: 'settled', settledAt: '2026-09-30T12:00:00.000Z', legs: [{ code: 'NIGHT', vault: 'cd'.repeat(32), payees: 2 }] };
const PROPOSALS: ProposalRow[] = [
  { id: 'p9', kind: 'something new' as ProposalRow['kind'], status: 'open', raisedBy: 'Sam', approvals: 0, needed: null, raisedAt: '2026-09-19T00:00:00.000Z', pays: null },
  { id: 'p1', kind: 'payroll', status: 'open', raisedBy: 'Sam', approvals: 1, needed: 2, raisedAt: '2026-09-21T00:00:00.000Z', pays: { run: 'r1', period: '2026-10', currency: 'NIGHT' } },
  { id: 'p2', kind: 'add-signer', status: 'executed', raisedBy: null, approvals: 2, needed: null, raisedAt: '2026-09-20T00:00:00.000Z', pays: null },
];
const PEOPLE: PersonRow[] = [
  { id: 'e1', name: 'Ana', title: 'Engineer', standing: 'active', pay: NIGHT(5_000_000n, 'private'), paid: 'privately', startedAt: '2026-01-01' },
  { id: 'e5', name: 'Eve', title: 'Writer', standing: 'waiting-for-check', pay: NIGHT(1n, 'public'), paid: 'not-set-up', startedAt: '2026-03-01' },
];
const records = (over: Partial<CompanyRecords> = {}): Company => ({
  of: 'open', id: 'c-1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }], approvalsNeeded: 1,
  proposals: { of: 'read', value: PROPOSALS }, runs: { of: 'read', value: [RUN, PAID_RUN] }, people: { of: 'read', value: PEOPLE },
  vaults: { of: 'read', value: [{ vault: VAULT, createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee' }] },
  invitations: { of: 'read', value: [{ kind: 'signer', name: 'Tom', sentAt: '2026-09-10T00:00:00.000Z', expiresAt: null }, { kind: 'employee', name: null, sentAt: '2026-09-11T00:00:00.000Z', expiresAt: '2026-10-11T00:00:00.000Z' }] },
  ...over,
});

type Id = keyof typeof PAGES;
async function draw(id: Id, params: Record<string, string> = {}) {
  window.history.replaceState(null, '', addressOf(id, params));
  const session = {
    person: { id: 'u1', name: 'Priya' }, companies: [{ id: 'c-1', createdAt: '2026-09-01T00:00:00.000Z', signers: 1, approvalsNeeded: 1 }], company: 'c-1',
    chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
    choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
  };
  const view = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session}><Shell current={id}><PageView id={id} params={params} /></Shell></SessionProvider>
    </KitProvider>,
  );
  /* The screen loads on demand, and the records are read after: both are waited for. */
  for (let i = 0; i < 50 && (view.container.querySelector('[data-loading], [data-reading]') !== null || view.container.querySelector('[data-screen]') === null); i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return view.container;
}
const q = (c: ParentNode, sel: string) => c.querySelector(sel) as HTMLElement | null;
const all = (c: ParentNode, sel: string) => [...c.querySelectorAll(sel)] as HTMLElement[];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.company = records(); state.handover = { of: 'vault-keys-missing', signers: 1 }; state.publicMoney = null; state.opened = 0; state.names = new Map();
  skippedFor('c-1').clear(); window.sessionStorage.clear(); takeAsked();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('every page that reads is built, at its own address', () => {
  /* RED WHEN: a page that reads shows Coming soon, or its screen is not the one its address opens. */
  it.each([
    ['home', {}], ['proposals', {}], ['payroll', {}], ['run', { run: 'r1' }], ['vaults', {}], ['vault', { vault: VAULT }], ['people', {}], ['invitations', {}],
  ] as const)('%s', async (id, params) => {
    const c = await draw(id, params);
    expect(q(c, '[data-screen=coming-soon]')).toBeNull();
    expect(q(c, `[data-page-body] [data-screen=${id}]`)).not.toBeNull();
    expect(q(c, `[data-menu-page=${id === 'run' ? 'payroll' : id === 'vault' ? 'vaults' : id}] [data-slot=coming-soon]`)).toBeNull();
  });

  /*
   * RED WHEN: an action these pages do not do yet (starting a run, approving,
   * declining, depositing, paying out, inviting, withdrawing, checking a
   * fingerprint, creating a vault) is hidden, or can be pressed, or is shown
   * without the Coming soon pill saying what it will do.
   */
  it('shows every action not built yet, disabled, with the Coming soon pill', async () => {
    const seen = new Set<string>();
    for (const [id, params] of [['home', {}], ['payroll', {}], ['run', { run: 'r1' }], ['vaults', {}], ['vault', { vault: VAULT }], ['people', {}], ['invitations', {}]] as const) {
      const c = await draw(id, params);
      const soon = all(c, '[data-soon]');
      expect(soon.length, id).toBeGreaterThan(0);
      for (const s of soon) {
        expect(q(s, 'button:not([data-slot=coming-soon])')!.hasAttribute('disabled'), `${id} ${s.dataset.action}`).toBe(true);
        expect(q(s, '[data-slot=coming-soon]'), `${id} ${s.dataset.action}`).not.toBeNull();
        seen.add(s.dataset.action!);
      }
      cleanup();
    }
    expect([...seen].sort()).toEqual(['approve', 'check-fingerprint', 'check-last-deposit', 'create-vault', 'deposit', 'export-run', 'invite', 'new-run', 'pay-out', 'withdraw']);
  });
});

describe('home', () => {
  /*
   * RED WHEN: the setup card leaves out a step not done, lists one that is
   * done, shows a skipped step as done or not as skipped, or its button does
   * not open the wizard at that step; or the card shows when every step is done.
   */
  it('shows the setup card with the steps left, a skipped one marked, each opening the wizard at it', async () => {
    skipStep('c-1', 'signers');
    const c = await draw('home');
    expect(all(c, '[data-part=setup-card] [data-step]').map((e) => [e.dataset.step, e.dataset.standing])).toEqual([
      ['signers', 'skipped'], ['handOver', 'open'], ['vault', 'open'], ['people', 'open'],
    ]);
    expect(q(c, '[data-part=setup-card] [data-step=signers] [data-skipped]')?.textContent).toBe(EN['setup.skipped']);
    expect(q(c, '[data-steps-left]')!.dataset.stepsLeft).toBe('4');
    fireEvent.click(q(c, '[data-part=setup-card] [data-step=vault] [data-action=open-step]')!);
    expect(window.location.pathname).toBe(PAGES.setup.path);
    expect(takeAsked()).toEqual({ step: 'vault', newCompany: false });
  });

  /* RED WHEN: a step the application knows is done stays on the card. */
  it('leaves a done step off the card', async () => {
    state.handover = { of: 'held' };
    const c = await draw('home');
    expect(all(c, '[data-part=setup-card] [data-step]').map((e) => e.dataset.step)).toEqual(['signers', 'vault', 'people']);
  });

  /* RED WHEN: proposals waiting, people waiting, the vaults, the next run or what passed recently is not the records', or a paid run is taken for the next one. */
  it('shows what needs the person, the vaults, the next run and what passed', async () => {
    const c = await draw('home');
    expect(q(c, '[data-company-name]')?.textContent).toBe('Northwind');
    expect(q(c, '[data-part=proposals-waiting] [data-count]')!.dataset.count).toBe('2');
    expect(all(c, '[data-part=proposals-waiting] [data-proposal]').map((e) => e.dataset.proposal)).toEqual(['p9', 'p1']);
    expect(all(c, '[data-part=people-waiting] [data-person]').map((e) => e.dataset.person)).toEqual(['e5']);
    expect(all(c, '[data-part=vaults] [data-vault]').map((e) => e.dataset.vault)).toEqual([VAULT]);
    expect(q(c, '[data-part=next-run] [data-run]')!.dataset.run).toBe('r1');
    expect(all(c, '[data-part=recently-passed] [data-proposal]').map((e) => e.dataset.proposal)).toEqual(['p2']);
    expect(q(c, '[data-part=recent-activity] [data-slot=coming-soon]')).not.toBeNull();
    /* The latest run is the newest month, whatever the record says of it: the record does not say whether it was paid. */
    cleanup();
    state.company = records({ runs: { of: 'read', value: [{ ...RUN, id: 'r2', period: '2026-11', status: 'draft' }, RUN] } });
    const later = await draw('home');
    expect(q(later, '[data-part=next-run] [data-run]')!.dataset.run).toBe('r2');
  });

  /* RED WHEN: one read that could not be read hides the others, or is shown as nothing (nobody waiting) instead of as not read. */
  it('says a read failed where it failed, and shows everything that was read', async () => {
    state.company = records({ people: { of: 'unreadable' }, vaults: { of: 'unreadable' } });
    const c = await draw('home');
    expect(q(c, '[data-part=people-waiting] [data-unreadable]')?.textContent).toBe(EN['records.unreadable']);
    expect(q(c, '[data-part=people-waiting] [data-count]')).toBeNull();
    expect(q(c, '[data-part=vaults] [data-unreadable]')).not.toBeNull();
    expect(q(c, '[data-part=proposals-waiting] [data-count]')!.dataset.count).toBe('2');
    expect(q(c, '[data-part=next-run] [data-run]')).not.toBeNull();
  });

  /* RED WHEN: locked records show anything but the way to open them, or opening them does not ask the account and read again. */
  it('offers to open the records with the person\'s account when they are locked', async () => {
    state.company = { of: 'locked' };
    const c = await draw('home');
    expect(q(c, '[data-records=locked]')).not.toBeNull();
    expect(q(c, '[data-part]')).toBeNull();
    state.company = records();
    await act(async () => { fireEvent.click(q(c, '[data-action=open-with-your-account]')!); await new Promise((r) => setTimeout(r, 10)); });
    expect(state.opened).toBe(1);
    expect(q(c, '[data-company-name]')?.textContent).toBe('Northwind');
  });
});

describe('the menu and the switcher', () => {
  /* RED WHEN: the count beside Proposals is not the proposals waiting, is shown while they could not be read, or Proposals is still Coming soon. */
  it('counts the proposals waiting beside Proposals', async () => {
    const c = await draw('payroll');
    expect(q(c, '[data-menu-page=proposals] [data-count]')?.textContent).toBe('2');
    expect(q(c, '[data-menu-page=proposals] [data-slot=coming-soon]')).toBeNull();
    cleanup();
    state.company = records({ proposals: { of: 'unreadable' } });
    const d = await draw('payroll');
    expect(q(d, '[data-menu-page=proposals] [data-count]')).toBeNull();
  });
});

describe('proposals', () => {
  /*
   * RED WHEN: a tab shows proposals that are not its (Pending not only those
   * waiting, Approved not those approved or done), the tabs are not the kit's
   * tabs across the top, Declined is offered as if it worked, or a row's panel
   * offers Approve or Decline as if they worked.
   */
  it('filters by the kit\'s tabs, with Declined Coming soon, and opens a proposal\'s panel', async () => {
    const c = await draw('proposals');
    expect(q(c, '[data-screen=proposals] [data-slot=tabs-list]')).not.toBeNull();
    expect(all(c, '[data-slot=tabs-trigger]').map((e) => e.dataset.tab)).toEqual(['all', 'pending', 'approved']);
    expect(all(c, '[data-proposals] [data-proposal]').map((e) => e.dataset.proposal)).toEqual(['p1', 'p2', 'p9']);
    /* A kind this app does not know is said as a change to the company, never as nothing. */
    expect(q(c, '[data-proposal=p9] td')?.textContent).toBe(EN['proposals.kind.other']);
    await act(async () => { fireEvent.mouseDown(q(c, '[data-tab=pending]')!, { button: 0 }); });
    expect(all(c, '[data-proposals] [data-proposal]').map((e) => e.dataset.proposal)).toEqual(['p1', 'p9']);
    await act(async () => { fireEvent.mouseDown(q(c, '[data-tab=approved]')!, { button: 0 }); });
    expect(all(c, '[data-proposals] [data-proposal]').map((e) => e.dataset.proposal)).toEqual(['p2']);
    expect(q(c, '[data-tab=declined] [data-slot=coming-soon]')).not.toBeNull();
    expect(q(c, '[data-proposal=p2] [data-approvals]')?.textContent).toBe('2 approvals');
    expect(q(c, '[data-proposal=p2] td')?.textContent).toBe(EN['proposals.kind.addSigner']);
    await act(async () => { fireEvent.mouseDown(q(c, '[data-tab=all]')!, { button: 0 }); });
    expect(q(c, '[data-proposal=p1] [data-approvals]')?.textContent).toBe('1 of 2');
    expect(q(c, '[data-proposal=p1] td')?.textContent).toBe('Pay the October 2026 run in NIGHT');
    await act(async () => { fireEvent.click(q(c, '[data-proposal=p1]')!); });
    const panel = document.querySelector('[data-proposal-panel=p1]') as HTMLElement;
    expect(all(panel, '[data-soon]').map((e) => [e.dataset.action, q(e, 'button')!.hasAttribute('disabled')])).toEqual([['approve', true], ['decline', true]]);
  });
});

describe('payroll and a run', () => {
  /* RED WHEN: a run's private and public money are shown as one figure, a public amount has no Public pill or a private one has one, or a paid run shows "Paid" without its day. */
  it('lists the runs, their money on a line each for private and public, and a paid run\'s day', async () => {
    const c = await draw('payroll');
    expect(all(c, '[data-runs] [data-run]').map((e) => e.dataset.run)).toEqual(['r1', 'r0']);
    const money = q(c, '[data-run=r1] [data-currency=NIGHT]')!;
    expect(all(money, '[data-slot=amount]').map((a) => a.dataset.visibility)).toEqual(['private', 'public']);
    expect(q(money, '[data-slot=amount][data-visibility=private] [data-slot=public-pill]')).toBeNull();
    expect(q(money, '[data-slot=amount][data-visibility=public]')!.textContent).toContain(EN['kit.public.label']);
    expect(q(c, '[data-run=r0] [data-status=settled]')?.textContent).toBe('Paid on Sep 30, 2026');
  });

  /* RED WHEN: a run's page does not warn that some are paid publicly, marks a payee by anything but how they are paid, or leaves a currency without its approvals. */
  it('shows a run\'s currencies, approvals, public payees and who is paid how', async () => {
    const c = await draw('run', { run: 'r1' });
    expect(q(c, '[data-public-payees]')?.textContent).toBe(EN['run.publicPayees_one']!.replace('{count}', '1'));
    expect(q(c, '[data-currency=NIGHT] [data-approvals]')?.textContent).toBe('1 of 2');
    expect(all(c, '[data-payee]').map((p) => [p.dataset.payee, q(p, '[data-paid]')!.dataset.paid, q(p, '[data-slot=amount]')!.dataset.visibility])).toEqual([
      ['e1', 'privately', 'private'], ['e2', 'publicly', 'public'], ['e3', 'not-known', 'public'],
    ]);
    /* A payee whose address is not known is not counted as paid publicly, and is not called private. */
    expect(q(c, '[data-payee=e3] [data-paid]')?.textContent).toBe(EN['records.paid.notKnown']);
    cleanup();
    const none = await draw('run', { run: 'nope' });
    expect(q(none, '[data-no-run]')).not.toBeNull();
  });
});

describe('a read that failed, on every page', () => {
  /*
   * RED WHEN: a page shows a read that failed as nothing (no runs, nobody,
   * no links, not sent for approval) instead of saying it could not be read.
   */
  it.each([
    ['proposals', {}, { proposals: { of: 'unreadable' } }],
    ['payroll', {}, { runs: { of: 'unreadable' } }],
    ['run', { run: 'r1' }, { runs: { of: 'unreadable' } }],
    ['run', { run: 'r1' }, { proposals: { of: 'unreadable' } }],
    ['vaults', {}, { vaults: { of: 'unreadable' } }],
    ['vault', { vault: VAULT }, { vaults: { of: 'unreadable' } }],
    ['vault', { vault: VAULT }, { runs: { of: 'unreadable' } }],
    ['people', {}, { people: { of: 'unreadable' } }],
    ['invitations', {}, { invitations: { of: 'unreadable' } }],
    ['home', {}, { proposals: { of: 'unreadable' }, runs: { of: 'unreadable' } }],
  ] as const)('%s', async (id, params, over) => {
    state.company = records(over as Partial<CompanyRecords>);
    const c = await draw(id, params);
    expect(all(c, '[data-unreadable]').length, id).toBeGreaterThan(0);
    expect(q(c, '[data-empty], [data-not-sent], [data-holds-none]'), id).toBeNull();
  });

  /* RED WHEN: the waiting tab shows nobody waiting when the people could not be read. */
  it('invitations, waiting tab', async () => {
    state.company = records({ people: { of: 'unreadable' } });
    const c = await draw('invitations');
    await act(async () => { fireEvent.mouseDown(q(c, '[data-tab=waiting]')!, { button: 0 }); });
    expect(q(c, '[data-waiting] [data-unreadable]')).not.toBeNull();
    expect(q(c, '[data-waiting] [data-empty]')).toBeNull();
  });
});

describe('vaults and a vault', () => {
  /*
   * RED WHEN: a vault's private money is shown as a figure (nothing reads it
   * here) or as nothing; its public money is read before it is asked for; a
   * public amount has no pill; or while a currency the registry does not know
   * is counted, the page says the vault holds no public money.
   */
  it('never says a vault holds nothing publicly while it holds a currency this app does not know', async () => {
    state.publicMoney = { amounts: [], unrecognised: 2 };
    const c = await draw('vault', { vault: VAULT });
    expect(q(c, '[data-private-line] [data-slot=coming-soon]')).not.toBeNull();
    expect(q(c, '[data-private-line] [data-slot=amount]')).toBeNull();
    expect(q(c, '[data-public-money]')!.dataset.publicMoney).toBe('not-asked');
    await act(async () => { fireEvent.click(q(c, '[data-action=show-public-money]')!); await new Promise((r) => setTimeout(r, 5)); });
    expect(q(c, '[data-unrecognised]')?.textContent).toBe(EN['vault.publicMoney.unrecognised_other']!.replace('{count}', '2'));
    expect(q(c, '[data-holds-none]')).toBeNull();
    state.publicMoney = { amounts: [NIGHT(4_000_000n, 'public')], unrecognised: 1 };
    await act(async () => { fireEvent.click(q(c, '[data-action=show-public-money]')!); await new Promise((r) => setTimeout(r, 5)); });
    expect(q(c, '[data-held=NIGHT] [data-slot=amount]')!.dataset.visibility).toBe('public');
    expect(q(c, '[data-held=NIGHT]')!.textContent).toContain(EN['kit.public.label']);
    expect(q(c, '[data-holds-none]')).toBeNull();
    state.publicMoney = { amounts: [], unrecognised: 0 };
    await act(async () => { fireEvent.click(q(c, '[data-action=show-public-money]')!); await new Promise((r) => setTimeout(r, 5)); });
    expect(q(c, '[data-holds-none]')?.textContent).toBe(EN['vault.publicMoney.none']);
    state.publicMoney = null;
    await act(async () => { fireEvent.click(q(c, '[data-action=show-public-money]')!); await new Promise((r) => setTimeout(r, 5)); });
    expect(q(c, '[data-public-money=unreadable]')).not.toBeNull();
    expect(q(c, '[data-holds-none]')).toBeNull();
  });

  /* RED WHEN: a vault's payouts are not the runs that pay out of it, or the tiles lead anywhere but the vault's own page. */
  it('lists the runs that pay out of the vault, and a tile opens the vault\'s page', async () => {
    const c = await draw('vault', { vault: VAULT });
    expect(all(c, '[data-part=payouts] [data-payout]').map((e) => e.dataset.payout)).toEqual(['r1']);
    cleanup();
    const tiles = await draw('vaults');
    expect((q(tiles, `[data-vault="${VAULT}"]`) as HTMLAnchorElement).getAttribute('href')).toBe(`/vaults/${VAULT}`);
  });
});

describe('people and invitations', () => {
  /* RED WHEN: a person's standing or how they are paid is not theirs, their pay has no Public pill when public, or their row does not open their panel. */
  it('lists the people and opens a person\'s panel', async () => {
    const c = await draw('people');
    expect(all(c, '[data-people] [data-person]').map((p) => [p.dataset.person, q(p, '[data-standing]')!.textContent, q(p, '[data-paid]')!.textContent, q(p, '[data-slot=amount]')!.dataset.visibility])).toEqual([
      ['e1', EN['people.standing.active'], EN['records.paid.privately'], 'private'], ['e5', EN['people.standing.waitingForCheck'], EN['records.paid.notSetUp'], 'public'],
    ]);
    await act(async () => { fireEvent.click(q(c, '[data-person=e5]')!); });
    expect(document.querySelector('[data-person-panel=e5]')).not.toBeNull();
  });

  /* RED WHEN: a sent link is not listed, a link that names nobody is given a name, the waiting tab leaves out someone waiting, or Codes received is offered as if it worked. */
  it('shows the sent links and the people waiting, by the kit\'s tabs', async () => {
    const c = await draw('invitations');
    expect(all(c, '[data-sent] [data-invitation]').map((e) => [e.dataset.invitation, e.querySelector('.font-medium')!.textContent])).toEqual([['signer', 'Tom'], ['employee', EN['invitations.noName']]]);
    expect(q(c, '[data-tab=codes] [data-slot=coming-soon]')).not.toBeNull();
    await act(async () => { fireEvent.mouseDown(q(c, '[data-tab=waiting]')!, { button: 0 }); });
    expect(all(c, '[data-waiting] [data-person]').map((e) => e.dataset.person)).toEqual(['e5']);
    expect(q(c, '[data-signers-waiting] [data-slot=coming-soon]')).not.toBeNull();
  });
});

describe('no page adds a second menu', () => {
  /*
   * RED WHEN: a screen writes a menu of its own beside the main menu (a nav,
   * or tabs made by hand) instead of the kit's tabs across the top. The
   * wizard's and Settings' side menus are named, and are to be moved to tabs
   * by the change that fixes them.
   */
  it('moves within a page only by the kit\'s tabs', () => {
    const NAMED = ['screens/settings.tsx', 'screens/setup.tsx'];
    const files = readdirSync(`${SRC}/screens`).filter((n) => /\.tsx$/.test(n));
    const read = ['screens', 'records'].flatMap((d) => readdirSync(`${SRC}/${d}`).filter((n) => /\.tsx$/.test(n) && !/\.test\./.test(n)).map((n) => `${d}/${n}`));
    const menu = /<nav\b|\brole=\{?\s*["'`](?:tablist|tab|menu|menubar|navigation)["'`]/;
    const hand = read.filter((n) => !NAMED.includes(n)).filter((n) => menu.test(readFileSync(`${SRC}/${n}`, 'utf8')));
    expect(hand).toEqual([]);
    for (const probe of ['<nav />', '<div role="tablist" />', '<div role={"tablist"} />', "<div role={'tab'} />", '<ul role="menu" />']) expect(menu.test(probe), probe).toBe(true);
    const tabbed = files.filter((n) => /\bTabsList\b/.test(readFileSync(`${SRC}/screens/${n}`, 'utf8')));
    expect(tabbed.sort()).toEqual(['invitations.tsx', 'proposals.tsx']);
    for (const n of tabbed) expect(readFileSync(`${SRC}/screens/${n}`, 'utf8'), n).toMatch(/import \{[^}]*\bTabsList\b[^}]*\} from 'vaults-ui'/);
    /* The rule reads what it is for: Settings, one of the two named, does write a nav. */
    expect(readFileSync(`${SRC}/screens/settings.tsx`, 'utf8')).toMatch(/<nav\b/);
  });
});
