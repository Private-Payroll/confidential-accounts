/**
 * **RUNS KEPT BY THE SERVICE'S OWN CODE, SIGNED AS A SEAT'S DEVICE FILES ONE.**
 *
 * A device reads a run only when a seat it believes filed it, and runs drawn
 * and raised by the service's own code - kept in these tests as setup - were
 * signed by nobody. This signs each as the seat whose secret is given, over the
 * run exactly as it is kept, so a device test can read a run the service made.
 * It is a stand-in for runs drawn and raised on a device; the service's own
 * drawing and raising are listed for removal.
 */
import type { Hex } from '../core/crypto.js';
import type { SealedRun } from '../core/types.js';
import { signRunFiling, type RunToFile } from '../core/run-filing.js';

export const runsFiledBy = (runs: readonly SealedRun[], company: string, signingSecret: Hex): SealedRun[] =>
  runs.map((r) => {
    const { wiring, filedBy: _unsigned, ...kept } = r;
    return { ...signRunFiling(company, kept as RunToFile, signingSecret), ...(wiring === undefined ? {} : { wiring }) };
  });
