/**
 * **EVERY TASK EACH BROWSER WORKER DOES HAS A `Buffer` BEFORE IT BEGINS.**
 *
 * The contract runtime and the ledger reach for Node's `Buffer`, and a browser's
 * worker has none. In Node it is a global, so a test that simply runs a worker's
 * code passes whether or not the worker installs one. Each case here takes
 * `Buffer` away for the length of one task and puts back what was there.
 *
 * The vault worker's deposit is also run through the real circuit with no
 * `Buffer` in `a-private-deposit-is-built-where-there-is-no-buffer.test.ts`;
 * this file is what holds every other task, and the other two workers, to the
 * same thing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { answerVaultAsk, type WorkerDeps } from './vault-worker-entry.js';
import type { VaultAsk } from './vault-worker-client.js';
import { answerPayslipAsk, type PayslipReaderDeps } from './payslip-worker-entry.js';
import type { PayslipAsk } from './payslip-worker-client.js';
import { startProvingWorker, withABuffer } from './proving-worker-entry.js';
import { workerNameFor } from './proving-session.js';
import { NothingWasSent, saysNothingWasSent, type Job, type JobRunner } from '../../../src/core/jobs.js';

/** Runs `go` with no `Buffer` anywhere global, as a browser's worker has none, and puts back what was there. */
const withoutBuffer = async <T,>(go: () => Promise<T>): Promise<T> => {
  const g = globalThis as { Buffer?: unknown };
  const held = g.Buffer;
  delete g.Buffer;
  try {
    return await go();
  } finally {
    g.Buffer = held;
  }
};
const hasBuffer = (): boolean => (globalThis as { Buffer?: unknown }).Buffer !== undefined;

/*
 * Every ask the vault worker answers, each with only what it needs to reach its
 * own case. Most then fail on what they were given, which is not what is being
 * measured: the question is whether the `Buffer` was there first.
 */
const BARE: Record<string, Record<string, unknown>> = {
  deploy: { account: 'ab'.repeat(32) },
  'account-deploy': { foundingLeaf: 'ab'.repeat(32), label: 'co_' + 'cd'.repeat(32), foundingKey: { tag: 'schnorr', value: 'ef'.repeat(32) } },
  'finished-creation': { account: 'ab'.repeat(32), signature: { tag: 'schnorr', value: '00' } },
  'born-held-vault': { account: 'ab'.repeat(32), holders: { committee: [], threshold: 1 } },
  'vault-as-deployed': { vault: 'ab'.repeat(32), account: 'cd'.repeat(32), holders: { committee: [], threshold: 1 }, deploy: '' },
  handover: { vault: 'ab'.repeat(32), counter: '0', temporaryKey: {}, to: {} },
  deposit: { vault: 'ab'.repeat(32), coin: { nonce: '00', token: '00', value: '1' }, state: '', parameters: '' },
  'public-deposit': { vault: 'ab'.repeat(32), token: '00', amount: '1', state: '', parameters: '' },
  commitments: { vault: 'ab'.repeat(32), coin: { nonce: '00', token: '00', value: '1' } },
  'own-seat': { material: {} },
  'secret-is-the-vaults': { vault: 'ab'.repeat(32), state: '', secret: 'cd'.repeat(32) },
  'choose-note': { notes: [], token: '00', amount: '1' },
  'payments-fit': { notes: [], payments: [] },
  'after-payment': { notes: [], spent: '', amount: '1', change: null, createdIn: '' },
  'confirm-payment': { vault: 'ab'.repeat(32), transactionHash: '00', change: null, events: [] },
  'creating-transaction': { vault: 'ab'.repeat(32), commitment: '00', transactionHash: '00', events: [] },
  payout: { vault: 'ab'.repeat(32), account: 'cd'.repeat(32), order: {}, payment: {}, note: {}, events: [], chain: {} },
  'payout-publicly': { vault: 'ab'.repeat(32), account: 'cd'.repeat(32), order: {}, payment: {}, chain: {} },
  'governed-call': { account: 'cd'.repeat(32), order: {}, material: {}, chain: {}, opened: {} },
  'start-standing': { vault: 'ab'.repeat(32), accountState: '', vaultState: '', now: '0' },
  'set-nonce-secret': { vault: 'ab'.repeat(32), account: 'cd'.repeat(32), run: {}, proposal: '00', opensAt: '0', closesAt: '1', chain: {} },
  'write-secret-copy': { vault: 'ab'.repeat(32), run: {}, place: 0, state: '' },
};

describe('the vault worker', () => {
  it('HAS A TEST HERE FOR EVERY ASK IT ANSWERS', () => {
    /* RED WHEN: the worker answers an ask this file does not run - that ask would be the one left without a Buffer. */
    const source = readFileSync(join(import.meta.dirname, 'vault-worker-entry.ts'), 'utf8');
    const answered = [...source.matchAll(/^\s+case '([a-z-]+)':/gm)].map((m) => m[1]).sort();
    expect(answered.length).toBeGreaterThan(10);
    expect(Object.keys(BARE).sort()).toEqual(answered);
  });

  it.each(Object.keys(BARE))('%s: THE Buffer IS THERE BEFORE THE WORKER LOADS WHAT THE ASK IS BUILT WITH, AND AFTER', async (kind) => {
    let whenLoaded: boolean | undefined;
    const deps = async (): Promise<WorkerDeps> => { whenLoaded = hasBuffer(); return {} as WorkerDeps; };
    const after = await withoutBuffer(async () => {
      await answerVaultAsk(deps, { id: 1, network: 'undeployed', ask: kind, ...BARE[kind] } as unknown as VaultAsk)
        .catch(() => undefined);
      return hasBuffer();
    });
    /* RED WHEN: the Buffer is installed inside one ask's case rather than before every ask, or not at all. */
    expect(whenLoaded, 'the worker loaded what this ask is built with before there was a Buffer').toBe(true);
    expect(after, 'this ask ran without a Buffer being put where the runtime looks').toBe(true);
  });
});

describe('the payslip reader', () => {
  it('READS A PAYMENT WITH A Buffer IN PLACE BEFORE IT BUILDS WHAT THE PAYMENT IS RECORDED UNDER', async () => {
    const seen: Array<[string, boolean]> = [];
    const deps: PayslipReaderDeps = {
      movementOf: async () => { seen.push(['movement', hasBuffer()]); return '00'.repeat(32) as never; },
      sourceFor: async () => { seen.push(['source', hasBuffer()]); throw new Error('no indexer here'); },
      readLedger: async () => { seen.push(['ledger', hasBuffer()]); throw new Error('no ledger here'); },
    };
    const ask = { id: 1, company: 'ab'.repeat(32), indexer: {}, payments: [{}] } as unknown as PayslipAsk;
    const answer = await withoutBuffer(() => answerPayslipAsk(deps, ask));
    expect(answer).toEqual({ id: 1, recorded: null });
    /* RED WHEN: the reader builds a payment's recorded value, or reads the chain, with no Buffer installed. */
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter(([, had]) => !had).map(([what]) => what)).toEqual([]);
  });
});

describe('the proving worker', () => {
  const job: Job = {
    id: 'job_1', accountId: 'acc_1', kind: 'approve', state: 'queued', signerId: 'sgn_1',
    payload: {}, attempts: 0, createdAt: 'x', updatedAt: 'x',
  };

  it.each(['prove', 'submit', 'recover'] as const)('%s: A TASK THE QUEUE HANDS IT BEGINS WITH A Buffer', async (task) => {
    let had: boolean | undefined;
    const runner: JobRunner = {
      prove: async () => { had = hasBuffer(); return { proof: 1 }; },
      submit: async () => { had = hasBuffer(); return { txRef: 'r' }; },
      recover: async () => { had = hasBuffer(); return null; },
    };
    const wrapped = withABuffer(runner);
    await withoutBuffer(async () => {
      if (task === 'prove') await wrapped.prove(job);
      else if (task === 'submit') await wrapped.submit(job, { proof: 1 });
      else await wrapped.recover?.(job);
    });
    /* RED WHEN: a task is handed to the runner with no Buffer installed first. */
    expect(had).toBe(true);
  });

  it('PASSES A REFUSAL THAT SENT NOTHING THROUGH AS IT WAS, SO THE QUEUE STILL READS IT AS NOTHING SENT', async () => {
    /*
     * RED WHEN: the wrapper catches and throws anew, losing the mark. The queue then
     * keeps the job as possibly sent and tells a person a payment that never left
     * may have settled.
     */
    const refusal = new NothingWasSent('refused before anything was sent');
    const wrapped = withABuffer({ prove: async () => ({ proof: 1 }), submit: async () => { throw refusal; } });
    const thrown = await wrapped.submit(job, { proof: 1 }).catch((e: unknown) => e);
    expect(thrown).toBe(refusal);
    expect(saysNothingWasSent(thrown)).toBe(true);
  });

  it('LEAVES A RUNNER WITH NO RECOVERY WITHOUT ONE', () => {
    /* RED WHEN: wrapping invents a recovery, which the queue would then trust to say whether a job settled. */
    const wrapped = withABuffer({ prove: async () => ({ proof: 1 }), submit: async () => ({ txRef: 'r' }) });
    expect(wrapped.recover).toBeUndefined();
  });

  it('THE WORKER THE PAGE STARTS PROVES A QUEUED JOB WITH A Buffer IN PLACE', async () => {
    /*
     * The worker itself, over an in-memory store, asked to work one job. Its
     * first act in proving is to fetch the job's material, so the fetch is where
     * the Buffer is looked for; the fetch then fails, which ends the job.
     */
    const fetched: boolean[] = [];
    let listener: ((e: { data: unknown }) => void) | undefined;
    const replies: Array<{ kind?: string; id?: number }> = [];
    const scope = {
      name: workerNameFor({ artefactBase: '/artefacts', dbName: 'every-task-has-a-buffer' }),
      indexedDB: new IDBFactory(),
      fetch: async () => { fetched.push(hasBuffer()); return { ok: false, status: 404 }; },
      postMessage: (m: { kind?: string; id?: number }) => { replies.push(m); },
      addEventListener: (_: string, h: (e: { data: unknown }) => void) => { listener = h; },
      setInterval, clearInterval,
    };
    await withoutBuffer(async () => {
      await startProvingWorker(scope);
      const answered = (id: number) => new Promise<void>((resolve) => {
        const wait = () => (replies.some((r) => r.id === id) ? resolve() : setTimeout(wait, 5));
        wait();
      });
      listener?.({ data: { kind: 'enqueue', id: 1, args: {
        accountId: 'acc_1', kind: 'approve', signerId: 'sgn_1', payload: { circuit: 'propose', preimageUrl: '/preimage/1' },
      } } });
      await answered(1);
      listener?.({ data: { kind: 'drain', id: 2 } });
      await answered(2);
    });
    /* RED WHEN: the worker hands the queue its runner without installing a Buffer for each task. */
    expect(fetched.length, 'the worker never began proving, so nothing here was measured').toBeGreaterThan(0);
    expect(fetched.every(Boolean)).toBe(true);
  });
});
