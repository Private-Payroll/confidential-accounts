/**
 * **A DEPOSIT OR A PAYMENT THIS DEVICE SENT AND HAS NOT YET SEEN LAND, KEPT
 * ON THIS DEVICE AND SEALED UNDER THE SIGNER'S OWN KEY.**
 *
 * What is kept names a coin: its nonce, its token and its amount. Anybody who
 * learns a coin's nonce and reads the chain can confirm a guessed amount, so
 * none of it is kept where it can be read without the signer. Each record is
 * sealed with AES-256-GCM under a key derived from the signer's own wrapping
 * secret, which this page holds only while the signer's keys are open and
 * never writes down. After a reload the same signer, back on the same device,
 * opens it again; the record itself never leaves this browser.
 *
 * **NOTHING OUTSIDE THE SEAL SAYS WHICH VAULT OR WHICH COIN.** A record is
 * filed under a slot derived from the same key and the vault, so the store
 * shows only that this signer keeps something, not where. The vault and the
 * kind of record are bound into the seal as well, so a record moved to another
 * slot does not open there.
 *
 * **ONE RECORD PER VAULT, AND A RECORD IS CHANGED ONLY BY WHOEVER KEPT IT.**
 * Each record carries a claim: random, made when it is first kept, and the
 * only thing outside the seal. A new record is kept only where none is; it is
 * replaced or forgotten only under the claim it was kept with. Each of the
 * three is one step of the store, so two tabs of one browser cannot overwrite
 * or forget each other's.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { fromHex, randomBytes, toHex, utf8, type Hex } from '../core/crypto.js';

/** The signer this device keeps records for: their seat, and the secret only they open with. */
export interface InFlightOpener {
  readonly signerId: string;
  readonly wrappingSecret: Hex;
}

/** What is kept: a deposit this device sent, or a payment. Each kind has its own record per vault. */
export type InFlightKind = 'deposit' | 'payment';

/** One record as the store keeps it. Only the claim is outside the seal, and it is random. */
export interface SealedInFlight {
  readonly claim: Hex;
  readonly iv: Hex;
  readonly body: Hex;
}

/**
 * **WHERE SEALED RECORDS ARE KEPT, AND THE THREE CHANGES IT MAKES AS ONE STEP
 * EACH.** In a browser, IndexedDB; in a test, memory.
 */
export interface InFlightRecords {
  get(slot: string): Promise<SealedInFlight | null>;
  /** Keeps this record only when the slot is empty. `false` when it is not. */
  add(slot: string, record: SealedInFlight): Promise<boolean>;
  /** Replaces the record kept under `claim`. `false` when another is kept there, or none. */
  replace(slot: string, claim: Hex, record: SealedInFlight): Promise<boolean>;
  /** Forgets the record kept under `claim`, and nothing else. */
  remove(slot: string, claim: Hex): Promise<void>;
}

/** A record this device keeps, with the claim it was kept under. */
export type Kept<T> = T & { readonly claim: string };

/**
 * **WHAT A DEPOSIT OR A PAYMENT OPERATION IS HANDED TO KEEP ITS RECORD IN.**
 * One per vault. `claim` keeps a new one only where none is kept.
 */
export interface KeptOnThisDevice<T> {
  get(vault: Hex): Promise<Kept<T> | null>;
  /** Keeps this record when none is kept for the vault, and answers its claim; `null` when another is kept. */
  claim(vault: Hex, record: T): Promise<string | null>;
  /** Replaces the record kept under `claim`, and nothing else. */
  update(vault: Hex, claim: string, record: T): Promise<void>;
  /** Forgets the record kept under `claim`, and nothing else. */
  forget(vault: Hex, claim: string): Promise<void>;
}

const SALT = utf8('vault operation in flight on this device');

/** Raised when the signer's secret is not open here: nothing can be kept or read until it is. */
export class InFlightKeysNotOpen extends Error {
  constructor() {
    super('your keys for this company are not open on this device, so nothing about a deposit or a payment on its way '
      + 'can be kept or read here. Open the company with your wallet and try again. Nothing was sent.');
    this.name = 'InFlightKeysNotOpen';
  }
}

const keysOf = (me: InFlightOpener): { seal: Uint8Array; slot: Uint8Array } => {
  let secret: Uint8Array;
  try {
    secret = fromHex(me.wrappingSecret);
  } catch {
    throw new InFlightKeysNotOpen();
  }
  if (secret.length !== 32) throw new InFlightKeysNotOpen();
  return {
    seal: hkdf(sha256, secret, SALT, utf8(`seal\u0000${me.signerId}`), 32),
    slot: hkdf(sha256, secret, SALT, utf8(`slot\u0000${me.signerId}`), 32),
  };
};

const bound = (kind: InFlightKind, vault: Hex, claim: Hex): Uint8Array =>
  utf8(`${kind}\u0000${vault.toLowerCase().replace(/^0x/u, '')}\u0000${claim}`);

/** Where this signer's record of one kind, for one vault, is filed. Says nothing of either without the key. */
export const slotFor = (me: InFlightOpener, kind: InFlightKind, vault: Hex): string =>
  toHex(hmac(sha256, keysOf(me).slot, bound(kind, vault, '')));

/** Seals one record. The claim is random and new unless one is given. */
export const sealInFlight = (
  me: InFlightOpener, kind: InFlightKind, vault: Hex, value: unknown, claim: Hex = toHex(randomBytes(16)),
): SealedInFlight => {
  const iv = randomBytes(12);
  const body = gcm(keysOf(me).seal, iv, bound(kind, vault, claim)).encrypt(utf8(JSON.stringify(value)));
  return { claim, iv: toHex(iv), body: toHex(body) };
};

/** Opens one record, or `null` when this signer's key does not open it for this vault and kind. */
export const openInFlight = <T>(me: InFlightOpener, kind: InFlightKind, vault: Hex, sealed: SealedInFlight): T | null => {
  const key = keysOf(me).seal;
  try {
    const plain = gcm(key, fromHex(sealed.iv), bound(kind, vault, sealed.claim)).decrypt(fromHex(sealed.body));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
};

/**
 * **ONE KIND OF RECORD, SEALED, OVER ANY STORE.**
 *
 * A record kept in this signer's slot that their key does not open is one
 * nothing on this device can use: it is treated as absent, and a new record
 * takes its place. It names no coin anybody here can recover, and the vault's
 * own journals name every coin a deposit or a payment was about to make.
 */
export function sealedOnThisDevice<T>(records: InFlightRecords, me: InFlightOpener, kind: InFlightKind): KeptOnThisDevice<T> {
  return {
    get: async (vault) => {
      const sealed = await records.get(slotFor(me, kind, vault));
      if (sealed === null) return null;
      const opened = openInFlight<T>(me, kind, vault, sealed);
      return opened === null ? null : { ...opened, claim: sealed.claim };
    },
    claim: async (vault, record) => {
      const slot = slotFor(me, kind, vault);
      const sealed = sealInFlight(me, kind, vault, record);
      if (await records.add(slot, sealed)) return sealed.claim;
      const there = await records.get(slot);
      if (there !== null && openInFlight(me, kind, vault, there) === null
        && await records.replace(slot, there.claim, sealed)) return sealed.claim;
      return null;
    },
    update: async (vault, claim, record) => {
      await records.replace(slotFor(me, kind, vault), claim, sealInFlight(me, kind, vault, record, claim));
    },
    forget: async (vault, claim) => {
      await records.remove(slotFor(me, kind, vault), claim);
    },
  };
}

/** Records kept in memory, for a test. */
export function inFlightInMemory(kept = new Map<string, SealedInFlight>()): InFlightRecords & { readonly kept: Map<string, SealedInFlight> } {
  return {
    kept,
    get: async (slot) => kept.get(slot) ?? null,
    add: async (slot, record) => {
      if (kept.has(slot)) return false;
      kept.set(slot, record);
      return true;
    },
    replace: async (slot, claim, record) => {
      if (kept.get(slot)?.claim !== claim) return false;
      kept.set(slot, record);
      return true;
    },
    remove: async (slot, claim) => {
      if (kept.get(slot)?.claim === claim) kept.delete(slot);
    },
  };
}
