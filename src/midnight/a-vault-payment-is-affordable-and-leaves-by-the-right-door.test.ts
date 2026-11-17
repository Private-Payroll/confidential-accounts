/*
 * What a vault payment needs to be affordable, and which door it leaves by: the private pool,
 * the public treasury, and the attempt journalled before the call.
 */
import { describe, it, expect } from 'vitest';
import { VaultChainUnreadable, VaultPoolDisagreesWithChain, VaultCannotAfford } from './vault-ledger.js';
import { toHex } from '../core/crypto.js';
import { unshieldedPayeeFor } from '../testing/payees.js';
import { BY, EVENTS, GBP, harness, itemAt, NIGHT, PAYEE, payment, PUBLIC_PAYEE, SECRET, SEEDED_TX, VAULT } from './a-vault-ledger-on-a-fake-chain.test-support.js';
import { NETWORK } from 'midnight-identity/network';

/**
 * **A RUN RECONCILES THE POOL BEFORE IT STARTS, AND EITHER REFUSAL IS
 * *CANNOT AFFORD*.**
 *
 * A caller must not be able to read *"we could not check"* and decide it is
 * safe to start paying people.
 */
describe('an affordability check refuses on EITHER refusal', () => {
  /*
   * Every payee here is SHIELDED, which is what makes these the pool's
   * question. `affordable` is split by the payee's own kind, so a run of
   * public payees goes to the chain's balance instead and never touches the
   * pool — that half is its own describe below.
   */
  const run = (...amounts: bigint[]) =>
    amounts.map(amount => ({ payee: PAYEE, token: GBP as never, amount }));

  it('passes a run the reconciled pool can pay, one payment at a time', async () => {
    const { ledger } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    await expect(ledger.affordable(VAULT, run(250n, 250n, 400n))).resolves.toBeUndefined();
  });

  it('CANNOT AFFORD when the chain could not be read — not "probably fine"', async () => {
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }], chain: 'unreadable',
    });
    const failed = await ledger.affordable(VAULT, run(10n)).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect((failed as VaultCannotAfford).why).toBe('chain-unreadable');
    /* The refusal is kept, so an operator can tell the two apart afterwards. */
    expect((failed as VaultCannotAfford).cause).toBeInstanceOf(VaultChainUnreadable);
    /* And the sum it would have had appears nowhere. */
    expect(failed?.message).not.toContain('1000');
  });

  it('CANNOT AFFORD a run whose note records no creating transaction, which the payment would refuse', async () => {
    /*
     * The same note, the same reconciled pool, and the same payment that
     * `payout` refuses before a fee (see "REFUSES before a fee a note that does
     * not record which transaction created it"). The check before a proposal is
     * raised must say the same, or the proposal is approved and paid for first.
     */
    const { ledger } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }], noCreatingTransaction: true });
    const failed = await ledger.affordable(VAULT, run(250n)).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect((failed as VaultCannotAfford).why).toBe('notes-do-not-cover');
    expect(failed?.message).toMatch(/does not record which transaction created it/);
    await expect(ledger.payout(VAULT, payment(250n), BY, EVENTS, SECRET)).rejects.toThrow(/does not record which transaction created it/);
  });

  it('AFFORDS AND PAYS a run out of a larger recorded note when the smallest covering note records no transaction, and leaves that note in the pool', async () => {
    /*
     * The pool: 150 that records no creating transaction,
     * beside 5,000 that does, paying 100. The check before a proposal must not
     * answer "the vault no longer holds the money" and the payment must not
     * refuse, because the vault can pay out of the 5,000.
     */
    const { ledger, spentCoins, eventReads, saves, journalled, current } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 150n }, { nonce: '02'.repeat(32), value: 5_000n }],
    });
    const { createdIn: _never, ...unrecorded } = current().notes[0]!;
    current().notes[0] = unrecorded;
    await expect(
      ledger.affordable(VAULT, run(100n)),
      'RED WHEN: the affordability walk refuses a vault that can pay, because it chose a note the payment cannot spend',
    ).resolves.toBeUndefined();
    await ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET);
    expect(spentCoins.map((c) => c.value), 'RED WHEN: the payment spends a different note from the one the walk chose').toEqual([5_000n]);
    expect(eventReads, 'the index is read from the transaction the spent note records').toEqual([{ hash: SEEDED_TX }]);
    expect(journalled.map((j) => j.spent.value), 'the attempt journalled is the note actually spent').toEqual([5_000n]);
    const after = saves[saves.length - 1]!.notes;
    expect(
      after.find((n) => n.nonce === '01'.repeat(32)),
      'RED WHEN: the note the payment passed over leaves the pool, which is money on chain nobody can name again',
    ).toEqual({ nonce: '01'.repeat(32), token: GBP, value: 150n });
    expect(after.map((n) => n.value).sort((a, b) => Number(a - b))).toEqual([150n, 4_900n]);
    /* And a payment only the unrecorded note could make is refused before anything is called, naming it. */
    const again = harness({ notes: [{ nonce: '01'.repeat(32), value: 150n }], noCreatingTransaction: true });
    await expect(again.ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET)).rejects.toThrow(/one more note would: 0101.*\(150\)/);
    expect(again.calls).toEqual([]);
  });

  it('CANNOT AFFORD when the pool and the chain disagree', async () => {
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 600n }, { nonce: '02'.repeat(32), value: 400n }],
      chain: [{ nonce: '01'.repeat(32), value: 600n }],
    });
    const failed = await ledger.affordable(VAULT, run(10n)).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect((failed as VaultCannotAfford).why).toBe('pool-disagrees');
    expect((failed as VaultCannotAfford).cause).toBeInstanceOf(VaultPoolDisagreesWithChain);
  });

  it('CANNOT AFFORD when the notes do not cover it, even though the SUM does', async () => {
    /*
     * The question a balance answers wrongly. Three notes of 40 reconcile
     * perfectly and cannot pay 100, because one payment draws on two notes at
     * most and does not merge - so a check built on the balance alone passes a
     * run that stops on its first payee.
     */
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 40n }, { nonce: '02'.repeat(32), value: 40n }, { nonce: '03'.repeat(32), value: 40n }],
    });
    const failed = await ledger.affordable(VAULT, run(100n)).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect((failed as VaultCannotAfford).why).toBe('notes-do-not-cover');
    expect(failed?.message).toMatch(/payment 1 of 1/);
  });

  it('says WHERE a run would stop, because stopping mid-run is the failure', async () => {
    const { ledger } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    const failed = await ledger.affordable(VAULT, run(400n, 400n, 400n))
      .then(() => null, (e: Error) => e);
    expect(failed?.message).toMatch(/payment 3 of 3/);
    expect(failed?.message).toMatch(/pays until it stops/);
  });

  it('reconciles BEFORE it asks whether the notes cover it', async () => {
    /*
     * The order matters and is not cosmetic. A pool that disagrees with the
     * chain can easily "cover" a run out of notes the chain will refuse, and
     * answering `notes-do-not-cover` — or worse, answering yes — for a pool
     * nothing had checked is the defect this order prevents.
     */
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }, { nonce: '02'.repeat(32), value: 5n }],
      chain: [{ nonce: '01'.repeat(32), value: 1_000n }],
    });
    const failed = await ledger.affordable(VAULT, run(999_999n)).then(() => null, (e: Error) => e);
    expect((failed as VaultCannotAfford).why).toBe('pool-disagrees');
  });
});

/* ------------------------------------------------------------------------
 * PUBLIC MONEY, THROUGH THE CLIENT.
 * ------------------------------------------------------------------------ */

/**
 * **A VAULT HOLDING ONLY PUBLIC MONEY NEEDS NO POOL, AND THAT IS TESTED BY
 * TAKING THE POOL AWAY.**
 *
 * `SealedNotePool.load` correctly refuses when no record exists and
 * `VaultLedger.deposit` loads before it calls. That is right for shielded money
 * and it must not gate public money, or a vault that needs no pool could not be
 * funded without one.
 *
 * **So every test in this describe runs against a `NotePool` whose `load`,
 * `save` and `create` all THROW BY NAME.** A branch that merely skipped the
 * pool would pass a test that supplied a working one; nothing but an
 * unreachable pool distinguishes *"unnecessary"* from *"tolerated"*.
 */
describe('public money needs no pool', () => {
  const publicMoney = { token: NIGHT, amount: 500n };

  it('FUNDS A VAULT WHOSE NOTE POOL CANNOT BE REACHED AT ALL', async () => {
    const { ledger, calls, saves, creates } = harness({ poolThrows: true });

    const tx = await ledger.depositUnshielded(VAULT, publicMoney, BY);

    expect(tx.ref).toBe('tx_dep_public');
    /* The colour and the amount, and nothing else — the circuit takes two. */
    const call = calls.find(c => c.circuit === 'depositUnshielded')!;
    expect(call.args).toHaveLength(2);
    expect(toHex(call.args[0] as Uint8Array)).toBe(NIGHT);
    expect(call.args[1]).toBe(500n);
    /* And nothing local moved, because there is nothing local to move. */
    expect(saves).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });

  it('PAYS A PUBLIC PAYEE WITH THE POOL STILL UNREACHABLE', async () => {
    const { ledger, calls, saves } = harness({ poolThrows: true });

    const paid = await ledger.payout(
      VAULT, { ...payment(250n), payee: PUBLIC_PAYEE, token: NIGHT }, BY);

    expect(paid.kind).toBe('unshielded');
    expect(paid.ref).toBe('tx_pay_public');
    expect(calls.map(c => c.circuit)).toEqual(['payoutUnshielded']);
    expect(saves).toHaveLength(0);
  });

  it('refuses a deposit of nothing, which would jam the vault\'s retirement for free', async () => {
    const { ledger, calls } = harness({ poolThrows: true });
    await expect(ledger.depositUnshielded(VAULT, { token: NIGHT, amount: 0n }, BY))
      .rejects.toThrow(/deposit of nothing/i);
    /* Before a fee, before a proof, and before the contract's own assert. */
    expect(calls).toHaveLength(0);
  });

  it('still loads the pool for a SHIELDED deposit, as it always has', async () => {
    const { ledger } = harness({ poolThrows: true });
    await expect(ledger.deposit(VAULT, { token: GBP, value: 5n }, BY))
      .rejects.toThrow(/note pool was LOADED/);
  });
});

/**
 * **AT THE CLIENT: THE PAYEE CHOOSES THE CIRCUIT, AND NOTHING ELSE CAN.**
 *
 * `PAYEE` and `PUBLIC_PAYEE` are built from the SAME 32 bytes. So every
 * assertion here is about the KIND and never about the values — if the dispatch
 * read the wrong field, the recipient bytes would still be right and the
 * failure would be invisible at this layer.
 *
 * What this layer can prove that the contract tests cannot: which CIRCUIT was
 * called, and whether an encryption mapping travelled with it.
 */
describe('which door a payment leaves by', () => {
  it('a SHIELDED payee goes through `payout`, with the encryption mapping', async () => {
    const { ledger, calls, scopes } = harness();
    const paid = await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);

    expect(paid.kind).toBe('shielded');
    expect(calls.map(c => c.circuit)).toEqual(['payout']);
    expect([...itemAt(scopes, 0).mappings.entries()]).toHaveLength(1);
  });

  it('an UNSHIELDED payee goes through `payoutUnshielded`, with NO mapping', async () => {
    const { ledger, calls, scopes } = harness({ poolThrows: true });
    const paid = await ledger.payout(
      VAULT, { ...payment(200n), payee: PUBLIC_PAYEE, token: NIGHT }, BY, EVENTS, SECRET);

    expect(paid.kind).toBe('unshielded');
    expect(calls.map(c => c.circuit)).toEqual(['payoutUnshielded']);
    /*
     * **AND THE ABSENCE IS THE POINT, NOT AN OMISSION.** the private path's obligation —
     * the payer must carry the payee's encryption key so their wallet can find
     * the coin — has no counterpart for a public UTXO: the payee's wallet finds
     * it by looking. A mapping here would be a key nobody reads, attached to a
     * payment that is already visible.
     */
    expect([...itemAt(scopes, 0).mappings.entries()]).toHaveLength(0);
    expect(itemAt(scopes, 0).scopeName).toBe('vault:payoutUnshielded');
  });

  it('hands the public circuit the payee\'s USER ADDRESS, in the recipient position', async () => {
    const { ledger, calls } = harness({ poolThrows: true });
    await ledger.payout(VAULT, { ...payment(200n), payee: PUBLIC_PAYEE, token: NIGHT }, BY);

    const call = calls.find(c => c.circuit === 'payoutUnshielded')!;
    /* RED WHEN the public payment hands its circuit any argument beyond the five. */
    expect(call.args).toHaveLength(5);
    /* 1 is the recipient. See the argument list beside the fake's payout. */
    /* RED WHEN the user address leaves the recipient position of the public circuit's five. */
    expect(toHex(call.args[1] as Uint8Array)).toBe(PUBLIC_PAYEE.userAddress);
  });

  it('REFUSES A PUBLIC PAYEE ON ANOTHER NETWORK, which nothing downstream would', async () => {
    const { ledger, calls } = harness({ poolThrows: true });
    const elsewhere = unshieldedPayeeFor(new Uint8Array(32).fill(0x44), NETWORK);
    await expect(ledger.payout(VAULT, { ...payment(200n), payee: elsewhere }, BY))
      .rejects.toThrow(/user address would be accepted either way/);
    expect(calls).toHaveLength(0);
  });
});

/**
 * **WHAT `balance` MEANS FOR PUBLIC MONEY, AND WHY IT IS A DIFFERENT
 * FUNCTION.**
 *
 * `balance` reconciles a local record against the chain and has THREE outcomes.
 * `unshieldedBalance` has no local record to reconcile — the ledger's figure is
 * the only record there has ever been — so it has TWO. Conflating them is how
 * *"could not read"* becomes *"there is none"*, and a vault's whole float reads
 * as zero.
 *
 * **THE CIRCUIT'S EMPTY-MAP BALANCE DOES NOT REACH THIS FUNCTION.** The empty-map hole is in `CallContext.balance`, which is what
 * the CIRCUIT's `unshieldedBalanceGte` reads. This asks the indexer through the
 * provider bundle, which these tests supply. So the answers below are a real
 * read of a controlled chain, not a circuit's question asked of an empty map.
 */
describe('the public balance is the chain\'s number, or no number', () => {
  it('returns what the chain published for that colour', async () => {
    const { ledger } = harness({ publicBalances: [[NIGHT, 4_200n], [GBP, 7n]] });
    expect(await ledger.unshieldedBalance(VAULT, NIGHT)).toBe(4_200n);
  });

  it('ZERO for a colour the chain answered about and did not list', async () => {
    /*
     * A true statement about the vault, and the ONE place a zero is correct
     * here: the indexer published what this contract holds and this colour is
     * not among it.
     */
    const { ledger } = harness({ publicBalances: [[GBP, 7n]] });
    expect(await ledger.unshieldedBalance(VAULT, NIGHT)).toBe(0n);
  });

  it('does NOT read a balance the pool would have to be loaded for', async () => {
    const { ledger } = harness({ poolThrows: true, publicBalances: [[NIGHT, 9n]] });
    expect(await ledger.unshieldedBalance(VAULT, NIGHT)).toBe(9n);
  });

  /*
   * THE FOUR WAYS IT MUST REFUSE RATHER THAN ANSWER ZERO. "we
   * could not check" and "the chain says none" are different answers with
   * opposite consequences, and only one of them is a reason to stop.
   */
  it.each([
    ['the indexer has no state for this address', 'unreadable' as const],
    ['the read itself failed', 'read-throws' as const],
    ['a state that carries no balance', 'no-balance' as const],
    ['a balance of a shape this client cannot read', 'not-a-map' as const],
    ['a provider that cannot answer at all', 'no-provider' as const],
    ['an entry that is not a public token and an amount', 'bad-row' as const],
  ])('REFUSES rather than answering zero: %s', async (_why, publicBalances) => {
    const { ledger } = harness({ publicBalances });
    await expect(ledger.unshieldedBalance(VAULT, NIGHT))
      .rejects.toThrow(VaultChainUnreadable);
  });

  it('says there is no local number to fall back to, which is the design', async () => {
    const { ledger } = harness({ publicBalances: 'unreadable' });
    const failed = await ledger.unshieldedBalance(VAULT, NIGHT).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultChainUnreadable);
    expect(failed!.message).toMatch(/no local number to fall back to/i);
    /* And the shielded refusal still says the opposite thing, which is also true. */
    const { ledger: l2 } = harness({ chain: 'unreadable' });
    const other = await l2.balance(VAULT, GBP).then(() => null, (e: Error) => e);
    expect(other!.message).toMatch(/the pool alone is our bookkeeping/i);
  });

  it('never names the vault in its words, and carries it as a property', async () => {
    const { ledger } = harness({ publicBalances: 'unreadable' });
    const failed = await ledger.unshieldedBalance(VAULT, NIGHT)
      .then(() => null, (e: VaultChainUnreadable) => e);
    /* An error message is a screen: it never carries the vault's address. */
    expect(failed!.message).not.toContain(VAULT.slice(0, 8));
    expect(failed!.vaultAddress).toBe(VAULT);
  });
});

/**
 * **AFFORDABILITY, SPLIT BY THE PAYEE'S OWN KIND.**
 *
 * A run can hold both kinds side by side, because the kind rides on each
 * payment's leaf rather than on the run. So one question
 * gets the wrong answer twice: the pool knows nothing about NIGHT, and the
 * chain's public balance says nothing about notes.
 *
 * **AND A SUM IS THE RIGHT QUESTION HERE, WHICH IS EXACTLY WHAT IT IS NOT ON
 * THE PRIVATE SIDE.** Notes do not merge, so a pool of two sixties
 * cannot pay a hundred. A public balance is one number the ledger subtracts
 * from, so a total is precisely the question.
 */
describe('an affordability check reads the right treasury', () => {
  const publicRun = (...amounts: bigint[]) =>
    amounts.map(amount => ({ payee: PUBLIC_PAYEE, token: NIGHT, amount }));

  it('passes a public run the chain says the vault can cover, and TOUCHES NO POOL', async () => {
    const { ledger } = harness({ poolThrows: true, publicBalances: [[NIGHT, 1_000n]] });
    await expect(ledger.affordable(VAULT, publicRun(400n, 400n))).resolves.toBeUndefined();
  });

  it('CANNOT AFFORD when the total exceeds what the chain says, not the largest payment', async () => {
    /*
     * Each payment fits on its own; the run does not. On the private side that
     * distinction is `paymentsFit`'s and is about notes not merging. Here it is
     * arithmetic on one number, and the run would pay until it stopped.
     */
    const { ledger } = harness({ poolThrows: true, publicBalances: [[NIGHT, 1_000n]] });
    const failed = await ledger.affordable(VAULT, publicRun(600n, 600n))
      .then(() => null, (e: VaultCannotAfford) => e);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect(failed!.why).toBe('public-balance-short');
    expect(failed!.message).toMatch(/pays 1200 of a public token .* holds 1000/);
  });

  it('CANNOT AFFORD when the public balance could not be read — not "probably fine"', async () => {
    const { ledger } = harness({ poolThrows: true, publicBalances: 'unreadable' });
    const failed = await ledger.affordable(VAULT, publicRun(1n))
      .then(() => null, (e: VaultCannotAfford) => e);
    expect(failed).toBeInstanceOf(VaultCannotAfford);
    expect(failed!.why).toBe('chain-unreadable');
  });

  it('A MIXED RUN ASKS BOTH, and refuses if EITHER half is short', async () => {
    /*
     * The pool holds 1,000 of GBP and the chain says 100 of NIGHT. The private
     * half fits and the public half does not, so the run does not.
     */
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }],
      publicBalances: [[NIGHT, 100n]],
    });
    const failed = await ledger.affordable(VAULT, [
      { payee: PAYEE, token: GBP, amount: 250n },
      { payee: PUBLIC_PAYEE, token: NIGHT, amount: 250n },
    ]).then(() => null, (e: VaultCannotAfford) => e);
    expect(failed!.why).toBe('public-balance-short');
  });

  it('and passes a mixed run both halves cover', async () => {
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }],
      publicBalances: [[NIGHT, 1_000n]],
    });
    await expect(ledger.affordable(VAULT, [
      { payee: PAYEE, token: GBP, amount: 250n },
      { payee: PUBLIC_PAYEE, token: NIGHT, amount: 250n },
    ])).resolves.toBeUndefined();
  });
});

/**
 * **THE AMOUNT IS WRITTEN DOWN BEFORE THE MONEY MOVES.**
 *
 * A payment's change note is on chain as a commitment the moment the call
 * lands, and the pool is written after. The nonce and colour of that note can
 * be derived from the note that was spent; **its value cannot** -- it is the
 * spent value minus an amount that until this record existed lived in one
 * process's memory. A crash between the call and the pool write therefore
 * left money the vault owned and could not name. These pin that the attempt
 * is recorded, that it is recorded BEFORE the call, that it carries what a
 * rebuild needs, and that a ledger with nowhere to record it refuses rather
 * than pays.
 */
describe('a private payment journals its attempt before the call', () => {
  it('records the note it is about to spend and the amount, BEFORE the payout call', async () => {
    const { ledger, journalled, calls, spentCoins } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 60n }, { nonce: '02'.repeat(32), value: 1_000n }],
    });
    await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);

    expect(journalled).toHaveLength(1);
    expect(
      itemAt(journalled, 0).callsMadeSoFar,
      'RED WHEN: the journal write is moved below the call -- an attempt recorded after the money moved is not on disk when the process stops in between, which is the only moment this record exists for',
    ).toBe(0);
    expect(calls.map((c) => c.circuit)).toEqual(['payout']);

    /* What a rebuild needs to name the change note without inverting anything. */
    expect(itemAt(journalled, 0).spent).toEqual({ nonce: '02'.repeat(32), token: GBP, value: 1_000n });
    expect(itemAt(journalled, 0).amount).toBe(200n);
    expect(
      itemAt(journalled, 0).spent.nonce,
      'RED WHEN: the note journalled is not the note the contract then spent, so the change note the rebuild derives belongs to no payment',
    ).toBe(toHex(spentCoins[0].nonce));
  });

  it('REFUSES a private payment by name when the ledger has nowhere to write the attempt, and calls nothing', async () => {
    const { ledger, calls, saves } = harness({ journal: 'none' });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET))
      .rejects.toThrow(/nowhere to write it/);
    expect(calls, 'RED WHEN: a payment proceeds unjournalled, which reopens the window silently').toEqual([]);
    expect(saves).toHaveLength(0);
  });

  it('a journal that cannot be written STOPS the payment with nothing spent', async () => {
    const { ledger, calls, saves } = harness({ journal: 'refuses' });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET))
      .rejects.toThrow(/journal cannot be written/);
    expect(calls, 'RED WHEN: the journal refusal arrives after the call, which moves the loss rather than removing it').toEqual([]);
    expect(saves).toHaveLength(0);
  });

  it('a PUBLIC payment writes no journal line: it spends no note and keeps no change', async () => {
    const { ledger, journalled, calls } = harness({ poolThrows: true });
    await ledger.payout(VAULT, { ...payment(200n), payee: PUBLIC_PAYEE, token: NIGHT }, BY);
    expect(calls.map((c) => c.circuit)).toEqual(['payoutUnshielded']);
    expect(journalled, 'RED WHEN: a public payment is journalled -- it spends no note, so the line would name money that does not exist').toHaveLength(0);
  });

  it('one line per payment, each naming the note THAT payment spent', async () => {
    const { ledger, journalled, spentCoins } = harness();
    await ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET);
    await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);
    expect(journalled).toHaveLength(2);
    expect(journalled.map((j) => j.spent.nonce)).toEqual(spentCoins.map((c: any) => toHex(c.nonce)));
    expect(journalled.map((j) => j.amount)).toEqual([100n, 200n]);
    /* The second spends the first's change, so its journalled value is what was kept. */
    expect(itemAt(journalled, 1).spent.value).toBe(900n);
  });
});

