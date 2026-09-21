/**
 * Sessions that can actually be revoked.
 *
 * WHAT WAS WRONG. A session was a signed blob: `base64url({uid, exp}).hmac`.
 * The server verified the tag, read the user id out of the payload, and held no
 * record of the session at all. That is a legitimate design — it is what a
 * stateless JWT is — and it has one property this product cannot accept:
 *
 *   **Signing out did nothing.** The client dropped the token; the token stayed
 *   valid until it expired. There was no list to remove it from.
 *
 * So "sign out on the laptop I left at the office" was a button that did
 * nothing, and a stolen token could not be stopped. For a product whose whole
 * claim is that a signer's device is the boundary, a session nobody can end is
 * the wrong shape.
 *
 * WHAT REPLACES IT. A random token, and a row. The row is the authority: if it
 * is gone, revoked or expired, the token is worthless no matter how well
 * formed. Revocation becomes an UPDATE.
 *
 * WHAT IS STORED IS THE HASH, NEVER THE TOKEN. A database backup must not be a
 * stack of working sessions. Same reason a password is never stored, and it
 * costs one sha256 per request.
 *
 * WHY THE RESTART PROBLEM IS RETIRED, NOT WORKED AROUND. The old secret
 * defaulted to a fresh random value on boot, which silently invalidated every
 * session on every restart — a stateless token cannot be verified without the
 * key that signed it, and a signed-out user looks exactly like an expired one,
 * so nobody noticed. A random token checked against a row does not care what
 * the process knows: restart it and the sessions are still there.
 * `SESSION_SECRET` is now unused by sessions and the constructor no longer
 * takes one.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, toHex } from './crypto.js';

export interface SessionRecord {
  userId: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  userAgent: string | null;
}

export interface IssuedSession {
  /** Returned to the client ONCE. Never stored, never logged, never recoverable. */
  token: string;
  expiresAt: string;
}

/** What a session looks like to the person who owns it. Never includes the token. */
export interface SessionSummary {
  id: string;
  issuedAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}

export interface SessionStore {
  issue(
    userId: string,
    opts?: { ttlHours?: number; userAgent?: string | null; now?: Date },
  ): Promise<IssuedSession>;

  /** The user id, or null. Null covers unknown, expired and revoked alike — see below. */
  resolve(token: string, now?: Date): Promise<string | null>;

  /** Ends one session. Idempotent: revoking a dead session is not an error. */
  revoke(token: string, now?: Date): Promise<void>;

  /**
   * Ends one session BY ITS ID — the handle `list` hands out — so a person can
   * sign out a device they are not currently holding.
   *
   * `userId` is not decoration and must not be dropped. A token is 32 random
   * bytes and is its own authority; an id is twelve characters of a hash, shown
   * on a screen and copied into a URL, and is not. Scoping to the owner is what
   * stops an id being a licence to end a stranger's session.
   *
   * Returns true if a live session was ended.
   */
  revokeSession(userId: string, id: string, now?: Date): Promise<boolean>;

  /** Ends every session for a user except, optionally, the one making the request. */
  revokeAll(userId: string, opts?: { except?: string; now?: Date }): Promise<number>;

  list(userId: string, opts?: { current?: string; now?: Date }): Promise<SessionSummary[]>;

  /** Housekeeping. Nothing depends on it: an expired row is refused on read. */
  sweep(now?: Date): Promise<number>;
}

const TOKEN_BYTES = 32;
export const DEFAULT_TTL_HOURS = 12;

/**
 * The lookup key. A hash, so the stored value is useless if the table leaks.
 *
 * No salt, and none is wanted: the token is 32 random bytes, so there is no
 * dictionary to defend against, and a per-row salt would make the lookup
 * impossible without reading every row.
 */
export const tokenHash = (token: string): Uint8Array => sha256(Buffer.from(token, 'utf8'));

/**
 * A short, stable handle for showing a session to its owner without showing the
 * token. Deliberately NOT a credential: 48 bits, derived from the hash, and
 * displayed. Anything that accepts one must also check who is asking — see
 * `revokeSession`.
 */
const HANDLE_CHARS = 12;
const handleOf = (hash: Uint8Array) => toHex(hash).slice(0, HANDLE_CHARS);

export const newToken = (): string => toHex(randomBytes(TOKEN_BYTES));

/*
 * `resolve` returns null rather than a distinguishing error, and that is
 * deliberate. "Expired", "revoked" and "never existed" are three facts an
 * attacker would like told apart, and the caller does the same thing in all
 * three cases: refuse. The reason belongs in a log, not in a response.
 */

export class MemorySessionStore implements SessionStore {
  private rows = new Map<string, SessionRecord>();

  async issue(
    userId: string,
    opts: { ttlHours?: number; userAgent?: string | null; now?: Date } = {},
  ) {
    const now = opts.now ?? new Date();
    const token = newToken();
    const expiresAt = new Date(
      now.getTime() + (opts.ttlHours ?? DEFAULT_TTL_HOURS) * 3600_000,
    ).toISOString();
    this.rows.set(toHex(tokenHash(token)), {
      userId,
      issuedAt: now.toISOString(),
      expiresAt,
      revokedAt: null,
      userAgent: opts.userAgent ?? null,
    });
    return { token, expiresAt };
  }

  async resolve(token: string, now = new Date()) {
    const row = this.rows.get(toHex(tokenHash(token)));
    if (!row || row.revokedAt) return null;
    if (new Date(row.expiresAt) <= now) return null;
    return row.userId;
  }

  async revoke(token: string, now = new Date()) {
    const key = toHex(tokenHash(token));
    const row = this.rows.get(key);
    if (row && !row.revokedAt) this.rows.set(key, { ...row, revokedAt: now.toISOString() });
  }

  async revokeSession(userId: string, id: string, now = new Date()) {
    for (const [key, row] of this.rows) {
      // Both conditions. The id says WHICH session; the user id says WHOSE.
      if (handleOf(Buffer.from(key, 'hex')) !== id || row.userId !== userId) continue;
      if (row.revokedAt) return false;
      this.rows.set(key, { ...row, revokedAt: now.toISOString() });
      return true;
    }
    return false;
  }

  async revokeAll(userId: string, opts: { except?: string; now?: Date } = {}) {
    const now = opts.now ?? new Date();
    const keep = opts.except ? toHex(tokenHash(opts.except)) : null;
    let n = 0;
    for (const [key, row] of this.rows) {
      if (row.userId !== userId || row.revokedAt || key === keep) continue;
      this.rows.set(key, { ...row, revokedAt: now.toISOString() });
      n++;
    }
    return n;
  }

  async list(userId: string, opts: { current?: string; now?: Date } = {}) {
    const now = opts.now ?? new Date();
    const currentKey = opts.current ? toHex(tokenHash(opts.current)) : null;
    return [...this.rows.entries()]
      .filter(([, r]) => r.userId === userId && !r.revokedAt && new Date(r.expiresAt) > now)
      .map(([key, r]) => ({
        id: handleOf(Buffer.from(key, 'hex')),
        issuedAt: r.issuedAt,
        expiresAt: r.expiresAt,
        userAgent: r.userAgent,
        current: key === currentKey,
      }))
      .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
  }

  async sweep(now = new Date()) {
    let n = 0;
    for (const [key, row] of this.rows) {
      if (new Date(row.expiresAt) <= now) {
        this.rows.delete(key);
        n++;
      }
    }
    return n;
  }
}

/** A minimal view of the driver, so this file depends on no particular one. */
export interface SqlRunner {
  <T = any>(strings: TemplateStringsArray, ...values: any[]): Promise<T[]>;
}

export class PostgresSessionStore implements SessionStore {
  constructor(private sql: SqlRunner) {}

  async issue(
    userId: string,
    opts: { ttlHours?: number; userAgent?: string | null; now?: Date } = {},
  ) {
    const now = opts.now ?? new Date();
    const token = newToken();
    const expiresAt = new Date(
      now.getTime() + (opts.ttlHours ?? DEFAULT_TTL_HOURS) * 3600_000,
    );
    await this.sql`
      INSERT INTO sessions (token_hash, user_id, issued_at, expires_at, user_agent)
      VALUES (${Buffer.from(tokenHash(token))}, ${userId}, ${now}, ${expiresAt},
              ${opts.userAgent ?? null})
    `;
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async resolve(token: string, now = new Date()) {
    // One statement, and the conditions live in the WHERE rather than in
    // JavaScript: a row fetched and then checked is a row that could be checked
    // wrongly, and this is the check every authenticated request depends on.
    const rows = await this.sql<{ user_id: string }>`
      SELECT user_id FROM sessions
      WHERE token_hash = ${Buffer.from(tokenHash(token))}
        AND revoked_at IS NULL
        AND expires_at > ${now}
    `;
    return rows[0]?.user_id ?? null;
  }

  async revoke(token: string, now = new Date()) {
    await this.sql`
      UPDATE sessions SET revoked_at = ${now}
      WHERE token_hash = ${Buffer.from(tokenHash(token))} AND revoked_at IS NULL
    `;
  }

  async revokeSession(userId: string, id: string, now = new Date()) {
    // An id is a handle, not a credential — see the note on the interface. The
    // `user_id` clause is the security property; the handle only picks a row.
    const rows = await this.sql<{ n: string }>`
      WITH gone AS (
        UPDATE sessions SET revoked_at = ${now}
        WHERE user_id = ${userId}
          AND left(encode(token_hash, 'hex'), ${HANDLE_CHARS}) = ${id}
          AND revoked_at IS NULL
        RETURNING 1
      ) SELECT count(*)::text AS n FROM gone
    `;
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async revokeAll(userId: string, opts: { except?: string; now?: Date } = {}) {
    const now = opts.now ?? new Date();
    const except = opts.except ? Buffer.from(tokenHash(opts.except)) : Buffer.alloc(0);
    const rows = await this.sql<{ count: string }>`
      WITH gone AS (
        UPDATE sessions SET revoked_at = ${now}
        WHERE user_id = ${userId} AND revoked_at IS NULL AND token_hash <> ${except}
        RETURNING 1
      ) SELECT count(*)::text AS count FROM gone
    `;
    return Number(rows[0]?.count ?? 0);
  }

  async list(userId: string, opts: { current?: string; now?: Date } = {}) {
    const now = opts.now ?? new Date();
    const rows = await this.sql<any>`
      SELECT token_hash, issued_at, expires_at, user_agent FROM sessions
      WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > ${now}
      ORDER BY issued_at
    `;
    const currentKey = opts.current ? toHex(tokenHash(opts.current)) : null;
    return rows.map((r: any) => {
      const key = toHex(new Uint8Array(r.token_hash));
      return {
        id: handleOf(new Uint8Array(r.token_hash)),
        issuedAt: new Date(r.issued_at).toISOString(),
        expiresAt: new Date(r.expires_at).toISOString(),
        userAgent: r.user_agent ?? null,
        current: key === currentKey,
      };
    });
  }

  async sweep(now = new Date()) {
    const rows = await this.sql<{ count: string }>`
      WITH gone AS (DELETE FROM sessions WHERE expires_at <= ${now} RETURNING 1)
      SELECT count(*)::text AS count FROM gone
    `;
    return Number(rows[0]?.count ?? 0);
  }
}
