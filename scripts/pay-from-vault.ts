/**
 * **PAYS PUBLIC MONEY OUT OF A VAULT, TO AN ADDRESS, AND READS WHAT HAPPENED OFF
 * THE CHAIN.**
 *
 * Run it through the door beside it that asks for these answers. Every rule it applies is in
 * `pay-from-vault-rules.ts`, where it is tested; this file connects those rules
 * to a wallet, a proof server, the account and the vault.
 *
 * ------------------------------------------------------------------------
 * **WHAT A PAYMENT OUT OF A VAULT IS.** Three kinds of transaction, each paid for
 * by the wallet on this machine, never by the vault:
 *
 *   1. propose   a run on the ACCOUNT: a root over one payee's leaf, one payee,
 *                and a window. Signer A's key is the witness.
 *   2. approve   by as many signers as the vault's threshold, in order A, B, C.
 *   3. pay       `payoutUnshielded` on the VAULT, which asks the account across the
 *                contract boundary whether this leaf is in an approved run, inside
 *                its window, and not yet paid, and only then sends the money.
 *
 * Before step 1 the vault is asked, through the chain's own reads, whether it
 * holds the amount; a vault that does not is refused before any fee. Before step
 * 3 it is asked again, because a balance can move between a proposal and a
 * payment.
 *
 * **IT CAN STOP BETWEEN ANY TWO STEPS AND BE RUN AGAIN.** Everything a payment
 * needs that the chain cannot give back is written to a record before the first
 * fee. A second run with the same answers reads the chain, finds how far the
 * first got, and does the next thing. It never proposes twice for one record and
 * it never pays a leaf the account has already recorded.
 *
 * ------------------------------------------------------------------------
 * **WHAT THIS MACHINE HOLDS THAT A COMPANY'S MACHINE WOULD NOT.** Test signers,
 * whose secret keys are in a file beside the wallet, so one process can approve
 * as several people. A real signer's key never leaves their device. This door is
 * for a test network and says so.
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
import { VaultLedger, type NotePool } from '../src/midnight/vault-ledger.js';
import { chainVaultHoldings } from '../src/midnight/vault-holdings.js';
import { vaultDetailsOf } from '../src/midnight/vault-details.js';
import { refuseWhatTheVaultCannotPay } from '../src/core/vault-holdings.js';
import { assertVaultName, vaultRegistryFile, parseVaultRegistry, type VaultEntry } from '../src/midnight/vault-record.js';
import { applyNetworkId, theNetwork } from '../src/midnight/network.js';
import { payeeOf, shortPayee } from '../src/midnight/payee-address.js';
import { privateStateKey } from '../src/midnight/ledger.js';
import { transferOf, transferFacts, privacyOf } from '../src/core/movement.js';
import { assets, assetIdBytes, formatAmount } from '../src/core/assets.js';
import { fromHex, toHex, type Hex } from '../src/core/crypto.js';
import type { SignerRef } from '../src/core/ledger.js';
import { explainNodeError } from './node-errors.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';
import { bringUpWallet } from './wallet-bringup.js';
import { saveDustState } from './dust-wallet.js';
import { serialiseWholeDetailed, describeDropped } from './error-report.js';
import { createScreen, phaseClock, withTimeout, describeError } from './deploy-report.js';
import { previewSignersFile, parsePreviewSigners, signerBytes, PREVIEW_SIGNER_IDS } from './preview-signers.js';
import { assertColoursAgree } from './transfer-from-vault.js';
import {
  amountFromText, referenceFromText, assertPublicPayee, assertVaultCanPayPublicly, assertVaultIsMarriedTo,
  blockSecondsOf, newPayoutRecord, payoutRecordFromText, assertNotAlreadyPaid, assertRecordIsThisPayment,
  finishedRecordFile, finishedRecordPrefix, runOf, vaultPaymentOf,
  asksOf, batchDigestOf, approvalsNeeded, publicMovementOf, drive, refusalBeforePayment,
  type PayoutRecord,
} from './pay-from-vault-rules.js';

/* ------------------------------------------------------------------ */

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, '.midnight');
const SEED_FILE = join(STATE_DIR, 'wallet.seed');
const NETWORK = theNetwork();
const ACCOUNT_RECORD = join(STATE_DIR, `${NETWORK}-contract.json`);
const VIEW_FILE = join(STATE_DIR, `${NETWORK}-view.json`);
const ACCOUNT_ARTEFACTS = join(ROOT, 'contracts', 'managed');
const VAULT_ARTEFACTS = join(ROOT, 'contracts', 'managed-vault');
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT || 6301);
const PRIVATE_STATE_ID = `confidential-accounts-${NETWORK}`;
const PRIVATE_STATE_PASSWORD = process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD || 'ConfidentialAccounts-Dev-2026';
/** The account every test door on this machine deploys and runs against. */
const ACCOUNT_ID = 'default';
const PRIVATE_STATE_KEY = privateStateKey(PRIVATE_STATE_ID, ACCOUNT_ID);
const ASSET = 'NIGHT';

const VAULT_NAME = (process.env.VAULT_NAME ?? '').trim();
const PAY_TO = (process.env.PAY_TO ?? '').trim();
const PAY_AMOUNT = (process.env.PAY_AMOUNT ?? '').trim();
const PAY_REFERENCE = (process.env.PAY_REFERENCE ?? '').trim();

const ZERO_32 = new Uint8Array(32);

const recordFileFor = (name: string) => join(STATE_DIR, `${NETWORK}-vault-payout-${name}.json`);

/** Who is acting, for the client's own records. The chain attributes nothing. */
const BY: SignerRef = { signerId: 'the operator paying out of this vault', leaf: '' } as unknown as SignerRef;

/* ------------------------------------------------------------------ *
 * the report
 * ------------------------------------------------------------------ */

let vaultAddress: string | null = null;
/** What the chain last said about this payment, so a stop after it was paid does not advise paying again. */
let lastReadPaid = false;
/** The record this run is working, until it is moved aside as finished. */
let liveRecord: { file: string; record: PayoutRecord } | null = null;
let accountAddress: string | null = null;

const say = createScreen(() => [
  ...(vaultAddress ? [{ what: "the vault's address", value: vaultAddress }] : []),
  ...(accountAddress ? [{ what: "the account's address", value: accountAddress }] : []),
]);
const clock = phaseClock(say);
const note = (s: string) => say(`  ${s}`);
const good = (s: string) => say(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s: string) => say(`  \x1b[33m■\x1b[0m ${s}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** A public payment reads no note and writes none, so the pool it is given refuses every use. */
const refusingPool = (): NotePool => {
  const refuse = (verb: string) => async (): Promise<never> => {
    throw new Error(
      `a public payment asked the note pool to ${verb}. Public money is a ledger balance: the public `
      + 'payment circuit reads no note and writes none, so nothing is substituted here.');
  };
  return { load: refuse('load'), save: refuse('save'), create: refuse('create') } as NotePool;
};

function vaultFromRegistry(name: string): VaultEntry {
  const file = vaultRegistryFile(STATE_DIR, NETWORK);
  if (!existsSync(file)) {
    throw new Error(`no vault has ever been deployed on ${NETWORK} from this machine. DEPLOY-VAULT.command deploys one.`);
  }
  const registry = parseVaultRegistry(JSON.parse(readFileSync(file, 'utf8')), NETWORK);
  const entry = registry.vaults[name];
  if (!entry) {
    const known = Object.keys(registry.vaults);
    throw new Error(
      `this company has no vault called "${name}" on ${NETWORK}. `
      + (known.length ? `The vaults it has are: ${known.join(', ')}.` : 'It has none on this network.'));
  }
  return entry;
}

const readJson = (file: string, what: string, door: string): any => {
  if (!existsSync(file)) throw new Error(`there is no ${what} on this machine. ${door} writes it.`);
  return JSON.parse(readFileSync(file, 'utf8'));
};

/**
 * **ONE COPY OF THIS DOOR AT A TIME FOR ONE VAULT, FOR THE WHOLE RUN.**
 *
 * Two copies working one record would each try every step, and the one that loses
 * stops and tells a person to run again after the other has paid and moved the
 * record aside, which starts a new payment. So the lock is taken before the record
 * is read and held until this process ends. A lock left by a crash names itself.
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
 * **CREATED EXCLUSIVELY: A SECOND RUN CANNOT WRITE A SECOND RECORD OVER THE FIRST.**
 * Two runs started together would otherwise each write a record with its own seed
 * and salt, and each would propose, approve and pay a different leaf, which the
 * account records as two payments. With an exclusive create the second run is
 * refused by the file system before it has a record, so before any fee. A record
 * cut short by a crash is not whole JSON, and the door refuses it by name.
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
  say(`  Paying public money out of a vault on ${NETWORK}`);
  say('────────────────────────────────────────────────────────────');
  say();
  say('  THIS RUN SPENDS FEES AND MOVES MONEY. It proposes a payment on the account,');
  say('  approves it, and pays it out of the vault, stopping at the first refusal.');

  /* -------------------------------------------------- 1 */
  clock.begin(1, 6, 'Which vault, and whether it can pay at all');
  if (!VAULT_NAME) throw new Error('no vault name was given, and there is deliberately no default.');
  assertVaultName(VAULT_NAME);
  const entry = vaultFromRegistry(VAULT_NAME);
  vaultAddress = entry.contractAddress.toLowerCase();
  good(`vault "${VAULT_NAME}", deployed ${entry.deployedAt}. Its address is not printed.`);
  assertVaultCanPayPublicly(entry);
  good('the record says this vault carries payoutUnshielded');
  const accountRecord = readJson(ACCOUNT_RECORD, `account deployed on ${NETWORK}`, 'DEPLOY-PREVIEW.command');
  assertVaultIsMarriedTo(entry, accountRecord);
  accountAddress = String(accountRecord.contractAddress).toLowerCase();
  good('this vault is married to the account deployed on this network');
  const view = readJson(VIEW_FILE, "account's saved view", 'DEPLOY-PREVIEW.command');
  if (!/^[0-9a-f]{64}$/i.test(String(view?.assetBlinding ?? ''))) {
    throw new Error(`${VIEW_FILE.replace(ROOT + '/', '')} carries no asset blinding, so no proposal this machine raised would match what the account holds. DEPLOY-PREVIEW.command writes it.`);
  }
  const signersFile = previewSignersFile(STATE_DIR, NETWORK, ACCOUNT_ID);
  const signers = parsePreviewSigners(readJson(signersFile, 'test signer file for this account', 'DEPLOY-PREVIEW.command'), signersFile);
  good(`${PREVIEW_SIGNER_IDS.length} test signers are on this machine: ${PREVIEW_SIGNER_IDS.join(', ')}`);
  for (const [circuit, dir] of [['propose', ACCOUNT_ARTEFACTS], ['approve', ACCOUNT_ARTEFACTS], ['recordPayment', ACCOUNT_ARTEFACTS], ['payoutUnshielded', VAULT_ARTEFACTS]] as const) {
    if (!existsSync(join(dir, 'keys', `${circuit}.prover`))) {
      throw new Error(`${join(dir, 'keys', `${circuit}.prover`).replace(ROOT + '/', '')} does not exist, so ${circuit} cannot be proved. ${dir === VAULT_ARTEFACTS ? 'COMPILE-VAULT.command' : 'BUILD-KEYS.command'} builds it.`);
    }
  }
  good('the proving keys for propose, approve, recordPayment and payoutUnshielded are on disk');

  /* -------------------------------------------------- 2 */
  clock.begin(2, 6, 'Who is paid, how much, and the record that lets this be finished');
  const payee = assertPublicPayee(payeeOf(PAY_TO, NETWORK as never));
  const amount = amountFromText(PAY_AMOUNT);
  const reference = referenceFromText(PAY_REFERENCE);
  const asset = assets.require(ASSET);
  good(`paying ${shortPayee(payee)}, a public address on ${NETWORK}`);
  good(`${amount.toLocaleString()} of ${ASSET} in its smallest unit (${formatAmount(amount, asset)} ${ASSET})`);
  note('A PUBLIC PAYMENT PUTS THE ADDRESS AND THE AMOUNT ON A RECORD ANYONE CAN READ.');
  const transfer = transferOf({
    accountId: `vault:${VAULT_NAME}`, payee, asset: ASSET, amount, privacy: privacyOf(payee), reference,
    createdBy: 'the operator paying out of this vault', employees: [],
  });
  note('THE PAYROLL ROSTER CHECK IS NOT MADE HERE: this machine holds no roster. Pay only an');
  note('address the company owns.');
  const facts = transferFacts(transfer);
  const { nativeToken } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  assertColoursAgree(facts.token, (nativeToken() as any).raw as Hex);
  good('the token this payment names is the ledger\'s own NIGHT, which is what a deposit puts in');

  /*
   * THE ASSET AND THE TOKEN GO INTO THE RECORD. This door's asset is a literal
   * and its token is a constant, so they can never differ between two runs of
   * one record here - they are recorded because the record is shared with a
   * door whose asset is derived, and a record that says what it was approved
   * for is worth more than one that has to be inferred.
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
     * **FALSE, AND THE ARGUMENT IS TWO LINES ABOVE.** This door's asset is the
     * literal `ASSET` and its token is the ledger's own constant for it, so no
     * run of it can settle a record in different money from the run that wrote
     * the record. A record from before the token was kept is therefore safe to
     * finish here, and refusing it would strand an approved proposal.
     */
    assertRecordIsThisPayment(record, ask, false);
    good(`finishing the payment recorded ${record.createdAt}`);
  } else {
    const prefix = finishedRecordPrefix(`${NETWORK}-vault-payout-${VAULT_NAME}.json`);
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
  clock.begin(3, 6, 'The network, the proof server and the wallet');
  await applyNetworkId(NETWORK);
  const logger = createDefaultTestLogger();
  const { env, how } = testEnvironmentFor(NETWORK, logger);
  note(`network ${NETWORK}, ${how}`);
  const cfg = await startEnvironment(env, new StaticProofServerContainer(PROVER_PORT), note);
  good(`indexer ${cfg.indexer}`);
  good(`prover  ${cfg.proofServer}`);
  if (!existsSync(SEED_FILE)) throw new Error('there is no funded wallet on this machine. DEPLOY-PREVIEW.command makes one.');
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
   * account's `recordPayment` that it calls. The proof provider finds a circuit's
   * keys by matching the verifier key the transaction names against each source it
   * is given, so it is given both. With the vault's keys alone, the account's
   * circuit inside the payment would have no key to prove with.
   */
  const vaultProviders: any = {
    zkConfigProvider: vaultZk,
    proofProvider: httpClientProofProvider(cfg.proofServer, new ZKConfigRegistry([vaultZk, accountZk]) as any),
    privateStateProvider, publicDataProvider, walletProvider: wallet, midnightProvider: wallet,
  };
  const vaultCompiled = CompiledContract.make('Vault', VaultContract as any).pipe(
    CompiledContract.withCompiledFileAssets(VAULT_ARTEFACTS as never)) as any;
  /*
   * THE VAULT'S DEPLOYED KEYS ARE CHECKED NOW, BEFORE ANY FEE. The payment is the
   * last of three transactions; a vault whose deployed keys differ from the ones on
   * this disk would otherwise be found only then, after a proposal and its
   * approvals had been paid for.
   */
  const { findDeployedVaultContract } = await import('../src/midnight/vault-contract.js');
  const { witnessesWithoutAPool } = await import('../src/midnight/vault-notes.js');
  const VaultCompiledContract = ((await import('@midnight-ntwrk/compact-js')) as any).CompiledContract;
  await findDeployedVaultContract(vaultProviders, {
    compiledContract: VaultCompiledContract.withWitnesses(vaultCompiled, witnessesWithoutAPool()),
    contractAddress: vaultAddress!,
  });
  good('found the vault on chain, and its verifier keys match these');
  const vaultLedger = new VaultLedger(
    { networkId: NETWORK } as never, {} as never, async () => vaultProviders, vaultCompiled, refusingPool(), VAULT_ARTEFACTS);

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
    const facts = await readChainOnce();
    lastReadPaid = facts.paid;
    return facts;
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
  /*
   * **AN ANSWER OF THREE KINDS, NOT A LIST.**
   *
   * This used to turn anything that was not an array into an empty one, and
   * print `(nothing)` for both. The two are opposite claims about a treasury:
   * an empty list is the chain saying this contract holds no public money, and
   * a null is the indexer having no contract action for the address at all -
   * which is what it also answers for an address nothing was ever deployed at.
   * Printed as the same line, a vault the reader cannot see reads as a vault
   * that is empty, and the person reading it deposits again.
   */
  const publicRows = async (): Promise<
    { of: 'listed'; rows: Array<{ tokenType: string; balance: bigint }> }
    | { of: 'unreadable'; why: string }
  > => {
    const rows = await publicDataProvider.queryUnshieldedBalances(vaultAddress);
    if (rows == null) {
      return {
        of: 'unreadable',
        why: 'the indexer has no contract action for this address, so it has not published a '
          + 'balance for it at all. That is not a vault holding nothing',
      };
    }
    if (!Array.isArray(rows)) {
      return { of: 'unreadable', why: `the indexer answered with ${typeof rows} rather than a list` };
    }
    return { of: 'listed', rows };
  };
  const printRows = async (when: string) => {
    try {
      const answer = await publicRows();
      if (answer.of === 'unreadable') {
        warn(`what this vault holds publicly COULD NOT BE READ ${when}: ${answer.why}`);
        return;
      }
      note(`what the indexer lists for this vault ${when}, every token:`);
      if (answer.rows.length === 0) {
        note('  the chain published a balance list for this contract and it is EMPTY,');
        note('  which is the chain saying this vault holds no public money');
      }
      for (const r of answer.rows) note(`  ${String(r.tokenType)}  ${String(r.balance)}`);
    } catch (e: any) {
      warn(`what this vault holds publicly COULD NOT BE READ ${when}: ${String(e?.message ?? e).split('\n')[0]}`);
    }
  };

  /* -------------------------------------------------- 4 */
  clock.begin(4, 6, 'What the chain says, and the next step');
  await printRows('before this run');
  note('IF NIGHT READS AS ZERO BELOW AND A LINE ABOVE HOLDS A BALANCE UNDER ANOTHER SPELLING OF');
  note('THE SAME TOKEN, DO NOT DEPOSIT AGAIN: that is the indexer spelling the token differently.');
  let before: bigint | null = null;
  try {
    before = await vaultLedger.unshieldedBalance(vaultAddress!, facts.token);
    good(`the chain says this vault holds ${before.toLocaleString()} NIGHT in its smallest unit`);
  } catch (e: any) {
    warn(`the vault's NIGHT balance could not be read before paying: ${String(e?.message ?? e).split('\n')[0]}`);
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
      const paid = await vaultLedger.payout(vaultAddress!, vaultPaymentOf(record, built, toHex(proposalId) as Hex), BY);
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

  /* -------------------------------------------------- the answer */
  clock.begin(6, 6, 'What the chain says now');
  const final = await readChain();
  if (!final.paid) {
    throw new Error('the sequence ended and the account does not show this payment as recorded. Run the door again with the same answers; it continues from what the chain says.');
  }
  let after: bigint | null = null;
  try { after = await vaultLedger.unshieldedBalance(vaultAddress!, facts.token); } catch { /* reported below */ }
  await printRows('after this run');
  say();
  say('  \x1b[1mWHAT THE CHAIN SAYS NOW\x1b[0m');
  say(`    the account has recorded this payment   ${final.paid ? 'YES' : 'NO'}`);
  say(`    the vault's NIGHT before this run        ${before === null ? '(not read)' : before.toLocaleString()}`);
  say(`    the vault's NIGHT now                    ${after === null ? '(not read)' : after.toLocaleString()}`);
  const moved = publicMovementOf(before, after, amount);
  say(`    what those two numbers say               ${moved}`);
  if (paidTx) say(`    the payment's transaction                ${paidTx}`);
  say('    The payee\'s own balance is not read by this door. Their wallet shows it.');
  /*
   * A FINISHED RECORD IS MOVED ASIDE, NOT DELETED, so the next payment out of this
   * vault starts a record of its own and this one stays as the history of the last.
   */
  const finished = finishedRecordFile(recordFile, record);
  renameSync(recordFile, finished);
  liveRecord = null;
  note(`the finished record is kept at ${finished.replace(ROOT + '/', '')}`);
  if (!paidTx) {
    say();
    say('  THIS PAYMENT WAS ALREADY MADE BY AN EARLIER RUN. Nothing was paid by this one, so the two');
    say('  balances above say nothing about it.');
    return 4;
  }
  return moved === 'left-the-vault' ? 0 : 3;
}

/* ------------------------------------------------------------------ *
 * the refusal
 * ------------------------------------------------------------------ */

function fail(e: any): never {
  const redact = (text: string): string => [vaultAddress, accountAddress].reduce(
    (t, a) => (a ? t.split(a).join('[an address, withheld]') : t), text);
  const out = (text: string) => console.log(redact(text));
  out('');
  out(`\x1b[31m\x1b[1m  Stopped during: ${clock.stage}\x1b[0m`);
  out(describeError(e, explainNodeError).split('\n').map((l) => '  ' + l).join('\n'));
  clock.print('stopped');
  console.log();
  console.log('  \x1b[1mThe error object, whole: bounded, and it says what it dropped\x1b[0m');
  const serialised = serialiseWholeDetailed(e);
  out(serialised.text.split('\n').map((l) => '    ' + l).join('\n'));
  for (const line of describeDropped(serialised.dropped)) console.log(`    ${line}`);
  console.log();
  if (lastReadPaid) {
    /*
     * THE RECORD IS FINISHED EVEN THOUGH THIS RUN STOPPED, so it is moved aside as
     * finished here too. Left in place, it would block the next, different payment
     * with advice to finish it; moved anywhere else by hand, the check that refuses
     * paying it again would not find it.
     */
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
