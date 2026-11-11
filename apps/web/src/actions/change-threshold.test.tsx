// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { VIEWS } from '../pages.js';
import { ENGLISH } from '../english.test-support.js';

/*
 * THE CHANGE-APPROVALS CONTROL, DRAWN over the real adapter and the real wallet wrapper, with only the call to the wallet and the
 * company's records stood in for: the number it starts at, the numbers it can reach, what is asked of the wallet, and the words that
 * follow each way the wallet answers.
 */
vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180'); });
const kr = vi.hoisted(() => ({
  acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown, steps: [] as { step: number; steps: number }[],
  hold: null as Promise<void> | null, company: null as unknown, reads: 0, user: { id: 'u1' } as { id: string } | null,
  told: null as unknown,
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
vi.mock('../adapters/proposal-acts.js', async (real) => {
  const actual = await real<typeof import('../adapters/proposal-acts.js')>();
  return { ...actual, changeThreshold: (...ask: Parameters<typeof actual.changeThreshold>) => (kr.told === null ? actual.changeThreshold(...ask) : Promise.resolve(kr.told)) };
});
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => { kr.reads += 1; return kr.company; },
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  companyNamesFor: async () => new Map(),
}));

const { ChangeThreshold } = await import('./change-threshold.js');
const { SessionProvider } = await import('../session.js');
const { PanelProvider, RightPanel, usePanel } = await import('../shell/right-panel.js');
const { CompanyRecordsProvider } = await import('../records/company-records.js');
const { WithRecords } = await import('../records/parts.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
/** A word with its {count} (or other values) filled in, for the plural form it is in. */
const words = (key: string, values: Record<string, string | number> = {}): string => {
  const count = values['count'];
  const form = count === undefined ? EN[key] : EN[`${key}_${count === 1 ? 'one' : 'other'}`] ?? EN[key];
  return Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), form ?? key);
};

const read = (value: unknown) => ({ of: 'read', value });
const records = (over: Record<string, unknown> = {}) => ({
  of: 'open', id: 'c-1', name: 'Northwind', signers: [], approvalsNeeded: read(2), proposals: read([]),
  approvalsForSigners: read({ count: 2, raisedAboveTheAccount: false, vaultsAtThatNumber: [], seated: 4 }),
  ...over,
});
const VAULT = 'ab'.repeat(32);
const withVaults = (approvals: number | undefined, over: Record<string, unknown> = {}) => records({
  vaults: read([{ vault: VAULT, createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee', adopted: true, ...(approvals === undefined ? {} : { approvals }) }]), ...over,
});
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
const draw = async (node: React.ReactNode = <ChangeThreshold />) => { inPage(node); await settle(); };
const stopped = (refused?: string) => ({ of: 'stopped', step: 3, steps: 4, relayed: 0, unconfirmed: 0, why: refused === undefined ? 'relay-refused' : 'check-failed', ...(refused === undefined ? {} : { refused }) });

beforeEach(() => {
  kr.acts = []; kr.steps = []; kr.hold = null; kr.reads = 0; kr.user = { id: 'u1' }; kr.company = records(); kr.told = null;
  kr.ended = { of: 'done', steps: 5, relayed: 2, outcome: { state: 'carried-out', approvals: 2, needed: 2 } };
});
afterEach(cleanup);

describe('the number it starts at and the numbers it can reach', () => {
  /* RED WHEN: the control starts at a number other than the one the company asks for now, or can be pressed before a number is chosen, so a press with the default asks the wallet for a change that changes nothing. */
  it('starts at the number in force and asks the wallet nothing until another is chosen', async () => {
    await draw();
    expect(q('[data-change-threshold-value]')!.textContent).toBe(words('changeThreshold.keeps', { count: 2 }));
    expect((q('[data-action=raise-threshold]') as HTMLButtonElement).disabled).toBe(true);
    await press('[data-action=raise-threshold]');
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: the number can be lowered below one or raised above the signers the company seats, which the wallet would refuse; or it can be stepped before the counts are read. */
  it('steps no lower than one and no higher than the signers seated, and not at all before the counts are read', async () => {
    kr.company = records({ approvalsNeeded: read(1) });
    await draw();
    expect((q('[data-action=threshold-fewer]') as HTMLButtonElement).disabled).toBe(true);
    for (let n = 2; n <= 4; n += 1) {
      await press('[data-action=threshold-more]');
      expect(q('[data-change-threshold-value]')!.textContent).toBe(words('changeThreshold.value', { count: n }));
    }
    expect((q('[data-action=threshold-more]') as HTMLButtonElement).disabled).toBe(true);
    await press('[data-action=threshold-more]');
    expect(q('[data-change-threshold-value]')!.textContent).toBe(words('changeThreshold.value', { count: 4 }));
    cleanup();
    kr.company = records({ approvalsForSigners: { of: 'unreadable' } });
    await draw();
    expect((q('[data-action=threshold-more]') as HTMLButtonElement).disabled).toBe(true);
    expect((q('[data-action=threshold-fewer]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-change-threshold-unread]')!.textContent).toBe(EN['changeThreshold.unread']);
  });

  /* RED WHEN: Keep the number now is missing once another is chosen, or does not return to the number in force and switch the press off. */
  it('returns to the number in force with Keep the number now', async () => {
    await draw();
    expect(q('[data-action=threshold-keep]')).toBeNull();
    await press('[data-action=threshold-more]');
    expect((q('[data-action=raise-threshold]') as HTMLButtonElement).disabled).toBe(false);
    await press('[data-action=threshold-keep]');
    expect(q('[data-change-threshold-value]')!.textContent).toBe(words('changeThreshold.keeps', { count: 2 }));
    expect((q('[data-action=raise-threshold]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('what is asked of the wallet, and what comes back', () => {
  /* RED WHEN: the number reaching the wallet is not the one chosen, the wallet is asked for a vault, the press is not told as working, or the records are not read again once the change is carried out. */
  it('asks the wallet for the number chosen, says it is working, and reads the records again once it is done', async () => {
    kr.steps = [{ step: 2, steps: 5 }];
    let release = (): void => {};
    kr.hold = new Promise<void>((r) => { release = r; });
    await draw();
    await press('[data-action=threshold-more]');
    await press('[data-action=raise-threshold]');
    expect(kr.acts).toEqual([{ name: 'change-threshold', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), threshold: '3' }]);
    expect(q('[data-working]')!.textContent).toBe(words('signers.working.step', { step: 2, steps: 5 }));
    expect((q('[data-action=raise-threshold]') as HTMLButtonElement).disabled).toBe(true);
    release();
    await settle();
    expect(q('[data-working]')).toBeNull();
    expect(q('[data-acted]')!.textContent).toContain(words('changeThreshold.done.carried', { count: 3 }));
    expect(kr.reads).toBe(2);
  });

  /* RED WHEN: a change that is raised and still waits for the other signers is told as carried out, or the person is not told where the others approve it. */
  it('says a change that waits for the other signers is raised, and where they approve it', async () => {
    kr.ended = { of: 'done', steps: 3, relayed: 1, outcome: { state: 'waiting-for-approvals', approvals: 1, needed: 2 } };
    await draw();
    await press('[data-action=threshold-more]');
    await press('[data-action=raise-threshold]');
    const said = q('[data-acted]')!.textContent!;
    expect(said).toContain(words('changeThreshold.done.waiting', { page: EN['page.proposals.name']! }));
    expect(said).not.toContain(words('changeThreshold.done.carried', { count: 3 }));
    expect(said).toContain(words('proposal.act.counted', { approvals: 1, needed: 2 }));
  });

  /* RED WHEN: the wallet's refusal of the number, after it checked every vault, is told as any other stop, so it says nothing of what to change; or it does not say nothing was sent. */
  it('tells the wallet\'s refusal of the number with what resolves it, and that nothing was sent', async () => {
    kr.ended = stopped('act.change-threshold.why.refused');
    await draw();
    await press('[data-action=threshold-more]');
    await press('[data-action=raise-threshold]');
    expect(q('[data-wallet-refused]')!.textContent).toContain(EN['changeThreshold.refused']);
    expect(EN['changeThreshold.refused']).toMatch(/choose a smaller number/i);
    expect(EN['changeThreshold.refused']).toMatch(/invite another approver or admin first/i);
    expect(EN['changeThreshold.refused']).toMatch(/nothing was sent/i);
    expect(q('[data-acted]')).toBeNull();
  });

  /* RED WHEN: a stop of the wallet's other kinds loses its reason, or one that may have gone part of the way is not told to be pressed again. */
  it('tells the other stops by their reason, and the one that went part of the way', async () => {
    kr.ended = stopped('act.change-threshold.why.no-seat');
    await draw();
    await press('[data-action=threshold-more]');
    await press('[data-action=raise-threshold]');
    expect(q('[data-proposal-stopped=seat]')!.textContent).toBe(EN['proposal.act.why.seat']);
    kr.ended = stopped('act.change-threshold.why.may-be-sent');
    await press('[data-action=raise-threshold]');
    expect(q('[data-proposal-stopped=may-be-sent]')!.textContent).toContain(EN['signers.partial']);
  });

  /* RED WHEN: a number the page already knows the wallet would refuse is not told, before the wallet window, with the words that say what resolves it; or its words lose the count of signers it names. */
  it('tells a number the page knows is refused with what to change', async () => {
    const P = { notWhole: 'not-whole', tooHigh: 'too-high', same: 'same', unread: 'unread' };
    await draw();
    await press('[data-action=threshold-more]');
    for (const [problem, key, most] of [
      [P.notWhole, 'changeThreshold.problem.not-whole', undefined], [P.tooHigh, 'changeThreshold.problem.too-high', 4],
      [P.same, 'changeThreshold.problem.same', undefined], [P.unread, 'changeThreshold.problem.unread', undefined],
    ] as const) {
      kr.told = { of: 'problem', problem, ...(most === undefined ? {} : { most }) };
      await press('[data-action=raise-threshold]');
      expect(q(`[data-problem=${problem}]`)!.textContent, problem).toBe(words(key, most === undefined ? {} : { count: most }));
    }
    expect(kr.acts).toEqual([]);
    expect(EN['changeThreshold.problem.not-whole']).toMatch(/whole number of at least one/);
    expect(words('changeThreshold.problem.too-high', { count: 4 })).toMatch(/4 signers.*seat more signers first/);
    expect(EN['changeThreshold.problem.same']).toMatch(/choose another number/i);
    expect(EN['changeThreshold.problem.unread']).toMatch(/reload the page/i);
  });
});

describe('why the change needs the approvals it does', () => {
  /* RED WHEN: the sentence is missing, does not name the number of approvals the change takes (the one the company asks for now), or does not say the wallet checks every vault. */
  it('says the change needs the approvals the company asks for now, and that the wallet checks every vault', async () => {
    await draw();
    expect(q('[data-needed-because]')!.textContent).toBe(words('changeThreshold.because', { count: 2 }));
    expect(q('[data-checks-every-vault]')!.textContent).toBe(EN['changeThreshold.checks']);
    expect(EN['changeThreshold.checks']).toMatch(/every vault/);
    cleanup();
    kr.company = records({ approvalsNeeded: read(1) });
    await draw();
    expect(q('[data-needed-because]')!.textContent).toBe(words('changeThreshold.because', { count: 1 }));
    cleanup();
    kr.company = records({ approvalsNeeded: { of: 'unreadable' } });
    await draw();
    expect(q('[data-needed-because]')).toBeNull();
  });
});

describe('one vault\'s approvals', () => {
  const vaultOf = () => <ChangeThreshold vault={VAULT} />;

  /* RED WHEN: a vault's control starts at the company's number instead of the vault's own, steps past the signers seated, or leaves the press on before another number is chosen. */
  it('starts at the number the vault has, steps to the signers seated, and asks nothing until another is chosen', async () => {
    kr.company = withVaults(3);
    await draw(vaultOf());
    expect(q('[data-change-threshold-value]')!.textContent).toBe(words('changeThreshold.keeps', { count: 3 }));
    expect(q('legend, [data-slot=field-legend]')!.textContent).toBe(EN['changeThreshold.vault.label']);
    expect((q('[data-action=raise-threshold]') as HTMLButtonElement).disabled).toBe(true);
    await press('[data-action=threshold-more]');
    expect(q('[data-change-threshold-value]')!.textContent).toBe(words('changeThreshold.value', { count: 4 }));
    expect((q('[data-action=threshold-more]') as HTMLButtonElement).disabled).toBe(true);
    await press('[data-action=threshold-fewer]');
    await press('[data-action=threshold-fewer]');
    expect(q('[data-change-threshold-value]')!.textContent).toBe(words('changeThreshold.value', { count: 2 }));
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: the wallet is not told which vault, is told the company's number as the vault's, or the vault's change is told in the company's words (and the vault is not named in the done sentence). */
  it('asks the wallet for the vault and the number chosen, and says it in the vault\'s words', async () => {
    kr.company = withVaults(2);
    await draw(vaultOf());
    await press('[data-action=threshold-more]');
    await press('[data-action=raise-threshold]');
    expect(kr.acts).toEqual([{ name: 'change-threshold', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), threshold: '3', vault: VAULT }]);
    expect(q('[data-acted]')!.textContent).toContain(words('changeThreshold.vault.done.carried', { count: 3, vault: words('vaults.tile.name', { number: 1 }) }));
    expect(q('[data-acted]')!.textContent).not.toContain(words('changeThreshold.done.carried', { count: 3 }));
  });

  /* RED WHEN: the sentence on why does not name the vault, gives the company's number as the vault's, does not say the wallet checks the rest, or still says it checks every vault. */
  it('names the vault and its number in the sentence on why, and says the wallet checks the rest', async () => {
    kr.company = withVaults(3);
    await draw(vaultOf());
    const said = q('[data-needed-because]')!.textContent!;
    expect(said).toBe(words('changeThreshold.vault.because', { count: 3, vault: words('vaults.tile.name', { number: 1 }) }));
    expect(said).toMatch(/Vault 1/);
    expect(said).toMatch(/Your wallet checks the rest/);
    expect(q('[data-checks-every-vault]')).toBeNull();
  });

  /* RED WHEN: a vault whose number was not read, or that is not among the company's, can be stepped or has the company's number put in its place; or the sentence on why is shown for it. */
  it('cannot be stepped where the vault\'s number is unread, and does not borrow the company\'s', async () => {
    for (const company of [withVaults(undefined), records({ vaults: read([]) }), records({ vaults: { of: 'unreadable' } })]) {
      kr.company = company;
      await draw(vaultOf());
      expect((q('[data-action=threshold-more]') as HTMLButtonElement).disabled).toBe(true);
      expect((q('[data-action=threshold-fewer]') as HTMLButtonElement).disabled).toBe(true);
      expect(q('[data-change-threshold-value]')!.textContent).toBe('');
      expect(q('[data-change-threshold-unread]')!.textContent).toBe(EN['changeThreshold.vault.unread']);
      expect(q('[data-needed-because]')).toBeNull();
      cleanup();
    }
  });

  /* RED WHEN: a number equal to the one the vault has now reaches the wallet window, or is told with the company's words. */
  it('tells a number equal to the vault\'s own in the vault\'s words, before any wallet window', async () => {
    kr.company = withVaults(2);
    const { changeThreshold } = await import('../adapters/proposal-acts.js');
    kr.told = null;
    expect(await changeThreshold('u1', 'c-1', 2, { now: 2, seated: 4 }, undefined, VAULT)).toEqual({ of: 'problem', problem: 'same' });
    expect(kr.acts).toEqual([]);
    kr.told = { of: 'problem', problem: 'same' };
    await draw(vaultOf());
    await press('[data-action=threshold-more]');
    await press('[data-action=raise-threshold]');
    expect(q('[data-problem=same]')!.textContent).toBe(words('changeThreshold.vault.problem.same', { vault: words('vaults.tile.name', { number: 1 }) }));
  });

  /* RED WHEN: the result of a raise from a vault's page is lost when the company's records are read again (it is shown under the page's records, which stand empty while they read), so the person is never told it was carried out or where the others approve it. */
  it('keeps its result on screen in the panel while the records are read again', async () => {
    kr.company = withVaults(2);
    const Opener = () => {
      const { open } = usePanel();
      return <button data-action="open-it" onClick={() => open({ title: 'Change approvals', body: <ChangeThreshold vault={VAULT} /> })}>open</button>;
    };
    await draw(<WithRecords>{() => <Opener />}</WithRecords>);
    await press('[data-action=open-it]');
    await press('[data-panel] [data-action=threshold-more]');
    await press('[data-panel] [data-action=raise-threshold]');
    expect(kr.reads).toBe(2);
    expect(document.body.querySelector('[data-panel] [data-acted]')!.textContent).toContain(words('changeThreshold.vault.done.carried', { count: 3, vault: words('vaults.tile.name', { number: 1 }) }));
  });
});
