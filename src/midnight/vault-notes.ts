/**
 * WHAT A VAULT'S OWNER HAS TO KNOW TO SPEND ITS MONEY. V-74.
 *
 * The vault holds a POOL of notes and the chain holds only commitments to them
 * — 32 opaque bytes each, from which nothing can be recovered. Every spend
 * supplies the note itself by witness. **So this file is the money.** If what
 * it holds and what the chain holds ever disagree, the vault's balance is
 * unspendable: not lost to a thief, just permanently stuck. Row 5 of
 * `docs/how-money-can-be-lost.md`, and the reason this is the most carefully
 * tested file in the client.
 *
 * ------------------------------------------------------------------------
 * THE TRAP THIS FILE USED TO CLOSE, AND WHERE IT WENT.
 *
 * A note's commitment covers its BLINDING, so spending a note means producing
 * the same blinding again. This file used to hold that rule: a per-vault seed,
 * `noteBlindingFor` deriving a blinding from a note's nonce, and
 * `nextBlindingFor` deriving the CHANGE's blinding before the change coin
 * existed — which required guessing its nonce, and V-47 is the finding that the
 * change's nonce cannot be derived at all.
 *
 * **The rule now lives in the contract**, as `noteBlindingOf(vault, coin)`,
 * and this file holds no blinding, no seed and no copy of the derivation. Two
 * things follow. The device can no longer be the only holder of something the
 * money depends on, because it holds nothing of the sort; and a DEPOSIT made by
 * an outsider — who could never have held this company's seed — produces a note
 * the company can open, which is C124 and could not have been closed here at
 * any price.
 *
 * What this file still is, and it is still the money: which notes exist, what
 * they are worth, and which one to spend. None of that is on chain and none of
 * it is derivable.
 *
 * ------------------------------------------------------------------------
 * WHAT IS STILL NOT DERIVABLE
 *
 * The note's **index** in the chain's commitment tree, which is what makes a
 * coin QUALIFIED and spendable. It is assigned by the chain and is not a
 * function of anything the owner holds, so it is read from the chain: from the
 * events of the transaction that created the note, which is why that
 * transaction is recorded with the note. Losing it costs a read, not the money,
 * which is the whole difference between this and a stored blinding.
 */
import { toHex, fromHex, type Hex } from '../core/crypto.js';
import type { VaultCoin } from './vault-coins.js';
import type { SettledByTheChain } from './vault-recovery.js';
import { theTransactionTheseEventsAreFrom, type ChainReadIndex } from './note-index.js';
import { planRun, STEP_LIMITS } from './payment-plan.js';

/**
 * One note the vault can spend.
 *
 * No blinding field, deliberately. A blinding stored beside a note is a second
 * copy of what the money depends on; this one is computed from `nonce` every
 * time it is needed.
 */
export interface Note {
  nonce: Hex;
  token: Hex;
  value: bigint;
  /**
   * Where the chain filed its commitment. Read from the chain, never derived.
   *
   * **OPTIONAL, AND THE OPTIONALITY IS THE HONEST PART.** The commitment tree
   * assigns this when the transaction is included; nothing the owner holds is a
   * function of it. **This client never stores one.** A private payment reads
   * it off the events of the transaction in `createdIn` (`indexForSpend` in
   * `note-index.ts`) and sets it, through `withIndexRead`, on its own copy of
   * the pool for that one call. Neither a deposit nor a payout takes one from
   * its caller, and a deposit that arrives with one is refused. The field is
   * still a plain number in the type, so a pool read from disk or rebuilt by
   * `replayVault` can carry one; a payment neither uses nor compares it, drops
   * it from its own copy, and reads the chain. A
   * field that is always present and sometimes invented is worse than one that
   * is sometimes absent, because only the second can be refused.
   *
   * `undefined` means NOT YET READ, never zero. It is not in the commitment —
   * `Vault.compact`'s `noteBlindingOf` deliberately excludes it — so a note
   * whose index is unknown is still on chain, still the vault's, and still
   * worth what it is worth. What it cannot be is SPENT: `sendShielded` builds
   * a Zswap input from the QUALIFIED coin and the merkle path is taken from the
   * chain state at `mt_index`
   * (`ZswapInput.newContractOwned`, `midnight-js-contracts/dist/index.mjs`), so
   * a wrong index does not reliably produce a refusal anyone can act on.
   *
   * **Losing an index costs a read; losing a nonce costs the money.** That
   * asymmetry is why one is stored and the other is never derived — and
   * `witnessesOver` below is where the read is DEMANDED rather than
   * substituted for.
   */
  index?: bigint;
  /**
   * **THE TRANSACTION THAT CREATED THIS NOTE, BY ITS HASH, AS THE CHAIN
   * REPORTED IT WHEN THE TRANSACTION WAS FINALISED.**
   *
   * It is what makes the index readable at all: the chain's events for that
   * transaction carry the note's place in the tree. A spend reads the index
   * from them again every time rather than trusting a number written down here.
   *
   * Absent for a note recorded before this was kept, and for a finalised result
   * that carried no hash. Such a note is still on chain and still the vault's;
   * its transaction is recorded by naming it to `recordCreatingTransaction`.
   */
  createdIn?: Hex;
}

/**
 * The vault's private state, as a device holds it.
 *
 * **NO SEED, AND NO BLINDING RULE. `S6a`, and this is a deletion rather than a
 * move.** Both used to live here: a per-vault seed, and `noteBlindingFor`
 * deriving a note's blinding from it. The contract now derives every blinding
 * in-circuit from the coin and the vault's own address (`Vault.compact`'s
 * `noteBlindingOf`), for a reason this layer could not have solved — a deposit
 * arrives from OUTSIDE, and an outside depositor cannot hold this company's
 * seed, so `C124` could never be closed while the rule lived on a device.
 *
 * **AND THE SENTENCE THAT USED TO BE HERE WAS FALSE WHEN IT WAS WRITTEN, WHICH
 * IS WHY ITS CORRECTION IS NOT JUST TIDYING. `C202`.**
 *
 * It said the seed was *"sealed and shared exactly like the payout seed"*. It
 * never was. **Nothing in `src/core/` has ever mentioned a note seed** — the
 * claim described an arrangement that did not exist, in the file that calls
 * itself the money, which is where a round goes to find out how the seed is
 * handled. Worse, the home it named is the wrong one twice over: the payout
 * seed is minted in our process (`src/core/account.ts`, and that is `C162`),
 * and it lives under a key derived from the account viewing key, **which
 * crosses the wire to our server on the vault-threshold routes** — so anything
 * sealed that way hands us the vault's balance the first time a signer changes
 * a threshold. `docs/scope-the-vault-system.md` §3.3 reverses it: a vault's
 * secrets are **wrapped per signer**, and `Purpose` stays at six.
 *
 * **The seed itself is gone, so it needs no home.** `S6d` was scheduled to give
 * it one; `S6a` had already removed the thing. A secret that does not exist
 * cannot be minted in the wrong process, cannot be sealed under the wrong key,
 * and cannot be lost with a device — which is a better answer than the one the
 * scope asked for, and the reason it is recorded here rather than silently
 * enjoyed. **What still needs that envelope is the POOL below**, which is not
 * derivable from anything and is not on chain: see `src/midnight/vault-pool.ts`.
 *
 * Three consequences, and the third is the one worth stating to a customer:
 *
 *   - there is no second implementation of the blinding rule to disagree with
 *     the contract's, which is what M-104 keeps costing this project;
 *   - `nextBlindingFor` is gone, and with it the guess it rested on. It
 *     derived the change's blinding from `changeNonceOf` BEFORE the change coin
 *     existed, and V-47 is the finding that the change's nonce is not derivable
 *     — a wrong guess there committed the change under a blinding nobody could
 *     reproduce, on every payment;
 *   - a lost device can no longer lose a secret the money depends on, because
 *     there is no longer such a secret. What still cannot be recovered without
 *     the history is a note's NONCE, which is `vault-recovery.ts`'s subject.
 */
export interface VaultNotes {
  notes: Note[];
  /**
   * **WHAT A REBUILD WORKED OUT ABOUT NONCES ITS RECORDS DESCRIBED MORE THAN ONE
   * WAY**, written into the version the rebuild files and into no other.
   *
   * It is a record of what the chain said, not a note and not money: nothing
   * that chooses, spends or counts a note reads it. It is kept because the
   * chain can answer which description is the coin only while it holds that
   * coin, and a rebuild after the coin is spent needs the earlier answer.
   */
  settled?: readonly SettledByTheChain[];
}

/**
 * **WHETHER A PAYMENT CAN SPEND THIS NOTE AT ALL. THE ONE STATEMENT OF IT.**
 *
 * A payment spends a note at the place the chain filed it, and that place is
 * read from the events of the transaction that created the note
 * (`indexForSpend`). So a note a payment can spend is a note that records that
 * transaction, as a value with the shape of a transaction hash. A note that
 * records nothing, or records something no spend could read from, is still on
 * chain and still the vault's; what it cannot be is the note a payment takes.
 *
 * The shape is the product's own statement of it, not a second one written
 * here.
 */
export const aPaymentCanSpend = (note: Note): boolean => {
  if (note.createdIn === WILL_BE_RECORDED) return String(note.nonce).startsWith('sim:');
  if (note.createdIn === undefined) return false;
  try {
    theTransactionTheseEventsAreFrom([], { hash: note.createdIn });
    return true;
  } catch {
    return false;
  }
};

/**
 * **THE CHANGE A WALK PUTS BACK HAS NO TRANSACTION YET, AND THE WALK ASSUMES
 * THE PAYMENT THAT MAKES IT WILL RECORD ONE.** A payment records its change
 * note's transaction when the finalised call reports a hash, which is the
 * ordinary case; when it reports none, the change is written without one and a
 * later payment of the same run passes it over, so a run judged to fit can stop
 * there, refused by name before its money moves. `paymentsFit` marks the change
 * with this, which is not a transaction hash, is not exported, and cannot be
 * read by any spend. It counts only on a note whose nonce is the walk's own
 * `sim:` one, which no real note has; a note carrying either that escaped the
 * walk is refused the moment it is handed to the circuit or its index is read.
 */
const WILL_BE_RECORDED = 'sim:recorded-by-the-payment-that-makes-it' as Hex;

/**
 * **SMALLEST NOTE THAT COVERS IT, OUT OF THE NOTES HANDED IN.** No payment
 * chooses by this: a payment's notes are `choosingNotesToSpend`'s. It is the
 * ordering a model of the circuit uses where its notes carry no transaction -
 * a stand-in witness that hands the vault one covering note - and it is
 * deterministic, ties broken by nonce, so the model never depends on array
 * order.
 */
export const smallestNoteCovering = (notes: readonly Note[], token: Hex, amount: bigint): Note | undefined => {
  const usable = notes.filter((n) => n.token === token && n.value >= amount);
  if (usable.length === 0) return undefined;
  return usable.reduce((a, b) =>
    b.value < a.value || (b.value === a.value && b.nonce < a.nonce) ? b : a);
};

/** What `choosingNotesToSpend` answers. */
export type NoteChoice =
  /** `notes` in place order: the first is the note the payment is offered, the rest the further notes it draws on. */
  | { readonly of: 'chosen'; readonly notes: readonly Note[]; readonly passedOver: readonly Note[] }
  | { readonly of: 'no-notes-of-token' }
  | { readonly of: 'none-covers'; readonly largest: bigint; readonly held: bigint; readonly count: number }
  | { readonly of: 'stranded'; readonly notes: readonly Note[] };

/**
 * The notes one payment's step draws on, as the run planner plans a single
 * payment, or nothing when its step cannot be made without a merge first.
 */
const aPaymentsStep = (notes: readonly Note[], token: Hex, amount: bigint, spendable: (n: Note) => boolean): Note[] | undefined => {
  const plan = planRun({
    token,
    notes: notes.map((n) => ({ id: n.nonce, token: n.token, value: n.value, spendable: spendable(n) })),
    units: [{ kind: 'payment', payees: [{ id: 'this payment', amount, nonce: 'this payment' }] }],
  });
  const step = plan.ok ? plan.steps[0] : undefined;
  if (step === undefined || step.kind === 'merge') return undefined;
  const byNonce = new Map(notes.map((n) => [n.nonce, n]));
  return step.notes.map((r) => {
    if (r.kind !== 'held') throw new Error('a single payment\'s first step draws only on notes the vault holds now');
    return byNonce.get(r.id as Hex)!;
  });
};

/**
 * **WHICH NOTES A PAYMENT OF `amount` IN `token` SPENDS, OR WHY NONE - DECIDED
 * HERE AND ONLY HERE.**
 *
 * Every question about it asks this: the payment, the witness the circuit is
 * offered, the walk that decides whether a run fits, and the check a door
 * makes before the first fee. Two functions asking two different questions
 * about the same pool is how a vault that can pay was told it could not, and
 * how a run judged to fit stopped half way.
 *
 * **THE CHOICE IS THE RUN PLANNER'S** (`planRun`): the largest notes first, as
 * few as cover the payment, at most as many as one payment takes. So a payment
 * planned with the run and a payment made on its own spend the same notes, and
 * the note the vault is offered first is the planner's, never a second choice
 * made by the witness. A payment that needs more notes than one step takes is
 * not made here: the notes have to be merged first.
 *
 * **ONLY NOTES A PAYMENT CAN SPEND ARE CHOSEN, AND THE OTHERS ARE NAMED.** A
 * note that records no creating transaction is still on chain and still the
 * vault's; it is passed over and named in the answer, so whoever asked can say
 * out loud that the vault holds money a payment cannot reach yet. When only
 * those notes would make the payment, the answer is `stranded`, naming them,
 * and never *nothing big enough*: those are two different repairs.
 */
export const choosingNotesToSpend = (notes: readonly Note[], token: Hex, amount: bigint): NoteChoice => {
  const ofToken = notes.filter((n) => n.token === token);
  if (ofToken.length === 0) return { of: 'no-notes-of-token' };
  const inOrder = (a: Note, b: Note) =>
    a.value > b.value ? -1 : a.value < b.value ? 1 : a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0;
  const cannot = ofToken.filter((n) => !aPaymentCanSpend(n)).sort(inOrder);
  const chosen = aPaymentsStep(ofToken, token, amount, aPaymentCanSpend);
  if (chosen !== undefined) return { of: 'chosen', notes: chosen, passedOver: cannot };
  if (cannot.length > 0 && aPaymentsStep(ofToken, token, amount, () => true) !== undefined) {
    return { of: 'stranded', notes: cannot };
  }
  const most = ofToken.reduce((a, b) => (b.value > a.value ? b : a));
  return {
    of: 'none-covers',
    largest: most.value,
    held: ofToken.reduce((n, x) => n + x.value, 0n),
    count: ofToken.length,
  };
};

/**
 * **WHY NO NOTE CAN MAKE A PAYMENT, IN WORDS**, for every choice that is not
 * `chosen`. One sentence per reason, used by the refusal a payment gives and by
 * the answer the walk below gives, so the two never say it differently.
 */
const whyNoNote = (
  choice: Exclude<NoteChoice, { of: 'chosen' }>, token: Hex, amount: bigint,
): string => {
  if (choice.of === 'no-notes-of-token') return `this vault holds no notes of ${token}`;
  if (choice.of === 'none-covers') {
    return `no ${STEP_LIMITS.paymentNotes} notes a payment can spend cover ${amount}: the largest is ${choice.largest} and the pool holds `
      + `${choice.held} across ${choice.count} notes. Merge them first — a payment cannot.`;
  }
  const which = choice.notes.map((n) => `${n.nonce} (${n.value})`).join(', ');
  return `the notes this vault can spend do not cover ${amount}, and ${choice.notes.length === 1 ? 'one more note' : `${choice.notes.length} more notes`} would: ${which}. `
    + `${choice.notes.length === 1 ? 'It does not record' : 'None of them records'} which transaction `
    + 'created it with a hash a spend can read, so a payment cannot read its place in the chain\'s '
    + 'commitment tree. The money is still on chain and still the vault\'s. Name the transaction '
    + 'that paid it in to recordCreatingTransaction, or rebuild the pool so the chain is asked, and '
    + 'pay again.';
};

/**
 * The notes a payment of `amount` in `token` spends, in place order, or a
 * refusal that says which of the three reasons it is and what resolves it. See
 * `choosingNotesToSpend`, which is where the decision is.
 */
export const notesToSpend = (notes: readonly Note[], token: Hex, amount: bigint): Note[] => {
  const choice = choosingNotesToSpend(notes, token, amount);
  if (choice.of === 'chosen') return [...choice.notes];
  throw new Error(whyNoNote(choice, token, amount));
};

/**
 * The pool after a payment: the spent note gone, its change in its place.
 *
 * **THE DEFECT THIS EXISTS TO PREVENT** was in the first test helper written
 * for the vault: it did not carry the coin forward, so it could make exactly
 * ONE payment and every later one was refused as not matching what the vault
 * held. The same mistake in a client is a payroll that pays its first employee
 * and stops.
 *
 * ------------------------------------------------------------------------
 * **`C239` IS TAKEN HERE: THE CHANGE NOTE IS READ, NOT DERIVED.**
 *
 * This used to compute the change's nonce with `changeNonceOf` — the kernel's
 * `nonce_evolve/2` hash — while its caller `VaultLedger.payout` was holding the
 * call's own result and could read the coin out of it. The derivation was
 * measured correct and is still there, in `vault-recovery.ts`, where it belongs:
 * **the fallback for a reading that was never captured or has been lost.**
 *
 * The objection was never correctness. It is `V-47`'s rule — *the change coin
 * is an OUTPUT of the transaction* — and the failure it names: the day the
 * kernel changes a domain separator, the read still works and the derivation
 * silently does not, on every payment, for a note nobody can then spend.
 *
 * **AND TAKING IT TURNED UP A SECOND DEFECT THAT WAS ALREADY THERE.**
 * `changeCoinOf` was written against the ENCODED Zswap local state a circuit
 * context carries, and the SDK hands a client the DECODED one, in which an
 * address is a hex string and `color` is called `type`. Handed that, the old
 * reader matched nothing and answered `undefined` — *"this payout left no
 * change"* — which is a note dropped from the pool, silently, on every payment.
 * `vault-coins.ts` now reads both spellings and refuses a third. **So the read
 * this function now depends on did not work until this round**, which is worth
 * knowing before anyone calls the derivation the safer option.
 *
 * `change` is what `changeCoinOf` answered: the coin, or `undefined` for a note
 * spent exactly. **Both are checked against the arithmetic rather than
 * trusted**, and a disagreement is refused. That is not a second source of
 * truth for the nonce — it is the contract's own subtraction, which this
 * function already had to do to know what to remove.
 */
export const afterPayment = (
  state: VaultNotes,
  spentNonce: Hex,
  amount: bigint,
  /**
   * The coin the payment handed back, read from the call's own outputs, or
   * `undefined` when the note was spent exactly and the contract emitted none.
   */
  change: VaultCoin | undefined,
  /**
   * The hash of the payment's own transaction, which created the change note.
   *
   * **The change note's INDEX is never taken here.** The commitment tree
   * assigns it when the transaction is applied, and it is read later from that
   * transaction's events. What is recorded is where to read it from.
   */
  createdIn?: Hex,
): VaultNotes => afterStep(state, { spent: [spentNonce], pays: amount, kept: change }, createdIn);

/**
 * **ONE STEP OUT OF THE VAULT, AS THE CHAIN HOLDS IT: EVERY NOTE IT SPENT GONE,
 * AND THE ONE COIN IT KEPT IN THEIR PLACE.** A payment that drew on several
 * notes, a batch and a merge each spend up to four notes and keep at most one
 * coin; recording only the first note spent would leave the pool offering
 * notes the chain has already nullified, and every later payment that chose
 * one would be refused.
 *
 *   - `spent`: the nonces of every note the step spent, in place order;
 *   - `pays`: what left the vault - a payment's amount, a batch's total, and
 *     nothing for a merge, which sends nothing out;
 *   - `kept`: the coin the step handed back, read from the call's own outputs,
 *     or `undefined` when it kept none. A merge always keeps one.
 *
 * Every figure is checked against the contract's own arithmetic - the coin
 * kept is worth what the spent notes held less what left - and a disagreement
 * is refused rather than recorded.
 */
export const afterStep = (
  state: VaultNotes,
  step: { readonly spent: readonly Hex[]; readonly pays: bigint; readonly kept: VaultCoin | undefined; readonly merge?: boolean },
  createdIn?: Hex,
): VaultNotes => {
  if (step.spent.length === 0) throw new Error('a step that spent no note is not a step out of this vault');
  if (new Set(step.spent).size !== step.spent.length) {
    throw new Error('a step names one note twice; the vault spends a note once, so this is not a step it made');
  }
  if (step.merge === true && (step.spent.length < 2 || step.pays !== 0n)) {
    throw new Error('a merge spends at least two notes and sends nothing out of the vault; this is not one');
  }
  const spentNotes = step.spent.map((nonce) => {
    const n = state.notes.find((x) => x.nonce === nonce);
    if (!n) throw new Error(`this vault has no note ${nonce} to spend; its pool and the chain disagree`);
    return n;
  });
  const first = spentNotes[0]!;
  const what = spentNotes.length === 1 ? `note ${first.nonce} holds` : `notes ${step.spent.join(', ')} hold`;
  if (spentNotes.some((n) => n.token !== first.token)) {
    throw new Error(`${what} more than one token, and a step spends notes of the token it pays only`);
  }
  const held = spentNotes.reduce((t, n) => t + n.value, 0n);
  if (step.pays > held) {
    throw new Error(spentNotes.length === 1
      ? `note ${first.nonce} holds ${held} and the payment is ${step.pays}`
      : `${what} ${held} together and the step pays ${step.pays}`);
  }
  const rest = state.notes.filter((n) => !step.spent.includes(n.nonce));
  const kept = held - step.pays;
  const label = spentNotes.length === 1 ? `note ${first.nonce}` : `notes ${step.spent.join(', ')}`;

  /*
   * Change of exactly zero is DROPPED rather than kept. The contract emits no
   * change coin when a note is spent exactly, so keeping a zero note here would
   * be a note the chain does not have: the divergence that makes a pool
   * unspendable. The READ must agree, and if it does not, this refuses.
   */
  if (kept === 0n) {
    if (step.kept !== undefined) {
      throw new Error(
        `${label} ${spentNotes.length === 1 ? 'was' : 'were'} spent exactly and the contract emits no change for that, but `
        + `the call's outputs carry a coin of ${step.kept.value} coming back to the vault. The `
        + 'pool cannot be advanced from two answers about the same money — rebuild it from the '
        + 'chain with replayVault.');
    }
    return { ...state, notes: rest };
  }

  if (step.kept === undefined) {
    /*
     * THE EXPENSIVE DIRECTION, AND THE REASON THIS IS A THROW. The contract
     * kept a coin; the read says it did not. Advancing the pool on the read
     * would drop that note - the commitment stays on chain and nobody can ever
     * say which note it describes. Advancing it on the arithmetic would invent
     * a nonce.
     */
    throw new Error(
      `${what} ${held} and the step pays ${step.pays}, so the vault kept `
      + `${kept} — but the call's outputs carry no coin coming back to it. Something is being `
      + 'read that is not this step. The pool is NOT advanced: the coin is on chain and a '
      + 'guess at its nonce is a note nobody can spend.');
  }
  if (step.kept.value !== kept) {
    throw new Error(
      `the coin coming back to this vault is worth ${step.kept.value} and the arithmetic says `
      + `${kept} (${label} of ${held}, paying ${step.pays}). These are two claims `
      + 'about the same money and there is no correct way to pick one.');
  }
  if (step.kept.token !== first.token) {
    throw new Error(
      `the coin coming back to this vault is of ${step.kept.token} and the note spent was of `
      + `${first.token}. That is not this payout's change.`);
  }

  return {
    ...state,
    notes: [...rest, {
      nonce: step.kept.nonce,
      token: step.kept.token,
      value: step.kept.value,
      ...(createdIn === undefined ? {} : { createdIn }),
    }],
  };
};

/**
 * **WHETHER A RUN CAN BE PAID OUT OF THIS POOL, ONE PAYMENT AT A TIME.**
 *
 *
 * **A SUM IS THE WRONG QUESTION AND ALWAYS WAS.** A payment does not merge -
 * a vault holding three notes of 40 cannot pay 100, because one payment draws
 * on two notes at most - so a pool whose TOTAL covers a run can still stop
 * halfway through it, and a run that stops halfway has failed at the only
 * thing it was for. This walks the payments in the order they will be made,
 * through the SAME choice of notes `choosingNotesToSpend` makes for the payment
 * path, so what it answers is what the run will do rather than a number beside
 * it.
 *
 * **IT MODELS VALUES AND NOT NONCES, AND THAT CANNOT CHANGE THE ANSWER.** A
 * change note's nonce is not knowable before the payment is made — that is
 * `V-47` — so the notes this walk puts back carry a synthetic one. The only
 * thing the choice uses a nonce for is breaking a tie between notes of EQUAL
 * value, and either side of such a tie leaves the pool holding the same values.
 * So a tie broken differently here is a different note chosen and an identical
 * verdict. Stated rather than left to be worried about later.
 *
 * **IT IS NOT A RECONCILIATION AND MUST NEVER BE MISTAKEN FOR ONE.** It reads
 * the pool only. `VaultLedger.balance` is what asks the chain, and an
 * affordability check that skipped it would be answering out of bookkeeping
 * nothing had checked — which is the whole of `C198`.
 */
export const paymentsFitAnswer = (
  state: VaultNotes,
  payments: ReadonlyArray<{ token: Hex; amount: bigint }>,
): PaymentsFitAnswer => {
  let notes: readonly Note[] = state.notes;
  for (const [i, p] of payments.entries()) {
    /*
     * **AND THE NOTE IT WOULD SPEND IS ONE A PAYMENT CAN SPEND, BECAUSE THE SAME
     * FUNCTION DECIDES BOTH.** This used to choose with one rule and then ask a
     * second question of the note it chose, so a vault holding a small note with
     * no recorded transaction beside a large one that had one was told it could
     * not pay. The change this walk puts back does not exist yet, and is marked
     * as a note a payment can spend on the assumption `WILL_BE_RECORDED` states.
     */
    const choice = choosingNotesToSpend(notes, p.token, p.amount);
    if (choice.of !== 'chosen') {
      return {
        of: 'does-not-fit',
        payment: i + 1,
        payments: payments.length,
        why: `payment ${i + 1} of ${payments.length} cannot be made out of this vault: `
          + whyNoNote(choice, p.token, p.amount),
      };
    }
    const chosen = choice.notes;
    const rest = notes.filter((n) => !chosen.some((c) => c.nonce === n.nonce));
    const kept = chosen.reduce((t, n) => t + n.value, 0n) - p.amount;
    notes = kept === 0n
      ? rest
      /*
       * `sim:` rather than a plausible 64 hex characters, deliberately. A
       * synthetic nonce that LOOKS like a real one is a value somebody
       * eventually writes to a pool; one that cannot be mistaken for a nonce is
       * refused by everything downstream the moment it escapes this function.
       */
      : [...rest, {
        nonce: `sim:${i}` as Hex, token: p.token, value: kept, index: 0n,
        createdIn: WILL_BE_RECORDED,
      }];
  }
  return { of: 'fits' };
};

/**
 * **THE ANSWER THE WALK GIVES, TYPED**, so whoever asked can tell a run the
 * notes cannot make from a failure to ask without reading a sentence. It is
 * plain data, so it crosses into and out of a page's background thread as it is.
 */
export type PaymentsFitAnswer =
  | { readonly of: 'fits' }
  | { readonly of: 'does-not-fit'; readonly payment: number; readonly payments: number; readonly why: string };

/** The same walk, refusing with its reason when the notes cannot make the payments. */
export const paymentsFit = (
  state: VaultNotes,
  payments: ReadonlyArray<{ token: Hex; amount: bigint }>,
): void => {
  const answer = paymentsFitAnswer(state, payments);
  if (answer.of === 'does-not-fit') throw new Error(answer.why);
};

/**
 * The pool after a deposit. Stated in `vault-note-deposit.ts`, which imports
 * nothing that reaches the chain's own readers, so a company's page can record
 * a deposit with the same rule every other writer uses.
 */
export { afterDeposit } from './vault-note-deposit.js';

/**
 * **A COPY OF THE POOL WITH ONE NOTE'S INDEX, AS THE CHAIN REPORTED IT.**
 *
 * It takes only a `ChainReadIndex`, which only `noteIndexFrom` makes, so a
 * plain number does not type-check here. A payment uses it on its own copy of
 * the pool for one call; the index is not saved.
 */
export const withIndexRead = (state: VaultNotes, nonce: Hex, index: ChainReadIndex): VaultNotes => {
  const note = state.notes.find((n) => n.nonce === nonce);
  if (!note) {
    throw new Error(
      `this vault's pool has no note ${nonce}, so there is nothing to record an index against. `
      + 'The pool may have moved on since the note was chosen; choose again.');
  }
  return {
    ...state,
    notes: state.notes.map((n) => (n.nonce === nonce ? { ...n, index } : n)),
  };
};

/** What the vault holds of one token. Public knowledge to its owner only. */
export const balanceOf = (state: VaultNotes, token: Hex): bigint =>
  state.notes.filter((n) => n.token === token).reduce((n, x) => n + x.value, 0n);

/**
 * **THE WITNESSES FOR A CALL THAT HAS NO POOL, AND IT REFUSES RATHER THAN
 * ANSWERS.**
 *
 * `depositUnshielded`, `payoutUnshielded` and `forgetUnshielded` read no
 * witness: public money is a ledger balance, so there is no note to choose. The
 * SDK still binds a witness set to the compiled contract, and something has to
 * be bound.
 *
 * **BINDING A POOL WOULD BE THE WRONG SHAPE, AND AN EMPTY ONE WOULD BE
 * WORSE.** Loading a pool for a call that cannot use it is what made a public
 * deposit require the very record `C242` says a new vault has not got; handing
 * over `{ notes: [] }` instead would be this client asserting a vault holds no
 * private money, on a path that has not asked and cannot know.
 *
 * **So it throws by name.** If any of the three circuits ever does ask for a
 * note, that is this client's model of the contract being wrong, and it stops
 * with a sentence rather than proceeding on a fabricated one. Nothing here can
 * lose money; everything here refuses to guess.
 */
/**
 * The vault's second witness, for the calls that need the vault's nonce secret
 * (a split, and nothing else this client builds yet). A call built without the
 * secret opened refuses here rather than answering with a value the contract
 * would refuse anyway.
 */
export const noSecretHere = () => (): never => {
  throw new Error(
    'this vault call needs the vault\'s nonce secret, and this call was built without it. Nothing '
    + 'was proved or sent. A split, or a change to the secret, is built where the secret is opened.');
};

export const witnessesWithoutAPool = () => ({
  noteToSpend: (_ctx: unknown, _token: Uint8Array, amount: bigint): never => {
    throw new Error(
      `this vault was asked which note to spend for ${amount} on a call that has no note pool. `
      + 'The unshielded circuits move a LEDGER BALANCE and read no witness, so either the '
      + 'contract has changed or this call was routed to the wrong circuit. Nothing is '
      + 'substituted: a note handed over here would be one this path never established the '
      + 'vault holds.');
  },
  nonceSecret: noSecretHere(),
});

/**
 * The witnesses the generated vault contract calls, over this state, for a call
 * that is offered `offer` as its first note.
 *
 * **THE WITNESS CHOOSES NOTHING.** A payment's notes are chosen before the
 * call, by `choosingNotesToSpend`, and the same choice names the further notes
 * the call takes as an argument. The witness hands the circuit exactly the
 * first of them, so the note the vault spends first and the notes beside it
 * come from one choice, never from two that could differ. A call with nothing
 * offered refuses by name.
 */
export const witnessesOver = (
  get: () => VaultNotes, pending: { spending?: Hex },
  /** The note this call is offered first, or a getter read at the moment the circuit asks, for witnesses bound once. */
  offered?: Hex | (() => Hex | undefined),
) => ({
  noteToSpend: (ctx: unknown, token: Uint8Array, amount: bigint) => {
    const offer = typeof offered === 'function' ? offered() : offered;
    if (offer === undefined) {
      throw new Error(
        `this vault was asked which note to spend for ${amount} on a call that was offered none. A payment's `
        + 'notes are chosen before the call, and the first of them is the one offered here. Nothing is '
        + 'substituted.');
    }
    const note = get().notes.find((n) => n.nonce === offer);
    if (note === undefined) {
      throw new Error(
        `the note offered to this call, ${offer}, is not in the copy of the pool the call was given. `
        + 'The pool may have moved on since the notes were chosen; choose again.');
    }
    if (note.token !== toHex(token)) {
      throw new Error(
        `the note offered to this call is of ${note.token} and the call pays ${toHex(token)}. `
        + 'Nothing is spent from a note of another token.');
    }
    /*
     * **THE ONE PLACE AN UNREAD INDEX IS REFUSED, AND IT IS REFUSED RATHER
     * THAN SUBSTITUTED FOR.** See `Note.index`.
     *
     * The chain assigns `mt_index` when the transaction is included, so a note
     * recorded by a deposit or a payout carries `undefined` until its index is
     * read from that transaction's events. A private payment reads it just
     * before the call and hands it in for that call only. Handing the contract
     * a zero, or the previous note's index, builds a transaction whose Zswap
     * input carries a merkle path for a different leaf, and a wrong index can
     * end in a WebAssembly trap inside the ledger rather than a refusal with
     * anything a person can act on.
     *
     * **This is refused at SELECTION and not at selection's edges**, so the
     * message names the note and what has to happen to it. The money is not
     * lost — the index is not in the commitment (`Vault.compact`'s
     * `noteBlindingOf` excludes it deliberately) — and it does not become lost
     * by waiting.
     */
    if (note.index === undefined) {
      throw new Error(
        `the vault's note ${note.nonce} is the one to spend for ${amount}, and its position in `
        + 'the chain\x27s commitment tree has not been read for this call. It cannot be spent '
        + 'until it is: the transaction would carry a merkle path for a different leaf. The note '
        + 'is safe, because an index is not part of a commitment. Its index is read from the '
        + 'events of the transaction that created it, which a private payment does before it '
        + 'calls. NOTHING HERE MAY SUBSTITUTE A NUMBER.');
    }
    pending.spending = note.nonce;
    return [ctx, {
      nonce: fromHex(note.nonce), color: fromHex(note.token),
      value: note.value, mt_index: note.index,
    }];
  },
  /*
   * `noteBlinding` AND `nextBlinding` USED TO BE HERE.
   *
   * The vault declares one witness now. Coin selection is still the device's,
   * because which notes exist is exactly what the contract must not see; the
   * blinding is not, because a value the device chooses is a value the device
   * can choose wrongly, and a wrongly blinded note cannot be spent again.
   */
  nonceSecret: noSecretHere(),
});
