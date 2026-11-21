/**
 * **PAYROLL RUNS AND THEIR RETRIES, RAISED AND SENT FROM THIS DEVICE.**
 *
 * What the device sends is made from the company's records here, and before
 * anything is built it checks that the payments are the ones written down for
 * the proposal and that the vault can pay them. It refuses a leg the service
 * names in another asset or form than asked, a payment it cannot check, and an
 * order that is not the raise it was asked to send. It also says which unpaid
 * people a closed run may retry, which retries are still pending, and whether
 * a run may still be withdrawn.
 */
import type { KeysHeld } from '../../../src/core/company-key.js';
import { assets as theAssets, symbolOf, type AssetId, type AssetRegistry, type LedgerForm } from '../../../src/core/assets.js';
import { refuseWhatTheVaultCannotPay, type PaymentAsked, type VaultHoldings } from '../../../src/core/vault-holdings.js';
import { DEVICE_RAISE_VERSION, WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED, paymentsCheckedDigest, type PaymentChecked } from '../../../src/core/device-raise.js';
import type { RaiseRunOrder } from './governed-call-builder.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import { handedOver } from './hand-over.js';
import { raiseLegHere, raiseRetryHere, type LegRaiseDoors } from './run-raised-here.js';
import { paysCommitmentOf } from '../../../src/core/proposal-filing.js';
import { legPaymentsHere, raiseOrderHere, retryOrderHere, retryPaymentsHere, NotMadeHere } from './material-made-here.js';
import { filerHere, type GovernedCallDoors, onChainHere, opensFor, type RoundOnThePage, theRoundAsked, waitFor } from './governed-call-on-device.js';

/** A proposal written down and not yet sent, as the service hands it to the device that builds it. */
export interface RaiseOrderOnTheWire {
  readonly proposalId: string;
  readonly chainId: string;
  readonly order: RaiseRunOrder;
  /**
   * What the proposal written down commits to paying, from its own record: the
   * commitment its filing carries (`paysCommitmentOf`), keyed with the salt and
   * the company's asset blinding in `order.half`. The payments the vault is
   * checked for are held to it.
   */
  readonly pays: string;
}

/** A retry written down and not yet sent: its proposal, and the people it pays as positions in the leg. */
export interface RetryOrderOnTheWire extends RaiseOrderOnTheWire {
  readonly indices: ReadonlyArray<number>;
}

/**
 * What raising one leg will ask its vault to pay, as the service hands it over:
 * a kind, a token and an amount per payment, and nothing about who is paid.
 */
export interface LegPaymentsOnTheWire {
  readonly asset: string;
  /** The form the leg pays in: privately from notes, or publicly from the vault's balance. */
  readonly form?: LedgerForm;
  readonly payments: ReadonlyArray<PaymentChecked<string, string>>;
}

/** What a raise or a retry is built from and checked against, each made on this device. */
interface MadeHereDoors {
  legPayments(runId: string, viewingKey: KeysHeld, which?: { asset?: string; form?: LedgerForm }): Promise<LegPaymentsOnTheWire>;
  retryPayments(runId: string, viewingKey: KeysHeld, indices: readonly number[], which?: { asset?: string; form?: LedgerForm }): Promise<LegPaymentsOnTheWire>;
  raiseOrder(runId: string, viewingKey: KeysHeld, which?: { asset?: string; form?: LedgerForm }): Promise<RaiseOrderOnTheWire>;
  retryOrder(runId: string, viewingKey: KeysHeld, proposalId: string, which?: { asset?: string; form?: LedgerForm }): Promise<RetryOrderOnTheWire>;
}

/** Everything a raise or a retry is made from, from the company's records this device opens. */
const madeFromTheRecords = (records: CompanyRecordsHere, accountId: string): MadeHereDoors => ({
  legPayments: (runId, viewingKey, which) => legPaymentsHere(records, accountId, runId, viewingKey, which),
  retryPayments: (runId, viewingKey, indices, which) => retryPaymentsHere(records, accountId, runId, viewingKey, indices, which),
  raiseOrder: (runId, viewingKey, which) => raiseOrderHere(records, accountId, runId, viewingKey, which),
  retryOrder: (runId, viewingKey, proposalId, which) => retryOrderHere(records, accountId, runId, viewingKey, proposalId, which),
});

/** What this device makes a raise or a retry from: the company's records, and nothing else. */
const madeFor = (doors: GovernedCallDoors): MadeHereDoors => {
  if (doors.records === undefined) {
    throw new NotMadeHere('This page cannot read the company\'s records, so it cannot make a raise or a retry here. Reload '
      + 'the page to get the current version.');
  }
  return madeFromTheRecords(doors.records, doors.accountId);
};

/**
 * **WHAT IS SENT AGAIN IS A RAISE, OF THE PROPOSAL IT NAMES.** Anything else is
 * refused before the worker is asked, which also builds the run again and holds
 * it to the proposal's identity.
 */
function refuseAnOrderThatIsNotThisRaise(order: RaiseOrderOnTheWire): void {
  const o = order.order as { circuit?: unknown; proposal?: unknown };
  if (o.circuit !== 'propose' || String(o.proposal).toLowerCase() !== String(order.chainId).toLowerCase()) {
    throw new Error('what the company handed this device is not the proposal it wrote down. Nothing was built or sent.');
  }
}

/**
 * Builds the proposal written down, sends it, and waits for the chain to hold
 * it. **What it is built from is made on this device from the company's
 * records**, never handed over by the service. **The vault is checked on this
 * device first, every time** - a first send and a send again alike - because a
 * proposal written down days ago is paid from the vault as it is now. What was
 * checked is held to the commitment the proposal written down carries, and the
 * send carries only the proven call: the service is told nothing of what it pays.
 */
export async function sendRaiseFromDevice(
  doors: RaiseDoors,
  input: {
    runId: string; viewingKey: KeysHeld; asset?: string; form?: LedgerForm;
  },
): Promise<RoundOnThePage> {
  const { service } = doors;
  const asked = legAsked(input);
  const order = await madeFor(doors).raiseOrder(input.runId, input.viewingKey, asked);
  refuseAnOrderThatIsNotThisRaise(order);
  doors.progress?.('checking-the-vault');
  await refuseALegTheVaultCannotPay(doors, {
    runId: input.runId, viewingKey: input.viewingKey, ...asked, vault: order.order.run.vault, order,
  });
  return buildAndSend(doors, order, input.viewingKey, (tx) => service.send(order.proposalId, { tx, version: DEVICE_RAISE_VERSION, filer: filerHere(doors) }));
}

/**
 * Builds and proves what the service wrote down, hands it to `send` (or, on another way, to the person's wallet or the company's own service),
 * and waits for the chain to hold it.
 */
async function buildAndSend(
  doors: GovernedCallDoors, order: RaiseOrderOnTheWire, viewingKey: KeysHeld,
  send: (tx: string) => Promise<RoundOnThePage>,
): Promise<RoundOnThePage> {
  const opened = await opensFor(doors)(order.proposalId, viewingKey, true);
  doors.progress?.('reading-the-chain');
  const chain = await doors.service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account, order: order.order, material: doors.material, chain, opened,
  });
  doors.progress?.('sending');
  const answer = await handedOver(doors.handOver, {
    tx, call: { kind: 'account-call', contract: chain.account, circuit: order.order.circuit },
    viaService: () => send(tx),
    after: () => doors.service.standing(order.proposalId),
  });
  const sent = await onChainHere(doors, theRoundAsked(answer, order.proposalId, opened.chainId));
  if (sent.raisedAt) return sent;
  return waitFor(doors, 'this proposal', order.proposalId, (r) => Boolean(r.raisedAt), sent);
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
 * **WHICH LEG A CALL NAMES**: its token, and its form where the run pays that
 * token both privately and publicly, as two legs side by side. Either is left
 * out where the run leaves no doubt, and nothing else is sent.
 */
const legAsked = (input: { asset?: string; form?: LedgerForm }): { asset?: string; form?: LedgerForm } => ({
  ...(input.asset === undefined ? {} : { asset: input.asset }),
  ...(input.form === undefined ? {} : { form: input.form }),
});

/**
 * **WHETHER THE VAULT CAN PAY THIS LEG'S PAYMENTS, PRIVATE OR PUBLIC, ASKED
 * HERE BEFORE ANYTHING IS SENT.** The vault's notes are opened on this device
 * and nowhere else, and the service no longer asks about public money either,
 * so this is the one place the question is answered for both forms. The leg's
 * payments are made on this device from the company's records; nothing about
 * them goes to the service. A refusal writes nothing and spends nothing. What
 * comes back is the digest of the payments checked.
 */
async function refuseALegTheVaultCannotPay(
  doors: RaiseDoors,
  input: { runId: string; viewingKey: KeysHeld; asset?: string; form?: LedgerForm; vault: string; order?: RaiseOrderOnTheWire },
): Promise<string> {
  const leg = await madeFor(doors).legPayments(input.runId, input.viewingKey, legAsked(input));
  return refusePaymentsTheVaultCannotPay(doors, leg, input);
}

/**
 * **THE CHECK ITSELF, OVER THE PAYMENTS MADE HERE FROM THE COMPANY'S RECORDS** -
 * a leg's, or a retry's. The digest returned is over exactly those payments, in
 * their order.
 *
 * **AND, WHEN A PROPOSAL IS WRITTEN DOWN, AGAINST THAT PROPOSAL.** Its digest
 * must be the digest of these payments, and its count of payees is the count
 * the payments are checked against, so what is checked is what will be built
 * and sent. Before anything is written down there is no proposal yet, and the
 * service compares what it writes down with the digest this returns.
 */
async function refusePaymentsTheVaultCannotPay(
  doors: RaiseDoors, leg: LegPaymentsOnTheWire, input: { asset?: string; form?: LedgerForm; vault: string; order?: RaiseOrderOnTheWire },
): Promise<string> {
  if ((input.asset !== undefined && leg.asset !== input.asset)
    || (input.form !== undefined && leg.form !== undefined && leg.form !== input.form)) {
    const registry = doors.assets ?? theAssets;
    const named = (asset: string, form: LedgerForm | undefined) =>
      `${form === undefined ? '' : `${form === 'shielded' ? 'private' : 'public'} `}${symbolOf(asset, registry)}`;
    throw new Error(`The service returned the ${named(leg.asset, leg.form)} payments when the `
      + `${named(input.asset ?? leg.asset, input.form)} payments were asked for. Nothing was sent for approval and no fee was spent.`);
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
    /*
     * **WHAT IS CHECKED IS WHAT THE PROPOSAL WRITTEN DOWN COMMITS TO PAYING.**
     * The payments come from the run's record of the leg; the commitment from
     * the proposal's own record, signed by the seat that filed it. Two records,
     * so a run changed after its proposal was written down is refused here.
     */
    const half = input.order.order.half as { proposalSalt?: unknown; assetBlinding?: unknown } | undefined;
    const salt = String(half?.proposalSalt ?? '');
    const assetBlinding = String(half?.assetBlinding ?? '');
    if (!/^[0-9a-f]{64}$/u.test(salt) || !/^[0-9a-f]{64}$/iu.test(assetBlinding)
      || paysCommitmentOf({ vault: input.vault, asset: leg.asset, payments: leg.payments }, salt, assetBlinding) !== String(input.order.pays).toLowerCase()) {
      throw new Error(WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED);
    }
    if (!DIGITS.test(String(input.order.order.run.payees))) {
      throw new Error('the proposal written down for this run does not say how many people it pays, so this device cannot '
        + 'check it. Nothing was built or sent. Reload the page and send it again. If this comes back, withdraw the '
        + 'proposal and raise the run again.');
    }
    payees = BigInt(input.order.order.run.payees);
    /* A retry is raised over its leg's own tree and pays only the people it names. */
    const named = (input.order as { indices?: unknown }).indices;
    if (Array.isArray(named)) payees = BigInt(named.length);
  }
  await refuseWhatTheVaultCannotPay(doors.holdings, {
    vault: input.vault,
    asset: (doors.assets ?? theAssets).require(leg.asset as AssetId),
    total: payments.reduce((a, p) => a + p.amount, 0n),
    payees,
    payments,
  }, ['shielded', 'unshielded']);
  return checked;
}

/**
 * **ONE LEG OF A RUN, RAISED FROM THIS DEVICE** (`raiseLegHere`), and waited
 * on until the chain holds it. The proposal and the run as raised are filed with
 * the proven raise, so a device that stops part way leaves a proposal that can
 * be sent again with `sendRaiseFromDevice`, never a second proposal over the
 * same people.
 */
export async function raiseRunOnDevice(
  doors: LegRaiseDoors,
  input: { runId: string; viewingKey: KeysHeld; asset?: string; form?: LedgerForm; vault: string; opensAt: string; closesAt: string },
): Promise<RoundOnThePage> {
  const sent = await onChainHere(doors, await raiseLegHere(doors, input));
  if (sent.raisedAt) return sent;
  return waitFor(doors, 'this proposal', sent.id, (r) => Boolean(r.raisedAt), sent);
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

/**
 * **A RETRY WRITTEN DOWN AND NOT YET SENT, BUILT AND SENT FROM THIS DEVICE.**
 * The vault is checked here for exactly the retry's payments right before the
 * send, every time, as a leg's are.
 */
export async function sendRetryFromDevice(
  doors: RaiseDoors,
  input: {
    runId: string; viewingKey: KeysHeld; asset?: string; form?: LedgerForm; proposalId: string;
  },
): Promise<RoundOnThePage> {
  const { service } = doors;
  const asked = legAsked(input);
  const order = await madeFor(doors).retryOrder(input.runId, input.viewingKey, input.proposalId, asked);
  if (order.proposalId !== input.proposalId) {
    throw new Error('the retry this device was handed is not the one on record. Reload the page and try again. Nothing '
      + 'was built or sent.');
  }
  refuseAnOrderThatIsNotThisRaise(order);
  doors.progress?.('checking-the-vault');
  await refusePaymentsTheVaultCannotPay(doors,
    await madeFor(doors).retryPayments(input.runId, input.viewingKey, order.indices, asked), { ...asked, vault: order.order.run.vault, order });
  return buildAndSend(doors, order, input.viewingKey, (tx) => service.send(order.proposalId, { tx, version: DEVICE_RAISE_VERSION, filer: filerHere(doors) }));
}

/**
 * **A RETRY OF SOME OF ONE LEG'S PEOPLE, RAISED FROM THIS DEVICE** over a tree
 * of its own (`raiseRetryHere`), and waited on until the chain holds it. A
 * device that stops part way leaves a retry written down that
 * `sendRetryFromDevice` sends as itself.
 */
export async function raiseRetryOnDevice(
  doors: LegRaiseDoors,
  input: {
    runId: string; viewingKey: KeysHeld; asset?: string; form?: LedgerForm; indices: ReadonlyArray<number>;
    vault: string; opensAt: string; closesAt: string;
  },
): Promise<RoundOnThePage> {
  const sent = await onChainHere(doors, await raiseRetryHere(doors, input));
  if (sent.raisedAt) return sent;
  return waitFor(doors, 'this retry', sent.id, (r) => Boolean(r.raisedAt), sent);
}
