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
 * function of anything the owner holds, so it is read from the chain and cached
 * here. Losing it costs a rescan, not the money — which is the whole difference
 * between this and a stored blinding.
 */
import { toHex, fromHex, type Hex } from '../core/crypto.js';
import type { VaultCoin } from './vault-coins.js';

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
   * **OPTIONAL SINCE `S6f`, AND THE OPTIONALITY IS THE HONEST PART.** The
   * commitment tree assigns this when the transaction is included; nothing the
   * owner holds is a function of it, and **nothing in this repository reads it
   * back** — `payout` took it as a parameter no production caller supplied, and
   * a deposit had to invent one. A field that is always present and sometimes
   * invented is worse than one that is sometimes absent, because only the
   * second can be refused.
   *
   * `undefined` means NOT YET READ, never zero. It is not in the commitment —
   * `Vault.compact`'s `noteBlindingOf` deliberately excludes it — so a note
   * whose index is unknown is still on chain, still the vault's, and still
   * worth what it is worth. What it cannot be is SPENT: `sendShielded` builds
   * a Zswap input from the QUALIFIED coin and the merkle path is taken from the
   * chain state at `mt_index`
   * (`ZswapInput.newContractOwned`, `midnight-js-contracts/dist/index.mjs`), so
   * a wrong index is a transaction the chain refuses.
   *
   * **Losing an index costs a rescan; losing a nonce costs the money.** That
   * asymmetry is why one is stored and the other is never derived — and
   * `witnessesOver` below is where the rescan is DEMANDED rather than
   * substituted for.
   */
  index?: bigint;
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
}

/**
 * The note to spend for a payment of `amount` in `token`.
 *
 * SMALLEST NOTE THAT COVERS IT, and the choice is not arbitrary:
 *
 *   - it keeps large notes intact, so a big payment later does not need a merge
 *   - it produces the smallest change, so the pool does not fill with dust
 *   - it is deterministic, so two operators who pick independently pick the
 *     same note and collide visibly rather than both half-succeeding (B3)
 *
 * Ties broken by nonce so the answer never depends on array order, which a
 * rebuild from the chain does not preserve.
 *
 * **It does not merge.** A vault holding two notes of 60 cannot pay 100, and
 * this says so rather than silently paying 60. Merging is a maintenance action
 * on its own schedule, never something a payroll discovers it needs at run time
 * (V-58, B12).
 */
export const noteToSpend = (notes: Note[], token: Hex, amount: bigint): Note => {
  const ofToken = notes.filter((n) => n.token === token);
  if (ofToken.length === 0) {
    throw new Error(`this vault holds no notes of ${token}`);
  }
  const usable = ofToken.filter((n) => n.value >= amount);
  if (usable.length === 0) {
    const most = ofToken.reduce((a, b) => (b.value > a.value ? b : a));
    const held = ofToken.reduce((n, x) => n + x.value, 0n);
    throw new Error(
      `no single note covers ${amount}: the largest is ${most.value} and the pool holds ` +
      `${held} across ${ofToken.length} notes. Merge them first — a payment cannot.`);
  }
  return usable.reduce((a, b) =>
    b.value < a.value || (b.value === a.value && b.nonce < a.nonce) ? b : a);
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
   * Where the chain filed the change note's commitment, if it is known yet.
   *
   * **`undefined` is the ordinary case at the moment of a payment**, and it is
   * recorded rather than invented — see `Note.index`. The transaction has to be
   * included before the commitment tree assigns one.
   */
  changeIndex?: bigint,
): VaultNotes => {
  const spent = state.notes.find((n) => n.nonce === spentNonce);
  if (!spent) {
    throw new Error(
      `this vault has no note ${spentNonce} to spend; its pool and the chain disagree`);
  }
  if (amount > spent.value) {
    throw new Error(`note ${spentNonce} holds ${spent.value} and the payment is ${amount}`);
  }
  const rest = state.notes.filter((n) => n.nonce !== spentNonce);
  const kept = spent.value - amount;

  /*
   * Change of exactly zero is DROPPED rather than kept. The contract emits no
   * change coin when a note is spent exactly, so keeping a zero note here would
   * be a note the chain does not have: the divergence that makes a pool
   * unspendable. The READ must agree, and if it does not, this refuses.
   */
  if (kept === 0n) {
    if (change !== undefined) {
      throw new Error(
        `note ${spentNonce} was spent exactly and the contract emits no change for that, but `
        + `the call's outputs carry a coin of ${change.value} coming back to the vault. The `
        + 'pool cannot be advanced from two answers about the same money — rebuild it from the '
        + 'chain with replayVault.');
    }
    return { ...state, notes: rest };
  }

  if (change === undefined) {
    /*
     * THE EXPENSIVE DIRECTION, AND THE REASON THIS IS A THROW. The contract
     * kept a change coin; the read says it did not. Advancing the pool on the
     * read would drop that note — the commitment stays on chain and nobody can
     * ever say which note it describes (`B1`). Advancing it on the arithmetic
     * would invent a nonce, which is the thing `C239` just removed.
     */
    throw new Error(
      `note ${spentNonce} holds ${spent.value} and the payment is ${amount}, so the vault kept `
      + `${kept} — but the call's outputs carry no coin coming back to it. Something is being `
      + 'read that is not this payout. The pool is NOT advanced: the change is on chain and a '
      + 'guess at its nonce is a note nobody can spend.');
  }
  if (change.value !== kept) {
    throw new Error(
      `the coin coming back to this vault is worth ${change.value} and the arithmetic says `
      + `${kept} (note ${spentNonce} of ${spent.value}, paying ${amount}). These are two claims `
      + 'about the same money and there is no correct way to pick one.');
  }
  if (change.token !== spent.token) {
    throw new Error(
      `the coin coming back to this vault is of ${change.token} and the note spent was of `
      + `${spent.token}. That is not this payout's change.`);
  }

  return {
    ...state,
    notes: [...rest, {
      nonce: change.nonce,
      token: change.token,
      value: change.value,
      index: changeIndex,
    }],
  };
};

/**
 * **WHETHER A RUN CAN BE PAID OUT OF THIS POOL, ONE PAYMENT AT A TIME.**
 *
 *
 * **A SUM IS THE WRONG QUESTION AND ALWAYS WAS.** `noteToSpend` does not merge
 * — a vault holding two notes of 60 cannot pay 100 — so a pool whose TOTAL
 * covers a run can still stop halfway through it, and a run that stops halfway
 * has failed at the only thing it was for. This walks the payments in the order
 * they will be made, through the SAME `noteToSpend` the payment path uses, so
 * what it answers is what the run will do rather than a number beside it.
 *
 * **IT MODELS VALUES AND NOT NONCES, AND THAT CANNOT CHANGE THE ANSWER.** A
 * change note's nonce is not knowable before the payment is made — that is
 * `V-47` — so the notes this walk puts back carry a synthetic one. The only
 * thing `noteToSpend` uses a nonce for is breaking a tie between notes of EQUAL
 * value, and either side of such a tie leaves the pool holding the same values.
 * So a tie broken differently here is a different note chosen and an identical
 * verdict. Stated rather than left to be worried about later.
 *
 * **IT IS NOT A RECONCILIATION AND MUST NEVER BE MISTAKEN FOR ONE.** It reads
 * the pool only. `VaultLedger.balance` is what asks the chain, and an
 * affordability check that skipped it would be answering out of bookkeeping
 * nothing had checked — which is the whole of `C198`.
 */
export const paymentsFit = (
  state: VaultNotes,
  payments: ReadonlyArray<{ token: Hex; amount: bigint }>,
): void => {
  let notes = state.notes;
  payments.forEach((p, i) => {
    let chosen: Note;
    try {
      chosen = noteToSpend(notes, p.token, p.amount);
    } catch (cause) {
      throw new Error(
        `payment ${i + 1} of ${payments.length} cannot be made out of this vault: `
        + `${(cause as Error).message}`);
    }
    const rest = notes.filter((n) => n.nonce !== chosen.nonce);
    const kept = chosen.value - p.amount;
    notes = kept === 0n
      ? rest
      /*
       * `sim:` rather than a plausible 64 hex characters, deliberately. A
       * synthetic nonce that LOOKS like a real one is a value somebody
       * eventually writes to a pool; one that cannot be mistaken for a nonce is
       * refused by everything downstream the moment it escapes this function.
       */
      : [...rest, { nonce: `sim:${i}` as Hex, token: chosen.token, value: kept, index: 0n }];
  });
};

/** The pool after a deposit. */
export const afterDeposit = (state: VaultNotes, note: Note): VaultNotes => {
  if (state.notes.some((n) => n.nonce === note.nonce)) {
    throw new Error(`this vault already holds a note ${note.nonce}`);
  }
  if (note.value <= 0n) throw new Error('a note of nothing is not a deposit');
  return { ...state, notes: [...state.notes, note] };
};

/** What the vault holds of one token. Public knowledge to its owner only. */
export const balanceOf = (state: VaultNotes, token: Hex): bigint =>
  state.notes.filter((n) => n.token === token).reduce((n, x) => n + x.value, 0n);

/**
 * The witnesses the generated vault contract calls, over this state.
 *
 * ONE, since S6a. Written here rather than at each call site so there is one
 * place coin selection lives — two implementations of which note to spend is
 * how two operators half-succeed at the same payment (B3).
 */
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
export const witnessesWithoutAPool = () => ({
  noteToSpend: (_ctx: unknown, _token: Uint8Array, amount: bigint): never => {
    throw new Error(
      `this vault was asked which note to spend for ${amount} on a call that has no note pool. `
      + 'The unshielded circuits move a LEDGER BALANCE and read no witness, so either the '
      + 'contract has changed or this call was routed to the wrong circuit. Nothing is '
      + 'substituted: a note handed over here would be one this path never established the '
      + 'vault holds.');
  },
});

export const witnessesOver = (get: () => VaultNotes, pending: { spending?: Hex }) => ({
  noteToSpend: (ctx: unknown, token: Uint8Array, amount: bigint) => {
    const note = noteToSpend(get().notes, toHex(token), amount);
    /*
     * **THE ONE PLACE AN UNREAD INDEX IS REFUSED, AND IT IS REFUSED RATHER
     * THAN SUBSTITUTED FOR.** `S6f`, and see `Note.index`.
     *
     * The chain assigns `mt_index` when the transaction is included, and
     * nothing in this repository reads it back — so a note recorded by a
     * deposit or a payout carries `undefined` until somebody does. Handing the
     * contract a zero, or the previous note's index, builds a transaction whose
     * Zswap input carries a merkle path for a different leaf; the chain refuses
     * it, and the refusal names nothing a person can act on.
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
        + 'the chain\x27s commitment tree has never been read. It cannot be spent until it is: '
        + 'the transaction would carry a merkle path for a different leaf and the chain would '
        + 'refuse it. The note is safe — an index is not part of a commitment — and reading it '
        + 'costs a rescan of the vault\x27s Zswap state. NOTHING HERE MAY SUBSTITUTE A NUMBER.');
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
});
