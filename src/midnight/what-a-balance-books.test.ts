/**
 * **BALANCING BOOKS COINS. ONLY SUBMITTING SPENDS THEM. THESE CASES ARE ABOUT
 * THE GAP BETWEEN THE TWO.**
 *
 * The SDK calls the balance and the submission as two separate callbacks at two
 * separate times, and until this round they were built as two independent
 * objects with nothing in common. Anything that went wrong in between - proving,
 * staging, an expiry, a caller giving up - ended the operation with the coins
 * still marked in-flight, and nothing afterwards let go of them: the vendor's
 * time-based sweep is a documented no-op, and its own cleanup only ever acts on
 * transactions that got an answer from chain sync, which one that was never
 * submitted never gets.
 *
 * The consequence is quiet, which is what makes it worth a file. Each failure
 * takes a little of the fee budget out of circulation; the next attempt balances
 * onto fresh coins because the booked ones are filtered out as pending; and the
 * balance that gets reported looks healthy right up until it does not.
 *
 * ── WHAT THESE CASES ESTABLISH, AND THE LINE THEY DO NOT CROSS ───────────
 *
 * **They are measurements about the LINK between the two callbacks and about
 * nothing else.** `FeeSponsor` is an interface, and the sponsor here is a
 * hand-written one - which is that seam used as designed, not a stand-in.
 *
 * **They do not establish anything about a wallet, a coin, or a chain, and they
 * cannot.** No deployment in this product has a customer wallet or a fee payer:
 * the one place that would supply them sets its capability to nothing, on
 * purpose, with the reason written beside it. So *a real booking is really
 * released* has no path to run down today, and a case that appeared to say so
 * would be a case reading its own double back. What is written here is the
 * bookkeeping. What is missing is the money, and the missing half is named
 * rather than implied.
 */
import { describe, it, expect } from 'vitest';
import { sponsoredProviders } from './providers.js';
import { MidnightJobRunner, type JobRunnerDeps } from './job-runner.js';
import type { FeeSponsor } from './ledger.js';
import type { Job } from '../core/jobs.js';

const customer = {
  coinPublicKey: () => 'not-a-secret: a test literal',
  encryptionPublicKey: () => 'not-a-secret: a test literal',
  balanceOwnLegs: async (tx: unknown) => ({ customerLegs: tx }),
};

/** Records what it was asked to do, so a case can assert on the argument. */
const sponsor = (over: Partial<FeeSponsor> = {}) => {
  const released: unknown[] = [];
  const submitted: unknown[] = [];
  const it: FeeSponsor = {
    addFeeAndFinalise: async (tx) => ({ finalised: tx }),
    submit: async (tx) => { submitted.push(tx); return { ref: 'tx_1', at: '' }; },
    release: async (booking) => { released.push(booking); },
    capacity: async () => ({ dust: 0n, night: 0n }),
    ...over,
  };
  return { it, released, submitted };
};

describe('a balance that is never submitted is released', () => {
  it('releases exactly what the balance produced, not something like it', async () => {
    /*
     * RED WHEN: `balanceTx` records `tx` - what went IN to the balance - rather
     * than `finalised`, what came out. The vendor's release is given a booking
     * to look up, so handing it the wrong object is a release that quietly
     * frees nothing, which is the whole failure wearing a fix. **The site is
     * the `outstanding.add` in `balanceTx`; `releaseUnspent` only passes on
     * what it was given, and the first version of this comment named the wrong
     * one of the two.**
     */
    const s = sponsor();
    const p = sponsoredProviders(customer, s.it);

    const finalised = await p.walletProvider.balanceTx({ the: 'transaction' } as any, new Date());
    // and now the operation is abandoned, which is the case with no owner
    expect(await p.releaseUnspent()).toBe(1);

    expect(s.released).toHaveLength(1);
    expect(s.released[0], 'the release was handed something other than the booking')
      .toBe(finalised);
  });

  it('releases NOTHING once the transaction has gone out', async () => {
    /*
     * The negative control, and it is the more important half. A release that
     * fires after a successful submission marks spent coins available again;
     * the wallet's local state is then ahead of the chain and the next
     * transaction selects coins that no longer exist.
     *
     * RED WHEN: `submitTx` stops forgetting the booking - the
     * `outstanding.delete(tx)` line - so the cleanup below finds it still there.
     */
    const s = sponsor();
    const p = sponsoredProviders(customer, s.it);

    const finalised = await p.walletProvider.balanceTx({ the: 'transaction' } as any, new Date());
    await p.midnightProvider.submitTx(finalised as any);

    expect(await p.releaseUnspent()).toBe(0);
    expect(s.released, 'a booking that was submitted was released as well').toEqual([]);
  });

  it('and nothing double-releases when the submission itself throws', async () => {
    /*
     * **THE ORDER OF THE HANDOVER IS WHAT THIS ASSERTS.** The sponsor's own
     * `submit` already releases on its own throw path, and so does the vendor's
     * facade underneath it. If this layer also held the booking at that point,
     * a failed submission would release the same coins two or three times over
     * - against a transaction the node may in fact have accepted.
     *
     * RED WHEN: `submitTx` forgets the booking AFTER `sponsor.submit` returns
     * instead of before it is called.
     */
    const s = sponsor({ submit: async () => { throw new Error('the socket closed'); } });
    const p = sponsoredProviders(customer, s.it);

    const finalised = await p.walletProvider.balanceTx({ the: 'transaction' } as any, new Date());
    await expect(p.midnightProvider.submitTx(finalised as any)).rejects.toThrow(/socket closed/);

    expect(await p.releaseUnspent(), 'this layer released a booking the sponsor already owns')
      .toBe(0);
  });

  it('a release that fails keeps its booking, and does not take the others with it', async () => {
    /*
     * **THE FIRST VERSION CLEARED THE WHOLE RECORD AND THEN RELEASED IN A
     * LOOP.** One refusal part way through dropped every remaining booking from
     * the record for ever - and the caller swallows the throw, so nothing
     * anywhere would have said so. The record is the only place a later attempt
     * can find what is still outstanding.
     *
     * **AND THE ANSWER COUNTS WHAT WENT, NOT WHAT WAS TRIED**, because a caller
     * asserting on it is asserting that coins were let go. A count of attempts
     * is exactly the kind of number that looks like evidence and is not.
     *
     * RED WHEN: `outstanding.clear()` is moved back above the loop, or the
     * answer becomes the number of bookings rather than the number released.
     */
    /*
     * **REFUSES ONCE AND THEN SUCCEEDS, WHICH IS WHAT MAKES THE PROPERTY
     * OBSERVABLE.** A booking that always fails looks identical whether it was
     * kept or dropped: the second attempt answers nought either way. Only a
     * release that can eventually work distinguishes *held for another try*
     * from *lost for ever*, and lost-for-ever was the defect.
     *
     * The shape reaches through both wrappers - `balanceOwnLegs` wraps, then
     * `addFeeAndFinalise` wraps again - so the fixture describes the real
     * object rather than a guess at it.
     */
    let refusals = 0;
    const s = sponsor({
      release: async (booking: any) => {
        if (booking?.finalised?.customerLegs?.first && refusals++ === 0) {
          throw new Error('the vendor refused this release');
        }
      },
    });
    const p = sponsoredProviders(customer, s.it);
    await p.walletProvider.balanceTx({ first: true } as any, new Date());
    await p.walletProvider.balanceTx({ second: true } as any, new Date());

    expect(await p.releaseUnspent(), 'a release that was refused was counted as done').toBe(1);
    expect(await p.releaseUnspent(),
      'the refused booking was dropped from the record, so nothing can ever release it again')
      .toBe(1);
    expect(await p.releaseUnspent()).toBe(0);
  });

  it('two balances abandoned together are both released', async () => {
    // RED WHEN: the record holds one booking rather than a set - which is what
    // a single slot would do, silently dropping the first of two.
    const s = sponsor();
    const p = sponsoredProviders(customer, s.it);
    await p.walletProvider.balanceTx({ one: true } as any, new Date());
    await p.walletProvider.balanceTx({ two: true } as any, new Date());

    expect(await p.releaseUnspent()).toBe(2);
    expect(s.released).toHaveLength(2);
  });
});

describe('the job runner lets go of what it did not spend', () => {
  const job: Job = {
    id: 'job_1', accountId: 'acc_1', kind: 'approve', state: 'proven', signerId: 'sgn_1',
    payload: {}, attempts: 1, createdAt: 'x', updatedAt: 'x',
  };

  const runnerOver = (over: Partial<JobRunnerDeps['providers']>) => {
    let released = 0;
    const deps: JobRunnerDeps = {
      providers: {
        proofProvider: { proveTx: async () => 'PROVEN' },
        walletProvider: { balanceTx: async () => 'FINALISED' },
        midnightProvider: { submitTx: async () => 'tx_1' },
        releaseUnspent: async () => { released += 1; return 0; },
        ...over,
      },
      compiled: {},
      plan: async () => ({
        contractAddress: '0xcontract', circuit: 'approve', args: [], privateStateId: 'ps_acc_1',
      }),
      status: async () => null as any,
      expectation: async () => ({ viewDigest: null, proposalId: null, duplicateRejectedOnChain: true }),
    };
    return { runner: new MidnightJobRunner(deps), releases: () => released };
  };

  it('asks on the way out when the submission throws', async () => {
    /*
     * RED WHEN: the `finally` around balance-and-submit is removed, which is
     * the state this method was in - it balanced, threw, and left the booking
     * standing with nothing anywhere that could let go of it.
     */
    const r = runnerOver({ midnightProvider: { submitTx: async () => { throw new Error('no'); } } });
    await expect(r.runner.submit(job, { plan: {}, provenTx: 'P' })).rejects.toThrow(/no/);
    expect(r.releases(), 'a submission that threw left its booking standing').toBe(1);
  });

  it('asks on the way out when the BALANCE throws, where there may still be a partial booking', async () => {
    // RED WHEN: the `try` starts after `balanceTx` rather than before it.
    const r = runnerOver({ walletProvider: { balanceTx: async () => { throw new Error('nope'); } } });
    await expect(r.runner.submit(job, { plan: {}, provenTx: 'P' })).rejects.toThrow(/nope/);
    expect(r.releases()).toBe(1);
  });

  it('asks on the way out even when everything worked, because asking is what is cheap', async () => {
    /*
     * The cleanup is unconditional and the bundle decides there is nothing to
     * do. Putting the condition here instead would put the knowledge of what is
     * outstanding in two places, and the copy that is wrong is the one that
     * leaks.
     *
     * RED WHEN: the `finally` becomes a `catch`.
     */
    const r = runnerOver({});
    await expect(r.runner.submit(job, { plan: {}, provenTx: 'P' })).resolves.toEqual({ txRef: 'tx_1' });
    expect(r.releases()).toBe(1);
  });

  it('a release that fails does not replace the failure that caused it', async () => {
    /*
     * RED WHEN: `releaseUnspent()` is awaited without `.catch(() => {})`. The
     * caller would then be handed a complaint about tidying up in place of the
     * error naming what actually went wrong, which sends whoever reads it to
     * the wrong place entirely.
     */
    const r = runnerOver({
      midnightProvider: { submitTx: async () => { throw new Error('the real problem'); } },
      releaseUnspent: async () => { throw new Error('the cleanup also failed'); },
    });
    await expect(r.runner.submit(job, { plan: {}, provenTx: 'P' }))
      .rejects.toThrow(/the real problem/);
  });
});
