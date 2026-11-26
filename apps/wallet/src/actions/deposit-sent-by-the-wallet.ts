import type { Identity } from 'midnight-identity/keys/derivation';
import { DEPOSIT_CLOCKS_MAY_DIFFER_MS, DEPOSIT_TIME_TO_LIVE_MS } from '../../../../packages/web-shared/src/vault-private-deposit.js';
import { CompanyChangedMeanwhile } from '../../../../packages/web-shared/src/company-view-probe.js';
import type { VaultService } from '../../../../packages/web-shared/src/vault-service.js';
import { timeShown } from '../../../../packages/web-shared/src/vault-step-reads.js';
import type { BalanceDoors } from '../chain/balance-for-page.js';
import { dustFromSpecks, exactSpecks } from '../chain/amount.js';
import { finishedSentWithOwnDust, OwnFeeNotPaid, type OwnFeeFacade, type OwnFeeUnpaid } from '../chain/finished-paid-with-own-dust.js';
import { FeeRefused, said } from '../chain/sent-straight-to-the-chain.js';
import type { CompanyReach } from './company-reach.js';
import { ownFeeConfirmed } from './hand-over-in-the-wallet.js';
import type { StepContext, Words } from './definition.js';

/*
 * **A DEPOSIT THE COMPANY'S FEE PAYER COULD NOT PAY FOR IS SENT BY THE WALLET ITSELF, ONCE THE PERSON CONFIRMS THE FEE
 * FROM THEIR OWN DUST.** The service's word that it sent nothing is never taken as the deposit never sent: whatever
 * this wallet does after it, the deposit stays on its way on this device until its window closes. When this wallet
 * sends nothing (the person says no, too little DUST, or the network refused it), the person is told when the vault
 * takes a new deposit from this device.
 */

/** The paying account's doors, as the deposit opens them, with its facade for paying a fee from its own DUST. */
export type DepositBalanceDoors = BalanceDoors & {
  readonly stop?: () => Promise<void>;
  /** The same facade, with its DUST part started. Absent where this wallet cannot pay a fee from its DUST. */
  readonly ownFee?: () => Promise<OwnFeeFacade>;
};

/** Why this wallet sent nothing after the service refused the deposit. */
export type DepositUnsent = OwnFeeUnpaid | 'network-refused';

/** The paying account's wallet for one deposit step: opened once, kept until the service has answered, stopped at the step's end. */
export interface DepositWallet {
  readonly doors: () => DepositBalanceDoors;
  /** Records when the payment was asked for, which is after the deposit's window started. */
  readonly paying: () => void;
  /** When this device takes a new deposit into the vault again, at the latest. */
  readonly freesAt: () => number;
  /** Why this wallet sent nothing after the service refused, and what it said, or null. */
  readonly unsent: () => { readonly why: DepositUnsent; readonly says: string } | null;
  readonly sentNothing: (why: DepositUnsent, says: string) => void;
  readonly stop: () => Promise<void>;
}

export function depositWalletFor(
  balance: (identity: Identity, account: number) => DepositBalanceDoors, identity: Identity, account: number, now: () => number,
): DepositWallet {
  let doors: DepositBalanceDoors | null = null;
  let paidAt: number | null = null;
  let unsent: { why: DepositUnsent; says: string } | null = null;
  return {
    doors: () => (doors ??= balance(identity, account)),
    paying: () => { paidAt ??= now(); },
    freesAt: () => (paidAt ?? now()) + DEPOSIT_TIME_TO_LIVE_MS + DEPOSIT_CLOCKS_MAY_DIFFER_MS,
    unsent: () => unsent,
    sentNothing: (why, says) => { unsent = { why, says }; },
    stop: async () => {
      const opened = doors;
      doors = null;
      await opened?.stop?.().catch(() => { /* stopping a wallet that failed to start has nothing to give back */ });
    },
  };
}

const PLAIN_REF = /^[A-Za-z0-9._:-]{1,128}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const bare = (h: string): string => h.toLowerCase().replace(/^0x/u, '');

/** Any failure of the send, as the deposit's step reads it: it may still be sent. */
const mayStillBeSent = (e: unknown): Error =>
  new Error(`the page did not confirm it sent the deposit (${said(e)}); it may still be sent.`);

/** The fee payer's code on a refusal that says nothing was sent, or null. */
const refusedFor = (e: unknown): 'fee-not-paid' | 'network-refused' | null => {
  const r = e as { nothingWasSent?: unknown; code?: unknown } | null;
  if (r === null || typeof r !== 'object' || r.nothingWasSent !== true) return null;
  return r.code === 'fee-not-paid' || r.code === 'network-refused' ? r.code : null;
};

/** What the person is shown before this wallet pays the deposit's fee from their own DUST. */
export const feeLines = (fee: bigint, until: number): readonly Words[] => [
  { key: 'act.private-deposit.fee.service' },
  { key: 'act.private-deposit.fee.own', values: { fee: dustFromSpecks(fee), specks: exactSpecks(fee) } },
  { key: 'act.private-deposit.fee.if-not', values: { until: timeShown(until) } },
];

/**
 * The deposit's send: through the company's service, written through the step's view; when its fee payer refused with
 * nothing sent, by this wallet with the fee from the person's own DUST, once they confirm it, checked against the
 * reading taken before the refused write. Every failure reads as "it may still be sent", but the view's own refusal
 * before anything left: another signer's change, or a vault the account no longer adopts.
 */
export function depositSentFor(
  ctx: Pick<StepContext, 'signal' | 'show' | 'sendStraight'> & Partial<Pick<StepContext, 'confirmFee'>>,
  r: Pick<CompanyReach, 'stepView'>, wallet: DepositWallet, now: () => number,
): VaultService['deposit'] {
  const byTheWallet = async (vault: string, tx: string, refused: unknown): Promise<{ txRef: string; transactionHash: string | null }> => {
    const doors = wallet.doors();
    if (doors.ownFee === undefined) {
      wallet.sentNothing('not-paid', 'this wallet cannot pay a fee from its DUST here');
      throw mayStillBeSent(refused);
    }
    try {
      const id = await ctx.sendStraight((door) => finishedSentWithOwnDust({ facade: doors.ownFee!, signSegment: doors.signSegment }, tx, {
        now, stillWanted: () => !ctx.signal.aborted,
        confirm: (fee) => ownFeeConfirmed(ctx, feeLines(fee, wallet.freesAt()), door.ready, fee),
        handedOver: door.handedOver,
      }), [{ vault }]);
      ctx.show({ key: 'act.fell-back.own-dust' });
      return { txRef: PLAIN_REF.test(id) ? id : '', transactionHash: null };
    } catch (e) {
      if (e instanceof FeeRefused) wallet.sentNothing(e instanceof OwnFeeNotPaid ? e.why : 'not-paid', said(e));
      else if ((e as { thisSendNotSent?: unknown } | null)?.thisSendNotSent === true) throw e;
      throw mayStillBeSent(e);
    }
  };
  return async (v, tx) => {
    let answer: { txRef?: unknown; transactionHash?: unknown } | null;
    try {
      answer = (await r.stepView.current().write([{ to: 'vault-send', tx, calls: [{ act: 'deposit', vault: v }] }]))[0] as typeof answer;
    } catch (e) {
      if (e instanceof CompanyChangedMeanwhile || (e as { thisSendNotSent?: unknown } | null)?.thisSendNotSent === true) {
        throw Object.assign(e as Error, { nothingWasSent: true });
      }
      const code = refusedFor(e);
      if (code === 'fee-not-paid') return byTheWallet(v, tx, e);
      if (code === 'network-refused') wallet.sentNothing('network-refused', said(e));
      throw mayStillBeSent(e);
    }
    const ref = typeof answer?.txRef === 'string' && PLAIN_REF.test(answer.txRef) ? answer.txRef : '';
    const hash = typeof answer?.transactionHash === 'string' && HEX64.test(bare(answer.transactionHash)) ? bare(answer.transactionHash) : null;
    return { txRef: ref, transactionHash: hash };
  };
}
