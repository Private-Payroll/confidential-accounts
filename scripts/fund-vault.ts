/**
 * **THE FIRST MONEY EVER TO ENTER A VAULT, AND IT IS PUBLIC MONEY.** `C245`,
 *
 *
 * Run it with `FUND-VAULT.command`. What that door must pass and must refuse is
 * at the bottom of this file; the order the doors go in, and what each one needs
 * first, is `docs/command-order.md`.
 *
 * ------------------------------------------------------------------------
 * WHY THE PUBLIC PATH AND NOT `deposit`
 *
 * `deposit` compiles to `createZswapOutput`: it CREATES a shielded coin
 * addressed to the vault, and it has to be funded from a shielded balance of
 * that colour. **The funded wallet holds none of any colour** (`V-94`), no
 * token has ever been chosen for one, and the vault has no mint circuit. So a
 * shielded deposit is not a thing this machine can do today, and pretending
 * otherwise would spend a fee to find that out.
 *
 * `depositUnshielded` needs no such decision. **NIGHT is unshielded by
 * definition** — `nativeToken(): UnshieldedTokenType` — and the wallet holds
 * it. The colour that reaches the circuit is read from the ledger's own
 * `nativeToken()` at run time and printed in the report, rather than typed into
 * this file as thirty-two zero bytes somebody once saw.
 *
 * ------------------------------------------------------------------------
 * WHAT A PUBLIC DEPOSIT NEEDS, AND IT IS SHORTER THAN THE PRIVATE ONE
 *
 * A deployed vault carrying this contract's circuits, a wallet that can fund
 * the call's declared `unshielded_input`, and nothing else. **No note pool, no
 * sealed record, no signer-wrapped key, no `openPool`, no `replayVault`.** The
 * unshielded circuits read no witness — public money is a ledger balance — so
 * the whole note model is absent here rather than satisfied.
 *
 * **THAT PROPERTY IS NOT ASSERTED HERE, IT IS EXERCISED.** The `NotePool` this
 * hands `VaultLedger` throws on every method. If any line of the public path
 * ever loads, saves or creates a pool, this run stops loudly instead of quietly
 * working because a pool happened to be on disk. `vault-ledger.test.ts` drives
 * the same shape for the same reason.
 *
 * ------------------------------------------------------------------------
 * **WHAT IS RECORDED LOCALLY BY THIS RUN: NOTHING, DELIBERATELY.**
 *
 * A shielded deposit writes a note into the pool, because nothing on chain says
 * what a note is. A public deposit has nothing to write: the ledger adds the
 * amount to this contract's balance and publishes it, and **a second name for a
 * number the chain already publishes is what `C124` and `V-47` were both
 * about.** `C199`'s crash window between a transaction and a local write cannot
 * exist where there is no local write.
 *
 * So if this run dies after the transaction lands, nothing is lost but the
 * report. The money is in the vault, the chain says so, and stage 6 of the next
 * run reads it back.
 *
 * ------------------------------------------------------------------------
 * **ONE ATTEMPT.** No retry, no fallback to another port, image or network. A
 * retry that succeeds after a failure hides which one was real, and no vault
 * circuit has ever been proved, so this run's whole value is what it settles.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import { StaticProofServerContainer, createDefaultTestLogger } from '@midnight-ntwrk/testkit-js';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

import { Contract as VaultContract } from '../contracts/managed-vault/contract/index.js';
import { VaultLedger, VaultChainUnreadable, type NotePool } from '../src/midnight/vault-ledger.js';
import { VAULT_CIRCUITS } from '../src/midnight/vault-contract.js';
import {
  assertVaultName, vaultRegistryFile, parseVaultRegistry, type VaultEntry,
} from '../src/midnight/vault-record.js';
import { applyNetworkId, theNetwork } from '../src/midnight/network.js';
import type { Hex } from '../src/core/crypto.js';
import type { SignerRef } from '../src/core/ledger.js';
import { explainNodeError, NODE_ERROR_CODES } from './node-errors.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';
import { bringUpWallet } from './wallet-bringup.js';
import { saveDustState } from './dust-wallet.js';
import { budgetFrom, budgetVerdict, SPENDS_TO_ESCAPE_A_SIZE_REFUSAL } from './dust-spend-budget.js';
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
const NETWORK = theNetwork();
const VAULT_ARTEFACTS = join(ROOT, 'contracts', 'managed-vault');
const ACCOUNT_RECORD = join(STATE_DIR, `${NETWORK}-contract.json`);

/* 6301, NOT 6300 — M-144. Port 6300 has an 8.1.0 server on it and a proof it
 * builds is refused by this node's fee check as error 170. */
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT || 6301);

/**
 * The private state store, per network.
 *
 * **THE VAULT WRITES NOTHING INTO IT** — `src/midnight/vault-contract.ts`
 * passes no `privateStateId`, so the SDK stores none and reads none. The store
 * is constructed because the providers bundle requires one, and `C228`'s
 * addressing rule is applied by the client before every access regardless.
 */
const PRIVATE_STATE_ID = `confidential-accounts-${NETWORK}`;
const PRIVATE_STATE_PASSWORD =
  process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD || 'ConfidentialAccounts-Dev-2026';

/** Which vault, by the name a person chose. No default: see `vaultFromRegistry`. */
const VAULT_NAME = (process.env.VAULT_NAME ?? '').trim();
/** How much, in NIGHT's smallest unit. No default, and no decimal point. */
const FUND_AMOUNT = (process.env.FUND_AMOUNT ?? '').trim();

/* ------------------------------------------------------------------ *
 * the report
 * ------------------------------------------------------------------ */

/**
 * The vault's address, held here so the screen guard can forbid it from the
 * moment it is read.
 *
 * A plain send to a vault's address is money on chain that nobody can spend and
 * no contract can refuse. Everything this script prints goes through `say`,
 * which refuses a line carrying this value or any eight-character window of it.
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
/** Wall clock around the one circuit call. Null until it has been taken. */
let provingSeconds: number | null = null;

/* ------------------------------------------------------------------ *
 * what is decided before anything is spent
 * ------------------------------------------------------------------ */

/**
 * The amount, as a whole number in NIGHT's smallest unit.
 *
 * **NO DECIMAL POINT IS ACCEPTED, AND THAT IS A REFUSAL RATHER THAN A GAP.**
 * `src/core/assets.ts` declares NIGHT with six decimal places, and **nothing in
 * this project has ever checked that against the chain.** Every number the
 * wallet reports and every number the circuit takes is in the smallest unit, so
 * this door works in the smallest unit end to end and converts nothing. A
 * conversion here would be this file's own belief about a currency, applied to
 * somebody's money.
 *
 * Exported so `fund-vault.test.ts` can drive every refusal without a chain.
 */
export function amountFromText(text: string): bigint {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    throw new Error(
      'no amount was given. FUND-VAULT.command asks how much and passes the answer here; ' +
      'reaching this means the question went unanswered.\n' +
      'There is deliberately no default: a default amount is a number nobody chose, moving ' +
      'money nobody decided to move.');
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `"${trimmed}" is not an amount this door will take. It wants digits and nothing else: ` +
      'no point, no separators, no sign, no exponent.\n' +
      'AMOUNTS HERE ARE IN THE SMALLEST UNIT, which is the unit the wallet reports and the ' +
      'unit the circuit takes. This door converts nothing, because how many decimal places ' +
      'NIGHT has has never been measured against the chain by this project.');
  }
  const amount = BigInt(trimmed);
  if (amount <= 0n) {
    throw new Error(
      'a deposit of nothing is not a deposit. The contract refuses it — it would seat a ' +
      'colour in this vault\'s unshielded token set that `retire` then blocks on, which is a ' +
      'way to jam a vault\'s retirement for free, by anybody, since a deposit needs no ' +
      'approval. This refuses it before a fee.');
  }
  return amount;
}

/**
 * Refuses a vault whose RECORD says it cannot hold public money.
 *
 * **THIS IS THE EARLY CHECK AND NOT THE REAL ONE, AND THE DIFFERENCE MATTERS.**
 * What decides is the operations map read off the chain by
 * `findDeployedVaultContract`, which the client does before it builds anything
 * (`C264`: a deployment and its client must move together, and the failure when
 * they do not is total rather than partial). This one reads a local file, which
 * can disagree with the chain, and it exists only so a vault deployed before
 * `S6j` is refused by name in a second instead of after a wallet, a dust wait
 * and a proof server.
 *
 * Exported for the same reason `amountFromText` is.
 */
export function assertVaultTakesPublicMoney(entry: VaultEntry): void {
  const circuits = Array.isArray(entry.circuits) ? entry.circuits : [];
  if (circuits.includes('depositUnshielded')) return;
  throw new Error(
    `the record for the vault "${entry.name}" lists ${circuits.length} circuit(s) and ` +
    '`depositUnshielded` is not among them, so this vault cannot hold public money.\n' +
    `  it has:   ${circuits.length ? circuits.join(', ') : '(none recorded)'}\n` +
    `  a vault has: ${[...VAULT_CIRCUITS].join(', ')}\n` +
    'A vault deployed before the public path existed carries four circuits. Its state does ' +
    'not decode against the compiled reader either, so nothing can be read back from it — ' +
    'that is one deployment and one client that moved apart, and no client change fixes it.\n' +
    'DEPLOY-VAULT.command deploys a vault carrying all of them. Choosing a different vault at ' +
    'this door\'s prompt is the other answer, and it is usually the right one.');
}

/**
 * **WHAT THE TWO READINGS SAY, AS A VALUE RATHER THAN AS A BRANCH INSIDE A
 * PRINT.** `V-172`.
 *
 * Exported and pure, so `fund-vault.test.ts` can drive every outcome. A guard
 * that lives only inside `main()` is a guard nothing executes, and this one is
 * the only thing that separates *the deposit did not land* from *this client
 * does not recognise the colour the indexer publishes* — two states with
 * opposite next actions.
 *
 * **THERE ARE FOUR ANSWERS AND NOT TWO**, and the fourth is the one `C110`
 * costs every time it is left out: the indexer may simply not have published
 * yet.
 */
export type MovementVerdict = 'no-baseline' | 'moved-by-the-deposit' | 'did-not-move';

export function movementVerdict(
  before: bigint | null, after: bigint, deposited: bigint,
): MovementVerdict {
  if (before === null) return 'no-baseline';
  return after - before === deposited ? 'moved-by-the-deposit' : 'did-not-move';
}

/** The company's vaults on this network, or a refusal — never a guess. */
function vaultFromRegistry(name: string): VaultEntry {
  const file = vaultRegistryFile(STATE_DIR, NETWORK);
  if (!existsSync(file)) {
    throw new Error(
      `no vault has ever been deployed on ${NETWORK}: ${file.replace(ROOT + '/', '')} does not ` +
      'exist, so there is nothing to fund. DEPLOY-VAULT.command is what creates one.');
  }
  const registry = parseVaultRegistry(JSON.parse(readFileSync(file, 'utf8')), NETWORK);
  const entry = registry.vaults[name];
  if (!entry) {
    const known = Object.keys(registry.vaults);
    throw new Error(
      `this company has no vault called "${name}" on ${NETWORK}.\n` +
      (known.length
        ? `The vaults it does have are: ${known.join(', ')}.`
        : 'It has none at all on this network.') +
      '\nA vault is named rather than addressed because a vault\'s address must never reach a ' +
      'screen (C236), and the registry is the only place the two are tied together.');
  }
  return entry;
}

/**
 * **THE VAULT'S PINNED ACCOUNT AGAINST THE ACCOUNT THAT IS ACTUALLY DEPLOYED.**
 *
 *
 * A vault holds its account's address from the moment it is built and can never
 * be redirected (`V-37`). **The account's deploy overwrites its own record
 * without comparing them**, so a vault deployed against yesterday's account is
 * married to a contract that is no longer the current one — and the failure
 * does not arrive at the redeploy, which succeeds. It arrives at the first
 * payment afterwards, when `payoutUnshielded` asks a contract that will not
 * answer.
 *
 * **`C266` NAMES THIS EXACT GUARD AS ITS CHEAP FIX — "a comparison at the point
 * a vault is used, refusing loudly rather than paying into a contract that will
 * not answer" — AND SAYS IT IS FREE ONLY WHILE THE VAULTS HOLD NOTHING.** This
 * door is the event that ends that, so the comparison belongs here rather than
 * in the round after it.
 *
 * It refuses BEFORE the fee and before the money, because a deposit into a
 * stranded vault is money that cannot be moved.
 */
export function assertVaultIsMarriedToTheDeployedAccount(entry: VaultEntry): void {
  if (!existsSync(ACCOUNT_RECORD)) {
    throw new Error(
      `no account is deployed on ${NETWORK}: ${ACCOUNT_RECORD.replace(ROOT + '/', '')} does not ` +
      'exist.\nEvery payment out of a vault is the vault calling its account across the ' +
      'contract boundary, so a vault whose account is not deployed is one nothing can be paid ' +
      'out of. DEPLOY-PREVIEW.command deploys it.');
  }
  const record = JSON.parse(readFileSync(ACCOUNT_RECORD, 'utf8'));
  const deployed = String(record?.contractAddress ?? '').trim().toLowerCase();
  const pinned = String(entry.accountAddress ?? '').trim().toLowerCase();
  if (deployed && pinned && deployed === pinned) return;
  throw new Error(
    `the vault "${entry.name}" is married to an account that is not the one deployed on ` +
    `${NETWORK}.\n` +
    'A vault pins its account in its own ledger at construction and can never be redirected ' +
    '(V-37), and the account\'s own deploy overwrites its record without comparing them ' +
    '(C266). So this vault would take the money and then be unable to pay any of it out: ' +
    'every payment is a cross-contract call to the account it was built against, and that ' +
    'contract is no longer the one this company uses.\n' +
    'NEITHER ADDRESS IS PRINTED HERE (C236). What settles it is which account was current ' +
    'when this vault was deployed, and DEPLOY-VAULT.command against the account deployed now ' +
    'is what produces a vault that can be paid out of.\n' +
    'Nothing was proved and nothing was spent.');
}

/**
 * **THE POOL THIS RUN HANDS THE CLIENT, AND EVERY METHOD OF IT THROWS.**
 *
 * The public path does not touch a note pool. That is a claim, and this is what
 * turns it into a property somebody can rely on: if any line of it ever loads,
 * saves or creates one, this run stops with a sentence naming the method rather
 * than quietly succeeding because a pool file happened to be on disk beside it.
 *
 * The same construction is in `vault-ledger.test.ts`, and it is there for the
 * reason it is here: *"the branch was not taken"* and *"there is no branch"* are
 * different claims, and only the second survives somebody refactoring the first.
 */
const refusingPool = (): NotePool => {
  const refuse = (method: string) => (): never => {
    throw new Error(
      `the public deposit path asked the note pool to ${method}, and it has no business ` +
      'doing so. Public money is a ledger balance: the unshielded circuits read no witness, ' +
      'record no note and have no pool. Nothing is substituted here, because a pool answer ' +
      'on this path would be an answer to a question the money does not depend on, hiding a ' +
      'client that has started depending on it.');
  };
  return {
    load: refuse('load') as NotePool['load'],
    save: refuse('save') as NotePool['save'],
    create: refuse('create') as NotePool['create'],
  };
};

/**
 * **WHO IS MAKING THIS DEPOSIT, AND THE HONEST ANSWER HAS NO LEAF IN IT.**
 *
 * `VaultLedger.depositUnshielded` takes a `SignerRef` so that no caller can
 * submit without having decided who is acting. **A deposit needs no approval —
 * nobody needs permission to be paid — so the actor is whoever holds the funded
 * wallet, and that is not a signer of anything.** There is no blinded leaf for
 * them in any signer tree, so none is invented: `txRef` discards `by` (`void
 * by`) and nothing anywhere derives from it. Inventing a leaf to fill a field
 * would put a value in a record that reads as membership.
 */
const DEPOSITOR: SignerRef = {
  signerId: 'whoever holds the funded wallet on this machine',
  leaf: '',
};

/** The size block, printed on success and on refusal alike. */
function printTxSize() {
  say();
  say('  \x1b[1mHow big the transaction is, against what the chain will carry\x1b[0m');
  if (!txMeasurements.length) {
    say('    NO TRANSACTION WAS BUILT IN THIS RUN, so there is no size to report and none is');
    say('    estimated. The stage named above says how far it got.');
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
    say('    THE FIVE DIMENSIONS THE NODE NORMALISES AGAINST:');
    for (const line of compareCost(last.cost, limits)) say(`    ${line}`);
  }
  say();
  /*
   * NO EXPECTED FIGURE IS PRINTED HERE, AND THAT IS DELIBERATE.
   *
   * `DEPLOY-VAULT.command` carries one in its own header and it has already
   * disagreed with the script beside it. No vault CIRCUIT CALL has ever been
   * measured by anything, so a number in this file would be an invention that
   * outlives the run that invented it.
   */
  say('    NOTHING ABOVE IS COMPARED TO AN EXPECTED FIGURE, because no vault circuit call');
  say('    has ever been measured by this project. These are the first. What they should');
  say('    be compared against is the next run of this door, not a number written here.');
}

/** What proved, and how long it took. Measured, or said to be absent. */
function printProving() {
  say();
  say('  \x1b[1mWhat proved, and what it took\x1b[0m');
  say(`    circuit           depositUnshielded  (one call, one transaction)`);
  say(`    proof server      ${proofServerImage}`);
  say(`    /version          ${proofServerVersion}`);
  if (provingSeconds === null) {
    say('    time              NOT MEASURED — the call did not complete, so there is no');
    say('                      duration to report and none is estimated.');
    return;
  }
  say(`    prove and submit  ${provingSeconds.toFixed(1)}s wall clock`);
  say('    THAT NUMBER COVERS THE WHOLE CALL, not the proof alone: the arity check, the');
  say('    read of the contract state, the proof, the balancing and the submission are all');
  say('    inside it. Nothing here can separate them, so nothing here claims to.');
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function main(): Promise<MovementVerdict | 'not-read'> {
  say('────────────────────────────────────────────────────────────');
  say(`  Putting public money into a vault on ${NETWORK}`);
  say('────────────────────────────────────────────────────────────');
  say();
  say('  ONE ATTEMPT. A real transaction, a real fee, and real test NIGHT.');
  say('  No vault circuit has ever been proved by this project. This is the first.');

  /* -------------------------------------------------- 1 */
  clock.begin(1, 6, 'Which vault, how much, and what is being deposited');

  if (!VAULT_NAME) {
    throw new Error(
      'no vault name was given. FUND-VAULT.command asks which vault and passes the answer ' +
      'here; reaching this means the question went unanswered.\n' +
      'There is deliberately no default: a default would fund whichever vault the registry ' +
      'happened to list first, with a company\'s money.');
  }
  assertVaultName(VAULT_NAME);
  const entry = vaultFromRegistry(VAULT_NAME);
  vaultAddress = entry.contractAddress;
  good(`vault "${VAULT_NAME}", deployed ${entry.deployedAt}`);
  note('  its address is NOT printed, here or anywhere — C236');

  assertVaultTakesPublicMoney(entry);
  assertVaultIsMarriedToTheDeployedAccount(entry);
  good('this vault is married to the account that is deployed on this network — C266');
  note('  a vault pins its account at construction and can never be redirected. The account\'s');
  note('  own deploy overwrites its record without comparing them, so this is checked here,');
  note('  before the money, rather than discovered at the first payment afterwards.');
  good(`the record says this vault carries ${entry.circuits.length} circuits, including depositUnshielded`);
  note('  that is a LOCAL record. What decides is the operations map the client reads off the');
  note('  chain before it builds anything; this check is only earlier, not stronger.');

  const amount = amountFromText(FUND_AMOUNT);

  /*
   * THE COLOUR, READ FROM THE LEDGER AND NOT TYPED HERE.
   *
   * `nativeToken()` is NIGHT and it is unshielded by definition, not by
   * configuration. Its raw type is what `receiveUnshielded` takes and what the
   * indexer keys its balance rows by, so reading it from the same library the
   * transaction is built with is the only way the two cannot drift. A constant
   * in this file would be this project's memory of a value.
   */
  const { nativeToken } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  const colour = (nativeToken() as any).raw as Hex;
  good(`depositing ${amount.toLocaleString()} of NIGHT, in NIGHT's smallest unit`);
  note(`  colour, read from the ledger's own nativeToken(): ${colour}`);
  note('  NO DECIMAL CONVERSION HAPPENS ANYWHERE IN THIS RUN. How many decimal places NIGHT');
  note('  has has never been measured against the chain by this project, so this door works');
  note('  in the unit the wallet reports and the circuit takes, end to end.');

  /*
   * **WHAT THIS MONEY CANNOT DO ONCE IT IS IN, SAID BEFORE IT GOES IN.**
   *
   * The colour above is the ledger's `nativeToken().raw`. A payment out of a
   * vault commits to the token `transferFacts` names, which comes from
   * `ledgerTokenOf` and is that same value for NIGHT paid publicly, so the
   * payment and the vault agree on what money moves.
   *
   * **What it still cannot do is leave, because nothing in this client makes
   * the payment.** A payment out is a proposal on the account, two approvals at
   * the vault's threshold and a call to the vault, and no door does those
   * three. **Nothing is lost and nothing is at risk: the money stays where it
   * is, on chain, in a balance anybody can read.** And `retire` refuses a vault
   * that still holds a colour, so it cannot be wound up either.
   *
   * **IT IS SAID AND NOT REFUSED HERE, DELIBERATELY.** This door exists to
   * establish whether a vault circuit can be proved and submitted at all,
   * which no run has ever established, and refusing the deposit would refuse
   * the measurement. The money is test NIGHT on a test network. That reasoning
   * does not survive contact with a customer's money, and the row says so.
   */
  say();
  say('  \x1b[33mWHAT THIS MONEY CANNOT DO ONCE IT IS IN\x1b[0m');
  say('    It cannot be paid out yet: no door in this client makes the proposal, gathers');
  say('    the two approvals and makes the payment. The vault cannot be retired while it');
  say('    holds it either. A payment out would name the colour above, the ledger\'s own');
  say('    token type, and the transfer checks that before any fee.');
  say('    NOTHING IS AT RISK BY THAT. The money stays on chain in a balance anybody can');
  say('    read.');
  say('    This is test NIGHT on a test network, and this run exists to establish whether a');
  say('    vault circuit proves at all. On a customer\'s money it would be a refusal.');
  say();
  /*
   * **AND THE SECOND THING, WHICH IS ABOUT FEES AND NOT ABOUT THIS COLOUR.**
   * Verified from source, both directions: DUST generation is minted per NIGHT
   * OUTPUT of an `UnshieldedOffer` whose `owner` has an entry in
   * `address_delegation: Map<UserAddress, DustPublicKey>`
   * (`midnight-ledger/ledger/src/dust.rs:921, 1240-1253`), and spending a NIGHT
   * input sets that generation's `dtime` (`:1205-1231`). **A contract's
   * unshielded holding is a balance and not a UTXO, and `UtxoOutput.owner` has
   * no contract variant at all** (`C236`, from `structure.rs`).
   *
   * So NIGHT in a vault generates DUST for nobody, and the fee that gets it out
   * is paid in DUST by a wallet, generated by NIGHT held OUTSIDE the vault. A
   * company that puts all of its NIGHT in a vault has no fee budget to pay
   * anything out with. `B8` is that row from the other side.
   */
  say('  \x1b[33mAND MONEY IN A VAULT PAYS FOR NOTHING\x1b[0m');
  say('    Fees are paid out of what NIGHT earns while a wallet holds it, and NIGHT stops');
  say('    earning the moment it goes into a vault: a vault holds a balance, not the kind of');
  say('    holding that earns. The fee that gets money OUT of a vault is paid by the wallet,');
  say('    out of what the NIGHT still in the wallet has earned.');
  say('    SO A COMPANY THAT PUTS ALL OF ITS NIGHT IN A VAULT CANNOT PAY ANYTHING OUT OF IT.');
  say('    This door does not enforce a reserve and does not decide the size of one. It says');
  say('    it here, before the amount is spent, and leaves the number to the person.');
  say();

  const proverKey = join(VAULT_ARTEFACTS, 'keys', 'depositUnshielded.prover');
  if (!existsSync(proverKey)) {
    throw new Error(
      'contracts/managed-vault/keys/depositUnshielded.prover does not exist, so this call ' +
      'cannot be proved.\n' +
      'COMPILE-VAULT.command builds the vault\'s keys and it is the ONLY file that does. ' +
      'COMPILE-CONTRACT.command compiles both contracts with --skip-zk, MUTATE.command\'s ' +
      'quick recompiles wipe them, and BUILD-KEYS.command covers the account only.');
  }
  good('the proving key for depositUnshielded is on disk');

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
    ?? '(not exported — run through FUND-VAULT.command to record it)';
  try {
    const res = await withTimeout('the proof server /version', 10_000, fetch(`${cfg.proofServer}/version`));
    proofServerVersion = (await res.text()).trim().slice(0, 200) || `(empty, HTTP ${res.status})`;
  } catch (e: any) {
    proofServerVersion = `(did not answer: ${String(e?.message ?? e).slice(0, 80)})`;
  }
  good(`prover image    ${proofServerImage}`);
  good(`prover /version ${proofServerVersion}`);
  note('THE NAMED RISK OF THIS RUN LIVES HERE. depositUnshielded lands at k=9, so the prover');
  note('wants bls_midnight_2p9, and the keys were built against a parameter set starting at');
  note('2p10. Building a key is not producing a proof and no proof has been produced for any');
  note('of these seven. If the server cannot get that parameter, this is where it says so.');

  try {
    const { LedgerParameters } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
    ledgerParameters = LedgerParameters;
    blockLimits = limitsFromLedger(LedgerParameters);
    good(`block usage limit ${blockLimits.blockUsage === null ? '(could not derive)' : `${blockLimits.blockUsage.toLocaleString()} bytes`}`);
  } catch (e: any) {
    note(`the block limits could not be read: ${String(e?.message ?? e)}`);
  }

  /* -------------------------------------------------- 4 */
  clock.begin(4, 6, 'Getting the funded wallet');

  if (!existsSync(SEED_FILE)) {
    throw new Error(
      `there is no wallet: ${SEED_FILE.replace(ROOT + '/', '')} does not exist.\n` +
      'This door will not make one. A fresh wallet holds nothing and the faucet wants a ' +
      'captcha, so a wallet made here would be a wallet that cannot pay, discovered after ' +
      'the proof server was up. DEPLOY-PREVIEW.command prints the address and the faucet URL.');
  }
  const masterSeed = readFileSync(SEED_FILE, 'utf8').trim();
  note(`using the wallet in ${SEED_FILE.replace(ROOT + '/', '')}`);

  const live = await bringUpWallet(logger, cfg, masterSeed, NETWORK, ROOT, {
    withDust: true, requireDust: true, onNote: note,
  });
  const wallet: any = live.wallet;
  const night = live.night();
  good(`wallet ready — NIGHT ${night.toLocaleString()}, DUST ${live.dust().toLocaleString()}`);
  const cached = await saveDustState(wallet, masterSeed, NETWORK, ROOT);
  if (cached) good(`dust wallet state cached (${(cached / 1024).toFixed(0)} KB)`);

  /*
   * THE CEILING ON DUST SPENDS, SAID OUT LOUD BEFORE ANYTHING IS PROVED.
   *
   * A deposit can be refused at submission for being too cheap relative to its
   * size, and the only known way past that is to make the transaction bigger by
   * adding another dust spend. How many of those this wallet can emit is fixed
   * by how many registered NIGHT outputs it holds, and a wallet that has been
   * used tends towards holding one. The chain does not explain this: it answers
   * with a code. So it is read and printed here, while it still costs nothing.
   *
   * IT IS MEASURED AGAINST THE ESCAPE, NOT AGAINST AN ORDINARY DEPOSIT, AND
   * THAT IS THE WHOLE POINT. Every deposit carries one dust spend and every
   * wallet can supply one, so a check asking for one passes on every wallet
   * including the ones where this refusal cannot be escaped — which would print
   * a reassurance nobody measured, immediately before the refusal. The number
   * asked for is the module's own constant, derived from the mechanism.
   *
   * IT DOES NOT STOP THE RUN. A wallet at the ceiling is a reason to recognise
   * the refusal if it comes, not a reason to refuse to try, and nothing is at
   * risk in finding out: every refusal so far was at submission and no fee was
   * taken.
   */
  const { nativeToken: nightToken } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  const budget = budgetVerdict(budgetFrom(
    live.state()?.unshielded?.availableCoins,
    String((nightToken() as any).raw),
    SPENDS_TO_ESCAPE_A_SIZE_REFUSAL,
  ));
  note(budget.line);
  if (!budget.ok && budget.remedy) note(`  ${budget.remedy}`);

  /*
   * REFUSED IN WORDS BEFORE A PROOF, AND THE LEDGER REFUSES IT AGAIN ANYWAY.
   *
   * The duplication is the same one the contract's own asserts carry: the
   * ledger's refusal protects the money whatever this believes, and this one
   * gives a person a sentence instead of eighty seconds of proving followed by
   * a rejection code.
   */
  if (night < amount) {
    throw new Error(
      `the wallet holds ${night.toLocaleString()} NIGHT and this deposit is ` +
      `${amount.toLocaleString()}. Both numbers are in the smallest unit and both were read ` +
      'just now: the wallet\'s from its own balances, the deposit\'s from the amount given at ' +
      'the prompt.\nNothing was proved and nothing was spent. Run this again with an amount ' +
      'the wallet can cover.');
  }
  good('the wallet holds enough to fund this deposit');

  /* -------------------------------------------------- 5 */
  clock.begin(5, 6, 'The deposit — the first vault circuit this project has ever proved');
  note('one circuit call, one transaction. Give it a few minutes.');

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
    /*
     * TWO SIZES, AND THE SECOND IS THE ONE ANY LIMIT IS EXPRESSED IN.
     *
     * This line used to print only what the client can see of its own
     * transaction. The node judges a different number, and the two are not the
     * same and do not differ by a constant, so a run that printed only the
     * first was quoting a size against a limit it is not measured in.
     */
    note(`transaction size (${m.stage}) ${m.bytes === null ? `not measured: ${m.problem ?? 'unknown'}` : `${m.bytes.toLocaleString()} bytes as the client serialises it`}`);
    note(`  the size the block limit is expressed in: ${m.ledgerBytes === null ? 'the ledger would not answer' : `${m.ledgerBytes.toLocaleString()} bytes`}`);
    const w = m.cost?.cost?.bytesWritten;
    if (typeof w === 'number' && blockLimits?.bytesWritten) {
      note(`  bytes written ${w.toLocaleString()} of ${blockLimits.bytesWritten.toLocaleString()} — ${((w / blockLimits.bytesWritten) * 100).toFixed(1)}% of a block`);
    }
    if (m.cost?.exceeded) note(`  THE LEDGER WILL NOT NORMALISE THIS COST: a block limit is exceeded. ${m.cost.exceeded}`);
  }, ledgerParameters);

  /*
   * MEMOISED, AND IT IS LOAD BEARING. `VaultLedger` calls this twice per circuit
   * call — once to read the contract state and once to prove, balance and
   * submit. An unmemoised factory opens a second private-state store per call
   * and balances with a different wallet handle than the one whose key went
   * into the transaction.
   */
  const providersOnce = async () => measured;

  const compiled = CompiledContract.make('Vault', VaultContract as any).pipe(
    CompiledContract.withCompiledFileAssets(VAULT_ARTEFACTS as never),
  ) as any;
  good(`compiled contract "${compiled.tag}", assets at contracts/managed-vault`);
  note('  the witnesses are bound per call by the client, and on this path they REFUSE:');
  note('  an unshielded circuit reads none, so a witness answer here would be an answer to a');
  note('  question the money does not depend on.');

  const ledger = new VaultLedger(
    { networkId: NETWORK } as never, {} as never, providersOnce, compiled,
    refusingPool(), VAULT_ARTEFACTS);

  /*
   * **THE BALANCE BEFORE, SO THE BALANCE AFTER CAN BE CHECKED AGAINST SOMETHING
   * RATHER THAN READ AS AGREEMENT.** `C268`'s shape on the public path.
   *
   * `unshieldedBalance` answers `0n` when the chain publishes rows for this
   * contract and none of them carries this colour, and that is correct: it is a
   * true statement about the vault. **What has never been observed is
   * how the indexer SPELLS the native token type.** It arrives as
   * `HexEncoded`, the client compares it case-insensitively against
   * `nativeToken().raw`, and both sides of that comparison in
   * `vault-ledger.test.ts` come from the test's own constant — so a difference
   * in spelling cannot be caught there by construction.
   *
   * A funded vault reporting `0` would then look exactly like a deposit that
   * did not land, and the operator's next move is to run this door again, which
   * deposits again. **Reading the balance twice and comparing the movement is
   * the only thing that separates those two**, and this run is the only place
   * that holds both numbers.
   */
  let before: bigint | null = null;
  /* THE VERDICT REACHES THE EXIT CODE. See `main`'s return and the door. */
  let verdict: MovementVerdict | 'not-read' = 'not-read';
  try {
    before = await ledger.unshieldedBalance(entry.contractAddress, colour);
    good(`before this deposit the chain says this vault holds ${before.toLocaleString()} of that colour`);
  } catch (e: any) {
    note(`the balance BEFORE this deposit could not be read: ${String(e?.message ?? e)}`);
    note('  so this run cannot check that the balance moved by what was deposited, and stage 6');
    note('  will say that rather than reading whatever it finds as agreement.');
  }

  const startedAt = Date.now();
  const tx = await ledger.depositUnshielded(
    entry.contractAddress, { token: colour, amount }, DEPOSITOR);
  provingSeconds = (Date.now() - startedAt) / 1000;
  good(`submitted in ${provingSeconds.toFixed(1)}s — transaction ${tx.ref}`);

  /*
   * THE FEE ACTUALLY PAID, AND THE BLOCK. Read off the finalized transaction
   * rather than estimated, and a failure to read it does NOT fail the run: the
   * money has moved and the chain publishes the balance regardless.
   */
  try {
    const finalized: any = await withTimeout(
      'the finalized deposit transaction', 120_000,
      providers.publicDataProvider.watchForTxData(tx.ref));
    say();
    say('  \x1b[1mWhat the chain charged, and where it landed\x1b[0m');
    say(`    fee paid          ${String(finalized?.fees?.paidFees ?? '(not in the answer)')}`);
    say(`    fee estimated     ${String(finalized?.fees?.estimatedFees ?? '(not in the answer)')}`);
    say(`    block height      ${finalized?.blockHeight ?? '(not in the answer)'}`);
    say(`    block hash        ${String(finalized?.blockHash ?? '')}`);
    say(`    transaction id    ${String(finalized?.txId ?? tx.ref)}`);
    say(`    status            ${String(finalized?.status ?? '')}`);
  } catch (e: any) {
    say();
    say('  \x1b[33mthe deposit was submitted and its finalized transaction could not be read');
    say('  back, so THIS RUN HAS NO FEE TO REPORT and estimates none:\x1b[0m');
    say(`    ${String(e?.message ?? e)}`);
    say('    Nothing is lost by that. A public deposit writes nothing locally: the balance is');
    say('    the ledger\'s, and stage 6 below reads it from the chain.');
  }

  printProving();
  printTxSize();

  /* -------------------------------------------------- 6 */
  clock.begin(6, 6, "Reading the balance back off the chain, through the client's own path");
  note('THE CLIENT\'S OWN READ AND NOT A SECOND ONE. S13c deleted the last second');
  note('implementation of a chain read for M-104\'s reason: a rule the money depends on,');
  note('written twice, is one copy behind on whichever was forgotten.');

  try {
    const held = await ledger.unshieldedBalance(entry.contractAddress, colour);
    say();
    /*
     * **THE HEADING IS DECIDED BY THE VERDICT, NOT BY HAVING A NUMBER.** A bold
     * "What this vault holds" over a figure asserts exactly what the paragraph
     * underneath then withdraws, which is a number with a caveat beside it —
     * and a number wins over its own footnote every time somebody is in a
     * hurry.
     */
    verdict = movementVerdict(before, held, amount);
    say(verdict === 'moved-by-the-deposit'
      ? '  \x1b[1mWhat this vault holds\x1b[0m'
      : '  \x1b[1mWhat this vault holds: THIS RUN COULD NOT CONFIRM IT\x1b[0m');
    say(verdict === 'moved-by-the-deposit'
      ? `    ${held.toLocaleString()} of NIGHT, in the smallest unit`
      : `    The chain answered ${held.toLocaleString()}. That is a reading, and this run`
        + ' claims nothing from it.');
    say('    WHERE THAT NUMBER CAME FROM: the indexer\'s own queryUnshieldedBalances for this');
    say(`    contract, summed over the rows whose token type is ${colour},`);
    say(`    asked through ${cfg.indexer}`);
    say('    at ' + new Date().toISOString() + '.');
    say('    It is the LEDGER\'s number and not a record this machine keeps. A company that');
    say('    lost every device it owns could read the same figure from the same place.');
    say();
    /*
     * **DID IT MOVE BY WHAT WAS DEPOSITED?** The one question a single reading
     * cannot answer, and the reason the balance was read before as well.
     */
    if (verdict === 'no-baseline') {
      say('    \x1b[33mTHIS RUN CANNOT SAY WHETHER THAT NUMBER MOVED.\x1b[0m The balance before the');
      say('    deposit could not be read, so there is nothing to compare it with, and no');
      say('    agreement is claimed from a single figure.');
    } else if (verdict === 'moved-by-the-deposit') {
      say(`    IT MOVED BY EXACTLY WHAT WAS DEPOSITED: ${before.toLocaleString()} to ${held.toLocaleString()}.`);
      say('    That settles two things at once. The deposit landed, and this client reads the');
      say('    same colour the indexer publishes — which nothing here had ever checked.');
    } else {
      say(`    \x1b[33mIT DID NOT MOVE BY WHAT WAS DEPOSITED, AND THAT IS THE FINDING.\x1b[0m`);
      say(`    before ${before.toLocaleString()}, after ${held.toLocaleString()}, deposited ${amount.toLocaleString()}.`);
      say('    THREE THINGS PRODUCE THIS AND THEY NEED DIFFERENT ANSWERS.');
      say('    1. THE INDEXER HAS NOT PUBLISHED IT YET, and on this branch that is the most');
      say('       likely of the three. C110: a transaction the node had finalised read as');
      say('       absent to the indexer 168ms later. The answer is to wait and read again.');
      say('    2. The deposit did not land at all.');
      say('    3. It landed, and this client does not recognise the colour the indexer');
      say('       publishes it under — the vault is funded and reads as empty.');
      say('    \x1b[1mDO NOT RUN THIS DOOR AGAIN TO FIND OUT. IT WOULD DEPOSIT AGAIN.\x1b[0m');
      say('    INDEXER-CHECK.command says whether the indexer is level with the node, which');
      say('    separates 1 from the other two. The transaction id above is what settles it.');
    }
  } catch (e: any) {
    say();
    say('  \x1b[1mWhat this vault holds: NOT ESTABLISHED BY THIS RUN\x1b[0m');
    if (e instanceof VaultChainUnreadable) {
      say('    THE CHAIN COULD NOT BE READ, WHICH IS NOT THE CHAIN SAYING ZERO. C110: a');
      say('    transaction the node had finalised read as absent to the indexer 168ms later,');
      say('    and a vault reported as empty because we asked too early is one whose whole');
      say('    float would be claimed as nothing.');
    }
    say(`    ${String(e?.message ?? e)}`);
    say('    NO FIGURE IS PRINTED IN PLACE OF THE ONE THAT COULD NOT BE READ. The deposit');
    say('    above either settled or did not, and that answer is on the chain either way.');
    say('    \x1b[1mDO NOT RUN THIS DOOR AGAIN TO FIND OUT. IT WOULD DEPOSIT AGAIN.\x1b[0m');
    say('    INDEXER-CHECK.command asks the node and the indexer the same question and prints');
    say('    both answers. If they disagree, no change on this machine will help.');
  }

  say();
  say('  \x1b[1mWhat this vault can and cannot do now\x1b[0m');
  say('    IT HOLDS PUBLIC MONEY, AND PUBLIC MEANS PUBLIC. The amount above is on chain');
  say('    against this contract, readable by anybody. Money that went in this way can only');
  say('    come out this way: a payment from a public balance publishes the payee and the');
  say('    amount. Payroll is paid from a private balance, this door creates none, and the');
  say('    vault cannot move money from one kind to the other. NO EMPLOYEE CAN BE PAID OUT');
  say('    OF THIS. Saying "what stays private is who gets paid out of it" would describe a');
  say('    different circuit than the one this money can reach.');
  say();
  say('    MONEY LEAVES IT ONLY THROUGH AN APPROVED RUN. There is no withdrawal circuit:');
  say('    a payment out is a proposal, approved at the vault\'s threshold, and the leaf has');
  say('    to be in the approved root. Nothing here can raise one, deliberately, because a');
  say('    script that could raise one would be a script that could move money.');
  say();
  say('    IT STILL CANNOT BE SENT MONEY. C236: funding a vault is a CALL and never a');
  say('    transfer. A plain send to this vault\'s address is money on chain that nobody can');
  say('    ever spend, and no contract can refuse it. That is why no address appears above.');

  live.stop();
  /*
   * **THE VERDICT LEAVES THIS PROCESS AS AN EXIT CODE, BECAUSE THE DOOR PRINTS
   * THE LOUDEST LINE ON THE SCREEN AND MUST NOT CONTRADICT IT.**
   *
   * A run that deposited and could not confirm the balance is not a success and
   * is not a failure: the money moved and the check did not answer. It has its
   * own code so the door can say that instead of "holds public money".
   */
  return verdict;
}

/* ------------------------------------------------------------------ *
 * the refusal, unabridged and bounded
 * ------------------------------------------------------------------ */

function fail(e: any): never {
  /*
   * NOT THROUGH THE SCREEN GUARD, for `open-vault-pool.ts`'s reason: an error
   * thrown from inside the guard would be unprintable, and a report that cannot
   * print its own failure is worse than one that shows an address in a stack
   * trace on a run that did not finish. So every line below has the address
   * replaced by a marker instead — a string substitution, which cannot throw.
   */
  const redact = (text: string): string => (vaultAddress
    ? text.split(vaultAddress).join('[the vault\x27s address, withheld — C236]')
    : text);
  const out = (text: string) => console.log(redact(text));

  out('');
  out(`\x1b[31m\x1b[1m  Failed during: ${clock.stage}\x1b[0m`);
  out(describeError(e, explainNodeError).split('\n').map((l) => '  ' + l).join('\n'));
  if (e?.stack) out(`\n\x1b[2m${String(e.stack).split('\n').slice(1, 8).join('\n')}\x1b[0m`);

  clock.print('stopped');

  try { printProving(); } catch { /* the guard fired; what is above stands */ }
  try { printTxSize(); } catch { /* the same */ }

  console.log();
  console.log("  \x1b[1mThe node's own words, verbatim and uncut\x1b[0m");
  if (rawNodeLines.length) {
    for (const line of collapseRepeatedLines(rawNodeLines)) {
      for (const part of line.split('\n')) out(`    ${part}`);
    }
    const codes = [...new Set(rawNodeLines.flatMap(
      (l) => [...l.matchAll(/Custom error:\s*(\d+)/g)].map((m) => m[1])))];
    console.log();
    if (codes.length) {
      for (const c of codes) {
        console.log(`    code ${c} = ${NODE_ERROR_CODES[c!] ?? '(not in our table — look it up in the node source, do not guess)'}`);
      }
    } else {
      console.log('    No numeric rejection code appears above. The node answered, but not');
      console.log('    with a Custom error.');
    }
  } else if (/deposit/i.test(clock.stage)) {
    console.log('    NOTHING, AND THE RUN HAD REACHED THE SUBMISSION. The node printed no');
    console.log('    rejection line, so it never answered: the websocket dropped and the chain');
    console.log('    never saw the transaction. M-23. THIS SETTLES NOTHING and it is not a');
    console.log('    finding about the circuit. Run FUND-VAULT.command again, unchanged.');
  } else {
    console.log('    NOTHING, AND THE RUN NEVER REACHED THE SUBMISSION — it stopped in');
    console.log(`    "${clock.stage}". This failure is local: read the error above.`);
  }

  console.log();
  console.log('  \x1b[1mThe error object, whole — bounded, and it says what it dropped\x1b[0m');
  const serialised = serialiseWholeDetailed(e);
  out(serialised.text.split('\n').map((l) => '    ' + l).join('\n'));
  console.log();
  for (const line of describeDropped(serialised.dropped)) console.log(`    ${line}`);

  console.log();
  console.log('  \x1b[33mIF THE DEPOSIT LANDED AND THIS RUN STOPPED AFTERWARDS, the money is in\x1b[0m');
  console.log('  \x1b[33mthe vault and nothing local was lost.\x1b[0m A public deposit records nothing');
  console.log('  on this machine: the balance is the ledger\'s. Run FUND-VAULT.command again only');
  console.log('  if you mean to deposit again, because it will.');
  process.exit(1);
}

/**
 * GUARDED, so a test can import the pure parts above without this file going to
 * the network and spending money on import. `measure-note-index.ts` does the
 * same and for the same reason.
 */
const RUN_DIRECTLY = typeof process.argv[1] === 'string'
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

/**
 * 0  the balance moved by exactly what was deposited.
 * 3  the deposit was submitted and the balance did NOT confirm it — either it
 *    has not been published yet, it did not land, or this client does not read
 *    the colour the indexer publishes. The money is not at risk either way and
 *    the door must not claim the vault holds it.
 * 1  the run stopped before the deposit, or on it. `fail` prints why.
 */
if (RUN_DIRECTLY) {
  main().then(
    (v) => process.exit(v === 'moved-by-the-deposit' ? 0 : 3),
    fail);
}

/* ------------------------------------------------------------------ *
 * THE `.command` THIS NEEDS, NAMED AND WRITTEN BESIDE IT
 * ------------------------------------------------------------------ */

/*
 * **`FUND-VAULT.command`.** What that door does, recorded here because the door
 * is what a person opens and a run order naming `npx tsx scripts/fund-vault.ts`
 * is an instruction nobody at the machine can follow.
 *
 * WHAT IT PASSES — exported, because this file reads the environment and
 * nothing else:
 *
 *     MIDNIGHT_NETWORK_ID   ACCEPTED AND NEVER DECIDING. The network is the one
 *                           this build is compiled for; naming a different one
 *                           here is refused, and naming none is the ordinary case.
 *     VAULT_NAME            the vault, by the name it was deployed under. NO
 *                           DEFAULT: this file refuses without it.
 *     FUND_AMOUNT           how much, in NIGHT's smallest unit, digits only.
 *                           NO DEFAULT, for the same reason.
 *     MIDNIGHT_PROOF_IMAGE  the pinned image, so the report can record what the
 *                           proof was built against rather than what was meant
 *                           to be running.
 *
 * WHAT IT REFUSES, before running anything:
 *
 *   1. **No name, or a name that is not a vault name.** It lists the vaults it
 *      knows and stops.
 *   2. **No amount, or an amount that is not digits.** It says the unit.
 *   3. **No `contracts/managed-vault/keys`.** Name `COMPILE-VAULT.command`.
 *   4. **The proof server on 6301 not answering the pin**, through the shared
 *      `scripts/proof-server-lib.sh`, whose refusals name `STOP-PROVER.command`.
 *
 * WHAT IT MUST NOT DO:
 *
 *   · **Not retry.** One attempt. A second run deposits again.
 *   · **Not print the address.** Everything this script prints goes through the
 *     screen guard; the door must not `cat` the registry.
 *   · **Not stop the proof server.** It is shared and is left running on
 *     purpose: it downloads a large shared reference string on its first proof
 *     and stopping the container throws it away.
 *
 * WHAT IT EXPORTS AS A REPORT: `REPORT-FUND-VAULT.txt`, beside the other
 * `REPORT-*.txt` files, ANSI stripped.
 */
