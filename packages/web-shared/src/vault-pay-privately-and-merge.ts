/**
 * **A PRIVATE PAYMENT OUT OF A COMPANY'S VAULT, AND A MERGE OF ITS NOTES, FROM
 * A SIGNER'S OWN DEVICE** (`payPrivatelyFromCompanyVault`,
 * `mergeNotesInCompanyVault`). Both are sent by the one step out
 * (`sendAStepOut`).
 *
 * The pool is opened here, with this signer's own key, and the note to spend is
 * chosen here; nothing that opens a note leaves this device. The note's place
 * in the chain's commitment tree is read from the events of the transaction
 * that created it; the payment is built and proved here against one block's
 * view of the vault and the account, and written into the vault's payment
 * journal once built and BEFORE it is sent; the service adds the network fee
 * and sends it; and the pool is advanced - the note gone, its change added with
 * the transaction that made it - only once the chain shows both.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { SealedNotePool } from '../../../src/midnight/vault-pool.js';
import type { Note } from '../../../src/midnight/vault-notes.js';
import { PaymentJournalInStore } from '../../../src/midnight/vault-journal.js';
import { STEP_LIMITS } from '../../../src/midnight/payment-plan.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import type { EventOnTheWire, NoteOnTheWire } from './vault-builder.js';
import { handedOver } from './hand-over.js';
import type { PayoutChainOnTheWire } from './vault-worker-client.js';
import { sentNothing } from './vault-start-stops.js';
import { type BuiltOnHereDoors, type VaultChainView, type VaultStage, until } from './vault-doors.js';
import { chainAtOneBlockHere, theWalletsIndexer } from './vault-read-here.js';
import { theSecretToSpend } from './vault-secret-to-spend.js';
import { HEX64, lowerOf, NAMED_BY_NOTHING, notesAsThisDeviceReadsThem } from './vault-step-reads.js';
import { fundableOrThrow } from './vault-fundable-here.js';
import { A_PAYOUT, type NoteAsHex, type PaymentInFlight, PaymentLandedUnrecorded, paymentLandsBy, PaymentNotAsBuilt, PaymentNotYetSeen, PaymentRefusedOnChain, PaymentStartedElsewhere, PaymentStillInFlight, type PayoutDoors, wireOf } from './vault-payment-in-flight.js';
import { ownPaymentOnChain, recordedIfOvertaken, recordPayment, settlePaymentInFlight, whyAfterTheSend } from './vault-payment-settled.js';
import { vaultNotesHere } from './vault-notes-here.js';

/** Every zswap event the chain holds for one transaction, read on this device at the indexer the wallet names. */
async function eventsHere(
  doors: Pick<BuiltOnHereDoors, 'builder' | 'indexer'>, vault: Hex, transactionHash: string,
): Promise<EventOnTheWire[]> {
  return doors.builder.eventsOf({ transactionHash, indexer: await theWalletsIndexer(doors, vault) });
}

/**
 * **HOW A STEP OUT OF THE VAULT IS SPOKEN OF**: the refusals once it may have
 * been sent, and the stages a person watches. A payment pays a person; a merge
 * pays nobody and only reshapes the vault's own notes, so neither borrows the
 * other's words.
 */
interface StepWords {
  readonly what: string;
  readonly writing: VaultStage;
  readonly building: VaultStage;
  readonly sending: VaultStage;
  readonly waiting: VaultStage;
  readonly recording: VaultStage;
  notYetSeen(vault: Hex, txRef: string, why?: string): Error;
  landedUnrecorded(vault: Hex, transactionHash: string, why: string): Error;
  notAsBuilt(vault: Hex, transactionHash: string, why: string): Error;
}

const A_PAYMENT: StepWords = {
  what: 'this payment',
  writing: 'writing the payment down', building: 'building the payment', sending: 'sending the payment',
  waiting: 'waiting for the payment', recording: 'recording the payment',
  notYetSeen: (vault, txRef, why) => new PaymentNotYetSeen(vault, txRef, why),
  landedUnrecorded: (vault, hash, why) => new PaymentLandedUnrecorded(vault, hash, why),
  notAsBuilt: (vault, hash, why) => new PaymentNotAsBuilt(vault, hash, why),
};

const A_MERGE: StepWords = {
  what: 'this merge',
  writing: 'writing the merge down', building: 'building the merge', sending: 'sending the merge',
  waiting: 'waiting for the merge', recording: 'recording the merge',
  notYetSeen: (vault, txRef, why) => new MergeNotYetSeen(vault, txRef, why),
  landedUnrecorded: (vault, hash, why) => new MergeLandedUnrecorded(vault, hash, why),
  notAsBuilt: (vault, hash, why) => new MergeNotAsBuilt(vault, hash, why),
};

/**
 * **A MERGE OF THE VAULT'S NOTES MAY HAVE BEEN SENT, AND THIS DEVICE HAS NOT
 * SEEN IT LAND.** A merge moves nothing out of the vault: whatever happens, the
 * money stays the vault's. Until the chain shows it, no other step leaves the
 * vault from this browser.
 */
export class MergeNotYetSeen extends Error {
  constructor(readonly vault: Hex, readonly txRef: string, why?: string) {
    super(`the merge of this vault's notes may have been sent${txRef === '' ? '' : ` (${txRef})`} and this device has `
      + `not seen it land${why === undefined ? '' : ` (${why})`}. Nothing left the vault either way. This browser keeps `
      + 'a locked record of it, and the next payment out of this vault from here adds it to the vault\'s record once '
      + 'the chain shows it. Until then, no other payment leaves this vault from this browser.');
    this.name = 'MergeNotYetSeen';
  }
}

/** **THE MERGE LANDED, AND THE VAULT'S RECORD WAS NOT WRITTEN.** The next look from this browser writes it. */
class MergeLandedUnrecorded extends Error {
  constructor(readonly vault: Hex, readonly transactionHash: string, why: string) {
    super(`the merge of this vault's notes landed${transactionHash === '' ? '' : ` (${transactionHash})`} and the `
      + `vault's record could not be written (${why}). Nothing left the vault. This browser keeps a locked record of `
      + 'it, and the next payment out of this vault from here writes the record.');
    this.name = 'MergeLandedUnrecorded';
  }
}

/** **A TRANSACTION UNDER THIS MERGE'S NAME IS ON THE CHAIN, AND IT IS NOT THE MERGE THIS DEVICE BUILT.** */
export class MergeNotAsBuilt extends Error {
  constructor(readonly vault: Hex, readonly transactionHash: string, why: string) {
    super(`the chain holds a transaction under this merge's name${transactionHash === '' ? '' : ` (${transactionHash})`} `
      + `that is not the merge this device built: ${why}. The vault's record is not changed for it now. If the `
      + 'vault\'s record still holds the notes it spent once the chain no longer does, the record has to be rebuilt '
      + 'from the company\'s records before this device spends them.');
    this.name = 'MergeNotAsBuilt';
  }
}

/**
 * **THE VAULT'S NOTES MOVED UNDER A STEP BEFORE IT WAS SENT.** A note it would
 * spend has left the chain, or the record no longer holds it as named: another
 * step landed first. Nothing was written down or sent, and the step is planned
 * again from the record as it now stands.
 */
export class NotesMovedUnderAStep extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotesMovedUnderAStep';
  }
}

/**
 * **A STEP SENT AND OVERTAKEN: ANOTHER STEP SPENT A NOTE IT SPENDS, AND LANDED
 * FIRST.** A note is spent once, so this step can never land and nothing left
 * the vault for it. The step that did land is recorded as the chain holds it,
 * this one is forgotten, and it is planned again from the record as it now
 * stands.
 */
export class StepOvertaken extends NotesMovedUnderAStep {
  constructor(readonly vault: Hex, what: string) {
    super(`${what} did not land: another step out of this vault spent a note it spends and landed first, and that step `
      + `is recorded as the chain holds it. Nothing left the vault for ${what}. Plan it again from the record as it is now.`);
    this.name = 'StepOvertaken';
  }
}

/** The commitment the vault holds for one of its notes, as its worker works it out. */
const heldOfANote = async (doors: Pick<PayoutDoors, 'builder'>, vault: Hex, n: NoteOnTheWire): Promise<string> =>
  (await doors.builder.commitments({ vault, coin: { nonce: n.nonce, token: n.token, value: n.value } })).held.toLowerCase();

/**
 * **THE VAULT OPENED FOR A STEP OUT OF IT, ON THIS DEVICE**: pinned to the
 * company's account as the chain shows it, money allowed out, any earlier step
 * from this browser settled first, then every note the vault holds brought into
 * its record (`vaultNotesHere`), and its pool as the company's records then hold
 * it. Who holds the vault is not asked: no payment waits on the super admins.
 */
async function openedForAStepOut(
  doors: PayoutDoors, vault: Hex,
): Promise<{ readonly view: VaultChainView; readonly pool: Awaited<ReturnType<SealedNotePool['load']>> }> {
  doors.progress?.('opening the pool');
  const answer = await fundableOrThrow(doors, vault);
  if (answer.of === 'not-on-chain') {
    throw new Error('the chain, as this device read it, does not show this vault, so its record is not opened here and '
      + `nothing is paid out of it. Nothing was sent. Reason: ${answer.why}`);
  }
  /*
   * **WHETHER MONEY MAY GO OUT NOW, ASKED BEFORE ANYTHING ELSE.** The vault
   * pinned to the company's account and started, said here before the pool is
   * opened, a line is written or two minutes are spent proving a payment that
   * could not be sent.
   */
  if (answer.of !== 'fundable') {
    throw new Error('No payment can be made out of this vault yet, so none was prepared or recorded. Nothing was '
      + `sent. Reason: ${answer.why}`);
  }
  const view = answer.view;
  /*
   * **AN EARLIER STEP FROM THIS BROWSER IS SETTLED FIRST.** Recorded if it has
   * landed, forgotten if it never can; while it still can, no note is chosen,
   * because the record does not yet say which notes are left.
   */
  await settlePaymentInFlight(doors, vault, view);
  /*
   * **THEN EVERY NOTE THE VAULT HOLDS IS BROUGHT INTO ITS RECORD**, a note
   * another signer's device deposited or a step that took a note left behind,
   * filed as the next version when it changes anything. It is advisory here:
   * whatever it cannot do it says and returns, and the step is planned only from
   * the record as filed.
   */
  await vaultNotesHere(doors, vault, view);
  const pool = await new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers).load(vault);
  return { view, pool };
}

/**
 * **THE NOTES A STEP NAMES, EXACTLY AS THIS VAULT'S RECORD HOLDS THEM**, in the
 * order named, or a refusal: a note the record does not hold, or holds as
 * another coin, is never spent on a caller's word, and nothing is chosen in
 * its place.
 */
function exactlyTheNotesNamed(
  pool: { readonly notes: readonly Note[] }, named: readonly NoteOnTheWire[], what: string,
): NoteOnTheWire[] {
  if (new Set(named.map((n) => lowerOf(n.nonce))).size !== named.length) {
    throw new Error(`${what} names one note twice, and a note is spent once. Nothing was sent.`);
  }
  return named.map((n) => {
    const held = pool.notes.find((x) => lowerOf(x.nonce) === lowerOf(n.nonce));
    if (held === undefined || lowerOf(held.token) !== lowerOf(n.token) || held.value.toString() !== n.value) {
      throw new NotesMovedUnderAStep(`${what} names a note this vault's record does not hold as named, so nothing was built: the record `
        + 'has moved since the step was planned. Plan it again from the record as it is now. Nothing was sent.');
    }
    return wireOf(held);
  });
}

/**
 * **WHAT A STEP OUT OF THE VAULT IS BUILT ON, READ ON THIS DEVICE**: every note
 * it spends recorded with the transaction that created it and still held on
 * the chain as this device read it; the events that file each one; one block's
 * view of the vault and the account; and the vault's secret, opened from the
 * company's records and checked against the vault. Every fact is read here, at
 * the indexer the person's own wallet names. Nothing is written down yet.
 */
async function readyToSpend(
  doors: PayoutDoors, vault: Hex, view: VaultChainView, notes: readonly NoteOnTheWire[], what: string,
): Promise<{
  readonly withEvents: ReadonlyArray<{ readonly note: NoteOnTheWire; readonly events: EventOnTheWire[] }>;
  readonly chain: PayoutChainOnTheWire & { readonly account: Hex };
  readonly secret: string;
}> {
  if (notes.some((n) => n.createdIn === undefined)) {
    throw new Error(`a note of this vault's that ${what} would spend does not record which transaction created it, so `
      + 'its place in the chain cannot be read and it cannot be spent yet. It is still the vault\'s. Nothing was sent.');
  }
  /*
   * **A NOTE THE CHAIN NO LONGER HOLDS IS NOT SPENT AGAIN.** It means a step
   * that spent it landed and this record does not show it yet - another device
   * still writing it down, a tab closed while it waited, or the vault's notes
   * merged under this step. The vault's own check would refuse the build
   * anyway; stopping here, before anything is written down, says which case it
   * is, and nothing is left waiting on a note that has gone.
   */
  const onChainNow = new Set((view.notes ?? []).map((n) => n.toLowerCase()));
  for (const n of notes) {
    if (!onChainNow.has(await heldOfANote(doors, vault, n))) {
      throw new NotesMovedUnderAStep(`the chain no longer holds a note this vault's record would spend for ${what}: a step `
        + 'that spent it has landed that this record does not show yet. Nothing was sent. If another signer is paying '
        + `from this vault right now, try again in a minute. Otherwise ${what}, and any other that would `
        + 'spend that note, waits until the vault\'s record is rebuilt from the company\'s records.');
    }
  }

  doors.progress?.('reading the chain');
  const withEvents: Array<{ note: NoteOnTheWire; events: EventOnTheWire[] }> = [];
  for (const n of notes) withEvents.push({ note: n, events: await eventsHere(doors, vault, n.createdIn!) });
  const chain = await chainAtOneBlockHere(doors, vault);

  /*
   * **THE VAULT'S SECRET, OPENED HERE BEFORE ANYTHING IS WRITTEN DOWN.** The
   * vault names every coin a step makes with it, and refuses one that is not
   * the secret it holds: the one it holds now is taken from the records or
   * this signer's copy on the chain, and none stops the step before a line is
   * written. Nothing is filed on the way.
   */
  const secret = await theSecretToSpend(doors, vault, view.state!);
  return { withEvents, chain, secret };
}

/**
 * **WRITTEN DOWN ONCE THE STEP IS BUILT AND CHECKED, AND THIS MAY NOT MOVE BELOW
 * THE SEND.** The notes, what leaves and whether it is a merge fix the whole of
 * the coin the step keeps; a journal that refuses stops the step with nothing
 * spent. A build the account refuses (a run short of its approvals, a held
 * run) or one that spends other notes than chosen writes no line, so the
 * journal never names a step that was never sent. The line is the one format
 * every step is journalled in.
 */
async function writtenDown(
  doors: PayoutDoors, vault: Hex, notes: readonly NoteOnTheWire[], step: 'payment' | 'merge', amount: string,
): Promise<void> {
  const journal = new PaymentJournalInStore(doors.records('payment-journal'), vault,
    { id: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  const [first, ...further] = notes as unknown as NoteAsHex[];
  if (first === undefined) throw new Error('a step that spends no note is not written down. Nothing was sent.');
  await journal.record(vault, {
    spent: { nonce: first.nonce, token: first.token, value: BigInt(first.value) },
    ...(further.length === 0 ? {} : {
      further: further.map((n) => ({ nonce: n.nonce, token: n.token, value: BigInt(n.value) })),
    }),
    step,
    amount: BigInt(amount),
    attemptedAt: new Date().toISOString(),
  });
}

/**
 * What a payment that keeps no coin is found by on the chain, read from the transaction built for it: its identifiers,
 * its time to live and the transaction itself. Refused, before anything is sent, unless it names itself and carries
 * exactly one payout of this vault.
 */
async function namedByItsOwnTransaction(
  doors: PayoutDoors, vault: Hex, tx: string,
): Promise<Pick<PaymentInFlight, 'identifiers' | 'timeToLive' | 'transaction'>> {
  const read = typeof doors.builder.readTransaction === 'function' && typeof doors.builder.vaultCallOnChain === 'function'
    ? await doors.builder.readTransaction({ transaction: tx }).catch(() => null) : null;
  const bare = (h: string) => lowerOf(h).replace(/^0x/u, '');
  const payouts = read === null ? [] : read.calls.filter((c) => bare(c.address) === bare(vault) && A_PAYOUT.includes(c.entryPoint));
  if (read === null || read.identifiers.length === 0 || read.timeToLive === null || payouts.length !== 1) {
    throw new Error('this page could not read the payment it built well enough to find it on the chain afterwards, so '
      + 'it did not send it. Nothing was sent and nobody was paid by it. Reload the page and pay again.');
  }
  return { identifiers: [...read.identifiers], timeToLive: read.timeToLive, transaction: tx };
}

/**
 * A kept step handed to `send`. One the send marks as having sent nothing is let go on this device and its failure
 * thrown as it is; any other failure is kept as why the step may have been sent, and the wait for it goes on.
 */
async function sentOrLetGo(
  doors: PayoutDoors, vault: Hex, claim: NonNullable<Awaited<ReturnType<PayoutDoors['inFlight']['claim']>>>,
  s: { readonly tx: string; readonly send: (vault: Hex, tx: string) => Promise<{ txRef: string; transactionHash: string | null }>; readonly words: StepWords },
): Promise<{ readonly sent: { txRef: string; transactionHash: string | null }; readonly sendFailed?: string }> {
  doors.progress?.(s.words.sending);
  try {
    return { sent: await s.send(vault, s.tx) };
  } catch (e) {
    if (sentNothing(e)) {
      await doors.inFlight.forget(vault, claim).catch(() => { /* the next step settles it, and finds it never landed */ });
      throw e;
    }
    return { sent: { txRef: '', transactionHash: null }, sendFailed: (e as Error)?.message ?? String(e) };
  }
}

/**
 * One look for a payment that keeps no coin: landed or refused as its own transaction says; overtaken when a step the
 * journal names spent its note first and landed; otherwise null, to look again. Why a look could not answer is `said`.
 */
async function ownPaymentLook(
  doors: PayoutDoors, vault: Hex,
  { first, inFlight, heldSpent }: { readonly first: PaymentInFlight; readonly inFlight: PaymentInFlight; readonly heldSpent: string | null },
  said: (why: string) => void,
) {
  const own = await ownPaymentOnChain(doors, vault, inFlight);
  if (own.of === 'landed') return { state: 'landed' as const, createdIn: own.transactionHash };
  if (own.of === 'refused') return { state: 'refused' as const, transactionHash: own.transactionHash };
  if (own.of === 'cannot' || own.of === 'not-known') said(own.why);
  /*
   * Not seen yet. Its note leaving says nothing of this payment, but a step the journal names that spent it
   * first and landed says this one never can - asked as settling asks it. Only a view that read the vault's
   * notes can say the note has left: an unreadable one says nothing.
   */
  const now = await notesAsThisDeviceReadsThem(doors, vault).catch(() => null);
  if (now === null || now.onChain !== true || !Array.isArray(now.notes)) return null;
  if (now.notes.some((n) => n.toLowerCase() === heldSpent)) return null;
  try {
    const onChain = new Set<string>(now.notes.map((n: string) => lowerOf(n)));
    if (await recordedIfOvertaken(doors, vault, inFlight, onChain, paymentLandsBy(first), false, now.state)) {
      return { state: 'overtaken' as const };
    }
  } catch (e) {
    /* The step that spent it landed and its coin's transfer cannot be read yet: ask again. */
    if (e instanceof PaymentStillInFlight) return null;
    throw e;
  }
  return null;
}

/**
 * One look for a step that keeps a coin: its own transaction, by the hash the send named or found by the coin's own
 * commitment, judged by the vault worker; null to look again. Why a look could not answer is `said`.
 */
async function aKeptCoinLook(
  doors: PayoutDoors, vault: Hex,
  { kept, merge, hash, keptOutput }: { readonly kept: NoteOnTheWire | null; readonly merge: boolean; readonly hash: string | null; readonly keptOutput: string | null },
  said: (why: string) => void,
) {
  let own: { transactionHash: string; events: EventOnTheWire[] } | null;
  try {
    own = hash !== null
      ? { transactionHash: hash, events: await eventsHere(doors, vault, hash) }
      : await doors.builder.createdBy({ vault, commitment: keptOutput!, indexer: await theWalletsIndexer(doors, vault) });
  } catch {
    /* The indexer does not hold it yet, or could not be asked: ask again. */
    return null;
  }
  if (own === null) return null;
  let answer: Awaited<ReturnType<typeof doors.builder.confirmPayment>>;
  try {
    answer = await doors.builder.confirmPayment({
      vault, transactionHash: String(own.transactionHash).toLowerCase(), change: kept, events: own.events,
      ...(merge ? { merge: true as const } : {}),
    });
  } catch (e) {
    /* The check could not be made this time; the next look asks again, of a new worker if this one stopped. */
    said(whyAfterTheSend(e));
    return null;
  }
  return answer.state === 'not-yet' ? null : answer;
}

/**
 * **ONE BUILT STEP OUT OF THE VAULT, KEPT, SENT, WATCHED AND RECORDED.** Kept on
 * this device before it is sent; sent through `send`; from then on every
 * failure says the step may have landed. A step that keeps a coin is confirmed
 * only by its own transaction's events, read on this device - or, when the
 * send named none, by the coin it kept. A payment that keeps no coin is
 * confirmed only by the chain showing its own transaction, by the identifiers
 * read from it before the send, take effect in the part that carries this
 * vault's payout; never by its notes leaving, and never by a hash the service
 * named. The vault's record is advanced on those and nothing else.
 */
async function sendAStepOut(doors: PayoutDoors, vault: Hex, s: {
  readonly notes: readonly NoteOnTheWire[];
  readonly amount: string;
  /** The one coin the step keeps, as the build read it, or `null` when it keeps none. */
  readonly kept: NoteOnTheWire | null;
  readonly merge: boolean;
  readonly tx: string;
  readonly send: (vault: Hex, tx: string) => Promise<{ txRef: string; transactionHash: string | null }>;
  readonly words: StepWords;
}): Promise<{ readonly txRef: string; readonly hash: string | null; readonly createdIn: Hex | null }> {
  const [note, ...further] = s.notes as unknown as NoteAsHex[];
  if (note === undefined) throw new Error('a step that spends no note is not sent. Nothing was sent.');
  /*
   * **A PAYMENT THAT KEEPS NO COIN IS KNOWN ON THE CHAIN ONLY BY ITS OWN
   * TRANSACTION**, so it is not sent unless that transaction names itself: at
   * least one identifier, a time to live, and exactly one payout of this vault.
   */
  const byItsOwn = s.kept === null && !s.merge;
  const named: Pick<PaymentInFlight, 'identifiers' | 'timeToLive' | 'transaction'> = byItsOwn
    ? await namedByItsOwnTransaction(doors, vault, s.tx) : {};
  /*
   * **KEPT ON THIS DEVICE BEFORE IT IS SENT, AND THIS MAY NOT MOVE BELOW THE
   * SEND.** The coin kept, and a payment's own transaction, are known only from
   * the build, and from the send on the step may land whatever happens to this
   * page; this is what lets the record be written once it does.
   */
  const first: PaymentInFlight = {
    spent: { nonce: note.nonce, token: note.token, value: note.value },
    ...(further.length === 0 ? {} : { further: further.map((n) => ({ nonce: n.nonce, token: n.token, value: n.value })) }),
    ...(s.merge ? { merge: true as const } : {}),
    amount: s.amount, change: s.kept, recordedAt: (doors.now ?? (() => new Date()))().getTime(), txRef: '', transactionHash: null,
    ...named,
  };
  const claim = await doors.inFlight.claim(vault, first);
  if (claim === null) throw new PaymentStartedElsewhere(vault);

  const { sent, sendFailed } = await sentOrLetGo(doors, vault, claim, s);

  /* ---- from here the money may have moved, and every failure says so ---- */
  try {
    const inFlight: PaymentInFlight = { ...first, txRef: sent.txRef, transactionHash: sent.transactionHash };
    await doors.inFlight.update(vault, claim, inFlight)
      .catch(() => { /* the record kept before still names the coin kept, or the payment's own transaction */ });
    const answered = sent.transactionHash === null ? null : sent.transactionHash.toLowerCase();
    const hash = answered !== null && HEX64.test(answered) ? answered : null;
    doors.progress?.(s.words.waiting);
    /*
     * **WITHOUT A NAME FROM THE SEND, A STEP THAT KEPT A COIN IS FOUND BY IT**,
     * by that coin's own commitment, in this vault's history, and its own
     * events, once found, are judged exactly as a named transaction's are.
     */
    const heldSpent = byItsOwn ? await heldOfANote(doors, vault, s.notes[0]!) : null;
    const keptOutput = hash === null && s.kept !== null
      ? (await doors.builder.commitments({ vault, coin: s.kept })).output : null;
    let unchecked: string | undefined;
    const said = (why: string) => { unchecked = why; };
    const confirmed = await until(doors, async () => (byItsOwn
      ? ownPaymentLook(doors, vault, { first, inFlight, heldSpent }, said)
      : aKeptCoinLook(doors, vault, { kept: s.kept, merge: s.merge, hash, keptOutput }, said)));
    if (confirmed === null) {
      throw s.words.notYetSeen(vault, sent.txRef,
        sendFailed ?? (byItsOwn || hash !== null ? unchecked : 'the service could not name the transaction it sent'));
    }
    if (confirmed.state === 'refused') {
      await doors.inFlight.forget(vault, claim).catch(() => { /* the next step settles it, and finds it refused */ });
      throw new PaymentRefusedOnChain(vault, confirmed.transactionHash);
    }
    if (confirmed.state === 'overtaken') {
      await doors.inFlight.forget(vault, claim).catch(() => { /* the next look finds its note gone from the record and forgets it */ });
      throw new StepOvertaken(vault, s.words.what);
    }
    if (confirmed.state === 'not-as-built') throw s.words.notAsBuilt(vault, hash ?? '', confirmed.why);
    const createdIn = confirmed.createdIn === null ? null : confirmed.createdIn as Hex;

    doors.progress?.(s.words.recording);
    try {
      await recordPayment(doors, vault, note.nonce, further.map((n) => n.nonce), s.amount, s.kept, createdIn);
    } catch (cause) {
      throw s.words.landedUnrecorded(vault, createdIn ?? '', (cause as Error)?.message ?? String(cause));
    }
    await doors.inFlight.forget(vault, claim).catch(() => { /* the next step finds it recorded and forgets it */ });
    doors.progress?.('done');
    return { txRef: sent.txRef, hash: byItsOwn ? createdIn : hash, createdIn };
  } catch (e) {
    if (e instanceof PaymentNotYetSeen || e instanceof PaymentNotAsBuilt || e instanceof PaymentLandedUnrecorded
      || e instanceof MergeNotYetSeen || e instanceof MergeNotAsBuilt || e instanceof MergeLandedUnrecorded
      || e instanceof StepOvertaken || e instanceof PaymentRefusedOnChain) throw e;
    throw s.words.notYetSeen(vault, sent.txRef, whyAfterTheSend(e));
  }
}

/**
 * **ONE PERSON PAID PRIVATELY OUT OF THE COMPANY'S VAULT, AGAINST A ROUND THE
 * COMPANY APPROVED.** `order` and `payment` are the proposal's, as this device
 * made them from the company's records (`privatePaymentsHere`); everything that
 * opens a note stays on this device.
 *
 * **THE NOTES ARE THE PLAN'S WHEN IT NAMES THEM.** `notes`, when given, are the
 * notes the run's plan names for this payment, in place order: exactly those
 * are spent, as the vault's record holds them, and nothing is chosen again.
 * Without them the payment's notes are chosen by the one function every
 * payment chooses by.
 *
 * **THE POOL IS ADVANCED ONLY ON THIS PAYMENT'S OWN TRANSACTION.** Two payments
 * out of one note for one amount make the same change coin, so what the vault
 * holds cannot say which of them landed; the transaction's own events can. The
 * change is recorded under that transaction, and under nothing else. A payment
 * that keeps no change is recorded only once the chain shows its own
 * transaction, by the identifiers read from it before the send, take effect.
 */
export async function payPrivatelyFromCompanyVault(
  doors: PayoutDoors,
  input: {
    readonly order: PrivatePaymentOrderOnTheWire; readonly payment: PrivatePaymentOnTheWire;
    readonly notes?: readonly NoteOnTheWire[];
  },
): Promise<{
  txRef: string; transactionHash: string; spent: Hex; change: NoteOnTheWire | null;
  /**
   * `its-own-transaction` when the transaction the service named was read and
   * judged to pay a person, or, for a payment that kept no change, when the
   * chain showed its own transaction take effect; `by-what-it-left` when the
   * send named none and the payment was found by its change. The vault's record
   * is right either way, but another payment of the same amount out of the same
   * note leaves exactly the same change, so only the run, read from the
   * company's account, says whether this person was paid.
   */
  seenAs: 'its-own-transaction' | 'by-what-it-left';
}> {
  const { order, payment } = input;
  const vault = order.vault.toLowerCase() as Hex;
  if (payment.kind !== 'shielded') {
    throw new Error('this payment is not a private one, so it is not paid privately. Nothing was sent.');
  }
  if (payment.paid === true) {
    throw new Error('the company\'s account already records this person paid for this run. Nothing was sent.');
  }
  const seconds = BigInt(Math.floor((doors.now ?? (() => new Date()))().getTime() / 1000));
  if (seconds < BigInt(order.opensAt) || seconds >= BigInt(order.closesAt)) {
    throw new Error('this run can be paid only inside the window its signers approved, and it is not open now. '
      + 'Nothing was sent.');
  }
  const { view, pool } = await openedForAStepOut(doors, vault);

  doors.progress?.('choosing the notes');
  /* In place order: the first is the note the vault is offered, the rest go in the payment's further place. */
  const chosen = input.notes !== undefined
    ? exactlyTheNotesNamed(pool, input.notes, A_PAYMENT.what)
    : await doors.builder.notesForPayment({ notes: pool.notes.map(wireOf), token: payment.token, amount: payment.amount });
  const [note, ...further] = chosen;
  if (note === undefined) throw new Error('no note was chosen for this payment, so nothing was built. Nothing was sent.');
  const { withEvents, chain, secret } = await readyToSpend(doors, vault, view, chosen, A_PAYMENT.what);

  doors.progress?.(A_PAYMENT.building);
  const { payments: _all, ...round } = order;
  const built = await doors.builder.payout({
    vault, account: chain.account, order: round, payment, note, events: withEvents[0]!.events, secret,
    ...(further.length === 0 ? {} : { further: withEvents.slice(1) }),
    chain: {
      blockHash: chain.blockHash, vaultState: chain.vaultState, zswapState: chain.zswapState,
      parameters: chain.parameters, accountState: chain.accountState,
    },
  });
  if (built.spent !== note.nonce) {
    throw new Error('the payment built spends a different note from the one chosen, so it was not sent. Nothing was sent.');
  }

  doors.progress?.(A_PAYMENT.writing);
  await writtenDown(doors, vault, chosen, 'payment', payment.amount);
  const sent = await sendAStepOut(doors, vault, {
    notes: chosen, amount: payment.amount, kept: built.change, merge: false, tx: built.tx,
    send: (v, tx) => handedOver(doors.handOver, {
      tx, call: { kind: 'payout', contract: v, circuit: 'payout', account: doors.account },
      viaService: () => doors.service.payout(v, tx), after: async () => NAMED_BY_NOTHING,
    }), words: A_PAYMENT,
  });
  /* A transaction found by what the payment left may be another payment's, so it is not named as this one's. */
  return {
    txRef: sent.txRef, transactionHash: sent.hash === null ? '' : sent.createdIn ?? '', spent: note.nonce as Hex,
    change: built.change, seenAs: sent.hash === null ? 'by-what-it-left' : 'its-own-transaction',
  };
}

/**
 * **THE VAULT'S OWN NOTES MERGED INTO ONE, SENT FROM THIS DEVICE.** `notes` are
 * the two to four notes the run's plan names for the merge, in place order:
 * exactly those are spent, as the vault's record holds them, and the one coin
 * the vault keeps is worth all of them. A merge sends nothing out of the vault
 * and needs no approval; it is built on what this device read at the indexer
 * the wallet names, written down once built and before it is sent, relayed by the service as
 * a payment is, and the vault's record is advanced by the coin it kept only
 * once its own transaction shows it.
 */
export async function mergeNotesInCompanyVault(
  doors: PayoutDoors,
  input: { readonly vault: Hex; readonly notes: readonly NoteOnTheWire[] },
): Promise<{
  txRef: string; transactionHash: string; spent: readonly Hex[]; kept: NoteOnTheWire;
  /** As a payment's: `by-what-it-left` when the send named no transaction and the merge was found by the coin it kept. */
  seenAs: 'its-own-transaction' | 'by-what-it-left';
}> {
  const vault = input.vault.toLowerCase() as Hex;
  if (input.notes.length < 2 || input.notes.length > STEP_LIMITS.mergeNotes) {
    throw new Error(`a merge takes two to ${STEP_LIMITS.mergeNotes} notes, so nothing was built. Nothing was sent.`);
  }
  const { view, pool } = await openedForAStepOut(doors, vault);
  const notes = exactlyTheNotesNamed(pool, input.notes, A_MERGE.what);
  if (notes.some((n) => lowerOf(n.token) !== lowerOf(notes[0]!.token))) {
    throw new Error('a merge combines notes of one token, and these are of more than one. Nothing was sent.');
  }
  const { withEvents, chain, secret } = await readyToSpend(doors, vault, view, notes, A_MERGE.what);

  doors.progress?.(A_MERGE.building);
  const built = await doors.builder.mergeNotes({
    vault, notes: withEvents, secret,
    chain: {
      blockHash: chain.blockHash, vaultState: chain.vaultState, zswapState: chain.zswapState,
      parameters: chain.parameters, accountState: chain.accountState,
    },
  });
  if (built.spent.length !== notes.length || built.spent.some((n, i) => lowerOf(n) !== lowerOf(notes[i]!.nonce))) {
    throw new Error('the merge built spends other notes than the ones named, so it was not sent. Nothing was sent.');
  }

  doors.progress?.(A_MERGE.writing);
  await writtenDown(doors, vault, notes, 'merge', '0');
  const sent = await sendAStepOut(doors, vault, {
    notes, amount: '0', kept: built.kept, merge: true, tx: built.tx,
    send: (v, tx) => handedOver(doors.handOver, {
      tx, call: { kind: 'merge', contract: v, circuit: 'merge', account: doors.account },
      viaService: () => doors.service.merge(v, tx), after: async () => NAMED_BY_NOTHING,
    }), words: A_MERGE,
  });
  return {
    txRef: sent.txRef, transactionHash: sent.hash === null ? '' : sent.createdIn ?? '',
    spent: notes.map((n) => n.nonce as Hex), kept: built.kept, seenAs: sent.hash === null ? 'by-what-it-left' : 'its-own-transaction',
  };
}
