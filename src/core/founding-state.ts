/**
 * **A COMPANY'S STATE, AS A RECORD ITS FOUNDING SIGNER SIGNED.**
 *
 * The state holds what every payroll run is derived from: the payout seeds each
 * payee's secrets come from, and the pay-record key each person-month nonce
 * comes from. A device that checks a run before approving it rebuilds the run
 * from these, so it must not take them from whoever serves them. The founding
 * signer's device seals the first state and signs it as a company record, and
 * that signed record is the only copy kept: the service reads its own copy from
 * it too.
 *
 * A device believes the record only when the seat that signed it is the seat
 * the account's deploy seated, as the chain recorded the deploy - never
 * whichever seat holds a slot later. A company created before its state was
 * kept this way has nothing
 * a device can believe, and is refused with the one sentence below rather than
 * read from a copy nobody signed.
 */
import { parseCanonical, unseal, type Hex } from './crypto.js';
import type { SealedStateAt } from './ledger.js';
import type { ShieldedState, StateBlinding } from './types.js';
import {
  signCompanyFiling, verifiedCompanyFiler, whyThisIsNotACompanyRecord, type SealedCompanyRecord,
} from '../midnight/sealed-record-wire.js';

/** The key epoch a company is founded at. */
export const FOUNDING_KEY_EPOCH = 0;

/** The id a company's state record is filed under: the key epoch it is sealed under. */
export const stateRecordId = (keyEpoch: number): string => String(keyEpoch);

/** Said, word for word, wherever a company has no state record its founding signer signed. */
export const CREATED_BEFORE_SIGNED_STATE = 'This company was created before its state was kept as a record signed by '
  + 'its founding signer, so this device cannot check what it pays. Nothing was approved or sent. Create the company '
  + 'again to pay from it.';

/** The first state, as the founding signer's device files it: version 1 at the founding epoch, signed by its seat. */
export const signedFoundingState = (company: string, sealed: SealedStateAt, signingSecret: Hex): SealedCompanyRecord => {
  if (sealed.keyEpoch !== FOUNDING_KEY_EPOCH) {
    throw new Error(`a company is founded at key epoch ${FOUNDING_KEY_EPOCH}, and this state is sealed at ${sealed.keyEpoch}.`);
  }
  return signCompanyFiling({
    company, kind: 'state', id: stateRecordId(sealed.keyEpoch), version: 1, keyEpoch: sealed.keyEpoch,
    sealed: sealed.sealed, wrapped: [],
  }, signingSecret);
};

/**
 * Why `rec` is not this company's first state signed by the seat with
 * `foundingSigningKey`, or null when it is.
 */
export const foundingStateRefusal = (rec: unknown, company: string, foundingSigningKey: string): string | null => {
  const shape = whyThisIsNotACompanyRecord(rec, { company, kind: 'state', id: stateRecordId(FOUNDING_KEY_EPOCH) });
  if (shape !== null) return shape;
  const r = rec as SealedCompanyRecord;
  if (r.version !== 1) return 'it is not the first version of the company\'s state';
  if (r.keyEpoch !== FOUNDING_KEY_EPOCH) return 'it is not sealed at the epoch a company is founded at';
  const filer = verifiedCompanyFiler(r);
  if (filer === null) return 'it is not signed, or its signature does not cover it';
  if (filer.toLowerCase() !== String(foundingSigningKey).toLowerCase()) return 'it is signed by a seat other than the founding signer\'s';
  return null;
};

/** The state and its blinding, opened from a state record with the viewing key of its epoch. */
export const openStateRecord = (
  rec: Pick<SealedCompanyRecord, 'sealed'>, viewingKey: Hex,
): { state: ShieldedState; blinding: StateBlinding } => {
  const parsed = parseCanonical<{ state: ShieldedState; blinding: StateBlinding }>(unseal(rec.sealed, viewingKey));
  return { state: parsed.state, blinding: parsed.blinding };
};
