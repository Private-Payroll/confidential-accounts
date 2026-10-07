import { describe, expect, it } from 'vitest';
import { NETWORK } from 'midnight-identity/network';
import { snapshotForTest } from '../testing/snapshot.js';
import { restorableAs, snapshotFacts } from './snapshot.js';

/*
 * WHAT A SAVED SNAPSHOT SAYS ABOUT ITSELF, READ FROM THE LEDGER'S OWN LOCAL
 * STATE: whose it is, which network, and whether anything is in flight.
 */
describe('A SNAPSHOT, READ FOR WHAT IT HOLDS IN FLIGHT AND WHOSE IT IS', () => {
  it('reads the ledger\'s own local state: nothing in flight, a coin set aside, a coin expected', () => {
    /* RED WHEN: the reader looks at fields the ledger does not keep, so it says nothing is in flight when a coin is set aside, or the other way round. */
    expect(snapshotFacts(snapshotForTest())?.inFlight).toBe(false);
    expect(snapshotFacts(snapshotForTest({ inFlight: 'spend' }))?.inFlight).toBe(true);
    expect(snapshotFacts(snapshotForTest({ inFlight: 'output' }))?.inFlight).toBe(true);
    expect(snapshotFacts(snapshotForTest({ coinPublicKey: 'k', networkId: 'n' }))).toMatchObject({ coinPublicKey: 'k', networkId: 'n' });
  });

  it('a snapshot it cannot read is no snapshot', () => {
    /* RED WHEN: an unreadable snapshot is read as one holding nothing in flight. */
    for (const bad of ['x', '{}', JSON.stringify({ publicKeys: { coinPublicKey: 'k' }, networkId: 'n', state: 'zz' }),
      JSON.stringify({ publicKeys: { coinPublicKey: 'k' }, networkId: 'n', state: 'abcd' })]) {
      expect(snapshotFacts(bad), bad).toBeNull();
    }
  });

  it('IS RESTORED ONLY AS THIS ACCOUNT\'S OWN, FROM THIS NETWORK, WITH NOTHING IN FLIGHT', () => {
    const mine = 'my-coin-key';
    /* RED WHEN: any one of the three is not checked. */
    expect(restorableAs(snapshotForTest({ coinPublicKey: mine }), mine, NETWORK)).toBe(true);
    expect(restorableAs(snapshotForTest({ coinPublicKey: 'another' }), mine, NETWORK)).toBe(false);
    expect(restorableAs(snapshotForTest({ coinPublicKey: mine, networkId: 'another-network' }), mine, NETWORK)).toBe(false);
    expect(restorableAs(snapshotForTest({ coinPublicKey: mine, inFlight: 'spend' }), mine, NETWORK)).toBe(false);
    expect(restorableAs('x', mine, NETWORK)).toBe(false);
  });
});
