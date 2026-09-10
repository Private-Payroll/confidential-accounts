/**
 * **WHAT A DEPLOYMENT IS TOLD WHEN IT CANNOT WRITE, AND WHAT IT IS TOLD WHEN IT
 * IS SHORT OF ONE THING RATHER THAN ALL OF THEM.**
 *
 * The rule under test is pure over five booleans, and that is the point: the
 * refusing branch of a write guard is otherwise reachable only by funding a
 * wallet, choosing a maintenance authority and compiling a contract - so it is
 * a branch nobody ever sees fire, and its sentence goes stale unread.
 *
 * The case that carries the most weight is the four-of-five one. A guard wired
 * to the first missing piece passes every other case in this file and reports
 * the wrong cause for the one state an operator actually has to diagnose.
 */
import { describe, it, expect } from 'vitest';
import {
  WRITE_PARTS, refusalForMissingWrite, refusalForCapability,
  type WriteCapability, type WritePart,
} from './write-capability.js';

const all = (value: boolean): Record<WritePart, boolean> =>
  Object.fromEntries(WRITE_PARTS.map(p => [p, value])) as Record<WritePart, boolean>;

const allBut = (missing: WritePart): Record<WritePart, boolean> =>
  ({ ...all(true), [missing]: false });

const capable = (): WriteCapability => ({
  maintenanceAuthority: { kind: 'unmaintainable' },
  compiled: { it: 'is here' },
  /*
   * **NOT `{}`, AND THAT IS THE POINT OF THESE SIX LINES.** Both members used
   * to be empty objects here, and the rule accepted them - so the fixture was
   * asserting that a deployment holding nothing where the wallet and the fee
   * payer go could write. The members are the ones the write path actually
   * calls; nothing behind them is real, and nothing needs to be.
   */
  customer: {
    coinPublicKey: () => 'not-a-secret: a test literal',
    encryptionPublicKey: () => 'not-a-secret: a test literal',
    balanceOwnLegs: async (tx: unknown) => tx,
    release: async () => {},
  } as WriteCapability['customer'],
  sponsor: {
    addFeeAndFinalise: async (tx: unknown) => tx,
    submit: async () => ({ ref: 'tx', at: '' }),
    release: async () => {},
    payingFor: () => {},
    capacity: async () => ({ dust: 0n, night: 0n }),
  } as WriteCapability['sponsor'],
  storagePassword: async () => 'not-a-secret: a test literal',
});

describe('a deployment is told which pieces of writing it has not got', () => {
  /*
   * **THE POSITIVE CONTROL, AND WITHOUT IT EVERY CASE BELOW ALSO PASSES
   * AGAINST A RULE THAT REFUSES UNCONDITIONALLY** - which is the shape of a
   * guard that is really a disabled feature.
   *
   * RED WHEN: the rule refuses when nothing is missing.
   */
  it('says nothing at all when all five are there', () => {
    expect(refusalForMissingWrite(all(true))).toBeNull();
    expect(refusalForCapability(capable())).toBeNull();
  });

  /*
   * RED WHEN: the capability is not consulted and absence is assumed either
   * way. This is the pair that decides whether a write refuses or is delegated,
   * so the two answers must come apart on the argument alone.
   */
  it('a deployment with nothing wired refuses, and names all five', () => {
    const said = refusalForCapability(undefined);
    expect(said).not.toBeNull();
    expect(said).toContain('maintenance authority');
    expect(said).toContain('compiled contract');
    expect(said).toContain('balance the parts of a transaction the company itself owns');
    expect(said).toContain('pay the transaction fee');
    expect(said).toContain('private state store');
  });

  /*
   * **THE CASE THAT CATCHES A GUARD WIRED TO THE FIRST CHECK ONLY.**
   *
   * RED WHEN: the rule stops at the first missing piece, or reports a fixed
   * sentence. Four of the five are present, so a rule that names anything but
   * the fifth is naming a piece the deployment has.
   */
  for (const part of WRITE_PARTS) {
    it(`short of ${part} alone, it says so and does not name the other four`, () => {
      const said = refusalForMissingWrite(allBut(part));
      expect(said, `${part} missing produced no refusal`).not.toBeNull();

      /* Exactly one cause, so the sentence has no list separator in it. */
      expect(said).not.toContain('; and ');

      /* And it is the right one: every other part's cause is absent. */
      for (const other of WRITE_PARTS) {
        if (other === part) continue;
        const othersOnly = refusalForMissingWrite(allBut(other))!;
        const causeOfOther = othersOnly.slice(
          othersOnly.indexOf('cannot write to it: '), othersOnly.indexOf('. Reading'));
        expect(said, `it named ${other} while ${part} was the missing one`)
          .not.toContain(causeOfOther);
      }
    });
  }

  /*
   * RED WHEN: two missing pieces produce one cause, or the same cause twice.
   */
  it('two missing pieces are both named, once each', () => {
    const said = refusalForMissingWrite({ ...all(true), circuits: false, feePayer: false })!;
    expect(said).toContain('; and ');
    expect(said).toContain('compiled contract');
    expect(said).toContain('pay the transaction fee');
    expect(said).not.toContain('maintenance authority');
  });

  /*
   * **THE REFUSAL SAYS WHAT STILL WORKS, AND THAT IS NOT DECORATION.** An
   * operator reading it has to be able to tell "this is broken" from "this
   * deployment was built to watch".
   *
   * RED WHEN: the reading half of the sentence is dropped.
   */
  it('says what a deployment that cannot write can still do', () => {
    const said = refusalForCapability(undefined)!;
    expect(said).toContain('Reading an account, its balances and its open rounds works');
    expect(said).toContain('opening a company');
  });

  /*
   * RED WHEN: a refusal names a file, a command or a variable. The person
   * reading may be looking at a health route rather than a terminal.
   */
  it('names states and never a thing to type', () => {
    for (const part of WRITE_PARTS) {
      const said = refusalForMissingWrite(allBut(part))!;
      expect(said, part).not.toMatch(/\.command|npm run|[A-Z]{3,}_[A-Z_]+/);
    }
  });

  /*
   * **A CAPABILITY HOLDING A HOLE IS NOT A CAPABILITY.**
   *
   * RED WHEN: the object is trusted because it exists. The type says all five
   * are present; the type is not what arrives at runtime from configuration,
   * and a half-built one is exactly what a partially-configured deployment
   * produces.
   */
  it('a capability missing a piece refuses for that piece', () => {
    const holed = { ...capable(), compiled: undefined } as unknown as WriteCapability;
    expect(refusalForCapability(holed)).toContain('compiled contract');

    const noKey = { ...capable(), storagePassword: undefined } as unknown as WriteCapability;
    expect(refusalForCapability(noKey)).toContain('private state store');

    /*
     * **AND THE TWO WITH SPEND AUTHORITY ARE THE ONES THIS CASE IS REALLY
     * FOR.** They were checked for truthiness, so an empty object passed - and
     * an empty object is exactly what a partially-wired deployment produces.
     * A deployment holding these was judged able to write, and the first thing
     * to notice would have been a dereference of nothing at the moment a
     * transaction was already being paid for.
     */
    const noWallet = { ...capable(), customer: {} } as unknown as WriteCapability;
    expect(refusalForCapability(noWallet),
      'an empty object was accepted where the wallet goes')
      .toContain('balance the parts of a transaction the company itself owns');

    const noPayer = { ...capable(), sponsor: {} } as unknown as WriteCapability;
    expect(refusalForCapability(noPayer),
      'an empty object was accepted where the fee payer goes')
      .toContain('pay the transaction fee');

    /* And a wallet short of ONE of the members the write path calls is not a
     * wallet either - the presence of the object is not the question. */
    const halfWallet = {
      ...capable(),
      customer: { coinPublicKey: () => '', encryptionPublicKey: () => '' },
    } as unknown as WriteCapability;
    expect(refusalForCapability(halfWallet),
      'a wallet that cannot balance was accepted')
      .toContain('balance the parts of a transaction the company itself owns');
  });

  /*
   * **A WALLET THAT CANNOT LET GO OF WHAT IT BOOKED IS NOT A WALLET THIS
   * DEPLOYMENT MAY WRITE WITH, AND THE SAME IS TRUE OF THE FEE PAYER.**
   *
   * Balancing books coins; only submitting spends them; nothing releases them
   * by time and the vendor's own cleanup never sees a transaction that was
   * never submitted. So a party with no release is a party whose failures each
   * take a little money out of circulation and say nothing - and on the
   * company's side that money is not ours.
   *
   * RED WHEN: `'release'` is dropped from either member list in
   * `refusalForCapability`. Nothing else in this file notices: both objects
   * below satisfy every other member the write path calls.
   */
  it('a party that cannot release what it booked is refused', () => {
    const noRelease = {
      ...capable(),
      customer: {
        coinPublicKey: () => '', encryptionPublicKey: () => '', balanceOwnLegs: async () => ({}),
      },
    } as unknown as WriteCapability;
    expect(refusalForCapability(noRelease),
      'a company wallet with no way to release its own booking was accepted')
      .toContain('balance the parts of a transaction the company itself owns');

    const payerCannotRelease = {
      ...capable(),
      sponsor: {
        addFeeAndFinalise: async () => ({}), submit: async () => ({ ref: '', at: '' }),
        capacity: async () => ({ dust: 0n, night: 0n }), payingFor: () => {},
      },
    } as unknown as WriteCapability;
    expect(refusalForCapability(payerCannotRelease),
      'a fee payer with no way to release its own booking was accepted')
      .toContain('pay the transaction fee');
  });

  /*
   * **AND A FEE PAYER THAT CANNOT BE TOLD WHOSE TRANSACTION IT IS PAYING FOR.**
   *
   * Attribution cannot be extracted from a bound, shielded transaction after
   * the fact, so a fee payer without this member is one whose records can never
   * say who anything was for. It is a record rather than a control, which is
   * exactly why nothing else would ever notice its absence.
   *
   * RED WHEN: `'payingFor'` is dropped from the fee payer's member list.
   */
  it('a fee payer that cannot be told whose transaction it is is refused', () => {
    const anonymous = {
      ...capable(),
      sponsor: {
        addFeeAndFinalise: async () => ({}), submit: async () => ({ ref: '', at: '' }),
        release: async () => {}, capacity: async () => ({ dust: 0n, night: 0n }),
      },
    } as unknown as WriteCapability;
    expect(refusalForCapability(anonymous)).toContain('pay the transaction fee');
  });
});
