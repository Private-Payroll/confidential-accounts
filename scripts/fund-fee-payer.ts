/**
 * GIVING A FRESH WALLET ENOUGH TO PAY FOR MORE THAN ONE TRANSACTION, AND
 * REFUSING TO DO IT ON SEVEN CONDITIONS.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * A wallet can put one fee-paying spend in a transaction for each NIGHT output
 * it holds that earns the fee token. The wallet this project pays with holds
 * ONE, so it has one such spend per transaction and nothing in reserve: any
 * work needing two is work it cannot do, and any mistake it makes it cannot pay
 * to correct.
 *
 * One transaction fixes that. It takes the NIGHT, splits it into several
 * outputs owned by a fresh wallet, registers that wallet for generation in the
 * same transaction, and leaves one output behind with the old one. Measured
 * against the ledger, that costs exactly one fee-paying spend, which is what
 * the old wallet has.
 *
 * ── AND IT IS THE MOST DANGEROUS TRANSACTION THIS PROJECT SUBMITS ───────────
 *
 * Fees are payable in one token and it is not NIGHT. NIGHT delivered to an
 * address that does not earn that token is money that arrived and can never
 * leave, by anybody, ever. The chain does not refuse it: measured, a transfer
 * to an unregistered address applies cleanly and leaves the recipient holding
 * NIGHT and nothing to spend it with. There is no faucet behind this network
 * and, because this transaction empties the only wallet that could have
 * sponsored a repair, no second chance either.
 *
 * So this door leaves one earning output behind with the old wallet, which is
 * the only on-chain remedy there is, and it rehearses on a submission it has
 * established the node will refuse before it makes the one that counts.
 *
 * ── WHERE THE DECISIONS ARE, AND WHY THEY ARE NOT HERE ──────────────────────
 *
 * Nobody runs this file by hand to find out whether it refuses correctly, and a
 * door that submits is the worst instrument for testing its own refusals. Every
 * decision is therefore taken by a pure function in `fee-payer-funding-rules`,
 * driven by a test that watches each one fail against a named change. What is
 * left here is gathering: read the chain, build the transaction, read it back,
 * and hand what was read to the rules.
 *
 * THE READ-BACK IS THE POINT AND IT IS NOT A FORMALITY. Nothing below trusts
 * what a library was ASKED to build. The outputs, the half they are in and the
 * registration are all read off the transaction that exists, because the
 * failure this door is for is a library doing something other than what the
 * caller asked, quietly, in a way that costs everything.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DustAddress, UnshieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';

import { theNetwork, applyNetworkId } from '../src/midnight/network.js';
import { endpointsOf } from '../src/core/networks.js';
import { bringUpWallet } from './wallet-bringup.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';
import { readHolding, describeHolding } from './chain-registered-night.js';
import {
  fallbackParameters, readLiveParameters, describeParameters, type ParametersReading,
} from './live-ledger-parameters.js';
import { measureCostAt, readDismissRefusal } from './tx-size.js';
import {
  FEE_PAYER_NIGHT_OUTPUTS, abilityToPay, allowanceFor, dismissLimitsFrom, feePayingSpendsOf,
  fundingVerdicts, maySubmit, outputsOf, planOutputs, registrationsOf, signaturesOf,
  type BalancerOutcome, type CostOutcome, type RegistrationCoverage,
} from './fee-payer-funding-rules.js';

const ROOT = process.cwd();
const NETWORK = theNetwork();
/*
 * **THE ENDPOINTS COME FROM THE ONE RECORD AND ARE NOT WRITTEN OUT HERE.**
 * A stagenet url typed into this file was a second copy of a value that has
 * moved under this project once already, and it was a copy that could not be
 * wrong in a way anything noticed: it was the fallback, so it answered
 * whenever the real answer was missing.
 */
const THE = endpointsOf(theNetwork());
const NODE = process.env.MIDNIGHT_NODE_URL || THE.node;
const INDEXER_WS = process.env.MIDNIGHT_INDEXER_WS_URL || THE.indexerWs;
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT || 6301);
const OLD_SEED = join(ROOT, '.midnight', 'wallet.seed');
const NEW_SEED = join(ROOT, '.midnight', 'fee-payer.seed');

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', O = '\x1b[0m';
/** How long a built transaction stays valid. Long enough to prove and send, no longer. */
const TTL_MS = 5 * 60_000;

const say = (s = '') => console.log(s);
const head = (s: string) => { say(); say(`${B}${s}${O}`); };

/**
 * HOW MANY FEE-PAYING SPENDS THIS SHAPE IS EXPECTED TO CARRY.
 *
 * ONE. Measured as spends rather than argued from anything: the wallet
 * library's own balancing was driven at its own entry point and the spends it
 * selected were counted, at one, two, three, four, six and eight held outputs,
 * at the library's starting values and at the parameters this chain is running.
 * All twelve of those readings are 1.
 *
 * The margin is not close, which is why it is the same at every count: one
 * earning output that has reached its cap holds thousands of times the fee this
 * transaction owes, so the first selection already covers it.
 *
 * IT IS NOT ONE WHEN THE OUTPUTS ARE YOUNG. At sixty seconds old the same
 * shapes were measured needing two, three and seven; at forty seconds, three
 * and four - and one of those shapes could not be balanced at all, which is a
 * refusal rather than a larger number and is not part of that range. The wallet
 * paying for THIS transaction is the old one, whose output has been earning for
 * a long time, so one is the expectation here, and more than one means what is
 * paying is not what was measured.
 */
const FEE_PAYING_SPENDS_EXPECTED = 1;

/**
 * Stops the door, saying what was not done rather than only what went wrong.
 *
 * THE CODE SEPARATES STOPS THAT SENT NOTHING FROM ONE THAT SENT SOMETHING.
 * The front prints a different sentence for each, and it used to print
 * "nothing was submitted" for all of them - which is a comfortable thing to
 * read directly after a submission the chain turned down.
 */
async function unbook(facade: any, tx: unknown): Promise<void> {
  if (tx === null || tx === undefined) return;
  try { await facade?.revertTransaction?.(tx); } catch { /* a booking we cannot give back is not worth failing over */ }
}

class Refused extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}
/**
 * A DECLARATION AND NOT AN ARROW, WHICH IS NOT A STYLE CHOICE. The typechecker
 * only narrows what follows a never-returning call when the callee is declared,
 * so written the other way every refusal below would leave the code after it
 * typed as though the door had carried on.
 */
function refuse(what: string, code = STOPPED_BEFORE_SENDING): never { throw new Refused(what, code); }

/** Nothing left this machine. */
const STOPPED_BEFORE_SENDING = 2;
/** The wallet was made on this run and that is all that happened. */
const WALLET_MADE_RUN_AGAIN = 3;
/** Something WAS sent, and the chain turned it down. */
const SENT_AND_REFUSED = 4;

/* ------------------------------------------------------------ the chain --- */

async function parameters(): Promise<ParametersReading> {
  const { LedgerParameters } = await import('@midnightntwrk/ledger-v9') as any;
  const reading = await readLiveParameters(NODE, {
    post: async (node, body) => {
      const res = await fetch(node, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        signal: AbortSignal.timeout(20_000),
      });
      return res.json() as any;
    },
    LedgerParameters,
  });
  if (reading.parameters !== null) return reading;
  /*
   * THE FALLBACK IS TAKEN SO THE REPORT CAN BE PRINTED, AND IT IS NOT A ROUTE
   * THROUGH. The first of the seven checks refuses a fallback outright. Taking
   * it here means a person gets the whole report, including which of the other
   * six would also have stopped this, instead of one line about a node.
   */
  return fallbackParameters(LedgerParameters, reading.problem ?? 'the chain did not answer');
}

/** The chain's own cost call, with enforcement on, keeping the numbers either way. */
function costOf(tx: any, params: unknown): CostOutcome {
  const reading = measureCostAt(tx, params, true);
  if (reading.problem !== undefined) {
    const d = readDismissRefusal(reading.problem);
    if (d === undefined) return { kind: 'unreadable', message: reading.problem };
    return {
      kind: 'refused',
      numbers: { dismissPs: d.timePs, sizeBytes: d.sizeBytes, allowancePs: d.allowancePs },
      message: reading.problem,
    };
  }
  /*
   * ACCEPTED, AND THE MARGIN IS A WEAKER READING THAN THE VERDICT.
   *
   * What settles the verdict is that the chain's own call, with enforcement
   * on, did not refuse. The three numbers beside it are for a reader, and they
   * are harder to come by than they look: the published parameters expose the
   * cost model, the dust parameters, the fee prices, a normaliser and a
   * serialiser, AND NO LIMITS AT ALL, so the two terms the allowance is built
   * from are read out of the parameters' printed form. When that does not
   * match, the numbers are null and the check says the margin was not
   * established rather than printing blanks that read like one.
   *
   * The size term IS sound: the block-usage dimension of a cost is the
   * transaction's estimated size, which is the term the allowance is charged
   * against.
   */
  const size = reading.cost?.blockUsage ?? null;
  const allowancePs = allowanceFor(dismissLimitsFrom(String((params as any)?.toString?.() ?? '')), size);
  return {
    kind: 'within',
    numbers: { dismissPs: null, sizeBytes: size, allowancePs },
  };
}

/* ---------------------------------------------------------------- report --- */

function printVerdicts(verdicts: ReturnType<typeof fundingVerdicts>) {
  head('The seven things that stop this');
  for (const v of verdicts) {
    const mark = v.passed ? `${G}ok${O}` : `${R}NO${O}`;
    say(`  ${mark}  ${B}${v.check}${O}  ${v.name}`);
    say(`         ${D}${v.line}${O}`);
  }
}

/* ------------------------------------------------------------------ run --- */

async function main() {
  await applyNetworkId(NETWORK);
  say(`\n${B}Funding a fee payer on ${NETWORK}${O}`);
  say(`${D}Nothing will be submitted unless all seven checks below pass, and a rehearsal${O}`);
  say(`${D}submission the node is known to refuse goes first.${O}`);

  if (!existsSync(OLD_SEED)) refuse(`there is no wallet at ${OLD_SEED.replace(ROOT + '/', '')} to fund from`);

  /* ---- 1. the parameters the chain is running -------------------------- */
  head('1 of 7  The parameters this chain is running');
  const params = await parameters();
  say(`  ${params.source === 'live' ? G + 'read' : Y + 'NOT READ'}${O}  ${D}${describeParameters(params)}${O}`);

  const ledger: any = await import('@midnightntwrk/ledger-v9');
  const { unshieldedToken } = await import('@midnight-ntwrk/midnight-js-protocol/ledger') as any;
  const NIGHT = String(unshieldedToken().raw);

  /* ---- 2. what the old wallet holds, from the chain -------------------- */
  head('2 of 7  What the old wallet holds, read from the chain');
  const { WalletSeeds } = await import('@midnight-ntwrk/testkit-js') as any;
  const { createKeystore } = await import('@midnightntwrk/wallet-sdk') as any;
  const oldSeed = readFileSync(OLD_SEED, 'utf8').trim();
  const oldKeys = await createKeystore({ kind: 'schnorr', secret: WalletSeeds.fromMasterSeed(oldSeed).unshielded }, NETWORK);
  /*
   * TWO SPELLINGS OF ONE ADDRESS, AND EVERY COMPARISON USES THE SAME ONE.
   *
   * A wallet answers with both: a long readable form for people and the
   * indexer, and the plain form the transaction itself carries. They are the
   * same key and they never look alike, so a comparison that mixes them cannot
   * ever be true. Two of the checks below are comparisons about money, and one
   * of them silently answered NO on every possible input until this line said
   * which spelling it meant.
   *
   * The rule here is: the plain form for anything compared or planned, the
   * readable form ONLY for asking the indexer and for showing a person.
   */
  const oldAddress = String(oldKeys.getAddress());
  const oldBech32 = String(oldKeys.getBech32Address().asString());
  /*
   * THE SAME TWO-SOURCE CHECK THE NEW WALLET GETS. This address decides what
   * the old wallet is credited with keeping, and it reaches the checks from a
   * different place than the outputs do. One line, and without it only half
   * the comparison has ever been established.
   */
  if (String(ledger.addressFromKey(oldKeys.getPublicKey())) !== oldAddress) {
    refuse('the old wallet answers with two different addresses for its own key, '
      + 'so nothing here can say which of them the outputs would be compared against');
  }
  const before = await readHolding(INDEXER_WS, oldBech32, NIGHT);
  for (const line of describeHolding(oldBech32, before)) say(`  ${line}`);
  if (!before.complete) refuse('the chain could not be read to its current point, so what the old wallet holds is not established');
  if (before.registered.length === 0) refuse('the old wallet holds nothing that earns the fee token, so it cannot pay for this transaction');

  /* ---- 3. the wallet the money goes to --------------------------------- */
  head('3 of 7  The wallet this funds');
  /*
   * THE SEED IS MADE ON ONE RUN AND SPENT ON ANOTHER, AND THAT IS DELIBERATE.
   *
   * This file becomes the only thing that can ever spend most of this
   * project's money, and it is written where nothing backs it up. A door that
   * created it and submitted in the same breath would leave a person holding
   * an irreplaceable file they have had no chance to copy, with the money
   * already in it. So the run that creates it stops there, and says so.
   */
  if (!existsSync(NEW_SEED)) {
    writeFileSync(NEW_SEED, WalletSeeds.generateRandom().masterSeed, { mode: 0o600 });
    say(`  ${Y}${B}A NEW WALLET WAS MADE AND NOTHING ELSE WAS DONE.${O}`);
    say(`  ${Y}Its seed is ${NEW_SEED.replace(ROOT + '/', '')} and that file is the only copy.${O}`);
    say(`  ${Y}After the transaction this door makes, that file IS the money.${O}`);
    say('');
    say(`  ${B}Copy it somewhere that is not this machine, then run this door again.${O}`);
    refuse('the wallet was created on this run, so nothing was submitted. '
      + 'Back the seed up and run it again.', WALLET_MADE_RUN_AGAIN);
  }
  const newSeed = readFileSync(NEW_SEED, 'utf8').trim();
  const newSeeds = WalletSeeds.fromMasterSeed(newSeed);
  const newKeys = await createKeystore({ kind: 'schnorr', secret: newSeeds.unshielded }, NETWORK);
  /*
   * `getPublicKey` AND NOT `getVerifyingKey`. The second does not exist on this
   * keystore, so reaching for it yields nothing, and nothing handed to the
   * address derivation throws in a way that names neither.
   */
  const newVerifyingKey = newKeys.getPublicKey();
  const newAddress = String(newKeys.getAddress());
  say(`  ${String(newKeys.getBech32Address().asString())}`);
  /*
   * THE SAME ADDRESS IN THE SPELLING THE TRANSACTION USES, printed under the
   * readable one and labelled, because they are the same key and will never
   * look alike. Printing them side by side unlabelled asks a person to check
   * something nobody can check by eye.
   */
  say(`  ${D}the same address as the transaction carries it: ${newAddress}${O}`);
  if (String(ledger.addressFromKey(newVerifyingKey)) !== newAddress) {
    refuse('the key that would be registered does not derive the address the outputs are sent to, '
      + 'which means these two came from different places and one of them is wrong');
  }
  /*
   * WHERE THE GENERATION MUST GO, DERIVED FROM THE NEW WALLET'S OWN SEED.
   *
   * A registration names both the address that starts earning and the address
   * the earnings belong to. They are different fields. Passing the wallet that
   * happens to be open - which is the OLD one, because it is the one paying -
   * registers the new outputs perfectly and hands every speck they earn to the
   * wallet being retired. The new wallet would hold registered NIGHT, generate
   * dust for somebody else, and be unable to pay for anything: the same end as
   * never registering it, reached by a transaction that reads as correct.
   */
  const newDustPublicKey = ledger.DustSecretKey.fromSeed(newSeeds.dust).publicKey;
  const newDustAddress = new DustAddress(newDustPublicKey);
  say(`  ${D}its earnings would go to ${String(newDustPublicKey).slice(0, 24)}...${O}`);

  /* ---- 4. the plan ------------------------------------------------------ */
  head(`4 of 7  The plan: ${FEE_PAYER_NIGHT_OUTPUTS} outputs to the new wallet, one left behind`);
  const total = before.total;
  const intended = planOutputs(total, FEE_PAYER_NIGHT_OUTPUTS, newAddress, oldAddress);
  if (intended === null) refuse('there is not enough NIGHT to split into the planned outputs');
  for (const o of intended) say(`  ${String(o.value).padStart(20)}  ${o.purpose}`);

  /* ---- 5. build it, and read back what was built ----------------------- */
  head('5 of 7  Building it, and reading back what was built');
  /*
   * THE CONFIGURATION IS BUILT, NOT LEFT TO BE SUPPLIED.
   *
   * An earlier version of this passed an empty object with a comment saying the
   * environment would fill it in. Nothing fills it in: the wallet is built from
   * exactly what it is handed, so an empty configuration has no node, no
   * indexer and no proving server, and the bring-up fails on a missing field
   * rather than on anything this door checks. Every other door here builds one
   * the same way and this one had a comment instead.
   */
  const { StaticProofServerContainer, createDefaultTestLogger } = await import('@midnight-ntwrk/testkit-js') as any;
  const logger = createDefaultTestLogger();
  const { env, how } = testEnvironmentFor(NETWORK, logger);
  say(`  ${D}network ${NETWORK} - ${how}${O}`);
  const cfg = await startEnvironment(env, new StaticProofServerContainer(PROVER_PORT), (m: string) => say(`  ${D}${m}${O}`));
  say(`  ${D}node ${cfg.node}   indexer ${cfg.indexer}   prover ${cfg.proofServer}${O}`);
  const live = await bringUpWallet(logger, cfg, oldSeed, NETWORK, ROOT, {
    withDust: true, requireDust: true, onNote: (m) => say(`  ${D}${m}${O}`),
  });

  /*
   * TWO LIBRARY CALLS, AND NEITHER ALONE BUILDS THIS SHAPE.
   *
   * The transfer call makes the outputs and attaches no registration. The
   * registration call the wallet library offers for this is not a substitute:
   * opened at source, it collapses every input into a SINGLE output owned by
   * the key it registers, which is a rotation to self rather than a split, and
   * it puts part of the offer in the guaranteed half. Neither is what is wanted
   * here.
   *
   * So the two are composed: the transfer builds the outputs, and the dust
   * wallet's own attach call puts the registration onto the intent the transfer
   * produced. That the two compose is MEASURED rather than assumed - a transfer
   * transaction carries its intent at the segment the attach call looks in, and
   * attaching preserves every output and derives the intended owner.
   *
   * NONE OF IT IS TRUSTED ANYWAY. What the checks below read is the transaction
   * that exists, not the calls that were made.
   */
  let balancer: BalancerOutcome = { kind: 'unknown', why: 'the build did not report what it did' };
  let built: any = null;
  try {
    const facade: any = live.wallet.wallet;

    /*
     * THREE ARGUMENTS, AND THE KEYS ARE THE OLD WALLET'S.
     *
     * The third is not optional: the call takes the deadline apart before it
     * does anything else, so omitting it fails before the first line of the
     * body runs.
     *
     * AND THE FEE KEY IS THE PAYER'S, NOT THE RECIPIENT'S. It is what the
     * balancing spends the fee from, so it has to own the coins being spent,
     * and those belong to the old wallet. Handing it the new wallet's key asks
     * the balancing to spend coins that will not exist for another minute.
     * Both keys are already on the provider, in the derived form the library
     * wants rather than the seed they came from.
     */
    const provider: any = live.wallet;
    const transfer = await facade.transferTransaction(
      [{
        type: 'unshielded',
        outputs: intended.map((o) => ({
          amount: o.value,
          receiverAddress: new UnshieldedAddress(Buffer.from(o.owner, 'hex')),
          type: NIGHT,
        })),
      }],
      { shieldedSecretKeys: provider.zswapSecretKeys, dustSecretKey: provider.dustSecretKey },
      { ttl: new Date(Date.now() + TTL_MS) },
    );
    const transferTx = transfer?.transaction ?? transfer;
    /*
     * THE FOURTH ARGUMENT IS WHERE THE EARNINGS GO AND IT IS THE NEW WALLET'S.
     *
     * The obvious thing to pass here is the dust address of the wallet in hand,
     * which is the OLD one, because it is the one paying. That registers the
     * new outputs correctly and delegates everything they earn to the wallet
     * being retired. The fifth argument allows the registered outputs' own
     * earnings to pay for the registration; the old wallet pays for all of this,
     * so it allows nothing.
     */
    const withRegistration = await facade.dust.attachDustRegistration(
      transferTx, new Date(), newVerifyingKey, newDustAddress, 0n,
    );

    /*
     * TWO WALLETS SIGN THIS, AND NO SINGLE SIGNER CAN MAKE BOTH SIGNATURES.
     *
     * The inputs being spent belong to the OLD wallet, so it signs those. The
     * registration is checked by the chain against the key it registers, which
     * is the NEW wallet's, so the new wallet signs that. The library's own
     * one-call path signs everything with one key, which is right for the shape
     * it was written for - a wallet rotating its own outputs back to itself -
     * and wrong for this one, where the outputs change hands.
     *
     * The order does not matter: what a segment's signature covers does not
     * include the dust actions, and erasing signatures empties the list rather
     * than changing what is signed, so attaching one does not disturb the other.
     *
     * NOTHING BELOW TRUSTS THAT EITHER CALL DID ANYTHING. What was signed is
     * read back off the transaction afterwards, exactly like the outputs and
     * the registration, because a signer that quietly did nothing leaves a
     * transaction the chain refuses and this door would otherwise send it.
     */
    const signedInputs = await facade.unshielded.signUnprovenTransaction(
      withRegistration, (data: Uint8Array) => oldKeys.signDataAsync(data),
    );
    const registrationIntent = signedInputs?.intents?.get?.(1);
    if (!registrationIntent) {
      refuse('the registration is not on the segment the signing path reads, so nothing could sign it');
    }
    built = await facade.dust.addDustRegistrationSignature(
      signedInputs, await newKeys.signDataAsync(registrationIntent.signatureData(1)),
    );
    /*
     * WHAT THE BALANCING DID, READ OFF THE TRANSACTION RATHER THAN OUT OF THE
     * LIBRARY.
     *
     * The count of passes is not reachable: the method it would be taken at is
     * on an object the library keeps to itself, and wrapping something that does
     * not have it counts zero, which reads as having balanced perfectly. What IS
     * readable is the result - how many fee-paying spends the finished
     * transaction carries - and that cannot come out at zero by accident.
     */
    balancer = { kind: 'converged', feePayingSpends: feePayingSpendsOf(built) };
  } catch (e: any) {
    balancer = { kind: 'threw', message: String(e?.message ?? e).slice(0, 200) };
  }

  const builtOutputs = outputsOf(built, NIGHT);
  const registrations = registrationsOf(built, (k) => String(ledger.addressFromKey(k)), String(newDustPublicKey));
  say(`  ${builtOutputs.length} NIGHT output(s) on the transaction, ${builtOutputs.filter((o) => o.section === 'fallible').length} of them in the fallible half`);
  say(`  ${registrations.length} registration(s), covering ${registrations.filter((r) => r.owner !== null).length} address(es) that could be derived`);

  /*
   * WHAT WAS ACTUALLY SIGNED, READ OFF THE TRANSACTION.
   *
   * The chain refuses an offer whose inputs are not all signed, and a
   * registration carrying no signature, and it refuses them without taking a
   * fee - so this costs nothing to get wrong and costs a run every time. It is
   * checked here rather than left to the node because the door has the
   * transaction in its hand and can say which half is missing.
   */
  const signatures = signaturesOf(built);
  say(`  ${signatures.signatures} of ${signatures.inputs} input signature(s), `
    + `${signatures.signedRegistrations} of ${signatures.registrations} registration signature(s)`);

  /*
   * AND THE REGISTRATION'S SIGNATURE IS CHECKED, NOT COUNTED.
   *
   * Counting says a signature is there. It does not say it was made by the key
   * the chain will check it against, or over the right segment - and this is
   * the one signature in the transaction made by a DIFFERENT wallet from the
   * one signing everything else, which is exactly where a wrong key would go
   * unnoticed. The check is the library's own, it needs no network, and it
   * costs nothing.
   */
  let registrationSignatureVerified = true;
  /*
   * EVERY REGISTRATION, ON EVERY SEGMENT, AND ONE BAD ONE IS ENOUGH.
   *
   * This was written as an assignment over the registrations of segment one,
   * which made it last-wins and single-segment at once: a bad registration
   * followed by a good one read as verified, and one on any other segment was
   * never looked at. Both are the fault this file has a written warning about
   * two checks above, reintroduced in the same change that removed it from the
   * readers.
   *
   * THE SEGMENT IS THE INTENT'S OWN KEY AND NOT A CONSTANT. What a signature
   * covers includes the segment it was made for, so checking a segment-two
   * registration against segment one's bytes fails a signature that is correct.
   */
  for (const [segment, intent] of built?.intents ?? []) {
    for (const reg of (intent as any)?.dustActions?.registrations ?? []) {
      let thisOne = false;
      try {
        thisOne = ledger.verifySignature(
          reg.nightKey, (intent as any).signatureData(segment), reg.signature?.value ?? reg.signature,
        );
      } catch { thisOne = false; }
      registrationSignatureVerified = registrationSignatureVerified && thisOne;
    }
  }
  say(`  the registration's signature ${registrationSignatureVerified ? 'checks out against the key it registers' : `${R}DOES NOT check out against the key it registers${O}`}`);

  const coverage: RegistrationCoverage = {
    derivedFromThisTransaction: registrations,
    alreadyRegisteredOnChain: before.registered.length > 0 ? [oldAddress] : [],
    ...(before.complete ? {} : { chainProblem: before.note }),
  };

  /* ---- 6. the seven checks --------------------------------------------- */
  const verdicts = fundingVerdicts({
    parameters: params,
    cost: built === null ? { kind: 'unreadable', message: 'nothing was built' } : costOf(built, params.parameters),
    intended,
    built: builtOutputs,
    coverage,
    oldWalletRegisteredOutputsAfter: builtOutputs.filter((o) => o.owner === oldAddress).length,
    balancer,
    feePayingSpendsExpected: FEE_PAYING_SPENDS_EXPECTED,
  });
  printVerdicts(verdicts);

  /*
   * STOPPING GIVES THE OUTPUTS BACK.
   *
   * Building books the outputs it is going to spend, so a second attempt would
   * be told they are already in use by a transaction nobody sent. The library's
   * own paths unbook on every failure; this door has more ways to stop than
   * they do, because most of its stopping is the seven checks.
   */
  const stop = async (why: string): Promise<never> => {
    await unbook(live.wallet.wallet, built);
    live.stop();
    return refuse(why);
  };

  if (built !== null && (signatures.signatures < signatures.inputs || signatures.signedRegistrations < signatures.registrations)) {
    say('');
    say(`  ${R}Not everything that has to be signed has been signed.${O}`);
    await stop('the transaction is not fully signed, so the chain would refuse it. '
      + 'The inputs are signed by the wallet that holds them and the registration by the key it '
      + 'registers, and those are two different wallets.');
  }
  if (built !== null && !registrationSignatureVerified) {
    await stop('the registration carries a signature that does not check out against the key it '
      + 'registers. A signature made by the wrong wallet, or over the wrong part of the '
      + 'transaction, is present and counted and still refused by the chain.');
  }

  if (!maySubmit(verdicts)) {
    head('Nothing was submitted');
    say(`  ${D}Every line marked NO above is a reason. Nothing has been spent and nothing${O}`);
    say(`  ${D}is at risk: the transaction was built and measured here, not sent.${O}`);
    await stop('one or more of the seven checks did not pass');
  }

  /* ---- 7. the rehearsal, then the one that counts ---------------------- */
  head('6 of 7  The rehearsal');
  say(`  ${D}A submission the node is known to refuse, made first, so that the whole path${O}`);
  say(`  ${D}has been watched working before the transaction that cannot be undone.${O}`);
  const rehearsal = buildDeliberatelyRefused(ledger, built, NIGHT, newAddress, NETWORK);
  const rehearsalCost = costOf(rehearsal, params.parameters);
  if (rehearsalCost.kind !== 'refused') {
    /*
     * THE UNBOOKING IS AWAITED AND THE REFUSAL IS NOT, which is not a style
     * choice: what follows this block reads the refusal's own numbers, and the
     * typechecker only knows the code below is unreachable when the call that
     * ends it is a plain one. Routed through the awaited helper, everything
     * after would be checked as though the door had carried on.
     */
    await unbook(live.wallet.wallet, built);
    live.stop();
    refuse('the rehearsal transaction was not established to be refusable before sending it, '
      + 'and a rehearsal that might be accepted is not a rehearsal');
  }
  say(`  ${G}the rehearsal is refusable here first${O}  ${D}${rehearsalCost.message.slice(0, 160)}${O}`);
  const rehearsalAnswer = await submit(live, rehearsal, true);
  say(`  the node answered: ${D}${rehearsalAnswer.slice(0, 200)}${O}`);
  say(`  ${D}Nothing was spent by that: a submission the node refuses is never included,${O}`);
  say(`  ${D}so no fee is taken.${O}`);

  head('7 of 7  The transaction that counts');
  const answer = await submit(live, built, false);
  say(`  ${answer}`);

  head('After it');
  const newBech32 = String(newKeys.getBech32Address().asString());
  const after = await readHolding(INDEXER_WS, newBech32, NIGHT);
  for (const line of describeHolding(newBech32, after)) say(`  ${line}`);
  const oldAfter = await readHolding(INDEXER_WS, oldBech32, NIGHT);
  for (const line of describeHolding(oldBech32, oldAfter)) say(`  ${line}`);
  say('');
  say(`  ${abilityToPay(live.dust(), null, after.registered.length)}`);
  say(`  ${D}A count of outputs is a ceiling on spends per transaction and is not the same${O}`);
  say(`  ${D}thing as being able to pay. For about half a minute after this lands the new${O}`);
  say(`  ${D}wallet holds the outputs and not yet the balance.${O}`);
  live.stop();
}

/**
 * A transaction built to be refused, and established as refusable before it is sent.
 *
 * The allowance the chain grants for dismissing a transaction is charged on its
 * GUARANTEED half alone, and against the parameters this chain runs, more than
 * one NIGHT output there is already over. So the rehearsal is this same split
 * put in the guaranteed half, which the chain's own cost call refuses locally
 * before anything is sent. The caller checks that refusal and stops if it does
 * not come, because a rehearsal that might be accepted is a second real
 * transaction.
 */
function buildDeliberatelyRefused(ledger: any, like: any, nightToken: string, owner: string, network: string): any {
  const outputs = outputsOf(like, nightToken);
  const intent = ledger.Intent.new(new Date(Date.now() + 60_000));
  intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new(
    [],
    outputs.map((o) => ({ owner, type: nightToken, value: o.value })),
    [],
  );
  return ledger.Transaction.fromParts(network, undefined, undefined, intent);
}

/**
 * Sends one transaction and says what the node answered.
 *
 * `expectRefusal` IS WHAT SEPARATES THE TWO SENDS, AND THE ANSWER TO EACH IS
 * THE OPPOSITE OF THE OTHER. The rehearsal is a success when it is refused; the
 * transaction that counts is a failure when it is. An earlier version of this
 * caught both and returned a string either way, so a refusal of the real
 * transaction ended the door normally and its front printed the new fee payer
 * is funded, directly above the node's own words saying it was not. That is the
 * failure this project keeps writing down: a failure that reads as a success.
 */
async function submit(live: any, tx: any, expectRefusal: boolean): Promise<string> {
  let answer: string;
  try {
    /*
     * FINALISED FIRST. What is sent is not the transaction that was built: the
     * chain takes a finished one, and finishing is a step of its own. Handing
     * the built form straight to the send is refused for a reason that has
     * nothing to do with anything this door checked.
     */
    const facade: any = live.wallet.wallet;
    const finished = await facade.finalizeRecipe({ type: 'UNPROVEN_TRANSACTION', transaction: tx });
    answer = `${G}the node accepted it${O}  ${String(await facade.submitTransaction(finished))}`;
  } catch (e: any) {
    const said = String(e?.message ?? e).slice(0, 300);
    if (expectRefusal) return `${G}refused, as it was built to be${O}  ${said}`;
    await unbook(live.wallet.wallet, tx);
    refuse(`the node refused the transaction: ${said}\n`
      + '  Nothing moved. A refused transaction is never included in a block, so no fee was\n'
      + '  taken and the old wallet holds everything it held before.', SENT_AND_REFUSED);
  }
  if (expectRefusal) {
    await unbook(live.wallet.wallet, tx);
    /*
     * SENT AND NOT REFUSED, WHICH IS ITS OWN OUTCOME. It shares an exit code
     * with a refusal because both mean something left this machine, and the
     * front says so in those terms rather than in terms of what the chain
     * decided - which is the opposite here.
     */
    refuse('the rehearsal was ACCEPTED. It was built to be refused, so something about the '
      + 'chain or about this transaction is not what was measured, and the transaction that '
      + 'counts has not been sent.', SENT_AND_REFUSED);
  }
  return answer;
}

main().then(() => process.exit(0)).catch((e: any) => {
  if (e instanceof Refused) {
    console.error(e.code === SENT_AND_REFUSED
      ? `\n${R}${B}Stopped. Something was sent and the chain turned it down.${O}`
      : `\n${R}${B}Stopped, and nothing was submitted.${O}`);
    console.error(`  ${e.message}\n`);
    process.exit(e.code);
  }
  console.error(`\n${R}${B}Stopped.${O}  ${String(e?.message ?? e)}\n`);
  process.exit(1);
});
