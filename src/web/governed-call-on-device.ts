/**
 * **RAISING A PAYROLL PROPOSAL AND APPROVING ONE, FROM THIS DEVICE.**
 *
 * The page's side of it. The company's service writes a proposal down and hands
 * over what the device needs to build it; the worker builds and proves the call
 * with this signer's own key material; the service pays the network fee and
 * sends what the device proved. **Nothing that proves membership leaves this
 * device**: what the service receives is a proven transaction and, for an
 * approval, a signature.
 *
 * **A SEND ENDS ONE OF THREE WAYS.** Refused before anything was sent, which
 * the service marks and this module keeps. Sent and counted by the chain. Or
 * sent and not yet seen, which is said as exactly that, and the person is told
 * not to send it again. The service sends a proposal again only when the chain
 * says it does not hold it, and the chain refuses a second approval from one
 * signer; **the screen does not yet say the first of the three any differently
 * from any other failure.**
 */
import { assets as theAssets, type AssetId, type AssetRegistry } from '../core/assets.js';
import { refuseWhatTheVaultCannotPay, type PaymentAsked, type VaultHoldings } from '../core/vault-holdings.js';
import {
  DEVICE_RAISE_VERSION, WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED, paymentsCheckedDigest, type PaymentChecked,
} from '../core/device-raise.js';
import type { SignerMaterial, GovernedCallOrder, RaiseRunOrder, RaiseGovernanceOrder, GovernanceOnTheWire } from './governed-call-builder.js';
import type { Hex, Sealed } from '../core/crypto.js';
import { payrollRoundOf, sameList, untoldRetryRounds } from '../core/retry-cover.js';
import type { AccountCallChainOnTheWire, VaultBuilderClient } from './vault-worker-client.js';

/** A proposal written down and not yet sent, as the service hands it to the device that builds it. */
export interface RaiseOrderOnTheWire {
  readonly proposalId: string;
  readonly chainId: string;
  readonly order: RaiseRunOrder;
  /** The digest of the payments the proposal written down pays, taken as `paymentsCheckedDigest` takes it. */
  readonly paymentsChecked: string;
}

/** A retry written down and not yet sent: its proposal, and the people it pays as positions in the leg. */
export interface RetryOrderOnTheWire extends RaiseOrderOnTheWire {
  readonly indices: ReadonlyArray<number>;
}

/** The parts of a proposal this module reads. */
export interface RoundOnThePage {
  readonly id: string;
  readonly chainId: string;
  readonly status: string;
  readonly txRef?: string;
  readonly raisedAt?: string;
  readonly approvalRound?: { readonly state: string; readonly approvals?: number };
}

/**
 * What raising one leg will ask its vault to pay, as the service hands it over:
 * a kind, a token and an amount per payment, and nothing about who is paid.
 */
export interface LegPaymentsOnTheWire {
  readonly asset: string;
  readonly payments: ReadonlyArray<PaymentChecked<string, string>>;
}

/** What this module asks of the company's service. */
export interface GovernedCallService {
  legPayments(runId: string, body: { viewingKey: string; asset?: string }): Promise<LegPaymentsOnTheWire>;
  raiseRun(runId: string, body: {
    viewingKey: string; asset?: string; vault: string; opensAt: string; closesAt: string; onDevice: true;
    version: typeof DEVICE_RAISE_VERSION; checked: string;
  }): Promise<{ proposal: RoundOnThePage; order: RaiseOrderOnTheWire | null }>;
  raiseOrder(runId: string, body: { viewingKey: string; asset?: string }): Promise<RaiseOrderOnTheWire>;
  sendRaise(runId: string, body: {
    viewingKey: string; asset?: string; tx: string; version: typeof DEVICE_RAISE_VERSION; checked: string;
  }): Promise<RoundOnThePage>;
  /** What a retry of some of one leg's people will ask its vault to pay, in the shape `legPayments` answers. */
  retryPayments(runId: string, body: { viewingKey: string; asset?: string; indices: number[] }): Promise<LegPaymentsOnTheWire>;
  raiseRetry(runId: string, body: {
    viewingKey: string; asset?: string; indices: number[]; vault: string; opensAt: string; closesAt: string; onDevice: true;
    version: typeof DEVICE_RAISE_VERSION; checked: string;
  }): Promise<{ proposal: RoundOnThePage; order: RetryOrderOnTheWire | null }>;
  retryOrder(runId: string, body: { viewingKey: string; asset?: string; proposalId: string }): Promise<RetryOrderOnTheWire>;
  sendRetry(runId: string, body: {
    viewingKey: string; asset?: string; proposalId: string; tx: string; version: typeof DEVICE_RAISE_VERSION; checked: string;
  }): Promise<RoundOnThePage>;
  callState(accountId: string): Promise<AccountCallChainOnTheWire & { readonly account: string }>;
  approve(proposalId: string, body: { signerId: string; signature: string; viewingKey: string; tx: string }): Promise<RoundOnThePage>;
  standing(proposalId: string, body: { viewingKey: string }): Promise<RoundOnThePage>;
  /** The proposal that seats one person waiting for a seat, and what a device needs to raise it if the chain does not hold it yet. */
  seatRound?(accountId: string, signerId: string, body: { viewingKey: string }): Promise<GovernanceRoundOnTheWire>;
  thresholdRound?(accountId: string, body: { viewingKey: string; newThreshold: number }): Promise<GovernanceRoundOnTheWire>;
  sendGovernance?(proposalId: string, body: { viewingKey: string; tx: string }): Promise<RoundOnThePage>;
  seatOrder?(accountId: string, signerId: string, body: { viewingKey: string }): Promise<{ order: GovernedCallOrder }>;
  seat?(accountId: string, signerId: string, body: { viewingKey: string; tx: string }): Promise<unknown>;
  thresholdOrder?(accountId: string, body: { viewingKey: string; newThreshold: number }): Promise<{ order: GovernedCallOrder }>;
  setThreshold?(accountId: string, body: { viewingKey: string; newThreshold: number; tx: string }): Promise<unknown>;
}

/** A seat or a threshold round as the service hands it over: the proposal, and the raise when it is still to be sent. */
export interface GovernanceRoundOnTheWire {
  readonly proposal: RoundOnThePage & { readonly approvals?: ReadonlyArray<{ readonly signerId: string }> };
  /** What the proposal changes and the salt its identity was made with; null once it has been carried out. */
  readonly asked: { readonly governance: GovernanceOnTheWire; readonly proposalSalt: string } | null;
  readonly order: { readonly proposalId: string; readonly chainId: string; readonly order: RaiseGovernanceOrder } | null;
}

export type GovernedStage = 'checking-the-vault' | 'writing-down' | 'reading-the-chain' | 'building' | 'sending' | 'waiting-for-the-chain';

export interface GovernedCallDoors {
  readonly service: GovernedCallService;
  readonly builder: Pick<VaultBuilderClient, 'governedCall'>;
  /** This signer's own three, from the keyring this device opened. */
  readonly material: SignerMaterial;
  readonly accountId: string;
  readonly progress?: (stage: GovernedStage) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the chain to show what was sent, and how often to ask. */
  readonly waitMs?: number;
  readonly everyMs?: number;
}

/** Sent, and the chain has not shown it yet. Not a failure, and not to be sent again. */
export class SentAndNotYetSeen extends Error {
  constructor(what: string, readonly round: RoundOnThePage) {
    super(
      `${what} was sent and the chain has not shown it yet. Do not send it again: open the run later ` +
        'and it will say where the proposal stands.',
    );
    this.name = 'SentAndNotYetSeen';
  }
}

/** The service's own mark of whether a refused send reached the chain, kept rather than guessed. */
export const nothingWasSentBy = (e: unknown): boolean =>
  (e as { nothingWasSent?: unknown } | null)?.nothingWasSent === true
  || /Nothing was sent/u.test(String((e as { message?: unknown } | null)?.message ?? ''));

const counted = (r: RoundOnThePage): number =>
  (r.approvalRound && typeof r.approvalRound.approvals === 'number' ? r.approvalRound.approvals : 0);

/**
 * **WHAT THE SERVICE HANDS OVER FOR A RAISE IS A RAISE, OF THE PROPOSAL IT
 * NAMES, AND OF WHAT THE PERSON CHOSE.** Anything else is refused before the
 * worker is asked: a device proves what it is handed, so this is the last place
 * a different call, a different proposal or a different vault or window can be
 * noticed.
 */
export function refuseAnOrderThatIsNotThisRaise(
  order: RaiseOrderOnTheWire, chosen?: { vault: string; opensAt: string; closesAt: string },
): void {
  const o = order.order as { circuit?: unknown; proposal?: unknown; run?: RaiseOrderOnTheWire['order']['run'] };
  if (o.circuit !== 'propose' || String(o.proposal).toLowerCase() !== String(order.chainId).toLowerCase()) {
    throw new Error('what the company handed this device is not the proposal it wrote down. Nothing was built or sent.');
  }
  if (chosen !== undefined && (o.run?.vault.toLowerCase() !== chosen.vault.toLowerCase()
    || o.run?.opensAt !== chosen.opensAt || o.run?.closesAt !== chosen.closesAt)) {
    throw new Error(
      'the proposal the company wrote down names another vault or another window than the ones chosen here. '
        + 'Nothing was built or sent.');
  }
}

/** Asks where a proposal stands until `seen` says so, or until the wait is over. */
const waitFor = async (
  doors: GovernedCallDoors, what: string, proposalId: string, viewingKey: string,
  seen: (r: RoundOnThePage) => boolean, last: RoundOnThePage,
): Promise<RoundOnThePage> => {
  const sleep = doors.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = doors.waitMs ?? 5 * 60_000;
  const everyMs = doors.everyMs ?? 6_000;
  doors.progress?.('waiting-for-the-chain');
  let now = last;
  for (let waited = 0; waited < waitMs; waited += everyMs) {
    await sleep(everyMs);
    try {
      now = await doors.service.standing(proposalId, { viewingKey });
    } catch {
      /* A read that failed says nothing about what was sent; ask again. */
      continue;
    }
    if (seen(now)) return now;
  }
  throw new SentAndNotYetSeen(what, now);
};

/**
 * Builds the proposal the service wrote down, sends it, and waits for the chain
 * to hold it. **The vault is checked on this device first, every time** - a
 * first send and a send again alike - because a proposal written down days ago
 * is paid from the vault as it is now. The send carries the digest of what was
 * checked, and the service refuses it unless that is the proposal it wrote down.
 */
export async function sendRaiseFromDevice(
  doors: RaiseDoors,
  input: {
    runId: string; viewingKey: string; asset?: string; order?: RaiseOrderOnTheWire;
    /** What the person chose, when this device is raising the leg now: the order must describe exactly that. */
    chosen?: { vault: string; opensAt: string; closesAt: string };
  },
): Promise<RoundOnThePage> {
  const { service } = doors;
  const asked = input.asset === undefined ? {} : { asset: input.asset };
  const order = input.order ?? await service.raiseOrder(input.runId, { viewingKey: input.viewingKey, ...asked });
  refuseAnOrderThatIsNotThisRaise(order, input.chosen);
  doors.progress?.('checking-the-vault');
  const checked = await refuseALegTheVaultCannotPay(doors, {
    runId: input.runId, viewingKey: input.viewingKey, ...asked, vault: order.order.run.vault, order,
  });
  return buildAndSend(doors, order, input.viewingKey, (tx) => service.sendRaise(input.runId, {
    viewingKey: input.viewingKey, ...asked, tx, version: DEVICE_RAISE_VERSION, checked,
  }));
}

/** Builds and proves what the service wrote down, hands it to `send`, and waits for the chain to hold it. */
async function buildAndSend(
  doors: GovernedCallDoors, order: RaiseOrderOnTheWire, viewingKey: string,
  send: (tx: string) => Promise<RoundOnThePage>,
): Promise<RoundOnThePage> {
  doors.progress?.('reading-the-chain');
  const chain = await doors.service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account, order: order.order, material: doors.material, chain,
  });
  doors.progress?.('sending');
  const sent = await send(tx);
  return waitFor(doors, 'this proposal', order.proposalId, viewingKey, (r) => Boolean(r.raisedAt), sent);
}

/** A raise also needs to know what the vault holds privately, which only this device can read. */
export interface RaiseDoors extends GovernedCallDoors {
  /** The vault's private money, read from the pool this device opens. */
  readonly holdings: VaultHoldings;
  /** The asset rows the payments are checked against. The product's own when not given. */
  readonly assets?: AssetRegistry;
}

const DIGITS = /^[0-9]+$/u;

/**
 * **WHETHER THE VAULT CAN PAY THIS LEG'S PRIVATE PAYMENTS, ASKED HERE BEFORE THE
 * SERVICE IS ASKED TO WRITE ANYTHING DOWN.** The vault's notes are opened on
 * this device and nowhere else, so this is the one place the question can be
 * answered; the service asks the rest. A refusal writes nothing and spends
 * nothing. The only thing that goes to the service to ask it is what it already
 * had: the run, the leg and the viewing key. What comes back is the digest of
 * the payments checked, which is all the service is told about the check.
 */
async function refuseALegTheVaultCannotPay(
  doors: RaiseDoors,
  input: { runId: string; viewingKey: string; asset?: string; vault: string; order?: RaiseOrderOnTheWire },
): Promise<string> {
  const leg = await doors.service.legPayments(input.runId, {
    viewingKey: input.viewingKey, ...(input.asset === undefined ? {} : { asset: input.asset }),
  });
  return refusePaymentsTheVaultCannotPay(doors, leg, input);
}

/**
 * **THE CHECK ITSELF, OVER WHATEVER PAYMENTS THE SERVICE HANDED OVER** - a
 * leg's, or a retry's. The digest returned is over exactly what was handed
 * over, in its order.
 *
 * **AND, WHEN A PROPOSAL IS WRITTEN DOWN, AGAINST THAT PROPOSAL.** Its digest
 * must be the digest of these payments, and its count of payees is the count
 * the payments are checked against, so what is checked is what will be built
 * and sent. Before anything is written down there is no proposal yet, and the
 * service compares what it writes down with the digest this returns.
 */
async function refusePaymentsTheVaultCannotPay(
  doors: RaiseDoors, leg: LegPaymentsOnTheWire, input: { asset?: string; vault: string; order?: RaiseOrderOnTheWire },
): Promise<string> {
  if (input.asset !== undefined && leg.asset !== input.asset) {
    throw new Error(`the company answered for its ${leg.asset} payments when ${input.asset} is being raised. `
      + 'Nothing was raised and no fee was spent.');
  }
  const payments = leg.payments.map((p, at): PaymentAsked => {
    const kind = p.kind;
    if ((kind !== 'shielded' && kind !== 'unshielded') || !DIGITS.test(String(p.amount))) {
      throw new Error(`payment ${at + 1} on this run came back from the company in a shape this device cannot `
        + 'check. Nothing was raised and no fee was spent.');
    }
    return { payee: { kind }, token: String(p.token), amount: BigInt(p.amount) };
  });
  const checked = paymentsCheckedDigest(leg.payments);
  let payees = BigInt(payments.length);
  if (input.order !== undefined) {
    if (checked !== String(input.order.paymentsChecked)) throw new Error(WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED);
    if (!DIGITS.test(String(input.order.order.run.payees))) {
      throw new Error('the proposal written down for this run does not say how many people it pays, so this device cannot '
        + 'check it. Nothing was built or sent. Reload the page and send it again. If this comes back, withdraw the '
        + 'proposal and raise the run again.');
    }
    payees = BigInt(input.order.order.run.payees);
  }
  await refuseWhatTheVaultCannotPay(doors.holdings, {
    vault: input.vault,
    asset: (doors.assets ?? theAssets).require(leg.asset as AssetId),
    total: payments.reduce((a, p) => a + p.amount, 0n),
    payees,
    payments,
  }, ['shielded']);
  return checked;
}

/**
 * **ONE LEG OF A RUN, RAISED FROM THIS DEVICE.** Its private payments are
 * checked against the vault's notes here first. The service then writes the
 * proposal down, so a device that stops part way leaves a proposal that can be
 * sent again with `sendRaiseFromDevice`, never a second proposal over the same
 * people.
 */
export async function raiseRunOnDevice(
  doors: RaiseDoors,
  input: { runId: string; viewingKey: string; asset?: string; vault: string; opensAt: string; closesAt: string },
): Promise<RoundOnThePage> {
  doors.progress?.('checking-the-vault');
  const checked = await refuseALegTheVaultCannotPay(doors, input);
  doors.progress?.('writing-down');
  const raised = await doors.service.raiseRun(input.runId, {
    viewingKey: input.viewingKey, vault: input.vault, opensAt: input.opensAt, closesAt: input.closesAt,
    ...(input.asset === undefined ? {} : { asset: input.asset }), onDevice: true,
    version: DEVICE_RAISE_VERSION, checked,
  });
  /* A proposal the chain already holds - one raised before and seen since - has nothing to send. */
  if (raised.order === null) return raised.proposal;
  return sendRaiseFromDevice(doors, {
    runId: input.runId, viewingKey: input.viewingKey, order: raised.order,
    chosen: { vault: input.vault, opensAt: input.opensAt, closesAt: input.closesAt },
    ...(input.asset === undefined ? {} : { asset: input.asset }),
  });
}

/**
 * **WHO A RETRY OF A STOPPED RUN PAYS: THE PEOPLE THE RUN HAS NOT PAID, AND
 * NOBODY ELSE.** Read from the run's own payment view, as positions in the leg.
 * A person the account records as paid is never named, and neither is one a
 * person decided not to pay. Nothing is offered when the view could not say who
 * was paid, or could not prove its people are this run's: a retry chosen from an
 * answer about another payroll would be a retry of the wrong people.
 *
 * **AND ONLY WHEN THE RETRY CAN BE RAISED: NOBODY WHILE THE RUN'S WINDOW HAS NOT
 * CLOSED, AND NOBODY A SENT RETRY CAN STILL PAY.** While the run's own round can
 * still pay them a retry would be a second round over the same people, and so
 * would a retry over people another retry on the chain still covers; the
 * company refuses both. So the people offered are the view's `stranded` - owed,
 * with nothing left that can pay them - and none of its `outstanding` beyond.
 */
export function unpaidToRetry(view: {
  readonly answered: boolean;
  readonly status?: {
    readonly verified: boolean;
    readonly outstanding: ReadonlyArray<{ readonly index: number; readonly state: string }>;
    readonly phase?: string;
    readonly stranded?: ReadonlyArray<{ readonly index: number; readonly state: string }>;
  };
},
/**
 * People a retry not yet seen on chain already covers: written down and not
 * sent, sent and not yet seen, or whose raise did not answer. The view counts
 * only retries the chain holds, so it still lists these people as stranded;
 * the company refuses a second retry over them while that one's window is
 * open. They are not offered here - their own retry is, to be sent.
 */
covered: ReadonlyArray<number> = []): number[] {
  if (!view.answered || !view.status?.verified) return [];
  if (view.status.phase !== 'closed') return [];
  const taken = new Set(covered);
  return (view.status.stranded ?? [])
    .filter((p) => (p.state === 'failed' || p.state === 'unsent') && !taken.has(p.index))
    .map((p) => p.index)
    .sort((a, b) => a - b);
}

/** A retry written onto a leg, as the page reads it off the run. */
export interface RetryOnTheLeg {
  readonly originalIndices: ReadonlyArray<number>;
  readonly opensAt: bigint | string | number;
  readonly closesAt: bigint | string | number;
  readonly vault: string;
  /** Absent when the retry was written onto the leg and its raise never answered. */
  readonly proposalId?: string;
}

/** The parts of a round the page reads to decide what may be done with it. */
export interface RoundStanding {
  readonly id: string;
  readonly status: string;
  readonly raisedAt?: string;
  readonly txRef?: string;
  /** What a round's sealed payload is opened from, to read which run, leg and people it is for. */
  readonly kind?: string;
  readonly chainId?: string;
  readonly sealedPayload?: Sealed;
}

/**
 * **THE ROUNDS WRITTEN DOWN FOR ONE RUN'S LEG, WITH THE PEOPLE EACH RETRY
 * PAYS**, read out of each round's sealed payload with the account's viewing
 * key exactly as the company reads them. A round this page holds no payload
 * for, or cannot open, is left out: it covers nobody here, and the company,
 * which opens every round, refuses a retry over its people all the same.
 */
export function roundsOfTheLeg(
  rounds: ReadonlyArray<RoundStanding>, viewingKey: string, runId: string, asset?: string,
): Array<{ readonly id: string; readonly status: string; readonly retry?: readonly number[] }> {
  return rounds.flatMap((r) => {
    if (r.kind === undefined || r.chainId === undefined || r.sealedPayload === undefined) return [];
    let opened: ReturnType<typeof payrollRoundOf>;
    try {
      opened = payrollRoundOf({
        id: r.id, kind: r.kind, status: r.status, chainId: r.chainId as Hex, sealedPayload: r.sealedPayload,
        ...(r.raisedAt ? { raisedAt: r.raisedAt } : {}),
      }, viewingKey as Hex);
    } catch {
      return [];
    }
    if (opened === null || opened.runId !== runId || (asset !== undefined && opened.asset !== asset)) return [];
    return [opened];
  });
}

const seconds = (s: bigint | string | number): bigint => BigInt(String(s));

/**
 * **A RETRY NOT YET SEEN ON CHAIN, AND WHAT SENDS IT.** One of three:
 *
 *   `untold`       written onto the leg, and its raise never answered, with a
 *                  round written down for exactly those people that can still
 *                  reach the chain (`untoldRetryRounds`, as the company reads
 *                  it). It is sent by raising exactly the same people with its
 *                  window and vault, which the company sends as itself. One
 *                  whose round was withdrawn, stopped, or never written down
 *                  covers nobody, and its people are offered again.
 *   `unsent`       written down and never sent.
 *   `sent-unseen`  sent from a device and not yet seen on chain. Sent again as
 *                  itself; the chain takes it once.
 *
 * Each covers its people until its window closes, exactly as the company
 * counts it. A retry withdrawn, stopped by policy, seen on chain, or whose
 * window has closed is none of these. A retry whose round this page cannot
 * find is left out: nothing here can say what would send it.
 */
export interface PendingRetry {
  readonly kind: 'untold' | 'unsent' | 'sent-unseen';
  readonly retry: RetryOnTheLeg;
  readonly round?: RoundStanding;
}

export function pendingRetries(
  retries: ReadonlyArray<RetryOnTheLeg>, rounds: ReadonlyArray<RoundStanding>, nowInSeconds: number,
  /** The rounds written down for this run's leg, with the people each retry pays: `roundsOfTheLeg`. */
  legRounds: ReadonlyArray<{ readonly id: string; readonly status: string; readonly retry?: readonly number[] }>,
): PendingRetry[] {
  const now = BigInt(Math.floor(nowInSeconds));
  const untold = untoldRetryRounds(retries, legRounds, now);
  const pending: PendingRetry[] = [];
  for (const retry of retries) {
    if (now >= seconds(retry.closesAt)) continue;
    if (retry.proposalId === undefined) {
      if (untold.some((u) => sameList(u.people, retry.originalIndices))) pending.push({ kind: 'untold', retry });
      continue;
    }
    const round = rounds.find((r) => r.id === retry.proposalId);
    /* Withdrawn, stopped by policy, or seen on chain: nothing here to send. */
    if (!round || round.raisedAt || round.status !== 'open') continue;
    pending.push({ kind: round.txRef ? 'sent-unseen' : 'unsent', retry, round });
  }
  return pending;
}

/**
 * **WHETHER THE COMPANY WILL WITHDRAW THIS PROPOSAL.** A round only written down
 * is withdrawn here. One the chain holds is withdrawn only before its window
 * opens, which the chain enforces. One a device sent and the chain does not
 * show yet is not withdrawn: it may still arrive, so it is sent again instead.
 * A round settled or already withdrawn has nothing to withdraw.
 */
export function mayWithdraw(
  round: RoundStanding, opensAt: bigint | string | number | undefined, nowInSeconds: number,
): boolean {
  if (round.status !== 'open' && round.status !== 'approved' && round.status !== 'blocked') return false;
  if (round.status === 'blocked') return true;
  if (!round.raisedAt) return !round.txRef;
  return opensAt !== undefined && BigInt(Math.floor(nowInSeconds)) < seconds(opensAt);
}

/** Withdraws a round through the company's service. The viewing key travels in the body. */
export const withdrawRound = (api: Api, proposalId: string, viewingKey: string): Promise<RoundOnThePage> =>
  api(`/api/proposals/${encodeURIComponent(proposalId)}/cancel`, { method: 'POST', body: JSON.stringify({ viewingKey }) });

const refuseAnOrderThatIsNotThisRetry = (order: RetryOrderOnTheWire, indices: ReadonlyArray<number>): void => {
  if (order.indices.length !== indices.length || order.indices.some((i, at) => i !== indices[at])) {
    throw new Error('the retry on record pays other people than the ones chosen on this page. Reload the run and choose '
      + 'again. Nothing was built or sent.');
  }
};

/**
 * **A RETRY WRITTEN DOWN AND NOT YET SENT, BUILT AND SENT FROM THIS DEVICE.**
 * The vault is checked here for exactly the retry's payments right before the
 * send, every time, as a leg's are.
 */
export async function sendRetryFromDevice(
  doors: RaiseDoors,
  input: {
    runId: string; viewingKey: string; asset?: string; proposalId: string; order?: RetryOrderOnTheWire;
    chosen?: { indices: ReadonlyArray<number>; vault: string; opensAt: string; closesAt: string };
  },
): Promise<RoundOnThePage> {
  const { service } = doors;
  const asked = input.asset === undefined ? {} : { asset: input.asset };
  const order = input.order ?? await service.retryOrder(input.runId, {
    viewingKey: input.viewingKey, ...asked, proposalId: input.proposalId,
  });
  if (order.proposalId !== input.proposalId) {
    throw new Error('the retry this device was handed is not the one on record. Reload the page and try again. Nothing '
      + 'was built or sent.');
  }
  refuseAnOrderThatIsNotThisRaise(order, input.chosen);
  if (input.chosen !== undefined) refuseAnOrderThatIsNotThisRetry(order, input.chosen.indices);
  doors.progress?.('checking-the-vault');
  const checked = await refusePaymentsTheVaultCannotPay(doors, await service.retryPayments(input.runId, {
    viewingKey: input.viewingKey, ...asked, indices: [...order.indices],
  }), { ...asked, vault: order.order.run.vault, order });
  return buildAndSend(doors, order, input.viewingKey, (tx) => service.sendRetry(input.runId, {
    viewingKey: input.viewingKey, ...asked, proposalId: order.proposalId, tx, version: DEVICE_RAISE_VERSION, checked,
  }));
}

/**
 * **A RETRY OF SOME OF ONE LEG'S PEOPLE, RAISED FROM THIS DEVICE.** Their
 * payments are checked against the vault's notes here first; the service then
 * writes the retry down under every rule a retry has, and this device builds,
 * proves and sends it. A device that stops part way leaves a retry that raising
 * the same people again sends as itself.
 */
export async function raiseRetryOnDevice(
  doors: RaiseDoors,
  input: {
    runId: string; viewingKey: string; asset?: string; indices: ReadonlyArray<number>;
    vault: string; opensAt: string; closesAt: string;
  },
): Promise<RoundOnThePage> {
  const asked = input.asset === undefined ? {} : { asset: input.asset };
  const indices = [...input.indices];
  doors.progress?.('checking-the-vault');
  const checked = await refusePaymentsTheVaultCannotPay(doors, await doors.service.retryPayments(input.runId, {
    viewingKey: input.viewingKey, ...asked, indices,
  }), { ...asked, vault: input.vault });
  doors.progress?.('writing-down');
  const raised = await doors.service.raiseRetry(input.runId, {
    viewingKey: input.viewingKey, ...asked, indices, vault: input.vault, opensAt: input.opensAt, closesAt: input.closesAt,
    onDevice: true, version: DEVICE_RAISE_VERSION, checked,
  });
  if (raised.order === null) return raised.proposal;
  return sendRetryFromDevice(doors, {
    runId: input.runId, viewingKey: input.viewingKey, ...asked, proposalId: raised.order.proposalId, order: raised.order,
    chosen: { indices, vault: input.vault, opensAt: input.opensAt, closesAt: input.closesAt },
  });
}

/**
 * **ONE APPROVAL, FROM THIS DEVICE.** The signature is made by the caller with
 * the keyring, the approval is built and proved in the worker, and both go to
 * the service together. Then the chain is asked until it counts one more.
 */
export async function approveOnDevice(
  doors: GovernedCallDoors,
  input: {
    round: RoundOnThePage; signerId: string; signature: string; viewingKey: string;
    /** For a seat or a threshold change: what it changes and its salt, which the approval is refused unless it matches. */
    of?: { governance: GovernanceOnTheWire; proposalSalt: string };
  },
): Promise<RoundOnThePage> {
  const { service } = doors;
  const before = await service.standing(input.round.id, { viewingKey: input.viewingKey });
  /* The proposal proved is the one the person was shown and signed for, or nothing is built. */
  if (String(before.chainId).toLowerCase() !== String(input.round.chainId).toLowerCase()) {
    throw new Error('the company now names another proposal than the one shown here. Nothing was built or sent.');
  }
  doors.progress?.('reading-the-chain');
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account,
    order: { circuit: 'approve', proposal: before.chainId, ...(input.of === undefined ? {} : { of: input.of }) },
    material: doors.material, chain,
  });
  doors.progress?.('sending');
  const sent = await service.approve(input.round.id, {
    signerId: input.signerId, signature: input.signature, viewingKey: input.viewingKey, tx,
  });
  const wanted = counted(before) + 1;
  return waitFor(doors, 'your approval', input.round.id, input.viewingKey,
    (r) => r.status === 'approved' || counted(r) >= wanted, sent);
}

type Api = (path: string, init?: RequestInit) => Promise<any>;

/** A refusal from the service keeps the service's own mark of whether anything was sent. */
const marked = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    throw Object.assign(new Error(message), { nothingWasSent: nothingWasSentBy(e) });
  }
};

/** The service's routes, over this page's own sign-in. Every key travels in a body, never in an address. */
export const governedCallServiceFor = (api: Api): GovernedCallService => {
  const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const run = (id: string) => `/api/runs/${encodeURIComponent(id)}`;
  const proposal = (id: string) => `/api/proposals/${encodeURIComponent(id)}`;
  const account = (id: string) => `/api/accounts/${encodeURIComponent(id)}`;
  const signer = (accountId: string, id: string) => `${account(accountId)}/signers/${encodeURIComponent(id)}`;
  return {
    legPayments: (runId, body) => post(`${run(runId)}/leg-payments`, body),
    raiseRun: (runId, body) => post(`${run(runId)}/propose`, body),
    raiseOrder: (runId, body) => post(`${run(runId)}/raise-order`, body),
    sendRaise: (runId, body) => marked(() => post(`${run(runId)}/raise-send`, body)),
    retryPayments: (runId, body) => post(`${run(runId)}/retry-payments`, body),
    raiseRetry: (runId, body) => post(`${run(runId)}/retry`, body),
    retryOrder: (runId, body) => post(`${run(runId)}/retry-order`, body),
    sendRetry: (runId, body) => marked(() => post(`${run(runId)}/retry-send`, body)),
    callState: (accountId) => api(`/api/accounts/${encodeURIComponent(accountId)}/call-state`),
    approve: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/approve`, body)),
    standing: (proposalId, body) => post(`${proposal(proposalId)}/standing`, body),
    seatRound: (accountId, signerId, body) => post(`${signer(accountId, signerId)}/round`, body),
    thresholdRound: (accountId, body) => post(`${account(accountId)}/threshold/round`, body),
    sendGovernance: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/governance-send`, body)),
    seatOrder: (accountId, signerId, body) => post(`${signer(accountId, signerId)}/seat-order`, body),
    seat: (accountId, signerId, body) => marked(() => post(`${signer(accountId, signerId)}/seat`, body)),
    thresholdOrder: (accountId, body) => post(`${account(accountId)}/threshold/order`, body),
    setThreshold: (accountId, body) => marked(() => post(`${account(accountId)}/threshold`, body)),
  };
};

/* ── A SEAT AND A THRESHOLD CHANGE, CARRIED OUT FROM THIS DEVICE ─────────────── */

/** Where a round that changes who may approve stands after this device has done what it can. */
export type GovernedOutcome =
  | { readonly state: 'done' }
  | { readonly state: 'waiting-for-approvals'; readonly round: RoundOnThePage };

const sameGovernance = (a: GovernanceOnTheWire, b: GovernanceOnTheWire): boolean =>
  a.kind === b.kind && (a.kind === 'add-signer'
    ? a.leaf.toLowerCase() === (b as { leaf: string }).leaf.toLowerCase()
    : a.threshold === (b as { threshold: string }).threshold);

/**
 * **A ROUND THAT CHANGES WHO MAY APPROVE, TAKEN AS FAR AS THIS DEVICE CAN TAKE
 * IT.** Raised if the chain does not hold it yet, approved by this signer if
 * they have not approved it, and carried out if it has the approvals it needs.
 * A round still short of approvals is left for the others to approve from their
 * own devices, and said so.
 *
 * **EVERY ORDER THE SERVICE HANDS OVER IS CHECKED AGAINST THE CHANGE THIS
 * PERSON ASKED FOR**, here and again where the call is built: the raise must be
 * for this leaf or this threshold, and so must the seat or the change. A device
 * proves what it is handed, so this is where a different change is noticed.
 */
async function governOnDevice(
  doors: GovernedCallDoors,
  input: {
    viewingKey: string; signerId: string; sign: (round: RoundOnThePage) => string;
    change: GovernanceOnTheWire;
    round: () => Promise<GovernanceRoundOnTheWire>;
    carryOrder: () => Promise<{ order: GovernedCallOrder }>;
    carry: (tx: string) => Promise<unknown>;
  },
): Promise<GovernedOutcome> {
  const { service } = doors;
  const handed = await input.round();
  let round: RoundOnThePage = handed.proposal;
  if (round.status === 'executed') return { state: 'done' };
  /* The change the service says this proposal makes must be the one asked for here, before anything is raised or approved. */
  if (handed.asked === null || !sameGovernance(handed.asked.governance, input.change)) {
    throw new Error('the service sent this device a different change from the one asked for here. Nothing was built or '
      + 'sent. Reload the page and try again; if it happens again, do not approve it.');
  }
  const of = { governance: input.change, proposalSalt: handed.asked.proposalSalt };
  if (handed.order !== null) {
    const o = handed.order.order as Partial<RaiseGovernanceOrder>;
    if (o.circuit !== 'propose' || !o.governance || !sameGovernance(o.governance, input.change)
      || String(o.proposal).toLowerCase() !== String(handed.proposal.chainId).toLowerCase()) {
      throw new Error('the service sent this device a different proposal from the one asked for here. Nothing was built '
        + 'or sent. Reload the page and try again; if it happens again, do not approve it.');
    }
    doors.progress?.('reading-the-chain');
    const chain = await service.callState(doors.accountId);
    doors.progress?.('building');
    const { tx } = await doors.builder.governedCall({ account: chain.account, order: o as RaiseGovernanceOrder, material: doors.material, chain });
    doors.progress?.('sending');
    const sent = await service.sendGovernance!(handed.proposal.id, { viewingKey: input.viewingKey, tx });
    round = await waitFor(doors, 'this proposal', handed.proposal.id, input.viewingKey, (r) => Boolean(r.raisedAt), sent);
  }
  const signed = (handed.proposal.approvals ?? []).some((a) => a.signerId === input.signerId);
  if (round.status === 'open' && !signed) {
    round = await approveOnDevice(doors, {
      round, signerId: input.signerId, signature: input.sign(round), viewingKey: input.viewingKey, of,
    });
  }
  if (round.status !== 'approved') return { state: 'waiting-for-approvals', round };
  const { order } = await input.carryOrder();
  const carried = order as { circuit?: string; leaf?: string; threshold?: string; proposal?: string };
  const asked = input.change.kind === 'add-signer'
    ? carried.circuit === 'amendSigner' && String(carried.leaf).toLowerCase() === input.change.leaf.toLowerCase()
    : carried.circuit === 'setThreshold' && carried.threshold === input.change.threshold;
  if (!asked || String(carried.proposal).toLowerCase() !== String(round.chainId).toLowerCase()) {
    throw new Error('the service sent this device something to carry out that is not the proposal asked for here. '
      + 'Nothing was built or sent. Reload the page and try again.');
  }
  doors.progress?.('reading-the-chain');
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({ account: chain.account, order, material: doors.material, chain });
  doors.progress?.('sending');
  await input.carry(tx);
  return { state: 'done' };
}

/** Seats one person waiting for a seat, as far as this device can: see `governOnDevice`. */
export function seatSignerOnDevice(
  doors: GovernedCallDoors,
  input: { viewingKey: string; signerId: string; sign: (round: RoundOnThePage) => string; seat: { signerId: string; leaf: string } },
): Promise<GovernedOutcome> {
  const { service, accountId } = doors;
  const body = { viewingKey: input.viewingKey };
  return governOnDevice(doors, {
    ...input,
    change: { kind: 'add-signer', leaf: input.seat.leaf },
    round: () => service.seatRound!(accountId, input.seat.signerId, body),
    carryOrder: () => service.seatOrder!(accountId, input.seat.signerId, body),
    carry: (tx) => service.seat!(accountId, input.seat.signerId, { ...body, tx }),
  });
}

/** Changes the account's threshold, as far as this device can: see `governOnDevice`. */
export function changeThresholdOnDevice(
  doors: GovernedCallDoors,
  input: { viewingKey: string; signerId: string; sign: (round: RoundOnThePage) => string; newThreshold: number },
): Promise<GovernedOutcome> {
  const { service, accountId } = doors;
  const body = { viewingKey: input.viewingKey, newThreshold: input.newThreshold };
  return governOnDevice(doors, {
    ...input,
    change: { kind: 'threshold', threshold: String(input.newThreshold) },
    round: () => service.thresholdRound!(accountId, body),
    carryOrder: () => service.thresholdOrder!(accountId, body),
    carry: (tx) => service.setThreshold!(accountId, { ...body, tx }),
  });
}
