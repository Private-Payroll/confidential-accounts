/**
 * **THE THREE RULES A DURABLE QUEUE NEEDS BEFORE IT IS GIVEN REAL WORK.**
 *
 * The queue has been in this repository for weeks with nothing plugged into it,
 * and the three holes below were all invisible for that reason: a hazard nobody
 * can reach is a hazard nobody sees. Each is written here as the consequence
 * rather than as a method check, because the consequence is what decides
 * whether the rule is worth the code.
 *
 *   the lease        two tabs both take the first pending job, both work it,
 *                    and the step after proving rebuilds the transaction onto
 *                    a different coin set - so the two are unrelated payments
 *                    to the chain and both apply. Nobody retried anything.
 *   the attempt cap  `attempts` was written on every proof and read nowhere,
 *                    so a job that cannot succeed re-proves once per reopened
 *                    tab, for ever, with a page that never finishes as the
 *                    only signal.
 *   a thrown submit  the state machine recorded `failed`, which is terminal,
 *                    so the one mechanism built to ask the chain whether
 *                    something landed was never consulted on the one path
 *                    that needs it.
 *
 * ── WHAT THESE CASES DO AND DO NOT ESTABLISH ─────────────────────────────
 *
 * `JobRunner` is an interface this queue was deliberately written against, so
 * driving it with a hand-written runner is that seam being used as designed.
 * **These cases are therefore real measurements about the queue, and about
 * nothing else.** They say nothing about what a Midnight transaction does,
 * because no deployment in this product has a wallet or a fee payer, and a case
 * that appeared to say so would be a case reading its own double back.
 */
import { describe, it, expect } from 'vitest';
import {
  JobQueue, MemoryJobStore, NothingWasSent, isTerminal, mayClaim, saysNothingWasSent,
  type JobRunner,
} from './jobs.js';

let seq = 0;
const clock = () => new Date(1_700_000_000_000 + seq++ * 1000);

const opts = (store: MemoryJobStore, over: Record<string, unknown> = {}) => ({
  store,
  now: clock,
  newId: () => `job_${seq++}`,
  ...over,
});

const runner = (over: Partial<JobRunner> = {}): JobRunner => ({
  prove: async () => ({ proof: 'PROOF' }),
  submit: async () => ({ txRef: 'tx_1' }),
  ...over,
});

const enqueue = (q: JobQueue) =>
  q.enqueue({ accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1' });

const held = (store: MemoryJobStore, id: string) =>
  store.list().then((all) => all.find((j) => j.id === id)!);

describe('the lease: two tabs cannot work one job', () => {
  it('a second worker is refused a job the first is holding', async () => {
    /*
     * RED WHEN: `mayClaim` answers `true` for a lease another owner holds -
     * which is the earlier state, where there was no lease at all and every
     * worker's answer to *may I work this* was yes.
     */
    const store = new MemoryJobStore();
    const first = new JobQueue(runner(), opts(store, { owner: 'tab-one' }));
    const job = await enqueue(first);

    expect(await store.claim(job.id, { owner: 'tab-one', until: '2100-01-01T00:00:00.000Z' }, new Date()))
      .not.toBeNull();

    expect(
      await store.claim(job.id, { owner: 'tab-two', until: '2100-01-01T00:00:00.000Z' }, new Date()),
      'a second tab was handed a job the first tab is already working. Both will prove it, ' +
        'both will rebuild the transaction onto different coins, and the chain will apply both',
    ).toBeNull();
  });

  it('a worker may take a lease it already holds, or it could not continue its own work', async () => {
    // RED WHEN: `mayClaim` drops its `held.owner === owner` branch.
    const store = new MemoryJobStore();
    const q = new JobQueue(runner(), opts(store, { owner: 'tab-one' }));
    const job = await enqueue(q);
    const lease = { owner: 'tab-one', until: '2100-01-01T00:00:00.000Z' };
    expect(await store.claim(job.id, lease, new Date())).not.toBeNull();
    expect(await store.claim(job.id, lease, new Date())).not.toBeNull();
  });

  it('a lapsed lease is takeable, so a tab that died does not hold a job for ever', async () => {
    // RED WHEN: `mayClaim` returns false whenever a lease is present.
    const store = new MemoryJobStore();
    const q = new JobQueue(runner(), opts(store, { owner: 'tab-one' }));
    const job = await enqueue(q);
    await store.claim(job.id, { owner: 'tab-one', until: '2020-01-01T00:00:00.000Z' }, new Date(0));

    expect(
      await store.claim(job.id, { owner: 'tab-two', until: '2100-01-01T00:00:00.000Z' },
        new Date('2020-06-01T00:00:00.000Z')),
    ).not.toBeNull();
  });

  it('a lease whose expiry cannot be read is treated as LIVE, not as expired', async () => {
    /*
     * RED WHEN: `mayClaim`'s `Number.isNaN` branch returns `true`.
     *
     * The two errors are not equal. A record nobody can parse is not evidence
     * that the worker who wrote it has gone; reading it as gone hands the job
     * to a second worker on the strength of a damaged field.
     */
    expect(mayClaim({ owner: 'tab-one', until: 'not a date' }, 'tab-two', new Date())).toBe(false);
  });

  it('the lease is renewed across a transition, so it cannot lapse under the worker holding it', async () => {
    /*
     * RED WHEN: `save` stops renewing - `else if (job.lease?.owner === this.owner)`
     * removed. The transitions either side of a proof are minutes apart, so a
     * lease written once at claim time is a lease that expires mid-proof.
     */
    const store = new MemoryJobStore();
    const q = new JobQueue(
      runner({ prove: async () => ({ proof: 'P' }), submit: async () => { throw new Error('stop here'); } }),
      opts(store, { owner: 'tab-one', leaseMs: 60_000 }),
    );
    const job = await enqueue(q);
    const at = await store.claim(job.id, { owner: 'tab-one', until: new Date(clock().getTime() + 60_000).toISOString() }, clock());
    const first = at!.lease!.until;

    await q.step(at!);

    const after = (await held(store, job.id)).lease!.until;
    expect(Date.parse(after), 'the lease was not renewed as the job moved, so a long step outlives it')
      .toBeGreaterThan(Date.parse(first));
  });

  it('a finished job holds no lease, so nothing reads it as work in progress', async () => {
    // RED WHEN: `save` stops deleting the lease on a terminal state.
    const store = new MemoryJobStore();
    const q = new JobQueue(runner(), opts(store, { owner: 'tab-one' }));
    const job = await enqueue(q);
    await q.drain();

    const done = await held(store, job.id);
    expect(done.state).toBe('settled');
    expect(done.lease, 'a settled job still names an owner, which reads as in flight').toBeUndefined();
  });

  it('a drain skips what another tab holds and works what it can', async () => {
    /*
     * RED WHEN: `drain` returns instead of `continue` when a claim is refused -
     * one held job would then stall every job behind it.
     */
    const store = new MemoryJobStore();
    const first = new JobQueue(runner(), opts(store, { owner: 'tab-one' }));
    const a = await enqueue(first);
    const b = await enqueue(first);

    // Another tab takes the older one and keeps it.
    await store.claim(a.id, { owner: 'tab-two', until: '2100-01-01T00:00:00.000Z' }, new Date());

    await first.drain();

    expect((await held(store, a.id)).state, 'a job another tab holds was worked anyway').toBe('queued');
    expect((await held(store, b.id)).state, 'a job nobody held was left unworked behind one that was')
      .toBe('settled');
  });
});

describe('the lease is a LOCK, which is a different claim from having one', () => {
  /**
   * **EVERY CASE ABOVE ASKS `store.claim` A QUESTION. NONE OF THEM DRIVES TWO
   * QUEUES TO COMPLETION, AND THAT IS WHERE THE DEFECT WAS.**
   *
   * Taking the lease was atomic from the first version. Every save afterwards
   * was an unconditional write of the whole record - so a worker suspended past
   * its own lease, which is the ordinary case a slept laptop produces, woke up,
   * wrote its own name back over the worker that had legitimately taken the
   * job, re-claimed it, and submitted. **Both workers submitted, and the second
   * write erased any record that the first transaction had ever existed.**
   *
   * The cases here drive the whole thing rather than asking about a part of it,
   * because a lock is a property of the sequence and not of any one call.
   */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('two workers over one store submit ONCE, even when the first one sleeps past its lease', async () => {
    /*
     * RED WHEN: `save` writes with `store.put` instead of `store.writeHeld`, or
     * `mayWrite` stops consulting the stored lease. That is the state this
     * queue was in, and every other case in this file stayed green through it.
     */
    const store = new MemoryJobStore();
    const submitted: string[] = [];

    let releaseA!: () => void;
    const aIsStuck = new Promise<void>((r) => { releaseA = r; });

    let clock = 1_000_000;
    const at = () => new Date(clock);

    const tabA = new JobQueue(
      runner({
        prove: async () => { await aIsStuck; return { proof: 'A' }; },
        submit: async () => { submitted.push('A'); return { txRef: 'tx_A' }; },
      }),
      { store, now: at, newId: () => 'job_shared', owner: 'tab-A', leaseMs: 60_000 },
    );
    const tabB = new JobQueue(
      runner({
        prove: async () => ({ proof: 'B' }),
        submit: async () => { submitted.push('B'); return { txRef: 'tx_B' }; },
      }),
      { store, now: at, newId: () => 'job_shared', owner: 'tab-B', leaseMs: 60_000 },
    );

    await tabA.enqueue({ accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1' });
    /*
     * Captured rather than ignored. `drain` now REJECTS when a worker finds it
     * has lost the job, which is the whole point of this case - so a `void`
     * here would be an unhandled rejection standing in for the measurement.
     */
    let tabAEnded: unknown;
    const tabADrain = tabA.drain().catch((e) => { tabAEnded = e; });
    await settle();

    // The laptop sleeps. A's lease lapses while A is still inside its proof.
    clock += 10 * 60_000;

    // B finds a lapsed lease, takes it correctly, and finishes the job.
    await tabB.drain();
    expect(submitted, 'the worker that legitimately took the job did not finish it').toEqual(['B']);

    // A wakes up holding a lease that expired ten minutes ago.
    releaseA();
    await tabADrain;

    expect(submitted, 'a worker that had lost its lease submitted a second transaction')
      .toEqual(['B']);
    expect(String((tabAEnded as any)?.message),
      'the worker that lost the job carried on silently instead of being told')
      .toMatch(/being worked somewhere else/i);
    const finished = await held(store, 'job_shared');
    expect(finished.state).toBe('settled');
    expect(finished.txRef, 'the second write erased the record of the transaction that was sent')
      .toBe('tx_B');
  });

  it('a live worker keeps its lease through a proof far longer than the lease', async () => {
    /*
     * **THIS IS WHAT MAKES A SHORT LEASE POSSIBLE, AND A SHORT LEASE IS WHAT A
     * REOPENED TAB WAITS.** Sized to outlast the slowest proof on its own, a
     * lease came out at fifteen minutes - and that was then exactly how long a
     * reopened page sat unable to work its own job, with the screen saying
     * *proving on this device* the whole time.
     *
     * RED WHEN: `drain` stops renewing, or `every` is dropped from the options
     * the worker passes. The proof below outlives the lease four times over.
     */
    const store = new MemoryJobStore();
    let clock = 1_000_000;
    let releaseProof!: () => void;
    const proving = new Promise<void>((r) => { releaseProof = r; });

    // A hand-driven timer, so the renewal is exercised rather than waited for.
    const ticks: Array<() => void> = [];
    const q = new JobQueue(
      runner({ prove: async () => { await proving; return { proof: 'P' }; } }),
      {
        store, now: () => new Date(clock), newId: () => 'job_long', owner: 'tab-A',
        leaseMs: 45_000,
        every: (fn) => { ticks.push(fn); return () => { ticks.length = 0; }; },
      },
    );

    await q.enqueue({ accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1' });
    const drained = q.drain().catch((e) => e);
    await settle();

    // Three minutes of proving, renewed every fifteen seconds as the queue asks.
    for (let elapsedMs = 0; elapsedMs < 180_000; elapsedMs += 15_000) {
      clock += 15_000;
      for (const tick of [...ticks]) tick();
      await settle();
    }

    const midProof = await held(store, 'job_long');
    expect(midProof.lease?.owner, 'the worker lost its own lease while it was still working')
      .toBe('tab-A');
    expect(Date.parse(midProof.lease!.until),
      'the lease was not renewed, so it lapsed under the worker holding it')
      .toBeGreaterThan(clock);

    releaseProof();
    const ended = await drained;
    expect(ended, 'the worker was refused a write of its own job part way through')
      .toBeUndefined();
    expect((await held(store, 'job_long')).state).toBe('settled');
  });

  it('a worker that lost its lease is told, rather than failing the job it no longer holds', async () => {
    /*
     * **THE ERROR MUST NOT LAND ON THE JOB.** The job belongs to somebody else
     * now, and writing a failure onto it would be this worker's last act being
     * the very write it has just been refused.
     *
     * RED WHEN: `step`'s catch stops re-throwing a lost lease, or `save`
     * answers quietly instead of throwing.
     */
    const store = new MemoryJobStore();
    const q = new JobQueue(runner(), opts(store, { owner: 'tab-A' }));
    const job = await enqueue(q);
    await store.claim(job.id, { owner: 'tab-B', until: '2100-01-01T00:00:00.000Z' }, new Date());

    await expect(q.step(job), 'a worker wrote to a job another tab holds')
      .rejects.toThrow(/being worked somewhere else/i);

    const untouched = await held(store, job.id);
    expect(untouched.state, 'the refused worker changed the job anyway').toBe('queued');
    expect(untouched.lease?.owner).toBe('tab-B');
    expect(untouched.error).toBeUndefined();
  });

  it('and a finished job is never written back to an unfinished one', async () => {
    /*
     * The other half of the same refusal. A worker suspended while somebody
     * withdrew its job would otherwise write `proving` back over `cancelled`
     * and carry on working something a person had stopped.
     *
     * RED WHEN: `mayWrite` drops its terminal branch.
     */
    const store = new MemoryJobStore();
    const q = new JobQueue(runner(), opts(store, { owner: 'tab-A' }));
    const job = await enqueue(q);
    await store.put({ ...job, state: 'cancelled' });

    expect(await store.writeHeld({ ...job, state: 'proving' }, 'tab-A', new Date()),
      'a withdrawn job was put back to work').toBe(false);
  });
});

describe('the attempt cap: a job that cannot succeed stops on its own', () => {
  /*
   * **THE FAILURE THIS CAP IS FOR IS A PROCESS THAT DIED, NOT A CALL THAT
   * THREW, AND THE DIFFERENCE DECIDES HOW THESE CASES ARE WRITTEN.**
   *
   * A `prove` that throws is already terminal one line later - the catch marks
   * the job `failed` and nothing works it again - so a cap would never be
   * consulted. What re-proves for ever is the other ending: the tab is closed,
   * or the browser reclaims the Worker, at 140 seconds into a proof. Nothing
   * runs on the way out, so what the next tab finds is the `proving` the queue
   * saved BEFORE it started, and it starts again from there.
   *
   * So the fixture below is a `prove` that never settles and a step nobody
   * awaits. That is what a killed process leaves behind, and modelling it any
   * other way would be measuring the cap against a failure it does not cover.
   */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('stops at the cap rather than re-proving on every reopened tab', async () => {
    /*
     * RED WHEN: `doProve`'s `job.attempts >= this.maxAttempts` guard is removed
     * - which is the state this queue was in, where `attempts` was incremented
     * on every proof and read by nothing at all.
     */
    const store = new MemoryJobStore();
    let proofs = 0;
    const diesMidProof = runner({
      prove: () => { proofs += 1; return new Promise<never>(() => {}); },
    });

    const first = new JobQueue(diesMidProof, opts(store, { maxAttempts: 3 }));
    const job = await enqueue(first);

    for (let reopen = 0; reopen < 6; reopen++) {
      const found = await held(store, job.id);
      if (isTerminal(found.state)) break;
      const tab = new JobQueue(diesMidProof, opts(store, { maxAttempts: 3, owner: `tab-${reopen}` }));
      void tab.step(found);
      await settle();
    }

    expect(proofs, 'the job kept re-proving past its cap, once per reopened tab').toBe(3);
    expect((await held(store, job.id)).state).toBe('failed');
  });

  it('the count survives the restart that produced it', async () => {
    /*
     * RED WHEN: the cap is read from a counter local to one `drain` rather than
     * from the job, or `attempts` is reset anywhere on the resume path. A cap
     * that starts again on reload is a cap on nothing, and reloading is exactly
     * what a person does when a proof does not finish.
     */
    const store = new MemoryJobStore();
    const dies = runner({ prove: () => new Promise<never>(() => {}) });
    const first = new JobQueue(dies, opts(store, { maxAttempts: 2 }));
    const job = await enqueue(first);

    void first.step(job);
    await settle();
    expect((await held(store, job.id)).attempts).toBe(1);

    // A new queue over the same store: the page was reopened.
    let proofsAfterReopen = 0;
    const second = new JobQueue(
      runner({ prove: () => { proofsAfterReopen += 1; return new Promise<never>(() => {}); } }),
      opts(store, { maxAttempts: 2, owner: 'tab-two' }),
    );
    void second.step(await held(store, job.id));
    await settle();
    await second.step(await held(store, job.id));

    expect(proofsAfterReopen, 'the reopened page started the count again').toBe(1);
    expect((await held(store, job.id)).state).toBe('failed');
  });

  it('the refusal tells a person what to do and names nothing internal', async () => {
    /*
     * RED WHEN: the message names a file, a variable or an option - which is
     * the shape a refusal takes when it is written for whoever wrote the code
     * rather than for whoever is waiting on a payment.
     */
    const store = new MemoryJobStore();
    const q = new JobQueue(runner(), opts(store, { maxAttempts: 0 }));
    const job = await enqueue(q);
    await q.step(job);

    const stopped = await held(store, job.id);
    expect(stopped.state).toBe('failed');
    expect(stopped.error).toMatch(/nothing was ever sent/i);
    expect(stopped.error).toMatch(/safe to raise again/i);
    expect(stopped.error, 'the refusal names something only a developer could act on')
      .not.toMatch(/\.ts\b|maxAttempts|attempts >=|JobQueue/);
  });

  it('and it says the OPPOSITE thing when the job has actually been sent', async () => {
    /*
     * **THE SENTENCE HERE USED TO BE UNCONDITIONAL AND IT WAS WRONG IN THE
     * DANGEROUS DIRECTION.** A job reaches the cap after re-queueing out of
     * `submitting`, so three real transactions could have gone out under a
     * refusal saying that nothing had been sent - and then telling the person
     * to raise it again, which is how one payroll run gets raised twice.
     *
     * RED WHEN: the message stops branching on `submissionAttempted`, or that
     * field stops being written when the job enters `submitting`.
     */
    const store = new MemoryJobStore();
    let submissions = 0;
    const q = new JobQueue(
      runner({
        submit: async () => { submissions += 1; throw new Error('the socket closed'); },
        // What a duplicate-refusing circuit answers: safe to do again. It is
        // NOT a statement that the chain never got the first one.
        recover: async () => null,
      }),
      opts(store, { maxAttempts: 2 }),
    );
    const job = await enqueue(q);
    await q.drain();

    const stopped = await held(store, job.id);
    expect(submissions, 'the fixture never actually submitted anything').toBeGreaterThan(0);
    expect(stopped.state).toBe('failed');
    expect(stopped.error, 'a person is told nothing was sent after a transaction really went out')
      .not.toMatch(/nothing was ever sent|nothing has been sent/i);
    expect(stopped.error).toMatch(/check the account before raising it again/i);
  });
});

describe('a thrown submit is unknown, not failed', () => {
  it('keeps `submitting`, because that is what is true on chain', async () => {
    /*
     * RED WHEN: `step`'s catch sets `job.state = 'failed'` unconditionally,
     * which is what it used to do. `failed` is terminal, so `recover` - the one
     * thing in this system that can ask the chain what happened - was never
     * reached on the one path that needs it.
     */
    const store = new MemoryJobStore();
    const q = new JobQueue(
      runner({ submit: async () => { throw new Error('the socket closed'); } }),
      opts(store),
    );
    const job = await enqueue(q);
    await q.step(job);

    const after = await held(store, job.id);
    expect(after.state, 'a submit that threw was recorded as a submit that did not happen')
      .toBe('submitting');
    expect(after.error).toMatch(/socket closed/);
  });

  it('and the next step then ASKS, rather than deciding for itself', async () => {
    /*
     * RED WHEN: the case above is reverted, or `doRecover` stops being reached
     * from `submitting`. This is the half that makes the first case worth
     * having: recording `submitting` matters only because something asks.
     */
    const store = new MemoryJobStore();
    let asked = 0;
    const q = new JobQueue(
      runner({
        submit: async () => { throw new Error('the socket closed'); },
        recover: async () => { asked += 1; return { settled: true, txRef: 'tx_found' }; },
      }),
      opts(store),
    );
    const job = await enqueue(q);
    await q.step(job);
    await q.step(await held(store, job.id));

    expect(asked, 'nothing asked the chain whether the transaction landed').toBe(1);
    expect((await held(store, job.id)).state).toBe('settled');
  });

  it('a refusal that KNOWS nothing was sent is terminal, and says nothing about the chain', async () => {
    /*
     * **FOUND BY A REAL RUN, NOT BY READING.** A device with no wallet refuses
     * before any network call. Filed as *outcome unknown*, the queue asked the
     * chain, found nothing that could answer, and ended by telling a person
     * *the transaction may have settled: check the account before retrying* -
     * about a payment that provably never existed. **A person who acts on that
     * raises the run again, which is the one thing in this system that pays
     * twice.**
     *
     * RED WHEN: `saysNothingWasSent` is dropped from `step`'s catch, or the
     * runner throws a plain `Error`. Either way the job goes to `submitting`
     * and the sentence comes back.
     */
    const store = new MemoryJobStore();
    let asked = 0;
    const q = new JobQueue(
      runner({
        submit: async () => { throw new NothingWasSent('no wallet has been set up to pay the network fee'); },
        recover: async () => { asked += 1; return null; },
      }),
      opts(store),
    );
    const job = await enqueue(q);
    await q.step(job);

    const after = await held(store, job.id);
    expect(after.state, 'a refusal that reached nothing was filed as an unknown outcome')
      .toBe('failed');
    expect(after.error).toMatch(/no wallet has been set up/);
    expect(after.error, 'a person is being sent to check an account for a payment that never existed')
      .not.toMatch(/may have settled|check the account/i);
    expect(asked, 'the chain was asked about a transaction that was never sent').toBe(0);
  });

  it('and the mark survives a plain object, because two bundles are two classes', () => {
    /*
     * **`instanceof` IS NOT THE CHECK, AND THAT IS DELIBERATE.** A worker
     * bundle and a page bundle are two copies of one module, so an error thrown
     * by one is not an instance of the other's class. A check that quietly
     * answered false would put the wrong sentence in front of a person.
     *
     * RED WHEN: `saysNothingWasSent` is written as an `instanceof` test.
     */
    expect(saysNothingWasSent(new NothingWasSent('x'))).toBe(true);
    expect(saysNothingWasSent({ nothingWasSent: true })).toBe(true);
    expect(saysNothingWasSent(new Error('an ordinary failure'))).toBe(false);
    expect(saysNothingWasSent(null)).toBe(false);
  });

  it('a throw BEFORE anything was sent is still terminal', async () => {
    /*
     * RED WHEN: the catch keeps whatever state it finds rather than testing for
     * `submitting`. Building and proving reach no chain, so treating them as
     * unknown would send a person to check an account for a transaction that
     * provably never existed - and it would do it on the ordinary failure.
     */
    const store = new MemoryJobStore();
    const q = new JobQueue(
      runner({ prove: async () => { throw new Error('an artefact is missing'); } }),
      opts(store),
    );
    const job = await enqueue(q);
    await q.step(job);

    expect((await held(store, job.id)).state).toBe('failed');
  });
});
