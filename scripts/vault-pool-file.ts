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
 *
 * ------------------------------------------------------------------------
 * **ONE FILE PER VERSION, AND THE NUMBER IN THE NAME IS WHAT MAKES A WRITE
 * ATOMIC.** This is the half that changed, and it changed because two processes
 * were watched losing a note between them.
 *
 * `put` used to read the stored version, compare it, and then write. Two
 * statements. Two processes that both read version 5 both passed that
 * comparison and both wrote version 6, and the second silently replaced the
 * first: a note the chain holds and no record names. It was worse than that in
 * one interleaving, because both processes staged their bytes under the SAME
 * neighbouring filename, so whichever renamed first published whatever the
 * other had just staged -- **the writer that reported success had its own write
 * thrown away, and the writer that reported failure was the one whose note
 * landed.** Both operators are then misinformed, in opposite directions, about
 * a payment's change note.
 *
 * So the version is no longer compared. **It is CLAIMED**, and the claim is one
 * step that either happens or does not:
 *
 *   1. the record is written to a neighbouring file whose name is unique to
 *      this attempt, so no two writers can ever be staging over each other;
 *   2. `link` gives those same bytes the name this version is filed under.
 *      **`link` creates a name or fails because it exists; there is no third
 *      outcome and nothing in between.** A writer that loses the race learns so
 *      here, having changed nothing, and no version is ever written twice;
 *   3. the winner renames its staged file to the plain, unnumbered name, which
 *      is the same bytes under the name a person reads. That step publishes
 *      nothing and decides nothing -- step 2 already did both.
 *
 * **THE RECORD IS THE HIGHEST-NUMBERED FILE, AND `get` READS THAT.** The
 * unnumbered file is a courtesy for whoever opens the folder. A process killed
 * between steps 2 and 3 leaves the record correct and the courtesy copy one
 * version behind, which is why nothing reads it when a numbered one exists.
 *
 * **WHAT IT COSTS, STATED RATHER THAN HIDDEN: one small file per pool write,
 * kept forever.** A deposit and a payment are one write each, so a payroll of
 * fifty people leaves fifty files of about a kilobyte. Nothing in this project
 * deletes, and the series is not waste: it is every note this pool has ever
 * held, which is the one question a rebuild needs answered and the one thing a
 * single overwritten file cannot answer.
 *
 * **A POOL WRITTEN BEFORE THIS EXISTED IS STILL READ.** A record under the
 * unnumbered name and no numbered file at all is that pool, and it is answered
 * as itself. The first write after that files a numbered one and the series
 * begins.
 */
import {
  existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { VaultPoolVersionAlreadyFiled } from '../src/midnight/vault-pool.js';
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

/**
 * **THE NAME ONE VERSION OF A POOL IS FILED UNDER.** `<the pool file>.v<n>.json`.
 *
 * The number is in the name rather than only in the record because that is what
 * makes a write a claim: `link` refuses a name that exists, so two writers
 * cannot both file version 6 and there is no moment between the check and the
 * write for one of them to slip through.
 *
 * It keeps the vault's NAME and not its address, exactly as the pool file does
 * and for the reason that file's header gives.
 */
export const vaultPoolVersionFile = (poolFile: string, version: number): string =>
  `${poolFile.replace(/\.json$/, '')}.v${version}.json`;

/** The version a filed record's name says it is, or `null` for any other file. */
export const versionFiledAs = (poolFile: string, candidate: string): number | null => {
  const stem = `${basename(poolFile).replace(/\.json$/, '')}.v`;
  if (!candidate.startsWith(stem) || !candidate.endsWith('.json')) return null;
  const digits = candidate.slice(stem.length, -'.json'.length);
  /*
   * `Number` alone would take `' 6'`, `'6e2'`, `'0x6'` and `''`. A filename is
   * an input like any other, and a version read loosely is a record filed under
   * a number nothing wrote.
   */
  if (!/^[1-9][0-9]*$/.test(digits)) return null;
  return Number(digits);
};

/**
 * **EVERY VERSION OF THIS POOL THAT HAS BEEN FILED, OLDEST FIRST, AS SEALED
 * RECORDS.**
 *
 * The union of their notes is every note this pool has ever believed in, which is
 * what a rebuild proposes to the chain (`reconcileVaultPool` in
 * `src/midnight/vault-recovery.ts`). **That is the reason the versions are kept
 * rather than overwritten**, and it is worth saying here because a round tidying
 * up would otherwise find a folder of old files and see only clutter.
 *
 * A record under the unnumbered name is included when it is the only one there --
 * a pool written before versions were filed separately. It is NOT included
 * otherwise, because it is then a copy of one of the numbered ones under a second
 * name, and counting it twice would offer the chain one note as two.
 *
 * **NOTHING HERE OPENS A POOL.** Each record is still sealed, and opening one
 * needs a signer's own secret half; this only says which records exist and
 * refuses any that are present and unreadable.
 */
export const everyVersionFiled = (
  poolFile: string, vault: string,
): { version: number; sealed: SealedPool }[] => {
  const dir = dirname(poolFile);
  const found: { version: number; sealed: SealedPool }[] = [];
  const read = (file: string): SealedPool => {
    const store = new FileSealedPoolStore(poolFile, vault);
    return store.recordAt(file);
  };
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir).sort()) {
      const v = versionFiledAs(poolFile, entry);
      if (v !== null) found.push({ version: v, sealed: read(join(dir, entry)) });
    }
  }
  if (found.length === 0 && existsSync(poolFile)) {
    const sealed = read(poolFile);
    found.push({ version: sealed.version, sealed });
  }
  return found.sort((a, b) => a.version - b.version);
};

/**
 * **THE HIGHEST VERSION FILED FOR THIS POOL, OR `null` IF NONE IS.**
 *
 * A directory read rather than a remembered number, because the writers are
 * separate processes and a number one of them holds says nothing about what the
 * others have filed since.
 */
export const highestVersionFiled = (poolFile: string): number | null => {
  const dir = dirname(poolFile);
  if (!existsSync(dir)) return null;
  let highest: number | null = null;
  for (const entry of readdirSync(dir)) {
    const v = versionFiledAs(poolFile, entry);
    if (v !== null && (highest === null || v > highest)) highest = v;
  }
  return highest;
};

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

/**
 * **A NAME NO OTHER WRITER AND NO OTHER ATTEMPT COULD BE USING.**
 *
 * It used to be one shared name, `<pool>.writing`, and two processes staging under
 * it wrote over each other's bytes: whichever renamed first published whatever the
 * other had just staged, so **the writer that reported success had its own write
 * discarded and the writer that reported failure was the one whose note landed.**
 * Measured across two real processes, once in twenty runs.
 *
 * **A PROCESS ID ALONE IS NOT ENOUGH** -- ids are reused, and one process writes
 * this pool more than once -- so random bytes carry it. It is a function rather
 * than an expression inside `put` so that its uniqueness can be asserted by
 * calling it twice, which a single process can do; asserting on the shape of the
 * name accepted `randomBytes(0)`, and a second reading found that.
 */
export const stagingNameFor = (poolFile: string): string =>
  `${poolFile}.writing.${process.pid}.${randomBytes(8).toString('hex')}`;

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

  /**
   * **WHICH FILE HOLDS THE RECORD RIGHT NOW.** The highest-numbered one, or the
   * unnumbered one for a pool written before versions were filed separately.
   *
   * It is asked afresh on every read. A number this process learned a moment ago
   * is a claim about the other two writers, and it has no standing to make one.
   */
  private recordFile(): string | null {
    const highest = highestVersionFiled(this.file);
    if (highest !== null) return vaultPoolVersionFile(this.file, highest);
    return existsSync(this.file) ? this.file : null;
  }

  /**
   * **ONE FILE, VALIDATED, AS A RECORD.** Public so that reading the whole filed
   * series goes through THIS validation rather than a second copy of it: a
   * rebuild that accepted a record `get` would have refused is a rebuild built on
   * bytes nothing checked.
   */
  recordAt(file: string): SealedPool {
    return this.validated(file, this.readRaw(file));
  }

  /** The bytes of one record, or a refusal naming the file that would not open. */
  private readRaw(from: string): string {
    try {
      return readFileSync(from, 'utf8');
    } catch (cause) {
      throw new VaultPoolFileUnreadable(from, `it could not be opened: ${String(cause)}`);
    }
  }

  /**
   * **SHAPE-CHECKED AT THE BOUNDARY, REFUSING RATHER THAN COERCING.** One copy of
   * these refusals, reached by `get` and by `recordAt`, so a record that reaches a
   * rebuild has passed exactly what a record that reaches a payment has passed.
   */
  private validated(from: string, raw: string): SealedPool {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /*
       * A half-written file lands here, and it is the failure `put` below is
       * shaped to prevent rather than the one it is allowed to have.
       */
      throw new VaultPoolFileUnreadable(
        from, 'it is not JSON — a truncated write looks exactly like this');
    }
    /*
     * SHAPE-CHECKED AT THE BOUNDARY, refusing rather than coercing. `C188`'s
     * rule: a record missing its `wrapped` list is not a pool wrapped to
     * nobody, it is a record we do not understand — and `sealPool` already
     * refuses to CREATE one wrapped to nobody (`V-91`), so reading one back
     * that way means the file is wrong.
     */
    if (parsed === null || typeof parsed !== 'object') {
      throw new VaultPoolFileUnreadable(from, `it holds ${typeof parsed}, not a record`);
    }
    if (typeof parsed.vault !== 'string' || parsed.vault !== this.vault) {
      throw new VaultPoolFileUnreadable(
        from,
        'it is a pool for a DIFFERENT vault than the one this store is for. Opening it would '
        + 'describe somebody else\x27s money in this vault\x27s name');
    }
    if (!Number.isInteger(parsed.version) || parsed.version < 1) {
      throw new VaultPoolFileUnreadable(
        from, `its version is ${JSON.stringify(parsed.version)} rather than a whole number`);
    }
    if (!Array.isArray(parsed.wrapped) || parsed.wrapped.length === 0) {
      throw new VaultPoolFileUnreadable(
        from,
        'it carries no wrapped keys, so there is no device anywhere that could open it. That is '
        + 'not a pool with no notes in it — it is ciphertext with no key in the world');
    }
    if (parsed.sealed === null || typeof parsed.sealed !== 'object') {
      throw new VaultPoolFileUnreadable(from, 'it carries no sealed payload');
    }
    /*
     * **THE NUMBER IN THE NAME AND THE NUMBER IN THE RECORD ARE ONE FACT, SO
     * THEY HAVE TO AGREE.** The name is what the version was CLAIMED under -- it
     * is the thing `link` refused to duplicate -- and the record is what the
     * claim was about. Two writers can never both claim a number, so two records
     * disagreeing with their own names is not a race: it is a file written by
     * something that is not this store. Trusting the record over its name would
     * let one hand-written file take a number that is already spoken for, and
     * the write that follows it would be filed on top of a version nobody read.
     */
    const filedAs = versionFiledAs(this.file, basename(from));
    if (filedAs !== null && parsed.version !== filedAs) {
      throw new VaultPoolFileUnreadable(
        from,
        `it is filed as version ${filedAs} and the record inside it says version `
        + `${JSON.stringify(parsed.version)}. A version is claimed by the name, so those are one `
        + 'fact written down twice and they do not match. This store never writes such a file: '
        + 'something else did -- a record restored under the wrong name, or copied by hand -- and '
        + 'which of the two numbers is true cannot be decided from here.\n'
        + '**WHAT RESOLVES IT: move that one file out of the state folder.** Nothing else is '
        + 'affected; every other version stays filed and the pool reads from the highest-numbered '
        + 'one that is left. Do not edit it in place and do not renumber it, because either makes a '
        + 'record that claims a version it never claimed.');
    }
    return parsed as SealedPool;
  }

  async get(vault: string): Promise<SealedPool | null> {
    this.mine(vault);
    /* ABSENT is `null`, and `SealedNotePool` is what turns that into a refusal
     * saying create() is how a vault that never had one gets its first. */
    const from = this.recordFile();
    if (from === null) return null;

    return this.validated(from, this.readRaw(from));
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
    /*
     * **THIS COMPARISON IS A COURTESY AND NOT THE GUARD.** It answers the
     * ordinary case -- one operator, one stale copy -- with a sentence that says
     * what happened, before any bytes are written. It cannot be the guard,
     * because between reading `existing` and filing anything there is a gap, and
     * two processes have been watched walking through it together. What decides
     * is the `link` below.
     */
    const existing = await this.get(vault);
    if (existing && rec.version <= existing.version) {
      /*
       * **THE SAME NAMED REFUSAL AS THE CLAIM BELOW, BECAUSE IT IS THE SAME
       * FACT.** The version this write wants is already taken. Reached here it
       * means the pool moved before this attempt started; reached at the `link`
       * it means it moved during. Neither is a damaged record, both leave the
       * pool exactly as it was, and both are answered the same way: read again
       * and apply the change to what the pool holds now.
       *
       * It used to be a plain `Error` saying *"refusing to write"*, and the
       * in-memory store said the same thing in its own words. Two stores, two
       * sentences, one fact -- so the retry that acts on it could only ever be
       * written against one of them.
       */
      throw new VaultPoolVersionAlreadyFiled(this.vault, rec.version);
    }
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    /*
     * **UNIQUE TO THIS ATTEMPT.** It used to be one shared name, and two
     * processes staging under it published each other's bytes: the one that
     * reported success had its write discarded and the one that reported failure
     * was the one whose note landed. A process id alone is not enough -- ids are
     * reused, and one process may write twice -- so random bytes carry it.
     */
    const staging = stagingNameFor(this.file);
    writeFileSync(staging, JSON.stringify(rec, null, 2), { mode: 0o600 });
    /*
     * **THE ONE STEP THAT DECIDES, AND IT HAS TWO OUTCOMES AND NO MIDDLE.**
     *
     * `link` gives the staged bytes the name this version is filed under. The
     * kernel either creates that name or refuses because it already exists;
     * there is no window inside it for a second writer, which is the whole
     * difference between this and comparing a number and then writing.
     *
     * **A REFUSAL HERE HAS CHANGED NOTHING ABOUT THE POOL**, so it is safe in
     * the one place it has to be: the caller may have already moved money, and
     * this refusal tells it that the pool it meant to advance was advanced by
     * somebody else, with that somebody's write intact.
     */
    const filed = vaultPoolVersionFile(this.file, rec.version);
    try {
      linkSync(staging, filed);
    } catch (cause) {
      /*
       * **THE STAGED COPY GOES, WHICHEVER WAY THIS FAILED.** It is a sealed copy of
       * the money under a name nothing reads and `everyVersionFiled` never lists,
       * and every lost race would otherwise leave one. The change that introduced this
       * asserted "no staging file of ANY name after a write" and then left one on
       * both failure paths; an audit found it.
       *
       * The removal is best-effort and its failure is not reported: the write has
       * already not happened, and a second error about a temporary file would bury
       * the first, which is the one that says what became of the money.
       */
      try { unlinkSync(staging); } catch { /* a leftover file is rubbish, not a defect */ }
      if ((cause as { code?: string })?.code === 'EEXIST') {
        /*
         * **THE SHARED REFUSAL, NOT ONE OF THIS FILE'S OWN.** The in-memory store
         * raises the same class for the same fact, so the retry that acts on it
         * is exercised by tests against that store and taken by instruments
         * against this one. A refusal only the shipped path raises by name is a
         * refusal no test reaches.
         */
        throw new VaultPoolVersionAlreadyFiled(this.vault, rec.version);
      }
      throw new Error(
        `this vault's pool could not be filed as version ${rec.version} `
        + `(${(cause as Error)?.message ?? String(cause)}). **Nothing has been written**, so the `
        + 'pool is exactly as it was and whatever the last writer recorded is still there. If the '
        + 'change being saved records money that has already moved on chain, the chain holds it '
        + 'and this pool does not yet.\n'
        + '**IF THIS FAILS EVERY TIME, SUSPECT THE FILESYSTEM RATHER THAN THE POOL.** A version is '
        + 'claimed by making a second name for a file, and a filesystem that cannot do that -- some '
        + 'network shares, some removable disks, some cloud-sync folders -- fails here for every '
        + 'writer and every write, with the money moving and nothing recorded. Move the state '
        + 'folder to a local disk.',
        { cause });
    }
    /*
     * **THE SAME BYTES UNDER THE NAME A PERSON READS, AND IT DECIDES NOTHING.**
     *
     * `get` reads the highest-numbered file, so this is a courtesy for whoever
     * opens the folder rather than a second record. It is a rename because a
     * rename also takes the staging name away, leaving one file per version and
     * nothing half-named. A process killed between the `link` and here leaves
     * the record correct and this copy one version behind, which is exactly why
     * nothing reads it while a numbered file exists.
     */
    renameSync(staging, this.file);
  }
}
