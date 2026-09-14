/**
 * **PAYS PRIVATE MONEY OUT OF A VAULT: A NOTE IN, A NOTE OUT, AND NOTHING
 * ABOUT THE MONEY IN THE CLEAR.**
 *
 * Run it through the door beside it that asks for these answers. Every rule it
 * applies is in `pay-privately-rules.ts` and `pay-from-vault-rules.ts`, where
 * they are tested; this file connects those rules to a wallet, a proof server,
 * the account and the vault.
 *
 * ------------------------------------------------------------------------
 * **WHAT A PRIVATE PAYMENT OUT OF A VAULT IS.** Three transactions, each paid
 * for by the wallet on this machine and never by the vault:
 *
 *   1. propose   a run on the ACCOUNT: a root over one payee's leaf, one payee,
 *                and a window. Signer A's key is the witness.
 *   2. approve   by as many signers as the vault's threshold, in order A, B, C.
 *   3. pay       `payout` on the VAULT, which asks the account across the
 *                contract boundary whether this leaf is in an approved run,
 *                inside its window and not yet paid, spends one of the vault's
 *                notes, and sends a new note to the payee's coin key.
 *
 * ------------------------------------------------------------------------
 * **WHAT IS DIFFERENT FROM THE PUBLIC DOOR, AND IT IS NOT THE PAPERWORK.**
 *
 * The record, the resume, the window, the approvals and the arguments the vault
 * is handed are the same, and they are the same code. Three things are not:
 *
 *   · **THE MONEY IS A NOTE AND NOT A BALANCE.** A vault's private money is a
 *     set of notes, each one whole. **A payment is made out of ONE of them** -
 *     notes are not merged - so a vault holding two notes that add up to enough
 *     still cannot make the payment, and that is refused here before any fee.
 *   · **A NOTE IS SPENT AT THE PLACE THE CHAIN FILED IT**, which is read from
 *     the transaction that created it, just before the spend. A note whose pool
 *     entry records no such transaction cannot be spent at all - the money is on
 *     chain and it is the vault's, and nothing can reach it until that
 *     transaction is recorded. This door asks that question first.
 *   · **THE POOL IS THE RECORD OF THE MONEY.** Nothing on chain says what a
 *     note is, only that a commitment exists, so this door opens the vault's
 *     sealed pool and the payment rewrites it. A run without it would be
 *     refused with nothing to reconcile against.
 *
 * ------------------------------------------------------------------------
 * **WHAT AN OBSERVER LEARNS ANYWAY, SAID HERE RATHER THAN IMPLIED.** The
 * vault's address, that `payout` was called on it, when, for what fee, that one
 * note left its set and one arrived, and that its payment counter went up by
 * one. **Not who was paid, not in what, and not how much.**
 *
 * ------------------------------------------------------------------------
 * ------------------------------------------------------------------------
 * **THE SETTLEMENT IS PRIVATE AND THIS RUN'S OWN TRANSCRIPT IS NOT.** The
 * screen and the report beside it are written on the machine making the
 * payment, for the person making it, and they carry things no observer of the
 * chain gets: a shortened form of the payee's address, the amount, the asset,
 * and on a refusal the note nonces involved. **A nonce with a colour and a
 * value reproduces the commitment the chain holds.** That is the right trade
 * for a door somebody runs and reads, and it is written here so that nobody
 * treats the report as safe to pass on.
 *
 * ------------------------------------------------------------------------
 * **WHAT THIS MACHINE HOLDS THAT A COMPANY'S MACHINE WOULD NOT.** Test signers,
 * whose secret keys are in a file beside the wallet, so one process can approve
 * as several people, and both halves of the pool's own keys. A real signer's
 * key never leaves their device. This door is for a test network and says so.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import { StaticProofServerContainer, createDefaultTestLogger } from '@midnight-ntwrk/testkit-js';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ZKConfigRegistry } from '@midnight-ntwrk/midnight-js-types';

import {
  Contract as AccountContract, ledger as readAccountLedger, pureCircuits as accountCircuits,
} from '../contracts/managed/contract/index.js';
import { Contract as VaultContract } from '../contracts/managed-vault/contract/index.js';
import { witnesses as accountWitnesses } from '../contracts/src/witnesses.js';
import { VaultLedger } from '../src/midnight/vault-ledger.js';
import { SealedNotePool, type PoolSigner } from '../src/midnight/vault-pool.js';
import { chainVaultHoldings } from '../src/midnight/vault-holdings.js';
import { vaultDetailsOf } from '../src/midnight/vault-details.js';
import { indexerNoteEvents } from '../src/midnight/note-index.js';
import { refuseWhatTheVaultCannotPay } from '../src/core/vault-holdings.js';
import { assertVaultName, vaultRegistryFile, parseVaultRegistry, type VaultEntry, theVault,} from '../src/midnight/vault-record.js';
import { applyNetworkId, theNetwork } from '../src/midnight/network.js';
import { payeeOf, shortPayee } from '../src/midnight/payee-address.js';
import { privateStateKey } from '../src/midnight/ledger.js';
import { transferOf, transferFacts, privacyOf } from '../src/core/movement.js';
import { assets, assetIdBytes, formatAmount, refuseATestAssetOffItsNetwork } from '../src/core/assets.js';
import { fromHex, toHex, type Hex } from '../src/core/crypto.js';
import type { SignerRef } from '../src/core/ledger.js';
import { explainNodeError } from './node-errors.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';
import { bringUpWallet } from './wallet-bringup.js';
import { saveDustState } from './dust-wallet.js';
import { serialiseWholeDetailed, describeDropped } from './error-report.js';
import { createScreen, phaseClock, withTimeout, describeError } from './deploy-report.js';
import { previewSignersFile, parsePreviewSigners, signerBytes, PREVIEW_SIGNER_IDS } from './preview-signers.js';
import { FileSealedPoolStore, vaultPoolFile } from './vault-pool-file.js';
import { chooseOpener, assertNoSignerIsDropped } from './deposit-to-vault.js';
import { testTokenFile } from './mint-test-token.js';
import {
  amountFromText, referenceFromText, assertVaultIsMarriedTo,
  blockSecondsOf, newPayoutRecord, payoutRecordFromText, assertNotAlreadyPaid, assertRecordIsThisPayment,
  finishedRecordFile, finishedRecordPrefix, runOf, vaultPaymentOf,
  asksOf, batchDigestOf, approvalsNeeded, publicMovementOf, drive, refusalBeforePayment,
  type PayoutRecord,
} from './pay-from-vault-rules.js';
import {
  assertPrivatePayee, assertVaultCanPayPrivately, theAssetPaidPrivately,
  checkTheColourWasMinted, assertANoteCanBeSpent,
} from './pay-privately-rules.js';

/* ------------------------------------------------------------------ */

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, '.midnight');
const SEED_FILE = join(STATE_DIR, 'wallet.seed');
/**
 * **WHICH NETWORK, AND IT IS NOT THE ENVIRONMENT'S TO DECIDE.**
 *
 * `theNetwork` throws when the environment names a network other
 * than the one this build is compiled for. **That matters more here than
 * anywhere else in this repository**: the asset this door settles in exists
 * only on networks a test asset is allowed on, and that gate is keyed on the
 * compiled constant. A door that took the environment's word for the network
 * would carry a worthless token onto whatever chain the variable named, with
 * the registry still holding it because the registry was asked a different
 * question. Unset is not a disagreement; it is the ordinary case.
 */
const NETWORK = theNetwork();
const ACCOUNT_RECORD = join(STATE_DIR, `${NETWORK}-contract.json`);
const VIEW_FILE = join(STATE_DIR, `${NETWORK}-view.json`);
const SIGNER_SECRETS = join(STATE_DIR, 'vault-pool-secrets.json');
const ACCOUNT_ARTEFACTS = join(ROOT, 'contracts', 'managed');
const VAULT_ARTEFACTS = join(ROOT, 'contracts', 'managed-vault');
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT || 6301);
const PRIVATE_STATE_ID = `confidential-accounts-${NETWORK}`;
const PRIVATE_STATE_PASSWORD = process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD || 'ConfidentialAccounts-Dev-2026';
const ACCOUNT_ID = 'default';
const PRIVATE_STATE_KEY = privateStateKey(PRIVATE_STATE_ID, ACCOUNT_ID);

const VAULT_NAME = (process.env.VAULT_NAME ?? '').trim();
const PAY_TO = (process.env.PAY_TO ?? '').trim();
const PAY_AMOUNT = (process.env.PAY_AMOUNT ?? '').trim();
const PAY_REFERENCE = (process.env.PAY_REFERENCE ?? '').trim();

const ZERO_32 = new Uint8Array(32);

const recordFileFor = (name: string) => join(STATE_DIR, `${NETWORK}-vault-private-payout-${name}.json`);

/** Who is acting, for the client's own records. The chain attributes nothing. */
const BY: SignerRef = { signerId: 'the operator paying out of this vault', leaf: '' } as unknown as SignerRef;

/* ------------------------------------------------------------------ *
 * the report
 * ------------------------------------------------------------------ */

let vaultAddress: string | null = null;
let accountAddress: string | null = null;
/** The address being paid, so a refusal's error dump does not carry it. */
let payeePaid: string | null = null;
/** What the chain last said about this payment, so a stop after it was paid does not advise paying again. */
let lastReadPaid = false;
/** The record this run is working, until it is moved aside as finished. */
let liveRecord: { file: string; record: PayoutRecord } | null = null;

const say = createScreen(() => [
  ...(vaultAddress ? [{ what: "the vault's address", value: vaultAddress }] : []),
  ...(accountAddress ? [{ what: "the account's address", value: accountAddress }] : []),
]);
const clock = phaseClock(say);
const note = (s: string) => say(`  ${s}`);
const good = (s: string) => say(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s: string) => say(`  \x1b[33m■\x1b[0m ${s}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

function vaultFromRegistry(name: string): VaultEntry {
  const file = vaultRegistryFile(STATE_DIR, NETWORK);
  if (!existsSync(file)) {
    throw new Error(`no vault has ever been deployed on ${NETWORK} from this machine, so there is nothing to pay out of.`);
  }
  const registry = parseVaultRegistry(JSON.parse(readFileSync(file, 'utf8')), NETWORK);
  /*
   * **THE NAME BECOMES A VAULT IN ONE PLACE, AND A RETIRED VAULT IS REFUSED
   * THERE.** Every door needs an address and the record is the only place an
   * address is, so the lookup is the thing every path has in common -- which is
   * why the refusal lives inside it rather than being remembered here.
   */
  return theVault(registry, name);
}

const readJson = (file: string, what: string, door: string): any => {
  if (!existsSync(file)) throw new Error(`there is no ${what} on this machine. ${door}`);
  return JSON.parse(readFileSync(file, 'utf8'));
};

const readJsonIfThere = (file: string): any => {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

/**
 * **ONE COPY OF THIS DOOR AT A TIME FOR ONE VAULT, FOR THE WHOLE RUN.**
 *
 * Two copies working one record would each try every step, and the one that
 * loses stops and tells a person to run again after the other has paid and
 * moved the record aside, which starts a new payment. **And a private payment
 * has a second reason**: both would rewrite the same note pool, and the second
 * write is built on a version the first has already moved past.
 */
let heldLock: string | null = null;
const takeTheLock = (file: string): void => {
  try {
    writeFileSync(file, `${process.pid} ${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' });
  } catch (e: any) {
    if (e?.code === 'EEXIST') {
      throw new Error(
        `another copy of this door is paying out of this vault, or one stopped without releasing ${file.replace(ROOT + '/', '')}. `
        + 'Nothing was proposed, approved or paid by this run. If no other copy is running, move that file '
        + 'aside and run the door again with the same answers.');
    }
    throw e;
  }
  heldLock = file;
};
const releaseTheLock = (): void => {
  if (heldLock === null) return;
  try { unlinkSync(heldLock); } catch { /* reported by its absence on the next run */ }
  heldLock = null;
};

/**
 * **CREATED EXCLUSIVELY: A SECOND RUN CANNOT WRITE A SECOND RECORD OVER THE
 * FIRST.** Two runs started together would each write a record with its own
 * seed and salt, and each would propose, approve and pay a different leaf,
 * which the account records as two payments.
 */
const createRecord = (file: string, record: PayoutRecord): void => {
  try {
    writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
  } catch (e: any) {
    if (e?.code === 'EEXIST') {
      throw new Error(
        'another run of this door created a payment record for this vault a moment ago. Nothing was '
        + 'proposed, approved or paid by this run. Let that run finish, then run this door again.');
    }
    throw e;
  }
};

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function main(): Promise<number> {
  say('────────────────────────────────────────────────────────────');
  say(`  Paying private money out of a vault on ${NETWORK}`);
  say('────────────────────────────────────────────────────────────');
  say();
  say('  THIS RUN SPENDS FEES AND MOVES MONEY. It proposes a payment on the account,');
  say('  approves it, and spends one of the vault\x27s notes, stopping at the first refusal.');

  /*
   * **THIS IS DEFENCE IN DEPTH AND NOT THE THING THAT HOLDS THE PROPERTY, AND
   * SAYING SO IS THE POINT.**
   *
   * What holds it is `theNetwork` above: the registry and this door read
   * the same compiled constant, so as the two are wired today this call cannot
   * fail. **It is here for the day one of them stops reading that constant** -
   * a door given its network another way, a registry taught to take one - which
   * is a change somebody makes for an unrelated reason and does not think of as
   * touching assets at all. Then this is what refuses.
   */
  refuseATestAssetOffItsNetwork(assets.all(), NETWORK);

  /* -------------------------------------------------- 1 */
  clock.begin(1, 6, 'Which vault, and whether it can make a private payment at all');
  if (!VAULT_NAME) throw new Error('no vault name was given, and there is deliberately no default.');
  assertVaultName(VAULT_NAME);
  const entry = vaultFromRegistry(VAULT_NAME);
  vaultAddress = entry.contractAddress.toLowerCase();
  good(`vault "${VAULT_NAME}", deployed ${entry.deployedAt}. Its address is not printed.`);
  assertVaultCanPayPrivately(entry);
  good('the record says this vault carries payout, the private payment circuit');
  const accountRecord = readJson(ACCOUNT_RECORD, `account deployed on ${NETWORK}`, 'Deploy one first.');
  assertVaultIsMarriedTo(entry, accountRecord);
  accountAddress = String(accountRecord.contractAddress).toLowerCase();
  good('this vault is married to the account deployed on this network');
  const view = readJson(VIEW_FILE, "account's saved view", 'Deploying the account writes it.');
  if (!/^[0-9a-f]{64}$/i.test(String(view?.assetBlinding ?? ''))) {
    throw new Error(`${VIEW_FILE.replace(ROOT + '/', '')} carries no asset blinding, so no proposal this machine raised would match what the account holds.`);
  }
  const signersFile = previewSignersFile(STATE_DIR, NETWORK, ACCOUNT_ID);
  const signers = parsePreviewSigners(readJson(signersFile, 'test signer file for this account', 'Deploying the account writes it.'), signersFile);
  good(`${PREVIEW_SIGNER_IDS.length} test signers are on this machine: ${PREVIEW_SIGNER_IDS.join(', ')}`);
  for (const [circuit, dir] of [['propose', ACCOUNT_ARTEFACTS], ['approve', ACCOUNT_ARTEFACTS], ['recordPayment', ACCOUNT_ARTEFACTS], ['payout', VAULT_ARTEFACTS]] as const) {
    if (!existsSync(join(dir, 'keys', `${circuit}.prover`))) {
      throw new Error(
        `${join(dir, 'keys', `${circuit}.prover`).replace(ROOT + '/', '')} does not exist, so `
        + `${circuit} cannot be proved. Build the ${dir === VAULT_ARTEFACTS ? 'vault' : 'account'} keys first.`);
    }
  }
  good('the proving keys for propose, approve, recordPayment and payout are on disk');

  /* -------------------------------------------------- 2 */
  clock.begin(2, 6, 'Who is paid, in what, how much, and the record that lets this be finished');
  const payee = assertPrivatePayee(payeeOf(PAY_TO, NETWORK as never));
  const amount = amountFromText(PAY_AMOUNT);
  const reference = referenceFromText(PAY_REFERENCE);
  /*
   * **THE ASSET IS NOT ASKED FOR.** Exactly one enabled asset has a private
   * form, so there is nothing to choose; `theAssetPaidPrivately` refuses on
   * none and on more than one rather than picking.
   */
  const asset = theAssetPaidPrivately(assets);
  const ASSET = asset.code;
  payeePaid = payee.bech32;
  good(`paying ${shortPayee(payee)}, a private address on ${NETWORK}`);
  good(`${amount.toLocaleString()} of ${ASSET} in its smallest unit (${formatAmount(amount, asset)} ${ASSET})`);
  note('NOTHING ABOUT THIS PAYMENT GOES ON A PUBLIC RECORD: not the payee, not the amount and');
  note('not the asset. What is in the clear is this vault\x27s address, that a payment circuit');
  note('was called on it, when, and for what fee.');
  const transfer = transferOf({
    accountId: `vault:${VAULT_NAME}`, payee, asset: ASSET, amount, privacy: privacyOf(payee), reference,
    createdBy: 'the operator paying out of this vault', employees: [],
  });
  note('THE PAYROLL ROSTER CHECK IS NOT MADE HERE: this machine holds no roster. Pay only an');
  note('address the company owns.');
  const facts = transferFacts(transfer);
  const colour = checkTheColourWasMinted(facts.token, readJsonIfThere(testTokenFile(STATE_DIR, NETWORK)));
  if (colour.of === 'agrees') {
    good(`the colour this payment names is the one the mint on this machine recorded`);
  } else {
    warn(`the colour could not be checked against a mint: ${colour.why}`);
  }

  /*
   * **THE ASSET AND THE TOKEN ARE PART OF THE ASK, AND THAT IS NOT PAPERWORK.**
   *
   * This door DERIVES its asset from the registry on every run. A leaf commits
   * to the token, so a record resumed after the registry's answer changed would
   * build a different leaf, see its own proposal as absent, and propose a
   * SECOND time while the first is open, approved and payable. The account
   * records payments per leaf and would not refuse it.
   */
  const ask = {
    network: NETWORK, vault: VAULT_NAME, payTo: payee.bech32, amount, reference,
    asset: ASSET, token: facts.token,
  };
  const recordFile = recordFileFor(VAULT_NAME);
  takeTheLock(recordFile.replace(/\.json$/, '.lock'));
  let record: PayoutRecord;
  if (existsSync(recordFile)) {
    record = payoutRecordFromText(readFileSync(recordFile, 'utf8'), recordFile.replace(ROOT + '/', ''));
    /*
     * **STRICT, AND THIS IS THE DOOR THE STRICTNESS IS FOR.** The asset here is
     * derived from the registry on every run, so a record written before the
     * token was kept cannot be shown to settle in the same money this run
     * would - and a leaf commits to the token.
     */
    assertRecordIsThisPayment(record, ask, true);
    good(`finishing the payment recorded ${record.createdAt}`);
  } else {
    const prefix = finishedRecordPrefix(`${NETWORK}-vault-private-payout-${VAULT_NAME}.json`);
    const finished = readdirSync(STATE_DIR).filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
      .map((n) => payoutRecordFromText(readFileSync(join(STATE_DIR, n), 'utf8'), `.midnight/${n}`));
    assertNotAlreadyPaid(finished, ask, BigInt(Math.floor(Date.now() / 1000)));
    record = newPayoutRecord(
      ask, () => randomBytes(32).toString('hex') as Hex, BigInt(Math.floor(Date.now() / 1000)), new Date().toISOString());
    createRecord(recordFile, record);
    good(`recorded before any fee: ${recordFile.replace(ROOT + '/', '')}`);
  }
  liveRecord = { file: recordFile, record };
  const built = runOf(record, facts, await vaultDetailsOf(), ACCOUNT_ID);
  const vaultBytes = fromHex(vaultAddress as Hex);
  const proposalId = accountCircuits.proposalIdOf(
    accountCircuits.runPayload(fromHex(built.run.tree.root), built.run.tree.payees, built.opensAt, built.closesAt),
    vaultBytes, fromHex(record.salt));
  const movement = accountCircuits.paidMovementOf(fromHex(built.args.leaf));
  note(`the window: ${new Date(Number(built.opensAt) * 1000).toISOString()} to ${new Date(Number(built.closesAt) * 1000).toISOString()}`);
  note(`the proposal this run is identified by on chain: ${toHex(proposalId).slice(0, 16)}…`);

  /* -------------------------------------------------- 3 */
  clock.begin(3, 6, 'The note pool, the network, the proof server and the wallet');

  /*
   * **THE POOL IS OPENED BEFORE ANY FEE, BECAUSE A PAYMENT WITHOUT IT IS NOT A
   * PAYMENT THAT CAN BE MADE.** Nothing on chain says what a note is, only that
   * a commitment exists, so the pool is the record of the money and the payment
   * rewrites it.
   */
  const poolFile = vaultPoolFile(STATE_DIR, NETWORK, VAULT_NAME);
  const store = new FileSealedPoolStore(poolFile, entry.contractAddress);
  const sealed = await store.get(entry.contractAddress);
  if (!sealed) {
    throw new Error(
      `this vault has no note pool: ${poolFile.replace(ROOT + '/', '')} does not exist. Nothing on `
      + 'chain says what a note is, only that a commitment exists, so a vault with no pool has no '
      + 'private money this machine can name and no payment out of it can be built.');
  }
  good(`the pool record is present, version ${sealed.version}, wrapped for ${sealed.wrapped.length} signer(s)`);
  const poolSignersFile = join(STATE_DIR, `vault-pool-signers-${VAULT_NAME}.json`);
  if (!existsSync(poolSignersFile)) {
    throw new Error(
      `${poolSignersFile.replace(ROOT + '/', '')} does not exist, and a private payment REWRITES `
      + 'the pool: it is sealed afresh and wrapped to the signers this run is told about. Without '
      + 'that file this run would have nobody to wrap it to, and a pool wrapped to nobody is '
      + 'ciphertext with no key in the world.');
  }
  const poolSigners = JSON.parse(readFileSync(poolSignersFile, 'utf8')) as PoolSigner[];
  assertNoSignerIsDropped(sealed.wrapped.map((w) => w.signerId), poolSigners.map((s) => s.id));
  good(`the pool will be re-sealed to all ${poolSigners.length} signer(s) it is wrapped for now`);
  if (!existsSync(SIGNER_SECRETS)) {
    throw new Error(
      `${SIGNER_SECRETS.replace(ROOT + '/', '')} does not exist, so this machine holds no signer `
      + 'secret and cannot open the pool. A real signer\x27s secret half is made on that person\x27s '
      + 'own device and never leaves it; this path is a test one.');
  }
  const secrets = JSON.parse(readFileSync(SIGNER_SECRETS, 'utf8'))?.signers ?? {};
  const chosen = chooseOpener(sealed.wrapped.map((w) => w.signerId), poolSigners, secrets);
  good(`opening the pool as "${chosen.id}" — its public half is the one the signers file publishes`);
  const pool = new SealedNotePool(
    store, { signerId: chosen.id, wrappingSecret: chosen.wrappingSecret }, async () => poolSigners);

  await applyNetworkId(NETWORK);
  const logger = createDefaultTestLogger();
  const { env, how } = testEnvironmentFor(NETWORK, logger);
  note(`network ${NETWORK}, ${how}`);
  const cfg = await startEnvironment(env, new StaticProofServerContainer(PROVER_PORT), note);
  good(`indexer ${cfg.indexer}`);
  good(`prover  ${cfg.proofServer}`);
  if (!existsSync(SEED_FILE)) throw new Error('there is no funded wallet on this machine, so nothing can pay the fees.');
  const masterSeed = readFileSync(SEED_FILE, 'utf8').trim();
  const live = await bringUpWallet(logger, cfg, masterSeed, NETWORK, ROOT, { withDust: true, requireDust: true, onNote: note });
  const wallet: any = live.wallet;
  good(`wallet ready: NIGHT ${live.night().toLocaleString()}, DUST ${live.dust().toLocaleString()}`);
  note('every fee in this run comes out of this wallet, never out of the vault');
  await saveDustState(wallet, masterSeed, NETWORK, ROOT);

  const privateStateProvider: any = levelPrivateStateProvider({
    accountId: PRIVATE_STATE_ID, privateStateStoreName: PRIVATE_STATE_ID,
    privateStoragePasswordProvider: async () => PRIVATE_STATE_PASSWORD,
  } as any);
  const publicDataProvider: any = indexerPublicDataProvider(cfg.indexer, cfg.indexerWS);
  const accountZk = new NodeZkConfigProvider<string>(ACCOUNT_ARTEFACTS);
  const vaultZk = new NodeZkConfigProvider<string>(VAULT_ARTEFACTS);
  const accountProviders: any = {
    zkConfigProvider: accountZk,
    proofProvider: httpClientProofProvider(cfg.proofServer, accountZk),
    privateStateProvider, publicDataProvider, walletProvider: wallet, midnightProvider: wallet,
  };
  /*
   * A VAULT PAYMENT PROVES TWO CONTRACTS' CIRCUITS: the vault's own, and the
   * account's `recordPayment` that it calls, so the proof provider is given
   * both sources of keys.
   */
  const vaultProviders: any = {
    zkConfigProvider: vaultZk,
    proofProvider: httpClientProofProvider(cfg.proofServer, new ZKConfigRegistry([vaultZk, accountZk]) as any),
    privateStateProvider, publicDataProvider, walletProvider: wallet, midnightProvider: wallet,
  };
  const vaultCompiled = CompiledContract.make('Vault', VaultContract as any).pipe(
    CompiledContract.withCompiledFileAssets(VAULT_ARTEFACTS as never)) as any;
  /*
   * **THE VAULT ON CHAIN IS RESOLVED NOW, BEFORE ANY FEE.**
   *
   * The payment is the LAST of three transactions. A vault whose deployed
   * verifier keys differ from the ones on this disk, or whose ledger is a
   * different shape from the one this build compiled, would otherwise be found
   * only then - after a proposal and its approvals had been proved and paid
   * for, and with a proposal left open on chain.
   */
  const { findDeployedVaultContract } = await import('../src/midnight/vault-contract.js');
  const { witnessesWithoutAPool } = await import('../src/midnight/vault-notes.js');
  const VaultCompiledContract = ((await import('@midnight-ntwrk/compact-js')) as any).CompiledContract;
  await findDeployedVaultContract(vaultProviders, {
    compiledContract: VaultCompiledContract.withWitnesses(vaultCompiled, witnessesWithoutAPool()),
    contractAddress: vaultAddress!,
  });
  good('found the vault on chain: its verifier keys match these, and so does its ledger shape');

  const vaultLedger = new VaultLedger(
    { networkId: NETWORK } as never, {} as never, async () => vaultProviders, vaultCompiled, pool, VAULT_ARTEFACTS);
  const events = indexerNoteEvents(cfg.indexer);

  const becomeSigner = async (id: (typeof PREVIEW_SIGNER_IDS)[number]) => {
    privateStateProvider.setContractAddress?.(accountAddress);
    await privateStateProvider.set(PRIVATE_STATE_KEY, {
      ...signerBytes(signers[id]),
      scope: accountCircuits.allVaults(),
      assetId: assetIdBytes(ASSET),
      assetBlinding: fromHex(String(view.assetBlinding).toLowerCase() as Hex),
      proposalSalt: fromHex(record.salt),
      changeAmount: amount,
      changeBatchDigest: fromHex(batchDigestOf(record)),
      pinnedPath: null,
    });
  };
  await becomeSigner('A');
  const accountCompiled = CompiledContract.make('ConfidentialAccount', AccountContract as any).pipe(
    CompiledContract.withWitnesses(accountWitnesses as any),
    CompiledContract.withCompiledFileAssets(ACCOUNT_ARTEFACTS as never)) as any;
  const { findDeployedPartialContract } = await import('../src/midnight/partial-contract.js');
  const account: any = await findDeployedPartialContract(accountProviders, {
    compiledContract: accountCompiled, contractAddress: accountAddress!, privateStateId: PRIVATE_STATE_KEY,
  });
  good('found the account on chain, and its verifier keys match these');

  const gql = async (query: string): Promise<any> => {
    const res = await withTimeout('the indexer', 20_000, fetch(cfg.indexer, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
    }));
    return res.json();
  };
  const readChain = async () => {
    const chainFacts = await readChainOnce();
    lastReadPaid = chainFacts.paid;
    return chainFacts;
  };
  async function readChainOnce() {
    const st = await publicDataProvider.queryContractState(accountAddress);
    if (!st) throw new Error('the indexer has no state for the account. Nothing was spent by this read; run the door again.');
    const l: any = readAccountLedger(st.data);
    const open = Boolean(l.openProposals.member(proposalId));
    const tip = await gql('query { block { height timestamp } }');
    const ts = tip?.data?.block?.timestamp;
    return {
      paid: Boolean(l.movements.member(movement)),
      proposalOpen: open,
      approvals: open ? BigInt(l.approvalCounts.lookup(proposalId)) : 0n,
      needed: approvalsNeeded(BigInt(l.threshold), l.thresholds.member(vaultBytes) ? BigInt(l.thresholds.lookup(vaultBytes)) : null),
      blockSeconds: blockSecondsOf(Number(ts)),
      opensAt: built.opensAt,
      closesAt: built.closesAt,
    };
  }

  /* -------------------------------------------------- 4 */
  clock.begin(4, 6, 'Whether a note can be spent at all, asked before the first fee');

  /*
   * **THE QUESTION THAT IS ONLY ASKED HERE.** The client refuses an unspendable
   * note twice - once when the payment is fitted and once at the spend - and
   * both of those are after a proposal and its approvals have been paid for.
   * Asked here, a run that cannot end in a payment does not begin with two fees.
   */
  const inThePool = await pool.load(vaultAddress!);
  note(`the pool holds ${inThePool.notes.length} note(s) for this vault`);
  assertANoteCanBeSpent(inThePool.notes, facts.token, amount, ASSET);
  good('one of them is this colour, large enough, and records the transaction that created it');

  let before: bigint | null = null;
  try {
    before = await vaultLedger.balance(vaultAddress!, facts.token);
    good(`the vault holds ${before.toLocaleString()} of ${ASSET} in notes the chain agrees with`);
  } catch (e: any) {
    warn(`what this vault holds privately could not be read before paying: ${String(e?.message ?? e).split('\n')[0]}`);
  }

  /* -------------------------------------------------- 5 */
  clock.begin(5, 6, 'Proposing, approving and paying, one step at a time from what the chain says');
  const { paidIn: paidTx } = await drive({
    readChain,
    holdsTheMoney: () => refuseWhatTheVaultCannotPay(chainVaultHoldings(vaultLedger), asksOf(vaultAddress!, asset, facts)),
    stillHoldsTheMoney: async () => {
      try {
        await vaultLedger.affordable(vaultAddress!, [{ payee, token: facts.token, amount }]);
      } catch (e) {
        throw refusalBeforePayment(e);
      }
    },
    propose: async () => {
      await becomeSigner('A');
      const res = await account.callTx.propose(
        ZERO_32, fromHex(built.run.tree.root), built.run.tree.payees, built.opensAt, built.closesAt, true, vaultBytes);
      return `as signer A, transaction ${String(res?.public?.txId ?? '(no id in the answer)')}`;
    },
    approve: async (who) => {
      note('signers approve in the order A, B, C. If anybody else approved this proposal, the count');
      note('no longer says which signers have, and the chain will refuse a second approval from one.');
      await becomeSigner(who);
      const res = await account.callTx.approve(proposalId);
      return `transaction ${String(res?.public?.txId ?? '(no id in the answer)')}`;
    },
    pay: async () => {
      /*
       * **THE EVENTS SOURCE IS THE FOURTH ARGUMENT AND IT IS NOT OPTIONAL
       * HERE.** A note is spent at the place the chain filed it, read from the
       * transaction that created it, just before the spend rather than earlier:
       * an index read at the start of this run and used at the end would be a
       * number that was true once.
       */
      const paid = await vaultLedger.payout(
        vaultAddress!, vaultPaymentOf(record, built, toHex(proposalId) as Hex), BY, events);
      try {
        const fin: any = await withTimeout('the finalized payment', 120_000, publicDataProvider.watchForTxData(paid.ref));
        note(`fee paid ${String(fin?.fees?.paidFees ?? '(not in the answer)')}, block ${String(fin?.blockHeight ?? '?')}, status ${String(fin?.status ?? '?')}`);
      } catch (e: any) {
        warn(`the finalized payment could not be read back: ${String(e?.message ?? e).split('\n')[0]}. The chain is read next.`);
      }
      return paid.ref;
    },
    wait: sleep,
    say: note,
  }, PREVIEW_SIGNER_IDS);

  /* -------------------------------------------------- 6 */
  clock.begin(6, 6, 'What the chain says now');
  const final = await readChain();
  if (!final.paid) {
    throw new Error('the sequence ended and the account does not show this payment as recorded. Run the door again with the same answers; it continues from what the chain says.');
  }
  let after: bigint | null = null;
  /**
   * **WHY THE READING FAILED IS NOT THE SAME QUESTION AS WHETHER IT FAILED.**
   *
   * An indexer a moment behind a payment is the ordinary case and means
   * nothing. **A pool that disagrees with the chain after a payment is the
   * opposite**: it says a note reached this vault, or left it, that this
   * machine has no record of, and the record of the money is the pool. Reported
   * as the same outcome, the second reads as the first and somebody closes the
   * window on it.
   */
  let whyNotRead: string | null = null;
  let poolAndChainDisagree = false;
  try {
    after = await vaultLedger.balance(vaultAddress!, facts.token);
  } catch (e: any) {
    whyNotRead = String(e?.message ?? e).split('\n')[0] ?? null;
    poolAndChainDisagree = String(e?.name ?? '') === 'VaultPoolDisagreesWithChain';
    warn(`what this vault holds privately could not be read after paying: ${whyNotRead}`);
  }
  const left = await pool.load(vaultAddress!).then((p) => p.notes.length, () => null);
  say();
  say('  \x1b[1mWHAT THE CHAIN SAYS NOW\x1b[0m');
  say(`    the account has recorded this payment    ${final.paid ? 'YES' : 'NO'}`);
  say(`    the vault's ${ASSET} before this run       ${before === null ? '(not read)' : before.toLocaleString()}`);
  say(`    the vault's ${ASSET} now                   ${after === null ? '(not read)' : after.toLocaleString()}`);
  const moved = publicMovementOf(before, after, amount);
  say(`    what those two numbers say               ${moved}`);
  say(`    notes in the pool now                    ${left === null ? '(not read)' : left}`);
  if (paidTx) say(`    the payment's transaction                ${paidTx}`);
  say();
  /*
   * **THOSE TWO NUMBERS ARE NOT THE CHAIN SPEAKING, AND SAYING SO IS THE POINT.**
   *
   * A shielded note publishes no value: the chain holds a commitment and
   * nothing else. So both figures are this client's own arithmetic over its
   * pool, admitted only after the chain's commitment SET has been reconciled
   * against it. The chain's own word on this payment is the line above them -
   * the account has recorded it - and that is the one that settles whether it
   * happened.
   */
  say('    The two figures above are this machine\x27s own record of the notes, checked against');
  say('    the chain\x27s set of commitments. A shielded note publishes no value, so no reading');
  say('    of the chain can give an amount. What the chain says about this payment is the');
  say('    first line: the account has recorded it.');
  say('    The payee\x27s own balance is not read by this door, and it cannot be: a note');
  say('    addressed to them is readable by them and by nobody else. Their wallet shows it.');
  const finishedFile = finishedRecordFile(recordFile, record);
  renameSync(recordFile, finishedFile);
  liveRecord = null;
  note(`the finished record is kept at ${finishedFile.replace(ROOT + '/', '')}`);
  if (!paidTx) {
    say();
    say('  THIS PAYMENT WAS ALREADY MADE BY AN EARLIER RUN. Nothing was paid by this one, so the two');
    say('  balances above say nothing about it.');
    return 4;
  }
  /*
   * **A READING THAT COULD NOT BE TAKEN IS NOT A MISMATCH, AND IT IS THE
   * ORDINARY CASE HERE.**
   *
   * `balance` refuses unless the chain's commitment set agrees with the pool,
   * and the indexer routinely lags a payment by a moment - so the read
   * immediately after one fails more often than not. Reported as `3` it would
   * tell a person their payment did not move the money, which is a different
   * and alarming claim. The account has recorded the payment either way, and
   * that is what the line above says.
   */
  if (poolAndChainDisagree) {
    say();
    say('  THE PAYMENT IS RECORDED AND THIS MACHINE\x27S RECORD OF THE MONEY NO LONGER AGREES WITH');
    say('  THE CHAIN. That is not the indexer being behind. It says the chain holds notes for this');
    say('  vault that the pool does not, or the other way round, and the pool is the record of the');
    say(`  money. What the read said: ${whyNotRead ?? '(no reason given)'}`);
    say('  Do not pay out of this vault again until the pool has been rebuilt from the chain.');
    return 6;
  }
  if (moved === 'not-read') {
    say();
    say('  THE PAYMENT IS RECORDED AND THE NOTES COULD NOT BE READ BACK. That is usually the');
    say('  indexer not having caught up with the payment yet, and it is not a claim that the');
    say('  money did not move. Nothing is wrong that another reading will not answer.');
    say(`  What the read said: ${whyNotRead ?? '(no reason given)'}`);
    return 5;
  }
  return moved === 'left-the-vault' ? 0 : 3;
}

/* ------------------------------------------------------------------ *
 * the refusal
 * ------------------------------------------------------------------ */

function fail(e: any): never {
  /*
   * **THE PAYEE IS REDACTED HERE TOO, AND THAT IS NOT THE SAME AS THE PUBLIC
   * DOOR'S TWO ADDRESSES.** On a refusal the whole error object is printed, and
   * on the stranded-note path it carries note nonces; a nonce with a colour and
   * a value reproduces the commitment the chain holds. The settlement gives
   * none of this away, so a transcript that does would be the only place it
   * leaked.
   */
  const redact = (text: string): string => [vaultAddress, accountAddress, payeePaid].reduce(
    (t, a) => (a ? t.split(a).join('[withheld]') : t), text);
  const out = (text: string) => console.log(redact(text));
  out('');
  out(`\x1b[31m\x1b[1m  Stopped during: ${clock.stage}\x1b[0m`);
  out(describeError(e, explainNodeError).split('\n').map((l) => '  ' + l).join('\n'));
  clock.print('stopped');
  console.log();
  console.log('  \x1b[1mThe error object, whole: bounded, and it says what it dropped\x1b[0m');
  const serialised = serialiseWholeDetailed(e);
  out(serialised.text.split('\n').map((l) => '    ' + l).join('\n'));
  /*
   * THROUGH `redact`, NOT `console.log`. A repeated error's message is moved
   * into what was dropped and printed here verbatim; the dump above is
   * redacted and this line was not, so the one place a payee could reach the
   * screen was the line describing what had been left out.
   */
  for (const line of describeDropped(serialised.dropped)) out(`    ${line}`);
  console.log();
  if (lastReadPaid) {
    if (liveRecord && existsSync(liveRecord.file)) {
      try {
        renameSync(liveRecord.file, finishedRecordFile(liveRecord.file, liveRecord.record));
        console.log('  The payment record has been moved aside as finished.');
      } catch (moveError: any) {
        console.log(`  The payment record could not be moved aside as finished: ${String(moveError?.message ?? moveError)}`);
      }
    }
    console.log('  \x1b[1mTHE ACCOUNT HAS ALREADY RECORDED THIS PAYMENT.\x1b[0m');
    console.log('  DO NOT RUN THIS DOOR AGAIN FOR IT: a new record would be a second payment.');
    releaseTheLock();
    process.exit(4);
  }
  releaseTheLock();
  console.log('  Whatever was proposed, approved or paid before this stop is on chain. Running the door');
  console.log('  again with the same answers reads how far it got and continues from there.');
  process.exit(1);
}

const RUN_DIRECTLY = typeof process.argv[1] === 'string' && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (RUN_DIRECTLY) main().then((code) => { releaseTheLock(); clock.print('finished'); process.exit(code); }, fail);
