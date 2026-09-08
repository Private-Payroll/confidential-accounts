import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { join } from 'node:path';
import { FileStore } from '../core/store-file.js';
import { wiring, observerView } from '../wiring/selection.js';
import { AccountService } from '../core/account.js';
import { PayrollService, RecordingInviteDelivery } from '../core/payroll.js';
import { PluginService } from '../core/plugins.js';
import { IdentityService, TooManyAttempts, StaleKeyBundle } from '../core/identity.js';
import {
  WalletIdentityService, WalletSignInError, walletSignInOrigin,
} from '../core/wallet-identity.js';
import { NoCompanyAddress, companyForSession } from '../core/company-address.js';
import { MemoryChallengeStore } from '../core/challenges.js';
/* `X8` — the server half of taking a receiving address from a wallet. It
 * reaches the wallet SDK, which is why nothing under `src/web/` may. */
import { WalletPayeeError, payeeFromWallet } from '../core/wallet-payee.js';
import {
  MemorySessionStore, PostgresSessionStore, type SessionStore,
} from '../core/sessions.js';
import {
  MemoryRateLimiter, PostgresRateLimiter, type RateLimiter,
} from '../core/rate-limit.js';
import { seedDemo } from '../core/demo.js';
import { assets as assetRegistry, parseAmount } from '../core/assets.js';
import { bigintJsonReplacer } from '../core/crypto.js';
import type { Hex } from '../core/crypto.js';
import { payeeAddress } from '../midnight/payee-address.js';
import { networkOfThePair } from '../midnight/network.js';
import { runPayments } from '../midnight/run-status.js';
import { loadEnvFile } from '../db/connect.js';
import { appendWebConsole, webConsoleLogPath } from './web-console-log.js';
/* `C157` — every refusal this service makes, kept. See `wrap` below. */
import { appendRefusal, refusalLogPath } from './refusal-log.js';

/**
 * **`.env` IS READ HERE, AND UNTIL X2 IT WAS NOT READ AT ALL.**
 *
 * `npm run dev` starts this file, `DATABASE_URL` lives in `.env`, and nothing
 * in this process ever opened that file — so the server refused to start with
 * *DATABASE_URL is not set* on a machine where it was set, and the payroll app
 * could not be started by anybody. `scripts/db-setup.ts` and `scripts/migrate.ts`
 * have always called this on their first line; the server, which is the thing a
 * person actually runs, was the one entry point that did not.
 *
 * **THE ENVIRONMENT STILL WINS.** `loadEnvFile` only fills a name that is
 * `undefined`, so `ALLOW_SIMULATED_COMPANY_ADDRESS=1` and
 * `VITE_ALLOW_LOCALHOST_ORIGIN=1` — which `npm run dev` sets on the command
 * line, and which are the whole of this deployment's development posture —
 * cannot be turned off by a stale line in a file. `connect.test.ts` holds that
 * for the parser and `server-starts.test.ts` holds it for a real boot, because
 * a posture set in one place and read in another is how `X1` went wrong.
 *
 * **IT IS CALLED HERE AND NOT INSIDE AN IMPORT**, because every environment
 * variable this deployment reads is read in the body of this file, below this
 * line. A module-scope `process.env` read added to anything imported ABOVE
 * would run first and see nothing — grep for one before adding it.
 */
loadEnvFile();

/**
 * Which network this deployment's money is on. A-2, and `C151`.
 *
 * Every payee address is parsed against it, so an address for another network
 * is refused at onboarding — free — rather than at payment time, where a coin
 * public key is network-independent bytes and nothing downstream would object.
 *
 * **IT IS THE WALLET'S NETWORK, NOT `.env`'s.** The address a person signs in
 * with is written by the wallet and re-derived here, and the network name is
 * inside both strings — so these cannot be two decisions. `MIDNIGHT_NETWORK_ID`
 * is now checked rather than obeyed, and a deployment that names a different
 * network stops here, loudly, instead of writing addresses no wallet in this
 * pair can read. `networkOfThePair` carries the whole argument.
 */
const NETWORK = networkOfThePair(process.env.MIDNIGHT_NETWORK_ID);

/**
 * How an amount crosses the HTTP boundary.
 *
 * A DECIMAL STRING PLUS AN ASSET CODE, never a JSON number, and both halves of
 * that are load-bearing.
 *
 * A JSON number cannot carry these values. Amounts are integers in the asset's
 * smallest unit, so one ether is 10^18 — past `Number.MAX_SAFE_INTEGER`, and
 * `JSON.parse` would round it silently on the way in. It is also the wrong
 * thing to ask a person for: nobody types 500000 meaning five thousand pounds.
 *
 * So the wire carries what a human wrote — `"5000.00"` — and the registry's
 * decimals turn it into an integer HERE, at the edge, once. `parseAmount`
 * refuses thousands separators, exponents, signs and more decimal places than
 * the asset has, so a request that would have been rounded is a 400 with a
 * sentence rather than a payslip that is quietly wrong.
 */
const assetCode = z.string().min(1).max(32);

const money = (asset: string, amount: string): bigint =>
  parseAmount(amount, assetRegistry.require(asset));

const DATA = process.env.DATA_PATH ?? join(process.cwd(), '.data', 'beta.json');

const store = new FileStore(DATA);
/*
 * LEDGER, PROOF SYSTEM AND COMMITMENT SCHEME COME FROM ONE PLACE AND CANNOT BE
 * PICKED APART. `src/wiring/selection.ts` says why at length; the short of it is
 * that this file used to construct the first two here and let `AccountService`
 * default the third, so changing the two would have left the simulated scheme
 * computing leaves a real contract cannot read.
 *
 * The commitment scheme is passed explicitly for that reason. The default at
 * `src/core/account.ts:253` is still there and still the same value, so nothing
 * behaves differently today — removing it, so that a mismatch is a compile error
 * instead of an unprovable leaf, is R3.
 */
const chosen = wiring();
const ledger = chosen.createLedger();
const proofs = chosen.createProofSystem();
const accounts = new AccountService(store, ledger, chosen.commitments);
/**
 * Where employee invites go. A-10.
 *
 * **This is not a mailer**, and the product does not have one yet — it keeps
 * what it was given so a development console can show it. What matters is the
 * shape: `invite()` hands the token here and not back to whoever raised it, so
 * an operator cannot redeem an invite they raised. Replacing this with real
 * email changes one line and nothing else.
 */
const invites = new RecordingInviteDelivery();
const payroll = new PayrollService(store, accounts, proofs, undefined, NETWORK, invites);
const plugins = new PluginService(store, accounts);

/*
 * SESSIONS AND THE LIMITER COME FROM POSTGRES, AND THE SERVER REFUSES TO START
 * WITHOUT IT UNLESS SOMEBODY SAYS OTHERWISE OUT LOUD.
 *
 * The in-memory versions are correct for the standalone single-tab build and
 * wrong for a server, in the same way and for the same reason: they are
 * per-process. Two instances double the login allowance, and a restart both
 * clears the count and — before S-3 — silently signed everybody out. Falling
 * back quietly would reproduce exactly the failure S-2 and S-4 describe, with
 * the code to fix it sitting right here looking like it was doing something.
 *
 * So: `DATABASE_URL` or an explicit `ALLOW_MEMORY_SESSIONS=1`. An accident
 * cannot produce either.
 */
const DATABASE_URL = process.env.DATABASE_URL;
let sessions: SessionStore;
let limiter: RateLimiter;

/*
 * **BOTH ANSWERS AT ONCE IS NOT AN ANSWER.** `X2`, and it is the guard that
 * makes reading `.env` above safe rather than dangerous.
 *
 * Until this round the server never opened `.env`, so a process that said
 * `ALLOW_MEMORY_SESSIONS=1` was CERTAIN of getting memory — nothing else could
 * supply a connection string. Now the file is read, and a working machine's
 * `.env` holds the live one. The branch below prefers a connection string when
 * it has one, so that same process would quietly open the real database and
 * write sessions into it: nothing printed, nothing failed, and the suite
 * TRUNCATES.
 *
 * Choosing a winner would be the wrong repair, because either choice is silent.
 * The two settings contradict each other and the only honest reading of them is
 * that somebody does not know which database this process is about to use — so
 * it says that and stops, which is one sentence to fix and cannot be missed.
 */
if (DATABASE_URL && process.env.ALLOW_MEMORY_SESSIONS === '1') {
  console.error(
    '\n  ALLOW_MEMORY_SESSIONS=1 and a DATABASE_URL were both given.\n\n' +
    '  Those ask for different databases and this process will not guess which.\n' +
    '  DATABASE_URL may be coming from .env, which is read from the directory\n' +
    '  this was started in.\n\n' +
    '  Remove one of them.\n',
  );
  process.exit(1);
}

if (DATABASE_URL) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(DATABASE_URL, { onnotice: () => {} });
  sessions = new PostgresSessionStore(sql);
  limiter = new PostgresRateLimiter(sql);
} else if (process.env.ALLOW_MEMORY_SESSIONS === '1') {
  console.warn(
    '\n  !! ALLOW_MEMORY_SESSIONS=1 — sessions and the attempt limiter are in memory.\n' +
    '     Sessions die on restart and the limiter resets with them. Development only.\n',
  );
  sessions = new MemorySessionStore();
  limiter = new MemoryRateLimiter();
} else {
  console.error(
    '\n  DATABASE_URL is not set.\n\n' +
    '  Sessions and attempt rate limiting need a database — in memory they are\n' +
    '  per-process, so a restart signs everybody out and resets the limiter,\n' +
    '  which is the hole S-2 and S-4 exist to close.\n\n' +
    '  Put DATABASE_URL in .env, or set ALLOW_MEMORY_SESSIONS=1 to accept that\n' +
    '  for local development.\n',
  );
  process.exit(1);
}

const challenges = new MemoryChallengeStore();
/*
 * `challenges` IS STILL PASSED TO THE WALLET SIGN-IN BELOW AND NOT TO THIS.
 * Recovery is gone, and `WalletIdentityService` uses the same store
 * for its sign-in nonce — so the const stays and this constructor loses it.
 *
 * **AND `limiter` HAS JUST LEFT IT THE SAME WAY.** It was a required
 * argument so a deployment could not omit it by not thinking about it, and what
 * it guarded was `login`. `limiter` is still built above and still passed to
 * the wallet sign-in below, which is now the only door that counts attempts.
 */
const identity = new IdentityService(store, sessions);

/*
 * SIGNING IN WITH THE WALLET. `docs/scope-payroll-identity.md` §10 step 1.
 *
 * ── WHY THIS IS BUILT AT START-UP AND NOT PER REQUEST ─────────────────────
 *
 * `APP_ORIGIN` is the value a wallet signature has to name, and it is the one
 * binding a replay turns on. It is configuration precisely so that it cannot be
 * read off a request header: a sign-in minted for another site, replayed here
 * with a matching `Origin`, would otherwise verify against itself.
 *
 * ── WHY A MISSING ONE DOES NOT STOP THE SERVER, WHICH `DATABASE_URL` DOES ──
 *
 * **THE ARGUMENT THAT PUT THIS HERE HAS BEEN DELETED, AND THE BEHAVIOUR HAS
 * NOT.** It read: *password sign-in still exists, so refusing to start
 * would take down the door that works because the new one is not configured.*
 * **There is no other door now.** A deployment that boots without `APP_ORIGIN`
 * boots with NO WAY IN AT ALL: the two wallet routes answer `503` with the
 * reason and nothing else signs anybody in.
 *
 * **THAT IS AN OUTAGE AND NOT A LOSS, WHICH IS WHY IT WAS NOT CHANGED HERE.**
 * Nothing becomes unreachable: the key that opens a company is made by the
 * person's own wallet from their seed and the company's address, so setting the
 * name and restarting restores every account exactly as it was. **Whether a
 * server with no way in should refuse to boot the way a missing `DATABASE_URL`
 * does is a decision, not a tidy-up**, and it is reported in
 * full here rather than taken quietly inside a deletion round.
 *
 * The failure is still LOUD and still at the route: the two wallet routes
 * answer with the reason, in full, rather than with a generic error, and the
 * reason is printed here at boot as well. **Silence is the thing that is not
 * allowed**, not running without it.
 */
let walletIdentity: WalletIdentityService | null = null;
let walletIdentityRefusal = '';
try {
  walletIdentity = new WalletIdentityService(
    store, sessions, limiter, challenges,
    { origin: walletSignInOrigin(process.env.APP_ORIGIN), network: NETWORK });
} catch (e) {
  walletIdentityRefusal = (e as Error).message;
  console.warn(`\n  !! SIGNING IN WITH A WALLET IS OFF.\n     ${walletIdentityRefusal}\n`);
}

const app = express();
/*
 * EVERY AMOUNT LEAVES AS `{"$n":"…"}`, and without this line the server is
 * broken for every screen that shows money.
 *
 * `res.json` calls `JSON.stringify`, which THROWS on a bigint — *Do not know
 * how to serialize a BigInt* — so `/state`, `/people`, `/plugins` and
 * `/api/public` all answered 400 the moment amounts became integers. It
 * typechecked perfectly: no signature says what `res.json` can carry.
 *
 * The replacer is imported rather than written here, so the tag has one
 * definition shared with `canonical` and `reviveBigints` — the client already
 * revives this shape, and two places deciding what it looks like is M-104.
 */
app.set('json replacer', bigintJsonReplacer);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

/*
 * Behind a proxy, `req.ip` is the proxy unless Express is told who to trust —
 * and a per-IP limit that sees one address for every request is a limit that
 * locks out the world on the first attacker. `TRUST_PROXY` is deliberately not
 * defaulted to true: trusting `X-Forwarded-For` when nothing sets it lets a
 * client pick its own address and opt out of the limit entirely.
 */
/*
 * **SAID OUT LOUD AT BOOT, BESIDE THE OTHER ONE.**
 *
 * A company opened by `SimulatedLedger` is handed an address this process
 * invented — thirty-two random bytes in the exact spelling a contract address
 * has. Keys derived from it are keys derived from a number nobody else has ever
 * seen, and every one of them changes on the day a contract is really deployed.
 *
 * This is set by `npm run dev` and by nothing else, so a deployment that has not
 * deliberately asked for it refuses instead, and says why. Printing it matters
 * for the reason `ALLOW_MEMORY_SESSIONS` prints: a posture nobody can see is a
 * posture nobody notices they are still in.
 */
if (process.env.ALLOW_SIMULATED_COMPANY_ADDRESS === '1') {
  console.warn(
    '\n  !! ALLOW_SIMULATED_COMPANY_ADDRESS=1 — companies whose address this server\n' +
    '     invented can be unlocked with a wallet. Every key derived from one changes\n' +
    '     the day a contract is deployed. Development only.\n',
  );
}

/*
 * **SAID OUT LOUD AT BOOT, FOR THE SAME REASON AS THE TWO ABOVE.**
 *
 * With this set, any page served from this machine can post what it observed —
 * uncaught errors, console messages, failed requests — and this service writes
 * them to a file. **That is a route with no session behind it**, which is
 * correct for the job (the white page it was written for happens before anybody
 * has signed in) and is exactly why it may not exist in a deployment that did
 * not ask for it out loud.
 *
 * Set by `npm run dev` and by nothing else. A posture nobody can see is a
 * posture nobody notices they are still in.
 */
const WEB_CONSOLE_SINK = process.env.ALLOW_WEB_CONSOLE_SINK === '1';
if (WEB_CONSOLE_SINK) {
  console.warn(
    '\n  !! ALLOW_WEB_CONSOLE_SINK=1 — any page on this machine can write to\n' +
    `     ${webConsoleLogPath()}\n` +
    '     No session is required. Development only.\n',
  );
}

if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

/**
 * **EVERY REFUSAL THIS SERVICE MAKES, AND THE ONE PLACE IT IS SAID OUT LOUD.**
 *
 *
 * This was four lines and answered every thrown error with `400` and a message
 * in a body, **keeping nothing.** The browser sink recorded the status and the
 * path and not the body, so a policy check refusing a second company and a
 * viewing key that could not open a record were the same event in every
 * artefact this project keeps — ten of one and three of the other on 24 Aug,
 * and telling them apart took reading two source files.
 *
 * **THE MESSAGE IS UNCHANGED AND NO NEW REFUSAL IS INVENTED.** The sentences
 * were always here, inside the errors being thrown; they reached the browser
 * and went nowhere else. `appendRefusal` is the somewhere else, and it carries
 * `e.name` with it because `NoCompanyAddress`, `ZodError` and a bare `Error`
 * from a policy check are three different mornings that `400` cannot tell
 * apart.
 *
 * **REDACTED AT THE BOUNDARY IT CROSSES AND NOT HERE**, which is the shape
 * `X4` chose for the sink and the reason its two layers each have a mutation.
 * `renderRefusal` redacts on the way to the disk; the page redacts on the way
 * to the wire. Redacting a third time here would mask both, so a mutation that
 * removed either would survive and prove the opposite of what it looked like it
 * proved — the trap `scripts/mutate-web-sink.mjs` was written to avoid.
 *
 * **IT CANNOT THROW.** `appendRefusal` swallows its own filesystem errors, so a
 * disk that is full answers the request and loses the line rather than turning
 * a refusal into a hang. A `500` here would be a service that fails because it
 * could not write down why it refused.
 */
const wrap = (fn: express.RequestHandler): express.RequestHandler =>
  async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (e: any) {
      const reason = e?.message ?? 'unknown error';
      appendRefusal(req.method, req.originalUrl, 400, e?.name ?? 'Error', reason);
      res.status(400).json({ error: reason });
    }
  };

/* ------------------------- auth ------------------------- */

declare global { namespace Express { interface Request { userId?: string } } }

/**
 * What the limiter and the session list need to know about the caller.
 *
 * The IP is used for counting and is never stored; the user agent is stored on
 * the session row so a person can tell their laptop from their phone. Neither
 * is written anywhere sealed — see the note at the top of the migration.
 */
const context = (req: express.Request) => ({
  ip: req.ip ?? null,
  userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200) || null,
});

/** The bearer token as sent, or ''. Needed by anything that revokes it. */
const bearer = (req: express.Request) =>
  String(req.headers.authorization ?? '').replace(/^Bearer /, '');

/** Resolves the session. Nothing below this reads a body before the token checks out. */
const authed: express.RequestHandler = async (req, res, next) => {
  try {
    req.userId = await identity.verify(bearer(req));
    next();
  } catch (e: any) {
    res.status(401).json({ error: e?.message ?? 'not signed in' });
  }
};

/**
 * Membership gate. Every account-scoped route goes through this, so authorisation
 * is not a thing each handler remembers to do. A route that forgets `authed` and
 * `member` simply has no access to req.userId and cannot resolve an account.
 */
const member: express.RequestHandler = (req, res, next) => {
  try {
    accounts.requireMember(String(req.params.id), req.userId!);
    next();
  } catch {
    // Deliberately the same 404 whether the account is missing or simply not
    // yours. Otherwise this endpoint enumerates account ids.
    res.status(404).json({ error: 'account not found' });
  }
};

/**
 * The same gate for routes keyed by a child record rather than an account:
 * proposals, runs, people, installations. Every child carries the account it
 * belongs to, so authorisation is one hop away and there is no reason for a
 * handler to do it by hand. Missing and not-yours are again the same 404.
 */
const ownedBy = (
  param: string,
  find: (id: string) => { accountId: string } | null,
): express.RequestHandler => (req, res, next) => {
  const record = find(String(req.params[param]));
  if (!record || !accounts.membership(record.accountId, req.userId!)) {
    return res.status(404).json({ error: 'not found' });
  }
  next();
};

const ownsProposal = ownedBy('id', id => store.getProposal(id));
const ownsRun = ownedBy('id', id => store.getRun(id));
const ownsPerson = ownedBy('id', id => store.getEmployee(id));
const ownsInstall = ownedBy('id', id => store.getInstallation(id));
const ownsAttestation = ownedBy('id', id => store.getAttestation(id));

/**
 * **A SIGNING SECRET IS REFUSED, OUT LOUD, RATHER THAN IGNORED.**
 *
 * The approve route used to require one. Now that the signature is made on the
 * signer's device, the field has no meaning here — and *no meaning* is the
 * dangerous state for a field, because a body that still carries it is a client
 * still posting its key. Dropping it silently would mean the key kept arriving,
 * kept being parsed, kept appearing in whatever sits between us and the caller,
 * and nothing anywhere would say so. **A field that is merely unused comes
 * back.**
 *
 * So this refuses by reason, and it refuses BEFORE the ownership lookup below
 * it. Ordering is not stylistic: everything after this point does work while
 * the secret is still in the request. The only thing worth doing with a secret
 * that should never have been sent is to stop at once and say what happened, so
 * the caller can be fixed and the person can be told which key to rotate.
 *
 * It reads the body, which everything above `authed` deliberately does not, so
 * it goes after `authed` in the chain and never before it.
 */
const refuseSigningSecret: express.RequestHandler = (req, res, next) => {
  const body = req.body;
  if (body && typeof body === 'object' && 'signingSecret' in body) {
    const reason =
      'this endpoint does not accept a signing secret. An approval is a signature '
      + 'made on the signer\'s device over the proposal digest, and the key never '
      + 'leaves it. Send `signature`. Treat any key that has already been sent this '
      + 'way as disclosed and replace it.';
    appendRefusal(req.method, req.originalUrl, 400, 'SigningSecretRefused', reason);
    res.status(400).json({ error: reason, code: 'signing-secret-refused' });
    return;
  }
  next();
};

/*
 * **`POST /api/auth/register` IS DELETED WITH THE PASSWORD.**
 *
 * It took an `authKey` the client had stretched from a password and a bundle
 * sealed under the other half of that stretch, and it was the ONLY writer of
 * `authHash` and `authSalt` — both of which are gone from `User`.
 *
 * **AN ACCOUNT IS CREATED BY A WALLET SIGN-IN NOW**, by the route below: a
 * subwallet that answers a challenge gets a row keyed on `sha256` of its
 * address, and no password exists to be phished, reused, or typed into the
 * wrong page. `src/server/password-is-gone.test.ts` asks this address over real
 * HTTP and requires a 404, because a deleted route and a disabled one are the
 * same thing to everybody except the person reading the source.
 */

/* ---------------- signing in with the wallet ---------------- */

/**
 * THE TWO HALVES OF A CHALLENGE, AND ONLY ONE OF THEM TRAVELS.
 *
 * `nonce` goes to the wallet and comes back inside the signature. `handle`
 * never leaves this deployment's page and has to be presented alongside — see
 * `WalletIdentityService.challenge` for the fixation this closes.
 */
const walletService = (res: express.Response): WalletIdentityService | null => {
  if (walletIdentity) return walletIdentity;
  res.status(503).json({ error: walletIdentityRefusal });
  return null;
};

app.post('/api/auth/wallet/challenge', wrap(async (req, res) => {
  const svc = walletService(res);
  if (!svc) return;
  try {
    res.json(await svc.challenge(context(req)));
  } catch (e) {
    if (e instanceof TooManyAttempts) {
      res.setHeader('Retry-After', String(e.retryAfterSeconds));
      res.status(429).json({ error: e.message, retryAfterSeconds: e.retryAfterSeconds });
      return;
    }
    throw e;
  }
}));

/**
 * THE SIGN-IN ITSELF.
 *
 * `response` is deliberately `z.unknown()` rather than a schema. It is checked
 * inside the service by a total parse that answers with a named code, and
 * putting a second shape here would be a second opinion about what a wallet
 * message looks like — kept in step by hand, disagreeing eventually. The wallet
 * owns that shape and this route owns none of it.
 *
 * `inviteToken` is OPTIONAL and is the only thing that lets the reused-subwallet
 * refusal happen HERE rather than one step later. **A sign-in with no company
 * in it cannot be judged against a company**, and the same guard runs again
 * wherever a membership is actually made, which is the copy that cannot be
 * skipped.
 */
app.post('/api/auth/wallet', wrap(async (req, res) => {
  const svc = walletService(res);
  if (!svc) return;
  const b = z.object({
    handle: z.string().min(1),
    nonce: z.string().min(1),
    response: z.unknown(),
    inviteToken: z.string().min(1).optional(),
  }).parse(req.body);
  try {
    const r = await svc.signIn(b, context(req));
    res.json({
      user: { id: r.user.id, email: r.user.email, name: r.user.name },
      session: r.session,
      address: r.address,
      created: r.created,
    });
  } catch (e) {
    if (e instanceof TooManyAttempts) {
      res.setHeader('Retry-After', String(e.retryAfterSeconds));
      res.status(429).json({ error: e.message, retryAfterSeconds: e.retryAfterSeconds });
      return;
    }
    if (e instanceof WalletSignInError) {
      /*
       * ONE STATUS FOR EVERY WAY OF FAILING, and the code beside it. A refusal
       * is not an error state to recover from — `docs/NEXT.md` §2 — so there is
       * no branch here that leads anywhere but back to the start.
       */
      res.status(401).json({ error: e.message, code: e.code });
      return;
    }
    throw e;
  }
}));

/*
 * **THE THREE RECOVERY ROUTES ARE DELETED.**
 *
 * `/api/auth/recover/challenge`, `/api/auth/recover` and
 * `/api/auth/recover/password` were here. **No client ever called any of
 * them**, and they could not serve a wallet account: keyed by an email a wallet
 * account does not have, and gated on an `identityPublicKey` it is created
 * without. `docs/reports/PI4a-proof-of-death.md` has the greps.
 */

/*
 * **`POST /api/auth/login` IS DELETED WITH THE PASSWORD.**
 *
 * It compared a client-stretched `authKey` against `authHash` and handed back
 * the session, the sealed bundle and its version. **It was also the only caller
 * of the limiter's `email` bucket and of `clear`**, which is why both went with
 * it — see `src/core/rate-limit.ts`. The limiter itself is untouched and still
 * counts every wallet challenge, every wallet sign-in and every invite offer.
 *
 * **THE BUNDLE AND ITS VERSION STILL TRAVEL**, by `GET /api/me/keys` below,
 * which is what a wallet session reads them from; a client that could not learn
 * the version could never write one again.
 */

/* ---------------- sessions the owner can see and end ---------------- */

app.get('/api/me/sessions', authed, wrap(async (req, res) => {
  res.json({ sessions: await identity.listSessions(req.userId!, bearer(req)) });
}));

/** Sign out. The token is dead when this returns, which is the whole of S-3. */
app.post('/api/auth/logout', authed, wrap(async (req, res) => {
  await identity.signOut(bearer(req));
  res.json({ ok: true });
}));

/** Sign out everywhere else, keeping the tab that asked. */
app.post('/api/me/sessions/others/revoke', authed, wrap(async (req, res) => {
  const ended = await identity.signOutEverywhere(req.userId!, bearer(req));
  res.json({ ended });
}));

/**
 * End one listed session — "sign out that phone".
 *
 * The id comes from the URL and is a twelve-character handle, not a
 * credential; `endSession` is scoped to `req.userId` so that stays true.
 */
app.post('/api/me/sessions/:id/revoke', authed, wrap(async (req, res) => {
  const ended = await identity.endSession(req.userId!, String(req.params.id));
  if (!ended) return res.status(404).json({ error: 'no such session' });
  res.json({ ok: true });
}));

/*
 * Since M-96 an account leaves here SEALED, and there is no version of this
 * endpoint that could add the company name back.
 *
 * The name, the signer list, every role and every spending limit are inside the
 * envelope, and this process does not hold the key. What goes out is what we
 * hold: two numbers the contract already publishes, opaque member ids, the
 * wrapped keys a signer needs in order to derive the viewing key, and
 * ciphertext. The client opens it — see `vault.openAccount`.
 *
 * A route here that could name the company would be a route that proves we can
 * read the roster.
 */
app.get('/api/me', authed, wrap(async (req, res) => {
  const u = identity.user(req.userId!);
  res.json({
    user: { id: u.id, email: u.email, name: u.name },
    accounts: store.accountsForUser(u.id),
  });
}));

/**
 * The client's vault. Opaque to us by construction: it arrives sealed under a
 * key derived from a password we never receive.
 */
app.get('/api/me/keys', authed, wrap(async (req, res) => {
  const u = identity.user(req.userId!);
  /*
   * **ONE HALF NOW, BECAUSE THERE IS ONLY ONE.** The bundle used to be
   * sealed under a bundle key which was itself sealed to the password, so a
   * client needed both. It is sealed under the key the wallet releases, and
   * there is no second half to hand over.
   */
  res.json({
    keyBundle: u.keyBundle,
    /* `C40`: a client cannot write safely without knowing what it read. */
    version: u.keyBundleVersion ?? 0,
  });
}));

/*
 * **THE DEVICE-ENVELOPE ROUTES ARE DELETED.**
 *
 * Six routes and `/api/me/keys/upgrade` were here. **Nothing ever called
 * them** — there is no devices screen in either build — and nothing could
 * create an envelope any more: the only thing that ever set `bundleKey` needed
 * the password-derived key to open the old bundle, and the wallet path refuses
 * an envelope outright rather than making one.
 *
 * **SESSIONS ARE NOT DEVICES AND ARE UNTOUCHED.** `/api/me/sessions` and its
 * two revoke routes are above and still do the job: **removing a device now
 * means revoking its session**, and that is enough, because no device holds a
 * copy of anything that opens the data — the key is recomputed from the
 * person's own wallet each time and is never stored.
 */

/*
 * **THE ENVELOPE REFUSAL IS GONE WITH THE ENVELOPE.**
 *
 * This route used to refuse when `bundleKey` was set, because replacing the
 * bundle alone on an upgraded account killed every device's wrapped copy — one
 * "create a company" click did exactly that once. **There is no bundle key and
 * no device copy**, so the bundle is the only thing there is to replace.
 */
app.put('/api/me/keys', authed, wrap(async (req, res) => {
  const b = z.object({
    keyBundle: z.object({ iv: z.string(), tag: z.string(), body: z.string() }),
    /* Optional on the wire so an old client still works, and every client we ship sends it. */
    ifVersion: z.number().int().min(0).optional(),
  }).parse(req.body);
  try {
    const u = identity.updateKeyBundle(req.userId!, b.keyBundle, b.ifVersion);
    res.json({ ok: true, version: u.keyBundleVersion });
  } catch (e) {
    if (e instanceof StaleKeyBundle) {
      res.status(409).json({ error: e.message, currentVersion: e.currentVersion });
      return;
    }
    throw e;
  }
}));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ledger: ledger.describe(), proofs: proofs.describe() });
});

/*
 * WHERE THE BROWSER'S OWN RECORD OF ITSELF LANDS.
 *
 * **REGISTERED ONLY WHEN THE RELAXATION IS DECLARED**, so a production build of
 * this service does not have the route at all and a post to it is an ordinary
 * 404 — not a 403, which would confirm the route exists.
 *
 * It answers 204 whatever happened. The page must not learn anything from this
 * and must not be able to fail because of it: a sink that can make the app
 * behave differently is the thing `X4` was told not to build.
 */
if (WEB_CONSOLE_SINK) {
  const webConsolePost = z.object({
    page: z.string().max(2048).default(''),
    entries: z.array(z.object({
      level: z.string().max(32),
      message: z.string().max(20_000),
      stack: z.string().max(20_000).optional(),
    })).max(500).default([]),
  });

  app.post('/api/dev/web-console', (req, res) => {
    const body = webConsolePost.safeParse(req.body);
    if (body.success && body.data.entries.length > 0) {
      appendWebConsole(body.data.page, body.data.entries);
    }
    res.status(204).end();
  });
}

/* ------------------------- accounts ------------------------- */

app.post('/api/accounts', authed, wrap(async (req, res) => {
  const body = z.object({
    name: z.string().min(1),
    signers: z.array(z.object({
      name: z.string().min(1),
      role: z.enum(['admin', 'approver', 'initiator', 'viewer']),
    })).min(1),
    threshold: z.number().int().min(1),
  }).parse(req.body);
  /*
   * **NOTHING IS REFUSED HERE FOR BEING A SECOND COMPANY.** `C155`, `C131`,
   * `docs/scope-v1-data-model.md` D4: *"A person may create and belong to many
   * companies. Already true."* — settled 15 Aug, and for a wallet sign-in it
   * had never been true. This line read
   * `refuseReusedSubwallet(store, req.userId!, null)`, which threw for any
   * wallet user already on any account at all, so a founder's second company
   * was impossible and the 400 said nothing they could act on.
   *
   * `C131` closed on 22 Aug by REMOVAL — reuse is a person's choice, a
   * contractor paid by five companies may want one address, and the warning
   * belongs in the wallet, which knows which of its own slots it has used and
   * with which sites. **The server-side refusal survived that removal**, and
   * this is the rest of it.
   *
   * The creator takes the first seat below. Without that the account would
   * exist with no members and even its author could not open it.
   */
  const signers = body.signers.map((s, i) => ({ ...s, userId: i === 0 ? req.userId! : null }));
  res.json(await accounts.create(body.name, signers, body.threshold));
}));

// Scoped to the caller. This is the list endpoint, not a directory of the estate.
app.get('/api/accounts', authed, wrap(async (req, res) => {
  res.json(store.accountsForUser(req.userId!));
}));

app.get('/api/accounts/:id', authed, member, wrap(async (req, res) => {
  res.json(accounts.require(String(req.params.id)));
}));

app.get('/api/accounts/:id/state', authed, member, wrap(async (req, res) => {
  const viewingKey = String(req.query.viewingKey ?? '');
  res.json(await accounts.readState(String(req.params.id), viewingKey));
}));

/*
 * `POST /api/accounts/:id/deposit` STOOD HERE AND IS GONE.
 *
 * It put money into the account's own book. The account keeps no book — it is
 * an authority over a vault — so there is nothing behind the route and it is
 * removed rather than left answering with a refusal: a route that exists is a
 * route somebody integrates against.
 *
 * Money reaches a VAULT, through the vault's own deposit path, which this round
 * does not touch and which no HTTP route here has ever exposed.
 */

app.get('/api/accounts/:id/proposals', authed, member, wrap(async (req, res) => {
  res.json(store.listProposals(String(req.params.id)));
}));

/*
 * **WHAT ARRIVES IS A SIGNATURE. NOTHING HERE COULD PRODUCE ONE.**
 *
 * `.strict()` is the second half of `refuseSigningSecret` and covers what the
 * named check cannot: any other spelling of a secret somebody adds to a client
 * later is an unrecognised key and is refused rather than carried. A schema that
 * ignores what it does not recognise is how a field nobody meant to accept ends
 * up being accepted for a year.
 */
app.post('/api/proposals/:id/approve', authed, refuseSigningSecret, ownsProposal, wrap(async (req, res) => {
  const b = z.object({
    signerId: z.string(), signature: z.string().min(1), viewingKey: z.string(),
  }).strict().parse(req.body);
  res.json(await accounts.approve(String(req.params.id), b.signerId, b.signature, b.viewingKey));
}));

/*
 * Withdrawing a round.
 *
 * New with M-29 and not optional. The contract permits exactly one open
 * proposal per account, so without this endpoint a single proposal that will
 * never reach its threshold wedges the account permanently — nothing else can
 * be proposed until it is closed.
 */
app.post('/api/proposals/:id/cancel', authed, ownsProposal, wrap(async (req, res) => {
  const b = z.object({ viewingKey: z.string(), by: z.string().optional() }).parse(req.body ?? {});
  res.json(await accounts.cancel(String(req.params.id), b.viewingKey, b.by));
}));

/*
 * What the chain says about this account's round.
 *
 * Separate from our own proposal records on purpose. On Midnight the open
 * proposal and the approval count are on-chain state, so "can I propose right
 * now" is not a question this server can answer from its own database — and
 * answering it from the database is how a UI comes to offer a button the chain
 * rejects.
 */
app.get('/api/accounts/:id/ledger', authed, member, wrap(async (req, res) => {
  res.json(await accounts.ledgerStatus(String(req.params.id)));
}));

/*
 * ── ONE VAULT'S OWN APPROVAL THRESHOLD ──────────────────────────────────
 *
 *
 * **THERE IS NO READ ROUTE HERE, DELIBERATELY.** What every signer needs to see
 * is `LedgerStatus.vaultThresholds`, and that already crosses on
 * `GET /api/accounts/:id/ledger` above, from the same single read of the
 * boundary as the account's own threshold and its seat count. A second route
 * answering the same question would be a second read, at a second moment, and
 * a screen showing a vault's bar from one moment beside the account's from
 * another is arithmetic over two chain states — the race `R4` spent a round
 * removing from one layer down.
 *
 * **AND THERE IS NOTHING TO LIST.** Absence means inherit, so the chain
 * publishes only the deliberate exceptions and there is no roster of vaults to
 * enumerate. A route that returned "every vault and its threshold" would have
 * to invent the left-hand column.
 *
 * The two routes below are the two halves of a governance round, matching
 * `setThreshold`'s pair: raise it, gather approvals through the ordinary
 * `/api/proposals/:id/approve`, then apply it.
 */
app.post('/api/accounts/:id/vault-threshold/propose', authed, member, wrap(async (req, res) => {
  const b = z.object({
    viewingKey: z.string(),
    /*
     * A vault is a contract address — `Bytes<32>` in the contract's
     * `thresholds` map — so the shape is fixed and checkable here. Refusing a
     * malformed one at the door is cheap; letting it through produces a row on
     * chain keyed by a value no vault can ever equal, which is a governed round
     * spent on nothing.
     */
    vault: z.string().regex(/^[0-9a-f]{64}$/, 'a vault address is 64 lower-case hex characters'),
    /*
     * `.int().min(1)` here as well as in `core/`, and the duplication is the
     * ordinary one: this is a wire schema refusing a body, and that is a rule
     * refusing a state. The message a person reads comes from `core/`.
     */
    newThreshold: z.number().int().min(1),
    proposedBy: z.string(),
  }).parse(req.body);
  res.json(await accounts.proposeVaultThresholdChange(
    String(req.params.id), b.viewingKey, b.vault as Hex, b.newThreshold, b.proposedBy));
}));

app.post('/api/accounts/:id/vault-threshold', authed, member, wrap(async (req, res) => {
  const b = z.object({
    viewingKey: z.string(),
    vault: z.string().regex(/^[0-9a-f]{64}$/),
    newThreshold: z.number().int().min(1),
    by: z.string().optional(),
  }).parse(req.body);
  await accounts.setVaultThreshold(
    String(req.params.id), b.viewingKey, b.vault as Hex, b.newThreshold, b.by);
  /* The chain is the record. Answering with the boundary's own view rather than
   * with anything this server holds, because this server holds none of it. */
  res.json(await accounts.ledgerStatus(String(req.params.id)));
}));

/**
 * **WHICH COMPANY THIS SESSION MAY ASK A WALLET TO OPEN.**
 *
 * The page needs the company's own address to put in an unlock, because that is
 * what the wallet derives the key from. **It is not allowed to choose it**, and
 * this route is the whole of that rule on the wire: the account comes from the
 * path and goes through `member` like every other account-scoped route, and the
 * address is looked up from what the ledger assigned.
 *
 * **NOTHING IS READ OUT OF THE BODY, AND THE BODY IS WHERE A CLAIM WOULD GO.**
 * There is no `z.object(...).parse(req.body)` here and no reference to
 * `req.body` anywhere below — not as a fallback, not as an override, not as a
 * hint. `scripts/mutate-wallet-unlock.mjs` mutation 1 puts exactly that door in
 * and names the test that dies.
 *
 * It is a POST because it is not a read of a public field: it is this
 * deployment saying *this is the company you may go and open, as you, now*.
 * A GET would also be honest; a POST is the shape in which the dangerous thing
 * — a body — actually exists, so refusing to read one is demonstrable rather
 * than theoretical.
 *
 * **NO KEY PASSES THROUGH HERE.** What comes back is a public chain address.
 * The key is released by the wallet to the browser and this server never sees
 * it — `wallet-unlock.test.ts` holds that to a transport that records every
 * byte this side is ever handed.
 */
app.post('/api/accounts/:id/unlock', authed, member, wrap(async (req, res) => {
  try {
    const company = companyForSession(store, req.userId!, String(req.params.id));
    res.json({ company });
  } catch (e) {
    if (e instanceof NoCompanyAddress) {
      /* Not-yours is the same 404 `member` gives, for the same reason. */
      res.status(e.code === 'company-not-yours' ? 404 : 409)
        .json({ error: e.message, code: e.code });
      return;
    }
    throw e;
  }
}));

/* ------------------------- payroll ------------------------- */

app.post('/api/accounts/:id/payroll', authed, member, wrap(async (req, res) => {
  const b = z.object({
    period: z.string().min(1),
    employees: z.array(z.object({
      name: z.string().min(1), asset: assetCode, amount: z.string().min(1),
    })).min(1),
    viewingKey: z.string(),
  }).parse(req.body);
  res.json(await payroll.createRun(
    String(req.params.id),
    b.period,
    b.employees.map(e => ({ name: e.name, asset: e.asset, amount: money(e.asset, e.amount) })),
    b.viewingKey,
  ));
}));

app.get('/api/accounts/:id/runs', authed, member, wrap(async (req, res) => {
  res.json(store.listRuns(String(req.params.id)));
}));

app.post('/api/runs/:id/propose', authed, ownsRun, wrap(async (req, res) => {
  const b = z.object({
    viewingKey: z.string(), proposedBy: z.string(),
    // Optional, and only needed by a run that settles in more than one asset —
    // each is its own approval round.
    asset: assetCode.optional(),
  }).parse(req.body);
  /*
   * **`null` RUN MATERIAL. THIS ROUTE REFUSES, AND THAT IS `C375`'s FIX
   * REACHING THE SURFACE.**
   *
   * It used to answer 200 with a proposal id for a round no vault could ever
   * be presented with. Nothing in this product builds a payout root, a payment
   * window or a vault, so there is nothing honest to pass here; the refusal
   * names what is missing. `PayrollService.proposeRun` carries the sentence.
   */
  res.json(await payroll.proposeRun(
    String(req.params.id), b.viewingKey, b.proposedBy, null, b.asset));
}));

/*
 * **WHO HAS BEEN PAID ON THIS RUN — OR WHY NOBODY CAN SAY.**
 *
 * A run is paid one payee at a time, so at any moment some are paid and some
 * are not. **A run reported as finished while two people are unpaid is worse
 * than one that fails outright, because nobody goes looking.** This is the
 * route that answers which two.
 *
 * **IT ASKS THE LEDGER, AND ONLY ABOUT THIS RUN'S OWN PAYEES.** The account's
 * record of completed payments is public and append-only; the question asked
 * here is bounded by the run rather than by the set, so what it costs is the
 * size of one payroll and not the age of the company.
 *
 * **AND IT CAN ANSWER THAT IT DOES NOT KNOW, WHICH IS A DIFFERENT ANSWER FROM
 * "NOBODY".** Two things can be missing: the run's payout leaves, which this
 * product does not write yet, and a ledger that records payments at all. Either
 * one produces a refusal to report rather than a report of nobody paid — the
 * body carries `answered: false` and a sentence, and there is no count in it to
 * misread.
 *
 * **A POST FOR A READ, AND THE KEY IN THE BODY IS WHY.** The viewing key is
 * what decrypts this company's own records, and a web address is the one part
 * of a request that gets written down all the way along: browser history,
 * proxies, load balancers, access logs. Three older reads here take it in the
 * query and each is a place it has already been written; this one does not add
 * a fourth. The verb is the cost of that and it is worth paying.
 */
app.post('/api/runs/:id/payments', authed, ownsRun, wrap(async (req, res) => {
  const b = z.object({ viewingKey: z.string() }).parse(req.body ?? {});
  const run = payroll.requireRun(String(req.params.id), b.viewingKey);
  const material = payroll.payoutMaterialOf(run.id, b.viewingKey);
  const among = material ? await ledger.paidAmong(run.accountId, material.leaves) : null;
  res.json(runPayments(material, among));
}));

/*
 * `POST /api/runs/:id/settle` STOOD HERE AND IS GONE.
 *
 * It settled a run by spending the account's own balance. There is no balance
 * and no `PayrollService.settle`. Removed rather than left answering a refusal:
 * a route that exists is a route somebody integrates against.
 */

app.get('/api/runs/:runId/employee/:employeeId', wrap(async (req, res) => {
  const secret = String(req.query.secret ?? '');
  res.json(payroll.employeeView(String(req.params.runId), String(req.params.employeeId), secret));
}));

/*
 * The roster needs the viewing key now, because the server cannot read it.
 *
 * That is the property, not an inconvenience: a route that could list employees
 * without a key would be a route that proves we can read them.
 */
app.get('/api/accounts/:id/people', authed, member, wrap(async (req, res) => {
  /*
   * **`handedOver` SAYS WHETHER A ROW IS WAITING ON US OR ON THEM.** `X11` §4,
   *
   *
   * A run already refuses in two different sentences for the two cases — *has
   * not set up yet* and *is waiting to be admitted by an admin* — and the
   * roster screen could not tell them apart, so the control that admits
   * somebody had nowhere to appear. It is a BOOLEAN and not the contents: the
   * drop box stays sealed and nothing here opens it.
   *
   * It is added HERE rather than on `RosterEmployee`, and that is not
   * cosmetic: `EmployeeSecrets` is `RosterEmployee` minus four fields, so
   * anything added to that type is added to **what gets sealed**, and a
   * derived fact would then be frozen into the envelope and able to disagree
   * with the store.
   */
  res.json(payroll.listPeople(String(req.params.id), String(req.query.viewingKey ?? ''))
    .map(p => ({ ...p, handedOver: payroll.hasHandover(p.id) })));
}));

app.post('/api/accounts/:id/people', authed, member, wrap(async (req, res) => {
  const b = z.object({
    name: z.string().min(1), email: z.string().min(1), title: z.string().min(1),
    // One asset. There are no exchange rates in this product.
    asset: assetCode,
    salary: z.string().min(1), startDate: z.string().optional(),
    viewingKey: z.string(),
  }).parse(req.body);
  res.json(payroll.invite(String(req.params.id), {
    name: b.name, email: b.email, title: b.title,
    asset: b.asset,
    baseAmount: money(b.asset, b.salary),
    startDate: b.startDate,
    /* Who raised it. `admit` records rather than refuses when they also redeem it. */
  }, b.viewingKey, req.userId!));
}));

/**
 * **AN ADMIN TAKES AN INVITATION BACK.** `X12` §3,
 * `docs/scope-invitations.md` §8.
 *
 * **ADDRESSED BY THE PERSON, NOT BY THE TOKEN**, and that is not a convenience.
 * The admin does not hold the token — `invite()` hands it back once, to the
 * browser that raised it, and no route gives it out again (`X11` §1,
 * `invitations.test.ts`'s first test). A revoke route keyed on the token would
 * be a route that requires the one value this product spent a round making
 * unreachable, and the obvious repair — letting a member look one up — is the
 * deleted *open it as them* button with a new name.
 *
 * `ownsPerson`, not `member`: the same gate `admit` and `status` stand behind.
 */
app.post('/api/employees/:id/invite/revoke', authed, ownsPerson, wrap(async (req, res) => {
  res.json(payroll.revokeInvite(String(req.params.id)));
}));

/**
 * **THE SEALED DROP BOX, FOR THE ADMIN'S OWN MACHINE TO OPEN.** `X12` §2,
 * `docs/scope-invitations.md` §5, `docs/how-money-can-be-lost.md` `C21`.
 *
 * §5 puts the confirmation code on the ADMIN'S machine — *"if we computed it we
 * would need the address, and the leak returns through the door this section
 * builds"* — so the browser needs the ciphertext and this hands it over.
 *
 * **THIS ROUTE CANNOT READ WHAT IT SERVES.** The blob is sealed to the account's
 * inbox public key; the secret is derived from the account's viewing key, which
 * does not reach this handler on any path — there is no query parameter for one
 * and no body to put one in. **The rule is expressed as a missing parameter**,
 * the same way the accept door has nowhere to put a plain address.
 *
 * **AND IT IS NOT A WIDENING.** Everybody `ownsPerson` admits already holds the
 * viewing key that opens this — they need it to see the roster at all — and
 * nobody else can read it, including this deployment.
 */
app.get('/api/employees/:id/handover', authed, ownsPerson, wrap(async (req, res) => {
  res.json({ inbox: payroll.handoverBlob(String(req.params.id)) });
}));

app.post('/api/people/:id/status', authed, ownsPerson, wrap(async (req, res) => {
  const b = z.object({ status: z.enum(['active', 'leaver']), viewingKey: z.string() }).parse(req.body);
  res.json(payroll.setStatus(String(req.params.id), b.status, b.viewingKey));
}));

app.post('/api/accounts/:id/runs', authed, member, wrap(async (req, res) => {
  const b = z.object({
    period: z.string().min(1), employeeIds: z.array(z.string()).optional(), viewingKey: z.string(),
  }).parse(req.body);
  res.json(await payroll.createRunFromRoster(String(req.params.id), b.period, b.viewingKey, b.employeeIds));
}));


app.post('/api/accounts/:id/invites/signer', authed, member, wrap(async (req, res) => {
  const b = z.object({
    name: z.string().min(1), email: z.string().min(1),
    role: z.enum(['admin', 'approver', 'initiator', 'viewer']),
  }).parse(req.body);
  res.json(accounts.inviteSigner(String(req.params.id), b.name, b.email, b.role));
}));

app.get('/api/accounts/:id/invites', authed, member, wrap(async (req, res) => {
  /*
   * THE TOKENS DO NOT COME BACK. A-10.
   *
   * This returned raw `Invite` objects, tokens in the clear, to anybody
   * `member` lets through — and `member` checks membership, not role, so a
   * `viewer` seat could read every unaccepted employee's token and redeem it
   * with an address they control. **A list of who has been invited is a
   * reasonable thing for a member to see; the bearer credential is not.**
   *
   * **Both halves of the reason originally given here were later made false, and
   * are corrected rather than left standing.** An EMPLOYEE invite's token does
   * not come back to its creator at all — `invite()` returns where it went and
   * nothing else — and `admit` no longer refuses a handover redeemed by the
   * person who raised it; it records it. What holds the flow now is that the
   * redeemer must be signed in as the address on the record, plus one payable
   * entry per person. A SIGNER invite's token does still come back once, in the
   * response to raising it, because `grantAccess` is its second gate.
   */
  res.json(store.listInvites(String(req.params.id)).map(({ token, ...rest }) => ({
    ...rest, redeemed: Boolean(rest.acceptedAt),
  })));
}));

// Signed in, but deliberately not `member`: accepting the invite is what makes
// you a member. The invite token is the authorisation, the session is the identity.
app.post('/api/invites/:token/accept-signer', authed, wrap(async (req, res) => {
  const b = z.object({
    signingPublicKey: z.string(), wrappingPublicKey: z.string(),
    /*
     * The commitment, and NOT the blinding factor behind it.
     *
     * This endpoint briefly took both, because a removal re-seated every
     * remaining signer and could not compute their new leaves without their
     * blindings. Slots re-seat nobody, so the blinding never has to leave the
     * invitee's device — which is what decision 0003 says, and it is better
     * that this server cannot receive it than that it promises not to keep it.
     */
    leafCommitment: z.string().min(32),
  }).parse(req.body);
  res.json(accounts.acceptSignerInvite(
    String(req.params.token), req.userId!, b.signingPublicKey, b.wrappingPublicKey,
    b.leafCommitment));
}));

/*
 * SIGNED IN, LIKE `accept-signer` ABOVE IT. A-10.
 *
 * This was the one account-scoped write in this file with no `authed` on it, so
 * a handover carried no trace of who made it — and `admit` had nothing to
 * compare against the person who minted the invite. The decision that an
 * employee logs in (`A-4`) is what makes this affordable: they have an identity
 * before they have a salary.
 */
/*
 * WHAT AN INVITEE IS BEING OFFERED, BEFORE THEY HAND ANYTHING OVER. A-7.
 *
 * Not `member` — by definition this is somebody who is not on the account yet.
 * Not even `authed`: they may be reading it before they sign up, which is when
 * a person actually decides. **The token is the authorisation and the key at
 * once**: the offer is sealed under a key derived from it, so holding it is what
 * opens it, and the server cannot — it stores only the hash.
 */
app.get('/api/invites/:token/offer', wrap(async (req, res) => {
  /*
   * **METERED, AND KEYED ON WHO IS ASKING.** `X11` §6,
   * `docs/scope-invitations.md` §8.
   *
   * This is the only unauthenticated door in the product that answers with
   * something worth having, and `X11` is what puts a real screen in front of
   * it. **The limiter is the one sign-in already uses** — the same class, the
   * same store, the same buckets — because a second implementation of a
   * counter is a second thing that can be wrong about atomicity, which is the
   * whole of `S-2`'s argument.
   *
   * **THE KEY IS THE CALLER AND NOT THE TOKEN**, and that is the load-bearing
   * line: a limit per token would give a guesser a fresh allowance for every
   * guess, so the endpoint would be metered and completely unprotected at the
   * same time.
   *
   * **RECORDED BEFORE THE LOOKUP**, for the reason `IdentityService.verify`
   * gives about counting before deciding: a limiter that only counts misses
   * lets the one guess that lands through, and the server cannot know a guess
   * was wrong until it has already done the work.
   *
   * A caller with no address is not counted and is not refused. `req.ip` is
   * absent only where there is no socket — a test driving the app directly —
   * and refusing there would fail closed on the one path that is not a caller
   * at all.
   */
  const from = context(req).ip;
  if (from) {
    const decision = await limiter.record('invite-offer', from);
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      res.status(429).json({
        error:
          'too many invitation lookups from here. This door answers anybody who has a link, '
          + `so it is metered — try again in ${decision.retryAfterSeconds} seconds.`,
        retryAfterSeconds: decision.retryAfterSeconds,
      });
      return;
    }
  }
  res.json(payroll.offerFor(String(req.params.token)));
}));

app.post('/api/invites/:token/accept-employee', authed, wrap(async (req, res) => {
  /*
   * **THE SERVER IS A COURIER, AND SINCE `X11` IT IS ONLY A COURIER.** `X11`
   * §7, `docs/how-money-can-be-lost.md` `C160`,
   * `docs/scope-invitations.md` §5.
   *
   * This took the receiving address as a bech32 STRING and called
   * `payeeAddress(b.address, NETWORK)` to build the value the service sealed.
   * Where the address ENDED UP was already right — sealed to the company's
   * inbox key, unreadable to us. **How it got there was not:** the plaintext
   * existed in this process, in whatever the framework buffered, and in
   * anything that ever logged a request body. Decided the opposite on
   * 22 Aug: the acceptance seals the address to the company's inbox key **on
   * the employee's own device**.
   *
   * **WE DO NOT STORE IT IS A POLICY. NOT BEING ABLE TO SEE IT IS A PROPERTY.**
   * What arrives now is a blob sealed to the account's inbox public key, and
   * the secret for that is derived from the account's viewing key, which does
   * not reach this route on any path. This handler cannot open what it is
   * forwarding, and neither can the service behind it.
   *
   * ── THE TWO OLD FIELDS ARE REFUSED BY NAME, NOT DROPPED ──────────────────
   *
   * `zod` strips unknown keys, so leaving them out would mean a client that
   * still posts an address is answered *"handover is required"* — and whoever
   * wrote it is entitled to believe the address was read. That is the same
   * sentence the wallet's own request parser is written in: **ignoring a field
   * lets the sender believe it counted.** So both are named, and the message
   * says where they went.
   *
   * ── AND `payeeAddress`'s THREE CHECKS DID NOT DISAPPEAR ──────────────────
   *
   * They moved to the invitee's device, where somebody can act on them
   * (`midnight-identity/wallet/address-shape`), and they still run HERE in the
   * sense that matters: `admit` rebuilds the value through the real
   * `payeeAddress()` from the string inside the envelope, on the machine that
   * holds the key, exactly as it always has. `A-1`.
   */
  const refuseInTheClear = (field: string, what: string) => {
    if (req.body && typeof req.body === 'object' && field in (req.body as object)) {
      res.status(400).json({
        code: 'handover-in-the-clear',
        error:
          `this posts ${what} in the clear. Since X11 the acceptance is sealed to the `
          + "company's inbox key on the employee's own device and this route takes a blob it "
          + 'cannot open, so the field is refused rather than ignored — ignoring it would '
          + 'leave whoever sent it believing we had read it. Seal it with `sealHandover` and '
          + 'send it as `handover`.',
      });
      return true;
    }
    return false;
  };
  if (refuseInTheClear('address', 'a receiving address')) return;
  if (refuseInTheClear('wrappingPublicKey', 'a payslip key')) return;

  const b = z.object({
    /* The sealed envelope's own shape, and nothing about what is inside it. */
    handover: z.object({
      ephemeral: z.string().min(1),
      iv: z.string().min(1),
      tag: z.string(),
      body: z.string().min(1),
    }),
  }).parse(req.body);
  res.json(payroll.acceptInvite(String(req.params.token), b.handover, req.userId!));
}));

/*
 * `ownsPerson`, NOT JUST `authed`. Found by audit before it shipped.
 *
 * Every other route keyed by a child record carries this gate; this one went
 * out with only a session check, so any signed-in stranger could call admit for
 * any employee id, on any company. What stood between that and setting where
 * somebody's salary goes was knowing the account's viewing key — which is a
 * secret doing an authorisation check's job, and the reason the 404 below is
 * the same whether the record is missing or simply not yours.
 */
/*
 * A MEMBER MAKES THEMSELVES PAYABLE. A-12, and it is the replacement for the
 * exception `C18` deleted.
 *
 * A founder creating a company and adding themselves, or a vendor who has just
 * incorporated, is not an employee being invited — no token, no third party,
 * nobody to impersonate. It had no route at all, which meant the case it exists
 * for had exactly one available path in the product, and that path was the
 * sockpuppet in `C21`.
 */
/*
 * **THE NONCE A PAYEE DISCLOSURE ANSWERS.**
 *
 * The same store and the same two halves as the sign-in challenge — a nonce
 * that travels to the wallet inside the signature, and a HANDLE that never
 * leaves this origin and must be presented alongside, so a nonce on its own is
 * not an address (`WalletIdentityService.challenge` argues the fixation this
 * closes).
 *
 * **IT IS ITS OWN ROUTE, BEHIND `member`, RATHER THAN THE SIGN-IN'S.** Not
 * because sharing the store is unsafe — it is the same store — but because the
 * thing this leads to is a row on ONE company's roster, and a door that writes
 * there should be reached only by somebody already on it. It also stops a
 * challenge for *where do I pay you* being served to anybody who can reach the
 * unauthenticated sign-in door.
 */
app.post('/api/accounts/:id/payee-challenge', authed, member, wrap(async (req, res) => {
  const svc = walletService(res);
  if (!svc) return;
  try {
    res.json(await svc.challenge(context(req)));
  } catch (e) {
    if (e instanceof TooManyAttempts) {
      res.setHeader('Retry-After', String(e.retryAfterSeconds));
      res.status(429).json({ error: e.message, retryAfterSeconds: e.retryAfterSeconds });
      return;
    }
    throw e;
  }
}));

app.post('/api/accounts/:id/self-payee', authed, member, wrap(async (req, res) => {
  /*
   * NO `email` FIELD, and that is `C24`. It is read off the caller's own
   * sign-in inside the service, so this route cannot be used to mint a payable
   * entry under somebody else's name.
   *
   * **AND NO `address` FIELD EITHER, WHICH IS `X8` AND `C153`.** It was a
   * string — the address the person had pasted into a box — and `X7` said in as
   * many words that pasting is safe on this one door and is a precedent that
   * must not spread. **The field is gone and there is nowhere to put one.** A
   * signed disclosure arrives instead, and `payeeFromWallet` is what turns it
   * into an address: the value is one a wallet WORKED OUT from its own keys,
   * inside a signature over a nonce this deployment issued, for this origin.
   *
   * **A BUTTON THAT FORWARDED WHATEVER THE WALLET SAID WOULD BE THE SAME DOOR
   * WITH THE BOX HIDDEN**, so nothing in the page judges it and the check is
   * here, where the record is written.
   */
  const svc = walletService(res);
  if (!svc) return;
  const b = z.object({
    name: z.string().min(1), title: z.string().min(1),
    asset: z.string().min(1), salary: z.string().min(1), startDate: z.string().optional(),
    viewingKey: z.string(),
    wrappingPublicKey: z.string(),
    disclosure: z.object({
      handle: z.string().min(1),
      nonce: z.string().min(1),
      response: z.unknown(),
    }),
  }).parse(req.body);
  let fromWallet;
  try {
    fromWallet = await payeeFromWallet(b.disclosure, {
      /* OURS, from configuration. A disclosure minted for another payroll names
       * that payroll inside the signature and is refused. */
      origin: svc.requesterOrigin,
      network: NETWORK,
      challenges,
    });
  } catch (e) {
    if (e instanceof WalletPayeeError) {
      res.status(400).json({ error: e.message, code: e.code });
      return;
    }
    throw e;
  }
  res.json(payroll.addSelfAsPayee(String(req.params.id), req.userId!, {
    /* `null`, not `''`. Whether this person has an email is read off their own
     * sign-in inside the service; there is nothing about one on this route. */
    name: b.name, email: null, title: b.title,
    asset: b.asset, baseAmount: money(b.asset, b.salary), startDate: b.startDate,
  }, b.viewingKey, {
    wrappingPublicKey: b.wrappingPublicKey,
    address: fromWallet.address,
  }));
}));

app.post('/api/employees/:id/admit', authed, ownsPerson, wrap(async (req, res) => {
  const b = z.object({ viewingKey: z.string() }).parse(req.body);
  res.json(payroll.admit(String(req.params.id), b.viewingKey, req.userId!));
}));

app.post('/api/accounts/:id/grant', authed, member, wrap(async (req, res) => {
  const b = z.object({ viewingKey: z.string(), signerId: z.string() }).parse(req.body);
  res.json(await accounts.grantAccess(String(req.params.id), b.viewingKey, b.signerId));
}));

/* ------------------------- disclosure ------------------------- */

/*
 * **ALL THREE ROUTES BELOW ARE LIVE AND NONE OF THEM CAN COMPLETE.** `T-217`
 * `F10`, `T-234`, confirmed at source by `SC10b`
 * (`docs/scope-the-product-surface.md` §0) and stated here by `S47`. Rule 14,
 * and `C178`'s species: a control that appears to be a capability and is not.
 *
 *   · `POST /api/runs/:id/attest` reaches `attestPayrollTotal`, whose gate is
 *     `run.status === 'settled'`. **`'settled'` is assigned nowhere in `src/`**
 *     — `run.status` is written twice, `'draft'` and `'proposed'` — because
 *     `C292`/`S26` deleted `settle` with the balance. So it can only ever
 *     answer 400, and `this.proofs.prove` is unreachable.
 *   · `POST /api/accounts/:id/attest-solvency` refuses unconditionally at
 *     `src/core/payroll.ts:2232`: the account holds no balance to prove a
 *     threshold against.
 *   · `GET /api/attestations/:id/verify` **never reaches its handler**.
 *     `store.putAttestation` has one caller, below the unpassable gate above,
 *     so the attestation store can never hold a row and `ownsAttestation`
 *     answers 404 on the null lookup. An integrator therefore gets *not found*
 *     where the truth is *this capability is not built*, and the guard is
 *     deliberately NOT loosened here to fix that — it is an access gate and
 *     changing one is not this round's. **`S47` reports it rather than
 *     touching it.**
 *
 * **NOT DELETED, AND THE REASON IS RULE 22b:** selective disclosure returns
 * with vault settlement, and a route removed is a route somebody has to
 * rediscover. What changed in `S47` is that the refusals now name what is
 * missing instead of naming a step nobody can take — rule 19.
 */

app.post('/api/runs/:id/attest', authed, ownsRun, wrap(async (req, res) => {
  // A run has a subtotal per asset and never one total, so an attestation has
  // to say which one it is about.
  const asset = assetCode.parse(req.query.asset);
  res.json(await payroll.attestPayrollTotal(
    String(req.params.id), String(req.query.viewingKey ?? ''), asset));
}));

app.post('/api/accounts/:id/attest-solvency', authed, member, wrap(async (req, res) => {
  const b = z.object({
    viewingKey: z.string(), asset: assetCode, threshold: z.string().min(1),
  }).parse(req.body);
  res.json(await payroll.attestSolvency(
    String(req.params.id), b.viewingKey, b.asset, money(b.asset, b.threshold)));
}));

app.get('/api/attestations/:id/verify', authed, ownsAttestation, wrap(async (req, res) => {
  res.json({ valid: await payroll.verifyAttestation(String(req.params.id)) });
}));


/* ------------------------- plug-ins ------------------------- */

app.get('/api/plugins/catalogue', wrap(async (_req, res) => res.json(plugins.catalogue())));

app.get('/api/accounts/:id/plugins', authed, member, wrap(async (req, res) => {
  res.json(plugins.installed(String(req.params.id)));
}));

app.post('/api/accounts/:id/plugins', authed, member, wrap(async (req, res) => {
  const b = z.object({
    pluginId: z.string(), scopes: z.array(z.string()),
    /*
     * A CEILING PER ASSET, as decimal strings.
     *
     * The old shape was two bare numbers and no asset, which is a limit that
     * means a sensible weekly cap in pounds and roughly nothing in ether — with
     * the plug-in, not the person setting it, deciding which. The figures cross
     * the wire as strings for the same reason every other amount does: a JSON
     * number cannot carry 10^18.
     */
    allowance: z.object({
      periodDays: z.number().positive(),
      limits: z.record(assetCode, z.object({
        perProposal: z.string().min(1),
        perPeriod: z.string().min(1),
      })),
    }).nullable().default(null),
    installedBy: z.string(),
  }).parse(req.body);

  const allowance = b.allowance && {
    periodDays: b.allowance.periodDays,
    limits: Object.fromEntries(Object.entries(b.allowance.limits).map(([asset, l]) => [
      asset,
      { perProposal: money(asset, l.perProposal), perPeriod: money(asset, l.perPeriod) },
    ])),
  };

  /*
   * No `as any`. It carried one, and that cast is what let the old flat
   * allowance shape survive a type change underneath it — M-42's lesson, and
   * the reason this route was still accepting a body the service could not use.
   */
  res.json(plugins.install({
    accountId: String(req.params.id),
    pluginId: b.pluginId,
    scopes: b.scopes as Parameters<typeof plugins.install>[0]['scopes'],
    allowance,
    installedBy: b.installedBy,
  }));
}));

app.post('/api/installations/:id/status', authed, ownsInstall, wrap(async (req, res) => {
  const b = z.object({ status: z.enum(['active', 'suspended', 'removed']) }).parse(req.body);
  res.json(plugins.setStatus(String(req.params.id), b.status));
}));

app.get('/api/accounts/:id/plugin-events', authed, member, wrap(async (req, res) => {
  res.json(plugins.events(String(req.params.id)));
}));

/** Everything below is what a plug-in itself calls, using its capability token. */
app.get('/api/plugin/state', wrap(async (req, res) => {
  res.json(await plugins.read(String(req.query.token ?? ''), String(req.query.viewingKey ?? '')));
}));
app.get('/api/plugin/people', wrap(async (req, res) => {
  res.json(plugins.readPeople(String(req.query.token ?? '')));
}));
app.get('/api/plugin/runs', wrap(async (req, res) => {
  res.json(plugins.readRuns(String(req.query.token ?? '')));
}));
app.post('/api/plugin/propose', wrap(async (req, res) => {
  const b = z.object({
    token: z.string(), viewingKey: z.string(), summary: z.string(),
    asset: assetCode, amount: z.string().min(1),
    recipient: z.string(), proposedBy: z.string(),
  }).parse(req.body);
  /*
   * The plug-in names the asset, and that is safe because the CEILING IS LOOKED
   * UP BY IT — an asset the installation was not granted has no ceiling to
   * reach and is refused outright.
   */
  res.json(await plugins.propose(b.token, b.viewingKey, {
    summary: b.summary,
    asset: b.asset,
    amount: money(b.asset, b.amount),
    recipient: b.recipient,
    proposedBy: b.proposedBy,
  }));
}));

/* ------------------------- the point ------------------------- */

/**
 * Everything an outside observer can see. This endpoint exists to be shown to
 * someone sceptical: the commitments and the public face of every proposal. No
 * individual amount or name appears anywhere in it.
 *
 * **IT USED TO SAY *the commitments, the aggregate settlements, and the public
 * face of every proposal*, AND TWO OF THOSE THREE WERE EMPTY OR CONSTANT.**
 * `C292` removed the account's balance: every commitment here is
 * `viewDigestOf([])`, one value for every account and every state. **The
 * settlements array is not empty any more — it is gone**,
 * because an empty one read as evidence that an observer sees no settlements
 * when in fact nothing had ever written one. What is genuinely demonstrated is
 * the proposal face — ids, digests, counts, no names — and that is the whole of
 * it until a vault pays somebody.
 *
 * **THIS ROUTE STILL HAS NO SIGN-IN ON IT.** `C122`, open. What it returns now
 * carries nothing denominated in money, which is half of that row's *Done
 * when*; the other half is that a stranger cannot reach it at all.
 */
app.get('/api/public', wrap(async (_req, res) => {
  /*
   * What an observer can see — and since S-8 that is genuinely all we can show,
   * not all we chose to show.
   *
   * This used to expose `kind`, the human-written `summary` and
   * `approvals[].signerId`. That last one is the deanonymised version of the
   * nullifiers the chain blinds on purpose: an endpoint built to demonstrate
   * privacy was publishing precisely what the privacy exists to hide.
   */
  const proposals = store.listAccounts().flatMap(a => store.listProposals(a.id)).map(p => ({
    id: p.id, accountId: p.accountId, digest: p.digest, status: p.status,
    approvalCount: p.approvalCount,
    sealed: { iv: p.sealed.iv, body: p.sealed.body.slice(0, 48) + '...' },
    txRef: p.txRef ?? null,
  }));
  /*
   * `observerView` rather than `ledger.publicView()`: the method is not on the
   * `Ledger` boundary and this call only ever compiled because this file held a
   * `SimulatedLedger`. `src/wiring/selection.ts` carries the finding and the
   * question it leaves open.
   */
  res.json({ ...observerView(ledger), proposals });
}));

/* ------------------------- demo seed ------------------------- */

// Seeds a demo company owned by the caller. It no longer resets the store: with
// real tenants on the deployment, one person clicking "demo" must not wipe
// everybody else's data.
app.post('/api/demo/seed', authed, wrap(async (req, res) => {
  res.json(await seedDemo(accounts, payroll, req.userId!));
}));

/**
 * M-98: THE APP IS EXPORTED, AND IT DOES NOT LISTEN ON IMPORT.
 *
 * Every test in this project used to stop at the service layer, and the two
 * leaks that actually shipped were both in a route — `/api/public` publishing
 * `approvals[].signerId`, and a projection that named the company. The types
 * carry most of the weight now, but a hand-built response object still
 * compiles, and a status code has no type at all.
 *
 * `server.test.ts` imports this and drives real HTTP against an ephemeral
 * port. Listening is therefore conditional: importing the module must not
 * seize :8787 or leave a handle open that keeps vitest alive.
 */
export { app };

if (process.env.SERVE !== '0') {
  const PORT = Number(process.env.PORT ?? 8787);
  app.listen(PORT, () => {
    console.log(`api        http://localhost:${PORT}`);
    console.log(`ledger     ${ledger.describe()}`);
    console.log(`proofs     ${proofs.describe()}`);
    console.log(`data       ${DATA}`);
    /*
     * Said at boot for the same reason the file exists: a report nobody
     * knows about is a report nobody reads, and the whole point of it is to be
     * the first thing opened after a walk went wrong.
     */
    console.log(`refusals   ${refusalLogPath()}`);
  });
}
