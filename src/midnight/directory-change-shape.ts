/**
 * The shapes a company directory's changes are held to before anything in them is believed: an object with exactly the
 * fields named, hex of the lengths a key, a signature or a sealed body has, and a change of the company's key whose every
 * part anyone can check without the key, the service included. Exactly one signature is required on a change of the key, and
 * none is checked here, nor what the sealed parts hold.
 */
import type { Sealed } from '../core/crypto.js';
import type { RotateChange } from './seat-directory.js';
export const exactly = (o: object, fields: readonly string[]): boolean => {
  const keys = Object.keys(o).sort();
  return keys.length === fields.length && keys.every((k, i) => k === fields[i]);
};

export const HEX64 = /^[0-9a-f]{64}$/u;
export const HEX128 = /^[0-9a-f]{128}$/u;
export const HEX_OR_EMPTY = /^(?:[0-9a-f]{2})*$/u;

const HEX24 = /^[0-9a-f]{24}$/u;
const SEALED_FIELDS = ['body', 'iv', 'tag'];
const WRAP_FIELDS = ['body', 'ephemeral', 'iv', 'tag'];
const ROTATE_FIELDS = ['after', 'epoch', 'keyCheck', 'kind', 'previous', 'signatures', 'waiting', 'wraps'];
const ROTATE_OPTIONAL = ['repairs', 'replaces', 'seed'];

const sealedShaped = (x: unknown, fields: readonly string[] = SEALED_FIELDS): boolean => {
  const v = x as Partial<Sealed> & { ephemeral?: unknown } | null;
  return typeof v === 'object' && v !== null && exactly(v, fields)
    && typeof v.iv === 'string' && HEX24.test(v.iv) && typeof v.tag === 'string' && HEX_OR_EMPTY.test(v.tag)
    && typeof v.body === 'string' && v.body.length > 0 && HEX_OR_EMPTY.test(v.body)
    && (!fields.includes('ephemeral') || (typeof v.ephemeral === 'string' && HEX64.test(v.ephemeral)));
};
const whole = (n: unknown, from: number): boolean => Number.isSafeInteger(n) && (n as number) >= from;

/** Whether a change of key is in its shape: what anyone can check of it without the key, the server included. */
export const rotateShaped = (c: RotateChange): boolean => {
  const keys = Object.keys(c);
  return ROTATE_FIELDS.every((k) => keys.includes(k)) && keys.every((k) => ROTATE_FIELDS.includes(k) || ROTATE_OPTIONAL.includes(k))
    && whole(c.epoch, 1) && typeof c.keyCheck === 'string' && HEX64.test(c.keyCheck) && whole(c.after, 1)
    && Array.isArray(c.wraps) && c.wraps.every((w) => typeof w === 'object' && w !== null && exactly(w, ['seat', 'wrap'])
      && typeof w.seat === 'string' && HEX64.test(w.seat) && sealedShaped(w.wrap, WRAP_FIELDS))
    && sealedShaped(c.previous)
    && (c.seed === undefined || (typeof c.seed === 'object' && c.seed !== null && exactly(c.seed, ['epoch', 'sealed'])
      && whole(c.seed.epoch, 1) && sealedShaped(c.seed.sealed)))
    && Array.isArray(c.waiting) && c.waiting.every((d) => typeof d === 'string' && HEX64.test(d))
    && (c.repairs === undefined || whole(c.repairs, 1))
    && (c.replaces === undefined || whole(c.replaces, 0))
    && Array.isArray(c.signatures) && c.signatures.length === 1;
};
