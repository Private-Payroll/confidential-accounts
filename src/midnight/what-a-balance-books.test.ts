/**
 * **BALANCING BOOKS COINS. ONLY SUBMITTING SPENDS THEM. THESE CASES ARE ABOUT
 * THE GAP BETWEEN THE TWO.**
 *
 * midnight-js calls the balance and the submission as two separate callbacks at
 * two separate times, handing each a transaction as bytes. Anything that goes
 * wrong in between - proving, staging, an expiry, a caller giving up - ends the
 * operation with coins still marked in flight, and nothing in the wallets lets go
 * of a transaction that was never submitted. So the two callbacks share a record
 * of what is booked, and the operation's owner releases what is left.
 *
 * The consequence of getting it wrong is quiet, which is what makes it worth a
 * file. Each failure takes a little of the fee budget out of circulation; the
 * next attempt balances onto fresh coins because the booked ones are filtered
 * out as pending; and the balance that gets reported looks healthy right up
 * until it does not.
 *
 * ── WHAT THESE CASES ESTABLISH, AND THE LINE THEY DO NOT CROSS ───────────
 *
 * **They are measurements about the LINK between the two callbacks and about
 * nothing else.** `FeeSponsor` and `CustomerWallet` are interfaces, and the two
 * here are hand-written ones - that seam used as designed, not a stand-in. The
 * transactions are real ledger 9 transactions with nothing in them, so what
 * crosses the callbacks is the bytes midnight-js really hands over.
 *
 * **They do not establish anything about a wallet, a coin, or a chain, and they
 * cannot.** What is written here is the bookkeeping.
 */
import { describe, it, expect } from 'vitest';
import { LedgerTransaction } from '@midnight-ntwrk/midnight-js-types';
import { CostModel, Intent, Transaction } from '@midnightntwrk/ledger-v9';
import { sponsoredProviders } from './providers.js';
import { SponsoredCustomerWallet } from './wallet.js';
import { WalletFeeSponsor } from './sponsor.js';
import { MidnightJobRunner, type JobRunnerDeps } from './job-runner.js';
import type { FeeSponsor } from './ledger.js';
import type { CustomerWallet } from './providers.js';
import type { Job } from '../core/jobs.js';
import { CIRCUITS_THAT_READ_NO_WITNESS } from './governed-call.js';

/** An empty transaction needs no proof, so this prover is never asked for one. */
const NO_PROOF_NEEDED = {
  check: async () => { throw new Error('an empty transaction asked for a proof'); },
  prove: async () => { throw new Error('an empty transaction asked for a proof'); },
  lookupKey: async () => undefined,
};

/** A proven, unbound ledger 9 transaction, as midnight-js hands it to the balance. Each `n` gives other bytes. */
const anUnbound = async (n: number) => {
  const unproven = Transaction.fromParts('preprod', undefined, undefined, Intent.new(new Date(Date.UTC(2030, 0, 1, 0, 0, n))));
  return LedgerTransaction.seal('v9', 'Unbound', await unproven.prove(NO_PROOF_NEEDED, CostModel.initialCostModel()));
};

type Decoded = Awaited<ReturnType<Awaited<ReturnType<typeof anUnbound>>['deserialize']>>;

/** The company's side, recording what it was handed and what it was asked to let go of. */
const customerWallet = (over: Partial<CustomerWallet> = {}) => {
  const released: unknown[] = [];
  const handed: unknown[] = [];
  const it: CustomerWallet = {
    coinPublicKey: () => 'not-a-secret: a test literal',
    encryptionPublicKey: () => 'not-a-secret: a test literal',
    balanceOwnLegs: async (tx) => { handed.push(tx); return { customerLegs: tx as unknown as Decoded, serialize: () => tx.serialize() }; },
    release: async (booking) => { released.push(booking); },
    ...over,
  };
  return { it, released, handed };
};

/** The fee payer's side: binds what the company balanced, and records what it finalised, submitted and released. */
const sponsor = (over: Partial<FeeSponsor> = {}) => {
  const released: unknown[] = [];
  const submitted: unknown[] = [];
  const finalised: unknown[] = [];
  const it: FeeSponsor = {
    addFeeAndFinalise: async (own) => {
      const done = (own as { customerLegs: Decoded }).customerLegs.bind();
      finalised.push(done);
      return done;
    },
    submit: async (tx) => { submitted.push(tx); return { ref: 'tx_1', at: '' }; },
    release: async (booking) => { released.push(booking); },
    payingFor: () => {},
    capacity: async () => ({ dust: 0n, night: 0n }),
    ...over,
  };
  return { it, released, submitted, finalised };
};

describe('what crosses the balance and the submission', () => {
  it('both providers serve ledger 9 only, and say so before anything is proved', () => {
    const p = sponsoredProviders(customerWallet().it, sponsor().it);
    /* RED WHEN: a provider claims an era it cannot balance or submit, and an operation is refused only after its proof was paid for. */
    expect([p.walletProvider.supportedEras, p.midnightProvider.supportedEras]).toEqual([['v9'], ['v9']]);
  });

  it('the company is handed the ledger 9 transaction, not the bytes it travelled as', async () => {
    const c = customerWallet();
    await sponsoredProviders(c.it, sponsor().it).walletProvider.balanceTx(await anUnbound(1), new Date());
    /* RED WHEN: the company's wallet is handed midnight-js's handle, which no wallet can balance. */
    expect(c.handed[0]).toBeInstanceOf(Transaction);
  });

  it('the fee payer submits the very transaction it finalised, not a copy read back from bytes', async () => {
    const s = sponsor();
    const p = sponsoredProviders(customerWallet().it, s.it);
    await p.midnightProvider.submitTx(await p.walletProvider.balanceTx(await anUnbound(1), new Date()));
    /* RED WHEN: the submission hands the fee payer a fresh copy, and its record of what it booked never matches what it sent. */
    expect(s.submitted[0]).toBe(s.finalised[0]);
  });

  it('a fee payer answer that is not a transaction is refused, and the fee payer\'s booking is released', async () => {
    const s = sponsor({ addFeeAndFinalise: async () => ({ not: 'a transaction' }) });
    const p = sponsoredProviders(customerWallet().it, s.it);
    /* RED WHEN: an answer that cannot be submitted is handed on, or the fee it booked is left booked for ever. */
    await expect(p.walletProvider.balanceTx(await anUnbound(1), new Date())).rejects.toThrow(/the fee payer answered with something that is not a transaction/);
    expect(s.released).toEqual([{ not: 'a transaction' }]);
    /* The company's own booking is still in the record, for the owner's release. */
    expect(await p.releaseUnspent()).toBe(1);
  });
});

describe('a balance that is never submitted is released', () => {
  it('releases exactly what the balance produced, not something like it', async () => {
    /*
     * RED WHEN: `balanceTx` records `tx` - what went IN to the balance - rather
     * than `finalised`, what came out. The vendor's release is given a booking
     * to look up, so handing it the wrong object is a release that quietly
     * frees nothing.
     */
    const s = sponsor();
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);

    await p.walletProvider.balanceTx(await anUnbound(1), new Date());
    /*
     * and now the operation is abandoned, which is the case with no owner.
     * **TWO, BECAUSE THERE ARE TWO WALLETS**: the company booked its own legs
     * and the fee payer booked the fee, in two separate local states, and each
     * has to be let go by the wallet that made it.
     */
    expect(await p.releaseUnspent()).toBe(2);

    expect(s.released).toHaveLength(1);
    expect(s.released[0], 'the release was handed something other than the booking')
      .toBe(s.finalised[0]);
  });

  it('releases the COMPANY\'s booking too, against the company\'s own wallet', async () => {
    /*
     * RED WHEN: `ownBookings.add(ownLegsBalanced)` is deleted from `balanceTx`,
     * or the release loop over it is removed from `releaseUnspent`. Either way
     * the fee payer's coins come back and the company's stay booked.
     *
     * **AND IT ASSERTS THE OBJECT, NOT THE COUNT.** A release handed the merged
     * transaction instead of what the company's own balance produced is a
     * release the vendor looks up and finds nothing for.
     */
    const s = sponsor();
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);

    await p.walletProvider.balanceTx(await anUnbound(1), new Date());
    await p.releaseUnspent();

    expect(c.released, 'the company\'s own booking was never released').toHaveLength(1);
    expect(c.released[0],
      'the company\'s wallet was handed something other than what its own balance produced')
      .toEqual(expect.objectContaining({ customerLegs: c.handed[0] }));
  });

  it('releases the company\'s booking when the FEE PAYER\'s phase throws', async () => {
    /*
     * The company books and signs; the fee payer is then handed the result and
     * can refuse, expire, or fail to prove. The company's own method has
     * already returned by then, so its guard cannot fire.
     *
     * RED WHEN: the `try` around `sponsor.addFeeAndFinalise` in `balanceTx` is
     * removed, so the throw leaves the company's coins booked for ever.
     */
    const s = sponsor({
      addFeeAndFinalise: async () => { throw new Error('the fee leg would not prove'); },
    });
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);

    await expect(p.walletProvider.balanceTx(await anUnbound(1), new Date()))
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
     * in place of the error naming what actually went wrong.
     */
    const s = sponsor({
      addFeeAndFinalise: async () => { throw new Error('the fee leg would not prove'); },
    });
    const c = customerWallet({
      release: async () => { throw new Error('the cleanup also failed'); },
    });
    const p = sponsoredProviders(c.it, s.it);

    await expect(p.walletProvider.balanceTx(await anUnbound(1), new Date()))
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
     * `outstanding.delete(key)` line - so the cleanup below finds it still there.
     */
    const s = sponsor();
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);

    await p.midnightProvider.submitTx(await p.walletProvider.balanceTx(await anUnbound(1), new Date()));

    expect(await p.releaseUnspent()).toBe(0);
    expect(s.released, 'a booking that was submitted was released as well').toEqual([]);
    /*
     * **AND THE COMPANY'S SIDE OF THE SAME CONTROL.** The submitted transaction
     * carries the company's legs, so a submission spends them.
     *
     * RED WHEN: `ownBookings.clear()` is removed from `submitTx`.
     */
    expect(c.released, 'the company\'s coins were released after they had been spent')
      .toEqual([]);
  });

  it('and nothing double-releases when the submission itself throws', async () => {
    /*
     * **THE ORDER OF THE HANDOVER IS WHAT THIS ASSERTS.** The fee payer's own
     * `submit` releases on its own throw path. If this layer also held the
     * booking at that point, a failed submission would release the same coins
     * twice - against a transaction the node may in fact have accepted.
     *
     * RED WHEN: `submitTx` forgets the booking AFTER `sponsor.submit` returns
     * instead of before it is called.
     */
    const s = sponsor({ submit: async () => { throw new Error('the socket closed'); } });
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);

    const finalised = await p.walletProvider.balanceTx(await anUnbound(1), new Date());
    await expect(p.midnightProvider.submitTx(finalised)).rejects.toThrow(/socket closed/);

    expect(await p.releaseUnspent(), 'this layer released a booking the sponsor already owns')
      .toBe(0);
    /*
     * **THE COMPANY'S BOOKING IS FORGOTTEN HERE AND NOT RELEASED.** A throw out
     * of a submission is not proof the transaction did not land, and releasing
     * after a landing clears the pending entry the company's wallet would have
     * repaired its state from. What it costs: a company that meets a dropped
     * socket has some of its own coins marked in flight until its wallet is
     * resynced. The fee payer's own release on a thrown submission belongs to
     * its own file.
     *
     * RED WHEN: `ownBookings.clear()` is replaced by a release.
     */
    expect(c.released,
      'the company\'s coins were released against a transaction that may have landed')
      .toEqual([]);
  });

  it('a release that fails keeps its booking, and does not take the others with it', async () => {
    /*
     * One refusal part way through must not drop the remaining bookings from
     * the record: the caller swallows the throw, so nothing else would say so,
     * and the record is the only place a later attempt can find them. The
     * answer counts what went, not what was tried.
     *
     * RED WHEN: the record is cleared above the loop, or the answer becomes the
     * number of bookings rather than the number released.
     *
     * The first booking refuses ONCE and then succeeds: only a release that can
     * eventually work tells *held for another try* from *lost for ever*.
     */
    let refusals = 0;
    const s = sponsor({
      release: async (booking: unknown) => {
        if (booking === s.finalised[0] && refusals++ === 0) throw new Error('the vendor refused this release');
      },
    });
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);
    await p.walletProvider.balanceTx(await anUnbound(1), new Date());
    await p.walletProvider.balanceTx(await anUnbound(2), new Date());

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
    // RED WHEN: the record holds one booking rather than one per transaction - which is
    // what a single slot would do, silently dropping the first of two.
    const s = sponsor();
    const c = customerWallet();
    const p = sponsoredProviders(c.it, s.it);
    await p.walletProvider.balanceTx(await anUnbound(1), new Date());
    await p.walletProvider.balanceTx(await anUnbound(2), new Date());

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
 * composition that runs: if a shipped release swallowed the vendor's refusal,
 * the count of releases would be a count of ATTEMPTS, and *a release that fails
 * keeps its booking* could not fire through anything real.
 */
describe('and the same, through the classes that actually ship', () => {
  const facade = (finalised: unknown, over: Record<string, unknown> = {}) => ({
    adoptTransaction: (bytes: Uint8Array) => ({ adopted: bytes }),
    handleOf: (tx: unknown) => tx,
    ledgerTransactionOf: (tx: unknown) => tx,
    balanceUnboundTransaction: async (tx: unknown) => ({ booked: tx }),
    balanceFinalizedTransaction: async (tx: unknown) => ({ fee: tx }),
    signRecipe: async (r: unknown) => r,
    /* An empty transaction, bound: it spends no DUST. */
    finalizeRecipe: async () => finalised,
    submitTransaction: async () => 'tx_1',
    revert: async () => {},
    estimateFee: async () => 1n,
    paidFee: async () => 1n,
    balances: async () => ({ dust: 0n, night: 0n }),
    ...over,
  });

  const shipped = async (over: Record<string, unknown> = {}) => {
    const unbound = await anUnbound(1);
    const f = facade(unbound.deserialize({ v9: Transaction }).bind(), over);
    const p = sponsoredProviders(
      new SponsoredCustomerWallet(f as never,
        async () => 'sig' as never, { coinPublicKey: 'not-a-secret', encryptionPublicKey: 'not-a-secret' }),
      new WalletFeeSponsor(f as never, { perTransaction: 1n }),
    );
    return { p, unbound };
  };

  it('a refused release is NOT counted and the booking is kept', async () => {
    /*
     * RED WHEN: either shipped `release` swallows the vendor's refusal inside
     * itself. Nothing above this `describe` notices - every case up there
     * supplies a release that can fail.
     */
    let refuse = true;
    const { p, unbound } = await shipped({ revert: async () => { if (refuse) throw new Error('the vendor refused'); } });
    await p.walletProvider.balanceTx(unbound, new Date());

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
    const { p, unbound } = await shipped();
    await p.walletProvider.balanceTx(unbound, new Date());
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
