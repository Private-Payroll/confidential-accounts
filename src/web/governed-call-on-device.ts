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
import type { SignerMaterial, GovernedCallOrder } from './governed-call-builder.js';
import type { AccountCallChainOnTheWire, VaultBuilderClient } from './vault-worker-client.js';

/** A proposal written down and not yet sent, as the service hands it to the device that builds it. */
export interface RaiseOrderOnTheWire {
  readonly proposalId: string;
  readonly chainId: string;
  readonly order: Extract<GovernedCallOrder, { circuit: 'propose' }>;
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
  readonly payments: ReadonlyArray<{ readonly kind: string; readonly token: string; readonly amount: string }>;
}

/** What this module asks of the company's service. */
export interface GovernedCallService {
  legPayments(runId: string, body: { viewingKey: string; asset?: string }): Promise<LegPaymentsOnTheWire>;
  raiseRun(runId: string, body: {
    viewingKey: string; asset?: string; vault: string; opensAt: string; closesAt: string; onDevice: true;
  }): Promise<{ proposal: RoundOnThePage; order: RaiseOrderOnTheWire | null }>;
  raiseOrder(runId: string, body: { viewingKey: string; asset?: string }): Promise<RaiseOrderOnTheWire>;
  sendRaise(runId: string, body: { viewingKey: string; asset?: string; tx: string }): Promise<RoundOnThePage>;
  callState(accountId: string): Promise<AccountCallChainOnTheWire & { readonly account: string }>;
  approve(proposalId: string, body: { signerId: string; signature: string; viewingKey: string; tx: string }): Promise<RoundOnThePage>;
  standing(proposalId: string, body: { viewingKey: string }): Promise<RoundOnThePage>;
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

/** Builds the proposal the service wrote down, sends it, and waits for the chain to hold it. */
export async function sendRaiseFromDevice(
  doors: GovernedCallDoors,
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
  doors.progress?.('reading-the-chain');
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account, order: order.order, material: doors.material, chain,
  });
  doors.progress?.('sending');
  const sent = await service.sendRaise(input.runId, { viewingKey: input.viewingKey, ...asked, tx });
  return waitFor(doors, 'this proposal', order.proposalId, input.viewingKey, (r) => Boolean(r.raisedAt), sent);
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
 * had: the run, the leg and the viewing key.
 */
async function refuseALegTheVaultCannotPay(
  doors: RaiseDoors, input: { runId: string; viewingKey: string; asset?: string; vault: string },
): Promise<void> {
  const leg = await doors.service.legPayments(input.runId, {
    viewingKey: input.viewingKey, ...(input.asset === undefined ? {} : { asset: input.asset }),
  });
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
  await refuseWhatTheVaultCannotPay(doors.holdings, {
    vault: input.vault,
    asset: (doors.assets ?? theAssets).require(leg.asset as AssetId),
    total: payments.reduce((a, p) => a + p.amount, 0n),
    payees: BigInt(payments.length),
    payments,
  }, ['shielded']);
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
  await refuseALegTheVaultCannotPay(doors, input);
  doors.progress?.('writing-down');
  const raised = await doors.service.raiseRun(input.runId, {
    viewingKey: input.viewingKey, vault: input.vault, opensAt: input.opensAt, closesAt: input.closesAt,
    ...(input.asset === undefined ? {} : { asset: input.asset }), onDevice: true,
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
 * **ONE APPROVAL, FROM THIS DEVICE.** The signature is made by the caller with
 * the keyring, the approval is built and proved in the worker, and both go to
 * the service together. Then the chain is asked until it counts one more.
 */
export async function approveOnDevice(
  doors: GovernedCallDoors,
  input: { round: RoundOnThePage; signerId: string; signature: string; viewingKey: string },
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
    account: chain.account, order: { circuit: 'approve', proposal: before.chainId }, material: doors.material, chain,
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
  return {
    legPayments: (runId, body) => post(`${run(runId)}/leg-payments`, body),
    raiseRun: (runId, body) => post(`${run(runId)}/propose`, body),
    raiseOrder: (runId, body) => post(`${run(runId)}/raise-order`, body),
    sendRaise: (runId, body) => marked(() => post(`${run(runId)}/raise-send`, body)),
    callState: (accountId) => api(`/api/accounts/${encodeURIComponent(accountId)}/call-state`),
    approve: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/approve`, body)),
    standing: (proposalId, body) => post(`${proposal(proposalId)}/standing`, body),
  };
};
