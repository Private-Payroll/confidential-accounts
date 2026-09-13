/**
 * THE TWO SIZES, MEASURED AGAINST THE LEDGER THIS PROJECT ACTUALLY RUNS.
 *
 * NOTHING HERE IS A HAND-WRITTEN FIXTURE. Every number is read out of the WASM
 * ledger at test time, because the claim under test is a claim ABOUT that
 * ledger — that `serialize().length` is not the size any limit is expressed in.
 * Asserting a remembered number would be this repository asserting its own
 * belief, which is the thing that produced the wrong claim in the first place.
 *
 * Each assertion names the change that turns it red. The mutations were applied
 * to a COPY outside this repository and watched failing.
 *
 * WHAT WOULD MAKE THESE STALE: a ledger upgrade that changes the serialisation
 * wrapper. The gap is measured rather than asserted, so that would show up as a
 * changed number here and not as a silent wrong answer in a report.
 */
import { describe, expect, it } from 'vitest';

import { compareAgainstLimits, measureCost, measureCostAt, measureTransaction, readDismissRefusal,
         type BlockLimits } from './tx-size.js';

const L: any = await import('@midnightntwrk/ledger-v9');
const { LedgerParameters, Transaction, Intent, UnshieldedOffer, nativeToken,
        sampleSigningKey, signatureVerifyingKey, addressFromKey } = L;

const vk = signatureVerifyingKey(sampleSigningKey());

/** A transaction carrying `n` NIGHT outputs, built only to be measured. */
const txWith = (n: number, value = 1_000_000n) => {
  const outputs = Array.from({ length: n }, () => ({
    owner: addressFromKey(vk), type: nativeToken().raw, value,
  }));
  const intent = Intent.new(new Date(Date.now() + 3_600_000));
  intent.guaranteedUnshieldedOffer = UnshieldedOffer.new([], outputs, []);
  return Transaction.fromParts('undeployed').addIntent({ tag: 'specific', value: 1 }, intent);
};

describe('THE SIZE THE LIMIT IS EXPRESSED IN', () => {
  it('is reported at all, which it was not before', () => {
    // TURNS RED IF: `ledgerBytes` stops being populated when a LedgerParameters
    // is supplied. Reporting only `serialize().length` is the defect: every
    // size this project quoted about a refusal was that number.
    const m = measureTransaction(txWith(1), 'probe', LedgerParameters);
    expect(m.ledgerBytes).not.toBeNull();
    expect(typeof m.ledgerBytes).toBe('number');
  });

  it('is NOT the same number as serialize().length', () => {
    // TURNS RED IF: `ledgerBytes` is quietly re-pointed at `serialize().length`.
    // That is the single change that would make this whole correction a no-op
    // while leaving every name and every comment looking right.
    const m = measureTransaction(txWith(1), 'probe', LedgerParameters);
    expect(m.bytes).not.toBeNull();
    expect(m.ledgerBytes).not.toBe(m.bytes);
    expect(m.ledgerBytes!).toBeLessThan(m.bytes!);
  });

  it('differs from serialize().length by a SMALL amount that is not always the same', () => {
    /*
     * TURNS RED IF: the gap becomes proportional to the size, or one of the two
     * numbers stops being read off what it claims to be read off.
     *
     * THE FIRST VERSION OF THIS ASSERTED THE GAP WAS ONE CONSTANT, over a
     * sample of four transactions that all carried an intent — and it was green
     * while pinning a claim the same sweep refutes, because the empty
     * transaction gaps 72 where the others gap 73. The sample is widened here
     * so the assertion is about what was measured rather than about what four
     * chosen rows happened to share.
     */
    const gaps = [
      Transaction.fromParts('undeployed'),
      txWith(1), txWith(2), txWith(1, 1n), txWith(1, 2n ** 64n - 1n),
    ]
      .map(tx => measureTransaction(tx, 'probe', LedgerParameters))
      .map(m => m.bytes! - m.ledgerBytes!);

    // Small and bounded: a wrapper, not a term that grows with the transaction.
    for (const g of gaps) { expect(g > 0 && g < 128).toBe(true); }
    // And NOT one value, which is the whole reason it cannot be used to convert.
    expect(new Set(gaps).size > 1).toBe(true);
  });

  it('is asked for WITHOUT enforcement, which is watched rather than assumed', () => {
    /*
     * TURNS RED IF: the size is taken through the enforcing `cost()` again.
     *
     * THE OBVIOUS VERSION OF THIS TEST CANNOT FAIL, and it was written that way
     * first: asserting that a real transaction still reports a size proves
     * nothing, because every transaction small enough to build here passes the
     * time-to-dismiss check, so enforcement changes nothing about it. The
     * transaction that WOULD be refused is the one that costs a funded wallet
     * and a proof to make. So the flag is observed at the call instead, through
     * a transaction that exists only to record how it was asked.
     */
    const asked: unknown[] = [];
    const recording = {
      serialize: () => new Uint8Array(300),
      cost: (_p: unknown, enforce: unknown) => { asked.push(enforce); return { blockUsage: 227n }; },
    };
    const m = measureTransaction(recording, 'probe', LedgerParameters);
    expect(m.ledgerBytes).toBe(227);
    expect(asked).toContain(false);
  });

  it('leaves both sizes null when no LedgerParameters was supplied, rather than guessing', () => {
    // TURNS RED IF: a missing ledger starts producing a size from the client's
    // own serialisation under the name of the ledger's. A number nobody read
    // off an instrument is the thing this project refuses to print.
    const m = measureTransaction(txWith(1), 'probe');
    expect(m.ledgerBytes).toBeNull();
  });
});

describe('THE COMPARISON SIX DOORS PRINT', () => {
  const limits: BlockLimits = {
    readTime: null, computeTime: null, blockUsage: 200_000,
    bytesWritten: 50_000, bytesChurned: 1_000_000, source: 'a fixture, for this test only',
  };

  it('judges the LEDGER\'s size against the limit, not the client\'s', () => {
    /*
     * TURNS RED IF: the comparator goes back to `m.bytes`.
     *
     * THIS IS WHERE THE CORRECTION ACTUALLY BITES, and it was the one change of
     * this round that nothing held: a mutation putting `serialize().length`
     * back left every test green. The limit here is `block_usage`, which IS the
     * ledger's size, so a verdict computed from the other number is a verdict
     * about the wrong quantity — in the direction that makes a transaction look
     * closer to the limit than it is.
     */
    const m = measureTransaction(txWith(1), 'probe', LedgerParameters);
    const lines = compareAgainstLimits(m, limits).join('\n');
    expect(lines).toContain(`${m.ledgerBytes!.toLocaleString()} bytes against a 200,000-byte block`);
    expect(lines).not.toContain(`${m.bytes!.toLocaleString()} bytes against a 200,000-byte block`);
  });

  it('still SHOWS the client\'s own size, beside the one it judges', () => {
    // TURNS RED IF: the client's number is dropped. It is what a reader sees in
    // the wallet's own logs, so hiding it makes the two reports disagree with
    // no explanation.
    const m = measureTransaction(txWith(1), 'probe', LedgerParameters);
    const lines = compareAgainstLimits(m, limits).join('\n');
    expect(lines).toContain('as the client serialises it');
    expect(lines).toContain(m.bytes!.toLocaleString());
  });

  it('refuses to compare at all when the ledger did not answer', () => {
    // TURNS RED IF: a missing ledger size falls back to the client's. A
    // comparison against a number that was not read is the defect this file
    // names in its own header.
    const m = measureTransaction(txWith(1), 'probe');
    const lines = compareAgainstLimits(m, limits).join('\n');
    expect(lines).toContain('NO COMPARISON IS POSSIBLE');
  });
});

describe('THE NUMBERS IN A REFUSAL, WHICH USED TO BE THROWN AWAY', () => {
  /** The refusal the ledger formats, word for word from its own source. */
  const REFUSAL =
    'exceeded the maximum time to dismiss for transaction size; this transaction would take '
    + '15.038ms to dismiss, but given its size of 7088 bytes, it may take at most 15.000ms';

  it('reads the time, the size and the allowance out of the refusal', () => {
    // TURNS RED IF: any of the three patterns stops matching the wording the
    // ledger writes. This is the only branch where the numbers matter: a
    // transaction that fits needs no explanation and one that does not is acted
    // on by how far over it is.
    expect(readDismissRefusal(REFUSAL)).toEqual({
      timePs: 15_038_000_000, sizeBytes: 7088, allowancePs: 15_000_000_000,
    });
  });

  it('reads a microsecond figure, which is written with the Greek letter', () => {
    // TURNS RED IF: the micro sign becomes the letter u, which silently reads
    // every microsecond figure as unmatched.
    expect(readDismissRefusal('would take 900.000\u03bcs to dismiss')!.timePs).toBe(900_000_000);
  });

  it('says nothing rather than inventing numbers for an unrelated failure', () => {
    // TURNS RED IF: a message that is not a dismiss refusal is given zeros,
    // which would read as a transaction costing nothing to dismiss.
    expect(readDismissRefusal('the wallet is not connected')).toBeUndefined();
  });

  it('KEEPS THE NUMBERS when the ledger refuses the real transaction', () => {
    /*
     * TURNS RED IF: the throw branch goes back to keeping only the message.
     *
     * Measured against the ledger rather than against a string: a transaction
     * of a shape the enforcing cost call refuses, costed with enforcement on.
     */
    const many = txWith(400);
    const reading = measureCost(many, LedgerParameters);
    expect(reading.problem).toBeTruthy();
    expect(reading.dismiss).toBeTruthy();
    expect(reading.dismiss!.timePs).toBeGreaterThan(0);
    expect(reading.dismiss!.allowancePs).toBeGreaterThan(0);
    expect(reading.dismiss!.timePs!).toBeGreaterThan(reading.dismiss!.allowancePs!);
  });

  it('records which parameters a cost was taken at, because it only means anything against those', () => {
    /*
     * TURNS RED IF: the label is dropped, or the two routes start reporting the
     * same source.
     *
     * The library's starting values are what a chain begins with and not what
     * one is running. Every cost this project has recorded was taken at them
     * and none of them said so.
     */
    expect(measureCost(txWith(1), LedgerParameters).parametersSource).toBe("the library's starting values");
    expect(measureCostAt(txWith(1), LedgerParameters.initialParameters()).parametersSource).toBe('supplied');
  });

  it('costs against parameters it is handed rather than fetching its own', () => {
    // TURNS RED IF: the supplied-parameters route quietly reads the library's
    // constant anyway, which would make a live reading decorative.
    let asked = 0;
    const params = LedgerParameters.initialParameters();
    const spy = { cost: (p: any, e: boolean) => { asked++; expect(p).toBe(params); return txWith(1).cost(p, e); } };
    const reading = measureCostAt(spy as any, params, false);
    expect(asked).toBe(1);
    expect(reading.cost).toBeTruthy();
  });
});
