/**
 * CREATE A COMPANY ON THE CHAIN, THROUGH THE PRODUCT.
 *
 * -- WHAT MAKES THIS DIFFERENT FROM THE DEPLOY SCRIPT BESIDE IT -------------
 *
 * The deploy script builds a ledger itself and calls it. **This one builds
 * nothing.** It assembles the capability a deployment holds, hands it to the
 * product's own wiring, and then calls the same service a person's browser
 * calls when they fill in the form. Every rule between those two points -
 * which contract an account is read at, who takes the first seat, what a leaf
 * is, which boundary stamps the record, what refuses and what does not - is the
 * product's own, unmodified, and exercised for the first time against a chain.
 *
 * **A SCRIPT THAT REIMPLEMENTED THE PATH WOULD PROVE THAT THE SCRIPT WORKS**,
 * which is the one thing nobody needs to know.
 *
 * -- WHAT IT SPENDS ---------------------------------------------------------
 *
 * One network fee, paid by the wallet whose seed is on this machine. The
 * company's own wallet holds nothing and pays nothing: it signs the parts of
 * the transaction the company owns, and the fee payer is deliberately not
 * allowed to touch those.
 *
 * -- WHAT IT REFUSES BEFORE IT SPENDS ANYTHING ------------------------------
 *
 * Everything that is knowable up front. The rules are next door in their own
 * file so they can be watched refusing without a wallet, a chain or a fee.
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { StaticProofServerContainer } from '@midnight-ntwrk/testkit-js';

import { FileStore } from '../src/core/store-file.js';
import { AccountService } from '../src/core/account.js';
import { ContractBook } from '../src/wiring/account-contract.js';
import { startProduct } from '../src/wiring/product.js';
import { deploymentWriteCapability } from '../src/wiring/write-capability-for-deployment.js';
import { WalletFeeSponsor } from '../src/midnight/sponsor.js';
import { fileFeeSink } from '../src/midnight/sponsored-fees.js';
import { applyNetworkId, networkFromEnv, ENDPOINTS } from '../src/midnight/network.js';
import { bringUpWallet } from './wallet-bringup.js';
import { customerWalletOver, paidFeeFrom, sponsorWalletOver } from './funded-wallets.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';
import {
  CREATED, NOT_CREATED, PARTLY_CREATED, refuseIncompleteSetup, refuseUnprovenCompany,
  refuseUnseatableCompany, type CreatePreconditions,
} from './create-company-rules.js';

const ROOT = join(import.meta.dirname, '..');
const STATE_DIR = join(ROOT, '.midnight');
const NETWORK = networkFromEnv(process.env.MIDNIGHT_NETWORK_ID, 'stagenet');
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT ?? 6301);
const SPONSOR_SEED_FILE = join(STATE_DIR, 'wallet.seed');
const COMPANY_SEED_FILE = join(STATE_DIR, `${NETWORK}-company.seed`);
const ARTIFACTS = join(ROOT, 'contracts', 'managed');
const FEE_RECORD = join(STATE_DIR, 'sponsored-fees.jsonl');
/*
 * The company's own data file, kept apart from a development one on purpose. A
 * door that wrote into whatever the last `npm run dev` left behind would make
 * the one record that matters indistinguishable from a rehearsal.
 */
const DATA = process.env.DATA_PATH ?? join(STATE_DIR, 'created-companies.json');

const COMPANY_NAME = process.env.COMPANY_NAME ?? 'The First Company';

/**
 * Who the company starts with, and the bar it starts at.
 *
 * **ONE PLACE, BECAUSE THE GUARD ABOVE AND THE CREATE BELOW MUST BE ASKING
 * ABOUT THE SAME THING.** Two copies of *one signer at threshold one* is a
 * guard that passes while the create does something else.
 */
const FOUNDING_SIGNERS = [
  { name: 'Founder', role: 'admin' as const, userId: null },
];
const THRESHOLD = 1;

/**
 * The company this run created, once it has, so a failure after that point
 * cannot report that nothing happened.
 *
 * **A MODULE-SCOPE VALUE AND NOT A LOCAL ONE**, because the only place the two
 * outcomes are told apart is the failure handler, which is outside the function
 * that would hold it.
 */
let spent: string | null = null;

const line = (s = '') => console.log(s);
const step = (n: number, of: number, what: string) => line(`\n  [${n}/${of}] ${what}`);
const good = (s: string) => line(`      ${s}`);

/** Reaches the proof server and says whether it answered. Nothing is proved. */
async function proofServerAnswers(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(4000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  line('  ------------------------------------------------------------');
  line(`  Creating a company on ${NETWORK}, through the product`);
  line('  ------------------------------------------------------------');

  /* ---------------------------------------------------------------- 1 */
  step(1, 6, 'Checking what this machine has, before anything is spent');

  const present: CreatePreconditions = {
    fundedSeed: existsSync(SPONSOR_SEED_FILE),
    companySeed: existsSync(COMPANY_SEED_FILE),
    maintenanceAuthority: existsSync(join(STATE_DIR, 'maintenance-authority.json')),
    compiledContract: existsSync(join(ARTIFACTS, 'keys')),
    proofServer: await proofServerAnswers(PROVER_PORT),
  };
  const incomplete = refuseIncompleteSetup(present);
  if (incomplete) throw new Error(incomplete);
  good('the authority is recorded, the contract is compiled, the prover answers,');
  good('and both wallets have a seed on this machine');

  /*
   * **THE GUARD READS THE VALUES THE PRODUCT IS ACTUALLY GIVEN, FROM THE SAME
   * TWO CONSTANTS, AND THAT IS THE WHOLE OF ITS WORTH.** A first draft called
   * it with the literals `1` and `1` while the create below carried its own
   * copy of both: three dead branches and a reassurance about nothing, which is
   * exactly the shape of a check nobody notices has stopped checking.
   *
   * What it refuses is a contract that seats one signer while our record says
   * three - a company whose chain and whose record disagree about who may
   * approve, reported as a success.
   */
  const unseatable = refuseUnseatableCompany(FOUNDING_SIGNERS.length, THRESHOLD);
  if (unseatable) throw new Error(unseatable);

  /* ---------------------------------------------------------------- 2 */
  step(2, 6, 'Bringing up the two wallets');

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
  good('the company\'s own wallet is up, and it holds nothing, which is the point');

  /* ---------------------------------------------------------------- 3 */
  step(3, 6, 'Assembling what a deployment holds before it can write');

  const { indexerPublicDataProvider } = await import(
    '@midnight-ntwrk/midnight-js-indexer-public-data-provider');
  const E = ENDPOINTS[NETWORK]!;
  const publicData = indexerPublicDataProvider(E.indexerUrl, E.indexerWsUrl);

  mkdirSync(STATE_DIR, { recursive: true });
  const sponsor = new WalletFeeSponsor(
    sponsorWalletOver(
      {
        provider: payerLive.wallet,
        facade: payerLive.wallet.wallet,
        dust: () => payerLive.dust(),
        night: () => payerLive.night(),
      },
      paidFeeFrom(publicData),
    ),
    ({ fee, remaining }) => good(
      `paid ${fee ?? 'an amount that was not read back'}; `
      + `${remaining} DUST reported after (it lags, and is not a capacity reading)`),
    fileFeeSink(FEE_RECORD, (p, l) => appendFileSync(p, l)),
  );
  const customer = customerWalletOver({
    provider: companyLive.wallet,
    facade: companyLive.wallet.wallet,
    dust: () => companyLive.dust(),
    night: () => companyLive.night(),
  });

  const store = new FileStore(DATA);
  const book = new ContractBook(
    (id) => {
      const a = store.getAccount(id);
      if (!a) return null;
      return {
        address: a.contractAddress ?? null,
        source: a.addressSource ?? null,
        wiring: a.wiring ?? null,
      };
    },
    'chain',
  );

  const capability = await deploymentWriteCapability(ROOT, process.env, { customer, sponsor });
  if (!capability) {
    throw new Error(
      'the two wallets are up and no capability came back, which cannot happen unless the '
      + 'supplier stopped assembling one from a pair it was handed. Nothing was spent.');
  }
  good('all five pieces are in hand: the recorded authority, the compiled contract,');
  good('the company\'s wallet, the wallet that pays, and the private state key');

  /* ---------------------------------------------------------------- 4 */
  step(4, 6, 'Starting the product with them');

  const startup = startProduct(book, ROOT, process.env, capability);
  if (startup.started !== true) throw new Error(startup.refusal);
  const ledger = startup.wiring.createLedger();
  good(ledger.describe());

  /* ---------------------------------------------------------------- 5 */
  step(5, 6, 'Creating the company through the product\'s own service');
  line('      this is a deploy: it proves, it submits, and it spends a fee.');

  const accounts = new AccountService(store, ledger, startup.wiring.commitments);
  const began = Date.now();
  const created = await accounts.create(COMPANY_NAME, FOUNDING_SIGNERS, THRESHOLD);
  good(`created in ${((Date.now() - began) / 1000).toFixed(1)}s`);

  /* ---------------------------------------------------------------- 6 */
  step(6, 6, 'Reading it back out of the product');

  /*
   * **FROM HERE A COMPANY EXISTS ON THE CHAIN AND A FEE HAS BEEN SPENT**, so
   * nothing below may report that nothing happened.
   */
  spent = created.account.id;

  const record = store.getAccount(created.account.id);
  const unproven = refuseUnprovenCompany({
    accountId: created.account.id,
    recordedAddress: record?.contractAddress ?? null,
    addressSource: record?.addressSource ?? null,
    wiring: record?.wiring ?? null,
  });
  if (unproven) throw new Error(unproven);

  good(`company     ${created.account.id}  "${created.account.name}"`);
  good(`contract    ${record!.contractAddress}`);
  good(`recorded by ${record!.wiring}, from ${record!.addressSource}`);
  good(`signers     ${created.account.signers.length} at threshold ${created.account.policy.threshold}`);
  line();
  line(`  ${CREATED}`);
  line();
  line(`  what it cost, and who it was for:  ${FEE_RECORD}`);
  line(`  the company's record:              ${DATA}`);
  line();
  line('  KEEP BOTH FILES. The contract address exists nowhere else, and the');
  line('  founder\'s signing material is in the record and is not recoverable.');

  /*
   * **THE TIDYING UP IS OUTSIDE THE PART THAT CAN REPORT A FAILURE.** A wallet
   * that will not shut down cleanly, after a company has been created and paid
   * for, is not a company that was not created - and a run that printed both
   * sentences would be telling a person to do the one thing this door says not
   * to do twice.
   */
  try {
    payerLive.stop();
    companyLive.stop();
    await env.shutdown(false);
  } catch { /* the company exists; how this process ends is not about that */ }
}

main().then(
  () => process.exit(0),
  (e: any) => {
    line();
    /*
     * **WHICH OF THE TWO SENTENCES IS TRUE DEPENDS ON WHETHER THE CREATE GOT AS
     * FAR AS THE CHAIN, AND SAYING THE WRONG ONE COSTS A SECOND FEE.** A person
     * told *nothing above this line succeeded* runs it again, which is the one
     * thing this door warns about - and a company that WAS created is on the
     * chain whether or not the reading back of it worked.
     */
    if (spent) {
      line(`  ${PARTLY_CREATED}`);
      line();
      line(`  the company is "${spent}", and it is in ${DATA}.`);
      line('  DO NOT RUN THIS AGAIN until somebody has looked at that record:');
      line('  another run creates another company and spends another fee.');
    } else {
      line(`  ${NOT_CREATED}`);
    }
    line();
    line(`  ${String(e?.message ?? e)}`);
    line();
    process.exit(1);
  },
);
