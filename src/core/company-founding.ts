/**
 * **A COMPANY MADE ON ITS FOUNDING SIGNER'S OWN DEVICE.**
 *
 * On a chain, every secret a company has at its start is made here, on the
 * device of the person founding it, and none of them is sent at creation: the
 * viewing key the company's records are sealed under, the account's asset
 * blinding, its first payout seed and its pay-record key. The founding
 * signer's own seat is made beside them, from keys made on the same device.
 * What leaves at creation is:
 *
 *   - the seat's two public halves and its leaf;
 *   - the company's record sealed under the viewing key, with that key wrapped
 *     to the seat's own wrapping key, so only that seat can open it;
 *   - the company's first state, sealed under the same viewing key and signed
 *     by the founding seat as a company record, which is the only copy kept.
 *
 * The viewing key and the state's secrets are made, used to seal, and dropped
 * here. The seat's own secrets are the caller's to keep, durably, before
 * anything is sent. This is about creation only: once the company exists, the
 * service's existing read routes are still handed the viewing key by the page
 * that reads them, and with it the service can open what is sealed here.
 *
 * **A COMPANY IS FOUNDED WITH ITS FOUNDING SIGNER ONLY.** Every other signer
 * joins later, their seat made on their own device.
 *
 * Pure apart from its randomness, and loads no WebAssembly: the page and the
 * service both import it, the page to make a company and the service to know
 * the shape of what it is sent.
 */
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { newSymmetricKey, signingPublicKeyOf, wrapKey, type Hex } from './crypto.js';
import {
  GENESIS_KEY_EPOCH, companyAtItsFounding, newAccountId, newSignerId, newStateBlinding, sealAccount, sealState,
  seatAtFounding,
} from './account.js';
import { signedFoundingState } from './founding-state.js';
import { signedFoundingRoster } from './roster-record.js';
import type { SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import type { Role, SealedAccount } from './types.js';

/** The founding signer's seat, as its two public halves and the leaf the account seats. */
export interface FoundingSeat {
  readonly signerId: string;
  readonly signingPublicKey: Hex;
  readonly wrappingPublicKey: Hex;
  readonly leaf: Hex;
}

/**
 * **WHAT LEAVES THE FOUNDING SIGNER'S DEVICE WHEN A COMPANY IS MADE THERE.**
 * Public halves, a leaf, and three things sealed under a key that does not leave.
 */
export interface CompanyFounded {
  readonly seat: FoundingSeat;
  /**
   * The company's record, sealed. Its viewing key is wrapped to the seat and to
   * nobody else. It carries no signers: they are its roster record.
   */
  readonly account: SealedAccount;
  /** The company's first roster, the founding signer's entry only, signed by the founding seat as its roster record. */
  readonly roster: SealedCompanyRecord;
  /**
   * The state the company's first view opens with, sealed under the same
   * viewing key and signed by the founding seat as the company's state record.
   */
  readonly state: SealedCompanyRecord;
}

/**
 * **MAKES A COMPANY HERE, AROUND A SEAT MADE HERE.** `seat` is the founding
 * signer's own seat: the public halves of keys this device made and the leaf
 * worked out from them. Every secret of the company is made inside this call,
 * sealed, and dropped.
 */
export function foundTheCompanyHere(input: {
  readonly name: string;
  readonly signer: { readonly name: string; readonly role: Role };
  /** The signed-in person founding it, who takes the seat. */
  readonly userId: string;
  readonly label: CompanyLabel;
  readonly seat: { readonly signingPublicKey: Hex; readonly wrappingPublicKey: Hex; readonly leaf: Hex };
  /** The seat's signing secret, which signs the first state here and is not kept by anything this returns. */
  readonly signingSecret: Hex;
  readonly now?: () => Date;
}): CompanyFounded {
  if (signingPublicKeyOf(input.signingSecret).toLowerCase() !== input.seat.signingPublicKey.toLowerCase()) {
    throw new Error('the seat\'s signing key is not the one its secret makes, so the company\'s first state could not be '
      + 'signed for it. Nothing was made.');
  }
  const seat: FoundingSeat = {
    signerId: newSignerId(),
    signingPublicKey: input.seat.signingPublicKey.toLowerCase(),
    wrappingPublicKey: input.seat.wrappingPublicKey.toLowerCase(),
    leaf: input.seat.leaf.toLowerCase(),
  };
  const viewingKey = newSymmetricKey();
  const signer = seatAtFounding(seat.signerId, { ...input.signer, userId: input.userId }, seat);
  const account = companyAtItsFounding({
    id: newAccountId(),
    name: input.name,
    signers: [signer],
    threshold: 1,
    wrappedKeys: [{ signerId: seat.signerId, ...wrapKey(viewingKey, seat.wrappingPublicKey) }],
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  });
  /* The signers are the roster record and nothing else: the sealed account is sent without them. */
  const { sealedRoster: _theRosterRecord, ...sealed } = sealAccount({ ...account, companyLabel: input.label }, viewingKey, []);
  return {
    seat,
    account: sealed,
    roster: signedFoundingRoster(account.id, { name: account.name, signers: account.signers }, viewingKey, input.signingSecret),
    state: signedFoundingState(
      account.id, sealState({ entries: [] }, newStateBlinding(), viewingKey, GENESIS_KEY_EPOCH), input.signingSecret),
  };
}

/**
 * **WHERE A COMPANY'S CREATION STANDS, ON A CHAIN**: the one list, read by the
 * service that answers it and the page that shows it.
 */
export const COMPANY_CREATION_STATES = [
  /** Nothing is recorded for its account: the deploy has not been sent. */
  'not-created',
  /** The deploy is recorded and sent, and the chain does not show the account yet. */
  'deploy-sent',
  /** The deploy is recorded, never landed, and can no longer land: it is carried again, the same account. */
  'deploy-expired',
  /** The chain shows the account and not this build's second step: it can be paid into by nobody yet. */
  'finish-owed',
  /** As above, and the second step recorded can no longer land: it is carried again, the same signature. */
  'finish-expired',
  /** The second step was just sent. An answer to sending it, never a standing read from the chain. */
  'finish-sent',
  /** The account carries this build's circuits, and is not yet committed to the company's pay-record key. */
  'pay-key-owed',
  /** The account carries this build's circuits and is committed to the pay-record key. */
  'finished',
  /** The chain could not be asked. */
  'unknown',
] as const;

export type CompanyCreationState = (typeof COMPANY_CREATION_STATES)[number];
