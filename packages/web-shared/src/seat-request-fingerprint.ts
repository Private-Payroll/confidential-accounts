/**
 * The fingerprint of the keys a seat request would seat, and the check that the one a joiner reads out is that one. A
 * device about to seat somebody works it out from the request itself, so keys swapped on their way are refused before
 * anybody is seated.
 */
import type { PendingSignerPayload } from '../../../src/core/types.js';
import { seatKeyFingerprint, tidyFingerprint } from 'midnight-identity/profile/fingerprint';
/** Thrown when the fingerprint a joiner reads out is not the one of the keys about to be seated. */
export class FingerprintsDiffer extends Error {
  constructor() {
    super('The fingerprint the person read out is not the fingerprint of the keys about to be seated, so what reached this company is not what their device made. Do not seat them: ask them for a new code or a new link.');
    this.name = 'FingerprintsDiffer';
  }
}

/** The fingerprint of the keys a seat request would seat, as a device about to seat it works it out. */
export const seatRequestFingerprint = (waiting: Pick<PendingSignerPayload, 'signingPublicKey' | 'wrappingPublicKey' | 'leafCommitment'>): string =>
  seatKeyFingerprint(waiting);

/** Refuses unless the fingerprint the joiner read out, however typed, is the one of the keys about to be seated. */
export function refuseASeatWhoseFingerprintIsNotTheJoiners(
  waiting: Pick<PendingSignerPayload, 'signingPublicKey' | 'wrappingPublicKey' | 'leafCommitment'>, readOut: string,
): void {
  if (tidyFingerprint(readOut) !== seatRequestFingerprint(waiting)) throw new FingerprintsDiffer();
}
