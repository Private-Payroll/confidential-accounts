// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom, privateAmount, publicAmount } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { VIEWS } from '../pages.js';
import { ENGLISH } from '../english.test-support.js';
import type { RunLeg, RunRow } from '../adapters/company-records.js';

/*
 * THE PAY CONTROL, DRAWN over the real adapter and the real wallet wrapper, with only the call to the wallet and the company's records
 * stood in for: what is shown before Pay, what is asked of the wallet and how often, the words that follow each way the wallet answers,
 * and that the result stays on screen when the company's records are read again and stand empty.
 */
vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180'); });
const kr = vi.hoisted(() => ({
  acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown, steps: [] as { step: number; steps: number }[],
  hold: null as Promise<void> | null, company: null as unknown, reads: 0, user: { id: 'u1' } as { id: string } | null,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.user,
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => ({ companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) }),
  actOnACompanyInTheWallet: async (intent: Record<string, string>, _origin: string, opts?: { onStep?: (at: { step: number; steps: number }) => void }) => {
    kr.acts.push(intent);
    for (const at of kr.steps) opts?.onStep?.(at);
    if (kr.hold !== null) await kr.hold;
    return kr.ended;
  },
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => { kr.reads += 1; return kr.company; },
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  companyNamesFor: async () => new Map(),
}));

const { PayRun } = await import('./pay-run.js');
const { SessionProvider } = await import('../session.js');
const { PanelProvider, RightPanel, usePanel } = await import('../shell/right-panel.js');
const { CompanyRecordsProvider } = await import('../records/company-records.js');
const { WithRecords } = await import('../records/parts.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const words = (key: string, values: Record<string, string | number> = {}): string => {
  const count = values['count'];
  const form = count === undefined ? EN[key] : EN[`${key}_${count === 1 ? 'one' : 'other'}`] ?? EN[key];
  return Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), form ?? key);
};

const TOKEN = '00'.repeat(32);
const VAULT = 'ab'.repeat(32);
const LEG: RunLeg = {
  code: `${TOKEN}:shielded`, asset: TOKEN, symbol: 'NIGHT', paid: 'privately', vault: VAULT, payees: 2, proposal: 'prop_0001', form: 'shielded', list: 'employees', people: 2, total: 7_000_000n,
  pays: [{ name: 'Ana', address: 'mn_shield-addr_ana', amount: privateAmount(5_000_000n, 6, 'NIGHT') }, { name: 'Bo', address: 'mn_shield-addr_bo', amount: privateAmount(2_000_000n, 6, 'NIGHT') }],
};
const PUBLIC_LEG: RunLeg = { ...LEG, code: `${TOKEN}:unshielded`, paid: 'publicly', form: 'unshielded', pays: [{ name: 'Ana', address: 'mn_addr_ana', amount: publicAmount(5_000_000n, 6, 'NIGHT') }, { name: 'Bo', address: 'mn_addr_bo', amount: publicAmount(2_000_000n, 6, 'NIGHT') }] };
const RUN = { id: 'run_1', period: '2026-10' } as RunRow;
const WIRE = { name: 'pay-run', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), proposal: 'prop_0001', run: 'run_1', period: '2026-10', list: 'employees', vault: VAULT, token: TOKEN, form: 'private', payees: '2', total: '7000000' };

const records = () => ({ of: 'open', id: 'c-1', name: 'Northwind', signers: [], approvalsNeeded: { of: 'read', value: 2 }, proposals: { of: 'read', value: [] } });
const session = () => ({
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true },
  chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
});
const inPage = (node: React.ReactNode) => render(
  <KitProvider languages={LANGUAGES} pick="en">
    <SessionProvider session={session()}><PanelProvider><CompanyRecordsProvider>{node}<RightPanel /></CompanyRecordsProvider></PanelProvider></SessionProvider>
  </KitProvider>,
);
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }); };
const q = (s: string): HTMLElement | null => document.body.querySelector(s);
const press = async (selector: string) => { fireEvent.click(q(selector)!); await settle(); };
const draw = async (leg: RunLeg = LEG) => { inPage(<PayRun run={RUN} leg={leg} vaultName="Vault 3" />); await settle(); };
const stopped = (refused?: string, over: Record<string, unknown> = {}) => ({ of: 'stopped', step: 3, steps: 4, relayed: 0, unconfirmed: 0, why: refused === undefined ? 'relay-refused' : 'check-failed', ...(refused === undefined ? {} : { refused }), ...over });

beforeEach(() => {
  kr.acts = []; kr.steps = []; kr.hold = null; kr.reads = 0; kr.user = { id: 'u1' }; kr.company = records();
  kr.ended = { of: 'done', steps: 5, relayed: 2, outcome: { state: 'paid', paid: 2, owed: 0, unseen: 0, charge: 'none' } };
});
afterEach(cleanup);

describe('what is shown before Pay', () => {
  /* RED WHEN: Pay can be pressed before the person is shown what the payment makes public, or the wallet is asked anything before Pay is pressed. */
  it('shows the run, the people and what the payment makes public, and asks the wallet nothing until Pay is pressed', async () => {
    await draw();
    expect(q('[data-pay-run-run]')!.textContent).toContain('October 2026');
    expect(q('[data-pay-run-run]')!.textContent).toContain(words('payRun.people', { count: 2 }));
    expect(q('[data-public-facts=private]')).not.toBeNull();
    expect(q('[data-fact=count]')!.textContent).toBe(words('publicFacts.count', { count: 2 }));
    expect(q('[data-fact=inference]')).not.toBeNull();
    expect(q('[data-pay-run-note]')!.textContent).toBe(EN['payRun.walletNote']);
    expect((q('[data-action=pay-run]') as HTMLButtonElement).disabled).toBe(false);
    expect(kr.acts).toEqual([]);
    cleanup();
    await draw(PUBLIC_LEG);
    expect(q('[data-public-facts=public]')).not.toBeNull();
    expect(document.body.querySelectorAll('[data-public-pay]')).toHaveLength(2);
  });

  /* RED WHEN: a leg that cannot be asked of the wallet (keyed before a run paid one form, or with no proposal) can still be pressed. */
  it('cannot be pressed for a leg the wallet cannot be asked to pay', async () => {
    await draw({ ...LEG, form: null });
    expect((q('[data-action=pay-run]') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    await draw({ ...LEG, proposal: null });
    expect((q('[data-action=pay-run]') as HTMLButtonElement).disabled).toBe(true);
    await press('[data-action=pay-run]');
    expect(kr.acts).toEqual([]);
  });
});

describe('what is asked of the wallet', () => {
  /* RED WHEN: the wallet is asked more than once for one press, with anything but the leg shown (the form as private or public), or the press stays on while it works; or the person is not told the wallet is working. */
  it('asks the wallet once with exactly the leg shown, says it is working, and keeps Pay off while it works', async () => {
    kr.steps = [{ step: 2, steps: 5 }];
    let release = (): void => {};
    kr.hold = new Promise<void>((r) => { release = r; });
    await draw();
    /* RED WHEN: the outcome has no polite status region on the page before the press, or the region that held the working words is replaced by another when the outcome arrives. */
    const region = q('[data-action=pay-run-panel] [data-act-outcome]')!;
    expect([region.getAttribute('role'), region.textContent]).toEqual(['status', '']);
    await press('[data-action=pay-run]');
    await press('[data-action=pay-run]');
    expect(kr.acts).toEqual([WIRE]);
    expect(q('[data-working]')!.textContent).toBe(words('signers.working.step', { step: 2, steps: 5 }));
    expect(q('[data-working]')!.closest('[data-act-outcome]')).toBe(region);
    expect((q('[data-action=pay-run]') as HTMLButtonElement).disabled).toBe(true);
    release();
    await settle();
    expect(q('[data-action=pay-run-panel] [data-act-outcome]')).toBe(region);
    expect(region.querySelector('[data-acted]')).not.toBeNull();
    expect(kr.acts).toHaveLength(1);
    cleanup();
    kr.acts = []; kr.hold = null;
    await draw(PUBLIC_LEG);
    await press('[data-action=pay-run]');
    expect(kr.acts).toEqual([{ ...WIRE, form: 'public' }]);
  });
});

describe('what comes back', () => {
  /* RED WHEN: a payment that went through is not told with how many were paid and that nobody is owed, or can be pressed again; or the records are not read again. */
  it('says everyone was paid, and reads the records again', async () => {
    await draw();
    await press('[data-action=pay-run]');
    expect(q('[data-pay-state=paid]')!.textContent).toBe(words('payRun.done.paid', { count: 2 }));
    expect((q('[data-action=pay-run]') as HTMLButtonElement).disabled).toBe(true);
    expect(kr.reads).toBe(2);
  });

  /* RED WHEN: a part payment is told as complete, loses how many are paid and owed, or cannot be pressed again to pay the rest. */
  it('says how many were paid and how many are still owed, and lets Pay be pressed again', async () => {
    kr.ended = { of: 'done', steps: 5, relayed: 1, outcome: { state: 'partly-paid', paid: 1, owed: 1, unseen: 0, charge: 'charged' } };
    await draw();
    await press('[data-action=pay-run]');
    expect(q('[data-pay-state=partly-paid]')!.textContent).toBe(words('payRun.done.partly', { paid: 1, owed: 1 }));
    expect((q('[data-action=pay-run]') as HTMLButtonElement).disabled).toBe(false);
    kr.ended = { of: 'done', steps: 5, relayed: 1, outcome: { state: 'partly-paid', paid: 1, owed: 0, unseen: 1 } };
    await press('[data-action=pay-run]');
    expect(q('[data-pay-state=partly-paid]')!.textContent).toBe(words('payRun.done.partly.unseen', { paid: 1, owed: 0, unseen: 1 }));
    expect(kr.acts).toHaveLength(2);
  });

  /* RED WHEN: the wallet's own answer for a leg the network already shows paid, or one still waiting for approvals, is told as a payment made now. */
  it('tells a leg already paid and a leg waiting for approvals in the wallet\'s own answer, as nothing paid now', async () => {
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'already-paid', paid: 0, owed: 0, charge: 'none' } };
    await draw();
    await press('[data-action=pay-run]');
    expect(q('[data-pay-state=already-paid]')!.textContent).toBe(EN['payRun.done.already']);
    expect((q('[data-action=pay-run]') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'awaiting-approvals', approvals: 1, needed: 2 } };
    await draw();
    await press('[data-action=pay-run]');
    expect((q('[data-action=pay-run]') as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-pay-state=awaiting-approvals]')!.textContent).toBe(EN['payRun.done.awaiting']);
    expect(q('[data-pay-state=paid]')).toBeNull();
  });

  /* RED WHEN: a stop of the wallet loses its own words (window not open, window closed, stopped part way, payment not as built), or one that sent nothing is not said to have sent nothing. */
  it('tells each stop in its own words, and nothing paid where nothing was', async () => {
    for (const [code, why] of [
      ['not-open-yet', 'not-open-yet'], ['window-closed', 'window-closed'], ['stopped', 'pay-stopped'], ['payment-not-as-built', 'payment-not-as-built'],
      ['stopped-unseen', 'pay-stopped-unseen'], ['not-paid', 'not-paid'], ['not-payable', 'not-payable'], ['not-as-shown', 'not-as-shown'], ['may-be-sent', 'may-be-sent'], ['nobody-knows', 'other'],
    ] as const) {
      kr.ended = stopped(`act.pay-run.why.${code}`);
      cleanup();
      await draw();
      await press('[data-action=pay-run]');
      expect(q(`[data-pay-stopped=${why}]`)!.textContent, code).toContain(EN[`payRun.why.${why}`]);
      /* RED WHEN: a stop that sent nothing is drawn as a calm notice. */
      if (['not-open-yet', 'window-closed', 'not-payable', 'not-as-shown'].includes(why)) expect(q(`[data-pay-stopped=${why}]`)!.className, code).toContain('text-destructive');
    }
    expect(EN['payRun.why.not-open-yet']).toMatch(/has not opened/);
    expect(EN['payRun.why.not-open-yet']).toMatch(/nothing was paid/);
    expect(EN['payRun.why.window-closed']).toMatch(/closed/);
    /* RED WHEN: a closed window tells the person to raise the run again, which could pay everyone twice, and not a retry. */
    expect(EN['payRun.why.window-closed']).toMatch(/Raise a retry/u);
    expect(EN['payRun.why.window-closed']).not.toMatch(/Raise the run again/u);
    expect(EN['payRun.why.pay-stopped']).toMatch(/pays only the people still owed/);
    kr.ended = stopped('act.pay-run.why.stopped', { outcome: { state: 'partly-paid', paid: 1, owed: 1, unseen: 0 } });
    cleanup();
    await draw();
    await press('[data-action=pay-run]');
    expect(q('[data-pay-stopped]')!.textContent).toContain(words('payRun.counts', { paid: 1, owed: 1 }));
    expect((q('[data-action=pay-run]') as HTMLButtonElement).disabled).toBe(false);
  });

  /* RED WHEN: a refusal before the wallet window opens (no one signed in here) is not told with what resolves it. */
  it('tells a refusal that came before the wallet opened', async () => {
    kr.user = null;
    await draw();
    await press('[data-action=pay-run]');
    expect(q('[data-action=pay-run]')).not.toBeNull();
    expect(kr.acts).toEqual([]);
    expect(document.body.querySelector('[role=alert], [data-slot=alert]')).not.toBeNull();
  });
});

describe('the result stays on screen', () => {
  /* RED WHEN: the result of a payment made from the vault's page is lost when the company's records are read again, so the person is never told what was paid. The records stand empty while they read, and everything drawn under them goes. */
  it('keeps its result in the panel while the company\'s records are read again and stand empty', async () => {
    const Opener = () => {
      const { open } = usePanel();
      return <button data-action="open-it" onClick={() => open({ title: 'Pay', body: <PayRun run={RUN} leg={LEG} vaultName="Vault 3" /> })}>open</button>;
    };
    inPage(<WithRecords>{() => <Opener />}</WithRecords>);
    await settle();
    await press('[data-action=open-it]');
    await press('[data-panel] [data-action=pay-run]');
    expect(kr.reads).toBe(2);
    expect(q('[data-panel] [data-pay-state=paid]')!.textContent).toBe(words('payRun.done.paid', { count: 2 }));
    expect(q('[data-action=open-it]')).not.toBeNull();
  });
});
