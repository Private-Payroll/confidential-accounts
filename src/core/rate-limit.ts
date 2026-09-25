/**
 * The attempt limiter.
 *
 * **IT WAS THE LOGIN LIMITER AND LOGIN IS DELETED.** The attack
 * it was written for was a password one: argon2id ran on the CLIENT, so what
 * arrived was a 32-byte `authKey` that cost nothing to check — the expensive
 * step a password normally imposes on a guesser had already been paid, by the
 * honest client, once, and an attacker simply skipped it.
 *
 * **THE MECHANISM OUTLIVED THE DOOR IT WAS BUILT FOR, AND OTHERS USE IT.**
 * `WalletIdentityService` counts every challenge and every sign-in attempt on
 * the `ip` scope; `GET /api/invites/:token/offer`, a METERED door that answers
 * a stranger, counts on `invite-offer`; and the three doors a payee asks for
 * their own payslips by, which answer a signed-in person only, share
 * `payslips`. None is a guessing oracle the way login was; what a limit buys
 * them is that an attempt is BOUNDED and therefore visible.
 *
 * **THE WORD `METERED` IS DOING REAL WORK AND USED TO BE MISSING.** This
 * sentence once said *the one door that answers a stranger*, flat, and that is
 * FALSE at source: **twelve routes in `src/server/index.ts` carry no
 * `authed`**, nine of them wrapped by `wrap` and three registered bare. Read
 * as written it would say the unauthenticated surface is one endpoint wide and
 * metered, when it is twelve wide: one is metered in the route itself, and the
 * two wallet sign-in doors are metered inside the service.
 *
 * ONE MECHANISM, A SCOPE PER DOOR. Each is the same bucket with a different
 * `scope`, so there is one rule to get right rather than one per caller.
 *
 * ATOMICITY IS THE WHOLE THING. A limiter that reads, adds one, and writes back
 * can be defeated by sending the requests concurrently: every request reads 4,
 * every request writes 5, and a hundred attempts count as one. That is not a
 * theoretical race — it is the first thing an attacker tries, and it is exactly
 * why this could not be built on the JSON store, where concurrent writes are
 * known to interleave and lose data. The Postgres implementation therefore does
 * the increment IN THE DATABASE, in a single statement, and returns the
 * resulting count. Nothing reads-then-writes.
 */

/** What a caller needs to know: may this attempt proceed, and if not, for how long. */
export interface LimitDecision {
  allowed: boolean;
  /** Attempts recorded in the current window, including this one. */
  attempts: number;
  /** Seconds until the caller may try again. Zero when allowed. */
  retryAfterSeconds: number;
}

export interface LimitPolicy {
  /** Attempts permitted per window, per key. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/**
 * Deliberately per-scope rather than one global number.
 *
 * A real person retrying a wallet press that did not land must not be treated
 * like a script, and a script working from one address must not be invisible
 * because each thing it touched only saw two attempts.
 *
 * **THE `email` BUCKET IS DELETED.** It counted attempts per account on the way
 * into `login`, and `login` was the only thing that ever recorded on it or
 * cleared it. **A bucket nothing fills is a limit that reads as protection and
 * is not one**, which is the same failure from the other side: a limiter that
 * existed and a route that never called it.
 */
/**
 * **WHAT AN UNKNOWN SCOPE IS COUNTED UNDER.**
 *
 * Both implementations fall back to this when `policy[scope]` is absent, so a
 * scope name with a typo in it is METERED rather than waved through. It used to
 * be `DEFAULT_POLICY.email`, which was deleted — **and these are that bucket's
 * numbers on purpose**: falling back to one of the remaining scopes would have
 * changed the unknown-scope ceiling as a side effect of a deletion, and falling
 * back to the most generous one would turn a typo into a quiet removal of the
 * limit. Named rather than borrowed, so the next person to change a scope's
 * numbers does not move this without meaning to.
 */
export const FALLBACK_POLICY: LimitPolicy = { max: 10, windowSeconds: 15 * 60 };

export const DEFAULT_POLICY: Record<string, LimitPolicy> = {
  /**
   * Higher than a per-person limit would be, because an office shares an
   * address — but far below what a script needs to be useful. Every wallet
   * challenge and every wallet sign-in is counted here.
   */
  ip: { max: 60, windowSeconds: 15 * 60 },
  /**
   * **THE UNAUTHENTICATED OFFER ENDPOINT.** `docs/NEXT.md` `X11` §6,
   * `docs/scope-invitations.md` §8.
   *
   * `GET /api/invites/:token/offer` is the one door in this product that
   * answers a stranger AND COUNTS THE ANSWER, and it was made reachable by a
   * real screen for the first time. **It is not the only unauthenticated
   * door.** Twelve routes carry no `authed`; what is unique here is the meter,
   * which is what the paragraph was always about and what it did not say. The
   * scope's own words: *"about a hundred bits of token is the only thing
   * between a guesser and a salary."*
   *
   * **A HUNDRED BITS IS NOT GUESSABLE, SO THIS IS DEPTH RATHER THAN URGENCY**
   * — said plainly rather than dressed up. `nanoid(18)` over a 64-character
   * alphabet is 108 bits, and no rate limit is what stands between that and a
   * guesser. What a limit actually buys is that the attempt is BOUNDED and
   * therefore visible: an endpoint nobody can hammer is an endpoint whose
   * traffic means something.
   *
   * **AND IT IS KEYED ON THE CALLER, NEVER ON THE TOKEN.** The reason is
   * arithmetic: a limit per token lets one guesser walk the whole space at one
   * attempt per token for ever, because every guess is a different bucket. The
   * bucket has to be the thing that does not change between guesses, and that
   * is who is asking.
   *
   * Lower than `ip`, and it used to be described as higher than `email`, which
   * was deleted with the login it counted. An invitee re-reads their own offer
   * a few times — they open the link, they sign in, they come back — and an
   * office shares an address. Thirty in a quarter of an hour is generous for
   * both and useless to a script.
   */
  'invite-offer': { max: 30, windowSeconds: 15 * 60 },
  /**
   * **A PAYEE'S OWN PAYSLIPS, ASKED BY A SIGNED-IN PERSON.** The page makes
   * three requests per company it opens - the addresses, then the proof and the
   * list for each address. Whether each was paid it reads through the indexer
   * the payee's wallet names, not from here. Counted by where the request comes
   * from, on top of the sign-in.
   * Sixty in a quarter of an hour is a person opening their
   * payslips many times over, and bounds what one caller can make the service
   * read.
   */
  'payslips': { max: 60, windowSeconds: 15 * 60 },
};

export interface RateLimiter {
  /**
   * Records an attempt and says whether it may proceed.
   *
   * Counts the attempt BEFORE deciding, on purpose: a limiter that only counts
   * failures lets an attacker who guesses correctly on attempt 500 through, and
   * the server cannot know the guess was wrong until it has done the work the
   * limiter exists to prevent.
   */
  record(scope: string, key: string, now?: Date): Promise<LimitDecision>;

  /*
   * **`clear` IS DELETED.**
   *
   * It emptied a key's bucket after a SUCCESSFUL login, and `login` was its
   * only caller — deliberately for the `email` scope and deliberately NOT for
   * `ip`, because clearing an address on success hands the limit back to any
   * attacker holding one valid account of their own: spray to the ceiling, log
   * into yours, repeat.
   *
   * **NOTHING SUCCEEDS ON THIS LIMITER ANY MORE IN A WAY THAT SHOULD FORGIVE
   * AN ADDRESS.** The two remaining callers count on `ip` and `invite-offer`,
   * and neither has ever cleared: a wallet sign-in that works is not a reason
   * to stop counting the address it came from, for exactly the reason above.
   * Keeping a method with no caller in an interface is keeping a door two
   * implementations must both get right for nobody.
   */
}

/** Floors `now` to the start of its window, so a bucket is a primary key. */
export const windowStart = (now: Date, windowSeconds: number): Date =>
  new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000);

const decide = (
  attempts: number,
  policy: LimitPolicy,
  start: Date,
  now: Date,
): LimitDecision => {
  const allowed = attempts <= policy.max;
  const endsAt = start.getTime() + policy.windowSeconds * 1000;
  return {
    allowed,
    attempts,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((endsAt - now.getTime()) / 1000)),
  };
};

/**
 * In-memory, for tests and for the standalone single-tab build.
 *
 * **Not for a deployed server**, and the reason is not performance: it is
 * per-process, so two instances double the allowance and a restart clears the
 * count. That is a limiter an attacker can reset by waiting for a deploy.
 */
export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, number>();

  constructor(private policy: Record<string, LimitPolicy> = DEFAULT_POLICY) {}

  async record(scope: string, key: string, now = new Date()): Promise<LimitDecision> {
    const p = this.policy[scope] ?? FALLBACK_POLICY;
    const start = windowStart(now, p.windowSeconds);
    const id = `${scope}:${key}:${start.getTime()}`;
    const attempts = (this.buckets.get(id) ?? 0) + 1;
    this.buckets.set(id, attempts);
    return decide(attempts, p, start, now);
  }
}

/** A minimal view of the driver, so this file does not depend on one. */
export interface SqlRunner {
  <T = any>(strings: TemplateStringsArray, ...values: any[]): Promise<T[]>;
}

/**
 * Postgres, where the increment happens inside the database.
 *
 * `INSERT … ON CONFLICT DO UPDATE SET attempts = login_attempts.attempts + 1
 * RETURNING attempts` is one statement. Postgres takes a row lock for the
 * duration, so a hundred concurrent requests produce the numbers 1 to 100 and
 * not a hundred 1s. **This single line is the difference between a rate limiter
 * and something shaped like one**, and it is why the limiter waited for a real
 * database rather than being bolted onto the JSON store.
 */
export class PostgresRateLimiter implements RateLimiter {
  constructor(
    private sql: SqlRunner,
    private policy: Record<string, LimitPolicy> = DEFAULT_POLICY,
  ) {}

  async record(scope: string, key: string, now = new Date()): Promise<LimitDecision> {
    const p = this.policy[scope] ?? FALLBACK_POLICY;
    const start = windowStart(now, p.windowSeconds);

    const rows = await this.sql<{ attempts: number }>`
      INSERT INTO login_attempts (scope, key, window_start, attempts)
      VALUES (${scope}, ${key}, ${start}, 1)
      ON CONFLICT (scope, key, window_start)
      DO UPDATE SET attempts = login_attempts.attempts + 1
      RETURNING attempts
    `;
    return decide(Number(rows[0].attempts), p, start, now);
  }

  /**
   * Drops buckets whose window has passed. Nothing depends on this for
   * correctness — an old bucket is simply never read again — so it is
   * housekeeping, safe to run on a schedule or never.
   */
  async sweep(olderThan: Date): Promise<number> {
    const rows = await this.sql<{ count: string }>`
      WITH gone AS (DELETE FROM login_attempts WHERE window_start < ${olderThan} RETURNING 1)
      SELECT count(*)::text AS count FROM gone
    `;
    return Number(rows[0]?.count ?? 0);
  }
}
