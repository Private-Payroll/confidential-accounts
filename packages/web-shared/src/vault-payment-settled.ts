/**
 * **A PAYMENT KEPT ON THIS DEVICE, SETTLED** (`settlePaymentInFlight`): found
 * on the chain as its own or as overtaken by another, and the vault's record
 * of notes advanced for it (`recordPayment`).
 */
import type { Hex } from '../../../src/core/crypto.js';
import { SealedNotePool, isALostPoolRace } from '../../../src/midnight/vault-pool.js';
import type { VaultCallOnChain } from '../../../src/midnight/note-index.js';
import { PaymentJournalInStore, attemptKey, stepOfLine } from '../../../src/midnight/vault-journal.js';
import type { NoteOnTheWire } from './vault-builder.js';
import { VaultAskFailed } from './vault-worker-client.js';
import { type VaultChainView } from './vault-doors.js';
import { theWalletsIndexer } from './vault-read-here.js';
import { keptOnTheChainUnder, secretsToTry } from './vault-secret-to-spend.js';
import { coinOnTheWire, creatingTransactionOfOutput, lowerOf, notesAsThisDeviceReadsThem } from './vault-step-reads.js';
import {
  A_PAYOUT,
  noteOf,
  type PaymentInFlight,
  paymentLandsBy,
  type PaymentSettled,
  PaymentStillInFlight,
  type PayoutDoors,
  wireOf
} from './vault-payment-in-flight.js';

/**
 * **THE VAULT'S RECORD ADVANCED FOR ONE PAYMENT: EVERY NOTE IT SPENT GONE, AND
 * ITS CHANGE ADDED UNDER THE TRANSACTION THAT MADE IT.** Against the record as
 * it stands at each attempt, so a note another writer added meanwhile is kept.
 * A record that no longer holds the first note has already been written for
 * this payment; one that holds some of its notes and not others is refused by
 * the pool's own rule rather than half-applied.
 */
export async function recordPayment(
  doors: PayoutDoors,
  vault: Hex,
  spent: Hex,
  further: readonly Hex[],
  amount: string,
  change: NoteOnTheWire | null,
  createdIn: Hex | null
): Promise<void> {
  const pool = new SealedNotePool(
    doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret },
    doors.signers
  );
  const ATTEMPTS = 5;
  for (let attempt = 1; ; attempt += 1) {
    const now = await pool.load(vault);
    /* Written already only when the record holds none of the notes it spent; some and not others is refused below. */
    const spentHere = [spent, ...further].map(lowerOf);
    if (!now.notes.some((n) => spentHere.includes(n.nonce.toLowerCase()))) return;
    const next = await doors.builder.afterPayment({
      notes: now.notes.map(wireOf),
      spent,
      ...(further.length === 0 ? {} : { further }),
      amount,
      change,
      createdIn
    });
    try {
      await pool.save(vault, { notes: next.map(noteOf) }, now.readAt);
      return;
    } catch (cause) {
      if (!isALostPoolRace(cause) || attempt === ATTEMPTS) throw cause;
    }
  }
}

/**
 * What the chain says of a payment's own transaction: `vaultCallOnChain`'s
 * answer, or `unnamed` when the record names no transaction of its own, or
 * `cannot` when the chain could not be asked, which says nothing about whether
 * it landed.
 */
type OwnPaymentSeen = VaultCallOnChain | { readonly of: 'unnamed' } | { readonly of: 'cannot'; readonly why: string };

/**
 * **A PAYMENT'S OWN TRANSACTION, LOOKED FOR ON THE CHAIN.** Asked in the worker
 * at the wallet's indexer by the identifiers of the transaction the record
 * kept, and judged by the part of it that carries this vault's payout
 * (`vaultCallOnChain`). A hash the service answered with is never asked for.
 */
export async function ownPaymentOnChain(doors: PayoutDoors, vault: Hex, p: PaymentInFlight): Promise<OwnPaymentSeen> {
  if (!Array.isArray(p.identifiers) || p.identifiers.length === 0 || typeof p.transaction !== 'string')
    return { of: 'unnamed' };
  if (typeof doors.builder.vaultCallOnChain !== 'function') {
    return { of: 'cannot', why: 'this page cannot ask the chain about a payment by its own transaction' };
  }
  try {
    return await doors.builder.vaultCallOnChain({
      vault,
      entryPoints: [...A_PAYOUT],
      transaction: p.transaction,
      indexer: await theWalletsIndexer(doors, vault)
    });
  } catch (e) {
    return { of: 'cannot', why: whyAfterTheSend(e) };
  }
}

/**
 * **A STEP WRITTEN IN THE VAULT'S PAYMENT JOURNAL THAT SPENT A NOTE THIS
 * PAYMENT SPENDS, AND LANDED.** A note is spent once, so when another step -
 * a merge above all, which needs no approval and may be made by any holder of
 * the vault's secret - spent it and its coin is on the chain, this payment can
 * never land. That is known as soon as the step's coin is seen, not when this
 * payment's time to live runs out.
 *
 * Only a step its own line can name is believed: its coin is worked out from
 * the line with the vault's secret, and it counts only when the chain holds
 * that coin, holds none of the notes the line names, and does not hold this
 * payment's own change. A line identical to this payment's is this payment.
 * For a payment that kept no change, and so left no coin of its own to look
 * for, a line whose first note is one this payment spends counts at once: a
 * coin names the note it was made from, so that coin on the chain says this
 * payment's note went into another step, and this payment cannot have landed.
 * A line that names this payment's note only beside its first counts only once
 * this payment is established as not landed (`notLanded`: its own transaction
 * refused, or unseen past its window): that coin names the other note, which
 * another step may have spent, so until then it cannot say this payment did
 * not land, and a payment that paid never reads as payable again.
 */
async function overtakenBy(
  doors: PayoutDoors,
  vault: Hex,
  p: PaymentInFlight,
  onChain: ReadonlySet<string>,
  until: number,
  notLanded: boolean,
  state?: string
): Promise<{
  readonly spent: Hex;
  readonly further: readonly Hex[];
  readonly amount: string;
  readonly kept: NoteOnTheWire;
  readonly createdIn: Hex;
} | null> {
  const mine = [p.spent, ...(p.further ?? [])].map((n) => lowerOf(n.nonce));
  const asCoin = (n: { readonly nonce: Hex; readonly token: Hex; readonly value: string }) => ({
    nonce: n.nonce,
    token: n.token,
    value: BigInt(n.value)
  });
  const thisPayment = attemptKey({
    spent: asCoin(p.spent),
    ...(p.further === undefined || p.further.length === 0 ? {} : { further: p.further.map(asCoin) }),
    amount: BigInt(p.amount),
    ...(p.merge === true ? { merge: true } : {})
  });
  const heldOf = async (coin: NoteOnTheWire): Promise<string> =>
    lowerOf((await doors.builder.commitments({ vault, coin })).held);
  /*
   * **THIS PAYMENT'S OWN CHANGE ON THE CHAIN SAYS IT LANDED**, whatever any other line says: a coin's commitment
   * names the first note it was made from and what it holds, not every note beside it, so another step's coin is
   * believed only while this payment's own change is absent.
   */
  if (p.change !== null && onChain.has(await heldOf(p.change))) return null;
  const journal = new PaymentJournalInStore(
    doors.records('payment-journal'),
    vault,
    { id: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret },
    doors.signers
  );
  const { attempts } = await journal.open();
  let secrets: Hex[] | null = null;
  for (const a of attempts) {
    const notes = [a.spent, ...(a.further ?? [])];
    if (!notes.some((n) => mine.includes(lowerOf(n.nonce)))) continue;
    /*
     * With no change of its own on the chain to weigh it against, only a coin made from this payment's own note says
     * so, until this payment is established as not landed.
     */
    if (p.change === null && !notLanded && !mine.includes(lowerOf(a.spent.nonce))) continue;
    /* A line identical to this payment's is this payment: the same notes and amount make the same change. */
    if (attemptKey(stepOfLine(a)) === thisPayment) continue;
    /* A step that landed spent every note it names: one the chain still holds says this line is not the one that landed. */
    let allGone = true;
    for (const n of notes) if (onChain.has(await heldOf(coinOnTheWire(n)))) allGone = false;
    if (!allGone) continue;
    /* Under every secret the vault may have held when the step was made, the records' and this signer's copy on the chain. */
    secrets ??= await secretsToTry(doors, vault, state);
    const made = await keptOnTheChainUnder(
      doors,
      vault,
      secrets,
      {
        spent: coinOnTheWire(a.spent),
        ...(a.further === undefined ? {} : { further: a.further.map(coinOnTheWire) }),
        amount: a.amount.toString(),
        ...(a.step === 'merge' ? { merge: true } : {})
      },
      onChain
    );
    if (made === null) continue;
    const { kept, output } = made;
    const found = await creatingTransactionOfOutput(
      doors,
      vault,
      output,
      null,
      "the coin of the step that spent this payment's note"
    );
    if (found.state !== 'found') {
      throw new PaymentStillInFlight(
        vault,
        p.txRef,
        until,
        "a step that spent the note it would spend has landed, and the transfer that made that step's coin cannot be read yet",
        { unread: true }
      );
    }
    return {
      spent: a.spent.nonce,
      further: (a.further ?? []).map((n) => n.nonce),
      amount: a.amount.toString(),
      kept,
      createdIn: found.createdIn
    };
  }
  return null;
}

/**
 * **WHEN ANOTHER STEP SPENT A NOTE THIS ONE SPENDS AND LANDED, THAT STEP IS
 * RECORDED AS THE CHAIN HOLDS IT**: every note it spent gone, its coin added
 * under the transaction that made it. Asked of a step on its way wherever it
 * is settled - when this browser looks again, and while a payment that kept no
 * change is watched for and its own transaction is not seen yet - so a step
 * another holder made is never recorded as this one. `notLanded` as
 * `overtakenBy` takes it. `true` when it was.
 */
export async function recordedIfOvertaken(
  doors: PayoutDoors,
  vault: Hex,
  p: PaymentInFlight,
  onChain: ReadonlySet<string>,
  until: number,
  notLanded: boolean,
  state?: string
): Promise<boolean> {
  const overtaken = await overtakenBy(doors, vault, p, onChain, until, notLanded, state);
  if (overtaken === null) return false;
  await recordPayment(
    doors,
    vault,
    overtaken.spent as Hex,
    overtaken.further as Hex[],
    overtaken.amount,
    overtaken.kept,
    overtaken.createdIn
  );
  return true;
}

/**
 * A payment kept on this device that kept no change, settled: it landed only when every note it spent has left the
 * chain and its own transaction is there.
 */
async function settledWithNoChange(
  doors: PayoutDoors,
  vault: Hex,
  p: NonNullable<Awaited<ReturnType<PayoutDoors['inFlight']['get']>>>,
  {
    notes,
    state,
    onChain,
    until,
    past,
    forget
  }: {
    readonly notes: readonly string[];
    readonly state: VaultChainView['state'];
    readonly onChain: Set<string>;
    readonly until: number;
    readonly past: boolean;
    readonly forget: () => Promise<unknown>;
  }
): Promise<PaymentSettled> {
  /* A payment that kept no change landed only when every note it spent has left: they leave in one transaction. */
  for (const n of p.further ?? []) {
    const { held: heldFurther } = await doors.builder.commitments({ vault, coin: n });
    if (!notes.some((x) => x.toLowerCase() === heldFurther.toLowerCase())) continue;
    if (past) {
      await forget();
      return { state: 'never-landed' };
    }
    throw new PaymentStillInFlight(vault, p.txRef, until, 'a note it spends is still held on the chain');
  }
  /* **ONLY ITS OWN TRANSACTION SAYS IT LANDED.** */
  const own = await ownPaymentOnChain(doors, vault, p);
  if (own.of === 'landed') {
    await recordPayment(
      doors,
      vault,
      p.spent.nonce,
      (p.further ?? []).map((n) => n.nonce),
      p.amount,
      null,
      null
    );
    await forget();
    return { state: 'recorded', createdIn: null };
  }
  /* An indexer that could not be asked is not an answer: never landed only on a clean look past the window. */
  const notLanded = own.of === 'refused' || (own.of === 'not-seen' && past);
  if (notLanded) {
    if (await recordedIfOvertaken(doors, vault, p, onChain, until, true, state)) {
      await forget();
      return { state: 'overtaken' };
    }
    await forget();
    return { state: 'never-landed' };
  }
  if ((own.of === 'unnamed' || own.of === 'not-known') && past) {
    await forget();
    return { state: 'not-matched' };
  }
  throw new PaymentStillInFlight(
    vault,
    p.txRef,
    until,
    own.of === 'cannot' || own.of === 'not-known'
      ? own.why
      : own.of === 'unnamed'
        ? "this browser's record of it does not name its own transaction, and the chain no longer holds the note it spent"
        : 'the chain has not shown its own transaction yet',
    { unread: own.of === 'cannot' }
  );
}

/**
 * **WHAT BECAME OF A PAYMENT THIS BROWSER SENT AND HAS NOT YET RECORDED.**
 *
 *   · the vault's record no longer holds the note it spent (this browser or
 *     another signer recorded it): nothing to record, and it is forgotten;
 *   · the chain still holds that note: nothing spent it yet. Once the
 *     payment's window (`paymentLandsBy`) has passed it never will, and it is
 *     forgotten; until then `PaymentStillInFlight`;
 *   · the chain no longer holds that note and the payment left no change: it
 *     landed only when the chain shows its own transaction, by the identifiers
 *     it kept, take effect in the part that carries this vault's payout. Then
 *     its notes are taken out of the record and nothing is added. Its notes
 *     leaving is never enough: another step may have spent them. Refused, or
 *     unseen on a clean look past its window, it never landed: a step the
 *     journal names that spent its note, first or beside another, is written
 *     into the record as below, and otherwise it is forgotten and the next
 *     open's rebuild files the coin of whatever spent the note. Unseen inside
 *     its window, or when the chain could not be asked, `PaymentStillInFlight`.
 *     A record that names no transaction of its own, or whose transaction the
 *     chain answers about in a way this cannot read, is let go as
 *     `not-matched` once its window has passed;
 *   · the chain no longer holds that note and the transaction that made the
 *     payment's change can be read: the note goes and the change is added
 *     under that transaction, found by the change's own commitment when the
 *     send named none. It is the vault's coin whichever payment made it: two
 *     payments of one amount out of one note make the same change;
 *   · the chain no longer holds that note because another step the vault's
 *     payment journal names spent it - a merge made while this payment was on
 *     its way - and that step's coin is on the chain: this payment can never
 *     land. The step is written into the record as the chain holds it, this
 *     payment is forgotten at once, and the person can be paid again from the
 *     record as it now stands;
 *   · the chain no longer holds that note and, once the time to live has
 *     passed, the vault's history, read in full, holds no such change: this
 *     payment never landed and something else spent the note. It is
 *     forgotten, and the record is left for whoever made that payment.
 *
 * Nothing is recorded that the chain does not show.
 */
export async function settlePaymentInFlight(
  doors: PayoutDoors,
  vault: Hex,
  view?: VaultChainView
): Promise<PaymentSettled> {
  const p = await doors.inFlight.get(vault);
  if (p === null) return { state: 'none' };
  const forget = () =>
    doors.inFlight.forget(vault, p.claim).catch(() => {
      /* the next look settles it again */
    });
  const pool = new SealedNotePool(
    doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret },
    doors.signers
  );
  if (!(await pool.load(vault)).notes.some((n) => n.nonce.toLowerCase() === p.spent.nonce.toLowerCase())) {
    await forget();
    return { state: 'already-recorded' };
  }
  const seen = view ?? (await notesAsThisDeviceReadsThem(doors, vault));
  const until = paymentLandsBy(p);
  const past = (doors.now ?? (() => new Date()))().getTime() > until;
  /* Only a view that read the vault's notes can say the note it spent has left. */
  if (seen.onChain !== true || !Array.isArray(seen.notes)) {
    throw new PaymentStillInFlight(vault, p.txRef, until, "the vault's notes could not be read just now", {
      unread: true
    });
  }
  const { held } = await doors.builder.commitments({ vault, coin: p.spent });
  if (seen.notes.some((n) => n.toLowerCase() === held.toLowerCase())) {
    if (past) {
      await forget();
      return { state: 'never-landed' };
    }
    throw new PaymentStillInFlight(vault, p.txRef, until);
  }
  const onChain = new Set(seen.notes.map(lowerOf));
  if (await recordedIfOvertaken(doors, vault, p, onChain, until, false, seen.state)) {
    await forget();
    return { state: 'overtaken' };
  }
  if (p.change === null)
    return settledWithNoChange(doors, vault, p, { notes: seen.notes, state: seen.state, onChain, until, past, forget });
  const { output, held: heldChange } = await doors.builder.commitments({ vault, coin: p.change });
  const found = await creatingTransactionOfOutput(doors, vault, output, p.transactionHash, "this payment's change");
  if (found.state === 'found') {
    await recordPayment(
      doors,
      vault,
      p.spent.nonce,
      (p.further ?? []).map((n) => n.nonce),
      p.amount,
      p.change,
      found.createdIn
    );
    await forget();
    return { state: 'recorded', createdIn: found.createdIn };
  }
  /*
   * The vault's history listing no transaction for the change is believed only
   * when this device's own read of the chain holds that change nowhere either.
   */
  const bareHex = (h: string) => h.toLowerCase().replace(/^0x/u, '');
  const changeOnChain =
    (seen.notes ?? []).some((n) => bareHex(n) === bareHex(heldChange)) ||
    (seen.everCreated ?? []).some((c) => bareHex(c) === bareHex(output));
  if (found.listed === 'none' && past && !changeOnChain) {
    await forget();
    return { state: 'spent-elsewhere' };
  }
  /*
   * **A CHANGE THE CHAIN SHOWS AND THE VAULT WORKER WILL NOT NAME, PAST ITS
   * TIME TO LIVE.** Waiting will not change it. It is let go, so payments go
   * on; the vault's record still holds the note it spent, which the chain no
   * longer does, and a payment that would spend that note says the record has
   * to be rebuilt from the company's records, which names the change again.
   */
  if (found.state === 'unknown' && past) {
    await forget();
    return { state: 'not-matched' };
  }
  /* Only an answer the time can settle names the time: one still waiting on a read, or on a change the chain holds, does not. */
  throw new PaymentStillInFlight(
    vault,
    p.txRef,
    until,
    found.state === 'unknown'
      ? found.why
      : 'the chain no longer holds the note it spent, and the transfer that made its change cannot be read yet',
    { unread: found.state !== 'unknown' && (found.listed !== 'none' || changeOnChain) }
  );
}

/**
 * What a failure after a step was sent is called in the notice that the step
 * may have been sent. A failed ask of the vault worker is named by its reason
 * alone: its own sentence tells the person to try again, which a notice that
 * must stop a second payment may never say.
 */
export const whyAfterTheSend = (e: unknown): string =>
  e instanceof VaultAskFailed
    ? `this page's check of it did not finish (${e.reason}${e.reason === 'answered' && e.workerName !== undefined ? `, ${e.workerName}` : ''})`
    : ((e as Error)?.message ?? String(e));
