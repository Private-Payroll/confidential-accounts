/**
 * Runs the contract's circuits in process.
 *
 * No proof server, no node, no proving keys. The generated TypeScript executes
 * the same logic the circuit will, against a real ledger state, which means
 * every assertion, every nullifier and every Merkle check behaves here exactly
 * as it will on chain. What it does not test is the proof: that the circuit
 * is satisfiable and that the verifier accepts it. That is M-2 and M-3.
 *
 * Pattern taken from midnightntwrk/example-bboard.
 *
 * EVERYTHING THAT TOUCHES STATE IS ASYNC ON compact-runtime 0.18.
 *
 * `initialState` and every impure circuit returned their result directly on
 * 0.16 and return a Promise on 0.18. Called the old way they hand back a
 * Promise that destructures into `undefined`, and the failure surfaces as
 * "Cannot read properties of undefined (reading 'data')" from deep inside the
 * constructor — a null-pointer message for what is actually a signature change.
 *
 * `pureCircuits` stayed synchronous, so this uses the module-level export for
 * leaves and commitments rather than `contract.circuits`, whose members did
 * become async. Fewer awaits, and it is the same code the scripts use.
 *
 * AND THE CONTEXT ITSELF CHANGED SHAPE. On 0.16 a `CircuitContext` was flat —
 * `{ currentPrivateState, currentZswapLocalState, costModel, currentQueryContext }`
 * — and this simulator built one by hand. On 0.18 it nests that under
 * `callContext`, alongside a `circuitId` and a contract address, and the
 * generated code reads `context.callContext.currentQueryContext`. Handed the
 * old flat object it throws "Cannot read properties of undefined", which reads
 * like a null bug and is really a changed interface.
 *
 * The runtime ships `createCircuitContext`, documented as "always use this
 * function to set up the initial circuit context", so this no longer builds the
 * shape by hand at all. Because the circuit id is now part of the context, a
 * fresh one is made per call and the three things that carry between calls —
 * ledger state, private state, Zswap local state — are threaded explicitly.
 * That is closer to what actually happens on chain than reusing one blob.
 */
import {
  type CircuitContext,
  sampleContractAddress,
  createConstructorContext,
  createCircuitContext,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, type Ledger, ledger, pureCircuits } from '../managed/contract/index.js';
import {
  witnesses,
  type AccountPrivateState,
  type SignerPath,
  ALL_VAULTS,
  NO_VAULT,
} from '../src/witnesses.js';

/**
 * Thirty-two zero bytes.
 *
 * **IT WAS THE FILLER `addSigner` TOOK ON THE BOOTSTRAP PATH, AND THAT PATH IS
 * GONE.** `S35d`: the constructor takes no threshold, so no account is ever in
 * the state that opened the free branch and every seating names a real
 * proposal. What the constant is for now is naming NO proposal — a value
 * `persistentCommit` can never produce, so it is in no account's `openProposals`
 * — which is exactly what the tests that assert an unapproved seating is refused
 * need to hand in. It is also `propose`'s unread `root` on the governance path.
 */
export const ZERO_32 = new Uint8Array(32);

const bytes = (seed: number): Uint8Array => {
  // Deterministic, so a failing test fails the same way twice.
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i * 7) % 256;
  return out;
};

/**
 * A DEVICE'S LEAF, WITHOUT AN ACCOUNT TO ASK.
 *
 * `AccountSimulator.leafOf` is a method, and a method needs an instance. The
 * FOUNDING leaf has to exist BEFORE the constructor runs — that is the whole of
 * The leaf is computed on the founder's own device and handed to the
 * deploy as a public value, so the deploying process never holds the material
 * it was made from. Same three inputs and the same circuit as `leafOf`, which
 * now calls this rather than spelling it a second time.
 */
export const leafOfDevice = (state: AccountPrivateState): Uint8Array =>
  pureCircuits.signerLeaf(
    pureCircuits.signerPublicKey(state.secretKey), state.blinding, state.scope);

/** The ASCII asset code, padded to 32 bytes, the way `core/assets.ts` does it. */
export const assetBytes = (code: string): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < code.length; i++) out[i] = code.charCodeAt(i);
  return out;
};

/** The default asset for tests that are not about assets. Two decimals. */
export const GBP = assetBytes('GBP');
export const USDC = assetBytes('USDC');

/*
 * `view(balance, seed)` STOOD HERE.
 *
 * It built one asset's `{ balance, balanceSalt }` for a device's `current` and
 * `next`. The account keeps no balance, `ShieldedView` is gone from
 * `contracts/src/witnesses.ts`, and the four witnesses that read it are gone
 * from the contract.
 */

/**
 * One signer's device.
 *
 * THE ASSET BLINDING IS SEEDED BY `viewSeed`, NOT BY THE SIGNER, and that is
 * decision 0002 rather than a shortcut: it is an ACCOUNT-level secret, and every
 * signer must derive the same asset key or the change commitment one of them
 * approves is not the one another recomputes.
 *
 * `balance` AND THE `current`/`next` PAIR STOOD HERE. The account
 * keeps no balance, so a device holds no view of one. What is left is what a
 * device genuinely holds — its secret, its blinding, which asset a call
 * concerns, and the change a proposal makes.
 *
 * Pass `viewSeed` to give a device a DIFFERENT asset blinding, which is how a
 * test plays a caller who cannot derive this account's asset key.
 */
export const privateStateFor = (
  seed: number,
  viewSeed = 0,
  asset: Uint8Array = GBP,
): AccountPrivateState => ({
  secretKey: bytes(seed),
  blinding: bytes(seed + 400),
  /*
   * Every signer is seated with ALL_VAULTS. V-33.
   *
   * From the contract's own circuit rather than a constant here, for the same
   * reason VACANT_SLOT is: two sides computing a sentinel separately is two
   * sentinels waiting to drift, and a signer seated under one spelling could
   * not prove membership under the other.
   */
  scope: ALL_VAULTS,
  /*
   * THE ASSET BLINDING IS SEEDED BY `viewSeed`, NOT BY THE SIGNER, and getting
   * that backwards would make every multi-asset test fail for the wrong reason.
   * It is an ACCOUNT-level secret: every signer must derive the same key for
   * the same asset, or an approval of one proposal would recompute as a
   * different id. See `assetBlinding` in contracts/src/witnesses.ts.
   */
  assetBlinding: bytes(viewSeed + 800),
  assetId: asset,
  proposalSalt: bytes(seed + 300),
  changeAmount: 0n,
  changeBatchDigest: bytes(seed + 500),
  pinnedPath: null,
  pinAnyLeaf: false,
});

/**
 * A change, as a proposer's device would hold it.
 *
 * `salt` is the proposal's blinding factor and must be identical on the
 * proposing and executing devices — the circuit recomputes the commitment from
 * it. A fresh one is a different change and the round can never settle.
 */
export interface Change {
  /** Which asset moves. Part of what the signers approve, since M-125. */
  asset: Uint8Array;
  amount: bigint;
  batch: Uint8Array;
  salt: Uint8Array;
}

export const change = (amount: bigint, seed = 9, asset: Uint8Array = GBP): Change => ({
  asset,
  amount,
  batch: bytes(seed + 600),
  salt: bytes(seed + 700),
});

export class AccountSimulator {
  readonly contract: Contract<AccountPrivateState>;
  readonly address: string;

  /** The three things that carry from one call to the next. */
  private contractState: any;
  /** The ContractState the constructor produced, kept for cross-contract calls. */
  private readonly initialContractState: any;
  private privateState: AccountPrivateState;
  private zswap: any;

  private constructor(
    contract: Contract<AccountPrivateState>,
    address: string,
    contractState: any,
    privateState: AccountPrivateState,
    zswap: any,
  ) {
    this.contract = contract;
    this.address = address;
    this.initialContractState = contractState;
    this.contractState = contractState;
    this.privateState = privateState;
    this.zswap = zswap;
  }

  /**
   * A factory, because a constructor cannot await and `initialState` is async
   * on compact-runtime 0.18.
   */
  /**
   * **THE FOUNDING LEAF IS A SEPARATE THING FROM THE DEVICE THAT DEPLOYS, AND
   * THE DEFAULT IS WHAT MAKES THAT INVISIBLE TO EVERY OTHER TEST.**
   *
   * The constructor used to derive its one seat from the DEPLOYING device's
   * witnesses. It now takes the founder's leaf as a public argument and calls
   * none of them:
   *
   *   `founder`      the device whose private state the simulator carries on
   *                  with, exactly as before — every `create(x)` call site
   *                  still gets an account `x` can act on
   *   `foundingLeaf` what is actually SEATED. Defaults to the founder's own
   *                  leaf, which is what a real founder deploying for
   *                  themselves would hand over
   *
   * **PASS THEM APART AND THE DEPLOYING DEVICE IS NOT A SIGNER**, which is the
   * property `C334` is about and which no test could express while the two were
   * the same value by construction. `what-a-signer-is.test.ts` does exactly
   * that.
   *
   * **THE THRESHOLD ARGUMENT IS GONE, AND IT WAS THE SECOND OF THREE.** `S35d`,
   * `C340` + `C343`, ruled by the founder 2 Sep. The constructor takes no
   * threshold and sets `threshold = 1`, so **every account this factory makes
   * is one seat at one approval** and there is no `create(x, 2n)` state to ask
   * for any more.
   *
   * **WHICH MEANS THE BOOTSTRAP WINDOW IS SHUT AND `addSigner(leaf, ZERO_32)`
   * NO LONGER SEATS ANYBODY.** That call was how nearly every fixture in this
   * directory built itself. `liveAccount` below is the replacement and it does
   * on the simulator exactly what a founder now does on chain. The reasoning is
   * in the contract beside `threshold = 1` and in `docs/company-accounts.md`
   * section 10a; the short version is that no writer can produce the state that
   * opens the window, so the free branch is dead code.
   */
  static async create(
    founder: AccountPrivateState,
    foundingLeaf: Uint8Array = leafOfDevice(founder),
  ): Promise<AccountSimulator> {
    const contract = new Contract<AccountPrivateState>(witnesses);
    const { currentPrivateState, currentContractState, currentZswapLocalState } =
      await contract.initialState(
        createConstructorContext(founder, '0'.repeat(64)),
        foundingLeaf,
      );
    return new AccountSimulator(
      contract,
      sampleContractAddress(),
      currentContractState,
      currentPrivateState,
      currentZswapLocalState,
    );
  }

  /**
   * **AN ACCOUNT WITH `devices` SEATED AND THE THRESHOLD AT `threshold`, BUILT
   * THE WAY A FOUNDER NOW HAS TO BUILD ONE.**
   *
   * **THIS REPLACES `create(x, n)` FOLLOWED BY `addSigner(leaf, ZERO_32)`,
   * WHICH WAS HOW ALMOST EVERY FIXTURE IN THIS DIRECTORY WAS MADE.** That
   * pattern used the bootstrap window: an account founded needing more
   * approvals than it had seats let its one signer seat the rest alone. The
   * constructor no longer takes a threshold, so the window is shut from birth
   * and a bare `addSigner` is refused *"there is no open proposal with that
   * id"*.
   *
   * **WHAT IT DOES INSTEAD IS NOT A SHORTCUT — IT IS THE REAL PATH.** Every
   * seat after the first is `propose` → `approve` × threshold → `amendSigner`,
   * and the threshold is raised at the end by the same three steps through
   * `setThreshold`. Every one of those goes through the compiled circuits with
   * every assert live, which is the point of this simulator.
   *
   * **THE THRESHOLD IS RAISED LAST, AND THAT ORDER IS FORCED.** `setThreshold`
   * asserts `!(signerLeaves.size() < newThreshold)`, so the seats must exist
   * before the number can name them. Raising first is not a slower way to the
   * same state, it is a refusal.
   *
   * `devices[0]` founds the account and its private state is what the returned
   * simulator carries, so `sim.as(devices[0])` is not needed afterwards — which
   * is what `create` did too.
   */
  static async liveAccount(
    devices: AccountPrivateState[],
    threshold: bigint = BigInt(devices.length),
  ): Promise<AccountSimulator> {
    if (devices.length < 1) throw new Error('an account needs a founding signer');
    if (threshold < 1n || threshold > BigInt(devices.length)) {
      throw new Error(
        `a threshold of ${threshold} is not reachable with ${devices.length} signer(s): ` +
        'the contract refuses a threshold above the seat count',
      );
    }
    const sim = await AccountSimulator.create(devices[0]!);
    for (let i = 1; i < devices.length; i++) {
      await sim.seatSigner(devices[i]!, devices.slice(0, i), 300 + i);
    }
    if (threshold > 1n) await sim.raiseThreshold(threshold, devices, 380);
    sim.as(devices[0]!);
    return sim;
  }

  /**
   * Seats `who` through the approved path, with `approvers` (who must already
   * be seated) voting. `seed` picks the round's salt.
   *
   * **THE PROPOSING DEVICE AND THE AMENDING DEVICE MUST CARRY THE SAME SALT.**
   * `propose` commits to it and `amendSigner` recomputes
   * `proposalIdOf(signerAddPayload(leaf), noVault(), proposalSalt())` from the
   * witness, so a device that proposed under one salt and amended under another
   * fails to recognise its own proposal. That is `M-128`, and `applying` is how
   * a device is handed a round's salt here.
   */
  async seatSigner(
    who: AccountPrivateState,
    approvers: AccountPrivateState[],
    seed = 301,
  ): Promise<Uint8Array> {
    return this.seatLeaf(this.leafOf(who), approvers, seed);
  }

  /**
   * The same, for a leaf that belongs to no device this simulator can derive
   * from — a leaf the PRODUCT wrote, or a deliberately wrong one.
   *
   * `what-a-signer-is.test.ts` needs this: its whole point is that the leaf
   * comes from `MidnightCommitments` or from `AccountService.create` rather
   * than from `leafOf`, and seating it is how the contract is asked whether it
   * agrees. The tree accepts any 32 bytes, which is why a wrong derivation is
   * silent until somebody tries to prove membership.
   */
  async seatLeaf(
    leaf: Uint8Array,
    approvers: AccountPrivateState[],
    seed = 301,
  ): Promise<Uint8Array> {
    const c = change(0n, seed);
    const payload = pureCircuits.signerAddPayload(leaf);
    const by = approvers[0]!;
    await this.as(this.applying(by, c)).propose(payload);
    const id = this.proposalId(payload, c.salt);
    for (const a of approvers) await this.as(a).approve(id);
    await this.as(this.applying(by, c)).addSigner(leaf, id);
    return id;
  }

  /**
   * Moves the threshold through the approved path, with `approvers` voting.
   *
   * Same salt discipline as `seatSigner`, against `setThresholdPayload`.
   */
  async raiseThreshold(
    newThreshold: bigint,
    approvers: AccountPrivateState[],
    seed = 381,
  ): Promise<Uint8Array> {
    const c = change(0n, seed);
    const payload = pureCircuits.setThresholdPayload(newThreshold);
    const by = approvers[0]!;
    await this.as(this.applying(by, c)).propose(payload);
    const id = this.proposalId(payload, c.salt);
    for (const a of approvers) await this.as(a).approve(id);
    await this.as(this.applying(by, c)).setThreshold(newThreshold, id);
    return id;
  }

  /**
   * THE BLOCK TIME THIS SIMULATOR IS RUNNING AT, in seconds since the Unix
   * epoch. V-67.
   *
   * A run's payments assert they fall inside an approved window, so a test that
   * could not move the clock could only ever test "now" — and the two failures
   * that matter, paying before a window opens and after it closes, would be
   * untestable. `createCircuitContext` takes the time as its ninth argument and
   * the runtime stores it as `secondsSinceEpoch`, so SECONDS is the unit here;
   * passing milliseconds would put every test in the year 56000 and every
   * window assert would pass for the wrong reason.
   *
   * **THE DEFAULT IS A FIXED INSTANT, NOT THE WALL CLOCK.** A simulator
   * that reads `Date.now()` makes every test that touches a window depend on
   * when it happens to run, and a test near a window boundary is then a coin
   * flip — which presents as flakiness and trains whoever runs the suite to
   * re-run rather than to look. Nothing here is measuring real time, so nothing
   * here should read a real clock.
   *
   * 2027-01-15T08:00:00Z, chosen only for being far from any boundary a test
   * picks and stable forever.
   */
  blockTime = 1_800_000_000;

  /** Moves the simulated clock. Returns `this`, so it reads inline in a test. */
  at(secondsSinceEpoch: number | bigint): this {
    this.blockTime = Number(secondsSinceEpoch);
    return this;
  }

  /** A context for one call. The circuit id is part of it, so it is per call. */
  private contextFor(circuitId: string): CircuitContext<AccountPrivateState> {
    return createCircuitContext<AccountPrivateState>(
      circuitId,
      this.address as never,
      this.zswap ?? '0'.repeat(64),
      this.contractState,
      this.privateState,
      undefined,
      undefined,
      undefined,
      this.blockTime,
    );
  }

  /**
   * Becomes a different signer.
   *
   * Swapping the whole private state, not just the key, because on a real
   * deployment each signer is a different device with its own everything. A
   * simulator that shared state between "users" would quietly let a test pass
   * that could not happen in production.
   */
  as(state: AccountPrivateState) {
    this.privateState = state;
    return this;
  }

  get ledger(): Ledger {
    return ledger(this.contractState.data ?? this.contractState);
  }

  /**
   * This account's state, in the shape a CROSS-CONTRACT CALL needs. V-39.
   *
   * A `ContractStateProvider` hands the runtime a `ContractState`, because the
   * runtime asks it for `operation(circuitId)` to check the callee's deployed
   * verifier key. The simulator otherwise carries the bare state value, which
   * answers no such question — so this rewraps the current state into the
   * initial `ContractState` rather than handing over something that looks
   * close enough and fails inside the runtime.
   */
  get contractStateForCall(): unknown {
    const cs: any = this.initialContractState;
    cs.data = this.contractState.data ?? this.contractState;
    return cs;
  }

  /**
   * Takes back what a CROSS-CONTRACT CALL wrote to this account.
   *
   * A vault's `payout` calls `recordPayment`, and the account's write happens
   * inside the vault's circuit context. On chain that write is committed by the
   * transaction; here it sits in `queryContexts[<account address>]` and the
   * simulator knows nothing about it until this is called.
   *
   * **Without it a test can pay the same payee twice and see it succeed** —
   * not because the contract allows it, but because the second call is judged
   * against an account that never saw the first. That is exactly the wrong
   * thing for a simulator to be lenient about, so it is a named step rather
   * than automatic: a test that means to carry the account forward says so.
   */
  adoptFromCall(context: any): void {
    const qc = context?.queryContexts?.[this.address as never];
    if (!qc) throw new Error('that call did not touch this account');
    this.contractState = qc.state;
  }

  get currentPrivateState(): AccountPrivateState {
    return this.privateState;
  }

  /** The public identity of whoever is currently acting. Not what goes in the tree. */
  publicKeyOf(state: AccountPrivateState): Uint8Array {
    return pureCircuits.signerPublicKey(state.secretKey);
  }

  /** What actually goes in the tree: the blinded commitment. */
  leafOf(state: AccountPrivateState): Uint8Array {
    // A signer's leaf no longer moves. Under M-99 it was stamped with the
    // account's generation, so a removal changed everybody's; M-106 clears one
    // slot instead, so a leaf is the same value for the life of the signer.
    return leafOfDevice(state);
  }

  /** Which slot a signer occupies, read from the tree rather than assumed. */
  slotOf(state: AccountPrivateState): bigint {
    const path = this.ledger.signers.findPathForLeaf(this.leafOf(state));
    if (!path) throw new Error('not a signer');
    return pureCircuits.slotOf(path as never);
  }

  /*
   * `commitmentOf` AND `balanceEntry` STOOD HERE. One wrapped
   * `balanceCommitmentOf`, the other looked an asset up in `assetBalances`;
   * both are gone from the contract.
   */

  /** Which asset a change commitment names, for this account. */
  assetKeyOf(state: AccountPrivateState, asset: Uint8Array = state.assetId): Uint8Array {
    return pureCircuits.assetKeyOf(asset, state.assetBlinding);
  }

  /**
   * What the chain will call a proposal over this payload, under this salt.
   *
   * From the contract's own `proposalIdOf`, not recomputed here — a test that
   * derived the id a second way would pass while agreeing with itself rather
   * than with the contract.
   */
  proposalId(payloadHash: Uint8Array, salt: Uint8Array, vault: Uint8Array = NO_VAULT): Uint8Array {
    return pureCircuits.proposalIdOf(payloadHash, vault, salt);
  }

  /** How many approvals a given proposal has on chain. */
  approvalsFor(id: Uint8Array): bigint {
    return this.ledger.approvalCounts.member(id) ? this.ledger.approvalCounts.lookup(id) : -1n;
  }

  /** Is this proposal open? Presence IS the answer since M-128. */
  isOpen(id: Uint8Array): boolean {
    return this.ledger.openProposals.member(id);
  }

  /** Captures a membership path now, to replay after the tree has moved on. */
  pathFor(state: AccountPrivateState): SignerPath {
    const found = this.ledger.signers.findPathForLeaf(this.leafOf(state));
    if (!found) throw new Error('not a signer');
    return found as unknown as SignerPath;
  }

  /**
   * A device that answers every path request with `path`, honestly or not.
   *
   * This is how a test plays a caller who is NOT using our client — which is
   * the only caller the contract's path-binding asserts exist for. An honest
   * witness cannot produce a wrong path, so without this the asserts are
   * unreachable and a mutation deleting them survives.
   */
  dishonest(state: AccountPrivateState, path: SignerPath): AccountPrivateState {
    return { ...state, pinnedPath: path, pinAnyLeaf: true };
  }

  /**
   * Runs one circuit and carries its effects forward.
   *
   * A failing circuit must leave nothing behind — an assert that fires on chain
   * does not half-apply — so state is only adopted once the call has returned.
   */
  private async run<T>(
    circuitId: string,
    fn: (ctx: CircuitContext<AccountPrivateState>) => Promise<{ context: any; result: T }>,
  ): Promise<T> {
    const out = await fn(this.contextFor(circuitId));
    const call = out.context.callContext;
    this.contractState = call.currentQueryContext.state;
    if (call.currentPrivateState !== undefined) this.privateState = call.currentPrivateState;
    if (call.currentZswapLocalState !== undefined) this.zswap = call.currentZswapLocalState;
    return out.result;
  }

  /**
   * Seats a signer.
   *
   * `intoVacatedSlot` defaults to false — append into a fresh slot — because
   * that is what an account does until somebody leaves. Pass true to take a
   * slot a removal freed. The two are separate operations because the signer
   * tree is sparse and a never-written slot has no path to prove anything
   * about; see the argument's comment in the contract.
   */
  addSigner(leaf: Uint8Array, proposal: Uint8Array = ZERO_32, intoVacatedSlot = false) {
    /* `amendSigner` with `removing` false — the S11 merge. The method keeps its
     * name because seating is still its own act everywhere above the ABI. */
    return this.run('amendSigner',
      (c) => this.contract.impureCircuits.amendSigner(c, leaf, proposal, intoVacatedSlot, false));
  }

  /** What a vacated slot holds, from the contract's own definition. */
  get vacant(): Uint8Array { return pureCircuits.vacantSlot(); }

  /** Which slots currently hold the vacancy marker, lowest first. */
  vacatedSlots(): bigint[] {
    const out: bigint[] = [];
    let path = this.ledger.signers.findPathForLeaf(this.vacant);
    if (path) out.push(pureCircuits.slotOf(path as never));
    return out;
  }

  /**
   * Removes a signer by clearing their one slot.
   *
   * One argument, where the previous design took the departing leaf plus a
   * sixteen-wide vector of survivors to re-seat. Nobody but the person leaving
   * is touched, so there is nothing else to pass.
   */
  removeSigner(removedLeaf: Uint8Array, proposal: Uint8Array) {
    /* `amendSigner` with `removing` true; `intoVacatedSlot` is ignored there. */
    return this.run('amendSigner',
      (c) => this.contract.impureCircuits.amendSigner(c, removedLeaf, proposal, false, true));
  }

  /** Changes M in M of N, through an approved round. */
  setThreshold(newThreshold: bigint, proposal: Uint8Array) {
    return this.run('setThreshold',
      (c) => this.contract.impureCircuits.setThreshold(c, newThreshold, proposal));
  }

  propose(payloadHash: Uint8Array, vault: Uint8Array = NO_VAULT) {
    /* The opaque path of the merged `propose`: `isRun` false, run parts zero. */
    return this.run('propose', (c) => this.contract.impureCircuits.propose(
      c, payloadHash, ZERO_32, 0n, 0n, 0n, false, vault));
  }

  /**
   * What a vault calls to pay ONE PAYEE of an approved run. V-41, V-43.
   *
   * **Every argument, and not one witness.** V-38: a cross-contract callee is
   * proved by whoever built the transaction, and the vault does not hold this
   * account's private state. That is also what makes the tests here honest —
   * a wrong salt, a wrong nonce or somebody else's path is handed over
   * directly, rather than approximated by pretending to be a different device.
   */
  recordPayment(args: {
    proposal: Uint8Array;
    vault: Uint8Array;
    root: Uint8Array;
    payees: bigint;
    from: bigint;
    until: bigint;
    salt: Uint8Array;
    details: Uint8Array;
    nonce: Uint8Array;
    path: unknown;
  }) {
    return this.run('recordPayment',
      (c) => this.contract.impureCircuits.recordPayment(
        c, args.proposal, args.vault, args.root, args.payees, args.from, args.until,
        args.salt, args.details, args.nonce, args.path as never));
  }

  /** Raises a payroll run with its window. V-67. An OMITTED `vault` defaults to `NO_VAULT` DELIBERATELY, and `payout-runs.test.ts:698` is the case that walks it — `T-248`. */
  proposeRun(args: {
    root: Uint8Array;
    payees: bigint;
    from: bigint;
    until: bigint;
    vault?: Uint8Array;
  }) {
    /* The run path of the merged `propose`: `isRun` true, opaque hash zero. */
    return this.run('propose',
      (c) => this.contract.impureCircuits.propose(
        c, ZERO_32, args.root, args.payees, args.from, args.until, true,
        args.vault ?? NO_VAULT));
  }

  /** Sweeps a run whose window has closed. Permissionless by design. V-67. */
  closeExpiredRun(proposal: Uint8Array) {
    return this.run('closeExpiredRun',
      (c) => this.contract.impureCircuits.closeExpiredRun(c, proposal));
  }

  /**
   * A run's approved window, or undefined if that id is not a run.
   *
   * This replaced `unpaid()`, which read a counter of outstanding payees. There
   * is no such counter any more — it serialised every payment of a run (V-61) —
   * so "how far along is this run" is answered from `movements` by
   * `runStatus`, not from the account. See `run-status.ts`.
   */
  runWindow(proposal: Uint8Array): { from: bigint; until: bigint } | undefined {
    /*
     * ONE MAP SINCE S35c. `runStart` and `runEnd` were two fields; `runWindow`
     * holds an `{ opensAt, closesAt }` record per run, and a governance proposal
     * still has NO ROW AT ALL rather than a pair of zeros — which is the
     * property `cancel` and `closeExpiredRun` rest on, so this keeps answering
     * `undefined` for one.
     */
    const key = Buffer.from(proposal).toString('hex');
    for (const [k, v] of this.ledger.runWindow) {
      if (Buffer.from(k).toString('hex') === key) return { from: v.opensAt, until: v.closesAt };
    }
    return undefined;
  }

  setVaultThreshold(vault: Uint8Array, newThreshold: bigint, proposal: Uint8Array) {
    return this.run('setVaultThreshold',
      (c) => this.contract.impureCircuits.setVaultThreshold(c, vault, newThreshold, proposal));
  }

  /**
   * Declares a vault to be this company's, through an approved round.
   *
   * THERE IS NO `retireVault` HERE, and its absence is the design rather than a
   * gap: retirement is refused while the vault still holds notes, only the
   * vault can see its own pool, so the account's half is reachable ONLY as a
   * cross-contract call from `Vault.retire`. A simulator method would let a
   * test retire a vault by a route no caller has, which is the shape of test
   * that passes while the product cannot do the thing.
   */
  adopt(vault: Uint8Array, proposal: Uint8Array) {
    return this.run('adopt',
      (c) => this.contract.impureCircuits.adopt(c, vault, proposal));
  }

  /** Which vaults this account has adopted, as the chain holds them. */
  adopted(vault: Uint8Array): boolean {
    return this.ledger.vaults.member(vault);
  }
  approve(proposal: Uint8Array) {
    return this.run('approve', (c) => this.contract.impureCircuits.approve(c, proposal));
  }
  cancel(proposal: Uint8Array) {
    return this.run('cancel', (c) => this.contract.impureCircuits.cancel(c, proposal));
  }

  /**
   * A device about to raise or recognise the change `c`.
   *
   * IT TOOK A `current: ShieldedView` AS ITS SECOND ARGUMENT and computed the
   * `next` balance the way the circuit would check it. There is
   * no balance, no `current`, no `next`. What a device carries into a call is
   * which asset, how much, over which entries, under which proposal salt — and
   * `changeCommitmentOf` binds all four.
   *
   * A fifth thing, `credited`, ADDED value on the way in for `credit`'s
   * callers; S23 shed that circuit and S25 deleted its callers.
   */
  applying(device: AccountPrivateState, c: Change) {
    return {
      ...device,
      assetId: c.asset,
      changeAmount: c.amount,
      changeBatchDigest: c.batch,
      proposalSalt: c.salt,
    };
  }
}
