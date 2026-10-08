/**
 * **WHAT A SIGNER'S DEVICE BUILDS A RAISE, A RETRY OR A SEAT FROM, MADE HERE
 * FROM THE COMPANY'S RECORDS IT OPENED.**
 *
 * Nothing in this file asks the company's service for anything but its sealed
 * records. Each answer is worked out on this device from the records it opened
 * with the viewing key it holds:
 *
 *   the legs of a run    one per token and form, each with who is on it, its
 *                        total and the proposal it was raised as;
 *   a leg's payments     what raising it will ask its vault to pay: the
 *                        payments written down when it was raised, or, for a
 *                        leg not yet raised, each person's payment worked out
 *                        from the people this device believes and would pay;
 *   a retry's payments   the leg's recorded payments for exactly the people it
 *                        names, in the order it names them;
 *   a raise's order      the run as the leg's own record holds it and the
 *                        account's half of the call from the proposal's sealed
 *                        payload and the state its founding seat signed, while
 *                        the proposal is written down and not yet sent;
 *   a retry's order      the same, from the retry as the leg records it;
 *   what carries out     a seat or a threshold change, from the proposal
 *                        opened here.
 *
 * What is built from these is checked again where the call is built
 * (`refuseWhatThisDeviceDidNotOpen`).
 */
import type { AssetRegistry, LedgerForm } from '../../../src/core/assets.js';
import { assetIdBytes, symbolOf } from '../../../src/core/assets.js';
import { parseCanonical, unseal, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { openRecord } from '../../../src/core/sealed-records.js';
import type { StateChange } from '../../../src/core/ledger.js';
import type { PayrollRun, RunLeg, SealedProposal } from '../../../src/core/types.js';
import { paymentChecked, paymentsOnTheWire } from '../../../src/core/device-raise.js';
import { isLiveRound, payrollRoundOf } from '../../../src/core/retry-cover.js';
import {
  assetOfLeg, legChoiceOf, legEmployees, legFieldsOf, legName, legOf, legOfRound, legsOfRun, raisedLegOf,
} from '../../../src/core/run-legs.js';
import type { PaymentFacts } from '../../../src/midnight/payout-tree.js';
import { openedRunHere, payableFactsHere, signedStateHere, type CompanyRecordsHere } from './run-rebuilt-here.js';
import type { GovernedCallOrder, OpenedRound } from './governed-call-builder.js';
import type { LegPaymentsOnTheWire, RaiseOrderOnTheWire, RetryOrderOnTheWire } from './governed-call-on-device.js';

/** Why this device could not make what a raise, a retry or a seat is built from. Nothing is built without it. */
export class NotMadeHere extends Error {
  constructor(why: string) {
    super(`${why} Nothing was built or sent.`);
    this.name = 'NotMadeHere';
  }
}

/** One leg of a run, as this device reads it. */
interface LegHere {
  readonly leg: RunLeg;
  readonly asset: string;
  readonly form: LedgerForm;
  readonly symbol: string;
  /** Who is on the leg, by roster entry. */
  readonly people: readonly string[];
  readonly total: bigint;
  readonly proposalId: string | null;
}

/** A proposal of the company opened here: its record, what it says, and the change sealed in it. */
interface ProposalHere {
  readonly rec: SealedProposal;
  readonly kind: string;
  readonly raisedAt?: string;
  readonly change: StateChange;
  readonly sealedPayload: Sealed;
}

/** Which leg a request names: its token, and its form where the run pays that token both ways. */
export interface LegNamed { readonly asset?: string; readonly form?: LedgerForm }

const registryOf = (records: CompanyRecordsHere): AssetRegistry | undefined => records.registry;

const proposalsOf = async (records: CompanyRecordsHere): Promise<readonly SealedProposal[]> => {
  if (records.proposals === undefined) {
    throw new NotMadeHere('This page cannot read the company\'s proposals, so it cannot make this here. Reload the page to '
      + 'get the current version.');
  }
  return records.proposals();
};

/** One of the company's proposals, opened here with the viewing key. */
const openedProposal = (rec: SealedProposal, accountId: string, viewingKey: Hex): ProposalHere => {
  if (rec.accountId !== accountId) throw new NotMadeHere('A proposal this run names belongs to another company.');
  let envelope: { kind: string; raisedAt?: string; sealedPayload: Sealed };
  let change: StateChange | undefined;
  try {
    envelope = openRecord('proposals', rec.accountId, rec.sealed, viewingKey);
    change = parseCanonical<{ __change?: StateChange }>(unseal(envelope.sealedPayload, viewingKey)).__change;
  } catch {
    throw new NotMadeHere('This device cannot read the company\'s record of a proposal this run names. Reload the page and '
      + 'try again.');
  }
  if (change === undefined || !/^[0-9a-f]{64}$/u.test(String(change.salt))) {
    throw new NotMadeHere('A proposal this run names is incomplete in the company\'s records. Withdraw it and raise the run '
      + 'again.');
  }
  return {
    rec, kind: envelope.kind, change, sealedPayload: envelope.sealedPayload,
    /* When the chain was first seen to hold it is kept plain on the record; a record written before that kept it sealed. */
    ...((rec.raisedAt ?? envelope.raisedAt) ? { raisedAt: (rec.raisedAt ?? envelope.raisedAt)! } : {}),
  };
};

/** The legs of a run, side by side, each with its token, form, symbol, people, total and proposal. */
export async function legsHere(records: CompanyRecordsHere, accountId: string, runId: string, viewingKey: Hex): Promise<LegHere[]> {
  const run = await openedRunHere(records, accountId, runId, viewingKey);
  return legsOfRun(run).map((leg) => {
    const people = legEmployees(run, leg);
    return {
      ...legFieldsOf(leg),
      symbol: symbolOf(assetOfLeg(leg), registryOf(records)),
      people: people.map((e) => e.id),
      total: people.reduce((sum, e) => sum + e.amount, 0n),
      proposalId: run.proposalIds[leg] ?? null,
    };
  });
}

/**
 * **WHETHER A LEG IS RAISED FROM WHAT IT WAS RAISED OVER.** A leg with a
 * proposal written down is, unless that proposal was withdrawn; and so is a leg
 * raised once and since withdrawn from the run whose earlier round may still be
 * on chain, so raising it again raises the same round.
 */
const raisedFromItsRecord = (
  run: PayrollRun, leg: RunLeg, proposals: readonly SealedProposal[], accountId: string, viewingKey: Hex,
): boolean => {
  if (run.payout?.[leg] === undefined) return false;
  const pointed = run.proposalIds[leg];
  if (pointed !== undefined) {
    const rec = proposals.find((p) => p.id === pointed);
    return rec !== undefined && rec.status !== 'cancelled';
  }
  return proposals.some((p) => {
    if (p.accountId !== accountId) return false;
    const opened = openedProposal(p, accountId, viewingKey);
    const round = payrollRoundOf({ id: p.id, kind: opened.kind, status: p.status, chainId: p.chainId, sealedPayload: opened.sealedPayload }, viewingKey);
    return round !== null && round.runId === run.id && legOfRound(round) === leg && round.retry === undefined && isLiveRound(round);
  });
};

/**
 * **WHAT RAISING ONE LEG WILL ASK ITS VAULT TO PAY**: a kind, a token and an
 * amount per payment, in the leg's order. A leg raised from its record pays
 * what was written down; any other pays each person what this device works out
 * from the people it believes and would pay.
 */
export async function legPaymentsHere(
  records: CompanyRecordsHere, accountId: string, runId: string, viewingKey: Hex, which?: LegNamed,
): Promise<LegPaymentsOnTheWire> {
  const run = await openedRunHere(records, accountId, runId, viewingKey);
  const leg = legOf(run, legChoiceOf(which ?? {}), registryOf(records));
  let facts: readonly PaymentFacts[];
  if (raisedFromItsRecord(run, leg, await proposalsOf(records), accountId, viewingKey)) {
    facts = run.payout![leg]!.facts;
  } else {
    facts = await payableFactsHere(records, legEmployees(run, leg), 'Put their record right before this run is raised.',
      'This device will not raise a run it would not pay.');
  }
  return { ...legFieldsOf(leg), payments: paymentsOnTheWire(facts.map(paymentChecked)) };
}

/**
 * **WHAT A RETRY OF SOME OF ONE LEG'S PEOPLE WILL ASK ITS VAULT TO PAY**: the
 * leg's recorded payment of each person it names, in the order it names them.
 */
export async function retryPaymentsHere(
  records: CompanyRecordsHere, accountId: string, runId: string, viewingKey: Hex, indices: readonly number[], which?: LegNamed,
): Promise<LegPaymentsOnTheWire> {
  const run = await openedRunHere(records, accountId, runId, viewingKey);
  const leg = legOf(run, legChoiceOf(which ?? {}), registryOf(records));
  const recorded = run.payout?.[leg];
  if (recorded === undefined) {
    throw new NotMadeHere(`The ${legName(leg, registryOf(records))} leg of this run has not been raised, so there is nobody on `
      + 'it to retry. Raise the leg first.');
  }
  if (indices.length === 0 || new Set(indices).size !== indices.length) {
    throw new NotMadeHere('A retry names each person it pays once, and at least one. Reload the run and choose again.');
  }
  const payments = indices.map((i) => {
    const f = Number.isInteger(i) && i >= 0 ? recorded.facts[i] : undefined;
    if (f === undefined) {
      throw new NotMadeHere(`This run pays ${recorded.facts.length} people in this leg, so there is no person #${Number(i) + 1} `
        + 'on it to retry. Reload the run and choose again.');
    }
    return paymentChecked(f);
  });
  return { ...legFieldsOf(leg), payments: paymentsOnTheWire(payments) };
}

/** The account's half of a raise: the change sealed in the proposal, and the asset blinding of the state its founding seat signed. */
const halfOf = async (records: CompanyRecordsHere, accountId: string, viewingKey: Hex, p: ProposalHere) => {
  const state = await signedStateHere(records, accountId, viewingKey);
  /* The account's own name for the asset, which is what the asset witness answers with. */
  const named = { assetId: assetIdBytes(p.change.asset) };
  return {
    assetId: Array.from(named.assetId, (x) => x.toString(16).padStart(2, '0')).join(''), assetBlinding: state.assetBlinding, proposalSalt: p.change.salt,
    changeAmount: String(p.change.amount), changeBatchDigest: p.change.batchDigest,
  };
};

const NOTHING_WAITING = 'This run has no proposal written down that is waiting to be sent to the chain: it has been sent '
  + 'already, or withdrawn. Reload the run to see where it stands.';

/**
 * **WHAT A PROPOSAL WRITTEN DOWN COMMITS TO PAYING**, from its own record: the
 * commitment its filing carries. A payroll proposal with none says nothing a
 * send could be held to, so none is made from it.
 */
const writtenDownPays = (rec: SealedProposal): string => {
  if (typeof rec.pays !== 'string' || !/^[0-9a-f]{64}$/iu.test(rec.pays)) {
    throw new NotMadeHere('The proposal written down for this run does not say what it pays, so this device cannot hold what '
      + 'it sends to it. Withdraw the proposal and raise the run again.');
  }
  return rec.pays.toLowerCase();
};

/**
 * **WHAT A SIGNER'S DEVICE BUILDS ONE LEG'S PROPOSAL FROM, WHILE IT IS WRITTEN
 * DOWN AND NOT YET SENT**: the run as the leg's own record holds it, and the
 * account's half of the call.
 */
export async function raiseOrderHere(
  records: CompanyRecordsHere, accountId: string, runId: string, viewingKey: Hex, which?: LegNamed,
): Promise<RaiseOrderOnTheWire> {
  const run = await openedRunHere(records, accountId, runId, viewingKey);
  const leg = raisedLegOf(run, legChoiceOf(which ?? {}), registryOf(records));
  const payout = leg ? run.payout?.[leg] : undefined;
  const proposalId = leg ? run.proposalIds[leg] : undefined;
  const rec = proposalId === undefined ? undefined : (await proposalsOf(records)).find((p) => p.id === proposalId);
  if (payout === undefined || rec === undefined) throw new NotMadeHere(NOTHING_WAITING);
  const opened = openedProposal(rec, accountId, viewingKey);
  if (opened.raisedAt !== undefined || rec.status !== 'open') throw new NotMadeHere(NOTHING_WAITING);
  return {
    proposalId: rec.id,
    chainId: rec.chainId,
    order: {
      circuit: 'propose',
      run: {
        root: payout.root, payees: payout.payees.toString(), opensAt: payout.opensAt.toString(),
        closesAt: payout.closesAt.toString(), vault: payout.vault,
        ...(payout.required ? { required: payout.required.toString() } : {}),
      },
      half: await halfOf(records, accountId, viewingKey, opened),
      proposal: rec.chainId,
    },
    pays: writtenDownPays(rec),
  };
}

/**
 * **WHAT A SIGNER'S DEVICE BUILDS A RETRY'S PROPOSAL FROM, WHILE IT IS WRITTEN
 * DOWN AND NOT YET SENT**: the retry found by its proposal among the leg's own
 * retries, its run read off that record, and the people it pays as positions
 * in the leg.
 */
export async function retryOrderHere(
  records: CompanyRecordsHere, accountId: string, runId: string, viewingKey: Hex, proposalId: string, which?: LegNamed,
): Promise<RetryOrderOnTheWire> {
  const run = await openedRunHere(records, accountId, runId, viewingKey);
  const leg = raisedLegOf(run, legChoiceOf(which ?? {}), registryOf(records));
  const payout = leg ? run.payout?.[leg] : undefined;
  const retry = payout?.retries?.find((r) => r.proposalId === proposalId);
  const rec = retry === undefined ? undefined : (await proposalsOf(records)).find((p) => p.id === proposalId);
  if (payout === undefined || retry === undefined || rec === undefined) throw new NotMadeHere(NOTHING_WAITING);
  const opened = openedProposal(rec, accountId, viewingKey);
  if (opened.raisedAt !== undefined || rec.status !== 'open') throw new NotMadeHere(NOTHING_WAITING);
  return {
    proposalId: rec.id,
    chainId: rec.chainId,
    order: {
      circuit: 'propose',
      run: {
        root: retry.root, payees: retry.payees.toString(), opensAt: retry.opensAt.toString(),
        closesAt: retry.closesAt.toString(), vault: retry.vault,
        ...(retry.required ? { required: retry.required.toString() } : {}),
      },
      half: await halfOf(records, accountId, viewingKey, opened),
      proposal: rec.chainId,
    },
    indices: [...retry.originalIndices],
    pays: writtenDownPays(rec),
  };
}

/**
 * **WHAT CARRIES OUT AN APPROVED SEAT OR THRESHOLD CHANGE**, from the proposal
 * as this device opened it: the leaf or the threshold it names, its identity
 * and its salt.
 */
export function carryOrderHere(opened: OpenedRound): GovernedCallOrder {
  const g = opened.governance;
  if (g?.kind === 'add-signer') return { circuit: 'amendSigner', leaf: g.leaf, proposal: opened.chainId, proposalSalt: opened.salt };
  if (g?.kind === 'threshold') return { circuit: 'setThreshold', threshold: g.threshold, proposal: opened.chainId, proposalSalt: opened.salt };
  if (g?.kind === 'vault-threshold') {
    return { circuit: 'setVaultThreshold', vault: g.vault, threshold: g.threshold, proposal: opened.chainId, proposalSalt: opened.salt };
  }
  throw new NotMadeHere('This proposal neither seats a signer nor changes the approvals required, so there is nothing to carry '
    + 'out from here.');
}
