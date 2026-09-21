import type { Sealed } from './crypto.js';
import type { DataStore } from './store.js';
import type { SessionStore, SessionSummary } from './sessions.js';

/**
 * Identity, built on the same assumption as the rest of the product: the server
 * is not trusted with anything that decrypts.
 *
 * **THERE IS NO PASSWORD ANY MORE, AND NOTHING HERE IS DISABLED.**
 *
 *
 * `deriveAuthMaterial`, `KDF`, `register`, `login`, `hashAuth`,
 * `replaceKeyBundle`, `timingSafeEqual`, `authHash` and `authSalt` were here.
 * **A password did two jobs and only one of them was letting you in:** it also
 * produced the key that unsealed a person's keyring. That is why deleting it
 * had to wait until the half that replaces it was built, so the key now comes
 * from the person's own wallet, for one company, after a press on the wallet's
 * own screen. It is different per company, it is never stored, and it can be
 * made again from their seed. **A password could be phished, reused and typed
 * into the wrong page, and a second way to prove who you are is a second thing
 * to steal.**
 *
 * **WHAT IS LEFT IS SESSIONS AND THE SEALED BUNDLE.** Who you are is settled by
 * `WalletIdentityService`; this holds the session that follows from it and the
 * opaque blob the server cannot open.
 *
 * **THE LIMITER IS NO LONGER A CONSTRUCTOR ARGUMENT.** It was required rather
 * than defaulted so a deployment could not omit it by not thinking about it —
 * and what it guarded was `login`, which counted before it compared because
 * argon2id ran on the CLIENT and what arrived was a 32-byte value that cost
 * nothing to check. **There is no such door here now.** The limiter itself is
 * very much alive: `WalletIdentityService` counts every challenge and every
 * sign-in on it, and the unauthenticated invite-offer route counts on it too.
 * Keeping an unused one here would be a required argument that protects
 * nothing, which is the opposite of the property the original signature bought.
 */

export interface SessionToken { token: string; expiresAt: string; }

/**
 * Where the request came from.
 *
 * `ip` is REQUIRED and nullable rather than optional, so a call site that has
 * no address has to say so out loud. An optional field is one a route forgets,
 * and a forgotten IP silently removes the only limit that sees one guess
 * sprayed across a thousand accounts.
 */
export interface RequestContext {
  ip: string | null;
  userAgent?: string | null;
}

/**
 * Thrown when a key bundle write did not see the current one.
 *
 * Carries the version the caller should have seen, so a client can fetch, merge
 * and retry rather than guess.
 */
export class StaleKeyBundle extends Error {
  constructor(public currentVersion: number) {
    super(
      'your keys were changed somewhere else since this device last read them. Reload and try '
      + 'again — writing now would erase that change.');
    this.name = 'StaleKeyBundle';
  }
}

/**
 * Thrown when the limiter refuses. Carries the wait so a route can send it.
 *
 * **DECLARED HERE AND THROWN BY THE WALLET SIGN-IN**, which is the only door
 * that counts attempts now that the password is deleted. It stays in this file
 * because `WalletIdentityService` and both server builds already import it from
 * here, and moving a live exception between files is churn a deletion has no
 * business spending.
 */
export class TooManyAttempts extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`too many attempts. try again in ${retryAfterSeconds} seconds`);
    this.name = 'TooManyAttempts';
  }
}

export class IdentityService {
  constructor(
    private store: DataStore,
    private sessions: SessionStore,
  ) {}

  /* ---------------- what used to be recovery ---------------- */

  /*
   * **THE RECOVERY FLOW IS DELETED**, and the proof is in
   * `docs/reports/PI4a-proof-of-death.md` rather than in this comment.
   *
   * `setPasswordWithSeed`, `recoveryChallenge` and `recoverWithSeed` were
   * here. **It could not serve a wallet account and it had no client at all.**
   * It was keyed by `getUserByEmail`, which refuses an absent email by design,
   * and gated on `identityPublicKey` — and a wallet account is created with
   * both of those `null`. Nothing in `src/web` or `src/standalone` ever
   * called the three routes it sat behind.
   *
   * **A person who has lost access rebuilds their wallet from its twenty-four
   * words and signs in.** The key that opens their keyring is derived from that
   * seed and the company's address, so it comes back with them; it was never
   * something this platform could reissue, and the flow deleted here never
   * pretended to — its own words were *"this does not open the key bundle, and
   * cannot"*.
   *
   * `challenges.ts` STAYS. `WalletIdentityService` uses the same store for the
   * sign-in nonce, so it is reachable and was not deleted with the rest.
   */

  /* ---------------- what used to be registration and login ---------------- */

  /*
   * **`register` AND `login` ARE DELETED WITH THE PASSWORD.**
   *
   * `register` was the only thing that ever wrote `authHash` and `authSalt`,
   * and both fields are gone from `User` with it. `login` was the only caller
   * of the limiter's `email` bucket and the only caller of `clear`, and both
   * went too — see `rate-limit.ts`.
   *
   * **AN ACCOUNT IS CREATED BY A WALLET SIGN-IN AND BY NOTHING ELSE.**
   * `WalletIdentityService.createFor` is the one writer of a `User` row for a
   * person who signed in, and `PayrollService` still seeds one for an invitee
   * who has not.
   *
   * **A STORE HOLDING PASSWORD ACCOUNTS IS NOW UNUSABLE**, and that is allowed
   * rather than overlooked: those rows have no wallet key, so nothing resolves
   * them and no route reaches them. Discarding the store is permitted — it is
   * scaffolding.
   */

  /* ---------------- sessions ---------------- */

  async issue(
    userId: string,
    opts: { ttlHours?: number; userAgent?: string | null } = {},
  ): Promise<SessionToken> {
    return this.sessions.issue(userId, opts);
  }

  /**
   * Returns the user id, or throws.
   *
   * ONE ERROR FOR EVERY WAY OF FAILING. The old version distinguished "not
   * signed in", "not valid" and "expired", which told a caller holding a stolen
   * token whether it was ever real and whether it had been revoked. The store
   * returns null for unknown, expired and revoked alike, and so does this.
   */
  async verify(token: string): Promise<string> {
    const userId = await this.sessions.resolve(token ?? '');
    if (!userId) throw new Error('not signed in');
    // The session can outlive the user it belongs to; the row is authority for
    // the session, not for the account.
    if (!this.store.getUser(userId)) throw new Error('not signed in');
    return userId;
  }

  /** The whole point: this actually ends the session. */
  async signOut(token: string): Promise<void> {
    await this.sessions.revoke(token);
  }

  /**
   * "Sign out my other devices".
   *
   * It used to be described as the useful half of a password change. There is
   * no password change; it is a door of its own and the only one that takes a
   * stolen session away from somebody else's browser.
   */
  async signOutEverywhere(userId: string, exceptToken?: string): Promise<number> {
    return this.sessions.revokeAll(userId, { except: exceptToken });
  }

  /** The signed-in devices, as their owner sees them. Never includes a token. */
  async listSessions(userId: string, currentToken?: string): Promise<SessionSummary[]> {
    return this.sessions.list(userId, { current: currentToken });
  }

  /** Ends one listed session by its id. Scoped to the owner. */
  async endSession(userId: string, id: string): Promise<boolean> {
    return this.sessions.revokeSession(userId, id);
  }

  user(userId: string) {
    const u = this.store.getUser(userId);
    if (!u) throw new Error('user not found');
    return u;
  }

  /**
   * Replaces the sealed bundle. Used whenever the client adds a key to its
   * vault, for example after creating an account. The server takes the
   * ciphertext on trust because it has no way to validate it, which is the
   * correct trade: it also has no way to read it.
   */
  updateKeyBundle(userId: string, keyBundle: Sealed, ifVersion?: number) {
    const user = this.user(userId);
    const current = user.keyBundleVersion ?? 0;
    /*
     * REFUSES A WRITE THAT DID NOT SEE THE LAST ONE.
     *
     * Read-modify-write over the whole bundle, with no version, meant the
     * second of two devices erased the first and nothing noticed — and the
     * value erased is the one thing a derived seat still stores, so the
     * membership it recorded became unreachable.
     *
     * Optional so nothing that has not been taught to send it breaks; a caller
     * that omits it is taking the old behaviour knowingly, and the two routes
     * that matter both send it.
     */
    if (ifVersion !== undefined && ifVersion !== current) {
      throw new StaleKeyBundle(current);
    }
    user.keyBundle = keyBundle;
    user.keyBundleVersion = current + 1;
    this.store.putUser(user);
    return user;
  }

  /*
   * **`replaceKeyBundle` IS DELETED.**
   *
   * It rotated the bundle FOR A PASSWORD CHANGE: a fresh `authSalt`, a fresh
   * `authHash`, the new ciphertext, and every other session ended. Two of those
   * four fields no longer exist and the event that called for it cannot happen.
   *
   * **THE HALF THAT WAS WORTH KEEPING IS ALREADY ITS OWN DOOR.**
   * `signOutEverywhere` is above and `POST /api/me/sessions/others/revoke`
   * reaches it, so a person who thinks a device is compromised still has the
   * one action that helped. `updateKeyBundle` is what writes a bundle now, and
   * it moves the version, which is what the refusal above requires of every
   * writer.
   */
}
