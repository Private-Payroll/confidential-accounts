/*
 * A device's first opening of a company is counted on its own, apart from the openings after it. A seat whose wallet has
 * not checked the company before runs the upkeep every action starts with: it reads what the device has not kept (every
 * header of the anchor, the seats' openings and the proposals' identities from its own builder), and the next run on that
 * device reads what the pinned reads for a device that has checked the company before say. Each seat has a builder of its
 * own, so what one device has kept is never what another's first opening finds. The first opening is pinned at the company's
 * first size and at twice it, and what differs between them is named.
 */
import { describe, expect, it } from 'vitest';
import { BO, CY } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { aCompanyOf, runUpkeep } from './company-harness.test-support.js';
import { differences, grownAs, readsOf, type Reads } from './action-counts.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });

/* The upkeep of a seat's first opening at the company's first size, measured on a device that has not checked it. */
const FIRST_AT_N: readonly Reads[] = [
  {'builder anchorHeads': 2, 'builder ownSeat': 1, 'builder proposalIdentity': 2, 'builder seatOpenings': 1, 'holders holders': 1, 'indexer invitedSeats': 1, 'indexer roundsOnChain': 1, 'onChain anchorsOnChain': 1, 'route GET /api/accounts/:record': 1, 'route GET /api/accounts/:record/directory': 1, 'route GET /api/accounts/:record/manifest/tree/headers': 1, 'route GET /api/accounts/:record/manifest/tree/pending': 1, 'route GET /api/accounts/:record/proposals': 1, 'route GET /api/accounts/:record/vault-keys/offers': 1, 'route POST /api/accounts/:record/manifest/newest': 3, 'route POST /api/accounts/:record/manifest/tree/proofs': 5, 'route POST /api/accounts/:record/records/read': 2},
  {'builder ownSeat': 1, 'holders holders': 1, 'indexer invitedSeats': 1, 'indexer roundsOnChain': 1, 'indexer vaultsOnChain': 1, 'onChain anchorsOnChain': 1, 'route GET /api/accounts/:record': 1, 'route GET /api/accounts/:record/directory': 1, 'route GET /api/accounts/:record/manifest/tree/pending': 1, 'route GET /api/accounts/:record/proposals': 1, 'route POST /api/accounts/:record/manifest/newest': 6, 'route POST /api/accounts/:record/manifest/tree/proofs': 8, 'route POST /api/accounts/:record/records/read': 3, 'route POST /api/accounts/:record/vault-records/read': 1},
];
/* The next opening on that device: what a device that has checked the company reads, for this seat. */
const NEXT_AT_N: readonly Reads[] = [
  {'builder ownSeat': 1, 'holders holders': 1, 'indexer invitedSeats': 1, 'indexer roundsOnChain': 1, 'onChain anchorsOnChain': 1, 'route GET /api/accounts/:record': 1, 'route GET /api/accounts/:record/directory': 1, 'route GET /api/accounts/:record/manifest/tree/pending': 1, 'route GET /api/accounts/:record/proposals': 1, 'route GET /api/accounts/:record/vault-keys/offers': 1, 'route POST /api/accounts/:record/manifest/newest': 3, 'route POST /api/accounts/:record/manifest/tree/proofs': 5, 'route POST /api/accounts/:record/records/read': 2},
  {'builder ownSeat': 1, 'holders holders': 1, 'indexer invitedSeats': 1, 'indexer roundsOnChain': 1, 'indexer vaultsOnChain': 1, 'onChain anchorsOnChain': 1, 'route GET /api/accounts/:record': 1, 'route GET /api/accounts/:record/directory': 1, 'route GET /api/accounts/:record/manifest/tree/pending': 1, 'route GET /api/accounts/:record/proposals': 1, 'route POST /api/accounts/:record/manifest/newest': 6, 'route POST /api/accounts/:record/manifest/tree/proofs': 8, 'route POST /api/accounts/:record/records/read': 3, 'route POST /api/accounts/:record/vault-records/read': 1},
];
/* The first opening on another seat's device at twice the records. */
const FIRST_AT_2N: readonly Reads[] = [
  {'builder anchorHeads': 2, 'builder ownSeat': 1, 'builder proposalIdentity': 2, 'builder seatOpenings': 1, 'holders holders': 1, 'indexer invitedSeats': 1, 'indexer roundsOnChain': 1, 'onChain anchorsOnChain': 1, 'route GET /api/accounts/:record': 1, 'route GET /api/accounts/:record/directory': 1, 'route GET /api/accounts/:record/manifest/tree/headers': 1, 'route GET /api/accounts/:record/manifest/tree/pending': 1, 'route GET /api/accounts/:record/proposals': 1, 'route GET /api/accounts/:record/vault-keys/offers': 1, 'route POST /api/accounts/:record/manifest/newest': 3, 'route POST /api/accounts/:record/manifest/tree/proofs': 5, 'route POST /api/accounts/:record/records/read': 2},
  {'builder ownSeat': 1, 'holders holders': 1, 'indexer invitedSeats': 1, 'indexer roundsOnChain': 1, 'indexer vaultsOnChain': 1, 'onChain anchorsOnChain': 1, 'route GET /api/accounts/:record': 1, 'route GET /api/accounts/:record/directory': 1, 'route GET /api/accounts/:record/manifest/tree/pending': 1, 'route GET /api/accounts/:record/proposals': 1, 'route POST /api/accounts/:record/manifest/newest': 6, 'route POST /api/accounts/:record/manifest/tree/proofs': 8, 'route POST /api/accounts/:record/records/read': 3, 'route POST /api/accounts/:record/vault-records/read': 1},
];

/* The reads of a first opening that still grow with the company, by ask, with why; each must still be found growing. */
const STILL_GROWS: Readonly<Record<string, string>> = Object.freeze({
});

describe('A DEVICE THAT HAS NOT CHECKED THE COMPANY BEFORE IS COUNTED ON ITS FIRST OPENING, APART FROM THE ONES AFTER IT', { timeout: 160_000 }, () => {
  it('a seat\'s first opening reads what its device has not kept, and its next opening reads what a device that has checked the company reads', async () => {
    const first = readsOf(await runUpkeep(company, BO.person));
    /* RED WHEN: a first opening reads differently than it did when measured: more or fewer headers, openings or identities asked of its own builder. */
    expect(first).toEqual(FIRST_AT_N);
    /* RED WHEN: a first opening is counted as the ones after it, so the reads a new device makes are hidden by what another device kept. */
    expect(Object.keys(first[0]!)).toEqual(expect.arrayContaining(['builder seatOpenings', 'builder proposalIdentity']));
    expect(Object.keys(NEXT_AT_N[0]!)).not.toContain('builder seatOpenings');
    /* RED WHEN: the next opening on the same device reads what the first did: nothing is kept. */
    expect(readsOf(await runUpkeep(company, BO.person))).toEqual(NEXT_AT_N);
  });

  it('a first opening at twice the records reads the same, but the reads named as still growing', async () => {
    await company.growTo({ people: 6, vendors: 4, vaults: 4, proposals: 2 });
    const first = readsOf(await runUpkeep(company, CY.person));
    /* RED WHEN: another seat's first opening at twice the records reads differently than it did when measured. */
    expect(first).toEqual(FIRST_AT_2N);
    const changed = differences('upkeep', FIRST_AT_N, first, ['at the first size', 'at twice it']);
    /* RED WHEN: any read of a first opening grows with the company's records but those named as still growing. */
    expect(changed.filter((d) => grownAs(STILL_GROWS, d) === undefined)).toEqual([]);
    /* RED WHEN: a read named as still growing no longer grows, and is still named here. */
    expect(Object.keys(STILL_GROWS).filter((k) => !changed.some((d) => grownAs(STILL_GROWS, d) === k))).toEqual([]);
  });
});
