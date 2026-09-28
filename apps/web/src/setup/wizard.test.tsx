// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { CurrentPageProvider } from '../router.js';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { SessionProvider, type Session } from '../session.js';
import { VIEWS } from '../pages.js';

/*
 * THE SETUP WIZARD AND ITS TWO BUILT STEPS, DRAWN, with the adapters that act
 * and read stood in for, so what each step shows and when it acts is read
 * from the screen.
 */
const state = vi.hoisted(() => ({
  handover: { of: 'vault-keys-missing', signers: 1 } as Record<string, unknown>,
  acted: [] as string[],
  created: { of: 'done', companyId: 'c-new' } as Record<string, unknown>,
  waiting: null as string | null,
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
const { EVERY_STEP, isBuiltStep, takeAsked } = await import('./steps.js');
const { skippedFor } = await import('./standing.js');
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

async function draw(node: React.ReactNode, session: Session) {
  const view = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session}><CurrentPageProvider id="setup">{node}</CurrentPageProvider></SessionProvider>
    </KitProvider>,
  );
  await act(settle);
  return view;
}
const q = (c: HTMLElement, sel: string) => c.querySelector(sel) as HTMLElement | null;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.handover = { of: 'vault-keys-missing', signers: 1 }; state.acted = []; state.waiting = null; state.created = { of: 'done', companyId: 'c-new' };
  /* What a tab remembers between showings of the wizard starts empty for every test. */
  for (const c of [null, 'c-1']) skippedFor(c).clear();
  takeAsked();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the wizard reads the one list', () => {
  /* RED WHEN: the wizard's list of steps or its progress bar is not the list's, one step left out or added, or in another order. */
  it('lists every step and marks each on the progress bar, in the list\'s order', async () => {
    const { container } = await draw(<Setup />, sessionWith());
    expect([...container.querySelectorAll('[data-setup-steps] [data-step]')].map((e) => e.getAttribute('data-step'))).toEqual(EVERY_STEP.map((s) => s.id));
    expect([...container.querySelectorAll('[data-progress] [data-mark]')].map((e) => e.getAttribute('data-mark'))).toEqual(EVERY_STEP.map((s) => s.id));
    expect(q(container, '[data-progress]')!.getAttribute('aria-valuemax')).toBe(String(EVERY_STEP.length));
  });

  /* RED WHEN: a step not built is shown without Coming soon and its line, or a built step does not show its own component. */
  it('shows a built step\'s component and a step not built Coming soon', async () => {
    const { container } = await draw(<Setup />, sessionWith());
    for (const s of EVERY_STEP) {
      await act(async () => { fireEvent.click(q(container, `[data-setup-steps] [data-step=${s.id}]`)!); await settle(); });
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
    const { container } = await draw(<Setup />, sessionWith());
    await act(async () => { fireEvent.click(q(container, `[data-setup-steps] [data-step=${STEP.handOver}]`)!); await settle(); });
    await act(async () => { fireEvent.click(q(container, `[data-lead-to=${STEP.createCompany}]`)!); await settle(); });
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.createCompany);
  });

  /* RED WHEN: Continue is not offered on a step that is done, or does not go on to the next step. */
  it('offers Continue on a step that is done, and goes on', async () => {
    const { container } = await draw(<Setup />, sessionWith({ company: 'c-1' }));
    await act(async () => { fireEvent.click(q(container, `[data-setup-steps] [data-step=${STEP.createCompany}]`)!); await settle(); });
    expect((q(container, '[data-action=continue]') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(q(container, '[data-action=continue]')!); await settle(); });
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.signers);
  });
});

describe('skipping', () => {
  /* RED WHEN: a skipped step is shown as done (a tick, a filled mark, a count), is not shown as skipped, or cannot be returned to. */
  it('shows a skipped step as skipped, never done, and lets the person return to it', async () => {
    const { container } = await draw(<Setup />, sessionWith());
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.createCompany);
    await act(async () => { fireEvent.click(q(container, '[data-action=skip]')!); await settle(); });
    const row = q(container, `[data-setup-steps] [data-step=${STEP.createCompany}]`)!;
    expect(row.getAttribute('data-standing')).toBe('skipped');
    expect(row.querySelector('[data-skipped]')!.textContent).toBe(EN['setup.skipped']);
    expect(q(container, `[data-mark=${STEP.createCompany}]`)!.getAttribute('data-standing')).toBe('skipped');
    expect(q(container, `[data-mark=${STEP.createCompany}]`)!.className).not.toContain('bg-primary');
    expect(q(container, '[data-progress]')!.getAttribute('aria-valuenow')).toBe('0');
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.signers);
    await act(async () => { fireEvent.click(row); await settle(); });
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.createCompany);
  });

  /* RED WHEN: a step done is not counted and marked as done, or Continue is offered on a step that is not done. */
  it('counts and marks a step done only when it is, and offers Continue only then', async () => {
    const { container } = await draw(<Setup />, sessionWith({ company: 'c-1' }));
    expect(q(container, `[data-mark=${STEP.createCompany}]`)!.getAttribute('data-standing')).toBe('done');
    expect(q(container, '[data-progress]')!.getAttribute('aria-valuenow')).toBe('1');
    expect(q(container, '[data-current-step]')!.getAttribute('data-current-step')).toBe(STEP.signers);
    expect((q(container, '[data-action=continue]') as HTMLButtonElement).disabled).toBe(true);
    state.handover = { of: 'held' };
    cleanup();
    const again = await draw(<Setup />, sessionWith({ company: 'c-1' }));
    expect(q(again.container, `[data-mark=${STEP.handOver}]`)!.getAttribute('data-standing')).toBe('done');
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
