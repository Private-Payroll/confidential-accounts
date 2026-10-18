/**
 * **AN ANSWER TO AN INVITATION, OPENED FROM THE COMPANY'S INBOX AND BELIEVED ONLY AS THE COMPANY'S KEY CHANGES ALLOW.**
 *
 * A person waiting for a seat, and a payee handing over their address, seal their answer to the company's inbox, which
 * is made from the company's key. When the key changes after a signer leaves, the seat that changes it names every
 * answer it found waiting under the old inbox, and that list is signed and anchored with the change. An answer sealed
 * to the inbox in force is believed; one sealed to an older inbox is believed only when the change that replaced that
 * key named it, so nothing the service hands in later, and nothing a removed signer seals with a key they kept, is
 * acted on. Everything here is pure and runs on a device.
 */
import { canonical, commit, type Hex, type Sealed } from './crypto.js';
import { openFromInbox } from './sealed-records.js';
import type { KeysHeld } from './company-key.js';

/** An answer as it is sealed to the company's inbox. */
export type SealedAnswer = { readonly ephemeral: Hex } & Sealed;

const ANSWER_DOMAIN = 'confidential-accounts/company-key-waiting-answer/v1';

/** The digest a change of the company's key names a waiting answer by: over its sealed bytes, never what it holds. */
export const answerDigestOf = (sealed: SealedAnswer): Hex =>
  commit(canonical({ ephemeral: sealed.ephemeral, iv: sealed.iv, tag: sealed.tag, body: sealed.body }), ANSWER_DOMAIN);

/** Refused because the answer was sealed to an inbox from before the company's key changed, and that change did not name it. */
export class AnswerToAnOldInvitation extends Error {
  constructor() {
    super('This answer was sealed to the company\'s key from before it changed, and the signer who changed the key did not '
      + 'find it waiting, so this device does not act on it. Nothing was sent. Ask the person for a new answer: withdraw this '
      + 'one and invite them again.');
    this.name = 'AnswerToAnOldInvitation';
  }
}

/** Refused because no key of the company this device holds opens the answer. */
export class AnswerNotOpened extends Error {
  constructor() {
    super('This answer does not open with any key of the company this device holds, so it was sealed for somebody else. '
      + 'Nothing was sent. Ask the person to accept a new invitation.');
    this.name = 'AnswerNotOpened';
  }
}

/**
 * The answer opened, with the key that opened it and that key's epoch. Tried first with the company's inbox in force,
 * then with each older key this device holds. One that opens only under an older key is returned only when the change
 * of key that replaced that key names its digest; otherwise it is refused (`AnswerToAnOldInvitation`). A bare key is
 * the company's only key, so it opens only what is sealed to its inbox.
 */
export const answerOpenedWith = <T>(
  keys: KeysHeld, box: SealedAnswer, accountId: string,
): { readonly value: T; readonly key: Hex; readonly epoch: number } => {
  if (typeof keys === 'string') {
    try {
      return { value: openFromInbox<T>(box, accountId, keys as Hex), key: keys as Hex, epoch: 0 };
    } catch {
      throw new AnswerNotOpened();
    }
  }
  try {
    return { value: openFromInbox<T>(box, accountId, keys.key), key: keys.key, epoch: keys.epoch };
  } catch { /* sealed to another inbox: an older one is tried below */ }
  for (let e = keys.epoch - 1; e >= 0; e -= 1) {
    let key: Hex;
    try { key = keys.keyAt(e); } catch { continue; }
    let value: T;
    try { value = openFromInbox<T>(box, accountId, key); } catch { continue; }
    if (keys.answered?.get(e)?.has(answerDigestOf(box)) !== true) throw new AnswerToAnOldInvitation();
    return { value, key, epoch: e };
  }
  throw new AnswerNotOpened();
};
