import type { Asset, LedgerForm } from './assets.js';
import { formatAmount, ledgerFormOf } from './assets.js';

/**
 * **WHAT A VAULT HOLDS, ASKED OF THE CHAIN, BEFORE ANYBODY IS ASKED TO PAY FOR A
 * PROPOSAL THAT SPENDS IT.**
 *
 * A proposal that moves money is raised, approved by the account's signers, and
 * only then presented at the vault. Every one of those steps costs a fee. A
 * proposal the vault cannot pay fails at the last of them, so each fee before it
 * was spent for nothing. This is the question asked before the first.
 */

/**
 * **WHAT A READ OF A VAULT CAN COME BACK AS, AND THERE ARE THREE.**
 *
 * `unreadable` and `contradicted` are different answers with opposite
 * consequences. The chain not answering is retried. A record of the vault's
 * private notes that the chain has contradicted is not fixed by asking again:
 * that record is rebuilt from the chain first.
 */
export type HoldingAnswer =
  | { readonly of: 'held'; readonly amount: bigint }
  | { readonly of: 'unreadable'; readonly why: string }
  | { readonly of: 'contradicted'; readonly why: string };

/** Whether the vault can make each payment, in order, as the chain says it holds its money now. */
export type FitAnswer =
  | { readonly of: 'fits' }
  | { readonly of: 'does-not-fit'; readonly why: string }
  | { readonly of: 'unreadable'; readonly why: string }
  | { readonly of: 'contradicted'; readonly why: string };

/**
 * **THE READER.**
 *
 * `held` is what one vault holds of one token in one form. A public balance is
 * the ledger's own figure for the contract. A private one is the vault's notes,
 * each of which the chain's set of the vault's commitments must hold, with
 * nothing held that the notes do not account for.
 *
 * `fits` is the question a total cannot answer. A private payment is made from
 * one note, and notes are not merged by paying, so a vault holding two notes of
 * 60 holds 120 and cannot make one payment of 100. It walks the payments through
 * the same choice of note a payment makes.
 */
export interface VaultHoldings {
  held(vault: string, form: LedgerForm, token: string): Promise<HoldingAnswer>;
  fits(vault: string, payments: ReadonlyArray<PaymentAsked>): Promise<FitAnswer>;
}

/**
 * **THE READER A SERVICE HAS WHEN NOBODY HANDED IT ONE, AND IT KNOWS NOTHING.**
 *
 * So every proposal that moves money is refused, by name, before a fee. A build
 * that cannot say what a vault holds has no way to keep a proposal it cannot pay
 * off the chain, and the refusal says that is what is missing.
 */
export class NoVaultHoldingsReader extends Error {
  constructor() {
    super('this service was not given a way to read what a vault holds');
    this.name = 'NoVaultHoldingsReader';
  }
}

export const noVaultHoldingsReader: VaultHoldings = Object.freeze({
  held: async (): Promise<HoldingAnswer> => { throw new NoVaultHoldingsReader(); },
  fits: async (): Promise<FitAnswer> => { throw new NoVaultHoldingsReader(); },
});

/** One payment as a vault would be asked to make it. */
export interface PaymentAsked {
  readonly payee: { readonly kind: LedgerForm };
  readonly token: string;
  readonly amount: bigint;
}

/** What a proposal asks one vault to pay, and in what. */
export interface ProposalAsks {
  /** The vault that will be presented with the proposal. */
  readonly vault: string;
  /** The asset the proposal settles, from the registry the service was given. */
  readonly asset: Asset;
  /** The amount the signers approve, in the asset's smallest unit. */
  readonly total: bigint;
  /** How many payments the proposal is raised over. */
  readonly payees: bigint;
  /** Each payment, as the vault will be asked to make it. */
  readonly payments: ReadonlyArray<PaymentAsked>;
}

/**
 * **A PROPOSAL THIS SERVICE WILL NOT RAISE, AND EXACTLY WHY.**
 *
 * Carries what a caller needs to act on without parsing a sentence. The vault's
 * address is a property and is not written into the sentence by this code,
 * because a message is shown on a screen. A reason passed up from a read is
 * quoted as the read gave it.
 */
export class VaultCannotPayThisProposal extends Error {
  constructor(
    message: string,
    readonly vault: string,
    readonly asset: string,
    readonly form: LedgerForm | null,
    readonly held: bigint | null,
    readonly asked: bigint | null,
    readonly why:
      | 'not-the-proposal' | 'no-such-form' | 'misnamed' | 'short' | 'does-not-fit'
      | 'unreadable' | 'contradicted' | 'no-reader' | 'failed',
  ) {
    super(message);
    this.name = 'VaultCannotPayThisProposal';
  }
}

const inForm = (form: LedgerForm): string => (form === 'shielded' ? 'privately' : 'publicly');

const NOTHING_RAISED = 'Nothing was raised and no fee was spent.';

const DEPOSIT = "through the vault's own deposit";

/**
 * **REFUSES A PROPOSAL THE VAULT CANNOT PAY. RETURNS ONLY WHEN IT CAN.**
 *
 * In this order, and each refusal is before any fee:
 *
 *   1. every payment names its money by the token the asset's own row gives for
 *      the form its payee is paid in. A payment that spells the same asset
 *      differently would be refused at the vault after the approvals, so it is
 *      refused here, with both spellings;
 *   2. the payments are the proposal the signers approve: as many as its payees,
 *      adding up to its total;
 *   3. for each form and token the proposal pays in, the vault holds at least
 *      what the proposal asks of it, as the chain reports it now;
 *   4. and the vault can make each payment in turn, which for private money is
 *      a question about single notes and not about a total.
 *
 * **WHAT IT DOES NOT ESTABLISH, SAID HERE.** A vault that can pay when the
 * proposal is raised can spend the money on something else before the proposal
 * is paid. That is decided at the moment of payment, where the vault refuses a
 * payment it cannot make.
 *
 * **`readFor` IS WHICH FORMS OF MONEY THIS READER CAN ANSWER FOR**, both when
 * it is omitted. A vault's private money is readable only where its note pool
 * is opened, which is a signer's device, and its public money is readable by
 * anybody. So the two halves of one proposal can be asked by two readers in two
 * places, each through this same function: steps 1 and 2 are always asked of
 * every payment, and steps 3 and 4 only of the payments in the forms named.
 * The two forms are held apart - notes and a contract balance - so a payment in
 * one never draws on the other, and asking them separately loses nothing.
 */
export async function refuseWhatTheVaultCannotPay(
  reader: VaultHoldings, proposal: ProposalAsks,
  readFor: ReadonlyArray<LedgerForm> = ['shielded', 'unshielded'],
): Promise<void> {
  const { asset, vault } = proposal;
  const cannot = (
    message: string, why: VaultCannotPayThisProposal['why'], form: LedgerForm | null = null,
    held: bigint | null = null, asked: bigint | null = null,
  ): VaultCannotPayThisProposal =>
    new VaultCannotPayThisProposal(
      `${message} ${NOTHING_RAISED}`, vault, asset.code, form, held, asked, why);

  /* The answers a read can give that are not an amount, said the same way for both questions. */
  const notAnAnswer = (
    answer: { of: string; why?: unknown } | unknown, what: string, form: LedgerForm | null,
    asked: bigint | null,
  ): VaultCannotPayThisProposal => {
    const a = answer as { of?: unknown; why?: unknown } | null;
    if (a?.of === 'unreadable') {
      return cannot(
        `what the vault holds ${what} could not be read from the chain (${String(a.why)}), and a `
        + 'proposal is not raised on a guess about the money that pays it. If the chain was slow to '
        + 'answer, try again. If the same reason keeps coming back, read it: it says what is wrong (an '
        + 'indexer that is down, a vault this network does not have, or an answer this service cannot '
        + 'read), and none of those is a reason to deposit more.',
        'unreadable', form, null, asked);
    }
    if (a?.of === 'contradicted') {
      return cannot(
        `the record of the vault's private notes disagrees with the chain (${String(a.why)}), `
        + 'so the vault has no balance a proposal can be raised against. Unless a deposit or a payment '
        + 'was still being written down when the vault was read, trying again does not change that: the '
        + 'record is rebuilt from the chain and the vault\'s payment history first, and no screen does '
        + 'that today.',
        'contradicted', form, null, asked);
    }
    return cannot(
      `what the vault holds ${what} came back as something that is not an answer, and a proposal is `
      + 'not raised on a guess about the money that pays it.', 'failed', form, null, asked);
  };

  const ask = async <T>(read: () => Promise<T>, what: string, form: LedgerForm | null, asked: bigint | null) => {
    try {
      return await read();
    } catch (cause) {
      if (cause instanceof NoVaultHoldingsReader) {
        throw cannot(
          'this service cannot read what a vault holds, so it cannot confirm the vault can pay this '
          + "proposal. A proposal that moves money is raised only by a service given the chain's "
          + 'reader of vault balances.', 'no-reader', form, null, asked);
      }
      throw cannot(
        `what the vault holds ${what} could not be established (${(cause as Error)?.message ?? String(cause)}), `
        + 'and a proposal is not raised on a guess about the money that pays it.', 'failed', form, null, asked);
    }
  };

  if (proposal.payments.length === 0) {
    throw cannot('this proposal pays nobody, so there is nothing a vault could be asked to pay.', 'not-the-proposal');
  }
  if (BigInt(proposal.payments.length) !== proposal.payees) {
    throw cannot(
      `this proposal is raised over ${proposal.payees} payments and ${proposal.payments.length} were `
      + 'handed in to check against the vault, so what was checked is not what the signers approve.',
      'not-the-proposal');
  }

  const asks = new Map<string, { form: LedgerForm; token: string; amount: bigint }>();
  let sum = 0n;
  for (const [at, payment] of proposal.payments.entries()) {
    const form = payment.payee?.kind;
    if (form !== 'shielded' && form !== 'unshielded') {
      throw cannot(
        `payment ${at + 1} on this proposal is to a payee that is neither private nor public.`,
        'not-the-proposal');
    }
    const answer = ledgerFormOf(asset, form);
    if (answer.of === 'no-such-form') throw cannot(answer.why, 'no-such-form', form);
    if (payment.token !== answer.token) {
      throw cannot(
        `payment ${at + 1} on this proposal names its money as ${payment.token}, and ${asset.code} `
        + `paid ${inForm(form)} is ${answer.token} on the ledger. A vault pays out of the token a `
        + 'payment names, so this proposal would be approved and then refused by the vault. Its '
        + "payments have to be drawn up again from the asset's row. A proposal already raised under "
        + 'the other name cannot be paid either, and it can be withdrawn until its window opens.',
        'misnamed', form);
    }
    if (typeof payment.amount !== 'bigint' || payment.amount <= 0n) {
      throw cannot(`payment ${at + 1} on this proposal is not a positive amount.`, 'not-the-proposal', form);
    }
    sum += payment.amount;
    const key = `${form}:${payment.token}`;
    const prior = asks.get(key);
    asks.set(key, { form, token: payment.token, amount: (prior?.amount ?? 0n) + payment.amount });
  }
  if (sum !== proposal.total) {
    throw cannot(
      `this proposal's payments add up to ${formatAmount(sum, asset)} ${asset.code} and the signers `
      + `would approve ${formatAmount(proposal.total, asset)} ${asset.code}.`, 'not-the-proposal');
  }

  const read = new Set(readFor);
  for (const { form, token, amount } of asks.values()) {
    if (!read.has(form)) continue;
    const what = `of ${asset.code} ${inForm(form)}`;
    const answer = await ask(() => reader.held(vault, form, token), what, form, amount);
    if (answer?.of !== 'held' || typeof answer.amount !== 'bigint' || answer.amount < 0n) {
      throw notAnAnswer(answer, what, form, amount);
    }
    if (answer.amount < amount) {
      throw cannot(
        `the vault holds ${formatAmount(answer.amount, asset)} ${asset.code} ${inForm(form)} and this `
        + `proposal asks it to pay ${formatAmount(amount, asset)}. Deposit at least `
        + `${formatAmount(amount - answer.amount, asset)} ${asset.code} into the vault ${inForm(form)}, `
        + `${DEPOSIT}, then raise the proposal again.`, 'short', form, answer.amount, amount);
    }
  }

  const asked = proposal.payments.filter(p => read.has(p.payee.kind));
  if (asked.length === 0) return;
  const askedSum = asked.reduce((a, p) => a + p.amount, 0n);
  const what = `of ${asset.code}`;
  const fit = await ask(() => reader.fits(vault, asked), what, null, askedSum);
  if (fit?.of === 'fits') return;
  if (fit?.of === 'does-not-fit') {
    const privately = asked.some(p => p.payee.kind === 'shielded');
    const reason = String(fit.why).replace(/[.\s]+$/, '');
    throw cannot(privately
      ? `the vault holds enough ${asset.code} in total, but its notes cannot make each payment in turn `
        + `(${reason}). A private payment is made from one note at least its size, and paying does not `
        + 'combine notes, so every payment the present notes cannot cover needs a note of its own. '
        + `Deposit those ${DEPOSIT}, then raise the proposal again.`
      : `the vault cannot make each payment in turn (${reason}). Read what it holds again, then raise `
        + 'the proposal again.',
      'does-not-fit', null, null, askedSum);
  }
  throw notAnAnswer(fit, what, null, askedSum);
}
