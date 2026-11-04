// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { VIEWS } from '../pages.js';
import { ENGLISH } from '../english.test-support.js';
import { untilPageShown } from '../page-shown.test-support.js';

/*
 * The panel the payroll page's New run opens: what it asks the wallet (a run to draw, naming no people and no total), what it shows of the wallet's
 * answer, and that the answer stays on screen while the company's records are read again.
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

const { Payroll } = await import('../screens/payroll.js');
const { SessionProvider } = await import('../session.js');
const { PanelProvider, RightPanel } = await import('../shell/right-panel.js');
const { CompanyRecordsProvider } = await import('../records/company-records.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const words = (key: string, values: Record<string, string | number> = {}): string =>
  Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), EN[key] ?? key);

const VAULT = 'ab'.repeat(32);
const records = () => ({
  of: 'open', id: 'c-1', name: 'Northwind', signers: [], approvalsNeeded: { of: 'read', value: 2 }, proposals: { of: 'read', value: [] },
  runs: { of: 'read', value: [] }, vaults: { of: 'read', value: [{ vault: VAULT, createdAt: '2026-09-01T00:00:00Z', standing: 'ready', adopted: true, approvals: 2 }] },
});
const session = () => ({
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true },
  chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
});
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }); };
const q = (s: string): HTMLElement | null => document.body.querySelector(s);
const press = async (selector: string) => { fireEvent.click(q(selector)!); await settle(); };
const opened = async () => {
  const view = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session()}><PanelProvider><CompanyRecordsProvider><Payroll /><RightPanel /></CompanyRecordsProvider></PanelProvider></SessionProvider>
    </KitProvider>,
  );
  await untilPageShown(view.container);
  await press('[data-action=new-run]');
};
const local = (ms: number): string => {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};
const DAY = 86_400_000;
const give = async (opens: string, closes: string) => {
  fireEvent.change(q('[data-field=opens]')!, { target: { value: opens } });
  fireEvent.change(q('[data-field=closes]')!, { target: { value: closes } });
  await settle();
};
const goodWindow = () => give(local(Date.now() + 2 * DAY), local(Date.now() + 9 * DAY));
const stopped = (refused?: string, over: Record<string, unknown> = {}) => ({ of: 'stopped', step: 2, steps: 4, relayed: 0, unconfirmed: 0, why: refused === undefined ? 'declined' : 'check-failed', ...(refused === undefined ? {} : { refused }), ...over });

beforeEach(() => {
  kr.acts = []; kr.steps = []; kr.hold = null; kr.reads = 0; kr.user = { id: 'u1' }; kr.company = records();
  kr.ended = { of: 'done', steps: 5, relayed: 1, outcome: { state: 'raised', run: 'run_9', proposal: 'prop_9', approvals: 1, needed: 2 } };
});
afterEach(cleanup);

describe('New run on the payroll page', () => {

  /* RED WHEN: New run stays disabled or opens nothing, or the panel asks the wallet anything before the person presses. */
  it('opens the panel from the page, and asks the wallet nothing until the person presses', async () => {
    await opened();
    expect((q('[data-action=new-run]') as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-panel] [data-action=raise-run-panel]')).not.toBeNull();
    expect(q('[data-raise-run-note]')!.textContent).toBe(EN['raiseRun.walletNote']);
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: the wallet is asked for a run with a total, people, a run's name or a proposal (the wallet draws and shows those), more than once, or with a field the person did not choose. */
  it('asks the wallet once to draw the run, with the fields that name it and no people and no total, and keeps Draw off while it works', async () => {
    kr.steps = [{ step: 2, steps: 5 }];
    let release = (): void => {};
    kr.hold = new Promise<void>((r) => { release = r; });
    await opened();
    fireEvent.change(q('[data-field=month]')!, { target: { value: '2026-11' } });
    const opens = local(Date.now() + 2 * DAY);
    const closes = local(Date.now() + 9 * DAY);
    await give(opens, closes);
    await press('[data-list=vendors]');
    await press('[data-form=unshielded]');
    await press('[data-panel] [data-action=raise-run]');
    await press('[data-panel] [data-action=raise-run]');
    expect(kr.acts).toHaveLength(1);
    const asked = kr.acts[0]!;
    expect(asked).toMatchObject({ name: 'raise-run', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), period: '2026-11', list: 'vendors', vault: VAULT, form: 'public' });
    expect(asked['token']).toMatch(/^[0-9a-f]{64}$/u);
    expect([asked['opensAt'], asked['closesAt']]).toEqual([String(new Date(opens).getTime() / 1000), String(new Date(closes).getTime() / 1000)]);
    for (const named of ['run', 'payees', 'total', 'indices', 'proposal']) expect(asked, named).not.toHaveProperty(named);
    expect(q('[data-working]')!.textContent).toBe(words('signers.working.step', { step: 2, steps: 5 }));
    expect((q('[data-action=raise-run]') as HTMLButtonElement).disabled).toBe(true);
    release();
    await settle();
    expect(kr.acts).toHaveLength(1);
  });

  /* RED WHEN: the result shows a count the wallet did not give, or is lost when the company's records are read again. */
  it('shows the wallet\'s answer and keeps it while the records are read again', async () => {
    await opened();
    await goodWindow();
    await press('[data-panel] [data-action=raise-run]');
    expect(q('[data-panel] [data-raise-state=raised]')!.textContent).toBe(words('raiseRun.done.counted', { approvals: 1, needed: 2 }));
    expect(kr.reads).toBe(2);
    expect((q('[data-action=raise-run]') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    kr.ended = { of: 'done', steps: 5, relayed: 1, outcome: { state: 'raised' } };
    await opened();
    await goodWindow();
    await press('[data-panel] [data-action=raise-run]');
    expect(q('[data-panel] [data-raise-state=raised]')!.textContent).toBe(EN['raiseRun.done']);
  });

  /* RED WHEN: a stop of the wallet is shown in another stop's words, or a refusal before the wallet opened is not shown. */
  it('shows each refusal in its own words, and nothing raised where nothing was', async () => {
    for (const [code, why] of [
      ['no-seat', 'seat'], ['not-a-run', 'not-a-run'], ['no-window', 'window'], ['not-as-shown', 'not-as-shown'], ['not-raised', 'not-raised'],
      ['raise-may-be-sent', 'may-be-sent'], ['nobody-knows', 'other'],
    ] as const) {
      kr.ended = stopped(`act.raise-run.why.${code}`);
      cleanup();
      await opened();
      await goodWindow();
      await press('[data-panel] [data-action=raise-run]');
      expect(q(`[data-raise-stopped=${why}]`)!.textContent, code).toContain(EN[`raiseRun.why.${why}`]);
      expect((q('[data-action=raise-run]') as HTMLButtonElement).disabled, code).toBe(false);
    }
    kr.ended = stopped();
    cleanup();
    await opened();
    await goodWindow();
    await press('[data-panel] [data-action=raise-run]');
    expect(q('[data-raise-stopped=stopped]')!.textContent).toContain(EN['signers.why.stopped']);
    kr.user = null;
    kr.acts = [];
    cleanup();
    await opened();
    await goodWindow();
    await press('[data-panel] [data-action=raise-run]');
    expect(kr.acts).toEqual([]);
    expect(document.body.querySelector('[role=alert], [data-slot=alert]')).not.toBeNull();
  });

  /* RED WHEN: the panel starts with a window filled in, can be pressed with either end empty, in the past or out of order, asks the wallet anything then, or does not say in words what is wrong. */
  it('has no window until the person gives one, and refuses a missing, past or backwards window on the page with its words', async () => {
    await opened();
    expect((q('[data-field=opens]') as HTMLInputElement).value).toBe('');
    expect((q('[data-field=closes]') as HTMLInputElement).value).toBe('');
    expect((q('[data-action=raise-run]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-window-problem=missing]')!.textContent).toBe(EN['raiseRun.window.missing']);
    await give(local(Date.now() + 2 * DAY), '');
    expect(q('[data-window-problem=missing]')).not.toBeNull();
    await give(local(Date.now() - 2 * DAY), local(Date.now() + 2 * DAY));
    expect(q('[data-window-problem=past]')!.textContent).toBe(EN['raiseRun.window.past']);
    await give(local(Date.now() + 2 * DAY), local(Date.now() + 1 * DAY));
    expect(q('[data-window-problem=order]')!.textContent).toBe(EN['raiseRun.window.order']);
    expect((q('[data-action=raise-run]') as HTMLButtonElement).disabled).toBe(true);
    await press('[data-panel] [data-action=raise-run]');
    fireEvent.submit(q('[data-action=raise-run-panel]')!);
    await settle();
    expect(kr.acts).toEqual([]);
    await goodWindow();
    expect(q('[data-window-problem]')).toBeNull();
    expect((q('[data-action=raise-run]') as HTMLButtonElement).disabled).toBe(false);
  });

  /* RED WHEN: a company with no vault can ask the wallet for a run. */
  it('cannot be pressed for a company with no vault to pay from', async () => {
    kr.company = { ...records(), vaults: { of: 'read', value: [] } };
    await opened();
    expect(q('[data-raise-run-no-vault]')).not.toBeNull();
    expect((q('[data-action=raise-run]') as HTMLButtonElement).disabled).toBe(true);
    await press('[data-panel] [data-action=raise-run]');
    expect(kr.acts).toEqual([]);
  });
});
