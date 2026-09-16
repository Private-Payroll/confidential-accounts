/**
 * SERVE THE FEE PAYER: OUR ONE CONFIGURED WALLET, PAYING THE PRODUCT'S FEES,
 * IN A PROCESS OF ITS OWN.
 *
 * -- WHAT IT DOES -----------------------------------------------------------
 *
 * It brings up the wallet that pays, and serves the three calls the web
 * process's fee payer client makes - add a capped fee, submit what was built,
 * let it go - on this machine's loopback, behind a shared secret. The web
 * process is pointed at it by its own two settings and holds no key.
 *
 * -- WHAT IT IS NOT --------------------------------------------------------
 *
 * **IT IS NOT A WALLET FOR COMPANIES.** It balances DUST and nothing else, and
 * it never holds, builds or signs a company's own part of a transaction.
 *
 * **IT IS NOT UNCAPPED.** It does not start without a ceiling on what one
 * transaction may spend, and every payment goes through a fee payer carrying it.
 *
 * -- SWAPPING THE WALLET THAT PAYS -----------------------------------------
 *
 * Stop this, point the seed setting at another wallet's seed, start this. The
 * web process needs no change: it names this service, not a wallet.
 *
 * -- WHAT IT SPENDS ----------------------------------------------------------
 *
 * Nothing by starting. One capped network fee each time the product writes.
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { StaticProofServerContainer } from '@midnight-ntwrk/testkit-js';

import { fileFeeSink } from '../src/midnight/sponsored-fees.js';
import { applyNetworkId, theNetwork, ENDPOINTS, type NetworkName } from '../src/midnight/network.js';
import { feePayerApp } from '../src/fee-payer/service.js';
import { finalisedTransactionCodec, FEE_PAYER_URL_SETTING } from '../src/fee-payer/client.js';
import { bringUpWallet } from './wallet-bringup.js';
import { feePayerOver, paidFeeFrom, type LiveWalletParts } from './funded-wallets.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';
import { feePayerSetupFrom, FEE_PAYER_HOST } from './serve-fee-payer-rules.js';

const ROOT = join(import.meta.dirname, '..');
const STATE_DIR = join(ROOT, '.midnight');
const NETWORK: NetworkName = theNetwork();
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT ?? 6301);
const FEE_RECORD = join(STATE_DIR, 'sponsored-fees.jsonl');

const line = (s = '') => console.log(s);
const step = (n: number, of: number, what: string) => line(`\n  [${n}/${of}] ${what}`);
const good = (s: string) => line(`      ${s}`);

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
  line(`  Serving the fee payer on ${NETWORK}`);
  line('  ------------------------------------------------------------');

  /* ---------------------------------------------------------------- 1 */
  step(1, 3, 'Checking the settings, before any wallet is brought up');

  const setup = feePayerSetupFrom(process.env, ROOT, existsSync);
  if ('refusals' in setup) {
    throw new Error(
      'the fee payer cannot be served from this machine:\n\n  '
      + setup.refusals.join(';\n\n  ') + '.\n\nNothing has been brought up and nothing has been spent.');
  }
  if (!(await proofServerAnswers(PROVER_PORT))) {
    throw new Error(
      `no proof server answers on port ${PROVER_PORT}, and the fee payer proves the fee it adds. `
      + 'Start one, then start this again. Nothing has been brought up.');
  }
  good(`no transaction may spend more than ${setup.ceiling.perTransaction} SPECKs of DUST`);

  /* ---------------------------------------------------------------- 2 */
  step(2, 3, 'Bringing up the wallet that pays (a sync, then DUST)');

  await applyNetworkId(NETWORK);
  const logger: any = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
    fatal: () => {}, silent: () => {}, level: 'silent',
    child() { return this; },
  };
  const { env, how } = testEnvironmentFor(NETWORK, logger);
  good(how);
  const cfg = await startEnvironment(env, new StaticProofServerContainer(PROVER_PORT), (s) => good(s));
  const payerLive = await bringUpWallet(
    logger, cfg, readFileSync(setup.seedFile, 'utf8').trim(), NETWORK, ROOT,
    { withDust: true, requireDust: true, onNote: (m) => good(m) });
  good(`the wallet that pays holds ${payerLive.night()} NIGHT and ${payerLive.dust()} DUST`);

  /* ---------------------------------------------------------------- 3 */
  step(3, 3, 'Serving');

  const { indexerPublicDataProvider } = await import(
    '@midnight-ntwrk/midnight-js-indexer-public-data-provider');
  const E = ENDPOINTS[NETWORK]!;
  const publicData = indexerPublicDataProvider(E.indexerUrl, E.indexerWsUrl);
  mkdirSync(STATE_DIR, { recursive: true });
  const feeRecord = fileFeeSink(FEE_RECORD, (p, l) => appendFileSync(p, l));

  const parts: LiveWalletParts = {
    provider: payerLive.wallet, facade: payerLive.wallet.wallet,
    dust: () => payerLive.dust(), night: () => payerLive.night(),
  };
  const app = feePayerApp({
    newPayer: () => feePayerOver(
      parts,
      paidFeeFrom(publicData),
      feeRecord,
      ({ fee, remaining }) => good(
        `paid ${fee ?? 'an amount that was not read back'}; `
        + `${remaining} DUST reported after (it lags, and is not a capacity reading)`),
      setup.ceiling,
    ),
    codec: finalisedTransactionCodec(),
    secret: setup.secret,
    capacity: async () => ({ dust: payerLive.dust(), night: payerLive.night() }),
  });

  await new Promise<void>((resolve) => {
    app.listen(setup.port, FEE_PAYER_HOST, () => resolve());
  });
  good(`every fee paid is recorded in ${FEE_RECORD}`);
  line();
  line(`  READY. The web process pays through this when its settings say:`);
  line(`    ${FEE_PAYER_URL_SETTING}=http://${FEE_PAYER_HOST}:${setup.port}/`);
  line('  and it is given the same secret. Closing this window stops the fee payer.');
  line();
}

main().catch((e: any) => {
  line();
  line('  THE FEE PAYER WAS NOT SERVED.');
  line();
  line(`  ${String(e?.message ?? e)}`);
  line();
  process.exit(1);
});
