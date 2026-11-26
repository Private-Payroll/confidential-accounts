import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Purposes } from '../keys/derivation.js';
import type { Identity } from '../keys/derivation.js';
import { networkName, type NetworkName } from '../wallet/network.js';
import { companyLabelBytes, companyLabelOf, type CompanyLabel } from './company-label.js';

/**
 * **ONE SIGNER SEAT'S ENTRY IN A PRIVATE REGISTRY, SEALED SO ONLY THE PERSON'S OWN WORDS OPEN IT.**
 *
 * A registry is a public map from a 32-byte tag to a 288-byte value. A person's entries sit at tags made from their own
 * words (`tagAt`), so the words alone find them again, and nobody else can tell whose a tag is or link two of them.
 * Each value is the seat's company label, the company's account, the seat's number, its scope and the rights the scope
 * commits to, sealed with AES-256-GCM (a 12-byte iv, the body, a 16-byte tag: the construction the saved keys are
 * sealed with) under a key made from the words. The tag and the network are bound into the seal, so a value moved to
 * another tag or read on another network does not open.
 *
 * Both keys come from the seat authority of the person's words (the parent every seat's keys come from), each under its
 * own purpose, per network. Only a signer seat has an entry: a reader holds no seat to find again.
 */

/** The registry's value size: the contract's `Bytes<288>`. */
export const ENTRY_BYTES = 288;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
/** What the seal holds: the value less its iv and its authentication tag. */
const BODY_BYTES = ENTRY_BYTES - IV_BYTES - GCM_TAG_BYTES;
const KEY_BYTES = 32;
const VERSION = 1;
/** The most vaults a seat's rights name (`RIGHTS_VAULT_PLACES` in the application). */
export const MOST_VAULTS = 4;
/** The highest tag index read or written; far past any person's seats. */
export const MOST_TAGS = 2 ** 31;

const SALT = new TextEncoder().encode('midnight-identity/private-registry/v1');
const SEAT_PARENT_INDEX = 0;
const HEX64 = /^[0-9a-f]{64}$/u;

/** The rights a seat's scope commits to, as the application records them. */
export interface EntryRights {
  readonly mayRaise: boolean;
  readonly mayApprove: boolean;
  readonly mayHold: boolean;
  readonly everyVault: boolean;
  readonly vaults: readonly string[];
}

/** What one entry says: which company, its account, which of this person's seats, its scope and its rights if any. */
export interface RegistryEntry {
  readonly label: CompanyLabel;
  /** The company's account address: 32 bytes of lower-case hex. */
  readonly account: string;
  /** The seat's number, `n` of the seat's keys. */
  readonly n: number;
  /** The scope the seat's leaf is drawn over: 32 bytes of lower-case hex. */
  readonly scope: string;
  readonly rights?: EntryRights;
}

export class RegistryEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryEntryError';
  }
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));
const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const keyFor = (identity: Identity, network: NetworkName, purpose: string): Uint8Array =>
  hkdf(sha256, identity.authority(Purposes.Seat, SEAT_PARENT_INDEX), SALT, utf8(`${networkName(network)}/${purpose}`), KEY_BYTES);

/** The key a person's tags on `network` are made from. */
export const registryKey = (identity: Identity, network: NetworkName): Uint8Array => keyFor(identity, network, 'registry-key');

/** The key a person's entries on `network` are sealed under. */
export const entrySealingKey = (identity: Identity, network: NetworkName): Uint8Array => keyFor(identity, network, 'entry-seal');

const indexRefusal = (i: number): string | null =>
  (Number.isSafeInteger(i) && i >= 0 && i < MOST_TAGS ? null : `a tag's index is a whole number from 0 to ${MOST_TAGS - 1}; got ${i}.`);

/**
 * A tag is never all zero bytes, which the registry refuses: a derivation that came out all zero would have its last
 * byte set to one.
 */
export const neverZero = (tag: Uint8Array): Uint8Array => {
  if (tag.some((b) => b !== 0)) return tag;
  const out = new Uint8Array(tag);
  out[out.length - 1] = 1;
  return out;
};

/** The person's `i`th tag on `network`: 32 bytes, as lower-case hex. */
export function tagAt(identity: Identity, network: NetworkName, i: number): string {
  const bad = indexRefusal(i);
  if (bad !== null) throw new RegistryEntryError(`${bad} No tag was made.`);
  return hexOf(neverZero(hkdf(sha256, registryKey(identity, network), SALT, utf8(`tag/${i}`), KEY_BYTES)));
}

/** What is bound into each seal besides the body: the purpose, the network and the tag the value sits at. */
const boundTo = (network: NetworkName, tag: string): Uint8Array => {
  const parts = [SALT, utf8(`/${networkName(network)}/`), bytesOf(tag)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => { out.set(p, at); return at + p.length; }, 0);
  return out;
};

const entryRefusal = (e: RegistryEntry): string | null => {
  if (!HEX64.test(e.account)) return 'its account is not 32 bytes of lower-case hex';
  if (!HEX64.test(e.scope)) return 'its scope is not 32 bytes of lower-case hex';
  if (!Number.isSafeInteger(e.n) || e.n < 0 || e.n >= MOST_TAGS) return `its seat number is not a whole number from 0 to ${MOST_TAGS - 1}`;
  const r = e.rights;
  if (r !== undefined && (r.vaults.length > MOST_VAULTS || !r.vaults.every((v) => HEX64.test(v)))) {
    return `its rights name more than ${MOST_VAULTS} vaults, or a vault that is not 32 bytes of lower-case hex`;
  }
  return null;
};

/*
 * The body, laid out: version (1), label (32), account (32), seat number (4, big-endian), scope (32), flags (1: rights
 * kept, may raise, may approve, may hold, every vault), how many vaults (1), each vault (32), then zeros to the end.
 */
const encoded = (e: RegistryEntry): Uint8Array => {
  const body = new Uint8Array(BODY_BYTES);
  body[0] = VERSION;
  body.set(companyLabelBytes(e.label), 1);
  body.set(bytesOf(e.account), 33);
  new DataView(body.buffer).setUint32(65, e.n);
  body.set(bytesOf(e.scope), 69);
  const r = e.rights;
  body[101] = r === undefined ? 0
    : 1 | (r.mayRaise ? 2 : 0) | (r.mayApprove ? 4 : 0) | (r.mayHold ? 8 : 0) | (r.everyVault ? 16 : 0);
  body[102] = r?.vaults.length ?? 0;
  (r?.vaults ?? []).forEach((v, i) => body.set(bytesOf(v), 103 + 32 * i));
  return body;
};

const decoded = (body: Uint8Array): RegistryEntry | null => {
  if (body.length !== BODY_BYTES || body[0] !== VERSION) return null;
  const flags = body[101]!;
  const count = body[102]!;
  if ((flags & ~31) !== 0 || count > MOST_VAULTS || (flags & 1) === 0 && (flags !== 0 || count !== 0)) return null;
  const end = 103 + 32 * count;
  if (body.subarray(end).some((b) => b !== 0)) return null;
  let label: CompanyLabel;
  try {
    label = companyLabelOf(body.slice(1, 33));
  } catch {
    return null; /* a body whose label is not one is not an entry this person wrote */
  }
  const vaults = Array.from({ length: count }, (_, i) => hexOf(body.subarray(103 + 32 * i, 135 + 32 * i)));
  return Object.freeze({
    label, account: hexOf(body.subarray(33, 65)), n: new DataView(body.buffer, body.byteOffset).getUint32(65), scope: hexOf(body.subarray(69, 101)),
    ...((flags & 1) === 0 ? {} : {
      rights: Object.freeze({
        mayRaise: (flags & 2) !== 0, mayApprove: (flags & 4) !== 0, mayHold: (flags & 8) !== 0, everyVault: (flags & 16) !== 0, vaults: Object.freeze(vaults),
      }),
    }),
  });
};

/** The entry sealed for the person's `i`th tag on `network`: exactly `ENTRY_BYTES` bytes. */
export function sealEntry(identity: Identity, network: NetworkName, i: number, entry: RegistryEntry): Uint8Array {
  const bad = indexRefusal(i) ?? entryRefusal(entry);
  if (bad !== null) throw new RegistryEntryError(`this entry cannot be sealed: ${bad}. Nothing was sealed.`);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = gcm(entrySealingKey(identity, network), iv, boundTo(network, tagAt(identity, network, i))).encrypt(encoded(entry));
  const out = new Uint8Array(ENTRY_BYTES);
  out.set(iv, 0);
  out.set(sealed, IV_BYTES);
  return out;
}

/**
 * The entry at the person's `i`th tag on `network`, or null when the value does not open under their words for that
 * tag and network, was changed, or is not an entry. Never throws for a value read off the chain.
 */
export function openEntry(identity: Identity, network: NetworkName, i: number, value: Uint8Array): RegistryEntry | null {
  if (indexRefusal(i) !== null || !(value instanceof Uint8Array) || value.length !== ENTRY_BYTES) return null;
  let body: Uint8Array;
  try {
    body = gcm(entrySealingKey(identity, network), value.slice(0, IV_BYTES), boundTo(network, tagAt(identity, network, i)))
      .decrypt(value.slice(IV_BYTES));
  } catch {
    return null; /* a value another key sealed, or that was changed, is not this person's entry */
  }
  return decoded(body);
}
