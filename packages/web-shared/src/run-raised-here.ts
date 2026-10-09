/**
 * **ONE LEG OF A PAYROLL RUN, RAISED ON THE SIGNER'S OWN DEVICE.**
 *
 * The device reads the run from the company's records - filed by a seat it
 * believes - with the company state its founding seat signed and the people it
 * believes and would pay. It checks the leg may be raised, builds the leg's
 * payout tree itself, checks the vault's private money, writes the proposal
 * and the run as raised, signs both with this seat's filing key, and proves
 * the raise. The service files the two and relays the proven call; it is
 * given no key and builds nothing.
 */
import { assetIdBytes, assets as theAssets, sumChangeAmount, type AssetId, type LedgerForm } from '../../../src/core/assets.js';
import { randomBytes, signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import { batchDigestOf, paysCommitmentOf, sealPayrollProposal, signProposalFiling } from '../../../src/core/proposal-filing.js';
import { signRunFiling } from '../../../src/core/run-filing.js';
import {
  receiptsOf, refuseARetryOfALegNeverOnChain, refuseARetryOfNobody, refuseARunNoVaultCanPay, refuseMaterialThatIsNotThisLeg,
  refuseRetryMaterialThatIsNotItsPeople,
} from '../../../src/core/run-raising.js';
import {
  assetOfLeg, formOfLeg, legChoiceOf, legEmployees, legName, legOf, payRecordsOf, runIdForLeg, sealedRunOf,
} from '../../../src/core/run-legs.js';
import { DEVICE_RAISE_VERSION, paymentChecked, paymentsOnTheWire, type PaymentChecked } from '../../../src/core/device-raise.js';
import { refuseWhatTheVaultCannotPay } from '../../../src/core/vault-holdings.js';
import type { Employee, PayrollRun, Role, RunLeg, SealedProposal, ShieldedEntry } from '../../../src/core/types.js';
import type { buildRetryRun, buildRun, rootOfPayments, DetailsOfKind } from '../../../src/midnight/payout-tree.js';
import { currentPayoutSeed } from '../../../src/midnight/run-keys.js';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import type { OpenedRound, RaiseRunOrder } from './governed-call-builder.js';
import type { RunMadeHere } from './what-this-device-made.js';
import type { RaiseDoors, RoundOnThePage } from './governed-call-on-device.js';
import {
  checkedAgainstTheRecordsAndTheWallet, keptRunHere, payableFactsHere, signedStateHere, type CompanyRecordsHere,
} from './run-rebuilt-here.js';
import { RoundRefusedHere, refuseWhatNoRoundMay, type ReadForTheRound, type RoundToCheck } from './raise-checks-here.js';
import { policyForARunHere, type PolicyForARun } from './spending-policy-here.js';

/** Why this device did not raise a leg. Nothing was written down, built or sent. */
export class LegNotRaisedHere extends Error {
  constructor(why: string) {
    super(`${why.replace(/\.?\s*$/u, '.')} Nothing was written down or sent, and no fee was spent.`);
    this.name = 'LegNotRaisedHere';
  }
}

/** The contract's own functions a run's identity is made with, and the leaf details a payee's leaf is made with. */
interface RunIdentityDeps {
  readonly detailsOf: DetailsOfKind;
  /**
   * The payout tree a run is raised over, built with the contract's own
   * circuits (`payout-tree.ts`): handed in by whoever holds them, because the
   * page itself loads no contract.
   */
  readonly buildRun: typeof buildRun;
  readonly buildRetryRun: typeof buildRetryRun;
  readonly rootOfPayments: typeof rootOfPayments;
  readonly runPayload: (root: Uint8Array, payees: bigint, opensAt: bigint, closesAt: bigint, required: bigint) => Uint8Array;
  readonly proposalIdOf: (payload: Uint8Array, vault: Uint8Array, salt: Uint8Array) => Uint8Array;
  readonly noVault: () => Uint8Array;
}

export interface LegRaiseDoors extends RaiseDoors {
  readonly records: CompanyRecordsHere & { readonly proposals: () => Promise<readonly SealedProposal[]> };
  /** This device's seat as the company's directory names it, the key epoch now, and a fresh salt and proposal name. */
  readonly filing: { readonly seat: string; readonly keyEpoch: number; readonly salt: () => string; readonly newId: () => string };
  /** The company's account and label, which each payslip's receipt names. */
  readonly company: { readonly account: string | null; readonly label: CompanyLabel | null };
  readonly runs: RunIdentityDeps;
  readonly now?: () => Date;
}

const DIGITS = /^[0-9]+$/u;
const hex = (b: Uint8Array): Hex => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') as Hex;
const bytes = (h: string): Uint8Array => Uint8Array.from(h.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));
const ENTRY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const entryId = (): string => `ent_${Array.from(randomBytes(10), (b) => ENTRY_ALPHABET[b & 63]).join('')}`;

/** Every check, with what refused it said as the refusal. */
const raised = <T>(make: () => T): T => {
  try {
    return make();
  } catch (e) {
    if (e instanceof LegNotRaisedHere) throw e;
    throw new LegNotRaisedHere((e as Error)?.message ?? String(e));
  }
};

/**
 * The raise checks every raising and approving device runs
 * (`raise-checks-here.ts`), at this device's clock, each refusal said as this
 * raise's: among them that the leg is raised once, and that a retry is of a leg
 * that can no longer pay its people and names nobody another retry can. They
 * decide on what this raise already read (`read`), never on a second read.
 */
const checkedHere = async (doors: LegRaiseDoors, key: Hex, round: Omit<RoundToCheck, 'filedBy'>, read: ReadForTheRound): Promise<void> => {
  try {
    await refuseWhatNoRoundMay(doors.records, doors.accountId, key, {
      ...round, filedBy: signingPublicKeyOf(doors.material.signingSecret as Hex),
    }, (doors.now ?? (() => new Date()))(), read);
  } catch (e) {
    if (e instanceof RoundRefusedHere) throw new LegNotRaisedHere(e.message);
    throw e;
  }
};

/**
 * **THE APPROVALS A ROUND IS RAISED NEEDING**: what its band needs under its
 * vault's spending policy for its currency, read here the one way a policy is
 * read; none for a vault with no policy, as it always was. Where the policy
 * could not be read or will not charge the proposal, none is asked for here and
 * the raise checks refuse the proposal in their own words - on this same read of
 * the policy, which is returned with it.
 */
const approvalsItsBandNeeds = async (
  doors: LegRaiseDoors, key: Hex, round: { vault: Hex; asset: AssetId; total: bigint; window: { opensAt: bigint; closesAt: bigint } },
): Promise<{ readonly required: string; readonly policy: PolicyForARun }> => {
  const policy = await policyForARunHere({ records: doors.records, accountId: doors.accountId, viewingKey: key }, {
    vault: round.vault, asset: round.asset, total: round.total, ...round.window,
  });
  return { required: policy.state === 'set' && policy.required !== null ? policy.required.toString() : '0', policy };
};

/**
 * **RAISES ONE LEG OF A RUN FROM THIS DEVICE.** `vault`, `opensAt` and
 * `closesAt` are what the person chose: the vault that pays it, and the window
 * in seconds since the Unix epoch. Refused, with nothing written down, when the
 * leg may not be raised, when anybody on it is somebody this device would not
 * pay, when the company's policy stops it, when the vault cannot pay it, or
 * when the chain holds what the company's records cannot account for.
 */
export async function raiseLegHere(
  doors: LegRaiseDoors,
  input: { runId: string; viewingKey: string; asset?: string; form?: LedgerForm; vault: string; opensAt: string; closesAt: string },
): Promise<RoundOnThePage> {
  const key = input.viewingKey as Hex;
  const { records, accountId, service } = doors;
  const registry = doors.assets ?? records.registry ?? theAssets;
  if (!DIGITS.test(input.opensAt) || !DIGITS.test(input.closesAt)) {
    throw new LegNotRaisedHere('a window bound is whole seconds since the Unix epoch');
  }
  if (!service.file) throw new LegNotRaisedHere('This page cannot write proposals down. Reload the page to get the current version');
  const window = { opensAt: BigInt(input.opensAt), closesAt: BigInt(input.closesAt) };
  const vault = input.vault.toLowerCase() as Hex;
  const now = (doors.now ?? (() => new Date()))();

  const { run } = await keptRunHere(records, accountId, input.runId, key);
  if (run.status !== 'draft' && run.status !== 'proposed') throw new LegNotRaisedHere(`this run is ${run.status}`);
  const leg = raised(() => legOf(run, legChoiceOf(input), registry));
  const paid = legEmployees(run, leg);
  const facts = await payableFactsHere(records, paid, 'Leave this run unraised until their record is put right.',
    'This device will not raise a run it would not pay.');

  const state = await signedStateHere(records, accountId, key);
  const asset = assetOfLeg(leg) as AssetId;
  const identity = { accountId, runId: runIdForLeg(run, leg), epoch: currentPayoutSeed([...state.seeds]).epoch };
  const payRecords = payRecordsOf(run, paid);
  const built = raised(() => doors.runs.buildRun([...state.seeds], identity, [...facts], doors.runs.detailsOf,
    { key: state.payKey as Hex, records: payRecords }, asset));
  const root = built.tree.root;
  const payees = built.tree.payees;
  raised(() => refuseARunNoVaultCanPay({ root, vault, ...window }, hex(doors.runs.noVault()), BigInt(Math.floor(now.getTime() / 1000))));
  raised(() => refuseMaterialThatIsNotThisLeg(run, leg, paid, { run: { root, payees }, leaves: built.tree.leaves, facts, identity },
    doors.runs.rootOfPayments as never, registry));

  /* What the raise is decided on is read once: the company's proposals, and the vault's policy for this proposal. */
  const proposals = await records.proposals();
  const { required, policy } = await approvalsItsBandNeeds(doors, key, { vault, asset, total: facts.reduce((a, f) => a + f.amount, 0n), window });
  const made = await checkedAgainstTheRecordsAndTheWallet(records, accountId, run, key, {
    kind: 'payroll', seeds: state.seeds, payKey: state.payKey, identity, facts, records: payRecords, asset,
    opensAt: input.opensAt, closesAt: input.closesAt, required,
  }, proposals);
  await checkedHere(doors, key, { run, leg, made, vault }, { proposals, spendingPolicy: policy });

  const role = await roleOfThisSeat(doors);
  const total = facts.reduce((a, f) => a + f.amount, 0n);
  doors.progress?.('checking-the-vault');
  const payments = facts.map(paymentChecked);
  await refuseWhatTheVaultCannotPay(doors.holdings, {
    vault, asset: registry.require(asset), total, payees, payments: payments.map((p) => ({ payee: { kind: p.kind }, token: p.token, amount: p.amount })),
  }, ['shielded']);

  return writtenProvedAndFiled(doors, key, {
    run, leg, entries: paid.map((e) => ({ e, at: now.toISOString() })), root, payees, window, vault, role, asset,
    summary: `Payroll ${run.period}, ${paid.length} recipients`, payments,
    raisedRun: (proposalId) => ({
      ...run,
      payslips: receiptsOf(run, [...state.seeds], state.payKey as Hex, {
        leg, leaves: built.tree.leaves, closesAt: window.closesAt, company: doors.company.account, identity, records: payRecords,
      }, { company: doors.company.account, label: doors.company.label }),
      payout: {
        ...(run.payout ?? {}),
        [leg]: {
          root, payees, opensAt: window.opensAt, closesAt: window.closesAt, vault, required: BigInt(made.required),
          leaves: built.tree.leaves, facts: [...facts],
          records: payRecords, runId: identity.runId, epoch: identity.epoch, company: doors.company.account,
        },
      },
      status: 'proposed',
      proposalIds: { ...run.proposalIds, [leg]: proposalId },
    }),
    made,
    assetBlinding: state.assetBlinding,
  });
}

/** The role this device's seat holds, as the company's directory reads it, written on the proposal as its raiser's. */
const roleOfThisSeat = async (doors: LegRaiseDoors): Promise<Role | undefined> =>
  ((await doors.records.directory()).dir.seats.find((s) => s.seat === doors.filing.seat)?.role ?? undefined) as Role | undefined;

/**
 * **WHAT EVERY RAISE FROM THIS DEVICE ENDS WITH**: the proposal written and
 * sealed, the run as raised, both signed by this seat; the raise proved, its
 * run built again where it is proved and checked against the chain; and the
 * three filed and relayed in one request.
 */
async function writtenProvedAndFiled(doors: LegRaiseDoors, key: Hex, r: {
  readonly run: PayrollRun; readonly leg: RunLeg; readonly entries: ReadonlyArray<{ readonly e: Employee; readonly at: string }>;
  readonly root: Hex; readonly payees: bigint; readonly window: { readonly opensAt: bigint; readonly closesAt: bigint };
  readonly vault: Hex; readonly role: Role | undefined; readonly asset: AssetId; readonly summary: string;
  readonly payments: ReadonlyArray<ReturnType<typeof paymentChecked>>;
  readonly retry?: readonly number[];
  readonly raisedRun: (proposalId: string) => PayrollRun;
  /** The proposal as made here, with what it was checked against before anything was written down. */
  readonly made: RunMadeHere;
  readonly assetBlinding: string;
}): Promise<RoundOnThePage> {
  const { accountId, service } = doors;
  doors.progress?.('writing-down');
  const entries: ShieldedEntry[] = r.entries.map(({ e, at }) => ({
    id: entryId(), kind: 'payroll', asset: e.asset, amount: e.amount, counterparty: e.name, memo: `${r.run.period} salary`,
    at, runId: r.run.id, recipientId: e.id,
  }));
  const salt = doors.filing.salt().toLowerCase() as Hex;
  const change = { asset: r.asset, amount: sumChangeAmount(entries.map((e) => e.amount), 'this run\'s change'), batchDigest: batchDigestOf(entries), salt };
  /* The approvals the run was made needing, which its band under its vault's spending policy may require, bound into its identity. */
  const required = r.made.required;
  if (!DIGITS.test(required)) throw new LegNotRaisedHere('the approvals this run needs are not a whole number');
  const digest = hex(doors.runs.runPayload(bytes(r.root), r.payees, r.window.opensAt, r.window.closesAt, BigInt(required)));
  const chainId = hex(doors.runs.proposalIdOf(bytes(digest), bytes(r.vault), bytes(salt)));
  const proposalId = doors.filing.newId();
  const createdAt = (doors.now ?? (() => new Date()))().toISOString();
  const pays = { vault: r.vault, asset: r.asset, payments: paymentsOnTheWire(r.payments as ReadonlyArray<PaymentChecked<'shielded' | 'unshielded'>>) };
  const proposal = signProposalFiling(accountId, {
    id: proposalId, digest, chainId, keyEpoch: doors.filing.keyEpoch, createdAt, pays: paysCommitmentOf(pays, salt),
    sealed: sealPayrollProposal({
      accountId, viewingKey: key, vault: r.vault, summary: r.summary,
      payload: { runId: r.run.id, form: formOfLeg(r.leg), entries, ...(r.retry === undefined ? {} : { retry: [...r.retry] }) }, change,
      /*
       * The approvals bound into its identity, sealed beside its change for the
       * service's own reading of the run; a device reads them from the run's
       * record, written below from the same value.
       */
      required: BigInt(required),
      proposedBy: doors.filing.seat, ...(r.role === undefined ? {} : { proposerRole: r.role }),
    }),
  }, doors.material.signingSecret as Hex);
  const runFiling = signRunFiling(accountId, sealedRunOf(r.raisedRun(proposalId), key, doors.filing.keyEpoch), doors.material.signingSecret as Hex);
  /* The account's own name for the asset, which is what the asset witness answers with. */
  const named = { assetId: assetIdBytes(r.asset) };
  const opened: OpenedRound = {
    chainId, digest, vault: r.vault, salt, summary: r.summary,
    half: { assetId: hex(named.assetId), changeAmount: String(change.amount), changeBatchDigest: change.batchDigest },
    made: r.made,
  };
  const order: RaiseRunOrder = {
    circuit: 'propose',
    run: {
      root: r.root, payees: String(r.payees), opensAt: String(r.window.opensAt), closesAt: String(r.window.closesAt), vault: r.vault, required,
    },
    half: {
      assetId: opened.half!.assetId, assetBlinding: r.assetBlinding, proposalSalt: salt,
      changeAmount: opened.half!.changeAmount, changeBatchDigest: opened.half!.changeBatchDigest,
    },
    proposal: chainId,
  };
  doors.progress?.('reading-the-chain');
  const chain = await service.callState(accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({ account: chain.account, material: doors.material, chain, opened, order });
  doors.progress?.('sending');
  return service.file!(accountId, {
    proposal, tx, version: DEVICE_RAISE_VERSION, salt, run: runFiling, pays,
  });
}

/**
 * **A RETRY OF SOME OF A LEG'S PEOPLE, RAISED FROM THIS DEVICE**, over a tree
 * of its own of only the people it names, each at the leaf the leg gave them.
 * `indices` are their positions in the leg as it was raised. Refused, with
 * nothing written down, when the leg has no round the chain was seen to hold,
 * when the retry names nobody or somebody twice, when anybody it names is
 * somebody the run was told not to pay or something else can still pay them,
 * when the leg's records do not build its leaves again here, and for every
 * reason a leg's raise is refused.
 */
export async function raiseRetryHere(
  doors: LegRaiseDoors,
  input: {
    runId: string; viewingKey: string; asset?: string; form?: LedgerForm; indices: readonly number[];
    vault: string; opensAt: string; closesAt: string;
  },
): Promise<RoundOnThePage> {
  const key = input.viewingKey as Hex;
  const { records, accountId, service } = doors;
  const registry = doors.assets ?? records.registry ?? theAssets;
  if (!DIGITS.test(input.opensAt) || !DIGITS.test(input.closesAt)) {
    throw new LegNotRaisedHere('a window bound is whole seconds since the Unix epoch');
  }
  if (!service.file) throw new LegNotRaisedHere('This page cannot write proposals down. Reload the page to get the current version');
  const window = { opensAt: BigInt(input.opensAt), closesAt: BigInt(input.closesAt) };
  const vault = input.vault.toLowerCase() as Hex;
  const now = (doors.now ?? (() => new Date()))();
  const indices = [...input.indices];

  const { run } = await keptRunHere(records, accountId, input.runId, key);
  const leg = raised(() => legOf(run, legChoiceOf(input), registry));
  /* What the retry is decided on is read once: every refusal below, and the raise checks, judge this one read of the proposals. */
  const proposals = await records.proposals();
  const legRound = run.payout?.[leg] === undefined ? undefined : proposals.find((p) => p.id === run.proposalIds[leg]);
  /* Before anything is built from the leg's record; the raise checks below judge it again, as every approver does. */
  raised(() => refuseARetryOfALegNeverOnChain(run, leg, legRound, registry));
  const recorded = run.payout![leg]!;
  raised(() => refuseARetryOfNobody(run, leg, recorded.leaves.length, indices, registry));
  /* A retry of exactly these people written down and not yet seen on the chain is sent as itself, not raised again. */
  const unsent = (recorded.retries ?? []).find((r) => r.proposalId !== undefined
    && r.originalIndices.length === indices.length && r.originalIndices.every((i, at) => i === indices[at])
    && proposals.some((p) => p.id === r.proposalId && p.status === 'open' && !p.raisedAt));
  if (unsent !== undefined) {
    throw new LegNotRaisedHere(`a retry of these people is already written down, as ${unsent.proposalId}, and has not reached the `
      + 'chain. Send that one, or withdraw it first');
  }
  const onTheLeg = legEmployees(run, leg);
  if (onTheLeg.length !== recorded.leaves.length) {
    throw new LegNotRaisedHere(`the ${legName(leg, registry)} leg of run ${run.id} lists ${onTheLeg.length} people and was raised `
      + `over ${recorded.leaves.length} leaves, so which person each leaf belongs to cannot be said`);
  }
  /* The leg built again from its own record; whether this device would pay the people it names is a raise check, below. */
  const state = await signedStateHere(records, accountId, key);
  const asset = assetOfLeg(leg) as AssetId;
  const identity = { accountId, runId: recorded.runId, epoch: recorded.epoch };
  const payRecords = recorded.records ?? payRecordsOf(run, onTheLeg);
  const whole = raised(() => doors.runs.buildRun([...state.seeds], identity, [...recorded.facts], doors.runs.detailsOf,
    { key: state.payKey as Hex, records: [...payRecords] }, asset));
  if (whole.tree.leaves.some((l, i) => l.toLowerCase() !== String(recorded.leaves[i]).toLowerCase())) {
    throw new LegNotRaisedHere(`the ${legName(leg, registry)} leg of run ${run.id} does not build its own leaves again from its record `
      + 'here, so a retry built from it would pay these people at other leaves, which the chain does not refuse');
  }
  const retry = raised(() => doors.runs.buildRetryRun(whole, indices));
  const root = retry.tree.root;
  const payees = retry.tree.payees;
  raised(() => refuseARunNoVaultCanPay({ root, vault, ...window }, hex(doors.runs.noVault()), BigInt(Math.floor(now.getTime() / 1000))));
  raised(() => refuseRetryMaterialThatIsNotItsPeople(run, leg, indices, { run: { root, payees }, leaves: retry.tree.leaves, identity },
    doors.runs.rootOfPayments as never));

  const { required, policy } = await approvalsItsBandNeeds(doors, key, { vault, asset, total: retry.facts.reduce((a, f) => a + f.amount, 0n), window });
  const made = await checkedAgainstTheRecordsAndTheWallet(records, accountId, run, key, {
    kind: 'payroll', seeds: state.seeds, payKey: state.payKey, identity, facts: recorded.facts, records: payRecords, asset,
    opensAt: input.opensAt, closesAt: input.closesAt, required, retry: indices,
  }, proposals);
  await checkedHere(doors, key, { run, leg, made, vault }, { proposals, spendingPolicy: policy });

  const role = await roleOfThisSeat(doors);
  const facts = retry.facts;
  const total = facts.reduce((a, f) => a + f.amount, 0n);

  doors.progress?.('checking-the-vault');
  const payments = facts.map(paymentChecked);
  await refuseWhatTheVaultCannotPay(doors.holdings, {
    vault, asset: registry.require(asset), total, payees, payments: payments.map((p) => ({ payee: { kind: p.kind }, token: p.token, amount: p.amount })),
  }, ['shielded']);

  const at = now.toISOString();
  return writtenProvedAndFiled(doors, key, {
    run, leg, entries: indices.map((i) => ({ e: onTheLeg[i]!, at })), root, payees, window, vault, role, asset,
    summary: `Payroll ${run.period}, retry for ${indices.length} recipients`, payments, retry: indices,
    raisedRun: (proposalId) => {
      const withRetry: PayrollRun = {
        ...run,
        payout: {
          ...run.payout!,
          [leg]: {
            ...recorded,
            retries: [...(recorded.retries ?? []), {
              originalIndices: [...indices], root, payees, opensAt: window.opensAt, closesAt: window.closesAt, vault,
              required: BigInt(made.required), proposalId, proposedBy: doors.filing.seat, at,
            }],
          },
        },
      };
      return { ...withRetry, payslips: receiptsOf(withRetry, [...state.seeds], state.payKey as Hex, undefined, { company: doors.company.account, label: doors.company.label }) };
    },
    made,
    assetBlinding: state.assetBlinding,
  });
}
