/*
 * A device that files more than 256 records before it anchors anchors them all: it asks for the newest version of every
 * record it filed in parts of 256, one request for each part, where one request naming all of them would be refused as too
 * long. The founding seat files the people of a company in one batch, then anchors, once with fewer than 256 records
 * filed and once with more, and every ask for the newest versions it made is counted with the records it names: its
 * own ask, and the step's view's ask again before each write it makes.
 */
import { describe, expect, it } from 'vitest';
import { anchorTheRecordsHere, type AnchorDoors } from '../../../../packages/web-shared/src/records-anchored-here.js';
import { throughAView, type AnchorDoorsBare } from '../../../../src/testing/anchor-doors-through-a-view.js';
import { aCompanyOf } from './company-harness.test-support.js';

const company = aCompanyOf({ people: 6 });

/** Anchors as the product does, keeping the number of records each ask for the newest versions names. */
const anchoredCounting = (asks: number[]) => (doors: AnchorDoorsBare): Promise<unknown> => anchorTheRecordsHere(throughAView({
  ...doors,
  manifest: { ...doors.manifest, newest: (company: string, records: Parameters<AnchorDoors['manifest']['newest']>[1]) => { asks.push(records.length); return doors.manifest.newest(company, records); } },
}));

describe('A DEVICE ANCHORS EVERY RECORD IT FILED, PAST 256 OF THEM, ASKING ONE MORE REQUEST FOR EACH 256', { timeout: 160_000 }, () => {
  it('asks for the newest versions in parts of at most 256 records, and in one more request when more than 256 were filed', async () => {
    const few: number[] = [];
    await company.growTo({ people: 106 }, anchoredCounting(few));
    const many: number[] = [];
    await company.growTo({ people: 406 }, anchoredCounting(many));
    expect(Math.max(...few, ...many)).toBeLessThanOrEqual(256);
    /* Past the two first reads, which name one record each, every ask is one request below 256 records and two above. */
    const asked = (asks: number[]) => asks.filter((n) => n > 1).length;
    /* RED WHEN: an ask of more than 256 records goes in more than two requests, or one of fewer in more than one. */
    expect(asked(many)).toBe(2 * asked(few));
  });
});
