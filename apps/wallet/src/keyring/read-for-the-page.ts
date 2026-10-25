import type { Identity } from 'midnight-identity/keys/derivation';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { keyringHolderFor, type KeysRead } from 'midnight-identity/profile/unlock';
import {
  metadataOf, sealedDigestOf, seatsOf, tidiedWith, servedKeysOpenedFrom, type Keyring, type ServedKeys,
} from '../../../../packages/web-shared/src/keyring-blob.js';
import { openHeldKeyring, type HeldKeyring, type KeyringMarks } from './held-keyring.js';

/**
 * **WHAT A PAGE IS GIVEN OF THE PERSON'S SAVED KEYS: NOTHING SECRET.** This wallet opens the saved keys the page
 * handed in and reads for it each seat's public halves and scope, each company's viewing key it opened with the
 * seat's wrapping secret and believed (`servedKeysOpenedFrom`: only a key that makes the company's inbox public key), the
 * parts that open nothing (`metadataOf`), and its own public name for this person (`keyringHolderFor`). No signing
 * secret, wrapping secret, blinding or keyring key is in it.
 *
 * The creation changes the page asked for are made only where the saved keys agree (`tidiedWith`); when one was
 * made, or the copy handed in was sealed under the old key (`held-keyring.ts`), the saved keys sealed again under the
 * key no page had come back for the page to write over the copy it handed in. No seat is made again for it. This
 * wallet does not hear whether the page kept that copy. A tidy of a copy already under the new key raises nothing: the
 * mark rises the next time that copy is opened. A copy that was under the old key is different: once the answer with it
 * re-sealed has gone (`handedOver`), the mark is raised to that copy with `under: 2`, as an action's keep raises it, so
 * this device opens no copy under the old key again. If the page then fails to keep it, this device refuses the old
 * copy from then on and says so; the copy the page was handed is the one to keep.
 */
export function readFor(identity: Identity, request: Pick<KeyringRequest, 'requester' | 'person' | 'served'>, k: Keyring, extra: readonly ServedKeys[] = []): Omit<KeysRead, 'resealed'> {
  return Object.freeze({
    seats: seatsOf(k),
    viewing: servedKeysOpenedFrom(k, [...(request.served ?? []), ...extra]),
    metadata: metadataOf(k) as unknown as Readonly<Record<string, unknown>>,
    holder: keyringHolderFor(identity, request),
  });
}

/** The read for the page, and what to do once the answer carrying it has gone. */
export interface KeysReadHere {
  readonly read: KeysRead;
  /** Call once the answer with `read` in it has been handed to the page. */
  handedOver(): void;
}

/** The read for a keyring ask that handed the saved keys in, or null when it handed none. */
export function keysReadForThePage(input: {
  readonly identity: Identity;
  readonly request: KeyringRequest;
  readonly marks: KeyringMarks;
}): KeysReadHere | null {
  const { identity, request } = input;
  if (request.keyring === undefined) return null;
  const held: HeldKeyring = openHeldKeyring({
    identity, ask: { requester: request.requester, person: request.person }, handedIn: request.keyring, marks: input.marks,
  });
  try {
    const before = held.read();
    const tidy = request.tidy ?? [];
    const after = tidiedWith(before, tidy);
    /* Saved keys sealed under the old key come back sealed under the new one, every seat as it was, even when nothing
     * else changed: the page writes this copy over the one it handed in, and the old key opens it no more. */
    const fromTheOldKey = held.underTheOldKey === true;
    const again = after === before && !fromTheOldKey ? null : held.seal((current) => tidiedWith(current, tidy));
    const resealed = again === null ? null : Object.freeze({ sealed: again.sealed, ifVersion: again.ifVersion });
    const mark = again === null || !fromTheOldKey ? null
      : Object.freeze({ counter: again.counter, digest: sealedDigestOf(again.sealed), under: 2 as const });
    let handed = false;
    return Object.freeze({
      read: Object.freeze({ ...readFor(identity, request, after), resealed }),
      handedOver: (): void => {
        if (handed || mark === null) return;
        handed = true;
        input.marks.raise(request.person, mark);
      },
    });
  } finally {
    held.letGo();
  }
}
