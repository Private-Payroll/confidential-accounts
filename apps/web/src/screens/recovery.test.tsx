// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { VIEWS } from '../pages.js';
import { ENGLISH } from '../english.test-support.js';

/*
 * THE RECOVERY SCREEN, DRAWN over the real adapter and the real wallet wrapper, with only the call to the wallet, the chain's read
 * and the company's records stood in for: what a press asks of the wallet, the words after each way the wallet answers, the file
 * saved and opened, and where the chain holds the recovery shown from the chain and never from the file.
 */
vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180'); });
const kr = vi.hoisted(() => ({
  acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown, steps: [] as { step: number; steps: number }[],
  hold: null as Promise<void> | null, reads: 0, standings: 0, records: { of: 'unreadable' } as unknown, recordReads: 0, round: { held: 'open', approvals: 1, needed: 2 } as unknown,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => ({ id: 'u1' }),
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
vi.mock('../adapters/filing-judge.js', async (real) => ({ ...(await real<typeof import('../adapters/filing-judge.js')>()), walletIndexerFor: async () => ({ indexerUri: 'http://i', indexerWsUri: 'ws://i' }) }));
vi.mock('../adapters/vault-builder.js', async (real) => ({
  ...(await real<typeof import('../adapters/vault-builder.js')>()),
  theVaultBuilder: async () => ({ roundsOnChain: async () => { kr.standings += 1; return { ['aa'.repeat(32)]: kr.round }; } }),
}));
vi.mock('../adapters/recovery.js', async (real) => ({
  ...(await real<typeof import('../adapters/recovery.js')>()),
  readRecordsStates: async () => { kr.recordReads += 1; return kr.records; },
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => { kr.reads += 1; return { of: 'open', id: 'c-1', name: 'Northwind', signers: [], proposals: { of: 'read', value: [] } }; },
}));
vi.mock('../adapters/session.js', async (real) => ({ ...(await real<typeof import('../adapters/session.js')>()), companyNamesFor: async () => new Map() }));

const { Recovery } = await import('./recovery.js');
const { SessionProvider } = await import('../session.js');
const { CompanyRecordsProvider } = await import('../records/company-records.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
/** A word with its values filled in, in the plural form its count is in. */
const words = (key: string, values: Record<string, string | number> = {}): string => {
  const form = values['count'] === undefined ? EN[key] : EN[`${key}_${values['count'] === 1 ? 'one' : 'other'}`] ?? EN[key];
  return Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), form ?? key);
};

const session = () => ({
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true },
  chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
});
const draw = async () => {
  render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session()}><CompanyRecordsProvider><Recovery /></CompanyRecordsProvider></SessionProvider>
    </KitProvider>,
  );
  await settle();
};
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }); };
const q = (s: string): HTMLElement | null => document.body.querySelector(s);
const text = (s: string): string => q(s)?.textContent ?? '';
/** A press, and the wait until the wallet's work for it is over (the first one loads the file's code, which takes a moment). */
const press = async (selector: string) => {
  fireEvent.click(q(selector)!);
  await settle();
  await waitFor(() => expect(q('[data-working]')).toBeNull());
  await settle();
};

const SOON = Math.floor(Date.now() / 1000) + 86400;
const told = (over: Record<string, string | number> = {}) => ({
  state: 'waiting-for-approvals', approvals: 1, needed: 2, proposal: 'aa'.repeat(32), salt: 'bb'.repeat(32), latest: String(SOON),
  lastRecovery: 'cc'.repeat(32), resumesFrom: 'dd'.repeat(32), root: 'ee'.repeat(32), seq: 4, ...over,
});
const stopped = (refused?: string, over: Record<string, unknown> = {}) => ({
  of: 'stopped', step: 3, steps: 3, relayed: 0, unconfirmed: 0, why: 'check-failed', ...(refused === undefined ? {} : { refused }), ...over,
});
const raised = async () => { kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: told() }; await press('[data-action=raise-recovery]'); kr.acts = []; };

const saved: { blobs: Blob[]; names: string[] } = { blobs: [], names: [] };
beforeEach(() => {
  kr.acts = []; kr.steps = []; kr.hold = null; kr.reads = 0; kr.standings = 0; kr.records = { of: 'unreadable' }; kr.recordReads = 0; kr.round = { held: 'open', approvals: 1, needed: 2 };
  kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: told() };
  saved.blobs = []; saved.names = [];
  URL.createObjectURL = ((b: Blob) => { saved.blobs.push(b); return 'blob:recovery'; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.names.push(this.download); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('raising', () => {
  /* RED WHEN: the page's parts are drawn as bare headings instead of the kit's sections, or the nothing-held part is a bare line instead of the kit's empty state. */
  it('draws what it raises, holds and has checked as the kit\'s sections, and nothing held as the kit\'s empty state', async () => {
    await draw();
    const sections = [...document.body.querySelectorAll('[data-screen=recovery] > [data-slot=section]')];
    expect(sections.map((e) => e.querySelector('h2')?.textContent)).toEqual([words('recovery.records.heading'), words('recovery.raise.heading'), words('recovery.held.heading')]);
    expect(document.body.querySelectorAll('[data-screen=recovery] h2:not([data-slot=empty-state-title])')).toHaveLength(3);
    expect(q('[data-recovery-held] > [data-slot=empty-state] [data-slot=empty-state-line]')?.textContent).toBe(words('recovery.held.nothing'));
    expect(q('[data-recovery-held] > p')).toBeNull();
  });

  /* RED WHEN: the screen offers a time past the week the wallet allows, or none after now, or presses without asking the wallet for the choice made. */
  it('offers four times, none past six days, and asks the wallet for the one chosen, after now', async () => {
    await draw();
    const offered = [...document.body.querySelectorAll('[data-within]')].map((b) => b.getAttribute('data-within'));
    expect(offered).toEqual(['hour', 'day', 'three-days', 'six-days']);
    expect(q('[data-within=day]')!.getAttribute('aria-pressed')).toBe('true');
    await press('[data-within=six-days]');
    const before = Math.floor(Date.now() / 1000);
    await press('[data-action=raise-recovery]');
    expect(kr.acts).toHaveLength(1);
    expect(kr.acts[0]).toMatchObject({ name: 'recovery', record: 'c-1', company: 'label-1', step: 'raise' });
    const latest = Number(kr.acts[0]!['latest']);
    expect(latest - before).toBeGreaterThanOrEqual(6 * 86400);
    expect(latest - before).toBeLessThan(7 * 86400);
  });

  /* RED WHEN: a raised recovery is not held on the page with the time it may be carried out, where the chain holds it and its file to save, or its words do not say the file goes to the other signers. */
  it('holds the recovery raised, reads where the chain holds it and says to save its file', async () => {
    await draw();
    expect(text('[data-recovery-held] [data-slot=empty-state-line]')).toBe(words('recovery.held.nothing'));
    await press('[data-action=raise-recovery]');
    expect(q(`[data-recovery="${'aa'.repeat(32)}"]`)).not.toBeNull();
    expect(q('[data-recovery-held] [data-slot=empty-state]')).toBeNull();
    expect(text('[data-acted=raise]')).toContain(words('recovery.done.raise'));
    expect(text('[data-acted=raise]')).toContain(words('proposal.act.counted', { approvals: 1, needed: 2 }));
    expect(text('[data-acted=raise]')).toContain(words('recovery.done.save'));
    expect(text('[data-recovery-standing]')).toBe(words('recovery.standing.open', { approvals: 1, needed: 2 }));
    expect(kr.standings).toBeGreaterThan(0);
  });

  /* RED WHEN: a raise the wallet stopped after raising loses the file, or the stop is worded as if nothing had been raised. */
  it('keeps the file of a recovery the wallet raised and then stopped on', async () => {
    kr.ended = stopped('act.recovery.why.no-dust', { outcome: told() });
    await draw();
    await press('[data-action=raise-recovery]');
    expect(q('[data-recovery-stopped=no-dust]')).not.toBeNull();
    expect(text('[data-raised-file]')).toBe(words('recovery.done.save'));
    expect(q('[data-action=save-recovery-file]')).not.toBeNull();
  });

  /* RED WHEN: a press while the wallet is open can start another, or the steps the wallet reports are not shown. */
  it('shows the wallet\'s steps and lets no second press start while one runs', async () => {
    let release: () => void = () => {};
    kr.hold = new Promise<void>((r) => { release = r; });
    kr.steps = [{ step: 1, steps: 3 }];
    await draw();
    fireEvent.click(q('[data-action=raise-recovery]')!);
    await settle();
    expect(text('[data-working]')).toBe(words('signers.working.step', { step: 1, steps: 3 }));
    expect((q('[data-action=raise-recovery]') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(q('[data-action=raise-recovery]')!);
    await settle();
    expect(kr.acts).toHaveLength(1);
    release();
    await waitFor(() => expect(q('[data-working]')).toBeNull());
  });

  /* RED WHEN: the records are read again after a raise that only waits for approvals, or are not read after a carrying out that went through. */
  it('reads the company\'s records again only when the recovery was carried out', async () => {
    await draw();
    const first = kr.reads;
    await press('[data-action=raise-recovery]');
    expect(kr.reads).toBe(first);
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'carried-out', approvals: 2, needed: 2 } };
    await press('[data-action=carry-out-recovery]');
    expect(kr.reads).toBeGreaterThan(first);
  });
});

describe('approving and carrying out', () => {
  /* RED WHEN: Approve does not go to the wallet as the one approval under the recovery kind with the file's parts, or what the wallet says is not told. */
  it('asks the wallet to approve with the file\'s parts and tells where it stands', async () => {
    await draw();
    await raised();
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'waiting-for-approvals', approvals: 2, needed: 3 } };
    await press('[data-action=approve-recovery]');
    expect(kr.acts).toEqual([expect.objectContaining({ name: 'approve-proposal', kind: 'recovery', proposal: 'aa'.repeat(32), salt: 'bb'.repeat(32), seq: '4', latest: String(SOON) })]);
    expect(text('[data-acted=approve]')).toBe(`${words('recovery.done.approve')} ${words('proposal.act.counted', { approvals: 2, needed: 3 })}`);
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'carried-out', approvals: 3, needed: 3 } };
    await press('[data-action=approve-recovery]');
    expect(text('[data-acted=approve]')).toContain(words('recovery.done.carried'));
  });

  /* RED WHEN: Carry out does not ask the wallet at its carry step with the file's parts, or tells a count short of the bar as carried out. */
  it('asks the wallet to carry out with the file\'s parts and tells a short count as not carried out', async () => {
    await draw();
    await raised();
    kr.ended = { of: 'done', steps: 2, relayed: 0, outcome: { state: 'waiting-for-approvals', approvals: 1, needed: 2 } };
    await press('[data-action=carry-out-recovery]');
    expect(kr.acts).toEqual([expect.objectContaining({ name: 'recovery', step: 'carry', proposal: 'aa'.repeat(32), resumesFrom: 'dd'.repeat(32), root: 'ee'.repeat(32) })]);
    expect(text('[data-acted=carry]')).toContain(words('recovery.done.not-yet'));
    expect(text('[data-acted=carry]')).not.toContain(words('recovery.done.carried'));
  });

  /* RED WHEN: a stop is worded as a different reason, a stop the wallet says may have gone is told as one that sent nothing, or a refusal before the window is lost. */
  it('words each stop of the wallet, and warns when part of it may have gone', async () => {
    await draw();
    await raised();
    const stopsWith = async (refused: string | undefined, over: Record<string, unknown> = {}) => { kr.ended = stopped(refused, over); await press('[data-action=carry-out-recovery]'); };
    await stopsWith('act.recovery.why.still-open');
    expect(text('[data-recovery-stopped=still-open]')).toBe(words('recovery.why.still-open'));
    await stopsWith('act.recovery.why.may-be-sent');
    expect(text('[data-recovery-stopped=may-be-sent]')).toContain(words('recovery.why.may-be-sent'));
    expect(q('[data-partial]')).not.toBeNull();
    await stopsWith('act.recovery.why.not-carried');
    expect(text('[data-recovery-stopped=not-done]')).toBe(words('recovery.why.not-done.carry'));
    expect(q('[data-partial]')).toBeNull();
    await stopsWith(undefined);
    expect(text('[data-recovery-stopped=stopped]')).toBe(words('recovery.why.stopped'));
    await stopsWith('act.recovery.why.outrun');
    expect(text('[data-recovery-stopped=outrun]')).toBe(words('recovery.why.outrun'));
  });
});

describe('the file', () => {
  /* RED WHEN: Save does not give the person the file under its own name with the text the other signers open, or the file holds anything but the recovery's public parts. */
  it('saves the file it holds, under its name, and the file holds no secret', async () => {
    await draw();
    await raised();
    await press('[data-action=save-recovery-file]');
    expect(saved.names).toEqual(['recovery-aaaaaaaa.json']);
    const file = JSON.parse(await saved.blobs[0]!.text()) as Record<string, unknown>;
    expect(file).toMatchObject({ company: 'c-1', chainId: 'aa'.repeat(32), salt: 'bb'.repeat(32), change: { kind: 'recover-anchor', latest: String(SOON) } });
    expect(Object.keys(file).sort()).toEqual(['account', 'chainId', 'change', 'company', 'format', 'resumesFrom', 'salt', 'summary']);
    expect(file['summary']).toContain('batch 4');
  });

  /* RED WHEN: a file saved here does not open as the same recovery, or what it says of where the chain holds it comes from the file and not a read of the chain. */
  it('opens a saved file as a recovery and reads where the chain holds it', async () => {
    await draw();
    await raised();
    await press('[data-action=save-recovery-file]');
    const text0 = await saved.blobs[0]!.text();
    cleanup();
    kr.standings = 0;
    kr.round = { held: 'open', approvals: 2, needed: 3 };
    await draw();
    expect(q('[data-recovery-held] [data-slot=empty-state]')).not.toBeNull();
    const input = q('[data-recovery-file]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [new File([text0], 'recovery.json', { type: 'application/json' })] } }); });
    await waitFor(() => expect(q(`[data-recovery="${'aa'.repeat(32)}"]`)).not.toBeNull());
    await settle();
    expect(kr.standings).toBeGreaterThan(0);
    expect(text('[data-recovery-standing]')).toBe(words('recovery.standing.open', { approvals: 2, needed: 3 }));
    expect(kr.acts).toEqual([]);
  });

  /* RED WHEN: a file that is not a recovery of this company opens, or its refusal is worded as another reason. */
  it('refuses a file that is not a recovery of this company, in words', async () => {
    await draw();
    const input = q('[data-recovery-file]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['not json'], 'x.json')] } }); });
    await settle();
    expect(text('[data-file-refused]')).toBe(words('recovery.file.refused.unreadable'));
    expect(q('[data-recovery]')).toBeNull();
  });

  /* RED WHEN: the screen says a recovery stands, or lets Approve and Carry out be pressed, when the chain shows it no longer open or its time passed; or says the chain is unread as if it were not. */
  it('shows what the chain holds, and turns off Approve and Carry out where the chain says there is nothing to do', async () => {
    const buttons = () => ['approve-recovery', 'carry-out-recovery'].map((a) => (q(`[data-action=${a}]`) as HTMLButtonElement).disabled);
    const shownFor = async (round: unknown) => { cleanup(); kr.round = round; await draw(); await raised(); };
    await shownFor({ held: 'open', approvals: 1, needed: 2 });
    expect(buttons()).toEqual([false, false]);
    await shownFor({ held: 'closed', approvals: 2 });
    expect(text('[data-recovery-standing]')).toBe(words('recovery.standing.closed'));
    expect(buttons()).toEqual([true, true]);
    await shownFor({ held: 'cleared', approvals: 2 });
    expect(buttons()).toEqual([true, true]);
    await shownFor({ held: 'never', approvals: 0 });
    expect(text('[data-recovery-standing]')).toBe(words('recovery.standing.never'));
    expect(buttons()).toEqual([false, false]);
    await shownFor({ held: 'open', approvals: 1, needed: 2, outrun: true });
    expect(text('[data-recovery-standing]')).toContain(words('recovery.standing.outrun'));
  });
});

const quiet = { reached: 7, stopped: null, checkedFrom: null, recovered: null, notYetAnchored: 0, passedOver: [], notApplied: [] };
const SEAT = 'ab'.repeat(32);
const states = async (value: Record<string, unknown>) => { kr.records = { of: 'read', value: { ...quiet, ...value } }; await draw(); };

describe('the company\'s records, each state in its own words', () => {
  /* RED WHEN: a read that cannot be made is shown as a stop or as nothing wrong, or the horizon the network allows is not said where a recovery is raised. */
  it('says an unreadable read as unread and blames no stop, and says the seven days beside the times', async () => {
    await draw();
    expect(text('[data-records-state=unread]')).toBe(words('recovery.records.unread'));
    expect(q('[data-records-state=stopped]')).toBeNull();
    expect(text('[data-recovery-horizon]')).toBe(words('recovery.horizon'));
  });

  /* RED WHEN: a quiet read hides where the check began or says there is a stop, or batch -1 is said as a batch. */
  it('says a quiet read: where the check reached and began, and that nothing stops it', async () => {
    await states({});
    expect(text('[data-records-state=reached]')).toBe(words('recovery.records.reached', { seq: 7 }));
    expect(text('[data-records-state=checked-from]')).toBe(words('recovery.records.fromFirst'));
    expect(text('[data-records-state=no-stop]')).toBe(words('recovery.records.noStop'));
    for (const hidden of ['stopped', 'recovered', 'not-yet-anchored', 'passed-over', 'not-applied']) expect(q(`[data-records-state=${hidden}]`), hidden).toBeNull();
    cleanup();
    await states({ reached: -1 });
    expect(text('[data-records-state=reached]')).toBe(words('recovery.records.nothingChecked'));
  });

  /* RED WHEN: a stop is told as the service's fault alone, loses the seat it names, or loses the way past it. */
  it('says a batch not given with the seat that moved the anchor past it, and a batch not honest with its signer', async () => {
    await states({ stopped: { stop: 'not-given', seq: 7, what: 'x', movedBy: SEAT } });
    expect(text('[data-stop=not-given]')).toContain(words('recovery.records.stop.notGiven', { batch: 8 }));
    expect(text('[data-moved-by]')).toBe(words('recovery.records.stop.movedBy', { seat: SEAT.slice(0, 12) }));
    /* RED WHEN: the stop advises removing the seat, which cannot be done yet. */
    expect(words('recovery.records.stop.movedBy', { seat: 'x' })).not.toMatch(/remove it/u);
    expect(words('recovery.records.stop.movedBy', { seat: 'x' })).toMatch(/removing a signer is not possible from here yet/u);
    expect(text('[data-stop=not-given]')).toContain(words('recovery.records.stop.wayPast'));
    expect(q('[data-records-state=no-stop]')).toBeNull();
    cleanup();
    await states({ stopped: { stop: 'not-given', seq: 7, what: 'x', movedBy: SEAT, anchorsInBlock: 3 } });
    expect(text('[data-moved-by]')).toBe(words('recovery.records.stop.movedByOneOf', { seat: SEAT.slice(0, 12), count: 3 }));
    cleanup();
    await states({ stopped: { stop: 'not-given', seq: 7, what: 'x', recovery: true } });
    expect(text('[data-stop=not-given]')).toContain(words('recovery.records.stop.recovery', { seq: 7 }));
    cleanup();
    await states({ stopped: { stop: 'dishonest', seq: 7, anchoredBy: SEAT, why: 'x' } });
    expect(text('[data-stop=dishonest]')).toContain(words('recovery.records.stop.dishonest', { batch: 8 }));
    expect(text('[data-stop=dishonest]')).toContain(words('recovery.records.stop.signedBy', { seat: SEAT.slice(0, 12) }));
    cleanup();
    await states({ stopped: { stop: 'dishonest', seq: 7, anchoredBy: null, why: 'x' } });
    expect(text('[data-stop=dishonest]')).toContain(words('recovery.records.stop.unsigned'));
  });

  /* RED WHEN: where the check began is not said for a device that began near the latest or at a run its approvers vouched for, or the run is not named. */
  it('says where a check that began after the first batch began, naming the run', async () => {
    await states({ checkedFrom: { by: 'latest', seq: 6, head: 'h' } });
    expect(text('[data-records-state=checked-from]')).toBe(words('recovery.records.fromLatest', { seq: 6 }));
    cleanup();
    await states({ checkedFrom: { by: 'vouched', seq: 4, head: 'h', run: SEAT } });
    expect(text('[data-records-state=checked-from]')).toBe(words('recovery.records.fromVouched', { seq: 4, run: SEAT.slice(0, 12) }));
    cleanup();
    await states({ checkedFrom: { by: 'vouched', seq: 4, head: 'h', run: SEAT, at: 99 } });
    expect(text('[data-records-state=checked-from]')).toBe(words('recovery.records.fromVouchedAt', { seq: 4, run: SEAT.slice(0, 12), at: 99 }));
  });

  /* RED WHEN: what a recovery gave up is said as the service's act, or not said; or a version passed over, a change not applied or a record not yet anchored is said as missing, or not counted. */
  it('says what a recovery gave up as the signers\' act, and the versions passed over, the changes not applied and the records not yet anchored', async () => {
    await states({ recovered: { resumedFrom: 4, gaveUpTo: 6 }, notYetAnchored: 3, passedOver: [3, 5], notApplied: [6] });
    expect(text('[data-records-state=recovered]')).toBe(words('recovery.records.recovered', { from: 4, to: 6 }));
    expect(text('[data-records-state=not-yet-anchored]')).toBe(words('recovery.records.notYetAnchored', { count: 3 }));
    expect(text('[data-records-state=passed-over]')).toBe(`${words('recovery.records.passedOver', { count: 2 })} 3 5`);
    expect(text('[data-records-state=not-applied]')).toBe(`${words('recovery.records.notApplied', { count: 1 })} 6`);
    cleanup();
    await states({ notYetAnchored: 1, passedOver: [2] });
    expect(text('[data-records-state=not-yet-anchored]')).toBe(words('recovery.records.notYetAnchored', { count: 1 }));
    expect(text('[data-records-state=passed-over]')).toContain('2');
  });

  /* RED WHEN: the records are not read again after a press, so a stop a recovery just passed stays on screen. */
  it('reads the records again after a press', async () => {
    await states({});
    const before = kr.recordReads;
    await raised();
    expect(kr.recordReads).toBeGreaterThan(before);
  });
});
