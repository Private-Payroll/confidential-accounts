/*
 * One vault whose state the indexer cannot give stops only its own secret change: changing the vaults' secrets goes on
 * for every other vault, and that one vault is named as not changed, never as owing nothing.
 */
import { describe, expect, it } from 'vitest';
import { ADA } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { aCompanyOf, runIntent, VAULTS_UNREADABLE } from './company-harness.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });

describe('A VAULT THAT CANNOT BE READ STOPS ONLY ITS OWN SECRET CHANGE', { timeout: 160_000 }, () => {
  it('changing the vaults\' secrets goes on for every vault but the one that cannot be read', async () => {
    const [readable, unreadable] = company.vaults();
    VAULTS_UNREADABLE.add(unreadable!.toLowerCase());
    try {
      const run = await runIntent('rotate-vault-secrets', { name: 'rotate-vault-secrets', fields: { ...company.fields } } as never, company, ADA.person);
      /* RED WHEN: one vault that cannot be read makes every vault come back not changed, so a leaver keeps the secret of every vault. */
      expect([run.told['vaultsNotChanged'], run.told['vaultsOwed'], run.told['vaultsWaiting']]).toEqual([1, 0, 0]);
      expect(company.vaults()).toEqual([readable, unreadable]);
    } finally {
      VAULTS_UNREADABLE.clear();
    }
  });
});
