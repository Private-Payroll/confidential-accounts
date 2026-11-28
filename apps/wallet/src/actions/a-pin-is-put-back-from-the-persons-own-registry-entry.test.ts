import { describe, expect, it, vi } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel, type AccountAddress } from 'midnight-identity/profile/company-label';
import type { ActIntent } from 'midnight-identity/profile/request';
import type { Keyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import { registryEntriesFound, type RegistryFinder, type RegistryReads } from '../chain/private-registry-on-chain.js';
import {
  ACCOUNT_STATE,
  NETWORK,
  REGISTRY_STATE,
  SECOND_REGISTRY_STATE,
  entryFor,
  leafOf,
  registryWorld,
  type Held
} from '../chain/registry-entries.test-support.js';
import { companyReachHead } from './company-reach-head.js';
import { pinnedFor } from './company-pin.js';
import type { StepContext } from './definition.js';
import { pinRestoredFor, restoreFinderOf } from './pin-restored.js';
import { pinnedIn } from './seats-the-words-make.test-support.js';

/*
 * **A REACH THAT FINDS NO PIN PUTS ONE BACK FROM THE PERSON'S OWN REGISTRY ENTRY, ONLY WHERE THE CHAIN BEARS ONE ACCOUNT
 * OUT.** With our service stopped it still finds the company and pins it `restored`, and the reach carries on with
 * it. A seat that has left pins nothing; two accounts under one label pin neither, and nothing is pinned while a
 * registry could not be read; the reach then refuses by the clash's and the unread registry's own names; a label
 * already pinned is left as it is, and nothing is thrown.
 */

/* The reads the head's own restore runs on, in place of this wallet's indexer and builder, when a test sets them. */
const live: { reads: RegistryReads | null } = { reads: null };
vi.mock('../chain/private-registry-on-chain.js', async (real) => {
  const actual = await real<typeof import('../chain/private-registry-on-chain.js')>();
  return {
    ...actual,
    liveRegistryReads: (...a: Parameters<typeof actual.liveRegistryReads>) =>
      live.reads ?? actual.liveRegistryReads(...a)
  };
});

const identity = identityFromSecret(newSecret());
const LABEL = drawCompanyLabel();
const A = 'a1'.repeat(32) as AccountAddress;
const B = 'b2'.repeat(32) as AccountAddress;
const FIRST = 'e1'.repeat(32);
const SECOND = 'e2'.repeat(32);
const INDEXER = { indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' };

const worldOver = (held: Held, seats: { readonly a?: readonly string[]; readonly b?: readonly string[] } = {}) =>
  registryWorld(identity, {
    registries: { [FIRST]: { state: REGISTRY_STATE, held } },
    accounts: {
      [A]: { label: LABEL, state: ACCOUNT_STATE, seats: seats.a ?? [leafOf(identity, LABEL, 0)] },
      [B]: { label: LABEL, state: ACCOUNT_STATE, seats: seats.b ?? [leafOf(identity, LABEL, 0)] }
    }
  });
const finderOver = (held: Held, seats: { readonly a?: readonly string[]; readonly b?: readonly string[] } = {}) => {
  const w = worldOver(held, seats);
  const asked: string[] = [];
  const find: RegistryFinder = (who) => {
    asked.push('find');
    return registryEntriesFound(who, NETWORK, w.reads);
  };
  return { find, asked };
};

/* A step whose saved keys are open, and whose company's service and fee payer answer nothing: our service is stopped. */
const stepOver = (kept: Keyring, page: string = A) => {
  let keys = kept;
  const stopped = async (): Promise<never> => {
    throw new Error('our service is stopped');
  };
  const ctx = {
    intent: { name: 'give-vault-keys', fields: { record: 'acc_1', company: LABEL, account: page } } as ActIntent,
    held: { identity, secret: newSecret() },
    keyring: {
      open: () => ({ read: () => structuredClone(keys) }),
      keep: async (change: (k: Keyring) => Keyring) => {
        keys = change(structuredClone(keys));
      }
    },
    fees: { fee: stopped, feeDone: stopped }
  } as unknown as StepContext;
  return { ctx, keys: () => keys };
};

describe("a pin put back from the person's own registry entry", () => {
  it('with our service stopped, finds the company and pins it restored', async () => {
    const { find } = finderOver({ 0: entryFor(LABEL, A) });
    const step = stepOver({ accounts: {} });
    /* RED WHEN: the one account the chain bears out for the label is not pinned, or is pinned as anything but restored. */
    expect(await pinRestoredFor(step.ctx, LABEL, find)).toEqual({ of: 'pinned', account: A });
    expect(pinnedFor(step.ctx, LABEL)).toEqual({ of: 'pinned', account: A, from: 'restored' });
  });

  it('pins nothing for a seat that has left', async () => {
    const { find } = finderOver({ 0: entryFor(LABEL, A) }, { a: ['77'.repeat(32)] });
    const step = stepOver({ accounts: {} });
    /* RED WHEN: an entry whose seat is no longer seated puts a pin back. */
    expect(await pinRestoredFor(step.ctx, LABEL, find)).toEqual({ of: 'none' });
    expect(pinnedFor(step.ctx, LABEL)).toEqual({ of: 'none' });
  });

  it('pins neither of two accounts under one label', async () => {
    const { find } = finderOver({ 0: entryFor(LABEL, A), 1: entryFor(LABEL, B) });
    const step = stepOver({ accounts: {} });
    /* RED WHEN: either account of a clash is pinned. */
    expect(await pinRestoredFor(step.ctx, LABEL, find)).toEqual({ of: 'clash' });
    expect(pinnedFor(step.ctx, LABEL)).toEqual({ of: 'none' });
  });

  it('leaves a label already pinned as it is, reading nothing and throwing nothing', async () => {
    const { find, asked } = finderOver({ 0: entryFor(LABEL, A) });
    const step = stepOver(pinnedIn({ accounts: {} }, LABEL, B));
    /* RED WHEN: an entry moves, or throws over, a pin the label already has. */
    expect(await pinRestoredFor(step.ctx, LABEL, find)).toEqual({ of: 'already-pinned' });
    expect(pinnedFor(step.ctx, LABEL)).toEqual({ of: 'pinned', account: B, from: 'created' });
    expect(asked).toEqual([]);
  });

  it('pins nothing while a registry the network lists could not be read, or the find could not finish', async () => {
    const w = registryWorld(identity, {
      registries: {
        [FIRST]: { state: REGISTRY_STATE, held: {} },
        [SECOND]: { state: SECOND_REGISTRY_STATE, held: { 0: entryFor(LABEL, A) } }
      },
      accounts: { [A]: { label: LABEL, state: ACCOUNT_STATE, seats: [leafOf(identity, LABEL, 0)] } },
      unread: [FIRST]
    });
    const step = stepOver({ accounts: {} });
    /* RED WHEN: one account is pinned from a find that could not see a registry where a second account could sit. */
    expect(await pinRestoredFor(step.ctx, LABEL, (who) => registryEntriesFound(who, NETWORK, w.reads))).toEqual({
      of: 'unread'
    });
    expect(pinnedFor(step.ctx, LABEL)).toEqual({ of: 'none' });
    /* RED WHEN: a find that throws midway is thrown on, or pins anything. */
    expect(
      await pinRestoredFor(step.ctx, LABEL, async () => {
        throw new Error('the builder stopped');
      })
    ).toEqual({ of: 'unread' });
    expect(pinnedFor(step.ctx, LABEL)).toEqual({ of: 'none' });
  });

  it('pins neither account of a clash when one of the two could not be read', async () => {
    const w = registryWorld(identity, {
      registries: { [FIRST]: { state: REGISTRY_STATE, held: { 0: entryFor(LABEL, A), 1: entryFor(LABEL, B) } } },
      accounts: {
        [A]: { label: LABEL, state: ACCOUNT_STATE, seats: [leafOf(identity, LABEL, 0)] },
        [B]: { label: LABEL, state: ACCOUNT_STATE, seats: [leafOf(identity, LABEL, 0)] }
      },
      unread: [B]
    });
    const step = stepOver({ accounts: {} });
    /* RED WHEN the account that could be read is pinned alone because the other one's read failed. */
    expect(await pinRestoredFor(step.ctx, LABEL, (who) => registryEntriesFound(who, NETWORK, w.reads))).toEqual({
      of: 'unread'
    });
    expect(pinnedFor(step.ctx, LABEL)).toEqual({ of: 'none' });
  });

  it("pins nothing while a registry's state does not decode, and files it as unread, not as an unreleased registry", async () => {
    const w = registryWorld(identity, {
      registries: {
        [FIRST]: { state: '00ff00ff', held: {} },
        [SECOND]: { state: SECOND_REGISTRY_STATE, held: { 0: entryFor(LABEL, A) } }
      },
      accounts: { [A]: { label: LABEL, state: ACCOUNT_STATE, seats: [leafOf(identity, LABEL, 0)] } }
    });
    const find: RegistryFinder = (who) => registryEntriesFound(who, NETWORK, w.reads);
    /* RED WHEN: bytes that are no contract state are filed as a registry that is merely not released, which is passed over and lets the other registry's entry be pinned. */
    expect(await find(identity)).toMatchObject({ of: 'read', passedOver: [{ registry: FIRST, why: 'unread' }] });
    const step = stepOver({ accounts: {} });
    expect(await pinRestoredFor(step.ctx, LABEL, find)).toEqual({ of: 'unread' });
    expect(pinnedFor(step.ctx, LABEL)).toEqual({ of: 'none' });
  });

  it('a reach with no pin puts it back over its own chain, with our service stopped, and refuses a clash and an unread registry by their own names', async () => {
    const chain = {
      indexer: INDEXER,
      registryEntry: {
        network: NETWORK,
        build: () => {
          throw new Error('the find asks the builder only through its reads');
        }
      }
    };
    const headOver = async (held: Held, unread: readonly string[] = []) => {
      const w = registryWorld(identity, {
        registries: { [FIRST]: { state: REGISTRY_STATE, held }, [SECOND]: { state: SECOND_REGISTRY_STATE, held: {} } },
        accounts: {
          [A]: { label: LABEL, state: ACCOUNT_STATE, seats: [leafOf(identity, LABEL, 0)] },
          [B]: { label: LABEL, state: ACCOUNT_STATE, seats: [leafOf(identity, LABEL, 0)] }
        },
        unread
      });
      live.reads = w.reads;
      try {
        return await companyReachHead(
          stepOver({ accounts: {} }).ctx,
          (key: string): never => {
            throw new Error(key);
          },
          { seats: async () => [], leafOf: async () => '', chain }
        );
      } finally {
        live.reads = null;
      }
    };
    /* RED WHEN: the head of a reach does not restore over the chain it is given, so the action is refused with no pin. */
    expect((await headOver({ 0: entryFor(LABEL, A) })).pin).toEqual({ label: LABEL, account: A, from: 'restored' });
    /* RED WHEN: a clash is refused as a plain missing pin, whose words point at a seating the person cannot do. */
    await expect(headOver({ 0: entryFor(LABEL, A), 1: entryFor(LABEL, B) })).rejects.toThrow('label-clash');
    /* RED WHEN: a registry that could not be read is refused as a missing pin, not as something to try again. */
    await expect(headOver({ 0: entryFor(LABEL, A) }, [SECOND])).rejects.toThrow('registry-unread');
    /* RED WHEN: entries naming no account for the label are refused as anything but no pin. */
    await expect(headOver({})).rejects.toThrow('no-pin');
  });

  it("finds over a chain that carries the registry's doors, and over one that carries none restores nothing", () => {
    const build = () => {
      throw new Error('nothing is built until the find runs');
    };
    /* RED WHEN: a chain with the registry's doors gives the head no way to put a pin back. */
    expect(restoreFinderOf({ indexer: INDEXER, registryEntry: { network: NETWORK, build } })).toBeTypeOf('function');
    /* RED WHEN: a chain with none (a reader's) restores. */
    expect(restoreFinderOf({ indexer: INDEXER })).toBeNull();
  });
});
