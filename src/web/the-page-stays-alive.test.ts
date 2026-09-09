/**
 * **WHAT THE PAGE IS ALLOWED TO SAY ABOUT A PROOF RUNNING SOMEWHERE ELSE.**
 *
 * Two things are being guarded here and they pull in opposite directions.
 *
 * **THE FIRST IS THAT NOTHING IS INVENTED.** The prover reports nothing while
 * it runs, so the proving stage has elapsed time and a name and no fraction at
 * all. A bar that crawls to ninety and sits there is a lie told to somebody
 * waiting on their own money, and it is the same species as the two documents
 * this repository found claiming a browser proof nobody had taken.
 *
 * **THE SECOND IS THAT NOTHING IMPLIES A RESUME.** A proof is one opaque call
 * with no checkpoint. A tab closed at 130 seconds has saved nothing; a reopened
 * page starts that proof again from the beginning. The job survives, the proof
 * does not, and the difference has to survive contact with the words on screen.
 */
import { describe, it, expect } from 'vitest';
import { directPorts, serveJobs, changeReporter } from '../core/jobs-worker.js';
import { JobQueue, MemoryJobStore, type JobRunner } from '../core/jobs.js';
import {
  ProvingSession, configFromWorkerName, workerNameFor, elapsed, megabytes,
} from './proving-session.js';

/** A worker on this thread: the real protocol, the real queue, no Worker. */
const workerOnThisThread = (runner: JobRunner) => {
  const [hostPort, workerPort] = directPorts();
  const store = new MemoryJobStore();
  const queue = new JobQueue(runner, { store, onChange: changeReporter(workerPort) });
  serveJobs(queue, workerPort);
  return {
    hostPort, workerPort, store,
    ready: () => workerPort.postMessage({ kind: 'proving-worker-ready' }),
    progress: (jobId: string, received: number, total: number | null, what = 'fetching the proving key') =>
      workerPort.postMessage({ kind: 'fetch-progress', jobId, progress: { received, total, what } }),
  };
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('what the page may say while a proof runs elsewhere', () => {
  it('the proving stage carries elapsed time and NO fraction, because there is not one', async () => {
    /*
     * RED WHEN: `ProofStage` gains a fraction on `proving`, or `stageOfState`
     * derives one from elapsed time against the measured 140 seconds. The
     * second is the tempting one and it is worse than the first: it looks like
     * a measurement and is arithmetic over an average.
     */
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const w = workerOnThisThread({
      prove: async () => { await held; return { proof: 'P' }; },
      submit: async () => ({ txRef: 'tx' }),
    });
    let clock = 1_000;
    const session = new ProvingSession({ port: w.hostPort, now: () => clock });
    w.ready();
    await session.ready();

    void session.enqueue({ accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1' });
    await settle();
    clock += 74_000;

    const [status] = session.status();
    expect(status.stage.name).toBe('proving');
    expect(Object.keys(status.stage).sort(),
      'the proving stage carries something other than a name and an elapsed time')
      .toEqual(['elapsedMs', 'name']);
    expect((status.stage as any).elapsedMs).toBe(74_000);
    release();
  });

  it('the fetch stage carries the real bytes, and a null total when nothing said', async () => {
    // RED WHEN: `total` is coerced to a number anywhere on the way through.
    const w = workerOnThisThread({
      prove: async () => new Promise<never>(() => {}),
      submit: async () => ({ txRef: 'tx' }),
    });
    const session = new ProvingSession({ port: w.hostPort });
    w.ready();
    await session.ready();
    const job = await session.enqueue({ accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1' });
    await settle();

    w.progress(job.id, 4_194_304, null);
    await settle();
    expect(session.status()[0].stage).toEqual({
      name: 'fetching', what: 'fetching the proving key', received: 4_194_304, total: null,
    });
  });

  it('bytes arriving outrank proving, because the artefacts are pulled INSIDE the proof', async () => {
    /*
     * **THE JOB SAYS `proving` FOR THE WHOLE OF IT.** The prover reaches back
     * for its artefacts from inside its own call, so a first proof is a
     * download and then a proof, and the record cannot tell them apart.
     * Measured: 36.6 seconds of a 176.9-second first proof was download, over a
     * local connection.
     *
     * RED WHEN: the fetch progress is ignored while the job says `proving`.
     * The one honest fraction in the operation would then be hidden behind the
     * stage that has none.
     */
    const w = workerOnThisThread({
      prove: async () => new Promise<never>(() => {}),
      submit: async () => ({ txRef: 'tx' }),
    });
    const session = new ProvingSession({ port: w.hostPort });
    w.ready();
    await session.ready();
    const job = await session.enqueue({ accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1' });
    await settle();
    expect(session.status()[0].stage.name).toBe('proving');

    w.progress(job.id, 1_000, 30_700_000);
    await settle();
    expect(session.status()[0].stage.name).toBe('fetching');
  });

  it('a new attempt starts its download count at nothing', async () => {
    /*
     * **THE FIRST VERSION OF THIS CASE COULD NOT FAIL AND A MUTATION FOUND IT.**
     * It asserted that a job which had moved on showed a later stage, and it
     * stayed green with the clearing deleted - because `status` already refuses
     * to draw a fetch stage for a job that is not queued or proving. The
     * clearing that MATTERS is the one on a second attempt, where the job is
     * back in `proving` and the guard does not help.
     *
     * RED WHEN: the record is not cleared as `attempts` moves. The count from
     * the attempt before is then shown against the new one - and on a warm
     * device it is never corrected, because nothing is fetched twice.
     */
    const w = workerOnThisThread({
      prove: async () => new Promise<never>(() => {}),
      submit: async () => ({ txRef: 'tx' }),
    });
    const session = new ProvingSession({ port: w.hostPort });
    w.ready();
    await session.ready();
    const job = await session.enqueue({ accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1' });
    await settle();
    w.progress(job.id, 12_000_000, 30_700_000);
    await settle();
    expect(session.status()[0].stage.name).toBe('fetching');

    /*
     * The shape a reopened tab produces: the same job, worked again. The count
     * is taken from what the page has actually been told rather than from the
     * record `enqueue` returned - that one is a snapshot from before any work
     * started, and building the next attempt from it produces the SAME number,
     * which is a fixture that changes nothing.
     */
    const worked = session.status()[0].attempts;
    w.workerPort.postMessage({
      kind: 'change',
      job: { ...job, state: 'proving', attempts: worked + 1 },
    });
    await settle();

    expect(session.status()[0].stage.name,
      'the new attempt is showing the previous attempt\'s download').toBe('proving');
  });

  it('the clock belongs to THIS attempt, not to the job', async () => {
    /*
     * **THE ONE NUMBER THAT HAD TO BE RIGHT.** Elapsed time is the only honest
     * signal the proving stage has, because the prover reports nothing - so a
     * clock kept per job rather than per attempt makes a proof five seconds old
     * read as minutes, and an operator cannot tell a restarted proof from a
     * stuck one. That is precisely the question the stage exists to answer.
     *
     * RED WHEN: `startedProvingAt` is not cleared as `attempts` moves, or the
     * clearing is moved AFTER the line that sets it - which deletes the start
     * time of every first attempt instead, because `attempts` moves on the very
     * transition into proving.
     */
    const w = workerOnThisThread({
      prove: async () => new Promise<never>(() => {}),
      submit: async () => ({ txRef: 'tx' }),
    });
    let clock = 1_000;
    const session = new ProvingSession({ port: w.hostPort, now: () => clock });
    w.ready();
    await session.ready();
    const job = await session.enqueue({ accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1' });
    await settle();

    clock += 200_000;
    expect((session.status()[0].stage as any).elapsedMs,
      'the first attempt is not being timed at all').toBe(200_000);

    // The shape a reopened tab produces: the same job, worked again.
    w.workerPort.postMessage({
      kind: 'change',
      job: { ...job, state: 'proving', attempts: session.status()[0].attempts + 1 },
    });
    await settle();
    clock += 5_000;

    expect((session.status()[0].stage as any).elapsedMs,
      'a five-second-old proof is being reported with the previous attempt\'s clock')
      .toBe(5_000);
  });

  it('a job that stopped shows the reason it stopped, not a stage', async () => {
    // RED WHEN: `failed` is drawn as anything that does not carry `job.error`.
    const w = workerOnThisThread({
      prove: async () => { throw new Error('no wallet has been set up to pay the network fee'); },
      submit: async () => ({ txRef: 'tx' }),
    });
    const session = new ProvingSession({ port: w.hostPort });
    w.ready();
    await session.ready();
    await session.enqueue({ accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1' });
    await settle();
    await settle();

    const stage = session.status()[0].stage;
    expect(stage.name).toBe('stopped');
    expect((stage as any).reason).toMatch(/pay the network fee/);
  });
});

describe('the page does not speak before the worker is listening', () => {
  it('waits for the ready notice rather than posting into a worker that is still loading', async () => {
    /*
     * **A MODULE WORKER DROPS WHAT IS POSTED TO IT WHILE ITS TOP-LEVEL `await`
     * IS PENDING**, and this worker's first act is to load a prover. A page
     * that sent at construction would lose exactly the message that starts the
     * work, and the failure is a strip that never appears.
     *
     * RED WHEN: `enqueue` stops awaiting `ready()`.
     */
    const w = workerOnThisThread({
      prove: async () => ({ proof: 'P' }), submit: async () => ({ txRef: 'tx' }),
    });
    const session = new ProvingSession({ port: w.hostPort });

    let settled = false;
    void session.enqueue({ accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1' })
      .then(() => { settled = true; });
    await settle();
    expect(settled, 'the page sent work before the worker said it was listening').toBe(false);

    w.ready();
    await settle();
    await settle();
    expect(settled).toBe(true);
  });
});

describe('the worker is told where to fetch from before it exists', () => {
  it('round-trips its settings through the name', () => {
    // RED WHEN: the name stops carrying `artefactBase`.
    expect(configFromWorkerName(workerNameFor({ artefactBase: '/artefacts' })))
      .toEqual({ artefactBase: '/artefacts', dbName: undefined });
  });

  it('refuses a worker started with no settings, in words rather than a crash', () => {
    /*
     * RED WHEN: the empty case falls through and the worker starts with an
     * undefined base. It would then run, answer every message, and 404 every
     * artefact - which is a queue that looks healthy and can never finish.
     */
    expect(() => configFromWorkerName('')).toThrow(/where the application serves/i);
    expect(() => configFromWorkerName('{}')).toThrow(/nothing to prove with/i);
  });
});

describe('what a waiting person reads', () => {
  it('shows minutes once the wait passes one, because this wait is over two', () => {
    // RED WHEN: the minute branch is removed. `94s` and `140s` are numbers a
    // person converts in their head while they are already waiting.
    expect(elapsed(41_000)).toBe('41s');
    expect(elapsed(94_000)).toBe('1m 34s');
    expect(elapsed(140_300)).toBe('2m 20s');
  });

  it('shows megabytes, which is the unit the 30.7 MB first fetch is in', () => {
    expect(megabytes(30_700_000)).toBe('29.3 MB');
  });
});
