// @vitest-environment jsdom
import { aViewOf } from './page-view.test-support.js';
import { describe, expect, it, vi } from 'vitest';
import type { Hex } from '../../../../src/core/crypto.js';

/*
 * THE RECOVERY WINDOW'S READ ON THE PAGE: the shared reader of the window, which the wallet also calls, is handed the
 * company's records through the opening's view and nothing else. The keyring, the seat and the shared reader are stood
 * in for; the page's view is its own, over the service in memory.
 */
const COMPANY = 'c-1';
const kr = vi.hoisted(() => ({
  named: { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) } as unknown, seat: null as unknown,
  reach: null as Record<string, unknown> | null,
}));
/* The page's own judges and view, kept as one module across each load of the code under test, so a view a test opens is the one it reads. */
vi.mock('./filing-judge.js', async (real) => ({
  ...(await real<typeof import('./filing-judge.js')>()),
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => ({ id: 'u1' }),
  forgetLocally: () => {},
  resumeSession: async () => null,
}));
vi.mock('vaults-web-shared/service-transport.js', async (real) => (await import('./service-in-memory.test-support.js')).withTheView({
  ...(await real<typeof import('vaults-web-shared/service-transport.js')>()),
  api: async (path: string) => (path.endsWith('/directory') ? { filings: [] } : kr.named),
}));
/* Who holds the company, as the person's wallet reads it for the view's first read. */
vi.mock('vaults-web-shared/wallet-asks.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-asks.js')>()),
  holdersFromTheWallet: async () => ({ holders: { committee: [], threshold: 1, seats: [], approvals: 1, adoptedVaults: [], vaultThresholds: [], policyBar: null }, indexer: null }),
}));
vi.mock('./vault-private-money.js', async (real) => ({
  ...(await real<typeof import('./vault-private-money.js')>()),
  seatAndRecordsHere: async () => kr.seat,
}));
vi.mock('vaults-web-shared/recovery-window-here.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/recovery-window-here.js')>()),
  recoveryWindowHere: async (reach: Record<string, unknown>) => { kr.reach = reach; return { inForce: { seconds: 600 }, waiting: null }; },
}));

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  return import('./recovery-window.js');
}

const key = (n: number): Hex => n.toString(16).padStart(64, '0') as Hex;
const HERE = {
  leaf: '01'.padEnd(64, '0'), company: 'label-1', account: 'c0'.repeat(32), viewingKey: {}, opened: { signers: [] }, mine: { signerId: 'x', wrappingSecret: key(9) },
  directory: async () => ({ dir: { seats: [] } }),
};

describe('the company\'s records the recovery window is read from', () => {
  /* RED WHEN: the shared reader the wallet also calls is handed a way to the company's records around the opening's view, so its read is not the one the check before a write compares. */
  it('are read through the opening\'s view, and the reader is handed no other way to the service', async () => {
    kr.seat = HERE;
    const { readRecoveryWindow, WINDOW_READ } = await load();
    const view = aViewOf(COMPANY);
    expect(await readRecoveryWindow('u1', view)).toEqual({ of: WINDOW_READ.read, inForce: 600, waiting: null });
    const reach = kr.reach!;
    expect(Object.keys(reach)).not.toContain('api');
    expect(Object.keys(reach)).not.toContain('send');
    const before = view.counts()['records'] ?? 0;
    await (reach['records'] as (asked: readonly { kind: string; id: string }[]) => Promise<unknown>)([{ kind: 'recovery-window', id: 'recovery-window' }]);
    expect((view.counts()['records'] ?? 0) - before).toBe(1);
  });
});
