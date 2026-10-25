import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { ActingChannel } from 'midnight-identity/profile/channel';
import type { Keyring } from '../../../../packages/web-shared/src/keyring-blob.js';

/**
 * **THE LAST CHECK BEFORE ANYTHING LEAVES THIS WALLET FOR THE PAGE.** Every message this wallet sends a page goes
 * through `checkedChannel`: a keyring or unlock answer, an action's relays, its calls for the service, the saved keys
 * it hands back to be kept and its end answer. Each is refused, and nothing is sent, when its serialised form holds a
 * secret of the saved keys this wallet opened for the ask - any seat's signing secret, wrapping secret or blinding, a
 * seat opening's blinding or salt - or the key they are sealed under, the key they were sealed under before, or the
 * parent both come from. It looks for the bytes, not for a name: the secret is refused however the code that built the
 * message reached it, as lower- or upper-case hex, base64 or base64url.
 *
 * What is watched is filled where the secrets are made or opened (`held-keyring.ts`) and forgotten once the ask's
 * terminal message has gone. It lives in this wallet's own code, which no page loads.
 */

/** A message this wallet was about to hand the page held a secret, and was not sent. */
export class SecretWouldCross extends Error {
  constructor() {
    super('this wallet was about to hand the page a secret of your saved keys, and did not: nothing was handed over, '
      + 'and the action has stopped. This is a fault in this wallet, not in anything you did.');
    this.name = 'SecretWouldCross';
  }
}

/* Shorter values are not secrets of these kinds (each is 32 bytes) and would match by chance. */
const SHORTEST_BYTES = 16;
const HEX = /^(?:0x)?((?:[0-9a-fA-F]{2})+)$/u;

const watchedHex = new Set<string>();
const watchedBase64 = new Set<string>();

const base64Of = (bytes: Uint8Array): string => {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
};

/** Watches one secret, given as bytes or as hex. Nothing shorter than 16 bytes is watched. */
export function watchFor(secret: Uint8Array | string): void {
  let bytes: Uint8Array;
  if (typeof secret === 'string') {
    const m = HEX.exec(secret);
    if (m === null) return;
    bytes = hexToBytes(m[1]!.toLowerCase());
  } else {
    bytes = secret;
  }
  if (bytes.length < SHORTEST_BYTES) return;
  watchedHex.add(bytesToHex(bytes));
  const b64 = base64Of(bytes);
  watchedBase64.add(b64);
  watchedBase64.add(b64.replace(/=+$/u, ''));
  watchedBase64.add(b64.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, ''));
}

type SeatLike = { signingSecret?: unknown; wrappingSecret?: unknown; blinding?: unknown; opening?: { blinding?: unknown; salt?: unknown } };

/** Watches every seat's secrets in saved keys: the seats held and the seats sealed before their leaf. */
export function watchTheSavedKeys(k: Keyring): void {
  const seats = [...Object.values(k.accounts ?? {}), ...Object.values(k.pendingSeats ?? {})] as SeatLike[];
  for (const seat of seats) {
    for (const v of [seat.signingSecret, seat.wrappingSecret, seat.blinding, seat.opening?.blinding, seat.opening?.salt]) {
      if (typeof v === 'string') watchFor(v);
    }
  }
}

/** Forgets every watched secret: the ask they were watched for has had its terminal message. */
export function forgetWatched(): void {
  watchedHex.clear();
  watchedBase64.clear();
}

/* Bytes are written out as hex, so a secret handed over as bytes is seen as one handed over as hex. */
const serialised = (message: unknown): string => JSON.stringify(message, (_key, value: unknown) => {
  if (ArrayBuffer.isView(value)) return bytesToHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof ArrayBuffer) return bytesToHex(new Uint8Array(value));
  if (typeof value === 'bigint') return value.toString(16);
  return value;
}) ?? '';

/** Whether a message holds any watched secret, in any of the spellings above. */
export function carriesASecret(message: unknown): boolean {
  if (watchedHex.size === 0) return false;
  const text = serialised(message);
  const lower = text.toLowerCase();
  for (const h of watchedHex) if (lower.includes(h)) return true;
  for (const b of watchedBase64) if (text.includes(b)) return true;
  return false;
}

/** Throws `SecretWouldCross` when a message holds a watched secret. */
export function refuseIfItCarriesASecret(message: unknown): void {
  if (carriesASecret(message)) throw new SecretWouldCross();
}

const CHECKED: unique symbol = Symbol('checked for secrets');

/**
 * The channel to the page with every outgoing message checked first: one that holds a watched secret throws
 * `SecretWouldCross` and is not sent. An answer or refusal that went ends the ask, and what was watched is forgotten.
 */
export function checkedChannel(channel: ActingChannel): ActingChannel {
  if ((channel as { [CHECKED]?: true })[CHECKED] === true) return channel;
  const ended = (sent: boolean): boolean => { if (sent) forgetWatched(); return sent; };
  const checked: ActingChannel & { readonly [CHECKED]: true } = {
    [CHECKED]: true,
    answer: (answer) => { refuseIfItCarriesASecret(answer); return ended(channel.answer(answer)); },
    refuse: ((...args: unknown[]) => ended((channel.refuse as (...a: unknown[]) => boolean).apply(channel, args))) as ActingChannel['refuse'],
    progress: (stage) => channel.progress(stage),
    over: () => channel.over(),
    stop: () => channel.stop(),
    /* A step's place is two numbers and carries nothing; it is sent on a timer, where a throw would be heard by nobody. */
    step: (at) => channel.step(at),
    relay: (at, transaction, label) => { refuseIfItCarriesASecret({ at, transaction, label }); return channel.relay(at, transaction, label); },
    keep: (at, sealed, ifVersion) => { refuseIfItCarriesASecret({ at, sealed, ifVersion }); return channel.keep(at, sealed, ifVersion); },
    call: (at, method, path, body) => { refuseIfItCarriesASecret({ at, method, path, body }); return channel.call(at, method, path, body); },
  };
  return Object.freeze(checked);
}
