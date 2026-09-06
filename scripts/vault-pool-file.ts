/**
 * **WHERE A VAULT'S SEALED NOTE POOL LIVES ON DISK, AND WHY IT IS NOT IN
 * `src/`.**
 *
 * `src/midnight/vault-pool.ts` ends with `MemorySealedPoolStore` and says of it
 * that it is *"the smallest store with the right properties. Good enough to run
 * on, and deliberately not more."* It is not good enough to run an INSTRUMENT
 * on: a pool that lives in a variable is a pool that exists for one process,
 * and the whole point of `C242` is that the pool is created by one act and read
 * by every later one.
 *
 * **IT IS HERE RATHER THAN BESIDE IT BECAUSE IT OPENS FILES.** `vault-pool.ts`
 * is reached from the application, which is built for a browser; a `node:fs`
 * import in it is a module that cannot be bundled and a rule nobody wrote down.
 * `scripts/deploy-report.ts` is the precedent: shared machinery for the
 * instruments, tested on its own, outside the app's tree.
 *
 * ------------------------------------------------------------------------
 * **THE FILE IS NAMED AFTER THE VAULT, NEVER ADDRESSED BY IT. `C236`.**
 *
 * A filename is a screen — it is in every listing, every error and every backup
 * log — so a file called `vault-pool-<64 hex>.json` puts the one value that
 * destroys money in front of somebody every time they open a folder. `S6e`
 * settled this for the authority file and the registry; the same rule, same
 * reason.
 *
 * **So the store is constructed FOR one vault** and holds the address it is
 * for. It refuses to answer about any other, which is not ceremony: the
 * `SealedPoolStore` interface is keyed by address, and a store that ignored the
 * address it was asked about would serve one vault's pool for another's
 * payment — a pool that opens perfectly and describes somebody else's money.
 *
 * ------------------------------------------------------------------------
 * **EVERY REFUSAL BELOW KEEPS "COULD NOT READ" APART FROM "EMPTY".**
 *
 * That is `vault-pool.ts`'s standing rule and this is the layer where a file
 * system makes it easy to break: a missing file, a truncated write, a file of
 * `{}` and a pool of no notes are four different things and three of them are
 * ignorance. `get` answers `null` for ABSENT — which `SealedNotePool` turns
 * into its own refusal, by name — and throws for anything present it cannot
 * read. It never answers `{ notes: [] }`, because it cannot: it does not open
 * the pool at all, it only carries the sealed record.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { SealedPool, SealedPoolStore } from '../src/midnight/vault-pool.js';
import { assertVaultName } from '../src/midnight/vault-record.js';

/**
 * Where one vault's pool is kept, per network and per vault NAME.
 *
 * `assertVaultName` is the same validator the registry and the authority file
 * use — one rule about what a vault may be called, in one place, because a name
 * carrying a slash or a `..` escapes a directory here exactly as it would
 * there.
 */
export const vaultPoolFile = (stateDir: string, network: string, name: string): string =>
  join(stateDir, `${network}-vault-pool-${assertVaultName(name)}.json`);

/** Thrown for a record that is present and unusable — never for an absent one. */
export class VaultPoolFileUnreadable extends Error {
  constructor(readonly file: string, why: string) {
    super(
      `the note pool file ${file} is present and could not be read: ${why}. **This is not an ` +
      'empty vault.** A pool that reads as empty is a claim that the vault has no money, and a ' +
      'file we could not parse is our ignorance — acting on the first spends nothing, reports a ' +
      'balance of zero, and leaves every commitment on chain unexplained. Do not delete it and ' +
      'do not replace it with an empty one: rebuild from the chain and the payment history with ' +
      'replayVault (src/midnight/vault-recovery.ts).');
    this.name = 'VaultPoolFileUnreadable';
  }
}

export class FileSealedPoolStore implements SealedPoolStore {
  constructor(
    private file: string,
    /** The one vault this store is for. Lower-case hex, as the registry holds it. */
    private vault: string,
  ) {}

  private mine(vault: string): void {
    if (vault !== this.vault) {
      /*
       * NOT a lookup miss. A store built for one vault, asked about another, is
       * a caller holding the wrong store — and answering `null` would read as
       * *"that vault has no pool"*, which is how a second vault gets a
       * fabricated empty one. The address is not printed.
       */
      throw new Error(
        'this note pool store was built for a different vault than the one it is being asked '
        + 'about. It holds ONE vault\x27s pool, named by the vault\x27s name rather than its '
        + 'address, and a store that answered about any address would serve one vault\x27s money '
        + 'for another\x27s payment.');
    }
  }

  async get(vault: string): Promise<SealedPool | null> {
    this.mine(vault);
    /* ABSENT is `null`, and `SealedNotePool` is what turns that into a refusal
     * saying create() is how a vault that never had one gets its first. */
    if (!existsSync(this.file)) return null;

    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (cause) {
      throw new VaultPoolFileUnreadable(this.file, `it could not be opened: ${String(cause)}`);
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /*
       * A half-written file lands here, and it is the failure `put` below is
       * shaped to prevent rather than the one it is allowed to have.
       */
      throw new VaultPoolFileUnreadable(
        this.file, 'it is not JSON — a truncated write looks exactly like this');
    }
    /*
     * SHAPE-CHECKED AT THE BOUNDARY, refusing rather than coercing. `C188`'s
     * rule: a record missing its `wrapped` list is not a pool wrapped to
     * nobody, it is a record we do not understand — and `sealPool` already
     * refuses to CREATE one wrapped to nobody (`V-91`), so reading one back
     * that way means the file is wrong.
     */
    if (parsed === null || typeof parsed !== 'object') {
      throw new VaultPoolFileUnreadable(this.file, `it holds ${typeof parsed}, not a record`);
    }
    if (typeof parsed.vault !== 'string' || parsed.vault !== this.vault) {
      throw new VaultPoolFileUnreadable(
        this.file,
        'it is a pool for a DIFFERENT vault than the one this store is for. Opening it would '
        + 'describe somebody else\x27s money in this vault\x27s name');
    }
    if (!Number.isInteger(parsed.version) || parsed.version < 1) {
      throw new VaultPoolFileUnreadable(
        this.file, `its version is ${JSON.stringify(parsed.version)} rather than a whole number`);
    }
    if (!Array.isArray(parsed.wrapped) || parsed.wrapped.length === 0) {
      throw new VaultPoolFileUnreadable(
        this.file,
        'it carries no wrapped keys, so there is no device anywhere that could open it. That is '
        + 'not a pool with no notes in it — it is ciphertext with no key in the world');
    }
    if (parsed.sealed === null || typeof parsed.sealed !== 'object') {
      throw new VaultPoolFileUnreadable(this.file, 'it carries no sealed payload');
    }
    return parsed as SealedPool;
  }

  /**
   * Writes a pool record, **whole or not at all**.
   *
   * `SealedPoolStore`'s own words: *"`put` must never overwrite and never
   * half-write"* — the first is `SealedNotePool`'s job through `create` versus
   * `save`, and the second is this method's. A truncated pool is
   * indistinguishable from a wrong key and both read as *"this vault is
   * unreadable"* forever, so the bytes are written to a neighbouring file and
   * RENAMED over the target: a rename within one directory is the only step
   * here that either happens or does not.
   *
   * And the version check the memory store makes is made here too, for the same
   * reason and against the same failure: two operators reconciling one vault at
   * once (`B3`). It is not a merge and there is no correct merge — the union
   * invents notes the chain never had and the intersection drops ones it does.
   */
  async put(vault: string, rec: SealedPool): Promise<void> {
    this.mine(vault);
    const existing = await this.get(vault);
    if (existing && rec.version <= existing.version) {
      throw new Error(
        `refusing to write version ${rec.version} of this vault's pool over version `
        + `${existing.version}. Another process has advanced it since it was read, and there is `
        + 'no correct merge of two disagreeing records of which notes exist — reconcile against '
        + 'the chain with replayVault and write once.');
    }
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const staging = `${this.file}.writing`;
    writeFileSync(staging, JSON.stringify(rec, null, 2), { mode: 0o600 });
    renameSync(staging, this.file);
  }
}
