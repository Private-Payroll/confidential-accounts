// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { SessionProvider, type Session } from '../session.js';
import { VIEWS } from '../pages.js';

/*
 * THE FINISHING STEP WHEN THE SERVICE CANNOT BE READ, drawn with the real adapters (the creation read and the look
 * at the company) and only the shared keyring stood in for at its functions: what the service answers to the read of
 * the company's creation is set by each test, and the screen is read.
 */
/* Set before any module is loaded, since the wallet's origin is read when the adapters are first loaded. */
vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180'); });
const kr = vi.hoisted(() => ({
  who: null as { id: string } | null,
  /** What the service does when the creation of a company is read. */
  answer: (async () => { throw new Error('unset'); }) as () => Promise<unknown>,
  asked: 0,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => {
  const keyring = await real<typeof import('vaults-web-shared/keyring.js')>();
  return {
    ...keyring,
    currentUser: () => kr.who,
    forgetLocally: () => { kr.who = null; },
    resumeSession: async () => kr.who,
    canOpenCompanies: () => true,
    /* A company these saved keys keep, so a standing read shows where its action stands. */
    companyBeingCreated: () => true,
    companyBeingCreatedLabel: () => null,
    companyAwaitingItsSecondPress: (id: string) => ({ accountId: id, account: null }),
    companyCreationStanding: async () => { kr.asked += 1; return kr.answer(); },
  };
});
vi.mock('../adapters/vault-builder.js', () => ({ theCreationBuilder: async () => null }));

const { AuthError } = await import('vaults-web-shared/keyring.js');
const { FinishCompany } = await import('./finish-company.js');
const { SERVICE_READ_BOUND_MS, SERVICE_READ_BOUND_SECONDS } = await import('../adapters/creation-standing.js');

const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../locales/en.json'), 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const READING = 'Reading where the company stands.';
const BOUND = 20_000;

const sessionWith = (over: Partial<Session> = {}): Session => ({
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(),
  viewer: { signedIn: true, view: VIEWS.employee, signs: false }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
  choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}), ...over,
});
const draw = (session: Session) => render(
  <KitProvider languages={LANGUAGES} pick="en">
    <SessionProvider session={session}><FinishCompany leadTo={() => {}} onChanged={() => {}} /></SessionProvider>
  </KitProvider>,
);
/** Lets every promise the screen is waiting on settle, with the clock held. */
const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const button = (c: HTMLElement, action: string) => c.querySelector(`[data-action=${action}]`) as HTMLElement | null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.assign(kr, { who: { id: 'u1' }, asked: 0, answer: async () => { throw new Error('unset'); } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the finishing step when the service cannot be read', () => {
  /* RED WHEN: a read the service refuses as signed out leaves the step on its reading words, or offers no way to sign in again. */
  it('says the person is signed out, and offers Sign in again, when the service refuses the read as signed out', async () => {
    kr.answer = async () => { kr.who = null; throw new AuthError('not signed in'); };
    const session = sessionWith();
    const view = draw(session);
    await settle();
    expect(view.container.textContent).not.toContain(READING);
    expect(view.container.querySelector('[data-signed-out]')?.textContent).toContain(EN['setup.finishCompany.signedOut']);
    const again = button(view.container, 'sign-in-again');
    expect(again?.textContent).toBe('Sign in again');
    fireEvent.click(again!);
    expect(session.signOut).toHaveBeenCalledTimes(1);
  });

  /* RED WHEN: a person the keyring has already forgotten is shown the reading words on the next look, or is given no Sign in again button. */
  it('offers Sign in again on the next look too, when the keyring has already forgotten the sign-in', async () => {
    kr.who = null;
    const view = draw(sessionWith());
    await settle();
    expect(view.container.textContent).not.toContain(READING);
    expect(view.container.textContent).toContain(EN['act.refused.notSignedIn']);
    expect(button(view.container, 'sign-in-again')?.textContent).toBe('Sign in again');
  });

  /* RED WHEN: a read the service answers with an error leaves the step on its reading words, or says nothing of what failed. */
  it('says the read failed, at once, when the service answers the read with an error', async () => {
    kr.answer = async () => { throw new Error('request failed: 502'); };
    const view = draw(sessionWith());
    await settle();
    expect(view.container.textContent).not.toContain(READING);
    expect(view.container.querySelector('[data-unread]')?.textContent).toContain('could not be read');
    expect(button(view.container, 'try-again')).not.toBeNull();
    expect(button(view.container, 'sign-in-again')).toBeNull();
  });

  /* RED WHEN: a read the service never answers keeps the step on its reading words past the bound, or gives up before it. */
  it('says the read failed once the bound has passed with no answer from the service, and not before', async () => {
    expect(SERVICE_READ_BOUND_MS).toBe(BOUND);
    expect(SERVICE_READ_BOUND_SECONDS).toBe(String(BOUND / 1000));
    kr.answer = () => new Promise<never>(() => {});
    const view = draw(sessionWith());
    await settle(BOUND - 1);
    expect(view.container.textContent).toContain(READING);
    expect(view.container.querySelector('[data-unread]')).toBeNull();
    await settle(1);
    expect(view.container.textContent).not.toContain(READING);
    expect(view.container.querySelector('[data-unread]')?.textContent).toContain(`within ${BOUND / 1000} seconds`);
  });

  /* RED WHEN: Try again after a failed read does not read the service again, or a service that has come back is still shown as unread. */
  it('reads the service again on Try again, and shows where the company stands once it answers', async () => {
    kr.answer = async () => { throw new Error('request failed: 502'); };
    const view = draw(sessionWith());
    await settle();
    expect(kr.asked).toBe(1);
    kr.answer = async () => ({ account: null, state: 'deploy-sent' });
    fireEvent.click(button(view.container, 'try-again')!);
    await settle();
    expect(kr.asked).toBe(2);
    expect(view.container.querySelector('[data-unread]')).toBeNull();
    expect(view.container.querySelector('[data-interrupted]')?.getAttribute('data-interrupted')).toBe('2');
  });
});
