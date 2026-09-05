import { nanoid } from 'nanoid';
import {
  addressOfVerifyingKey, verify as verifySigned,
} from 'midnight-identity/profile/disclosure';
import type { DisclosureResponse } from 'midnight-identity/profile/disclosure';
import { REQUEST_SCHEMA } from 'midnight-identity/profile/request';
import { usableOrigin } from 'midnight-identity/profile/origin';
import { randomBytes, toHex, type Hex } from './crypto.js';
import { walletKeyOf, type DataStore } from './store.js';
import type { User } from './types.js';
import type { SessionStore } from './sessions.js';
import type { ChallengeStore } from './challenges.js';
import type { RateLimiter } from './rate-limit.js';
import { TooManyAttempts, type RequestContext, type SessionToken } from './identity.js';
import { NETWORKS, type NetworkName } from '../midnight/network.js';

/**
 * SIGNING IN WITH THE WALLET — the payroll half. `docs/scope-payroll-identity.md`
 * §4 and §10 step 1, `docs/NEXT.md` PI1.
 *
 * A person arrives, their Identity wallet signs a payload naming THIS
 * deployment and a nonce THIS deployment issued, and payroll knows them by the
 * address that signature came from. There is no password on this path and
 * nothing derived from one.
 *
 * ── THE CODE THAT CHECKS THE SIGNATURE IS NOT IN THIS FILE, DELIBERATELY ──
 *
 * `verifySigned` and `addressOfVerifyingKey` are imported from the wallet's own
 * package. `docs/NEXT.md` §1: *that code exists once, in the wallet, and must go
 * on existing once.* A vendored copy is two implementations that agree about
 * bytes until the day they do not, and bytes are the whole mechanism — the
 * payload is a hand-rolled length-prefixed encoding precisely so that two
 * parties cannot disagree about it, and copying the encoder is how they would.
 *
 * **WHAT THIS FILE ADDS IS THE RECIPIENT'S SIDE OF THE FOUR BINDINGS**, and
 * every one of them is a value this deployment holds rather than one it was
 * sent. See `signIn` below.
 *
 * ── WHAT PAYROLL LEARNS, AND IT IS ONE STRING ─────────────────────────────
 *
 * A subwallet address. Not a name, not an email, not a person. §2: *the slots
 * come from one secret and one recovery set*, so two addresses may be one
 * human — and payroll must never be able to tell, which is why a `User` here is
 * created per ADDRESS and never merged with another. Merging them would rebuild
 * exactly the link the separate-slot design exists to destroy.
 */

/* ------------------------------ the ask ---------------------------------- */

/**
 * **THE ASK MOVED OUT OF THIS FILE, AND THAT IS THE WHOLE OF `C149`'s REPAIR.**
 * `docs/NEXT.md` X5 §2.
 *
 * `signInAsk` builds a plain object and touches nothing. It was the ONLY thing
 * the browser wanted from this module — `src/web/wallet-sign-in.ts` imported it
 * and got the rest for free, because an import is all-or-nothing. The rest is
 * `verify`, which is `midnight-identity/profile/disclosure`, which is
 * `wallet-sdk-address-format`, which is `ledger-v9`, which is ten megabytes of
 * WebAssembly the page then failed to load. **A blank page, in every real
 * browser, with 908 tests green.**
 *
 * They are re-exported rather than moved-and-forgotten because this file is
 * where the server and `wallet-sign-in.test.ts` already look for them, and
 * moving a name is a change to two files that had nothing wrong with them.
 * **The re-export is safe in the direction that matters**: `wallet-sign-in-ask.ts`
 * does not import this file, so reaching the ask through here costs the SDK and
 * reaching it directly costs nothing.
 */
export { SIGN_IN_KIND, signInAsk } from './wallet-sign-in-ask.js';
export type { SignInAsk } from './wallet-sign-in-ask.js';

/* ---------------------------- refusing well ------------------------------ */

/**
 * EVERY WAY THIS CAN REFUSE, NAMED.
 *
 * The five in the middle are the wallet's own `VerdictFailure` values, passed
 * through unchanged so that a refusal keeps the name the code that made it gave
 * it. The rest are this side's.
 */
export type SignInFailure =
  | 'not-a-response'
  | 'stale-challenge'
  | 'unusable-key'
  | 'address-not-the-signers'
  | 'discloses-something'
  | 'wrong-schema'
  | 'origin-mismatch'
  | 'nonce-mismatch'
  | 'address-mismatch'
  | 'signature-invalid'
  | 'expired-claim';

/**
 * A REFUSAL, NOT AN ERROR STATE TO RECOVER FROM. `docs/NEXT.md` §2.
 *
 * Every one of these means the same thing to the caller — you are not signed
 * in — and the `code` exists so a test can name which binding did the refusing
 * rather than matching on a sentence. `C63` is the row about the second half of
 * that.
 */
export class WalletSignInError extends Error {
  readonly code: SignInFailure;

  constructor(code: SignInFailure, message: string) {
    super(message);
    this.name = 'WalletSignInError';
    this.code = code;
  }
}

/**
 * THE SHAPE CHECK, AND IT IS TOTAL.
 *
 * What arrives is JSON off a wire. Nothing below may throw a `TypeError` out of
 * a property access on a caller matching by name, so every field a later step
 * reads is checked here first, and the refusal is one code.
 */
function asResponse(raw: unknown): DisclosureResponse {
  const nope = (): never => {
    throw new WalletSignInError(
      'not-a-response', 'that is not something this wallet could have signed.');
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) nope();
  const body = raw as Record<string, unknown>;
  const payload = body['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) nope();
  const p = payload as Record<string, unknown>;
  if (typeof p['schema'] !== 'string' || typeof p['origin'] !== 'string'
    || typeof p['nonce'] !== 'string' || typeof p['address'] !== 'string'
    || typeof p['at'] !== 'number' || !Number.isSafeInteger(p['at'])
    || !Array.isArray(p['disclosed']) || !Array.isArray(p['declined'])) nope();
  if (typeof body['signature'] !== 'string' || typeof body['verifyingKey'] !== 'string'
    || typeof body['scheme'] !== 'string') nope();
  return raw as DisclosureResponse;
}

/* ------------------------- where this deployment is ---------------------- */

/**
 * THE ORIGIN THE SIGNATURE MUST NAME, AND WHERE IT COMES FROM.
 *
 * **CONFIGURATION, NEVER A REQUEST HEADER.** This is the one value that makes
 * a replay impossible, and taking it from `Origin` or `Host` would hand the
 * choice to whoever is calling: a sign-in minted for another site, replayed
 * here with a matching header, would verify against itself. The wallet's own
 * rule is that the origin is observed rather than claimed; the server cannot
 * observe a browser, so it holds the value instead. Same rule, other end.
 *
 * **`https://` ONLY, AND THAT IS THE WALLET'S RULE RATHER THAN A PREFERENCE.**
 * `Identity/src/profile/request.ts` refuses any observed origin that is not
 * `https://`, saying *an origin nobody can authenticate is a name, not an
 * identity*. So a deployment served over plain HTTP — `http://localhost`
 * included — cannot be signed in to at all, and finding that out here at
 * start-up is better than finding it out in a wallet tab that silently refuses.
 */
export function walletSignInOrigin(value: string | undefined): string {
  const origin = (value ?? '').trim().replace(/\/+$/, '');
  /*
   * **THE SAME ONE CHECK THE WALLET USES, IMPORTED FROM IT.** `X1`, `C132`.
   *
   * This tested `startsWith('https://')` and then looked separately for a
   * path — the same prefix-then-patch shape as the wallet's own parser, and it
   * would have needed the same repair twice. **`usableOrigin` is the wallet's,
   * it parses rather than matches, and the rule this deployment enforces about
   * who may sign in is therefore the rule the wallet enforces about who it will
   * answer.** Two copies of that rule is one of them being wrong later.
   *
   * It also carries the same single exception: `http` on `localhost`,
   * `127.0.0.1` or `[::1]`, **in a development build only** — which is what
   * lets `APP_ORIGIN=http://localhost:5173` be signed in to for the first time.
   * The gate is `VITE_ALLOW_LOCALHOST_ORIGIN=1`, set inside `npm run dev` and
   * by nothing a person types.
   */
  if (!usableOrigin(origin)) {
    throw new Error(
      `APP_ORIGIN must be the origin this deployment is served from, and it is `
      + `${origin ? `"${origin}"` : 'not set'}. It is what a wallet signature names, so it `
      + 'cannot be read off a request header — a sign-in minted for another site would then '
      + 'verify here against itself. It must be an https origin with no path, or, in a '
      + 'development build, http on localhost, 127.0.0.1 or [::1].');
  }
  return origin;
}

/**
 * **THE SAME KEY UNDER TWO NETWORK NAMES IS A DIFFERENT SENTENCE FROM TWO
 * DIFFERENT KEYS, AND THE CODE CAN TELL THEM APART.**
 * `docs/how-money-can-be-lost.md` `C151`.
 *
 * The refusal used to say *the key is what says who you are, and the two do not
 * agree* — accurate about what it saw and wrong about what had happened. On the
 * first walk-through of the two applications it sent a person to look at their
 * wallet, which was working perfectly; the fault was a network name in a
 * configuration file. **A message that names the likely cause would have turned
 * that into a one-line fix.**
 *
 * So before saying anything, this asks the only question that separates the two:
 * **is there a network on which THIS key writes exactly the address that
 * arrived?** `addressOfVerifyingKey` is the encoder both sides use, so the
 * question is answered by running it rather than by comparing strings — and
 * string comparison could not answer it anyway, because a bech32 checksum
 * covers the network prefix, so the same key on two networks differs in its
 * payload as well as in its prefix.
 *
 * **NOTHING HERE CHANGES A VERDICT.** Both cases are refused, with the same
 * code, exactly as before. Only the words differ.
 */
function refusalOfAddress(
  verifyingKey: string, claimed: string, ours: NetworkName,
): string {
  const elsewhere = NETWORKS.find((n) => {
    if (n === ours) return false;
    try { return addressOfVerifyingKey(verifyingKey, n) === claimed; } catch { return false; }
  });

  if (elsewhere !== undefined) {
    return 'this sign-in is signed by the right key and names that key\'s own address — but '
      + `written for the "${elsewhere}" network, and this deployment writes addresses for `
      + `"${ours}". A network name is part of every Midnight address, so one key produces a `
      + 'different string on each. Nothing is wrong with the wallet or the key: the two '
      + 'applications are configured for different networks, and one of the two settings has '
      + 'to change. It is refused until they agree.';
  }

  return 'this sign-in names one address and was signed by the owner of another. It is '
    + 'refused: the key is what says who you are, and the two do not agree.';
}

/* ------------------------------ the service ------------------------------ */

export interface WalletSignIn {
  readonly user: User;
  readonly session: SessionToken;
  /** Bech32, as the wallet shows it. Derived from the key, never read. */
  readonly address: string;
  /** True the first time this address was seen here. */
  readonly created: boolean;
}

export class WalletIdentityService {
  private readonly origin: string;

  constructor(
    private store: DataStore,
    private sessions: SessionStore,
    private limiter: RateLimiter,
    /**
     * The nonce store. REQUIRED rather than optional, for the reason
     * `IdentityService`'s two required arguments are required: a deployment
     * cannot omit it by not thinking about it, and a sign-in with no one-use
     * nonce is a signature that works for ever.
     */
    private challenges: ChallengeStore,
    where: { origin: string; network: NetworkName },
  ) {
    this.origin = walletSignInOrigin(where.origin);
    this.network = where.network;
  }

  private readonly network: NetworkName;

  /** What this deployment calls itself to a wallet. Untrusted words, shown as text. */
  get requesterOrigin(): string { return this.origin; }

  /**
   * A NONCE OF OURS, USED ONCE, AND A HANDLE THAT TIES IT TO ONE BROWSER.
   *
   * The nonce alone is enough to stop a REPLAY — a captured sign-in cannot be
   * presented twice. It is not enough to stop a FIXATION: somebody who asks
   * this deployment for a nonce, and then gets an honest person's wallet to
   * sign it, can present the answer and be that person.
   *
   * That attack needs the attacker's nonce to reach the victim's payroll page,
   * which needs code running on this origin — but "needs an XSS" is a
   * condition, not a mechanism, and this is ten lines. So the challenge comes
   * in two halves: the nonce, which travels to the wallet and comes back inside
   * the signature, and a HANDLE, which never leaves this deployment's page and
   * must be presented alongside. The store holds one against the other, so a
   * nonce without its handle is not a sign-in.
   */
  async challenge(ctx: RequestContext): Promise<{
    nonce: Hex; handle: Hex; expiresAt: string;
  }> {
    await this.limit(ctx);
    const handle = toHex(randomBytes(32));
    const { challenge, expiresAt } = await this.challenges.issue(handle);
    return { nonce: challenge, handle, expiresAt };
  }

  /**
   * THE FOUR BINDINGS, EACH CHECKED AGAINST SOMETHING WE HOLD.
   * `docs/NEXT.md` PI1 §2.
   *
   * 1. **THE ORIGIN IS OURS.** `this.origin` is configuration. A sign-in minted
   *    for another site names that site inside the signature and is refused.
   * 2. **THE NONCE IS OURS.** `nonce` arrives in the request envelope, but it
   *    is not believed until the store has said *we issued this, to this
   *    handle, and it has not been spent* — and only then is it compared with
   *    the one inside the signature. **Reading the nonce out of the payload and
   *    checking it against itself is the shape of every replay**, and the store
   *    is what makes this the other thing.
   * 3. **THE ADDRESS IS RECOMPUTED FROM THE KEY THAT SIGNED.**
   *    `payload.address` is never the authority — it is compared with the
   *    derived value and a disagreement is refused, so a payload naming
   *    somebody else's address cannot pass as theirs.
   * 4. **A SIGNATURE THAT DOES NOT VERIFY IS A REFUSAL**, not a state to
   *    recover from. There is no branch below that continues past one.
   *
   * The nonce is consumed BEFORE the signature is judged. A challenge presented
   * once is spent whether or not what came with it was any good — otherwise a
   * captured nonce could be tried against until it expired, which turns a
   * one-use proof into a two-minute window. `challenges.ts` makes the same
   * argument for the same reason.
   */
  async signIn(args: {
    handle: string; nonce: string; response: unknown;
  }, ctx: RequestContext): Promise<WalletSignIn> {
    await this.limit(ctx);

    /*
     * **THE CHALLENGE IS SPENT BEFORE ANYTHING ELSE IS EVEN LOOKED AT**, and
     * the order was decided by a test rather than by taste.
     *
     * The shape check came first at one point, so a malformed body was refused
     * as `not-a-response` and left the nonce LIVE — and a nonce that survives
     * being presented is a nonce that can be presented again, which is the
     * two-minute window `challenges.ts` refuses to have. Its own words:
     * *deleted whether or not it matches … otherwise a wrong subject could be
     * tried against the same value until it expired.* Same rule, and the cost
     * is that a client which sends rubbish has to ask for a new challenge,
     * which is exactly what it should do.
     */
    const ours = await this.challenges.consume(String(args.handle ?? ''), args.nonce);
    if (!ours) {
      throw new WalletSignInError(
        'stale-challenge',
        'this sign-in answers a request this deployment did not issue, or one that has '
        + 'already been used or has expired. Start again.');
    }

    const response = asResponse(args.response);

    let address: string;
    try {
      address = addressOfVerifyingKey(response.verifyingKey, this.network);
    } catch {
      throw new WalletSignInError(
        'unusable-key', 'the key that signed this is not one an address can be read from.');
    }

    /*
     * `payingAddress` IS THE DERIVED VALUE, WHICH MAKES `verify`'s OWN ADDRESS
     * BRANCH UNREACHABLE FROM HERE — and that is correct rather than a gap.
     *
     * `verify` exists to answer *is this the owner of the address I am about to
     * pay*, and a recipient paying somebody already knows which address it
     * means. A SIGN-IN is the other direction: the address is the thing being
     * claimed, so there is nothing to compare it against except the key it came
     * out of. The binding that does the work here is the signature, which is
     * over bytes that include the address; the explicit check below is what
     * refuses a payload naming an address its own key does not produce.
     */
    const verdict = verifySigned(response, {
      atOrigin: this.origin,
      expectingNonce: args.nonce,
      payingAddress: address,
      networkId: this.network,
      now: Date.now(),
    });
    if (!verdict.ok) throw new WalletSignInError(verdict.code, verdict.says);

    if (response.payload.address !== address) {
      throw new WalletSignInError('address-not-the-signers', refusalOfAddress(
        response.verifyingKey, response.payload.address, this.network));
    }

    /*
     * A SIGN-IN CARRIES NOTHING ABOUT A PERSON, AND A RESPONSE THAT DOES IS
     * REFUSED RATHER THAN IGNORED.
     *
     * The wallet refuses attributes on the REQUEST; this is the same rule on
     * the answer. Accepting personal details nobody asked for would mean this
     * deployment quietly holding data it has no record of requesting — and
     * disclosure is step 2 of the scope's §10, with a source-of-truth rule that
     * does not exist yet. Ignoring the field would leave whoever sent it
     * entitled to believe it had been honoured.
     */
    if (response.payload.disclosed.length > 0 || response.payload.declined.length > 0) {
      throw new WalletSignInError(
        'discloses-something',
        'this is a sign-in and it carries personal details. Nothing was asked for, so they '
        + 'are refused rather than kept.');
    }

    const existing = this.store.getUserByWalletKey(walletKeyOf(address));
    const user = existing ?? this.createFor(address);
    return {
      user,
      session: await this.sessions.issue(user.id, { userAgent: ctx.userAgent }),
      address,
      created: existing === null,
    };
  }

  /**
   * A PERSON THIS DEPLOYMENT HAS NOT SEEN BEFORE.
   *
   * No email, no name and no password, because the wallet was not asked for
   * any: §10 step 1 is *nothing about profiles*. What is written is a HASH of
   * the address and nothing else, so the row cannot be joined to anything.
   *
   * ── WHY THE ADDRESS ITSELF IS NOT STORED, AND IT IS `A-11`'s ARGUMENT ────
   *
   * `memberUserIds` sits outside the envelope on every account, in the clear.
   * A user row carrying a subwallet address beside it would therefore read as
   * **"this on-chain address holds a seat on this company"** — and where that
   * person is also paid at that slot, which is the ordinary case the
   * one-slot-per-employer design produces, that is exactly the fact
   * `RosterEmployee.address` is sealed to hide: *which on-chain identity a
   * given company pays, which the chain itself does not reveal, because the
   * payments are shielded.* `A-11` removed `Invite.acceptedBy` for one join
   * less than this one.
   *
   * So the stored value is `sha256(address)`, the same construction and the
   * same reason as `inviteKeyOf`. **What that buys and what it does not:** a
   * database dump no longer ENUMERATES which addresses are paid by which
   * companies; somebody holding a candidate address can still CONFIRM one. An
   * address is a public value by design, so confirmability cannot be removed
   * here — and removing it is `docs/scope-server-trust.md`'s job rather than
   * this round's.
   *
   * **THE VERIFYING KEY IS NOT STORED EITHER, FOR THE SAME REASON.** The
   * address is `addressOfVerifyingKey(key)`, so keeping the key would be
   * keeping the address written another way. Nothing needs it: every sign-in
   * arrives with the key that made it.
   */
  private createFor(address: string): User {
    const user: User = {
      id: 'usr_' + nanoid(12),
      email: null,
      name: '',
      /* `PI4b`: `authSalt`, `authHash` and `identityPublicKey` were set to
       * `null` here and are deleted from `User`. Nothing on this path ever set
       * them to anything else — a wallet account never had a password — so the
       * three lines were the last writers of three fields nothing reads. */
      keyBundle: null,
      keyBundleVersion: 0,
      walletKey: walletKeyOf(address),
      createdAt: new Date().toISOString(),
    };
    this.store.putUser(user);
    return user;
  }

  /**
   * COUNTED ON THE ADDRESS RATHER THAN AN EMAIL, because there is no email.
   *
   * Only the per-IP bucket is available before a response has been read — the
   * address is inside the thing being judged, so counting on it would mean
   * doing the work first. The IP bucket is what catches somebody grinding
   * signatures, which is the attack this door has.
   */
  private async limit(ctx: RequestContext): Promise<void> {
    if (!ctx.ip) return;
    const decision = await this.limiter.record('ip', ctx.ip);
    if (!decision.allowed) throw new TooManyAttempts(decision.retryAfterSeconds);
  }
}
