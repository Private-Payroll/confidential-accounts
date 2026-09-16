/**
 * SERVE THE PRODUCT ON STAGENET, ABLE TO WRITE, SO A COMPANY CAN BE CREATED
 * FROM THE SCREEN.
 *
 * -- WHAT IT DOES -----------------------------------------------------------
 *
 * It brings up the wallet that pays and the company wallet, turns them into
 * the pair the product is handed, hands that pair over, and only then starts
 * the product - the same server, application and wallet `npm run dev` starts,
 * through the same code, on the same origins. A person signs in with their wallet,
 * presses the button, and the company is deployed to stagenet through the
 * route the screen already calls.
 *
 * -- WHAT IT IS NOT --------------------------------------------------------
 *
 * **IT IS NOT THE SERVER ACQUIRING A WALLET.** The server still asks for a pair
 * and still answers read-only when none was handed in. This is a separate
 * process a person starts on purpose, and the only thing that makes the server
 * able to spend is that this process brought the wallets up first. Starting the
 * server any other way hands it nothing.
 *
 * -- WHAT IT TRADES, STATED ---------------------------------------------------
 *
 * **THE COMPANY'S HALF IS THE COMPANY WALLET ON THIS MACHINE, FOR EVERY COMPANY
 * CREATED WHILE IT RUNS.** It is brought up without DUST and pays no fee, and
 * its balance is not read here; it balances and signs the legs a company owns,
 * and a deploy carries no coin. The
 * design it stands in for takes that half from the signed-in person's own
 * wallet with each request, which needs the wallet to answer a balancing ask
 * it does not answer today.
 *
 * **ONE FEE PAYER, NOTHING METERED, AND EACH TRANSACTION CAPPED** at the
 * ceiling this machine's settings name; nothing starts without one. Every
 * payment is recorded with its company, its estimate and what the chain says it
 * cost - best effort: a record that cannot be written never turns a payment
 * that landed into a failure, so a full disk loses rows.
 *
 * -- WHAT IT SPENDS ----------------------------------------------------------
 *
 * Nothing by starting. At least one network fee each time somebody creates a
 * company or otherwise writes from the screen while it runs - more when the
 * product retries a deploy that had in fact landed.
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { StaticProofServerContainer } from '@midnight-ntwrk/testkit-js';

import { fileFeeSink } from '../src/midnight/sponsored-fees.js';
import { feeCeilingFrom } from '../src/midnight/fee-ceiling.js';
import { applyNetworkId, theNetwork, ENDPOINTS, type NetworkName } from '../src/midnight/network.js';
import { handInFundedParties } from '../src/wiring/handed-in-wallets.js';
import { bringUpWallet } from './wallet-bringup.js';
import { fundedPartiesOver, paidFeeFrom } from './funded-wallets.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';
import {
  POSTURE_NOT_CARRIED, postureFrom, refuseToServe, seedsAreOneParty,
} from './serve-with-wallets-rules.js';
import { pageStartsFor, refuseWhatTheServerSaid } from './serve-rules.js';
import { startTheServer, startThePages, stopChildren, stopEverythingOnExit } from './serve-product.js';

const ROOT = join(import.meta.dirname, '..');
const STATE_DIR = join(ROOT, '.midnight');
/*
 * **RESOLVED ONCE, HERE, AND NOT READ AGAIN.** This door used to take the raw
 * value, name a seed file with it and print it, and only validate it four
 * hundred lines later - so an unusable name reached a filename and a screen
 * before anything refused it.
 */
const NETWORK: NetworkName = theNetwork();
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT ?? 6301);
const SPONSOR_SEED_FILE = join(STATE_DIR, 'wallet.seed');
const COMPANY_SEED_FILE = join(STATE_DIR, `${NETWORK}-company.seed`);
const ARTIFACTS = join(ROOT, 'contracts', 'managed');
const FEE_RECORD = join(STATE_DIR, 'sponsored-fees.jsonl');
/*
 * **THE COMPANIES GO IN THE ONE RECORD OF COMPANIES THAT EXIST ON THE CHAIN.**
 * Every company created here is real, and a development data file is a
 * rehearsal record that may carry things no chain wrote - which this server
 * refuses to boot over, correctly. Set here and not left to `.env`, because the
 * server reads `.env` only for names nothing has set.
 */
const DATA = join(STATE_DIR, 'created-companies.json');

const line = (s = '') => console.log(s);
const step = (n: number, of: number, what: string) => line(`\n  [${n}/${of}] ${what}`);
const good = (s: string) => line(`      ${s}`);

stopEverythingOnExit();

async function proofServerAnswers(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  line('  ------------------------------------------------------------');
  line(`  Serving the product on ${NETWORK}, able to create a company`);
  line('  ------------------------------------------------------------');

  /* ---------------------------------------------------------------- 1 */
  step(1, 5, 'Checking what this machine has, before any wallet is brought up');

  const devScript = String(
    (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {}).dev ?? '');
  const posture = postureFrom(devScript);
  /*
   * **COMPARED HERE AND NEVER PRINTED.** Two halves brought up from one seed are
   * one wallet, and nothing after this point would say so.
   */
  const oneSeedForBoth = existsSync(SPONSOR_SEED_FILE) && existsSync(COMPANY_SEED_FILE)
    && seedsAreOneParty(readFileSync(SPONSOR_SEED_FILE, 'utf8'), readFileSync(COMPANY_SEED_FILE, 'utf8'));
  const refusal = refuseToServe({
    network: NETWORK,
    posture,
    oneSeedForBoth,
    present: {
      fundedSeed: existsSync(SPONSOR_SEED_FILE),
      companySeed: existsSync(COMPANY_SEED_FILE),
      maintenanceAuthority: existsSync(join(STATE_DIR, 'maintenance-authority.json')),
      compiledContract: existsSync(join(ARTIFACTS, 'keys')),
      proofServer: await proofServerAnswers(PROVER_PORT),
    },
  });
  if (refusal) throw new Error(refusal);
  /*
   * **READ BEFORE ANY WALLET IS BROUGHT UP**, so a missing ceiling stops this
   * here rather than after the slow part.
   */
  const ceiling = feeCeilingFrom(process.env);
  const plan = pageStartsFor(posture);
  /* Already refused above when it cannot be started; this narrows the type. */
  if ('refusals' in plan) throw new Error(plan.refusals.join('; '));
  good('the authority is recorded, the contract is compiled, the prover answers,');
  good('and both wallets have a seed on this machine');

  /* ---------------------------------------------------------------- 2 */
  step(2, 5, 'Bringing up the two wallets (this is the slow part: a sync, then DUST)');

  await applyNetworkId(NETWORK);
  const logger: any = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
    fatal: () => {}, silent: () => {}, level: 'silent',
    child() { return this; },
  };
  const { env, how } = testEnvironmentFor(NETWORK, logger);
  good(how);
  const cfg = await startEnvironment(
    env, new StaticProofServerContainer(PROVER_PORT), (s) => good(s));

  const payerLive = await bringUpWallet(
    logger, cfg, readFileSync(SPONSOR_SEED_FILE, 'utf8').trim(), NETWORK, ROOT,
    { withDust: true, requireDust: true, onNote: (m) => good(m) });
  good(`the wallet that pays holds ${payerLive.night()} NIGHT and ${payerLive.dust()} DUST`);

  const companyLive = await bringUpWallet(
    logger, cfg, readFileSync(COMPANY_SEED_FILE, 'utf8').trim(), NETWORK, ROOT,
    { withDust: false, onNote: (m) => good(m) });
  good('the company wallet is up; it is not given DUST and pays no fee');

  /* ---------------------------------------------------------------- 3 */
  step(3, 5, 'Handing the pair to the product, before the server exists');

  const { indexerPublicDataProvider } = await import(
    '@midnight-ntwrk/midnight-js-indexer-public-data-provider');
  const E = ENDPOINTS[NETWORK]!;
  const publicData = indexerPublicDataProvider(E.indexerUrl, E.indexerWsUrl);

  mkdirSync(STATE_DIR, { recursive: true });
  handInFundedParties(fundedPartiesOver(
    {
      provider: payerLive.wallet, facade: payerLive.wallet.wallet,
      dust: () => payerLive.dust(), night: () => payerLive.night(),
    },
    {
      provider: companyLive.wallet, facade: companyLive.wallet.wallet,
      dust: () => companyLive.dust(), night: () => companyLive.night(),
    },
    paidFeeFrom(publicData),
    fileFeeSink(FEE_RECORD, (p, l) => appendFileSync(p, l)),
    ({ fee, remaining }) => good(
      `paid ${fee ?? 'an amount that was not read back'}; `
      + `${remaining} DUST reported after (it lags, and is not a capacity reading)`),
    ceiling,
  ));
  good(`every fee paid is recorded in ${FEE_RECORD}`);
  good(`no transaction may spend more than ${ceiling.perTransaction} SPECKs of DUST`);

  /* ---------------------------------------------------------------- 4 */
  step(4, 5, 'Starting the server');

  for (const [k, v] of Object.entries(posture)) process.env[k] = v;
  /* Left behind even when this shell inherited it, not only when the script declares it. */
  for (const n of POSTURE_NOT_CARRIED) delete process.env[n];
  process.env.DATA_PATH = DATA;
  good(`companies are recorded in ${DATA}`);
  /*
   * **THE SERVER READS THE PAIR ONCE, WHILE IT IS BEING LOADED**, which is why
   * the pair was handed over above this line and not below it.
   */
  const { said, port } = await startTheServer(ROOT);

  /*
   * **THE SERVER IS ASKED WHAT IT CAN DO, AND ITS OWN WORDS DECIDE.** A server
   * that came up read-only would render every screen and fail at the button,
   * in front of whoever pressed it.
   */
  const cannot = refuseWhatTheServerSaid('can write', said, port);
  if (cannot) throw new Error(cannot);
  good(`the server says: ${said}`);

  /* ---------------------------------------------------------------- 5 */
  step(5, 5, 'Starting the page and the wallet');

  /*
   * **ON THIS MACHINE'S OWN LOOPBACK ONLY.** A page whose server can spend is
   * not offered to the rest of the network it happens to be on.
   */
  startThePages(ROOT, plan.starts, { ...process.env, ...posture });
  line();
  line(`  READY. Open ${posture.APP_ORIGIN}, sign in with your wallet, and create a company.`);
  line('  Each company created spends a network fee from the wallet that pays.');
  line('  Closing this window stops the server, the page and the wallet.');
  line();
}

main().catch((e: any) => {
  stopChildren();
  line();
  line('  THE PRODUCT WAS NOT SERVED WITH WALLETS.');
  line();
  line(`  ${String(e?.message ?? e)}`);
  line();
  process.exit(1);
});
