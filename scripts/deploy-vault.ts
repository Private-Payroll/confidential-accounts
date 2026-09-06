/**
 * S6e: PUT A VAULT ON CHAIN. The first SECOND contract this project deploys.
 *
 * Run it with `DEPLOY-VAULT.command`. What that door must pass and must refuse
 * is at the bottom of this file; the order the doors go in, and what each one
 * needs first, is `docs/command-order.md`.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS NOT
 *
 * **It is not `deploy-preview.ts` with a different contract in it.** Three
 * things differ and each of them is the subject of a rule:
 *
 *   · **The deploy is FULL.** The account is eleven of thirteen circuits and
 *     `submitPartialDeployTx` exists entirely for that. A vault is four
 *     circuits, 16,040 `bytesWritten`, 49.4% of the 32,497 per-extrinsic
 *     ceiling — it fits, so it deploys whole, through the SDK's ordinary
 *     `deployContract`. `src/midnight/vault-contract.ts` carries the deploy and
 *     the vault's own find, and says why neither of the two existing finds is
 *     the right one.
 *   · **There are MANY vaults.** The account has one deployment and one record;
 *     a company has a vault per purpose. Where the set lives, how a vault is
 *     named, what happens when two exist for the same purpose, and where each
 *     one's maintenance authority is recorded are all answered in
 *     `src/midnight/vault-record.ts`.
 *   · **`C236`: NO VAULT ADDRESS MAY REACH A SCREEN.** A plain send to a
 *     vault's address is money on chain that nobody can ever spend, and no
 *     contract can refuse it. So this script prints nothing through anything
 *     but `say`, which REFUSES a line carrying the address or any window of it
 *     worth having (`scripts/deploy-report.ts`). The address is written to the
 *     record; it is not shown, here or anywhere.
 *
 * ------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * **It does not create the vault's note pool, and it cannot.** The pool is
 * sealed under a fresh key wrapped to each signer's own wrapping public key
 * (`src/midnight/vault-pool.ts`) and this instrument holds no signer's key
 * material — deliberately, the same reason `MidnightLedger` refuses to carry
 * deployment credentials it was not given. A vault with no pool record cannot
 * be deposited into through the client: `SealedNotePool.load` refuses, by
 * design, because an absent pool and an empty one are opposite claims about a
 * treasury. **That step is owed and is named in the report** rather than being
 * faked with an unwrapped pool nobody could open.
 *
 * **It does not adopt the vault.** `adopt` is a governed round on the ACCOUNT,
 * at the account's own threshold, and a script that could raise one would be a
 * script that could move money. What adoption is worth is established below and
 * in the build log: the `vaults` registry is a RECOVERY record, not an
 * authorisation — `recordPayment` never consults it — so a vault that has not
 * been adopted can still be paid out of, and one adopted by mistake gains
 * nothing.
 *
 * **ONE ATTEMPT.** No retry, no fallback to another port, image or network. A
 * retry that succeeds after a failure hides which one was real, and no vault
 * deploy has ever been submitted, so this run's whole value is what it settles.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import {
  StaticProofServerContainer, createDefaultTestLogger, WalletSeeds,
} from '@midnight-ntwrk/testkit-js';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

import { Contract as VaultContract } from '../contracts/managed-vault/contract/index.js';
import {
  deployVaultContract, findDeployedVaultContract, requireVaultMaintenanceAuthority,
  describeMaintenanceAuthority, VAULT_CIRCUITS,
  type MaintenanceAuthorityChoice,
} from '../src/midnight/vault-contract.js';
import {
  assertVaultName, vaultAuthorityFile, vaultRegistryFile, emptyVaultRegistry,
  parseVaultRegistry, addVault, updateVault, describeVaultForReport,
  type VaultEntry, type VaultRegistry,
} from '../src/midnight/vault-record.js';
import { applyNetworkId, networkFromEnv, ENDPOINTS } from '../src/midnight/network.js';
import { explainNodeError, NODE_ERROR_CODES } from './node-errors.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';
import { bringUpWallet } from './wallet-bringup.js';
import { saveDustState } from './dust-wallet.js';
import { collapseRepeatedLines, describeDropped, serialiseWholeDetailed } from './error-report.js';
import {
  compareAgainstLimits, compareCost, limitsFromLedger, measuringProviders,
  type BlockLimits, type TxMeasurement,
} from './tx-size.js';
import {
  createScreen, phaseClock, withTimeout, describeError, captureNodeLines,
} from './deploy-report.js';

/* ------------------------------------------------------------------ */

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, '.midnight');
const SEED_FILE = join(STATE_DIR, 'wallet.seed');
const NETWORK = networkFromEnv(process.env.MIDNIGHT_NETWORK_ID, 'stagenet');
const VAULT_ARTEFACTS = join(ROOT, 'contracts', 'managed-vault');
const ACCOUNT_RECORD = join(STATE_DIR, `${NETWORK}-contract.json`);

/**
 * WHICH VAULT THIS RUN CREATES, by the name a person chose.
 *
 * There is no default and there must not be one. A default name means the
 * second run of this file deploys a second contract under the first's name —
 * and the record refuses to overwrite, which is the safe outcome, but only
 * after a deploy has been paid for. Better to refuse before the wallet.
 */
const VAULT_NAME = (process.env.VAULT_NAME ?? '').trim();
const VAULT_PURPOSE = (process.env.VAULT_PURPOSE ?? '').trim() || undefined;

/* 6301, NOT 6300 — M-144. Port 6300 has an 8.1.0 server on it and using it
 * produces node error 170. */
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT || 6301);

/**
 * The private state store, per network.
 *
 * **THE VAULT WRITES NOTHING INTO IT**, which is `C228`'s answer here
 * — `src/midnight/vault-contract.ts` passes no `privateStateId`, so the SDK
 * stores no private state for a vault and there is nothing for a second vault
 * to read. The store is still constructed because the SDK's providers bundle
 * requires one, and because the deploy files the vault's SIGNING KEY under the
 * vault's own address (keyed by the address it is given, never by the mutable
 * closure — `level-private-state-provider/dist/index.mjs:823`).
 */
const PRIVATE_STATE_ID = `confidential-accounts-${NETWORK}`;
const PRIVATE_STATE_PASSWORD =
  process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD || 'ConfidentialAccounts-Dev-2026';

/* ------------------------------------------------------------------ *
 * the report
 * ------------------------------------------------------------------ */

/**
 * The address, once it exists — held here so the SCREEN GUARD can forbid it
 * from the moment it does.
 *
 * Everything printed by this script goes through `say`, and `say` refuses a
 * line carrying this value or any eight-character window of it. That is the
 * difference between "we are careful not to print the address" and "the address
 * cannot be printed".
 */
let vaultAddress: string | null = null;

const say = createScreen(() => (vaultAddress
  ? [{ what: "the vault's address", value: vaultAddress }]
  : []));

const clock = phaseClock(say);
const note = (s: string) => say(`  ${s}`);
const good = (s: string) => say(`  \x1b[32m✓\x1b[0m ${s}`);

const rawNodeLines = captureNodeLines(explainNodeError);

const txMeasurements: TxMeasurement[] = [];
let blockLimits: BlockLimits | null = null;
let ledgerParameters: any = null;
let proofServerImage = '(not established)';
let proofServerVersion = '(not asked)';

/** The size block, printed on success and on refusal alike. */
function printTxSize() {
  say();
  say('  \x1b[1mHow big the transaction is, against what the chain will carry\x1b[0m');
  if (!txMeasurements.length) {
    say('    NO TRANSACTION WAS BUILT IN THIS RUN, so there is no size to report.');
    say('    The stage named above says how far it got.');
    if (blockLimits?.blockUsage != null) {
      say(`    The block usage limit is ${blockLimits.blockUsage.toLocaleString()} bytes regardless — ${blockLimits.source}.`);
    }
    return;
  }
  for (const m of txMeasurements) {
    say(`    ${m.stage.padEnd(10)} ${m.bytes === null ? `(not measured: ${m.problem ?? 'unknown'})` : `${m.bytes.toLocaleString()} bytes`}`);
  }
  const last = txMeasurements[txMeasurements.length - 1]!;
  const limits = blockLimits ?? {
    readTime: null, computeTime: null, blockUsage: null, bytesWritten: null, bytesChurned: null,
    source: '(not derived — the ledger parameters were never read in this run)',
  };
  say();
  for (const line of compareAgainstLimits(last, limits)) say(`    ${line}`);
  if (last.cost) {
    say();
    for (const line of compareCost(last.cost, limits)) say(`    ${line}`);
  }
  say();
  say('    MEASURED OFFLINE, THE VAULT DEPLOY IS 16,040 bytesWritten — 49.4% of the');
  say('    32,497 per-extrinsic ceiling (MEASURE-DEPLOY-SHAPE-VAULT.command). Anything');
  say('    far from that is the finding, whichever direction it is in.');
}

/* ------------------------------------------------------------------ *
 * what is chosen before anything is spent
 * ------------------------------------------------------------------ */

/**
 * The account this vault will be married to, read from the account's own
 * deployment record. `V-37`.
 *
 * NOT an argument and not an environment variable. Compact cannot create a
 * contract reference, so the address arrives from application code — and if it
 * arrived from a person typing it, a typo would deploy a vault married to a
 * contract that does not exist, or to somebody else's. It is pinned at creation
 * and can never be redirected, so this is the last moment it can be got right.
 */
function accountAddressFromRecord(): string {
  if (!existsSync(ACCOUNT_RECORD)) {
    throw new Error(
      `no account is deployed on ${NETWORK}: ${ACCOUNT_RECORD.replace(ROOT + '/', '')} does not ` +
      'exist.\n' +
      'A vault is married to ONE account at creation and can never be redirected (V-37), so ' +
      'there is nothing to deploy a vault against yet. DEPLOY-PREVIEW.command deploys the ' +
      'account and writes that file.');
  }
  const record = JSON.parse(readFileSync(ACCOUNT_RECORD, 'utf8'));
  const address = String(record?.contractAddress ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(address)) {
    throw new Error(
      `${ACCOUNT_RECORD.replace(ROOT + '/', '')} holds no usable contract address. A vault ` +
      'deployed against a wrong address is a vault that can never be paid out of, and the ' +
      'address cannot be changed afterwards.');
  }
  /*
   * THE ACCOUNT MUST CARRY THE CIRCUITS A VAULT CALLS.
   *
   * `payout` calls the account's `recordPayment`; `retire` calls `retireVault`,
   * which is DEFERRED from the account's deployment and therefore has no
   * verifier key on chain — a `retire` would be refused by the chain itself
   * with `VerifierKeyNotPresent`. That is known and accepted for version one,
   * and it is said here rather than discovered by a vault that cannot be
   * retired.
   */
  const deployed: string[] = Array.isArray(record?.circuits?.deployed) ? record.circuits.deployed : [];
  if (deployed.length && !deployed.includes('recordPayment')) {
    throw new Error(
      'the deployed account does not carry `recordPayment`, which every vault payout calls as a ' +
      'cross-contract callee. A vault deployed against it could accept deposits and never pay ' +
      'anything out. The account must be redeployed carrying it before a vault is worth having.');
  }
  return address.toLowerCase();
}

/**
 * The deliberate maintenance authority for THIS vault, or a refusal that says
 * how to choose one. `C225`, per vault.
 *
 * One file per vault, keyed by the vault's NAME — see `vault-record.ts` for why
 * each vault chooses its own rather than inheriting the account's, and why the
 * file cannot be keyed by address.
 */
function loadVaultAuthority(name: string): MaintenanceAuthorityChoice {
  const file = vaultAuthorityFile(STATE_DIR, name);
  if (!existsSync(file)) {
    throw new Error(
      `no maintenance authority has been chosen for the vault "${name}": ` +
      `${file.replace(ROOT + '/', '')} does not exist.\n\n` +
      'THE DEPLOY REFUSES TO SAMPLE ONE. `deployContract` falls through to\n' +
      '`sampleSigningKey()` when no key is passed (midnight-js-contracts index.mjs:1907), and\n' +
      'whoever holds that key can change which proofs THIS CONTRACT — the one holding the\n' +
      'money — will accept, alone, outside the company threshold. If it is lost, the vault can\n' +
      'never be maintained. C225.\n\n' +
      'RUN CHOOSE-AUTHORITY.command. It asks which contract — type this vault\'s name — and\n' +
      'writes that file itself.\n\n' +
      'ONE KEY IS THE ONLY KIND A VAULT CAN HAVE TODAY, and that is the SDK rather than a\n' +
      'choice: the full deploy path builds the authority from a single signing key\n' +
      '(compact-js ContractExecutable.js:276-290), and `replaceAuthority` takes a single key\n' +
      'through the same constructor. A committee, and an empty committee that can never sign,\n' +
      'are both unreachable from here — M-156 carries what it would take.\n\n' +
      'EACH VAULT CHOOSES ITS OWN, which is why that door asks for a name rather than\n' +
      'assuming the account\'s. The account\'s own choice lives in\n' +
      '.midnight/maintenance-authority.json, its key is recorded as a temporary state, and\n' +
      'one key over every pot of money means one compromise reaches all of them.\n\n' +
      'THEN BACK THAT FILE UP LIKE THE WALLET SEED: it holds the only key that can ever\n' +
      'maintain this vault. Losing it does not lose the money — it loses maintenance for good.');
  }
  return requireVaultMaintenanceAuthority(JSON.parse(readFileSync(file, 'utf8')));
}

/** The company's vaults on this network, or an empty set — never a guess. */
function loadRegistry(): VaultRegistry {
  const file = vaultRegistryFile(STATE_DIR, NETWORK);
  if (!existsSync(file)) return emptyVaultRegistry(NETWORK);
  return parseVaultRegistry(JSON.parse(readFileSync(file, 'utf8')), NETWORK);
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function main() {
  say('────────────────────────────────────────────────────────────');
  say(`  Creating a vault on ${NETWORK}`);
  say('────────────────────────────────────────────────────────────');

  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

  /* -------------------------------------------------- 1 */
  clock.begin(1, 6, 'Deciding what is being created, and for whom');

  if (!VAULT_NAME) {
    throw new Error(
      'no vault name was given. Set VAULT_NAME to the person or purpose this vault pays — ' +
      'payroll-uk, contractors, alice.\n' +
      'There is deliberately NO DEFAULT: a default name means the second run of this file ' +
      'deploys a second contract under the first one\'s name, and the record would refuse it — ' +
      'correctly, but only after a deploy had been paid for. A vault is named rather than ' +
      'addressed because a vault\'s address must never reach a screen (C236).');
  }
  assertVaultName(VAULT_NAME);
  good(`vault name  ${VAULT_NAME}${VAULT_PURPOSE ? `  — ${VAULT_PURPOSE}` : ''}`);

  /*
   * THE NAME IS FREE, CHECKED BEFORE ANYTHING IS SPENT.
   *
   * `addVault` refuses a taken name after the deploy too, which is the safety
   * net that matters — but discovering it there means a deployed contract with
   * nowhere to be recorded. Anything knowable up front belongs up front.
   */
  const registry = loadRegistry();
  if (registry.vaults[VAULT_NAME]) {
    throw new Error(
      `this company already has a vault called "${VAULT_NAME}" on ${NETWORK}, deployed ` +
      `${registry.vaults[VAULT_NAME]!.deployedAt}.\n` +
      'Deploying another would create a SECOND contract at a different address, and writing it ' +
      'over the first would lose the first\'s address — which exists in that record and nowhere ' +
      'else. Two vaults for the same purpose are two vaults: give this one its own name.');
  }
  good(`the name is free — this company has ${Object.keys(registry.vaults).length} vault(s) on ${NETWORK}`);

  const accountAddress = accountAddressFromRecord();
  good('the account this vault will be married to is the one in the deployment record');
  note('  pinned in the vault\'s ledger at creation and never redirectable (V-37)');

  /*
   * The compiled vault, with its keys.
   *
   * `contracts/managed-vault/` has held no `keys/` since the vault was written
   * and COMPILE-VAULT.command is the only file that builds them. The
   * deploy layer asks the zk config provider for all four before a fee is
   * spent and names that file when they are missing; this checks the directory
   * first so the message arrives before the network rather than after it.
   */
  if (!existsSync(join(VAULT_ARTEFACTS, 'keys'))) {
    throw new Error(
      'contracts/managed-vault/keys does not exist, so the vault has no proving or verifier ' +
      'keys and nothing can be deployed.\n' +
      'COMPILE-VAULT.command builds them. It takes minutes and it is the ONLY file that does — ' +
      'COMPILE-CONTRACT.command compiles both contracts with --skip-zk, MUTATE.command\'s quick ' +
      'recompiles wipe them, and BUILD-KEYS.command covers the account only.');
  }
  good('the vault\'s proving and verifier keys are on disk');

  const maintenanceAuthority = loadVaultAuthority(VAULT_NAME);
  const authorityShape = describeMaintenanceAuthority(maintenanceAuthority);
  good(
    `maintenance authority chosen deliberately: ${authorityShape.kind} — committee of ` +
    `${authorityShape.committeeSize}, threshold ${authorityShape.threshold}` +
    (authorityShape.fixedBy ? ` (TEMPORARY, replaced by: ${authorityShape.fixedBy})` : ''));
  note('  this file holds the only key that can ever maintain THIS vault. Back it up like');
  note('  the wallet seed — losing it does not lose the money, it loses maintenance for good');

  const { validatePassword } = await import('@midnight-ntwrk/midnight-js-utils');
  try {
    validatePassword(PRIVATE_STATE_PASSWORD);
    good('private state password meets the SDK rules');
  } catch (e: any) {
    throw new Error(
      `the private state store password is not acceptable to the SDK: ${e?.message ?? e}\n` +
      '  At least 16 characters and 3 of: uppercase, lowercase, digits, special.');
  }

  const compiled = CompiledContract.make('Vault', VaultContract as any).pipe(
    CompiledContract.withWitnesses({
      /*
       * THE CONSTRUCTOR CALLS NO WITNESS, so this one refuses rather than
       * answering. A deploy that reached `noteToSpend` would be a deploy
       * spending a note out of a vault that does not exist yet, and a witness
       * that quietly returned a zero coin would let it.
       */
      noteToSpend: () => {
        throw new Error(
          'the vault constructor asked for a note to spend. It has no such call — this is a ' +
          'deploy, the pool is empty by definition, and answering would commit the vault to a ' +
          'note nobody holds.');
      },
    } as any),
    CompiledContract.withCompiledFileAssets(VAULT_ARTEFACTS as never),
  ) as any;
  good(`compiled contract "${compiled.tag}", assets at contracts/managed-vault`);
  note(`  ${VAULT_CIRCUITS.length} circuits, ALL of them deployed: ${VAULT_CIRCUITS.join(', ')}`);
  note('  a vault deploys whole — it is the ACCOUNT that defers, because the account does not fit');

  /* -------------------------------------------------- 2 */
  clock.begin(2, 6, 'Setting the network id');
  await applyNetworkId(NETWORK);
  good(`network id is the string "${NETWORK}"`);

  /* -------------------------------------------------- 3 */
  clock.begin(3, 6, 'Connecting to the network and the proof server');

  const logger = createDefaultTestLogger();
  const { env, how } = testEnvironmentFor(NETWORK, logger);
  note(`network ${NETWORK} — ${how}`);
  const cfg = await startEnvironment(env, new StaticProofServerContainer(PROVER_PORT), note);
  good(`node      ${cfg.node}`);
  good(`indexer   ${cfg.indexer}`);
  good(`prover    ${cfg.proofServer}`);

  proofServerImage = process.env.MIDNIGHT_PROOF_IMAGE
    ?? '(not exported — run through DEPLOY-VAULT.command to record it)';
  try {
    const res = await withTimeout('the proof server /version', 10_000, fetch(`${cfg.proofServer}/version`));
    proofServerVersion = (await res.text()).trim().slice(0, 200) || `(empty, HTTP ${res.status})`;
  } catch (e: any) {
    proofServerVersion = `(did not answer: ${String(e?.message ?? e).slice(0, 80)})`;
  }
  good(`prover image    ${proofServerImage}`);
  good(`prover /version ${proofServerVersion}`);

  try {
    const { LedgerParameters } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
    ledgerParameters = LedgerParameters;
    blockLimits = limitsFromLedger(LedgerParameters);
    good(`block usage limit ${blockLimits.blockUsage === null ? '(could not derive)' : `${blockLimits.blockUsage.toLocaleString()} bytes`}`);
  } catch (e: any) {
    note(`the block limits could not be read: ${String(e?.message ?? e)}`);
  }

  /* -------------------------------------------------- 4 */
  clock.begin(4, 6, 'Getting a funded wallet');

  let masterSeed: string;
  if (existsSync(SEED_FILE)) {
    masterSeed = readFileSync(SEED_FILE, 'utf8').trim();
    note(`reusing the wallet in ${SEED_FILE.replace(ROOT + '/', '')}`);
  } else {
    /*
     * A FRESH WALLET HAS NO FUNDS AND THE FAUCET WANTS A CAPTCHA, so this
     * refuses rather than making one and waiting for money that will not come.
     * The vault deploy is not the place to discover that.
     */
    masterSeed = WalletSeeds.generateRandom().masterSeed;
    writeFileSync(SEED_FILE, masterSeed, { mode: 0o600 });
    throw new Error(
      `there was no wallet, so one was made and saved to ${SEED_FILE.replace(ROOT + '/', '')}. ` +
      'It holds nothing. Fund it from the faucet — DEPLOY-PREVIEW.command prints the address ' +
      'and the faucet URL — and run this again.');
  }

  /*
   * Bring-up is `scripts/wallet-bringup.ts`, not written out again. `M-75`:
   * `sponsor-test.ts` was written from MEMORY of this procedure and lost three
   * runs to one absent `wallet.start(false)`.
   */
  const live = await bringUpWallet(logger, cfg, masterSeed, NETWORK, ROOT, {
    withDust: true, requireDust: true, onNote: note,
  });
  const wallet: any = live.wallet;
  good(`wallet ready — NIGHT ${live.night()}, DUST ${live.dust()}`);
  const cached = await saveDustState(wallet, masterSeed, NETWORK, ROOT);
  if (cached) good(`dust wallet state cached (${(cached / 1024).toFixed(0)} KB)`);

  /* -------------------------------------------------- 5 */
  clock.begin(5, 6, `Deploying the vault — ${VAULT_CIRCUITS.length} circuits, none deferred`);
  note('a vault deploy has never been submitted by this project. Give it a minute.');

  const zkConfigProvider = new NodeZkConfigProvider<string>(VAULT_ARTEFACTS);
  const providers: any = {
    zkConfigProvider,
    proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
    privateStateProvider: levelPrivateStateProvider({
      accountId: PRIVATE_STATE_ID,
      privateStateStoreName: PRIVATE_STATE_ID,
      privateStoragePasswordProvider: async () => PRIVATE_STATE_PASSWORD,
    } as any),
    publicDataProvider: indexerPublicDataProvider(cfg.indexer, cfg.indexerWS),
    walletProvider: wallet,
    midnightProvider: wallet,
  };

  const measured = measuringProviders(providers, (m) => {
    txMeasurements.push(m);
    note(`transaction size (${m.stage}) ${m.bytes === null ? `not measured: ${m.problem ?? 'unknown'}` : `${m.bytes.toLocaleString()} bytes`}`);
    const w = m.cost?.cost?.bytesWritten;
    if (typeof w === 'number' && blockLimits?.bytesWritten) {
      note(`  bytes written ${w.toLocaleString()} of ${blockLimits.bytesWritten.toLocaleString()} — ${((w / blockLimits.bytesWritten) * 100).toFixed(1)}% of a block`);
    }
    if (m.cost?.exceeded) note(`  THE LEDGER WILL NOT NORMALISE THIS COST: a block limit is exceeded. ${m.cost.exceeded}`);
  }, ledgerParameters);

  const startedAt = Date.now();
  const deployed = await deployVaultContract(measured, {
    compiledContract: compiled,
    accountAddress,
    maintenanceAuthority,
  });
  /*
   * THE ADDRESS BECOMES A SECRET THE MOMENT IT EXISTS. Everything printed from
   * here on is refused if it carries it.
   */
  vaultAddress = deployed.contractAddress;
  good(`deployed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  good('the address is NOT printed, here or anywhere — C236. It is written to the record below.');

  /* -------------------------------------------------- 6 */
  clock.begin(6, 6, 'Recording it, then reading it back off the chain');

  /*
   * RECORDED BEFORE THE READ-BACK, exactly as `MidnightLedger.open` records the
   * account's address before verifying it. **A vault we deployed and did not
   * write down is money nobody can reach**, and the address exists in this file
   * and nowhere else. A failed verification can be retried; a forgotten address
   * cannot be recovered from anything.
   */
  const entry: VaultEntry = {
    name: VAULT_NAME,
    purpose: VAULT_PURPOSE,
    contractAddress: deployed.contractAddress,
    accountAddress,
    deployedAt: new Date().toISOString(),
    circuits: deployed.circuits,
    maintenanceAuthority: authorityShape,
    /* Adoption is a governed round on the account. Nothing here can raise one. */
    adopted: false,
    deployTx: null,
  };
  const registryFile = vaultRegistryFile(STATE_DIR, NETWORK);
  writeFileSync(registryFile, JSON.stringify(addVault(registry, entry), null, 2), { mode: 0o600 });
  good(`recorded in ${registryFile.replace(ROOT + '/', '')} under the name "${VAULT_NAME}"`);

  /*
   * THE FEE ACTUALLY PAID, AND THE BLOCK.
   *
   * Read off the finalized transaction rather than estimated. It does NOT fail
   * the run: the vault has landed and its address is already on disk, and a
   * report missing its fee is worth more than a successful deploy discarded
   * over one.
   */
  try {
    const finalized: any = await withTimeout(
      'the finalized deploy transaction', 60_000,
      providers.publicDataProvider.watchForDeployTxData(deployed.contractAddress));
    const deployTx = {
      txId: String(finalized?.txId ?? ''),
      txHash: String(finalized?.txHash ?? ''),
      status: String(finalized?.status ?? ''),
      blockHeight: finalized?.blockHeight ?? null,
      blockHash: String(finalized?.blockHash ?? ''),
      blockTimestamp: finalized?.blockTimestamp ?? null,
      protocolVersion: finalized?.protocolVersion ?? null,
      paidFees: String(finalized?.fees?.paidFees ?? ''),
      estimatedFees: String(finalized?.fees?.estimatedFees ?? ''),
      proofServerImage,
      proofServerVersion,
    };
    entry.deployTx = deployTx;
    /*
     * `updateVault`, NOT `addVault`. The entry is already on disk — it was
     * written the moment the address existed — so adding it again would be
     * refused, correctly, and the measurement would be lost. Creating and
     * advancing are different acts, the same distinction `SealedNotePool`
     * keeps between `create` and `save`.
     */
    writeFileSync(
      registryFile,
      JSON.stringify(updateVault(loadRegistry(), entry), null, 2), { mode: 0o600 });
    say();
    say('  \x1b[1mWhat the chain charged, and where it landed\x1b[0m');
    say(`    fee paid          ${deployTx.paidFees}`);
    say(`    fee estimated     ${deployTx.estimatedFees}`);
    say(`    block height      ${deployTx.blockHeight}`);
    say(`    block hash        ${deployTx.blockHash}`);
    say(`    transaction id    ${deployTx.txId}`);
    say(`    status            ${deployTx.status}`);
    say(`    proof server      ${proofServerImage}  (/version: ${proofServerVersion})`);
  } catch (e: any) {
    say();
    say('  \x1b[33mthe vault deployed but its finalized transaction could not be read back:\x1b[0m');
    say(`    ${String(e?.message ?? e)}`);
    say('    So there is NO recorded fee for this deploy. The vault is on chain regardless');
    say(`    and its address is in ${registryFile.replace(ROOT + '/', '')}.`);
  }

  printTxSize();

  /*
   * THE READ-BACK, through THE VAULT'S OWN FIND.
   *
   * Not `findDeployedPartialContract` — that one refuses a full deployment by
   * design, which is right for the account and wrong here. Not the SDK's
   * `findDeployedContract` either: it samples and stores a signing key for any
   * address the private-state store has none for (index.mjs:1951-1963), which
   * would file a key that maintains nothing in the slot the real one lives in.
   * `findDeployedVaultContract` keeps M-9's byte-for-byte key comparison,
   * checks the operations map is exactly the vault's four, and writes nothing.
   */
  const found = await findDeployedVaultContract(providers, {
    compiledContract: compiled, contractAddress: deployed.contractAddress,
  });
  good(`read back off the chain — the operations map carries ${found.circuits.join(', ')}`);

  say();
  say('  \x1b[1mThe vault that now exists\x1b[0m');
  for (const line of describeVaultForReport(entry)) say(`    ${line}`);

  say();
  say('  \x1b[1mWHAT IS OWED BEFORE THIS VAULT CAN HOLD MONEY\x1b[0m');
  say('    1. A NOTE POOL, which OPEN-VAULT-POOL.command creates. This script cannot: the');
  say('       pool is sealed under a key wrapped to each signer\'s own wrapping public key,');
  say('       and this instrument holds no signer\'s key material. Until one exists,');
  say('       VaultLedger refuses every call — deliberately, because an absent pool and an');
  say('       empty one are opposite claims about a treasury.');
  say('       That door needs a signer set: MAKE-TEST-SIGNERS.command writes one.');
  say('    2. ADOPTION, which is a governed round on the ACCOUNT at the account\'s own');
  say('       threshold. It is a RECOVERY record and not an authorisation: nothing consults');
  say('       the account\'s `vaults` set before authorising a payment, so this vault can be');
  say('       paid out of without it. What adoption buys is that a company whose devices and');
  say('       database are gone can still find a vault that was FUNDED and never PAID.');
  say('    3. FUNDING, WHICH IS A `deposit` CALL AND NEVER A TRANSFER. C236: a plain send to');
  say('       this vault\'s address is money on chain that nobody can ever spend, and no');
  say('       contract can refuse it. There is no "wire funds to this address" flow and');
  say('       there never can be.');

  live.stop();
}

/* ------------------------------------------------------------------ *
 * the refusal, unabridged and bounded
 * ------------------------------------------------------------------ */

main().then(
  () => process.exit(0),
  (e) => {
    /*
     * THE FAILURE BLOCK DOES NOT GO THROUGH THE SCREEN GUARD, and that is
     * deliberate rather than an oversight: an error thrown from inside the
     * guard would otherwise be unprintable, and a report that cannot print its
     * own failure is worse than one that shows an address in a stack trace on a
     * run that did not finish. Nothing here formats the address — it is
     * console.log because the guard's own throw is what would arrive here.
     */
    console.log();
    console.log(`\x1b[31m\x1b[1m  Failed during: ${clock.stage}\x1b[0m`);
    console.log(describeError(e, explainNodeError).split('\n').map((l) => '  ' + l).join('\n'));
    if (e?.stack) console.log(`\n\x1b[2m${e.stack.split('\n').slice(1, 8).join('\n')}\x1b[0m`);

    clock.print('stopped');

    console.log();
    console.log('  \x1b[1mWhat this was proved against\x1b[0m');
    console.log(`    proof server image    ${proofServerImage}`);
    console.log(`    proof server /version ${proofServerVersion}`);
    console.log('    ONE ATTEMPT was made. No retry, no other port, image or network.');

    try { printTxSize(); } catch { /* the guard fired; the sizes are above */ }

    console.log();
    console.log("  \x1b[1mThe node's own words, verbatim and uncut\x1b[0m");
    if (rawNodeLines.length) {
      for (const line of collapseRepeatedLines(rawNodeLines)) {
        for (const part of line.split('\n')) console.log(`    ${part}`);
      }
      const codes = [...new Set(rawNodeLines.flatMap(
        (l) => [...l.matchAll(/Custom error:\s*(\d+)/g)].map((m) => m[1])))];
      if (codes.length) {
        console.log();
        for (const c of codes) {
          console.log(`    code ${c} = ${NODE_ERROR_CODES[c!] ?? '(not in our table — look it up in the node source, do not guess)'}`);
        }
      } else {
        console.log();
        console.log('    No numeric rejection code appears above. The node answered, but not');
        console.log('    with a Custom error.');
      }
    } else if (/deploy/i.test(clock.stage)) {
      console.log('    NOTHING, AND THE RUN HAD REACHED THE SUBMISSION. The node printed no');
      console.log('    rejection line, so it never answered: the websocket dropped and the');
      console.log('    chain never saw the transaction. M-23.');
      console.log('    THIS IS NOT A REFUSAL AND IT SETTLES NOTHING. Run DEPLOY-VAULT.command');
      console.log('    again, unchanged.');
    } else {
      console.log('    NOTHING, AND THE RUN NEVER REACHED THE SUBMISSION — it stopped in');
      console.log(`    "${clock.stage}". This failure is local: read the error above.`);
    }

    console.log();
    console.log('  \x1b[1mThe error object, whole — bounded, and it says what it dropped\x1b[0m');
    const serialised = serialiseWholeDetailed(e);
    console.log(serialised.text.split('\n').map((l) => '    ' + l).join('\n'));
    console.log();
    for (const line of describeDropped(serialised.dropped)) console.log(`    ${line}`);

    console.log();
    console.log('  \x1b[33mIF THE DEPLOY LANDED AND THIS RUN STOPPED AFTERWARDS, the vault exists\x1b[0m');
    console.log('  \x1b[33mand its address may not have been recorded. Check\x1b[0m');
    console.log(`  \x1b[33m.midnight/${NETWORK}-vaults.json for "${VAULT_NAME}" BEFORE running this again:\x1b[0m`);
    console.log('  \x1b[33ma second run deploys a second contract, and the first one\'s address\x1b[0m');
    console.log('  \x1b[33mexists in that file and nowhere else.\x1b[0m');

    console.log();
    console.log('  Send this whole output back. The stage name above says which layer broke.');
    process.exit(1);
  },
);

/*
 * ------------------------------------------------------------------------
 * `DEPLOY-VAULT.command` — NOT WRITTEN HERE, AND WHAT IT MUST DO
 *
 * A bare shell line is not runnable: these files are launched by opening them,
 * which passes no argument. What that door must pass is exactly this:
 *
 *   NAME          DEPLOY-VAULT.command, at the repository root, beside
 *                 DEPLOY-PREVIEW.command. `chmod +x` on all *.command as every
 *                 other one does, and a REPORT-DEPLOY-VAULT.txt written beside
 *                 it with the ANSI codes stripped.
 *
 *   IT MUST REFUSE BEFORE IT STARTS, in this order, because each refusal is
 *   cheaper than the one after it:
 *     0. `VAULT_NAME` is set. There is no default — see the refusal above.
 *     1. `contracts/managed-vault/keys` exists. COMPILE-VAULT.command is the
 *        only file that builds it, it takes minutes, and it must have run.
 *     2. `.midnight/<network>-contract.json` exists — there is an account to
 *        marry this vault to (V-37).
 *     3. `.midnight/vault-authority-<VAULT_NAME>.json` exists. C225: the deploy
 *        will not sample. The refusal text this file prints is what to show.
 *     4. The proof server on 6301 answers, and its IMAGE is the pinned
 *        9.0.0-rc.3 — the same check DEPLOY-PREVIEW.command performs, for the
 *        same reason: a server left running from an earlier stack produces
 *        proofs the node's fee check refuses (node error 170, port 6300 is an
 *        8.1.0 server).
 *
 *   IT MUST EXPORT
 *     MIDNIGHT_PROOF_IMAGE   the image it verified, so the report can record
 *                            what the proof was built against
 *     MIDNIGHT_NETWORK_ID    the network, defaulting to stagenet
 *     VAULT_NAME, VAULT_PURPOSE   passed straight through
 *
 *   IT MUST RUN            npx tsx scripts/deploy-vault.ts
 *
 *   AND IT MUST NOT
 *     · start, stop or restart the proof server. One is running on 6301 and it
 *       is left alone.
 *     · retry. One attempt, for the reason at the top of this file.
 *     · print the vault's address, or grep the report for it. The report will
 *       not contain one, and a `.command` that added it would defeat the guard
 *       this script enforces in code.
 *
 *   WHAT TO RUN, IN ORDER, BY THE PERSON AT THE MACHINE
 *     1. COMPILE-VAULT.command          the vault's keys. Minutes. Once.
 *     2. MEASURE-DEPLOY-SHAPE-VAULT.command   the gate: expect 16,040
 *                                       bytesWritten, 49.4% of 32,497. If it
 *                                       prints OVER, stop — that is the finding.
 *     3. CHOOSE-AUTHORITY.command        it asks which contract; type this
 *                                       vault's name. Back the file it writes
 *                                       up like the wallet seed.
 *     4. DEPLOY-VAULT.command           this script
 *     5. MAKE-TEST-SIGNERS.command      the signer set the pool is wrapped to
 *     6. OPEN-VAULT-POOL.command        what makes the deployed vault FUNDABLE
 *
 * `docs/command-order.md` carries this sequence and the others, with what each
 * door needs before it will run and what it prints when that is missing.
 */
