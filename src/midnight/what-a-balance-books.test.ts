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
import { SponsoredCustomerWallet } from './wallet.js';
import { WalletFeeSponsor } from './sponsor.js';
import { MidnightJobRunner, type JobRunnerDeps } from './job-runner.js';
import type { FeeSponsor } from './ledger.js';
import type { CustomerWallet } from './providers.js';
import type { Job } from '../core/jobs.js';
import { CIRCUITS_THAT_READ_NO_WITNESS } from './governed-call.js';

/**
 * The company's side, recording what it was asked to let go of.
 *
 * **A FUNCTION RATHER THAN A CONSTANT, WHICH IT WAS NOT BEFORE.** The company's
 * bookings are now released against the company's own wallet, so a case has to
 * be able to see this one's releases separately from the fee payer's - a shared
 * object would pool them and the count would say nothing about which wallet let
 * go of what.
 */
const customerWallet = (over: Partial<CustomerWallet> = {}) => {
  const released: unknown[] = [];
  const it: CustomerWallet = {
    coinPublicKey: () => 'not-a-secret: a test literal',
    encryptionPublicKey: () => 'not-a-secret: a test literal',
    balanceOwnLegs: async (tx: unknown) => ({ customerLegs: tx }),
    release: async (booking) => { released.push(booking); },
    ...over,
  };
  return { it, released };
};

/** Records what it was asked to do, so a case can assert on the argument. */
const sponsor = (over: Partial<FeeSponsor> = {}) => {
  const released: unknown[] = [];
  const submitted: unknown[] = [];
  const it: FeeSponsor = {
    addFeeAndFinalise: async (tx) => ({ finalised: tx }),
    submit: async (tx) => { submitted.push(tx); return { ref: 'tx_1', at: '' }; },
    release: async (booking) => { released.push(booking); },
    payingFor: () => {},
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
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);

    const finalised = await p.walletProvider.balanceTx({ the: 'transaction' } as any, new Date());
    /*
     * and now the operation is abandoned, which is the case with no owner.
     * **TWO, BECAUSE THERE ARE TWO WALLETS**: the company booked its own legs
     * and the fee payer booked the fee, in two separate local states, and each
     * has to be let go by the wallet that made it.
     */
    expect(await p.releaseUnspent()).toBe(2);

    expect(s.released).toHaveLength(1);
    expect(s.released[0], 'the release was handed something other than the booking')
      .toBe(finalised);
  });

  it('releases the COMPANY\'s booking too, against the company\'s own wallet', async () => {
    /*
     * RED WHEN: `ownBookings.add(ownLegsBalanced)` is deleted from `balanceTx`,
     * or the release loop over it is removed from `releaseUnspent`. Either way
     * the fee payer's coins come back and the company's stay booked - which is
     * the state this whole file existed to describe on one side only.
     *
     * **AND IT ASSERTS THE OBJECT, NOT THE COUNT.** A release handed the merged
     * transaction instead of what the company's own balance produced is a
     * release the vendor looks up and finds nothing for: it frees nothing, and
     * a count cannot tell that from a release that worked.
     */
    const s = sponsor();
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);

    await p.walletProvider.balanceTx({ the: 'transaction' } as any, new Date());
    await p.releaseUnspent();

    expect(c.released, 'the company\'s own booking was never released').toHaveLength(1);
    expect(c.released[0],
      'the company\'s wallet was handed something other than what its own balance produced')
      .toEqual({ customerLegs: { the: 'transaction' } });
  });

  it('releases the company\'s booking when the FEE PAYER\'s phase throws', async () => {
    /*
     * **THE WINDOW THIS CASE IS ABOUT IS BETWEEN THE TWO BALANCES, AND NOTHING
     * COVERED IT.** The company books and signs; the fee payer is then handed
     * the result and can refuse, expire, or fail to prove. The company's own
     * method has already returned by then, so its guard cannot fire, and this
     * layer had no record of the booking at all.
     *
     * RED WHEN: the `try` around `sponsor.addFeeAndFinalise` in `balanceTx` is
     * removed, so the throw leaves the company's coins booked for ever.
     */
    const s = sponsor({
      addFeeAndFinalise: async () => { throw new Error('the fee leg would not prove'); },
    });
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);

    await expect(p.walletProvider.balanceTx({ the: 'transaction' } as any, new Date()))
      .rejects.toThrow(/would not prove/);

    expect(c.released,
      'the fee payer refused and the company\'s coins were left booked').toHaveLength(1);
    expect(await p.releaseUnspent(),
      'the booking was released AND left in the record, so a later sweep frees it twice')
      .toBe(0);
  });

  it('and a company release that throws does not replace the failure that caused it', async () => {
    /*
     * RED WHEN: the `try` around `customer.release(...)` inside `balanceTx`'s
     * catch is removed. The caller is then handed a complaint about tidying up
     * in place of the error naming what actually went wrong, which sends
     * whoever reads it to the wrong layer entirely.
     */
    const s = sponsor({
      addFeeAndFinalise: async () => { throw new Error('the fee leg would not prove'); },
    });
    const c = customerWallet({
      release: async () => { throw new Error('the cleanup also failed'); },
    });
    const p = sponsoredProviders(c.it, s.it);

    await expect(p.walletProvider.balanceTx({ the: 'transaction' } as any, new Date()))
      .rejects.toThrow(/would not prove/);
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
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);

    const finalised = await p.walletProvider.balanceTx({ the: 'transaction' } as any, new Date());
    await p.midnightProvider.submitTx(finalised as any);

    expect(await p.releaseUnspent()).toBe(0);
    expect(s.released, 'a booking that was submitted was released as well').toEqual([]);
    /*
     * **AND THE COMPANY'S SIDE OF THE SAME CONTROL, WHICH IS THE MORE
     * DANGEROUS OF THE TWO.** The merged transaction carries the company's
     * legs, so a submission spends them. Releasing them afterwards marks spent
     * coins available on a device we do not operate, and the next transaction
     * from it selects coins that no longer exist.
     *
     * RED WHEN: `ownBookings.clear()` is removed from `submitTx`.
     */
    expect(c.released, 'the company\'s coins were released after they had been spent')
      .toEqual([]);
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
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);

    const finalised = await p.walletProvider.balanceTx({ the: 'transaction' } as any, new Date());
    await expect(p.midnightProvider.submitTx(finalised as any)).rejects.toThrow(/socket closed/);

    expect(await p.releaseUnspent(), 'this layer released a booking the sponsor already owns')
      .toBe(0);
    /*
     * **THE COMPANY'S BOOKING IS FORGOTTEN HERE AND NOT RELEASED, WHICH IS THE
     * OPPOSITE OF WHAT THE FEE PAYER DOES ON THIS SAME PATH. IT IS A DECISION
     * AND NOT AN OVERSIGHT, AND IT IS RECORDED AS ONE.**
     *
     * A throw out of a submission is not proof the transaction did not land.
     * Releasing after a landing does not merely fail to help: the vendor's
     * release clears the pending entry chain sync would have used to repair the
     * local state, and files a rejection that did not happen. The fee payer's
     * wallet is one we operate, so that repair is a thing we do; the company's
     * is on a device we do not, so the self-healing path is worth more there
     * than the booking is.
     *
     * **WHAT IT COSTS: a company that meets a dropped socket has some of its
     * own coins marked in flight until its wallet is resynced.** Nothing here
     * can find them again.
     *
     * **WHAT THIS CASE CAN AND CANNOT SHOW, BECAUSE A FIRST DRAFT OF IT
     * ASSERTED THE WRONG HALF AND WENT RED.** The fee payer here is a
     * hand-written double whose `submit` simply throws, so nothing releases
     * anything on its side and the pairing cannot be measured from this
     * fixture. What is measured is that THIS LAYER releases neither party's
     * booking once the handover has happened. The fee payer's own release on a
     * thrown submission belongs to its own file.
     *
     * RED WHEN: `ownBookings.clear()` is replaced by a release.
     */
    expect(c.released,
      'the company\'s coins were released against a transaction that may have landed')
      .toEqual([]);
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
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);
    await p.walletProvider.balanceTx({ first: true } as any, new Date());
    await p.walletProvider.balanceTx({ second: true } as any, new Date());

    /*
     * Four bookings now, in two wallets: two the company made and two the fee
     * payer made. The refusal above is aimed at ONE of the fee payer's, so the
     * first sweep frees three of the four.
     */
    expect(await p.releaseUnspent(), 'a release that was refused was counted as done').toBe(3);
    expect(await p.releaseUnspent(),
      'the refused booking was dropped from the record, so nothing can ever release it again')
      .toBe(1);
    expect(await p.releaseUnspent()).toBe(0);
  });

  it('two balances abandoned together are both released', async () => {
    // RED WHEN: the record holds one booking rather than a set - which is what
    // a single slot would do, silently dropping the first of two.
    const s = sponsor();
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);
    await p.walletProvider.balanceTx({ one: true } as any, new Date());
    await p.walletProvider.balanceTx({ two: true } as any, new Date());

    // Two operations, two wallets, four bookings.
    expect(await p.releaseUnspent()).toBe(4);
    expect(s.released).toHaveLength(2);
    expect(c.released, 'the company kept one booking per operation, or none').toHaveLength(2);
  });
});

/**
 * **EVERY CASE ABOVE DRIVES A HAND-WRITTEN FEE PAYER, AND THAT IS THE SEAM USED
 * AS DESIGNED. THESE TWO DRIVE THE CLASSES THIS PRODUCT ACTUALLY SHIPS, AND
 * THAT IS A DIFFERENT QUESTION.**
 *
 * A property can be pinned perfectly against a double and be unreachable in the
 * composition that runs: the double's release could fail, and both shipped ones
 * swallowed - so the count of releases was a count of ATTEMPTS, and the case
 * that pinned *a release that fails keeps its booking* could not fire through
 * anything real. **An instrument that cannot report a failure is the instrument
 * every open question in this area is answered with.**
 */
describe('and the same, through the classes that actually ship', () => {
  const facade = (over: Record<string, unknown> = {}) => ({
    balanceUnboundTransaction: async (tx: unknown) => ({ booked: tx }),
    balanceFinalizedTransaction: async (tx: unknown) => ({ fee: tx }),
    signRecipe: async (r: unknown) => r,
    /* A balanced transaction declares what it spends from DUST; this one spends nothing. */
    finalizeRecipe: async (r: object) => ({ ...r, intents: new Map() }),
    submitTransaction: async () => 'tx_1',
    revert: async () => {},
    estimateFee: async () => 1n,
    paidFee: async () => 1n,
    shieldedSecretKeys: 'k', dustSecretKey: 'k',
    balances: async () => ({ dust: 0n, night: 0n }),
    ...over,
  });

  const shipped = (over: Record<string, unknown> = {}) => {
    const f = facade(over);
    return sponsoredProviders(
      new SponsoredCustomerWallet(f as never, { shieldedSecretKeys: 'k', dustSecretKey: 'k' },
        () => 'sig', { coinPublicKey: 'not-a-secret', encryptionPublicKey: 'not-a-secret' }),
      new WalletFeeSponsor(f as never, { perTransaction: 1n }),
    );
  };

  it('a refused release is NOT counted and the booking is kept', async () => {
    /*
     * **MEASURED THROUGH THE REAL OBJECTS.** With the release swallowing one
     * layer down, this answered TWO while nothing had been let go, and emptied
     * the record so a later attempt could never find either booking again.
     *
     * RED WHEN: either `release` goes back to swallowing the vendor's refusal
     * inside itself, which is where the swallow was. Nothing above this
     * `describe` notices - every case up there supplies a release that can
     * fail, and no shipped one could.
     */
    let refuse = true;
    const p = shipped({ revert: async () => { if (refuse) throw new Error('the vendor refused'); } });
    await p.walletProvider.balanceTx({ the: 'transaction' } as never, new Date());

    expect(await p.releaseUnspent(), 'coins nobody let go of were counted as released')
      .toBe(0);
    refuse = false;
    expect(await p.releaseUnspent(),
      'the bookings were dropped from the record, so nothing can ever release them')
      .toBe(2);
  });

  it('and a release that works is counted once, by each wallet', async () => {
    // The positive control: without it the case above passes on a composition
    // in which nothing is ever booked at all.
    const p = shipped();
    await p.walletProvider.balanceTx({ the: 'transaction' } as never, new Date());
    expect(await p.releaseUnspent()).toBe(2);
    expect(await p.releaseUnspent()).toBe(0);
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
      circuitsThatReadNoWitness: CIRCUITS_THAT_READ_NO_WITNESS,
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
