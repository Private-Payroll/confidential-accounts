import { describe, expect, it, vi } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel, type AccountAddress } from 'midnight-identity/profile/company-label';
import { registryEntriesFound } from './private-registry-on-chain.js';
import {
  ACCOUNT_STATE,
  NETWORK,
  REGISTRY_STATE,
  entryFor,
  leafOf,
  registryWorld
} from './registry-entries.test-support.js';

/*
 * A registry or an account whose verifier keys cannot be read is unread, which stops every restore pin; it is never
 * filed as one that is merely not a released version, which is only passed over.
 */
const unreadable: { address: string | null } = { address: null };
vi.mock('./published-build.js', async (real) => {
  const actual = await real<typeof import('./published-build.js')>();
  return {
    ...actual,
    publishedBuildOfState: (...a: Parameters<typeof actual.publishedBuildOfState>) =>
      a[1] === unreadable.address ? { of: 'unchecked' } : actual.publishedBuildOfState(...a)
  };
});

const identity = identityFromSecret(newSecret());
const LABEL = drawCompanyLabel();
const A = 'a1'.repeat(32) as AccountAddress;
const FIRST = 'e1'.repeat(32);
const world = () =>
  registryWorld(identity, {
    registries: { [FIRST]: { state: REGISTRY_STATE, held: { 0: entryFor(LABEL, A) } } },
    accounts: { [A]: { label: LABEL, state: ACCOUNT_STATE, seats: [leafOf(identity, LABEL, 0)] } }
  });

describe('keys that cannot be read', () => {
  it('MAKE A REGISTRY UNREAD, NOT NOT-RELEASED', async () => {
    unreadable.address = FIRST;
    try {
      /* RED WHEN a registry whose keys cannot be read is filed as not released. */
      expect(await registryEntriesFound(identity, NETWORK, world().reads)).toMatchObject({
        passedOver: [{ registry: FIRST, why: 'unread' }],
        companies: []
      });
    } finally {
      unreadable.address = null;
    }
  });

  it('MAKE AN ACCOUNT UNREAD, NOT UNBELIEVED', async () => {
    unreadable.address = A;
    try {
      /* RED WHEN an account whose keys cannot be read is simply not believed, so a restore pins around it. */
      expect(await registryEntriesFound(identity, NETWORK, world().reads)).toMatchObject({
        passedOver: [{ registry: A, why: 'unread' }],
        companies: []
      });
    } finally {
      unreadable.address = null;
    }
  });

  it('LEAVE THE FIND AS IT WAS WHEN EVERYTHING READS', async () => {
    expect(await registryEntriesFound(identity, NETWORK, world().reads)).toMatchObject({
      passedOver: [],
      companies: [{ account: A }]
    });
  });
});
