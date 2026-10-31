// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { CurrentPageProvider } from '../router.js';
import { PanelProvider } from '../shell/right-panel.js';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { SessionProvider, type Session } from '../session.js';
import { VIEWS } from '../pages.js';
import { untilPageShown } from '../page-shown.test-support.js';

/*
 * THE SETUP WIZARD AND ITS BUILT STEPS, DRAWN, with the adapters that act
 * and read stood in for, so what each step shows and when it acts is read
 * from the screen.
 */
const state = vi.hoisted(() => ({
  handover: { of: 'held-by-other-keys' } as Record<string, unknown>,
  acted: [] as string[],
  gaveKeys: { of: 'done' } as unknown,
  created: { of: 'done', companyId: 'c-new', label: 'co_drawn' } as Record<string, unknown>,
  /** What each look at the company comes to, one per look; the last stays. The wallet press and starting again from the finishing step come to what these say. */
  carried: [{ of: 'waiting', companyId: 'c-1', stage: 'deploy' }] as Record<string, unknown>[],
  looks: 0,
  /** Held back while a look is not resolved, so a test can leave the step while a look is under way. */
  carryGate: null as Promise<void> | null,
  /** What a look at one company comes to, held while its `gate` is not resolved; a company not in it comes to what `carried` says. */
  carriedBy: {} as Record<string, { gate?: Promise<void>; result: Record<string, unknown> }>,
  pressed: { of: 'done' } as Record<string, unknown>,
  startedAgainHere: { of: 'done' } as Record<string, unknown>,
  /** The company's vaults as the service lists them, and whether one can be created, and what creating one comes to. */
  vaults: [] as { vault: string; createdAt: string; standing: string }[] | null,
  ready: { of: 'ready' } as Record<string, unknown>,
  vaultCreated: { of: 'done', vault: 'v-new' } as Record<string, unknown>,
  /** The name the company filed for the vault being carried on, as this device reads it; null when none was filed. */
  vaultName: 'Payroll' as string | null,
  opened: [] as string[],
  /** What the creation read says of the shown company, whichever company is asked about; held back while `gate` is not resolved. */
  creation: { standing: 'finished', awaitingSecondPress: false, kept: false, confirmedFinished: true, mark: null } as Record<string, unknown>,
  gate: null as Promise<void> | null,
  /** Held back while the company's vaults are not yet read, though its creation is. */
  vaultsGate: null as Promise<void> | null,
  /** Run when a company is created, so the creation read afterwards says what a creation leaves. */
  onCreate: null as (() => void) | null,
  changed: [] as (string | null)[],
  /** The label the keyring holds for the creation this tab keeps; null when it keeps none. */
  label: null as string | null,
  /** The company's records as the one read of them gives them, to the provider the shell holds above every page. */
  records: null as unknown,
  /** How many times the vaults were read, so a test can tell the wizard read again after a step told it something changed. */
  vaultReads: 0,
  /** How many times anything asked the company's records to be read again. */
  reloads: 0,
  /** What signing a change of the super admins comes to. */
  signedChange: { of: 'done' } as Record<string, unknown>,
  /** The invitations the page sent to the wallet, and what sending one comes to. */
  sent: [] as unknown[],
  invited: { of: 'done', link: 'https://example.test/join/inv_1#token', already: false } as Record<string, unknown>,
  /** What the service then lists for the company, as the one read of its records says it, once an invitation is filed. */
  afterInvite: null as unknown,
}));
vi.mock('../adapters/creation-standing.js', async (real) => ({
  ...(await real<typeof import('../adapters/creation-standing.js')>()),
  creationOf: vi.fn(async (company: string | null) => {
    if (state.gate !== null) await state.gate;
    /* With no company shown there is no creation to read: each kept creation is read by its own company. */
    if (company === null) return { company: null, standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null };
    return { company, ...state.creation };
  }),
  creationHere: vi.fn((company: string | null) => ({
    company, ...(company === null ? { kept: false, awaitingSecondPress: false } : { kept: state.creation.kept === true, awaitingSecondPress: state.creation.awaitingSecondPress === true }),
    standing: null, confirmedFinished: false, mark: null,
  })),
  creationChanged: vi.fn((company: string | null) => { state.changed.push(company); }),
  keptCreationLabel: () => state.label,
}));
vi.mock('../adapters/vault-rows.js', async (real) => ({
  ...(await real<typeof import('../adapters/vault-rows.js')>()),
  readVaultRows: vi.fn(async () => { state.vaultReads += 1; if (state.vaultsGate !== null) await state.vaultsGate; return state.vaults; }),
}));
vi.mock('../adapters/committee-change.js', () => ({
  signChange: vi.fn(async (...args: unknown[]) => { state.acted.push(JSON.stringify(['sign-change', ...args])); return state.signedChange; }),
}));
vi.mock('../adapters/invite.js', async (real) => ({
  ...(await real<typeof import('../adapters/invite.js')>()),
  sendInvite: vi.fn(async (...args: unknown[]) => {
    state.sent.push(args[2]);
    if (state.invited.of === 'done' && state.afterInvite !== null) state.records = state.afterInvite;
    return state.invited;
  }),
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  companyNamesFor: async () => new Map(),
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readVaultName: vi.fn(async (_p: string, _c: string, _v: string, unread?: unknown) => (state.vaultName === 'unread' ? unread ?? null : state.vaultName)),
  readCompany: vi.fn(async () => state.records),
}));
vi.mock('../adapters/create-vault.js', async (real) => ({
  ...(await real<typeof import('../adapters/create-vault.js')>()),
  readVaultReadiness: vi.fn(async () => state.ready),
  openYourKeys: vi.fn(async (person: string) => { state.opened.push(person); state.ready = { of: 'ready' }; return { of: 'done' }; }),
  createVault: vi.fn(async (person: string, company: string, onStage: (s: string) => void) => {
    onStage('building');
    state.acted.push(JSON.stringify(['create-vault', person, company]));
    return state.vaultCreated;
  }),
  finishStarting: vi.fn(async (person: string, company: string, vault: string, _stage: unknown, info?: unknown) => {
    state.acted.push(JSON.stringify(['finish-vault', person, company, vault, ...(info === undefined ? [] : [info])]));
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
vi.mock('../adapters/create-company.js', () => ({
  createCompany: vi.fn(async (...args: unknown[]) => { state.acted.push(JSON.stringify(['create', ...args])); state.onCreate?.(); return state.created; }),
}));
vi.mock('../adapters/start-again.js', () => ({
  startAgain: vi.fn(async (...args: unknown[]) => { state.acted.push(JSON.stringify(['start-again-here', ...args])); return state.startedAgainHere; }),
  AGAIN: { landed: 'landed', wait: 'wait', unsure: 'unsure' },
}));
vi.mock('../adapters/finish-company.js', () => ({
  carryOn: vi.fn(async (...args: unknown[]) => {
    state.acted.push(JSON.stringify(['carry', ...args]));
    state.looks += 1;
    const own = state.carriedBy[String(args[1])];
    if (own !== undefined) { if (own.gate !== undefined) await own.gate; return own.result; }
    if (state.carryGate !== null) await state.carryGate;
    return state.carried[Math.min(state.looks - 1, state.carried.length - 1)];
  }),
  openYourWallet: vi.fn(async (...args: unknown[]) => { state.acted.push(JSON.stringify(['open-wallet', ...args])); return state.pressed; }),
  FINISH: { waiting: 'waiting', press: 'press', interrupted: 'interrupted', locked: 'locked', cannot: 'cannot', none: 'none' },
  STAGE: { deploy: 'deploy', finish: 'finish', key: 'key', shown: 'shown', read: 'read' },
  CARRY_ON_EVERY_MS: 10_000,
}));

const { Setup } = await import('../screens/setup.js');
const { CreateCompany } = await import('../actions/create-company.js');
const { FinishCompany } = await import('../actions/finish-company.js');
const { forgetWhatStartAgainSaid } = await import('../actions/start-again.js');
const { CreateVault } = await import('../actions/create-vault.js');
const { EVERY_STEP, isBuiltStep, startSetupAt, takeAsked } = await import('./steps.js');
const { isDoneForGood, skippedFor, useCreationFact } = await import('./standing.js');
const { HANDOVER } = await import('../adapters/handover-state.js');
const { STEP } = await import('./step-ids.js');
const recordsModule = await import('../records/company-records.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../locales/en.json'), 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const settle = () => new Promise((r) => setTimeout(r, 0));

function sessionWith(over: Partial<Session> = {}): Session {
  return {
    person: { id: 'u1', name: 'Priya' }, companies: [], company: null, chooseCompany: vi.fn(),
    viewer: { signedIn: true, view: VIEWS.company, signs: true }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
    choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}), ...over,
  };
}

const framed = (node: React.ReactNode, session: Session) => (
  <KitProvider languages={LANGUAGES} pick="en">
    <SessionProvider session={session}><PanelProvider><CurrentPageProvider id="setup">{node}</CurrentPageProvider></PanelProvider></SessionProvider>
  </KitProvider>
);
/** A person who signs for the company shown, which they look at from the company's side, where its records are read. The wizard is drawn with no provider of the records above it, as the focused frame draws it, and brings its own. */
const SIGNER_ADDRESS = 'mn_shield-addr_stagenet1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyq4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kkcvfvr0u';
const signing = (over: Partial<Session> = {}): Session => sessionWith({ company: 'c-1', ...over });
/** The company's records, opened, with nobody waiting and nobody invited. */
const openRecords = (over: Record<string, unknown> = {}) => ({
  of: 'open', id: 'c-1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }], approvalsNeeded: { of: 'read', value: 1 },
  proposals: { of: 'read', value: [] }, runs: { of: 'read', value: [] }, people: { of: 'read', value: [] }, vaults: { of: 'read', value: [] },
  invitations: { of: 'read', value: [] },
  approvalsForSigners: { of: 'unreadable' }, signerStandings: { of: 'read', value: [] }, signersInvited: { of: 'read', value: [] },
  ...over,
});
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
/** The vault's name typed in, as Create a vault needs before it can be pressed. */
const nameIt = async (c: HTMLElement, text = 'Payroll UK') => {
  await act(async () => { fireEvent.change(q(c, '[data-field=vault-name]')!, { target: { value: text } }); await settle(); });
};
/* The kit's tabs are chosen on mouse-down, as the browser sends it, not on click, so a test presses a tab that way. */
const pick = async (c: HTMLElement, step: string) => { await act(async () => { fireEvent.mouseDown(q(c, `[data-setup-steps] [data-step=${step}]`)!, { button: 0 }); await settle(); }); };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.handover = { of: 'held-by-other-keys' }; state.acted = []; state.gaveKeys = { of: 'done' }; state.created = { of: 'done', companyId: 'c-new', label: 'co_drawn' };
  state.carried = [{ of: 'waiting', companyId: 'c-1', stage: 'deploy' }]; state.looks = 0; state.carryGate = null; state.carriedBy = {};
  state.pressed = { of: 'done' }; state.startedAgainHere = { of: 'done' };
  forgetWhatStartAgainSaid();
  state.vaults = []; state.ready = { of: 'ready' }; state.vaultCreated = { of: 'done', vault: 'v-new' }; state.opened = []; state.vaultName = 'Payroll';
  state.creation = { standing: 'finished', awaitingSecondPress: false, kept: false, confirmedFinished: true, mark: null }; state.gate = null; state.vaultsGate = null; state.changed = []; state.onCreate = null; state.label = null;
  state.records = openRecords(); state.vaultReads = 0; state.reloads = 0; state.signedChange = { of: 'done' };
  state.sent = []; state.invited = { of: 'done', link: 'https://example.test/join/inv_1#token', already: false }; state.afterInvite = null;
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

  /* RED WHEN: a step not built is shown without Coming soon and its line, a built step does not show its own component, or a built step with a part not built shows that part as the whole step. */
  it('shows a built step\'s component, with the part of it not built Coming soon, and a step not built Coming soon', async () => {
    const { container } = await drawWizard(signing());
    for (const s of EVERY_STEP.filter((x) => !x.cannotBeUndone || x.id === STEP.vault)) {
      await pick(container, s.id);
      expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(s.id);
      if (isBuiltStep(s)) {
        expect(q(container, '[data-current-step] [data-action]'), s.id).not.toBeNull();
        expect(q(container, '[data-coming-soon-step]'), s.id).toBeNull();
      } else {
        expect(q(container, '[data-current-step] [data-slot=coming-soon]'), s.id).not.toBeNull();
        expect(q(container, '[data-coming-soon-step]')!.textContent, s.id).toBe(EN[`setup.step.${s.id}.soon`]);
      }
    }
  });

  /*
   * RED WHEN: the signers step does not draw the signers component and the committee change, once each, or is Coming
   * soon as a whole; or it does not say that choosing how many must approve is Coming soon, in the words kept for it;
   * or it says so for a step that is held back.
   */
  it('draws the signers and the committee change in the signers step, with choosing how many must approve Coming soon', async () => {
    const { container } = await drawWizard(signing());
    await pick(container, STEP.signers);
    const step = q(container, '[data-current-step]')!;
    expect(step.getAttribute('data-current-step')).toBe(STEP.signers);
    expect(step.querySelectorAll('[data-action=signers]')).toHaveLength(1);
    expect(step.querySelectorAll('[data-action=committee-change]')).toHaveLength(1);
    expect(q(container, '[data-coming-soon-step]')).toBeNull();
    expect(q(container, '[data-also-soon]')!.textContent).toBe(EN['setup.step.signers.soon']);
    expect(EN['setup.step.signers.soon']).toMatch(/how many of the signers must approve/i);
    expect(EN['setup.step.signers.soon']).not.toMatch(/invite/i);
    expect(q(step, '[data-slot=coming-soon]')).not.toBeNull();
  });

  /* RED WHEN: a press in the signers step that changes who holds the company is not told to the wizard, which then reads the company again. */
  it('reads the company again when the committee change is signed inside the signers step', async () => {
    state.handover = { of: 'change-owed', signed: [{ have: 1, required: 2 }] };
    const { container } = await drawWizard(signing());
    await pick(container, STEP.signers);
    const before = state.vaultReads;
    await act(async () => { fireEvent.click(q(container, '[data-action=sign-change]')!); await settle(); });
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect(state.acted).toContain(JSON.stringify(['sign-change', 'u1', 'c-1']));
    expect(state.vaultReads).toBeGreaterThan(before);
  });

  /*
   * RED WHEN: one act in the signers step, an invitation sent for a signer or the committee change signed, asks for
   * the company's records to be read again more than once, or not at all, so the same read is asked for two or three times, or the step goes on
   * showing what it read before.
   */
  it.each([
    ['an invitation sent for a signer', async (c: HTMLElement) => {
      await act(async () => { fireEvent.change(q(c, '[data-field=name]')!, { target: { value: 'Zed' } }); await settle(); });
      await act(async () => { fireEvent.change(q(c, '[data-field=address]')!, { target: { value: SIGNER_ADDRESS } }); await settle(); });
      await act(async () => { fireEvent.click(q(c, '[data-action=send-invite]')!); await settle(); });
      expect(state.sent).toHaveLength(1);
    }],
    ['the committee change signed', async (c: HTMLElement) => {
      await act(async () => { fireEvent.click(q(c, '[data-action=sign-change]')!); await settle(); });
      await act(async () => { fireEvent.click([...c.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
      expect(state.acted).toContain(JSON.stringify(['sign-change', 'u1', 'c-1']));
    }],
  ])('asks for the company\'s records to be read once for one act in the signers step: %s', async (_name, act1) => {
    state.handover = { of: 'change-owed', signed: [{ have: 1, required: 2 }] };
    const original = recordsModule.useCompanyRecords;
    const counting = vi.spyOn(recordsModule, 'useCompanyRecords').mockImplementation(() => {
      const records = original();
      return useMemo(() => ({ ...records, reload: () => { state.reloads += 1; records.reload(); } }), [records]);
    });
    try {
      const { container } = await drawWizard(signing());
      await pick(container, STEP.signers);
      state.reloads = 0;
      await act1(container);
      await untilPageShown(container);
      expect(state.reloads).toBe(1);
    } finally { counting.mockRestore(); }
  });

  /* RED WHEN: creating the company is not drawn with its own component before there is a company, or finishing it is not drawn with its own component for a company that is not finished. */
  it('shows creating the company with its component, and finishing it with its own, for a company that is not finished', async () => {
    state.creation = { standing: 'pay-key-owed', awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: 'not-finished' };
    const none = await drawWizard(sessionWith());
    expect(q(none.container, '[data-current-step] [data-action=create-company]')).not.toBeNull();
    cleanup();
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.finishCompany);
    expect(q(container, '[data-current-step] h1')!.textContent).toBe('Finish creating the company');
    expect(q(container, '[data-coming-soon-step]')).toBeNull();
    expect(q(container, '[data-current-step] [data-action=finish-company]')).not.toBeNull();
    expect(state.acted).toContain(JSON.stringify(['carry', 'u1', 'c-1']));
  });
});

describe('starting a new company from a step', () => {
  /* RED WHEN: a company that cannot be finished leaves the person on it when they ask for a new company, or the wizard still treats the company shown as the one being set up. */
  it('puts the wizard at creating a new company, with no company shown, when a step asks for one', async () => {
    state.creation = { standing: 'not-created', awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null };
    state.carried = [{ of: 'cannot', companyId: 'c-1' }];
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    await pick(container, STEP.signers);
    await pick(container, STEP.finishCompany);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.finishCompany);
    await act(async () => { fireEvent.click(q(container, '[data-action=new-company]')!); await settle(); });
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.createCompany);
    expect(q(container, '[data-current-step] [data-action=create-company]')).not.toBeNull();
  });
});

describe('moving between steps', () => {
  /* RED WHEN: a button that leads to another step does not take the wizard there. */
  it('follows a step\'s lead to the step that fixes it', async () => {
    state.creation = { ...state.creation, standing: 'pay-key-owed', confirmedFinished: false, mark: 'not-finished' };
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    await pick(container, STEP.vault);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.vault);
    await act(async () => { fireEvent.click(q(container, `[data-current-step] [data-lead-to=${STEP.finishCompany}]`)!); await settle(); });
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.finishCompany);
  });
});

describe('a step held back until the company is finished', () => {
  const unfinished = { standing: 'pay-key-owed', awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: 'not-finished' };

  /*
   * RED WHEN: a step after finishing the company, while it is not done, shows
   * its own action, has a tab that cannot be pressed (rather than one marked
   * unavailable), gives no reason, or leads nowhere; or a step up to and
   * including finishing the company is held back.
   */
  it('keeps the tab of a held back step pressable and marked unavailable, and its panel gives the reason and the way to finish', async () => {
    state.creation = unfinished;
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    const tab = (id: string) => q(container, `[data-setup-steps] [data-step=${id}]`) as HTMLButtonElement;
    for (const id of [STEP.createCompany, STEP.finishCompany]) expect(tab(id).getAttribute('aria-disabled'), id).toBeNull();
    for (const id of [STEP.signers, STEP.vault, STEP.people]) {
      expect(tab(id).disabled, id).toBe(false);
      expect(tab(id).getAttribute('aria-disabled'), id).toBe('true');
      await pick(container, id);
      expect(q(container, '[data-current-step]')!.getAttribute('data-current-step'), id).toBe(id);
      const blocked = q(container, '[data-step-blocked]')!;
      expect(blocked.getAttribute('data-step-blocked'), id).toBe(STEP.finishCompany);
      expect(blocked.textContent, id).toContain(EN['setup.blocked']!.replace('{step}', 'Finish creating the company'));
      expect(q(container, '[data-current-step] [data-action]:not([data-lead-to])'), id).toBeNull();
      expect(q(container, `[data-current-step] [data-lead-to=${STEP.finishCompany}]`)!.textContent, id).toBe(EN['setup.blocked.go']!.replace('{step}', 'Finish creating the company'));
    }
    await pick(container, STEP.signers);
    expect(q(container, '[data-coming-soon-step]'), 'a step not built shows the reason, not Coming soon').toBeNull();
    expect(q(container, '[data-also-soon]'), 'nor the part of it not built').toBeNull();
    expect(q(container, '[data-current-step] [data-slot=coming-soon]'), 'nor the Coming soon mark').toBeNull();
  });

  /* RED WHEN: a finished company still holds a later step back. */
  it('holds nothing back once the company is finished', async () => {
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    for (const id of [STEP.signers, STEP.vault, STEP.people]) {
      expect(q(container, `[data-setup-steps] [data-step=${id}]`)!.getAttribute('aria-disabled'), id).toBeNull();
      await pick(container, id);
      expect(q(container, '[data-step-blocked]'), id).toBeNull();
    }
  });

  /* RED WHEN: the reasons sit beside the buttons in a narrow box rather than above them at full width, or the footer's words share a row with them. */
  it('lays the footer out as words, then the reasons, then the buttons, with no fixed width', async () => {
    state.creation = unfinished;
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    const bar = q(container, '[data-setup-bar]')!;
    const order = [...bar.children].map((e) => (e.hasAttribute('data-progress-words') ? 'words' : e.hasAttribute('data-why-bar') ? 'reasons' : e.querySelector('[data-action=skip]') ? 'buttons' : 'other'));
    expect(order.filter((o) => o !== 'other')).toEqual(['words', 'reasons', 'buttons']);
    expect(bar.querySelector('[data-why-bar]')!.querySelectorAll('[data-why-disabled]')).toHaveLength(2);
    expect(bar.innerHTML).not.toMatch(/max-w-/);
  });

  /* RED WHEN: Skip or Continue is disabled with no reason beside it, with another step's reason, or is enabled when it should not be. */
  it('shows beside a disabled Skip or Continue the reason it is disabled', async () => {
    state.creation = unfinished;
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    const skip = () => q(container, '[data-action=skip]') as HTMLButtonElement;
    const go = () => q(container, '[data-action=continue]') as HTMLButtonElement;
    const why = (which: string) => q(container, `[data-setup-bar] [data-why-disabled~=${which}]`)?.textContent ?? null;
    /* Finishing the company: it cannot be skipped, and it is not done. */
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.finishCompany);
    expect(skip().disabled).toBe(true);
    expect(why('skip')).toBe(EN['setup.skip.cannot']);
    expect(go().disabled).toBe(true);
    expect(why('continue')).toBe(EN['setup.continue.notDone']);
    expect(skip().getAttribute('aria-describedby')).toBe(q(container, '[data-why-disabled~=skip]')!.id);
    expect(go().getAttribute('aria-describedby')).toBe(q(container, '[data-why-disabled~=continue]')!.id);
    /* A step held back: both say what it waits for. */
    await pick(container, STEP.signers);
    expect(skip().disabled).toBe(true);
    expect(go().disabled).toBe(true);
    const waits = EN['setup.blocked']!.replace('{step}', 'Finish creating the company');
    expect(why('skip')).toBe(waits);
    expect(why('continue')).toBe(waits);
    /* RED WHEN: the same reason is printed twice, once for each button, or one button is not tied to the line. */
    expect(container.querySelectorAll('[data-setup-bar] [data-why-disabled]')).toHaveLength(1);
    expect(skip().getAttribute('aria-describedby')).toBe(q(container, '[data-setup-bar] [data-why-disabled]')!.id);
    expect(go().getAttribute('aria-describedby')).toBe(q(container, '[data-setup-bar] [data-why-disabled]')!.id);
    /* Creating the company, done and so closed, is not shown; a step that can be skipped has no reason and is enabled. */
    cleanup();
    state.creation = { ...unfinished, standing: 'finished', confirmedFinished: true, mark: null };
    const again = await drawWizard(sessionWith({ company: 'c-1' }));
    expect((q(again.container, '[data-action=skip]') as HTMLButtonElement).disabled).toBe(false);
    expect(q(again.container, '[data-why-disabled~=skip]')).toBeNull();
    expect(q(again.container, '[data-why-disabled~=continue]')!.textContent).toBe(EN['setup.continue.notDone']);
  });

  /* RED WHEN: Continue is disabled with no reason on the last step once it is done. */
  it('says on the last step, once it is done, that there is none after it', async () => {
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    vi.spyOn(EVERY_STEP.find((s) => s.id === STEP.people)!, 'done').mockReturnValue(true);
    await pick(container, STEP.people);
    expect((q(container, '[data-action=continue]') as HTMLButtonElement).disabled).toBe(true);
    expect(q(container, '[data-why-disabled~=continue]')!.textContent).toBe(EN['setup.continue.last']);
  });

  /* RED WHEN: Skip is disabled with no reason on a step that is done and closed. */
  it('says on a step that is done and closed that it is already done', async () => {
    const people = EVERY_STEP.find((s) => s.id === STEP.people)! as { cannotBeUndone: boolean };
    const kept = people.cannotBeUndone;
    people.cannotBeUndone = true;
    vi.spyOn(EVERY_STEP.find((s) => s.id === STEP.people)!, 'done').mockReturnValue(true);
    try {
      startSetupAt(STEP.people);
      const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
      expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.people);
      expect((q(container, '[data-action=skip]') as HTMLButtonElement).disabled).toBe(true);
      expect(q(container, '[data-why-disabled~=skip]')!.textContent).toBe(EN['setup.skip.done']);
    } finally {
      people.cannotBeUndone = kept;
    }
  });

  /* RED WHEN: Skip on a step that cannot be skipped records a skip, so the step is shown skipped. */
  it('refuses to skip finishing the company', async () => {
    state.creation = unfinished;
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    await act(async () => { fireEvent.click(q(container, '[data-action=skip]')!); await settle(); });
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.finishCompany);
    expect([...skippedFor('c-1')]).toEqual([]);
    expect(q(container, `[data-setup-steps] [data-step=${STEP.finishCompany}]`)!.getAttribute('data-standing')).toBe('open');
  });
});

describe('the wizard chooses where to open when what it needs arrives', () => {
  /*
   * RED WHEN: the wizard opens at a step chosen from nothing (before the
   * company's creation is read) and stays there, so a step the person already
   * skipped, or one done, is opened first.
   */
  it('opens again at the first step neither done nor skipped once the creation is read', async () => {
    skippedFor('c-1').add(STEP.signers);
    let release!: () => void;
    state.gate = new Promise<void>((r) => { release = r; });
    const { container } = render(framed(<Setup />, sessionWith({ company: 'c-1' })));
    await act(settle);
    expect(q(container, '[data-screen=setup]')!.hasAttribute('data-reading')).toBe(true);
    await act(async () => { release(); await settle(); });
    await untilPageShown(container);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.vault);
  });

  /* RED WHEN: a step the person chose while the wizard was reading is left for the step the facts would open at. */
  it('leaves a step the person chose while it was reading', async () => {
    let release!: () => void;
    state.gate = new Promise<void>((r) => { release = r; });
    const { container } = render(framed(<Setup />, sessionWith({ company: 'c-1' })));
    await act(settle);
    await pick(container, STEP.people);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.people);
    await act(async () => { release(); await settle(); });
    await untilPageShown(container);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.people);
  });

  /* RED WHEN: a step asked for by name is left for the step the facts would open at. */
  it('leaves a step asked for by name', async () => {
    let release!: () => void;
    state.gate = new Promise<void>((r) => { release = r; });
    startSetupAt(STEP.people);
    const { container } = render(framed(<Setup />, sessionWith({ company: 'c-1' })));
    await act(async () => { release(); await settle(); });
    await untilPageShown(container);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.people);
  });

  /* RED WHEN: another company is shown while its creation is read, and the wizard takes the company before it for it. */
  it('does not take one company\'s creation for another\'s while it is read', async () => {
    const view = render(framed(<Setup />, sessionWith({ company: 'c-1' })));
    await untilPageShown(view.container);
    let release!: () => void;
    state.gate = new Promise<void>((r) => { release = r; });
    view.rerender(framed(<Setup />, sessionWith({ company: 'c-2' })));
    await act(settle);
    expect(q(view.container, '[data-screen=setup]')!.hasAttribute('data-reading')).toBe(true);
    await act(async () => { release(); await settle(); });
    await untilPageShown(view.container);
  });

  /* RED WHEN: a step that changed the company leaves the old reading of its creation in place, so the wizard goes on showing where the company stood. */
  it('puts away the old reading of the creation after a step changed the company, and reads it again', async () => {
    const { container } = await drawWizard(sessionWith());
    const { creationOf } = await import('../adapters/creation-standing.js');
    const before = vi.mocked(creationOf).mock.calls.length;
    expect(state.changed).toEqual([]);
    fireEvent.change(container.querySelector('[data-action=create-company] input')!, { target: { value: 'Acme' } });
    await act(async () => { fireEvent.click(q(container, '[data-action=create]')!); await settle(); });
    /* The reading put away is the company just created: each creation is read by its own company. */
    expect(state.changed).toEqual(['c-new']);
    expect(vi.mocked(creationOf).mock.calls.length).toBeGreaterThan(before);
  });
});

describe('a step that cannot be undone', () => {
  /* RED WHEN: a step whose action cannot be undone is not marked so in the list, or one that can be undone is. */
  it('is marked so in the one list, step by step', () => {
    expect(EVERY_STEP.filter((s) => s.cannotBeUndone).map((s) => s.id)).toEqual([STEP.createCompany, STEP.finishCompany, STEP.vault]);
  });

  /*
   * RED WHEN: after the company is created the wizard stays on Create the
   * company, or does not move on to finishing it, or its tab does not say
   * done, can be pressed, or shows the form again, blank.
   */
  it('moves on by itself once the company is created, and never reopens it blank', async () => {
    state.creation = { standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null };
    state.onCreate = () => { state.label = 'co_drawn'; state.creation = { standing: 'not-created', awaitingSecondPress: true, kept: true, confirmedFinished: false, mark: 'not-finished' }; };
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
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.finishCompany);
    /* RED WHEN: the page moves on to finishing the company at once and the label the wallet drew is never on screen. */
    expect(q(container, '[data-drawn-label]')!.textContent).toBe(EN['setup.finishCompany.named']!.replace('{label}', 'co_drawn'));
    const tab = q(container, `[data-setup-steps] [data-step=${STEP.createCompany}]`) as HTMLButtonElement;
    expect(tab.getAttribute('data-standing')).toBe('done');
    expect(tab.hasAttribute('data-done-for-good')).toBe(true);
    expect(tab.querySelector('[data-done]')!.textContent).toBe(EN['setup.done']);
    expect(tab.disabled).toBe(true);
    await pick(container, STEP.createCompany);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.finishCompany);
    expect(q(container, '[data-action=create-company]')).toBeNull();
  });

  /*
   * RED WHEN: after Create succeeds the wizard stays on creating the company
   * until the network's read of the new company comes back, so the person has
   * to press to reach finishing it; or it moves them off a step they chose
   * themselves afterwards.
   */
  it('moves to finishing the company as soon as it is started, with no press, and leaves a later choice alone', async () => {
    state.creation = { standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null };
    let release!: () => void;
    state.onCreate = () => {
      state.label = 'co_drawn';
      state.creation = { standing: 'not-created', awaitingSecondPress: true, kept: true, confirmedFinished: false, mark: 'not-finished' };
      state.gate = new Promise<void>((r) => { release = r; });
    };
    const { container } = await drawWizard(sessionWith());
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.createCompany);
    fireEvent.change(container.querySelector('[data-action=create-company] input')!, { target: { value: 'Acme' } });
    await act(async () => { fireEvent.click(q(container, '[data-action=create]')!); await settle(); });
    /* The network's read is still out: nothing but this tab's own keeping says the company was started. */
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.finishCompany);
    expect(q(container, '[data-drawn-label]')!.textContent).toBe(EN['setup.finishCompany.named']!.replace('{label}', 'co_drawn'));
    await act(async () => { release(); await settle(); });
    await untilPageShown(container);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.finishCompany);
    await pick(container, STEP.people);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.people);
  });

  /* RED WHEN: reading a company's creation again takes back what the network already said, so a finished company shows unfinished while the new reading is out. */
  it('keeps what the network said of a company while its creation is read again', async () => {
    function Probe() {
      const { creation, reread } = useCreationFact('c-1');
      return <button data-probe={String(creation?.confirmedFinished)} onClick={() => { void reread(); }} />;
    }
    const { container } = render(framed(<Probe />, sessionWith({ company: 'c-1' })));
    await act(settle);
    expect(q(container, '[data-probe]')!.getAttribute('data-probe')).toBe('true');
    let release!: () => void;
    state.gate = new Promise<void>((r) => { release = r; });
    await act(async () => { fireEvent.click(q(container, '[data-probe]')!); await settle(); });
    expect(q(container, '[data-probe]')!.getAttribute('data-probe')).toBe('true');
    await act(async () => { release(); await settle(); });
    expect(q(container, '[data-probe]')!.getAttribute('data-probe')).toBe('true');
  });

  /* RED WHEN: a creation this tab keeps for some other company closes creating a new company, so a person with a company not finished cannot start another. */
  it('keeps creating a company open while another company is kept, with no company shown: the new one starts at step 1', async () => {
    state.creation = { standing: 'not-created', awaitingSecondPress: true, kept: true, confirmedFinished: false, mark: 'not-finished' };
    const { container } = await drawWizard(sessionWith());
    expect(q(container, `[data-setup-steps] [data-step=${STEP.createCompany}]`)!.getAttribute('data-standing')).toBe('open');
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.createCompany);
    expect(q(container, '[data-action=create-company]')).not.toBeNull();
  });

  /* RED WHEN: finishing the company just created reads another kept company, or asking for a new company from one not finished does not go to step 1, or the new company is not finished by its own id. */
  it('starts a new company from one not finished at step 1, and finishes the new one by its own id', async () => {
    state.creation = { standing: 'not-created', awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null };
    state.carried = [{ of: 'cannot', companyId: 'c-1' }];
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    await pick(container, STEP.signers);
    await pick(container, STEP.finishCompany);
    await act(async () => { fireEvent.click(q(container, '[data-action=new-company]')!); await settle(); });
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.createCompany);
    state.carried = [{ of: 'waiting', companyId: 'c-new', stage: 'deploy' }];
    state.onCreate = () => { state.label = 'co_drawn'; state.creation = { standing: 'not-created', awaitingSecondPress: true, kept: true, confirmedFinished: false, mark: 'not-finished' }; };
    state.acted = [];
    fireEvent.change(container.querySelector('[data-action=create-company] input')!, { target: { value: 'Acme' } });
    await act(async () => { fireEvent.click(q(container, '[data-action=create]')!); await settle(); });
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.finishCompany);
    expect(state.acted).toContain(JSON.stringify(['carry', 'u1', 'c-new']));
    expect(state.acted.filter((a) => a.startsWith('["carry"') && a.includes('"c-1"'))).toEqual([]);
  });

  /* RED WHEN: a step done for good, asked for by name (from the setup card), is opened with its action again rather than the step after it. */
  it('opens the step after one done for good, when that one is asked for', async () => {
    startSetupAt(STEP.createCompany);
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.signers);
    expect(q(container, '[data-action=create-company]')).toBeNull();
  });

  /*
   * RED WHEN: before the company's vaults are read, the vault step's action is
   * drawn or its tab can be pressed, so a company that already has its vault is
   * offered creating one again, even for a moment; or the step is drawn as
   * anything but the kit's section loading while it is read.
   */
  it('offers no step that cannot be undone while the company is still being read', async () => {
    state.vaults = [{ vault: 'v-1', createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee' }];
    let release!: () => void;
    state.vaultsGate = new Promise<void>((r) => { release = r; });
    startSetupAt(STEP.vault);
    const { container } = render(framed(<Setup />, sessionWith({ company: 'c-1' })));
    /* The creation is read at once; the vaults are held back, and until they arrive the wizard is still reading. */
    await act(settle);
    expect(q(container, '[data-screen=setup]')!.hasAttribute('data-reading')).toBe(true);
    expect(q(container, '[data-action=create-vault]')).toBeNull();
    /* The step is drawn as the kit's section loading while it is read, not as loose lines. */
    expect(q(container, '[data-step-reading]')!.getAttribute('data-slot')).toBe('section-loading');
    expect(q(container, '[data-step-reading]')!.getAttribute('aria-busy')).toBe('true');
    expect((q(container, `[data-setup-steps] [data-step=${STEP.vault}]`) as HTMLButtonElement).disabled).toBe(true);
    expect((q(container, `[data-setup-steps] [data-step=${STEP.people}]`) as HTMLButtonElement).disabled).toBe(false);
    expect((q(container, '[data-action=skip]') as HTMLButtonElement).disabled).toBe(true);
    expect(q(container, '[data-why-disabled~=skip]')!.textContent).toBe(EN['setup.skip.reading']);
    await act(async () => { release(); await settle(); });
    await untilPageShown(container);
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.people);
    expect(q(container, '[data-action=create-vault]')).toBeNull();
  });

  /* RED WHEN: a skipped step, a step not done, or a step done that can be undone, is closed as if done for good. */
  it('leaves every other step open to return to', async () => {
    const facts = { company: 'c-1', vaults: null, creation: null, invited: false };
    const doneButUndoable = { ...EVERY_STEP.find((s) => s.id === STEP.people)!, done: () => true };
    expect(isDoneForGood(doneButUndoable, facts)).toBe(false);
    expect(isDoneForGood({ ...doneButUndoable, cannotBeUndone: true }, facts)).toBe(true);
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    await act(async () => { fireEvent.click(q(container, '[data-action=skip]')!); await settle(); });
    for (const id of [STEP.signers, STEP.vault, STEP.people]) {
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
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.finishCompany);
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
    expect(q(again.container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.vault);
    window.sessionStorage.setItem('private-vaults.setup-skipped', JSON.stringify({ 'c-1': ['deposit', STEP.vault], '': 'not a list' }));
    expect([...fresh.readSkips(window.sessionStorage).entries()].map(([c, v]) => [c, [...v]])).toEqual([['c-1', [STEP.vault]]]);
  });

  /* RED WHEN: a step done is not counted and marked as done, or Continue is offered on a step that is not done. */
  it('counts and marks a step done only when it is, and offers Continue only then', async () => {
    const { container } = await drawWizard(sessionWith({ company: 'c-1' }));
    expect(q(container, `[data-mark=${STEP.createCompany}]`)!.getAttribute('data-filled')).toBe('true');
    expect(q(container, `[data-mark=${STEP.finishCompany}]`)!.getAttribute('data-filled')).toBe('true');
    expect(q(container, '[data-progress]')!.getAttribute('aria-valuenow')).toBe('2');
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.signers);
    expect((q(container, '[data-action=continue]') as HTMLButtonElement).disabled).toBe(true);
    state.vaults = [{ vault: 'v-1', createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee' }];
    cleanup();
    const again = await drawWizard(sessionWith({ company: 'c-1' }));
    expect(q(again.container, `[data-mark=${STEP.vault}]`)!.getAttribute('data-filled')).toBe('true');
    expect(q(again.container, '[data-progress]')!.getAttribute('aria-valuenow')).toBe('3');
  });
});

describe('creating a vault: one component, on the step and on the Vaults page', () => {
  const HELD = { vault: 'v-1', createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee' };
  const OWED = { vault: 'v-2', createdAt: '2026-09-02T00:00:00.000Z', standing: 'start-owed' };

  /* RED WHEN: once a vault is held by the super admins the vault step can be opened again or does not say done; or a vault sent and not handed over is taken for done. */
  it('closes the vault step once a vault is held by the super admins, and only then', async () => {
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
    expect(q(container, '[data-action=create-vault-now]')!.getAttribute('aria-describedby')).toBe(q(container, '[data-why]')!.id);
    await act(async () => { fireEvent.click(q(container, '[data-action=open-with-your-account]')!); await settle(); });
    expect(state.opened).toEqual(['u1']);
    await nameIt(container);
    expect((q(container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(false);
  });

  /* RED WHEN: with the keys not open, Create a vault cannot be pressed once the vault is named, so creating it costs a
   * window to open the keys first: the action in the wallet reads them itself (the moved action's own button). */
  it('with the keys not open, Create a vault can be pressed once the vault is named, without opening them first', async () => {
    state.ready = { of: 'locked' };
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await nameIt(container);
    expect((q(container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(false);
    expect(q(container, '[data-why]')).toBeNull();
    expect(state.opened).toEqual([]);
  });

  /* RED WHEN: a person whose own vault keys are still to give cannot press Create a vault, though the action gives them first. */
  it('with only your own vault keys still to give, Create a vault can be pressed once the vault is named', async () => {
    state.ready = { of: 'yours-missing' };
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await nameIt(container);
    expect((q(container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(false);
  });

  /* RED WHEN: Create a vault is hidden, enabled, or says no reason while it cannot be used, or does not lead to the step that makes it possible. */
  it('is always shown, and disabled with why and the way on while it cannot be used', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ of: 'yours-missing' }, 'createVault.why.yoursMissing'],
      [{ of: 'others-missing' }, 'createVault.why.othersMissing'],
      [{ of: 'not-on-chain' }, 'createVault.why.notOnChain'],
    ];
    for (const [ready, why] of cases) {
      state.ready = ready;
      const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
      expect((q(container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled, why).toBe(true);
      expect(q(container, '[data-why]')!.textContent, why).toBe(EN[why]);
      expect(q(container, '[data-action=create-vault-now]')!.getAttribute('aria-describedby'), why).toBe(q(container, '[data-why]')!.id);
      /* Giving your vault keys is offered only where they are what is missing. */
      expect(q(container, '[data-action=give-vault-keys]') !== null, why).toBe(why === 'createVault.why.yoursMissing');
      cleanup();
    }
    const leadTo = vi.fn();
    const { container } = await draw(<CreateVault leadTo={leadTo} onChanged={() => {}} />, sessionWith());
    expect((q(container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(true);
    expect(q(container, '[data-why]')!.textContent).toBe(EN['createVault.why.noCompany']);
    expect(q(container, '[data-action=create-vault-now]')!.getAttribute('aria-describedby')).toBe(q(container, '[data-why]')!.id);
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
    for (const [gave, says] of [[{ of: 'done' }, EN['createVault.keysGiven']], [{ of: 'refused', why: 'unreachable' }, null]] as const) {
      state.ready = { of: 'yours-missing' }; state.acted = []; state.gaveKeys = gave;
      const leadTo = vi.fn();
      const onChanged = vi.fn();
      const { container } = await draw(<CreateVault leadTo={leadTo} onChanged={onChanged} />, sessionWith({ company: 'c-1' }));
      expect(q(container, '[data-lead-to]')).toBeNull();
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
    await nameIt(container);
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
    state.vaultCreated = { of: 'refused', why: 'nothing-sent' };
    await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect(q(container, '[data-refusal]')!.textContent).toContain(EN['act.refused.nothingSent']);
  });

  /*
   * RED WHEN: after a vault is created, the page says the company's account is held by its super admins when the read says anything
   * else, or says another read's words (a change owed, unreadable, unreachable, held by other keys), or leaves a change owed without
   * the way to the signers page, or says anything but the one line when the read says held.
   */
  it('says what the read of who holds the company says, and leads to the signers page where a change is owed', async () => {
    const extra: Record<string, Record<string, unknown>> = { [HANDOVER.changeOwed]: { signed: [{ have: 1, required: 2 }] } };
    const words: Record<string, string | null> = {
      [HANDOVER.held]: null,
      [HANDOVER.changeOwed]: 'createVault.held.changeOwed',
      [HANDOVER.heldByOtherKeys]: 'createVault.held.byOtherKeys',
      [HANDOVER.unreadable]: 'createVault.held.unreadable',
      [HANDOVER.notOnChain]: 'createVault.held.unreadable',
      [HANDOVER.unreachable]: 'createVault.held.unreachable',
      [HANDOVER.notSignedIn]: 'createVault.held.unreachable',
      [HANDOVER.anotherPerson]: 'createVault.held.unreachable',
    };
    expect(Object.keys(words).sort()).toEqual(Object.values(HANDOVER).sort());
    for (const of of Object.values(HANDOVER)) {
      state.handover = { of, ...extra[of] };
      const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
      await nameIt(container);
      await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
      await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
      expect(q(container, '[data-created]')!.textContent, of).toBe(EN['createVault.done']);
      const key = words[of];
      const notice = q(container, '[data-held-notice]');
      if (key === null) expect(notice, of).toBeNull();
      else {
        expect(notice!.dataset.heldNotice, of).toBe(of === HANDOVER.notOnChain ? HANDOVER.unreadable : of === HANDOVER.notSignedIn || of === HANDOVER.anotherPerson ? HANDOVER.unreachable : of);
        expect(notice!.textContent, of).toContain(EN[key as string]);
      }
      /* The way to the signers page is offered where a change is owed, and only there. */
      const lead = q(container, '[data-action=go-signers]');
      expect(lead !== null, of).toBe(of === HANDOVER.changeOwed);
      if (lead !== null) {
        await act(async () => { fireEvent.click(lead); await settle(); });
        expect(window.location.pathname).toBe('/settings/signers');
        window.history.pushState(null, '', '/');
      }
      cleanup();
    }
  });

  /* RED WHEN: a press can be made without a name, or without the reason shown beside Create, or the name and description typed are not what is handed to the adapter. */
  it('asks a name and a description, and creates only with a name, handing both over', async () => {
    const { createVault } = await import('../adapters/create-vault.js');
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    const name = q(container, '[data-field=vault-name]') as HTMLInputElement;
    const description = q(container, '[data-field=vault-description]') as HTMLTextAreaElement;
    expect(name.maxLength).toBe(64);
    expect(description.maxLength).toBe(1000);
    expect(container.querySelector(`label[for="${name.id}"]`)!.textContent).toBe(EN['createVault.nameLabel']);
    expect(container.querySelector(`label[for="${description.id}"]`)!.textContent).toBe(EN['createVault.descriptionLabel']);
    expect((q(container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(true);
    expect(q(container, '[data-why]')!.textContent).toBe(EN['createVault.why.nameFirst']);
    expect(q(container, '[data-action=create-vault-now]')!.getAttribute('aria-describedby')).toBe(q(container, '[data-why]')!.id);
    await nameIt(container, '   ');
    expect((q(container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(true);
    await nameIt(container, ' Payroll UK ');
    await act(async () => { fireEvent.change(description, { target: { value: 'Pays the London team.' } }); await settle(); });
    expect((q(container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(false);
    expect(q(container, '[data-why]')).toBeNull();
    await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
    /* Neither can be changed under the confirm step. */
    expect(name.disabled).toBe(true);
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect(vi.mocked(createVault).mock.calls.at(-1)!.slice(0, 2)).toEqual(['u1', 'c-1']);
    expect(vi.mocked(createVault).mock.calls.at(-1)![3]).toEqual({ name: 'Payroll UK', description: 'Pays the London team.' });
  });

  /*
   * RED WHEN: Create can be pressed on a company that is not confirmed finished, or says no reason, or does not lead to the step that finishes the
   * company; or a company whose keys are not open yet is said unfinished, which would lead the person to a step that cannot help.
   */
  it('is disabled with its reason and the way to the finishing step while the company is not finished', async () => {
    state.creation = { standing: 'pay-key-owed', awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: 'not-finished' };
    const leadTo = vi.fn();
    const { container } = await draw(<CreateVault leadTo={leadTo} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await nameIt(container);
    expect((q(container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(true);
    expect(q(container, '[data-why]')!.textContent).toBe(EN['createVault.why.notFinished']);
    expect(q(container, '[data-action=create-vault-now]')!.getAttribute('aria-describedby')).toBe(q(container, '[data-why]')!.id);
    /* RED WHEN: the lead button keeps its label on one line, so at phone width it runs past the panel's edge. */
    expect(q(container, `[data-lead-to=${STEP.finishCompany}]`)!.className).toMatch(/\bh-auto\b.*\bwhitespace-normal\b|\bwhitespace-normal\b.*\bh-auto\b/);
    fireEvent.click(q(container, `[data-lead-to=${STEP.finishCompany}]`)!);
    expect(leadTo).toHaveBeenCalledWith(STEP.finishCompany);
    cleanup();
    state.creation = { standing: 'finished', awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null };
    state.ready = { of: 'locked' };
    const locked = await draw(<CreateVault leadTo={leadTo} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    expect(q(locked.container, '[data-why]')!.textContent).toBe(EN['createVault.why.locked']);
    expect(q(locked.container, `[data-lead-to=${STEP.finishCompany}]`)).toBeNull();
    cleanup();
    state.creation = { standing: 'finished', awaitingSecondPress: false, kept: false, confirmedFinished: true, mark: null };
    state.ready = { of: 'ready' };
    const done = await draw(<CreateVault leadTo={leadTo} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await nameIt(done.container);
    expect((q(done.container, '[data-action=create-vault-now]') as HTMLButtonElement).disabled).toBe(false);
  });

  /* RED WHEN: a refusal of the press reaches the page as "it did not finish", or as the words of another kind of refusal. */
  it('says every refusal of the press by its own words', async () => {
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await nameIt(container);
    for (const [why, key] of [
      ['seat-unknown', 'act.refused.seatUnknown'], ['seat-not-believed', 'act.refused.seatNotBelieved'], ['seat-may-not-raise', 'act.refused.seatMayNotRaise'],
      ['committee-unread', 'act.refused.committeeUnread'], ['committee-not-installable', 'act.refused.committeeNotInstallable'],
      ['page-out-of-date', 'act.refused.pageOutOfDate'], ['vault-not-the-companys', 'act.refused.vaultNotTheCompanys'],
      ['vault-info-refused', 'act.refused.vaultInfoRefused'],
      ['entry-not-filed', 'act.refused.entryNotFiled'], ['entry-waits-for-its-invitation', 'act.refused.entryWaitsForItsInvitation'],
    ] as const) {
      state.vaultCreated = { of: 'refused', why } as never;
      await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
      await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
      expect(q(container, `[data-refusal=${why}]`)?.textContent, why).toContain(EN[key]);
      expect(q(container, `[data-refusal=${why}]`)?.textContent, why).not.toContain(EN['act.refused.didNotFinish']);
    }
  });

  /* RED WHEN: what the press could not leave in the company's records is not said on the page, or is said in another kind's words, or is said when nothing was left out. */
  it('says each thing the press left out of the company\'s records, in its own words', async () => {
    /* RED WHEN: a name that could not be filed is said to be nameable later, when nothing in the product renames a vault. */
    expect(EN['createVault.said.nameNotFiled']).not.toMatch(/name it later/);
    expect(EN['createVault.said.nameNotFiled']).toMatch(/shown by its number/);
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await nameIt(container);
    for (const [said, keys] of [
      [undefined, []],
      [['vault-name-not-filed'], ['createVault.said.nameNotFiled']],
      [['vault-name-given-before', 'proposal-not-written-down'], ['createVault.said.nameGivenBefore', 'createVault.said.proposalNotWrittenDown']],
    ] as const) {
      state.vaultCreated = { of: 'done', vault: 'v-7', ...(said === undefined ? {} : { said }) } as never;
      await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
      await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
      expect([...container.querySelectorAll('[data-said] [data-said-code]')].map((e) => e.textContent)).toEqual(keys.map((k) => EN[k]));
    }
    state.vaultCreated = { of: 'awaiting-approvals', vault: 'v-7', round: 'adoption', approvals: 1, needed: 2, said: ['proposal-not-written-down'] } as never;
    await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect([...container.querySelectorAll('[data-said] [data-said-code]')].map((e) => e.textContent)).toEqual([EN['createVault.said.proposalNotWrittenDown']]);
  });

  /* RED WHEN: the vault's words say money goes in before it is set up, say the signers hold it, or call it done without saying it is set up and who holds it. */
  it('says the vault is held by the super admins and takes no money until it is set up', async () => {
    state.handover = { of: HANDOVER.held };
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await nameIt(container);
    await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect([container.querySelector('[data-action=create-vault] > p')?.textContent, q(container, '[data-created]')!.textContent]).toEqual([
      expect.stringContaining('held from the start by your company\'s super admins. It is then added to your company\'s account and set up. Until it is set up, this app puts no money into it.'),
      'The vault is created and set up, and your company\'s super admins hold it.',
    ]);
  });

  /* RED WHEN: the vaults a company sent and never handed over are listed on the vault page again, though the service no longer holds any in that state. */
  it('lists no vault as owed on the page', async () => {
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    expect(q(container, '[data-owed]')).toBeNull();
    expect(q(container, '[data-action=finish-handover]')).toBeNull();
  });

  /*
   * RED WHEN: a set up waiting for other signers' approvals is said as done, as
   * a failure, or without its round and how many approvals it has and needs; a
   * set up that stopped is not said as that; or finishing it does anything but
   * carry that same vault on, after the account confirms.
   */
  it('says a set up waiting for approvals, or one that stopped, and finishes setting up that vault', async () => {
    const said = (key: string, approvals: number, needed: number) =>
      EN[key]!.replace('{approvals}', String(approvals)).replace('{needed}', String(needed));
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await nameIt(container);
    for (const [result, says] of [
      [{ of: 'awaiting-approvals', vault: 'v-4', round: 'adoption', approvals: 1, needed: 2 }, said('createVault.awaiting.adoption', 1, 2)],
      [{ of: 'awaiting-approvals', vault: 'v-4', round: 'first-secret', approvals: 2, needed: 3 }, said('createVault.awaiting.firstSecret', 2, 3)],
      [{ of: 'start-owed', vault: 'v-4' }, EN['createVault.startOwed']],
    ] as const) {
      state.vaultCreated = result as never;
      state.acted.length = 0;
      await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
      await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
      expect(q(container, '[data-result] [data-says]')!.textContent, result.of).toBe(says);
      /* RED WHEN the words promise what is not built - finishing it from here after a reload - or name it adopting. */
      expect(says, result.of).not.toMatch(/own accounts|from here|adopt/iu);
      /* RED WHEN the words do not send the other signers to the approval that is built for them, on their own device. */
      if (result.of === 'awaiting-approvals') expect(says).toContain('Each of your other signers approves it from their own device: they open this vault and press Finish setting it up');
      expect(q(container, '[data-created]'), result.of).toBeNull();
      await act(async () => { fireEvent.click(q(container, '[data-action=finish-start]')!); await settle(); });
      expect(q(container, '[data-slot=confirm-in-your-account]')!.textContent).toContain(EN['createVault.confirmStart']);
      await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
      expect(state.acted).toEqual([JSON.stringify(['create-vault', 'u1', 'c-1']), JSON.stringify(['finish-vault', 'u1', 'c-1', 'v-4'])]);
    }
  });

  /*
   * RED WHEN: a set up that stopped at the check of who its secret is sealed to is not said with what resolves it,
   * or is said with another reason's words.
   */
  it('says what resolves a set up that stopped before its secret was approved', async () => {
    /* RED WHEN: a stop after the vault's adoption was approved is said as "before anything was approved". */
    for (const k of ['wallet', 'walletAsk', 'directory', 'signers', 'mismatch']) {
      expect(EN[`createVault.stopped.${k}`], k).toMatch(/stopped before its secret was approved/);
      expect(EN[`createVault.stopped.${k}`], k).not.toMatch(/anything was approved|Nothing was approved/);
    }
    /* RED WHEN: a stop a press can never clear is worded as one it can ("finish setting it up"), or is worded without saying what to do. */
    for (const k of ['adoptionStale', 'anotherSecret', 'readBackOnly']) {
      expect(EN[`createVault.stopped.${k}`], k).not.toMatch(/finish setting it up/i);
      expect(EN[`createVault.stopped.${k}`], k).toMatch(/new vault/);
    }
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await nameIt(container);
    for (const [stopped, key] of [
      ['wallet', 'createVault.stopped.wallet'], ['wallet-ask', 'createVault.stopped.walletAsk'], ['directory', 'createVault.stopped.directory'],
      ['signers', 'createVault.stopped.signers'], ['mismatch', 'createVault.stopped.mismatch'],
      ['adoption-stale', 'createVault.stopped.adoptionStale'], ['too-few-approvers', 'createVault.stopped.tooFewApprovers'],
      ['readers-cannot-open', 'createVault.stopped.readersCannotOpen'], ['another-secret', 'createVault.stopped.anotherSecret'],
      ['read-back-only', 'createVault.stopped.readBackOnly'],
    ] as const) {
      state.vaultCreated = { of: 'start-owed', vault: 'v-5', stopped } as never;
      await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
      await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
      expect(q(container, '[data-result]')!.dataset.stopped, stopped).toBe(stopped);
      expect(q(container, '[data-result] [data-says]')!.textContent, stopped).toBe(EN[key]);
    }
  });

  /*
   * RED WHEN: a set up that stopped offers anything but the one action that resolves its own stop: signers' keys that do
   * not match offer no blind retry; the wallet and the signers carry on.
   */
  it('a set up that stopped offers the action that resolves its own stop, and no other', async () => {
    const press = async (container: HTMLElement) => {
      await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
      await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    };
    const offered = (c: HTMLElement) => [...c.querySelectorAll('[data-result] button')].map((b) => b.getAttribute('data-action') ?? `lead-to ${b.getAttribute('data-lead-to')}`);
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await nameIt(container);
    for (const [stopped, actions] of [
      ['wallet', ['finish-start']], ['wallet-ask', ['finish-start']], ['directory', ['finish-start']], ['signers', ['finish-start']],
      ['too-few-approvers', ['finish-start']], ['readers-cannot-open', ['finish-start']],
      ['mismatch', []], ['adoption-stale', []], ['another-secret', []], ['read-back-only', []],
    ] as const) {
      state.vaultCreated = { of: 'start-owed', vault: 'v-5', stopped } as never;
      await press(container);
      expect(offered(container), stopped).toEqual(actions);
    }
  });

  /* RED WHEN: opened to carry a vault on, the confirm opens again after every read of the company - the blind retry back. */
  it('opened to carry a vault on, asks once and not again after the set up ends', async () => {
    const { readVaultReadiness } = await import('../adapters/create-vault.js');
    /* Every read answers with a new object, as the adapter does. */
    vi.mocked(readVaultReadiness).mockImplementation(async () => ({ ...state.ready }) as never);
    state.vaultCreated = { of: 'start-owed', vault: 'v-6', stopped: 'mismatch' } as never;
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} starting="v-6" />, sessionWith({ company: 'c-1' }));
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    await act(settle);
    expect(q(container, '[data-result]')!.dataset.stopped).toBe('mismatch');
    expect(q(container, '[data-slot=confirm-in-your-account]')).toBeNull();
    vi.mocked(readVaultReadiness).mockImplementation(async () => state.ready as never);
  });

  /* RED WHEN: what a set up came to is put on the screen where a screen reader does not announce it. */
  it('announces what a set up came to', async () => {
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await nameIt(container);
    const live = q(container, '[data-outcome]')!;
    /* A status region is announced politely by its role alone. */
    expect(live.getAttribute('role')).toBe('status');
    state.vaultCreated = { of: 'start-owed', vault: 'v-5', stopped: 'wallet' } as never;
    await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect(q(live, '[data-says]')!.textContent).toBe(EN['createVault.stopped.wallet']);
    state.vaultCreated = { of: 'done', vault: 'v-6' } as never;
    await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect(q(live, '[data-created]')).not.toBeNull();
  });

  /* RED WHEN: a set up refused for the signer's seat - none in the records, or one their own key does not make - is not said in its own words on the screen. */
  it('drives a set up to each of the two seat refusals and says each in its own words', async () => {
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await nameIt(container);
    for (const [why, key] of [['no-seat', 'act.refused.noSeat'], ['not-your-seat', 'act.refused.notYourSeat']] as const) {
      state.vaultCreated = { of: 'refused', why } as never;
      await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
      await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
      expect(q(container, `[data-refusal=${why}]`)?.textContent, why).toContain(EN[key]);
      expect(q(container, `[data-refusal=${why}]`)?.textContent, why).not.toContain(EN['act.refused.didNotFinish']);
    }
  });

  /* RED WHEN: asked to carry one vault's set up on, the component opens its confirm before it has read the company. */
  it('opened to carry a vault\'s set up on, reads the company before asking to confirm', async () => {
    const { readVaultReadiness } = await import('../adapters/create-vault.js');
    let release: () => void = () => {};
    vi.mocked(readVaultReadiness).mockImplementationOnce(() => new Promise((r) => { release = () => r(state.ready as never); }));
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} starting="v-6" />, sessionWith({ company: 'c-1' }));
    expect(q(container, '[data-slot=confirm-in-your-account]')).toBeNull();
    await act(async () => { release(); await settle(); });
    expect(q(container, '[data-slot=confirm-in-your-account]')!.textContent).toContain(EN['createVault.confirmStart']);
  });

  /*
   * RED WHEN: a vault carried on that has no name filed is carried on without asking for one, its name and description
   * cannot be typed while it is asked, or what is typed is not handed to the set up.
   */
  it('opened to carry on a vault with no name filed, asks its name and description first and hands them on', async () => {
    state.vaultName = null;
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} starting="v-6" />, sessionWith({ company: 'c-1' }));
    await act(settle);
    expect(q(container, '[data-name-again]')!.textContent).toBe(EN['createVault.resume.nameAgain']);
    expect(q(container, '[data-slot=confirm-in-your-account]')).toBeNull();
    expect((q(container, '[data-field=vault-name]') as HTMLInputElement).disabled).toBe(false);
    await nameIt(container, 'Payroll');
    await act(async () => { fireEvent.change(q(container, '[data-field=vault-description]')!, { target: { value: 'Founding vault.' } }); await settle(); });
    state.acted.length = 0;
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect(state.acted).toEqual([JSON.stringify(['finish-vault', 'u1', 'c-1', 'v-6', { name: 'Payroll', description: 'Founding vault.' }])]);
  });

  /* RED WHEN: a vault whose name could not be read is said to have none, and a second name is asked for over the one filed. */
  it('opened to carry on a vault whose name could not be read, says so and asks no name', async () => {
    state.vaultName = 'unread';
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} starting="v-6" />, sessionWith({ company: 'c-1' }));
    await act(settle);
    expect(q(container, '[data-name-unread]')!.textContent).toBe(EN['createVault.resume.nameUnread']);
    expect(q(container, '[data-name-again]')).toBeNull();
    expect(q(container, '[data-slot=confirm-in-your-account]')).toBeNull();
    expect((q(container, '[data-field=vault-name]') as HTMLInputElement).disabled).toBe(true);
  });

  /* RED WHEN: asked to carry one vault's set up on, the component does not ask to confirm that, or carries another vault on. */
  it('opened to carry a vault\'s set up on, asks to confirm that and carries that vault on', async () => {
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} starting="v-6" />, sessionWith({ company: 'c-1' }));
    await settle();
    expect(q(container, '[data-slot=confirm-in-your-account]')!.textContent).toContain(EN['createVault.confirmStart']);
    state.acted.length = 0;
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
    expect(state.acted).toEqual([JSON.stringify(['finish-vault', 'u1', 'c-1', 'v-6'])]);
  });

  /* RED WHEN: a stage of the vault's set up is not said while it happens, or is said in words other than its own. */
  it('says each stage of setting the vault up while it happens', async () => {
    const { createVault } = await import('../adapters/create-vault.js');
    const STAGES = [['checking', 'createVault.stage.checking'], ['building', 'createVault.stage.building']] as const;
    const { container } = await draw(<CreateVault leadTo={() => {}} onChanged={() => {}} />, sessionWith({ company: 'c-1' }));
    await nameIt(container);
    for (const [stage, key] of STAGES) {
      let release: () => void = () => {};
      vi.mocked(createVault).mockImplementationOnce(async (_p, _c, onStage) => {
        onStage(stage);
        await new Promise<void>((r) => { release = r; });
        return state.vaultCreated as never;
      });
      await act(async () => { fireEvent.click(q(container, '[data-action=create-vault-now]')!); await settle(); });
      await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!); await settle(); });
      expect(q(container, `[data-stage=${stage}]`)?.textContent, stage).toBe(EN[key]);
      await act(async () => { release(); await settle(); });
    }
  });
});

describe('creating the company', () => {
  const create = async (container: HTMLElement) => {
    fireEvent.change(container.querySelector('input')!, { target: { value: ' Acme ' } });
    await act(async () => { fireEvent.click(q(container, '[data-action=create]')!); await settle(); });
  };

  /* RED WHEN: Create is enabled with no name or says no reason; the first signer's name or the company's name is not what is handed to the adapter; or the wizard is not told so it reads where the company stands. */
  it('creates with the name typed and the person as its first signer, and tells the wizard', async () => {
    const companiesChanged = vi.fn(async () => {});
    const onChanged = vi.fn();
    const { container } = await draw(<CreateCompany leadTo={() => {}} onChanged={onChanged} />, sessionWith({ companiesChanged }));
    expect((q(container, '[data-action=create]') as HTMLButtonElement).disabled).toBe(true);
    expect(q(container, '[data-why-disabled]')!.textContent).toBe(EN['setup.createCompany.nameFirst']);
    await create(container);
    expect(state.acted).toEqual([JSON.stringify(['create', 'u1', { name: 'Acme', firstSigner: 'Priya' }])]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    /* RED WHEN: the company is shown as listed before it is finished, so the switcher and the pages offer a company that does not exist on the network. */
    expect(companiesChanged).not.toHaveBeenCalled();
  });

  /* RED WHEN: a person whose account gives no name is sent to the service with none, which the service refuses. */
  it('names a person with no name by the language file\'s word', async () => {
    const { container } = await draw(<CreateCompany leadTo={() => {}} onChanged={() => {}} />, sessionWith({ person: { id: 'u1', name: '' } }));
    await create(container);
    expect(state.acted).toEqual([JSON.stringify(['create', 'u1', { name: 'Acme', firstSigner: EN['setup.createCompany.you'] }])]);
  });

  /* RED WHEN: the label the wallet drew is not shown, or the person is not led to the step that finishes the company, or the first press says the company is finished. */
  it('shows the label the wallet drew and leads to finishing the company', async () => {
    const leadTo = vi.fn();
    const { container } = await draw(<CreateCompany leadTo={leadTo} onChanged={() => {}} />, sessionWith());
    await create(container);
    expect(q(container, '[data-created]')!.getAttribute('data-created')).toBe('c-new');
    expect(q(container, '[data-created]')!.textContent).toBe(EN['setup.createCompany.started']!.replace('{label}', 'co_drawn'));
    fireEvent.click(q(container, `[data-lead-to=${STEP.finishCompany}]`)!);
    expect(leadTo).toHaveBeenCalledWith(STEP.finishCompany);
  });

  /* RED WHEN: Create stays enabled once a company is started, so a second press could start a second company; or its reason is not shown, or not tied to it. */
  it('shuts Create once a company is started, with its reason tied to it', async () => {
    const { container } = await draw(<CreateCompany leadTo={() => {}} onChanged={() => {}} />, sessionWith());
    const button = () => q(container, '[data-action=create]') as HTMLButtonElement;
    const why = () => q(container, '[data-why-disabled]');
    /* RED WHEN: the reason beside a disabled Create is not tied to it, for a screen reader. */
    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-describedby')).toBe(why()!.id);
    await create(container);
    expect(button().disabled).toBe(true);
    expect(why()!.textContent).toBe(EN['setup.createCompany.made']);
    expect(button().getAttribute('aria-describedby')).toBe(why()!.id);
    await act(async () => { fireEvent.click(button()); await settle(); });
    expect(state.acted).toHaveLength(1);
  });

  /* RED WHEN: creating a company while another is kept still shows a refusal about it, or does not say which company it made, so the wizard cannot finish that one. */
  it('shows no refusal because another company is not finished: it creates, and tells the wizard which company it made', async () => {
    state.creation = { standing: 'not-created', awaitingSecondPress: true, kept: true, confirmedFinished: false, mark: 'not-finished' };
    const onChanged = vi.fn();
    const { container } = await draw(<CreateCompany leadTo={() => {}} onChanged={onChanged} />, sessionWith());
    await create(container);
    expect(q(container, '[data-refusal]')).toBeNull();
    expect(q(container, '[data-action=start-again]')).toBeNull();
    expect(q(container, '[data-created]')!.getAttribute('data-created')).toBe('c-new');
    expect(onChanged).toHaveBeenCalledWith('c-new');
    expect(EN).not.toHaveProperty(['act.refused.companyKept']);
    /* Any other refusal is still shown, with nothing to start again. */
    cleanup();
    state.created = { of: 'refused', why: 'sign-in-again' };
    const other = await draw(<CreateCompany leadTo={() => {}} onChanged={() => {}} />, sessionWith());
    await create(other.container);
    expect(q(other.container, '[data-refusal]')).not.toBeNull();
    expect(q(other.container, `[data-lead-to=${STEP.finishCompany}]`)).toBeNull();
  });

  /* RED WHEN: a refusal is not shown, or is shown in words that are not the language file's. */
  it('says why it did not happen', async () => {
    state.created = { of: 'refused', why: 'sign-in-again', waiting: null };
    const { container } = await draw(<CreateCompany leadTo={() => {}} onChanged={() => {}} />, sessionWith());
    await create(container);
    expect(q(container, '[data-refusal]')!.getAttribute('data-refusal')).toBe('sign-in-again');
    expect(q(container, '[data-refusal]')!.textContent).toContain(EN['act.refused.signInAgain']);
    expect(q(container, '[data-created]')).toBeNull();
  });
});

describe('finishing the company', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const drawStep = async (over: Partial<Session> = {}, props: { leadTo?: () => void; onChanged?: () => void; startNewCompany?: () => void } = {}) => {
    const view = render(framed(<FinishCompany leadTo={props.leadTo ?? (() => {})} onChanged={props.onChanged ?? (() => {})} startNewCompany={props.startNewCompany} />, sessionWith({ company: 'c-1', ...over })));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    return view;
  };
  const wait = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const carries = () => state.acted.filter((a) => a.startsWith('["carry"')).length;

  /* RED WHEN: the label the wallet drew, kept by the keyring, is not shown on finishing the company, or is shown when nothing is kept. */
  it('shows the label the wallet drew for the company being created, and nothing when none is kept', async () => {
    state.label = 'co_drawn';
    const { container, unmount } = await drawStep();
    expect(q(container, '[data-drawn-label]')!.getAttribute('data-drawn-label')).toBe('co_drawn');
    expect(q(container, '[data-drawn-label]')!.textContent).toBe(EN['setup.finishCompany.named']!.replace('{label}', 'co_drawn'));
    unmount();
    state.label = null;
    const none = await drawStep();
    expect(q(none.container, '[data-drawn-label]')).toBeNull();
  });

  /* RED WHEN: a company the chain is still working on is not looked at again by itself every ten seconds, or the screen does not say which stage it waits on and that it carries on when the person comes back. */
  it('looks again by itself while the chain works, naming the stage, and says it carries on when the person returns', async () => {
    const { container } = await drawStep();
    expect(state.acted).toEqual([JSON.stringify(['carry', 'u1', 'c-1'])]);
    expect(q(container, '[data-stage]')!.getAttribute('data-stage')).toBe('deploy');
    expect(q(container, '[data-stage]')!.textContent).toContain(EN['setup.finishCompany.stage.deploy']);
    expect(q(container, '[data-carries-on]')!.textContent).toBe(EN['setup.finishCompany.carries']);
    /* RED WHEN: the stages are drawn by hand, not with the kit's progress. */
    expect([...container.querySelectorAll('[data-stage-progress] [data-mark]')].map((m) => [m.getAttribute('data-mark'), m.getAttribute('data-filled')])).toEqual([['deploy', 'false'], ['finish', 'false'], ['key', 'false']]);
    await wait(9_999);
    expect(carries()).toBe(1);
    state.carried = [{ of: 'waiting', companyId: 'c-1', stage: 'deploy' }, { of: 'waiting', companyId: 'c-1', stage: 'key' }];
    await wait(1);
    expect(carries()).toBe(2);
    expect(q(container, '[data-stage]')!.getAttribute('data-stage')).toBe('key');
    expect([...container.querySelectorAll('[data-stage-progress] [data-mark]')].map((m) => m.getAttribute('data-filled'))).toEqual(['true', 'true', 'false']);
    await wait(30_000);
    expect(carries()).toBe(5);
  });

  /* RED WHEN: a company the service reads as finished, while the wallet has not yet shown it, is said to be having its key sealed. */
  it('says it waits for the network to show a finished company to the wallet, with every stage filled', async () => {
    state.carried = [{ of: 'waiting', companyId: 'c-1', stage: 'shown' }];
    const { container } = await drawStep();
    expect(q(container, '[data-stage]')!.getAttribute('data-stage')).toBe('shown');
    expect(q(container, '[data-stage]')!.textContent).toBe(EN['setup.finishCompany.stage.shown']);
    expect([...container.querySelectorAll('[data-stage-progress] [data-mark]')].map((m) => m.getAttribute('data-filled'))).toEqual(['true', 'true', 'true']);
  });

  /* RED WHEN: the screen keeps looking at the company after the person has left it. */
  it('stops looking when it is no longer shown', async () => {
    const { unmount } = await drawStep();
    await wait(10_000);
    expect(carries()).toBe(2);
    unmount();
    await wait(60_000);
    expect(carries()).toBe(2);
  });

  /* RED WHEN: a look still under way when the person leaves the step goes on to tell the app and the wizard the company is finished, or to look again. */
  it('ignores a look that comes back after the step was left', async () => {
    const companiesChanged = vi.fn(async () => {});
    const onChanged = vi.fn();
    let release = () => {};
    state.carryGate = new Promise<void>((r) => { release = r; });
    state.carried = [{ of: 'done', companyId: 'c-1' }];
    const { unmount } = await drawStep({ companiesChanged }, { onChanged });
    unmount();
    release();
    await wait(60_000);
    expect(companiesChanged).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(carries()).toBe(1);
  });

  /* RED WHEN: a company carried to finished does not tell the app and the wizard, or goes on looking afterwards. */
  it('when the company is finished, lists it as a company, tells the wizard, and stops looking', async () => {
    const companiesChanged = vi.fn(async () => {});
    const onChanged = vi.fn();
    state.carried = [{ of: 'waiting', companyId: 'c-1', stage: 'key' }, { of: 'done', companyId: 'c-1' }];
    await drawStep({ companiesChanged }, { onChanged });
    await wait(10_000);
    expect(companiesChanged).toHaveBeenCalledWith('c-1');
    expect(onChanged).toHaveBeenCalledTimes(1);
    await wait(60_000);
    expect(carries()).toBe(2);
  });

  /* RED WHEN: once the company is finished and the app lists it, the step looks at the company again, so a step the wizard is closing sends or signs once more. */
  it('does not look again after it is finished when the company shown changes', async () => {
    state.carried = [{ of: 'done', companyId: 'c-1' }];
    /* The company just created is shown by its id before the app lists it. */
    const view = render(framed(<FinishCompany leadTo={() => {}} onChanged={() => {}} creation="c-1" />, sessionWith({ company: null })));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(carries()).toBe(1);
    view.rerender(framed(<FinishCompany leadTo={() => {}} onChanged={() => {}} creation="c-1" />, sessionWith({ company: 'c-1' })));
    await wait(30_000);
    expect(carries()).toBe(1);
  });

  /*
   * RED WHEN: switching from one company to another shows the first company's stage or its Start it again for the second;
   * the first company finishing marks the second finished, or stops the second from being looked at; or Start it again
   * acts on a company other than the one shown.
   */
  it('shows its own company\'s stage after a switch, is not finished by the one left, and starts again the one shown', async () => {
    let releaseA!: () => void;
    state.carriedBy = {
      'c-1': { gate: new Promise<void>((r) => { releaseA = r; }), result: { of: 'done', companyId: 'c-1' } },
      'c-2': { result: { of: 'waiting', companyId: 'c-2', stage: 'key' } },
    };
    const companiesChanged = vi.fn(async () => {});
    const onChanged = vi.fn();
    const at = (company: string) => framed(<FinishCompany leadTo={() => {}} onChanged={onChanged} />, sessionWith({ company, companiesChanged }));
    const view = render(at('c-1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    view.rerender(at('c-2'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(q(view.container, '[data-stage]')!.getAttribute('data-stage')).toBe('key');
    await act(async () => { releaseA(); await vi.advanceTimersByTimeAsync(0); });
    expect(companiesChanged).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(q(view.container, '[data-stage]')!.getAttribute('data-stage')).toBe('key');
    const looksAtB = () => state.acted.filter((a) => a === JSON.stringify(['carry', 'u1', 'c-2'])).length;
    const before = looksAtB();
    await wait(10_000);
    expect(looksAtB()).toBeGreaterThan(before);
    await startAgainConfirmed(view.container);
    expect(state.acted.filter((a) => a.startsWith('["start-again-here"'))).toEqual([JSON.stringify(['start-again-here', 'u1', 'c-2'])]);
  });

  /* RED WHEN: a creation waiting for the wallet is looked at again by itself instead of waiting for the press, the press opens nothing, or the look is not taken again after it. */
  it('waits for the one wallet press, opens the wallet once, then goes on by itself', async () => {
    state.carried = [{ of: 'press', companyId: 'c-1' }, { of: 'waiting', companyId: 'c-1', stage: 'deploy' }];
    const { container } = await drawStep();
    expect(q(container, '[data-press]')!.textContent).toContain(EN['setup.finishCompany.press']);
    await wait(60_000);
    expect(carries()).toBe(1);
    await act(async () => { fireEvent.click(q(container, '[data-action=open-wallet]')!); await vi.advanceTimersByTimeAsync(0); });
    /* The third argument is the step the wallet reports, a function, which a JSON record writes as null. */
    expect(state.acted.filter((a) => a.startsWith('["open-wallet"'))).toEqual([JSON.stringify(['open-wallet', 'u1', 'c-1', null])]);
    expect(carries()).toBe(2);
    expect(q(container, '[data-stage]')).not.toBeNull();
    expect(q(container, '[data-action=open-wallet]')).toBeNull();
  });

  /* RED WHEN: an action the wallet stopped before its end does not show where it stopped, or offers no press that carries it on. */
  it('says where the wallet stopped after the press, and carries on from there with one more press', async () => {
    state.carried = [{ of: 'press', companyId: 'c-1' }];
    state.pressed = { of: 'interrupted', step: 3, steps: 5 };
    const { container } = await drawStep();
    expect(q(container, '[data-interrupted]')).toBeNull();
    await act(async () => { fireEvent.click(q(container, '[data-action=open-wallet]')!); await vi.advanceTimersByTimeAsync(0); });
    expect(q(container, '[data-interrupted]')!.getAttribute('data-interrupted')).toBe('3');
    expect(q(container, '[data-interrupted]')!.textContent).toContain(
      (EN['setup.finishCompany.interrupted'] ?? '').replace('{step}', '3').replace('{steps}', '5'));
    state.pressed = { of: 'done' };
    await act(async () => { fireEvent.click(q(container, '[data-action=continue]')!); await vi.advanceTimersByTimeAsync(0); });
    expect(state.acted.filter((a) => a.startsWith('["open-wallet"')).length).toBe(2);
  });

  /* RED WHEN: a company whose action stopped before a reload shows as waiting for nothing instead of interrupted at its step. */
  it('shows a company interrupted before a reload at its step, with the press that carries it on', async () => {
    state.carried = [{ of: 'interrupted', companyId: 'c-1', step: 2, steps: 5 }];
    const { container } = await drawStep();
    expect(q(container, '[data-interrupted]')!.getAttribute('data-interrupted')).toBe('2');
    expect(q(container, '[data-action=continue]')!.textContent).toBe(EN['setup.finishCompany.continue']);
    await wait(60_000);
    expect(carries()).toBe(1);
  });

  /* RED WHEN: shut saved keys are not said, or the press that opens them is not the same one. */
  it('says the saved keys must be opened first when they are shut', async () => {
    state.carried = [{ of: 'locked', companyId: 'c-1' }];
    const { container } = await drawStep();
    expect(q(container, '[data-locked]')!.textContent).toContain(EN['setup.finishCompany.locked']);
    expect(q(container, '[data-action=open-wallet]')!.textContent).toBe(EN['setup.finishCompany.sign']);
  });

  /* RED WHEN: a refusal of the wallet press is not shown by its kind, or leaves the press unavailable. */
  it('says why the wallet press did not happen and lets it be pressed again', async () => {
    state.carried = [{ of: 'press', companyId: 'c-1' }];
    state.pressed = { of: 'refused', why: 'declined' };
    const { container } = await drawStep();
    await act(async () => { fireEvent.click(q(container, '[data-action=open-wallet]')!); await vi.advanceTimersByTimeAsync(0); });
    expect(q(container, '[data-refusal]')!.getAttribute('data-refusal')).toBe('declined');
    expect((q(container, '[data-action=open-wallet]') as HTMLButtonElement).disabled).toBe(false);
  });

  /* RED WHEN: a refusal from a step is not shown by its kind, the screen goes on sending after it, or Try again does not take the look again. */
  it('stops at a refusal, says it by kind, and takes the look again only when the person tries again', async () => {
    state.carried = [{ of: 'refused', why: 'keys-did-not-open', companyId: 'c-1' }, { of: 'waiting', companyId: 'c-1', stage: 'key' }];
    const { container } = await drawStep();
    expect(q(container, '[data-refusal]')!.getAttribute('data-refusal')).toBe('keys-did-not-open');
    await wait(60_000);
    expect(carries()).toBe(1);
    await act(async () => { fireEvent.click(q(container, '[data-action=try-again]')!); await vi.advanceTimersByTimeAsync(0); });
    expect(carries()).toBe(2);
    expect(q(container, '[data-refusal]')).toBeNull();
    expect(q(container, '[data-stage]')!.getAttribute('data-stage')).toBe('key');
  });

  /* RED WHEN: a company that cannot be finished from here is not said so plainly, or the person is not led to creating a new company. */
  it('says plainly a company cannot be finished from here, and leads to creating a new company', async () => {
    state.carried = [{ of: 'cannot', companyId: 'c-1' }];
    const startNewCompany = vi.fn();
    const { container } = await drawStep({}, { startNewCompany });
    expect(q(container, '[data-cannot] [data-slot=alert-description]')!.textContent).toBe(EN['setup.finishCompany.cannot']);
    await wait(60_000);
    expect(carries()).toBe(1);
    const lead = q(container, '[data-action=new-company]')!;
    expect(lead.textContent).toBe(EN['switcher.create']);
    fireEvent.click(lead);
    expect(startNewCompany).toHaveBeenCalledTimes(1);
  });

  const startAgainConfirmed = async (container: HTMLElement) => {
    await act(async () => { fireEvent.click(q(container, '[data-action=start-again]')!); await vi.advanceTimersByTimeAsync(0); });
    const sure = [...container.querySelectorAll('[data-slot=confirm-in-your-account] button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!;
    expect(state.acted.filter((a) => a.startsWith('["start-again-here"'))).toEqual([]);
    await act(async () => { fireEvent.click(sure); await vi.advanceTimersByTimeAsync(0); });
  };

  /* RED WHEN: a kept creation waiting for its press is not offered to be started again here, starting again acts before the person confirms, forgets another company, or the person is left on the company that cannot be finished. */
  it('offers to start again a kept creation waiting for its press, asks first, then leads to creating a new company', async () => {
    state.carried = [{ of: 'press', companyId: 'c-1' }];
    const startNewCompany = vi.fn();
    const { container } = await drawStep({}, { startNewCompany });
    await startAgainConfirmed(container);
    expect(state.acted.filter((a) => a.startsWith('["start-again-here"'))).toEqual([JSON.stringify(['start-again-here', 'u1', 'c-1'])]);
    expect(q(container, '[data-start-again-kept]')!.textContent).toContain(EN['setup.again.dropped']);
    expect(startNewCompany).not.toHaveBeenCalled();
    fireEvent.click(q(container, '[data-action=start-new-company]')!);
    expect(startNewCompany).toHaveBeenCalledTimes(1);
  });

  /* RED WHEN: a creation that cannot be finished and was sent offers no way out, or no way to start it again. */
  it('offers starting again to a creation waiting for the chain, and to one that is stuck', async () => {
    for (const carried of [{ of: 'waiting', companyId: 'c-1', stage: 'deploy' }, { of: 'cannot', companyId: 'c-1' }, { of: 'refused', why: 'did-not-finish', companyId: 'c-1' }]) {
      state.carried = [carried];
      state.acted = [];
      const { container } = await drawStep({}, {});
      expect(q(container, '[data-action=start-again]'), String(carried.of)).not.toBeNull();
      cleanup();
    }
  });

  /* RED WHEN: a creation kept because its deploy landed or may still land is led on as dropped, or says nothing of why it was kept. */
  it('says why a creation was kept, and does not lead on', async () => {
    for (const [again, words] of [
      [{ of: 'landed' }, EN['setup.again.landed']],
      [{ of: 'wait', minutes: 7 }, (EN['setup.again.wait'] ?? '').replace('{minutes}', '7')],
      [{ of: 'unsure' }, EN['setup.again.unsure']],
    ] as [Record<string, unknown>, string][]) {
      state.carried = [{ of: 'press', companyId: 'c-1' }];
      state.acted = [];
      state.startedAgainHere = again;
      const startNewCompany = vi.fn();
      const { container } = await drawStep({}, { startNewCompany });
      await startAgainConfirmed(container);
      expect(q(container, '[data-start-again-kept]')!.textContent).toContain(words);
      expect(startNewCompany).not.toHaveBeenCalled();
      cleanup();
    }
  });

  /* RED WHEN: a refusal to start again is lost and the person is led on as if it had been forgotten. */
  it('does not lead on when starting again was refused', async () => {
    state.carried = [{ of: 'press', companyId: 'c-1' }];
    state.startedAgainHere = { of: 'refused', why: 'did-not-finish' };
    const startNewCompany = vi.fn();
    const { container } = await drawStep({}, { startNewCompany });
    await startAgainConfirmed(container);
    expect(q(container, '[data-refusal]')!.getAttribute('data-refusal')).toBe('did-not-finish');
    expect(startNewCompany).not.toHaveBeenCalled();
  });

  /* RED WHEN: with no company waiting, the step looks as if something were being carried, or leads nowhere. */
  it('with no company waiting, says so and leads back to creating one', async () => {
    state.carried = [{ of: 'none' }];
    const leadTo = vi.fn();
    const { container } = await drawStep({ company: null }, { leadTo });
    expect(q(container, '[data-none] [data-slot=alert-description]')!.textContent).toBe(EN['setup.finishCompany.nothing']);
    expect(state.acted).toEqual([JSON.stringify(['carry', 'u1', null])]);
    fireEvent.click(q(container, `[data-lead-to=${STEP.createCompany}]`)!);
    expect(leadTo).toHaveBeenCalledWith(STEP.createCompany);
  });
});

describe('the People step is done once somebody is invited', () => {
  const read = (value: unknown) => ({ of: 'read', value });
  const waiting = (kind: string) => ({ kind, name: 'Ada', sentAt: '2026-10-29T00:00:00.000Z', expiresAt: null });
  const stand = (c: HTMLElement, id: string) => q(c, `[data-setup-steps] [data-step=${id}]`)!.getAttribute('data-standing');
  const continueButton = (c: HTMLElement) => q(c, '[data-action=continue]') as HTMLButtonElement;

  /*
   * RED WHEN: after an invitation is filed from the People step the step still reads open and Continue stays disabled; or the
   * wizard does not read the company's records again when the step says something changed; or the step is done before.
   */
  it('reads not done and shuts Continue before an invitation is filed, then done and opens Continue after', async () => {
    state.afterInvite = openRecords({ invitations: read([waiting('employee')]) });
    const { container } = await drawWizard(signing());
    await pick(container, STEP.people);
    expect(stand(container, STEP.people)).toBe('open');
    expect(continueButton(container).disabled).toBe(true);
    expect(q(container, '[data-why-disabled~=continue]')!.textContent).toBe(EN['setup.continue.notDone']);
    await act(async () => { fireEvent.change(q(container, '[data-field=name]')!, { target: { value: 'Ada' } }); await settle(); });
    await act(async () => { fireEvent.click(q(container, '[data-action=send-invite]')!); await settle(); });
    await untilPageShown(container);
    expect(state.sent).toHaveLength(1);
    expect(stand(container, STEP.people)).toBe('done');
    expect(q(container, `[data-setup-steps] [data-step=${STEP.people}] [data-done]`)!.textContent).toBe(EN['setup.done']);
    expect(q(container, `[data-mark=${STEP.people}]`)!.getAttribute('data-filled')).toBe('true');
    expect(q(container, '[data-progress]')!.getAttribute('aria-valuenow')).toBe('3');
  });

  /*
   * RED WHEN: the fact is kept by the page (in its memory or the tab's storage) instead of read from what the company holds, so
   * a reload, or another device, shows the step open for somebody already invited; or a vendor's waiting invitation does not count; or a signer's invitation counts.
   */
  it('reads it from the company\'s records, so a fresh showing of the wizard says the same, and a signer\'s invitation is not somebody to pay', async () => {
    state.records = openRecords({ invitations: read([waiting('employee')]) });
    const first = await drawWizard(signing());
    expect(stand(first.container, STEP.people)).toBe('done');
    expect(window.sessionStorage.length).toBe(0);
    cleanup();
    state.records = openRecords({ invitations: read([waiting('signer')]) });
    const second = await drawWizard(signing());
    expect(stand(second.container, STEP.people)).toBe('open');
    cleanup();
    state.records = openRecords({ people: read([{ id: 'e1', name: 'Ana' }]) });
    const third = await drawWizard(signing());
    expect(stand(third.container, STEP.people)).toBe('done');
    cleanup();
    state.records = openRecords({ invitations: read([waiting('vendor')]) });
    const fourth = await drawWizard(signing());
    expect(stand(fourth.container, STEP.people)).toBe('done');
  });

  /* RED WHEN: the step is counted done with no company shown, or with the records of another company than the one being set up. */
  it('is not done while no company is shown, or for another company\'s records', async () => {
    state.records = openRecords({ id: 'c-other', invitations: read([waiting('employee')]) });
    const other = await drawWizard(signing());
    expect(stand(other.container, STEP.people)).toBe('open');
    cleanup();
    state.records = openRecords({ invitations: read([waiting('employee')]) });
    const none = await drawWizard(sessionWith());
    expect(stand(none.container, STEP.people)).toBe('open');
  });
});
