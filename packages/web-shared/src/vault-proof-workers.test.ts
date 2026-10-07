import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KEPT_IDLE_MS, PROOF_CEILING_MS, oneThreadWhenAThreadDoesNotLoad, proofProviderOnWorkers, provingOnWorkers,
} from './vault-proof-workers.js';
import { whyItFailed } from './why-it-failed.js';
import type { ProofWorkerLike } from './vault-proof-workers.js';

/*
 * **THE DEPOSIT'S PROOFS SIDE BY SIDE, AND THE SAME PROOFS.** Each call the
 * ledger makes gets a thread; the thread is handed exactly the bytes the call
 * carried; each answer goes back to the call that asked; the material comes
 * from the vault worker's own source. A thread that has checked a circuit is
 * the one that proves it next.
 */

class AThread {
  static made: AThread[] = [];
  readonly sent: unknown[] = [];
  terminated = false;
  private onMessage: ((e: { data: never }) => void)[] = [];
  private onError: ((e: { message?: string }) => void)[] = [];
  constructor() { AThread.made.push(this); }
  postMessage(m: unknown): void { this.sent.push(m); }
  addEventListener(type: 'message' | 'error', l: (e: { data: never } & { message?: string }) => void): void {
    if (type === 'message') this.onMessage.push(l as (e: { data: never }) => void);
    else this.onError.push(l as (e: { message?: string }) => void);
  }
  terminate(): void { this.terminated = true; }
  says(data: unknown): void { for (const l of this.onMessage) l({ data } as never); }
  breaks(message: string): void { for (const l of this.onError) l({ message }); }
  get orders(): unknown[] { return this.sent.filter((m) => (m as { op: string }).op !== 'answer'); }
}

const source = () => ({
  lookupKey: vi.fn(async (loc: string) => ({ proverKey: new Uint8Array([1]), verifierKey: new Uint8Array([2]), ir: new Uint8Array([3]), loc }) as never),
  getParams: vi.fn(async (k: number) => new Uint8Array([k])),
});
/** Timers the test runs by hand. */
const handTimers = () => {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 1;
  return {
    set: (run: () => void, ms: number) => { const id = next++; pending.set(id, { run, ms }); return id; },
    clear: (id: unknown) => { pending.delete(id as number); },
    fire: (ms: number) => { for (const [id, t] of [...pending]) if (t.ms === ms) { pending.delete(id); t.run(); } },
    get count() { return pending.size; },
  };
};
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
const DEPOSIT = 'contract:54ef/deposit?vk=aa';
const OUTPUT = 'midnight/zswap/output';

afterEach(() => { AThread.made = []; });

describe('THE PAGE PROVES A DEPOSIT\'S PROOFS ON THREADS OF THEIR OWN', () => {
  it('the ledger\'s calls asked together run together, each on its own thread, each answered with its own proof', async () => {
    const p = provingOnWorkers(source(), () => new AThread() as unknown as ProofWorkerLike, handTimers());
    const check = p.check(new Uint8Array([1]), DEPOSIT);
    const output = p.prove(new Uint8Array([2]), OUTPUT, undefined);
    /* RED WHEN: the two are put on one thread again, and their times add up. */
    expect(AThread.made).toHaveLength(2);
    const [a, b] = AThread.made as [AThread, AThread];
    /* Nothing is posted before a thread says it is listening. */
    expect(a.orders).toEqual([]);
    a.says({ op: 'ready' }); b.says({ op: 'ready' });
    /* RED WHEN: a thread is handed anything but the bytes the ledger's call carried. */
    expect(a.orders).toEqual([{ op: 'check', preimage: new Uint8Array([1]), overwriteBindingInput: undefined }]);
    expect(b.orders).toEqual([{ op: 'prove', preimage: new Uint8Array([2]), overwriteBindingInput: undefined }]);
    b.says({ op: 'result', value: new Uint8Array([22]) });
    a.says({ op: 'result', value: [1n, undefined] });
    /* RED WHEN: answers cross between calls - a transaction with a proof in the wrong place. */
    expect(await output).toEqual(new Uint8Array([22]));
    expect(await check).toEqual([1n, undefined]);
  });

  it('the thread that checked a circuit proves it next, with the binding the ledger gave', async () => {
    const p = provingOnWorkers(source(), () => new AThread() as unknown as ProofWorkerLike, handTimers());
    const check = p.check(new Uint8Array([1]), DEPOSIT);
    const t = AThread.made[0]!;
    t.says({ op: 'ready' });
    t.says({ op: 'result', value: [0n] });
    await check;
    const proof = p.prove(new Uint8Array([1]), DEPOSIT, 42n);
    /* RED WHEN: the proof starts a new thread rather than the one kept from the check. */
    expect(AThread.made).toHaveLength(1);
    expect(t.orders.at(-1)).toEqual({ op: 'prove', preimage: new Uint8Array([1]), overwriteBindingInput: 42n });
    t.says({ op: 'result', value: new Uint8Array([9]) });
    expect(await proof).toEqual(new Uint8Array([9]));
  });

  it('the material a thread asks for comes from the vault worker\'s source, and an answer it could not give is said', async () => {
    const s = source();
    s.getParams.mockRejectedValueOnce(new Error('the parameters for k=15 are not served'));
    const p = provingOnWorkers(s, () => new AThread() as unknown as ProofWorkerLike, handTimers());
    void p.prove(new Uint8Array([2]), OUTPUT).catch(() => {});
    const t = AThread.made[0]!;
    t.says({ op: 'ready' });
    t.says({ op: 'lookupKey', askId: 0, keyLocation: OUTPUT });
    t.says({ op: 'getParams', askId: 1, k: 15 });
    await settle();
    /* RED WHEN: a thread is answered from anywhere but the source the vault worker checks and caches. */
    expect(s.lookupKey).toHaveBeenCalledWith(OUTPUT);
    expect(t.sent).toContainEqual({ op: 'answer', askId: 1, ok: false, error: 'the parameters for k=15 are not served' });
    expect((t.sent.find((m) => (m as { askId?: number }).askId === 0) as { ok: boolean }).ok).toBe(true);
    /* The ledger reads the verifier key straight from the source, as the in-thread prover does. */
    await p.lookupKey(DEPOSIT);
    expect(s.lookupKey).toHaveBeenLastCalledWith(DEPOSIT);
  });

  it('a thread that failed, broke or ran past the ceiling is never used again, and the failure is the proof\'s', async () => {
    const timers = handTimers();
    const p = provingOnWorkers(source(), () => new AThread() as unknown as ProofWorkerLike, timers);
    const failed = p.prove(new Uint8Array([1]), OUTPUT);
    AThread.made[0]!.says({ op: 'ready' });
    AThread.made[0]!.says({ op: 'failure', error: 'no proof' });
    /* Each failure says what happened, that nothing was sent and what to do; the thread's own words stay underneath. */
    const said = async (p2: Promise<unknown>) => whyItFailed(await p2.catch((e: unknown) => e));
    /* RED WHEN: a failed proof reaches the page in the prover's internal words alone, with no next step. */
    expect(await said(failed)).toMatch(/^This device could not work out the proof for this transaction, so nothing was sent\. Reload the page and try again\. Underneath that: no proof$/u);
    const broke = p.prove(new Uint8Array([1]), OUTPUT);
    AThread.made[1]!.says({ op: 'ready' });
    AThread.made[1]!.breaks('the thread stopped');
    /* RED WHEN: a thread that stopped is told to the page as its internal event and nothing else. */
    expect(await said(broke)).toMatch(/^This device stopped working out the proof for this transaction before it finished, so nothing was sent\. Try again.*Underneath that: the thread stopped$/u);
    const slow = p.prove(new Uint8Array([1]), OUTPUT);
    AThread.made[2]!.says({ op: 'ready' });
    timers.fire(PROOF_CEILING_MS);
    /* RED WHEN: a proof past the ceiling says only that the ceiling passed. */
    expect(await said(slow)).toMatch(/^Working out the proof for this transaction took more than ten minutes, so this device stopped and nothing was sent\. Try again.*Underneath that: the prove did not finish within ten minutes$/u);
    /* RED WHEN: a thread that loaded and then broke is read as one that could not load, and every proof after it is moved to one thread. */
    expect(p.didNotLoad).toBe(false);
    /* RED WHEN: a thread in an unknown state is kept and handed the next proof. */
    expect(AThread.made.map((t) => t.terminated)).toEqual([true, true, true]);
    expect(p.idle).toBe(0);
  });

  it('keeps at most one idle thread per circuit, lets it go after the idle time, and lets them all go on stop', async () => {
    const timers = handTimers();
    const p = provingOnWorkers(source(), () => new AThread() as unknown as ProofWorkerLike, timers);
    const one = p.prove(new Uint8Array([1]), OUTPUT);
    const two = p.prove(new Uint8Array([2]), OUTPUT);
    for (const t of AThread.made) { t.says({ op: 'ready' }); t.says({ op: 'result', value: new Uint8Array([0]) }); }
    await one; await two;
    /* RED WHEN: every finished thread is kept, each holding the memory it proved in. */
    expect(p.idle).toBe(1);
    timers.fire(KEPT_IDLE_MS);
    expect(p.idle).toBe(0);
    expect(AThread.made.every((t) => t.terminated)).toBe(true);
    const three = p.prove(new Uint8Array([3]), DEPOSIT);
    AThread.made[2]!.says({ op: 'ready' }); AThread.made[2]!.says({ op: 'result', value: new Uint8Array([0]) });
    await three;
    p.stop();
    expect(AThread.made[2]!.terminated).toBe(true);
  });

  it('where the vault worker cannot start a thread, it proves on its own thread as before', async () => {
    const oneThread = { proveTx: async () => 'proved on one thread' };
    /* RED WHEN: a browser without threads in a worker is handed a provider that can never answer. */
    expect(await proofProviderOnWorkers(source(), {}, async () => oneThread)).toBe(oneThread);
  });

  it('A THREAD THAT FAILS TO LOAD IS SAID SO, AND THE TRANSACTION IS PROVED AGAIN ON ONE THREAD, AS IS EVERY ONE AFTER IT', async () => {
    const p = provingOnWorkers(source(), () => new AThread() as unknown as ProofWorkerLike, handTimers());
    const proof = p.prove(new Uint8Array([1]), OUTPUT);
    /* The thread breaks before it ever said it was listening: its file did not load. */
    AThread.made[0]!.breaks('failed to fetch the worker script');
    await expect(proof).rejects.toThrow(/nothing was sent/u);
    /* RED WHEN: a thread that never loaded is not told apart from a proof that failed. */
    expect(p.didNotLoad).toBe(true);

    const proved: string[] = [];
    let onOneThreadMade = 0;
    /* Threads that prove 'a' and fail for a reason of its own, and whose thread for 'b' does not load. */
    const onWorkers = {
      didNotLoad: false,
      stopped: 0,
      async proveTx(tx: unknown) {
        proved.push(`workers:${String(tx)}`);
        if (tx === 'b') this.didNotLoad = true;
        throw new Error('no thread');
      },
      stop() { this.stopped += 1; },
    };
    const prover = oneThreadWhenAThreadDoesNotLoad(onWorkers, async () => {
      onOneThreadMade += 1;
      return { proveTx: async (tx: unknown) => { proved.push(`one:${String(tx)}`); return `proof of ${String(tx)}`; } };
    });
    /* A proof that failed for its own reason is said, and not tried again on one thread. */
    await expect(prover.proveTx('a')).rejects.toThrow('no thread');
    /* RED WHEN: any failure, not only a thread that did not load, sends the transaction round again. */
    expect(onOneThreadMade).toBe(0);
    /* RED WHEN: a deposit whose thread did not load fails instead of being proved on one thread. */
    expect(await prover.proveTx('b')).toBe('proof of b');
    expect(await prover.proveTx('c')).toBe('proof of c');
    /* RED WHEN: every transaction after it tries the threads again, or the prover is made afresh each time. */
    expect(proved).toEqual(['workers:a', 'workers:b', 'one:b', 'one:c']);
    expect(onOneThreadMade).toBe(1);
    expect(onWorkers.stopped).toBe(1);
  });
});
