/**
 * **AN APPROVED RUN CHARGED TO ITS VAULT'S PERIOD, BUILT AND PROVED ON A
 * SIGNER'S DEVICE, AGAINST THE PERIOD'S RUNNING TOTAL WORKED OUT AGAIN HERE.**
 *
 * A vault under a spending policy pays a run only once the run is charged to
 * the period its window lies in (`clearRun`). The chain keeps, per period, a
 * commitment to what the vault has been charged in it, and a mark under every
 * run's root it charged. It never keeps the total itself, and no device keeps
 * it either: the total is worked out again every time it is needed, from what
 * the chain marks charged and what the company's records say each run paid,
 * and it is taken only when it opens the commitment the chain holds.
 *
 * **WHAT IS READ, AND FROM WHERE.** The account's state is the one this device
 * read at one block, at the indexer the person's own wallet names - the same
 * state the charge is built on, so the total and the charge can never disagree
 * about the chain. The runs are the company's own records, opened on the
 * device; each run's total is made again here from its leaves and amounts and
 * kept only where it makes the root the record names. Every key is the
 * contract's own function, called here and never written a second way.
 *
 * Nothing here can make the chain believe a wrong total: the total is checked
 * against the chain's commitment here, and again by the chain itself.
 */
import type { AccountPrivateState, PolicyOpening } from '../../../contracts/src/witnesses.js';
import { fromHex } from '../../../src/core/crypto.js';
import { sumTreeOfLeaves } from '../../../src/midnight/payout-tree.js';
import { periodOf, policyOpeningFromWire, type PolicyOpeningOnTheWire } from '../../../src/midnight/spending-policy-record.js';
import type { AccountCallChain, GovernedCallDeps } from './governed-call-builder.js';

const HEX64 = /^[0-9a-f]{64}$/u;
const DIGITS = /^[0-9]+$/u;

/** A run of the company's, as its record names it: its root, and the leaves and amounts of its tree, in the tree's order. */
export interface RunTreeOnTheWire {
  readonly root: string;
  readonly leaves: readonly string[];
  /** Each leaf's amount, in the asset's smallest unit, as decimal digits. */
  readonly amounts: readonly string[];
}

/** The approved run to charge, as the paying device opened it from the company's records. */
export interface RunToChargeOnTheWire extends RunTreeOnTheWire {
  /** Its identity on the chain. */
  readonly proposal: string;
  readonly vault: string;
  readonly salt: string;
  /** The approvals it was raised needing, as decimal digits. */
  readonly required: string;
  /** Its window, in seconds since the Unix epoch, as decimal digits. */
  readonly opensAt: string;
  readonly closesAt: string;
  /** The token it pays, and the account's blinding the token's key is made with. */
  readonly asset: string;
  readonly assetBlinding: string;
  /** The opening of its vault's policy for that token, opened on this device. */
  readonly policy: PolicyOpeningOnTheWire;
}

/** What the period's running total is worked out for: a vault's policy for one token, one period, and the company's runs. */
export interface PeriodTotalAskOnTheWire {
  readonly vault: string;
  readonly asset: string;
  readonly assetBlinding: string;
  readonly policy: PolicyOpeningOnTheWire;
  /** The period, counted from the policy's first, as decimal digits. */
  readonly period: string;
  /** Every run of the company's that may have been charged to this vault and token: what the total is summed over. */
  readonly runs: readonly RunTreeOnTheWire[];
}

/** Why this device did not charge a run, or could not say what a period has been charged. Nothing was sent. */
class ChargeNotBuilt extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(`${why.replace(/\.?\s*$/u, '.')} Nothing was proved or sent.`, options);
    this.name = 'ChargeNotBuilt';
  }
}

/** The account's own functions the charge and the total are made with. */
type ChargePure = GovernedCallDeps['accountPure'] & {
  assetKeyOf(asset: Uint8Array, blinding: Uint8Array): Uint8Array;
  policyKeyOf(vault: Uint8Array, assetKey: Uint8Array): Uint8Array;
  policyCommitmentOf(policy: PolicyOpening): Uint8Array;
  periodKeyOf(policyKey: Uint8Array, commitment: Uint8Array, period: bigint): Uint8Array;
  periodBlindingOf(blinding: Uint8Array, period: bigint): Uint8Array;
  periodTotalOf(total: bigint, blinding: Uint8Array): Uint8Array;
  chargedKeyOf(periodKey: Uint8Array, root: Uint8Array): Uint8Array;
  clearedMark(): Uint8Array;
};

const CHARGE_FUNCTIONS = [
  'assetKeyOf', 'policyKeyOf', 'policyCommitmentOf', 'periodKeyOf', 'periodBlindingOf', 'periodTotalOf', 'chargedKeyOf', 'clearedMark',
] as const;

const pureOf = (deps: Pick<GovernedCallDeps, 'accountPure'>): ChargePure => {
  const P = deps.accountPure as Partial<ChargePure>;
  if (CHARGE_FUNCTIONS.some((f) => typeof P[f] !== 'function')) {
    throw new ChargeNotBuilt('this device was not given the account\'s functions for charging a run to its period');
  }
  return P as ChargePure;
};

/** The account's state, as its own ledger reads it: the two maps a charge reads. */
interface ChargeLedgerView {
  readonly openProposals: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): Uint8Array };
  readonly signerRoles: { member(key: Uint8Array): boolean; lookup(key: Uint8Array): Uint8Array };
}

const viewOf = (deps: Pick<GovernedCallDeps, 'runtimeState' | 'accountLedger'>, accountState: Uint8Array): ChargeLedgerView => {
  if (deps.accountLedger === undefined) {
    throw new ChargeNotBuilt('this device was not given the account\'s reader, so it cannot read what the chain holds');
  }
  return deps.accountLedger((deps.runtimeState.deserialize(accountState) as { data: unknown }).data) as ChargeLedgerView;
};

const bytesOf = (name: string, value: string): Uint8Array => {
  if (typeof value !== 'string' || !HEX64.test(value)) throw new ChargeNotBuilt(`the ${name} this device was handed is not thirty-two bytes`);
  return fromHex(value);
};
const digitsOf = (name: string, value: string): bigint => {
  if (typeof value !== 'string' || !DIGITS.test(value)) throw new ChargeNotBuilt(`the ${name} this device was handed is not a whole number`);
  return BigInt(value);
};
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A run's tree made again here from its leaves and amounts in `asset`: its
 * total and top node, or null when they do not make the root its record names.
 */
const treeOf = (run: RunTreeOnTheWire, asset: string): { root: string; total: bigint; top: bigint } | null => {
  if (!Array.isArray(run.leaves) || !Array.isArray(run.amounts) || run.leaves.length === 0
    || run.leaves.length !== run.amounts.length || !run.leaves.every((l) => HEX64.test(String(l)))
    || !run.amounts.every((a) => DIGITS.test(String(a))) || !HEX64.test(String(run.root))) return null;
  try {
    const tree = sumTreeOfLeaves(run.leaves.map((l) => l as `${string}`) as never, run.amounts.map((a) => BigInt(a)), asset as never);
    if (tree.root.toLowerCase() !== run.root.toLowerCase()) return null;
    return { root: tree.root.toLowerCase(), total: tree.total, top: tree.top as unknown as bigint };
  } catch {
    return null;
  }
};

/** Where the chain keeps a vault's policy for one token and one period's running total, made by the contract's own functions. */
interface PeriodKeys { readonly policyKey: Uint8Array; readonly commitment: Uint8Array; readonly periodKey: Uint8Array }

/**
 * **THE PERIOD'S RUNNING TOTAL, WORKED OUT AGAIN FROM THE CHAIN AND THE
 * COMPANY'S RECORDS.** The sum of the totals of the distinct runs whose roots
 * the chain marks charged in this period - whatever their proposals' status
 * now, as the chain counts them - taken only when it opens the
 * commitment the chain holds for the period, or is nothing when the chain
 * holds none. Refused when the chain holds no policy for this vault and token,
 * holds another policy than the one opened here, or holds a total the
 * company's records do not account for.
 */
function periodTotalIn(
  deps: Pick<GovernedCallDeps, 'accountPure'>, view: ChargeLedgerView, ask: PeriodTotalAskOnTheWire,
): { readonly spent: bigint; readonly keys: PeriodKeys; readonly policy: PolicyOpening; readonly period: bigint } {
  const P = pureOf(deps);
  const policy = policyOpeningFromWire(ask.policy);
  const period = digitsOf('period', ask.period);
  const asset = String(ask.asset).toLowerCase();
  const assetKey = P.assetKeyOf(bytesOf('currency', asset), bytesOf('account\'s asset blinding', String(ask.assetBlinding).toLowerCase()));
  const policyKey = P.policyKeyOf(bytesOf('vault', String(ask.vault).toLowerCase()), assetKey);
  if (!view.signerRoles.member(policyKey)) {
    throw new ChargeNotBuilt('the chain holds no spending policy for this vault in the currency this run pays in, so there is no '
      + 'period to charge it to. Set a policy for this currency first');
  }
  const commitment = view.signerRoles.lookup(policyKey);
  if (!same(commitment, P.policyCommitmentOf(policy))) {
    throw new ChargeNotBuilt('the policy this device opened is not the one the chain holds for this vault and currency. Reload the '
      + 'page to get the current policy and try again');
  }
  const periodKey = P.periodKeyOf(policyKey, commitment, period);
  const counted = new Set<string>();
  let spent = 0n;
  for (const run of ask.runs) {
    const tree = treeOf(run, asset);
    if (tree === null || counted.has(tree.root)) continue;
    if (!view.signerRoles.member(P.chargedKeyOf(periodKey, fromHex(tree.root)))) continue;
    counted.add(tree.root);
    spent += tree.total;
  }
  const keys = { policyKey, commitment, periodKey };
  if (!view.signerRoles.member(periodKey)) {
    if (spent !== 0n) throw new ChargeNotBuilt('the chain marks runs charged to this period and holds no total for it');
    return { spent, keys, policy, period };
  }
  if (!same(view.signerRoles.lookup(periodKey), P.periodTotalOf(spent, P.periodBlindingOf(policy.blinding, period)))) {
    throw new ChargeNotBuilt('the company\'s records do not account for everything the chain has charged to this vault in this '
      + 'period, so this device cannot say what the period has been charged. Reload the page and try again; if it happens '
      + 'again, a run charged to this period is missing from the company\'s records');
  }
  return { spent, keys, policy, period };
}

/**
 * Where the chain holds a run's proposal: open and charged to its period,
 * open and not charged yet, or not open at all.
 */
export type RunChargeStanding = 'charged' | 'open' | 'not-open';

const standingIn = (P: ChargePure, view: ChargeLedgerView, id: Uint8Array): RunChargeStanding => {
  if (!view.openProposals.member(id)) return 'not-open';
  return same(view.openProposals.lookup(id), P.clearedMark()) ? 'charged' : 'open';
};

/**
 * **WHETHER THE CHAIN HOLDS A RUN AS CHARGED**, read from one block's state:
 * what a device that relayed a charge waits on before it pays the run.
 */
export function runChargeStandingOf(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'runtimeState' | 'accountLedger'>,
  input: { readonly accountState: Uint8Array; readonly proposal: string },
): RunChargeStanding {
  return standingIn(pureOf(deps), viewOf(deps, input.accountState),
    bytesOf('proposal\'s identity', String(input.proposal).toLowerCase()));
}

/** **WHAT A VAULT HAS BEEN CHARGED IN ONE PERIOD UNDER ITS POLICY FOR ONE TOKEN**, worked out again from one block's state. */
export function periodTotalOf(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'runtimeState' | 'accountLedger'>,
  input: { readonly accountState: Uint8Array; readonly ask: PeriodTotalAskOnTheWire },
): bigint {
  return periodTotalIn(deps, viewOf(deps, input.accountState), input.ask).spent;
}

/**
 * The record for one charge, composed now and used once: the token, the
 * account's blinding, the policy's opening and the period's running total.
 * The charge reads nothing else, and any other field it read would be a
 * refusal rather than a value.
 */
const recordForACharge = (fields: Pick<AccountPrivateState, 'assetId' | 'assetBlinding' | 'policy' | 'periodSpent'>): AccountPrivateState => {
  const record = {} as AccountPrivateState;
  for (const [field, value] of Object.entries(fields)) Object.defineProperty(record, field, { enumerable: true, value });
  for (const field of ['secretKey', 'blinding', 'scope', 'rights', 'runOpenings', 'proposalSalt', 'changeAmount', 'changeBatchDigest', 'pinnedPath', 'pinAnyLeaf']) {
    Object.defineProperty(record, field, {
      enumerable: false,
      get: () => { throw new ChargeNotBuilt(`charging a run read "${field}" from this device, and a charge has never needed it`); },
    });
  }
  return Object.freeze(record);
};

/**
 * What the contract said when it refused the charge: the words of the
 * assertion that failed, found anywhere along the error's causes, or else the
 * error's own message.
 */
const whatTheContractSaid = (e: unknown): string => {
  for (let x = e as { message?: unknown; cause?: unknown } | null | undefined, depth = 0; x != null && depth < 8; x = x.cause as typeof x, depth += 1) {
    const m = typeof x.message === 'string' ? /^failed assert: (.+)$/su.exec(x.message) : null;
    if (m !== null) return m[1]!;
  }
  return String((e as { message?: unknown } | null)?.message ?? e);
};

/** What charging a run did: the proven charge, or null when the chain already holds the run as charged; and the period's total before it. */
interface ChargeBuilt {
  readonly proven: Uint8Array | null;
  readonly spent: bigint | null;
}

/**
 * **ONE APPROVED RUN CHARGED TO ITS PERIOD, BUILT AND PROVED HERE.** Refused
 * before anything is built when the run is not the proposal its identity
 * names, its window lies in no single period, or the period's total cannot be
 * worked out; built against the period's total worked out from the same
 * block's state. A run the chain already holds as charged is not charged
 * again, and nothing is built. The chain's own refusals - approvals short of
 * the bar, a total past the period's limit or above the run's band - stop the
 * build here, before anything is sent.
 */
export async function buildClearRun(
  deps: GovernedCallDeps,
  input: {
    readonly account: string; readonly run: RunToChargeOnTheWire; readonly runs: readonly RunTreeOnTheWire[];
    readonly chain: AccountCallChain;
  },
): Promise<ChargeBuilt> {
  const account = String(input.account).toLowerCase();
  if (!HEX64.test(account)) throw new ChargeNotBuilt('this charge is not for a company account this device can name');
  const r = input.run;
  const asset = String(r.asset).toLowerCase();
  const vault = String(r.vault).toLowerCase();
  const window = { opensAt: digitsOf('window\'s opening', r.opensAt), closesAt: digitsOf('window\'s closing', r.closesAt) };
  const required = digitsOf('approvals needed', r.required);
  const tree = treeOf(r, asset);
  if (tree === null) throw new ChargeNotBuilt('this run\'s leaves and amounts do not make the root its record names');
  const id = bytesOf('proposal\'s identity', String(r.proposal).toLowerCase());
  const payees = BigInt(r.leaves.length);
  const made = deps.accountPure.proposalIdOf(
    deps.accountPure.runPayload(fromHex(tree.root), payees, window.opensAt, window.closesAt, required),
    bytesOf('vault', vault), bytesOf('proposal\'s salt', String(r.salt).toLowerCase()));
  if (!same(made, id)) {
    throw new ChargeNotBuilt('this run, its window, its vault or the approvals it needs are not the ones its proposal was raised '
      + 'with. Reload the page and try again; if it happens again, do not pay it');
  }
  const opening = policyOpeningFromWire(r.policy);
  const period = periodOf(opening, window);
  if (period === null) {
    throw new ChargeNotBuilt('this run\'s window does not lie inside one period of its vault\'s spending policy, so it cannot be '
      + 'charged; raise it again inside one period');
  }
  const P = pureOf(deps);
  const view = viewOf(deps, input.chain.accountState);
  const standing = standingIn(P, view, id);
  if (standing === 'not-open') {
    throw new ChargeNotBuilt('the chain holds no open proposal for this run, so there is nothing to charge');
  }
  if (standing === 'charged') return { proven: null, spent: null };
  const { spent } = periodTotalIn(deps, view, {
    vault, asset, assetBlinding: r.assetBlinding, policy: r.policy, period: period.toString(), runs: input.runs,
  });
  const record = recordForACharge({
    assetId: bytesOf('currency', asset), assetBlinding: bytesOf('account\'s asset blinding', String(r.assetBlinding).toLowerCase()),
    policy: opening, periodSpent: spent,
  });
  const L = deps.ledger;
  const seed = (deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32);
  const keys = L.ZswapSecretKeys.fromSeed(seed);
  const coinPublicKey = keys.coinPublicKey;
  const encryptionPublicKey = keys.encryptionPublicKey;
  seed.fill(0);
  try { keys.clear?.(); } catch { /* nothing to clear */ }
  let built: any;
  try {
    built = await deps.contracts.createUnprovenCallTxFromInitialStates(deps.accountZkConfig, {
      compiledContract: deps.accountCompiled,
      circuitId: 'clearRun',
      contractAddress: account,
      coinPublicKey,
      initialContractState: deps.runtimeState.deserialize(input.chain.accountState),
      /* A charge moves no coin, so the builder is given no commitment tree to read. */
      initialZswapChainState: new L.ZswapChainState(),
      ledgerParameters: L.LedgerParameters.deserialize(input.chain.parameters),
      initialPrivateState: record,
      args: [id, fromHex(vault), fromHex(tree.root), payees, window.opensAt, window.closesAt, required,
        fromHex(String(r.salt).toLowerCase()), tree.top, tree.total, period],
    }, encryptionPublicKey);
  } catch (e) {
    if (e instanceof ChargeNotBuilt) throw e;
    throw new ChargeNotBuilt(`this run could not be charged to its period: ${whatTheContractSaid(e)}`, { cause: e });
  }
  if (built?.private?.nextPrivateState !== record) {
    throw new ChargeNotBuilt('the charge changed this device\'s record for the company, and nothing here keeps a record between calls');
  }
  const proven = await deps.prove(built.private.unprovenTx, 'clearRun');
  return { proven: proven.serialize(), spent };
}
