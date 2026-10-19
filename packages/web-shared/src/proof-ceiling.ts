/**
 * **THE ONE TIME LIMIT ON PROVING ON THIS DEVICE**, read by the vault worker's
 * pool of proof threads and by the page's client of the vault worker. It is a module of its own so
 * the page can read it without loading anything that starts a thread.
 */

/** The ceiling on one proof, the same ten minutes the wallet's own SDK keeps. */
export const PROOF_CEILING_MS = 10 * 60_000;
