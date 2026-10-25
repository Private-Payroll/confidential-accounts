import type { Identity } from 'midnight-identity/keys/derivation';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import type { KeysRead, SealedKeyring } from 'midnight-identity/profile/unlock';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { foundTheCompanyHere, type CompanyFounded } from '../../../../src/core/company-founding.js';
import {
  withCreation, withNewSeat, type AccountKeys, type SavedCreation,
} from '../../../../packages/web-shared/src/keyring-blob.js';
import { openHeldKeyring, type KeyringMarks } from './held-keyring.js';
import { foundingSeatOf } from './founding-seat.js';
import { readFor } from './read-for-the-page.js';

/**
 * **A NEW COMPANY, FOUNDED IN THIS WALLET.** Behind the press that starts a
 * company: the founding seat made from this wallet's words for the label it
 * has just drawn, the founding roster and state signed with that seat, and the
 * seat and what the company was founded with written into the person's saved
 * keys and sealed again. What crosses back to the page is the founding (its
 * records sealed under the company's new viewing key, which is wrapped to the
 * seat), the sealed saved keys and what they hold that is not secret, the new
 * company's viewing key among it; the seat's secrets never do.
 *
 * What it trusts: the page's words for the company's name and its founding
 * signer's name and role, shown as the page's on the window, and the person's
 * id the saved keys are sealed for. The saved keys it opens are refused if they
 * are older than ones this device has opened.
 *
 * **ONE ANSWER, NO REPLY.** A keyring ask is answered once, so this wallet does
 * not hear whether the page kept the sealed copy. It raises nothing for it:
 * the next time it is handed the saved keys it opens them and raises its mark
 * to them then. A copy the page dropped loses nothing, because the founding
 * seat is made again from this wallet's words (`foundingSeatOf`).
 */
export interface FoundedHere {
  readonly accountId: string;
  readonly founded: CompanyFounded;
  readonly sealed: SealedKeyring;
  readonly ifVersion: number;
  /** What the page is given of the saved keys with the new seat in them: nothing secret (`read-for-the-page.ts`). */
  readonly read: KeysRead;
}

/** Why a company could not be founded here, in words the person can act on. */
export class NotFoundedHere extends Error {
  constructor(says: string) {
    super(says);
    this.name = 'NotFoundedHere';
  }
}

export async function foundTheCompanyInTheWallet(input: {
  readonly identity: Identity;
  readonly request: KeyringRequest;
  readonly label: CompanyLabel;
  readonly marks: KeyringMarks;
  readonly now?: () => Date;
}): Promise<FoundedHere> {
  const { identity, request, label } = input;
  if (request.founding === undefined || request.keyring === undefined) {
    throw new NotFoundedHere('The page asked this wallet to start a company without saying what it is called, or without '
      + 'handing over your saved keys to keep its seat in, so nothing was started. Reload the page and start the company again.');
  }
  const seat = await foundingSeatOf(identity, label);
  const founded = foundTheCompanyHere({
    name: request.founding.name,
    signer: { name: request.founding.signer.name, role: request.founding.signer.role },
    userId: request.person,
    label,
    seat: { signingPublicKey: seat.signingPublicKey, wrappingPublicKey: seat.wrappingPublicKey, leaf: seat.leaf },
    signingSecret: seat.signingSecret,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const accountId = founded.account.id;
  const mine: AccountKeys = {
    signerId: founded.seat.signerId,
    signingSecret: seat.signingSecret,
    wrappingSecret: seat.wrappingSecret,
    blinding: seat.blinding,
    scope: seat.scope,
    opening: { publicKey: seat.publicKey, scope: seat.scope, blinding: seat.blinding, walletKey: seat.walletKey, salt: seat.salt },
  };
  const creation: SavedCreation = {
    accountId,
    person: request.person,
    label,
    foundingKey: seat.walletKey,
    request: {
      name: request.founding.name,
      signers: [{ name: request.founding.signer.name, role: request.founding.signer.role }],
      threshold: 1,
      companyLabel: label,
      foundingKey: seat.walletKey,
      founding: founded,
    },
    made: false, deploy: null, signed: null, recorded: false,
  };
  const held = openHeldKeyring({
    identity, ask: { requester: request.requester, person: request.person }, handedIn: request.keyring, marks: input.marks,
  });
  try {
    if (held.read().creations?.[accountId] !== undefined) {
      throw new NotFoundedHere('Your saved keys already keep a company being created under the new company\'s id, so nothing '
        + 'was started. Start the company again from the page.');
    }
    const write = (k: Parameters<typeof withNewSeat>[0]) => withCreation(withNewSeat(k, accountId, mine), creation);
    const read = readFor(identity, request, write(held.read()), [{
      accountId, inboxPublicKey: String(founded.account.inboxPublicKey),
      wrappedKeys: founded.account.wrappedKeys as never,
    }]);
    const again = held.seal(write);
    return Object.freeze({ accountId, founded, sealed: again.sealed, ifVersion: again.ifVersion, read: Object.freeze({ ...read, resealed: null }) });
  } finally {
    held.letGo();
  }
}
