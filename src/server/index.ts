import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { join } from 'node:path';
import { FileStore } from '../core/store-file.js';
import { wiring } from '../wiring/selection.js';
import { startProduct, holdingsFor } from '../wiring/product.js';
import { ContractBook } from '../wiring/account-contract.js';
import type { WriteCapability } from '../wiring/write-capability.js';
import { deploymentWriteCapability } from '../wiring/write-capability-for-deployment.js';
import { handedInFundedParties } from '../wiring/handed-in-wallets.js';
import { handedInWiring } from '../wiring/handed-in.js';
import { AccountService, CompanyLabelTaken, NotACompanyLabel } from '../core/account.js';
import { readCompanyLabel } from 'midnight-identity/profile/company-label';
import { PayrollService, RecordingInviteDelivery } from '../core/payroll.js';
import { IdentityService, TooManyAttempts, StaleKeyBundle } from '../core/identity.js';
import {
  WalletIdentityService, WalletSignInError, walletSignInOrigin,
} from '../core/wallet-identity.js';
import { NoCompanyAddress, companyForSession } from '../core/company-address.js';
import { MemoryChallengeStore } from '../core/challenges.js';
/* `X8` — the server half of taking a receiving address from a wallet. It
 * reaches the wallet SDK, which is why no browser application (`apps/web`, or
 * the shared code in `packages/web-shared`) may. */
import {
  MemorySessionStore, PostgresSessionStore, type SessionStore,
} from '../core/sessions.js';
import {
  MemoryRateLimiter, PostgresRateLimiter, type RateLimiter,
} from '../core/rate-limit.js';
import {
  countProvenance, decideList, refuseSelectionOver, refuseSelectionOverHistory,
  type ListVerdict, type Marked,
} from '../core/provenance.js';
import { assets as assetRegistry, type AssetId, type LedgerForm } from '../core/assets.js';
import { refuseWhatTheVaultCannotPay } from '../core/vault-holdings.js';
import { bigintJsonReplacer, wrapKey } from '../core/crypto.js';
import { payslipProofSubject } from '../core/payslip-open.js';
import { PAGE_OUT_OF_DATE, PAYSLIP_PAGE_HEADER, isCurrentPayslipPage } from '../core/payslip-page.js';
import {
  SIGNED_IN_AS_HEADER, anotherPersonRefusal, answerCarriesToken, clearedSessionCookie,
  cookieScopeFor, credentialOf, crossSiteWriteRefusal, sessionCookie,
} from './session-cookie.js';
import type { Hex } from '../core/crypto.js';
import { theNetwork } from '../midnight/network.js';
import { NothingWasSent, saysNothingWasSent } from '../core/jobs.js';
import { loadEnvFile } from '../db/connect.js';
import { appendWebConsole, webConsoleLogPath } from './web-console-log.js';
/* `C157` — every refusal this service makes, kept. See `wrap` below. */
import { appendRefusal, refusalLogPath } from './refusal-log.js';
import {
  mountVaultRecords, openedOnFirstUse, vaultAccountFromTheIndexer, whyVaultRecordsCannotBeKept,
  type VaultAccountReader,
} from './vault-records-authority.js';
import { openCompanyRecords, openVaultRecords, refuseVaultsTheOperatorToolsKeep } from '../db/vault-records.js';
import { companyRecordsRoutes, MemoryCompanyRecordStore, movePeopleToTheirRecords, withTheRosterIn } from './company-records-route.js';
import { invitationRoutes } from './invitations-route.js';
import { ownsPersonIn, peopleRoutes } from './people-route.js';
import { proposalRelayRoutes } from './proposal-relays.js';
import { runRoutes } from './run-routes.js';
import { signerRoutes } from './signer-routes.js';
import { MemorySealedPoolStore, type SealedPoolStore } from '../midnight/vault-pool.js';
import type { CompanyRecordStore, PeopleRecords, WireRecord } from '../midnight/sealed-record-wire.js';
import { aCompanyCreatedOnTheLedger, accountCreationRoutes } from './account-creation.js';
import { companyVaultRoutes, type VaultChain } from './company-vaults.js';
import {
  directoryChainFromTheContract, directoryOf, filerSeatNow, seatDirectoryRoutes, type AccountHolds, type DirectoryChainRead,
} from './seat-directory-route.js';
import { ledger as readAccountLedger } from '../../contracts/managed/contract/index.js';
import { vaultArtefactPlaces, vaultArtefactRoutes } from './vault-artefacts.js';
import { parameterSources, startProvingParameters } from './proving-parameters.js';
import {
  accountCreationExpectationsIn, accountHandoverWith, accountTemporaryVerifyingKey, accountVerifierKeysIn, committeeChangeWith, vaultChainFromTheIndexer,
  vaultVerifierKeysIn,
} from './vault-chain.js';
import { DEPLOYED_CIRCUITS } from '../midnight/deferral.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { readProvenTransaction, readFinishedTransaction } from '../wiring/proven-submission.js';

/**
 * **`.env` IS READ HERE, AND UNTIL X2 IT WAS NOT READ AT ALL.**
 *
 * `npm run dev` starts this file, `DATABASE_URL` lives in `.env`, and nothing
 * in this process ever opened that file — so the server refused to start with
 * *DATABASE_URL is not set* on a machine where it was set, and the payroll app
 * could not be started by anybody. `scripts/migrate.ts` has always called this
 * before it connects; the server, which is the thing a person actually runs, was
 * the one entry point that did not.
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
 * pair can read. `theNetwork` carries the whole argument.
 */
const NETWORK = theNetwork();



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
/*
 * **THE RUNNING SET, ASSEMBLED FROM THIS DEPLOYMENT'S OWN FACTS.**
 *
 * `src/wiring/selection.ts` says WHICH implementation runs and holds the
 * commitment scheme; `src/wiring/product.ts` is what turns that into a ledger,
 * and it needs a contract address, an indexer, a node and a proof server, none
 * of which has a default.
 *
 * **AN ACCOUNT'S ADDRESS COMES OFF ITS OWN STORED RECORD AND FROM NOWHERE
 * ELSE.** It is written the moment the account is opened, from what the ledger
 * reported, precisely so that reading it later does not depend on a process
 * remembering anything.
 *
 * **A REFUSAL DOES NOT STOP THIS MODULE LOADING**, and the reason is in
 * `product.ts`: this file is imported by things that never serve, and a module
 * that throws while being evaluated reports a failure about itself instead of
 * about the missing configuration. What a refusal does is give every route a
 * ledger that answers nothing and says why - and stop the process listening,
 * below.
 */
/*
 * **AN ACCOUNT'S CONTRACT COMES OFF ITS OWN RECORD, WITH THE TWO FACTS THAT
 * MAKE THAT RECORD CHECKABLE, AND THERE IS NO FALLBACK.**
 *
 * This used to hand over the address by itself. An address alone is sixty-four
 * hex characters that cannot be told from sixty-four hex characters some
 * process invented for itself, so the check downstream had nothing to check
 * with. The record already carries where the address came from and which ledger
 * wrote it; they travel together now because they are only useful together.
 *
 * **AND THE OBVIOUS REPAIR IS THE DANGEROUS ONE.** An account with no recorded
 * address could be pointed at the contract this deployment already resolved at
 * boot - it is real, it is right there, and it is THE SAME ONE FOR EVERY
 * ACCOUNT. Every company would then read the same balances, the same rounds and
 * the same signers, and no screen would look broken. So an unrecorded account
 * resolves to nothing and the boundary says it cannot answer.
 */
const book = new ContractBook(
  id => {
    const a = store.getAccount(id);
    if (!a) return null;
    return {
      address: a.contractAddress ?? null,
      source: a.addressSource ?? null,
      wiring: a.wiring ?? null,
    };
  },
  wiring().name,
);
/*
 * **WHAT THIS PROCESS CAN WRITE WITH.**
 *
 * Writing needs five things: somebody to balance the legs the company owns,
 * somebody to pay the fee, the compiled contract this build proves against, a
 * recorded maintenance authority and a key for the private state store. Three
 * of those are this deployment's own facts and the function below resolves them
 * itself. **The other two are parties that can spend, and a server does not
 * acquire either by starting up** - bringing a funded wallet up means a seed, a
 * proof server, a sync and a wait for DUST to accrue, none of which is a thing a
 * web process should do to itself on boot, and one that quietly did would be a
 * web process that can spend.
 *
 * **THE FEE PAYER IS A SEPARATE SERVICE, NAMED BY THIS DEPLOYMENT'S SETTINGS.**
 * This process holds a client to it and no key: it can ask for a capped fee to
 * be added and for what the service built to be submitted. With no fee payer
 * named, there is none.
 *
 * **THE COMPANY'S SIDE IS HANDED IN OR ABSENT.** `handedInFundedParties`
 * answers with what a launcher brought up and handed over before importing this
 * file, or with `null`, which is what every process started the ordinary way
 * gets. Without both halves every write goes on refusing by name; reading
 * accounts, balances and rounds is unaffected, which is what a deployment built
 * to watch a chain is for.
 *
 * **ONE SUPPLIER, AND EVERY PATH REACHES IT.** The script that creates a
 * company from this machine calls it in its own process and never starts this
 * server. The launcher that serves the product on a chain hands both halves in
 * before importing this file. A deployment names its fee payer in its settings,
 * **and that alone does not make it able to write**: until the company's side
 * is handed in too, every write is refused.
 *
 * **AND WHAT ELSE HAS TO CHANGE ON THE DAY THIS ARGUMENT DOES, BECAUSE THIS
 * PARAGRAPH SAID *nothing else* AND THAT WAS FALSE.** A fee payer is told which
 * company it is about to pay for, because that cannot be read off a bound,
 * shielded transaction afterwards - and it is told on the object, since the
 * SDK's callbacks carry nothing to tell one operation from another. Two
 * requests handled at once would share one fee payer, and the second would
 * overwrite the first's company before the first recorded what it paid - a
 * record wrong rather than absent. **So writes wait their turn per fee payer,
 * inside the chain ledger's one write gate**, and the second request's write
 * starts only when the first's has settled.
 */
const writeCapability: WriteCapability | undefined =
  await deploymentWriteCapability(process.cwd(), process.env, handedInFundedParties());
const startup = startProduct(book, process.cwd(), process.env, writeCapability);
/*
 * **AND THE ONE CASE WHERE THIS PROCESS DOES NOT RESOLVE ITS OWN SET: A TEST
 * HANDED IT ONE BEFORE IMPORTING THIS FILE.**
 *
 * The routes below cannot be exercised against a deployment that has no wallet
 * - every write refuses above the ledger, correctly - and those routes are
 * where approval-signature verification, invitation sealing and payee
 * disclosure live. A caller that has built a whole boundary implementation
 * itself gets to drive them with it.
 *
 * **NO MODULE THE PRODUCT SHIPS REACHES THIS.** `handInWiring` is refused in
 * every non-test `.ts` and `.tsx` file under `src/` by the walk beside the
 * selector - which names its own edges where it is defined - so this is `null`
 * here unless a test file said otherwise, and there is no name, environment
 * variable or default that could make it anything else.
 */
const handed = handedInWiring();
const chosen = handed ?? startup.wiring;
/*
 * **THE LEDGER IS CHOSEN BEFORE ANYTHING IS SERVED, SO THE RECORDS IT WILL BE
 * SERVING ARE CHECKED HERE AND NOT ONE COMPANY AT A TIME.**
 *
 * A record that does not say which ledger wrote it cannot be shown beside one
 * that a chain wrote, and nothing can work out afterwards which it was. The
 * list routes refuse such a mixture per company, which protects each company;
 * this refuses the process, which is what makes the situation visible to
 * whoever pointed it here. It cannot fire while the product is rehearsing.
 */
{
  const snapshot = chosen.name;
  const seen = countProvenance([
    ...store.listAccounts(),
    ...store.listAccounts().flatMap(a => store.listProposals(a.id)),
    ...store.listAccounts().flatMap(a => store.listRuns(a.id)),
  ]);
  const refusal = refuseSelectionOver(snapshot, seen)
    /* And the half a count cannot see: what has written here before, including
     * for records that are no longer in the store to be counted. */
    ?? refuseSelectionOverHistory(store.snapshot().writtenBy);
  if (refusal) throw new Error(refusal);
}
const ledger = chosen.createLedger();
const proofs = chosen.createProofSystem();

/*
 * SESSIONS AND THE LIMITER COME FROM POSTGRES, AND THE SERVER REFUSES TO START
 * WITHOUT IT UNLESS SOMEBODY SAYS OTHERWISE OUT LOUD.
 *
 * The in-memory versions are correct for one process nothing else shares -
 * development and the tests, which say so out loud - and wrong for a server,
 * in the same way and for the same reason: they are per-process. Two
 * instances double the login allowance, and a restart both clears the count
 * and — before S-3 — silently signed everybody out. Falling
 * back quietly would reproduce exactly the failure S-2 and S-4 describe, with
 * the code to fix it sitting right here looking like it was doing something.
 *
 * So: `DATABASE_URL` or an explicit `ALLOW_MEMORY_SESSIONS=1`. An accident
 * cannot produce either.
 */
const DATABASE_URL = process.env.DATABASE_URL;
let sessions: SessionStore;
let limiter: RateLimiter;
/* The same database, kept for a vault's sealed records below. */
let recordsSql: import('../db/vault-records.js').RecordsSql | null = null;

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
  recordsSql = sql as never;
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

const sqlForRecordsOfCompanies = recordsSql;
/*
 * A COMPANY'S OWN SEALED RECORDS, filed by its seats: kept as a vault's are, in the database when there is one,
 * and opened at the first request for the same reason.
 */
const companyRecords: CompanyRecordStore & PeopleRecords = sqlForRecordsOfCompanies
  ? (() => {
    let opened: Promise<CompanyRecordStore & PeopleRecords> | null = null;
    const db = () => {
      if (opened === null) { opened = openCompanyRecords(sqlForRecordsOfCompanies); opened.catch(() => { opened = null; }); }
      return opened;
    };
    return {
      get: async (c, k, i) => (await db()).get(c, k, i),
      versions: async (c, k, i) => (await db()).versions(c, k, i),
      at: async (c, k, i, v) => (await db()).at(c, k, i, v),
      put: async (r) => (await db()).put(r),
      peopleOf: async (c) => (await db()).peopleOf(c),
      companyOfPerson: async (i) => (await db()).companyOfPerson(i),
    };
  })()
  : new MemoryCompanyRecordStore();
/* A company's roster is kept in the main store, beside the account record that reads its signers (`withTheRosterIn`). */
const companyRecordStore = withTheRosterIn(store, companyRecords);
/*
 * A company's people are kept with its other records. Anyone the main store still holds from before is moved there
 * first, one person at a time, and the service does not start while one cannot be.
 */
{
  const moved = await movePeopleToTheirRecords(store, companyRecords);
  if (moved > 0) console.log(`moved ${moved} people from the main store to the company records store`);
}

/*
 * **WHAT A VAULT HOLDS, WIRED, SO THAT A ROUND THAT MOVES MONEY IS REFUSED FOR
 * A REASON ABOUT THE MONEY RATHER THAN ABOUT THIS SERVICE.**
 *
 * Without it every such round is refused before it is raised, by a reader that
 * answers nothing - which is the correct default for a service that might not
 * be able to see a chain, and the wrong answer for one that can. This process
 * resolved a deployment, so it can.
 *
 * **IT DOES NOT ANSWER PRIVATE MONEY, AND A PAYROLL RUN IS ALL PRIVATE.** The
 * reader answers public money only. A private payment is checked on the
 * signer's device that raises the proposal, against the vault's pool that device
 * opens, before it asks for the raise; this service then asks only about the
 * public money on that round. A round this service would send itself is still
 * asked about both, so a private payment on it is refused, as before.
 *
 * **WHAT IT WIDENS, EXACTLY.** A reader that answers nothing refuses every
 * round that moves money. This one refuses on what the chain says, so a round
 * whose payees are all PUBLIC and whose total the vault's public balance covers
 * is now raised where it was previously stopped. Every other answer this
 * reader gives - the chain unreadable, a read that failed, a private balance
 * this service cannot see - is still a refusal to raise.
 *
 * The asset registry is named rather than skipped because the reader is the
 * argument after it and there is no way to pass the fifth without the fourth.
 * It is the same registry the constructor's default supplies, and it is the one
 * this file already holds.
 */
const holdings = holdingsFor(startup);
/* The sixth is where a company's signed state record is read: the only copy of the state a device founded. */
const accounts = new AccountService(
  store, ledger, chosen.commitments, assetRegistry, holdings, companyRecordStore);
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
const payroll = new PayrollService(store, accounts, undefined, NETWORK, invites);

const challenges = new MemoryChallengeStore();
/* Its own store, so a value sealed for a payslip proof can never be spent as a sign-in. */
const payslipProofs = new MemoryChallengeStore();
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
 * person's own wallet from their seed and the company's label, so setting the
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

/*
 * **WHERE THE SIGN-IN COOKIE BELONGS, DECIDED ONCE AT START-UP.** The site the
 * application and the wallet share - `WALLET_ORIGIN` names the wallet - so one
 * sign-in covers both surfaces. Two origins that share no site stop the server
 * here with the reason: a sign-in scoped to the wrong name fails later, at a
 * sign-in, in front of a person.
 */
const cookieScope = cookieScopeFor(process.env.APP_ORIGIN, process.env.WALLET_ORIGIN);

const app = express();
/*
 * EVERY AMOUNT LEAVES AS `{"$n":"…"}`, and without this line the server is
 * broken for every screen that shows money.
 *
 * `res.json` calls `JSON.stringify`, which THROWS on a bigint — *Do not know
 * how to serialize a BigInt* — so `/state` and `/people` answered 400 the
 * moment amounts became integers. It
 * typechecked perfectly: no signature says what `res.json` can carry.
 *
 * The replacer is imported rather than written here, so the tag has one
 * definition shared with `canonical` and `reviveBigints` — the client already
 * revives this shape, and two places deciding what it looks like is M-104.
 */
app.set('json replacer', bigintJsonReplacer);
app.use(cors());
/*
 * **A VAULT'S SEALED RECORDS: ITS NOTE POOL, ITS TWO JOURNALS AND ITS NONCE
 * SECRET, KEPT HERE AND OPENED ONLY ON A SIGNER'S DEVICE.**
 *
 * Who may read and file them is answered by the chain and the account records:
 * the vault's ledger names the company's account, and the person must be an
 * active signer of the company with that address. Every filing is signed.
 * Without a database the records are kept in this process only, which is for
 * development and says so.
 */
{
  /*
   * Opened at the first request rather than at start, so a database that is not
   * answering refuses the records it holds and does not stop the server; and
   * asked about its durability on that first open, as the store requires.
   */
  const sqlForRecords = recordsSql;
  if (!sqlForRecords) {
    console.warn('     A vault\'s sealed records are in memory too, and a restart loses them.\n');
  }
  const records: { of(record: WireRecord): SealedPoolStore } = sqlForRecords
    ? openedOnFirstUse(() => openVaultRecords(sqlForRecords, {
      refuseToCreate: refuseVaultsTheOperatorToolsKeep(join(process.cwd(), '.midnight')),
    }))
    : (() => {
      const kept = new Map<WireRecord, SealedPoolStore>();
      return { of: (record: WireRecord) => kept.get(record) ?? kept.set(record, new MemorySealedPoolStore()).get(record)! };
    })();
  const accountOf: VaultAccountReader = startup.started
    ? vaultAccountFromTheIndexer(await (async () => {
      const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
      return indexerPublicDataProvider(startup.deployment.indexerUrl, startup.deployment.indexerWsUrl) as never;
    })())
    : async () => { throw new Error(startup.refusal); };
  const refusingChain: VaultChain = {
    contractState: async () => { throw new Error(startup.started ? 'unreachable' : startup.refusal); },
    serialize: () => { throw new Error('no chain'); },
    notesOf: () => { throw new Error('no chain'); },
    startingLedgerOf: () => { throw new Error('no chain'); },
    everCreated: async () => { throw new Error(startup.started ? 'unreachable' : startup.refusal); },
  };
  const theChain = startup.started
    ? await vaultChainFromTheIndexer({ url: startup.deployment.indexerUrl, wsUrl: startup.deployment.indexerWsUrl })
    : refusingChain;
  /*
   * WHAT THE CHAIN SAYS OF A COMPANY'S ACCOUNT NOW, read by this server: its committee, the seats it holds of those
   * asked about, and its approval threshold. Every seat directory this server believes is replayed against it. A
   * test that hands in a simulated ledger hands in this read with it (`handInWiring`); nothing shipped can.
   */
  const directoryChain: DirectoryChainRead = handed?.directoryChain ?? directoryChainFromTheContract({
    addressOf: async (accountId) => (await ledger.address(accountId))?.value ?? null,
    contractState: (address) => theChain.contractState(address as Hex),
    readLedger: (data) => readAccountLedger(data as never) as unknown as AccountHolds,
  });
  const directoryNow = (accountId: string) => directoryOf(store, directoryChain, accountId);
  /* `authed` is defined further down; it is looked up when a request arrives, by which time it is. */
  mountVaultRecords(app, {
    signedIn: (req, res, next) => authed(req, res, next),
    records, accountOf, companies: () => store.listAccounts(),
    mayFileUnder: async (companyId, person, filer, record) =>
      typeof filerSeatNow(await directoryNow(companyId), person, filer, record) !== 'string',
  });

  app.use(companyRecordsRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    records: companyRecordStore,
    accountOf: (accountId) => store.getAccount(accountId),
    directoryOf: directoryNow,
  }));
  app.use(invitationRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store, records: () => companyRecordStore,
    directoryOf: directoryNow,
    meterOffer: (req, res) => meteredOfferLookup(req, res),
    recordRefusal: appendRefusal,
  }));
  app.use(peopleRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    ownsPerson: (req, res, next) => ownsPerson(req, res, next),
    store, records: () => companyRecordStore, people: () => companyRecords,
    directoryOf: directoryNow,
  }));
  /* A COMPANY'S SIGNERS: admitted, their vault keys offered, and the roster filed, each from a seat's own device. */
  app.use(signerRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store, records: () => companyRecordStore, ledger, directoryOf: directoryNow,
  }));
  /* A COMPANY'S PAYROLL RUNS: drawn, sealed and signed on a signer's own device, and kept as they are given. */
  app.use(runRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store, directoryOf: directoryNow, wiring: () => ledger.wiring ?? null,
  }));
  /*
   * A COMPANY'S PROPOSALS: a raise, an approval or a withdrawal a signer's device proved, relayed for a seat that may act,
   * and where each stands read off the chain. Nothing here holds a key.
   */
  app.use(proposalRelayRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    ownsProposal: (req, res, next) => ownsProposal(req, res, next),
    refuseSigningSecret: (req, res, next) => refuseSigningSecret(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store, ledger, directoryOf: directoryNow, recordRefusal: appendRefusal,
    wiring: () => ledger.wiring ?? null,
    /* A proposal's identity is the contract's on every wiring, as the device that raised it made it. */
    proposalIdOf: (payloadHash, salt, vault) => MidnightCommitments.proposalId(payloadHash as Hex, salt as Hex, vault as Hex | undefined),
    /* A raise is refused before it is written down when the vault's public money cannot pay what it says it pays. */
    publicMoney: async ({ vault, asset, payments }) => {
      const asked = payments.map((p) => ({ payee: { kind: p.kind as LedgerForm }, token: p.token, amount: BigInt(p.amount) }));
      try {
        await refuseWhatTheVaultCannotPay(holdings, {
          vault: vault as Hex, asset: assetRegistry.require(asset as AssetId), total: asked.reduce((a, p) => a + p.amount, 0n),
          payees: BigInt(asked.length), payments: asked,
        }, ['unshielded']);
      } catch (e) {
        throw new NothingWasSent((e as Error).message);
      }
    },
  }));

  /*
   * A COMPANY'S VAULTS: created, handed to the company's committee and funded
   * from its signers' own devices. Mounted before the general parser for the
   * same reason as the records above: a deploy is larger than most bodies.
   */
  app.use(vaultArtefactRoutes(vaultArtefactPlaces(process.cwd(), process.env)));
  /*
   * A COMPANY'S SEAT DIRECTORY: every filing served whole, each new one checked against this server's own read of
   * the account on the chain - its committee, the seats it holds now and its approval threshold.
   */
  app.use(seatDirectoryRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store,
    chain: directoryChain,
  }));
  /*
   * A COMPANY'S ACCOUNT, deployed by its founding signer's device held by their own key, and paid for here: read
   * against what was recorded when the company was made, recorded before it is sent, and finished by its second step.
   */
  const creationExpected = accountCreationExpectationsIn(process.cwd());
  app.use(accountCreationRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store,
    ledger,
    contractState: (address) => theChain.contractState(address),
    register: (accountId, address) => book.record(accountId, address),
    readers: { proven: readProvenTransaction },
    expected: creationExpected,
  }));
  app.use(companyVaultRoutes({
    signedIn: (req, res, next) => authed(req, res, next),
    member: (req, res, next) => member(req, res, next),
    store,
    company: async (accountId) => {
      const [address, status] = await Promise.all([ledger.address(accountId), ledger.status(accountId)]);
      if (!address || !status) return null;
      return {
        address: address.value as Hex,
        threshold: status.threshold,
        vaultThresholds: status.vaultThresholds.map((v) => ({ vault: v.vault as Hex, threshold: v.threshold })),
      };
    },
    ledger,
    chain: theChain,
    verifierKeys: vaultVerifierKeysIn(process.cwd()),
    /* A company account is handed to its committee with the temporary key this deployment recorded, and no
     * money goes into a vault until the chain shows the account held by the committee. */
    account: {
      circuits: DEPLOYED_CIRCUITS,
      verifierKeys: accountVerifierKeysIn(process.cwd()),
      handover: startup.started ? accountHandoverWith(writeCapability?.maintenanceAuthority, NETWORK) : undefined,
      temporaryKey: startup.started ? await accountTemporaryVerifyingKey(writeCapability?.maintenanceAuthority) : undefined,
    },
    readers: { proven: readProvenTransaction, finished: readFinishedTransaction },
    /* A committee change is put together from its signers' own signatures; this deployment signs none of it. */
    committeeChange: startup.started ? committeeChangeWith(NETWORK) : undefined,
  }));
}

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
 * proved — the trap the sink's own layer defects were written to avoid.
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

/* ------------------- which ledger wrote what ------------------- */

/**
 * **EVERY LIST OF ACCOUNTS, ROUNDS OR PAYROLL RUNS GOES THROUGH HERE.**
 *
 * A company works out what it has by reading a list, so this is where a record
 * that never reached a chain has to be told apart from one that did. A check at
 * the point of payment would be a check that runs after somebody has already
 * decided, on a screen, that the money is there.
 *
 * The rule itself is not in this file. It is one function with no server in it,
 * so it can be read, tested and reasoned about without starting anything - and
 * so that the other build of this product, which answers these same routes
 * in-process with no server at all, answers them by the same rule rather than
 * by a second copy of it.
 */
const answerList = <T extends Marked>(res: express.Response, rows: readonly T[]): void => {
  const verdict: ListVerdict<T> = decideList(chosen.name, rows);
  if (verdict.listed) { res.json(verdict.rows); return; }
  res.status(409).json({ error: verdict.message, code: verdict.refusal, counts: verdict.counts });
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

/**
 * The sign-in token as sent - the bearer header if there is one, otherwise the
 * session cookie - or ''. Needed by anything that revokes it.
 */
const bearer = (req: express.Request) => credentialOf(req.headers).token;

/**
 * Resolves the sign-in. Nothing below this reads a body before the token checks out.
 *
 * **A WRITE THAT ARRIVED ON THE COOKIE IS REFUSED UNLESS IT CAME FROM THIS
 * APPLICATION'S OWN PAGE**, before the sign-in is even looked up - the cookie is
 * sent by the browser on its own, so its presence says nothing about who asked.
 */
/*
 * **AN INVITATION'S OFFER IS METERED, AND KEYED ON WHO IS ASKING.** `X11` §6,
 * `docs/scope-invitations.md` §8.
 *
 * It is the one door that answers somebody with no sign-in with something worth
 * having. **The limiter is the one sign-in already uses** - the same class, the
 * same store, the same buckets - because a second implementation of a counter is
 * a second thing that can be wrong about atomicity.
 *
 * **THE KEY IS THE CALLER AND NOT THE INVITATION**: a limit per invitation
 * would give a guesser a fresh allowance for every guess. **Recorded before the
 * lookup**, because a limiter that only counts misses lets the one guess that
 * lands through. A caller with no address is not counted and is not refused:
 * `req.ip` is absent only where there is no socket, a test driving the app
 * directly, and refusing there would fail closed on the one path that is not a
 * caller at all.
 */
const meteredOfferLookup = async (req: express.Request, res: express.Response): Promise<boolean> => {
  const from = context(req).ip;
  if (!from) return true;
  const decision = await limiter.record('invite-offer', from);
  if (decision.allowed) return true;
  res.setHeader('Retry-After', String(decision.retryAfterSeconds));
  res.status(429).json({
    error:
      'too many invitation lookups from here. This door answers anybody who has a link, '
      + `so it is metered — try again in ${decision.retryAfterSeconds} seconds.`,
    retryAfterSeconds: decision.retryAfterSeconds,
  });
  return false;
};

const authed: express.RequestHandler = async (req, res, next) => {
  const credential = credentialOf(req.headers);
  const refusal = crossSiteWriteRefusal({
    method: req.method,
    via: credential.via,
    origin: req.headers.origin,
    fetchSite: req.headers['sec-fetch-site'] as string | undefined,
  }, process.env.APP_ORIGIN);
  if (refusal !== null) {
    res.status(403).json({ error: refusal });
    return;
  }
  let userId: string;
  try {
    userId = await identity.verify(credential.token);
  } catch (e: any) {
    res.status(401).json({ error: e?.message ?? 'not signed in' });
    return;
  }
  /* The sign-in is live; is it the person this tab was prepared for? */
  const another = anotherPersonRefusal(req.headers[SIGNED_IN_AS_HEADER], userId);
  if (another !== null) {
    res.status(409).json({ error: another, code: 'another-person' });
    return;
  }
  req.userId = userId;
  next();
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
 * proposals, runs, people. Every child carries the account it
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
/* A person is on the payroll of the company whose records hold them. */
const ownsPerson = ownsPersonIn(() => companyRecords, (accountId, userId) => accounts.membership(accountId, userId));

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
      'this endpoint does not accept a signing secret. An approval is a call the '
      + 'signer\'s own device proves, and the key never leaves it. Send the proven '
      + 'transaction alone. Treat any key that has already been sent this way as '
      + 'disclosed and replace it.';
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
    /*
     * **A BROWSER GETS THE COOKIE AND NEVER THE TOKEN.** The cookie is
     * `HttpOnly`, which is worth nothing if the same token is also handed to the
     * page in this body. A client that is not a browser has no cookie jar and
     * gets the token to send as a bearer header, exactly as before.
     */
    res.setHeader('Set-Cookie', sessionCookie(r.session.token, r.session.expiresAt, cookieScope));
    res.json({
      user: { id: r.user.id, email: r.user.email, name: r.user.name },
      session: answerCarriesToken(req.headers) ? r.session : { expiresAt: r.session.expiresAt },
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
  /* The row is what makes the token dead; the cookie is cleared so the browser
   * stops sending a dead one. */
  res.setHeader('Set-Cookie', clearedSessionCookie(cookieScope));
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
  /*
   * **THE SIGN-IN ANSWER CARRIES A LIST, SO IT IS HELD TO THE LIST RULE.**
   *
   * This is the first thing a client asks for and the first place a company
   * sees what it has, which makes it the earliest moment a wrong belief can
   * form. It refuses the same way and with the same words as the list route
   * next to it rather than quietly serving what that route would withhold -
   * two answers to one question is how a refusal gets routed around.
   */
  const verdict = decideList(chosen.name, store.accountsForUser(u.id));
  if (!verdict.listed) {
    res.status(409).json({ error: verdict.message, code: verdict.refusal, counts: verdict.counts });
    return;
  }
  res.json({
    user: { id: u.id, email: u.email, name: u.name },
    accounts: verdict.rows,
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

/*
 * **A PRODUCT WAITING ON A WRITE THAT HAS NOT SETTLED SAYS SO HERE.**
 *
 * Writes through one fee payer run one at a time, so a write that never settles
 * holds every later one. Without this the route said `ok` over a product that
 * could not open a company, and the only symptom was a button that kept
 * spinning. `writing` names the kind of write, when it started and how many are
 * queued behind it - never the company, because this route answers anybody -
 * and `ok` is false once that write is overdue. A ledger that does not track
 * its writes gets no `writing` field at all rather than a `null` that would
 * claim nothing is in flight.
 */
app.get('/api/health', (_req, res) => {
  const tracked = typeof ledger.writeInFlight === 'function';
  const writing = tracked ? ledger.writeInFlight!() : null;
  res.json({
    ok: !writing?.overdue,
    ledger: ledger.describe(),
    proofs: proofs.describe(),
    ...(tracked ? { writing } : {}),
  });
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
  /*
   * **ON A CHAIN THIS SERVICE MAKES NOTHING FOR A COMPANY.** Its secrets and
   * its founding signer's seat are made on that signer's device, and what this
   * service is sent is what they seal: it is checked, recorded, and nothing is
   * made here. A creation that does not name the founding signer's committee
   * key is the old path, and is refused by name first.
   */
  const onTheLedger = await aCompanyCreatedOnTheLedger({ store, ledger, records: companyRecordStore }, req.userId!, req.body);
  if (onTheLedger !== null) {
    res.status(onTheLedger.status).json(onTheLedger.body);
    return;
  }
  const body = z.object({
    name: z.string().min(1),
    signers: z.array(z.object({
      name: z.string().min(1),
      role: z.enum(['admin', 'approver', 'initiator', 'viewer']),
    })).min(1),
    threshold: z.number().int().min(1),
    /*
     * **THE COMPANY'S LABEL, AS THE FOUNDING SIGNER'S WALLET DREW IT.** Every
     * signer's keys for this company are derived from it, so this service takes
     * it and never makes one up. Required: a company created without one is a
     * company no wallet could open.
     */
    companyLabel: z.string(),
    /*
     * **THE FOUNDING SIGNER'S COMMITTEE KEY FOR THE COMPANY, AS THEIR WALLET
     * GAVE IT WHEN IT DREW THE LABEL.** On a chain the account is deployed from
     * their browser held by this key alone, and this service records it now,
     * before any deploy exists, so the deploy is read against a key recorded
     * first and never against one the deploy carries itself.
     */
    foundingKey: z.object({ tag: z.literal('schnorr'), value: z.string().regex(/^[0-9a-f]{64}$/u) }).strict().optional(),
  }).parse(req.body);
  /*
   * **THE SIMULATED LEDGER MAKES ITS COMPANIES HERE**, so a company made on a
   * device is refused by name rather than ignored: what the device sealed
   * would otherwise be dropped and a second company made here in its place.
   */
  if (typeof req.body === 'object' && req.body !== null && 'founding' in req.body) {
    res.status(409).json({
      code: 'made-here-on-the-simulated-ledger',
      error: 'the simulated ledger makes its companies on this service, and a company made on a device is refused. Nothing was created.',
    });
    return;
  }
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
  const label = readCompanyLabel(body.companyLabel);
  if (label === null) {
    res.status(400).json({ error: new NotACompanyLabel().message, code: 'not-a-company-label' });
    return;
  }
  try {
    const created = await accounts.create(body.name, signers, body.threshold, undefined, label);
    if (body.foundingKey !== undefined) {
      /* What the account must be deployed from, recorded before the founding signer's device builds the deploy. */
      const leaf = created.account.signers[0]?.leafCommitment ?? null;
      if (leaf === null || !store.recordAccountOpening({
        accountId: created.account.id, foundingKey: body.foundingKey, foundingLeaf: String(leaf).toLowerCase(), companyLabel: label,
      })) {
        throw new Error('what this company\'s account must be created from could not be recorded, so it cannot be created.');
      }
    }
    res.json(created);
  } catch (e) {
    /* **A LABEL ANOTHER COMPANY HAS IS REFUSED, AND NOTHING IS DEPLOYED FOR IT.** */
    if (e instanceof CompanyLabelTaken) {
      res.status(409).json({ error: e.message, code: 'company-label-taken' });
      return;
    }
    throw e;
  }
}));

// Scoped to the caller. This is the list endpoint, not a directory of the estate.
/*
 * **A COMPANY AS IT IS SERVED: ITS ACCOUNT RECORD, AND ITS ROSTER RECORD WHERE
 * IT HAS ONE**, newest version, sealed as filed. A device opens both; nothing
 * here opens either, and nothing is stored twice to serve them together.
 */
const withRoster = <T extends { id: string }>(rec: T): T & { roster: ReturnType<typeof store.newestRoster> } =>
  ({ ...rec, roster: store.newestRoster(rec.id) });

app.get('/api/accounts', authed, wrap(async (req, res) => {
  answerList(res, store.accountsForUser(req.userId!).map(withRoster));
}));

app.get('/api/accounts/:id', authed, member, wrap(async (req, res) => {
  res.json(withRoster(accounts.require(String(req.params.id))));
}));

/*
 * `GET /api/accounts/:id/state` STOOD HERE AND IS GONE.
 *
 * It took the company's viewing key in its address and opened the company's
 * records with it to answer. No app called it. No route reads a viewing key
 * from a query string now, and `no-route-reads-a-key-from-an-address.test.ts`
 * says so of every route.
 */

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
  answerList(res, store.listProposals(String(req.params.id)));
}));

/*
 * Approving, asking where a proposal stands, withdrawing it and sending its
 * raise are `proposalRelayRoutes`: each takes the transaction a signer's device
 * proved, relays it for a seat that may act, and holds no key.
 */

/*
 * What the chain says about this account's round.
 *
 * Separate from our own proposal records on purpose. On Midnight the open
 * proposal and the approval count are on-chain state, so "can I propose right
 * now" is not a question this server can answer from its own database — and
 * answering it from the database is how a UI comes to offer a button the chain
 * rejects.
 */
/*
 * **A TRANSACTION A SIGNER'S DEVICE PROVED, SENT.**
 *
 * The device proves where the private input is and sends the proven
 * transaction here. This deployment balances the company's side, has its fee
 * payer add the capped fee, and submits - or refuses. Only a member of the
 * company reaches it, and the ledger pays only for calls into that company's
 * own contract.
 *
 * **THE ANSWER SAYS WHETHER ANYTHING WAS SENT.** `nothingWasSent: true` is a
 * refusal before any submission, which the device can report as final.
 * `nothingWasSent: false` is a submission that failed, which may have landed,
 * and the device must not report as nothing.
 */
app.post('/api/accounts/:id/proven', authed, member, async (req, res) => {
  /* Held under the body limit above, so a refusal here is this route's and not the parser's. */
  const body = z.object({ tx: z.string().min(1).max(1_000_000) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      nothingWasSent: true,
      error: 'this request carries no proven transaction to send. Nothing was sent.',
    });
    return;
  }
  if (typeof ledger.submitProven !== 'function') {
    res.status(503).json({
      nothingWasSent: true,
      error: 'this deployment does not send transactions proved on a device, so nothing was sent.',
    });
    return;
  }
  try {
    const ref = await ledger.submitProven(
      String(req.params.id), new Uint8Array(Buffer.from(body.data.tx, 'base64')));
    res.json({ txRef: ref.ref });
  } catch (e: any) {
    const nothing = saysNothingWasSent(e);
    const reason = e?.message ?? 'unknown error';
    appendRefusal(req.method, req.originalUrl, nothing ? 422 : 502, e?.name ?? 'Error', reason);
    res.status(nothing ? 422 : 502).json({ nothingWasSent: nothing, error: reason });
  }
});

app.get('/api/accounts/:id/ledger', authed, member, wrap(async (req, res) => {
  res.json(await accounts.ledgerStatus(String(req.params.id)));
}));

/*
 * ── ONE VAULT'S OWN APPROVAL THRESHOLD ──────────────────────────────────
 *
 * There is no route of its own here. What every signer needs to see is
 * `LedgerStatus.vaultThresholds`, which crosses on `GET /api/accounts/:id/ledger`
 * from the same read as the account's own threshold. Changing it is a
 * governance proposal like any other, written down, raised, approved and carried
 * out from signers' devices through `proposalRelayRoutes`.
 */

/**
 * **WHICH COMPANY THIS SESSION MAY ASK A WALLET TO OPEN.**
 *
 * The page needs the company's label to put in an unlock, because that is what
 * the wallet derives the key from, and the account that carries it, because
 * that is where the wallet reads it back from. **It is not allowed to choose
 * either**, and
 * this route is the whole of that rule on the wire: the account comes from the
 * path and goes through `member` like every other account-scoped route, and the
 * label and the account are looked up from that company's own record.
 *
 * **NOTHING IS READ OUT OF THE BODY, AND THE BODY IS WHERE A CLAIM WOULD GO.**
 * There is no `z.object(...).parse(req.body)` here and no reference to
 * `req.body` anywhere below — not as a fallback, not as an override, not as a
 * hint. A deliberate defect for this route puts exactly that door in
 * and names the test that dies.
 *
 * It is a POST because it is not a read of a public field: it is this
 * deployment saying *this is the company you may go and open, as you, now*.
 * A GET would also be honest; a POST is the shape in which the dangerous thing
 * — a body — actually exists, so refusing to read one is demonstrable rather
 * than theoretical.
 *
 * **NO KEY PASSES THROUGH HERE.** What comes back is the company's label and
 * its account's address, both public: the label is what the wallet derives the
 * company's keys from, and the account is where the wallet reads the label back
 * from, itself, before it gives anything. The key is released by the wallet to
 * the browser and this server never sees it — `wallet-unlock.test.ts` holds
 * that to a transport that records every byte this side is ever handed.
 */
app.post('/api/accounts/:id/unlock', authed, member, wrap(async (req, res) => {
  try {
    const { label, account } = companyForSession(store, req.userId!, String(req.params.id));
    res.json({ company: label, account });
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


app.get('/api/accounts/:id/runs', authed, member, wrap(async (req, res) => {
  answerList(res, store.listRuns(String(req.params.id)));
}));

/*
 * A leg of a run is raised on a signer's device: the run as raised and its proposal are filed together, and the raise
 * relayed, by `POST /api/accounts/:id/proposals` in `proposalRelayRoutes`; a raise written down and not yet seen on the
 * chain is sent again by `POST /api/proposals/:id/send`.
 */

/*
 * A retry of some of a leg's people is raised on a signer's device, over a tree of its own: the run as raised and its
 * proposal are filed together, and the raise relayed, by `POST /api/accounts/:id/proposals` in `proposalRelayRoutes`.
 */

/* A retry's raise is sent as any proposal's is: `POST /api/proposals/:id/send`, in `proposalRelayRoutes`. */

/*
 * `POST /api/runs/:id/settle` STOOD HERE AND IS GONE.
 *
 * It settled a run by spending the account's own balance. There is no balance
 * and no `PayrollService.settle`. Removed rather than left answering a refusal:
 * a route that exists is a route somebody integrates against.
 */

/*
 * `GET /api/runs/:runId/employee/:employeeId` STOOD HERE AND IS GONE.
 *
 * It took a payee's payslip secret in its address and opened the slip here, and
 * later only refused, with no sign-in. Removed rather than left answering a
 * refusal: a route that exists is a route somebody integrates against. Payslips
 * are opened in the payee's own browser, with the key from their wallet.
 */

/*
 * **A PAYEE'S OWN PAYSLIPS, TO A SIGNED-IN PERSON WHO HOLDS THEIR KEY.**
 *
 * Two locks, and both are required. The first is the sign-in: every route here
 * answers only a live session, as every company route does. The second is the
 * key: the first step seals a one-use value to the public key asked about, only
 * the holder of the matching secret can read it back, and the second step hands
 * over the slips only for that value. What is handed over is ciphertext that
 * the same secret opens in the payee's browser; this service never holds that
 * secret and cannot read what it hands over.
 *
 * **WHAT THE SIGN-IN COSTS, SAID RATHER THAN LEFT TO BE FOUND.** While it
 * answers, this service sees which signed-in person asked for slips naming which
 * company address. Nothing here writes that down: no route stores it, and the
 * refusal log records a request's method and address and no session. Which
 * companies pay a person is kept in that person's own saved keys, sealed under
 * the key their wallet releases, and this service cannot read it there.
 *
 * The first step answers the same way whether or not any slip is sealed to that
 * key, so asking does not reveal whether somebody is on a payroll here.
 */
/*
 * Metered by where the request comes from, on top of the sign-in. A caller with
 * no address is not counted, as on the offer route.
 */
const payslipsMetered = async (req: express.Request, res: express.Response): Promise<boolean> => {
  const from = context(req).ip;
  if (!from) return true;
  const decision = await limiter.record('payslips', from);
  if (decision.allowed) return true;
  res.setHeader('Retry-After', String(decision.retryAfterSeconds));
  res.status(429).json({
    error: `too many payslip requests from here. Try again in ${decision.retryAfterSeconds} seconds.`,
    retryAfterSeconds: decision.retryAfterSeconds,
  });
  return false;
};

/*
 * **A PAGE OLDER THAN THESE ROUTES IS TOLD TO RELOAD, BEFORE ANYTHING ELSE.**
 * It sends no sign-in, and a bare "not signed in" would send somebody who is
 * signed in back to a sign-in. Checked ahead of the sign-in, and it answers
 * nothing but the refusal, so no route here answers without a sign-in.
 */
const currentPayslipPage: express.RequestHandler = (req, res, next) => {
  if (isCurrentPayslipPage(req.headers[PAYSLIP_PAGE_HEADER])) { next(); return; }
  res.status(409).json({ code: 'payslip-page-out-of-date', error: PAGE_OUT_OF_DATE });
};

const payslipKey = z.string().regex(/^[0-9a-fA-F]{64}$/u, 'a payslip key is 32 bytes of hex')
  .transform(k => k.toLowerCase());

app.post('/api/payslips/proof', currentPayslipPage, authed, wrap(async (req, res) => {
  if (!await payslipsMetered(req, res)) return;
  const b = z.object({ publicKey: payslipKey }).parse(req.body);
  const { challenge, expiresAt } = await payslipProofs.issue(payslipProofSubject(b.publicKey));
  res.json({ sealed: wrapKey(challenge, b.publicKey), expiresAt });
}));

app.post('/api/payslips', currentPayslipPage, authed, wrap(async (req, res) => {
  if (!await payslipsMetered(req, res)) return;
  const b = z.object({
    publicKey: payslipKey,
    answer: z.string().regex(/^[0-9a-fA-F]{64}$/u, 'the answer is the value that was sealed to you'),
    /* The label of the company this key was worked out from, or null for a key no
     * company produced. Only slips naming exactly that are sent. */
    from: z.union([
      z.string().regex(/^co_[0-9a-f]{64}$/u, 'That is not a company label. It is co_ and 64 characters of 0-9 and a-f'),
      z.null(),
    ]),
  }).parse(req.body);
  const proven = await payslipProofs.consume(payslipProofSubject(b.publicKey), b.answer.toLowerCase());
  if (!proven) {
    res.status(403).json({
      code: 'payslip-proof-refused',
      error: 'this key has not been shown to be yours, so no payslips are sent for it. '
        + 'Ask again from the start: the value sealed to you can be used once, for two minutes.',
    });
    return;
  }
  res.json(payroll.payslipsFor(b.publicKey, b.from));
}));

/*
 * `GET /api/payslips/paid` STOOD HERE AND IS GONE. It relayed a company's
 * completed payments, and nothing called it once the payslip page read the
 * company's contract itself, through the indexer the payee's wallet names.
 */

/*
 * **EVERY COMPANY LABEL A COMPANY'S PAYSLIPS NAME, FROM ANY ONE OF THEM, EACH
 * WITH THE ACCOUNT THAT CARRIES IT.** A payee who knows a company by its label
 * reaches every slip sealed for it, and their wallet is told which account to
 * read the label back from. Labels and account addresses are public on the
 * chain, and this answers with nothing else, to a signed-in person only.
 */
app.get('/api/payslips/addresses', currentPayslipPage, authed, wrap(async (req, res) => {
  if (!await payslipsMetered(req, res)) return;
  const company = z.string().regex(/^co_[0-9a-f]{64}$/u, 'a company is named by its label: co_ and 64 lower-case hex')
    .parse(String(req.query.company ?? ''));
  res.json({ companies: payroll.payslipAddressesOf(company) });
}));

/*
 * A company's people are read, and changed, as their signed records: `peopleRoutes`, mounted beside the company's
 * records. No route here takes a key to read or change one.
 */

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
  const id = String(req.params.id);
  res.json(payroll.revokeInvite((await companyRecords.companyOfPerson(id))!, id));
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
  res.json({ inbox: store.handoverFor(String(req.params.id)) });
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
   * person who raised it; it records it. What holds the flow now is the admitting
   * device's own checks (`people-on-device.ts` `admitHere`): the payee's code,
   * signed by their own wallet for this company, the fingerprint they read out,
   * and one payable record per person. An invitation made on a device keeps no
   * token here at all, only the hash of what accepts it.
   */
  /* Nor what accepts one, its sealed offer or what a payee handed over: a list says who was invited and where it stands. */
  res.json(store.listInvites(String(req.params.id)).map(({ token, acceptanceHash, offer, handover, ...rest }) => ({
    ...rest, redeemed: Boolean(rest.acceptedAt),
  })));
}));

/*
 * Making, reading and accepting an invitation are `invitationRoutes`, mounted
 * beside the company's records.
 */

/*
 * ── A COMPANY'S SIGNERS, FROM ITS SIGNERS' OWN DEVICES ──────────────────────
 *
 * A signer is seated by a governance proposal like any other - written down,
 * raised, approved and carried out from signers' devices through
 * `proposalRelayRoutes` - and admitted, their vault keys offered and the roster
 * filed through `signerRoutes`. This service holds no signer's secret and no
 * viewing key, so it seats, grants and writes no roster itself.
 */

/**
 * M-98: THE APP IS EXPORTED, AND IT DOES NOT LISTEN ON IMPORT.
 *
 * Every test in this project used to stop at the service layer, and the two
 * leaks that actually shipped were both in a route — a public route, since
 * deleted, publishing `approvals[].signerId`, and a projection that named the company. The types
 * carry most of the weight now, but a hand-built response object still
 * compiles, and a status code has no type at all.
 *
 * Tests import this through `src/testing/server-under-test.ts` and drive real
 * HTTP against an ephemeral port on 127.0.0.1. Listening is therefore conditional: importing the module must not
 * seize :8787 or leave a handle open that keeps vitest alive.
 */
export { app };

if (process.env.SERVE !== '0') {
  /*
   * **NOTHING IS SERVED BY A PROCESS THAT CANNOT SAY WHICH CONTRACT IT IS
   * TALKING TO.**
   *
   * This is the last thing checked and the first thing printed, and it exits
   * rather than listening. A process that came up and answered every question
   * with a refusal would look, to whoever pointed a browser at it, exactly like
   * a product that was broken - and to whoever deployed it, exactly like a
   * product that had started. **Those are the two readings that cost money**,
   * so the process does not exist to be read either way.
   *
   * The block below carries the cause whole and carries no stack: a stack trace
   * is a description of this program's insides handed to somebody who is trying
   * to configure it.
   */
  if (!startup.started) {
    console.error(`\n${startup.refusal}\n`);
    process.exit(1);
  }
  /*
   * **A SERVER THAT WRITES TO A CHAIN DOES NOT KEEP A VAULT'S RECORDS IN
   * MEMORY.** Money deposited under records a restart loses is named by
   * nothing, so this is asked before listening rather than found afterwards.
   * Asked here and not where the records are mounted, so that importing this
   * module to drive its routes stops nothing.
   */
  const cannotKeep = whyVaultRecordsCannotBeKept({ reachesAChain: startup.started && handed === null, database: recordsSql !== null });
  if (cannotKeep !== null) {
    console.error(`\n  ${cannotKeep}\n`);
    process.exit(1);
  }
  const PORT = Number(process.env.PORT ?? 8787);
  /*
   * **LOOPBACK, AND NOT EVERY INTERFACE.** Called with a port alone, this binds
   * every address the machine has, so anything on the same network could reach
   * it. That was merely untidy while nothing here could write. It is not untidy
   * now: this process can be started holding a funded wallet, and an unbound
   * listener would let a stranger on the same wireless network open companies
   * and spend with it. An address that has to be reachable from elsewhere is a
   * deployment's decision and belongs in front of this, not inside it.
   */
  app.listen(PORT, '127.0.0.1', () => {
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
    /*
     * **THE PUBLIC PARAMETERS A DEVICE PROVES WITH ARE FETCHED HERE WHEN THEY
     * ARE MISSING, SO NOBODY PUTS THEM IN PLACE BY HAND.** Each is checked
     * against the digest Midnight publishes before it is kept. It does not hold
     * up the start: a server that cannot fetch still serves, and says which
     * proofs will fail until it can.
     */
    startProvingParameters({ places: vaultArtefactPlaces(process.cwd(), process.env), sources: parameterSources(process.env) });
  });
}
