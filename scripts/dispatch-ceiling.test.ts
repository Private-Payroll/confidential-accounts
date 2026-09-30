/**
 * THE CEILING, CALIBRATED AGAINST THE TWO REAL SUBMISSIONS.
 *
 * On 28 Aug 2026 the chain accepted an eleven-circuit deploy at bytesWritten
 * 31,201 (21:04 IST, block 215,346, contract `93ac5860…`) and refused a
 * thirteen-circuit deploy at 35,748 (22:27 IST, `1010`). Those two numbers are
 * the only ground truth this repository has about where the ceiling actually
 * is: ANY ceiling an instrument computes must sit strictly between them, or
 * the derivation is wrong — however well-cited it reads. The 37,500 "75%
 * ceiling" both instruments used until S11 fails exactly this test, which is
 * why it exists.
 *
 * These tests are pure arithmetic over recorded submissions: no chain, no
 * ledger WASM, no keys. If a FUTURE submission lands between 31,201 and
 * 35,748, add it to the constants in `dispatch-ceiling.ts` — the window
 * narrows and this test gets stronger.
 */
import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_BYTES_WRITTEN, BYTES_WRITTEN_LIMIT, EXTRINSIC_FRACTION, REFUSED_BYTES_WRITTEN,
  TX_SIZE_WEIGHT_REF_TIME_PS, calibrate, classCeiling, extrinsicCeiling,
} from './dispatch-ceiling.js';

describe('the per-extrinsic ceiling, calibrated against the two real submissions', () => {
  it('sits strictly between the deploy the chain accepted and the one it refused', () => {
    const ceiling = extrinsicCeiling(BYTES_WRITTEN_LIMIT);
    expect(ceiling).toBeGreaterThan(ACCEPTED_BYTES_WRITTEN);
    expect(ceiling).toBeLessThan(REFUSED_BYTES_WRITTEN);
    expect(calibrate()).toBeNull();
  });

  it('is the arithmetic the derivation says: 0.75 − 0.10 − base − the node\'s size weight, of 50,000', () => {
    // (0.65 × 2e12 − 108,157,000 − 20,000,000,000) / 2e12 × 50,000 = 31,997.29…, floored.
    expect(extrinsicCeiling(50_000)).toBe(31_997);
  });

  it('counts the node\'s size weight: without it the ceiling would be 500 bytes higher', () => {
    expect(TX_SIZE_WEIGHT_REF_TIME_PS).toBe(20_000_000_000n);
    // 20,000,000,000 ps of a 2 s block is 1%, and 1% of 50,000 is 500.
    const without = Number((50_000n * (EXTRINSIC_FRACTION.num + TX_SIZE_WEIGHT_REF_TIME_PS)) / EXTRINSIC_FRACTION.den);
    expect(without - extrinsicCeiling(50_000)).toBe(500);
  });

  it('would have caught C238: the 75% class ceiling FAILS the same calibration', () => {
    // 37,500 passes the refused 35,748 — the exact mistake the instruments
    // made. The class number is real (it is the NORMAL class's per-block
    // budget) and it is not the number that judges one extrinsic.
    expect(classCeiling(BYTES_WRITTEN_LIMIT)).toBe(37_500);
    expect(calibrate(classCeiling(BYTES_WRITTEN_LIMIT))).not.toBeNull();
  });

  it('refuses a ceiling at or below the accepted submission', () => {
    expect(calibrate(ACCEPTED_BYTES_WRITTEN)).not.toBeNull();
    expect(calibrate(30_000)).not.toBeNull();
  });
});
