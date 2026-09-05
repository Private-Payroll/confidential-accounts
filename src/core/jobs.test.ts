/**
 * The job queue. Decision 0008.
 *
 * Written as consequences rather than method checks, because the failures this
 * prevents are the expensive kind: an approval lost when a tab closed, or a
 * payment submitted twice because a crash was mistaken for a failure.
 *
 * The interrupted-submission case is the one that matters most. Everything else
 * is recoverable by trying again; that one is not.
 */
import { describe, it, expect, vi } from 'vitest';
import { JobQueue, MemoryJobStore, isTerminal, type Job, type JobRunner, type JobStore } from './jobs.js';

let seq = 0;
const opts = (store: MemoryJobStore, onChange?: (j: Job) => void) => ({
  store,
  now: () => new Date(1_700_000_000_000 + seq++ * 1000),
  newId: () => `job_${seq++}`,
  onChange,
});

const runner = (over: Partial<JobRunner> = {}): JobRunner => ({
  prove: async () => ({ proof: 'PROOF' }),
  submit: async () => ({ txRef: 'tx_1' }),
  ...over,
});

const enqueue = (q: JobQueue, kind: any = 'approve') =>
  q.enqueue({ accountId: 'acc_1', kind, signerId: 'sgn_1' });

describe('JobQueue', () => {
  it('is durable before it is done — enqueue returns once it is stored', async () => {
    // The whole point: a tab that closes right after the click has not lost it.
    const store = new MemoryJobStore();
    const q = new JobQueue(runner(), opts(store));
    const job = await enqueue(q);
    expect(job.state).toBe('queued');
    expect((await store.list())[0].id).toBe(job.id);
  });

  it('proves then submits, and reports settled with a txRef', async () => {
    const store = new MemoryJobStore();
    const q = new JobQueue(runner(), opts(store));
    const job = await enqueue(q);
    await q.drain();
    const done = await q.get(job.id);
    expect(done!.state).toBe('settled');
    expect(done!.txRef).toBe('tx_1');
  });

  it('emits every transition, which is what a UI and a notification hang off', async () => {
    const seen: string[] = [];
    const store = new MemoryJobStore();
    const q = new JobQueue(runner(), opts(store, (j) => seen.push(j.state)));
    await enqueue(q);
    await q.drain();
    // queued -> proving -> proven -> submitting -> settled
    expect(seen).toEqual(['queued', 'proving', 'proven', 'submitting', 'settled']);
  });

  it('resumes a proof interrupted mid-flight, because proving is pure', async () => {
    /*
     * The laptop slept during proving. Redoing it costs time and nothing else —
     * a proof has no effect on chain — so this must simply work rather than
     * asking anyone anything.
     */
    const store = new MemoryJobStore();
    await store.put({
      id: 'job_stuck', accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1',
      payload: {}, state: 'proving', attempts: 1,
      createdAt: 'x', updatedAt: 'x',
    });
    const q = new JobQueue(runner(), opts(store));
    await q.drain();
    expect((await q.get('job_stuck'))!.state).toBe('settled');
  });

  it('NEVER re-submits blindly after an interrupted submission', async () => {
    /*
     * THE ONE THAT MATTERS. The process died between sending and hearing back,
     * so the chain may already have the transaction. Re-sending would pay
     * twice. It has to ask first.
     */
    const store = new MemoryJobStore();
    await store.put({
      id: 'job_flight', accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1',
      payload: {}, state: 'submitting', attempts: 1, txRef: 'tx_maybe',
      createdAt: 'x', updatedAt: 'x',
    });

    const submit = vi.fn(async () => ({ txRef: 'tx_2' }));
    const q = new JobQueue(
      runner({ submit, recover: async () => ({ settled: true, txRef: 'tx_maybe' }) }),
      opts(store),
    );
    await q.drain();

    const done = await q.get('job_flight');
    expect(done!.state).toBe('settled');
    expect(done!.txRef).toBe('tx_maybe');
    expect(submit).not.toHaveBeenCalled();
  });

  it('restarts a submission the chain genuinely never received', async () => {
    const store = new MemoryJobStore();
    await store.put({
      id: 'job_lost', accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1',
      payload: {}, state: 'submitting', attempts: 1,
      createdAt: 'x', updatedAt: 'x',
    });
    const q = new JobQueue(runner({ recover: async () => null }), opts(store));
    await q.drain();
    expect((await q.get('job_lost'))!.state).toBe('settled');
  });

  it('refuses to guess when it cannot ask the chain', async () => {
    /*
     * No recover implementation. Retrying might pay twice; declaring it settled
     * might hide a payment that never happened. Stopping and saying so is the
     * only honest option, and the message has to tell a person what to check.
     */
    const store = new MemoryJobStore();
    await store.put({
      id: 'job_unknown', accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1',
      payload: {}, state: 'submitting', attempts: 1,
      createdAt: 'x', updatedAt: 'x',
    });
    const q = new JobQueue(runner(), opts(store));
    await q.drain();
    const done = await q.get('job_unknown');
    expect(done!.state).toBe('failed');
    expect(done!.error).toMatch(/may have settled/i);
  });

  it('runs jobs one at a time, oldest first', async () => {
    /*
     * Serial on purpose. The prover is single-threaded (M-78), so two proofs in
     * parallel take twice as long each and nothing finishes sooner — the user
     * just watches two spinners instead of one.
     */
    const store = new MemoryJobStore();
    const order: string[] = [];
    let active = 0, maxActive = 0;
    const q = new JobQueue(
      runner({
        prove: async (job) => {
          active += 1; maxActive = Math.max(maxActive, active);
          order.push(job.id);
          await new Promise((r) => setTimeout(r, 1));
          active -= 1;
          return { proof: 'P' };
        },
      }),
      opts(store),
    );
    const a = await enqueue(q); const b = await enqueue(q); const c = await enqueue(q);
    await q.drain();
    expect(order).toEqual([a.id, b.id, c.id]);
    expect(maxActive).toBe(1);
  });

  it('a second drain does not race the first', async () => {
    // drain() is called on start-up, on enqueue, and on regaining focus. Those
    // overlap constantly in a real tab.
    const store = new MemoryJobStore();
    const proved: string[] = [];
    const q = new JobQueue(
      runner({ prove: async (j) => { proved.push(j.id); await new Promise(r => setTimeout(r, 5)); return { proof: 'P' }; } }),
      opts(store),
    );
    await enqueue(q);
    await Promise.all([q.drain(), q.drain(), q.drain()]);
    expect(proved).toHaveLength(1);
  });

  it('a failure is terminal and carries a reason, not just a state', async () => {
    const store = new MemoryJobStore();
    const q = new JobQueue(
      runner({ prove: async () => { throw new Error('no DUST to pay the fee'); } }),
      opts(store),
    );
    const job = await enqueue(q);
    await q.drain();
    const done = await q.get(job.id);
    expect(done!.state).toBe('failed');
    expect(done!.error).toMatch(/no DUST/);
    expect(isTerminal(done!.state)).toBe(true);
  });

  it('one failure does not stop the queue', async () => {
    // A signer with an expired proposal should not block everyone else's work.
    const store = new MemoryJobStore();
    let first = true;
    const q = new JobQueue(
      runner({ prove: async () => { if (first) { first = false; throw new Error('boom'); } return { proof: 'P' }; } }),
      opts(store),
    );
    const bad = await enqueue(q); const good = await enqueue(q);
    await q.drain();
    expect((await q.get(bad.id))!.state).toBe('failed');
    expect((await q.get(good.id))!.state).toBe('settled');
  });

  it('can be cancelled before submission', async () => {
    const store = new MemoryJobStore();
    const q = new JobQueue(runner(), opts(store));
    const job = await enqueue(q);
    expect((await q.cancel(job.id)).state).toBe('cancelled');
    await q.drain();
    expect((await q.get(job.id))!.state).toBe('cancelled');
  });

  it('refuses to cancel something already in flight, and says why', async () => {
    /*
     * A local "cancelled" on a transaction the chain may already hold is a lie
     * the UI would then tell the customer. The honest answer is the
     * inconvenient one.
     */
    const store = new MemoryJobStore();
    await store.put({
      id: 'job_flying', accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1',
      payload: {}, state: 'submitting', attempts: 1,
      createdAt: 'x', updatedAt: 'x',
    });
    const q = new JobQueue(runner(), opts(store));
    await expect(q.cancel('job_flying')).rejects.toThrow(/already been submitted/);
  });

  it('stops instead of spinning when storage is not saving progress', async () => {
    /*
     * Found by mutation: a store that appends instead of overwriting leaves the
     * old `queued` record in place, so `pending()` keeps handing back a job
     * that has already settled and the loop never ends. In a tab that is a
     * pinned core and an endless re-prove, with nothing on screen to say why.
     *
     * It throws rather than marking the job failed, because a store that is not
     * saving progress would not save that either.
     */
    const broken: JobStore = {
      list: async () => [
        {
          id: 'job_stuck', accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1',
          payload: {}, state: 'queued', attempts: 0, createdAt: 'x', updatedAt: 'x',
        },
      ],
      put: async () => {},
    };
    const q = new JobQueue(runner(), { store: broken });
    await expect(q.drain()).rejects.toThrow(/not saving progress/);
  });

  it('pending() is what a fresh tab reads to pick up where it left off', async () => {
    const store = new MemoryJobStore();
    const first = new JobQueue(runner(), opts(store));
    const a = await enqueue(first);
    await enqueue(first);

    // A brand new queue over the same store: a reloaded page.
    const second = new JobQueue(runner(), opts(store));
    const pending = await second.pending();
    expect(pending.map((j) => j.id)).toContain(a.id);
    expect(pending).toHaveLength(2);

    await second.drain();
    expect(await second.pending()).toHaveLength(0);
  });
});
