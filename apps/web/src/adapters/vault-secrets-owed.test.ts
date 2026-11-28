// @vitest-environment jsdom
import { aViewOf } from './page-view.test-support.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * THE SIGNERS PAGE'S READ, ON LOAD, OF WHICH VAULTS OWE A NEW SECRET: a vault whose secret the network shows was set
 * before a signer's removal is named, one the network could not be read for is named as unread, and nothing is ever
 * counted as owing nothing because a read failed. The keyring, the person's wallet and the vault worker are stood in
 * for; which vault owes a change is the product's own compare.
 */
const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const SET = 'e5'.repeat(32);
const kr = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  named: { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) } as unknown,
  adopted: [] as string[],
  wallet: null as Error | null,
  indexer: 'http://indexer-1' as string | null,
  /** Each vault's secret commitment on the network, the account's removal count, and the count when each secret was set. */
  commitment: {} as Record<string, string>,
  removals: 0,
  setAt: {} as Record<string, number>,
  unreadable: new Set<string>(),
  historyAsked: 0,
  resume: null as Error | null,
  offChain: new Set<string>(),
  vaultAsks: 0,
  vaultsFail: false,
  /** Vaults whose state the indexer cannot give: any ask naming one fails. */
  stateUnreadable: new Set<string>()
}));
/* The page's own judges and view, kept as one module across each load of the code under test, so a view a test opens is the one it reads. */
vi.mock('./filing-judge.js', async (real) => ({
  ...(await real<typeof import('./filing-judge.js')>())
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.user,
  forgetLocally: () => {},
  resumeSession: async () => {
    if (kr.resume !== null) throw kr.resume;
    return null;
  }
}));
vi.mock('vaults-web-shared/service-transport.js', async (real) =>
  (await import('./service-in-memory.test-support.js')).withTheView({
    ...(await real<typeof import('vaults-web-shared/service-transport.js')>()),
    api: async (path: string) => (path.endsWith('/directory') ? { filings: [] } : kr.named)
  })
);
vi.mock('vaults-web-shared/wallet-asks.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-asks.js')>()),
  holdersFromTheWallet: async () => {
    if (kr.wallet !== null) throw kr.wallet;
    return {
      holders: {
        adoptedVaults: kr.adopted,
        committee: [],
        threshold: 1,
        seats: [],
        approvals: 1,
        vaultThresholds: [],
        policyBar: null
      },
      indexer: kr.indexer === null ? null : { indexerUri: kr.indexer, indexerWsUri: `${kr.indexer}/ws` }
    };
  }
}));
vi.mock('./vault-builder.js', () => ({
  theVaultBuilder: async () => ({
    vaultsOnChain: async ({ vaults }: { vaults: readonly string[] }) => {
      kr.vaultAsks += 1;
      if (kr.vaultsFail) throw new Error('the indexer did not answer');
      if (vaults.some((v) => kr.stateUnreadable.has(v))) throw new Error("a vault's state could not be read");
      return vaults.map((vault) => ({
        onChain: !kr.offChain.has(vault),
        state: 'st',
        notesFromThisBuild: true,
        everCreated: [],
        nonceCommitment: kr.commitment[vault]
      }));
    },
    chainAtOneBlock: async ({ vault }: { vault: string }) => {
      if (kr.unreadable.has(vault)) throw new Error('the indexer did not answer');
      return { blockHash: 'h', accountState: 'as', vaultState: 'vs', zswapState: 'zs', parameters: 'p' };
    },
    startStanding: async () => ({ standing: { removals: kr.removals } }),
    secretSetAt: async ({ vault }: { vault: string }) => {
      kr.historyAsked += 1;
      return kr.setAt[vault]!;
    }
  })
}));

const { vaultSecretsOwed } = await import('./vault-secrets-owed.js');

let indexers = 0;
beforeEach(() => {
  kr.user = { id: 'u1' };
  kr.named = { companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) };
  kr.wallet = null;
  /* Each test reads at its own indexer: when a secret was set never changes, so a device keeps it per indexer. */
  indexers += 1;
  kr.indexer = `http://indexer-${indexers}`;
  kr.adopted = [A, B];
  kr.commitment = { [A]: SET, [B]: SET };
  kr.removals = 1;
  kr.setAt = { [A]: 0, [B]: 1 };
  kr.unreadable = new Set();
  kr.historyAsked = 0;
  kr.resume = null;
  kr.offChain = new Set();
  kr.vaultAsks = 0;
  kr.vaultsFail = false;
  kr.stateUnreadable = new Set();
});

describe('which vaults owe a new secret, as the signers page reads it on load', () => {
  it("names a vault whose secret was set before a signer's removal, and not one set after it", async () => {
    expect(
      await vaultSecretsOwed('u1', aViewOf('c-1')),
      'RED WHEN: after a reload the page does not name a vault a signer who left can still open'
    ).toEqual({ of: 'read', owed: [A], unread: [] });
    expect(kr.vaultAsks, 'RED WHEN: each vault is read from the network in an ask of its own').toBe(1);
  });

  it('names every vault unread, never owing nothing, when the one read of the vaults fails', async () => {
    kr.vaultsFail = true;
    expect(
      await vaultSecretsOwed('u1', aViewOf('c-1')),
      'RED WHEN: a failed read of the vaults is taken as no vault owing a secret'
    ).toEqual({ of: 'read', owed: [], unread: [A, B] });
  });

  it("reads every other vault when one vault's state cannot be read, and names only that one unread", async () => {
    kr.stateUnreadable = new Set([B]);
    expect(
      await vaultSecretsOwed('u1', aViewOf('c-1')),
      'RED WHEN: one vault that cannot be read leaves every vault unread, so a vault owing a secret goes unnamed'
    ).toEqual({ of: 'read', owed: [A], unread: [B] });
    expect(kr.vaultAsks, 'RED WHEN: the vaults are read one by one when their one ask answers').toBe(3);
  });

  it('names a vault the network could not be read for as unread, never as owing nothing', async () => {
    kr.unreadable = new Set([A]);
    expect(
      await vaultSecretsOwed('u1', aViewOf('c-1')),
      'RED WHEN: a vault whose read failed is counted as owing nothing'
    ).toEqual({ of: 'read', owed: [], unread: [A] });
  });

  it('says the whole read failed when the wallet does not say which vaults the company holds, or names no indexer', async () => {
    kr.wallet = new Error('the wallet did not answer');
    expect(
      await vaultSecretsOwed('u1', aViewOf('c-1')),
      'RED WHEN: a wallet that did not answer reads as no vault owing anything'
    ).toEqual({ of: 'unread' });
    kr.wallet = null;
    kr.indexer = null;
    expect(await vaultSecretsOwed('u1', aViewOf('c-1'))).toEqual({ of: 'read', owed: [], unread: [A, B] });
  });

  it('says the whole read failed, and never rejects, when the service cannot be asked who is signed in', async () => {
    kr.user = null;
    kr.resume = new TypeError('Failed to parse URL from /api/me');
    expect(
      await vaultSecretsOwed('u1', aViewOf('c-1')),
      "RED WHEN: the page's read on load rejects, unhandled, where the service could not be reached"
    ).toEqual({ of: 'unread' });
  });

  it('names a vault the network does not show yet as unread, never as owing nothing', async () => {
    kr.offChain = new Set([A]);
    expect(
      await vaultSecretsOwed('u1', aViewOf('c-1')),
      'RED WHEN: a vault the chain does not show yet is counted as owing nothing'
    ).toEqual({ of: 'read', owed: [], unread: [A] });
  });

  it('owes nothing for a vault whose secret is not started, and reads no history where the company removed nobody', async () => {
    kr.commitment = { [A]: '00'.repeat(32), [B]: SET };
    kr.removals = 0;
    expect(await vaultSecretsOwed('u1', aViewOf('c-1'))).toEqual({ of: 'read', owed: [], unread: [] });
    expect(
      kr.historyAsked,
      "RED WHEN: every page load reads the network's history of every vault though no signer was ever removed"
    ).toBe(0);
  });

  it('reads nothing for a person who is not signed in, or a company with no account yet', async () => {
    kr.user = null;
    expect(await vaultSecretsOwed('u1', aViewOf('c-1'))).toBeNull();
    kr.user = { id: 'u1' };
    kr.named = { companyLabel: null, contractAddress: null };
    expect(await vaultSecretsOwed('u1', aViewOf('c-1'))).toBeNull();
  });
});
