/**
 * An end-to-end check runs only when the network it runs against is named and, when it spends a fee, the funded
 * wallet's seed is on this machine. Without either it stands down with exit 0 and names what it waits for.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { standDownLine, standDownWhenMissing, whatIsMissing } from './end-to-end-waits.js';
import { aNetworkIsNamed } from '../src/midnight/network.js';

const ROOT = '/repo';
const seedFor = (network: string): string => join(ROOT, '.data', network, 'wallet.seed');

describe('what an end-to-end check waits for', () => {
  /* RED WHEN: a check with no network named goes on to run against whichever network the build defaults to. */
  it('waits for the network to be named, and asks for nothing else until it is', () => {
    expect(whatIsMissing({ named: false, network: 'preprod' }, { fundedSeedFor: seedFor }, ROOT, () => true)).toEqual([
      'MIDNIGHT_NETWORK_ID naming the network to run against'
    ]);
    expect(aNetworkIsNamed({})).toBe(false);
    expect(aNetworkIsNamed({ MIDNIGHT_NETWORK_ID: '  ' })).toBe(false);
    expect(aNetworkIsNamed({ MIDNIGHT_NETWORK_ID: 'preprod' })).toBe(true);
  });

  /* RED WHEN: a check that spends a fee runs with no funded wallet, or looks for the seed of another network. */
  it('waits for the funded seed of the network it was given, when it spends a fee', () => {
    const asked: string[] = [];
    const missing = whatIsMissing({ named: true, network: 'preprod' }, { fundedSeedFor: seedFor }, ROOT, (p) => {
      asked.push(p);
      return false;
    });
    expect(asked).toEqual([join(ROOT, '.data', 'preprod', 'wallet.seed')]);
    expect(missing).toEqual(["a funded wallet's seed at .data/preprod/wallet.seed"]);
    expect(whatIsMissing({ named: true, network: 'preprod' }, { fundedSeedFor: seedFor }, ROOT, () => true)).toEqual(
      []
    );
  });

  it('asks for no seed when the check spends nothing', () => {
    expect(whatIsMissing({ named: true, network: 'preprod' }, {}, ROOT, () => false)).toEqual([]);
  });

  /* RED WHEN: a stand-down exits with a failure, prints nothing, or runs on when something is missing. */
  it('stands down with exit 0 naming what it waits for, and lets the check run when nothing is missing', () => {
    const printed: string[] = [];
    const exits: number[] = [];
    const exit = ((code: number) => {
      exits.push(code);
      throw new Error('exited');
    }) as (code: number) => never;
    expect(() => standDownWhenMissing('The chain read', ['x', 'y'], (l) => printed.push(l), exit)).toThrow('exited');
    expect(exits).toEqual([0]);
    expect(printed).toEqual([standDownLine('The chain read', ['x', 'y'])]);
    expect(printed[0]).toBe('  The chain read stands down [needs x; y]');
    standDownWhenMissing('The chain read', [], (l) => printed.push(l), exit);
    expect(exits).toEqual([0]);
    expect(printed).toHaveLength(1);
  });
});
