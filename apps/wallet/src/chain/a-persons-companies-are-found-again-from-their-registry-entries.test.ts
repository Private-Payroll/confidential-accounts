import { describe, expect, it } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel, type AccountAddress } from 'midnight-identity/profile/company-label';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import type { Hex } from '../../../../src/core/crypto.js';
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import { seatAt } from '../keyring/seat-at.js';
import { ABSENT_IN_A_ROW, authorityPassedOver, registryEntriesFound } from './private-registry-on-chain.js';
import {
  ACCOUNT_STATE,
  ADOPT_V2,
  ADOPT_V3,
  NETWORK,
  PUT,
  REGISTRY_STATE,
  SECOND_REGISTRY_STATE,
  STRANGER_V2,
  STRANGER_V3,
  entryFor,
  leafOf,
  registryWorld,
  stateHex
} from './registry-entries.test-support.js';

/*
 * **A PERSON'S COMPANIES ARE FOUND AGAIN FROM THEIR OWN REGISTRY ENTRIES, AND ONLY WHERE THE CHAIN BEARS THEM OUT.** A
 * registry is read only when no one holds it and its key is released; the person's tags are walked until twenty in a
 * row are absent; an entry is believed only when its account carries its label, holds released keys in every slot,
 * and seats the entry's seat now. Two believed accounts under one label are a clash, answered with both fingerprints.
 */

const identity = identityFromSecret(newSecret());
const LABEL = drawCompanyLabel();
const OTHER = drawCompanyLabel();
const A = 'a1'.repeat(32) as AccountAddress;
const B = 'b2'.repeat(32) as AccountAddress;
const FIRST = 'e1'.repeat(32);
const SECOND = 'e2'.repeat(32);
const seated = (label = LABEL, n = 0) => [leafOf(identity, label, n)];
const find = (w: ReturnType<typeof registryWorld>) => registryEntriesFound(identity, NETWORK, w.reads);

describe("a person's companies found again from their registry entries", () => {
  it('finds the company an entry names when the chain bears it out, reading nothing from our service', async () => {
    const w = registryWorld(identity, {
      registries: { [FIRST]: { state: REGISTRY_STATE, held: { 0: entryFor(LABEL, A) } } },
      accounts: { [A]: { label: LABEL, state: ACCOUNT_STATE, seats: seated() } }
    });
    const found = await find(w);
    /* RED WHEN: an entry the chain bears out is not found, or is found without its fingerprint and released version. */
    expect(found).toMatchObject({
      of: 'read',
      clashes: [],
      passedOver: [],
      companies: [
        {
          label: LABEL,
          account: A,
          fingerprint: companyFingerprint(LABEL, A),
          version: 4,
          entries: [entryFor(LABEL, A)]
        }
      ]
    });
  });

  it('believes nothing of a seat that has left: its entry is neither found nor a clash', async () => {
    const w = registryWorld(identity, {
      registries: { [FIRST]: { state: REGISTRY_STATE, held: { 0: entryFor(LABEL, A), 1: entryFor(LABEL, B, 2) } } },
      accounts: {
        [A]: { label: LABEL, state: ACCOUNT_STATE, seats: ['77'.repeat(32)] },
        [B]: { label: LABEL, state: ACCOUNT_STATE, seats: seated(LABEL, 2) }
      }
    });
    const found = await find(w);
    /* RED WHEN: an entry whose seat is no longer among the account's seats is believed, here as a clash with the live one. */
    expect(found).toMatchObject({ of: 'read', clashes: [], companies: [{ label: LABEL, account: B }] });
  });

  it('answers two accounts under one label as a clash with both fingerprints, and neither as found', async () => {
    const w = registryWorld(identity, {
      registries: {
        [FIRST]: {
          state: REGISTRY_STATE,
          held: { 0: entryFor(LABEL, A), 1: entryFor(LABEL, B), 2: entryFor(OTHER, A) }
        }
      },
      accounts: {
        [A]: { label: LABEL, state: ACCOUNT_STATE, seats: seated() },
        [B]: { label: LABEL, state: ACCOUNT_STATE, seats: seated() }
      }
    });
    const found = await find(w);
    /* RED WHEN: one of two accounts under one label is found, or the clash does not show both fingerprints. */
    expect(found).toMatchObject({
      of: 'read',
      companies: [],
      clashes: [
        {
          label: LABEL,
          accounts: [
            { account: A, fingerprint: companyFingerprint(LABEL, A) },
            { account: B, fingerprint: companyFingerprint(LABEL, B) }
          ]
        }
      ]
    });
  });

  it('passes over a registry held by any key, or by none at a threshold other than one, or whose put key is no released one, without reading it', async () => {
    const held = { 0: entryFor(LABEL, A) };
    const w = registryWorld(identity, {
      registries: {
        [FIRST]: { state: stateHex({ put: [PUT] }, 1, 1), held },
        [SECOND]: { state: stateHex({ put: [PUT] }, 0, 0), held },
        ['e3'.repeat(32)]: { state: stateHex({ put: [STRANGER_V3] }), held },
        ['e4'.repeat(32)]: { state: stateHex({ put: [STRANGER_V2, PUT] }), held }
      },
      accounts: { [A]: { label: LABEL, state: ACCOUNT_STATE, seats: seated() } }
    });
    const found = await find(w);
    /* RED WHEN: a registry someone could change, or one whose write is checked by a key of no released version, is read. */
    expect(found).toMatchObject({
      of: 'read',
      companies: [],
      passedOver: [
        { registry: FIRST, why: 'held' },
        { registry: SECOND, why: 'held' },
        { registry: 'e3'.repeat(32), why: 'not-released' },
        { registry: 'e4'.repeat(32), why: 'not-released' }
      ]
    });
    expect(w.asked.tags).toEqual([]);
  });

  it('files a registry whose authority could not be read as unread, never as held', () => {
    const authority = (committee: number, threshold: number) => ({
      state: 'read' as const,
      address: FIRST,
      authority: {
        committee: Array.from({ length: committee }, () => ({ tag: 'schnorr', value: 'ab'.repeat(32) })),
        threshold,
        counter: 0n,
        shape: committee === 0 ? ('no-one' as const) : ('one-key' as const),
        hasDuplicateMembers: false
      }
    });
    /* RED WHEN: an authority nobody could read is said to be held by someone, or let through. */
    expect(authorityPassedOver({ state: 'unreadable', address: FIRST, why: 'the state carries no authority' })).toBe(
      'unread'
    );
    expect(authorityPassedOver({ state: 'absent', address: FIRST, why: 'nothing there' })).toBe('unread');
    expect(authorityPassedOver(authority(1, 1))).toBe('held');
    expect(authorityPassedOver(authority(0, 1))).toBeNull();
  });

  it('refuses an account with a key of no released version in either slot of a circuit', async () => {
    for (const keys of [[STRANGER_V2, ADOPT_V3], [ADOPT_V2, STRANGER_V3], [ADOPT_V3]]) {
      const w = registryWorld(identity, {
        registries: { [FIRST]: { state: REGISTRY_STATE, held: { 0: entryFor(LABEL, A) } } },
        accounts: { [A]: { label: LABEL, state: stateHex({ adopt: keys }), seats: seated() } }
      });
      /* RED WHEN: an account whose circuit holds a hidden key in its other slot, or lacks one of its released keys, is believed. */
      expect(await find(w)).toMatchObject({ of: 'read', companies: [], clashes: [] });
    }
  });

  it('walks the tags until twenty in a row are absent: a shorter gap is walked past, twenty end the walk', async () => {
    const world = (second: number) =>
      registryWorld(identity, {
        registries: {
          [FIRST]: { state: REGISTRY_STATE, held: { 0: entryFor(LABEL, A), [second]: entryFor(OTHER, B) } }
        },
        accounts: {
          [A]: { label: LABEL, state: ACCOUNT_STATE, seats: seated() },
          [B]: { label: OTHER, state: ACCOUNT_STATE, seats: seated(OTHER) }
        }
      });
    const past = await find(world(ABSENT_IN_A_ROW));
    /* RED WHEN: a gap of nineteen absent tags ends the walk before the entry after it. */
    expect(past.of === 'read' && past.companies.map((c) => c.label)).toEqual([LABEL, OTHER]);
    const ended = await find(world(ABSENT_IN_A_ROW + 1));
    /* RED WHEN: the walk goes on past twenty absent tags in a row. */
    expect(ended.of === 'read' && ended.companies.map((c) => c.label)).toEqual([LABEL]);
  });

  it('answers a network that lists no registry in so many words, reading nothing', async () => {
    const w = registryWorld(identity, { registries: {}, accounts: {} });
    /* RED WHEN: a network with no registry is an error, or anything is read for it. */
    expect(await find(w)).toEqual({ of: 'no-registries', network: NETWORK });
    expect(w.asked.states).toEqual([]);
  });

  it('names an account that could not be read as unread, beside the ones that were', async () => {
    const w = registryWorld(identity, {
      registries: { [FIRST]: { state: REGISTRY_STATE, held: { 0: entryFor(LABEL, A), 1: entryFor(LABEL, B) } } },
      accounts: {
        [A]: { label: LABEL, state: ACCOUNT_STATE, seats: seated() },
        [B]: { label: LABEL, state: ACCOUNT_STATE, seats: seated() }
      },
      unread: [B]
    });
    /* RED WHEN an account whose state read failed is not believed in silence: the other account of a clash would then be found alone. */
    expect(await find(w)).toMatchObject({
      of: 'read',
      passedOver: [{ registry: B, why: 'unread' }],
      companies: [{ account: A }],
      clashes: []
    });
  });

  it('names a registry that could not be read, and still reads the others', async () => {
    const w = registryWorld(identity, {
      registries: {
        [FIRST]: { state: REGISTRY_STATE, held: {} },
        [SECOND]: { state: SECOND_REGISTRY_STATE, held: { 0: entryFor(LABEL, A) } }
      },
      accounts: { [A]: { label: LABEL, state: ACCOUNT_STATE, seats: seated() } },
      unread: [FIRST]
    });
    /* RED WHEN: an unread registry is read as empty, or stops the others being read. */
    expect(await find(w)).toMatchObject({
      of: 'read',
      passedOver: [{ registry: FIRST, why: 'unread' }],
      companies: [{ account: A }]
    });
  });
});

describe('a seat is believed at the scope its entry names or at every vault', () => {
  const NARROW = '77'.repeat(32) as Hex;
  const narrowEntry = { ...entryFor(LABEL, A), scope: NARROW };
  const seat = seatAt(identity, LABEL, 0, NARROW, MidnightCommitments);
  const over = (seats: readonly string[]) =>
    registryWorld(identity, {
      registries: { [FIRST]: { state: REGISTRY_STATE, held: { 0: narrowEntry } } },
      accounts: { [A]: { label: LABEL, state: ACCOUNT_STATE, seats } }
    });

  it('HOLDS TWO DIFFERENT LEAVES FOR A NARROW SCOPE', () => {
    expect(seat.leaf).not.toBe(seat.leafAtAll);
  });

  it("FINDS THE COMPANY WHEN THE CHAIN HOLDS THE SEAT AT THE ENTRY'S SCOPE", async () => {
    /* RED WHEN the leaf at the entry's own scope is not accepted, or the entry's scope is read from the wrong field. */
    expect(await find(over([seat.leaf]))).toMatchObject({ companies: [{ account: A }] });
  });

  it('FINDS THE COMPANY WHEN THE CHAIN HOLDS THE SEAT AT EVERY VAULT', async () => {
    /* RED WHEN the every-vault leaf is not accepted. */
    expect(await find(over([seat.leafAtAll]))).toMatchObject({ companies: [{ account: A }] });
  });

  it('BELIEVES NEITHER WHEN THE CHAIN HOLDS NEITHER LEAF', async () => {
    /* RED WHEN a seat that is not among the account's is believed. */
    expect(await find(over([leafOf(identity, OTHER, 0)]))).toMatchObject({ companies: [], clashes: [] });
  });
});
