// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom, privateAmount, publicAmount } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { untilPageShown } from '../page-shown.test-support.js';
import { VIEWS } from '../pages.js';

/*
 * THE PEOPLE PAGE AND A PERSON'S PANEL, DRAWN over the real adapters and the real wallet wrappers, with only the call to the wallet and
 * the company's records stood in for: who is listed and who is left out and why, what the panel says of a person, and what each press
 * asks of the wallet. The clock is west of UTC, where a calendar date shown as a moment is a day early.
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

const { People } = await import('../screens/people.js');
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
  id: 'e1', name: 'Ana', title: 'Engineer', standing: 'active', pay: privateAmount(5_000_000n, 6, 'NIGHT'), paid: 'privately', startedAt: '2026-01-01', asset: NIGHT_TOKEN,
  classification: 'full-time', endDate: null, leavingDate: null, pays: [], classifications: [], admittedAt: null, admitBy: 'fingerprint', notPayable: null, ...over,
});
const belief = (rows: unknown[], over: Record<string, unknown> = {}) => ({ of: 'read', value: { rows, notBelieved: [], notPayable: [], refused: [], ...over } });
const records = (over: Record<string, unknown> = {}) => ({
  of: 'open', id: 'c-1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }], approvalsNeeded: { of: 'read', value: 1 }, peopleBelief: belief([person()]), ...over,
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
      <SessionProvider session={session()}><PanelProvider><CompanyRecordsProvider><People /><RightPanel /></CompanyRecordsProvider></PanelProvider></SessionProvider>
    </KitProvider>,
  );
  await untilPageShown(container);
};
const open = async (id: string) => { await press(`[data-screen=people] tbody tr[data-row=${id}] td`); };
const panelText = (): string => q('[data-person-panel]')!.textContent!;
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

describe('who the People page lists, and who it says it left out', () => {
  /* RED WHEN: a person the check believes is missing from the list because somebody else is not believed, or a person it does not believe is listed. */
  it('lists the believed people even while others are not believed, refused or not payable', async () => {
    kr.company = records({
      people: { of: 'unreadable' },
      peopleBelief: belief([person(), person({ id: 'e2', name: 'Bo' })], { notBelieved: ['rec_x', 'rec_y'], refused: [{ id: 'rec_z', why: 'it names no person' }], notPayable: [{ person: person({ id: 'e3', name: 'Cy' }), why: 'their address is not what their wallet signed' }] }),
    });
    await draw();
    expect(qa('[data-screen=people] tbody tr[data-row]').map((r) => r.dataset['row'])).toEqual(['e1', 'e2']);
    expect(q('[data-screen=people] [data-unreadable]')).toBeNull();
  });

  /* RED WHEN: a record that is not believed, refused, or an active person who will not be paid is left unsaid, or said only with the rows, or without why. */
  it('says, above the list, how many records were not believed, which were refused and which people will not be paid, each with why', async () => {
    kr.company = records({
      peopleBelief: belief([person()], { notBelieved: ['rec_x', 'rec_y'], refused: [{ id: 'rec_z', why: 'it names no person' }], notPayable: [{ person: person({ id: 'e3', name: 'Cy' }), why: 'their address is not what their wallet signed' }] }),
    });
    await draw();
    const block = q('[data-people-belief]')!;
    expect(block.textContent).toContain(en('people.belief.title'));
    expect(q('[data-not-believed]')!.textContent).toBe(en('people.belief.notBelieved_other').replace('{count}', '2'));
    /* RED WHEN: the notice tells the person to use a refresh button the People page does not draw. */
    expect(q('[data-not-believed]')!.textContent).toContain('Reload the page');
    expect(q('[data-screen=people]')!.textContent!.toLowerCase()).not.toContain('refresh');
    expect(q('[data-refused=rec_z]')!.textContent).toBe(en('people.belief.refused').replace('{id}', 'rec_z').replace('{why}', 'it names no person'));
    expect(q('[data-not-payable=e3]')!.textContent).toBe(en('people.belief.notPayable').replace('{name}', 'Cy').replace('{why}', 'their address is not what their wallet signed'));
  });

  /* RED WHEN: the notice is drawn when every record is believed, or one record not believed is told in the plural. */
  it('draws no notice when nothing was left out, and says one record in the singular', async () => {
    await draw();
    expect(q('[data-people-belief]')).toBeNull();
    cleanup();
    kr.company = records({ peopleBelief: belief([person()], { notBelieved: ['rec_x'] }) });
    await draw();
    expect(q('[data-not-believed]')!.textContent).toBe(en('people.belief.notBelieved_one').replace('{count}', '1'));
  });

  /* RED WHEN: the notice is drawn only when some record was not believed, so a refused record or a person who will not be paid is left unsaid when that is all there is. */
  it('says a refused record, or a person who will not be paid, when nothing else was left out', async () => {
    kr.company = records({ peopleBelief: belief([person()], { refused: [{ id: 'rec_z', why: 'it names no person' }] }) });
    await draw();
    expect([q('[data-not-believed]'), q('[data-refused=rec_z]') === null, q('[data-not-payable]')]).toEqual([null, false, null]);
    cleanup();
    kr.company = records({ peopleBelief: belief([person()], { notPayable: [{ person: person({ id: 'e3', name: 'Cy' }), why: 'their address is not what their wallet signed' }] }) });
    await draw();
    expect([q('[data-not-believed]'), q('[data-refused]'), q('[data-not-payable=e3]') === null]).toEqual([null, null, false]);
  });

  /* RED WHEN: a belief check that could not run is shown as an empty list of people. */
  it('says so when the belief check could not be read', async () => {
    kr.company = records({ peopleBelief: { of: 'unreadable' } });
    await draw();
    expect(q('[data-screen=people] [data-unreadable]')!.textContent).toBe(en('records.unreadable'));
    expect(q('[data-screen=people] tbody tr[data-row]')).toBeNull();
  });

  /* RED WHEN: the page draws its own invite button in place of the one invite panel, or draws none. */
  it('opens the one invite panel from its header', async () => {
    await draw();
    const invite = q('[data-screen=people] button[data-action=invite]') as HTMLButtonElement;
    expect([invite.textContent, invite.disabled, invite.hasAttribute('data-soon')]).toEqual([en('people.invite'), false, false]);
    await press('[data-screen=people] button[data-action=invite]');
    expect(q('[data-panel] [data-field=name]')).not.toBeNull();
  });
});

describe('what a person\'s panel says', () => {
  /* RED WHEN: a calendar date is shown a day early west of UTC, or a moment is not shown in the person's own time, or the end and leaving dates are missing. */
  it('shows calendar dates as the day they are and moments in local time', async () => {
    kr.company = records({ peopleBelief: belief([person({ startedAt: '2026-01-01', endDate: '2026-12-31', leavingDate: '2027-01-15', admittedAt: '2026-03-02T01:30:00.000Z' })]) });
    await draw();
    await open('e1');
    const text = panelText();
    expect(text).toMatch(/Started\s*Jan 1, 2026/);
    expect(text).toMatch(/End date\s*Dec 31, 2026/);
    expect(text).toMatch(/Leaving date\s*Jan 15, 2027/);
    expect(text).toMatch(/Admitted\s*Mar 1, 2026, 5:30\sPM/);
  });

  /* RED WHEN: the working time in force or the pay and working-time history is missing, out of the record's order, or its recorded moments are not local. */
  it('shows the working time in force and the history lines in the record\'s order', async () => {
    kr.company = records({
      peopleBelief: belief([person({
        classification: 'part-time',
        pays: [{ amount: privateAmount(4_000_000n, 6, 'NIGHT'), from: '2026-01-01', madeAt: '2025-12-30T10:00:00.000Z' }, { amount: privateAmount(5_000_000n, 6, 'NIGHT'), from: '2026-06-01', madeAt: '2026-05-20T10:00:00.000Z' }],
        classifications: [{ classification: 'full-time', from: '2026-01-01', madeAt: null }, { classification: 'part-time', from: '2026-09-01', madeAt: '2026-08-15T19:00:00.000Z' }],
      })]),
    });
    await draw();
    await open('e1');
    expect(panelText()).toMatch(/Working time\s*Part time/);
    const lines = qa('[data-history]').map((l) => [l.dataset['history'], l.textContent]);
    expect(lines.map((l) => l[0])).toEqual(['pay', 'pay', 'classification', 'classification']);
    expect(lines[0]![1]).toContain('Pay from Jan 1, 2026');
    expect(lines[0]![1]).toMatch(/recorded Dec 30, 2025, 2:00\sAM$/);
    expect(lines[1]![1]).toContain('Pay from Jun 1, 2026');
    expect(lines[2]![1]).toBe('Full time from Jan 1, 2026');
    expect(lines[3]![1]).toMatch(/^Part time from Sep 1, 2026 recorded Aug 15, 2026, 12:00\sPM$/);
  });

  /* RED WHEN: a person's panel opens on a person who is not the one pressed, or still shows after the person is gone from the records. */
  it('opens on the person pressed, and says so when that person is no longer in the records', async () => {
    kr.company = records({ peopleBelief: belief([person(), person({ id: 'e2', name: 'Bo', title: 'Writer' })]) });
    await draw();
    await open('e2');
    expect(q('[data-person-panel=e2]')!.textContent).toContain('Writer');
    kr.after = () => { kr.company = records({ peopleBelief: belief([person()]) }); };
    await type('[data-field=endDate]', '2027-01-31');
    await press('[data-action=set-endDate]');
    expect(q('[data-person-panel]')).toBeNull();
    expect(q('[data-person-gone=e2]')!.textContent).toBe(en('people.panel.gone'));
  });

  /* RED WHEN: an action is hidden instead of shown disabled with its reason (the change forms of a person who is not active, the admit control of one who is not waiting for the check), or one is usable that does not apply. */
  it('shows the change forms and the admit control to every person, each disabled with its reason when it does not apply', async () => {
    kr.company = records({ peopleBelief: belief([
      person(), person({ id: 'e2', name: 'Bo', standing: 'waiting-for-check' }), person({ id: 'e3', name: 'Cy', standing: 'leaver' }), person({ id: 'e4', name: 'Di', standing: 'invited' }),
    ]) });
    await draw();
    const seen: Record<string, string[]> = {};
    for (const id of ['e1', 'e2', 'e3', 'e4']) {
      await open(id);
      seen[id] = [stateOf('change'), stateOf('admit')];
    }
    expect(seen).toEqual({
      e1: ['live', `locked: ${en('people.admit.locked.admitted')}`],
      e2: [`locked: ${en('people.locked.waitingForCheck')}`, 'live'],
      e3: [`locked: ${en('people.locked.left')}`, `locked: ${en('people.admit.locked.left')}`],
      e4: [`locked: ${en('people.locked.invited')}`, `locked: ${en('people.admit.locked.invited')}`],
    });
  });

  /* RED WHEN: the Public pill is drawn on the pay of a person who has no payment address yet (nothing decides yet whether the payment is public), in the list or in their panel, or is missing from a person paid publicly. */
  it('draws the Public pill on a pay only when the person\'s address says the payment is public', async () => {
    kr.company = records({ peopleBelief: belief([
      person({ id: 'e1', name: 'Ana', pay: publicAmount(5_000_000n, 6, 'NIGHT'), paid: 'publicly' }),
      person({ id: 'e2', name: 'Bo', pay: publicAmount(5_000_000n, 6, 'NIGHT'), paid: 'not-set-up', pays: [{ amount: publicAmount(5_000_000n, 6, 'NIGHT'), from: '2026-01-01', madeAt: null }] }),
    ]) });
    await draw();
    expect([q('[data-row=e1] [data-slot=public-pill]') !== null, q('[data-row=e2] [data-slot=public-pill]') !== null]).toEqual([true, false]);
    expect(q('[data-row=e2]')!.textContent).toMatch(/5\s*NIGHT/);
    await open('e2');
    expect(q('[data-person-panel] [data-slot=public-pill]')).toBeNull();
    expect(q('[data-person-panel] [data-history=pay]')!.textContent).toMatch(/5\s*NIGHT/);
  });
});

describe('an active person the check will not pay', () => {
  const NOT_PAID = 'their address is not what their wallet signed';
  const drawn = async () => {
    kr.company = records({ peopleBelief: belief([person({ notPayable: NOT_PAID }), person({ id: 'e2', name: 'Bo' })], { notPayable: [{ person: person({ notPayable: NOT_PAID }), why: NOT_PAID }] }) });
    await draw();
  };

  /* RED WHEN: an active person the check will not pay is not a row, so the notice names somebody the list does not show, or the row is not marked. */
  it('is a row, marked, and the notice names them with why', async () => {
    await drawn();
    expect(qa('[data-screen=people] tbody tr[data-row]').map((r) => r.dataset['row'])).toEqual(['e1', 'e2']);
    expect(qa('[data-screen=people] tbody td [data-not-payable]').map((b) => [b.dataset['notPayable'], b.textContent])).toEqual([['e1', en('people.notPayable.badge')]]);
    expect(q('[data-people-belief] [data-not-payable=e1]')!.textContent).toBe(en('people.belief.notPayable').replace('{name}', 'Ana').replace('{why}', NOT_PAID));
  });

  /* RED WHEN: their panel leaves a change form or the admit control usable, which the wallet refuses, or leaves out why they will not be paid. */
  it('shows their details and why, with every form locked and saying so', async () => {
    await drawn();
    await open('e1');
    expect(panelText()).toContain('Engineer');
    expect(q('[data-person-panel] [data-not-payable=e1]')!.textContent).toBe(en('people.panel.notPayable').replace('{why}', NOT_PAID));
    expect([stateOf('change'), stateOf('admit')]).toEqual([`locked: ${en('people.locked.notPayable')}`, `locked: ${en('people.admit.locked.admitted')}`]);
    await open('e2');
    expect(stateOf('change')).toBe('live');
    expect(q('[data-person-panel] [data-not-payable]')).toBeNull();
  });
});

describe('how an admitted person was admitted', () => {
  /* RED WHEN: an admitted person's panel does not say how they were admitted, says the other way, or says it of a person not admitted yet. */
  it('says whether they were admitted on a fingerprint or on their wallet\'s signed claim, and says nothing of a person not admitted', async () => {
    kr.company = records({ peopleBelief: belief([
      person({ admittedAt: '2026-03-02T01:30:00.000Z' }), person({ id: 'e2', name: 'Bo', admittedAt: '2026-03-02T01:30:00.000Z', admitBy: 'claim' }), person({ id: 'e3', name: 'Cy', standing: 'waiting-for-check' }),
    ]) });
    await draw();
    const said: Record<string, boolean[]> = {};
    for (const id of ['e1', 'e2', 'e3']) {
      await open(id);
      said[id] = [new RegExp(`${en('people.admitBy')}\\s*${en('people.admitBy.fingerprint')}`).test(panelText()), new RegExp(`${en('people.admitBy')}\\s*${en('people.admitBy.claim')}`).test(panelText()), panelText().includes(en('people.admitBy'))];
    }
    expect(said).toEqual({ e1: [true, false, true], e2: [false, true, true], e3: [false, false, false] });
  });
});

describe('admitting a person from the panel', () => {
  const waiting = (over: Record<string, unknown> = {}) => person({ standing: 'waiting-for-check', ...over });

  /* RED WHEN: the wallet is asked to admit another person than the one open, the fingerprint is not sent as read out, or the answer is lost when the records are read again. */
  it('asks the wallet to admit the person open with the fingerprint typed, says so, and keeps saying so after the records are read again', async () => {
    kr.company = records({ peopleBelief: belief([waiting()]) });
    kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'admitted' } };
    kr.after = () => { kr.company = records({ peopleBelief: belief([person({ admittedAt: '2026-10-29T10:00:00.000Z' })]) }); };
    await draw();
    await open('e1');
    await type('[data-field=fingerprint]', ` ${FINGERPRINT.toLowerCase()} `);
    await press('[data-action=admit-person]');
    expect(kr.acts).toEqual([{ name: 'admit-person', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), kind: 'employee', person: 'e1', personName: 'Ana', fingerprint: FINGERPRINT }]);
    expect(kr.reads).toBe(2);
    expect(q('[data-acted=admit-person]')!.textContent).toBe(en('people.done.admitted').replace('{name}', 'Ana'));
    expect(q('[data-admit] [data-field=fingerprint]')).toBeNull();
    expect(q('[data-part=change]')).not.toBeNull();
  });

  /* RED WHEN: a person added by an unshielded address is asked for a fingerprint, or is sent one. */
  it('asks no fingerprint of a person admitted on their wallet\'s signed claim, and sends none', async () => {
    kr.company = records({ peopleBelief: belief([waiting({ admitBy: 'claim' })]) });
    kr.ended = { of: 'done', steps: 4, relayed: 0, outcome: { state: 'already-admitted' } };
    await draw();
    await open('e1');
    expect(q('[data-field=fingerprint]')).toBeNull();
    expect(q('[data-admit-by=claim]')!.textContent).toBe(en('people.admit.claim'));
    await press('[data-action=admit-person]');
    expect(kr.acts).toEqual([{ name: 'admit-person', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), kind: 'employee', person: 'e1', personName: 'Ana' }]);
    expect(q('[data-acted=admit-person]')!.textContent).toBe(en('people.done.alreadyAdmitted').replace('{name}', 'Ana'));
  });

  /* RED WHEN: a missing or mistyped fingerprint reaches the wallet, or is told in words other than the page's. */
  it('asks the wallet for nothing when the fingerprint is missing or mistyped, and says which', async () => {
    kr.company = records({ peopleBelief: belief([waiting()]) });
    await draw();
    await open('e1');
    await press('[data-action=admit-person]');
    expect(q('[data-person-problem=no-fingerprint]')!.textContent).toBe(en('people.problem.no-fingerprint'));
    await type('[data-field=fingerprint]', 'ABCD-EFGH');
    await press('[data-action=admit-person]');
    expect(q('[data-person-problem=bad-fingerprint]')!.textContent).toBe(en('people.problem.bad-fingerprint'));
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: the wallet's refusal is shown in another person's words than the page's, a stop that may have gone part of the way is told as nothing done or does not read the records again, or a clean stop reads them again. */
  it('says the wallet\'s stop in the page\'s words, and reads the records again only after a stop that may have gone part of the way', async () => {
    kr.company = records({ peopleBelief: belief([waiting()]) });
    await draw();
    await open('e1');
    await type('[data-field=fingerprint]', FINGERPRINT);
    kr.ended = { of: 'stopped', step: 3, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.admit-person.why.not-believed' };
    await press('[data-action=admit-person]');
    expect(q('[data-person-stopped=not-believed]')!.textContent).toBe(en('people.why.not-believed'));
    expect(q('[data-partial]')).toBeNull();
    expect(kr.reads).toBe(1);
    kr.ended = { of: 'stopped', step: 3, steps: 4, relayed: 1, unconfirmed: 0, why: 'check-failed', refused: 'act.admit-person.why.filed-not-entered' };
    await press('[data-action=admit-person]');
    expect(q('[data-person-stopped=filed-not-entered]')!.textContent).toContain(en('people.why.filed-not-entered'));
    expect(q('[data-partial]')!.textContent).toBe(en('people.partial'));
    expect(kr.reads).toBe(2);
  });

  /* RED WHEN: a stop whose words say nothing was done is shown after the wallet handed over transactions (sent or unconfirmed), the page does not say they may have been sent, or the list is not read again; or a stop that handed over none loses its own words. */
  it.each([[1, 0], [0, 1], [0, 0]])('says transactions may have been sent, in place of "nothing was done", and reads the list again, only when they were: %i sent, %i unconfirmed', async (relayed, unconfirmed) => {
    kr.company = records({ peopleBelief: belief([waiting({ admitBy: 'claim' })]) });
    await draw();
    await open('e1');
    kr.ended = { of: 'stopped', step: 3, steps: 4, relayed, unconfirmed, why: 'check-failed', refused: 'act.admit-person.why.not-found' };
    const before = kr.reads;
    await press('[data-action=admit-person]');
    const shown = q('[data-person-stopped=not-found]')!.textContent!;
    const handed = relayed + unconfirmed > 0;
    expect(shown.includes(en('people.sent'))).toBe(handed);
    expect(shown.includes(en('people.why.not-found'))).toBe(!handed);
    expect(kr.reads - before).toBe(handed ? 1 : 0);
  });

  /* RED WHEN: a second press while the wallet works asks the wallet again, or the page says nothing while it works. */
  it('says it is working, with the step, and ignores a second press meanwhile', async () => {
    kr.company = records({ peopleBelief: belief([waiting({ admitBy: 'claim' })]) });
    kr.steps = [{ step: 2, steps: 4 }];
    let release = (): void => {};
    kr.hold = new Promise<void>((r) => { release = r; });
    await draw();
    await open('e1');
    await press('[data-action=admit-person]');
    expect(q('[data-working]')!.textContent).toBe(en('people.working.step').replace('{step}', '2').replace('{steps}', '4'));
    expect((q('[data-action=admit-person]') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(q('[data-admit]')!);
    await settle();
    expect(kr.acts).toHaveLength(1);
    release();
    await settle();
    expect(q('[data-working]')).toBeNull();
  });
});

describe('changing a person from the panel', () => {
  const asked = (fields: Record<string, string>) => [{ name: 'change-person', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), kind: 'employee', person: 'e1', personName: 'Ana', ...fields }];
  const draws = async (over: Record<string, unknown> = {}) => { kr.company = records({ peopleBelief: belief([person(over)]) }); await draw(); await open('e1'); };

  /* RED WHEN: the new pay is sent in any unit but the smallest of the person's own token, from any date but the one given, or for another person. */
  it('asks the wallet for the new pay in the person\'s own token, from the date given', async () => {
    await draws();
    await type('[data-field=pay-amount]', '6500.5');
    await type('[data-field=pay-from]', '2026-12-01');
    await press('[data-action=change-pay]');
    expect(kr.acts).toEqual(asked({ payAmount: '6500500000', asset: NIGHT_TOKEN, payFrom: '2026-12-01' }));
    expect(q('[data-person-answer=pay] [data-acted=change-person]')!.textContent).toBe(en('people.done.changed').replace('{name}', 'Ana'));
    expect(kr.reads).toBe(2);
  });

  /* RED WHEN: an amount or date that is missing or cannot be right reaches the wallet, or is told in other words than the page's. */
  it('asks the wallet for nothing when the amount or the date is missing or wrong, and says which', async () => {
    await draws();
    await press('[data-action=change-pay]');
    expect(q('[data-person-problem=no-amount]')!.textContent).toBe(en('people.problem.no-amount'));
    await type('[data-field=pay-amount]', '0');
    await press('[data-action=change-pay]');
    expect(q('[data-person-problem=zero-amount]')).not.toBeNull();
    await type('[data-field=pay-amount]', '1.1234567');
    await press('[data-action=change-pay]');
    expect(q('[data-person-problem=too-many-decimals]')).not.toBeNull();
    await type('[data-field=pay-amount]', '10');
    await press('[data-action=change-pay]');
    expect(q('[data-person-problem=no-date]')!.textContent).toBe(en('people.problem.no-date'));
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: the working time changed is not the one chosen, or is sent without its date, or a choice is not offered in the page's words. */
  it('asks the wallet to change the working time to the one chosen, from the date given', async () => {
    await draws();
    fireEvent.pointerDown(q('[data-field=classification]')!, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    await settle();
    expect(qa('[role=option]').map((o) => o.textContent)).toEqual([en('people.classification.full-time'), en('people.classification.part-time')]);
    fireEvent.click(qa('[role=option]')[1]!);
    await settle();
    await type('[data-field=classification-from]', '2026-11-01');
    await press('[data-action=change-classification]');
    expect(kr.acts).toEqual(asked({ classification: 'part-time', classificationFrom: '2026-11-01' }));
  });

  /* RED WHEN: setting the end date or the leaving date sends the other, or the date given is not the one sent, or clearing sends a date, or a clear is offered when nothing is set. */
  it('sets and clears the end date and the leaving date, each by its own, and offers a clear only where one is set', async () => {
    await draws({ endDate: '2026-12-31' });
    expect(qa('[data-action^=clear-]').map((b) => b.dataset['action'])).toEqual(['clear-endDate']);
    await type('[data-field=endDate]', '2027-01-31');
    await press('[data-action=set-endDate]');
    await type('[data-field=leavingDate]', '2027-02-15');
    await press('[data-action=set-leavingDate]');
    await press('[data-action=clear-endDate]');
    expect(kr.acts).toEqual([...asked({ endDate: '2027-01-31' }), ...asked({ leavingDate: '2027-02-15' }), ...asked({ clear: 'endDate' })]);
  });

  /* RED WHEN: marking a person as left sends a status with details, drops the leaving date given, or sends one when none was given. */
  it('marks a person as left, with the leaving date when one is given and without when not', async () => {
    await draws();
    await press('[data-action=leave]');
    await type('[data-field=leave-on]', '2026-12-15');
    await press('[data-action=leave]');
    expect(kr.acts).toEqual([...asked({ status: 'leaver' }), ...asked({ status: 'leaver', leavingDate: '2026-12-15' })]);
  });

  /* RED WHEN: a press while the wallet works asks the wallet a second time, or the forms stay open to a press while the records are read again. */
  it('ignores a press on any form while the wallet works', async () => {
    await draws();
    let release = (): void => {};
    kr.hold = new Promise<void>((r) => { release = r; });
    await type('[data-field=pay-amount]', '10');
    await type('[data-field=pay-from]', '2026-12-01');
    await press('[data-action=change-pay]');
    expect(qa('[data-part=change] button').every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.submit(q('[data-form=leave]')!);
    await settle();
    expect(kr.acts).toHaveLength(1);
    release();
    await settle();
    expect(qa('[data-part=change] button').some((b) => (b as HTMLButtonElement).disabled)).toBe(false);
  });

  /* RED WHEN: a change the wallet will not make is told as made, or its words are not the page's. */
  it('says the wallet\'s refusal of a change in the page\'s words, and reads nothing again', async () => {
    await draws();
    kr.ended = { of: 'stopped', step: 3, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.change-person.why.date-raised' };
    await type('[data-field=endDate]', '2026-06-30');
    await press('[data-action=set-endDate]');
    expect(q('[data-person-stopped=date-raised]')!.textContent).toBe(en('people.why.date-raised'));
    expect(kr.reads).toBe(1);
  });
});

describe('the words of the stops, against what the wallet found', () => {
  /* RED WHEN: the admit stop names a fingerprint for every failure (a person admitted on a signed claim has none), or leaves out that the reason is in the wallet's window. */
  it('says an admission the wallet did not make without naming a fingerprint, and where the reason is', () => {
    expect(en('people.why.not-admitted')).not.toMatch(/fingerprint/i);
    expect(en('people.why.not-admitted')).toMatch(/reason is in the wallet's window/);
  });

  /* RED WHEN: the unbelieved-record stop says nobody can be admitted (it refuses this person's own record only), or leaves out that a signer files the record again. */
  it('says the unbelieved record is this person\'s own, and that a signer files it again', () => {
    expect(en('people.why.not-believed')).not.toMatch(/nobody|some record/i);
    expect(en('people.why.not-believed')).toMatch(/This person's record/);
    expect(en('people.why.not-believed')).toMatch(/A signer has to file it again from their own device/);
  });

  /* RED WHEN: a record the service refused to enter is told as the network not having entered it yet, or the stop does not say that nobody can be admitted until it does, not to try again and who to ask. */
  it('says the service refused the entry, what that blocks and who resolves it', () => {
    for (const key of ['people.why.filed-not-entered', 'people.why.filed-not-entered-nor-anchored']) {
      expect(en(key), key).not.toMatch(/network has/);
      expect(en(key), key).toMatch(/the service has not accepted its entry in the company's records/);
      expect(en(key), key).toMatch(/nobody can be admitted or changed/);
      expect(en(key), key).toMatch(/Do not try again: ask whoever runs the service/);
    }
    expect(en('people.why.filed-not-entered-nor-anchored')).toMatch(/The anchor was not made either/);
    expect(en('people.why.filed-not-entered')).not.toMatch(/anchor/);
  });

  /* RED WHEN: the raised-month stop compares with "that month" instead of the newest raised month, or says nothing of a date that is cleared or replaced. */
  it('compares a date with the newest raised month, and covers a date cleared or replaced', () => {
    expect(en('people.why.date-raised')).toMatch(/Choose a date after the newest raised month/);
    expect(en('people.why.date-raised')).toMatch(/clear/);
    expect(en('people.why.date-raised')).not.toMatch(/that month/);
  });

  /* RED WHEN: the seat-step stops say the account holds no seat (it is the saved keys on this device that hold none), call the signers list "the company's people", or say the device holds no keys when the page did not hand them over. */
  it('says what the wallet found at the seat step', () => {
    expect(en('people.why.no-seat')).toMatch(/saved keys on this device hold no seat of this company/);
    expect(en('people.why.no-seat')).toMatch(/Open the company on the device where you took your seat/);
    expect(en('people.why.roster-not-opened')).toMatch(/list of signers/);
    expect(en('people.why.roster-not-opened')).not.toMatch(/company's people/);
    expect(en('people.why.no-saved-keys')).toMatch(/The page did not give the wallet your saved keys/);
    expect(en('people.why.no-saved-keys')).not.toMatch(/holds no keys/);
  });
});

