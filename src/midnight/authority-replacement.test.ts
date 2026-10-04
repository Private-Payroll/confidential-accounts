import { describe, it, expect } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { LARGEST_COMMITTEE, authorityValueRefusals } from './authority-replacement.js';

/*
 * **WHAT A NEW MAINTENANCE AUTHORITY MUST NOT BE**, read against the ledger's
 * own objects where the ledger is what decides: how large an authority it takes.
 */
const keys = (n: number) => Array.from({ length: n }, () => {
  const k = L.signatureVerifyingKey(L.sampleSigningKey());
  return { tag: k.tag, value: k.value };
});
const codes = (committee: { tag: string; value: string }[], threshold: number) =>
  authorityValueRefusals(committee, threshold, { emptyCommitteeIsDeliberate: false }).map((r) => r.code);

/** The ledger's starting limit on an authority's size, read off the ledger's own parameters. */
const metadataLimit = (): number => {
  const m = /max_contract_metadata_size:\s*(\d+)/u.exec(L.LedgerParameters.initialParameters().toString());
  if (m === null) throw new Error('the ledger\'s parameters no longer name max_contract_metadata_size');
  return Number(m[1]);
};
/** An authority's size as the ledger checks it: its serialization without the tag in front. */
const sizeOf = (n: number, threshold: number, counter: bigint): number => {
  const bytes = new L.ContractMaintenanceAuthority(keys(n) as never, threshold, counter).serialize();
  const tag = new TextDecoder().decode(bytes).indexOf(':', 'midnight:'.length) + 1;
  return bytes.length - tag;
};

describe('A NEW AUTHORITY', () => {
  it('IS REFUSED AT A THRESHOLD OF NOTHING, ABOVE ITS KEYS, OR WITH NO KEYS', () => {
    /* Each RED WHEN its own check in authorityValueRefusals is removed: the ledger accepts all three. */
    expect(codes(keys(3), 0)).toContain('threshold-below-one');
    expect(codes(keys(3), 4)).toContain('threshold-above-committee');
    expect(codes([], 1)).toContain('committee-emptied');
    expect(codes(keys(3), 2)).toEqual([]);
  });

  it('IS REFUSED WHEN IT HOLDS MORE KEYS THAN THE LEDGER\'S LIMIT ON AN AUTHORITY TAKES, AT ANY THRESHOLD OR COUNTER', () => {
    const limit = metadataLimit();
    /* RED WHEN LARGEST_COMMITTEE is raised past what fits at the largest threshold and counter. */
    expect(sizeOf(LARGEST_COMMITTEE, 2 ** 32 - 1, 2n ** 32n - 1n)).toBeLessThanOrEqual(limit);
    /* RED WHEN it is lowered below the largest that fits there: one more key does not. */
    expect(sizeOf(LARGEST_COMMITTEE + 1, 2 ** 32 - 1, 2n ** 32n - 1n)).toBeGreaterThan(limit);
    /* RED WHEN the refusal is removed or moved by one. */
    expect(codes(keys(LARGEST_COMMITTEE + 1), 2)).toContain('committee-over-the-metadata-limit');
    expect(codes(keys(LARGEST_COMMITTEE), 2)).not.toContain('committee-over-the-metadata-limit');
  });
});
