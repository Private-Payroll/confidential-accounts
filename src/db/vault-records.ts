/**
 * **A VAULT'S SEALED RECORDS IN THE PRODUCT'S DATABASE: ITS NOTE POOL AND ITS
 * TWO ATTEMPT JOURNALS.**
 *
 * The note pool is the only record of what a vault's notes ARE. The chain
 * publishes commitments, and a commitment cannot be inverted, so a pool that
 * exists in one folder on one machine is money that one disk failure makes
 * unnameable. This is the store the product holds instead: every version of
 * each record is a row, and the four properties `SealedPoolStore` requires are
 * enforced by the table rather than by care.
 *
 *   1. **One writer per version.** The primary key is the claim. Two writers
 *      filing the same version insert one row between them; the other insert
 *      fails, writes nothing, and is answered with
 *      `VaultPoolVersionAlreadyFiled` - the same named refusal every store
 *      raises, so the retry that acts on it is the same retry everywhere.
 *   2. **Versions follow one another**, checked in the same statement that
 *      inserts.
 *   3. **A write that returns has happened.** The insert commits with
 *      `synchronous_commit` on, and the row reports the mode it committed
 *      under; a commit under any other mode is rolled back. A server that does
 *      not flush its log at all is refused when the store is opened
 *      (`assertCommitsAreDurable`).
 *   4. **Nothing filed is changed or removed.** The table's own triggers refuse
 *      an update, a delete and a truncate.
 *
 * **A PARTIAL WRITE CANNOT BE READ AS A WHOLE ONE.** A row is inserted by one
 * statement in one transaction, so it is there whole or not at all; and every
 * row carries the digest of its own body, checked on every read, so a row that
 * is somehow not what was written is refused rather than opened.
 *
 * **WHAT THE SERVER HOLDS IS CIPHERTEXT, AND WHAT IT CAN READ IS A COUNTER.** A
 * body is a `SealedPool`: sealed under a fresh key wrapped to each signer's own
 * key. Nothing here holds a signer's secret and nothing here opens a body.
 * **THE VAULT'S ADDRESS IS NOT A COLUMN**: rows are keyed by a hash of it,
 * because a database key is printed by every error that names it and an
 * address pasted into a wallet destroys the money sent to it.
 *
 * **NODE ONLY.** It imports `node:crypto` and `node:fs`, and nothing a page
 * loads may import it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  whyThisIsNotASealedPool, assertTheNextVersion, VaultPoolVersionAlreadyFiled,
  type FiledPoolVersion, type SealedPool, type SealedPoolStore,
} from '../midnight/vault-pool.js';
import { parseVaultRegistry, namesRecordedFor } from '../midnight/vault-record.js';

/** The three sealed records a vault has. */
export type VaultRecord = 'pool' | 'deposit-journal' | 'payment-journal';

/** A tagged query, as the driver and a transaction inside it both offer. */
export interface RecordsQuery {
  <T = any>(strings: TemplateStringsArray, ...values: any[]): Promise<T[]>;
}

/** The part of the driver this file uses: tagged queries, and a transaction. */
export interface RecordsSql extends RecordsQuery {
  begin(fn: (tx: any) => Promise<unknown>): Promise<unknown>;
}

/**
 * **THE KEY A VAULT'S ROWS ARE FILED UNDER: A HASH OF ITS ADDRESS, NEVER THE
 * ADDRESS.** The label keeps this hash from being any other hash of an address
 * this product computes.
 */
export const vaultKeyOf = (vault: string): Buffer =>
  createHash('sha256').update('vault-sealed-records\0', 'utf8').update(theOneSpelling(vault), 'utf8').digest();

/**
 * **A VAULT'S ADDRESS HAS ONE SPELLING HERE: 64 LOWER-CASE HEX CHARACTERS.**
 *
 * The key is a hash of the string, so a second spelling of the same address -
 * capitals, a `0x` - would be a second, empty series: a pool that reads as
 * absent and invites a first version, and a journal that reads as empty and
 * files a line no rebuild reading the usual spelling ever sees. So any other
 * spelling is refused, by every read and every write, rather than normalised: a
 * normalised address would still disagree with the one sealed inside the record.
 */
const theOneSpelling = (vault: string): string => {
  if (!/^[0-9a-f]{64}$/.test(vault)) {
    throw new Error(
      'a vault\'s sealed records are filed under its address written as 64 lower-case hex '
      + 'characters, and the address given is not written that way. Nothing is read or written. '
      + 'What resolves it: pass the address exactly as the vault registry holds it. (The address '
      + 'is not printed: it is the one value that destroys money when it is pasted into a wallet.)');
  }
  return vault;
};

const digestOf = (body: string): Buffer => createHash('sha256').update(body, 'utf8').digest();

/** Thrown for a row that is present and cannot be used - never for an absent one. */
export class VaultRecordUnreadable extends Error {
  constructor(readonly record: VaultRecord, readonly version: number, why: string) {
    super(
      `version ${version} of this vault's ${record} is filed and could not be read: ${why}. **This is `
      + 'not an empty record.** A pool that reads as empty is a claim that the vault has no money, and '
      + 'a row that will not open is our ignorance. Nothing is changed. Every other version is still '
      + 'filed, but a rebuild reads every version and stops at this one too, and nothing can be filed '
      + 'after it. What resolves it is not built yet: a filed version can be neither changed nor '
      + 'removed, so setting this one aside needs the database\'s owner, and a written record of why, '
      + 'before anything else is filed for this vault.'
      + ' (the vault is not named here: its address is the one value that destroys money when '
      + 'somebody pastes it into a wallet.)');
    this.name = 'VaultRecordUnreadable';
  }
}

/**
 * **WHY COMMITS ON THIS SERVER MAY NOT BE DURABLE, OR `null` WHEN THEY ARE.**
 *
 * `fsync` off means the server does not flush its log, and a commit it
 * acknowledged can be gone after the power fails. **The one server where that
 * is not so is one that makes a commit durable by replicating its log rather
 * than flushing it**, which is how a Neon compute runs: it reports `fsync` off,
 * and a commit is acknowledged only once a quorum of its log servers holds the
 * record. A Neon compute is recognised by the timeline its server
 * configuration defines: a setting a loaded module declares, fixed when the
 * server starts. A session can invent a setting of the same name with `SET`,
 * and an invented one does not appear among the server's own settings, so it
 * is not believed.
 *
 * `synchronous_commit` is not asked about here, because every write this store
 * makes sets it on for its own transaction and checks that it was.
 */
export const whyCommitsMayNotBeDurable = (s: {
  readonly fsync: string;
  /** The Neon timeline the server's own configuration defines, or null when it defines none. */
  readonly neonTimeline: string | null;
}): string | null => {
  if (s.fsync === 'on') return null;
  if (s.neonTimeline !== null && s.neonTimeline !== '') return null;
  return `this database server runs with fsync ${s.fsync}, so a commit it acknowledges can be lost `
    + 'when its power fails, and it is not a server that makes commits durable by replicating its log. '
    + 'A vault\'s note pool is the only record of what its notes are, and a write that is acknowledged '
    + 'and then lost is a note nobody can name. What resolves it: turn fsync on for this server, or '
    + 'point DATABASE_URL at one that has it on.';
};

/** Reads the two settings `whyCommitsMayNotBeDurable` needs, and refuses on its answer. */
export async function assertCommitsAreDurable(sql: RecordsQuery): Promise<void> {
  const [row] = await sql<{ fsync: string; neon: string | null }>`
    SELECT current_setting('fsync') AS fsync,
           (SELECT setting FROM pg_settings
            WHERE name = 'neon.timeline_id' AND context = 'postmaster') AS neon`;
  const why = whyCommitsMayNotBeDurable({ fsync: String(row?.fsync), neonTimeline: row?.neon ?? null });
  if (why !== null) throw new Error(why);
}

/**
 * **A REFUSAL TO FILE THE FIRST VERSION OF A VAULT'S RECORD WHEN THE OPERATOR
 * TOOLS ON THIS MACHINE ALREADY KEEP THAT VAULT'S RECORDS IN FILES.**
 *
 * A vault whose notes are described in a folder AND in this database has two
 * sources of truth, and a payment built on one of them can spend a note the
 * other does not know is gone. The operator tools keep a vault's records in
 * files, and every vault they keep is in a registry file in their state
 * folder, so a vault in any of those registries is refused here. The address is
 * compared and never printed.
 */
export const refuseVaultsTheOperatorToolsKeep = (stateDir: string) =>
  (vault: string): string | null => {
    if (!existsSync(stateDir)) return null;
    for (const file of readdirSync(stateDir)) {
      const m = /^(.+)-vaults\.json$/.exec(file);
      if (!m) continue;
      /*
       * A registry that will not parse is not an empty one: it may name this
       * vault. So it refuses, rather than letting the first version through.
       */
      let names: string[] = [];
      try {
        names = namesRecordedFor(
          parseVaultRegistry(JSON.parse(readFileSync(join(stateDir, file), 'utf8')), m[1]!), vault);
      } catch {
        return `the operator tools' vault registry ${file} could not be read, so whether they already `
          + 'keep this vault\'s records in files cannot be told. Nothing is filed here. What resolves '
          + 'it: repair or restore that registry file.';
      }
      if (names.length > 0) {
        return `the operator tools on this machine keep this vault's records in files (it is "${names[0]}" `
          + `in ${file}), so filing a first version here would give one vault's notes two records. `
          + 'Nothing is filed. What resolves it: keep using the operator tools for that vault, or give '
          + 'the product a vault the operator tools do not keep.';
      }
    }
    return null;
  };

/** A refusal this file raised inside a transaction, carried out of it unchanged. */
class OwnRefusal {
  constructor(readonly error: Error) {}
}

/** One of a vault's three records, as a `SealedPoolStore`. */
class RecordInTheDatabase implements SealedPoolStore {
  constructor(
    private readonly sql: RecordsSql,
    private readonly record: VaultRecord,
    private readonly refuseToCreate: RefuseToCreate,
  ) {}

  private validated(vault: string, row: { version: number; body: string; digest: Uint8Array }): SealedPool {
    const version = Number(row.version);
    if (!Buffer.from(row.digest).equals(digestOf(row.body))) {
      throw new VaultRecordUnreadable(this.record, version, 'its body does not match the digest filed with it');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.body);
    } catch {
      throw new VaultRecordUnreadable(this.record, version, 'its body is not JSON');
    }
    const why = whyThisIsNotASealedPool(parsed, vault);
    if (why !== null) throw new VaultRecordUnreadable(this.record, version, why);
    if ((parsed as SealedPool).version !== version) {
      throw new VaultRecordUnreadable(
        this.record, version,
        `it is filed as version ${version} and the record inside it says version `
        + `${JSON.stringify((parsed as SealedPool).version)}, and a version is one fact`);
    }
    return parsed as SealedPool;
  }

  async get(vault: string): Promise<SealedPool | null> {
    /* An index lookup: the newest version under the key, and nothing else is read. */
    const rows = await this.sql<{ version: number; body: string; digest: Uint8Array }>`
      SELECT version, body, digest FROM vault_sealed_records
      WHERE vault_key = ${vaultKeyOf(vault)} AND record = ${this.record}
      ORDER BY version DESC LIMIT 1`;
    return rows.length === 0 ? null : this.validated(vault, rows[0]!);
  }

  async versions(vault: string): Promise<readonly FiledPoolVersion[]> {
    const rows = await this.sql<{ version: number; body: string; digest: Uint8Array }>`
      SELECT version, body, digest FROM vault_sealed_records
      WHERE vault_key = ${vaultKeyOf(vault)} AND record = ${this.record}
      ORDER BY version ASC`;
    return rows.map((row) => ({ version: Number(row.version), sealed: this.validated(vault, row) }));
  }

  async put(vault: string, rec: SealedPool): Promise<void> {
    const unusable = whyThisIsNotASealedPool(rec, vault);
    if (unusable !== null) {
      throw new Error(`this is not a sealed record for this vault (${unusable}), so nothing is filed.`);
    }
    theOneSpelling(vault);
    if (rec.version === 1) {
      const refused = this.refuseToCreate(vault);
      if (refused !== null) throw new Error(refused);
    }
    const key = vaultKeyOf(vault);
    const body = JSON.stringify(rec);
    try {
      await this.sql.begin(async (tx: RecordsQuery) => {
        /*
         * **THIS TRANSACTION COMMITS DURABLY WHATEVER THE SERVER'S DEFAULT IS**,
         * and the insert below reports the mode it ran under, so a driver or a
         * pooler that dropped this line is caught rather than trusted.
         */
        await tx`SET LOCAL synchronous_commit TO on`;
        const filed = await tx<{ version: number; commit_mode: string }>`
          INSERT INTO vault_sealed_records (vault_key, record, version, body, digest)
          SELECT ${key}, ${this.record}, ${rec.version}, ${body}, ${digestOf(body)}
          WHERE COALESCE((SELECT max(version) FROM vault_sealed_records
                          WHERE vault_key = ${key} AND record = ${this.record}), 0) = ${rec.version - 1}
          RETURNING version, current_setting('synchronous_commit') AS commit_mode`;
        if (filed.length === 1) {
          if (filed[0]!.commit_mode !== 'on') {
            /* Thrown, so the transaction rolls back and the row is not filed. */
            throw new OwnRefusal(new Error(
              `this write would have committed with synchronous_commit ${filed[0]!.commit_mode}, so its `
              + 'acknowledgement would not mean it is durable. It is rolled back and nothing is filed.'));
          }
          return;
        }
        /* Nothing inserted: say which of the two reasons it was, in the words every store uses. */
        const [newest] = await tx<{ v: number | null }>`
          SELECT max(version) AS v FROM vault_sealed_records
          WHERE vault_key = ${key} AND record = ${this.record}`;
        try {
          assertTheNextVersion(vault, newest?.v === null || newest?.v === undefined ? null : Number(newest.v), rec.version);
        } catch (refusal) {
          throw new OwnRefusal(refusal as Error);
        }
        /* The newest moved to the one before this while it was being filed. */
        throw new OwnRefusal(new VaultPoolVersionAlreadyFiled(vault, rec.version));
      });
    } catch (cause) {
      if (cause instanceof OwnRefusal) throw cause.error;
      if ((cause as { code?: string })?.code === '23505') {
        /* The primary key refused the second of two writers: the claim, decided. */
        throw new VaultPoolVersionAlreadyFiled(vault, rec.version);
      }
      throw new Error(
        `version ${rec.version} of this vault's ${this.record} was not confirmed filed `
        + `(${(cause as Error)?.message ?? String(cause)}). If the database was reached and refused, `
        + 'nothing was written. If the connection failed while the write was committing, it may have '
        + 'been filed: read the record again before deciding anything, and do not file the same change '
        + 'again on the assumption that it was not.', { cause });
    }
  }
}

/**
 * **WHAT THE STORE ASKS BEFORE THE FIRST VERSION OF ANY RECORD IS FILED.** A
 * sentence refuses it. Required, so that a store never answers the question by
 * nobody having asked it: a deployment whose vaults are kept nowhere else says
 * so with `NOTHING_IS_KEPT_ELSEWHERE`.
 */
export type RefuseToCreate = (vault: string) => string | null;
export const NOTHING_IS_KEPT_ELSEWHERE: RefuseToCreate = () => null;

/**
 * **THE PRODUCT'S STORE FOR EVERY VAULT'S SEALED RECORDS.** One object, three
 * records per vault, each a `SealedPoolStore`.
 *
 * **IT IS OPENED ONLY BY `openVaultRecords`**, which asks the server whether its
 * commits are durable first. The constructor is not exported, so there is no
 * way to hold this store without that question having been answered.
 */
/** Held by this module alone, so only `open` can construct the store, typed or not. */
const OPENED_AFTER_THE_CHECK = Symbol('opened after the durability check');

export class PostgresVaultRecords {
  private constructor(
    opened: symbol,
    private readonly sql: RecordsSql,
    private readonly refuseToCreate: RefuseToCreate,
  ) {
    if (opened !== OPENED_AFTER_THE_CHECK) {
      throw new Error(
        'the store of vault records is opened with openVaultRecords, which first asks the database '
        + 'whether its commits are durable. Nothing is read or written.');
    }
  }

  /**
   * **OPENS THE STORE, AFTER ASKING THE SERVER WHETHER ITS COMMITS ARE DURABLE.**
   * A store whose writes can vanish is refused before it is used, not
   * discovered after a payment's change note was written to it.
   */
  static async open(sql: RecordsSql, opts: { readonly refuseToCreate: RefuseToCreate }): Promise<PostgresVaultRecords> {
    await assertCommitsAreDurable(sql);
    return new PostgresVaultRecords(OPENED_AFTER_THE_CHECK, sql, opts.refuseToCreate);
  }

  /** The store for one of a vault's records. */
  of(record: VaultRecord): SealedPoolStore {
    return new RecordInTheDatabase(this.sql, record, this.refuseToCreate);
  }
}

/** `PostgresVaultRecords.open`, as a function. */
export const openVaultRecords = (
  sql: RecordsSql, opts: { readonly refuseToCreate: RefuseToCreate },
): Promise<PostgresVaultRecords> => PostgresVaultRecords.open(sql, opts);
