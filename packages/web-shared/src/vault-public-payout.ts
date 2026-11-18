/**
 * **A PUBLIC PAYMENT OUT OF A COMPANY'S VAULT** (`payPubliclyFromCompanyVault`),
 * and the failure that says it may have been sent.
 */
import type { Hex } from '../../../src/core/crypto.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import { handedOver, type HandOver } from './hand-over.js';
import type { AccountAddress } from 'midnight-identity/profile/company-label';
import type { VaultBuilderClient } from './vault-worker-client.js';
import type { VaultService } from './vault-service.js';
import { sentNothing } from './vault-start-stops.js';
import { type ChainHereDoors, type Pacing, type VaultOnChainDoors, until } from './vault-doors.js';
import { chainAtOneBlockHere } from './vault-read-here.js';
import { NAMED_BY_NOTHING } from './vault-step-reads.js';
import { fundableOrThrow } from './vault-fundable-here.js';

/**
 * **A PUBLIC PAYMENT MAY HAVE BEEN SENT, AND THIS DEVICE HAS NOT SEEN IT
 * RECORDED.** The money may have moved. Raised for every failure after the
 * service began sending, so no screen reads it as a payment that did not
 * happen. A public payment spends no note and changes no record on this
 * device, so there is nothing here to rebuild.
 */
export class PublicPaymentNotYetSeen extends Error {
  constructor(readonly vault: Hex, readonly txRef: string, why?: string) {
    super(`the payment may have been sent${txRef === '' ? '' : ` (${txRef})`} and this device has not seen it land`
      + `${why === undefined ? '' : ` (${why})`}, so it may still land. Do not pay this person again: open the run `
      + 'later, and it shows them paid once the chain does.');
    this.name = 'PublicPaymentNotYetSeen';
  }
}

interface PublicPayoutDoors extends Pacing {
  readonly service: VaultService;
  /** Where the payout goes: through the service (the default), or straight to the chain from the person's wallet. */
  readonly handOver?: HandOver;
  readonly builder: VaultBuilderClient;
  readonly account: AccountAddress;
  readonly onChain: VaultOnChainDoors['onChain'];
  readonly indexer: ChainHereDoors['indexer'];
  readonly now?: () => Date;
  /**
   * Whether the company's account records this payment as made, asked again
   * after it is sent: `true` once it does, `false` while it does not, `null`
   * when this deployment cannot say.
   */
  readonly paidYet: () => Promise<boolean | null>;
}

/**
 * **ONE PERSON PAID PUBLICLY OUT OF THE COMPANY'S VAULT, AGAINST A ROUND THE
 * COMPANY APPROVED.** `order` and `payment` are what the service rebuilt from
 * that round, and the payment is a public one: it is refused here unless the
 * leg names it public, and the builder refuses its address unless it decodes
 * as a public one.
 *
 * **NOTHING ON THIS DEVICE CHANGES.** No note is chosen or spent and nothing is
 * written to the vault's record. The payment is done when the company's account
 * records it, which is the same record that refuses paying this person twice.
 */
export async function payPubliclyFromCompanyVault(
  doors: PublicPayoutDoors,
  input: { readonly order: PrivatePaymentOrderOnTheWire; readonly payment: PrivatePaymentOnTheWire },
): Promise<{ txRef: string }> {
  const { order, payment } = input;
  const vault = order.vault.toLowerCase() as Hex;
  if (payment.kind !== 'unshielded') {
    throw new Error('this payment is not a public one, so it is not paid publicly. Nothing was sent.');
  }
  if (payment.paid === true) {
    throw new Error('the company\'s account already records this person paid for this run. Nothing was sent.');
  }
  const seconds = BigInt(Math.floor((doors.now ?? (() => new Date()))().getTime() / 1000));
  if (seconds < BigInt(order.opensAt) || seconds >= BigInt(order.closesAt)) {
    throw new Error('this run can be paid only inside the window its signers approved, and it is not open now. '
      + 'Nothing was sent.');
  }
  doors.progress?.('reading the chain');
  const answer = await fundableOrThrow(doors, vault);
  if (answer.of === 'not-on-chain') {
    throw new Error('the chain, as this device read it, does not show this vault, so nothing is paid out of it. Nothing was '
      + `sent. Reason: ${answer.why}`);
  }
  if (answer.of !== 'fundable') {
    throw new Error('No payment can be made out of this vault yet, so none was prepared or recorded. Nothing was '
      + `sent. Reason: ${answer.why}`);
  }
  const chain = await chainAtOneBlockHere(doors, vault);

  doors.progress?.('building the payment');
  const { payments: _all, ...round } = order;
  const built = await doors.builder.payoutPublicly({
    vault, account: chain.account, order: round, payment,
    chain: {
      blockHash: chain.blockHash, vaultState: chain.vaultState, zswapState: chain.zswapState,
      parameters: chain.parameters, accountState: chain.accountState,
    },
  });

  doors.progress?.('sending the payment');
  let sent: { txRef: string; transactionHash: string | null };
  try {
    const tx = built.tx;
    sent = await handedOver(doors.handOver, {
      tx, call: { kind: 'public-payout', contract: vault, circuit: 'payoutUnshielded', account: doors.account },
      viaService: () => doors.service.payoutPublicly(vault, tx), after: async () => NAMED_BY_NOTHING,
    });
  } catch (e) {
    if (sentNothing(e)) throw e;
    throw new PublicPaymentNotYetSeen(vault, '', (e as Error)?.message ?? String(e));
  }

  /* ---- from here the money may have moved, and every failure says so ---- */
  try {
    doors.progress?.('waiting for the payment');
    const recorded = await until(doors, async () => ((await doors.paidYet().catch(() => null)) === true ? true : null));
    if (recorded === null) throw new PublicPaymentNotYetSeen(vault, sent.txRef);
    doors.progress?.('done');
    return { txRef: sent.txRef };
  } catch (e) {
    if (e instanceof PublicPaymentNotYetSeen) throw e;
    throw new PublicPaymentNotYetSeen(vault, sent.txRef, (e as Error)?.message ?? String(e));
  }
}
