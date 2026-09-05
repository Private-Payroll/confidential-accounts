/**
 * **THE FIRST SHIELDED COIN THIS PROJECT HAS EVER HELD, AND IT IS A TEST
 * ASSET.** `V-94`, `V-111`.
 *
 * Run it with `MINT-TEST-TOKEN.command`. What that door must pass and must
 * refuse is at the bottom of this file; the order the doors go in, and what
 * each one needs first, is `docs/command-order.md`.
 *
 * ------------------------------------------------------------------------
 * **WHY A PROBE CONTRACT MINTS IT AND THE VAULT DOES NOT**
 *
 * `deposit` compiles to `createZswapOutput` — it CREATES a shielded coin
 * addressed to the vault, and the wallet balancing the transaction has to fund
 * it from a shielded balance of that colour (`V-94`, read from the generated
 * contract's `_receiveShielded_0`). **The funded wallet syncs zero shielded
 * outputs of any colour** — `REPORT-CHAIN-PROBE.txt`, 16 Aug: `shielded
 * 3177/0` — and the vault has no mint circuit, so there is nothing a shielded
 * deposit could be funded from. **Adding a mint to the vault is a contract
 * change and would be the wrong one**: a vault that can print the money it
 * holds is not a vault. So the coin comes from a throwaway contract that mints
 * its own token, and the token is a TEST asset for that reason and not by
 * accident.
 *
 * ------------------------------------------------------------------------
 * **WHY `contracts/probe-out4/mint-64` AND NOT `contracts/probe-out6/wrap`.**
 *
 * `ROUND-S16.md` names `wrap`. **Read the two sources beside each other and
 * `wrap` is the wrong one, for two separate reasons:**
 *
 *   · **Its first line is `receiveUnshielded(stable, amount)`.** A mint through
 *     it requires an unshielded token to be sent INTO that contract in the same
 *     transaction — and `wrap` declares no circuit that can ever send one out
 *     again. `contracts/probe-out6/unwrap` is a SEPARATE contract with its own
 *     address and its own balance, so it cannot redeem what `wrap` holds.
 *     Whatever funds the mint stays in that contract for ever, which is
 *     `CLAUDE.md` rule 23 on test money and would be rule 23 on anybody's.
 *   · **It puts NIGHT in an unshielded offer**, which is the exact transaction
 *     shape the node refused on 30 Aug — `C272`, `V-176`: the balancer's NIGHT
 *     change output is budgeted as a boolean and enforced at 1.886 ms, and the
 *     submission was refused by 38 µs. `ROUND-S16.md` says `C272` and `C273`
 *     do not apply to this round because a shielded deposit creates no NIGHT
 *     change output. **That is true of the deposit and false of a mint through
 *     `wrap`**, so choosing `wrap` would walk the round into the refusal the
 *     brief had reasoned its way out of.
 *
 * `mint-64/issue` is one statement — `mintShieldedToken` and nothing else. It
 * receives nothing, so there is nothing to strand and no unshielded offer.
 * **It is compiled at this project's pin** (`compiler/contract-info.json`:
 * compiler 0.33.0, language 0.25.0, runtime 0.18.0-rc.1) **with keys on disk**,
 * `keys/issue.prover` 5,204,344 bytes and `keys/issue.verifier` 2,119 bytes,
 * both dated 15 Aug — read off the directory, not remembered.
 *
 * ------------------------------------------------------------------------
 * **WHAT HAS NEVER HAPPENED, AND THIS RUN IS BOTH OF IT**
 *
 * **No proof has ever been produced for a mint by this project, and no probe
 * contract of any kind is deployed on stagenet.** `.midnight/` holds a record
 * for the account and for two vaults and for nothing else; the only recorded
 * run of `scripts/chain-probe.ts` (`REPORT-CHAIN-PROBE.txt` and
 * `logs/chain-probe-console.txt`, 16 Aug) stopped at its stage 3 — *deploying*
 * — with node error 170, `InvalidDustSpendProof`, **before its mint**.
 *
 * So this run does two first things in one go: it deploys a contract that has
 * never been deployed, and then proves a circuit that has never been proved.
 * **Each is one attempt and the report says which one stopped.**
 *
 * ------------------------------------------------------------------------
 * **IT MINTS TO THE WALLET'S OWN COIN PUBLIC KEY, AND THAT IS THIS PROJECT'S
 * DECISION RATHER THAN A LIMIT THE PLATFORM IMPOSES.** `V-111`.
 *
 * **The correction first, because the obvious sentence is false.**
 * `createZswapOutput` resolves a recipient's encryption public key and throws
 * when it cannot — `midnight-src/midnight-js/packages/contracts/src/utils/
 * zswap-utils.ts:151-157` — **but the resolver accepts three things, not one**
 * (`:85-97`): the caller's own coin key, the shielded BURN key, which needs no
 * mapping at all, and anything in `additionalCoinEncPublicKeyMappings`. That
 * mapping is a first-class supported option, carried through `call.ts`,
 * `deploy-contract.ts` and `tx-interfaces.ts`. **So "the SDK will not let you
 * mint to anybody else" is not true, and a door that says it would be teaching
 * a platform fact that is not one.**
 *
 * What is true is the reason: **a coin minted to a key whose secret is not on
 * this machine is money nobody can spend**, and there is no way to tell that
 * mistake from an intention afterwards. So the recipient is read from the
 * wallet — `wallet.getCoinPublicKey()` — and is not an argument, an
 * environment variable or a prompt. **The enforcement is this file's**, and it
 * would not survive a second caller of the same contract.
 *
 * ------------------------------------------------------------------------
 * **WHAT IS RECORDED LOCALLY, AND WHY IT IS NOT THE COIN**
 *
 * `.midnight/<network>-test-token.json` records the minter's address, the
 * COLOUR that arrived, and one line per mint. **It does not record the coin.**
 * The coin is the wallet's — a mint to a user key carries a ciphertext and the
 * wallet finds it by scanning, permanently, with no help from this file
 * (`V-111`'s correction to `V-77`) — and a second copy of a coin on disk is a
 * second thing that can be stale, which is what `C124` and `V-47` were both
 * about.
 *
 * ------------------------------------------------------------------------
 * **WHAT IS EXPECTED TO REFUSE THIS, AND IT IS NOT WHAT THE ROUND'S BRIEF
 * EXPECTED.** `C272`, `V-176`, and the row this round filed.
 *
 * `ROUND-S16.md` reasons that `C272` does not apply to this round because a
 * shielded transaction creates no NIGHT change output and does carry Zswap
 * offers, so both halves of `V-176`'s budgeting gap close. **Read against the
 * ledger's own source that is wrong here, and this door is the one it is
 * wrong about first.**
 *
 * `per_tx_cost_reserve` counts Zswap items off the **contract's effects** —
 * `claimed_nullifiers` and `claimed_shielded_receives`,
 * `midnight-src/midnight-ledger/ledger/src/construct.rs:898-905` — and adds
 * the Pedersen pair only when that count is above zero (`:938-942`).
 * **`mintShieldedToken` claims a SPEND, not a receive** — the standard
 * library's own `kernel.claimZswapCoinSpend(cm)`, generated into
 * `contracts/probe-out4/mint-64/contract/index.js` as effects index 2 — so for
 * this transaction the reserve counts **zero** Zswap items and skips the
 * Pedersen pair, exactly as it did on the run `V-176` measured. The enforcing
 * side counts the balanced offer (`structure.rs:1879-1888`), where the minted
 * output is plainly present.
 *
 * **So the expected refusal at the node is `OutsideTimeToDismiss`, and it is
 * expected HERE rather than at the deposit.** If it fires, nothing is spent —
 * a refused submission enters no block — and the finding is that `V-176`'s gap
 * is general rather than about NIGHT. If it does NOT fire, that is a
 * measurement worth as much: it would mean the margin absorbed a term this
 * reading says is unbudgeted.
 *
 * **THE CHECK THAT WOULD SAY SO BEFORE THE FEE ALREADY RUNS IN THIS PROCESS
 * AND ITS ANSWER IS THROWN AWAY.** `scripts/tx-size.ts`'s `measureCost` calls
 * `Transaction.cost(params, true)` — the same call the node makes — on the
 * balanced transaction, before `submitTx`; when the time-to-dismiss check
 * throws, the reading is discarded and only a `problem` string survives
 * (`V-177`). This door prints that string loudly and cannot act on it: turning
 * it into a refusal is a change to the client, not to an instrument.
 *
 * ------------------------------------------------------------------------
 * **ONE ATTEMPT.** No retry, no fallback to another port, image or network. A
 * retry that succeeds after a failure hides which one was real. **Running this
 * door twice mints twice**, which is harmless — it is a test token — and is
 * still said out loud rather than left to be noticed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { randomBytes } from '@noble/hashes/utils.js';

import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import { StaticProofServerContainer, createDefaultTestLogger } from '@midnight-ntwrk/testkit-js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

import { Contract as MinterContract } from '../contracts/probe-out4/mint-64/contract/index.js';
import { applyNetworkId, networkFromEnv } from '../src/midnight/network.js';
import { sleep } from '../src/midnight/retry.js';
import { explainNodeError, NODE_ERROR_CODES } from './node-errors.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';
import { bringUpWallet } from './wallet-bringup.js';
import { saveDustState } from './dust-wallet.js';
import { shieldedHeldOf, waitForShieldedScan, whyNoCoin, SHIELDED_DEADLINE_IS_NOT_MEASURED } from './shielded-wallet.js';
import { collapseRepeatedLines, describeDropped, serialiseWholeDetailed } from './error-report.js';
import {
  compareAgainstLimits, compareCost, limitsFromLedger, measuringProviders,
  type BlockLimits, type TxMeasurement,
} from './tx-size.js';
import { phaseClock, withTimeout, describeError, captureNodeLines } from './deploy-report.js';

/* ------------------------------------------------------------------ */

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, '.midnight');
const SEED_FILE = join(STATE_DIR, 'wallet.seed');
const NETWORK = networkFromEnv(process.env.MIDNIGHT_NETWORK_ID, 'stagenet');
const MINTER_ARTEFACTS = join(ROOT, 'contracts', 'probe-out4', 'mint-64');

/* 6301, NOT 6300 — `M-144`. Port 6300 has an 8.1.0 server on it and a proof it
 * builds is refused by this node's fee check as error 170. */
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT || 6301);

const PRIVATE_STATE_ID = `confidential-accounts-${NETWORK}`;
const PRIVATE_STATE_PASSWORD =
  process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD || 'ConfidentialAccounts-Dev-2026';

/** How much to mint, in the token's smallest unit. No default. */
const MINT_AMOUNT = (process.env.MINT_AMOUNT ?? '').trim();

/**
 * The largest amount `mintShieldedToken` will take.
 *
 * **READ OFF THE COMPILER'S OWN ERROR AND NOT FROM MEMORY** —
 * `REPORT-PROBE-MINT.txt` prints the declared signature:
 * `(Bytes<32>, Uint<64>, Bytes<32>, Either<…>)`, and the generated contract
 * carries the same bound as a runtime guard
 * (`contracts/probe-out4/mint-64/contract/index.js`).
 *
 * **`REPORT-PROBE-MINT-2.txt` COMPILED this value and did not mint it**, which
 * is a different claim: nothing has ever minted anything here. An earlier draft
 * of this comment said it had been minted, which is rule 9 — a number an
 * instrument did not read.
 */
const UINT64_MAX = 18_446_744_073_709_551_615n;

/* ------------------------------------------------------------------ *
 * the screen
 * ------------------------------------------------------------------ */

/**
 * **NO SCREEN GUARD HERE, AND THE ABSENCE IS A DECISION RATHER THAN AN
 * OVERSIGHT.** `C236`.
 *
 * `fund-vault.ts` and `open-vault-pool.ts` refuse to print a line carrying a
 * VAULT's address, because a plain send to a vault is money on chain nobody can
 * spend and no contract can refuse. **This contract is not a vault**: it holds
 * no treasury, it has one circuit, and it is deliberately throwaway. Its
 * address has to be printed and recorded because deriving the token's colour
 * needs it and reusing the deployment needs it.
 *
 * **The hazard it does have is said out loud instead**: anything sent to this
 * contract is stranded there exactly as it would be at a vault, and the reason
 * is the same one — no contract can refuse money sent to it.
 */
const say = (line = '') => console.log(line);
const clock = phaseClock(say);
const note = (s: string) => say(`  ${s}`);
const good = (s: string) => say(`  \x1b[32m✓\x1b[0m ${s}`);

const rawNodeLines = captureNodeLines(explainNodeError);

const txMeasurements: TxMeasurement[] = [];
let blockLimits: BlockLimits | null = null;
let ledgerParameters: any = null;
let proofServerImage = '(not established)';
let proofServerVersion = '(not asked)';
let provingSeconds: number | null = null;

/* ------------------------------------------------------------------ *
 * what is decided before anything is spent
 * ------------------------------------------------------------------ */

/**
 * The amount, as a whole number of the token's smallest unit.
 *
 * **NO DECIMAL POINT, FOR `fund-vault.ts`'s REASON AND ONE OF ITS OWN.** That
 * door refuses a point because how many decimal places NIGHT has has never been
 * measured against the chain. This token has no decimal places at all: it is a
 * test asset minted by a probe, and nothing anywhere declares a scale for it.
 * A door that accepted `5.5` here would be inventing one.
 *
 * Exported so `mint-test-token.test.ts` can drive every refusal without a
 * chain.
 */
export function amountFromText(text: string): bigint {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    throw new Error(
      'no amount was given. MINT-TEST-TOKEN.command asks how much and passes the answer here; ' +
      'reaching this means the question went unanswered.\n' +
      'There is deliberately no default: a default is a number nobody chose.');
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `"${trimmed}" is not an amount this door will take. It wants digits and nothing else: ` +
      'no point, no separators, no sign, no exponent.\n' +
      'THIS TOKEN HAS NO DECIMAL PLACES. It is minted by a probe contract for this test and ' +
      'nothing declares a scale for it, so a door that accepted a point would be inventing one.');
  }
  const amount = BigInt(trimmed);
  if (amount <= 0n) {
    throw new Error('a mint of nothing is not a mint, and there would be no coin to deposit.');
  }
  if (amount > UINT64_MAX) {
    throw new Error(
      `${amount} does not fit in the Uint<64> that mintShieldedToken declares — the ceiling is ` +
      `${UINT64_MAX}, read off the compiler's own error in REPORT-PROBE-MINT.txt.\n` +
      'This refuses it here rather than after a wallet, a dust wait and a proof server.');
  }
  return amount;
}

/** Where the record of the minter and its colour lives, per network. */
export const testTokenFile = (stateDir: string, network: string): string =>
  join(stateDir, `${network}-test-token.json`);

/**
 * The record, or a refusal — never a guess.
 *
 * **A CONTRACT ADDRESS MEANS NOTHING ON ANOTHER CHAIN**, which is
 * `chain-probe.ts`'s refusal and the same one: reusing a stagenet deployment
 * against a different network is a run that fails somewhere further in, saying
 * something about the state rather than about the record.
 *
 * Exported and pure so the test can drive it.
 */
export function parseTestTokenRecord(parsed: any, network: string): {
  contractAddress: string; colour?: string;
} {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('the test-token record is not an object. It is not a record this door wrote.');
  }
  if (String(parsed.network ?? '') !== network) {
    throw new Error(
      `the test-token record is for the network "${String(parsed.network ?? '')}" and this run is ` +
      `on "${network}". A contract address means nothing on another chain.`);
  }
  const contractAddress = String(parsed.contractAddress ?? '').trim();
  if (!/^[0-9a-f]{64}$/.test(contractAddress)) {
    throw new Error(
      'the test-token record carries no usable contract address, so there is nothing to reuse ' +
      'and nothing to derive a colour from.');
  }
  const colour = typeof parsed.colour === 'string' && /^[0-9a-f]{64}$/.test(parsed.colour)
    ? parsed.colour : undefined;
  return { contractAddress, colour };
}

/**
 * **WHICH COIN WAS MINTED, READ OFF THE CALL'S OWN ANSWER.**
 *
 * **THE PLATFORM ALREADY HANDS THIS BACK AND AN EARLIER DRAFT OF THIS FILE
 * WENT LOOKING FOR IT.** `createUnprovenCallTx` puts `newCoins` on the result —
 * `midnight-src/midnight-js/packages/contracts/src/unproven-call-tx.ts:176-179`
 * — built by filtering the circuit's own Zswap outputs for the caller's coin
 * key (`utils/zswap-utils.ts:182-185`), and it reaches this door on
 * `FinalizedCallTxData.private.newCoins`. It is the coin the circuit made, with
 * its colour, its value and the nonce this run chose, **at call time and
 * without asking the chain anything**.
 *
 * The draft this replaces snapshotted the wallet's coin commitments before and
 * after and took the difference. That is a worse answer to the same question in
 * three ways, and the middle one costs money: it cannot start until the
 * shielded sub-wallet has synced; **a coin from an earlier run arriving late
 * reads as this run's**, so the colour written into the record could be read
 * off somebody else's coin; and it has to refuse whenever two coins arrive,
 * which produced a whole failure mode, a whole exit code and a whole banner
 * for a question that was never open.
 *
 * `docs/handoff/00-START-HERE.md` names not asking whether the platform already
 * does it as the failure this project has paid most for. This is that, caught
 * by the `platform-fact-checker` pass before the door was ever run.
 *
 * Exported and pure, so every outcome can be driven without a chain.
 */
export function theMintedCoin(newCoins: unknown): { type: string; value: bigint; nonce?: string } {
  if (!Array.isArray(newCoins)) {
    throw new Error(
      'the mint landed and the call did not report the coin it created. `newCoins` is built by ' +
      'midnight-js from the circuit\x27s own Zswap outputs, so its absence means the SDK\x27s ' +
      'answer is not the shape this door was written against — a version difference, not a ' +
      'chain problem. NO COLOUR IS RECORDED, because the only honest source for it is gone.');
  }
  if (newCoins.length !== 1) {
    throw new Error(
      `the mint reported ${newCoins.length} new coins and this circuit creates exactly one. ` +
      'This door will not choose between them: a colour written into the record wrongly is a ' +
      'deposit aimed at the wrong money.');
  }
  const coin: any = newCoins[0];
  const type = String(coin?.type ?? '');
  /*
   * **VALIDATED HERE, BECAUSE EVERY READER OF THE RECORD VALIDATES IT AND THE
   * WRITER DID NOT.** `parseTestTokenRecord` below requires 32 bytes of lower
   * hex; a value that fails it is stored as *no colour at all*, and the next
   * door then explains that absence to an operator as *"the mint was submitted
   * and the coin could not be identified"* — a confident, wrong account of what
   * happened. So the shape is checked where it is written.
   */
  if (!/^[0-9a-f]{64}$/.test(type)) {
    throw new Error(
      `the coin the mint reported carries a token type this door does not recognise as a ` +
      `colour: ${JSON.stringify(type).slice(0, 80)}. Every reader of the record requires 32 ` +
      'bytes of lower-case hex, so writing this would produce a record that reads as having no ' +
      'colour — and the next door would explain that absence as something else entirely.');
  }
  return { type, value: BigInt(coin?.value ?? 0n), nonce: typeof coin?.nonce === 'string' ? coin.nonce : undefined };
}

/* ------------------------------------------------------------------ *
 * the size block
 * ------------------------------------------------------------------ */

/** Printed on success and on refusal alike. `C218`, `R1c`, `C238`. */
function printTxSize() {
  say();
  say('  \x1b[1mHow big the transactions were, against what the chain will carry\x1b[0m');
  if (!txMeasurements.length) {
    say('    NO TRANSACTION WAS BUILT IN THIS RUN, so there is no size to report and none is');
    say('    estimated. The stage named above says how far it got.');
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
  } else {
    say();
    say('    THE COST COULD NOT BE READ, AND THAT IS ITS OWN FINDING RATHER THAN A GAP.');
    say('    scripts/tx-size.ts asks Transaction.cost(params, true) — the same call the node');
    say('    makes — and when the time-to-dismiss check throws, all five dimensions are lost');
    say('    with it. V-177 is that row, and this is what it looks like from a run.');
  }
  say();
  say('    NOTHING ABOVE IS COMPARED TO AN EXPECTED FIGURE. No mint has ever been built by');
  say('    this project, so a number written here would be an invention that outlives the run');
  say('    that invented it. Compare it against the next run of this door.');
}

/** What proved, and how long it took. Measured, or said to be absent. `C238`. */
function printProving() {
  say();
  say('  \x1b[1mWhat proved, and what it took\x1b[0m');
  say('    circuit           issue  (one call, one transaction)');
  say(`    proof server      ${proofServerImage}`);
  say(`    /version          ${proofServerVersion}`);
  if (provingSeconds === null) {
    say('    time              NOT MEASURED — the call did not complete, so there is no');
    say('                      duration to report and none is estimated.');
    return;
  }
  say(`    prove and submit  ${provingSeconds.toFixed(1)}s wall clock`);
  say('    THAT NUMBER COVERS THE WHOLE CALL, not the proof alone.');
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

/**
 * **THE TWO STATES A LANDED MINT CAN BE IN, AND NEITHER IS A FAILURE.** The
 * colour is known in both, because the call reports it. What differs is whether
 * the wallet has scanned the coin, which is the only thing the deposit needs
 * and the only thing this door cannot make happen.
 */
type Verdict = 'minted-and-in-hand' | 'submitted-not-confirmed';

async function main(): Promise<Verdict> {
  say('────────────────────────────────────────────────────────────');
  say(`  Minting a shielded test token on ${NETWORK}`);
  say('────────────────────────────────────────────────────────────');
  say();
  say('  ONE ATTEMPT AT EACH OF TWO THINGS THAT HAVE NEVER BEEN DONE HERE:');
  say('  a probe contract deployed on this network, and a mint proved.');

  /* -------------------------------------------------- 1 */
  clock.begin(1, 6, 'How much, and what is being minted');

  const amount = amountFromText(MINT_AMOUNT);
  good(`minting ${amount.toLocaleString()} of a token this run creates`);
  note('  IT IS A TEST ASSET AND IT IS NOT WHAT A CUSTOMER HOLDS. A probe contract mints it,');
  note('  anybody who learns that contract\x27s address can mint themselves as much of it as');
  note('  they like, and nothing backs it. It exists to find out whether the private path');
  note('  moves at all — no converter work is done here and none is implied.');

  const proverKey = join(MINTER_ARTEFACTS, 'keys', 'issue.prover');
  if (!existsSync(proverKey)) {
    throw new Error(
      'contracts/probe-out4/mint-64/keys/issue.prover does not exist, so this mint cannot be ' +
      'proved.\nThose keys were built on 15 Aug and are committed with the probe. If they are ' +
      'gone, the door that rebuilds them is COMPILE-CONTRACT.command\x27s compiler — and note ' +
      'that MUTATE.command\x27s last restore leaves no keys for anything.');
  }
  good('the proving key for issue is on disk');

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
    ?? '(not exported — run through MINT-TEST-TOKEN.command to record it)';
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
    note('  THOSE ARE THE GENESIS PARAMETERS AND NOT THE CHAIN\x27S. V-178: ledger parameters are');
    note('  mutable state and this project has never read the live ones. Every figure below that');
    note('  is compared against a limit is compared against initialParameters().');
  } catch (e: any) {
    note(`the block limits could not be read: ${String(e?.message ?? e)}`);
  }

  /* -------------------------------------------------- 4 */
  clock.begin(4, 6, 'Getting the funded wallet');

  if (!existsSync(SEED_FILE)) {
    throw new Error(
      `there is no wallet: ${SEED_FILE.replace(ROOT + '/', '')} does not exist.\n` +
      'This door will not make one. A fresh wallet holds nothing and the faucet wants a ' +
      'captcha, so a wallet made here would be a wallet that cannot pay, discovered after the ' +
      'proof server was up. DEPLOY-PREVIEW.command prints the address and the faucet URL.');
  }
  const masterSeed = readFileSync(SEED_FILE, 'utf8').trim();
  note(`using the wallet in ${SEED_FILE.replace(ROOT + '/', '')}`);

  const live = await bringUpWallet(logger, cfg, masterSeed, NETWORK, ROOT, {
    withDust: true, requireDust: true, onNote: note,
  });
  const wallet: any = live.wallet;
  good(`wallet ready — NIGHT ${live.night().toLocaleString()}, DUST ${live.dust().toLocaleString()}`);
  const cached = await saveDustState(wallet, masterSeed, NETWORK, ROOT);
  if (cached) good(`dust wallet state cached (${(cached / 1024).toFixed(0)} KB)`);

  /*
   * **THE RECIPIENT, READ FROM THE WALLET AND NEVER TAKEN FROM ANYWHERE ELSE.**
   * See the header: the SDK would happily build a mint to somebody else's key
   * given their encryption key, and to the burn key given nothing at all. **The
   * refusal is this door's**, and the reason is that a coin minted to a key
   * whose secret is not on this machine is money nobody can spend.
   */
  const { encodeCoinPublicKey } = await import('@midnight-ntwrk/compact-runtime');
  const ourCoinPublicKey: string = String(wallet.getCoinPublicKey());
  good(`minting to this wallet\x27s own coin public key — ${ourCoinPublicKey.slice(0, 24)}…`);
  note('  not a prompt, not an environment variable, not a default. V-111.');

  const hexOf = (b: Uint8Array): string =>
    [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  /*
   * **THE SECOND COPY IS GONE.** `S17`, `M-104`.
   *
   * This door had its own `heldOf` and its own five-minute poll; the deposit
   * door had a third reading of the same coin list and no wait at all. One
   * implementation now lives in `shielded-wallet.ts` and both doors reach it.
   * `shieldedHeldOf(state, colour)` answers only whether the wallet has SEEN a
   * colour — which coin this run created is answered by the call itself
   * (`theMintedCoin`), a different question with a different failure.
   */
  const heldOf = (colour: string): bigint | null => shieldedHeldOf(live.state(), colour);

  /* -------------------------------------------------- 5 */
  clock.begin(5, 6, 'The minter — deployed for the first time, or reused');

  const zkConfigProvider = new NodeZkConfigProvider<string>(MINTER_ARTEFACTS);
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
    if (m.cost?.exceeded) note(`  THE LEDGER WILL NOT NORMALISE THIS COST: ${m.cost.exceeded}`);
  }, ledgerParameters);

  /*
   * The compiled contract, not a `new Contract(...)` instance. Handing the SDK
   * an instance is the mistake `M-16` lost a round to.
   *
   * NO WITNESSES: `issue` reads nothing from a device — every input is a
   * circuit argument — so the witness object is empty and that is correct
   * rather than an omission.
   */
  const compiled = CompiledContract.make('TestTokenMinter', MinterContract as any).pipe(
    CompiledContract.withWitnesses({} as any),
    CompiledContract.withCompiledFileAssets(MINTER_ARTEFACTS as never),
  ) as any;
  good(`compiled contract "${compiled.tag}", assets at contracts/probe-out4/mint-64`);

  const recordFile = testTokenFile(STATE_DIR, NETWORK);
  let found: any;
  let minterAddress: string;

  if (existsSync(recordFile)) {
    const existing = parseTestTokenRecord(JSON.parse(readFileSync(recordFile, 'utf8')), NETWORK);
    minterAddress = existing.contractAddress;
    note(`reusing the minter recorded in ${recordFile.replace(ROOT + '/', '')}`);
    found = await findDeployedContract(measured as any, {
      compiledContract: compiled, contractAddress: minterAddress,
    } as any);
    good(`found on chain, verifier keys match — ${minterAddress.slice(0, 24)}…`);
  } else {
    note('no minter is recorded on this network, so one is deployed. This is the first time');
    note('this project has deployed anything that is not the account or a vault.');
    /*
     * Settle before submitting. The node's websocket closes cleanly a few
     * seconds after the wallet connects, so submitting immediately is
     * submitting into the gap on purpose. `M-23`.
     */
    note('letting the node websocket settle before submitting');
    await sleep(6000);
    const deployed: any = await withTimeout(
      'deploying the minter', 6 * 60_000,
      deployContract(measured as any, { compiledContract: compiled } as any));
    if (!deployed) throw new Error('the deploy reported landed but returned nothing to continue from');
    found = deployed;
    minterAddress = String(deployed.deployTxData.public.contractAddress);
    good(`the minter is deployed — ${minterAddress.slice(0, 24)}…`);
    writeFileSync(recordFile, `${JSON.stringify({
      network: NETWORK,
      contractAddress: minterAddress,
      deployedAt: new Date().toISOString(),
      note: 'A THROWAWAY MINTER FOR A TEST TOKEN. It has one circuit, holds no treasury and '
        + 'backs nothing. Anything SENT to this address is stranded there, exactly as it would '
        + 'be at a vault and for the same reason: no contract can refuse money sent to it.',
      mints: [],
    }, null, 2)}\n`);
    good(`recorded in ${recordFile.replace(ROOT + '/', '')} — a second run reuses it`);
  }

  providers.privateStateProvider.setContractAddress?.(minterAddress);

  /* -------------------------------------------------- 6 */
  clock.begin(6, 6, 'The mint — the first proof of a mint this project has produced');
  note('one circuit call, one transaction. Give it a few minutes.');

  /*
   * A FRESH NONCE PER MINT, MADE HERE AND RECORDED AFTERWARDS.
   *
   * The nonce is a circuit argument, so it is the caller's choice, and two
   * mints of the same amount to the same key under the same nonce are the same
   * coin — which the ledger will not accept twice. `randomBytes` and not a
   * counter: a counter is a second thing to keep, and losing it looks exactly
   * like never having had one.
   */
  const nonce = randomBytes(32);
  note(`nonce ${hexOf(nonce).slice(0, 24)}… (fresh this run)`);

  const startedAt = Date.now();
  const done: any = await withTimeout(
    'the mint', 6 * 60_000,
    (found.callTx as any).issue({ bytes: (encodeCoinPublicKey as any)(ourCoinPublicKey) }, amount, nonce));
  provingSeconds = (Date.now() - startedAt) / 1000;
  const txId = String(done?.public?.txId ?? done?.public?.txHash ?? '(not in the answer)');
  good(`minted and submitted in ${provingSeconds.toFixed(1)}s — transaction ${txId}`);

  printProving();
  printTxSize();

  /*
   * **THE COIN IS THE CALL'S OWN ANSWER, AND THE WALLET IS ASKED A DIFFERENT
   * QUESTION AFTERWARDS.**
   *
   * `newCoins` is what the SDK built out of the circuit's own Zswap outputs, so
   * the colour, the value and the nonce are settled the moment the call returns
   * — no derivation, no diff, no chance of reading somebody else's coin. What
   * is NOT settled is whether the wallet has scanned it, and the deposit cannot
   * balance until it has, so that is asked separately and reported as its own
   * state rather than folded into the same answer.
   */
  const minted = theMintedCoin((done as any)?.private?.newCoins);
  const colour = minted.type;
  say();
  say('  \x1b[1mWhat was minted\x1b[0m');
  say(`    ${minted.value.toLocaleString()} of colour ${colour}`);
  say('    THE CALL REPORTED THAT, not a derivation and not a difference between two wallet');
  say('    readings. It is what DEPOSIT-TO-VAULT.command reads and what the vault will record.');
  if (minted.value !== amount) {
    say(`    \x1b[33mTHE COIN IS WORTH ${minted.value.toLocaleString()} AND ${amount.toLocaleString()} WAS ASKED FOR.\x1b[0m`);
    say('    That is a disagreement between this door and the circuit and is worth reporting.');
  }

  const record = JSON.parse(readFileSync(recordFile, 'utf8'));
  record.colour = colour;
  record.mints = [...(Array.isArray(record.mints) ? record.mints : []), {
    at: new Date().toISOString(), amount: String(amount), nonce: hexOf(nonce), txId,
  }];
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  good(`the colour is recorded in ${recordFile.replace(ROOT + '/', '')}`);

  /*
   * **AND NOW THE SECOND QUESTION: HAS THE WALLET SEEN IT.**
   *
   * A mint to a user key carries a coin ciphertext and the wallet finds it by
   * scanning — `V-111`, and the ledger's own scan at `zswap/src/local.rs:176-197`
   * decrypts each output and keeps the coins whose commitment matches. **When
   * that happens is not something any source read here states.**
   *
   * **THE FIVE MINUTES THIS DOOR USED TO CHOOSE ARE GONE.** `S17`. It was a
   * number with nothing under it, and the door beside this one copied it into
   * a place where it never ran at all. The wait is now one function, its
   * deadline is disclosed as unmeasured in its own output, and the answer it
   * returns is what decides which of the two sentences below gets printed —
   * *the scan has not caught up* is not *there is no such coin*.
   *
   * This door waits HERE rather than at bring-up, and the difference is real:
   * the deposit door needs the scan finished BEFORE it reads, and this one is
   * asking about a coin that did not exist when the wallet started. Same
   * function, different moment.
   */
  say();
  say('  \x1b[1mWaiting for the wallet to scan it\x1b[0m');
  /*
   * **`until` IS THE ONLY WAY OUT OF THIS WAIT BUT THE DEADLINE, AND THAT IS
   * NOT A DETAIL.** Reaching the tip does not answer *has my coin arrived*: the
   * platform's caught-up predicate allows ten events of slack, which is exactly
   * where a coin submitted seconds ago sits. `shielded-wallet.ts` refuses to
   * end on caught-up when a caller supplies its own question.
   *
   * **`null` IS NOT ZERO.** A coin list that could not be read is a fault in
   * this machine, not a coin that is absent, and it must never end the wait as
   * though the answer were known.
   */
  const scan = await waitForShieldedScan(live, note, { until: () => (heldOf(colour) ?? 0n) > 0n });
  const inHand = heldOf(colour);

  let verdict: Verdict = 'submitted-not-confirmed';
  if (inHand !== null && inHand > 0n) {
    verdict = 'minted-and-in-hand';
    good(`the wallet holds ${inHand.toLocaleString()} of that colour`);
    // An upper bound sampled every 2s, not a measurement — rule 9.
    good(`the shielded scan reached it within ${Math.round(scan.waitedMs / 1000)}s — ${scan.describe}`);
    note(`  ${SHIELDED_DEADLINE_IS_NOT_MEASURED}`);
  } else {
    const why = whyNoCoin(colour, scan, inHand);
    say();
    say(`  \x1b[1m${why.holding} — AND THAT IS NOT THE MINT HAVING FAILED.\x1b[0m`);
    for (const line of why.message.split('\n')) say(`    ${line}`);
    say(`    The colour IS recorded, so nothing is lost and nothing has to be guessed later.`);
    say(`    The transaction id is ${txId}.`);
    say('    DEPOSIT-TO-VAULT.command waits for this same scan and refuses while the wallet');
    say('    holds none of that colour. Run it when the wallet has caught up — not this door,');
    say('    \x1b[1mwhich would mint a second coin.\x1b[0m');
    say('    THIS DOOR NEVER SAYS THE COIN DOES NOT EXIST. It submitted the transaction itself');
    say('    and nothing here reads back which block it landed in.');
  }

  say();
  say('  \x1b[1mWhat this coin can and cannot do\x1b[0m');
  say('    IT CAN BE DEPOSITED INTO A VAULT. That is the next door and the only reason this');
  say('    one exists.');
  say('    IT CANNOT BE PAID OUT OF ONE YET, FOR TWO OPEN REASONS AND NOT ONE. A payment out');
  say('    asks the account to authorise a leaf carrying a token, and this client writes an');
  say('    asset code into that leaf while the vault holds a colour — different values, and');
  say('    the circuit compares them (`C269`). AND a note is spent through a witness that');
  say('    refuses without the index the chain filed the commitment at, which no deposit knows');
  say('    and nothing here reads back (`C244`, `V-93`). The first is understood. THE SECOND IS');
  say('    NOT: `C244`\x27s own words are that if the index cannot be read back, this is loss.');
  say('    NOTHING BACKS IT. It is not a stablecoin, a wrapped asset or a customer\x27s money.');

  live.stop();
  return verdict;
}

/* ------------------------------------------------------------------ *
 * the refusal, unabridged and bounded
 * ------------------------------------------------------------------ */

function fail(e: any): never {
  console.log('');
  console.log(`\x1b[31m\x1b[1m  Failed during: ${clock.stage}\x1b[0m`);
  console.log(describeError(e, explainNodeError).split('\n').map((l) => '  ' + l).join('\n'));
  if (e?.stack) console.log(`\n\x1b[2m${String(e.stack).split('\n').slice(1, 8).join('\n')}\x1b[0m`);

  clock.print('stopped');
  try { printProving(); } catch { /* what is above stands */ }
  try { printTxSize(); } catch { /* the same */ }

  console.log();
  console.log("  \x1b[1mThe node's own words, verbatim and uncut\x1b[0m");
  if (rawNodeLines.length) {
    for (const line of collapseRepeatedLines(rawNodeLines)) {
      for (const part of line.split('\n')) console.log(`    ${part}`);
    }
    const codes = [...new Set(rawNodeLines.flatMap(
      (l) => [...l.matchAll(/Custom error:\s*(\d+)/g)].map((m) => m[1])))];
    console.log();
    for (const c of codes) {
      console.log(`    code ${c} = ${NODE_ERROR_CODES[c!] ?? '(not in our table — look it up in the node source, do not guess)'}`);
    }
    if (!codes.length) {
      console.log('    No numeric rejection code appears above. The node answered, but not with a');
      console.log('    Custom error.');
    }
  } else {
    console.log('    NOTHING. Either the run never reached a submission, or the node never');
    console.log(`    answered one. The stage above — "${clock.stage}" — says which.`);
  }

  console.log();
  console.log('  \x1b[1mThe error object, whole — bounded, and it says what it dropped\x1b[0m');
  const serialised = serialiseWholeDetailed(e);
  console.log(serialised.text.split('\n').map((l) => '    ' + l).join('\n'));
  console.log();
  for (const line of describeDropped(serialised.dropped)) console.log(`    ${line}`);

  console.log();
  console.log('  \x1b[33mIF THE MINT LANDED AND THIS RUN STOPPED AFTERWARDS, the coin is in the\x1b[0m');
  console.log('  \x1b[33mwallet and the COLOUR was not recorded.\x1b[0m The next door reads that record, so');
  console.log('  it will refuse and say so. Running this door again mints a second coin rather');
  console.log('  than recovering the first.');
  process.exit(1);
}

/**
 * GUARDED, so a test can import the pure parts above without this file going to
 * the network and spending money on import. `fund-vault.ts` and
 * `measure-note-index.ts` carry the same guard for the same reason.
 */
const RUN_DIRECTLY = typeof process.argv[1] === 'string'
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

/**
 * 0  the mint landed, the colour is recorded, and the wallet has scanned the
 *    coin.
 * 3  the mint landed and the colour IS recorded — the call reported it — and
 *    the wallet had not scanned the coin within this run's five minutes. Not a
 *    failure and not a success: nothing is lost, nothing has to be guessed, and
 *    the next door refuses in plain words until the wallet catches up.
 * 1  the run stopped before the mint, or on it. `fail` prints why.
 */
if (RUN_DIRECTLY) {
  main().then((v) => process.exit(v === 'minted-and-in-hand' ? 0 : 3), fail);
}

/* ------------------------------------------------------------------ *
 * THE `.command` THIS NEEDS, NAMED AND WRITTEN BESIDE IT
 * ------------------------------------------------------------------ */

/*
 * **`MINT-TEST-TOKEN.command`.** Recorded here because the door is what a
 * person opens, and a run order naming `npx tsx scripts/mint-test-token.ts` is
 * an instruction nobody at the machine can follow (`C226`).
 *
 * WHAT IT PASSES — exported, because this file reads the environment and
 * nothing else:
 *
 *     MIDNIGHT_NETWORK_ID   the network to mint on.
 *     MINT_AMOUNT           how much, digits only. NO DEFAULT.
 *     MIDNIGHT_PROOF_IMAGE  the pinned image, so the report records what the
 *                           proof was built against rather than what was meant
 *                           to be running (`C180`).
 *
 * WHAT IT REFUSES, before running anything:
 *
 *   1. **No amount, or an amount that is not digits.**
 *   2. **No `contracts/probe-out4/mint-64/keys/issue.prover`.**
 *   3. **The proof server on 6301 not answering the pin**, through the shared
 *      `scripts/proof-server-lib.sh`, whose refusals name `STOP-PROVER.command`.
 *
 * WHAT IT MUST NOT DO:
 *
 *   · **Not retry.** One attempt at the deploy and one at the mint.
 *   · **Not stop the proof server.** It is shared and is left running on
 *     purpose.
 *   · **Not offer a recipient.** The recipient is the wallet's own key and the
 *     door must not ask for one.
 *
 * WHAT IT EXPORTS AS A REPORT: `REPORT-MINT-TEST-TOKEN.txt`, ANSI stripped.
 */
