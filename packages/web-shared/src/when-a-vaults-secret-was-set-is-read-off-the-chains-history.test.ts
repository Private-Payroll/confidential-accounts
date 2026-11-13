/**
 * WHEN A VAULT'S SECRET WAS SET IS READ OFF THE CHAIN'S OWN HISTORY: the vault step that first holds the commitment, and
 * the account's removal count in its last step in an earlier block. States stand in as plain objects, keyed by the
 * first byte of each step's state.
 */
import { describe, expect, it } from 'vitest';
import type { ContractHistoryEntry } from '../../../src/midnight/contract-history.js';
import { removalsWhenTheSecretWasSet } from './secret-set-on-the-chain.js';
import { removedSinceSet, secretMustChange } from './who-holds-the-vaults-secret.js';

const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const COUNT_KEY = bytes(0xee);
const FIRST = bytes(1); const SECOND = bytes(2);

/** One step of a history; its state's first byte names which stand-in state it is. */
const step = (tx: string, height: number, state: number, succeeded = true): ContractHistoryEntry =>
  ({ kind: 'call', transaction: tx, state: Uint8Array.of(state), block: { height, at: height }, succeeded });
const vaults: Record<number, Uint8Array> = { 1: FIRST, 2: SECOND, 3: SECOND };
/** Each account state's removal count, and the proposals still held in it, by id and the count each was raised at. */
const accounts: Record<number, { count: number; held: Array<[number, number]> }> = {
  10: { count: 1, held: [] }, 11: { count: 2, held: [] }, 12: { count: 3, held: [] }, 13: { count: 4, held: [] },
  /* A run raised at a count of 1, a removal, then the block that set the secret closes the run. */
  20: { count: 2, held: [[7, 1]] }, 21: { count: 2, held: [] },
};
const read = {
  vault: (s: Uint8Array) => ({ nonceCommitment: vaults[s[0]!]! }),
  account: (s: Uint8Array) => {
    const a = accounts[s[0]!]!;
    const all: Array<[Uint8Array, { needed: bigint; removals: bigint }]> = [
      [COUNT_KEY, { needed: 0n, removals: BigInt(a.count) }], ...a.held.map(([id, r]): [Uint8Array, { needed: bigint; removals: bigint }] => [bytes(id), { needed: 0n, removals: BigInt(r) }]),
    ];
    const found = (k: Uint8Array) => all.find(([e]) => hex(e) === hex(k));
    return { proposalHolds: { member: (k: Uint8Array) => found(k) !== undefined, lookup: (k: Uint8Array) => found(k)![1], [Symbol.iterator]: () => all[Symbol.iterator]() } };
  },
  removalCountKey: () => COUNT_KEY,
};

describe('when a vault\'s secret was set, read off the chain\'s history', () => {
  it('IS THE ACCOUNT\'S COUNT IN ITS LAST STEP BEFORE THE SETTING BLOCK, WHATEVER TRANSACTION EACH STEP CARRIES', () => {
    const removals = removalsWhenTheSecretWasSet(read, {
      vault: [step('a', 1, 1), step('x', 5, 2, false), step('b', 6, 2), step('c', 9, 3)],
      account: [step('p', 2, 10), step('q', 4, 11), step('r', 5, 13, false), step('other', 6, 12)],
    }, hex(SECOND));
    expect(removals, 'RED WHEN: a count from the setting block itself, a failed step, or a later step is read as the one the secret was set at')
      .toBe(2);
  });

  it('IS LOWERED TO THE COUNT THE RUN CLOSED IN THE SETTING BLOCK WAS RAISED AT, SO A SIGNER REMOVED BETWEEN ITS RAISE AND ITS SETTING COUNTS', () => {
    const removals = removalsWhenTheSecretWasSet(read, {
      vault: [step('a', 1, 1), step('b', 6, 2)],
      account: [step('p', 2, 10), step('removed', 4, 20), step('another hash', 6, 21)],
    }, hex(SECOND));
    expect(removals, 'RED WHEN: a removal between a run\'s raise and its setting is read as before the secret').toBe(1);
  });

  it('A RUN RAISED AT ONE REMOVAL, SET AFTER A SECOND, OWES A NEW SECRET THOUGH NO REMOVAL CAME AFTER THE SETTING', async () => {
    const steps = { vault: [step('a', 1, 1), step('b', 6, 2)], account: [step('p', 2, 10), step('removed', 4, 20), step('set', 6, 21)] };
    const must = await secretMustChange({ opened: { removals: 2 }, chainRemovals: 2, set: async () => removalsWhenTheSecretWasSet(read, steps, hex(SECOND)) });
    expect(must, 'RED WHEN: the signer removed between the run\'s raise and its setting is left holding the secret deposits are made under')
      .toEqual({ why: 'removed-since-it-was-set' });
  });

  it('REFUSES WHEN THE ACCOUNT\'S HISTORY SHOWS NO STEP IN THE SETTING BLOCK, NAMING THE WALLET\'S INDEXER', () => {
    expect(() => removalsWhenTheSecretWasSet(read, {
      vault: [step('a', 1, 1), step('b', 6, 2)], account: [step('p', 2, 10), step('removed', 4, 20)],
    }, hex(SECOND)), 'RED WHEN: a removal between a run\'s raise and its setting can be missed because the setting block was not read')
      .toThrow(/indexer your wallet names.*Try again/u);
  });

  it('REFUSES WHEN THE ACCOUNT\'S HISTORY DOES NOT REACH BACK BEFORE THE SETTING BLOCK', () => {
    expect(() => removalsWhenTheSecretWasSet(read, { vault: [step('a', 1, 1), step('b', 6, 2)], account: [step('p', 6, 10)] }, hex(SECOND)),
      'RED WHEN: a count is guessed for a secret whose account history starts at or after it').toThrow(/does not reach back/);
  });

  it('REFUSES WHEN THE VAULT\'S HISTORY DOES NOT YET SHOW THE SECRET SET', () => {
    expect(() => removalsWhenTheSecretWasSet(read, { vault: [step('a', 1, 1)], account: [step('p', 2, 10)] }, hex(SECOND)),
      'RED WHEN: a history that has not caught up is answered as a set point').toThrow(/does not yet show/);
  });
});

describe('whether the chain has counted a removal since a vault\'s secret was set', () => {
  it('a removal counted after the secret was set owes the vault a new secret', async () => {
    expect(await removedSinceSet(2, async () => 1), 'RED WHEN: a signer removed after the vault\'s secret was set is not counted as able to open it').toBe(true);
  });

  it('no removal since the secret was set owes nothing, and a chain that counted no removal never asks its history', async () => {
    let asked = 0;
    expect(await removedSinceSet(2, async () => 2)).toBe(false);
    expect(await removedSinceSet(0, async () => { asked += 1; return 0; })).toBe(false);
    expect(asked, 'RED WHEN: a company that never removed a signer has the chain\'s history read for every vault').toBe(0);
  });
});
