/**
 * The queue across a thread boundary. Decision 0008.
 *
 * These are about what a message channel does that a function call does not:
 * lose errors, deliver late, arrive out of order, and stop entirely when the
 * other side dies. Each of those turns into the same visible bug — a spinner
 * that never stops — so they are tested as consequences rather than as
 * plumbing.
 */
import { describe, it, expect, vi } from 'vitest';
import { JobQueue, MemoryJobStore, type Job, type JobRunner } from './jobs.js';
import { JobClient, serveJobs, changeReporter, directPorts, webPort, emitterPort } from './jobs-worker.js';

let seq = 0;
const wire = (over: Partial<JobRunner> = {}) => {
  const [hostPort, workerPort] = directPorts();
  const store = new MemoryJobStore();
  const queue = new JobQueue(
    { prove: async () => ({ proof: 'PROOF' }), submit: async () => ({ txRef: 'tx_1' }), ...over },
    {
      store,
      now: () => new Date(1_700_000_000_000 + seq++ * 1000),
      newId: () => `job_${seq++}`,
      onChange: changeReporter(workerPort),
    },
  );
  serveJobs(queue, workerPort);
  return { client: new JobClient(hostPort), queue, store };
};

const work = { accountId: 'acc_1', kind: 'approve' as const, signerId: 'sgn_1' };

describe('JobClient over a port', () => {
  it('enqueues across the boundary and gets the durable job back', async () => {
    const { client, store } = wire();
    const job = await client.enqueue(work);
    expect(job.state).toBe('queued');
    // On the worker's storage, not the host's — the host keeps nothing.
    expect((await store.list())[0].id).toBe(job.id);
  });

  it('drives a job to settled and reports it', async () => {
    const { client } = wire();
    const job = await client.enqueue(work);
    await client.drain();
    const done = await client.get(job.id);
    expect(done!.state).toBe('settled');
    expect(done!.txRef).toBe('tx_1');
  });

  it('pushes every transition to the host, unasked', async () => {
    /*
     * This is the whole basis for optimistic state and notifications: they are
     * subscribers to one stream rather than two more mechanisms. If changes
     * only arrived in response to polling, the page would show stale states for
     * however long the poll interval was.
     */
    const { client } = wire();
    const seen: string[] = [];
    client.onChange((j) => seen.push(j.state));
    await client.enqueue(work);
    await client.drain();
    expect(seen).toEqual(['queued', 'proving', 'proven', 'submitting', 'settled']);
  });

  it('unsubscribing actually stops the updates', async () => {
    const { client } = wire();
    const seen: string[] = [];
    const off = client.onChange((j) => seen.push(j.state));
    await client.enqueue(work);
    off();
    await client.drain();
    expect(seen).toEqual(['queued']);
  });

  it('carries a failure across as a rejection, with the reason intact', async () => {
    /*
     * An error thrown inside a Worker does not reach the page — it is simply
     * lost, and the caller waits forever. So failures have to travel as
     * ordinary messages, and the TEXT has to survive: "no DUST to pay the fee"
     * is what tells a person what to do.
     */
    const { client } = wire();
    await expect(client.cancel('nope')).rejects.toThrow(/no job nope/);
  });

  it('preserves the interrupted-submission warning word for word', async () => {
    /*
     * The one message in the system that is money. If it were flattened to
     * "worker error" on the way across, a person would retry a payment that may
     * already have settled.
     */
    const [hostPort, workerPort] = directPorts();
    const store = new MemoryJobStore();
    await store.put({
      id: 'job_flight', accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1',
      payload: {}, state: 'submitting', attempts: 1,
      createdAt: 'x', updatedAt: 'x',
    });
    const queue = new JobQueue(
      { prove: async () => ({ proof: 'P' }), submit: async () => ({ txRef: 't' }) },
      { store, onChange: changeReporter(workerPort) },
    );
    serveJobs(queue, workerPort);
    const client = new JobClient(hostPort);

    await client.drain();
    const done = await client.get('job_flight');
    expect(done!.state).toBe('failed');
    expect(done!.error).toMatch(/may have settled/i);
  });

  it('a rejected call does not poison the ones after it', async () => {
    // One signer's bad request must not take down the page for everything else.
    const { client } = wire();
    await expect(client.cancel('nope')).rejects.toThrow();
    const job = await client.enqueue(work);
    expect(job.state).toBe('queued');
  });

  it('matches replies to their own calls when they come back OUT OF ORDER', async () => {
    /*
     * A channel gives no ordering guarantee between a slow request and a fast
     * one, and the queue itself does not answer in the order it was asked — a
     * `drain` can take two minutes while a `get` beside it returns at once.
     * Without correlation ids a batch of approvals resolves with each other's
     * jobs, and the page tells the wrong signer their payment was sent.
     *
     * The worker is faked here ON PURPOSE. A real one happens to answer in
     * order, so testing against it proves nothing about correlation — an
     * earlier version of this test did exactly that and passed with the ids
     * removed.
     */
    const [hostPort, workerPort] = directPorts();
    const asked: number[] = [];
    workerPort.onMessage((m: any) => {
      asked.push(m.id);
      if (asked.length < 3) return; // hold everything until all three arrive
      for (const id of [...asked].reverse()) {
        workerPort.postMessage({ kind: 'ok', id, value: { id: `job_${id}` } });
      }
    });

    const client = new JobClient(hostPort);
    const [a, b, c] = await Promise.all([
      client.get('a'),
      client.get('b'),
      client.get('c'),
    ]);
    expect([a, b, c].map((j) => j!.id)).toEqual(['job_1', 'job_2', 'job_3']);
  });

  it('gives every job in a batch its own identity', async () => {
    const { client } = wire();
    const [a, b, c] = await Promise.all([
      client.enqueue({ ...work, payload: { n: 1 } }),
      client.enqueue({ ...work, payload: { n: 2 } }),
      client.enqueue({ ...work, payload: { n: 3 } }),
    ]);
    expect([a.payload.n, b.payload.n, c.payload.n]).toEqual([1, 2, 3]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it('ignores a reply it is not waiting for instead of crashing', async () => {
    // Late replies after a timeout, and duplicates, are ordinary on a channel.
    const [hostPort, workerPort] = directPorts();
    const queue = new JobQueue(
      { prove: async () => ({ proof: 'P' }), submit: async () => ({ txRef: 't' }) },
      { store: new MemoryJobStore() },
    );
    serveJobs(queue, workerPort);
    const client = new JobClient(hostPort);

    workerPort.postMessage({ kind: 'ok', id: 999, value: 'stray' });
    workerPort.postMessage({ kind: 'error', id: 998, message: 'stray' });
    workerPort.postMessage('not even a message');
    await new Promise((r) => setTimeout(r, 5));
    // Still working.
    expect(await client.pending()).toEqual([]);
  });

  it('rejects everything outstanding when the worker dies', async () => {
    /*
     * THE ONE THAT MATTERS ON THE HOST SIDE. A promise that never settles is a
     * spinner that never stops: the person believes their approval is still
     * being worked on when nothing is running at all. The jobs are safe — they
     * are on disk and a new worker resumes them — but the page has to be told.
     */
    const [hostPort] = directPorts(); // nothing serving the other end
    const client = new JobClient(hostPort);
    const call = client.enqueue(work);
    client.fail('the background worker stopped unexpectedly');
    await expect(call).rejects.toThrow(/stopped unexpectedly/);
  });

  it('refuses new work once it knows the worker is gone', async () => {
    // Accepting it would be a lie: nothing would ever run it.
    const [hostPort] = directPorts();
    const client = new JobClient(hostPort);
    client.fail('the background worker stopped unexpectedly');
    await expect(client.enqueue(work)).rejects.toThrow(/stopped unexpectedly/);
  });

  it('answers an unknown request instead of leaving the caller hanging', async () => {
    /*
     * A cached page talking to a newer worker is normal, not impossible.
     * Silence would hang it; an error at least says what happened.
     */
    const [hostPort, workerPort] = directPorts();
    const queue = new JobQueue(
      { prove: async () => ({ proof: 'P' }), submit: async () => ({ txRef: 't' }) },
      { store: new MemoryJobStore() },
    );
    serveJobs(queue, workerPort);

    const answer = new Promise<any>((resolve) => hostPort.onMessage(resolve));
    hostPort.postMessage({ kind: 'somethingNewer', id: 7 });
    const res = await answer;
    expect(res.kind).toBe('error');
    expect(res.id).toBe(7);
    expect(res.message).toMatch(/different version/);
  });

  it('only sends what a real channel could clone', async () => {
    /*
     * `directPorts` structured-clones on purpose. A test that passed object
     * references would pass here and fail in a browser, which is the worst
     * possible place to find out.
     */
    const { client } = wire();
    const job = await client.enqueue({ ...work, payload: { amount: 235_000 } });
    expect(job.payload).toEqual({ amount: 235_000 });
  });

  it('delivers asynchronously, like a real channel', async () => {
    // Synchronous delivery would let ordering bugs hide behind a guarantee no
    // browser gives.
    const [a, b] = directPorts();
    const seen: unknown[] = [];
    b.onMessage((m) => seen.push(m));
    a.postMessage({ kind: 'ping' });
    expect(seen).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([{ kind: 'ping' }]);
  });
});

describe('port adapters', () => {
  it('wraps a browser-shaped target', async () => {
    const listeners: Array<(e: { data: unknown }) => void> = [];
    const posted: unknown[] = [];
    const port = webPort({
      postMessage: (m) => posted.push(m),
      addEventListener: (_t, l) => listeners.push(l),
    });
    const seen: unknown[] = [];
    port.onMessage((m) => seen.push(m));
    port.postMessage('out');
    listeners[0]({ data: 'in' });
    expect(posted).toEqual(['out']);
    expect(seen).toEqual(['in']); // unwrapped from the event, not the event itself
  });

  it('wraps a Node-shaped target', async () => {
    const listeners: Array<(d: unknown) => void> = [];
    const posted: unknown[] = [];
    const port = emitterPort({
      postMessage: (m) => posted.push(m),
      on: (_t, l) => listeners.push(l),
    });
    const seen: unknown[] = [];
    port.onMessage((m) => seen.push(m));
    port.postMessage('out');
    listeners[0]('in');
    expect(posted).toEqual(['out']);
    expect(seen).toEqual(['in']);
  });
});

describe('the reason the queue lives on one side only', () => {
  it('the host holds no state that could disagree with the worker', async () => {
    /*
     * Two queues over one store would each read, decide and write, and the
     * second write would erase the first — a job settled on one side and
     * re-proved on the other. So `get` must reflect the worker, always, even
     * where a local cache would be faster.
     */
    const { client, queue } = wire();
    const job = await client.enqueue(work);

    // Something else moved it, without the host being involved.
    await queue.drain();

    expect((await client.get(job.id))!.state).toBe('settled');
  });

  it('a fresh client sees work the previous one left behind', async () => {
    // A reloaded page. Nothing is handed over; it is all read back.
    const [hostPort, workerPort] = directPorts();
    const store = new MemoryJobStore();
    const queue = new JobQueue(
      { prove: async () => ({ proof: 'P' }), submit: async () => ({ txRef: 't' }) },
      { store, newId: () => `job_${seq++}`, onChange: changeReporter(workerPort) },
    );
    serveJobs(queue, workerPort);

    const first = new JobClient(hostPort);
    const job = await first.enqueue(work);
    first.fail('page reloaded');

    const second = new JobClient(hostPort);
    expect((await second.pending()).map((j) => j.id)).toEqual([job.id]);
  });
});

describe('the drain guard survives the boundary', () => {
  it('reports a store that is not saving progress rather than hanging', async () => {
    /*
     * M-80 across a thread. In a Worker this failure is invisible from the page
     * — the thread just spins — so the error reaching the host is the only way
     * anyone finds out.
     */
    const stuck: Job = {
      id: 'job_stuck', accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1',
      payload: {}, state: 'queued', attempts: 0, createdAt: 'x', updatedAt: 'x',
    };
    const [hostPort, workerPort] = directPorts();
    const queue = new JobQueue(
      { prove: async () => ({ proof: 'P' }), submit: async () => ({ txRef: 't' }) },
      {
        store: {
          list: async () => [{ ...stuck }],
          put: async () => {},
          // Always granted: the subject is a store that does not SAVE. A claim
          // that refused would end the drain with no error, which is the one
          // outcome this case exists to rule out.
          claim: async () => ({ ...stuck }),
          // Accepted every time: the subject is a store that does not SAVE, and a
          // write that refused would end the drain quietly instead of loudly.
          writeHeld: async () => true,
        },
        onChange: changeReporter(workerPort),
      },
    );
    serveJobs(queue, workerPort);
    const client = new JobClient(hostPort);

    await expect(client.drain()).rejects.toThrow(/not saving progress/);
  });
});
