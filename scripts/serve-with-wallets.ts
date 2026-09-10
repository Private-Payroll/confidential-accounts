/**
 * SERVE THE PRODUCT ON STAGENET, ABLE TO WRITE, SO A COMPANY CAN BE CREATED
 * FROM THE SCREEN.
 *
 * -- WHAT IT DOES -----------------------------------------------------------
 *
 * It brings up the wallet that pays and the company wallet, turns them into
 * the pair the product is handed, hands that pair over, and only then starts
 * the server - the same server `npm run dev` starts, unmodified. Then it starts
 * the page and the wallet beside it. A person signs in with their wallet,
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
 * **ONE FEE PAYER, NOTHING METERED, NOTHING CAPPED** beyond what the vendor's
 * own balancing does. Every payment is recorded with its company, its estimate
 * and what the chain says it cost - best effort: a record that cannot be written
 * never turns a payment that landed into a failure, so a full disk loses rows.
 *
 * -- WHAT IT SPENDS ----------------------------------------------------------
 *
 * Nothing by starting. At least one network fee each time somebody creates a
 * company or otherwise writes from the screen while it runs - more when the
 * product retries a deploy that had in fact landed.
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

import { StaticProofServerContainer } from '@midnight-ntwrk/testkit-js';

import { fileFeeSink } from '../src/midnight/sponsored-fees.js';
import { applyNetworkId, networkFromEnv, ENDPOINTS, type NetworkName } from '../src/midnight/network.js';
import { handInFundedParties } from '../src/wiring/handed-in-wallets.js';
import { bringUpWallet } from './wallet-bringup.js';
import { fundedPartiesOver, paidFeeFrom } from './funded-wallets.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';
import { POSTURE_NOT_CARRIED, postureFrom, refuseToServe } from './serve-with-wallets-rules.js';

const ROOT = join(import.meta.dirname, '..');
const STATE_DIR = join(ROOT, '.midnight');
const NETWORK_RAW = process.env.MIDNIGHT_NETWORK_ID ?? 'stagenet';
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT ?? 6301);
const SPONSOR_SEED_FILE = join(STATE_DIR, 'wallet.seed');
const COMPANY_SEED_FILE = join(STATE_DIR, `${NETWORK_RAW}-company.seed`);
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

const children: ChildProcess[] = [];
const stopChildren = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } } };
process.on('exit', stopChildren);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => { stopChildren(); process.exit(130); });
}

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
  line(`  Serving the product on ${NETWORK_RAW}, able to create a company`);
  line('  ------------------------------------------------------------');

  /* ---------------------------------------------------------------- 1 */
  step(1, 5, 'Checking what this machine has, before any wallet is brought up');

  const devScript = String(
    (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {}).dev ?? '');
  const posture = postureFrom(devScript);
  const refusal = refuseToServe({
    network: NETWORK_RAW,
    posture,
    present: {
      fundedSeed: existsSync(SPONSOR_SEED_FILE),
      companySeed: existsSync(COMPANY_SEED_FILE),
      maintenanceAuthority: existsSync(join(STATE_DIR, 'maintenance-authority.json')),
      compiledContract: existsSync(join(ARTIFACTS, 'keys')),
      proofServer: await proofServerAnswers(PROVER_PORT),
    },
  });
  if (refusal) throw new Error(refusal);
  const NETWORK: NetworkName = networkFromEnv(NETWORK_RAW, 'stagenet');
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
  ));
  good(`every fee paid is recorded in ${FEE_RECORD}`);

  /* ---------------------------------------------------------------- 4 */
  step(4, 5, 'Starting the server');

  for (const [k, v] of Object.entries(posture)) process.env[k] = v;
  /* Left behind even when this shell inherited it, not only when the script declares it. */
  for (const n of POSTURE_NOT_CARRIED) delete process.env[n];
  process.env.DATA_PATH = DATA;
  good(`companies are recorded in ${DATA}`);
  /*
   * **IMPORTED FOR WHAT EVALUATING IT DOES, AND NOTHING IS TAKEN FROM IT.** The
   * server builds its ledger and starts listening while it is being evaluated,
   * which is why the pair was handed over above this line and not below it.
   * Named by file so the scripts' typecheck, which is looser than the server's
   * own, does not re-check the server under settings it was not written for.
   */
  await import(pathToFileURL(join(ROOT, 'src', 'server', 'index.ts')).href);

  /*
   * **THE SERVER IS ASKED WHAT IT CAN DO, AND ITS OWN WORDS DECIDE.** A server
   * that came up read-only would render every screen and fail at the button,
   * in front of whoever pressed it.
   */
  const port = Number(process.env.PORT ?? 8787);
  let said = '';
  for (let i = 0; i < 30 && !said; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      said = String((await r.json())?.ledger ?? '');
    } catch { /* not listening yet */ }
  }
  if (!said.includes('reading and writing')) {
    throw new Error(
      `the server did not say it can write. It said: "${said || 'nothing, on port ' + port}". `
      + 'No company can be created from the screen in this state. Nothing has been spent.');
  }
  good(`the server says: ${said}`);

  /* ---------------------------------------------------------------- 5 */
  step(5, 5, 'Starting the page and the wallet');

  const withPosture = { ...process.env, ...posture };
  /*
   * **ON THIS MACHINE'S OWN LOOPBACK ONLY.** A page whose server can spend is
   * not offered to the rest of the network it happens to be on.
   */
  children.push(spawn(join(ROOT, 'node_modules', '.bin', 'vite'), ['--host', 'localhost'], {
    cwd: ROOT, env: withPosture, stdio: 'inherit',
  }));
  children.push(spawn('npm', ['run', 'wallet', '--', '--host', 'localhost'], {
    cwd: ROOT, env: withPosture, stdio: 'inherit',
  }));
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
