import { describe, expect, it, vi } from 'vitest';

/*
 * The service's client, its seat directory and its account-deploy reading load without the
 * ledger's WebAssembly: the ledger's objects are handed in. Loading the
 * ledger package here throws, so any module either one reaches, directly or
 * through another module, that loads it fails the import.
 */
vi.mock('@midnightntwrk/ledger-v9', () => { throw new Error('THE LEDGER WAS LOADED'); });
vi.mock('@midnightntwrk/onchain-runtime-v4', () => { throw new Error('THE LEDGER WAS LOADED'); });

describe('the modules that must load without the ledger\'s WebAssembly', () => {
  it('loads the service\'s client without loading the ledger, however far its imports reach', async () => {
    /* RED WHEN: the client, or any module it imports, loads the ledger, so the service cannot start without its WebAssembly. */
    const loaded = await import('./ledger.js');
    expect(typeof loaded.MidnightLedger).toBe('function');
  });

  it('loads the seat directory\'s judge, the service\'s directory route and the one rule for the seat bar without loading the ledger', async () => {
    /* RED WHEN: the judge, the route, or the rule a demotion or retirement is held to loads the ledger, so the service cannot judge one without its WebAssembly. */
    const judge = await import('./seat-directory.js');
    const route = await import('../server/seat-directory-route.js');
    const rule = await import('midnight-identity/profile/records-key');
    expect(typeof judge.applyFiling).toBe('function');
    expect(typeof route.directoryChainFromTheContract).toBe('function');
    expect([rule.seatBarOf(2, 3), rule.seatBarOf(3, 2), rule.seatBarOf(2, null)]).toEqual([3, 3, 2]);
  });

  it('loads the account-deploy reading without loading the ledger, however far its imports reach', async () => {
    /* RED WHEN: the account-deploy reading, or any module it imports, loads the ledger, so the wallet cannot read a deploy without its WebAssembly. */
    const loaded = await import('./account-deploy.js');
    expect(typeof loaded.readAccountDeploy).toBe('function');
  });
});
