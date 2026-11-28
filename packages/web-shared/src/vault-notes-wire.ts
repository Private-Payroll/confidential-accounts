/**
 * **THE VAULT'S NOTES AS THEY CROSS FROM THE PAGE, AND WHAT A PAYMENT DOES TO THEM**: which notes a payment
 * spends, the pool after it landed, and whether a payment's own events say it landed as built.
 */
import type { Hex } from '../../../src/core/crypto.js';
import {
  establishCreatingTransaction,
  type EventOnTheWire,
  type ServedEvent,
  theTransactionTheseEventsAreFrom,
  vaultNoteCommitment
} from '../../../src/midnight/note-index.js';
import { afterStep, type Note, notesToSpend } from '../../../src/midnight/vault-notes.js';
import type { VaultCoin } from '../../../src/midnight/vault-coins.js';
import { HEX64 } from './vault-builder.js';

/** A note the pool holds, as it crosses from the page. */
export interface NoteOnTheWire {
  readonly nonce: string;
  readonly token: string;
  readonly value: string;
  readonly createdIn?: string;
}

/** One zswap event of one transaction, as it crosses to this worker. */

export const DIGITS = /^[0-9]+$/u;

export const noteFromWire = (n: NoteOnTheWire): Note => {
  if (
    !HEX64.test(n.nonce) ||
    !HEX64.test(n.token) ||
    !DIGITS.test(n.value) ||
    (n.createdIn !== undefined && !HEX64.test(n.createdIn))
  ) {
    throw new Error('the pool handed over holds a note that is not one, so nothing was chosen.');
  }
  const checked = n as unknown as {
    readonly nonce: Hex;
    readonly token: Hex;
    readonly value: string;
    readonly createdIn?: Hex;
  };
  return {
    nonce: checked.nonce,
    token: checked.token,
    value: BigInt(checked.value),
    ...(checked.createdIn === undefined ? {} : { createdIn: checked.createdIn })
  };
};

export const noteToWire = (n: Note): NoteOnTheWire => ({
  nonce: n.nonce,
  token: n.token,
  value: n.value.toString(),
  ...(n.createdIn === undefined ? {} : { createdIn: n.createdIn })
});

/**
 * **WHICH NOTES A PAYMENT SPENDS**, chosen by the one function every payment
 * chooses by, from the pool the page opened: in place order, the first the one
 * the vault is offered, the rest the further notes the payment takes. Refuses
 * with what the pool holds.
 */
export function notesForPayment(input: {
  readonly notes: readonly NoteOnTheWire[];
  readonly token: string;
  readonly amount: string;
}): NoteOnTheWire[] {
  if (!HEX64.test(input.token) || !DIGITS.test(input.amount)) {
    throw new Error('this payment names no token or amount a note could cover, so nothing was chosen.');
  }
  return notesToSpend(input.notes.map(noteFromWire), input.token as Hex, BigInt(input.amount)).map(noteToWire);
}

/**
 * **THE POOL AFTER A PAYMENT LANDED**: every note it spent gone and its change
 * added, applied to what the pool holds now and not to the copy the payment was
 * built from. The same function the operator's client applies.
 */
export function poolAfterPayment(input: {
  readonly notes: readonly NoteOnTheWire[];
  /** The note the payment spent first. */
  readonly spent: string;
  /** Every further note it spent, in place order; absent or empty when it spent one. */
  readonly further?: readonly string[];
  readonly amount: string;
  readonly change: NoteOnTheWire | null;
  readonly createdIn: string | null;
}): NoteOnTheWire[] {
  const further = input.further ?? [];
  if (
    !HEX64.test(input.spent) ||
    further.some((n) => !HEX64.test(n)) ||
    !DIGITS.test(input.amount) ||
    (input.createdIn !== null && !HEX64.test(input.createdIn))
  ) {
    throw new Error('this payment cannot be recorded as it was described, so the pool was not changed.');
  }
  const change: VaultCoin | undefined =
    input.change === null
      ? undefined
      : (() => {
          const c = noteFromWire(input.change);
          return { nonce: c.nonce, token: c.token, value: c.value };
        })();
  const next = afterStep(
    { notes: input.notes.map(noteFromWire) },
    { spent: [input.spent as Hex, ...further.map((n) => n as Hex)], pays: BigInt(input.amount), kept: change },
    input.createdIn === null ? undefined : (input.createdIn as Hex)
  );
  return next.notes.map(noteToWire);
}

export const servedFromWire = (events: readonly EventOnTheWire[]): ServedEvent[] =>
  events.map((e) => ({
    transactionHash: e.transactionHash,
    details: {
      tag: e.details.tag,
      ...(e.details.commitment === undefined ? {} : { commitment: e.details.commitment }),
      ...(e.details.contract === undefined ? {} : { contract: e.details.contract }),
      ...(e.details.mtIndex === undefined || !DIGITS.test(e.details.mtIndex)
        ? {}
        : { mtIndex: BigInt(e.details.mtIndex) })
    }
  }));

/** What a payment's own events say: it landed as built, the chain has not answered yet, or it is not as built. */
export type PaymentConfirmation =
  | { readonly state: 'landed'; readonly createdIn: string }
  | { readonly state: 'not-yet' }
  | { readonly state: 'not-as-built'; readonly why: string };

/**
 * **WHETHER THE CHAIN HOLDS THIS PAYMENT, READ OFF THIS PAYMENT'S OWN EVENTS.**
 *
 * Two payments out of one note for one amount make the same change coin, so
 * the vault's note set cannot tell which of them landed. The transaction's own
 * events can: every one must be this transaction's, one output must be a
 * person's, and the change - when there is one - must be an output of this
 * transaction, owned by this vault. The hash answered is the one the change is
 * recorded under.
 *
 * **THREE ANSWERS, BECAUSE THEY NEED THREE ACTS.** No events yet, or an indexer
 * that cannot say yet, is `not-yet`, and the caller asks again. Events that are
 * there and are not this payment as it was built are `not-as-built`, and asking
 * again will not change them.
 */
export async function confirmPayment(input: {
  readonly vault: string;
  readonly transactionHash: string;
  readonly change: NoteOnTheWire | null;
  readonly events: readonly EventOnTheWire[];
  /**
   * A merge of the vault's own notes, judged as one: it pays nobody, so an
   * output to a person under its name is not it, and the one coin it keeps
   * must be an output of the transaction, owned by this vault.
   */
  readonly merge?: true;
}): Promise<PaymentConfirmation> {
  const vault = input.vault.toLowerCase();
  const transaction = { hash: input.transactionHash as Hex };
  const served = servedFromWire(input.events);
  if (served.length === 0) return { state: 'not-yet' };
  try {
    const hash = theTransactionTheseEventsAreFrom(served, transaction);
    if (served.some((e) => e.transactionHash.toLowerCase().replace(/^0x/u, '') !== hash)) {
      return { state: 'not-as-built', why: 'the events read for this payment are not all its own' };
    }
    const paysAPerson = served.some((e) => e.details.tag === 'zswapOutput' && e.details.contract === undefined);
    if (input.merge === true) {
      if (paysAPerson)
        return {
          state: 'not-as-built',
          why: "the transaction under this merge's name pays somebody, and a merge pays nobody"
        };
      if (input.change === null)
        return { state: 'not-as-built', why: 'a merge keeps one coin, and none was named for this one' };
    } else if (!paysAPerson) {
      return { state: 'not-as-built', why: "the transaction under this payment's name paid nobody" };
    }
    if (input.change === null) return { state: 'landed', createdIn: hash };
    const change = noteFromWire(input.change);
    const commitment = await vaultNoteCommitment(change, vault as Hex);
    const { createdIn } = establishCreatingTransaction(served, { vault: vault as Hex, commitment, transaction });
    return { state: 'landed', createdIn };
  } catch (cause) {
    if ((cause as Error)?.name === 'NoteIndexUnreadable') return { state: 'not-yet' };
    return { state: 'not-as-built', why: (cause as Error)?.message ?? String(cause) };
  }
}
