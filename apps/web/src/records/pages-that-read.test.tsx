// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom, privateAmount, publicAmount } from 'vaults-ui';
import type { Company, CompanyRecords, PersonRow, ProposalRow, RunLeg, RunRow, VaultRow, VendorRow } from '../adapters/company-records.js';
import { untilPageShown, untilShown } from '../page-shown.test-support.js';
import { ENGLISH } from '../english.test-support.js';
import { proposalsNotRead } from './counts.js';

/*
 * THE COMPANY PAGES THAT READ, DRAWN IN THE FRAME at their own addresses,
 * over records handed to them as the adapter hands them: what each page shows,
 * what it marks public, what it says when a read failed, and that every action
 * not built yet is shown, disabled, with nothing beside it or on hover.
 */
const state = vi.hoisted(() => ({
  company: null as unknown, handover: { of: 'held' } as unknown, publicMoney: null as unknown, privateMoney: null as unknown,
  opened: 0, names: new Map<string, string>(), ready: { of: 'ready' } as unknown,
  /* The companies whose pages say they are open, as the adapter is told. */
  pagesOpen: [] as string[],
  /* The name the company filed for a vault, and each vault a name was asked for. */
  vaultName: null as string | null, namesAsked: [] as string[],
  /* What the creation adapter says of the company: nothing known, so not confirmed finished; and a gate a test holds the read at. */
  creation: { company: 'c-1', standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null } as unknown,
  creationGate: null as Promise<void> | null,
  /* Each press that reached the wallet's acts (the act, then what it was asked), and what the wallet's act came to. */
  payActed: { of: 'done', state: 'paid', paid: 2, owed: 0, unseen: 0 } as unknown, retried: { of: 'done', state: 'raised', approvals: 1, needed: 2 } as unknown, acts: [] as unknown[][], acted: { of: 'done', state: 'approved', approvals: 2, needed: 2 } as unknown,
}));
vi.mock('../adapters/creation-standing.js', async (real) => ({
  ...(await real<typeof import('../adapters/creation-standing.js')>()),
  creationOf: async () => { if (state.creationGate !== null) await state.creationGate; return state.creation; },
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => state.company,
  openWithYourAccount: async () => { state.opened += 1; return { of: 'done' }; },
  companyPagesOpen: (id: string) => { state.pagesOpen.push(id); return () => { state.pagesOpen.splice(state.pagesOpen.lastIndexOf(id), 1); }; },
  readVaultPublicMoney: async () => state.publicMoney,
  readVaultName: async (_person: string, _company: string, vault: string) => { state.namesAsked.push(vault); return state.vaultName; },
}));
vi.mock('../adapters/proposal-acts.js', async (real) => ({
  ...(await real<typeof import('../adapters/proposal-acts.js')>()),
  approveProposal: async (...args: unknown[]) => { state.acts.push(['approve', ...args]); return state.acted; },
  withdrawProposal: async (...args: unknown[]) => { state.acts.push(['withdraw', ...args]); return state.acted; },
  changeThreshold: async (...args: unknown[]) => { state.acts.push(['change-threshold', ...args]); return state.acted; },
  payRun: async (...args: unknown[]) => { state.acts.push(['pay-run', ...args]); return state.payActed; },
  retryRun: async (...args: unknown[]) => { state.acts.push(['retry-run', ...args]); return state.retried; },
}));
vi.mock('../adapters/handover-state.js', async (real) => ({
  ...(await real<typeof import('../adapters/handover-state.js')>()),
  readHandover: async () => state.handover,
}));
vi.mock('../adapters/create-vault.js', async (real) => ({
  ...(await real<typeof import('../adapters/create-vault.js')>()),
  readVaultReadiness: async () => state.ready,
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
const { PAID_STATE } = await import('../adapters/company-records.js');
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
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const VAULT = 'ab'.repeat(32);

/** The token a run's fixture pays: compared by the screens, and never shown. */
const NIGHT_TOKEN = '00'.repeat(32);
const NIGHT = (units: bigint, how: 'private' | 'public') => (how === 'private' ? privateAmount(units, 6, 'NIGHT') : publicAmount(units, 6, 'NIGHT'));
/** What a leg carries beyond its token, vault and people: its proposal, how it is paid, whom it pays, and who is paid what. */
const LEG_MORE = {
  proposal: 'p1' as string | null, form: 'shielded' as 'shielded' | 'unshielded' | null, list: 'employees' as const, people: 2, total: 7_000_000n,
  /* What the chain shows paid of the leg, as the adapter reads it on this device: none of it yet. */
  paidOnChain: 0 as 0 | 1 | 2 | undefined,
  pays: [{ name: 'Ana', address: 'mn_shield-addr_ana', amount: privateAmount(5_000_000n, 6, 'NIGHT') }, { name: 'Bo', address: 'mn_shield-addr_bo', amount: privateAmount(2_000_000n, 6, 'NIGHT') }],
};
const RUN: RunRow = {
  id: 'r1', period: '2026-10', paidOnChain: PAID_STATE.none,
  payees: [
    { id: 'e1', name: 'Ana', amount: NIGHT(5_000_000n, 'private'), paid: 'privately' },
    { id: 'e2', name: 'Bo', amount: NIGHT(2_000_000n, 'public'), paid: 'publicly' },
    { id: 'e3', name: 'Cy', amount: NIGHT(1_000_000n, 'public'), paid: 'not-known' },
  ],
  currencies: [{ code: NIGHT_TOKEN, symbol: 'NIGHT', privately: NIGHT(5_000_000n, 'private'), publicly: NIGHT(2_000_000n, 'public') }],
  legs: [{ ...LEG_MORE, code: `${NIGHT_TOKEN}:shielded`, asset: NIGHT_TOKEN, symbol: 'NIGHT', paid: 'privately', vault: VAULT, payees: 2 }], unrecognised: 0,
};
/* Paid out of another vault, so a vault's payouts are told apart from every run's. */
const PAID_RUN: RunRow = { ...RUN, id: 'r0', period: '2026-09', paidOnChain: PAID_STATE.all, legs: [{ ...LEG_MORE, paidOnChain: PAID_STATE.all, code: `${NIGHT_TOKEN}:shielded`, asset: NIGHT_TOKEN, symbol: 'NIGHT', paid: 'privately', vault: 'cd'.repeat(32), payees: 2 }] };
const PROPOSALS: ProposalRow[] = [
  { id: 'p9', kind: 'something new' as ProposalRow['kind'], status: 'open', raisedBy: 'Sam', approvals: 0, needed: null, raisedAt: '2026-09-19T00:00:00.000Z', pays: null },
  { id: 'p1', kind: 'payroll', status: 'open', raisedBy: 'Sam', approvals: 1, needed: 2, raisedAt: '2026-09-21T00:00:00.000Z', pays: { run: 'r1', period: '2026-10', asset: NIGHT_TOKEN, symbol: 'NIGHT', paid: 'privately' } },
  { id: 'p2', kind: 'add-signer', status: 'executed', raisedBy: null, approvals: 2, needed: null, raisedAt: '2026-09-20T00:00:00.000Z', pays: null },
];
/** What a person's row carries beyond the list's columns: the token, the classification and dates in force, the history lines and how they are admitted. */
const MORE: Omit<PersonRow, 'id' | 'name' | 'title' | 'standing' | 'pay' | 'paid' | 'startedAt'> = {
  asset: NIGHT_TOKEN, classification: 'full-time', endDate: null, leavingDate: null, pays: [], classifications: [], admittedAt: null, admitBy: 'fingerprint', notPayable: null,
};
const PEOPLE: PersonRow[] = [
  { id: 'e1', name: 'Ana', title: 'Engineer', standing: 'active', pay: NIGHT(5_000_000n, 'private'), paid: 'privately', startedAt: '2026-01-01', ...MORE },
  { id: 'e5', name: 'Eve', title: 'Writer', standing: 'waiting-for-check', pay: NIGHT(1n, 'public'), paid: 'not-set-up', startedAt: '2026-03-01', ...MORE },
];
const VENDORS: VendorRow[] = [{
  id: 'ven_aa', name: 'Vee', address: null, standing: 'active', handedOver: false, termsKind: 'monthly', asset: NIGHT_TOKEN, monthly: NIGHT(2_000_000n, 'public'), paid: 'publicly', startedAt: '2026-02-01',
  endDate: null, admittedAt: null, admitBy: 'fingerprint', notPayable: null,
}];
const records = (over: Partial<CompanyRecords> = {}): Company => ({
  of: 'open', id: 'c-1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }], approvalsNeeded: { of: 'read', value: 1 },
  proposals: { of: 'read', value: PROPOSALS }, runs: { of: 'read', value: [RUN, PAID_RUN] }, people: { of: 'read', value: PEOPLE },
  peopleBelief: { of: 'read', value: { rows: PEOPLE, notBelieved: [], notPayable: [], refused: [] } },
  vendorsBelief: { of: 'read', value: { vendors: VENDORS, rows: VENDORS, notBelieved: [], notPayable: [] } },
  /* Nobody to be paid is a vendor here: the People step stands on the vendors read, and the vendors page on the belief. */
  vendors: { of: 'read', value: { vendors: [], rows: [], notBelieved: [], notPayable: [] } },
  vaults: { of: 'read', value: [{ vault: VAULT, createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee' }] },
  invitations: { of: 'read', value: [{ kind: 'signer', name: 'Tom', sentAt: '2026-09-10T00:00:00.000Z', expiresAt: null }, { kind: 'employee', name: null, sentAt: '2026-09-11T00:00:00.000Z', expiresAt: '2026-10-11T00:00:00.000Z' }, { kind: 'vendor', name: 'Vik', sentAt: '2026-09-12T00:00:00.000Z', expiresAt: null }] },
  ...over,
});

type Id = keyof typeof PAGES;
/** Draw a page in the frame, and read nothing yet. */
function drawNow(id: Id, params: Record<string, string> = {}) {
  window.history.replaceState(null, '', addressOf(id, params));
  const session = {
    person: { id: 'u1', name: 'Priya' }, companies: [{ id: 'c-1', createdAt: '2026-09-01T00:00:00.000Z', signers: 1 }], company: 'c-1',
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
const inFooter = (sel: string) => document.querySelector(`[data-panel] [data-slot=sheet-footer] ${sel}`) as HTMLElement | null;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.company = records(); state.handover = { of: 'held' }; state.publicMoney = null; state.privateMoney = { of: 'unreadable', why: 'chain' }; state.opened = 0; state.names = new Map(); state.ready = { of: 'ready' }; state.vaultName = null; state.namesAsked = [];
  skippedFor('c-1').clear(); window.sessionStorage.clear(); takeAsked();
  state.creation = { company: 'c-1', standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null }; state.creationGate = null;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('every page that reads is built, at its own address', () => {
  /* RED WHEN: a page that reads shows Coming soon, or its screen is not the one its address opens. */
  it.each([
    ['home', {}], ['proposals', {}], ['payroll', {}], ['run', { run: 'r1' }], ['vaults', {}], ['vault', { vault: VAULT }], ['people', {}], ['vendors', {}], ['invitations', {}],
  ] as const)('%s', async (id, params) => {
    const c = await draw(id, params);
    expect(q(c, '[data-screen=coming-soon]')).toBeNull();
    expect(q(c, `[data-page-body] [data-screen=${id}]`)).not.toBeNull();
    expect(q(c, `[data-menu-page=${id === 'run' ? 'payroll' : id === 'vault' ? 'vaults' : id}] [data-slot=coming-soon]`)).toBeNull();
  });

  /*
   * RED WHEN: an action these pages do not do yet (starting a run,
   * withdrawing an invitation, checking a
   * fingerprint, exporting) is hidden, or can be pressed, or has a Coming soon
   * pill beside it, or shows anything on hover; or a Coming soon pill sits
   * among a page's actions instead of in a heading, a tab or a line of text;
   * or creating a vault, or depositing and checking the last deposit, which are built, are still shown Coming soon anywhere.
   */
  it('shows every action not built yet, disabled, with nothing beside it or on hover', async () => {
    /* Each page's own actions not built yet, so one hidden on one page is not covered by the same action drawn on another. */
    const EACH: Record<string, string[]> = {
      home: [], proposals: [], payroll: [], run: ['export-run'],
      vault: [], people: ['payslips'], invitations: ['withdraw'],
    };
    const seen = new Set<string>();
    for (const [id, params] of [['home', {}], ['proposals', {}], ['payroll', {}], ['run', { run: 'r1' }], ['vault', { vault: VAULT }], ['people', {}], ['invitations', {}]] as const) {
      const c = await draw(id, params);
      /* The actions in a proposal's and a person's panel are drawn once the panel is open. */
      if (id === 'proposals') await act(async () => { fireEvent.click(q(c, '[data-screen=proposals] tbody tr[data-row=p1]')!); });
      if (id === 'people') await act(async () => { fireEvent.click(q(c, '[data-screen=people] tbody tr[data-row]')!); });
      const soon = all(document.body, '[data-soon]');
      expect([...new Set(soon.map((s) => s.dataset.action!))].sort(), id).toEqual(EACH[id]);
      for (const s of soon) {
        const at = `${id} ${s.dataset.action}`;
        expect([s.tagName, s.hasAttribute('disabled')], at).toEqual(['BUTTON', true]);
        expect(q(s.parentElement!, ':scope > [data-slot=coming-soon]'), at).toBeNull();
        expect([s.closest('[title]'), s.getAttribute('aria-describedby'), s.closest('[data-state=closed], [data-state=delayed-open], [data-state=instant-open]'), s.closest('[data-slot$=-trigger]')], at).toEqual([null, null, null, null]);
        seen.add(s.dataset.action!);
      }
      for (const pill of all(c, '[data-screen] [data-slot=coming-soon]')) {
        expect(pill.closest('[data-slot=section-actions], [data-slot=section-row-actions], [data-slot=page-header] > :last-child:not(:first-child), td'), id).toBeNull();
        expect(q(pill.parentElement!, ':scope > button:not([data-slot=coming-soon])'), id).toBeNull();
      }
      cleanup();
    }
    expect([...seen].sort()).toEqual(['export-run', 'payslips', 'withdraw']);
    const vaults = await draw('vaults');
    expect(all(vaults, '[data-soon]')).toEqual([]);
    state.creation = { company: 'c-1', standing: 'finished', awaitingSecondPress: false, kept: false, confirmedFinished: true, mark: null };
    await act(async () => { fireEvent.click(q(vaults, '[data-action=create-vault]')!); await new Promise((r) => setTimeout(r, 5)); });
    /* A company confirmed finished, a name typed: only then can Create be pressed. */
    expect((document.querySelector('[data-panel] [data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.change(document.querySelector('[data-panel] [data-field=vault-name]')!, { target: { value: 'Payroll UK' } }); await new Promise((r) => setTimeout(r, 5)); });
    expect((document.querySelector('[data-panel] [data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('home', () => {
  /*
   * RED WHEN: the setup card leaves out a step not done, lists one that is
   * done, shows a skipped step as done or not as skipped, or its button does
   * not open the wizard at that step (or, for a step the company's unfinished
   * creation blocks, is not shown shut with its reason and a lead to the step that blocks it); or the card shows when every
   * step is done.
   */
  it('shows the setup card with the steps left, a skipped one marked, each opening the wizard at it', async () => {
    skipStep('c-1', 'signers');
    state.company = records({ vaults: { of: 'read', value: [] }, people: { of: 'read', value: [] }, invitations: { of: 'read', value: [] } });
    const c = await draw('home');
    expect(all(c, '[data-part=setup-card] [data-step]').map((e) => [e.dataset.step, e.dataset.standing])).toEqual([
      ['finishCompany', 'open'], ['signers', 'skipped'], ['vault', 'open'], ['people', 'open'],
    ]);
    expect(q(c, '[data-part=setup-card] [data-step=signers] [data-skipped]')?.textContent).toBe(EN['setup.skipped']);
    expect(q(c, '[data-steps-left]')!.dataset.stepsLeft).toBe('4');
    /* RED WHEN: a step the unfinished creation blocks has a live Open that silently opens another step, or no reason, or no lead to the blocking step. */
    for (const blocked of ['vault', 'signers']) {
      const row = `[data-part=setup-card] [data-step=${blocked}]`;
      const open = q(c, `${row} [data-action=open-step]`) as HTMLButtonElement;
      expect(open.disabled).toBe(true);
      expect(open.getAttribute('aria-describedby')).toBe(q(c, `${row} [data-why-disabled]`)!.id);
      expect(q(c, `${row} [data-why-disabled]`)!.textContent).toBe(EN['setup.blocked']!.replace('{step}', EN['setup.step.finishCompany.name']!));
    }
    fireEvent.click(q(c, '[data-part=setup-card] [data-step=vault] [data-lead-to=finishCompany]')!);
    expect(window.location.pathname).toBe(PAGES.setup.path);
    expect(takeAsked()).toEqual({ step: 'finishCompany', newCompany: false });
    fireEvent.click(q(c, '[data-part=setup-card] [data-step=signers] [data-lead-to=finishCompany]')!);
    expect(takeAsked()).toEqual({ step: 'finishCompany', newCompany: false });
    /* The step that blocks is not itself blocked: its Open is live. */
    expect(q(c, '[data-part=setup-card] [data-step=finishCompany] [data-lead-to]')).toBeNull();
    fireEvent.click(q(c, '[data-part=setup-card] [data-step=finishCompany] [data-action=open-step]')!);
    expect(takeAsked()).toEqual({ step: 'finishCompany', newCompany: false });
  });

  /*
   * RED WHEN: "Finish creating the company" stays on the card once the creation adapter confirms the company finished, or is
   * missing from it before; or a step it blocked still opens the blocking step after; or the card is drawn, saying the company
   * is unfinished, before the adapter has said which.
   */
  it('lists "Finish creating the company" only while the company is unfinished, and opens each step at itself once it is done', async () => {
    state.company = records({ vaults: { of: 'read', value: [] }, people: { of: 'read', value: [] }, invitations: { of: 'read', value: [] } });
    let release = (): void => {};
    state.creationGate = new Promise<void>((r) => { release = r; });
    const reading = drawNow('home');
    await settle();
    expect(q(reading, '[data-part=setup-card]')).toBeNull();
    release();
    await untilShown(() => q(reading, '[data-part=setup-card]'), 'the setup card');
    expect(all(reading, '[data-part=setup-card] [data-step]').map((e) => e.dataset.step)).toEqual(['finishCompany', 'signers', 'vault', 'people']);
    cleanup();
    state.creationGate = null;
    state.creation = { company: 'c-1', standing: 'finished', awaitingSecondPress: false, kept: false, confirmedFinished: true, mark: null };
    const c = await draw('home');
    await untilShown(() => q(c, '[data-part=setup-card]'), 'the setup card');
    expect(all(c, '[data-part=setup-card] [data-step]').map((e) => e.dataset.step)).toEqual(['signers', 'vault', 'people']);
    fireEvent.click(q(c, '[data-part=setup-card] [data-step=vault] [data-action=open-step]')!);
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
    expect(all(card, '[data-slot=progress-mark]').map((m) => m.dataset.filled)).toEqual(['true', 'false', 'false', 'true', 'true']);
    expect(q(card, '[data-steps-done]')!.textContent).toBe('3 of 5 steps done');
    fireEvent.click(q(card, '[data-action=fold-setup]')!);
    expect(q(c, '[data-part=setup-card] [data-step]')).toBeNull();
    expect(q(c, '[data-part=setup-card] [data-slot=progress]')).not.toBeNull();
    expect(q(c, '[data-action=fold-setup]')!.getAttribute('aria-expanded')).toBe('false');
    cleanup();
    const again = await draw('home');
    expect(q(again, '[data-part=setup-card]')!.hasAttribute('data-folded')).toBe(true);
    expect(q(again, '[data-part=setup-card] [data-step]')).toBeNull();
    fireEvent.click(q(again, '[data-action=fold-setup]')!);
    expect(all(again, '[data-part=setup-card] [data-step]').length).toBe(2);
    window.localStorage.clear();
  });

  /*
   * RED WHEN: pending approval loses its proposals or its people section, a
   * section its count or its actions, or an action not built yet (creating
   * inviting, letting a person in) is missing,
   * pressable, or has a Coming soon pill beside it; inviting is not called
   * Invite; or View all does not go to Proposals.
   */
  it('shows pending approval: proposals and people, with their counts and actions', async () => {
    const c = await draw('home');
    const pending = q(c, '[data-part=pending-approval]')!;
    expect(q(pending, 'h2')!.textContent).toBe(EN['home.pendingApproval']);
    const proposals = q(pending, '[data-part=proposals-waiting]')!;
    expect(q(proposals, '[data-slot=section-header] h2')!.textContent).toBe(EN['page.proposals.name']);
    expect(q(proposals, '[data-slot=section-actions] button[data-action=create-menu]')!.textContent).toBe(EN['home.proposals.create']);
    expect(q(proposals, '[data-slot=section-actions] [data-action=view-all-proposals]')!.getAttribute('href')).toBe(PAGES.proposals.path);
    /* A payroll run and a kind this app does not know cannot be approved from the list, so no row offers Approve, and none offers Decline. */
    for (const row of all(proposals, '[data-proposal]')) {
      expect(all(row, 'button').map((b) => b.dataset.action), row.dataset.proposal).toEqual([]);
    }
    const people = q(pending, '[data-part=people-waiting]')!;
    expect(q(people, '[data-slot=count-pill]')!.textContent).toBe('1');
    const invite = q(people, '[data-slot=section-actions] button[data-action=invite]')!;
    expect([invite.textContent, invite.hasAttribute('disabled'), invite.hasAttribute('data-soon')]).toEqual([EN['people.invite'], false, false]);
    expect(EN['people.invite']).toBe('Invite');
    expect(q(pending, '[data-slot=coming-soon]')).toBeNull();
    expect(q(people, '[data-person=e5] button[data-action=check-fingerprint]')!.hasAttribute('disabled')).toBe(false);
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

  /* RED WHEN: Home's New run, shown while there is no run, is disabled or does nothing, or opens anything but the run form in the panel. */
  it('opens the run form in the panel from the New run on Home', async () => {
    state.company = records({ runs: { of: 'read', value: [] } });
    const c = await draw('home');
    const button = q(c, '[data-part=next-run] [data-action=new-run]')!;
    expect(button.hasAttribute('disabled')).toBe(false);
    await act(async () => { fireEvent.click(button); await new Promise((r) => setTimeout(r, 5)); });
    expect(all(document.body, '[data-panel] [data-action=raise-run-panel]')).toHaveLength(1);
    expect(q(document.body, '[data-panel]')!.textContent).toContain(EN['raiseRun.title']);
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

  /* RED WHEN: a step the application knows is done stays on the card; or a vault not yet held by the super admins, or vaults that could not be read, take the vault step off it. */
  it('leaves a done step off the card', async () => {
    const c = await draw('home');
    expect(all(c, '[data-part=setup-card] [data-step]').map((e) => e.dataset.step)).toEqual(['finishCompany', 'signers']);
    for (const vaults of [{ of: 'read', value: [{ vault: VAULT, createdAt: '2026-09-01T00:00:00.000Z', standing: 'start-owed' }] }, { of: 'unreadable' }] as const) {
      cleanup();
      state.company = records({ vaults: vaults as CompanyRecords['vaults'] });
      const again = await draw('home');
      expect(all(again, '[data-part=setup-card] [data-step]').map((e) => e.dataset.step), vaults.of).toEqual(['finishCompany', 'signers', 'vault']);
    }
  });

  /*
   * RED WHEN: the card lists People for a company that has somebody invited (an employee invitation waiting, or a person held)
   * or leaves it off for one that has not (nobody, or only an invitation for a signer): it must say what the wizard says, from the
   * same records.
   */
  it('lists People on the card until somebody to be paid is invited, as the wizard says it', async () => {
    const waiting = (kind: string) => ({ kind, name: null, sentAt: '2026-09-11T00:00:00.000Z', expiresAt: null });
    const stepsOn = async (over: Partial<CompanyRecords>) => {
      cleanup();
      state.company = records({ vaults: { of: 'read', value: [] }, ...over });
      const c = await draw('home');
      return all(c, '[data-part=setup-card] [data-step]').map((e) => e.dataset.step);
    };
    const nobody = { people: { of: 'read', value: [] }, invitations: { of: 'read', value: [] } } as const;
    expect(await stepsOn({ ...nobody })).toContain('people');
    expect(await stepsOn({ ...nobody, invitations: { of: 'read', value: [waiting('signer')] } as CompanyRecords['invitations'] })).toContain('people');
    expect(await stepsOn({ ...nobody, invitations: { of: 'read', value: [waiting('employee')] } as CompanyRecords['invitations'] })).not.toContain('people');
    expect(await stepsOn({ invitations: { of: 'read', value: [] } })).not.toContain('people');
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
    state.company = records({ runs: { of: 'read', value: [{ ...RUN, id: 'r2', period: '2026-11' }, RUN] } });
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

  it('says the company\'s pages are open while they are on screen, and gone once they are left', async () => {
    state.company = { of: 'locked' };
    state.pagesOpen = [];
    const c = await draw('home');
    /* RED WHEN: the company's pages do not say they are open, so opening the saved keys there cannot name the company. */
    expect(q(c, '[data-records=locked]')).not.toBeNull();
    expect(state.pagesOpen.length > 0 && state.pagesOpen.every((id) => id === state.pagesOpen[0])).toBe(true);
    cleanup();
    /* RED WHEN: leaving the company's pages leaves them said to be open, so the open press elsewhere names the company. */
    expect(state.pagesOpen).toEqual([]);
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
   * waiting, Approved not those approved or done), the proposals are not in
   * the kit's table or its tabs are not the kit's tabs across the top,
   * Declined is hidden or offered as if it worked, or a row's panel offers
   * Approve or Decline as if they worked.
   */
  /* RED WHEN: a proposal whose raiser's roster entry this device does not believe is shown as raised by a signer no longer listed, or with no word of why. */
  it('names a raiser this device does not believe, with why, apart from one no longer listed', async () => {
    state.company = records({ proposals: { of: 'read', value: [{ ...PROPOSALS[1]!, raiserNotBelieved: 'seat-not-on-the-chain' }, PROPOSALS[2]!] } });
    const c = await draw('proposals');
    expect(q(c, '[data-row=p1] [data-raiser-not-believed]')?.textContent).toBe(EN['proposals.raisedBy.notSeated']!.replace('{name}', 'Sam'));
    expect(q(c, '[data-row=p2]')?.textContent).toContain(EN['proposals.raisedBy.unknown']);
    expect(q(c, '[data-row=p2] [data-raiser-not-believed]')).toBeNull();
    cleanup();
    state.company = records({ proposals: { of: 'read', value: [{ ...PROPOSALS[1]!, raisedBy: null, raiserNotBelieved: 'not-their-signing-key' }] } });
    const refused = await draw('proposals');
    /* RED WHEN: a raiser whose entry did not check out is said as a signer no longer listed, or by a name nothing vouches for. */
    expect(q(refused, '[data-row=p1] [data-raiser-not-believed]')?.textContent).toBe(EN['proposals.raisedBy.notAsSigned']);
  });

  /* RED WHEN: a raiser whose seat was retired is said the same as one whose seat the chain does not show, or either is said as seated. */
  it('says a raiser whose seat was retired apart from one whose seat the chain does not show', async () => {
    state.company = records({ proposals: { of: 'read', value: [{ ...PROPOSALS[1]!, raiserNotBelieved: 'seat-retired' }] } });
    const retired = await draw('proposals');
    expect(q(retired, '[data-row=p1] [data-raiser-not-believed]')?.textContent).toBe(EN['proposals.raisedBy.retired']!.replace('{name}', 'Sam'));
    expect(EN['proposals.raisedBy.retired']).not.toBe(EN['proposals.raisedBy.notSeated']);
  });

  /* RED WHEN: a proposal left out of the list for its key is not said to be left out, or is counted as waiting, or a status the chain never gives still has a word. */
  it('says how many proposals were not read, and has no word for a status the chain does not give', async () => {
    const gone = (id: string): ProposalRow => ({ id, kind: 'unreadable', status: 'unreadable', raisedBy: null, approvals: 0, needed: null, raisedAt: '', pays: null });
    const mixed = [PROPOSALS[1]!, gone('u1'), gone('u2')];
    state.company = records({ proposals: { of: 'read', value: mixed } });
    const c = await draw('proposals');
    expect(q(c, '[data-proposals-not-read]')?.textContent).toBe(EN['proposals.someNotRead_other']!.replace('{count}', '2'));
    expect(proposalsNotRead(mixed)).toBe(2);
    cleanup();
    state.company = records({ proposals: { of: 'read', value: [PROPOSALS[1]!] } });
    expect(q(await draw('proposals'), '[data-proposals-not-read]')).toBeNull();
    expect(EN['proposals.status.rejected']).toBeUndefined();
    expect(EN['proposals.status.blocked']).toBeUndefined();
  });

  /* RED WHEN: a payment is called private from its address or its form alone, in a proposal, a run total or a payee's line. */
  it('says a shielded payment as shielded, never as private', async () => {
    for (const key of ['proposals.kind.payRunPrivately', 'proposals.kind.payRunPrivatelyUnknownToken', 'payroll.runTotal.privately', 'records.paid.privately']) {
      expect(EN[key]!.toLowerCase()).not.toMatch(/private/u);
    }
  });

  /* RED WHEN: a vault's adoption, its first secret or the pay-record key is said as a change to the company, or a proposal this device did not read is given a status or a count. */
  it('says what each of the three proposals setting a company up does, and a proposal not read as not read', async () => {
    const row = (id: string, kind: string, status: string): ProposalRow => ({ id, kind, status, raisedBy: 'Sam', approvals: 1, needed: 1, raisedAt: '2026-10-21T00:00:00.000Z', pays: null }) as ProposalRow;
    state.company = records({ proposals: { of: 'read', value: [
      row('k1', 'adopt-vault', 'executed'), row('k2', 'vault-secret', 'approved'), row('k3', 'pay-key', 'executed'),
      { ...row('k4', 'unreadable', 'unreadable'), raisedBy: null, approvals: 0, needed: null },
    ] } });
    const c = await draw('proposals');
    expect(['k1', 'k2', 'k3', 'k4'].map((id) => q(c, `[data-row=${id}] td [data-slot=data-table-value]`)?.textContent)).toEqual([
      EN['proposals.kind.adoptVault'], EN['proposals.kind.vaultSecret'], EN['proposals.kind.payKey'], EN['proposals.kind.unreadable'],
    ]);
    expect(['k1', 'k2', 'k4'].map((id) => q(c, `[data-row=${id}] [data-status]`)?.textContent)).toEqual([
      EN['proposals.status.executed'], EN['proposals.status.approved'], EN['proposals.status.unreadable'],
    ]);
    expect([q(c, '[data-row=k2] [data-approvals]')?.textContent, q(c, '[data-row=k4] [data-approvals]')?.textContent]).toEqual(['1 of 1', EN['proposals.approvals.notRead']]);
  });

  /* RED WHEN: a run closed past its window, or closed by calls not read, is said as withdrawn, or as not read. */
  it('says a run nobody withdrew, closed past its window or closed in a way not read, in its own words, apart from one withdrawn', async () => {
    const row = (id: string, status: string): ProposalRow => ({ id, kind: 'payroll', status, raisedBy: 'Sam', approvals: 1, needed: 2, raisedAt: '2026-10-21T00:00:00.000Z', pays: null }) as ProposalRow;
    state.company = records({ proposals: { of: 'read', value: [row('w1', 'cancelled'), row('e1', 'expired'), row('c1', 'closed')] } });
    const c = await draw('proposals');
    expect(['w1', 'e1', 'c1'].map((id) => q(c, `[data-row=${id}] [data-status]`)?.textContent)).toEqual([
      EN['proposals.status.cancelled'], EN['proposals.status.expired'], EN['proposals.status.closed'],
    ]);
    expect(new Set([EN['proposals.status.cancelled'], EN['proposals.status.expired'], EN['proposals.status.closed'], EN['proposals.status.unreadable']]).size).toBe(4);
  });

  it('filters by the kit\'s table\'s tabs, with no Declined tab, and opens a proposal\'s panel', async () => {
    const c = await draw('proposals');
    const rowsShown = () => all(c, '[data-screen=proposals] [data-slot=data-table] tbody tr').map((e) => e.dataset.row);
    expect(q(c, '[data-screen=proposals] [data-slot=data-table] [data-slot=tabs-list]')).not.toBeNull();
    expect(all(c, '[data-slot=tabs-trigger]').map((e) => e.dataset.filter)).toEqual(['all', 'pending', 'approved']);
    expect(all(c, '[data-slot=tabs-trigger]').map((e) => e.hasAttribute('data-disabled'))).toEqual([false, false, false]);
    expect(rowsShown()).toEqual(['p1', 'p2', 'p9']);
    /* A kind this app does not know is said as a change to the company, never as nothing. */
    expect(q(c, '[data-row=p9] td [data-slot=data-table-value]')?.textContent).toBe(EN['proposals.kind.other']);
    await act(async () => { fireEvent.mouseDown(q(c, '[data-filter=pending]')!, { button: 0 }); });
    expect(rowsShown()).toEqual(['p1', 'p9']);
    await act(async () => { fireEvent.mouseDown(q(c, '[data-filter=approved]')!, { button: 0 }); });
    expect(rowsShown()).toEqual(['p2']);
    expect(q(c, '[data-filter=declined]')).toBeNull();
    expect(q(c, '[data-row=p2] [data-approvals]')?.textContent).toBe('2 approvals');
    expect(q(c, '[data-row=p2] td [data-slot=data-table-value]')?.textContent).toBe(EN['proposals.kind.addSigner']);
    await act(async () => { fireEvent.mouseDown(q(c, '[data-filter=all]')!, { button: 0 }); });
    expect(q(c, '[data-row=p1] [data-approvals]')?.textContent).toBe('1 of 2');
    /* RED WHEN a private payment proposal is not said as the private payments of its run. */
    expect(q(c, '[data-row=p1] td [data-slot=data-table-value]')?.textContent).toBe('Pay the shielded payments of the October 2026 run in NIGHT');
    await act(async () => { fireEvent.click(q(c, '[data-row=p1] td:last-child')!); });
    const panel = document.querySelector('[data-proposal-panel=p1]') as HTMLElement;
    /* A payroll run's proposal the list carries nothing of for the wallet cannot be approved from it, so the panel says so; it was raised by another signer, and a run may be withdrawn by any seated signer, so it offers Withdraw, and nothing is Decline. */
    expect(all(document.body, '[data-panel] button[data-action]').map((e) => e.dataset.action)).toEqual(['withdraw']);
    expect(q(panel, '[data-approve-not-here]')!.textContent).toBe(EN['proposals.approve.notHere']);
    expect(q(panel, '[data-soon]')).toBeNull();
    expect(q(panel, '[data-slot=coming-soon]')).toBeNull();
  });

  const PAY_KEY: ProposalRow = { id: 'pk1', kind: 'pay-key', status: 'open', raisedBy: 'Priya', approvals: 0, needed: 2, raisedAt: '2026-10-22T00:00:00.000Z', pays: null };
  const press = async (sel: string) => { await act(async () => { fireEvent.click(q(document.body, sel)!); await new Promise((r) => setTimeout(r, 5)); }); };

  /* RED WHEN: Approve in the panel asks the wallet for anything but the proposal pressed, or a proposal that is not waiting is offered it. */
  it('asks the wallet to approve the proposal pressed from its panel, and says what came of it', async () => {
    state.company = records({ proposals: { of: 'read', value: [PAY_KEY, { ...PAY_KEY, id: 'pk0', status: 'executed' }] } });
    state.acts = [];
    const c = await draw('proposals');
    await act(async () => { fireEvent.click(q(c, '[data-row=pk0] td:last-child')!); });
    expect(q(document.body, '[data-panel] [data-action=approve]')).toBeNull();
    await act(async () => { fireEvent.click(q(c, '[data-row=pk1] td:last-child')!); });
    /* RED WHEN: in the panel, Approve or what came of it is in the panel's scrolling body instead of its footer. */
    expect(inFooter('[data-action=approve]')).not.toBeNull();
    expect(q(document.body, '[data-proposal-panel=pk1] [data-action=approve]')).toBeNull();
    await press('[data-panel] [data-action=approve]');
    expect(state.acts).toEqual([['approve', 'u1', 'c-1', PAY_KEY, expect.any(Function)]]);
    expect(q(document.body, '[data-panel] [data-acted]')?.textContent).toContain(EN['proposal.act.approved']);
    expect(inFooter('[data-act-outcome] [data-acted]')).not.toBeNull();
  });

  /* RED WHEN: Approve is offered on a kind of proposal the wallet can be told about and is left out, it asks the wallet for anything but the row pressed, with what the row carries, or a panel opened after an approval keeps that approval's answer and stays disabled. */
  it('offers the same Approve on every kind, and asks the wallet to approve the row pressed with what it carries', async () => {
    const kinds = ['transfer', 'payroll', 'add-signer', 'remove-signer', 'set-threshold', 'set-vault-threshold', 'adopt-vault', 'vault-secret'] as const;
    const rows = kinds.map((kind, i): ProposalRow & { asks: Record<string, string> } => ({ ...PAY_KEY, id: `k${i}`, kind, asks: { vault: 'v1' } }));
    state.company = records({ proposals: { of: 'read', value: rows } });
    state.acts = []; state.acted = { of: 'done', state: 'approved', approvals: 1, needed: 2 };
    const c = await draw('proposals');
    for (const r of rows) {
      await act(async () => { fireEvent.click(q(c, `[data-row=${r.id}] td:last-child`)!); });
      await press('[data-panel] [data-action=approve]');
    }
    expect(state.acts).toEqual(rows.map((r) => ['approve', 'u1', 'c-1', r, expect.any(Function)]));
  });

  /*
   * RED WHEN: Withdraw is offered to a signer whose seat did not file a change to the company, a signer who shares the
   * name of the one who did included, or asks the wallet for anything but the proposal pressed.
   */
  it('offers Withdraw on a change to the company only to the seat that filed it, never by name, and asks the wallet to withdraw that proposal', async () => {
    const add = (id: string, raisedByYou: boolean): ProposalRow => ({ ...PAY_KEY, id, kind: 'add-signer', raisedBy: 'Priya', raisedByYou });
    state.company = records({ proposals: { of: 'read', value: [add('a1', true), add('a2', false)] } });
    state.acts = []; state.acted = { of: 'done', state: 'withdrawn', approvals: null, needed: null };
    const c = await draw('proposals');
    await act(async () => { fireEvent.click(q(c, '[data-row=a2] td:last-child')!); });
    expect(q(document.body, '[data-panel] [data-action=withdraw]')).toBeNull();
    await act(async () => { fireEvent.click(q(c, '[data-row=a1] td:last-child')!); });
    /* RED WHEN: in the panel, Withdraw is in the panel's scrolling body instead of its footer. */
    expect(inFooter('[data-action=withdraw]')).not.toBeNull();
    await press('[data-panel] [data-action=withdraw]');
    expect(state.acts).toEqual([['withdraw', 'u1', 'c-1', add('a1', true), expect.any(Function)]]);
    expect(q(document.body, '[data-panel] [data-acted]')?.textContent).toBe(EN['proposals.withdraw.done']);
  });

  /*
   * RED WHEN: a waiting proposal whose record was not read or believed here, or that the network has never held, is
   * told as a kind this page cannot approve, or is offered Approve.
   */
  it('says why a waiting proposal is not offered Approve: not read here, not raised, or a kind this page does not approve', async () => {
    const t = (id: string, asksUnread?: 'not-read' | 'not-raised'): ProposalRow => ({ ...PAY_KEY, id, kind: 'transfer', ...(asksUnread === undefined ? {} : { asksUnread }) });
    state.company = records({ proposals: { of: 'read', value: [t('u1', 'not-read'), t('u2', 'not-raised'), t('u3')] } });
    const c = await draw('proposals');
    for (const [id, key] of [['u1', 'proposals.approve.notRead'], ['u2', 'proposals.approve.notRaised'], ['u3', 'proposals.approve.notHere']] as const) {
      await act(async () => { fireEvent.click(q(c, `[data-row=${id}] td:last-child`)!); });
      const panel = document.querySelector(`[data-proposal-panel=${id}]`) as HTMLElement;
      expect(q(document.body, '[data-panel] [data-action=approve]'), id).toBeNull();
      expect(q(panel, '[data-approve-not-here]')!.textContent, id).toBe(EN[key]);
    }
    expect(EN['proposals.approve.notRead']).toMatch(/Do not approve it until it reads here/u);
  });

  /*
   * RED WHEN: a refusal of the wallet that sent nothing (the proposal not as shown, or a reason this page does not know)
   * is told as something that may have gone part of the way, or a stop the wallet says may have is not.
   */
  it('tells a refusal that sent nothing as one, and says part may have gone only where the wallet says so', async () => {
    for (const [why, says, partly] of [
      ['not-as-shown', 'proposal.act.why.not-as-shown', false], ['other', 'proposal.act.why.other', false], ['may-be-sent', 'proposal.act.why.may-be-sent', true],
    ] as const) {
      state.company = records({ proposals: { of: 'read', value: [PAY_KEY] } });
      state.acts = []; state.acted = { of: 'stopped', act: 'approve-proposal', why, partial: partly, handedOver: false };
      const c = await draw('proposals');
      await act(async () => { fireEvent.click(q(c, '[data-row=pk1] td:last-child')!); });
      await press('[data-panel] [data-action=approve]');
      const stopped = q(document.body, '[data-panel] [data-proposal-stopped]')!;
      expect(stopped.textContent, why).toContain(EN[says]);
      expect(q(stopped, '[data-partial]') !== null, why).toBe(partly);
      if (!partly) expect(stopped.textContent, why).toMatch(/nothing was sent/iu);
    }
  });

  /* RED WHEN: Home offers Decline, or its Approve asks the wallet for anything but the row's proposal. */
  it('has no Decline on Home or the list, approves a waiting proposal from Home, and has a Create menu of three entries', async () => {
    state.company = records({ proposals: { of: 'read', value: [PAY_KEY] } });
    state.acts = []; state.acted = { of: 'done', state: 'approved', approvals: 1, needed: 2 };
    const c = await draw('home');
    expect(document.body.innerHTML).not.toContain('decline');
    await press('[data-part=proposals-waiting] [data-proposal=pk1] [data-action=approve]');
    expect(state.acts).toEqual([['approve', 'u1', 'c-1', PAY_KEY, expect.any(Function)]]);
    await act(async () => { fireEvent.pointerDown(q(c, '[data-action=create-menu]')!, { button: 0, ctrlKey: false }); fireEvent.click(q(c, '[data-action=create-menu]')!); });
    expect(all(document.body, '[data-create-menu] [data-create]').map((e) => [e.dataset.create, e.textContent!.startsWith(EN[`home.create.${{ 'new-run': 'newRun', 'one-off-payment': 'oneOff', 'change-approvals': 'approvals' }[e.dataset.create!]}`]!)]))
      .toEqual([['new-run', true], ['one-off-payment', true], ['change-approvals', true]]);
    expect(all(document.body, '[data-create-menu] [data-slot=coming-soon]')).toHaveLength(0);
    expect(all(document.body, '[data-create-menu] [data-create]').filter((e) => e.getAttribute('aria-disabled') !== null)).toHaveLength(0);
    await press('[data-create=change-approvals]');
    expect(all(document.body, '[data-panel] [data-action=change-threshold]')).toHaveLength(1);
    /* RED WHEN: in the panel, the press to change the approvals needed is in the panel's scrolling body instead of its footer. */
    expect(inFooter('[data-action=raise-threshold]')).not.toBeNull();
    expect(q(document.body, '[data-panel]')!.textContent).toContain(EN['changeThreshold.title']);
    /* RED WHEN: New run or One-off payment in the Create menu does nothing, or opens anything but the run form or the one-off form in the panel. */
    for (const [entry, form, title, press1] of [['new-run', 'raise-run-panel', 'raiseRun.title', 'raise-run'], ['one-off-payment', 'one-off-panel', 'oneOff.title', 'raise-one-off']] as const) {
      await act(async () => { fireEvent.pointerDown(q(c, '[data-action=create-menu]')!, { button: 0, ctrlKey: false }); fireEvent.click(q(c, '[data-action=create-menu]')!); });
      await press(`[data-create=${entry}]`);
      expect(all(document.body, `[data-panel] [data-action=${form}]`), entry).toHaveLength(1);
      expect(q(document.body, '[data-panel]')!.textContent, entry).toContain(EN[title]);
      /* RED WHEN: in the panel, the press that raises the run or the payment is in the panel's scrolling body instead of its footer. */
      expect(inFooter(`[data-action=${press1}]`), entry).not.toBeNull();
    }
  });
});

describe('payroll and a run', () => {
  /* RED WHEN: a run's private and public money are shown as one figure, a public amount has no Public pill or a private one has one, or a run the chain shows paid does not say Paid. */
  it('lists the runs, their money on a line each for private and public, and a run the chain shows paid', async () => {
    const c = await draw('payroll');
    expect(all(c, '[data-screen=payroll] [data-slot=data-table] tbody tr').map((e) => e.dataset.row)).toEqual(['r1', 'r0']);
    const money = q(c, `[data-row=r1] [data-currency="${NIGHT_TOKEN}"]`)!;
    expect(all(money, '[data-slot=amount]').map((a) => a.dataset.visibility)).toEqual(['private', 'public']);
    expect(q(money, '[data-slot=amount][data-visibility=private] [data-slot=public-pill]')).toBeNull();
    expect(q(money, '[data-slot=amount][data-visibility=public]')!.textContent).toContain(EN['kit.public.label']);
    /* A run reads Paid once the chain shows it paid. */
    expect(q(c, '[data-row=r0] [data-status=paid]')?.textContent).toBe(EN['payroll.status.paid']);
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
    expect(await explained(runs, '[data-row=r1]')).toEqual([EN['kit.public.explanation.toBePaid']]);
    expect(await explained(runs, '[data-row=r0]')).toEqual([EN['kit.public.explanation.payment']]);
    cleanup();
    const run = await draw('run', { run: 'r1' });
    expect(await explained(run, '[data-payee=e2]')).toEqual([EN['kit.public.explanation.toBePaid']]);
    cleanup();
    /* A person with no payment address yet has no pill to explain: nothing says whether their pay is public. */
    const people = await draw('people');
    expect(q(people, '[data-row=e5] [data-slot=public-pill]')).toBeNull();
    await act(async () => { fireEvent.click(q(people, '[data-row=e5] td')!); });
    expect(q(document.body, '[data-person-panel=e5] [data-slot=public-pill]')).toBeNull();
  });

  /* RED WHEN: a run's page does not warn that some are paid publicly, marks a payee by anything but how they are paid, or leaves a currency without its approvals. */
  it('shows a run\'s currencies, approvals, public payees and who is paid how', async () => {
    const c = await draw('run', { run: 'r1' });
    expect(q(c, '[data-public-payees]')?.textContent).toBe(EN['run.publicPayees_one']!.replace('{count}', '1'));
    expect(q(c, `[data-currency="${NIGHT_TOKEN}"] [data-approvals]`)?.textContent).toBe('1 of 2');
    /* RED WHEN a token paid both privately and publicly is shown as one round, so the private round's approvals are said of the public payments too. */
    expect(all(c, `[data-currency="${NIGHT_TOKEN}"] [data-round]`).map((w) => [w.dataset.round, q(w, '[data-approvals]')?.textContent ?? null, q(w, '[data-not-sent]') !== null])).toEqual([
      ['privately', '1 of 2', false], ['publicly', null, true],
    ]);
    /* RED WHEN a way of paying is shown apart from its label and its amount, or its label is left out. */
    expect(all(c, `[data-currency="${NIGHT_TOKEN}"] [data-round]`).map((w) => [q(w, '[data-form-label]')?.textContent ?? null, q(w, '[data-slot=amount]')?.dataset.visibility ?? null])).toEqual([
      [EN['payroll.runTotal.privately'], 'private'], [EN['payroll.runTotal.publicly'], 'public'],
    ]);
    /* RED WHEN a token paid both ways does not say its private and public payments are approved separately. */
    expect(q(c, `[data-currency="${NIGHT_TOKEN}"] [data-paid-both-ways]`)?.textContent).toBe(EN['run.paidBothWays']!.replace('{token}', 'NIGHT'));
    expect(all(c, '[data-payee]').map((p) => [p.dataset.payee, q(p, '[data-paid]')!.dataset.paid, q(p, '[data-slot=amount]')!.dataset.visibility])).toEqual([
      ['e1', 'privately', 'private'], ['e2', 'publicly', 'public'], ['e3', 'not-known', 'public'],
    ]);
    /* A payee whose address is not known is not counted as paid publicly, and is not called private. */
    expect(q(c, '[data-payee=e3] [data-paid]')?.textContent).toBe(EN['records.paid.notKnown']);
    cleanup();
    const none = await draw('run', { run: 'nope' });
    expect(q(none, '[data-screen=run] [data-slot=empty-state-line]')?.textContent).toBe(EN['run.notFound']);
    expect(q(none, '[data-screen=run] [data-slot=empty-state]')).not.toBeNull();
    cleanup();
    const noVault = await draw('vault', { vault: 'nope' });
    expect(q(noVault, '[data-screen=vault] [data-slot=empty-state-line]')?.textContent).toBe(EN['vault.notFound']);
  });

  const ASKS = { kind: 'payroll', period: '2026-10', vault: VAULT, token: NIGHT_TOKEN, form: 'private', payees: '2', total: '7000000' };
  const panelOf = () => document.querySelector('[data-panel]') as HTMLElement;
  /*
   * RED WHEN: a run's page cannot approve or withdraw the proposal of a leg, or does it anywhere but the shell's panel, or for another proposal than
   * the one on the line pressed, or Withdraw is kept from a signer who did not raise the run, or an act's answer is lost once the records are read again.
   */
  it('approves and withdraws a leg\'s proposal from the shell\'s panel through the wallet\'s acts, Withdraw offered to a signer who did not raise it', async () => {
    const row: ProposalRow = { ...PROPOSALS[1]!, asks: ASKS, raisedByYou: false };
    state.company = records({ proposals: { of: 'read', value: [row] } });
    state.acts = []; state.acted = { of: 'done', state: 'approved', approvals: 2, needed: 2 };
    const c = await draw('run', { run: 'r1' });
    const round = q(c, '[data-round=privately]')!;
    expect(all(round, ':scope > div button[data-action]').map((b) => b.dataset.action)).toEqual(['approve', 'withdraw']);
    expect(q(c, '[data-round=publicly] button[data-action]')).toBeNull();
    expect(state.acts).toEqual([]);
    await act(async () => { fireEvent.click(q(round, 'button[data-action=approve]')!); await new Promise((r) => setTimeout(r, 5)); });
    expect(state.acts).toEqual([]);
    await act(async () => { fireEvent.click(q(panelOf(), 'button[data-action=approve]')!); await new Promise((r) => setTimeout(r, 20)); });
    expect(state.acts).toEqual([['approve', 'u1', 'c-1', row, expect.any(Function)]]);
    expect(q(panelOf(), '[data-acted]')!.textContent).toContain(EN['proposal.act.approved']);
    state.acts = [];
    await act(async () => { fireEvent.click(q(c, '[data-round=privately] button[data-action=withdraw]')!); await new Promise((r) => setTimeout(r, 5)); });
    await act(async () => { fireEvent.click(q(panelOf(), 'button[data-action=withdraw]')!); await new Promise((r) => setTimeout(r, 20)); });
    expect(state.acts).toEqual([['withdraw', 'u1', 'c-1', row, expect.any(Function)]]);
    expect(q(panelOf(), '[data-acted]')!.textContent).toContain(EN['proposals.withdraw.done']);
  });

  /*
   * RED WHEN: a run reads Paid, or its legs read paid, when the chain does not show it; a leg or a run the chain shows partly paid is not
   * told apart from one it shows paid in full or not at all; a payment the chain could not be read for is called paid or unpaid; or a run whose
   * record names a proposal for a leg reads as a draft, or one that names none reads as anything else.
   */
  it('says a run is paid only by what the chain shows, and a draft only while no leg of it is raised', async () => {
    const leg = (paidOnChain: 0 | 1 | 2 | undefined, proposal: string | null): RunLeg => ({ ...RUN.legs[0]!, paidOnChain, proposal });
    const run = (paidOnChain: 0 | 1 | 2 | undefined, proposal: string | null = 'p1'): RunRow => ({ ...RUN, paidOnChain, legs: [leg(paidOnChain, proposal)] });
    const says = async (r: RunRow) => {
      state.company = records({ runs: { of: 'read', value: [r] } });
      const c = await draw('run', { run: 'r1' });
      const out = [q(c, '[data-slot=page-header] [data-status]')!.textContent, q(c, '[data-round=privately] [data-leg-paid]')?.textContent ?? null, q(c, '[data-round=privately] [data-slot=amount]')?.dataset.kind ?? null];
      cleanup();
      return out;
    };
    /* Raised, and the chain shows none of it paid: it reads not paid, and its amounts are still to be paid. */
    const none = await says(run(PAID_STATE.none));
    expect(none.slice(0, 2)).toEqual([EN['payroll.status.notPaid'], EN['run.legPaid.notSeen']]);
    expect((await says(run(PAID_STATE.some))).slice(0, 2)).toEqual([EN['payroll.status.partlyPaid'], EN['run.legPaid.inPart']]);
    expect((await says(run(PAID_STATE.all))).slice(0, 2)).toEqual([EN['payroll.status.paid'], EN['run.legPaid.inFull']]);
    expect((await says(run(undefined))).slice(0, 2)).toEqual([EN['payroll.status.paidUnread'], EN['run.legPaid.unread']]);
    expect((await says(run(undefined, null))).slice(0, 1)).toEqual([EN['payroll.status.draft']]);
  });

  /*
   * RED WHEN: a run's page offers Pay before the chain shows the leg's proposal approved, for a leg the chain shows paid in full, or in the
   * shell's panel for anything but the leg on the line; or does not show a retry on a leg, with its own approvals and presses.
   */
  it('offers Pay on a leg once the chain shows its proposal approved, and shows a retry on it with its own presses', async () => {
    const retry = { proposal: 'p3', vault: VAULT, people: 1, total: 2_000_000n, pays: [LEG_MORE.pays[1]!], leaves: ['bb'], paidOnChain: PAID_STATE.none };
    const withRetry: RunRow = { ...RUN, legs: [{ ...RUN.legs[0]!, retries: [retry] }] };
    const adopted: VaultRow = { vault: VAULT, createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee', adopted: true };
    const p1 = (status: 'open' | 'approved'): ProposalRow => ({ ...PROPOSALS[1]!, status, asks: ASKS });
    const p3 = (status: 'open' | 'approved'): ProposalRow => ({ ...PROPOSALS[1]!, id: 'p3', status, asks: { ...ASKS, payees: '1', total: '2000000' }, pays: PROPOSALS[1]!.pays });
    const draws = async (run: RunRow, proposals: ProposalRow[]) => {
      state.company = records({ vaults: { of: 'read', value: [adopted] }, runs: { of: 'read', value: [run] }, proposals: { of: 'read', value: proposals } });
      const c = await draw('run', { run: 'r1' });
      const out = all(c, '[data-round=privately] button[data-action=pay-run]').map((b) => b.closest('[data-retry]')?.getAttribute('data-retry') ?? 'leg');
      return { c, out };
    };
    expect((await draws(withRetry, [p1('open'), p3('open')])).out).toEqual([]);
    cleanup();
    const { c, out } = await draws(withRetry, [p1('approved'), p3('open')]);
    expect(out).toEqual(['leg']);
    expect(q(c, '[data-retry=p3]')!.textContent).toContain(EN['run.retry_one']!.replace('{count}', '1'));
    expect(all(c, '[data-retry=p3] button[data-action]').map((b) => b.dataset.action)).toEqual(['approve', 'withdraw']);
    cleanup();
    expect((await draws(withRetry, [p1('open'), p3('approved')])).out).toEqual(['p3']);
    state.acts = []; state.payActed = { of: 'done', state: 'paid', paid: 1, owed: 0, unseen: 0 };
    await act(async () => { fireEvent.click(q(document.body, '[data-retry=p3] button[data-action=pay-run]')!); await new Promise((r) => setTimeout(r, 5)); });
    /* RED WHEN: in the panel, Pay or what came of it is in the panel's scrolling body instead of its footer. */
    expect(inFooter('button[data-action=pay-run]')).not.toBeNull();
    expect(q(panelOf(), '[data-action=pay-run-panel] [data-action=pay-run]')).toBeNull();
    await act(async () => { fireEvent.click(q(panelOf(), 'button[data-action=pay-run]')!); await new Promise((r) => setTimeout(r, 20)); });
    expect(inFooter('[data-act-outcome] [data-acted]')).not.toBeNull();
    expect(state.acts).toEqual([['pay-run', 'u1', 'c-1', expect.objectContaining({ proposal: 'p3', run: 'r1', payees: 1, total: 2_000_000n, vault: VAULT }), expect.any(Function)]]);
    cleanup();
    /* A leg the chain shows paid in full is not offered, though its proposal is approved. */
    const paid: RunRow = { ...RUN, legs: [{ ...RUN.legs[0]!, paidOnChain: PAID_STATE.all }] };
    expect((await draws(paid, [p1('approved')])).out).toEqual([]);
  });

  /*
   * RED WHEN: a run's page offers Retry for a leg the chain shows paid in full or has not been read for, with no people the chain shows unpaid, before the leg's
   * window has closed (unless its proposal was stopped), or while the proposals are not read; or does not offer it once the window has closed, whether or not the
   * proposal was approved, which is when the wallet accepts one.
   */
  it('offers Retry only for a leg the chain shows people unpaid on and that can no longer pay them', async () => {
    const PAST = 1n;
    const FUTURE = BigInt(Math.floor(Date.now() / 1000) + 86_400);
    const leg = (over: Partial<RunLeg> = {}): RunLeg => ({
      ...RUN.legs[0]!, paidOnChain: PAID_STATE.some, leaves: ['aa', 'bb'], amounts: [5_000_000n, 2_000_000n], unpaid: [1], closesAt: PAST, ...over,
    });
    const offered = async (l: RunLeg, status: ProposalRow['status'] = 'approved', proposals: 'read' | 'unreadable' = 'read') => {
      state.company = records({
        runs: { of: 'read', value: [{ ...RUN, legs: [l] }] },
        proposals: proposals === 'read' ? { of: 'read', value: [{ ...PROPOSALS[1]!, status, asks: ASKS }] } : { of: 'unreadable' },
      });
      const c = await draw('run', { run: 'r1' });
      const out = q(c, '[data-round=privately] button[data-action=retry-run]') !== null;
      cleanup();
      return out;
    };
    expect(await offered(leg())).toBe(true);
    expect(await offered(leg(), 'open')).toBe(true);
    expect(await offered(leg({ closesAt: FUTURE }))).toBe(false);
    expect(await offered(leg({ closesAt: FUTURE }), 'cancelled')).toBe(true);
    expect(await offered(leg({ paidOnChain: PAID_STATE.all, unpaid: [] }))).toBe(false);
    expect(await offered(leg({ unpaid: [] }))).toBe(false);
    expect(await offered(leg({ paidOnChain: undefined, unpaid: undefined }))).toBe(false);
    expect(await offered(leg({ amounts: undefined }))).toBe(false);
    expect(await offered(leg({ form: null }))).toBe(false);
    expect(await offered(leg(), 'approved', 'unreadable')).toBe(false);
  });

  /*
   * RED WHEN: the retry panel asks the wallet before Raise is pressed, names other people than those the chain shows unpaid, lets Raise through without both
   * times, with an opening not in the future or a closing not after it, gives either time a default, or asks the wallet for other places, another total or
   * another window than those shown and typed; or the answer is lost when the records are read again.
   */
  it('raises a retry of the people the chain shows unpaid over the window the person typed, and keeps the answer', async () => {
    const leg: RunLeg = { ...RUN.legs[0]!, paidOnChain: PAID_STATE.some, leaves: ['aa', 'bb'], amounts: [5_000_000n, 2_000_000n], unpaid: [1], closesAt: 1n };
    state.company = records({ runs: { of: 'read', value: [{ ...RUN, legs: [leg] }] }, proposals: { of: 'read', value: [{ ...PROPOSALS[1]!, status: 'approved', asks: ASKS }] } });
    state.acts = []; state.retried = { of: 'done', state: 'raised', approvals: 1, needed: 2 };
    const c = await draw('run', { run: 'r1' });
    await act(async () => { fireEvent.click(q(c, '[data-round=privately] button[data-action=retry-run]')!); await new Promise((r) => setTimeout(r, 5)); });
    const panel = panelOf();
    const raise = () => q(panel, 'button[data-action=retry-run]') as HTMLButtonElement;
    expect(all(panel, '[data-retry-person]').map((p) => p.textContent!.startsWith('Bo'))).toEqual([true]);
    expect((q(panel, '[data-field=opens]') as HTMLInputElement).value).toBe('');
    expect((q(panel, '[data-field=closes]') as HTMLInputElement).value).toBe('');
    expect([raise().disabled, q(panel, '[data-window-problem]')!.dataset.windowProblem]).toEqual([true, 'missing']);
    const local = (ms: number) => { const d = new Date(ms); const two = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`; };
    const give = async (opens: string, closes: string) => {
      await act(async () => { fireEvent.change(q(panel, '[data-field=opens]')!, { target: { value: opens } }); fireEvent.change(q(panel, '[data-field=closes]')!, { target: { value: closes } }); });
    };
    const DAY = 86_400_000;
    await give(local(Date.now() - DAY), local(Date.now() + DAY));
    expect([raise().disabled, q(panel, '[data-window-problem]')!.dataset.windowProblem]).toEqual([true, 'past']);
    await give(local(Date.now() + 2 * DAY), local(Date.now() + DAY));
    expect([raise().disabled, q(panel, '[data-window-problem]')!.dataset.windowProblem]).toEqual([true, 'order']);
    const opens = local(Date.now() + 2 * DAY);
    const closes = local(Date.now() + 9 * DAY);
    await give(opens, closes);
    expect(raise().disabled).toBe(false);
    /* RED WHEN: in the panel, the press to raise the retry or what came of it is in the panel's scrolling body instead of its footer, or the press in the footer is not tied to the form it submits. */
    expect(inFooter('[data-action=retry-run]')).toBe(raise());
    expect(q(panel, 'form')!.contains(raise())).toBe(false);
    expect(raise().getAttribute('form')).toBe(q(panel, 'form')!.id);
    expect(state.acts).toEqual([]);
    await act(async () => { fireEvent.click(raise()); await new Promise((r) => setTimeout(r, 20)); });
    expect(inFooter('[data-act-outcome] [data-retry-state=raised]')).not.toBeNull();
    expect(state.acts).toEqual([['retry-run', 'u1', 'c-1', {
      run: 'r1', period: '2026-10', list: 'employees', vault: VAULT, token: NIGHT_TOKEN, form: 'shielded', indices: [1], total: 2_000_000n,
      opensAt: BigInt(new Date(opens).getTime() / 1000), closesAt: BigInt(new Date(closes).getTime() / 1000),
    }, expect.any(Function)]]);
    expect(q(panel, '[data-retry-state=raised]')!.textContent).toBe(EN['retryRun.done.counted']!.replace('{approvals}', '1').replace('{needed}', '2'));
  });

  /* The private and public payments of one token, and how a run's page tells them apart. */
  const rowsOf = (c: ParentNode) => all(c, `[data-currency="${NIGHT_TOKEN}"] [data-round]`)
    .map((w) => [w.dataset.round, q(w, '[data-approvals]')?.textContent ?? null, q(w, '[data-not-sent]') !== null]);
  const legacy = (paid: 'not-known' | 'publicly'): ProposalRow => ({ ...PROPOSALS[1]!, id: `p-${paid}`, pays: { run: 'r1', period: '2026-10', asset: NIGHT_TOKEN, symbol: 'NIGHT', paid } });

  /* RED WHEN a proposal whose form is not known is said of the private or the public payments of a token paid both ways, or of neither when the token is paid one way. */
  it('puts a proposal whose form is not known on a token\'s one way, and on a line of its own when it is paid both ways', async () => {
    state.company = records({ proposals: { of: 'read', value: [legacy('not-known')] } });
    const both = await draw('run', { run: 'r1' });
    expect(rowsOf(both)).toEqual([['privately', null, true], ['publicly', null, true], ['not-known', '1 of 2', false]]);
    cleanup();
    const privateOnly: RunRow = { ...RUN, payees: [RUN.payees[0]!], currencies: [{ ...RUN.currencies[0]!, publicly: null }] };
    state.company = records({ runs: { of: 'read', value: [privateOnly] }, proposals: { of: 'read', value: [legacy('not-known')] } });
    const one = await draw('run', { run: 'r1' });
    expect(rowsOf(one)).toEqual([['privately', '1 of 2', false]]);
    expect(q(one, '[data-paid-both-ways]')).toBeNull();
  });

  /* RED WHEN a run's approval lines follow only its people's addresses, so a public leg raised for a run whose amounts read private is not shown. */
  it('shows a line for each leg a run was raised with, as well as for each way its people are paid', async () => {
    const privateOnly: RunRow = {
      ...RUN, payees: [RUN.payees[0]!], currencies: [{ ...RUN.currencies[0]!, publicly: null }],
      legs: [...RUN.legs, { ...LEG_MORE, code: `${NIGHT_TOKEN}:unshielded`, asset: NIGHT_TOKEN, symbol: 'NIGHT', paid: 'publicly', vault: VAULT, payees: 1, form: 'unshielded', people: 1 }],
    };
    state.company = records({ runs: { of: 'read', value: [privateOnly] }, proposals: { of: 'read', value: [PROPOSALS[1]!, legacy('publicly')] } });
    const c = await draw('run', { run: 'r1' });
    expect(rowsOf(c)).toEqual([['privately', '1 of 2', false], ['publicly', '1 of 2', false]]);
    /* The public leg has no amount read from the people's addresses, and none is made up for it. */
    expect(q(c, '[data-round=publicly] [data-slot=amount]')).toBeNull();
  });

  /* RED WHEN who a run pays is listed in any order but the private payments together, then the public ones, then those not known. */
  it('lists who a run pays with each way of paying together', async () => {
    const mixed: RunRow = { ...RUN, payees: [RUN.payees[2]!, RUN.payees[1]!, RUN.payees[0]!, { ...RUN.payees[0]!, id: 'e4', name: 'Dee' }] };
    state.company = records({ runs: { of: 'read', value: [mixed] } });
    const c = await draw('run', { run: 'r1' });
    expect(all(c, '[data-payee]').map((p) => [p.dataset.payee, q(p, '[data-paid]')!.dataset.paid])).toEqual([
      ['e1', 'privately'], ['e4', 'privately'], ['e2', 'publicly'], ['e3', 'not-known'],
    ]);
  });

  /* RED WHEN a payment proposal in a token this app does not know is not said as the private or the public payments it is, or a public one does not say anyone can see who is paid and how much. */
  it('says which payments of a run a proposal pays, in a token this app knows or not', async () => {
    const pays = (paid: 'privately' | 'publicly', symbol: string | null): ProposalRow => ({ ...PROPOSALS[1]!, id: `p-${paid}-${symbol ?? 'none'}`, pays: { run: 'r1', period: '2026-10', asset: NIGHT_TOKEN, symbol, paid } });
    const rows = [pays('publicly', 'NIGHT'), pays('privately', null), pays('publicly', null)];
    state.company = records({ proposals: { of: 'read', value: rows } });
    const c = await draw('proposals');
    expect(rows.map((r) => q(c, `[data-row="${r.id}"] td [data-slot=data-table-value]`)?.textContent)).toEqual([
      'Pay the public payments of the October 2026 run in NIGHT. Anyone can see who is paid and how much.',
      'Pay the shielded payments of the October 2026 run in a token this app does not know',
      'Pay the public payments of the October 2026 run in a token this app does not know. Anyone can see who is paid and how much.',
    ]);
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
    ['people', {}, { peopleBelief: { of: 'unreadable' } }],
    ['vendors', {}, { vendorsBelief: { of: 'unreadable' } }],
    ['invitations', {}, { invitations: { of: 'unreadable' } }],
    ['home', {}, { proposals: { of: 'unreadable' }, runs: { of: 'unreadable' } }],
  ] as const)('%s', async (id, params, over) => {
    state.company = records(over as Partial<CompanyRecords>);
    const c = await draw(id, params);
    expect(all(c, '[data-unreadable]').length, id).toBeGreaterThan(0);
    expect(q(c, '[data-not-sent], [data-holds-none]'), id).toBeNull();
    /* Home's recent activity, not built yet, is its empty state whatever was read. */
    expect(all(c, '[data-slot=empty-state]').filter((e) => e.closest('[data-part=recent-activity]') === null), id).toEqual([]);
  });

  /* RED WHEN: the Vaults page, when the company's vaults cannot be loaded, shows the general line instead of the words that name the vaults and give the details for support. */
  it('says on the Vaults page that the company\'s vaults could not be loaded, with the details for support', async () => {
    state.company = records({ vaults: { of: 'unreadable' } });
    const c = await draw('vaults', {});
    const said = q(c, '[data-screen=vaults] [data-unreadable]')?.textContent;
    expect(said).toBe(EN['vaults.unreadable']!.replace('{reasons}', EN['vaults.unreadable.reason']!));
    expect(said).toMatch(/^This company's vaults could not be loaded\. Details for support: .+\.$/u);
    expect(said).not.toContain(EN['records.unreadable']);
  });

  /* RED WHEN: the waiting tab shows nobody waiting when the people could not be read. */
  it('invitations, waiting tab', async () => {
    state.company = records({ people: { of: 'unreadable' } });
    const c = await draw('invitations');
    await act(async () => { fireEvent.mouseDown(q(c, '[data-tab=waiting]')!, { button: 0 }); });
    expect(q(c, '[data-waiting] [data-unreadable]')).not.toBeNull();
    expect(q(c, '[data-waiting] [data-slot=empty-state]')).toBeNull();
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
    state.privateMoney = { of: 'held', amounts: [TD(1_500_000n)], unrecognised: 0 };
    state.publicMoney = { amounts: [NIGHT(4_000_000n, 'public')], unrecognised: 0 };
    for (const id of ['vaults', 'home'] as const) {
      const c = await draw(id);
      await settle();
      const tile = q(c, `[data-slot=stat-tile][data-vault="${VAULT}"]`)!;
      expect(heldLines(tile), id).toEqual([
        ['TDUST', 'private', `1.5 TDUST${EN['kit.balance.private']}`],
        ['NIGHT', 'public', `4 NIGHT${EN['kit.public.label']}`],
      ]);
      expect(q(tile, '[data-held=TDUST] [data-slot=private-pill]'), id).not.toBeNull();
      expect(q(tile, '[data-held=NIGHT] [data-slot=public-pill]'), id).not.toBeNull();
      expect(tile.textContent, id).not.toContain('Private money');
      expect(tile.textContent, id).not.toContain('Public money');
      expect(tile.textContent, id).not.toContain('Not shown here');
      expect(q(tile, '[data-holds-none]'), id).toBeNull();
      cleanup();
    }
    state.privateMoney = { of: 'unreadable', why: 'chain' };
    state.publicMoney = { amounts: [], unrecognised: 0 };
    const c = await draw('vaults');
    await settle();
    const tile = q(c, `[data-slot=stat-tile][data-vault="${VAULT}"]`)!;
    expect(q(tile, '[data-unreadable=private]')?.textContent).toBe(EN['vaults.privateMoney.cannotRead']!.replace('{why}', EN['vault.privateMoney.why.chain']!));
    expect(q(tile, '[data-holds-none]')).toBeNull();
    cleanup();
    state.privateMoney = { of: 'held', amounts: [], unrecognised: 0 };
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
    state.privateMoney = { of: 'held', amounts: [], unrecognised: 0 };
    const c = await draw('vaults');
    await settle();
    expect(q(c, `[data-slot=stat-tile][data-vault="${VAULT}"] [data-unreadable=public]`)?.textContent).toBe(EN['vaults.publicMoney.unreadable']);
  });

  /*
   * RED WHEN: a vault's page does not
   * show its money in the kit's table with exactly the columns Asset, Balance,
   * State and Actions; the balance repeats the token's name; an asset held
   * both ways is not two rows, one per state; the state is not read from the
   * amount; Send is missing or disabled, Shield or Unshield is missing or enabled, without their
   * hover text, or carry a Coming soon pill; the tabs do not keep the rows
   * held privately, or publicly; a side that could not be read is shown as
   * held; a currency the registry does not know is not counted; or checking
   * again is not the refresh icon with its hover text and how long ago the
   * money was read.
   */
  it('shows a vault\'s money in the kit\'s table: Asset, Balance, State and Actions, a row an asset and state', async () => {
    state.privateMoney = { of: 'held', amounts: [TD(1_500_000n), NIGHT(2_000_000n, 'private')], unrecognised: 1 };
    state.publicMoney = { amounts: [NIGHT(4_000_000n, 'public')], unrecognised: 2 };
    const c = await draw('vault', { vault: VAULT });
    await settle();
    const table = q(c, '[data-part=money] [data-slot=data-table]')!;
    const rows = () => all(table, 'tbody tr').map((r) => [r.dataset.row, ...all(r, 'td [data-slot=data-table-value]').slice(0, 3).map((d) => d.textContent)]);
    expect(all(table, 'thead th').map((h) => h.textContent)).toEqual([EN['vault.money.asset'], EN['vault.money.balance'], EN['vault.money.state'], EN['vault.money.actions']]);
    /* Asset takes half the table and Actions an eighth; Balance and State share the rest; the three after Asset are centred, heading and entries alike. */
    expect(all(table, 'thead th').map((h) => [h.className.includes('md:w-1/2'), h.className.includes('md:w-1/8'), h.className.includes('text-center')])).toEqual([[true, false, false], [false, false, true], [false, false, true], [false, true, true]]);
    expect(all(table, 'tbody tr:first-child td').map((d) => d.className.includes('text-center'))).toEqual([false, true, true, true]);
    expect(q(table, 'table')!.className).toContain('md:table-fixed');
    expect(rows()).toEqual([
      ['TDUSTprivate', 'TDUST', '1.5', EN['kit.balance.private']],
      ['NIGHTprivate', 'NIGHT', '2', EN['kit.balance.private']],
      ['NIGHTpublic', 'NIGHT', '4', EN['kit.public.label']],
    ]);
    expect(q(table, '[data-row="NIGHTpublic"] [data-slot=public-pill]')).not.toBeNull();
    expect(q(table, '[data-row="NIGHTprivate"] [data-slot=private-pill]')).not.toBeNull();
    const actions = (row: string) => all(table, `[data-row="${row}"] td:last-child [data-hover]`).map((a) => [a.dataset.hover, (q(a, 'button') as HTMLButtonElement).disabled]);
    expect(actions('NIGHTprivate')).toEqual([[EN['vault.money.send'], false], [EN['vault.money.unshield'], true]]);
    expect(actions('NIGHTpublic')).toEqual([[EN['vault.money.send'], false], [EN['vault.money.shield'], true]]);
    expect(q(table, '[data-slot=coming-soon]')).toBeNull();
    /* Each icon is named by its hover text, reached with the keyboard although disabled, and says it is disabled. */
    const send = all(table, '[data-row=NIGHTpublic] td:last-child [data-hover]')[1]!;
    expect([send.tabIndex, send.getAttribute('aria-label'), send.getAttribute('aria-disabled'), q(send, 'button')!.getAttribute('aria-label')]).toEqual([0, EN['vault.money.shield'], 'true', EN['vault.money.shield']]);
    await act(async () => { fireEvent.focus(send); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-slot=tooltip-content]')?.textContent).toContain(EN['vault.money.shield']);
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
    expect(q(c, '[data-part=money] [data-unrecognised][data-side=public]')?.textContent).toBe(EN['vault.publicMoney.unrecognised_other']!.replace('{count}', '2'));
    expect(q(c, '[data-part=money] [data-unrecognised][data-side=private]')?.textContent).toBe(EN['vault.privateMoney.unrecognised_one']!.replace('{count}', '1'));
    const refresh = q(c, '[data-part=money] [data-slot=section-actions] [data-hover] [data-action=read-money]')!;
    expect(q(c, '[data-part=money] [data-slot=section-actions] [data-updated]')).not.toBeNull();
    expect(refresh.closest('[data-hover]')!.getAttribute('data-hover')).toBe(EN['vault.money.readAgain']);
    expect(refresh.textContent).toBe('');
    expect(q(c, '[data-part=money] [data-updated]')!.textContent).toBe(EN['vault.money.updated']!.replace('{ago}', 'now'));
    expect(q(c, '[data-part=money] [data-updated]')!.className).toContain('text-muted-foreground');
    state.privateMoney = { of: 'unreadable', why: 'wallet-refused' };
    state.publicMoney = { amounts: [NIGHT(1_000_000n, 'public')], unrecognised: 0 };
    await act(async () => { fireEvent.click(refresh); await new Promise((r) => setTimeout(r, 5)); });
    await act(async () => { fireEvent.mouseDown(q(c, '[data-part=money] [data-filter=all]')!, { button: 0 }); });
    expect(all(q(c, '[data-part=money]')!, 'tbody tr').map((r) => r.dataset.row)).toEqual(['NIGHTpublic']);
    expect(q(c, '[data-part=money] [data-unreadable=private]')?.textContent).toBe(EN['vault.privateMoney.cannotRead']!.replace('{why}', EN['vault.privateMoney.why.walletRefused']!).replace('{next}', EN['vault.privateMoney.next.again']!));
    expect(q(c, '[data-part=money] [data-slot=empty-state]')).toBeNull();
  });

  /*
   * RED WHEN: a vault whose pool was never opened is said to have failed to read, or sends the person to support, or
   * is shown as no money in the tokens this app shows while its public side is unread; or a vault with nothing held
   * yet is not said, on its tile and on its page, in its own words; or the page does not say it was read.
   */
  it('says a vault holds nothing privately yet, on its tile and its page, as a read that succeeded', async () => {
    state.privateMoney = { of: 'nothing-yet' };
    state.publicMoney = { amounts: [NIGHT(1_000_000n, 'public')], unrecognised: 0 };
    const tile = await draw('vaults');
    await settle();
    const said = q(tile, `[data-vault="${VAULT}"] [data-private-money=nothing-yet]`)?.textContent;
    expect(said).toBe(EN['vault.privateMoney.nothingYet']);
    expect(said).not.toMatch(/support|could not be read/);
    expect(q(tile, `[data-vault="${VAULT}"] [data-unreadable=private]`)).toBeNull();
    cleanup();
    const page = await draw('vault', { vault: VAULT });
    await settle();
    expect(q(page, '[data-part=money] [data-private-money=nothing-yet]')?.textContent).toBe(EN['vault.privateMoney.nothingYet']);
    expect(q(page, '[data-part=money] [data-unreadable=private]')).toBeNull();
    expect(q(page, '[data-part=money] [data-updated]')).not.toBeNull();
    expect(all(page, '[data-part=money] tbody tr').map((r) => r.dataset.row)).toEqual(['NIGHTpublic']);
  });

  /*
   * RED WHEN: a private record no seat signed, or one the network contradicts, is shown as nothing held or as a
   * failed read; or its words differ from the record not being believed; or the page says the money was just read.
   */
  it('says a private record that was not believed was not believed, on its tile and its page, and shows no amount for it', async () => {
    state.privateMoney = { of: 'not-believed' };
    state.publicMoney = { amounts: [NIGHT(1_000_000n, 'public')], unrecognised: 0 };
    const tile = await draw('vaults');
    await settle();
    expect(q(tile, `[data-vault="${VAULT}"] [data-private-money=not-believed]`)?.textContent).toBe(EN['vaults.privateMoney.notBelieved']);
    expect(q(tile, `[data-vault="${VAULT}"] [data-unreadable=private]`)).toBeNull();
    expect(heldLines(q(tile, `[data-slot=stat-tile][data-vault="${VAULT}"]`)!)).toEqual([['NIGHT', 'public', `1 NIGHT${EN['kit.public.label']}`]]);
    cleanup();
    const page = await draw('vault', { vault: VAULT });
    await settle();
    const said = q(page, '[data-part=money] [data-private-money=not-believed]')?.textContent;
    expect(said).toBe(EN['vault.privateMoney.notBelieved']);
    expect(said).toMatch(/no seat of your company signed it/);
    expect(q(page, '[data-part=money] [data-unreadable=private]')).toBeNull();
    expect(q(page, '[data-part=money] [data-updated]')).toBeNull();
    expect(all(page, '[data-part=money] tbody tr').map((r) => r.dataset.row)).toEqual(['NIGHTpublic']);
  });

  /* RED WHEN: a private read that failed gives the same words whatever stopped it, or leaves out why, or on the page no longer points to the refresh button. */
  it.each([
    ['no-keys', 'noKeys'], ['wallet-refused', 'walletRefused'], ['chain', 'chain'], ['layout', 'layout'], ['record', 'record'], ['other', 'other'],
  ] as const)('says why a private read failed (%s), on its tile and its page, each with its own reason', async (why, key) => {
    state.privateMoney = { of: 'unreadable', why };
    state.publicMoney = { amounts: [], unrecognised: 0 };
    const reason = EN[`vault.privateMoney.why.${key}`]!;
    const tile = await draw('vaults');
    await settle();
    expect(q(tile, `[data-vault="${VAULT}"] [data-unreadable=private]`)?.textContent).toBe(EN['vaults.privateMoney.cannotRead']!.replace('{why}', reason));
    cleanup();
    const page = await draw('vault', { vault: VAULT });
    await settle();
    const said = q(page, '[data-part=money] [data-unreadable=private]')?.textContent;
    /* RED WHEN: a private read that refresh cannot clear (no keys open in this tab, no record on this device) tells the person to refresh, instead of the step that clears it. */
    const next = EN[`vault.privateMoney.next.${key === 'noKeys' || key === 'record' ? key : 'again'}`]!;
    expect(said).toBe(EN['vault.privateMoney.cannotRead']!.replace('{why}', reason).replace('{next}', next));
    expect(said).toContain(reason);
    if (key === 'noKeys') expect(said).toContain("Open your company's records in your wallet first: press Check my last deposit above");
    if (key === 'record') expect(said).toContain('Press Check my last deposit above, which files the record this device lacks');
    if (key === 'noKeys' || key === 'record') expect(said).not.toMatch(/^[^.]*\.[^.]*\. Use the refresh button/u);
    expect(q(page, '[data-part=money] [data-action=read-money]')).not.toBeNull();
    expect(q(page, '[data-part=money] [data-private-money]')).toBeNull();
  });

  /* RED WHEN: tokens a vault holds privately that no asset names are left out of what is said, are counted as one for each note, or are said as none held. */
  it('counts the tokens a vault holds privately that the app does not know, on its tile and its page', async () => {
    state.privateMoney = { of: 'held', amounts: [], unrecognised: 2 };
    state.publicMoney = { amounts: [], unrecognised: 0 };
    const tile = await draw('vaults');
    await settle();
    expect(q(tile, `[data-vault="${VAULT}"] [data-unrecognised][data-side=private]`)?.textContent).toBe(EN['vault.privateMoney.unrecognised_other']!.replace('{count}', '2'));
    expect(q(tile, `[data-vault="${VAULT}"] [data-holds-none]`)).toBeNull();
    cleanup();
    const page = await draw('vault', { vault: VAULT });
    await settle();
    expect(q(page, '[data-part=money] [data-unrecognised][data-side=private]')?.textContent).toBe(EN['vault.privateMoney.unrecognised_other']!.replace('{count}', '2'));
  });

  /* RED WHEN: a read that could not read both sides is said as the money just updated. */
  it('says when the money was last read in full, not when a read failed', async () => {
    state.privateMoney = { of: 'unreadable', why: 'chain' };
    state.publicMoney = { amounts: [NIGHT(1n, 'public')], unrecognised: 0 };
    const c = await draw('vault', { vault: VAULT });
    await settle();
    expect(q(c, '[data-part=money] [data-updated]')).toBeNull();
  });

  /* RED WHEN: the time since the money was read is not said again as time passes. */
  it('says how long ago the money was read, as time passes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      state.privateMoney = { of: 'held', amounts: [], unrecognised: 0 };
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
    state.privateMoney = { of: 'held', amounts: [], unrecognised: 0 };
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
   * pressing it on a vault not set up does not open carrying its set up on in the
   * panel, or follows the tile's link; pressing it on a company not handed
   * over does not open who holds the company in the panel; the Vaults page does not list each
   * pending vault as a row of its own at the top with its action; or that
   * list is drawn when nothing is pending.
   */
  it('marks a pending vault with the Pending pill, lists it on top, and opens what finishes it', async () => {
    /* The vault carried on has its name filed, so carrying it on asks only to confirm. */
    state.vaultName = 'Treasury';
    const OTHER = 'cd'.repeat(32);
    state.company = records({ vaults: { of: 'read', value: [vaultOf('start-owed'), vaultOf('account-not-handed-over', OTHER), vaultOf('held-by-other-keys', 'ef'.repeat(32))] } });
    const c = await draw('vaults');
    await settle();
    const pill = q(c, `[data-slot=stat-tile][data-vault="${VAULT}"] [data-pending]`)!;
    expect(pill.textContent).toBe(EN['vaults.pending']);
    expect(pill.dataset.variant).toBe('destructive');
    expect(q(c, `[data-slot=stat-tile][data-vault="${VAULT}"]`)!.textContent).not.toContain(EN['vaults.standing.startOwed']);
    expect(all(c, '[data-part=vaults-pending] [data-pending-vault]').map((r) => [r.dataset.pendingVault, r.textContent])).toEqual([
      [VAULT, `Vault 1${EN['vaults.standing.startOwed']}${EN['createVault.finishStart']}`],
      [OTHER, `Vault 2${EN['vaults.standing.accountNotHandedOver']}${EN['committeeChange.button']}`],
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
    expect(document.querySelector('[data-panel] [data-action=committee-change]')).not.toBeNull();
    cleanup();
    const explain = await draw('vaults');
    await settle();
    await act(async () => { fireEvent.click(q(explain, `[data-vault="${'ef'.repeat(32)}"] [data-pending]`)!); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-slot=tooltip-content]')?.textContent).toContain(EN['vaults.standing.heldByOtherKeys']);
    expect(document.querySelector('[data-panel]')).toBeNull();
    cleanup();
    const rowsPress = await draw('vaults');
    await settle();
    await act(async () => { fireEvent.click(q(rowsPress, `[data-pending-vault="${VAULT}"] [data-action=finish-start]`)!); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-panel] [data-action=create-vault] [data-slot=confirm-in-your-account]')).not.toBeNull();
    cleanup();
    const rowsHand = await draw('vaults');
    await settle();
    await act(async () => { fireEvent.click(q(rowsHand, `[data-pending-vault="${OTHER}"] [data-action=committee-change]`)!); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-panel] [data-action=committee-change]')).not.toBeNull();
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

  /*
   * RED WHEN: the signers page does not show the committee change - what holds the company, and for a change owed the
   * signatures it has and needs - or shows it twice; or the page shows the change of the approvals needed other than once;
   * or the page carries a Coming soon pill again.
   */
  it('shows the committee change and the change of the approvals needed on the signers page, once each, with no Coming soon', async () => {
    state.handover = { of: 'change-owed', signed: [{ have: 1, required: 2 }] };
    const c = await draw('settingsSigners');
    await settle();
    expect(all(c, '[data-action=committee-change]')).toHaveLength(1);
    expect(q(c, '[data-public-facts]')!.textContent).toBe(EN['settingsSigners.publicFacts']);
    expect(all(c, '[data-change-owed] li').map((li) => li.textContent)).toEqual(['1 of 2 signed']);
    expect(q(c, '[data-action=sign-change]')).not.toBeNull();
    expect(all(c, '[data-action=change-threshold]')).toHaveLength(1);
    expect(q(c, '[data-screen=coming-soon]')).toBeNull();
    expect(q(c, '[data-screen=settings] [data-slot=coming-soon]')).toBeNull();
  });

  /*
   * RED WHEN: a vault its super admins hold and that is not set up is shown as set up, is not marked pending, or
   * its pill and its row do not open carrying its set up on in the panel - which any signer does from their own device.
   */
  it('marks a vault held and not set up as pending, says so, and opens carrying its set up on', async () => {
    /* The vault carried on has its name filed, so carrying it on asks only to confirm. */
    state.vaultName = 'Treasury';
    state.company = records({ vaults: { of: 'read', value: [vaultOf('start-owed')] } });
    const c = await draw('vaults');
    await settle();
    const pill = q(c, `[data-slot=stat-tile][data-vault="${VAULT}"] [data-pending]`)!;
    expect(pill.dataset.pending).toBe('start-owed');
    expect(q(c, `[data-slot=stat-tile][data-vault="${VAULT}"]`)!.textContent).not.toContain(EN['vaults.standing.held']);
    expect(all(c, '[data-part=vaults-pending] [data-pending-vault]').map((r) => r.textContent)).toEqual([
      `Vault 1${EN['vaults.standing.startOwed']}${EN['createVault.finishStart']}`,
    ]);
    await act(async () => { fireEvent.click(pill); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-panel] [data-action=create-vault] [data-slot=confirm-in-your-account]')?.textContent).toContain(EN['createVault.confirmStart']);
    cleanup();
    const rows = await draw('vaults');
    await settle();
    await act(async () => { fireEvent.click(q(rows, `[data-pending-vault="${VAULT}"] [data-action=finish-start]`)!); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-panel] [data-action=create-vault] [data-slot=confirm-in-your-account]')?.textContent).toContain(EN['createVault.confirmStart']);
  });

  /*
   * RED WHEN: a vault the account adopted shows its number instead of the name the company filed for it, or a vault it
   * did not adopt shows a name or has one asked for; or a vault with no readable name shows anything but its number.
   */
  it('names an adopted vault by the name filed for it, and any other vault, or one with no readable name, by its number', async () => {
    const OTHER = 'cd'.repeat(32);
    state.company = records({ vaults: { of: 'read', value: [{ ...vaultOf('held-by-committee'), adopted: true }, vaultOf('start-owed', OTHER)] } });
    state.vaultName = 'Treasury';
    const c = await draw('vaults');
    await settle();
    const title = (vault: string) => q(c, `[data-slot=stat-tile][data-vault="${vault}"] [data-slot=stat-tile-title]`)!.textContent;
    expect([title(VAULT), title(OTHER)]).toEqual(['Treasury', `Vault 2${EN['vaults.pending']}`]);
    expect(state.namesAsked).toEqual([VAULT]);
    cleanup();
    state.vaultName = null;
    const unnamed = await draw('vaults');
    await settle();
    expect(q(unnamed, `[data-slot=stat-tile][data-vault="${VAULT}"] [data-slot=stat-tile-title]`)!.textContent).toBe('Vault 1');
  });

  /* RED WHEN: a vault's page names it by its number while its tile, or the list of what is pending, shows the name filed for it. */
  it('names a vault on its own page as its tile does', async () => {
    state.company = records({ vaults: { of: 'read', value: [{ ...vaultOf('held-by-committee'), adopted: true }] } });
    state.vaultName = 'Treasury';
    const tiles = await draw('vaults');
    await settle();
    const onTile = q(tiles, `[data-slot=stat-tile][data-vault="${VAULT}"] [data-slot=stat-tile-title]`)!.textContent;
    cleanup();
    const page = await draw('vault', { vault: VAULT });
    await settle();
    expect(q(page, `[data-screen=vault] [data-vault="${VAULT}"]`)!.textContent).toBe(onTile);
    expect(onTile).toBe('Treasury');
  });

  /*
   * RED WHEN: a vault's page does not say how many approvals the chain holds for that vault, or says it for one the account did not adopt or whose
   * number was not read, or offers Change approvals anywhere but the shell's panel; or the control does not ask for this vault and the number chosen,
   * or its result is not kept on screen once the records are read again.
   */
  it('tells a vault\'s approvals and changes them from the shell\'s panel, keeping the result on screen', async () => {
    const adopted = { ...vaultOf('held-by-committee'), adopted: true as const };
    state.company = records({
      approvalsNeeded: { of: 'read', value: 1 }, approvalsForSigners: { of: 'read', value: { count: 1, raisedAboveTheAccount: false, vaultsAtThatNumber: [], seated: 3 } },
      vaults: { of: 'read', value: [{ ...adopted, approvals: 2 }] },
    });
    state.acts = []; state.acted = { of: 'done', state: 'carried-out', approvals: 1, needed: 1 };
    const page = await draw('vault', { vault: VAULT });
    await settle();
    expect(q(page, '[data-screen=vault] [data-vault-approvals]')!.textContent).toBe(EN['vault.approvals_other']!.replace('{count}', '2'));
    expect(q(page, '[data-screen=vault] [data-action=change-approvals]')!.textContent).toBe(EN['vault.approvals.change']);
    expect(q(page, '[data-action=change-threshold]')).toBeNull();
    await act(async () => { fireEvent.click(q(page, '[data-action=change-approvals]')!); await new Promise((r) => setTimeout(r, 5)); });
    const panel = () => document.querySelector('[data-panel]') as HTMLElement;
    expect(q(panel(), '[data-action=change-threshold]')).not.toBeNull();
    await act(async () => { fireEvent.click(q(panel(), '[data-action=threshold-more]')!); await new Promise((r) => setTimeout(r, 5)); });
    await act(async () => { fireEvent.click(q(panel(), '[data-action=raise-threshold]')!); await new Promise((r) => setTimeout(r, 20)); });
    expect(state.acts).toEqual([['change-threshold', 'u1', 'c-1', 3, { now: 2, seated: 3 }, expect.any(Function), VAULT]]);
    expect(q(panel(), '[data-acted]')!.textContent).toContain(EN['changeThreshold.vault.done.carried_other']!.replace('{count}', '3').replace('{vault}', 'Vault 1'));
    cleanup();
    state.company = records({ vaults: { of: 'read', value: [adopted] } });
    const unread = await draw('vault', { vault: VAULT });
    await settle();
    expect(q(unread, '[data-vault-approvals]')).toBeNull();
    expect(q(unread, '[data-unreadable=approvals]')!.textContent).toBe(EN['vault.approvals.unread']);
    expect((q(unread, '[data-action=change-approvals]') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    state.company = records({ vaults: { of: 'read', value: [{ ...vaultOf('held-by-committee'), approvals: 2 }] } });
    const notAdopted = await draw('vault', { vault: VAULT });
    await settle();
    expect(q(notAdopted, '[data-part=approvals]')).toBeNull();
  });

  /*
   * RED WHEN: a vault's page leaves a raised leg of a run whose proposal the chain shows approved without its Pay, offers Pay before the chain
   * shows it approved, for a leg the chain shows paid in full, one with no proposal or one keyed before a run paid one form, or still shows a Coming soon pay out; or Pay is anywhere but the shell's panel, does not show what the payment makes
   * public before it is pressed, does not ask the wallet for the leg shown, or loses the wallet's answer once the records are read again.
   */
  it('pays a raised leg from the shell\'s panel, with what it makes public shown first, and keeps the answer', async () => {
    const adopted = { ...vaultOf('held-by-committee'), adopted: true as const };
    const legs = [{ ...RUN.legs[0]!, proposal: null }, { ...RUN.legs[0]!, code: `${NIGHT_TOKEN}`, form: null }];
    const approved = PROPOSALS.map((p) => (p.id === 'p1' ? { ...p, status: 'approved' as const } : p));
    state.company = records({ vaults: { of: 'read', value: [adopted] }, runs: { of: 'read', value: [RUN, { ...RUN, id: 'r2', period: '2026-11', legs }, { ...PAID_RUN, legs: [{ ...PAID_RUN.legs[0]!, vault: VAULT }] }] } });
    state.acts = []; state.payActed = { of: 'done', state: 'paid', paid: 2, owed: 0, unseen: 0 };
    /* The chain shows the run's proposal still waiting for approvals: nothing is offered to pay yet. */
    const waiting = await draw('vault', { vault: VAULT });
    await settle();
    expect(all(waiting, '[data-part=payouts] [data-action=pay-run]')).toEqual([]);
    expect(all(waiting, '[data-part=payouts] [data-payout]')).toHaveLength(4);
    cleanup();
    state.company = records({ vaults: { of: 'read', value: [adopted] }, proposals: { of: 'read', value: approved }, runs: { of: 'read', value: [RUN, { ...RUN, id: 'r2', period: '2026-11', legs }, { ...PAID_RUN, legs: [{ ...PAID_RUN.legs[0]!, vault: VAULT }] }] } });
    const page = await draw('vault', { vault: VAULT });
    await settle();
    expect(all(page, '[data-part=payouts] [data-action=pay-run]').map((b) => b.closest('[data-payout]')!.getAttribute('data-payout'))).toEqual(['r1']);
    expect(all(page, '[data-part=payouts] [data-payout]')).toHaveLength(4);
    expect(q(page, '[data-action=pay-out]')).toBeNull();
    expect(q(page, '[data-part=payouts] [data-slot=coming-soon]')).toBeNull();
    await act(async () => { fireEvent.click(q(page, '[data-part=payouts] [data-action=pay-run]')!); await new Promise((r) => setTimeout(r, 5)); });
    const panel = () => document.querySelector('[data-panel]') as HTMLElement;
    expect(q(panel(), '[data-public-facts=private]')).not.toBeNull();
    expect(q(panel(), '[data-fact=count]')!.textContent).toBe(EN['publicFacts.count_other']!.replace('{count}', '2'));
    expect(q(page, '[data-pay-state]')).toBeNull();
    expect(state.acts).toEqual([]);
    await act(async () => { fireEvent.click(q(panel(), '[data-action=pay-run]')!); await new Promise((r) => setTimeout(r, 20)); });
    expect(state.acts).toEqual([['pay-run', 'u1', 'c-1', {
      proposal: 'p1', run: 'r1', period: '2026-10', list: 'employees', vault: VAULT, token: NIGHT_TOKEN, form: 'shielded', payees: 2, total: 7_000_000n,
    }, expect.any(Function)]]);
    expect(q(panel(), '[data-pay-state=paid]')!.textContent).toBe(EN['payRun.done.paid_other']!.replace('{count}', '2'));
  });

  /* RED WHEN: a retry raised on a leg cannot be paid from the vault's page like a run, is offered before its own proposal is approved, or after the chain shows it paid. */
  it('offers Pay on a retry once its own proposal is approved, and not once the chain shows it paid', async () => {
    const adopted = { ...vaultOf('held-by-committee'), adopted: true as const };
    const retry = { proposal: 'p3', vault: VAULT, people: 1, total: 2_000_000n, pays: [LEG_MORE.pays[1]!], leaves: ['bb'], paidOnChain: PAID_STATE.none };
    const withRetry = (paidOnChain: 0 | 2): RunRow => ({ ...RUN, legs: [{ ...RUN.legs[0]!, paidOnChain: PAID_STATE.some, retries: [{ ...retry, paidOnChain }] }] });
    const p3 = (status: 'open' | 'approved'): ProposalRow => ({ ...PROPOSALS[1]!, id: 'p3', status });
    const opens = async (run: RunRow, proposals: ProposalRow[]) => {
      state.company = records({ vaults: { of: 'read', value: [adopted] }, proposals: { of: 'read', value: proposals }, runs: { of: 'read', value: [run] } });
      const page = await draw('vault', { vault: VAULT });
      await settle();
      return all(page, '[data-part=payouts] [data-action=pay-run]').map((b) => [b.dataset.payRetry ?? null, b.textContent]);
    };
    state.acts = []; state.payActed = { of: 'done', state: 'paid', paid: 1, owed: 0, unseen: 0 };
    /* The leg's own proposal is still waiting, and the retry's is not yet approved: nothing to pay. */
    expect(await opens(withRetry(PAID_STATE.none), [PROPOSALS[1]!, p3('open')])).toEqual([]);
    cleanup();
    expect(await opens(withRetry(PAID_STATE.none), [PROPOSALS[1]!, p3('approved')])).toEqual([['p3', EN['vault.payRetry']]]);
    await act(async () => { fireEvent.click(q(document.body, '[data-part=payouts] [data-action=pay-run]')!); await new Promise((r) => setTimeout(r, 5)); });
    await act(async () => { fireEvent.click(q(document.querySelector('[data-panel]') as HTMLElement, '[data-action=pay-run]')!); await new Promise((r) => setTimeout(r, 20)); });
    expect(state.acts).toEqual([['pay-run', 'u1', 'c-1', {
      proposal: 'p3', run: 'r1', period: '2026-10', list: 'employees', vault: VAULT, token: NIGHT_TOKEN, form: 'shielded', payees: 1, total: 2_000_000n,
    }, expect.any(Function)]]);
    cleanup();
    expect(await opens(withRetry(PAID_STATE.all), [PROPOSALS[1]!, p3('approved')])).toEqual([]);
  });

  /* RED WHEN: a vault the account adopted whose set-up is not finished is named on its tile and by its number in the list of what is pending. */
  it('names an adopted vault the same on its tile and in the list of what is pending', async () => {
    state.company = records({ vaults: { of: 'read', value: [{ ...vaultOf('start-owed'), adopted: true }] } });
    state.vaultName = 'Treasury';
    const c = await draw('vaults');
    await settle();
    expect(q(c, `[data-slot=stat-tile][data-vault="${VAULT}"] [data-slot=stat-tile-title]`)!.textContent).toContain('Treasury');
    expect(q(c, `[data-pending-vault="${VAULT}"]`)!.textContent).toBe(`Treasury${EN['vaults.standing.startOwed']}${EN['createVault.finishStart']}`);
  });

  /* RED WHEN: a standing no service gives any more, or a way to finish it, is still in the words the page says. */
  it('keeps no words for a hand-over that is owed on a vault, which no vault stands in any more', () => {
    expect(Object.keys(EN).filter((k) => /handoverOwed|^createVault\.finish$/.test(k))).toEqual([]);
  });

  /*
   * RED WHEN: a standing phrase says as a fact about the vault that no money can go in; a standing a gate of this
   * app refuses money for stops saying this app puts none in; a standing no gate stands behind - who holds the
   * account or the vault, which no payment reads - says anything about money, as does the vault-created line on
   * the account; or any string says the signers hold the company or a vault, which its super admins hold.
   */
  it('says this app puts no money in only where a gate refuses it, and never that the signers hold anything', () => {
    for (const k of ['notFundable', 'accountNotFundable', 'startOwed']) {
      expect(EN[`vaults.standing.${k}`], k).not.toMatch(/no money can go/i);
      expect(EN[`vaults.standing.${k}`], k).toMatch(/this app puts no money|it puts no money/i);
    }
    for (const k of ['vaults.standing.accountNotHandedOver', 'vaults.standing.heldByOtherKeys', 'createVault.held.byOtherKeys']) {
      expect(EN[k], k).not.toMatch(/money/i);
      expect(EN[k], k).toMatch(/super admins/);
    }
    expect(Object.entries(EN).filter(([, v]) => /(held by|handed to|hand(ed)? over to) (your|its|the) signers|signers (hold|do not hold)/i.test(String(v)))).toEqual([]);
    expect(EN['committeeChange.what']).toMatch(/without the signers, they can change any of those rules, and so take money out of any vault/i);
  });

  /* RED WHEN: a vault's payouts are not the runs that pay out of it, or the tiles lead anywhere but the vault's own page. */
  it('lists the runs that pay out of the vault, and a tile opens the vault\'s page', async () => {
    const c = await draw('vault', { vault: VAULT });
    expect(all(c, '[data-part=payouts] [data-payout]').map((e) => e.dataset.payout)).toEqual(['r1']);
    /* RED WHEN a payout names its leg by the token rather than its symbol, or does not say how it pays. */
    const row = q(c, '[data-part=payouts] [data-payout=r1]')!;
    expect(row.textContent).toContain('NIGHT');
    expect(row.textContent).not.toContain(NIGHT_TOKEN);
    expect(q(row, '[data-paid]')?.dataset.paid).toBe('privately');
    cleanup();
    const tiles = await draw('vaults');
    expect((q(tiles, `[data-vault="${VAULT}"]`) as HTMLAnchorElement).getAttribute('href')).toBe(`/vaults/${VAULT}`);
  });
});

describe('people and invitations', () => {
  /* RED WHEN: the people are not in the kit's table, a person's standing or how they are paid is not theirs, their pay has a visibility when no address decides it (a person with no payment address yet is shown a figure alone, never the Public pill), or their row does not open their panel. */
  it('lists the people and opens a person\'s panel', async () => {
    const c = await draw('people');
    expect(all(c, '[data-screen=people] [data-slot=data-table] tbody tr').map((p) => [p.dataset.row, q(p, '[data-standing]')!.textContent, q(p, '[data-paid]')!.textContent, q(p, '[data-slot=amount]')?.dataset.visibility ?? 'none'])).toEqual([
      ['e1', EN['people.standing.active'], EN['records.paid.privately'], 'private'], ['e5', EN['people.standing.waitingForCheck'], EN['records.paid.notSetUp'], 'none'],
    ]);
    expect(q(c, '[data-row=e5] [data-pay-unset]')!.textContent).toMatch(/NIGHT/);
    expect(q(c, '[data-row=e5] [data-slot=public-pill]')).toBeNull();
    await act(async () => { fireEvent.click(q(c, '[data-row=e5] td:last-child')!); });
    expect(document.querySelector('[data-person-panel=e5]')).not.toBeNull();
  });

  /* RED WHEN: a sent link is not listed, a link that names nobody is given a name, a vendor's link is missing or labelled as an employee's, the waiting tab leaves out someone waiting, or a Codes received tab, or a line of signers waiting for the check, is drawn. */
  it('shows the sent links and the people waiting, by the kit\'s tabs', async () => {
    const c = await draw('invitations');
    expect(all(c, '[data-sent] [data-invitation]').map((e) => [e.dataset.invitation, e.querySelector('.font-medium')!.textContent])).toEqual([['signer', 'Tom'], ['employee', EN['invitations.noName']], ['vendor', 'Vik']]);
    expect(all(c, '[data-sent] [data-kind]').map((e) => [e.dataset.kind, e.textContent])).toEqual([['signer', EN['invitations.kind.signer']], ['employee', EN['invitations.kind.employee']], ['vendor', EN['invitations.kind.vendor']]]);
    expect(all(c, '[data-tab]').map((t) => t.dataset.tab)).toEqual(['sent', 'waiting']);
    expect(q(c, '[data-tab-soon]')).toBeNull();
    await act(async () => { fireEvent.mouseDown(q(c, '[data-tab=waiting]')!, { button: 0 }); });
    expect(all(c, '[data-waiting] [data-person]').map((e) => e.dataset.person)).toEqual(['e5']);
    expect(q(c, '[data-signers-waiting]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Codes received|Signers waiting for the check/u);
  });
});

describe('people, payroll, proposals, a run and invitations, drawn from the kit', () => {
  /* RED WHEN: one of the five pages draws its heading other than with the kit's page header, has a second heading, or an action of the page is not in the header's actions. */
  it('heads each page with the kit\'s page header, its actions in it', async () => {
    const EACH = [
      ['people', {}, EN['page.people.name'], ['invite']], ['vendors', {}, EN['page.vendors.name'], ['invite']], ['payroll', {}, EN['page.payroll.name'], ['new-run']], ['proposals', {}, EN['page.proposals.name'], []],
      ['run', { run: 'r1' }, 'October 2026', ['export-run']], ['invitations', {}, EN['page.invitations.name'], ['invite']],
    ] as const;
    for (const [id, params, title, actions] of EACH) {
      const c = await draw(id, params);
      const header = q(c, `[data-screen=${id}] [data-slot=page-header]`)!;
      expect(all(c, `[data-screen=${id}] h1`).map((h) => [h.closest('[data-slot=page-header]') === header, h.textContent]), id).toEqual([[true, title]]);
      expect(all(header, '[data-action]').map((a) => a.dataset.action), id).toEqual([...actions]);
      cleanup();
    }
  });

  /* RED WHEN: a list with nothing in it is drawn as a bare line instead of the kit's empty state, or its words change. */
  it('shows each list with nothing in it as the kit\'s empty state, in the same words', async () => {
    state.company = records({ proposals: { of: 'read', value: [] }, runs: { of: 'read', value: [] }, people: { of: 'read', value: [] }, peopleBelief: { of: 'read', value: { rows: [], notBelieved: [], notPayable: [], refused: [] } }, invitations: { of: 'read', value: [] }, vendorsBelief: { of: 'read', value: { vendors: [], rows: [], notBelieved: [], notPayable: [] } } });
    const line = (c: ParentNode) => all(c, '[data-screen] [data-slot=empty-state] [data-slot=empty-state-line]').map((e) => e.textContent);
    for (const [id, key] of [['people', 'people.none'], ['vendors', 'vendors.none'], ['payroll', 'payroll.none'], ['proposals', 'proposals.none'], ['invitations', 'invitations.sent.none']] as const) {
      const c = await draw(id);
      expect(line(c), id).toEqual([EN[key]]);
      if (id === 'invitations') {
        await act(async () => { fireEvent.mouseDown(q(c, '[data-tab=waiting]')!, { button: 0 }); });
        expect(all(q(c, '[data-waiting]')!, '[data-slot=empty-state] [data-slot=empty-state-line]').map((e) => e.textContent), 'waiting').toEqual([EN['invitations.waiting.none']]);
      }
      cleanup();
    }
  });

  /* RED WHEN: a run's currency is not a kit section with its approvals and Approve at the end of its title, or who is paid is not the kit's section of rows. */
  it('draws a run\'s currencies and who it pays in the kit\'s sections', async () => {
    const c = await draw('run', { run: 'r1' });
    const night = q(c, `[data-part=currencies] [data-slot=section][data-currency="${NIGHT_TOKEN}"]`)!;
    /* RED WHEN the section is titled with the token rather than its symbol. */
    expect(q(night, '[data-slot=section-header] h2')!.textContent).toBe('NIGHT');
    /* RED WHEN one Approve covers both ways a token is paid, rather than one on each way's own line. */
    expect(q(night, '[data-slot=section-actions] [data-action=approve]')).toBeNull();
    expect(all(night, '[data-round]').map((r) => [r.dataset.round, all(r, ':scope > div button[data-action]').map((b) => b.dataset.action)])).toEqual([
      ['privately', ['withdraw']], ['publicly', []],
    ]);
    expect(q(night, '[data-approvals]')!.textContent).toBe('1 of 2');
    const payees = q(c, '[data-slot=section][data-part=payees]')!;
    expect(q(payees, '[data-slot=section-header] h2')!.textContent).toBe(EN['run.whoIsPaid']);
    expect(all(payees, '[data-slot=section-row]').map((r) => r.dataset.payee)).toEqual(['e1', 'e2', 'e3']);
  });

  /* RED WHEN: a person's or a proposal's panel is drawn by hand instead of as the kit's items, or loses a line. */
  it('draws a person\'s and a proposal\'s details as the kit\'s items', async () => {
    const people = await draw('people');
    await act(async () => { fireEvent.click(q(people, '[data-row=e1] td')!); });
    const person = document.querySelector('[data-person-panel=e1]') as HTMLElement;
    expect(all(person, '[data-slot=item]').map((i) => q(i, '[data-slot=item-description]')!.textContent)).toEqual([
      EN['people.column.title'], EN['people.column.standing'], EN['people.started'], EN['people.column.pay'], EN['people.classification'], EN['people.endDate'], EN['people.leavingDate'], EN['people.column.paid'],
    ]);
    expect(q(person, '[data-slot=item] [data-slot=item-title]')!.textContent).toBe('Engineer');
    /* A value is never cut to its first line, as the kit's item title is by default. */
    expect(all(person, '[data-slot=item-title]').map((e) => e.className.split(/\s+/).includes('line-clamp-none'))).toEqual([true, true, true, true, true, true, true, true]);
    expect(q(person, 'dl, dt, dd')).toBeNull();
    cleanup();
    const proposals = await draw('proposals');
    await act(async () => { fireEvent.click(q(proposals, '[data-row=p1] td')!); });
    const proposal = document.querySelector('[data-proposal-panel=p1]') as HTMLElement;
    expect(all(proposal, '[data-slot=item]').map((i) => [q(i, '[data-slot=item-description]')!.textContent, q(i, '[data-slot=item-title]')!.textContent])).toEqual([
      [EN['proposals.column.raisedBy'], 'Sam'], [EN['proposals.column.raised'], 'Sep 21, 2026'], [EN['proposals.column.approvals'], '1 of 2'], [EN['proposals.column.status'], EN['proposals.status.open']],
    ]);
    expect(q(proposal, 'dl, dt, dd')).toBeNull();
  });
});
