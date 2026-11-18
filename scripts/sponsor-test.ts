/**
 * Does fee sponsorship work, end to end, against a live network?
 *
 * The product's design says the customer never holds a token: they balance the shielded and
 * unshielded legs of their own transaction and sign it, and a sponsor balances
 * only the dust leg and submits. If that is true, a finance team signs up with
 * an email address. If it is not, every customer has to acquire and hold NIGHT
 * before they can approve a payment, and the product is a different product.
 *
 * THE TEST IS THE POINT: the customer wallet is a FRESH SEED THAT HAS NEVER
 * BEEN FUNDED. No NIGHT, no DUST, not registered for DUST generation. If the
 * transaction settles, sponsorship works. If it fails for want of fees, it does
 * not, and no amount of reading the SDK would have told us.
 *
 * Note what stays the same: the signer identity. Wallet identity (who pays) and
 * signer identity (who is in the Merkle tree) are separate things — the wallet
 * is a funding source, the `localSecretKey` witness is the authority. So this
 * runs as signer A, with a wallet that owns nothing, which is exactly the
 * shape of a real customer device.
 */
import { shownAddress } from '../src/core/networks.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import { StaticProofServerContainer } from '@midnight-ntwrk/testkit-js';
import { bringUpWallet } from './wallet-bringup.js';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { midnightProviders } from '../src/midnight/providers.js';
import { contractStateAt } from '../src/midnight/contract-state-at.js';

import { Contract, ledger as readLedger, pureCircuits } from '../contracts/managed/contract/index.js';
import { witnesses, type AccountPrivateState } from '../contracts/src/witnesses.js';
import { theNetwork, ENDPOINTS } from '../src/midnight/network.js';
import { privateStateKey } from '../src/midnight/ledger.js';
import { isDeployedCircuit } from '../src/midnight/deferral.js';
import { assetIdBytes } from '../src/core/assets.js';
import { WalletFeeSponsor, CUSTOMER_BALANCES, SPONSOR_BALANCES } from '../src/midnight/sponsor.js';
import { feeCeilingFrom } from '../src/midnight/fee-ceiling.js';
import { customerWalletOver, sponsorWalletOver } from './funded-wallets.js';
import { testEnvironmentFor } from './test-environment.js';
import { explainNodeError } from './node-errors.js';
import { sleep } from '../src/midnight/retry.js';
import {
  previewSignersFile, readOrCreatePreviewSigners, signerBytes,
} from './preview-signers.js';
import { deploymentRecordPath, storeDir } from '../src/wiring/deployment.js';
import { standDownWhenMissing, thisRun, whatIsMissing } from './end-to-end-waits.js';
import type { NetworkName } from '../src/midnight/network.js';

/* Without the network named and the sponsor's funded seed on this machine, nothing below runs. */
standDownWhenMissing('The sponsored-fee check', whatIsMissing(thisRun(), {
  fundedSeedFor: (n) => join(storeDir(process.cwd(), n as NetworkName), 'wallet.seed'),
}, process.cwd()));

const BOLD = '\x1b[1m', DIM = '\x1b[2m', RED = '\x1b[31m', GREEN = '\x1b[32m', YEL = '\x1b[33m', OFF = '\x1b[0m';
const good = (m: string) => console.log(`  ${GREEN}✓${OFF} ${m}`);
const note = (m: string) => console.log(`  ${DIM}${m}${OFF}`);
const warn = (m: string) => console.log(`  ${YEL}!${OFF} ${m}`);
const begin = (n: number, of: number, t: string) => console.log(`\n${BOLD}${n} of ${of}  ${t}${OFF}`);

const ROOT = process.cwd();
const NETWORK = theNetwork();
const STATE_DIR = storeDir(ROOT, NETWORK);
const SPONSOR_SEED_FILE = join(STATE_DIR, 'wallet.seed');
const CUSTOMER_SEED_FILE = join(STATE_DIR, `${NETWORK}-customer.seed`);
const CONTRACT_FILE = deploymentRecordPath(ROOT, NETWORK);
const VIEW_FILE = join(STATE_DIR, `${NETWORK}-view.json`);
const ARTIFACTS = join(ROOT, 'contracts', 'managed');
const PRIVATE_STATE_ID = `confidential-accounts-${NETWORK}`;
const ACCOUNT_ID = 'default';
/**
 * The circuit the sponsored call drives: the contract's one read-only circuit,
 * `attestSolvency`, WHICH THE CONTRACT NO LONGER CARRIES. It stays named here so
 * the guard below refuses by name rather than this check quietly acquiring a
 * substitute nobody chose; every circuit the contract still carries writes state.
 */
const SPONSORED_CIRCUIT = 'attestSolvency';
const PRIVATE_STATE_PASSWORD =
  process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD || 'ConfidentialAccounts-Dev-2026';
const PRIVATE_STATE_KEY = privateStateKey(PRIVATE_STATE_ID, ACCOUNT_ID);

/**
 * **SIGNER A AND B ARE READ FROM THE NETWORK'S STORE FOLDER, NOT COMPUTED.**
 *
 * The deploy that seated them wrote real entropy into a per-account file in the
 * network's store folder, kept off the repository, and this reads it, so the
 * check reconstructs exactly the devices the deploy seated and nothing in the
 * repository names either of them.
 *
 * A REFUSAL RATHER THAN A FRESH SET: `readOrCreatePreviewSigners` would make
 * one, and a fresh set is a device that is not on the account this check is
 * about to read. The refusal names the file and what writes it.
 */
const previewSignersPath = previewSignersFile(STATE_DIR, NETWORK, ACCOUNT_ID);
if (!existsSync(previewSignersPath)) {
  throw new Error(
    `there is no demo signer material for "${ACCOUNT_ID}" on ${NETWORK}: ` +
      `${previewSignersPath.replace(ROOT + '/', '')} does not exist.\n` +
      'Deploy an account from this machine on this network, which writes it, then run this again.',
  );
}
const PREVIEW_SIGNERS = readOrCreatePreviewSigners(STATE_DIR, NETWORK, ACCOUNT_ID).signers;


const seededBytes = (seed: number): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i * 7) % 256;
  return out;
};
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/**
 * A customer wallet that has never been funded.
 *
 * Generated once and kept, so a failed run can be diagnosed against the same
 * address rather than a new one each time. It is deliberately NOT the sponsor's
 * seed and must never be funded — the whole claim is that it does not need to
 * be, and funding it would make this test prove nothing.
 */
function customerSeed(): string {
  mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(CUSTOMER_SEED_FILE)) {
    writeFileSync(CUSTOMER_SEED_FILE, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return readFileSync(CUSTOMER_SEED_FILE, 'utf8').trim();
}

async function main() {
  /* Read before any wallet syncs: this rig spends a real fee, and nothing pays one uncapped. */
  const ceiling = feeCeilingFrom(process.env);
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  ${BOLD}Fee sponsorship on ${NETWORK}${OFF}`);
  console.log('  A wallet with nothing in it calls a circuit. Someone else pays.');
  console.log('────────────────────────────────────────────────────────────');

  /*
   * BEFORE any wallet syncs or money moves, AND THE TEST IS NOW "IS IT
   * DEPLOYED", NOT "IS IT DEFERRED".
   *
   * `attestSolvency`, the circuit this check calls, was chosen because it was
   * the contract's only read-only circuit, and the contract no longer carries
   * it. Asking whether it is deferred would answer NO for a circuit that does
   * not exist, and this check would go on to prove and PAY for a call the chain
   * refuses as VerifierKeyNotPresent. The guard is membership of the
   * deployment, which is true of neither a deferred circuit nor a removed one.
   *
   * There is no drop-in replacement: every other circuit writes state. Running
   * this check again needs a deliberate choice of a state-changing circuit (and
   * of the account it may change), not a substitution made in passing.
   */
  if (!isDeployedCircuit(SPONSORED_CIRCUIT)) {
    console.log();
    console.log(`  ${RED}${BOLD}REFUSED before anything ran or was spent.${OFF}`);
    console.log(`  This script's sponsored call is ${BOLD}${SPONSORED_CIRCUIT}${OFF}, and the current`);
    console.log('  deployment does not carry that circuit (src/midnight/deferral.ts). The');
    console.log('  contract no longer has it, so the call would prove and pay, then be refused');
    console.log('  by the chain as VerifierKeyNotPresent. This check waits for a circuit to be');
    console.log('  chosen for it, deliberately: every circuit the contract carries writes state.');
    process.exitCode = 1;
    return;
  }

  if (!existsSync(CONTRACT_FILE)) {
    throw new Error(`no deployed contract for ${NETWORK}: deploy an account from this machine on ${NETWORK} first.`);
  }
  const contractAddress = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8')).contractAddress as string;

  const E = ENDPOINTS[NETWORK]!;
  const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT ?? 6301);
  const proofServer = `http://localhost:${PROVER_PORT}`;

  const logger: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => logger };
  const { env, how } = testEnvironmentFor(NETWORK, logger);
  note(how);

  /*
   * The config comes from the test environment, not from a literal.
   *
   * The first version of this script built `{ indexer, indexerWS, node,
   * proofServer }` by hand and the wallet builder said "Invalid URL" after
   * logging `Initializing wallet builder for undefined` — it wants a different
   * shape entirely. `env.start` produces the one that works, and run-preview.ts
   * has been using it successfully all along. Guessing a shape that a working
   * script already had is the same mistake as writing a rule twice.
   */
  const cfg = await env.start(new StaticProofServerContainer(PROVER_PORT));
  note(`node ${shownAddress(cfg.node)}`);

  /* -------------------------------------------------- 1 */
  begin(1, 5, 'Two wallets: one funded, one deliberately empty');

  const sponsorSeed = readFileSync(SPONSOR_SEED_FILE, 'utf8').trim();
  const custSeed = customerSeed();
  if (custSeed === sponsorSeed) {
    throw new Error('the customer seed is the sponsor seed; this test would prove nothing');
  }

  /*
   * Both wallets come up through `bringUpWallet`.
   *
   * This block used to be hand-written and was wrong four separate times, most
   * fatally by never calling `wallet.start(false)` — so the wallets were built,
   * never began syncing, reported NIGHT 0 forever, and had their dust proofs
   * rejected as 170. Every one of those steps was already correct in
   * run-preview.ts. There is one copy now.
   */
  const sponsorLive = await bringUpWallet(logger, cfg, sponsorSeed, NETWORK, ROOT, {
    withDust: true,
    onNote: note,
  });
  const sponsorWallet = sponsorLive.wallet;

  /*
   * The customer gets NO dust wallet installed, deliberately. It has no funds
   * and no DUST registration, and installing one would only add a sync it does
   * not need — the whole claim is that this wallet never pays for anything.
   */
  const customerLive = await bringUpWallet(logger, cfg, custSeed, NETWORK, ROOT, {
    withDust: false,
    onNote: note,
  });
  const customerWallet = customerLive.wallet;

  const sponsorFunds = { night: sponsorLive.night(), dust: sponsorLive.dust() };
  const customerFunds = { night: customerLive.night(), dust: customerLive.dust() };

  good(`sponsor  NIGHT ${sponsorFunds.night}  DUST ${sponsorFunds.dust}  ${sponsorLive.synced() ? 'synced' : 'still syncing'}`);
  good(`customer NIGHT ${customerFunds.night}  DUST ${customerFunds.dust}`);

  if (sponsorFunds.dust === 0n) {
    throw new Error(
      'the sponsor has no DUST, so it cannot pay for anything. Either the wallet needs ' +
        'funding and DUST registration, or it never finished syncing — both produce ' +
        'node rejection 170 at submission.',
    );
  }

  if (customerFunds.dust > 0n) {
    throw new Error(
      `the customer wallet holds ${customerFunds.dust} DUST, so this test cannot tell ` +
        'sponsorship from self-payment. Delete ' +
        CUSTOMER_SEED_FILE.replace(ROOT + '/', '') + ' and run again with a fresh, unfunded seed.',
    );
  }
  good('the customer holds no DUST — anything that settles was paid for by the sponsor');

  /* -------------------------------------------------- 2 */
  begin(2, 5, 'Wiring the customer to balance its own legs, and nobody else\'s');

  // Built the same way run-preview.ts builds it, because a second construction
  // of the same object is a place for the two to disagree.
  const compiled = CompiledContract.make('ConfidentialAccount', Contract as any).pipe(
    CompiledContract.withWitnesses(witnesses as any),
    CompiledContract.withCompiledFileAssets(ARTIFACTS as never),
  ) as any;

  /*
   * Bound straight off the facade rather than re-wrapped in hand-written
   * lambdas.
   *
   * The first version wrote `(tx: any, keys: any, options: any) => ...` around
   * each call, which threw away types the SDK actually publishes —
   * `WalletFacade`, `ZswapSecretKeys`, `DustSecretKey` are all real. Three of
   * the bugs in this script's first run were shapes I guessed while `any` kept
   * the compiler quiet: the wallet config, how state arrives, and how the two
   * balances are read. Every one of them was already written correctly in
   * run-preview.ts and typed in node_modules.
   */
  const facade = sponsorWallet.wallet;
  /*
   * **THE ADAPTER IS SHARED WITH THE DOOR THAT CREATES A COMPANY, AND THAT IS
   * THE POINT OF THE MOVE.** These twelve lines were written here first and
   * were about to be written a second time next door. Every member of the seam
   * is bound in one place now, so a member that is added to it - the fee
   * estimate and the charged fee are the two most recent - cannot arrive in one
   * copy and be forgotten in the other.
   *
   * **THE CHARGED FEE IS NOT READ ON THIS PATH.** Reading it needs the public
   * data provider, which this script builds AFTER the fee payer, and this
   * script's subject is whether the two-phase flow settles rather than what it
   * cost. `null` is the honest answer for a reading nobody took.
   */
  const sponsor = new WalletFeeSponsor(
    sponsorWalletOver(
      {
        provider: sponsorWallet,
        facade,
        dust: () => sponsorLive.dust(),
        night: () => sponsorLive.night(),
      },
      async () => null,
    ),
    ceiling,
    /*
     * Read immediately after submitting, so it lags: the first run printed
     * "remaining: 0" while the sponsor held 4.1e17, because the wallet had not
     * yet reconciled the spend. Labelled rather than "fixed" by sleeping —
     * an operator alarming on a number needs to know it is a snapshot, and a
     * capacity check belongs on its own schedule, not on the pay path.
     */
    ({ remaining }) => note(`sponsor DUST immediately after submitting: ${remaining} (lags; not a capacity reading)`),
  );

  let customerBalanced = false;
  let sponsorPaid = false;

  /*
   * The product's own provider set, as the service builds it: the customer's wallet balances the shielded and
   * unshielded legs only and signs, and the fee payer adds the DUST, pays the fee and submits. Nothing here
   * balances by hand, so the two parties' token kinds are the product's constants and cannot overlap.
   */
  const product = await midnightProviders({
    config: {
      indexerUrl: E.indexerUrl,
      indexerWsUrl: E.indexerWsUrl,
      proverUrl: proofServer,
      nodeUrl: E.nodeUrl,
      zkConfigPath: ARTIFACTS,
      networkId: NETWORK,
      privateStateId: PRIVATE_STATE_ID,
    },
    customer: customerWalletOver({
      provider: customerWallet,
      facade: customerWallet.wallet,
      dust: () => customerLive.dust(),
      night: () => customerLive.night(),
    }),
    sponsor,
    artifactsPath: ARTIFACTS,
    privateStateId: PRIVATE_STATE_ID,
    storagePassword: async () => PRIVATE_STATE_PASSWORD,
  });

  /*
   * The same set, with its balance and its submission watched: the run fails unless both happened, so a call
   * that settled some other way is not taken for sponsorship.
   */
  const balancing = product.walletProvider;
  const submitting = product.midnightProvider;
  const providers: MidnightProviders = {
    ...product,
    walletProvider: {
      supportedEras: balancing.supportedEras,
      getCoinPublicKey: () => balancing.getCoinPublicKey(),
      getEncryptionPublicKey: () => balancing.getEncryptionPublicKey(),
      balanceTx: async (tx, ttl) => {
        note(`customer balancing ${CUSTOMER_BALANCES.join(' + ')}, fee payer adding ${SPONSOR_BALANCES.join(' + ')}`);
        const balanced = await balancing.balanceTx(tx, ttl);
        customerBalanced = true;
        good(`customer balanced ${CUSTOMER_BALANCES.join(' + ')} and signed; the fee payer added the fee`);
        return balanced;
      },
    },
    midnightProvider: {
      supportedEras: submitting.supportedEras,
      submitTx: async (tx) => {
        const ref = await submitting.submitTx(tx);
        sponsorPaid = true;
        good(`sponsor submitted: ${ref}`);
        return ref;
      },
    },
  };


  /* -------------------------------------------------- 3 */
  begin(3, 5, 'Acting as signer A, from a wallet that owns nothing');

  const viewRaw = JSON.parse(readFileSync(VIEW_FILE, 'utf8'));
  /*
   * THE VIEW NAMES ITS ASSET, and refusing is better than guessing.
   *
   * A view written before the multi-asset change carries one balance, one salt
   * and an entry digest, and none of those say WHICH ASSET they describe — the
   * account's blinding, which is what derives the asset key, does not appear in
   * it at all. Defaulting to something would produce a key no proposal on this
   * account was approved under, and the failure would be completely misleading
   * about the cause. So it says what is missing instead.
   *
   * `balanceSalt` STOOD IN THIS LIST, and `current`/`next` were built from it
   * just below. Both went with the account's balance ledger: the view file the
   * deploy writes carries no balance and no salt for one, and
   * `AccountPrivateState` has no `current`/`next` pair to put them in.
   *
   * WHAT THE CHECK STILL ENFORCES is the half that is still load-bearing: the
   * view must name its asset and carry the account's asset blinding, because
   * `assetKeyOf(assetId, assetBlinding)` is the first field of the change
   * commitment a proposal is approved under, and every signer has to derive the
   * same one.
   */
  for (const field of ['asset', 'assetBlinding'] as const) {
    if (!viewRaw[field]) {
      throw new Error(
        `${VIEW_FILE.replace(ROOT + '/', '')} has no "${field}", so it predates the ` +
          'multi-asset change and cannot say which asset it describes. ' +
          'Redeploy, or run the proposal script once, to write a current view.',
      );
    }
  }

  const signerA: AccountPrivateState = {
    ...signerBytes(PREVIEW_SIGNERS.A),
    scope: pureCircuits.allVaults(),
    /*
     * The ACCOUNT's blinding, not this signer's, and it comes from the view
     * rather than a seed: every signer has to derive the same asset key from
     * it, or a signer recomputes a different change commitment from the one the
     * proposer committed to and their approval is not an approval of that
     * proposal.
     *
     * IT USED TO KEY AN ON-CHAIN MAP, and the older reason given here was that
     * two derivations would make the account hold its money twice under two
     * names, each unspendable by half the signers. That map went with the
     * account's balance ledger; the requirement did not, because the change
     * commitment still carries the key.
     */
    assetBlinding: Uint8Array.from(Buffer.from(viewRaw.assetBlinding, 'hex')),
    assetId: assetIdBytes(viewRaw.asset),
    proposalSalt: seededBytes(301),
    changeAmount: 0n,
    changeBatchDigest: seededBytes(601),
    pinnedPath: null,
  };
  await providers.privateStateProvider.forContract(contractAddress).set(PRIVATE_STATE_KEY, signerA);

  const served = await contractStateAt(providers.publicDataProvider, contractAddress);
  if (served === null) throw new Error(`the indexer has no state for ${contractAddress}, so there is nothing to call`);
  const before = readLedger(served.data);
  /*
   * `round` and `proposalOpen` USED TO BE PRINTED HERE, and the contract no
   * longer has either field. There is no round, and an account holds however
   * many proposals are open at once.
   *
   * THE ASSET COUNT STOOD BESIDE THEM — `assetBalances.size()` — and went with
   * the account's balance ledger. What is left is the two numbers the
   * chain still carries about where this account stands: how many proposals are
   * collecting approvals, and how many payments have been recorded.
   */
  note(`${before.openProposals.size()} proposal(s) open, ${before.movements.size()} movement(s) recorded`);

  /*
   * The PARTIAL find: the deployment carries a subset of the
   * fifteen compiled circuits, and the SDK's `findDeployedContract` refuses
   * that shape outright (it compares all fifteen keys). This verifies the
   * deployed keys byte-for-byte and checks the deferred circuits are absent.
   * The guard at the top of main() has already established that the circuit
   * this script calls is among the deployed.
   */
  const { findDeployedPartialContract } = await import('../src/midnight/partial-contract.js');
  const found: any = await findDeployedPartialContract(providers, {
    compiledContract: compiled,
    contractAddress,
    privateStateId: PRIVATE_STATE_KEY,
  });
  good('found on chain, the deployed verifier keys match, the deferred circuits are absent');

  /* -------------------------------------------------- 4 */
  begin(4, 5, 'The sponsored call');

  /*
   * `attestSolvency` is the circuit chosen on purpose: it reads state and
   * changes none, so a failure here is about who paid rather than about what
   * the contract did. It still costs a real fee, which is the whole question.
   * (If it is deferred on the current deployment, main() refused above.)
   */
  note(`calling ${SPONSORED_CIRCUIT}(0) — reads state, changes nothing, costs a real fee`);
  const started = Date.now();
  const result: any = await (found.callTx as any)[SPONSORED_CIRCUIT](0n);
  const took = ((Date.now() - started) / 1000).toFixed(1);

  /* -------------------------------------------------- 5 */
  begin(5, 5, 'What that proves');

  const failures: string[] = [];
  if (!customerBalanced) failures.push('the customer never balanced — phase 1 did not run');
  if (!sponsorPaid) failures.push('the sponsor never paid — phase 2 did not run');

  const after = { dust: customerLive.dust(), night: customerLive.night() };
  if (after.dust > 0n) failures.push(`the customer wallet acquired ${after.dust} DUST during the run`);

  console.log();
  if (failures.length) {
    console.log(`  ${RED}${BOLD}Sponsorship did not do what decision 0001 claims.${OFF}`);
    for (const f of failures) console.log(`    ${RED}✗${OFF} ${f}`);
    process.exitCode = 1;
    return;
  }

  sponsorLive.stop();
  customerLive.stop();
  good(`the call settled in ${took}s`);
  good(`result ${JSON.stringify(result?.private?.result ?? result?.result ?? '(no return value)')}`);
  console.log();
  console.log(`  ${GREEN}${BOLD}A wallet holding no NIGHT and no DUST transacted on ${NETWORK}.${OFF}`);
  console.log('  The customer balanced their own legs and signed; the sponsor paid the');
  console.log('  fee and submitted. That is decision 0001, and it is the difference');
  console.log('  between a SaaS signup and a crypto onboarding.');

  /*
   * Shut the environment down, or the process never exits.
   *
   * The first successful run produced every line above and then sat there with
   * the window open, which reads exactly like a hang and is not one: the wallet
   * subscriptions and the node websockets keep Node's event loop alive. Both
   * working scripts end with this and `process.exit`, and this one did not —
   * the sixth thing in this file that run-preview.ts already had right.
   */
  await env.shutdown(false);
}

main().then(
  // Explicit, for the same reason as the shutdown above: an open socket is
  // enough to keep the process alive after every useful thing has happened.
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.log();
    console.log(`  ${RED}${BOLD}Failed.${OFF}`);
    console.log(`  ${String(e?.message ?? e)}`);
    const explained = explainNodeError(String(e?.message ?? e));
    if (explained) console.log(`  ${DIM}${explained}${OFF}`);
    console.log();
    console.log('  Send this whole output back.');
    process.exit(1);
  },
);
