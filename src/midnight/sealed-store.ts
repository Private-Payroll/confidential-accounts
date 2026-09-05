/**
 * Where the sealed state actually lives.
 *
 * The chain holds a commitment. The state it commits to — the balance, the
 * entries, and the salt that blinds them — lives here, encrypted under a
 * viewing key this module never sees.
 *
 * WHY THIS IS NOT A DETAIL. M-73 made it concrete rather than theoretical: the
 * run script had no store, moved the account, and the opening evaporated when
 * the process exited. It was only recovered because a *script* derives its
 * state from fixed seeds. A real account's salt is random and there would have
 * been nothing to reconstruct from — the commitment on chain would name a state
 * nobody could ever produce again, and the account would be permanently
 * unreadable while looking perfectly healthy on chain.
 *
 * So the failure mode this file exists to prevent is total and silent, and the
 * two rules that follow from it are worth stating plainly:
 *
 *   1. **Never overwrite, never delete.** Blobs are keyed by the commitment
 *      they open AND the key epoch that sealed them (K-4), so an old state stays
 *      readable and a rotation cannot discard the copy it replaces. That is what lets an auditor
 *      verify a historical attestation, and it means a bug that writes the
 *      wrong blob cannot destroy the right one.
 *   2. **Never half-write.** A truncated blob is indistinguishable from a
 *      corrupt key: AES-GCM fails the tag check either way, and the account
 *      reads as "wrong viewing key" forever. Writes go to a temporary file and
 *      are renamed, which is atomic on POSIX.
 *
 * What this module deliberately does NOT do is decrypt, validate, or even know
 * what a viewing key is. It stores opaque bytes. Anything it could check about
 * the contents would require the key, and holding that key here would undo the
 * entire product.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Sealed, Hex } from '../core/crypto.js';
import type { SealedStateStore } from './ledger.js';

/** Rejects anything that could escape the directory, before it is used as a path. */
const safeSegment = (value: string, what: string): string => {
  if (!/^[a-zA-Z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${what} "${value}" is not a safe path segment`);
  }
  return value;
};

/**
 * On disk, one file per committed state and key epoch.
 *
 * Good enough to run on, and deliberately the smallest thing that has the right
 * properties. Moving to content-addressed storage later removes the operator's
 * ability to withhold a blob without touching anything else, because the
 * on-chain commitment is already the pointer — that is the whole reason this is
 * an interface.
 */
export class FileSealedStateStore implements SealedStateStore {
  constructor(private root: string) {}

  private dirFor(accountId: string): string {
    const dir = join(this.root, safeSegment(accountId, 'account id'));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /*
   * One file per (commitment, key epoch). K-4.
   *
   * The epoch is in the NAME rather than inside the file, so the
   * never-overwrite rule keeps meaning what it says. A rotation writes a second
   * ciphertext for a state whose commitment has not moved, and if the two
   * shared a filename one of them would be discarded — silently, by the very
   * guard that exists to protect them.
   */
  private fileFor(accountId: string, commitment: Hex, keyEpoch: number): string {
    if (!Number.isInteger(keyEpoch) || keyEpoch < 0) {
      throw new Error(`key epoch "${keyEpoch}" is not a whole number of rotations`);
    }
    return join(this.dirFor(accountId), `${safeSegment(commitment, 'commitment')}.k${keyEpoch}.json`);
  }

  async put(accountId: string, commitment: Hex, keyEpoch: number, sealed: Sealed): Promise<void> {
    const target = this.fileFor(accountId, commitment, keyEpoch);

    /*
     * Already there? Leave it.
     *
     * A commitment is a hash of the state, so the same commitment means the
     * same state and rewriting it can only do harm. This also makes `put`
     * idempotent, which matters because `execute` writes the blob before
     * submitting and a retried submission writes it again.
     */
    if (existsSync(target)) return;

    // Temp file then rename. A crash between the two leaves a stray temp file,
    // which is garbage; a crash during a direct write would leave a truncated
    // blob, which is an account nobody can open.
    const temp = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ commitment, keyEpoch, sealed, savedAt: new Date().toISOString() }, null, 2));
      renameSync(temp, target);
    } catch (e) {
      try { if (existsSync(temp)) unlinkSync(temp); } catch { /* the original error matters more */ }
      throw e;
    }
  }

  async get(accountId: string, commitment: Hex, keyEpoch: number): Promise<Sealed | null> {
    const target = this.fileFor(accountId, commitment, keyEpoch);
    if (!existsSync(target)) return null;
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    return parsed.sealed as Sealed;
  }
}

/**
 * In memory, for tests and for the simulated stack.
 *
 * Keeps the same never-overwrite rule as the file store, so a test cannot pass
 * against behaviour the real one does not have.
 */
export class MemorySealedStateStore implements SealedStateStore {
  private blobs = new Map<string, Sealed>();

  private key = (accountId: string, commitment: Hex, keyEpoch: number) =>
    `${accountId}:${commitment}:k${keyEpoch}`;

  async put(accountId: string, commitment: Hex, keyEpoch: number, sealed: Sealed): Promise<void> {
    const k = this.key(accountId, commitment, keyEpoch);
    if (this.blobs.has(k)) return;
    this.blobs.set(k, sealed);
  }

  async get(accountId: string, commitment: Hex, keyEpoch: number): Promise<Sealed | null> {
    return this.blobs.get(this.key(accountId, commitment, keyEpoch)) ?? null;
  }

  /** How many states are retained. Used to assert that history is not discarded. */
  get size(): number { return this.blobs.size; }
}

/**
 * A store that refuses to be used.
 *
 * This exists to be explicit where a stub used to be implicit. The deploy path
 * carried `{ put: async () => {}, get: async () => null }` — a store that
 * silently threw every blob away and reported nothing. That is the shape of
 * M-73: the account looks healthy on chain and is permanently unreadable.
 *
 * If a caller genuinely has no storage yet, this makes them say so and fail
 * loudly at the first write rather than at the first read, which may be months
 * later and by someone else.
 */
export const noSealedStateStore: SealedStateStore = {
  async put(accountId: string): Promise<void> {
    throw new Error(
      `refusing to discard the sealed state for "${accountId}": this ledger was built ` +
        'without a SealedStateStore. Only the commitment goes on chain, so a state that ' +
        'is not stored here is unrecoverable and the account becomes permanently ' +
        'unreadable while looking healthy on chain. See M-73.',
    );
  },
  async get(): Promise<Sealed | null> {
    return null;
  },
};
