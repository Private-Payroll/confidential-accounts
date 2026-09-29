// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { CurrentPageProvider } from '../router.js';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { SessionProvider, type Session } from '../session.js';
import { VIEWS } from '../pages.js';
import { untilPageShown } from '../page-shown.test-support.js';

/*
 * THE SETUP WIZARD AND ITS TWO BUILT STEPS, DRAWN, with the adapters that act
 * and read stood in for, so what each step shows and when it acts is read
 * from the screen.
 */
const state = vi.hoisted(() => ({
  handover: { of: 'vault-keys-missing', signers: 1 } as Record<string, unknown>,
  acted: [] as string[],
  gaveKeys: { of: 'done' } as unknown,
  created: { of: 'done', companyId: 'c-new' } as Record<string, unknown>,
  waiting: null as string | null,
  /** The company's vaults as the service lists them, and whether one can be created, and what creating one comes to. */
  vaults: [] as { vault: string; createdAt: string; standing: string }[] | null,
  ready: { of: 'ready' } as Record<string, unknown>,
  vaultCreated: { of: 'done', vault: 'v-new' } as Record<string, unknown>,
  owed: [] as { vault: string; number: number; here: boolean }[],
  opened: [] as string[],
}));
vi.mock('../adapters/vault-rows.js', async (real) => ({
  ...(await real<typeof import('../adapters/vault-rows.js')>()),
  readVaultRows: vi.fn(async () => state.vaults),
}));
vi.mock('../adapters/create-vault.js', async (real) => ({
  ...(await real<typeof import('../adapters/create-vault.js')>()),
  readVaultReadiness: vi.fn(async () => state.ready),
  readOwedVaults: vi.fn(async () => state.owed),
  openYourKeys: vi.fn(async (person: string) => { state.opened.push(person); state.ready = { of: 'ready' }; return { of: 'done' }; }),
  createVault: vi.fn(async (person: string, company: string, onStage: (s: string) => void) => {
    onStage('building');
    state.acted.push(JSON.stringify(['create-vault', person, company]));
    return state.vaultCreated;
  }),
  finishHandingOver: vi.fn(async (person: string, company: string, vault: string) => {
    state.acted.push(JSON.stringify(['finish-vault', person, company, vault]));
    return state.vaultCreated;
  }),
  giveYourVaultKeys: vi.fn(async (person: string, company: string) => {
    state.acted.push(JSON.stringify(['give-vault-keys', person, company]));
    state.ready = { of: 'others-missing' };
    return state.gaveKeys;
  }),
}));
vi.mock('../adapters/handover-state.js', async (real) => ({
  ...(await real<typeof import('../adapters/handover-state.js')>()),
  readHandover: vi.fn(async () => state.handover),
}));
vi.mock('../adapters/hand-over.js', () => ({
  handOver: vi.fn(async () => { state.acted.push('hand-over'); return { of: 'done' }; }),
  signChange: vi.fn(async () => { state.acted.push('sign-change'); return { of: 'done' }; }),
  giveMyVaultKeys: vi.fn(async () => { state.acted.push('give-keys'); return { of: 'done' }; }),
}));
vi.mock('../adapters/create-company.js', () => ({
  createCompany: vi.fn(async (...args: unknown[]) => { state.acted.push(JSON.stringify(['create', ...args])); return state.created; }),
  finishCreating: vi.fn(async () => { state.acted.push('finish'); return state.created; }),
  waitingToBeFinished: () => state.waiting,
}));

const { Setup } = await import('../screens/setup.js');
const { HandOver } = await import('../actions/hand-over.js');
const { CreateCompany } = await import('../actions/create-company.js');
const { CreateVault } = await import('../actions/create-vault.js');
const { EVERY_STEP, isBuiltStep, startSetupAt, takeAsked } = await import('./steps.js');
const { isDoneForGood, skippedFor } = await import('./standing.js');
const { STEP } = await import('./step-ids.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../locales/en.json'), 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const settle = () => new Promise((r) => setTimeout(r, 0));

function sessionWith(over: Partial<Session> = {}): Session {
  return {
    person: { id: 'u1', name: 'Priya' }, companies: [], company: null, chooseCompany: vi.fn(),
    viewer: { signedIn: true, view: VIEWS.employee, signs: false }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
    choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}), ...over,
  };
}

const framed = (node: React.ReactNode, session: Session) => (
  <KitProvider languages={LANGUAGES} pick="en">
    <SessionProvider session={session}><CurrentPageProvider id="setup">{node}</CurrentPageProvider></SessionProvider>
  </KitProvider>
);
/** A step's own component, drawn on its own. */
async function draw(node: React.ReactNode, session: Session) {
  const view = render(framed(node, session));
  await act(settle);
  return view;
}
/** The wizard, drawn as a page, and waited for until it is on screen. */
async function drawWizard(session: Session) {
  const view = render(framed(<Setup />, session));
  await untilPageShown(view.container);
  return view;
}
const q = (c: HTMLElement, sel: string) => c.querySelector(sel) as HTMLElement | null;
/* The kit's tabs are chosen on mouse-down, as the browser sends it, not on click, so a test presses a tab that way. */
const pick = async (c: HTMLElement, step: string) => { await act(async () => { fireEvent.mouseDown(q(c, `[data-setup-steps] [data-step=${step}]`)!, { button: 0 }); await settle(); }); };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.handover = { of: 'vault-keys-missing', signers: 1 }; state.acted = []; state.gaveKeys = { of: 'done' }; state.waiting = null; state.created = { of: 'done', companyId: 'c-new' };
  state.vaults = []; state.ready = { of: 'ready' }; state.vaultCreated = { of: 'done', vault: 'v-new' }; state.owed = []; state.opened = [];
  /* What a tab remembers between showings of the wizard starts empty for every test. */
  for (const c of [null, 'c-1']) skippedFor(c).clear();
  window.sessionStorage.clear();
  takeAsked();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the wizard reads the one list', () => {
  /* RED WHEN: the wizard's list of steps or its progress bar is not the list's, one step left out or added, or in another order. */
  it('lists every step and marks each on the progress bar, in the list\'s order', async () => {
    const { container } = await drawWizard(sessionWith());
    expect([...container.querySelectorAll('[data-setup-steps] [data-step]')].map((e) => e.getAttribute('data-step'))).toEqual(EVERY_STEP.map((s) => s.id));
    expect([...container.querySelectorAll('[data-progress] [data-mark]')].map((e) => e.getAttribute('data-mark'))).toEqual(EVERY_STEP.map((s) => s.id));
    expect(q(container, '[data-progress]')!.getAttribute('aria-valuemax')).toBe(String(EVERY_STEP.length));
  });

  /* RED WHEN: a step not built is shown without Coming soon and its line, or a built step does not show its own component. */
  it('shows a built step\'s component and a step not built Coming soon', async () => {
    const { container } = await drawWizard(sessionWith());
    for (const s of EVERY_STEP) {
      await pick(container, s.id);
      expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(s.id);
      if (isBuiltStep(s)) expect(q(container, '[data-current-step] [data-action]'), s.id).not.toBeNull();
      else {
        expect(q(container, '[data-current-step] [data-slot=coming-soon]'), s.id).not.toBeNull();
        expect(q(container, '[data-coming-soon-step]')!.textContent, s.id).toBe(EN[`setup.step.${s.id}.soon`]);
      }
    }
  });
});

describe('moving between steps', () => {
  /* RED WHEN: a step that leads to another does not take the wizard there. */
  it('follows a step\'s lead to the step that fixes it', async () => {
    const { container } = await drawWizard(sessionWith());
    await pick(container, STEP.handOver);
    await act(async () => { fireEvent.click(q(container, `[data-lead-to=${STEP.createCompany}]`)!); await settle(); });
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.createCompany);
  });
});

describe('a step that cannot be undone', () => {
  /* RED WHEN: a step whose action cannot be undone is not marked so in the list, or one that can be undone is. */
  it('is marked so in the one list, step by step', () => {
    expect(EVERY_STEP.filter((s) => s.cannotBeUndone).map((s) => s.id)).toEqual([STEP.createCompany, STEP.handOver, STEP.vault]);
  });

  /*
   * RED WHEN: after the company is created the wizard stays on Create the
   * company, or its tab does not say done, can be pressed, or shows the form
   * again, blank.
   */
  it('moves on by itself once the company is created, and never reopens it blank', async () => {
    /* As the application keeps it: the company created is asked for again and shown. */
    function Wizard() {
      const [company, setCompany] = useState<string | null>(null);
      return (
        <SessionProvider session={sessionWith({ company, companiesChanged: async (id) => { if (id !== undefined) setCompany(id); } })}>
          <Setup />
        </SessionProvider>
      );
    }
    const view = render(<KitProvider languages={LANGUAGES} pick="en"><CurrentPageProvider id="setup"><Wizard /></CurrentPageProvider></KitProvider>);
    const { container } = view;
    await untilPageShown(container);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.createCompany);
    fireEvent.change(container.querySelector('[data-action=create-company] input')!, { target: { value: 'Acme' } });
    await act(async () => { fireEvent.click(q(container, '[data-action=create]')!); await settle(); });
    await untilPageShown(container);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.signers);
    const tab = q(container, `[data-setup-steps] [data-step=${STEP.createCompany}]`) as HTMLButtonElement;
    expect(tab.getAttribute('data-standing')).toBe('done');
    expect(tab.hasAttribute('data-done-for-good')).toBe(true);
    expect(tab.querySelector('[data-done]')!.textContent).toBe(EN['setup.done']);
    expect(tab.disabled).toBe(true);
    await pick(container, STEP.createCompany);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.signers);
    expect(q(container, '[data-action=create-company]')).toBeNull();
  });

  /* RED WHEN: a step done for good, asked for by name (from the setup card), is opened with its action again rather than the step after it. */
  it('opens the step after one done for good, when that one is asked for', async () => {
    startSetupAt(STEP.createCompany);
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.signers);
    expect(q(container, '[data-action=create-company]')).toBeNull();
  });

  /* RED WHEN: once the company is held by its signers, the handover step can be opened again, or does not say done. */
  it('closes the handover once the company is held, and moves on', async () => {
    state.handover = { of: 'held' };
    startSetupAt(STEP.handOver);
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.vault);
    const tab = q(container, `[data-setup-steps] [data-step=${STEP.handOver}]`) as HTMLButtonElement;
    expect(tab.disabled).toBe(true);
    expect(tab.querySelector('[data-done]')).not.toBeNull();
    expect(q(container, '[data-action=hand-over]')).toBeNull();
  });

  /*
   * RED WHEN: before the company's handover is read, the handover step's
   * action is drawn or its tab can be pressed, so a company already held is
   * offered the handover again, even for a moment; or the step is drawn as
   * anything but the kit's section loading while it is read.
   */
  it('offers no step that cannot be undone while the company is still being read', async () => {
    state.handover = { of: 'held' };
    startSetupAt(STEP.handOver);
    const { container } = render(framed(<Setup />, sessionWith({ company: 'c-1' })));
    expect(q(container, '[data-screen=setup]')!.hasAttribute('data-reading')).toBe(true);
    expect(q(container, '[data-action=hand-over]')).toBeNull();
    /* The step is drawn as the kit's section loading while it is read, not as loose lines. */
    expect(q(container, '[data-step-reading]')!.getAttribute('data-slot')).toBe('section-loading');
    expect(q(container, '[data-step-reading]')!.getAttribute('aria-busy')).toBe('true');
    expect((q(container, `[data-setup-steps] [data-step=${STEP.handOver}]`) as HTMLButtonElement).disabled).toBe(true);
    expect((q(container, `[data-setup-steps] [data-step=${STEP.vault}]`) as HTMLButtonElement).disabled).toBe(true);
    expect((q(container, `[data-setup-steps] [data-step=${STEP.people}]`) as HTMLButtonElement).disabled).toBe(false);
    await untilPageShown(container);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.vault);
    expect(q(container, '[data-action=hand-over]')).toBeNull();
  });

  /* RED WHEN: a skipped step, a step not done, or a step done that can be undone, is closed as if done for good. */
  it('leaves every other step open to return to', async () => {
    const facts = { company: 'c-1', handover: null, vaults: null };
    const doneButUndoable = { ...EVERY_STEP.find((s) => s.id === STEP.people)!, done: () => true };
    expect(isDoneForGood(doneButUndoable, facts)).toBe(false);
    expect(isDoneForGood({ ...doneButUndoable, cannotBeUndone: true }, facts)).toBe(true);
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    await act(async () => { fireEvent.click(q(container, '[data-action=skip]')!); await settle(); });
    for (const id of [STEP.signers, STEP.handOver, STEP.vault, STEP.people]) {
      expect((q(container, `[data-setup-steps] [data-step=${id}]`) as HTMLButtonElement).disabled, id).toBe(false);
    }
    await pick(container, STEP.signers);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.signers);
  });
});

describe('skipping', () => {
  /* RED WHEN: a skipped step is shown as done (a tick, a filled mark, a count), is not shown as skipped, or cannot be returned to. */
  it('shows a skipped step as skipped, never done, and lets the person return to it', async () => {
    const { container } = await drawWizard(sessionWith());
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.createCompany);
    await act(async () => { fireEvent.click(q(container, '[data-action=skip]')!); await settle(); });
    const row = q(container, `[data-setup-steps] [data-step=${STEP.createCompany}]`)!;
    expect(row.getAttribute('data-standing')).toBe('skipped');
    expect(row.querySelector('[data-skipped]')!.textContent).toBe(EN['setup.skipped']);
    expect(q(container, `[data-mark=${STEP.createCompany}]`)!.getAttribute('data-filled')).toBe('false');
    expect(q(container, '[data-progress]')!.getAttribute('aria-valuenow')).toBe('0');
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.signers);
    await pick(container, STEP.createCompany);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.createCompany);
  });

  /*
   * RED WHEN: a skipped step is forgotten when the tab reloads (the skip kept
   * only in the page's memory), is kept under another company, or a skip
   * kept for a step no longer in the list is read back as a step.
   */
  it('keeps a skipped step through a reload of the tab, for its own company', async () => {
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    await act(async () => { fireEvent.click(q(container, '[data-action=skip]')!); await settle(); });
    expect(q(container, `[data-setup-steps] [data-step=${STEP.signers}]`)!.getAttribute('data-standing')).toBe('skipped');
    expect(q(container, `[data-mark=${STEP.signers}]`)!.getAttribute('data-filled')).toBe('false');
    cleanup();
    /* A reload: the modules start again, and read only what the tab kept. */
    vi.resetModules();
    const fresh = await import('./standing.js');
    expect([...fresh.skippedFor('c-1')]).toEqual([STEP.signers]);
    expect([...fresh.skippedFor(null)]).toEqual([]);
    const [{ Setup: Reloaded }, ui, sessions, router] = await Promise.all([import('../screens/setup.js'), import('vaults-ui'), import('../session.js'), import('../router.js')]);
    const again = render(
      <ui.KitProvider languages={ui.languagesFrom({ './locales/en.json': EN })} pick="en">
        <sessions.SessionProvider session={sessionWith({ company: 'c-1' })}><router.CurrentPageProvider id="setup"><Reloaded /></router.CurrentPageProvider></sessions.SessionProvider>
      </ui.KitProvider>,
    );
    await untilPageShown(again.container);
    expect(q(again.container, `[data-setup-steps] [data-step=${STEP.signers}]`)!.getAttribute('data-standing')).toBe('skipped');
    expect(q(again.container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.handOver);
    window.sessionStorage.setItem('private-vaults.setup-skipped', JSON.stringify({ 'c-1': ['deposit', STEP.vault], '': 'not a list' }));
    expect([...fresh.readSkips(window.sessionStorage).entries()].map(([c, v]) => [c, [...v]])).toEqual([['c-1', [STEP.vault]]]);
  });

  /* RED WHEN: a step done is not counted and marked as done, or Continue is offered on a step that is not done. */
  it('counts and marks a step done only when it is, and offers Continue only then', async () => {
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    expect(q(container, `[data-mark=${STEP.createCompany}]`)!.getAttribute('data-filled')).toBe('true');
    expect(q(container, '[data-progress]')!.getAttribute('aria-valuenow')).toBe('1');
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.signers);
    expect((q(container, '[data-action=continue]') as HTMLButtonElement).disabled).toBe(true);
    state.handover = { of: 'held' };
    cleanup();
    const again = await drawWizard(sessionWith({ company: 'c-1' }));
    expect(q(again.container, `[data-mark=${STEP.handOver}]`)!.getAttribute('data-filled')).toBe('true');
    expect(q(again.container, '[data-progress]')!.getAttribute('aria-valuenow')).toBe('2');
  });
});

describe('handing the company over: every action shown, disabled with why, leading to the step that fixes it', () => {
  /* RED WHEN: with no company the handover is hidden, enabled, says no reason, or does not lead to creating the company. */
  it('before the company exists', async () => {
    const leadTo = vi.fn();
    const { container } = await draw(<HandOver leadTo={leadTo} onChanged={() => {}} />, sessionWith());
    expect((q(container, '[data-action=hand-over-now]') as HTMLButtonElement).disabled).toBe(true);
    expect(q(container, '[data-why]')!.textContent).toBe(EN['setup.handOver.why.noCompany']);
    fireEvent.click(q(container, `[data-lead-to=${STEP.createCompany}]`)!);
    expect(leadTo).toHaveBeenCalledWith(STEP.createCompany);
  });

  /* RED WHEN: with any one signer able to approve alone, the handover is enabled or hidden, or does not lead to setting approvals. */
  it('with too few approvals', async () => {
    state.handover = { of: 'too-few-approvals', signers: 3, needed: 1 };
    const leadTo = vi.fn();
    const { container } = await draw(<HandOver leadTo={leadTo} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    expect((q(container, '[data-action=hand-over-now]') as HTMLButtonElement).disabled).toBe(true);
    expect(q(container, '[data-why]')!.getAttribute('data-why')).toBe('too-few-approvals');
    expect(q(container, '[data-why]')!.textContent).toBe(EN['setup.handOver.why.tooFewApprovals_other']!.replace('{count}', '3'));
    fireEvent.click(q(container, `[data-lead-to=${STEP.signers}]`)!);
    expect(leadTo).toHaveBeenCalledWith(STEP.signers);
  });

  /* RED WHEN: with vault keys missing the handover is enabled, or there is no way to give this person's keys from the step. */
  it('with vault keys missing, offers to give them', async () => {
    const { container } = await draw(<HandOver leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    expect((q(container, '[data-action=hand-over-now]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(q(container, '[data-action=give-vault-keys]')!); await settle(); });
    expect(state.acted).toEqual(['give-keys']);
  });

  /* RED WHEN: the handover is sent without the "Confirm in your account" step in front of it, or is sent when that step is cancelled. */
  it('when ready, asks to confirm in the account before anything is sent', async () => {
    state.handover = { of: 'ready', everySignerNeeded: false, signers: 1 };
    const { container } = await draw(<HandOver leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await act(async () => { fireEvent.click(q(container, '[data-action=hand-over-now]')!); await settle(); });
    expect(state.acted).toEqual([]);
    expect(q(container, '[data-slot=confirm-in-your-account]')).not.toBeNull();
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.cancel'])!); await settle(); });
    expect(state.acted).toEqual([]);
    await act(async () => { fireEvent.click(q(container, '[data-action=hand-over-now]')!); await settle(); });
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect(state.acted).toEqual(['hand-over']);
  });
});

describe('signing a change owed', () => {
  /* RED WHEN: a change is signed without the "Confirm in your account" step in front of it. */
  it('asks to confirm in the account before anything is signed', async () => {
    state.handover = { of: 'change-owed', signed: [{ have: 1, required: 2 }] };
    const { container } = await draw(<HandOver leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await act(async () => { fireEvent.click(q(container, '[data-action=sign-change]')!); await settle(); });
    expect(state.acted).toEqual([]);
    expect(q(container, '[data-slot=confirm-in-your-account]')).not.toBeNull();
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect(state.acted).toEqual(['sign-change']);
    expect(q(container, '[data-acted]')!.textContent).toBe(EN['setup.handOver.done.signChange']);
  });

  /* RED WHEN: a line saying something was sent is shown after giving vault keys, or beside a company already held. */
  it('says what each action did, and nothing pending once the company is held', async () => {
    const { container } = await draw(<HandOver leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await act(async () => { fireEvent.click(q(container, '[data-action=give-vault-keys]')!); await settle(); });
    expect(q(container, '[data-acted]')!.textContent).toBe(EN['setup.handOver.done.giveKeys']);
    cleanup();
    state.handover = { of: 'ready', everySignerNeeded: false, signers: 1 };
    const again = await draw(<HandOver leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    state.handover = { of: 'held' };
    await act(async () => { fireEvent.click(q(again.container, '[data-action=hand-over-now]')!); await settle(); });
    await act(async () => { fireEvent.click([...again.container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect(q(again.container, '[data-acted]')).toBeNull();
    expect(q(again.container, '[data-why]')!.textContent).toBe(EN['setup.handOver.why.held']);
  });
});

describe('creating a vault: one component, on the step and on the Vaults page', () => {
  const HELD = { vault: 'v-1', createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee' };
  const OWED = { vault: 'v-2', createdAt: '2026-09-02T00:00:00.000Z', standing: 'handover-owed' };

  /* RED WHEN: once a vault is held by the signers the vault step can be opened again or does not say done; or a vault sent and not handed over is taken for done. */
  it('closes the vault step once a vault is held by the signers, and only then', async () => {
    state.handover = { of: 'held' };
    state.vaults = [OWED];
    startSetupAt(STEP.vault);
    const first = await drawWizard(sessionWith({ company: 'c-1' }));
    expect(q(first.container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.vault);
    expect(q(first.container, '[data-action=create-vault]')).not.toBeNull();
    cleanup();
    state.vaults = [OWED, HELD];
    startSetupAt(STEP.vault);
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.people);
    const tab = q(container, `[data-setup-steps] [data-step=${STEP.vault}]`) as HTMLButtonElement;
    expect(tab.disabled).toBe(true);
    expect(tab.querySelector('[data-done]')).not.toBeNull();
    expect(q(container, '[data-action=create-vault]')).toBeNull();
  });

  /* RED WHEN: vaults that could not be read close the step as if one were held, or the step is offered before they are read. */
  it('keeps the step open when the vaults could not be read, and closed while they are read', async () => {
    state.handover = { of: 'held' };
    state.vaults = null;
    startSetupAt(STEP.vault);
    const { container } = render(framed(<Setup />, sessionWith({ company: 'c-1' })));
    expect((q(container, `[data-setup-steps] [data-step=${STEP.vault}]`) as HTMLButtonElement).disabled).toBe(true);
    await untilPageShown(container);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.vault);
    expect(q(container, `[data-setup-steps] [data-step=${STEP.vault}]`)!.getAttribute('data-standing')).toBe('open');
  });

  /* RED WHEN: keys not open in this tab are said as anything but that, or there is no way to open them with the account from the step. */
  it('with the keys not open, offers to open them with the account', async () => {
    state.ready = { of: 'locked' };
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    expect((q(container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(true);
    expect(q(container, '[data-why]')!.textContent).toBe(EN['createVault.why.locked']);
    await act(async () => { fireEvent.click(q(container, '[data-action=open-with-your-account]')!); await settle(); });
    expect(state.opened).toEqual(['u1']);
    expect((q(container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(false);
  });

  /* RED WHEN: Create a vault is hidden, enabled, or says no reason while it cannot be used, or does not lead to the step that makes it possible. */
  it('is always shown, and disabled with why and the way on while it cannot be used', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ of: 'yours-missing' }, 'createVault.why.yoursMissing'],
      [{ of: 'others-missing' }, 'createVault.why.othersMissing'],
      [{ of: 'roster-disagrees' }, 'createVault.why.rosterDisagrees'],
      [{ of: 'not-on-chain' }, 'createVault.why.notOnChain'],
    ];
    for (const [ready, why] of cases) {
      state.ready = ready;
      const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
      expect((q(container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled, why).toBe(true);
      expect(q(container, '[data-why]')!.textContent, why).toBe(EN[why]);
      /* Giving your vault keys is offered only where they are what is missing. */
      expect(q(container, '[data-action=give-vault-keys]') !== null, why).toBe(why === 'createVault.why.yoursMissing');
      cleanup();
    }
    const leadTo = vi.fn();
    const { container } = await draw(<CreateVault leadTo={leadTo} onChanged={() => {}} />, sessionWith());
    expect((q(container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(true);
    expect(q(container, '[data-why]')!.textContent).toBe(EN['createVault.why.noCompany']);
    fireEvent.click(q(container, `[data-lead-to=${STEP.createCompany}]`)!);
    expect(leadTo).toHaveBeenCalledWith(STEP.createCompany);
  });

  /*
   * RED WHEN: a person who has not given their vault keys is sent to another
   * step to give them, rather than giving them where Create a vault is; the
   * keys are given for another person or company; what happened is not said;
   * or whether a vault can be created is not read again after.
   */
  it('gives the person\'s vault keys where Create a vault is, and reads again after', async () => {
    for (const [gave, says] of [[{ of: 'done' }, EN['setup.handOver.done.giveKeys']], [{ of: 'refused', why: 'unreachable' }, null]] as const) {
      state.ready = { of: 'yours-missing' }; state.acted = []; state.gaveKeys = gave;
      const leadTo = vi.fn();
      const onChanged = vi.fn();
      const { container } = await draw(<CreateVault leadTo={leadTo} onChanged={onChanged} />, sessionWith({ company: 'c-1' }));
      expect(q(container, `[data-lead-to=${STEP.handOver}]`)).toBeNull();
      await act(async () => { fireEvent.click(q(container, '[data-action=give-vault-keys]')!); await settle(); });
      expect(state.acted).toEqual([JSON.stringify(['give-vault-keys', 'u1', 'c-1'])]);
      expect(leadTo).not.toHaveBeenCalled();
      expect(onChanged).toHaveBeenCalled();
      expect(q(container, '[data-why]')!.textContent).toBe(EN['createVault.why.othersMissing']);
      if (says === null) expect(q(container, '[data-refusal=unreachable]')).not.toBeNull();
      else expect(q(container, '[data-gave-keys]')!.textContent).toBe(says);
      cleanup();
    }
  });

  /* RED WHEN: a vault is created without the "Confirm in your account" step in front of it, or when that step is cancelled; or what it came to is not said, or the page is not told something changed. */
  it('asks to confirm in the account, then creates, says where it got to and what it came to', async () => {
    const onChanged = vi.fn();
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={onChanged} />, sessionWith({ company: 'c-1' }));
    await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
    expect(state.acted).toEqual([]);
    expect(q(container, '[data-slot=confirm-in-your-account]')!.textContent).toContain(EN['createVault.confirm']);
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.cancel'])!); await settle(); });
    expect(state.acted).toEqual([]);
    await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect(state.acted).toEqual([JSON.stringify(['create-vault', 'u1', 'c-1'])]);
    expect(q(container, '[data-created]')!.textContent).toBe(EN['createVault.done']);
    expect(onChanged).toHaveBeenCalled();
    for (const [result, key] of [[{ of: 'handover-owed', vault: 'v-3' }, 'createVault.owed.now'], [{ of: 'handover-owed-elsewhere', vault: 'v-3' }, 'createVault.owed.elsewhere'], [{ of: 'handover-owed-roster-disagrees', vault: 'v-3' }, 'createVault.owed.rosterDisagrees']] as const) {
      state.vaultCreated = result;
      await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
      await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
      expect(q(container, '[data-result]')!.textContent).toBe(EN[key]);
    }
    state.vaultCreated = { of: 'refused', why: 'nothing-sent' };
    await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect(q(container, '[data-refusal]')!.textContent).toContain(EN['act.refused.nothingSent']);
  });

  /* RED WHEN: a vault sent and not handed over is not named, with its number, or finishing it sends another vault rather than handing that one over; or Finish is offered on a device that does not hold the vault's key, or hidden there rather than disabled with why. */
  it('names a vault not handed over yet, and finishes handing that one over', async () => {
    state.owed = [{ vault: 'v-2', number: 2, here: true }, { vault: 'v-9', number: 3, here: false }];
    const elsewhere = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    const notHere = q(elsewhere.container, '[data-owed=v-9]')!;
    expect((q(notHere, '[data-action=finish-handover]') as HTMLButtonElement).disabled).toBe(true);
    expect(notHere.textContent).toContain(EN['createVault.owed.notHere']);
    cleanup();
    state.owed = [{ vault: 'v-2', number: 2, here: true }];
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    expect(q(container, '[data-owed=v-2]')!.textContent).toContain(EN['createVault.owed.title']!.replace('{number}', '2'));
    await act(async () => { fireEvent.click(q(container, '[data-action=finish-handover]')!); await settle(); });
    expect(q(container, '[data-slot=confirm-in-your-account]')!.textContent).toContain(EN['createVault.confirmFinish']);
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect(state.acted).toEqual([JSON.stringify(['finish-vault', 'u1', 'c-1', 'v-2'])]);
  });
});

describe('creating the company', () => {
  /* RED WHEN: Create is enabled with no name or says no reason; the first signer's name or the company's name is not what is handed to the adapter; or the new company is not asked for again and shown. */
  it('creates with the name typed and the person as its first signer, then shows the new company', async () => {
    const companiesChanged = vi.fn(async () => {});
    const { container } = await draw(<CreateCompany leadTo={() => {}} onChanged={() => {}} />, sessionWith({ companiesChanged }));
    expect((q(container, '[data-action=create]') as HTMLButtonElement).disabled).toBe(true);
    expect(q(container, '[data-why-disabled]')!.textContent).toBe(EN['setup.createCompany.nameFirst']);
    fireEvent.change(container.querySelector('input')!, { target: { value: ' Acme ' } });
    await act(async () => { fireEvent.click(q(container, '[data-action=create]')!); await settle(); });
    expect(state.acted).toEqual([JSON.stringify(['create', 'u1', { name: 'Acme', firstSigner: 'Priya' }])]);
    expect(companiesChanged).toHaveBeenCalledWith('c-new');
    expect(q(container, '[data-created]')!.getAttribute('data-created')).toBe('c-new');
  });

  /* RED WHEN: a person whose account gives no name is sent to the service with none, which the service refuses. */
  it('names a person with no name by the language file\'s word', async () => {
    const { container } = await draw(<CreateCompany leadTo={() => {}} onChanged={() => {}} />, sessionWith({ person: { id: 'u1', name: '' } }));
    fireEvent.change(container.querySelector('input')!, { target: { value: 'Acme' } });
    await act(async () => { fireEvent.click(q(container, '[data-action=create]')!); await settle(); });
    expect(state.acted).toEqual([JSON.stringify(['create', 'u1', { name: 'Acme', firstSigner: EN['setup.createCompany.you'] }])]);
  });

  /* RED WHEN: a company created whose keys are not saved lets another be started, or offers no Finish. */
  it('with a company waiting to be finished, offers Finish and starts nothing else', async () => {
    state.waiting = 'c-half';
    const { container } = await draw(<CreateCompany leadTo={() => {}} onChanged={() => {}} />, sessionWith());
    fireEvent.change(container.querySelector('input')!, { target: { value: 'Acme' } });
    expect((q(container, '[data-action=create]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(q(container, '[data-action=finish-company]')!); await settle(); });
    expect(state.acted).toEqual(['finish']);
  });

  /* RED WHEN: a refusal is not shown, or is shown in words that are not the language file's. */
  it('says why it did not happen', async () => {
    state.created = { of: 'refused', why: 'sign-in-again', waiting: null };
    const { container } = await draw(<CreateCompany leadTo={() => {}} onChanged={() => {}} />, sessionWith());
    fireEvent.change(container.querySelector('input')!, { target: { value: 'Acme' } });
    await act(async () => { fireEvent.click(q(container, '[data-action=create]')!); await settle(); });
    expect(q(container, '[data-refusal]')!.getAttribute('data-refusal')).toBe('sign-in-again');
    expect(q(container, '[data-refusal]')!.textContent).toContain(EN['act.refused.signInAgain']);
  });
});
