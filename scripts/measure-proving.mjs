/**
 * HOW LONG DOES ONE `execute` PROOF ACTUALLY TAKE, HOW BIG IS IT, AND DOES THE
 * MAIN THREAD STOP RESPONDING WHILE IT HAPPENS?
 *
 *   MEASURE-PROVING.command        (which pins the server and starts it)
 *
 * `docs/scope-the-real-chain.md` §5.2 names three numbers that do not exist
 * anywhere in this repository and that six of scope 7's eleven rounds reason
 * from: one isolated `execute` proof cold and warm, whether the 20-minute stall
 * reproduces on the pinned stack, and the proof's size in bytes. This produces
 * all three or says which one it could not take and why.
 *
 * `execute` is the circuit that matters: it is on the critical path of paying
 * people and it is the most expensive one the account has.
 *
 *   under ~2s   a signer approves from a browser tab like any web app
 *   2s to ~10s  usable, but the UI has to be honest about the wait
 *   over ~10s   every signer needs a local proof server installed, which rules
 *               out in-browser wallets and makes onboarding much worse
 *
 * Must be run with tsx, not node: it imports TypeScript through `.js`
 * specifiers, which is the TypeScript convention and which plain node cannot
 * resolve.
 *
 * ── WHAT WAS WRONG WITH THIS FILE BEFORE 28 AUG, MEASURED RATHER THAN GUESSED ─
 *
 * It could not run at all, and had not since the 5.0 dependency matrix landed.
 *
 *   · `import('@midnight-ntwrk/ledger')` — THAT PACKAGE IS NOT INSTALLED.
 *     Nothing else in the repository imports it. The equivalents now live in
 *     `@midnight-ntwrk/midnight-js-protocol/ledger`, which is what
 *     `scripts/prove-compare.ts:44` uses.
 *   · `LedgerParameters.dummyParameters()` — that static does not exist on the
 *     installed build. `Object.getOwnPropertyNames` reports `deserialize` and
 *     `initialParameters`, and `initialParameters` is what the rest of this
 *     repository calls.
 *   · Its private state was the pre-M-125 shape: one balance, an
 *     `entriesDigest` that M-128 deleted, and no `assetId`, `assetBlinding` or
 *     `scope`. Handed to the current witnesses it cannot describe an account.
 *
 * So the "wrong server on the wrong port" was not the only reason there has
 * never been a `REPORT-PROVING.txt`. It would have failed at its first import.
 *
 * ── AND WHY IT NOW BUILDS THE STATE INSTEAD OF DEPLOYING ONE ─────────────
 *
 * `execute` cannot be proved against a freshly-constructed account.
 * `ConfidentialAccount.compact:1728-1739` requires a seated signer and an
 * APPROVED proposal, and a constructor produces neither. The old version built
 * a deploy transaction and called `execute` against its initial state, which
 * cannot satisfy `requireApproved` and would have failed inside the circuit.
 *
 * The account is therefore driven to an approved proposal in process, through
 * `contracts/test/simulator.ts` — the same helper the contract tests use,
 * running the same generated circuits, needing no node, no wallet, no proving
 * key and no server. The `ContractState` it holds afterwards is what the
 * unproven transaction is built from. **That fixture is a test helper being
 * used by a script, deliberately: the alternative is a second implementation of
 * "how an account reaches an approved proposal", and this project's oldest
 * failure is a rule with two implementations.**
 *
 * ══ THE VERIFIER KEYS, AND THE ROUTE CHOSEN TO GET THEM ══════════════════
 *
 * WHAT `R1a` HIT, ON 28 AUG, WITH DOCKER RUNNING AND THE KEYS BUILT:
 *
 *     could not build the transaction: Operation 'execute' on contract
 *     '51ac946e…' has no verifier key. Each invoked operation must carry its
 *     deployed verifier key (present in states read from chain, or produced by
 *     a real deploy), which the call's key location hashes.
 *
 * The fixture's `ContractState` carries circuits and no deployed verifier keys,
 * because nothing deployed it. `R1b` names two routes out and requires one to
 * be chosen, with the reason and the cost stated here. **A THIRD IS CHOSEN, and
 * the two named ones are rejected for evidence rather than for taste.**
 *
 * ── ROUTE A, "attach the keys from disk", IS REJECTED: NO VERSION ────────
 *
 * It is MECHANICALLY POSSIBLE, and `R1b` asked that the declarations be read
 * before claiming either way. Read, in
 * `node_modules/@midnightntwrk/ledger-v9/ledger-v9.d.ts`:
 *
 *     749  export class ContractOperation {
 *     750    constructor();
 *     752    verifierKey: Uint8Array;              // public and mutable
 *
 *     808  export class ContractState {
 *     817    operations(): Array<string | Uint8Array>
 *     822    operation(operation: string | Uint8Array): ContractOperation | undefined;
 *     827    setOperation(operation: string | Uint8Array, value: ContractOperation): void;
 *
 * So a key can be put on a state: construct a `ContractOperation`, assign
 * `verifierKey`, `setOperation('execute', …)`. The fifteen key files are on
 * disk at `contracts/managed/keys/execute.verifier` and its siblings.
 *
 * **AND IT IS STILL REJECTED, BECAUSE THE VERSION CANNOT BE STATED.**
 * `ContractOperation`'s own documentation, at :744-745, says *"Only the latest
 * available version is exposed to this API"*, and its constructor takes no
 * version. The only versioned carrier in the API is
 *
 *     2236 export class ContractOperationVersionedVerifierKey {
 *     2238   constructor(version: 'v3' | 'v4', rawVk: Uint8Array);
 *
 * and it is reachable only through `VerifierKeyInsert` (:2276-2283), which is a
 * `SingleUpdate` in a `MaintenanceUpdate` — a CHAIN operation, not something a
 * fixture can perform. `R1b` asks *"which version transactionVersion 4
 * implies and on what evidence"*: **THERE IS NO EVIDENCE.** The node's
 * `transactionVersion` and this enum's `'v4'` are different numbering schemes
 * that happen to share a digit, and `C208` already records that the coincidence
 * proves nothing. Attaching a key under a version chosen because the numbers
 * look alike is the exact failure `CLAUDE.md` opens with — a name that reads
 * plausibly is still a guess — and it would produce a confident wrong proving
 * figure, which `C180` says is worse than no figure.
 *
 * ── ROUTE B, "read the state from the chain", IS REJECTED: THE SALT ──────
 *
 * `R1b` calls this the honest route and it would be, if the witness could be
 * rebuilt. It cannot, and the blocker is not the verifier keys.
 *
 * `execute` is a call ABOUT a proposal, and its witness must carry the values
 * the proposal's commitment was computed from. `ConfidentialAccount.compact`
 * defines the id in `proposalIdOf` as
 *
 *     proposalIdOf(payloadHash, vault, salt) =
 *       persistentCommit<Vector<3, Bytes<32>>>(
 *         [pad(32, "midnight-accounts:proposal-id:"), payloadHash, vault], salt)
 *
 * — the domain tag added by `S32`, `C317`; the line citation that stood here
 * was already three rounds stale, so the circuit is named rather than a line.
 * It is a commitment either way, so the salt is not recoverable from the id. And
 * `scripts/run-preview.ts:230-247` draws that salt from `randomBytes(32)` on
 * every run, DELIBERATELY (M-128: a fixed salt reproduces an id whose approval
 * nullifiers are already burned), and never writes it to disk. **So the salt of
 * an approved proposal on chain exists only inside the process that made it,
 * and no later process can prove `execute` against it.**
 *
 * Two further facts confirm the route is closed rather than merely awkward —
 * **AND THE FIRST OF THEM WAS FALSE WHEN IT WAS WRITTEN AND IS FALSE NOW.**
 * It said: *`RUN-PROPOSAL.command` EXECUTES the proposal it
 * raises (`scripts/run-preview.ts:1972`), so it leaves no open approved
 * proposal behind*. **There is no `execute` circuit and that run executes
 * nothing** — `run-preview.ts:1947-1957` says in its own words that the
 * threshold is met and *that is where this round ends*, so the proposal is LEFT
 * OPEN at or above its threshold. The citation is stale too: `:1972` is inside
 * an error string. **What survives is the second fact, and it is enough**: no
 * `.command` in this repository stops between approval and a payment. **THAT IS A FINDING AND IT IS NAMED RATHER THAN WORKED AROUND:
 * measuring `execute` against real chain state has to happen INSIDE the process
 * that raised the proposal, which means it belongs in `run-preview.ts` or in a
 * new `.command` — and this file may not invent one.**
 *
 * ── ROUTE C, CHOSEN: THE FIXTURE'S STATE, THE CHAIN'S KEYS ───────────────
 *
 * The fixture keeps everything it already owns and is reproducible about — the
 * data, the approved proposal, the private state, the salt. The DEPLOYED
 * VERIFIER KEYS are read off the chain at the address
 * `DEPLOY-PREVIEW.command` wrote to `.midnight/<network>-contract.json` and
 * grafted onto it with `setOperation`, using the three declarations quoted
 * above.
 *
 * WHY THIS ANSWERS ROUTE A'S OBJECTION: nothing here constructs a version. The
 * operations come out of a state the chain produced, already carrying whatever
 * version was deployed, and are copied across whole. The question "v3 or v4?"
 * is never asked, so it never has to be guessed.
 *
 * WHY IT ANSWERS ROUTE B'S: the witness is the fixture's own, so the salt is in
 * hand by construction.
 *
 * WHAT IT COSTS, PLAINLY:
 *
 *   · **A DEPLOY, AND OF THE CURRENT TREE.** Verifier keys are bound to the
 *     circuits deployed with them. A deploy older than the last contract change
 *     yields keys that do not match what is being proved. `docs/stagenet.md`
 *     records that a redeploy is owed anyway and that `R1b` deploys fresh.
 *   · **THE NUMBER IS NOT REPRODUCIBLE FROM A CLEAN TREE**, exactly as `R1b`
 *     says of the chain-read route. It needs the network, once.
 *   · **IT IS ONE STEP SHORT OF WHAT A REAL SIGNER PROVES AGAINST.** A real
 *     wallet proves against a whole state read from chain; this proves against
 *     the chain's keys and a local state. For a PROVING TIME that difference is
 *     the state's data, not its keys, and the fixture's data is the same shape
 *     the tests use. **It is a real limitation and it belongs in the report,
 *     not in a footnote.**
 *
 * ── AND NONE OF THIS HAS BEEN RUN ────────────────────────────────────────
 *
 * **THE GRAFT BELOW IS WRITTEN AND UNEXERCISED.** It needs a deployed contract
 * and a reachable indexer, and the session that wrote it had neither. The
 * PRECONDITION REFUSAL has been forced and is proved; the path past it has not.
 *
 * **AND THE SENTENCE THAT STOOD HERE WAS FALSE ON DISK.** It
 * read *Until `REPORT-PROVING.txt` exists, this file has produced no number and
 * nothing may reason from one*. **That file exists**, dated 28 Aug, carrying
 * cold 5.14s, warm average 4.94s and a 5,916-byte proof — real measurements,
 * taken against the FIFTEEN-circuit pre-`C292` contract its own line 32 lists.
 * So the true statement is the stronger one: **this file has produced no number
 * about THIS contract, the numbers it did produce are about a contract that no
 * longer exists, and nothing may reason from either.**
 *
 * **THIS FILE IS NOT REACHED AT ALL SINCE `S29`.** `MEASURE-PROVING.command`
 * refuses before its first step, because `execute` is gone and every stop below
 * is certain: `view` is no longer exported by `contracts/test/simulator.js`
 * (destructured at `:433-435`; `simulator.ts:76` records the deletion), the
 * simulator has no `credit` (`:458`), `circuitId` is the literal `'execute'`
 * (`:535`), and the chain holds no key of that name (`:414-421`). What is
 * missing is a DECISION about which circuit a proving time is taken against —
 * every remaining circuit writes state — and a decision is a person's.
 */
import { performance } from 'node:perf_hooks';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = join(ROOT, 'contracts', 'managed');

/**
 * 6301, NOT 6300.
 *
 * Two proof servers have run on this machine: `8.1.0` on 6300 and the pinned
 * one on 6301. The pinned image is `9.0.0-rc.3` since 28 Aug 2026 — the prover
 * built from the ledger release the running node is built from — and was
 * `9.0.0-rc.5_experimental` before that, on the authority of Midnight's
 * Stagenet delivery document, which is a draft edited forward of the running
 * network. `docs/stagenet.md` carries the derivation.
 * `MEASURE-PROVING.command` exports both this URL and `MIDNIGHT_PROVER_PORT`;
 * the default here agrees with it so that running this file by hand measures
 * the same stack.
 */
const PROOF_SERVER = process.env.PROOF_SERVER
  ?? `http://localhost:${process.env.MIDNIGHT_PROVER_PORT ?? 6301}`;

/**
 * The ceiling on ONE proof, and it is deliberately longer than the stall it is
 * trying to observe. The stall recorded on 13 Aug was 20+ minutes; a four-minute
 * bound would kill the process before the thing being measured had finished
 * happening, and report a timeout where the answer is a duration.
 */
const PER_PROOF_MS = Number(process.env.MIDNIGHT_PROVE_TIMEOUT_MS || 25 * 60_000);

/** Above this, a main-thread gap is a stall rather than ordinary scheduling. */
const STALL_MS = Number(process.env.MIDNIGHT_STALL_MS || 5_000);

const line = (s = '') => console.log(s);
const fail = (msg, code = 1) => { console.error(`\nSTOPPED: ${msg}`); process.exit(code); };

/**
 * The network whose deployment supplies the verifier keys, resolved the one way
 * there is.
 *
 * It used to be read here with a default of its own, which made this instrument
 * a second answer to a question the client already answers - and an unvalidated
 * one, handed straight to `setNetworkId` below, which is the one place a wrong
 * network name does silent damage.
 */
const { theNetwork } = await import('../src/midnight/network.js');
const NETWORK = theNetwork();
const STATE_DIR = join(ROOT, '.midnight');
const CONTRACT_FILE = join(STATE_DIR, `${NETWORK}-contract.json`);

/**
 * REFUSES BY NAMING WHAT MUST HAVE RUN, IN ORDER.
 *
 * *"A precondition reported as a stack trace is a precondition nobody can act
 * on."* `R1a` stopped with an SDK sentence about a verifier key — accurate,
 * and it named no file anybody could run. This is the replacement.
 *
 * Exit code 4 is this refusal specifically, so `MEASURE-PROVING.command` can
 * tell "you have not run the prerequisites" apart from "the measurement went
 * wrong" (2) and "no proof server" (3). A refusal is not a crash.
 */
const PRECONDITIONS = [
  ['DEPLOY-PREVIEW.command',
   'puts the CURRENT contract on chain and writes its address to '
   + `.midnight/${NETWORK}-contract.json. The deployed verifier keys are what this file grafts `
   + 'onto its fixture, and they are bound to the circuits deployed with them — so a deploy '
   + 'older than the last change to contracts/src is the wrong keys, not merely stale ones.'],
];
const refuseOnPreconditions = (what, detail) => {
  console.error('');
  console.error('STOPPED: this measurement has a precondition that is not met.');
  console.error('');
  console.error(`  ${what}`);
  if (detail) for (const l of String(detail).split('\n')) console.error(`    ${l}`);
  console.error('');
  console.error('  NOTHING WAS MEASURED AND NO NUMBER WAS ESTIMATED.');
  console.error('');
  console.error('  Run these first, outside this session, in this order:');
  for (let i = 0; i < PRECONDITIONS.length; i++) {
    const [name, why] = PRECONDITIONS[i];
    console.error('');
    console.error(`    ${i + 1}. ${name}`);
    for (const l of why.match(/.{1,68}(\s|$)/g) ?? [why]) console.error(`       ${l.trim()}`);
  }
  console.error('');
  console.error('  Then run MEASURE-PROVING.command again.');
  console.error('');
  console.error('  NOTE, and it is not a footnote: RUN-PROPOSAL.command is NOT in this list.');
  console.error('  It was, under the route R1b calls the honest one — read the whole state off');
  console.error('  the chain — and that route is closed. A proposal id is a commitment over a');
  console.error('  salt that run-preview.ts:230-247 draws fresh every run and never writes');
  console.error('  down, so no later process can build the witness for a proposal it did not');
  console.error('  raise. This file therefore keeps the fixture\'s own proposal and takes only');
  console.error('  the deployed KEYS from the chain. The header of this file has the evidence.');
  process.exit(4);
};

/* ---------------- artifacts ---------------- */

line('Checking build artifacts');

const keyDir = join(ARTIFACTS, 'keys');
const zkirDir = join(ARTIFACTS, 'zkir');
if (!existsSync(keyDir)) fail(`no proving keys at ${keyDir}. Run the full compile first.`);

const keys = readdirSync(keyDir);
const zkirs = existsSync(zkirDir) ? readdirSync(zkirDir) : [];
line(`  keys: ${keys.filter((k) => k.endsWith('.prover')).join(', ')}`);
line(`  zkir: ${zkirs.join(', ')}`);

// The provider reads `<circuit>.bzkir`. The compiler emits both that and
// `.zkir`, confirmed on a real build, so this is a check rather than a worry.
const bzkir = zkirs.filter((z) => z.endsWith('.bzkir'));
if (zkirs.length && !bzkir.length) {
  fail('no .bzkir files. The provider cannot read .zkir, so proving would fail '
     + 'with a missing-artifact error that reads like a missing circuit.');
}

/* ---------------- the deployed verifier keys, read off the chain ---------------- */

/*
 * BEFORE ANY OF THE EXPENSIVE WORK, AND THAT IS THE POINT. R1a spent a full
 * fixture build, a proof-server start and a transaction build to arrive at an
 * SDK sentence about a missing verifier key. The same fact is knowable in one
 * file read and one indexer query, so it is asked here.
 */
line('\nReading the deployed verifier keys off the chain');

if (!existsSync(CONTRACT_FILE)) {
  refuseOnPreconditions(
    `There is no deployed contract recorded for ${NETWORK}.`,
    `${CONTRACT_FILE.replace(ROOT + '/', '')} does not exist.\n`
    + 'It is written by a successful deploy and holds the address whose state\n'
    + 'carries the verifier keys this measurement needs. Without it there is no\n'
    + 'address to ask about, and the fifteen .verifier files on disk cannot\n'
    + 'substitute — the header of this file says why at length.',
  );
}

let deployedAddress;
try {
  const raw = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8'));
  deployedAddress = String(raw.contractAddress ?? '');
  if (!deployedAddress) throw new Error('no "contractAddress" field');
  if (raw.network && raw.network !== NETWORK) {
    refuseOnPreconditions(
      `${CONTRACT_FILE.replace(ROOT + '/', '')} describes ${raw.network}, not ${NETWORK}.`,
      'The keys on one network say nothing about a contract on another. Deploy to\n'
      + `${NETWORK}, or build for the network that file describes.`,
    );
  }
} catch (e) {
  refuseOnPreconditions(
    `${CONTRACT_FILE.replace(ROOT + '/', '')} could not be read as a deploy record.`,
    String(e?.message ?? e),
  );
}
line(`  contract ${deployedAddress}`);

const { endpointsOf } = await import('../src/core/networks.js');
let endpoints;
try { endpoints = endpointsOf(NETWORK); } catch (e) { fail(String(e?.message ?? e), 1); }

/*
 * THE NETWORK ID IS SET TWICE, IN THIS ORDER, AND THE ORDER IS DELIBERATE.
 *
 * The SDK refuses every contract operation until a network is set, and an
 * address is parsed against it. The address below is a REAL one from a real
 * network, so it is read while that network is set; the fixture afterwards is
 * local and undeployed, and is set back before it runs. Reading the chain under
 * 'undeployed' would fail on the address, and running the fixture under
 * 'stagenet' would claim a local state belongs to a network it has never
 * touched.
 */
const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
setNetworkId(NETWORK);

const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');

let chainState;
try {
  const publicData = indexerPublicDataProvider(endpoints.indexer, endpoints.indexerWs);
  chainState = await publicData.queryContractState(deployedAddress);
} catch (e) {
  refuseOnPreconditions(
    `The indexer could not be asked about ${deployedAddress}.`,
    `${endpoints.indexer}\n${String(e?.message ?? e)}\n\n`
    + 'This is a network failure, not a missing prerequisite — but it stops the\n'
    + 'measurement in the same place, and the same deploy has to be on chain\n'
    + 'either way.',
  );
}
if (!chainState) {
  refuseOnPreconditions(
    `The indexer has no state for ${deployedAddress}.`,
    'The address is recorded but the chain does not know it: the deploy did not\n'
    + 'land, or the network was reset under it. Stagenet has been reset under this\n'
    + 'project once already — STAGENET-RESET.command.',
  );
}

/*
 * THE OPERATIONS, COPIED WHOLE. `ledger-v9.d.ts:817-827`.
 *
 * `operations()` lists the entry points the deployed contract registered;
 * `operation(name)` returns each one carrying the verifier key the chain holds
 * for it. Nothing here constructs a `ContractOperation` or assigns a
 * `verifierKey`, and that is exactly why this route was chosen over attaching
 * the keys from disk: no version is ever named, so no version is ever guessed.
 */
const deployedOperations = [];
for (const name of chainState.operations()) {
  const op = chainState.operation(name);
  if (op) deployedOperations.push([name, op]);
}
const nameOf = (n) => (typeof n === 'string' ? n : Buffer.from(n).toString());
line(`  deployed entry points: ${deployedOperations.map(([n]) => nameOf(n)).join(', ') || '(none)'}`);

if (!deployedOperations.some(([n]) => nameOf(n) === 'execute')) {
  refuseOnPreconditions(
    `The contract at ${deployedAddress} has no deployed verifier key for 'execute'.`,
    'It has ' + (deployedOperations.length ? deployedOperations.map(([n]) => nameOf(n)).join(', ') : 'no entry points at all')
    + '.\nThat is a contract deployed from a different source than the one in this\ntree. Redeploy from the current tree.',
  );
}
line('  the chain holds a verifier key for `execute`');

/* ---------------- the account, driven to an approved proposal ---------------- */

line('\nBuilding an account with an approved proposal, in process');

const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
const contracts = await import('@midnight-ntwrk/midnight-js-contracts');
const ledger = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
const { Contract } = await import('../contracts/managed/contract/index.js');
const { witnesses } = await import('../contracts/src/witnesses.js');
const {
  AccountSimulator, privateStateFor, view, change, GBP, ZERO_32,
} = await import('../contracts/test/simulator.js');

/*
 * BACK TO 'undeployed' FOR THE FIXTURE, having read the chain above under the
 * real network id. Undeployed is the local, no-chain network: correct here,
 * because we are measuring proving cost and never submitting anything.
 * `setNetworkId` was imported above; it is not imported again.
 */
setNetworkId('undeployed');

/** £10,000.00. Minor units, per M-125. */
const OPENING = 10_000_00n;
/** What the approved round moves. One payment, the same shape the tests use. */
const PAYING = 1_500_00n;

const ada = privateStateFor(1);
const blake = privateStateFor(2);

const sim = await AccountSimulator.create(ada, 2n);

// Fund it. `execute` requires the asset to exist on chain even for a zero
// change: a spend comes out of a balance that is there.
const credited = sim.applying(ada, view(0n, 0), change(0n, 61, GBP), OPENING);
await sim.as(credited).credit();
const funded = credited.next;

// A second signer, so a threshold of two is reachable.
await sim.as(ada).addSigner(sim.leafOf(blake), ZERO_32);

const payload = new Uint8Array(32).fill(7);
const paying = change(PAYING);
await sim.as(sim.applying(ada, funded, paying)).propose(payload);
const proposalId = sim.proposalId(payload, paying.salt);
await sim.as(sim.applying(ada, funded, paying)).approve(proposalId);
await sim.as(sim.applying(blake, funded, paying)).approve(proposalId);

const settling = sim.applying(ada, funded, paying);
line(`  threshold ${sim.ledger.threshold}, signers ${sim.ledger.signerLeaves.size()}, approvals ${sim.approvalsFor(proposalId)}`);
if (sim.approvalsFor(proposalId) < sim.ledger.threshold) {
  fail('the account did not reach its own threshold, so `execute` could not be proved '
     + 'even in principle. Nothing was measured.', 2);
}
line('  approved — the state `execute` will be proved against is ready');

/* ---------------- build the unproven transaction ---------------- */

line('\nBuilding an unproven transaction for `execute`');

const zkConfigProvider = new NodeZkConfigProvider(ARTIFACTS);
// Positional, not an options object. The options-object overload exists on the
// midnight-js main branch but not in the published package, and passing an
// object here fails with `Invalid URL: [object Object]` from inside the
// provider. Read the installed package, not the source repo.
const proofProvider = httpClientProofProvider(PROOF_SERVER, zkConfigProvider);

const CC = await import('@midnight-ntwrk/compact-js/effect/CompiledContract');
const compiledContract = CC.make('ConfidentialAccount', Contract).pipe(
  CC.withWitnesses(witnesses),
  CC.withCompiledFileAssets(ARTIFACTS),
);

/*
 * THE GRAFT. Route C, and the one line the whole precondition list exists for.
 *
 * `sim.contractStateForCall` is the fixture's `ContractState`: it carries the
 * account's data — funded, two signers, one approved proposal — and no deployed
 * verifier keys, because nothing deployed it. Every operation the chain holds is
 * copied onto it with `setOperation` (`ledger-v9.d.ts:827`), whole, exactly as
 * `operation()` returned it. No `ContractOperation` is constructed here and no
 * `verifierKey` is assigned; the version travels with the object.
 *
 * `execute` alone would be enough for THIS measurement, and all of them are
 * copied anyway: the account's circuits call one another, the cost of copying
 * fifteen entries is nothing, and a state carrying one key is a state that fails
 * later, differently, for anyone who measures a second circuit with this file.
 */
const stateForCall = sim.contractStateForCall;
for (const [name, op] of deployedOperations) stateForCall.setOperation(name, op);
line(`  grafted ${deployedOperations.length} deployed verifier key(s) onto the fixture state`);
line(`  from ${deployedAddress} on ${NETWORK}`);
line('  the fixture supplies the data, the proposal and the witness; the chain');
line('  supplies the keys. Nothing here names a proof-system version.');

let unprovenTx;
try {
  const coinPublicKey = ledger.sampleCoinPublicKey();
  const encryptionPublicKey = ledger.sampleEncryptionPublicKey();
  /*
   * NO `signingKey`, AND ITS ABSENCE IS CHECKED RATHER THAN ASSUMED. The
   * previous version passed one, carried over from the deploy transaction it
   * used to build. `CallOptionsBase`, `CallOptionsProviderDataDependencies` and
   * `CallOptionsWithPrivateState` — midnight-js-contracts/dist/index.d.mts:10-72
   * — have no such field between them. A key is needed to DEPLOY a contract,
   * not to call one.
   */

  const called = await contracts.createUnprovenCallTxFromInitialStates(
    zkConfigProvider,
    {
      compiledContract,
      circuitId: 'execute',
      contractAddress: sim.address,
      args: [proposalId],
      coinPublicKey,
      initialContractState: stateForCall,
      initialZswapChainState: new ledger.ZswapChainState(),
      // `initialParameters`, not `dummyParameters`: the latter does not exist on
      // the installed build. `scripts/prove-compare.ts:180` uses this one.
      ledgerParameters: ledger.LedgerParameters.initialParameters(),
      initialPrivateState: settling,
    },
    encryptionPublicKey,
  );
  unprovenTx = called.private.unprovenTx;
  line('  call transaction built');
} catch (e) {
  const msg = String(e?.message ?? e);
  line(`  could not build the transaction: ${msg}`);
  line('');
  if (/verifier key/i.test(msg)) {
    line('  IT IS STILL THE VERIFIER KEYS, AND THAT IS INFORMATION RATHER THAN A');
    line('  REPEAT. The keys were read off the chain and grafted on — the line');
    line('  above this says how many — so the graft is not sufficient, and the');
    line('  route decision in this file\'s header is wrong somewhere. Two things');
    line('  are worth knowing before anything is changed: whether the deployed');
    line('  contract is from the CURRENT tree (keys are bound to the circuits');
    line('  deployed with them), and whether the runtime wants the key under a');
    line('  version that reading it off the chain did not carry.');
    line('  Report this message with REPORT-DEPLOY.txt from the deploy that');
    line('  wrote the address above.');
  } else {
    line('  THIS IS SDK WIRING OR THE STATE HANDED TO IT, NOT THE CIRCUIT. The');
    line('  circuit logic is covered by the contract tests, which run the same');
    line('  generated code in process.');
  }
  line('');
  line('  NOTHING WAS MEASURED and no number below was estimated.');
  process.exit(2);
}

/* ---------------- the proof server ---------------- */

line('\nConnecting to the proof server');
const health = await fetch(`${PROOF_SERVER}/health`).catch(() => null);
if (!health || !health.ok) {
  fail(`the proof server is not answering at ${PROOF_SERVER}.

Nothing was measured, and nothing was estimated: a proving time is a wall-clock
measurement against a running server and there is no way to approximate one.

Start it the way every other script here does:
  docker run -d --name midnight-proof-server-9.0.0-rc.3 -p 6301:6300 \\
    midnightntwrk/proof-server:9.0.0-rc.3 midnight-proof-server -v`, 3);
}
const reported = await fetch(`${PROOF_SERVER}/version`).then((r) => r.text()).catch(() => '');
line(`  proof server ok at ${PROOF_SERVER}${reported ? `  (/version: ${reported.trim().slice(0, 60)})` : ''}`);

/* ---------------- the stall detector ---------------- */

/*
 * TWO INSTRUMENTS, BECAUSE "SLOW" AND "BLOCKED" ARE DIFFERENT ANSWERS.
 *
 * The 13 Aug measurement recorded the main thread unresponsive for 33 to 58
 * seconds during every circuit, deepest named frame `Builtins_JSToWasmWrapperAsm`
 * — a tab that cannot repaint cannot tell anybody what it is doing. And
 * `unprovenTx.prove()` blocked for 20+ minutes after the server had answered
 * `/prove` in 2.03s.
 *
 * **THIS EXERCISES EXACTLY THAT PATH.** `httpClientProofProvider(...).proveTx`
 * calls `unprovenTx.prove(provingProvider, costModel)` — the ledger's WASM
 * method — at `midnight-js-http-client-proof-provider/dist/index.mjs:180`. So a
 * stall here is the same stall.
 *
 *   · the WATCHDOG runs on a worker thread with its own event loop, so it keeps
 *     reporting while the main thread is blocked, and writes with a direct
 *     syscall rather than through the thread it is watching.
 *   · the GAP TIMER runs on the main loop and records the longest interval it
 *     was denied. A loop that never falls behind is a loop that was never
 *     blocked, and that is the negative result stated as a number.
 */
const sharedBuffer = new SharedArrayBuffer(9 * 8);
const shared = new BigInt64Array(sharedBuffer);
const PULSE = 0, IN_FLIGHT = 1, STEP = 2, STEP_START = 3, PHASE = 4;
const pulse = () => Atomics.store(shared, PULSE, BigInt(Date.now()));
pulse();
setInterval(pulse, 2000).unref();
// 3: "asking the proof server to prove", from the watchdog's own PHASES list.
Atomics.store(shared, PHASE, 3n);

let maxGapMs = 0;
let lastTick = Date.now();
const TICK_MS = 250;
const gapTimer = setInterval(() => {
  const now = Date.now();
  maxGapMs = Math.max(maxGapMs, now - lastTick - TICK_MS);
  lastTick = now;
}, TICK_MS);
gapTimer.unref();

const watchdog = new Worker(new URL('./watchdog.mjs', import.meta.url), {
  workerData: { sharedBuffer, timeoutMs: PER_PROOF_MS, heartbeatMs: 15_000, label: 'proving execute', witnessNames: [] },
});
watchdog.unref();

/* ---------------- prove ---------------- */

let proofBytes = null;

const timeOne = async (label) => {
  Atomics.store(shared, STEP_START, BigInt(Date.now()));
  Atomics.store(shared, IN_FLIGHT, 1n);
  Atomics.add(shared, STEP, 1n);
  lastTick = Date.now();
  pulse();
  const t0 = performance.now();
  const proven = await proofProvider.proveTx(unprovenTx);
  const ms = performance.now() - t0;
  Atomics.store(shared, IN_FLIGHT, 0n);
  if (proofBytes === null) {
    // `Transaction.serialize(): Uint8Array`, no arguments — read from the
    // installed `@midnightntwrk/ledger-v9/ledger-v9.d.ts`, not assumed. If a
    // future build changes it, this reports UNKNOWN rather than a wrong number.
    try {
      proofBytes = proven.serialize().length;
    } catch (e) {
      proofBytes = { unknown: String(e?.message ?? e).slice(0, 120) };
    }
  }
  line(`  ${label}: ${(ms / 1000).toFixed(2)}s`);
  return ms;
};

line('\nProving `execute`');
line(`  ${'\x1b[2m'}one proof at a time, nothing else running${'\x1b[0m'}`);
let cold;
try {
  cold = await timeOne('cold (first proof in a fresh process, includes key load)');
} catch (e) {
  fail(`proving failed: ${e?.message ?? e}\n\nNothing was measured. No number was estimated.`);
}

const warm = [];
for (let i = 1; i <= 3; i++) warm.push(await timeOne(`warm run ${i}`));
const avg = warm.reduce((a, b) => a + b, 0) / warm.length;

/* ---------------- verdict ---------------- */

line('\n' + '─'.repeat(58));
line(`RESULT  cold ${(cold / 1000).toFixed(2)}s   warm average ${(avg / 1000).toFixed(2)}s`);
line(`        proof size ${typeof proofBytes === 'number' ? `${proofBytes} bytes (${(proofBytes / 1024).toFixed(1)} KiB)` : `UNKNOWN — ${proofBytes?.unknown}`}`);
line(`        longest main-thread gap ${(maxGapMs / 1000).toFixed(1)}s`);
line('─'.repeat(58));

/*
 * WHAT "COLD" MEANS HERE, SAID RATHER THAN IMPLIED.
 *
 * Cold is the first proof in a fresh process: it includes reading a 9.5MB
 * proving key from disk and whatever the SDK initialises once. It does NOT
 * include the proof server's own first-run download of the shared reference
 * string, because the container is deliberately kept between runs — throwing
 * that away was the previous version's other defect. A colder number than this
 * one exists and this cannot produce it; `docker rm` the container first and
 * run again if it is wanted.
 */
line('');
line('COLD here means the first proof in a fresh process, against a server that may');
line('already hold its downloaded parameters. That is the number a signer pays on a');
line('machine that has proved before. A first-ever-run figure needs the container');
line('removed first and is a separate measurement.');

line('');
if (maxGapMs > STALL_MS) {
  line(`THE STALL REPRODUCES ON THE PINNED STACK. The main thread was denied the`);
  line(`event loop for ${(maxGapMs / 1000).toFixed(1)}s at its worst. A tab that cannot repaint cannot tell`);
  line('anybody what it is doing, and no timer, promise or progress bar written in');
  line('JavaScript runs during it. That is scope 7 §5.4 as a number.');
} else {
  line(`The 20-minute WASM stall did NOT reproduce: the longest the main thread was`);
  line(`denied the event loop was ${maxGapMs}ms, over ${warm.length + 1} proofs. What that covers is`);
  line('proving through the http proof provider on this stack, in node. It says');
  line('nothing about the browser, where the 13 Aug measurement was taken.');
}

line('');
if (avg < 2000) {
  line('Under 2 seconds warm. A signer can approve from a browser tab.');
  line('In-browser proving is viable, so we can support 1AM and mobile wallets');
  line('without asking anyone to install a proof server.');
} else if (avg < 10000) {
  line('Between 2 and 10 seconds. Usable, but the interface has to be honest');
  line('about the wait rather than pretending it is instant. Worth trying to');
  line('shrink `execute` before committing to in-browser proving.');
} else {
  line('Over 10 seconds. Every signer would need a local proof server, which');
  line('rules out in-browser wallets and makes onboarding materially worse.');
  line('`execute` should be split, or proving moved to a service we run.');
}

line('');
line(`PROVE_COLD_MS=${Math.round(cold)}`);
line(`PROVE_WARM_AVG_MS=${Math.round(avg)}`);
line(`PROVE_SIZE_BYTES=${typeof proofBytes === 'number' ? proofBytes : 'UNKNOWN'}`);
line(`PROVE_MAX_MAIN_THREAD_GAP_MS=${Math.round(maxGapMs)}`);
line(`PROOF_SERVER=${PROOF_SERVER}`);
process.exit(0);
