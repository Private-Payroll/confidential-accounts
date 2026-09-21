import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryStore, emptyShape } from './store.js';
import { canonical, parseCanonical } from './crypto.js';
import type { Shape } from './store.js';

/**
 * Server-side persistence. Deliberately boring: a file is trivial to reset and
 * inspect.
 *
 * `canonical`/`parseCanonical` rather than `JSON.stringify`/`JSON.parse`, and
 * this is not a preference.
 *
 * Almost everything in here is ciphertext, but not all of it: a plug-in's
 * spending allowance and a plug-in event's amount are readable by design, and
 * both are bigints. `JSON.stringify` throws on a bigint — which is the loud
 * failure bigint was chosen for, and it would fire on the write that records
 * an installation rather than on the read that misinterprets it. Pretty
 * printing goes with it, which is a real loss for a file meant to be inspected
 * and a small one next to a store that cannot save an installation.
 */
export class FileStore extends MemoryStore {
  constructor(private path: string) {
    super();
    /*
     * A FILE WRITTEN BEFORE A COLLECTION EXISTED IS MISSING THAT COLLECTION,
     * AND THE NEXT WRITE TO IT THROWS.
     *
     * `devices` arrived after this file format did. A store loaded from a file
     * older than that has no `devices` key at all, so the first `putDevice`
     * fails on `undefined[id]` — **the account cannot enrol a device and the
     * error names a property rather than a cause.** Spreading over `emptyShape`
     * fixes it for every collection that will ever be added, rather than for
     * this one.
     *
     * It goes HERE and not in a migration script, for a reason this project has
     * already paid for once: **this file is also what somebody restores from a
     * backup.** A one-shot migration fixes the deploy and not the restore.
     */
    this.data = existsSync(path)
      ? { ...emptyShape(), ...parseCanonical<Shape>(readFileSync(path, 'utf8')) }
      : emptyShape();
    this.flush();
  }
  /**
   * WRITE BESIDE, THEN RENAME.
   *
   * This was one `writeFileSync`, which truncates and then writes. A crash or a
   * full disk part way through leaves a file that is not valid JSON — and the
   * constructor parses eagerly, so **the next start fails for EVERY account,
   * not for the record being written.** One store file holds every user's key
   * bundle and every sealed account, so the blast radius of a half-write is the
   * whole product.
   *
   * `rename` within a directory is atomic on every filesystem this runs on: the
   * old file is complete until the instant the new one replaces it. That is
   * also what makes `commitRotation`'s claim of being "as atomic as the
   * filesystem allows" true, which it had not been since it was written.
   *
   * **And a failed write must not leave the process serving a change it
   * reported as failed.** The mutation has already happened in memory by the
   * time we get here, so if the write throws we put the previous data back
   * before rethrowing: a caller that sees an error can rely on nothing having
   * changed, which is what `remove` needs to be safe to retry.
   */
  protected override flush() {
    if (!this.path) return;
    const next = canonical(this.data);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.' + process.pid + '.tmp';
    try {
      writeFileSync(tmp, next);
      renameSync(tmp, this.path);
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* nothing to add */ }
      if (this.committed !== null) this.data = parseCanonical<Shape>(this.committed);
      throw e;
    }
    this.committed = next;
  }

  /** The last text that actually reached disk. What a failed flush rolls back to. */
  private committed: string | null = null;
}
