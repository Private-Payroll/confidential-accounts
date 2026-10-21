// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { SessionProvider, type Session } from '../session.js';
import { VIEWS } from '../pages.js';

/*
 * THE FINISHING STEP SAYS WHAT IS HAPPENING during its long waits: the stage in plain words, how long that stage has run
 * (read from the vault builder's proofs in progress while one runs), and how long it usually takes.
 */

vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180'); });
vi.mock('vaults-web-shared/keyring.js', async (real) => {
  const keyring = await real<typeof import('vaults-web-shared/keyring.js')>();
  return {
    ...keyring,
    currentUser: () => ({ id: 'u1' }),
    resumeSession: async () => ({ id: 'u1' }),
    canOpenCompanies: () => true,
    companyBeingCreated: () => null,
    companyBeingCreatedLabel: () => null,
    companyAwaitingItsSecondPress: () => null,
    companyCreationStanding: async () => ({ account: null, state: 'deploy-sent' }),
  };
});
vi.mock('../adapters/vault-builder.js', () => ({ theCreationBuilder: async () => null }));

const { FinishCompany } = await import('./finish-company.js');
const { builderIsUp } = await import('../adapters/proofs-running.js');
const { lane } = await import('../adapters/sends.js');
const { COMPANY_USUAL_SECONDS, COMPANY_PHASE } = await import('../adapters/usual-times.js');

const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../locales/en.json'), 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });

const session: Session = {
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(),
  viewer: { signedIn: true, view: VIEWS.employee, signs: false }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
  choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}), preferencesChanged: vi.fn(),
} as unknown as Session;
const draw = () => render(
  <KitProvider languages={LANGUAGES} pick="en">
    <SessionProvider session={session}><FinishCompany leadTo={() => {}} onChanged={() => {}} /></SessionProvider>
  </KitProvider>,
);
const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
/* One second at a time: the clock and the phase are read on each tick, so a change between ticks is seen at the tick after it. */
const everySecond = async (n: number): Promise<void> => { if (n > 0) { await settle(1000); await everySecond(n - 1); } };
const clockOf = (c: HTMLElement) => c.querySelector('[data-stage-clock]');
const proofStartedSecondsAgo = (seconds: number) => {
  const startedAt = Date.now() - seconds * 1000;
  const proofsInProgress = vi.fn(() => [{ ask: 'creation-again', circuit: null, startedAt, elapsedMs: Date.now() - startedAt }]);
  builderIsUp({ proofsInProgress } as never);
  return proofsInProgress;
};

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {}); builderIsUp({} as never); lane.sending = false; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); lane.sending = false; });

describe('the finishing step during its long waits', () => {
  /* RED WHEN: a proof running on this device is not said, its running time does not tick, or its usual duration is not stated. */
  it('says it is proving the account, how long the proof has run as it ticks, and how long that usually takes', async () => {
    const reads = proofStartedSecondsAgo(75);
    const view = draw();
    await settle();
    expect(reads).toHaveBeenCalled();
    const clock = clockOf(view.container)!;
    expect(clock.getAttribute('data-stage-clock')).toBe(COMPANY_PHASE.proving);
    expect(view.container.querySelector('[data-phase-words]')?.textContent).toBe(EN['setup.finishCompany.phase.proving']);
    expect(view.container.querySelector('[data-elapsed]')?.textContent).toBe('Running for 1:15.');
    expect(view.container.querySelector('[data-usual]')?.textContent).toBe('This usually takes about 2 minutes.');
    expect(clock.getAttribute('data-usual-seconds')).toBe(String(COMPANY_USUAL_SECONDS.proving));
    await settle(3000);
    expect(view.container.querySelector('[data-elapsed]')?.textContent).toBe('Running for 1:18.');
    await settle(60_000);
    expect(view.container.querySelector('[data-usual]')?.textContent).toBe(EN['stageProgress.longer']);
  });

  /* RED WHEN: sending the account is not told from waiting for the network, or neither shows a running time and a usual duration. */
  it('says it is sending the account while a send is going out, and waiting for the network after', async () => {
    const view = draw();
    lane.sending = true;
    await everySecond(2);
    expect(clockOf(view.container)?.getAttribute('data-stage-clock')).toBe(COMPANY_PHASE.sending);
    expect(view.container.querySelector('[data-phase-words]')?.textContent).toBe(EN['setup.finishCompany.phase.sending']);
    expect(view.container.querySelector('[data-usual]')?.textContent).toBe('This usually takes about 30 seconds.');
    lane.sending = false;
    await everySecond(4);
    expect(clockOf(view.container)?.getAttribute('data-stage-clock')).toBe(COMPANY_PHASE.waiting);
    expect(view.container.querySelector('[data-phase-words]')?.textContent).toBe(EN['setup.finishCompany.phase.waiting']);
    expect(view.container.querySelector('[data-elapsed]')?.textContent).toBe('Running for 0:03.');
    expect(view.container.querySelector('[data-usual]')?.textContent).toBe('This usually takes about a minute.');
    await everySecond(5);
    expect(view.container.querySelector('[data-elapsed]')?.textContent).toBe('Running for 0:08.');
  });
});
