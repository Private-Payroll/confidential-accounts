import { describe, expect, it, vi } from 'vitest';

/*
 * The service's client and its account-deploy reading load without the
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

  it('loads the account-deploy reading without loading the ledger, however far its imports reach', async () => {
    /* RED WHEN: the account-deploy reading, or any module it imports, loads the ledger, so the wallet cannot read a deploy without its WebAssembly. */
    const loaded = await import('./account-deploy.js');
    expect(typeof loaded.readAccountDeploy).toBe('function');
  });
});
