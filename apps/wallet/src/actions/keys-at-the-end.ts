import type { Identity } from 'midnight-identity/keys/derivation';
import type { ActEnded, ActStop } from 'midnight-identity/profile/channel';
import { READER_KEYS_INTENT, readReleasedReadKeys, type ReadKeysReleased } from 'midnight-identity/profile/read-keys-release';
import { isPurpose } from '../../../../src/core/sealed-records.js';
import type { ActRequest } from 'midnight-identity/profile/request';
import type { Keyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { HeldKeyring } from '../keyring/held-keyring.js';
import { readFor } from '../keyring/read-for-the-page.js';

/**
 * WHAT AN ACTION'S END TELLS THE PAGE OF KEYS: the read keys of a reader's act (`readKeysAtTheEnd`, below), and of the
 * person's saved keys, when a step opened them: what they hold that is not
 * secret, as the action left them, so the page reads the creations and seats it lists without opening them
 * (`read-for-the-page.ts`), and no copy. The one viewing key in it is the action's own company's (`ownOf`), from the
 * served keys the ask handed in for it, opened with this seat and given only when it makes that company's inbox
 * public key (`servedKeysOpenedFrom`), so a page that ran an action with its keys closed can open that company
 * afterwards with no other window. Nothing at all when the keys were not opened or cannot be read now.
 */
export const keysAtTheEnd = (
  opened: HeldKeyring | null, request: ActRequest, identity: Identity, ownOf: (k: Keyring) => string | null,
): { keys?: NonNullable<ActEnded['keys']> } => {
  const h = opened;
  if (h === null || request.person === undefined) return {};
  try {
    const k = h.read();
    const own = ownOf(k);
    const served = own === null ? [] : (request.served ?? []).filter((s) => s.accountId === own);
    const read = readFor(identity, { requester: request.requester, person: request.person, served }, k);
    const viewing = own !== null && Object.prototype.hasOwnProperty.call(read.viewing, own) ? { [own]: read.viewing[own]! } : {};
    return { keys: Object.freeze({ ...read, viewing, resealed: null }) };
  } catch {
    /* Saved keys let go or unreadable at the end: the page is told nothing of them, and opens them with its wallet. */
    return {};
  }
};

/**
 * The read keys an action's end hands the page: only from the `reader-keys` action, only when it ended done, and only
 * in the one closed shape, its kinds of record the company's own purposes (`readReleasedReadKeys`, the reader the page
 * runs too). Anything else a step released is dropped here, before it leaves the wallet.
 */
export const readKeysAtTheEnd = (intent: string, why: ActStop | null, released: ReadKeysReleased | null): { readKeys?: ReadKeysReleased } => {
  if (why !== null || released === null || intent !== READER_KEYS_INTENT) return {};
  const read = readReleasedReadKeys(released, isPurpose);
  return read === null ? {} : { readKeys: read };
};
