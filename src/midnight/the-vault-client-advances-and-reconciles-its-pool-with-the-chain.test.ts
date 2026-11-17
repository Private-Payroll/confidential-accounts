/**
 * The vault client, against a chain whose answers we control.
 *
 * What only this layer can get wrong: advancing the pool on a call that did not
 * happen, advancing it by the wrong note, or holding a copy of it taken before
 * the call. Each of those is a vault whose money stops moving, and none of them
 * is visible in the contract tests.
 */
import { describe, it, expect } from 'vitest';
import { VaultChainUnreadable, VaultPoolDisagreesWithChain, VaultAlreadyHoldsNotes } from './vault-ledger.js';
import { readFileSync } from 'node:fs';
import { balanceOf } from './vault-notes.js';
import { toHex } from '../core/crypto.js';
import { payeeFor } from '../testing/payees.js';
import { NoteIndexUnreadable, indexForSpend } from './note-index.js';
import { BY, DEP_ID, DEP_TX, EVENTS, eventsInUse, GBP, harness, itemAt, NIGHT, PAYEE, payHash, payId, payment, PUBLIC_PAYEE, SECRET, SEEDED_TX, seededIndex, useEvents, VAULT } from './a-vault-ledger-on-a-fake-chain.test-support.js';
import { NETWORK } from 'midnight-identity/network';

describe('the vault client', () => {
  it('hands the deposit circuit the COIN AND NOTHING ELSE, and adds the note once it lands', async () => {
    /*
     * The circuit takes no blinding. A client that passed one would be caught by
     * the arity guard rather than here — this pins that it does not, because an
     * argument that could carry a value nobody can reproduce is a note this
     * company could never open.
     */
    const { ledger, calls, current } = harness({ notes: [] });
    await ledger.deposit(VAULT, { token: GBP, value: 500n }, BY);

    expect(itemAt(calls, 0).circuit).toBe('deposit');
    expect(itemAt(calls, 0).args).toHaveLength(1);
    expect(balanceOf(current(), GBP)).toBe(500n);
    /* Where its index is to be read from, off the finalised result, and no index. */
    expect(itemAt(current().notes, 0).createdIn).toBe(DEP_TX);
    expect(current().notes[0]).not.toHaveProperty('index');
  });

  /* ------------------------------------------------------------------ *
   * A DEPOSIT RECORDS THE TRANSACTION THAT CREATED ITS NOTE, IN THE SAME
   * ACTION - because a note that records none is money the vault owns and
   * cannot spend, and the repair was a second command somebody had to remember.
   * ------------------------------------------------------------------ */

  it('records the creating transaction off the call, and does not ask the chain when it does not have to', async () => {
    const { ledger, current, eventReads, saves } = harness({ notes: [] });
    const out = await ledger.deposit(
      VAULT, { token: GBP, value: 500n }, BY, eventsInUse);

    /* RED WHEN the ordinary path stops recording the transaction the call reported. */
    expect(out.recordedFrom).toBe('the call');
    expect(out.createdIn).toBe(DEP_TX);
    expect(itemAt(current().notes, 0).createdIn).toBe(DEP_TX);
    /* RED WHEN a deposit reads the chain it did not need to read, which is a network call per deposit. */
    expect(eventReads).toEqual([]);
    /* RED WHEN the note is written by more than one save, which would be a fourth writer of this pool. */
    expect(saves).toHaveLength(1);
  });

  it('READS IT FROM THE CHAIN when the call reports only the identifier, still in ONE write', async () => {
    const { ledger, current, eventReads, saves } = harness({ notes: [], depositResult: 'no-hash' });
    const out = await ledger.deposit(
      VAULT, { token: GBP, value: 500n }, BY, eventsInUse);

    /*
     * RED WHEN a result carrying no hash strands the note. This is the branch
     * that would otherwise write a note with no creating transaction and say
     * nothing.
     */
    expect(out.recordedFrom).toBe('the chain');
    expect(out.createdIn).toBe(DEP_TX);
    expect(itemAt(current().notes, 0).createdIn).toBe(DEP_TX);
    /* RED WHEN the chain is asked by a name it was never given: the pool holds the hash, the call reported the identifier. */
    expect(eventReads).toEqual([{ identifier: DEP_ID }]);
    /* RED WHEN the repair becomes a second write, which is what makes it a fourth writer of an unlocked pool. */
    expect(saves).toHaveLength(1);
  });

  it('STILL WRITES THE NOTE when nothing can be recorded, and SAYS the note is stranded', async () => {
    const { ledger, current, saves } = harness({ notes: [], depositResult: 'no-hash' });
    /* No events source at all: the money has landed and there is nothing to read the hash from. */
    const out = await ledger.deposit(VAULT, { token: GBP, value: 500n }, BY);

    /*
     * RED WHEN the deposit throws here. The transaction has settled: throwing
     * loses the note from the pool entirely, and a vault holding money it has
     * no record of needs its whole history replayed, which is strictly worse
     * than a note that records no transaction.
     */
    expect(out.recordedFrom).toBe('nowhere');
    expect(saves).toHaveLength(1);
    expect(itemAt(current().notes, 0).value).toBe(500n);
    /* RED WHEN a note is written with no creating transaction and nothing says so. */
    expect(out.stranded).toContain('no source of the chain');
    expect(current().notes[0]).not.toHaveProperty('createdIn');
  });

  it('says WHY when the chain refuses the question, rather than only that it failed', async () => {
    const { ledger, current, saves } = harness({
      notes: [], depositResult: 'no-hash', events: 'unreadable' });
    const out = await ledger.deposit(
      VAULT, { token: GBP, value: 500n }, BY, eventsInUse);

    /* RED WHEN a chain read that throws takes the deposit down with it. */
    expect(out.recordedFrom).toBe('nowhere');
    expect(saves).toHaveLength(1);
    /* RED WHEN the reason is swallowed, leaving somebody to guess which of the three failures it was. */
    expect(out.stranded).toContain('the indexer is not answering');
    expect(current().notes[0]).not.toHaveProperty('createdIn');
  });

  it('WILL NOT TAKE A 32-BYTE VALUE AS THE 33-BYTE NAME, and asks the chain nothing', async () => {
    const { ledger, eventReads } = harness({
      notes: [], depositResult: 'hash-shaped-identifier' });
    const out = await ledger.deposit(
      VAULT, { token: GBP, value: 500n }, BY, eventsInUse);

    /*
     * RED WHEN the length check on the identifier widens. The two names are 32
     * and 33 bytes and the chain is asked by one or the other; a hash handed
     * over as an identifier is a question about a transaction nothing is filed
     * under, and the answer to it would be recorded against this note.
     */
    expect(out.recordedFrom).toBe('nowhere');
    expect(out.stranded).toContain('neither a transaction hash nor an identifier');
    /* RED WHEN the chain is asked anyway, with a name it cannot use. */
    expect(eventReads).toEqual([]);
  });

  it('WILL NOT RECORD A TRANSACTION THAT DID NOT CREATE THIS NOTE, even though one answered', async () => {
    const { ledger, current, saves } = harness({
      notes: [], depositResult: 'no-hash', chainDoesNotFileTheNote: true });
    const out = await ledger.deposit(
      VAULT, { token: GBP, value: 500n }, BY, eventsInUse);

    /*
     * RED WHEN the hash is taken off the first event the chain returns. A hash
     * nothing established created this note reads as a HEALTHY note everywhere
     * afterwards - in the pool, on the screen, and in the check a payment makes
     * before it proposes - and is refused only at the spend, after a proposal
     * and its approvals have been proved and paid for.
     */
    expect(out.recordedFrom).toBe('nowhere');
    expect(out.createdIn).toBeUndefined();
    expect(current().notes[0]).not.toHaveProperty('createdIn');
    /* RED WHEN the reason stops saying it was the chain's answer that did not match. */
    expect(out.stranded).toMatch(/did not create this note|not for a contract|different contract/);
    /* RED WHEN the note is lost because the check threw instead of answering. */
    expect(saves).toHaveLength(1);
    expect(itemAt(current().notes, 0).value).toBe(500n);
  });

  /**
   * **WHETHER READING AGAIN COULD ANSWER IS PART OF WHAT A STRANDED NOTE
   * REPORTS**, because it is the whole of what the person holding it does next.
   *
   * An indexer a moment behind a node answers in a minute and the note is
   * repaired by asking again. An indexer this client can no longer ask never
   * answers, and somebody told to ask again asks again for ever.
   */
  it('SAYS A SLOW INDEXER IS RETRYABLE, and does not call it final', async () => {
    const { ledger, current, saves } = harness({
      notes: [], depositResult: 'no-hash', events: 'unreadable' });
    const out = await ledger.deposit(
      VAULT, { token: GBP, value: 500n }, BY, eventsInUse);

    /*
     * RED WHEN a read that could succeed in a minute is reported as the chain's
     * final word. Telling somebody to stop waiting for an answer that would
     * have come is the worse of the two mistakes: a note whose place is never
     * read is money nobody reaches.
     */
    expect(out.recordedFrom).toBe('nowhere');
    expect(out.permanent).toBeUndefined();
    expect(out.stranded).toContain('the chain could not say which transaction this was');
    expect(saves).toHaveLength(1);
    expect(current().notes[0]).not.toHaveProperty('createdIn');
  });

  it('AND A REFUSAL IS NOT FINAL: only a question the indexer will not take is', async () => {
    /*
     * **THE ASYMMETRY, DRIVEN ON BOTH SIDES.** Every refusal but one names
     * reading again as what resolves it, so only the one that does not may be
     * reported as final. This is the pair that keeps the classification from
     * quietly widening back.
     */
    const refused = harness({ notes: [], depositResult: 'no-hash', chainDoesNotFileTheNote: true });
    const a = await refused.ledger.deposit(
      VAULT, { token: GBP, value: 500n }, BY, eventsInUse);
    /* RED WHEN a refusal the chain can answer differently tomorrow is called
     * final. Its own sentence tells the reader to read again. */
    expect(a.recordedFrom).toBe('nowhere');
    expect(a.permanent).toBeUndefined();

    const unaskable = harness({ notes: [], depositResult: 'no-hash', events: 'unaskable' });
    const b = await unaskable.ledger.deposit(
      VAULT, { token: GBP, value: 500n }, BY, eventsInUse);
    /* RED WHEN the one error that IS final stops being reported as final,
     * which leaves somebody reading again for ever. */
    expect(b.permanent).toBe(true);
  });

  it('SAYS A QUESTION THE INDEXER WILL NOT TAKE IS FINAL, and does not say try again', async () => {
    const { ledger, current, saves } = harness({
      notes: [], depositResult: 'no-hash', events: 'unaskable' });
    const out = await ledger.deposit(
      VAULT, { token: GBP, value: 500n }, BY, eventsInUse);

    /*
     * RED WHEN the two are not told apart. Identical results would print the
     * identical frame, whose word is YET.
     */
    expect(out.recordedFrom).toBe('nowhere');
    expect(out.permanent).toBe(true);
    /* RED WHEN the refusal's own words are wrapped in the sentence for a read
     * that merely failed, which says the chain could not say - it said. */
    expect(out.stranded).toBe('the indexer will not take this question');
    /* RED WHEN a final answer loses the note, which is what throwing here does. */
    expect(saves).toHaveLength(1);
    expect(itemAt(current().notes, 0).value).toBe(500n);
    expect(current().notes[0]).not.toHaveProperty('createdIn');
  });

  it('WILL NOT RECORD A HASH THE CHAIN DID NOT NAME, even when the events are this note\x27s', async () => {
    const { ledger, current, saves } = harness({
      notes: [], depositResult: 'no-hash', events: 'no-hash-named' });
    const out = await ledger.deposit(
      VAULT, { token: GBP, value: 500n }, BY, eventsInUse);

    /*
     * **THE ONE VALUE ON THIS PATH THAT NOTHING CHECKED.** Every event agrees
     * with every other, the commitment matches and the output is this vault's -
     * so every question the client asked was answered yes, and the value
     * written into the pool as the note's creating transaction was `0x`.
     *
     * RED WHEN a value that is not a transaction hash is recorded. A note
     * carrying one reads as HEALTHY in the pool, on the screen and in the
     * check a payment makes before it proposes, and is refused only at the
     * spend - after a proposal and its approvals have been proved and paid for.
     */
    expect(out.recordedFrom).toBe('nowhere');
    expect(out.createdIn).toBeUndefined();
    expect(current().notes[0]).not.toHaveProperty('createdIn');
    expect(out.stranded).toMatch(/without naming its hash|sixty-four hex characters/);
    /*
     * **AND IT IS NOT FINAL.** An event whose transaction hash is not a hash
     * is an indexer that has not caught up with the node, and the refusal's own
     * sentence says to read again once the transaction shows on it.
     *
     * RED WHEN it is reported as the chain's last word - which puts "reading
     * again will not answer" above a reason that says to read again, and stops
     * the one act that repairs the note.
     */
    expect(out.permanent).toBeUndefined();
    /* RED WHEN the note is lost because the refusal threw instead of answering. */
    expect(saves).toHaveLength(1);
    expect(itemAt(current().notes, 0).value).toBe(500n);
  });

  it('says so when the call names the transaction NEITHER way', async () => {
    const { ledger, current } = harness({ notes: [], depositResult: 'nothing-to-go-on' });
    const out = await ledger.deposit(
      VAULT, { token: GBP, value: 500n }, BY, eventsInUse);

    /* RED WHEN a result with no name at all is reported as some other failure. */
    expect(out.recordedFrom).toBe('nowhere');
    expect(out.stranded).toContain('neither a transaction hash nor an identifier');
    expect(current().notes[0]).not.toHaveProperty('createdIn');
  });

  it('REFUSES TO READ A VAULT OF ANOTHER BUILD\x27S SHAPE, before a field is read off it', async () => {
    /*
     * RED WHEN this read is left outside the shape gate. It is not on the
     * payment path: it is what answers `balance` and `affordable`, which is
     * what decides whether a run is raised. A field is addressed by position,
     * so on a vault of another shape the answer about notes comes out of
     * whichever field is in that slot - silently, where the two are stored the
     * same way.
     */
    const { ledger } = harness({ ledgerSlots: ['cell', 'map', 'map', 'cell'] });
    const failed = await ledger.balance(VAULT, GBP).then(() => null, (e: Error) => e);
    expect(failed?.name).toBe('VaultLedgerShapeMismatch');
    expect(failed?.message).toMatch(/holds 4 ledger fields/);
  });

  it('AND A STRANDED NOTE IS EXACTLY THE ONE A PAYMENT REFUSES, which is why it is worth saying', async () => {
    const { ledger, current } = harness({ notes: [], depositResult: 'no-hash' });
    await ledger.deposit(VAULT, { token: GBP, value: 500n }, BY);

    /*
     * RED WHEN a note with no recorded transaction becomes spendable, or stops
     * being refused by name. The claim "this note cannot be paid out" is
     * measured here against the product's own refusal rather than asserted in
     * a comment.
     */
    const stranded = itemAt(current().notes, 0);
    await expect(indexForSpend(VAULT as `${string}`, stranded, eventsInUse)).rejects
      .toThrow(/does not record which transaction created it/);
  });

  it('A CHANGE NOTE WHOSE CALL REPORTED NO HASH IS RECORDED FROM THE CHAIN BY ITS IDENTIFIER, AND THE NEXT PAYMENT CAN SPEND IT', async () => {
    /*
     * RED WHEN: the change note's transaction is taken from the call's hash alone -
     * the change is then written with no `createdIn`, the answer says nothing, and the
     * next payment that needs it is refused after its proposal has been paid for.
     */
    const { ledger, current, eventReads } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }], payoutResult: 'no-hash' });
    const r = await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);
    if (r.kind !== 'shielded') throw new Error('a shielded payee was paid through another door');
    expect(r.change).toEqual({ createdIn: payHash(1), recordedFrom: 'the chain' });
    expect(eventReads).toContainEqual({ identifier: payId(1) });
    expect(current().notes).toEqual([{ nonce: 'ab'.repeat(32), token: GBP, value: 800n, createdIn: payHash(1) }]);
    /* And the note it recorded is one the next payment can spend: its index is read from that transaction. */
    await expect(ledger.payout(VAULT, payment(700n), BY, EVENTS, SECRET)).resolves.toMatchObject({ kind: 'shielded', spentNote: 'ab'.repeat(32) });
  });

  it('A CHANGE NOTE NOTHING CAN NAME IS STILL KEPT, AND THE PAYMENT SAYS IT CANNOT BE SPENT YET', async () => {
    /* RED WHEN: the payment answers as though its change were spendable, or throws and loses the change from the pool. */
    const { ledger, current } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }], payoutResult: 'nothing-to-go-on' });
    const r = await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);
    if (r.kind !== 'shielded') throw new Error('a shielded payee was paid through another door');
    expect(r.change?.recordedFrom).toBe('nowhere');
    expect(r.change?.stranded).toMatch(/neither a transaction hash nor an identifier/);
    expect(current().notes).toEqual([{ nonce: 'ab'.repeat(32), token: GBP, value: 800n }]);
    await expect(ledger.payout(VAULT, payment(700n), BY, EVENTS, SECRET)).rejects.toThrow(/does not record which transaction created it/);
  });

  it('a payment that spends its note exactly says nothing about a change it did not make', async () => {
    const { ledger } = harness({ notes: [{ nonce: '01'.repeat(32), value: 200n }] });
    const r = await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);
    expect(r).not.toHaveProperty('change');
  });

  it('ADVANCES THE POOL BY THE NOTE THE CONTRACT ACTUALLY TOOK, not the one it assumed', async () => {
    /*
     * The client does not choose the note twice. It reads back which one the
     * witness handed over, because a client that assumed would drift from the
     * chain on the first payment where the assumption was wrong — and then
     * every later payment is refused as "not in this vault's pool".
     */
    const { ledger, current } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }, { nonce: '02'.repeat(32), value: 300n }],
    });
    const r = await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);

    /*
     * **THE KIND IS ESTABLISHED BEFORE THE NOTE IS READ.**
     *
     * `VaultPaid` is a union: an unshielded payment spends no note and reports
     * none. A caller that wants the note has to say which payment it made, and
     * that one line is what stops a pool being advanced by a payment that never
     * touched one.
     */
    if (r.kind !== 'shielded') throw new Error('a shielded payee was paid through another door');
    /* The planner's first note, offered to the witness and reported back as the one it handed over. */
    expect(r.spentNote).toBe('01'.repeat(32));
    expect(balanceOf(current(), GBP)).toBe(1_100n);
    expect(current().notes.some(n => n.value === 800n && n.createdIn === payHash(1) && n.index === undefined))
      .toBe(true);
  });

  /*
   * THE SILENT FAILURE OF A WRONG ENCRYPTION KEY, PINNED AT THE ONLY LAYER THAT CAN SEE IT.
   *
   * The coin ciphertext that makes a payment visible in the payee's own wallet
   * is encrypted to whatever key rides in `additionalCoinEncPublicKeyMappings`.
   * That mapping is a TRANSACTION option, so the contract never sees it, it is
   * not part of what the signers approved, and no assert anywhere can reach it.
   * Hand it the wrong key and the payment settles perfectly into a coin the
   * payee will never be shown.
   *
   * There is no contract test for this and there cannot be. This is it.
   */
  it('ENCRYPTS THE PAYMENT TO THE SAME PAYEE IT PAYS, from one value', async () => {
    const { ledger, calls } = harness();
    await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);

    const call = calls.find(c => c.circuit === 'payout')!;
    /* 1 is the recipient: the coin key, the only half the circuit sees. */
    const recipient = toHex(call.args[1] as Uint8Array);
    /*
     * And the mapping is on the CONTEXT, which is what midnight-js reads. The
     * circuit's own arguments end at the sixth, the further note; a seventh
     * argument would be read as a mapping and `dispatch` refuses it.
     */
    /* RED WHEN the private payment hands its circuit any argument beyond the run, the payee, the token, the amount, the blinding and the further note. */
    expect(call.args).toHaveLength(6);
    /* RED WHEN the client offers the payment a second note: it spends only the note it chose. */
    expect((call.args[5] as Array<{ value: bigint }>).map((n) => n.value)).toEqual([0n]);
    const mappings = [...(call.ctx as any).getAdditionalMappings().entries()];

    /* RED WHEN the coin key leaves the recipient position of the five. */
    expect(recipient).toBe(PAYEE.coinPublicKey);
    expect(mappings).toHaveLength(1);
    expect(mappings[0][0]).toBe(recipient);
    expect(mappings[0][1]).toBe(PAYEE.encryptionPublicKey);

    /*
     * And the reading key is NOT the spending key. If the fixture ever made
     * them equal, everything above would pass while proving nothing.
     */
    expect(PAYEE.encryptionPublicKey).not.toBe(PAYEE.coinPublicKey);
  });

  it('REFUSES A CALL WITH THE WRONG NUMBER OF ARGUMENTS, before anything is built', async () => {
    /*
     * The same guard `ledger.ts` makes — without it an options object becomes an
     * extra argument to a circuit that declares fewer. It reads the VAULT's own compiled ABI, so it moves
     * when the contract does.
     */
    const { ledger, calls } = harness();
    /* RED WHEN the arity guard stops reading the vault's own compiled count before a call is built. */
    await expect((ledger as any).call(VAULT, 'payout', [1, 2, 3]))
      .rejects.toThrow(/circuit "payout" takes 6 argument\(s\), got 3/);
    expect(calls).toHaveLength(0);

    /* RED WHEN an argument beyond the circuit's six is let through. */
    await expect((ledger as any).call(VAULT, 'payout', new Array(7).fill(0)))
      .rejects.toThrow(/takes 6 argument\(s\), got 7/);
  });

  it('REFUSES A PAYEE WHOSE ADDRESS IS FOR ANOTHER NETWORK, which nothing downstream would', async () => {
    /*
     * A coin public key is network-independent bytes. Hand this vault an address
     * built for another chain and the payment settles to a key belonging to
     * somebody on a network this deployment has never heard of — correctly, as
     * far as every layer below can tell.
     */
    const { ledger, calls } = harness();
    const elsewhere = { ...payment(100n), payee: payeeFor(new Uint8Array(32).fill(0x44), NETWORK) };
    await expect(ledger.payout(VAULT, elsewhere, BY, EVENTS, SECRET))
      .rejects.toThrow(`for ${NETWORK} and this vault is on preview`);
    expect(calls).toHaveLength(0);
  });

  it('has nowhere to put a reading key that belongs to somebody else', async () => {
    /*
     * The type-level claim, tested rather than asserted in a comment: a payment
     * carries a payee, not a pair of keys, so there is no field a caller could
     * fill with one person's coin key and another's reading key. Both halves
     * come out of decoding one address, and a different reading key is a
     * DIFFERENT ADDRESS — a different payee, not the same payee misread.
     */
    const other = payeeFor(new Uint8Array(32).fill(0x44).map((b, i) => (i === 31 ? b ^ 1 : b)), 'preview');
    expect(other.bech32).not.toBe(PAYEE.bech32);
    expect(other.encryptionPublicKey).not.toBe(PAYEE.encryptionPublicKey);
    expect(Object.keys(payment(1n))).not.toContain('payslipKey');
    expect(Object.keys(payment(1n))).not.toContain('recipient');
  });

  it('REFUSES BEFORE A FEE when no two notes cover the payment', async () => {
    const { ledger, calls } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 40n }, { nonce: '02'.repeat(32), value: 40n }, { nonce: '03'.repeat(32), value: 40n }],
    });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET))
      .rejects.toThrow(/no 2 notes a payment can spend cover 100/i);
    expect(calls).toEqual([]);
  });

  it('PAYS FROM TWO NOTES WHEN NO ONE NOTE COVERS IT: both indexes read, both journalled, both out of the pool', async () => {
    const { ledger, spentCoins, eventReads, journalled, saves } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 60n }, { nonce: '02'.repeat(32), value: 70n }],
    });
    await ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET);
    /* RED WHEN the further note is not handed to the call, not journalled, or left in the pool the chain has spent it from. */
    expect(spentCoins.map((c) => c.value)).toEqual([70n, 60n]);
    expect(eventReads).toHaveLength(2);
    expect(journalled.map((j) => [j.spent.value, (j.further ?? []).map((f) => f.value)])).toEqual([[70n, [60n]]]);
    expect(saves[saves.length - 1]!.notes.map((n) => n.value)).toEqual([30n]);
  });

  it('DOES NOT TOUCH THE POOL when the call fails', async () => {
    /*
     * A pool advanced for a payment that never landed is a vault that will
     * refuse its own next payment, with the money still there and unreachable
     * until somebody replays it from the chain.
     */
    const { ledger, saves, current } = harness({ throws: 'node said no' });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET)).rejects.toThrow(/node said no/);
    expect(saves).toEqual([]);
    expect(balanceOf(current(), GBP)).toBe(1_000n);
  });

  it('STOPS rather than guessing if the vault paid without asking for a note', async () => {
    /*
     * Impossible against the real contract, which is why it matters: if it
     * happens, this client's model of the vault is wrong in a way that would
     * corrupt the pool on the next call. Advancing by a guess is how a vault
     * quietly loses track of its own money.
     */
    const { ledger, saves } = harness({ asksForANote: false });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET))
      .rejects.toThrow(/paid without asking for a note|rebuild it from the chain/i);
    expect(saves).toEqual([]);
  });

  it('loads the pool fresh on every call, never a copy taken at construction', async () => {
    /*
     * The "can make exactly one payment" defect wearing a closure. It has
     * already appeared once in this repo, in the first vault test helper.
     */
    const { ledger, current } = harness();
    await ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET);
    await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);
    expect(balanceOf(current(), GBP)).toBe(700n);
    expect(current().notes).toHaveLength(1);
  });

  it('never mentions the account: the vault pins it on chain, not this client', async () => {
    const { ledger } = harness();
    expect(ledger.describe()).toMatch(/pinned by the vault on chain/i);
  });
});

/**
 * **A BALANCE NOTHING HAS RECONCILED IS NOT A BALANCE.**
 *
 * A sum of the local pool that never asks the chain would let every decision
 * taken from a vault balance — including whether a payroll run can be afforded
 * — rest on our bookkeeping agreeing with reality by luck.
 *
 * **THREE OUTCOMES, PINNED AS THREE.** Two would be a defect in a different
 * shape: a transaction the node had finalised can read as `not found` to the
 * indexer moments later, so *"we could not check"* and *"the chain
 * says no"* are different answers with opposite consequences, and a test that
 * accepted either refusal for either cause would not notice them merging.
 */
describe('balance reconciles against the chain, or refuses to answer', () => {
  it('AGREES: returns the sum when every note the pool holds is on chain, and only those',
    async () => {
      const { ledger } = harness({
        notes: [{ nonce: '01'.repeat(32), value: 600n }, { nonce: '02'.repeat(32), value: 400n }],
      });
      expect(await ledger.balance(VAULT, GBP)).toBe(1_000n);
    });

  it('DISAGREES, pool claims MORE: names the amount the chain will not honour', async () => {
    /*
     * The direction that costs money at payment time: the vault would offer a
     * note the commitment set does not contain, and the payment is refused —
     * mid-run, after earlier payees have been paid.
     */
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 600n }, { nonce: '02'.repeat(32), value: 400n }],
      chain: [{ nonce: '01'.repeat(32), value: 600n }],
    });
    const failed = await ledger.balance(VAULT, GBP).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultPoolDisagreesWithChain);
    // By how much, and in which direction — both, in words a person can act on.
    expect(failed?.message).toMatch(/claims MORE than the chain will honour/);
    expect(failed?.message).toContain('worth 400 between them');
    expect(failed?.message).toContain('02'.repeat(32));
    // And NOT the other refusal: naming the wrong fault is the defect.
    expect(failed).not.toBeInstanceOf(VaultChainUnreadable);
  });

  it('A NOTE THE CHAIN HOLDS AND THE POOL DOES NOT IS IGNORED, NEVER A FREEZE: the vault states its balance and pays on', async () => {
    /*
     * Anyone may deposit into a vault. A stranger's note is on chain and spendable by nobody, because its opening
     * never reached this pool. RED WHEN the balance, the affordability check or a payment refuses because the chain
     * holds a note the pool does not - one stranger's deposit would freeze a funded vault for good.
     */
    const { ledger } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 600n }],
      chain: [{ nonce: '01'.repeat(32), value: 600n }, { nonce: '02'.repeat(32), value: 400n }],
    });
    expect(await ledger.balance(VAULT, GBP)).toBe(600n);
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET)).resolves.toMatchObject({ kind: 'shielded', spentNote: '01'.repeat(32) });
  });

  it('COULD NOT READ: refuses when the indexer returns no state, and never a local number',
    async () => {
      /*
       * A vault that reads as absent because we asked too early is not a
       * vault that disagrees, and it is certainly not a vault holding nothing.
       */
      const { ledger } = harness({ notes: [{ nonce: '01'.repeat(32), value: 600n }],
        chain: 'unreadable' });
      const failed = await ledger.balance(VAULT, GBP).then(() => null, (e: Error) => e);
      expect(failed).toBeInstanceOf(VaultChainUnreadable);
      expect(failed).not.toBeInstanceOf(VaultPoolDisagreesWithChain);
      expect(failed?.message).toMatch(/could not be read/);
      // The number it would have returned appears NOWHERE, with or without a caveat.
      expect(failed?.message).not.toContain('600');
    });

  it('COULD NOT READ: refuses when the read itself fails, naming the cause', async () => {
    const { ledger } = harness({ chain: 'read-throws' });
    const failed = await ledger.balance(VAULT, GBP).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultChainUnreadable);
    expect(failed?.message).toContain('indexer said no');
  });

  it('COULD NOT READ: a state with no notes set is ignorance, not an empty vault', async () => {
    /*
     * An empty set is a true statement
     * about the vault and a missing one is ours. Answering "empty" here would
     * report every note in the pool as a disagreement — or, one coercion away,
     * a balance of zero.
     */
    const { ledger } = harness({ chain: 'no-notes-field' });
    const failed = await ledger.balance(VAULT, GBP).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultChainUnreadable);
    expect(failed?.message).toMatch(/not an empty vault/);
  });

  it('reconciles the WHOLE pool, not just the token asked about', async () => {
    /*
     * A euro note the chain does not hold means the pool and the chain
     * disagree. A pound balance read out of a pool that is wrong about euros is
     * a number nobody should act on, and reconciling only the asked-for token
     * is how it would be answered anyway.
     */
    const EUR = 'bb'.repeat(32);
    const { ledger, current } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 600n }],
      chain: [{ nonce: '01'.repeat(32), value: 600n }],
    });
    // A euro note the pool believes in and the chain has never held.
    current().notes.push({ nonce: '09'.repeat(32), token: EUR as never, value: 5n, index: 0n });
    const failed = await ledger.balance(VAULT, GBP).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultPoolDisagreesWithChain);
    // The pound sum it would have returned is not in the message either.
    expect(failed?.message).toMatch(/claims MORE than the chain will honour/);
  });
});

/**
 * **THE POOL IS WRITTEN AFTER THE TRANSACTION, AND THE RECOVERY THAT
 * MAKES THAT SAFE IS LOAD-BEARING.**
 *
 * The ordering is correct — of the two ways to fail, it picks the recoverable
 * one — but a justification that lives nowhere is how a later tidy-up finds
 * `replayVault` apparently unused and deletes it. The comments at both write
 * sites say so.
 *
 * **A comment nothing checks is a comment that gets tidied away**, so this is
 * the grep-style test that fails if either site loses the name. It is the same
 * shape as the `signerScope` test in `contracts/test/vault-scoping.test.ts`:
 * read the source, assert about the text, fail by name.
 */
describe('both pool-write sites name the recovery they depend on', () => {
  const source = readFileSync(new URL('./vault-ledger.ts', import.meta.url), 'utf8');

  it('names replayVault at the deposit site and at the payout site', () => {
    /*
     * Two mentions minimum, one per site. Counted rather than merely found,
     * because a single mention would pass while the other site went bare —
     * which is the "guard on some of N" shape.
     */
    const mentions = source.match(/replayVault/g) ?? [];
    expect(mentions.length).toBeGreaterThanOrEqual(2);

    /*
     * AND EACH SAVE IS PRECEDED BY A COMMENT THAT SAYS THE WHOLE THING, WITHIN
     * THE SAME BLOCK — NOT BY A COMMENT THAT CITES AN ID.
     *
     * **A POINTER INTO A DOCUMENT THAT DOES NOT SHIP IS NOT A REASON.** A stranger
     * who clones this repository, reads the comment and wants to check the claim
     * has nowhere to go.
     *
     * **WHAT IS REQUIRED IS THE CLAIM ITSELF, IN FOUR PARTS, EVERY ONE OF WHICH
     * RESOLVES INSIDE THIS REPOSITORY.** The comment at each site must name the
     * recovery, say where it lives, say what the window is, and say what closes
     * it. A comment that keeps the word `replayVault` and loses any of the other
     * three has lost the reason — which is precisely how the ordering here
     * silently becomes the unrecoverable one.
     *
     * **EACH ASSERTION NAMES THE CHANGE THAT TURNS IT RED.**
     */
    /*
     * **THE SITES ARE FOUND BY `advancePool`, AND A BARE SAVE IS PINNED AGAINST
     * AS WELL.** Both writes go through one method that re-reads the
     * pool, re-applies the change and files the next version, so the two places
     * that DECIDE a write are its two call sites.
     *
     * The second assertion is the one worth having: **exactly one `pool.save` in
     * the whole file, and it is inside `advancePool`.** A later change adding a
     * bare `this.pool.save(...)` beside a call would get no retry, no re-read and
     * none of this comment -- and without this line the suite would not notice,
     * because the four checks below would still find their two good sites.
     */
    const saves = [...source.matchAll(/this\s*\.\s*advancePool\s*\(/g)].map(m => m.index!);
    /*
     * **WHITESPACE-INSENSITIVE, AND `await` IS NOT REQUIRED.** A third site
     * written `return this.advancePool(…)` or `void this.advancePool(…)` would
     * keep the count at 2 and carry no comment, and `this.pool\n.save(` would
     * slip past the second check.
     */
    const sites = [...source.matchAll(/this\s*\.\s*advancePool\s*\(/g)];
    expect(sites, 'RED WHEN: a pool-write site is added or removed without carrying the four-part claim below, however it is spelled').toHaveLength(2);
    expect(
      [...source.matchAll(/this\s*\.\s*pool\s*\.\s*save\s*\(/g)],
      'RED WHEN: a write goes straight to the pool instead of through advancePool, which skips the re-read, the re-apply and the retry -- the three things that stop a payment losing its change note',
    ).toHaveLength(1);
    for (const at of saves) {
      /*
       * Flattened, for the reason the assertion below gives about itself: a
       * comment is line-wrapped, and a check that broke when a sentence
       * rewrapped would be noise rather than a guard.
       */
      const before = source.slice(Math.max(0, at - 2_500), at)
        .replace(/^\s*\*/gm, ' ').replace(/\s+/g, ' ');

      expect(before, 'RED WHEN: the name of the recovery is deleted from this comment, which is what lets a later tidy-up grep for callers, find none, and delete it')
        .toMatch(/replayVault/);

      expect(before, 'RED WHEN: the comment stops saying WHERE the recovery lives, so a reader who wants to check the claim has to go looking for it')
        .toMatch(/src\/midnight\/vault-recovery\.ts/);

      expect(before, 'RED WHEN: the comment stops saying that the failure window is a crash BETWEEN the chain call and this write — which is the ordering, and without it the next reader cannot tell why the pool is not written first')
        .toMatch(/crash[^.]{0,160}between/i);

      expect(before, 'RED WHEN: the comment stops saying that the recovery REBUILDS the pool — the dependency rather than the mention, and the half that says this ordering is safe only because something else exists')
        .toMatch(/rebuild/i);
    }
  });

  it('says what breaks without it, rather than only naming it', () => {
    /*
     * The point of the comment is the DEPENDENCY, not the word. A future reader
     * has to learn that deleting the recovery changes this ordering from
     * recoverable to not — which is the whole reason the recovery exists.
     *
     * Matched against whitespace-flattened source, because a comment is
     * line-wrapped and a test that broke when a sentence rewrapped would be
     * noise rather than a check.
     */
    const flat = source.replace(/^\s*\*/gm, ' ').replace(/\s+/g, ' ');
    expect(flat).toMatch(/not a safety net beside this design\. it is part of it/i);
    expect(flat).toMatch(/nothing about this ordering is safe on its own/i);

    /*
     * **AND THE RECOVERY IS NAMED AS RUN, NOT MERELY AS EXISTING.**
     *
     * The claim is that **a recovery path nobody has run does not exist**, so both
     * sites must name the test that runs it. A change that rewrites the recovery
     * and does not re-run it against a real vault fails here.
     */
    expect(flat).toMatch(/contracts\/test\/vault-recovery\.test\.ts/);
    expect(flat).toMatch(/RUN, not\s*\*?\s*asserted/i);
  });
});

/**
 * **A VAULT DEPLOYED TODAY CANNOT BE FUNDED, AND THIS IS WHERE THAT
 * ENDS.**
 *
 * `SealedNotePool.load` refuses when no record exists and `deposit` loads
 * before it calls, so the client could not take the first deposit. The deploy
 * cannot create one — a pool is wrapped per signer and a deploy holds no signer
 * key material — so it is created here, by whatever supplied the
 * `NotePool`, which is the thing that does hold them.
 *
 * **AND THE HALF THAT IS NOT ABOUT CREATION AT ALL.** Answering *empty* where the truth is *unreadable* makes `balance` report zero
 * and leaves every note on chain unexplained. An instrument that can write an
 * empty pool is exactly how that state gets MANUFACTURED — for a vault whose
 * record was lost, `create` sees nothing and succeeds. So the chain is asked
 * first, and these are the three answers.
 */
describe('an empty pool is created only for a vault the CHAIN says is empty', () => {
  it('creates one when the vault exists and its on-chain note set is empty', async () => {
    const { ledger, creates, current } = harness({ notes: [], chain: [], poolExists: false });
    await ledger.openPool(VAULT);
    expect(creates).toEqual([{ notes: [] }]);
    expect(current()).toEqual({ notes: [] });
  });

  it('REFUSES for a vault the chain says holds notes, and names the recovery', async () => {
    /*
     * **THE CASE THIS GUARD EXISTS FOR, AND IT IS NOT A NEW VAULT.** A vault
     * whose pool record has been lost looks identical to one that never had a
     * pool, and `create` alone would write a truthful-looking empty pool over a
     * treasury that is not empty. `balance` would then report zero and every
     * commitment on chain would read as unexplained — which is a rebuild
     * (`replayVault`), not an initialisation.
     */
    const { ledger, creates } = harness({
      notes: [], poolExists: false, chain: [{ nonce: '01'.repeat(32), value: 900n }],
    });
    const failed = await ledger.openPool(VAULT).then(() => null, (e: Error) => e);
    expect(failed).toBeInstanceOf(VaultAlreadyHoldsNotes);
    expect(failed?.message).toMatch(/on-chain set holds 1 note/);
    expect(failed?.message).toMatch(/replayVault/);
    expect(failed?.message).toMatch(/is NOT a new vault|not a new vault/i);
    expect(creates).toEqual([]);
  });

  it('REFUSES when the chain could not be read, and writes nothing', async () => {
    /*
     * A state the node had finalised read as absent to the indexer
     * 168ms later. A vault that reads as empty because we asked too early is
     * the vault this refusal exists for, and the cost of getting it wrong here
     * is the whole treasury reported as zero.
     */
    for (const chain of ['unreadable', 'read-throws', 'no-notes-field'] as const) {
      const { ledger, creates } = harness({ notes: [], poolExists: false, chain });
      const failed = await ledger.openPool(VAULT).then(() => null, (e: Error) => e);
      expect(failed).toBeInstanceOf(VaultChainUnreadable);
      expect(failed).not.toBeInstanceOf(VaultAlreadyHoldsNotes);
      expect(creates).toEqual([]);
    }
  });

  it('leaves the store\'s own refusal to overwrite in place, rather than repeating it', async () => {
    /*
     * Two implementations of "do not replace the record of every note
     * a vault holds" is two chances to soften one of them. The store refuses,
     * this reports it.
     */
    const { ledger, creates } = harness({ notes: [], chain: [], poolExists: true });
    await expect(ledger.openPool(VAULT)).rejects.toThrow(/already has a note pool/);
    expect(creates).toEqual([]);
  });
});

/**
 * **THE CHANGE NOTE IS READ FROM THE CALL, NOT DERIVED BESIDE IT.**
 *
 * The client holds the payout's own result, and the change coin is an OUTPUT of
 * that transaction, so a derived value and a readable value never both exist
 * for the same money. What these pin is that the pool is advanced by the READING, and that a reading
 * which cannot be had is a refusal rather than a payment recorded as keeping
 * nothing.
 */
describe('a private payment spends against the index the chain reports at that moment', () => {
  it('hands the contract the index read from the creating transaction, never a position or a count', async () => {
    const { ledger, spentCoins, eventReads } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 60n }, { nonce: '02'.repeat(32), value: 1_000n }],
    });
    await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);

    /* The note of 1,000 is the second seeded note, filed by the chain at 43. */
    expect(eventReads).toEqual([{ hash: SEEDED_TX }]);
    expect(spentCoins).toHaveLength(1);
    expect(spentCoins[0].value).toBe(1_000n);
    expect(spentCoins[0].mt_index).toBe(seededIndex(1));
  });

  it('never writes that index into the pool: the next spend reads it again', async () => {
    const { ledger, saves } = harness();
    await ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET);
    for (const saved of saves) {
      for (const n of saved.notes) expect(n).not.toHaveProperty('index');
    }
  });

  it('spends the change of the last payment by reading ITS transaction', async () => {
    const { ledger, spentCoins, eventReads } = harness();
    await ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET);
    await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);
    expect(eventReads).toEqual([{ hash: SEEDED_TX }, { hash: payHash(1) }]);
    expect(spentCoins[1].value).toBe(900n);
    expect(spentCoins[1].mt_index).toBe(91n);
  });

  it('REFUSES before a fee when the chain cannot be read, and moves nothing', async () => {
    const { ledger, calls, saves } = harness({ events: 'unreadable' });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET)).rejects.toThrow(NoteIndexUnreadable);
    expect(calls).toEqual([]);
    expect(saves).toEqual([]);
  });

  it('spends at the index the chain gives now, whatever index the pool held', async () => {
    const { ledger, spentCoins, current } = harness({ events: 'moved' });
    current().notes[0] = { ...itemAt(current().notes, 0), index: seededIndex(0) };
    await ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET);
    expect(spentCoins[0].mt_index).toBe(seededIndex(0) + 1n);
  });

  it('REFUSES when the chosen note\'s coin changes under the same nonce while its index is read', async () => {
    const { ledger, calls, saves, spentCoins, current } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    const reading = eventsInUse;
    useEvents({
      eventsOf: async (tx) => {
        const answer = await reading.eventsOf(tx);
        current().notes[0] = { ...itemAt(current().notes, 0), value: 1_200n };
        return answer;
      },
    });
    await expect(ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET)).rejects.toThrow(/changed or left the pool/);
    expect(calls).toEqual([]);
    expect(spentCoins).toEqual([]);
    expect(saves).toEqual([]);
  });

  it('REFUSES before a fee a note that does not record which transaction created it, and names the way out', async () => {
    const { ledger, calls, saves } = harness({ noCreatingTransaction: true });
    await expect(ledger.payout(VAULT, payment(100n), BY, EVENTS, SECRET)).rejects.toThrow(/recordCreatingTransaction/);
    expect(calls).toEqual([]);
    expect(saves).toEqual([]);
  });

  it('never hands the contract a note other than the one whose index was just read', async () => {
    /*
     * The pool changes while the chosen note's index is being read: a larger
     * note that also covers the payment arrives, carrying a stored index - the
     * one any rule choosing again now would take. The witness is offered the
     * chosen note and nothing else, so the note that arrived is neither spent
     * nor spent at its stored number.
     */
    const { ledger, spentCoins, current } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    const reading = eventsInUse;
    useEvents({
      eventsOf: async (tx) => {
        current().notes.push({ nonce: '02'.repeat(32), token: GBP, value: 5_000n, index: 7n, createdIn: SEEDED_TX });
        return reading.eventsOf(tx);
      },
    });
    await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);
    /* RED WHEN the witness chooses again from the pool as it now stands, or spends at an index nobody read for this call. */
    expect(spentCoins.map((c) => [c.value, c.mt_index === 7n])).toEqual([[1_000n, false]]);
  });

  it('saves no index for any note, including one the pool held before the payment', async () => {
    const { ledger, saves, current } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 60n }, { nonce: '02'.repeat(32), value: 1_000n }],
    });
    current().notes[0] = { ...itemAt(current().notes, 0), index: 5n };
    await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);
    expect(saves).toHaveLength(1);
    for (const n of itemAt(saves, 0).notes) expect(n).not.toHaveProperty('index');
  });

  it('a public payment reads no events at all', async () => {
    const { ledger, eventReads } = harness({ poolThrows: true });
    await ledger.payout(VAULT, { ...payment(200n), payee: PUBLIC_PAYEE, token: NIGHT }, BY, EVENTS, SECRET);
    expect(eventReads).toEqual([]);
  });
});

describe('a write to the pool is applied to what the pool holds NOW', () => {
  /*
   * **A WRITE IS A DIFFERENCE APPLIED TO THE POOL AS IT STANDS, NOT A REFUSAL.**
   *
   * A private payment loads the pool, proves for a minute or more, submits, and
   * then writes the change note. A deposit does the same with its new note. The
   * write must not erase whatever another process recorded in that minute, and it
   * must not do so by REFUSING either.
   *
   * **A REFUSAL AFTER THE MONEY HAS MOVED IS A REPORT OF LOSS, NOT A PREVENTION
   * OF IT.** The chain holds the change note, the pool is the only thing that
   * can say what that note IS -- a commitment discloses nothing and cannot be
   * inverted -- so a refused write leaves money in the vault that this machine
   * cannot name and no payment can reach.
   *
   * So the write is a DIFFERENCE applied to the pool as it stands: the other
   * writer's note survives AND this one is recorded. Both halves are asserted,
   * because keeping one without the other is a way to pass this block while
   * losing either the other process's money or this one's.
   */
  const OTHER = { nonce: '0f'.repeat(32), value: 42n };
  const DEPOSITED = '77'.repeat(32);

  it('RECORDS the change of a payment when another process wrote the pool while it proved, and keeps what that process wrote', async () => {
    const { ledger, current, saves } = harness({ anotherWriterAddsDuringTheCall: OTHER });
    await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);

    /*
     * RED WHEN: `advancePool` stops retrying, or stops re-reading the pool
     * before it re-applies -- either of which puts this back to a refusal after
     * the money has moved, which is the whole defect.
     */
    expect(saves, 'RED WHEN: the payment gives up instead of applying its change to the pool as it stands, which leaves the chain holding a change note the pool cannot name').toHaveLength(1);

    const after = current().notes.map((n) => n.nonce);
    /*
     * RED WHEN: the re-applied write is built from the copy the call was made
     * from rather than from a fresh load -- which erases the other writer
     * silently, the failure the version check was added for.
     */
    expect(after, 'RED WHEN: the other process\'s note is erased by this write, which is the silent overwrite the version check exists to prevent').toContain(OTHER.nonce);
    /*
     * RED WHEN: the change note is dropped. `payment(200n)` spends a 1,000 note,
     * so the change is the vault's own 800 coming back, and the fake's outputs
     * carry it under its own nonce.
     */
    expect(after, 'RED WHEN: the payment\'s change note is not recorded, so the vault holds 800 on chain that nothing can spend').toContain('ab'.repeat(32));
    /*
     * RED WHEN: the spent note is left in the pool. It is nullified on chain, so
     * a pool still offering it makes every later payment die inside the circuit
     * after two fees.
     */
    expect(after, 'RED WHEN: the note that was spent stays in the pool, which offers the next payment a note the chain no longer holds').not.toContain('01'.repeat(32));
  });

  it('RECORDS the note of a deposit when another process wrote the pool while it proved, and keeps what that process wrote', async () => {
    const { ledger, current, saves } = harness({ notes: [], anotherWriterAddsDuringTheCall: OTHER });
    await ledger.deposit(VAULT, { token: GBP, value: 500n }, BY);

    expect(saves, 'RED WHEN: the deposit gives up instead of adding its note to the pool as it stands, which leaves money on chain the pool has never heard of').toHaveLength(1);
    const after = current().notes.map((n) => n.nonce);
    expect(after, 'RED WHEN: the other process\'s note is erased by the deposit\'s write').toContain(OTHER.nonce);
    expect(after, 'RED WHEN: the deposit\'s own note is not recorded, which is the money it just moved').toContain(DEPOSITED);
  });

  /**
   * **THE RACE NO RE-READ CAN REMOVE, AND THE ONLY THING THAT EXERCISES THE
   * RETRY.**
   *
   * Re-reading the pool after the money has moved closes the window that is
   * MINUTES wide -- the proof. What is left is the microseconds between that read
   * and the filing of the next version, where two processes can walk through
   * together: both pass the version check, both file, and one note is lost with
   * nothing refused.
   *
   * **WITHOUT THESE TESTS THE WHOLE RETRY COULD BE DELETED WITH EVERY OTHER TEST
   * GREEN**: trying once only, or re-throwing instead of retrying, would leave
   * every other assertion passing.
   */
  it('FILES THE CHANGE ANYWAY when another writer wins the race, by applying it again to what the pool then holds', async () => {
    const { ledger, current, saves } = harness({ poolRaceLostTimes: 2 });
    /*
     * **THE PREMISE IS STATED AS AN ASSERTION AND NOT AS A BARE `await`.** A bare
     * await makes a failure an unhandled rejection, which cannot be told from the
     * code blowing up on an unrelated path -- so deleting the retry would read as
     * "broke the code" rather than as caught.
     */
    await expect(
      ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET),
      'RED WHEN: the payment does not survive a lost race at all, which is the whole of it: the money has moved and the pool does not record it',
    ).resolves.toMatchObject({ kind: 'shielded' });
    expect(
      saves,
      'RED WHEN: the write stops being re-derived after a lost race, which leaves the chain holding a change note the pool cannot name -- a refusal after the money has moved is a report of loss, not a prevention of it',
    ).toHaveLength(1);
    expect(current().notes.map((n) => n.nonce), 'RED WHEN: the change note is not recorded')
      .toContain('ab'.repeat(32));
  });

  it('and it STOPS after a fixed number of attempts, saying the money has moved and the pool does not record it', async () => {
    const { ledger, saves } = harness({ poolRaceLostTimes: 99 });
    /*
     * RED WHEN: the retry becomes unbounded. A write that cannot land must end in
     * a sentence somebody can act on, not in a loop -- the one state left where
     * the money is on chain and no record names it, and the operator has to know
     * they are in it.
     */
    await expect(ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET))
      .rejects.toThrow(/the money has already moved on chain/);
    expect(saves, 'RED WHEN: a write reports failure and lands anyway').toHaveLength(0);
  });

  it('names the recovery, and names nothing a public reader cannot open', async () => {
    const { ledger } = harness({ poolRaceLostTimes: 99 });
    const why = await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET).catch((e: Error) => e.message);
    /*
     * **`reconcileVaultPool` AND NOT AN ALTERNATION.** `/reconcileVaultPool|replayVault/`
     * would accept `replayVault`, which needs a history of the vault's events that
     * nothing in this repository produces -- so the refusal would name a remedy
     * nobody can carry out.
     */
    expect(why, 'RED WHEN: the refusal names replayVault, or nothing -- replayVault needs a history no tool here produces, so naming it is naming something a person cannot do')
      .toMatch(/reconcileVaultPool/);
    /*
     * RED WHEN: a `.command` name is put into this message. None of them
     * ship, so a public reader would meet an instruction naming a file that is not
     * in the repository.
     */
    expect(why, 'RED WHEN: shipping code names an instrument that is not in the shipping set')
      .not.toMatch(/\.command/);
  });

  /**
   * **THE PAYMENT'S HALF OF WHAT MAKES RE-APPLYING SAFE, PINNED AT THE RETRY SITE.**
   *
   * The whole retry rests on the change functions refusing when the pool they are
   * handed cannot be the one the change belongs to. That is asserted twice for a
   * deposit and, here, for a payment -- a unit test of `afterPayment` alone
   * says nothing about whether the retry swallows it.
   *
   * The state: the pool no longer holds the note this payment spent. Two payments
   * cannot spend one note -- the contract nullifies the commitment -- so a pool
   * without it is not the pool this payment belongs to, and guessing would drop a
   * note the chain still holds and add a change note against nothing.
   */
  it('REFUSES rather than retrying when the pool no longer holds the note the payment spent', async () => {
    const { ledger, current, saves } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }],
      /*
       * The pool becomes one that does not hold the note this payment spent, while
       * the call is being proved -- so the money moves and only then does the write
       * meet a pool its change cannot be applied to.
       */
      poolBecomesDuringTheCall: [{ nonce: '0f'.repeat(32), value: 42n }],
    });
    const why = await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET)
      .then(() => 'IT DID NOT REFUSE', (e: Error) => e.message);

    /*
     * **THE MESSAGE, NOT MERELY A THROW.** A bare `.rejects.toThrow()` would be
     * satisfied by the exhaustion error -- so deleting `if (!isALostPoolRace(cause))
     * throw cause;` would leave this green, which is the one change it exists to
     * catch.
     */
    expect(
      why,
      'RED WHEN: the retry treats "this is not the pool my change belongs to" as contention, attempts it five times, and reports it as contention -- which is a guess about which notes exist',
    ).toMatch(/no note .* to spend|does not hold/i);
    expect(
      why,
      'RED WHEN: the refusal arrives as the retry giving up, which tells the operator another writer is busy when what actually happened is that this is not the pool this payment belongs to',
    ).not.toMatch(/all 5 attempts|another writer filed the next version first/);
    expect(saves, 'RED WHEN: a change note is written against a pool that does not hold the note it came from').toHaveLength(0);
    expect(
      current().notes.map((n) => n.nonce),
      'RED WHEN: the other writer\'s note is erased by a payment that could not be applied',
    ).toEqual(['0f'.repeat(32)]);
  });

  /**
   * **THE DEPOSIT'S CHAIN READ IS OUTSIDE THE WINDOW, AND THIS IS THE
   * ASSERTION THAT SAYS SO.**
   *
   * A deposit whose call reports only the 33-byte identifier has to ask the chain
   * for the transaction hash, because that is what a spend names the creating
   * transaction by. That read must not sit BETWEEN the load the write was built on
   * and the write itself, which would make the window a network round trip wide
   * rather than an instant -- and in that branch a refusal would lose the note
   * from the pool entirely.
   *
   * **SO THE OTHER WRITER LANDS INSIDE THE CHAIN READ**, which is the one place
   * `anotherWriterAddsDuringTheCall` cannot reach: it fires in the circuit, and
   * the chain read happens after the circuit returns. Same hook the
   * index-read test above uses, for the same reason -- the window has to be
   * entered from inside to be measured.
   */
  it('records the deposit\'s note when another writer lands inside the CHAIN READ, and keeps what that writer wrote', async () => {
    const { ledger, current, saves, eventReads } = harness({
      notes: [], depositResult: 'no-hash',
      anotherWriterAddsDuringTheChainRead: OTHER,
    });

    await ledger.deposit(VAULT, { token: GBP, value: 500n }, BY, eventsInUse);

    expect(eventReads, 'RED WHEN: the chain is not asked at all, so this test is not in the branch it is about').not.toEqual([]);
    /*
     * RED WHEN: the pool is read before the chain read rather than after -- then
     * this write is built on a copy that predates the other writer, the version
     * check refuses it, and the deposit's own note is lost from the pool while its
     * money sits on chain. That is the defect exactly, and it is the branch the earlier change
     * measured as the one where a refusal loses the note entirely.
     */
    /*
     * **ONE SAVE, ON THE FIRST ATTEMPT.** The retry would absorb a chain read
     * that went back inside the window, so a refusal is not what the ordering
     * buys. What it buys is that the write lands without contending at all.
     */
    expect(saves, 'RED WHEN: the deposit writes more than once, or not at all -- either means its chain read is back inside the window between the load and the write, where it has to contend with whoever wrote during it').toHaveLength(1);
    const after = current().notes.map((n) => n.nonce);
    expect(after, 'RED WHEN: the writer that landed during the chain read is erased').toContain(OTHER.nonce);
    expect(after, 'RED WHEN: the deposit\'s own note is lost, which is money on chain that nothing names').toContain(DEPOSITED);
  });

  /**
   * **THE HALF THAT MUST STILL REFUSE, AND IT IS WHY RE-APPLYING IS SAFE AT ALL.**
   *
   * `advancePool` retries by calling the change again against a fresh pool. That
   * is only safe because the change REFUSES when the pool it is handed cannot be
   * the one the change belongs to -- so a retry cannot write the same note twice
   * and cannot invent one. A deposit of a nonce the pool already holds is that
   * case, and the refusal is thrown out of the retry rather than swallowed by it.
   */
  it('still REFUSES a deposit of a note the pool already holds, and the retry does not swallow it', async () => {
    /*
     * **THE DUPLICATE ARRIVES DURING THE CALL, WHICH IS THE ONLY WAY TO REACH THE
     * RETRY WITH IT.** The first version of this test started from a pool that
     * already held the nonce -- so the deposit's own pre-flight refused it before
     * any call was made, `advancePool` was never entered, and the title's claim
     * about the retry was unexercised. A second reading found that.
     */
    const { ledger, saves } = harness({
      notes: [],
      anotherWriterAddsDuringTheCall: { nonce: DEPOSITED, value: 1n },
    });
    await expect(
      ledger.deposit(VAULT, { token: GBP, value: 500n }, BY),
      'RED WHEN: the retry catches everything rather than only a lost race, so a change that cannot be true is attempted five times and then reported as contention',
    ).rejects.toThrow(/already holds a note/);
    expect(saves, 'RED WHEN: a refused change is written anyway').toHaveLength(0);
  });

  /**
   * **AND IT REFUSES BEFORE THE MONEY MOVES, WHICH IS THE OTHER HALF.**
   *
   * The same refusal, reached with no call made at all: the deposit tries its own
   * write against the pool before it proves anything, so a deposit that cannot be
   * recorded costs nothing rather than a fee and a note on chain nobody can name.
   */
  it('refuses that deposit BEFORE the call, so no money moves', async () => {
    const { ledger, calls } = harness({
      notes: [{ nonce: DEPOSITED, value: 1_000n }], depositNonces: [DEPOSITED, DEPOSITED, DEPOSITED, DEPOSITED],
    });
    await expect(ledger.deposit(VAULT, { token: GBP, value: 500n }, BY))
      .rejects.toThrow(/pool already holds a note under this nonce/);
    expect(
      calls.filter((c) => c.circuit === 'deposit'),
      'RED WHEN: the pre-flight write moves below the call, so the vault pays a fee to deposit a note that cannot be recorded',
    ).toEqual([]);
  });

  it('and with nobody else writing, both still advance the pool', async () => {
    const paid = harness({});
    await paid.ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);
    expect(paid.saves).toHaveLength(1);
    const deposited = harness({ notes: [] });
    await deposited.ledger.deposit(VAULT, { token: GBP, value: 500n }, BY);
    expect(deposited.saves).toHaveLength(1);
  });

  it('seals only the notes, never the version a load read', async () => {
    const { ledger, saves } = harness({});
    await ledger.payout(VAULT, payment(200n), BY, EVENTS, SECRET);
    expect(Object.keys(itemAt(saves, 0))).toEqual(['notes']);
  });
});

describe('the pool advances by the coin the call reported', () => {
  it('records the change coin\'s OWN nonce, which no derivation here produced', async () => {
    const { ledger, current } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    await ledger.payout(VAULT, payment(250n), BY, EVENTS, SECRET);

    const change = current().notes.find(n => n.value === 750n)!;
    expect(change).toBeDefined();
    expect(change.nonce).toBe('ab'.repeat(32));   // what the fake's outputs carried
    expect(change.createdIn).toBe(payHash(1));
    expect(change).not.toHaveProperty('index');
  });

  it('REFUSES when the call carries no readable Zswap state, rather than recording nothing kept',
    async () => {
      /*
       * **THE MONEY PATH'S LAST STEP.** A result we could not read, answered as
       * "no change", drops the change note from the pool: the commitment stays on
       * chain and nobody can ever say which note it describes. The pool must not
       * move.
       */
      const { ledger, saves } = harness({
        notes: [{ nonce: '01'.repeat(32), value: 1_000n }], reads: 'absent',
      });
      await expect(ledger.payout(VAULT, payment(250n), BY, EVENTS, SECRET))
        .rejects.toThrow(/no readable "outputs"/);
      expect(saves).toEqual([]);
    });

  it('REFUSES when the call says the vault kept nothing and the arithmetic says otherwise',
    async () => {
      const { ledger, saves } = harness({
        notes: [{ nonce: '01'.repeat(32), value: 1_000n }], reads: 'none',
      });
      await expect(ledger.payout(VAULT, payment(250n), BY, EVENTS, SECRET))
        .rejects.toThrow(/no coin coming back to it/);
      expect(saves).toEqual([]);
    });

  it('REFUSES when the coin read back disagrees with the arithmetic', async () => {
    const { ledger, saves } = harness({
      notes: [{ nonce: '01'.repeat(32), value: 1_000n }], reads: 'wrong-value',
    });
    await expect(ledger.payout(VAULT, payment(250n), BY, EVENTS, SECRET))
      .rejects.toThrow(/two claims about the same money/);
    expect(saves).toEqual([]);
  });

  it('REFUSES a private payment given nowhere to read the note\'s index, before anything is called', async () => {
    const { ledger, calls, saves } = harness({ notes: [{ nonce: '01'.repeat(32), value: 1_000n }] });
    await expect(ledger.payout(VAULT, payment(250n), BY))
      .rejects.toThrow(/No source of the chain\x27s events was given/);
    expect(calls).toEqual([]);
    expect(saves).toEqual([]);
  });
});

