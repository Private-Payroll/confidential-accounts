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
 * THE COMMITTEE CHANGE, DRAWN: the one component the vault panel and the
 * signers page both show. The adapter that signs and the read of where the
 * company stands are stood in for, so what it says and when it acts is read
 * from the screen.
 */
const state = vi.hoisted(() => ({
  handover: { of: 'held' } as Record<string, unknown>,
  acted: [] as string[],
  signed: { of: 'done' } as Record<string, unknown>,
  reads: 0,
}));
vi.mock('../adapters/handover-state.js', async (real) => ({
  ...(await real<typeof import('../adapters/handover-state.js')>()),
  readHandover: vi.fn(async () => { state.reads += 1; return state.handover; }),
}));
vi.mock('../adapters/committee-change.js', () => ({
  signChange: vi.fn(async (...args: unknown[]) => { state.acted.push(JSON.stringify(['sign-change', ...args])); return state.signed; }),
}));

const { CommitteeChange } = await import('./committee-change.js');
const { HANDOVER } = await import('../adapters/handover-state.js');

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
const confirmButton = (c: HTMLElement) => [...c.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.handover = { of: 'held' }; state.acted = []; state.signed = { of: 'done' }; state.reads = 0;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** What the component says of each state the company can stand in, written out by hand. */
const SAYS: Record<string, string> = {
  [HANDOVER.notOnChain]: 'committeeChange.holds.notOnChain',
  [HANDOVER.held]: 'committeeChange.holds.held',
  [HANDOVER.changeOwed]: 'committeeChange.holds.changeOwed',
  [HANDOVER.heldByOtherKeys]: 'committeeChange.holds.heldByOtherKeys',
  [HANDOVER.unreadable]: 'committeeChange.holds.unreadable',
  [HANDOVER.unreachable]: 'committeeChange.holds.unreachable',
  [HANDOVER.notSignedIn]: 'act.refused.notSignedIn',
  [HANDOVER.anotherPerson]: 'act.refused.anotherPerson',
};

describe('what the committee change says', () => {
  /* RED WHEN: with no company the component reads a company, offers any button (it once led to creating one), or does not say there is none. */
  it('with no company, says so, reads nothing and offers nothing', async () => {
    const { container } = await draw(<CommitteeChange />, sessionWith());
    expect(q(container, '[data-holds]')!.textContent).toBe(EN['committeeChange.noCompany']);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(q(container, '[data-lead-to]')).toBeNull();
    expect(state.reads).toBe(0);
  });

  /* RED WHEN: a state of the company is said in anyone else's words, or says nothing; or any state offers a hand-over, a gift of vault keys, or a way to another step. */
  it('says plainly what holds in every state, and offers no hand-over, no vault keys and no way to another step', async () => {
    expect(Object.keys(SAYS).sort()).toEqual(Object.values(HANDOVER).sort());
    for (const of of Object.values(HANDOVER)) {
      state.handover = of === HANDOVER.changeOwed ? { of, signed: [] } : { of };
      const { container } = await draw(<CommitteeChange />, sessionWith({ company: 'c-1' }));
      expect(q(container, '[data-holds]')!.textContent, of).toBe(EN[SAYS[of]!]);
      expect(q(container, '[data-holds]')!.getAttribute('data-holds'), of).toBe(of);
      expect(q(container, '[data-action=hand-over-now]'), of).toBeNull();
      expect(q(container, '[data-action=give-vault-keys]'), of).toBeNull();
      expect(q(container, '[data-lead-to]'), of).toBeNull();
      cleanup();
    }
  });

  /* RED WHEN: a change is offered to be signed in any state but the one where it is owed, or the way to read again is offered in a state that reads fine. */
  it('offers to sign only when a change is owed, and to check again only when the company could not be read', async () => {
    const buttons: Record<string, string[]> = {
      [HANDOVER.changeOwed]: ['sign-change'],
      [HANDOVER.notOnChain]: ['read-again'], [HANDOVER.unreadable]: ['read-again'], [HANDOVER.unreachable]: ['read-again'],
    };
    for (const of of Object.values(HANDOVER)) {
      state.handover = of === HANDOVER.changeOwed ? { of, signed: [{ have: 1, required: 2 }] } : { of };
      const { container } = await draw(<CommitteeChange />, sessionWith({ company: 'c-1' }));
      expect([...container.querySelectorAll('button')].map((b) => b.getAttribute('data-action')), of).toEqual(buttons[of] ?? []);
      cleanup();
    }
  });

  /* RED WHEN: a change owed does not show, for each contract, how many signatures it has and how many it needs, in the kit's section with a row for each. */
  it('shows the signatures a change owed has and needs', async () => {
    state.handover = { of: 'change-owed', signed: [{ have: 1, required: 2 }, { have: 0, required: 3 }] };
    const { container } = await draw(<CommitteeChange />, sessionWith({ company: 'c-1' }));
    expect([...container.querySelectorAll('[data-change-owed] li')].map((li) => li.textContent)).toEqual(['1 of 2 signed', '0 of 3 signed']);
    expect(container.querySelectorAll('[data-change-owed][data-slot=section] > ul > [data-slot=section-row]')).toHaveLength(2);
  });

  /* RED WHEN: the words that tell a person what the super admins can do without the signers are lost from the component. */
  it('says what the super admins can do without the signers', async () => {
    const { container } = await draw(<CommitteeChange />, sessionWith({ company: 'c-1' }));
    expect(container.textContent).toContain(EN['committeeChange.what']);
    expect(EN['committeeChange.what']).toMatch(/without the signers, they can change any of those rules, and so take money out of any vault/i);
  });
});

describe('signing a change owed', () => {
  /* RED WHEN: a change is signed without the "Confirm in your account" step in front of it, or what was signed is not said, or the page is not told something changed. */
  it('asks to confirm in the account before anything is signed, then says it, and tells the page', async () => {
    state.handover = { of: 'change-owed', signed: [{ have: 1, required: 2 }] };
    const onChanged = vi.fn();
    const { container } = await draw(<CommitteeChange onChanged={onChanged} />, sessionWith({ company: 'c-1' }));
    await act(async () => { fireEvent.click(q(container, '[data-action=sign-change]')!); await settle(); });
    expect(state.acted).toEqual([]);
    expect(q(container, '[data-slot=confirm-in-your-account]')!.textContent).toContain(EN['committeeChange.confirm']);
    await act(async () => { fireEvent.click(confirmButton(container)); await settle(); });
    expect(state.acted).toEqual([JSON.stringify(['sign-change', 'u1', 'c-1'])]);
    expect(q(container, '[data-acted]')!.textContent).toBe(EN['committeeChange.done']);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  /* RED WHEN: cancelling the confirmation signs anyway. */
  it('signs nothing when the confirmation is cancelled', async () => {
    state.handover = { of: 'change-owed', signed: [{ have: 1, required: 2 }] };
    const { container } = await draw(<CommitteeChange />, sessionWith({ company: 'c-1' }));
    await act(async () => { fireEvent.click(q(container, '[data-action=sign-change]')!); await settle(); });
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === EN['kit.confirm.cancel'])!); await settle(); });
    expect(state.acted).toEqual([]);
    expect(q(container, '[data-slot=confirm-in-your-account]')).toBeNull();
  });

  /* RED WHEN: a line saying something was sent is shown beside a company already held. */
  it('says nothing pending once the company is held', async () => {
    state.handover = { of: 'change-owed', signed: [{ have: 1, required: 2 }] };
    const { container } = await draw(<CommitteeChange />, sessionWith({ company: 'c-1' }));
    state.handover = { of: 'held' };
    await act(async () => { fireEvent.click(q(container, '[data-action=sign-change]')!); await settle(); });
    await act(async () => { fireEvent.click(confirmButton(container)); await settle(); });
    expect(q(container, '[data-acted]')).toBeNull();
    expect(q(container, '[data-holds]')!.textContent).toBe(EN['committeeChange.holds.held']);
  });

  /* RED WHEN: a refusal of the signing is not said by name, or is said as a success. */
  it('says a refusal by name, and not as done', async () => {
    state.handover = { of: 'change-owed', signed: [{ have: 1, required: 2 }] };
    state.signed = { of: 'refused', why: 'nothing-to-sign' };
    const { container } = await draw(<CommitteeChange />, sessionWith({ company: 'c-1' }));
    await act(async () => { fireEvent.click(q(container, '[data-action=sign-change]')!); await settle(); });
    await act(async () => { fireEvent.click(confirmButton(container)); await settle(); });
    expect(q(container, '[data-refusal=nothing-to-sign]')).not.toBeNull();
    expect(q(container, '[data-acted]')).toBeNull();
  });
});
