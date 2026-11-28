/**
 * **A DEPOSIT INTO A VAULT, AND THE BOOKKEEPING OF THE VAULT'S NOTES, ANSWERED IN THE VAULT WORKER**: the private
 * and public deposits built and proved, which notes pay a payment, the notes left after one, a payment confirmed
 * from its transaction's events, and which transaction created a note.
 */
import {
  buildDeposit,
  buildPublicDeposit,
  confirmPayment,
  notesForPayment,
  paymentsFitNotes,
  poolAfterPayment,
  type EventOnTheWire,
  type VaultBuilderDeps
} from './vault-builder.js';
import { fromBase64, toBase64 } from './base64-bytes.js';
import { establishCreatingTransaction, NoteIndexRefused, type ServedEvent } from '../../../src/midnight/note-index.js';
import type { Hex } from '../../../src/core/crypto.js';
import type { CreatingTransactionAnswer, VaultAnswer, VaultAsk } from './vault-worker-client.js';
import type { WorkerDeps } from './vault-worker-deps.js';

/** The served events, with each position read as the number it is. */
const servedOf = (events: readonly EventOnTheWire[]): ServedEvent[] =>
  events.map((e) => ({
    transactionHash: e.transactionHash,
    details: {
      tag: e.details.tag,
      ...(e.details.commitment === undefined ? {} : { commitment: e.details.commitment }),
      ...(e.details.contract === undefined ? {} : { contract: e.details.contract }),
      ...(e.details.mtIndex === undefined || !/^[0-9]+$/u.test(e.details.mtIndex)
        ? {}
        : { mtIndex: BigInt(e.details.mtIndex) })
    }
  }));

/**
 * **WHICH TRANSACTION CREATED A NOTE, AS THE EVENTS OF THE TRANSACTION NAMED
 * FOR IT SAY.** The events must carry exactly one output with this commitment,
 * owned by this vault. A refusal is `refused`; anything else that stops the
 * answer is `unreadable`, and asking again may answer it.
 */
export const creatingTransactionOfNote = (input: {
  readonly vault: string;
  readonly commitment: string;
  readonly transactionHash: string;
  readonly events: readonly EventOnTheWire[];
}): CreatingTransactionAnswer => {
  try {
    const { createdIn } = establishCreatingTransaction(servedOf(input.events), {
      vault: input.vault as Hex,
      commitment: input.commitment,
      transaction: { hash: input.transactionHash as Hex }
    });
    return { state: 'found', createdIn };
  } catch (cause) {
    if (cause instanceof NoteIndexRefused) return { state: 'refused' };
    return { state: 'unreadable' };
  }
};

/** The deposit and note asks; any other ask is answered elsewhere, so this gives undefined. */
export const depositsAndNotesAnswered = async (
  _d: WorkerDeps,
  withNetwork: VaultBuilderDeps,
  ask: VaultAsk
): Promise<VaultAnswer | undefined> => {
  switch (ask.ask) {
    case 'deposit': {
      const built = await buildDeposit(withNetwork, {
        vault: ask.vault,
        coin: { nonce: ask.coin.nonce, token: ask.coin.token, value: BigInt(ask.coin.value) },
        state: fromBase64(ask.state),
        /* An ask with no parameters is passed on empty, so the builder's refusal names what is missing. */
        parameters: typeof ask.parameters === 'string' ? fromBase64(ask.parameters) : new Uint8Array(0)
      });
      return { id: ask.id, ok: true, ask: 'deposit', tx: toBase64(built.proven) };
    }
    case 'public-deposit': {
      const amount = typeof ask.amount === 'string' && /^[0-9]+$/u.test(ask.amount) ? BigInt(ask.amount) : 0n;
      const built = await buildPublicDeposit(withNetwork, {
        vault: ask.vault,
        token: ask.token,
        amount,
        state: fromBase64(ask.state),
        parameters: typeof ask.parameters === 'string' ? fromBase64(ask.parameters) : new Uint8Array(0)
      });
      return { id: ask.id, ok: true, ask: 'public-deposit', tx: toBase64(built.proven) };
    }
    case 'notes-for-payment': {
      const notes = notesForPayment({ notes: ask.notes, token: ask.token, amount: ask.amount });
      return { id: ask.id, ok: true, ask: 'notes-for-payment', notes };
    }
    case 'payments-fit': {
      return {
        id: ask.id,
        ok: true,
        ask: 'payments-fit',
        answer: paymentsFitNotes({ notes: ask.notes, payments: ask.payments })
      };
    }
    case 'after-payment': {
      const notes = poolAfterPayment({
        notes: ask.notes,
        spent: ask.spent,
        ...(ask.further === undefined ? {} : { further: ask.further }),
        amount: ask.amount,
        change: ask.change,
        createdIn: ask.createdIn
      });
      return { id: ask.id, ok: true, ask: 'after-payment', notes };
    }
    case 'confirm-payment': {
      const confirmation = await confirmPayment({
        vault: ask.vault,
        transactionHash: ask.transactionHash,
        change: ask.change,
        events: ask.events,
        ...(ask.merge === true ? { merge: true as const } : {})
      });
      return { id: ask.id, ok: true, ask: 'confirm-payment', confirmation };
    }
    case 'creating-transaction': {
      const answer = creatingTransactionOfNote({
        vault: ask.vault,
        commitment: ask.commitment,
        transactionHash: ask.transactionHash,
        events: ask.events
      });
      return { id: ask.id, ok: true, ask: 'creating-transaction', answer };
    }
    default:
      return undefined;
  }
};
