// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom, privateAmount, publicAmount } from 'vaults-ui';
import type { Company, CompanyRecords, PersonRow, ProposalRow, RunRow, VaultRow } from '../adapters/company-records.js';
import { untilPageShown, untilShown } from '../page-shown.test-support.js';

/*
 * THE COMPANY PAGES THAT READ, DRAWN IN THE FRAME at their own addresses,
 * over records handed to them as the adapter hands them: what each page shows,
 * what it marks public, what it says when a read failed, and that every action
 * not built yet is shown, disabled, with the Coming soon pill.
 */
const state = vi.hoisted(() => ({
  company: null as unknown, handover: { of: 'vault-keys-missing', signers: 1 } as unknown, publicMoney: null as unknown, privateMoney: null as unknown,
  opened: 0, names: new Map<string, string>(), ready: { of: 'ready' } as unknown, owed: [] as unknown[],
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
vi.mock('../adapters/create-vault.js', async (real) => ({
  ...(await real<typeof import('../adapters/create-vault.js')>()),
  readVaultReadiness: async () => state.ready,
  readOwedVaults: async () => state.owed,
}));
vi.mock('../adapters/vault-private-money.js', async (real) => ({
  ...(await real<typeof import('../adapters/vault-private-money.js')>()),
  readVaultPrivateMoney: async () => state.privateMoney,
}));
vi.mock('../adapters/vault-rows.js', async (real) => ({
  ...(await real<typeof import('../adapters/vault-rows.js')>()),
  readVaultRows: async () => [],
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
/** Draw a page in the frame, and read nothing yet. */
function drawNow(id: Id, params: Record<string, string> = {}) {
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
  return view.container;
}

/** Draw a page, and wait for it: the screen loads on demand, and the records are read after. */
async function draw(id: Id, params: Record<string, string> = {}) {
  const container = drawNow(id, params);
  await untilPageShown(container);
  return container;
}
const q = (c: ParentNode, sel: string) => c.querySelector(sel) as HTMLElement | null;
/** Let the reads a page starts come back. */
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
const all = (c: ParentNode, sel: string) => [...c.querySelectorAll(sel)] as HTMLElement[];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.company = records(); state.handover = { of: 'vault-keys-missing', signers: 1 }; state.publicMoney = null; state.privateMoney = null; state.owed = []; state.opened = 0; state.names = new Map(); state.ready = { of: 'ready' };
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
   * fingerprint) is hidden, or can be pressed, or is shown without the Coming
   * soon pill saying what it will do; or creating a vault, which is built, is
   * still shown Coming soon anywhere.
   */
  it('shows every action not built yet, disabled, with the Coming soon pill', async () => {
    const seen = new Set<string>();
    for (const [id, params] of [['home', {}], ['payroll', {}], ['run', { run: 'r1' }], ['vault', { vault: VAULT }], ['people', {}], ['invitations', {}]] as const) {
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
    expect([...seen].sort()).toEqual(['approve', 'check-fingerprint', 'check-last-deposit', 'create-proposal', 'decline', 'deposit', 'export-run', 'invite', 'new-run', 'pay-out', 'withdraw']);
    const vaults = await draw('vaults');
    expect(all(vaults, '[data-soon]')).toEqual([]);
    await act(async () => { fireEvent.click(q(vaults, '[data-action=create-vault]')!); await new Promise((r) => setTimeout(r, 5)); });
    expect((document.querySelector('[data-panel] [data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(false);
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
    state.company = records({ vaults: { of: 'read', value: [] } });
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

  /*
   * RED WHEN: the setup card loses its bar or its "n of 5 steps done"; folding
   * it does not hide its steps; or a fold is not kept for the company when
   * Home is opened again.
   */
  it('shows how far setup has come, and folds, kept for the company', async () => {
    window.localStorage.clear();
    const c = await draw('home');
    const card = q(c, '[data-part=setup-card]')!;
    expect(all(card, '[data-slot=progress-mark]').map((m) => m.dataset.filled)).toEqual(['true', 'false', 'false', 'true', 'false']);
    expect(q(card, '[data-steps-done]')!.textContent).toBe('2 of 5 steps done');
    fireEvent.click(q(card, '[data-action=fold-setup]')!);
    expect(q(c, '[data-part=setup-card] [data-step]')).toBeNull();
    expect(q(c, '[data-part=setup-card] [data-slot=progress]')).not.toBeNull();
    expect(q(c, '[data-action=fold-setup]')!.getAttribute('aria-expanded')).toBe('false');
    cleanup();
    const again = await draw('home');
    expect(q(again, '[data-part=setup-card]')!.hasAttribute('data-folded')).toBe(true);
    expect(q(again, '[data-part=setup-card] [data-step]')).toBeNull();
    fireEvent.click(q(again, '[data-action=fold-setup]')!);
    expect(all(again, '[data-part=setup-card] [data-step]').length).toBe(3);
    window.localStorage.clear();
  });

  /*
   * RED WHEN: pending approval loses its proposals or its people section, a
   * section its count or its actions, or an action not built yet (creating
   * approving and declining a proposal, inviting, letting a person in) is missing,
   * pressable, or without its Coming soon pill; or View all does not go to
   * Proposals.
   */
  it('shows pending approval: proposals and people, with their counts and actions', async () => {
    const c = await draw('home');
    const pending = q(c, '[data-part=pending-approval]')!;
    expect(q(pending, 'h2')!.textContent).toBe(EN['home.pendingApproval']);
    const proposals = q(pending, '[data-part=proposals-waiting]')!;
    expect(q(proposals, '[data-slot=section-header] h2')!.textContent).toBe(EN['page.proposals.name']);
    expect(q(proposals, '[data-slot=section-actions] [data-action=create-proposal] button:not([data-slot=coming-soon])')!.hasAttribute('disabled')).toBe(true);
    expect(q(proposals, '[data-slot=section-actions] [data-action=view-all-proposals]')!.getAttribute('href')).toBe(PAGES.proposals.path);
    for (const row of all(proposals, '[data-proposal]')) {
      for (const action of ['approve', 'decline']) {
        expect(q(row, `[data-action=${action}] button:not([data-slot=coming-soon])`)!.hasAttribute('disabled'), action).toBe(true);
        expect(q(row, `[data-action=${action}] [data-slot=coming-soon]`), action).not.toBeNull();
      }
    }
    const people = q(pending, '[data-part=people-waiting]')!;
    expect(q(people, '[data-slot=count-pill]')!.textContent).toBe('1');
    expect(q(people, '[data-slot=section-actions] [data-action=invite] [data-slot=coming-soon]')).not.toBeNull();
    expect(q(people, '[data-person=e5] [data-action=check-fingerprint] button:not([data-slot=coming-soon])')!.hasAttribute('disabled')).toBe(true);
  });

  /* RED WHEN: a part with nothing in it shows a bare line instead of the kit's empty state, or its next action. */
  it('shows each part with nothing in it as the kit\'s empty state, with what comes next', async () => {
    state.company = records({ proposals: { of: 'read', value: [] }, people: { of: 'read', value: [] }, vaults: { of: 'read', value: [] }, runs: { of: 'read', value: [] } });
    const c = await draw('home');
    for (const part of ['proposals-waiting', 'people-waiting', 'vaults', 'next-run', 'recently-passed']) {
      expect(q(c, `[data-part=${part}] [data-slot=empty-state]`), part).not.toBeNull();
    }
    expect(q(c, '[data-part=vaults] [data-slot=empty-state] [data-action=create-vault]')).not.toBeNull();
    expect(q(c, '[data-part=next-run] [data-slot=empty-state] [data-action=new-run]')).not.toBeNull();
    expect(q(c, '[data-part=proposals-waiting] [data-slot=count-pill]')!.textContent).toBe('0');
  });

  /* RED WHEN: a vault's tile is not the kit's tile linking to its page, or shows a change it has nothing to compare with. */
  it('shows each vault as a tile, with no change', async () => {
    const c = await draw('home');
    const tile = q(c, `[data-part=vaults] [data-vault="${VAULT}"]`)!;
    expect(tile.getAttribute('data-slot')).toBe('stat-tile');
    expect(q(tile, '[data-slot=stat-tile-change]')).toBeNull();
    expect(q(tile, '[data-slot=stat-tile-title]')!.textContent).toBe('Vault 1');
  });

  /* RED WHEN: what passed recently is not in the kit's table, its filters lose their counts, or a filter keeps rows it should not. */
  it('shows what passed recently in the kit\'s table, filtered by its tabs', async () => {
    state.company = records({ proposals: { of: 'read', value: [...PROPOSALS, { ...PROPOSALS[2]!, id: 'p3', status: 'approved', raisedAt: '2026-09-22T00:00:00.000Z' }] } });
    const c = await draw('home');
    const table = q(c, '[data-part=recently-passed] [data-slot=data-table]')!;
    expect(all(table, 'tbody tr').map((r) => r.dataset.row)).toEqual(['p3', 'p2']);
    expect(all(table, '[data-filter]').map((t) => [t.dataset.filter, q(t, '[data-slot=count-pill]')!.textContent])).toEqual([['all', '2'], ['approved', '1'], ['executed', '1']]);
    await act(async () => { fireEvent.mouseDown(q(table, '[data-filter=executed]')!, { button: 0 }); });
    expect(all(table, 'tbody tr').map((r) => r.dataset.row)).toEqual(['p2']);
    expect(q(table, 'tbody tr [data-action=view-proposal]')!.getAttribute('href')).toBe(PAGES.proposals.path);
  });

  /* RED WHEN: a step the application knows is done stays on the card; or a vault not yet held by the signers, or vaults that could not be read, take the vault step off it. */
  it('leaves a done step off the card', async () => {
    state.handover = { of: 'held' };
    const c = await draw('home');
    expect(all(c, '[data-part=setup-card] [data-step]').map((e) => e.dataset.step)).toEqual(['signers', 'people']);
    for (const vaults of [{ of: 'read', value: [{ vault: VAULT, createdAt: '2026-09-01T00:00:00.000Z', standing: 'handover-owed' }] }, { of: 'unreadable' }] as const) {
      cleanup();
      state.company = records({ vaults: vaults as CompanyRecords['vaults'] });
      const again = await draw('home');
      expect(all(again, '[data-part=setup-card] [data-step]').map((e) => e.dataset.step), vaults.of).toEqual(['signers', 'vault', 'people']);
    }
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
    expect(all(c, '[data-part=recently-passed] [data-row]').map((e) => e.dataset.row)).toEqual(['p2']);
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

  /*
   * RED WHEN: while the company's records are read, the page shows anything
   * but the kit's page loading: nothing, loose lines, or something that could
   * be read as an answer.
   */
  it('shows the kit\'s page loading while the records are read', async () => {
    state.company = new Promise(() => {});
    const c = drawNow('home');
    const reading = await untilShown(() => q(c, '[data-screen=home] [data-reading]'), 'Home reading its records');
    expect(reading.getAttribute('data-slot')).toBe('page-loading');
    expect(reading.getAttribute('aria-busy')).toBe('true');
    expect(reading.querySelectorAll('[data-slot=section-loading]').length).toBe(2);
    expect(reading.textContent).toBe('');
    expect(q(c, '[data-part]')).toBeNull();
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

  /*
   * RED WHEN: the Public pill of a run not paid yet, of a payee in it, or of
   * a person's pay, says the amount was received; or a paid run's says it is
   * still to come.
   */
  it('explains public money not paid yet as to come, and a paid run\'s as received', async () => {
    /* The pill's words, opened from the keyboard, so a press does not also open the row it sits in. */
    const explained = async (c: ParentNode, sel: string) => {
      const pill = q(c, `${sel} [data-slot=amount][data-visibility=public] [data-slot=public-pill]`)!;
      await act(async () => { fireEvent.focus(pill); });
      const words = [EN['kit.public.explanation.toBePaid']!, EN['kit.public.explanation.payment']!].filter((w) => all(document.body, '[data-slot=tooltip-content]').some((e) => e.textContent?.includes(w)));
      await act(async () => { fireEvent.blur(pill); });
      return words;
    };
    const runs = await draw('payroll');
    expect(await explained(runs, '[data-run=r1]')).toEqual([EN['kit.public.explanation.toBePaid']]);
    expect(await explained(runs, '[data-run=r0]')).toEqual([EN['kit.public.explanation.payment']]);
    cleanup();
    const run = await draw('run', { run: 'r1' });
    expect(await explained(run, '[data-payee=e2]')).toEqual([EN['kit.public.explanation.toBePaid']]);
    cleanup();
    const people = await draw('people');
    expect(await explained(people, '[data-person=e5]')).toEqual([EN['kit.public.explanation.toBePaid']]);
    await act(async () => { fireEvent.click(q(people, '[data-person=e5] td')!); });
    expect(await explained(document.body, '[data-person-panel=e5]')).toEqual([EN['kit.public.explanation.toBePaid']]);
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
  const TD = (units: bigint) => privateAmount(units, 6, 'TDUST');
  const heldLines = (c: ParentNode) => all(c, '[data-money-lines] [data-held]').map((l) => [l.dataset.held, l.dataset.visibility, l.textContent]);
  const vaultOf = (standing: VaultRow['standing'], vault = VAULT): VaultRow => ({ vault, createdAt: '2026-09-01T00:00:00.000Z', standing });

  /*
   * RED WHEN: a tile, on the Vaults page or on Home, draws
   * separate Private money and Public money headings; a currency held is not
   * on a line of its own with its Private or Public pill; private money is
   * not the adapter's read on this device, or is said as not shown; or a
   * side that could not be read is shown as nothing held.
   */
  it('shows each currency a vault holds on its tile, one line each, with its Private or Public pill', async () => {
    state.privateMoney = { amounts: [TD(1_500_000n)] };
    state.publicMoney = { amounts: [NIGHT(4_000_000n, 'public')], unrecognised: 0 };
    for (const id of ['vaults', 'home'] as const) {
      const c = await draw(id);
      await settle();
      const tile = q(c, `[data-slot=stat-tile][data-vault="${VAULT}"]`)!;
      expect(heldLines(tile), id).toEqual([
        ['TDUST', 'private', `1.500000 TDUST${EN['kit.balance.private']}`],
        ['NIGHT', 'public', `4.000000 NIGHT${EN['kit.public.label']}`],
      ]);
      expect(q(tile, '[data-held=TDUST] [data-slot=private-pill]'), id).not.toBeNull();
      expect(q(tile, '[data-held=NIGHT] [data-slot=public-pill]'), id).not.toBeNull();
      expect(tile.textContent, id).not.toContain('Private money');
      expect(tile.textContent, id).not.toContain('Public money');
      expect(tile.textContent, id).not.toContain('Not shown here');
      expect(q(tile, '[data-holds-none]'), id).toBeNull();
      cleanup();
    }
    state.privateMoney = null;
    state.publicMoney = { amounts: [], unrecognised: 0 };
    const c = await draw('vaults');
    await settle();
    const tile = q(c, `[data-slot=stat-tile][data-vault="${VAULT}"]`)!;
    expect(q(tile, '[data-unreadable=private]')?.textContent).toBe(EN['vaults.privateMoney.unreadable']);
    expect(q(tile, '[data-holds-none]')).toBeNull();
    cleanup();
    state.privateMoney = { amounts: [] };
    const none = await draw('vaults');
    await settle();
    expect(q(none, `[data-vault="${VAULT}"] [data-holds-none]`)?.textContent).toBe(EN['vaults.money.none']);
    cleanup();
    /* A currency this app does not know is still money held: counted, and never "none". */
    state.publicMoney = { amounts: [], unrecognised: 2 };
    const unknown = await draw('vaults');
    await settle();
    expect(q(unknown, `[data-vault="${VAULT}"] [data-holds-none]`)).toBeNull();
    expect(q(unknown, `[data-vault="${VAULT}"] [data-unrecognised]`)?.textContent).toBe(EN['vault.publicMoney.unrecognised_other']!.replace('{count}', '2'));
  });

  /* RED WHEN: a tile whose public money could not be read says so in the page's words, which name a button the tile does not have. */
  it('says on a tile, in its own words, that its public money could not be read', async () => {
    state.privateMoney = { amounts: [] };
    const c = await draw('vaults');
    await settle();
    expect(q(c, `[data-slot=stat-tile][data-vault="${VAULT}"] [data-unreadable=public]`)?.textContent).toBe(EN['vaults.publicMoney.unreadable']);
  });

  /*
   * RED WHEN: a vault's page does not
   * show its money in the kit's table with exactly the columns Asset, Balance,
   * State and Actions; the balance repeats the token's name; an asset held
   * both ways is not two rows, one per state; the state is not read from the
   * amount; Send and Shield or Unshield are missing, enabled, without their
   * hover text, or carry a Coming soon pill; the tabs do not keep the rows
   * held privately, or publicly; a side that could not be read is shown as
   * held; a currency the registry does not know is not counted; or checking
   * again is not the refresh icon with its hover text and how long ago the
   * money was read.
   */
  it('shows a vault\'s money in the kit\'s table: Asset, Balance, State and Actions, a row an asset and state', async () => {
    state.privateMoney = { amounts: [TD(1_500_000n), NIGHT(2_000_000n, 'private')] };
    state.publicMoney = { amounts: [NIGHT(4_000_000n, 'public')], unrecognised: 2 };
    const c = await draw('vault', { vault: VAULT });
    await settle();
    const table = q(c, '[data-part=money] [data-slot=data-table]')!;
    const rows = () => all(table, 'tbody tr').map((r) => [r.dataset.row, ...all(r, 'td').slice(0, 3).map((d) => d.textContent)]);
    expect(all(table, 'thead th').map((h) => h.textContent)).toEqual([EN['vault.money.asset'], EN['vault.money.balance'], EN['vault.money.state'], EN['vault.money.actions']]);
    /* Asset takes half the table and Actions an eighth; Balance and State share the rest; the three after Asset are centred, heading and entries alike. */
    expect(all(table, 'thead th').map((h) => [h.className.includes('md:w-1/2'), h.className.includes('md:w-1/8'), h.className.includes('text-center')])).toEqual([[true, false, false], [false, false, true], [false, false, true], [false, true, true]]);
    expect(all(table, 'tbody tr:first-child td').map((d) => d.className.includes('text-center'))).toEqual([false, true, true, true]);
    expect(q(table, 'table')!.className).toContain('md:table-fixed');
    expect(rows()).toEqual([
      ['TDUSTprivate', 'TDUST', '1.500000', EN['kit.balance.private']],
      ['NIGHTprivate', 'NIGHT', '2.000000', EN['kit.balance.private']],
      ['NIGHTpublic', 'NIGHT', '4.000000', EN['kit.public.label']],
    ]);
    expect(q(table, '[data-row="NIGHTpublic"] [data-slot=public-pill]')).not.toBeNull();
    expect(q(table, '[data-row="NIGHTprivate"] [data-slot=private-pill]')).not.toBeNull();
    const actions = (row: string) => all(table, `[data-row="${row}"] td:last-child [data-hover]`).map((a) => [a.dataset.hover, (q(a, 'button') as HTMLButtonElement).disabled]);
    expect(actions('NIGHTprivate')).toEqual([[EN['vault.money.send'], true], [EN['vault.money.unshield'], true]]);
    expect(actions('NIGHTpublic')).toEqual([[EN['vault.money.send'], true], [EN['vault.money.shield'], true]]);
    expect(q(table, '[data-slot=coming-soon]')).toBeNull();
    /* Each icon is named by its hover text, reached with the keyboard although disabled, and says it is disabled. */
    const send = q(table, '[data-row=NIGHTpublic] td:last-child [data-hover]')!;
    expect([send.tabIndex, send.getAttribute('aria-label'), send.getAttribute('aria-disabled'), q(send, 'button')!.getAttribute('aria-label')]).toEqual([0, EN['vault.money.send'], 'true', EN['vault.money.send']]);
    await act(async () => { fireEvent.focus(send); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-slot=tooltip-content]')?.textContent).toContain(EN['vault.money.send']);
    await act(async () => { fireEvent.blur(send); await new Promise((r) => setTimeout(r, 5)); });
    /* The State column's Public pill explains a balance, not a payment. */
    await act(async () => { fireEvent.click(q(table, '[data-row=NIGHTpublic] [data-slot=public-pill]')!); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-slot=tooltip-content]')?.textContent).toContain(EN['kit.public.explanation.balance']);
    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); });
    expect(all(table, '[data-filter]').map((t) => [t.dataset.filter, q(t, '[data-slot=count-pill]')!.textContent])).toEqual([['all', '3'], ['private', '2'], ['public', '1']]);
    await act(async () => { fireEvent.mouseDown(q(table, '[data-filter=public]')!, { button: 0 }); });
    expect(rows().map((r) => r[0])).toEqual(['NIGHTpublic']);
    await act(async () => { fireEvent.mouseDown(q(table, '[data-filter=private]')!, { button: 0 }); });
    expect(rows().map((r) => r[0])).toEqual(['TDUSTprivate', 'NIGHTprivate']);
    expect(q(c, '[data-part=money] [data-unrecognised]')?.textContent).toBe(EN['vault.publicMoney.unrecognised_other']!.replace('{count}', '2'));
    const refresh = q(c, '[data-part=money] [data-slot=section-actions] [data-hover] [data-action=read-money]')!;
    expect(q(c, '[data-part=money] [data-slot=section-actions] [data-updated]')).not.toBeNull();
    expect(refresh.closest('[data-hover]')!.getAttribute('data-hover')).toBe(EN['vault.money.readAgain']);
    expect(refresh.textContent).toBe('');
    expect(q(c, '[data-part=money] [data-updated]')!.textContent).toBe(EN['vault.money.updated']!.replace('{ago}', 'now'));
    expect(q(c, '[data-part=money] [data-updated]')!.className).toContain('text-muted-foreground');
    state.privateMoney = null;
    state.publicMoney = { amounts: [NIGHT(1_000_000n, 'public')], unrecognised: 0 };
    await act(async () => { fireEvent.click(refresh); await new Promise((r) => setTimeout(r, 5)); });
    await act(async () => { fireEvent.mouseDown(q(c, '[data-part=money] [data-filter=all]')!, { button: 0 }); });
    expect(all(q(c, '[data-part=money]')!, 'tbody tr').map((r) => r.dataset.row)).toEqual(['NIGHTpublic']);
    expect(q(c, '[data-part=money] [data-unreadable=private]')?.textContent).toBe(EN['vault.privateMoney.unreadable']);
    expect(q(c, '[data-part=money] [data-slot=empty-state]')).toBeNull();
  });

  /* RED WHEN: a read that could not read both sides is said as the money just updated. */
  it('says when the money was last read in full, not when a read failed', async () => {
    state.privateMoney = null;
    state.publicMoney = { amounts: [NIGHT(1n, 'public')], unrecognised: 0 };
    const c = await draw('vault', { vault: VAULT });
    await settle();
    expect(q(c, '[data-part=money] [data-updated]')).toBeNull();
  });

  /* RED WHEN: the time since the money was read is not said again as time passes. */
  it('says how long ago the money was read, as time passes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      state.privateMoney = { amounts: [] };
      state.publicMoney = { amounts: [NIGHT(1n, 'public')], unrecognised: 0 };
      const c = await draw('vault', { vault: VAULT });
      await settle();
      await act(async () => { vi.advanceTimersByTime(6 * 60_000); });
      expect(q(c, '[data-part=money] [data-updated]')!.textContent).toBe(EN['vault.money.updated']!.replace('{ago}', '6 minutes ago'));
    } finally {
      vi.useRealTimers();
    }
  });

  /* RED WHEN: a vault holding none of the currencies this app shows says so while a side could not be read, or does not say so when both were read; or an empty tab says the vault holds nothing while another tab holds money. */
  it('says a vault holds none of the currencies shown only when both sides were read and nothing is held', async () => {
    state.privateMoney = { amounts: [] };
    state.publicMoney = { amounts: [], unrecognised: 0 };
    const c = await draw('vault', { vault: VAULT });
    await settle();
    expect(q(c, '[data-part=money] [data-slot=empty-state]')?.textContent).toContain(EN['vaults.money.none']);
    cleanup();
    state.publicMoney = { amounts: [NIGHT(1n, 'public')], unrecognised: 0 };
    const tab = await draw('vault', { vault: VAULT });
    await settle();
    await act(async () => { fireEvent.mouseDown(q(tab, '[data-part=money] [data-filter=private]')!, { button: 0 }); });
    expect(q(tab, '[data-part=money] [data-slot=empty-state]')?.textContent).toContain(EN['vault.money.noneThisWay']);
    expect(q(tab, '[data-part=money] [data-slot=empty-state]')?.textContent).not.toContain(EN['vaults.money.none']);
    cleanup();
    state.publicMoney = null;
    const d = await draw('vault', { vault: VAULT });
    await settle();
    expect(q(d, '[data-part=money] [data-slot=empty-state]')).toBeNull();
    expect(q(d, '[data-part=money] [data-unreadable=public]')?.textContent).toBe(EN['vault.publicMoney.unreadable']);
  });

  /* RED WHEN: Create a vault is not the action on the Vaults page's title line, opening the one create-a-vault component in the right-hand panel; a Create a vault section is still drawn on the page; or the heading Vaults is drawn more than once. */
  it('puts Create a vault on the title line, opening the one component in the panel, and says Vaults once', async () => {
    const c = await draw('vaults');
    await settle();
    const header = q(c, '[data-screen=vaults] [data-slot=page-header]')!;
    expect(q(header, '[data-action=create-vault]')).not.toBeNull();
    expect(q(c, '[data-screen=vaults] [data-action=create-vault-now]')).toBeNull();
    expect(q(c, '[data-part=create-vault]')).toBeNull();
    expect(all(q(c, '[data-screen=vaults]')!, 'h1, h2, h3').filter((h) => h.textContent === EN['page.vaults.name'])).toHaveLength(1);
    await act(async () => { fireEvent.click(q(header, '[data-action=create-vault]')!); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-panel] [data-action=create-vault]')).not.toBeNull();
  });

  /*
   * RED WHEN: a pending vault shows no Pending pill on
   * its tile or its page, the pill is the colour of Coming soon, its hover
   * text is not the standing's phrase, or the long text stays on the tile;
   * pressing it on a vault not finished does not open finishing it in the
   * panel, or follows the tile's link; pressing it on a company not handed
   * over does not open handing it over; the Vaults page does not list each
   * pending vault as a row of its own at the top with its action; or that
   * list is drawn when nothing is pending.
   */
  it('marks a pending vault with the Pending pill, lists it on top, and opens what finishes it', async () => {
    const OTHER = 'cd'.repeat(32);
    state.company = records({ vaults: { of: 'read', value: [vaultOf('handover-owed'), vaultOf('account-not-handed-over', OTHER), vaultOf('held-by-other-keys', 'ef'.repeat(32))] } });
    state.owed = [{ vault: VAULT, number: 1, here: true }];
    const c = await draw('vaults');
    await settle();
    const pill = q(c, `[data-slot=stat-tile][data-vault="${VAULT}"] [data-pending]`)!;
    expect(pill.textContent).toBe(EN['vaults.pending']);
    expect(pill.dataset.variant).toBe('destructive');
    expect(q(c, `[data-slot=stat-tile][data-vault="${VAULT}"]`)!.textContent).not.toContain(EN['vaults.standing.handoverOwed']);
    expect(all(c, '[data-part=vaults-pending] [data-pending-vault]').map((r) => [r.dataset.pendingVault, r.textContent])).toEqual([
      [VAULT, `Vault 1${EN['vaults.standing.handoverOwed']}${EN['createVault.finish']}`],
      [OTHER, `Vault 2${EN['vaults.standing.accountNotHandedOver']}${EN['setup.handOver.button']}`],
      ['ef'.repeat(32), `Vault 3${EN['vaults.standing.heldByOtherKeys']}`],
    ]);
    expect(q(c, '[data-part=vaults-pending]')!.compareDocumentPosition(q(c, '[data-part=vaults]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const before = window.location.pathname;
    await act(async () => { fireEvent.click(pill); await new Promise((r) => setTimeout(r, 5)); });
    expect(window.location.pathname).toBe(before);
    expect(document.querySelector('[data-panel] [data-action=create-vault] [data-slot=confirm-in-your-account]')).not.toBeNull();
    cleanup();
    const again = await draw('vaults');
    await settle();
    await act(async () => { fireEvent.click(q(again, `[data-vault="${OTHER}"] [data-pending]`)!); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-panel] [data-action=hand-over]')).not.toBeNull();
    cleanup();
    const explain = await draw('vaults');
    await settle();
    await act(async () => { fireEvent.click(q(explain, `[data-vault="${'ef'.repeat(32)}"] [data-pending]`)!); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-slot=tooltip-content]')?.textContent).toContain(EN['vaults.standing.heldByOtherKeys']);
    expect(document.querySelector('[data-panel]')).toBeNull();
    cleanup();
    const rowsPress = await draw('vaults');
    await settle();
    await act(async () => { fireEvent.click(q(rowsPress, `[data-pending-vault="${VAULT}"] [data-action=finish-handover]`)!); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-panel] [data-action=create-vault] [data-slot=confirm-in-your-account]')).not.toBeNull();
    cleanup();
    const rowsHand = await draw('vaults');
    await settle();
    await act(async () => { fireEvent.click(q(rowsHand, `[data-pending-vault="${OTHER}"] [data-action=hand-over]`)!); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-panel] section[data-action=hand-over]')).not.toBeNull();
    cleanup();
    const page = await draw('vault', { vault: VAULT });
    await settle();
    expect(q(page, '[data-screen=vault] [data-pending]')?.textContent).toBe(EN['vaults.pending']);
    expect(q(page, '[data-screen=vault] [data-standing]')).toBeNull();
    await act(async () => { fireEvent.click(q(page, '[data-screen=vault] [data-pending]')!); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-panel] [data-action=create-vault] [data-slot=confirm-in-your-account]')).not.toBeNull();
    cleanup();
    state.company = records();
    const quiet = await draw('vaults');
    await settle();
    expect(q(quiet, '[data-part=vaults-pending]')).toBeNull();
    expect(q(quiet, '[data-pending]')).toBeNull();
  });

  /* RED WHEN: a standing phrase says as a fact about the vault that no money can go in, or the vault-created line leaves out that this app puts money in only once the company is handed over. */
  it('says only that this app puts no money in, and says the company account must be handed over too', () => {
    for (const k of ['notFundable', 'accountNotHandedOver', 'accountNotFundable', 'heldByOtherKeys']) {
      expect(EN[`vaults.standing.${k}`], k).not.toMatch(/no money can go/i);
      expect(EN[`vaults.standing.${k}`], k).toMatch(/this app puts no money|it puts no money/i);
    }
    expect(EN['createVault.done']).toMatch(/only once your company is handed to its signers/);
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
