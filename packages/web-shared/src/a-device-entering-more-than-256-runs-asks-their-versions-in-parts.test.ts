/*
 * A device that enters more than 256 runs at once asks for their newest versions in parts of 256, one request for each
 * part, where one request naming all of them would be refused as too long; each run is then entered at the version
 * after its newest, and the entries go in parts as they always did.
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from '../../../src/core/crypto.js';
import { AskTooLong, READ_AT_ONCE } from './records-source.js';
import { recordsEnteredFor, type Filed, type ManifestService } from './record-entered-here.js';

const COMPANY = 'co_runs_in_parts';
const SECRET = '11'.repeat(32) as Hex;

/** A manifest that refuses an ask naming more records than one request carries, as the service's source does, and counts each. */
const aManifest = () => {
  const asked: number[] = [];
  const entered: { readonly id: string; readonly version: number }[] = [];
  const manifest: ManifestService = {
    newest: async (_company, records) => {
      asked.push(records.length);
      if (records.length > READ_AT_ONCE) throw new AskTooLong('records', records.length);
      return records.map((r) => (r.id.endsWith('0') ? 2 : 0));
    },
    enter: async (_company, entries) => {
      for (const e of entries) entered.push({ id: e.id, version: e.version });
    }
  };
  return { manifest, asked, entered };
};

const runs = (n: number): Filed[] =>
  Array.from({ length: n }, (_, i) => ({
    store: 'run' as const,
    run: { id: `run_${String(i).padStart(12, '0')}` } as never
  }));

describe('A DEVICE ENTERING MORE THAN 256 RUNS ASKS FOR THEIR NEWEST VERSIONS IN PARTS OF 256', () => {
  it('asks one request for each 256 runs, and enters each at the version after its newest', async () => {
    const few = aManifest();
    await recordsEnteredFor(few.manifest, COMPANY, SECRET).enter(runs(200));
    const many = aManifest();
    await recordsEnteredFor(many.manifest, COMPANY, SECRET).enter(runs(300));
    /* RED WHEN: every run entered is named in one request, which the service refuses past 256. */
    expect([few.asked, many.asked]).toEqual([[200], [256, 44]]);
    /* RED WHEN: a run's version is read off another run's answer, as when the parts' answers are put back out of order. */
    expect(many.entered.length).toBe(300);
    expect(many.entered.filter((e) => e.version !== (e.id.endsWith('0') ? 3 : 1))).toEqual([]);
  });
});
