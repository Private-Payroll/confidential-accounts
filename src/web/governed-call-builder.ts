/**
 * **A PROPOSAL RAISED, OR A PROPOSAL APPROVED, BUILT AND PROVED ON THE SIGNER'S OWN
 * DEVICE.**
 *
 * Both calls open with the contract's signer check, which reads three values
 * off the calling device - the signer's secret key, their blinding and their
 * scope - and a path through the public signer tree. Those three exist in one
 * place, the signer's own keyring, so these calls can only be built where the
 * keyring is open. **RUNS IN THE PROVING WORKER**, where the contract runtime
 * and the prover are allowed to load; the page asks for it through
 * `vault-worker-client.ts`.
 *
 * -- THERE IS NO PRIVATE-STATE STORE HERE, AND THAT IS THE DESIGN ----------
 *
 * The usual client hands the call builder a store and a key, and the builder
 * reads the record the circuit needs out of the store. That shape is a
 * capability: whatever holds the store can ask it for any record it holds, at
 * any time. **The call builder used here takes the record itself, as a value,
 * for one call.** So the record is composed in memory from what this call was
 * handed, used for exactly this call, and then its three secret fields are
 * overwritten. Nothing is looked up, nothing is kept, and there is no second
 * question anything here could answer.
 *
 * **WHAT THAT REMOVES, AND WHY IT MATTERS FOR A PAYROLL RUN.** The store-based
 * client writes the record back after every call that settles, as it was when
 * that call STARTED. Anything staged into the store while the call was being
 * proved is silently put back, and the field that would be put back is the
 * salt a proposal's identity is recomputed from. A payroll run is several such
 * calls in a row. **Here there is no store to write back into**: every call is
 * composed from its own order, so a second call cannot read what a first call
 * left behind, and a first call cannot overwrite what a second call staged.
 * Several calls through one client, one after another or at once, share
 * nothing.
 *
 * **WHAT THAT DESIGN RESTS ON, CHECKED ON EVERY CALL RATHER THAN ASSUMED.** It
 * is correct only while no circuit changes the record: the contract's
 * witnesses today hand back the record they were given, unchanged. A circuit
 * that one day wrote something into it would expect that write to be there for
 * the next call, and dropping the record would lose it without a word. So the
 * record a call finishes with is compared with the record it started with, and
 * a call that changed it is refused before it is proved.
 *
 * -- WHAT THIS IS HANDED, AND WHERE EACH PART COMES FROM --------------------
 *
 *   the signer's three    from the keyring the person opened on this device.
 *                         A scope that is absent is refused by name: it is part
 *                         of the leaf, and a record composed without it proves
 *                         the person is not a signer, on a device that looks
 *                         healthy.
 *   the account's half    for a raise only: the asset, the account's asset
 *                         blinding, the salt and the change the proposal commits
 *                         to. The company's service holds these under the
 *                         account's viewing key, and hands them to a member
 *                         who presents that key. An approval reads none of
 *                         them, and a record for an approval refuses by name if
 *                         a circuit ever asks for one.
 *   the chain             the account's contract state and the ledger
 *                         parameters, both as one block saw them.
 *
 * **WHAT LEAVES THIS FILE IS A PROVEN TRANSACTION.** It carries no coin of
 * anybody's: a raise and an approval move nothing, and the two public keys the
 * call builder asks for are made from randomness nobody keeps.
 */
import type { AccountPrivateState } from '../../contracts/src/witnesses.js';
import { fromHex } from '../core/crypto.js';
import { CIRCUITS_THAT_READ_NO_WITNESS } from '../midnight/governed-call.js';
import { ACCOUNT_CIRCUITS_A_DEVICE_GOVERNS } from '../midnight/vault-contract.js';
import { signerHalfOf, type SignerMaterial } from './private-state.js';

export type { SignerMaterial } from './private-state.js';

const HEX64 = /^[0-9a-f]{64}$/u;
const DIGITS = /^[0-9]+$/u;
const ZERO_32 = new Uint8Array(32);

/**
 * **THE ACCOUNT'S HALF OF A RAISE**, as the company's service hands it over.
 * Every value is the hexadecimal of its thirty-two bytes, except the amount,
 * which is decimal digits.
 */
export interface RaiseHalfOnTheWire {
  readonly assetId: string;
  readonly assetBlinding: string;
  readonly proposalSalt: string;
  readonly changeAmount: string;
  readonly changeBatchDigest: string;
}

/** The run a raise opens, as the chain is asked to open it. */
export interface RunOnTheWire {
  readonly root: string;
  readonly payees: string;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly vault: string;
}

/**
 * **A GOVERNANCE ROUND, AS THE DEVICE IS ASKED TO RAISE IT.** Only the change
 * itself is named: the device makes the proposal's payload from it with the
 * contract's own function, so the payload proved is the one for the seat or the
 * threshold this person was shown, and never a digest handed over as bytes.
 */
export type GovernanceOnTheWire =
  | { readonly kind: 'add-signer'; readonly leaf: string }
  | { readonly kind: 'threshold'; readonly threshold: string };

/** Raising a payroll run. */
export interface RaiseRunOrder {
  readonly circuit: 'propose'; readonly run: RunOnTheWire; readonly half: RaiseHalfOnTheWire;
  /** The identity the service wrote the proposal down under; the device recomputes it and refuses a mismatch. */
  readonly proposal: string;
}

/** Raising a round that seats a signer or changes the account's threshold. */
export interface RaiseGovernanceOrder {
  readonly circuit: 'propose'; readonly governance: GovernanceOnTheWire; readonly half: RaiseHalfOnTheWire;
  /** The identity the service wrote the proposal down under; the device recomputes it and refuses a mismatch. */
  readonly proposal: string;
}

/**
 * **WHAT TO BUILD.** One shape per call a device makes here. `proposal` is the
 * proposal's identity on the chain; `proposalSalt` is the salt that identity
 * was made with, which the seating and threshold circuits recompute it from.
 */
export type GovernedCallOrder =
  | RaiseRunOrder
  | RaiseGovernanceOrder
  | {
    readonly circuit: 'approve'; readonly proposal: string;
    /**
     * For a seat or a threshold change: the change this person was asked to
     * approve and the salt the proposal's identity was made with. The identity is
     * remade from them and an approval of any other proposal is refused.
     */
    readonly of?: { readonly governance: GovernanceOnTheWire; readonly proposalSalt: string };
  }
  | { readonly circuit: 'amendSigner'; readonly leaf: string; readonly proposal: string; readonly proposalSalt: string }
  | { readonly circuit: 'setThreshold'; readonly threshold: string; readonly proposal: string; readonly proposalSalt: string };

/** Whether a raise is for a run rather than for a governance round. */
export const raisesARun = (order: GovernedCallOrder): order is RaiseRunOrder =>
  order.circuit === 'propose' && 'run' in order;

/** The account as one block saw it. Both values are their bytes. */
export interface AccountCallChain {
  readonly accountState: Uint8Array;
  readonly parameters: Uint8Array;
}

export interface GovernedCallDeps {
  /** `@midnightntwrk/ledger-v9`. */
  readonly ledger: any;
  /** `@midnight-ntwrk/compact-runtime`'s `ContractState`. */
  readonly runtimeState: { deserialize(bytes: Uint8Array): unknown };
  /**
   * **THE ONE CALL BUILDER, AND IT IS THE ONE THAT TAKES THE RECORD AS A
   * VALUE.** The type names nothing else, so the entry points that read and
   * write a store cannot be reached through this object.
   */
  readonly contracts: {
    createUnprovenCallTxFromInitialStates(...args: any[]): Promise<any>;
  };
  /** The company account's compiled contract, with the account's own witnesses. */
  readonly accountCompiled: unknown;
  /** Hands out the account circuits' verifying keys. */
  readonly accountZkConfig: unknown;
  /** Proves an unproven transaction for the circuit it names. */
  readonly prove: (unproven: any, circuit?: string) => Promise<{ serialize(): Uint8Array }>;
  /** The company account's own pure circuits, which make a proposal's identity from its parts. */
  readonly accountPure: {
    runPayload(root: Uint8Array, payees: bigint, opensAt: bigint, closesAt: bigint): Uint8Array;
    proposalIdOf(payload: Uint8Array, vault: Uint8Array, salt: Uint8Array): Uint8Array;
    signerAddPayload(leaf: Uint8Array): Uint8Array;
    setThresholdPayload(threshold: bigint): Uint8Array;
    noVault(): Uint8Array;
  };
  readonly random?: (n: number) => Uint8Array;
}

/**
 * **A FIELD AN APPROVAL NEVER READS.** Reading one means the circuit has
 * changed under this device, and answering with any value would be answering
 * with a guess.
 */
export class NotReadByAnApproval extends Error {
  constructor(readonly field: string) {
    super(
      `approving a proposal read "${field}" from this device, and an approval has never needed it. ` +
        'The company\'s contract is not the one this page was built for; nothing was built or sent. ' +
        'Reload the page to use the current build.',
    );
    this.name = 'NotReadByAnApproval';
  }
}

/** A circuit that changed the record it was handed, which this design would drop. */
export class RecordChangedByTheCall extends Error {
  constructor(readonly circuit: string) {
    super(
      `the "${circuit}" call changed this device's record for the company, and nothing here keeps a ` +
        'record between calls, so the change would be lost. Nothing was proved or sent. The ' +
        'company\'s contract is not the one this page was built for.',
    );
    this.name = 'RecordChangedByTheCall';
  }
}

const bytesOf = (name: string, value: string): Uint8Array => {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new Error(`the ${name} this proposal was handed is not thirty-two bytes, so nothing was built.`);
  }
  return fromHex(value);
};
const digitsOf = (name: string, value: string): bigint => {
  if (typeof value !== 'string' || !DIGITS.test(value)) {
    throw new Error(`the ${name} this proposal was handed is not a whole number, so nothing was built.`);
  }
  return BigInt(value);
};

const ACCOUNT_FIELDS = ['assetBlinding', 'assetId', 'proposalSalt', 'changeAmount', 'changeBatchDigest'] as const;

/**
 * **THE RECORD FOR ONE CALL, COMPOSED NOW AND USED ONCE.**
 *
 * The signer's three come first and are refused by name if any is missing or
 * the wrong width - the scope included. For a raise the account's half is read
 * off the order, every field of it. Seating a signer and changing the threshold
 * read one account field, the salt the approved round's identity was made with,
 * and it is read off the order too. Every other account field is a refusal
 * rather than a value. The two membership-path fields are set here and from
 * nowhere else, so nothing handed in can put a path into the record.
 */
export function recordForOneCall(order: GovernedCallOrder, material: SignerMaterial): AccountPrivateState {
  const signer = signerHalfOf(material);
  if (order.circuit === 'propose') {
    const h = order.half;
    return {
      ...signer,
      assetId: bytesOf('asset', h.assetId),
      assetBlinding: bytesOf('account\'s asset blinding', h.assetBlinding),
      proposalSalt: bytesOf('proposal\'s salt', h.proposalSalt),
      changeAmount: digitsOf('change amount', h.changeAmount),
      changeBatchDigest: bytesOf('change digest', h.changeBatchDigest),
      pinnedPath: null,
    };
  }
  const record = { ...signer, pinnedPath: null } as AccountPrivateState;
  const salt = order.circuit === 'amendSigner' || order.circuit === 'setThreshold'
    ? bytesOf('proposal\'s salt', order.proposalSalt) : null;
  for (const field of ACCOUNT_FIELDS) {
    if (field === 'proposalSalt' && salt !== null) {
      Object.defineProperty(record, field, { enumerable: true, value: salt });
      continue;
    }
    Object.defineProperty(record, field, {
      enumerable: false,
      get: () => { throw new NotReadByAnApproval(field); },
    });
  }
  return record;
}

/** A threshold, as the digits it travels as, refused unless it is a whole number of at least one. */
const thresholdOf = (value: string): bigint => {
  const t = digitsOf('threshold', value);
  if (t < 1n) throw new Error('a company\'s threshold is at least one, and this one is not. Nothing was built.');
  return t;
};

/** The circuit's arguments, from the order and from nothing else. */
export function argumentsFor(order: GovernedCallOrder): unknown[] {
  if (order.circuit === 'approve') return [bytesOf('proposal\'s identity', order.proposal)];
  if (order.circuit === 'amendSigner') {
    /* Seating, never removing, and appended rather than put into a vacated slot. */
    return [bytesOf('signer\'s leaf', order.leaf), bytesOf('proposal\'s identity', order.proposal), false, false];
  }
  if (order.circuit === 'setThreshold') {
    return [thresholdOf(order.threshold), bytesOf('proposal\'s identity', order.proposal)];
  }
  if (!raisesARun(order)) {
    /*
     * The merged circuit on its governance branch: the payload is passed, the
     * run's own parts are empty, and the vault is the one no vault can equal.
     * The payload and that vault are made where the call is built, from the
     * contract's own functions, so they are not arguments this file can get wrong.
     */
    return [GOVERNANCE_PAYLOAD, ZERO_32, 0n, 0n, 0n, false, NO_VAULT];
  }
  const r = order.run;
  const payees = digitsOf('number of people paid', r.payees);
  const opensAt = digitsOf('window\'s opening', r.opensAt);
  const closesAt = digitsOf('window\'s close', r.closesAt);
  if (payees < 1n) throw new Error('a run pays at least one person, and this one names none. Nothing was built.');
  if (opensAt >= closesAt) throw new Error('this run\'s window closes before it opens. Nothing was built.');
  /* The merged circuit on its run branch: no opaque payload, and `isRun` set. */
  return [ZERO_32, bytesOf('payout root', r.root), payees, opensAt, closesAt, true, bytesOf('vault', r.vault)];
}

/** Stand-ins in a governance raise's arguments, replaced with the contract's own values before the call is built. */
const GOVERNANCE_PAYLOAD = Symbol('the governance payload');
const NO_VAULT = Symbol('no vault');

/** The payload a governance round commits to, made by the contract's own function from the change named. */
export function governancePayloadOf(deps: Pick<GovernedCallDeps, 'accountPure'>, g: GovernanceOnTheWire): Uint8Array {
  if (g.kind === 'add-signer') return deps.accountPure.signerAddPayload(bytesOf('signer\'s leaf', g.leaf));
  if (g.kind === 'threshold') return deps.accountPure.setThresholdPayload(thresholdOf(g.threshold));
  throw new Error('this proposal is neither a seat nor a threshold, so nothing was built.');
}

/** The arguments as the circuit is handed them, with the contract's own payload and no-vault in place. */
const argumentsBuilt = (deps: Pick<GovernedCallDeps, 'accountPure'>, order: GovernedCallOrder): unknown[] => {
  const args = argumentsFor(order);
  if (order.circuit !== 'propose' || raisesARun(order)) return args;
  return args.map((a) => (a === GOVERNANCE_PAYLOAD ? governancePayloadOf(deps, order.governance)
    : a === NO_VAULT ? deps.accountPure.noVault() : a));
};

/**
 * **WHY A CALL COULD NOT BE BUILT, IN THE CONTRACT'S OR THE WITNESS'S OWN
 * WORDS.** The call builder lifts a failed assertion's sentence to the top, but
 * a witness that refuses - "you are not a signer on this account" - arrives
 * wrapped as a generic failure to run the circuit, with the sentence one level
 * down. That sentence is the one a person can act on, so it is brought up.
 */
/** What each call is called in a sentence a person reads. */
const CALLED: Readonly<Record<string, string>> = {
  approve: 'approval', propose: 'proposal', amendSigner: 'seat', setThreshold: 'threshold change',
};

export class CallNotBuilt extends Error {
  constructor(readonly circuit: string, why: string, options?: { cause?: unknown }) {
    super(`this ${CALLED[circuit] ?? 'proposal'} could not be built on this device: ${why}. Nothing was proved or sent.`, options);
    this.name = 'CallNotBuilt';
  }
}

const theWitnessSaid = (circuit: string, e: unknown): unknown => {
  const outer = e as { _tag?: unknown; cause?: unknown } | null;
  const inner = outer?.cause as { message?: unknown } | undefined;
  if (outer?._tag === 'ContractRuntimeError' && inner instanceof Error && typeof inner.message === 'string' && inner.message !== '') {
    return new CallNotBuilt(circuit, inner.message, { cause: e });
  }
  return e;
};

/**
 * **A CALL IS BUILT ONLY FOR THE PROPOSAL THE SERVICE WROTE DOWN.** Its
 * identity is made here, by the contract's own functions, from what this device
 * was handed - the run or the change, and the salt - and compared with the
 * identity the service recorded. A mismatch - a salt, a window, a vault, a leaf
 * or a threshold that is not the recorded proposal's - is refused before
 * anything is built, because the chain would otherwise hold, or act on, a
 * proposal the service's record does not describe. Seating a signer and changing
 * the threshold are checked the same way: the leaf seated and the threshold set
 * must be the ones the approved round was raised for.
 */
export function refuseARaiseThatIsNotTheRecordedOne(deps: Pick<GovernedCallDeps, 'accountPure'>, order: GovernedCallOrder): void {
  if (order.circuit === 'approve' && order.of === undefined) return;
  const P = deps.accountPure;
  let made: Uint8Array;
  if (order.circuit === 'approve') {
    made = P.proposalIdOf(governancePayloadOf(deps, order.of!.governance), P.noVault(), bytesOf('proposal\'s salt', order.of!.proposalSalt));
  } else if (order.circuit === 'propose' && raisesARun(order)) {
    const [, root, payees, opensAt, closesAt, , vault] = argumentsFor(order) as [unknown, Uint8Array, bigint, bigint, bigint, unknown, Uint8Array];
    made = P.proposalIdOf(P.runPayload(root, payees, opensAt, closesAt), vault, bytesOf('proposal\'s salt', order.half.proposalSalt));
  } else if (order.circuit === 'propose') {
    made = P.proposalIdOf(governancePayloadOf(deps, order.governance), P.noVault(), bytesOf('proposal\'s salt', order.half.proposalSalt));
  } else if (order.circuit === 'amendSigner') {
    made = P.proposalIdOf(P.signerAddPayload(bytesOf('signer\'s leaf', order.leaf)), P.noVault(),
      bytesOf('proposal\'s salt', order.proposalSalt));
  } else {
    made = P.proposalIdOf(P.setThresholdPayload(thresholdOf(order.threshold)), P.noVault(),
      bytesOf('proposal\'s salt', order.proposalSalt));
  }
  const hex = Array.from(made, (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== String(order.proposal).toLowerCase()) {
    throw new Error(
      order.circuit === 'propose'
        ? 'the proposal this device was asked to raise is not the one the company wrote down: its parts and its salt '
          + 'make another identity. Nothing was built or sent. Reload the page and try again.'
        : order.circuit === 'approve'
          ? 'the proposal this device was asked to approve is not for the change asked for here. Nothing was built or '
            + 'sent. Reload the page and try again; if it happens again, do not approve it.'
          : 'the approved proposal this device was asked to act on is not for this change: the change and its salt make '
            + 'another identity. Nothing was built or sent. Reload the page and try again.');
  }
}

/** Overwrites the signer's three in a record that is finished with. */
const wipe = (record: AccountPrivateState): void => {
  for (const field of ['secretKey', 'blinding', 'scope'] as const) {
    const value = (record as unknown as Record<string, unknown>)[field];
    if (value instanceof Uint8Array) value.fill(0);
  }
};

/**
 * **ONE GOVERNED CALL, BUILT AND PROVED HERE.**
 *
 * Refuses, before anything is built, a circuit a device does not govern here
 * and a circuit that reads no witness: the second kind is open to anybody on
 * the chain and must not be given anybody's record.
 */
export async function buildGovernedCall(
  deps: GovernedCallDeps,
  input: {
    readonly account: string;
    readonly order: GovernedCallOrder;
    readonly material: SignerMaterial;
    readonly chain: AccountCallChain;
  },
): Promise<{ proven: Uint8Array }> {
  const account = String(input.account).toLowerCase();
  if (!HEX64.test(account)) {
    throw new Error('this call is not for a company account this device can name, so nothing was built.');
  }
  const circuit = input.order.circuit;
  if (!ACCOUNT_CIRCUITS_A_DEVICE_GOVERNS.includes(circuit) || CIRCUITS_THAT_READ_NO_WITNESS.has(circuit)) {
    throw new Error(`a device here raises and approves proposals, seats signers and changes the threshold, and "${String(circuit)}" is none of those. Nothing was built.`);
  }
  const args = argumentsBuilt(deps, input.order);
  refuseARaiseThatIsNotTheRecordedOne(deps, input.order);
  /*
   * Frozen, so a circuit that tried to write into the record it was handed
   * fails there rather than changing what the next check compares.
   */
  const record = Object.freeze(recordForOneCall(input.order, input.material));
  try {
    const L = deps.ledger;
    const seed = (deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32);
    const keys = L.ZswapSecretKeys.fromSeed(seed);
    const coinPublicKey = keys.coinPublicKey;
    const encryptionPublicKey = keys.encryptionPublicKey;
    seed.fill(0);
    try { keys.clear?.(); } catch { /* nothing to clear */ }
    const built = await deps.contracts.createUnprovenCallTxFromInitialStates(deps.accountZkConfig, {
      compiledContract: deps.accountCompiled,
      circuitId: circuit,
      contractAddress: account,
      coinPublicKey,
      initialContractState: deps.runtimeState.deserialize(input.chain.accountState),
      /* A raise and an approval move no coin, so the builder is given no commitment tree to read. */
      initialZswapChainState: new L.ZswapChainState(),
      ledgerParameters: L.LedgerParameters.deserialize(input.chain.parameters),
      initialPrivateState: record,
      args,
    }, encryptionPublicKey).catch((e: unknown) => { throw theWitnessSaid(circuit, e); });
    if (built?.private?.nextPrivateState !== record) throw new RecordChangedByTheCall(circuit);
    const proven = await deps.prove(built.private.unprovenTx, circuit);
    return { proven: proven.serialize() };
  } finally {
    wipe(record as AccountPrivateState);
  }
}
