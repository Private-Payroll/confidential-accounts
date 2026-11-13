/**
 * **THE LEDGER'S PART IN A CHANGE OF THE SUPER ADMINS**: the bytes each contract's update is signed over, and the two
 * signature checks a change is judged by. Made here where the ledger loads (the vault worker, or a test); the page asks
 * the vault worker for each (`vault-worker-client.ts`), so no part of the ledger loads on the page.
 */
import { joinedBy } from 'midnight-identity/profile/committee-sign';
import { committeeReplacement, type ReplacementPrimitives } from '../../../src/midnight/vault-committee.js';

type Key = { readonly tag: string; readonly value: string };

/** One contract's update to the committee `to`, signed at `counter`, the counter the chain holds the contract at. */
interface SuperAdminUpdate {
  readonly vault: string;
  readonly counter: bigint;
  readonly to: { readonly committee: readonly Key[]; readonly threshold: number };
}

export interface SuperAdminLedger {
  /** The bytes `update` is signed over, as the ledger makes them (`committeeReplacement`); throws on an update it cannot make. */
  readonly updateBytes: (update: SuperAdminUpdate) => Promise<Uint8Array>;
  /** Whether `signature` is `key`'s over `data` by the ledger's own check; false for anything the check refuses or throws on. */
  readonly signedBy: (key: Key, data: Uint8Array, signature: Key) => Promise<boolean>;
  /** Whether a joining key's `signature` is its own over a change's `bytes` (`joinedBy`): a Schnorr key and signature, checked by the ledger. */
  readonly joinedBy: (bytes: Uint8Array, key: Key, signature: string) => Promise<boolean>;
}

/** What the ledger is asked for: its classes that make an update, and its signature check. */
export type LedgerHere = ReplacementPrimitives & { verifySignature(key: Key, data: Uint8Array, signature: Key): boolean };

/** The ledger's part, made with the ledger itself. */
export const superAdminLedgerOf = (L: LedgerHere): SuperAdminLedger => ({
  updateBytes: async (update) => committeeReplacement(L, {
    vault: update.vault, counter: update.counter,
    to: { committee: update.to.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: update.to.threshold },
  }).dataToSign,
  signedBy: async (key, data, signature) => {
    try {
      return L.verifySignature(key, data, { tag: signature.tag, value: signature.value });
    } catch {
      /* A key or a signature the ledger cannot read verifies nothing: it is a signature that does not count. */
      return false;
    }
  },
  joinedBy: async (bytes, key, signature) => joinedBy(L, bytes, key, signature),
});
