/**
 * **AN APPROVED LEG'S PAYMENTS, AND WHO IT HAS PAID, MADE ON A SIGNER'S DEVICE
 * FROM THE COMPANY'S RECORDS IT OPENED.**
 *
 * What a vault is handed to pay one approved leg - every payee's leaf, nonce,
 * blinding and path - is worked out here from the leg's own record, the state
 * the founding seat signed and the proposal as this device opens it, and is
 * offered only when its leaves are the recorded ones and rebuild the identity
 * the chain opened the proposal under (`assemblePrivatePayments`). Who the leg has
 * paid is read off the account's own record of completed payments, through the
 * read this device is given, and reported against those same leaves.
 */
import { fromHex, parseCanonical, toHex, unseal, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { openRecord } from '../../../src/core/sealed-records.js';
import type { StateChange, PaymentsAmong } from '../../../src/core/ledger.js';
import type { PayrollRun, RunLeg, SealedProposal } from '../../../src/core/types.js';
import {
  assetOfLeg, legChoiceOf, legEmployees, legFieldsOf, payRecordsOf, raisedLegOf,
} from '../../../src/core/run-legs.js';
import {
  buildRetryRun, buildRun, rootOfPayments, type DetailsOfKind, type PaymentFacts,
} from '../../../src/midnight/payout-tree.js';
import { assemblePrivatePayments, type PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import { runPayments, type RunInputs, type RunPayments, type RunWindow } from '../../../src/midnight/run-status.js';
import { openedRunHere, signedStateHere, type CompanyRecordsHere } from './run-rebuilt-here.js';
import { NotMadeHere, type LegNamed } from './material-made-here.js';

/** What paying a leg is made with on this device: the vault's and the account's own circuits, and a read of the chain. */
export interface PaymentsHereDeps {
  /** The vault's two details circuits, which each payee's leaf is made with. */
  readonly detailsOf: DetailsOfKind;
  /** The account's own payload of a round and its identity, from which a round over these leaves is named. */
  readonly runPayload: (root: Uint8Array, payees: bigint, opensAt: bigint, closesAt: bigint, required: bigint) => Uint8Array;
  readonly proposalIdOf: (payload: Uint8Array, vault: Uint8Array, salt: Uint8Array) => Uint8Array;
  /** Which of these leaves the company's account records as paid, as this device read it; null when it cannot say. */
  readonly paidAmong: (leaves: readonly Hex[]) => Promise<PaymentsAmong | null>;
}

/**
 * A raised round of the company, opened here: its identity, salt and vault.
 * The approvals its run needs are not read here but from the run's own record,
 * the one the approving devices rebuild the proposal from.
 */
interface RoundHere { readonly chainId: Hex; readonly salt: Hex; readonly vault: Hex; readonly raisedAt?: string; readonly status: string }

const roundOf = async (records: CompanyRecordsHere, accountId: string, proposalId: string, viewingKey: Hex): Promise<RoundHere | null> => {
  if (records.proposals === undefined) {
    throw new NotMadeHere('This page cannot read the company\'s proposals, so it cannot make a payment here. Reload the page '
      + 'to get the current version.');
  }
  const rec: SealedProposal | undefined = (await records.proposals()).find((p) => p.id === proposalId);
  if (rec === undefined || rec.accountId !== accountId) return null;
  let envelope: { kind: string; vault: Hex; raisedAt?: string; sealedPayload: Sealed };
  let payload: { __change?: StateChange };
  try {
    envelope = openRecord('proposals', rec.accountId, rec.sealed, viewingKey);
    payload = parseCanonical(unseal(envelope.sealedPayload, viewingKey));
  } catch {
    throw new NotMadeHere('This device cannot read the company\'s record of the proposal this leg was raised as. Reload the page '
      + 'and try again.');
  }
  if (envelope.kind !== 'payroll' || payload.__change === undefined) return null;
  return {
    chainId: rec.chainId, salt: payload.__change.salt, vault: envelope.vault, status: rec.status,
    /* When the chain was first seen to hold it is kept plain on the record; a record written before that kept it sealed. */
    ...((rec.raisedAt ?? envelope.raisedAt) ? { raisedAt: (rec.raisedAt ?? envelope.raisedAt)! } : {}),
  };
};

/**
 * The identity a round over `leaves` in `window` would have, under a raised
 * round's vault and salt, at `required`: the approvals the run's record says
 * the leg or retry was raised needing.
 */
const idFromFor = (deps: PaymentsHereDeps, round: RoundHere, required: bigint, facts: readonly PaymentFacts[], leg: RunLeg) =>
  (leaves: Hex[], w: RunWindow): Hex => toHex(deps.proposalIdOf(
    deps.runPayload(fromHex(rootOfPayments(leaves, facts, assetOfLeg(leg))), BigInt(leaves.length), w.from, w.until, required),
    fromHex(round.vault), fromHex(round.salt)));

/** The leg named, its record, and the run it is on. */
const raisedLeg = async (records: CompanyRecordsHere, accountId: string, runId: string, viewingKey: Hex, which?: LegNamed) => {
  const run = await openedRunHere(records, accountId, runId, viewingKey);
  const leg = raisedLegOf(run, legChoiceOf(which ?? {}), records.registry);
  const payout = leg ? run.payout?.[leg] : undefined;
  return { run, leg, payout };
};

/** The leg built again here from its record and the state the founding seat signed. */
const builtAgain = async (records: CompanyRecordsHere, accountId: string, viewingKey: Hex, deps: PaymentsHereDeps,
  run: PayrollRun, leg: RunLeg) => {
  const payout = run.payout![leg]!;
  const state = await signedStateHere(records, accountId, viewingKey);
  return buildRun([...state.seeds], { accountId, runId: payout.runId, epoch: payout.epoch }, [...payout.facts], deps.detailsOf,
    { key: state.payKey as Hex, records: [...(payout.records ?? payRecordsOf(run, legEmployees(run, leg)))] }, assetOfLeg(leg));
};

const NOTHING_TO_PAY = 'This run has no round on the chain a vault can pay yet. It is paid once it has been raised and approved.';

/**
 * **WHAT A VAULT IS HANDED TO PAY ONE APPROVED LEG**, or, naming the proposal a
 * retry on it was raised as, that retry and nobody else. Refused unless the
 * leg built again here is the one its signers approved.
 */
export async function privatePaymentsHere(
  records: CompanyRecordsHere, accountId: string, runId: string, viewingKey: Hex, deps: PaymentsHereDeps,
  which?: LegNamed, retry?: string,
): Promise<PrivatePaymentOrderOnTheWire> {
  return (await legToPayHere(records, accountId, runId, viewingKey, deps, which, retry)).order;
}

/**
 * **ONE APPROVED LEG, OR ONE RETRY ON IT, AS THE DEVICE THAT PAYS IT OPENS
 * IT**: what the vault is handed (`privatePaymentsHere`), with the company's
 * name for the proposal it was raised as. The order carries the approvals the
 * leg or the retry was raised needing, as the run's own record holds them -
 * the ones its identity on the chain was made again with here, and the ones
 * the vault's payment and the run's charge make it again with. What a run is
 * charged to its period with, before it is paid.
 */
export async function legToPayHere(
  records: CompanyRecordsHere, accountId: string, runId: string, viewingKey: Hex, deps: PaymentsHereDeps,
  which?: LegNamed, retry?: string,
): Promise<{ readonly order: PrivatePaymentOrderOnTheWire; readonly proposalId: string }> {
  const { run, leg, payout } = await raisedLeg(records, accountId, runId, viewingKey, which);
  if (leg === null || payout === undefined) throw new NotMadeHere(NOTHING_TO_PAY);
  const entry = retry === undefined ? undefined : payout.retries?.find((r) => r.proposalId === retry);
  if (retry !== undefined && entry === undefined) {
    throw new NotMadeHere('This run records no retry raised as that proposal, so there is nothing a vault can pay against it. '
      + 'Reload the run and choose again.');
  }
  const proposalId = entry === undefined ? run.proposalIds[leg] : entry.proposalId;
  if (proposalId === undefined) throw new NotMadeHere(NOTHING_TO_PAY);
  const round = await roundOf(records, accountId, proposalId, viewingKey);
  if (round === null || round.raisedAt === undefined) throw new NotMadeHere(NOTHING_TO_PAY);
  const whole = await builtAgain(records, accountId, viewingKey, deps, run, leg);
  const shape = entry === undefined
    ? { root: payout.root, payees: payout.payees, opensAt: payout.opensAt, closesAt: payout.closesAt, vault: payout.vault }
    : { root: entry.root, payees: entry.payees, opensAt: entry.opensAt, closesAt: entry.closesAt, vault: entry.vault };
  const indices = entry === undefined ? undefined : [...entry.originalIndices];
  /* The approvals the leg, or the retry, was raised needing, as the run's own record holds them. */
  const required = (entry === undefined ? payout.required : entry.required) ?? 0n;
  /* A retry is paid over a tree of its own, of only the people it names, each at the leaf the leg gave them. */
  const leaves = indices === undefined ? [...payout.leaves] : indices.map((i) => payout.leaves[i]!);
  const facts = indices === undefined ? payout.facts : indices.map((i) => payout.facts[i]!);
  const paid = await deps.paidAmong(leaves);
  const assembled = assemblePrivatePayments({
    order: { ...legFieldsOf(leg), proposal: round.chainId, salt: round.salt, ...shape },
    leaves, window: { from: shape.opensAt, until: shape.closesAt },
    idFrom: idFromFor(deps, round, required, facts, leg),
    built: indices === undefined ? whole : buildRetryRun(whole, indices),
    facts,
    paid: paid?.known === true ? new Set(paid.paid) : null,
    ...(indices === undefined ? {} : { indices }),
  });
  if ('refusal' in assembled) throw new NotMadeHere(assembled.refusal.replace(/ Nothing was sent\.$/u, ''));
  /* The vault's payment and the run's charge each make the proposal's identity again with the approvals it was raised needing. */
  return { order: required === 0n ? assembled.order : { ...assembled.order, required: required.toString() }, proposalId };
}

/**
 * **WHO ONE RAISED LEG HAS PAID AND WHO IT STILL OWES**, over the leg's own
 * leaves and only when they rebuild the identity the chain opened its round
 * under, with every other attempt at the leg that can still pay somebody.
 */
export async function paymentViewHere(
  records: CompanyRecordsHere, accountId: string, runId: string, viewingKey: Hex, deps: PaymentsHereDeps, which?: LegNamed,
): Promise<RunPayments> {
  const { run, leg, payout } = await raisedLeg(records, accountId, runId, viewingKey, which);
  if (leg === null || payout === undefined) return runPayments(null, null);
  const own = run.proposalIds[leg] === undefined ? null : await roundOf(records, accountId, run.proposalIds[leg]!, viewingKey);
  const mayPay = (r: RoundHere | null) => r !== null && r.raisedAt !== undefined && r.status !== 'cancelled' && r.status !== 'blocked';
  const retries: NonNullable<RunInputs['retries']> = [];
  for (const r of payout.retries ?? []) {
    if (r.proposalId !== undefined && mayPay(await roundOf(records, accountId, r.proposalId, viewingKey))) {
      retries.push({ indices: [...r.originalIndices], window: { from: r.opensAt, until: r.closesAt } });
    }
  }
  const inputs: RunInputs = {
    leaves: [...payout.leaves], window: { from: payout.opensAt, until: payout.closesAt },
    ...(own !== null && own.raisedAt !== undefined ? { proposal: { id: own.chainId, idFrom: idFromFor(deps, own, payout.required ?? 0n, payout.facts, leg) } } : {}),
    ...(retries.length > 0 ? { retries } : {}),
  };
  return runPayments(inputs, await deps.paidAmong(inputs.leaves));
}
