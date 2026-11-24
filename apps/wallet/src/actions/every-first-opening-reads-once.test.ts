/*
 * A device's first opening of a company is counted on its own, apart from the openings after it. A seat whose wallet has
 * not checked the company before runs the upkeep every action starts with: it reads what the device has not kept (every
 * header of the anchor, the seats' openings and the proposals' identities from its own builder), and the next run on that
 * device reads what the pinned reads for a device that has checked the company before say. Each seat has a builder of its
 * own, so what one device has kept is never what another's first opening finds. The first opening is pinned at the company's
 * first size and at twice it, with the records the answers to each carried, and they read the same; what each read that
 * names its records asks at twice the records is held by kind to what the company grew by. Its tables are written by the
 * pins writer from this file's run (WRITE_PINS=1), never by hand.
 */
import { describe, expect, it } from 'vitest';
import { BO, CY } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { aCompanyOf, runUpkeep, type IntentCount } from './company-harness.test-support.js';
import {
  FIRST_OPENING_CARRIED_PINS, FIRST_OPENING_CARRIED_PINS_AT_TWICE, FIRST_OPENING_PINS, FIRST_OPENING_PINS_AT_TWICE, NEXT_OPENING_CARRIED_PINS, NEXT_OPENING_PINS,
} from './action-count-pins.test-support.js';
import { carriedNotAsHeldIn, carriedOf, differences, listedThenNot, readsOf, tableHeld, tableSource, type PinTable, type Reads } from './action-counts.test-support.js';
import { askedOtherThan, heldBy, type CompanyHeld } from './asked-by-kind.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });

const PINNED = {
  first: FIRST_OPENING_PINS['give-vault-keys']!, next: NEXT_OPENING_PINS['give-vault-keys']!, firstAt2N: FIRST_OPENING_PINS_AT_TWICE['give-vault-keys']!,
};
/*
 * The records the service's answers to each step of each opening carried. A first opening's grow with the company, 47 to
 * 64 and 55 to 84, by the records the larger company holds and nothing else: the anchor's list of headers carries an
 * entry for each record the larger company anchored (27 to 43), the list of proposals carries its one more proposal in
 * each step, and the reads of each vault's records, their newest versions and their proofs ask those of the two vaults
 * added (8 to 16, 6 to 10, 30 to 46). Every list is held to every record of its kind and every read to what it asked
 * (`carriedNotAsHeldIn`), and what each read asks is held by kind to what the company grew by (`askedOtherThan`).
 */
const CARRIED = {
  firstAtN: FIRST_OPENING_CARRIED_PINS['give-vault-keys']!, nextAtN: NEXT_OPENING_CARRIED_PINS['give-vault-keys']!,
  firstAt2N: FIRST_OPENING_CARRIED_PINS_AT_TWICE['give-vault-keys']!,
};

/* Each opening counted here, as it ran, with what the company held when it ended. */
const measured: { first?: IntentCount; next?: IntentCount; firstAt2N?: IntentCount; heldAtN?: CompanyHeld } = {};
/*
 * The tables of the pins this file measures, each of the upkeep a seat's wallet runs at its first opening (counted as
 * giving vault keys, as every upkeep is): the first opening and the next at the company's first size, and the first at
 * twice it, by reads and by records carried.
 */
const tablesOf = (m: typeof measured): PinTable[] => {
  const of = (c: IntentCount | undefined): Reads[] => (c === undefined ? [] : readsOf(c));
  const carried = (c: IntentCount | undefined): number[] => (c === undefined ? [] : carriedOf(c));
  const first = 'A seat\'s first opening of the company, on a device that has not checked it before';
  const next = 'The next opening on that device, as a device that has checked the company reads it';
  const answers = 'The records the service\'s answers to each step carried at';
  return [
    { name: 'FIRST_OPENING_PINS', about: `${first}, on the company at its first size.`, reads: { 'give-vault-keys': of(m.first) } },
    { name: 'NEXT_OPENING_PINS', about: `${next}, on the company at its first size.`, reads: { 'give-vault-keys': of(m.next) } },
    { name: 'FIRST_OPENING_PINS_AT_TWICE', about: `${first}, on the company at twice its first size.`, reads: { 'give-vault-keys': of(m.firstAt2N) } },
    { name: 'FIRST_OPENING_CARRIED_PINS', about: `${answers} a seat's first opening, on the company at its first size.`, carried: { 'give-vault-keys': carried(m.first) } },
    { name: 'NEXT_OPENING_CARRIED_PINS', about: `${answers} the next opening on that device, on the company at its first size.`, carried: { 'give-vault-keys': carried(m.next) } },
    { name: 'FIRST_OPENING_CARRIED_PINS_AT_TWICE', about: `${answers} a seat's first opening, on the company at twice its first size.`, carried: { 'give-vault-keys': carried(m.firstAt2N) } },
  ];
};

describe('A DEVICE THAT HAS NOT CHECKED THE COMPANY BEFORE IS COUNTED ON ITS FIRST OPENING, APART FROM THE ONES AFTER IT', { timeout: 160_000 }, () => {
  it('a seat\'s first opening reads what its device has not kept, and its next opening reads what a device that has checked the company reads', async () => {
    const opened = await runUpkeep(company, BO.person);
    const first = readsOf(opened);
    /* RED WHEN: a first opening reads differently than it did when measured: more or fewer headers, openings or identities asked of its own builder. */
    expect(first).toEqual(PINNED.first);
    /* RED WHEN: the answers to a first opening carry more or fewer records than were pinned for it, or carry other than what the service holds and what was asked. */
    expect(carriedOf(opened)).toEqual(CARRIED.firstAtN);
    expect(carriedNotAsHeldIn(opened.log)).toEqual([]);
    /* RED WHEN: a first opening is counted as the ones after it, so the reads a new device makes are hidden by what another device kept. */
    expect(Object.keys(first[0]!)).toEqual(expect.arrayContaining(['builder seatOpenings', 'builder proposalIdentity']));
    expect(Object.keys(PINNED.next[0]!)).not.toContain('builder seatOpenings');
    const next = await runUpkeep(company, BO.person);
    /* RED WHEN: the next opening on the same device reads what the first did: nothing is kept. */
    expect(readsOf(next)).toEqual(PINNED.next);
    /* RED WHEN: the answers to the next opening carry more or fewer records than were pinned for it, or other than what is held and asked. */
    expect(carriedOf(next)).toEqual(CARRIED.nextAtN);
    expect(carriedNotAsHeldIn(next.log)).toEqual([]);
    measured.first = opened;
    measured.next = next;
    measured.heldAtN = await heldBy(company);
  });

  it('a first opening at twice the records reads the same', async () => {
    await company.growTo({ people: 6, vendors: 4, vaults: 4, proposals: 2 });
    const opened = await runUpkeep(company, CY.person);
    const first = readsOf(opened);
    /* RED WHEN: another seat's first opening at twice the records reads differently than it did when measured. */
    expect(first).toEqual(PINNED.firstAt2N);
    /* RED WHEN: any read of a first opening is made a different number of times at twice the company's records. */
    expect(differences('upkeep', PINNED.first, first, ['at the first size', 'at twice it'])).toEqual([]);
    /* RED WHEN: the answers to a first opening at twice the records carry more or fewer records than were pinned, or other than what is held and asked. */
    expect(carriedOf(opened)).toEqual(CARRIED.firstAt2N);
    expect(carriedNotAsHeldIn(opened.log)).toEqual([]);
    /* RED WHEN: a list carried a record at the first size that the same step's list does not carry at twice it. */
    expect(listedThenNot(measured.first!, opened)).toEqual([]);
    /*
     * RED WHEN: a read that names its records asks more or fewer of a kind at twice the records than at the first size,
     * other than a read granted to the upkeep asking one more for each one more the company holds.
     */
    expect(askedOtherThan('give-vault-keys', measured.first!, opened, [measured.heldAtN!, await heldBy(company)])).toEqual([]);
    measured.firstAt2N = opened;
  });

  it('the tables of the pins this file measures are the ones the pins writer writes from it', () => {
    /* RED WHEN: a pin is not what this run measured, or the pins file was changed by hand away from what its writer writes. */
    for (const t of tablesOf(measured)) expect(tableHeld(t, true), t.name).toBe(tableSource(t));
  });
});
