import { describe, expect, it, vi } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { ActIntent } from 'midnight-identity/profile/request';
import { seatAt } from '../keyring/seat-at.js';
import { FOUNDING_SEAT, foundingSeatOf } from '../keyring/founding-seat.js';
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import type { Keyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { StepContext } from './definition.js';
import { firstReadsAnswered, stepOverItsCall } from './step-views.test-support.js';
import { pinnedIn } from './seats-the-words-make.test-support.js';
import type { RegistryReads } from '../chain/private-registry-on-chain.js';
import { ACCOUNT_STATE, NETWORK, REGISTRY_STATE, entryFor, leafOf, registryWorld, type Held } from '../chain/registry-entries.test-support.js';

/*
 * **EVERY REACH OF A COMPANY IS HELD TO THE ACCOUNT ITS LABEL IS PINNED TO, AND TO THE SEAT THIS WALLET'S WORDS MAKE
 * FOR IT.** The head refuses before any read when the saved keys pin the label to another account, or when none are
 * open; with no pin it asks the registry once and refuses; once the seat is chosen, it must be the one the words make
 * for the pinned label, the founding seat 0 among them. A reach a step is handed is held to the pin too, and the head
 * names the seat's registry entry owed when the chain offers a way to write it.
 */

vi.mock('../../../../packages/web-shared/src/company-judges.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/company-judges.js')>()),
  companyJudges: () => ({ companyKeysFor: async () => ({}), openedHere: async () => ({ signers: [] }) }),
}));

/* The reads restore runs on, in place of this wallet's indexer and builder; each find the head asks for is counted. */
const live: { reads: RegistryReads | null; asked: number } = { reads: null, asked: 0 };
vi.mock('../chain/private-registry-on-chain.js', async (real) => {
  const actual = await real<typeof import('../chain/private-registry-on-chain.js')>();
  return {
    ...actual,
    liveRegistryReads: (...a: Parameters<typeof actual.liveRegistryReads>) => { live.asked += 1; return live.reads ?? actual.liveRegistryReads(...a); },
  };
});

const { companyReachFor, keptReach } = await import('./company-reach.js');

const identity = identityFromSecret(newSecret());
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const ELSEWHERE = 'c1'.repeat(32);
const LEAF = 'aa'.repeat(32);
const SCOPE = MidnightCommitments.allVaults().toLowerCase();
const seatOfTheWords = (n: number) => seatAt(identity, LABEL, n, SCOPE as never, MidnightCommitments);
const savedSeat = (n?: number, signingSecret = seatOfTheWords(n ?? FOUNDING_SEAT).signingSecret) => ({
  signerId: 's1', signingSecret, wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: SCOPE, ...(n === undefined ? {} : { seat: n }),
});
const why = (key: string) => ({ key });

const world = (kept: Keyring, o: { restoring?: Held; entry?: boolean } = {}) => {
  const reads: string[] = [];
  const owed: unknown[] = [];
  live.asked = 0;
  live.reads = o.restoring === undefined ? null : registryWorld(identity, {
    registries: { ['e1'.repeat(32)]: { state: REGISTRY_STATE, held: o.restoring } },
    accounts: {
      [ACCOUNT]: { label: LABEL, state: ACCOUNT_STATE, seats: [leafOf(identity, LABEL, 0)] },
      [ELSEWHERE]: { label: LABEL, state: ACCOUNT_STATE, seats: [leafOf(identity, LABEL, 0)] },
    },
  }).reads;
  let keys = kept;
  const chain = {
    indexer: { indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' },
    holders: async () => { reads.push('holders'); return { seats: [LEAF], committee: [], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT, founding: LEAF } as never; },
    callState: async () => null,
    ...(o.entry === true ? { registryEntry: { network: 'undeployed', build: () => { throw new Error('nothing is built here'); } } } : {}),
    ...(o.restoring === undefined ? {} : { registryEntry: { network: NETWORK, build: () => { throw new Error('the find reads through its reads only'); } } }),
  };
  const builder = { ownSeat: async () => LEAF } as never;
  const ctx = stepOverItsCall({
    intent: { name: 'give-vault-keys', fields: { record: 'acc_1', company: LABEL, account: ACCOUNT } } as ActIntent,
    asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret: newSecret() }, at: { step: 1, steps: 1 }, signal: new AbortController().signal,
    relay: async () => {},
    call: firstReadsAnswered(async () => ({ status: 200, body: { id: 'acc_1', companyLabel: LABEL, contractAddress: ACCOUNT, wrappedKeys: [] } })),
    tell: () => {},
    keyring: { open: () => ({ read: () => structuredClone(keys) }), keep: async (change: (k: Keyring) => Keyring) => { keys = change(structuredClone(keys)); } },
    registryEntryOwed: (write: unknown) => { owed.push(write); },
  }) as unknown as StepContext;
  return { ctx, reads, owed, chain, builder, reach: () => companyReachFor(ctx, chain as never, builder, why) };
};

describe('every reach of a company is held to the pin for its label', () => {
  it('refuses another account under a pinned label before anything is read, and saved keys that are not open', async () => {
    const w = world(pinnedIn({ accounts: { acc_1: savedSeat() } }, LABEL, ELSEWHERE));
    /* RED WHEN: a page naming a second account under a label this wallet pinned is read, or acted for. */
    await expect(w.reach()).rejects.toMatchObject({ words: { key: 'pinned-elsewhere' } });
    expect(w.reads).toEqual([]);
    const shut = world({ accounts: {} });
    /* RED WHEN: a reach runs with no saved keys open to read a pin from. */
    await expect(companyReachFor({ ...shut.ctx, keyring: null }, shut.chain as never, shut.builder, why)).rejects.toMatchObject({ words: { key: 'no-saved-keys' } });
    expect(shut.reads).toEqual([]);
  });

  it('with no pin, asks the registry once, takes the account it pins, and refuses when it pins none', async () => {
    const none = world({ accounts: { acc_1: savedSeat() } }, { restoring: {} });
    /* RED WHEN: a label with no pin is reached, or the registry is asked more than once for it. */
    await expect(none.reach()).rejects.toMatchObject({ words: { key: 'no-pin' } });
    expect(live.asked).toBe(1);
    /* RED WHEN: the account the person's own entry names is not then pinned and reached. */
    expect((await world({ accounts: { acc_1: savedSeat() } }, { restoring: { 0: entryFor(LABEL, ACCOUNT) } }).reach()).account).toBe(ACCOUNT);
    /* RED WHEN: the entry names another account for the label and the page's account is reached anyway. */
    await expect(world({ accounts: { acc_1: savedSeat() } }, { restoring: { 0: entryFor(LABEL, ELSEWHERE) } }).reach())
      .rejects.toMatchObject({ words: { key: 'pinned-elsewhere' } });
  });

  it('holds the seat to the one the words make for the pinned label: the founding seat 0, and a joiner\'s numbered seat', async () => {
    const founding = await foundingSeatOf(identity, LABEL);
    /* RED WHEN: the founding seat as saved, which names no number, is not seat 0 of the words. */
    expect((await world(pinnedIn({ accounts: { acc_1: { ...savedSeat(), signingSecret: founding.signingSecret } } }, LABEL, ACCOUNT)).reach()).leaf).toBe(LEAF);
    expect((await world(pinnedIn({ accounts: { acc_1: savedSeat(3) } }, LABEL, ACCOUNT)).reach()).leaf).toBe(LEAF);
    /* RED WHEN: a saved seat the words do not make for this label signs for the pinned company. */
    await expect(world(pinnedIn({ accounts: { acc_1: savedSeat(undefined, '01'.repeat(32)) } }, LABEL, ACCOUNT)).reach())
      .rejects.toMatchObject({ words: { key: 'seat-not-yours' } });
    await expect(world(pinnedIn({ accounts: { acc_1: savedSeat(2, seatOfTheWords(3).signingSecret) } }, LABEL, ACCOUNT)).reach())
      .rejects.toMatchObject({ words: { key: 'seat-not-yours' } });
  });

  it('holds a reach a step is handed to the pin, before that reach is asked', async () => {
    const w = world(pinnedIn({ accounts: {} }, LABEL, ELSEWHERE));
    const asked: string[] = [];
    const kept = keptReach(async () => { asked.push('reach'); return {} as never; });
    /* RED WHEN: a reach handed to the steps skips the pin check, so another account under a pinned label is acted for. */
    await expect(kept.at(w.ctx)).rejects.toMatchObject({ words: { key: 'act.give-vault-keys.why.pinned-elsewhere' } });
    expect(asked).toEqual([]);
    const shut = world({ accounts: {} });
    await expect(keptReach(async () => { asked.push('reach'); return {} as never; }).at({ ...shut.ctx, keyring: null })).rejects.toMatchObject({ words: { key: 'act.give-vault-keys.why.no-saved-keys' } });
    expect(asked).toEqual([]);
  });

  it('names the seat\'s registry entry owed when the chain offers a way to write it, and not when the entry was found written', async () => {
    const pinned = pinnedIn({ accounts: { acc_1: savedSeat() } }, LABEL, ACCOUNT);
    const w = world(pinned, { entry: true });
    await w.reach();
    /* RED WHEN: a seat pinned to the page's account and seated on the chain is reached with its entry never named owed. */
    expect(w.owed).toHaveLength(1);
    const marked = world(pinnedIn({ accounts: { acc_1: { ...savedSeat(), registry: { leaf: LEAF, written: true } } } }, LABEL, ACCOUNT), { entry: true });
    await marked.reach();
    /* RED WHEN: an entry already found written is named owed again. */
    expect(marked.owed).toEqual([]);
    const none = world(pinned);
    await none.reach();
    expect(none.owed).toEqual([]);
  });
});
