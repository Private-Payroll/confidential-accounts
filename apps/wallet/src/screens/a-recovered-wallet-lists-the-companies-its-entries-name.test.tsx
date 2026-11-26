// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel, type AccountAddress } from 'midnight-identity/profile/company-label';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import { registryEntriesFound } from '../chain/private-registry-on-chain.js';
import { ACCOUNT_STATE, NETWORK, REGISTRY_STATE, entryFor, leafOf, registryWorld } from '../chain/registry-entries.test-support.js';
import { cleanup, render, screen } from '../testing/render.js';
import EN from '../locales/en.json' with { type: 'json' };
import { CompaniesFoundAgain } from './companies-found-again.js';

/*
 * **A WALLET RECOVERED FROM ITS PIECES LISTS THE COMPANIES ITS OWN ENTRIES NAME**, each with its fingerprint and what
 * the chain was checked for, and a clash with both fingerprints and neither kept. It never says a company is genuine,
 * and a network with no registry says so in words.
 */

const identity = identityFromSecret(newSecret());
const LABEL = drawCompanyLabel();
const A = 'a1'.repeat(32) as AccountAddress;
const B = 'b2'.repeat(32) as AccountAddress;
const FIRST = 'e1'.repeat(32);
const seated = { label: LABEL, state: ACCOUNT_STATE, seats: [leafOf(identity, LABEL, 0)] };
const finding = (held: Parameters<typeof registryWorld>[1]['registries'][string]['held']) => {
  const w = registryWorld(identity, { registries: { [FIRST]: { state: REGISTRY_STATE, held } }, accounts: { [A]: seated, [B]: seated } });
  return (who: typeof identity) => registryEntriesFound(who, NETWORK, w.reads);
};

afterEach(cleanup);

describe('a recovered wallet lists the companies its entries name', () => {
  it('shows each company found with its fingerprint and what was checked, and never calls it genuine', async () => {
    render(<CompaniesFoundAgain identity={identity} find={finding({ 0: entryFor(LABEL, A) })} />);
    /* RED WHEN: a company the chain bears out is not listed with its fingerprint. */
    expect(await screen.findByText(companyFingerprint(LABEL, A))).toBeTruthy();
    /* RED WHEN: the list says less than what was checked, or names no version. */
    expect(screen.getByText(EN['recover.found.checked'].replace('{version}', '4'))).toBeTruthy();
    /* RED WHEN: the list calls a company genuine, which no check here proves. */
    expect(document.body.textContent ?? '').not.toMatch(/genuine|verified|trusted/iu);
  });

  it('shows a clash with both fingerprints and keeps neither', async () => {
    render(<CompaniesFoundAgain identity={identity} find={finding({ 0: entryFor(LABEL, A), 1: entryFor(LABEL, B) })} />);
    /* RED WHEN: one account of a clash is hidden, or the clash is listed as a company found. */
    expect(await screen.findByText(EN['recover.found.clash'])).toBeTruthy();
    expect(screen.getByText(companyFingerprint(LABEL, A))).toBeTruthy();
    expect(screen.getByText(companyFingerprint(LABEL, B))).toBeTruthy();
    expect(document.querySelectorAll('[data-found-company]').length).toBe(0);
  });

  it('says in words that a network lists no registry', async () => {
    render(<CompaniesFoundAgain identity={identity} find={async () => ({ of: 'no-registries', network: 'preprod' })} />);
    /* RED WHEN: a network with no registry shows nothing, or an error. */
    expect(await screen.findByText(EN['recover.found.no-registries'].replace('{network}', 'preprod'))).toBeTruthy();
  });

  it('says the chain could not be read when the find fails, and lists nothing', async () => {
    render(<CompaniesFoundAgain identity={identity} find={async () => { throw new Error('the indexer did not answer'); }} />);
    /* RED WHEN: a failed find is silent, or listed as finding nothing. */
    expect(await screen.findByText(EN['recover.found.failed'])).toBeTruthy();
  });
});
