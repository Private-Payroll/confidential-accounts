// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { CurrentPageProvider } from '../router.js';
import { PanelProvider } from '../shell/right-panel.js';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { SessionProvider, type Session } from '../session.js';
import { VIEWS } from '../pages.js';

/*
 * THE VAULT STEP SAYS WHAT IS HAPPENING while the vault is built and set up: each stage in plain words, how long it has
 * run (read from the vault builder's proofs in progress while one runs), and how long it usually takes.
 */

const stages = vi.hoisted(() => ({ show: null as ((s: string) => void) | null }));
vi.mock('../adapters/creation-standing.js', async (real) => ({
  ...(await real<typeof import('../adapters/creation-standing.js')>()),
  creationOf: vi.fn(async (company: string | null) => ({ company, standing: 'finished', awaitingSecondPress: false, kept: false, confirmedFinished: true, mark: null })),
  creationHere: vi.fn((company: string | null) => ({ company, standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null })),
}));
vi.mock('../adapters/create-vault.js', async (real) => ({
  ...(await real<typeof import('../adapters/create-vault.js')>()),
  readVaultReadiness: vi.fn(async () => ({ of: 'ready' })),
  createVault: vi.fn((_p: string, _c: string, onStage: (s: string) => void) => { stages.show = onStage; onStage('checking'); return new Promise<never>(() => {}); }),
}));

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const { CreateVault } = await import('./create-vault.js');
const { CREATING } = await import('../adapters/create-vault.js');
const { builderIsUp } = await import('../adapters/proofs-running.js');
const { VAULT_USUAL_SECONDS } = await import('../adapters/usual-times.js');

const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../locales/en.json'), 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const session = {
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(),
  viewer: { signedIn: true, view: VIEWS.employee, signs: false }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
  choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
} as unknown as Session;
const q = (c: HTMLElement, sel: string) => c.querySelector(sel) as HTMLElement | null;
const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

async function startCreating() {
  const view = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session}><PanelProvider><CurrentPageProvider id="setup"><CreateVault leadTo={() => {}} onChanged={() => {}} /></CurrentPageProvider></PanelProvider></SessionProvider>
    </KitProvider>,
  );
  await settle();
  await act(async () => { fireEvent.change(q(view.container, '[data-field=vault-name]')!, { target: { value: 'Payroll UK' } }); });
  await act(async () => { fireEvent.click(q(view.container, '[data-action=create-vault-now]')!); });
  await act(async () => { fireEvent.click(q(view.container, '[data-slot=confirm-in-your-account] button:last-of-type')!); });
  await settle();
  return view;
}

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {}); builderIsUp({} as never); stages.show = null; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the vault step while the vault is made', () => {
  /* RED WHEN: a stage shows no running time, the time does not tick, or its usual duration is not stated where one is known, or is stated for the stage whose time was never measured. */
  it('shows the stage words, the time the stage has run as it ticks, and how long it usually takes', async () => {
    const view = await startCreating();
    expect(q(view.container, '[data-stage]')?.textContent).toBe(EN['createVault.stage.checking']);
    expect(q(view.container, '[data-elapsed]')?.textContent).toBe('Running for 0:00.');
    expect(q(view.container, '[data-usual]')?.textContent).toBe(EN['stageProgress.noUsual']);
    await settle(3000);
    expect(q(view.container, '[data-elapsed]')?.textContent).toBe('Running for 0:03.');
    await act(async () => { stages.show!(CREATING.building); });
    await settle(2000);
    expect(q(view.container, '[data-stage]')?.textContent).toBe(EN['createVault.stage.building']);
    expect(q(view.container, '[data-elapsed]')?.textContent).toBe('Running for 0:02.');
    expect(q(view.container, '[data-usual]')?.textContent).toBe('This usually takes about 2 minutes.');
    await settle(10_000);
    expect(q(view.container, '[data-elapsed]')?.textContent).toBe('Running for 0:12.');
  });

  /* RED WHEN: a stage of the vault that has ended leaves no record in the development console with its name, measured seconds and the usual figure shown, one is written for the stage still running, or the stage running when the screen goes away is left unwritten. */
  it('writes one console record per stage when it ends, none for the stage that runs, and the last one when the screen goes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = await startCreating();
    await settle(3000);
    expect(warn).not.toHaveBeenCalled();
    await act(async () => { stages.show!(CREATING.building); });
    await settle(2000);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([{ stageTime: ['checking'], measuredSeconds: expect.closeTo(3, 0), usualShownSeconds: null }]);
    view.unmount();
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      { stageTime: ['checking'], measuredSeconds: expect.closeTo(3, 0), usualShownSeconds: null },
      { stageTime: ['building'], measuredSeconds: expect.closeTo(2, 0), usualShownSeconds: 120 },
    ]);
  });

  /* RED WHEN: the finished vault is timed as a stage of its own. */
  it('writes no record for done', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = await startCreating();
    await settle(3000);
    await act(async () => { stages.show!(CREATING.done); });
    await settle(1000);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([{ stageTime: ['checking'], measuredSeconds: expect.closeTo(3, 0), usualShownSeconds: null }]);
    view.unmount();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  /* RED WHEN: the vault step does not read the builder's proofs in progress, or shows a proof's running time as the stage's own. */
  it('reads the builder\'s proofs in progress and shows how long the proof has run', async () => {
    const startedAt = Date.now() - 100_000;
    const proofsInProgress = vi.fn(() => [{ ask: 'born-held-vault', circuit: null, startedAt, elapsedMs: Date.now() - startedAt }]);
    builderIsUp({ proofsInProgress } as never);
    const view = await startCreating();
    await act(async () => { stages.show!(CREATING.building); });
    await settle(1000);
    expect(proofsInProgress).toHaveBeenCalled();
    expect(q(view.container, '[data-stage]')?.textContent).toBe(EN['createVault.stage.building']);
    expect(q(view.container, '[data-elapsed]')?.textContent).toBe('Running for 1:41.');
    expect(q(view.container, '[data-usual]')?.textContent).toBe('This usually takes about 2 minutes.');
    expect(VAULT_USUAL_SECONDS[CREATING.building]).toBe(120);
  });

});
