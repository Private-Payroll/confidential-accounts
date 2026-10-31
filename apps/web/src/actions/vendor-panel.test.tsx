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
 * THE VENDORS PAGE AND A VENDOR'S PANEL, DRAWN over the real adapters and the real wallet wrappers, with only the call to the wallet and
 * the company's records stood in for: which vendors are listed and which are left out and why, what the panel says of a vendor, and what
 * each press asks of the wallet. The clock is west of UTC, where a calendar date shown as a moment is a day early.
 */
vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180'); process.env.TZ = 'America/Los_Angeles'; });
const kr = vi.hoisted(() => ({
  acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown, steps: [] as { step: number; steps: number }[],
  hold: null as Promise<void> | null, company: null as unknown, reads: 0, user: { id: 'u1' } as { id: string } | null, after: null as (() => void) | null,
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
    kr.after?.();
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

const { Vendors } = await import('../screens/vendors.js');
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
const NOT_PAID = 'they were added with no address and their wallet has not claimed one, so nothing names where to pay them';

const vendor = (over: Record<string, unknown> = {}) => ({
  id: 'ven_aa', name: 'Vee', standing: 'active', handedOver: false, termsKind: 'monthly', asset: NIGHT_TOKEN, monthly: publicAmount(2_500_000n, 6, 'NIGHT'), paid: 'publicly',
  startedAt: '2026-01-01', endDate: null, admittedAt: null, admitBy: 'fingerprint', notPayable: null, ...over,
});
const belief = (rows: ReturnType<typeof vendor>[], over: Record<string, unknown> = {}) => ({
  of: 'read', value: {
    vendors: rows.filter((v) => v.notPayable === null), rows, notBelieved: [],
    notPayable: rows.filter((v) => v.notPayable !== null).map((v) => ({ vendor: v, why: v.notPayable })), ...over,
  },
});
const records = (over: Record<string, unknown> = {}) => ({
  of: 'open', id: 'c-1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }], approvalsNeeded: { of: 'read', value: 1 }, vendorsBelief: belief([vendor()]), ...over,
});

const session = () => ({
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true },
  chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
});
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }); };
const q = (s: string): HTMLElement | null => document.body.querySelector(s);
const qa = (s: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(s)];
const type = async (selector: string, value: string) => { fireEvent.change(q(selector)!, { target: { value } }); await settle(); };
const press = async (selector: string) => { fireEvent.click(q(selector)!); await settle(); };
const draw = async () => {
  const { container } = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session()}><PanelProvider><CompanyRecordsProvider><Vendors /><RightPanel /></CompanyRecordsProvider></PanelProvider></SessionProvider>
    </KitProvider>,
  );
  await untilPageShown(container);
};
const open = async (id: string) => { await press(`[data-screen=vendors] tbody tr[data-row=${id}] td`); };
const panelText = (): string => q('[data-vendor-panel]')!.textContent!;
/** A part of the panel as it stands: absent, live (every control can be used), or locked (every control disabled), with the reason it gives when it is. */
const stateOf = (part: string): string => {
  const p = q(`[data-part=${part}]`);
  if (p === null) return 'hidden';
  const controls = [...p.querySelectorAll<HTMLInputElement>('input, button')];
  const reason = p.querySelector('[data-locked]')?.textContent ?? null;
  if (controls.length > 0 && controls.every((c) => c.disabled)) return `locked: ${reason}`;
  return controls.some((c) => c.disabled) ? 'mixed' : reason === null ? 'live' : `live with a reason: ${reason}`;
};

beforeEach(() => {
  kr.acts = []; kr.steps = []; kr.hold = null; kr.reads = 0; kr.user = { id: 'u1' }; kr.company = records(); kr.after = null;
  kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'changed' } };
});
afterEach(cleanup);

describe('who the Vendors page lists, and who it says it left out', () => {
  /* RED WHEN: a vendor this device believes is dropped from the page because another record was not believed or will not be paid, a vendor it does not believe is listed, or a start date is shown a day early west of UTC. */
  it('lists the believed vendors even while other records are not believed', async () => {
    kr.company = records({ vendorsBelief: belief([vendor(), vendor({ id: 'ven_bb', name: 'Wes', standing: 'invited' })], { notBelieved: ['ven_x', 'ven_y'] }) });
    await draw();
    expect(qa('[data-screen=vendors] tbody tr[data-row]').map((r) => r.dataset['row'])).toEqual(['ven_aa', 'ven_bb']);
    expect(q('[data-screen=vendors] [data-unreadable]')).toBeNull();
    expect(q('[data-screen=vendors] tbody tr[data-row=ven_aa]')!.textContent).toContain('Jan 1, 2026');
  });

  /* RED WHEN: records this device does not believe are dropped without a word, or a vendor it will not pay is listed unmarked or without why. */
  it('says, above the list, how many records were not believed and which vendors will not be paid, each with why', async () => {
    kr.company = records({ vendorsBelief: belief([vendor(), vendor({ id: 'ven_cc', name: 'Cy', notPayable: NOT_PAID })], { notBelieved: ['ven_x', 'ven_y'] }) });
    await draw();
    expect(qa('[data-screen=vendors] tbody tr[data-row]').map((r) => r.dataset['row'])).toEqual(['ven_aa', 'ven_cc']);
    expect(qa('[data-screen=vendors] tbody td [data-not-payable]').map((b) => [b.dataset['notPayable'], b.textContent])).toEqual([['ven_cc', en('people.notPayable.badge')]]);
    const block = q('[data-vendors-belief]')!;
    expect(block.textContent).toContain(en('vendors.belief.title'));
    expect(q('[data-not-believed]')!.textContent).toBe(en('vendors.belief.notBelieved_other').replace('{count}', '2'));
    /* RED WHEN: the notice tells the person to use a refresh button the Vendors page does not draw. */
    expect(q('[data-not-believed]')!.textContent).toContain('Reload the page');
    expect(q('[data-screen=vendors]')!.textContent!.toLowerCase()).not.toContain('refresh');
    expect(q('[data-vendors-belief] [data-not-payable=ven_cc]')!.textContent).toBe(en('vendors.belief.notPayable').replace('{name}', 'Cy').replace('{why}', NOT_PAID));
  });

  /* RED WHEN: a notice is drawn when nothing was left out, or one record is said in the plural. */
  it('draws no notice when nothing was left out, and says one record in the singular', async () => {
    await draw();
    expect(q('[data-vendors-belief]')).toBeNull();
    cleanup();
    kr.company = records({ vendorsBelief: belief([vendor()], { notBelieved: ['ven_x'] }) });
    await draw();
    expect(q('[data-not-believed]')!.textContent).toBe(en('vendors.belief.notBelieved_one').replace('{count}', '1'));
  });

  /* RED WHEN: a belief check that could not be read shows an empty list as though there were no vendors. */
  it('says so when the belief check could not be read', async () => {
    kr.company = records({ vendorsBelief: { of: 'unreadable' } });
    await draw();
    expect(q('[data-screen=vendors] [data-unreadable]')!.textContent).toBe(en('records.unreadable'));
    expect(q('[data-screen=vendors] tbody tr[data-row]')).toBeNull();
  });

  /* RED WHEN: a company with no vendors shows an empty table instead of saying so. */
  it('says there are no vendors yet', async () => {
    kr.company = records({ vendorsBelief: belief([]) });
    await draw();
    expect(q('[data-screen=vendors]')!.textContent).toContain(en('vendors.none'));
  });

  /* RED WHEN: the Invite vendor button is missing, is disabled, or opens the panel with the other kinds offered. */
  it('opens the one invite panel for a vendor from its header', async () => {
    await draw();
    const invite = q('[data-screen=vendors] button[data-action=invite]') as HTMLButtonElement;
    expect([invite.textContent, invite.disabled, invite.hasAttribute('data-soon')]).toEqual([en('invite.open.vendor'), false, false]);
    await press('[data-screen=vendors] button[data-action=invite]');
    expect(q('[data-panel]')!.textContent).toContain(en('invite.title.vendor'));
    expect([q('[data-panel] [data-field=name]') === null, q('[data-panel] [data-field=terms]') === null, q('[data-panel] [data-field=classification]') === null]).toEqual([false, false, true]);
  });
});

describe('what a vendor\'s panel says', () => {
  /* RED WHEN: a calendar date is shown a day early west of UTC, a moment is not in local time, or the terms are not shown with their amount. */
  it('shows the terms, the calendar dates as the day they are and the admission as a moment in local time', async () => {
    kr.company = records({ vendorsBelief: belief([vendor({ startedAt: '2026-01-01', endDate: '2026-12-31', admittedAt: '2026-03-02T01:30:00.000Z' })]) });
    await draw();
    await open('ven_aa');
    const text = panelText();
    expect(text).toMatch(/Started\s*Jan 1, 2026/);
    expect(text).toMatch(/End date\s*Dec 31, 2026/);
    expect(text).toMatch(/Admitted\s*Mar 1, 2026, 5:30\sPM/);
    expect(q('[data-vendor-panel] [data-terms-of]')!.textContent).toContain(en('vendors.terms.monthly'));
    expect(q('[data-vendor-panel] [data-terms-of]')!.textContent).toMatch(/2\.5/);
  });

  /* RED WHEN: a vendor paid by one-off payments is shown a monthly amount, or one paid in a token this app does not know is shown an amount. */
  it('says one-off terms without an amount, and a token the app does not know without one', async () => {
    kr.company = records({ vendorsBelief: belief([vendor({ id: 'ven_bb', name: 'Wes', termsKind: 'one-off', asset: null, monthly: null }), vendor({ id: 'ven_cc', name: 'Cy', monthly: null })]) });
    await draw();
    expect(q('[data-row=ven_bb] [data-terms-of]')!.textContent).toBe(en('invite.terms.oneOff'));
    expect(q('[data-row=ven_cc] [data-terms-of]')!.textContent).toContain(en('records.unrecognisedOne'));
  });

  /* RED WHEN: the panel stays on a vendor who is gone from the records, or does not say so. */
  it('opens on the vendor pressed, and says so when that vendor is no longer in the records', async () => {
    kr.company = records({ vendorsBelief: belief([vendor(), vendor({ id: 'ven_bb', name: 'Wes' })]) });
    await draw();
    await open('ven_bb');
    expect(q('[data-vendor-panel=ven_bb]')).not.toBeNull();
    kr.after = () => { kr.company = records({ vendorsBelief: belief([vendor()]) }); };
    await type('[data-field=endDate]', '2027-01-31');
    await press('[data-action=set-endDate]');
    expect(q('[data-vendor-panel]')).toBeNull();
    expect(q('[data-vendor-gone=ven_bb]')!.textContent).toBe(en('vendors.panel.gone'));
  });

  /* RED WHEN: an action is hidden instead of shown disabled with its reason (the change forms of a vendor who is not active, the admit control of one who is not waiting for the check), or one is usable that does not apply. */
  it('shows the change forms and the admit control to every vendor, each disabled with its reason when it does not apply', async () => {
    kr.company = records({ vendorsBelief: belief([
      vendor(), vendor({ id: 'ven_bb', name: 'Wes', standing: 'waiting-for-check' }), vendor({ id: 'ven_cc', name: 'Cy', standing: 'leaver' }), vendor({ id: 'ven_dd', name: 'Di', standing: 'invited' }),
    ]) });
    await draw();
    const seen: Record<string, string[]> = {};
    for (const id of ['ven_aa', 'ven_bb', 'ven_cc', 'ven_dd']) {
      await open(id);
      seen[id] = [stateOf('change'), stateOf('admit')];
    }
    expect(seen).toEqual({
      ven_aa: ['live', `locked: ${en('people.admit.locked.admitted')}`],
      ven_bb: [`locked: ${en('people.locked.waitingForCheck')}`, 'live'],
      ven_cc: [`locked: ${en('people.locked.left')}`, `locked: ${en('people.admit.locked.left')}`],
      ven_dd: [`locked: ${en('people.locked.invited')}`, `locked: ${en('people.admit.locked.invited')}`],
    });
  });

  /* RED WHEN: a vendor waiting for the fingerprint check loses the admit control, whatever their record says of their address, which is only checked when they are admitted. */
  it('keeps the admit control live for a vendor waiting for the check, never marked as one who will not be paid', async () => {
    kr.company = records({ vendorsBelief: belief([vendor({ standing: 'waiting-for-check', paid: 'not-set-up' })]) });
    await draw();
    await open('ven_aa');
    expect(q('[data-vendor-panel] [data-not-payable]')).toBeNull();
    expect(stateOf('admit')).toBe('live');
    expect((q('[data-part=admit] [data-action=admit-person]') as HTMLButtonElement).disabled).toBe(false);
  });

  /* RED WHEN: the Public pill is drawn on the monthly amount of a vendor who has no payment address yet (nothing decides yet whether the payment is public), or is missing from a vendor paid publicly. */
  it('draws the Public pill on a monthly amount only when the vendor\'s address says the payment is public', async () => {
    kr.company = records({ vendorsBelief: belief([vendor(), vendor({ id: 'ven_bb', name: 'Wes', paid: 'not-set-up' })]) });
    await draw();
    expect([q('[data-row=ven_aa] [data-slot=public-pill]') !== null, q('[data-row=ven_bb] [data-slot=public-pill]') !== null]).toEqual([true, false]);
    expect(q('[data-row=ven_bb] [data-terms-of]')!.textContent).toMatch(/2\.5\s*NIGHT/);
    await open('ven_bb');
    expect(q('[data-vendor-panel] [data-terms-of] [data-slot=public-pill]')).toBeNull();
    expect(q('[data-vendor-panel] [data-terms-of]')!.textContent).toMatch(/2\.5\s*NIGHT/);
  });
});

describe('a vendor the check will not pay', () => {
  const drawn = async (standing = 'active') => {
    kr.company = records({ vendorsBelief: belief([vendor({ id: 'ven_cc', name: 'Cy', standing, notPayable: NOT_PAID }), vendor()]) });
    await draw();
  };

  /* RED WHEN: a vendor the check will not pay is left off the page, is not marked, or the notice does not name them with why. */
  it('is a row, marked, with the notice naming them and why', async () => {
    await drawn();
    expect(qa('[data-screen=vendors] tbody tr[data-row]').map((r) => r.dataset['row'])).toEqual(['ven_cc', 'ven_aa']);
    expect(q('[data-vendors-belief] [data-not-payable=ven_cc]')).not.toBeNull();
  });

  /* RED WHEN: an active vendor the check will not pay can be changed or admitted again from their panel, or the panel does not say why, in the panel and beside the locked forms. */
  it('shows their details and why, with every form locked and saying so', async () => {
    await drawn();
    await open('ven_cc');
    expect(q('[data-vendor-panel] [data-not-payable=ven_cc]')!.textContent).toBe(en('vendors.panel.notPayable').replace('{why}', NOT_PAID));
    expect([stateOf('change'), stateOf('admit')]).toEqual([`locked: ${en('people.locked.notPayable')}`, `locked: ${en('people.admit.locked.admitted')}`]);
    await open('ven_aa');
    expect(stateOf('change')).toBe('live');
    expect(q('[data-vendor-panel] [data-not-payable]')).toBeNull();
  });
});

describe('admitting a vendor from the panel', () => {
  const waiting = (over: Record<string, unknown> = {}) => vendor({ standing: 'waiting-for-check', ...over });
  const asked = (fields: Record<string, string>) => [{ name: 'admit-person', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), kind: 'vendor', person: 'ven_aa', personName: 'Vee', ...fields }];

  /* RED WHEN: a vendor is admitted as an employee, the fingerprint typed is not what is sent, or the answer is lost when the records are read again. */
  it('asks the wallet to admit the vendor open, as a vendor, with the fingerprint typed, and keeps saying so after the records are read again', async () => {
    kr.company = records({ vendorsBelief: belief([waiting()]) });
    kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'admitted' } };
    kr.after = () => { kr.company = records({ vendorsBelief: belief([vendor({ admittedAt: '2026-10-29T10:00:00.000Z' })]) }); };
    await draw();
    await open('ven_aa');
    await type('[data-field=fingerprint]', ` ${FINGERPRINT.toLowerCase()} `);
    await press('[data-action=admit-person]');
    expect(kr.acts).toEqual(asked({ fingerprint: FINGERPRINT }));
    expect(kr.reads).toBe(2);
    expect(q('[data-acted=admit-person]')!.textContent).toBe(en('people.done.admitted').replace('{name}', 'Vee'));
    expect(q('[data-part=change]')).not.toBeNull();
  });

  /* RED WHEN: a vendor admitted on their wallet's signed claim is asked for a fingerprint, or sent one. */
  it('asks no fingerprint of a vendor admitted on their wallet\'s signed claim, and sends none', async () => {
    kr.company = records({ vendorsBelief: belief([waiting({ admitBy: 'claim' })]) });
    await draw();
    await open('ven_aa');
    expect(q('[data-field=fingerprint]')).toBeNull();
    expect(q('[data-admit-by=claim]')!.textContent).toBe(en('people.admit.claim'));
    await press('[data-action=admit-person]');
    expect(kr.acts).toEqual(asked({}));
  });
});

describe('changing a vendor\'s terms and dates from the panel', () => {
  const asked = (fields: Record<string, string>) => [{ name: 'change-person', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), kind: 'vendor', person: 'ven_aa', personName: 'Vee', ...fields }];
  const draws = async (over: Record<string, unknown> = {}) => { kr.company = records({ vendorsBelief: belief([vendor(over)]) }); await draw(); await open('ven_aa'); };

  /* RED WHEN: monthly terms are sent in the entered text instead of the token's smallest unit, in another token than the one chosen, or with employee pay fields. */
  it('asks the wallet for monthly terms in the token chosen, and says so', async () => {
    await draws({ termsKind: 'one-off', asset: null, monthly: null });
    await press('[data-terms=monthly]');
    await type('[data-field=termsAmount]', '1250.5');
    await press('[data-action=change-terms]');
    expect(kr.acts).toEqual(asked({ terms: 'monthly', termsAsset: NIGHT_TOKEN, termsAmount: '1250500000' }));
    expect(q('[data-vendor-answer=terms] [data-acted=change-person]')!.textContent).toBe(en('people.done.changed').replace('{name}', 'Vee'));
    expect(kr.reads).toBe(2);
  });

  /* RED WHEN: one-off terms are sent with an amount, or the terms form starts on other terms than the vendor's now. */
  it('starts on the vendor\'s terms now, and asks for one-off terms with no amount', async () => {
    await draws();
    expect((q('[data-terms=monthly]') as HTMLElement).getAttribute('data-state')).toBe('checked');
    await press('[data-terms=one-off]');
    expect(q('[data-field=termsAmount]')).toBeNull();
    await press('[data-action=change-terms]');
    expect(kr.acts).toEqual(asked({ terms: 'one-off' }));
  });

  /* RED WHEN: a missing or wrong monthly amount reaches the wallet, or is not told as its own problem, beside the amount it is about (as the invite form tells it) and not in a line apart from it. */
  it('asks the wallet for nothing when the monthly amount is missing or wrong, and says which beside the amount', async () => {
    await draws();
    const beside = (code: string): string | null => q(`[data-part=change] [data-form=terms] [data-slot=field] [data-problem=termsAmount]`)?.textContent ?? `none ${code}`;
    await type('[data-field=termsAmount]', '');
    await press('[data-action=change-terms]');
    expect(beside('a')).toBe(en('people.problem.no-amount'));
    expect((q('[data-field=termsAmount]') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
    expect(q('[data-person-problem]')).toBeNull();
    await type('[data-field=termsAmount]', '0');
    await press('[data-action=change-terms]');
    expect(beside('b')).toBe(en('people.problem.zero-amount'));
    await type('[data-field=termsAmount]', '1.1234567');
    await press('[data-action=change-terms]');
    expect(beside('c')).toBe(en('people.problem.too-many-decimals'));
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: an end date is sent as an empty field when it is to be taken off, or a clear button is offered when none is held. */
  it('sets an end date and takes it off by clearing it', async () => {
    await draws({ endDate: '2026-12-31' });
    expect(qa('[data-action^=clear-]').map((b) => b.dataset['action'])).toEqual(['clear-endDate']);
    await type('[data-field=endDate]', '2027-01-31');
    await press('[data-action=set-endDate]');
    await press('[data-action=clear-endDate]');
    expect(kr.acts).toEqual([...asked({ endDate: '2027-01-31' }), ...asked({ clear: 'endDate' })]);
    expect(q('[data-field=leavingDate]')).toBeNull();
  });

  /* RED WHEN: the wallet's refusal to change terms after a month was raised is shown as a stop with no reason, or as part-way done. */
  it('says a refused change of terms, after a month was raised, in its own words and reads nothing again', async () => {
    await draws();
    await type('[data-field=termsAmount]', '3');
    kr.ended = { of: 'stopped', step: 3, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.change-person.why.terms-raised' };
    await press('[data-action=change-terms]');
    expect(q('[data-person-stopped=terms-raised]')!.textContent).toBe(en('people.why.terms-raised'));
    /* RED WHEN: the refusal says a raised month of this vendor, when the wallet refuses every vendor's terms once any pay run for vendors is past draft. */
    expect(q('[data-person-stopped=terms-raised]')!.textContent).toMatch(/pay run for vendors/);
    expect(q('[data-person-stopped=terms-raised]')!.textContent).toMatch(/no vendor's terms/);
    expect(q('[data-partial]')).toBeNull();
    expect(kr.reads).toBe(1);
  });

  /* RED WHEN: a press while the wallet works asks the wallet a second time. */
  it('ignores a press on any form while the wallet works', async () => {
    await draws();
    let release = (): void => {};
    kr.hold = new Promise<void>((r) => { release = r; });
    kr.steps = [{ step: 2, steps: 4 }];
    await type('[data-field=termsAmount]', '3');
    await press('[data-action=change-terms]');
    expect(q('[data-working]')!.textContent).toBe(en('people.working.step').replace('{step}', '2').replace('{steps}', '4'));
    await type('[data-field=endDate]', '2027-01-31');
    await press('[data-action=set-endDate]');
    expect(kr.acts).toHaveLength(1);
    release();
    await settle();
    expect(q('[data-working]')).toBeNull();
  });
});
