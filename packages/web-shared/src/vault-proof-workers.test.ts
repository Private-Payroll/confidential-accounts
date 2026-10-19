import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KEPT_IDLE_MS, PROOF_CEILING_MS, oneThreadWhenAThreadDoesNotLoad, proofProviderOnWorkers, provingOnWorkers,
} from './vault-proof-workers.js';
import { ProvingMaterialRefused } from './key-material.js';
import { whyItFailed } from './why-it-failed.js';
import type { ProofWorkerLike } from './vault-proof-workers.js';

/*
 * **THE DEPOSIT'S PROOFS SIDE BY SIDE, AND THE SAME PROOFS.** Each call the
 * ledger makes gets a thread, up to the device's cores, and waits for one past
 * that; the thread is handed exactly the bytes the call
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

const clockTimers = () => {
  let now = 0;
  let next = 1;
  const live = new Map<number, { run: () => void; at: number }>();
  return {
    set: (run: () => void, ms: number) => { const id = next++; live.set(id, { run, at: now + ms }); return id; },
    clear: (id: unknown) => { live.delete(id as number); },
    advance: (ms: number) => {
      const target = now + ms;
      for (;;) {
        const due = [...live].filter(([, t]) => t.at <= target).sort((x, y) => x[1].at - y[1].at)[0];
        if (due === undefined) break;
        now = due[1].at;
        live.delete(due[0]);
        due[1].run();
      }
      now = target;
    },
  };
};
const spawnThread = () => new AThread() as unknown as ProofWorkerLike;
const bytes = (n: number) => new Uint8Array([n]);
const circuit = (n: number) => `midnight/zswap/circuit${n}`;
const finishes = (t: AThread, value: unknown = bytes(0)): void => { t.says({ op: 'ready' }); t.says({ op: 'result', value }); };
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
const DEPOSIT = 'contract:54ef/deposit?vk=aa';
const OUTPUT = 'midnight/zswap/output';

afterEach(() => { AThread.made = []; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('THE PAGE PROVES A DEPOSIT\'S PROOFS ON THREADS OF THEIR OWN', () => {
  it('the ledger\'s calls asked together run together, each on its own thread, each answered with its own proof', async () => {
    const p = provingOnWorkers(source(), () => new AThread() as unknown as ProofWorkerLike, handTimers());
    const check = p.check(new Uint8Array([1]), DEPOSIT);
    const output = p.prove(new Uint8Array([2]), OUTPUT, undefined);
    /* RED WHEN: the two are put on one thread, and their times add up. */
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

  it('where the vault worker cannot start a thread, it proves on the vault worker\'s own thread', async () => {
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

describe('THE PAGE HOLDS THE PROOF THREADS TO THE DEVICE\'S CORES', () => {
  /* RED WHEN: more proofs than the device has cores run at once, or a finished proof's thread stays alive beside the new one. */
  it('a proof asked beyond the cores waits, and the thread a finished proof leaves is let go for it', async () => {
    const timers = handTimers();
    const p = provingOnWorkers(source(), spawnThread, timers, 2);
    const first = p.prove(bytes(1), circuit(1));
    const second = p.prove(bytes(2), circuit(2));
    const third = p.prove(bytes(3), circuit(3));

    expect(AThread.made).toHaveLength(2);
    const [a, b] = AThread.made as [AThread, AThread];
    a.says({ op: 'ready' }); b.says({ op: 'ready' });
    expect(timers.count).toBe(2);
    a.says({ op: 'result', value: bytes(11) });
    expect(await first).toEqual(bytes(11));

    expect(AThread.made).toHaveLength(3);
    const c = AThread.made[2]!;
    expect(a.terminated).toBe(true);
    expect(AThread.made.filter((t) => !t.terminated)).toHaveLength(2);
    c.says({ op: 'ready' });
    expect(c.orders).toEqual([{ op: 'prove', preimage: bytes(3), overwriteBindingInput: undefined }]);
    b.says({ op: 'result', value: bytes(22) }); c.says({ op: 'result', value: bytes(33) });
    expect(await second).toEqual(bytes(22));
    expect(await third).toEqual(bytes(33));
    expect(AThread.made.filter((t) => !t.terminated).length).toBeLessThanOrEqual(2);
  });

  /* RED WHEN: a proof's ten minutes start when it is asked for and not when it starts running. */
  it('a proof that waits for a place is not timed until it starts', async () => {
    const timers = handTimers();
    const p = provingOnWorkers(source(), spawnThread, timers, 1);
    void p.prove(bytes(1), circuit(1)).catch(() => {});
    const waits = p.prove(bytes(2), circuit(2));
    void waits.catch(() => {});

    expect(timers.count).toBe(1);
    AThread.made[0]!.says({ op: 'ready' });
    AThread.made[0]!.says({ op: 'failure', error: 'no proof' });
    expect(AThread.made).toHaveLength(2);
    expect(timers.count).toBe(1);
    AThread.made[1]!.says({ op: 'ready' });
    timers.fire(PROOF_CEILING_MS);
    await expect(waits).rejects.toThrow(/took more than ten minutes/u);
  });

  /* RED WHEN: a proof that ran past its time leaves the proofs behind it waiting for ever. */
  it('a proof that runs past its time makes room for the one waiting behind it', async () => {
    const timers = handTimers();
    const p = provingOnWorkers(source(), spawnThread, timers, 1);
    const slow = p.prove(bytes(1), circuit(1));
    const next = p.prove(bytes(2), circuit(2));
    AThread.made[0]!.says({ op: 'ready' });
    timers.fire(PROOF_CEILING_MS);
    await expect(slow).rejects.toThrow(/took more than ten minutes/u);

    expect(AThread.made).toHaveLength(2);
    finishes(AThread.made[1]!, bytes(8));
    expect(await next).toEqual(bytes(8));
  });

  /* RED WHEN: a kept thread keeps its place and the next proof waits behind it, or both stay alive. */
  it('a thread kept for another circuit never holds the place a new proof needs', async () => {
    const p = provingOnWorkers(source(), spawnThread, handTimers(), 1);
    const first = p.prove(bytes(1), circuit(1));
    finishes(AThread.made[0]!);
    await first;
    expect(p.idle).toBe(1);

    const second = p.prove(bytes(2), circuit(2));

    expect(AThread.made).toHaveLength(2);
    expect(AThread.made[0]!.terminated).toBe(true);
    expect(p.idle).toBe(0);
    finishes(AThread.made[1]!, bytes(7));
    expect(await second).toEqual(bytes(7));
  });

  /* RED WHEN: the device's reported cores are not read, or the number taken when it says nothing is not two. */
  it('the threads are held to the cores the worker\'s scope reports, and to two where it does not say', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', AThread);
    const tx = (n: number) => ({ prove: (provider: { prove(p: Uint8Array, k: string): Promise<unknown> }) => provider.prove(bytes(n), circuit(n)) });
    const asks = async (navigator: unknown, proofs: number): Promise<number> => {
      AThread.made = [];
      const prover = await proofProviderOnWorkers(source(), { Worker: AThread, navigator } as never, async () => ({ proveTx: async () => 'one thread' }));
      for (let n = 1; n <= proofs; n += 1) void prover.proveTx(tx(n) as never).catch(() => {});
      return AThread.made.length;
    };

    expect(await asks({ hardwareConcurrency: 3 }, 5)).toBe(3);
    expect(await asks({ hardwareConcurrency: 1 }, 5)).toBe(1);
    expect(await asks({ hardwareConcurrency: 16 }, 5)).toBe(5);
    for (const unsaid of [undefined, {}, { hardwareConcurrency: 0 }, { hardwareConcurrency: Number.NaN }, { hardwareConcurrency: -4 }, { hardwareConcurrency: 1.5 }, { hardwareConcurrency: '8' }]) {
      expect(await asks(unsaid, 5)).toBe(2);
    }
  });

  /* RED WHEN: the failure to load is not seen by the provider, or the kept threads stay alive after the one-thread fallback. */
  it('a thread that fails to load sends the whole transaction to one thread, as every one after it, and lets the kept threads go', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', AThread);
    const oneThread = { proveTx: vi.fn(async () => 'proved on one thread') };
    const inThread = vi.fn(async () => oneThread);
    const prover = await proofProviderOnWorkers(source(), { Worker: AThread }, inThread);
    const pair = {
      prove: (provider: { prove(p: Uint8Array, k: string): Promise<unknown> }) =>
        Promise.all([provider.prove(bytes(1), circuit(1)), provider.prove(bytes(2), circuit(2))]),
    };

    const proved = prover.proveTx(pair as never);
    const [kept, broken] = AThread.made as [AThread, AThread];
    finishes(kept);
    broken.breaks('failed to fetch the worker script');

    expect(await proved).toBe('proved on one thread');
    expect(inThread).toHaveBeenCalledTimes(1);
    expect(kept.terminated).toBe(true);
    expect(await prover.proveTx(pair as never)).toBe('proved on one thread');
    expect(AThread.made).toHaveLength(2);
    expect(oneThread.proveTx).toHaveBeenCalledTimes(2);
  });
});

describe('EACH ANSWER REACHES THE THREAD THAT ASKED, AND EVERY KEPT THREAD AND TIMER IS ACCOUNTED FOR', () => {
  /* RED WHEN: an answer goes to a thread other than the one that asked. */
  it('two threads asking under the same number at once are each answered for their own circuit and size', async () => {
    const p = provingOnWorkers(source(), spawnThread, handTimers(), 2);
    void p.prove(bytes(1), circuit(1)).catch(() => {});
    void p.prove(bytes(2), circuit(2)).catch(() => {});
    const [a, b] = AThread.made as [AThread, AThread];
    a.says({ op: 'ready' }); b.says({ op: 'ready' });
    a.says({ op: 'lookupKey', askId: 0, keyLocation: circuit(1) });
    b.says({ op: 'lookupKey', askId: 0, keyLocation: circuit(2) });
    a.says({ op: 'getParams', askId: 1, k: 9 });
    b.says({ op: 'getParams', askId: 1, k: 15 });
    await settle();

    const answered = (t: AThread, askId: number) => t.sent.filter((m) => (m as { op: string; askId?: number }).op === 'answer' && (m as { askId: number }).askId === askId) as { ok: boolean; value: { loc?: string } | Uint8Array }[];
    expect(answered(a, 0)).toHaveLength(1);
    expect(answered(b, 0)).toHaveLength(1);
    expect((answered(a, 0)[0]!.value as { loc: string }).loc).toBe(circuit(1));
    expect((answered(b, 0)[0]!.value as { loc: string }).loc).toBe(circuit(2));
    expect(answered(a, 1)[0]!.value).toEqual(bytes(9));
    expect(answered(b, 1)[0]!.value).toEqual(bytes(15));
  });

  /* RED WHEN: a kept thread that broke while it waited is handed the next proof of its circuit, and that proof hangs until its time limit. */
  it('a kept thread that broke while it waited is never given a proof, and a new thread takes it', async () => {
    const p = provingOnWorkers(source(), spawnThread, handTimers(), 2);
    const first = p.prove(bytes(1), circuit(1));
    finishes(AThread.made[0]!);
    await first;
    expect(p.idle).toBe(1);
    AThread.made[0]!.breaks('the thread stopped while it waited');

    const next = p.prove(bytes(2), circuit(1));

    expect(AThread.made).toHaveLength(2);
    expect(p.didNotLoad).toBe(false);
    AThread.made[1]!.says({ op: 'ready' });
    expect(AThread.made[0]!.orders).toHaveLength(1);
    expect(AThread.made[1]!.orders).toEqual([{ op: 'prove', preimage: bytes(2), overwriteBindingInput: undefined }]);
    AThread.made[1]!.says({ op: 'result', value: bytes(6) });
    expect(await next).toEqual(bytes(6));
  });

  /* RED WHEN: a refusal of one thread's key is sent to another thread, and the thread that asked waits for ever. */
  it('a refusal of a key reaches the thread that asked and no other', async () => {
    const s = source();
    s.lookupKey.mockRejectedValueOnce(new Error('this key is not served'));
    const p = provingOnWorkers(s, spawnThread, handTimers(), 2);
    void p.prove(bytes(1), circuit(1)).catch(() => {});
    void p.prove(bytes(2), circuit(2)).catch(() => {});
    const [a, b] = AThread.made as [AThread, AThread];
    a.says({ op: 'ready' }); b.says({ op: 'ready' });
    a.says({ op: 'lookupKey', askId: 0, keyLocation: circuit(1) });
    b.says({ op: 'lookupKey', askId: 0, keyLocation: circuit(2) });
    await settle();

    expect(a.sent).toContainEqual({ op: 'answer', askId: 0, ok: false, error: 'this key is not served' });
    expect(b.sent.filter((m) => (m as { ok?: boolean }).ok === false)).toEqual([]);
    expect(b.sent.filter((m) => (m as { ok?: boolean }).ok === true)).toHaveLength(1);
  });

  /* RED WHEN: a second circuit's kept thread replaces or refuses the first's. */
  it('one thread is kept for each circuit at once, and each is the one its circuit\'s next proof uses', async () => {
    const p = provingOnWorkers(source(), spawnThread, handTimers(), 2);
    const first = p.prove(bytes(1), circuit(1));
    const second = p.prove(bytes(2), circuit(2));
    for (const t of AThread.made) finishes(t);
    await first; await second;

    expect(p.idle).toBe(2);
    const [a, b] = AThread.made as [AThread, AThread];
    void p.prove(bytes(3), circuit(1)).catch(() => {});
    void p.prove(bytes(4), circuit(2)).catch(() => {});

    expect(AThread.made).toHaveLength(2);
    expect(a.orders.at(-1)).toEqual({ op: 'prove', preimage: bytes(3), overwriteBindingInput: undefined });
    expect(b.orders.at(-1)).toEqual({ op: 'prove', preimage: bytes(4), overwriteBindingInput: undefined });
  });

  /* RED WHEN: a time limit or a kept thread's timer is left running after the proof ended or the page stopped. */
  it('a proof\'s time limit is cleared when it ends either way, and a kept thread\'s time is cleared when it is let go', async () => {
    const timers = handTimers();
    const p = provingOnWorkers(source(), spawnThread, timers, 2);
    const done = p.prove(bytes(1), circuit(1));
    const failed = p.prove(bytes(2), circuit(2));
    void failed.catch(() => {});
    AThread.made[0]!.says({ op: 'ready' });
    AThread.made[1]!.says({ op: 'ready' });
    expect(timers.count).toBe(2);
    AThread.made[1]!.says({ op: 'failure', error: 'no proof' });
    expect(timers.count).toBe(1);
    AThread.made[0]!.says({ op: 'result', value: bytes(5) });
    await done;
    expect(timers.count).toBe(1);

    const other = p.prove(bytes(3), circuit(3));
    finishes(AThread.made[2]!);
    await other;
    expect(p.idle).toBe(2);
    expect(timers.count).toBe(2);
    p.stop();

    expect(p.idle).toBe(0);
    expect(timers.count).toBe(0);
    expect(AThread.made.every((t) => t.terminated)).toBe(true);
  });

  /* RED WHEN: a thread is kept after the page stopped. */
  it('a proof that ends after the page stopped lets its thread go and keeps nothing', async () => {
    const timers = handTimers();
    const p = provingOnWorkers(source(), spawnThread, timers, 2);
    const proof = p.prove(bytes(1), circuit(1));
    AThread.made[0]!.says({ op: 'ready' });
    p.stop();
    AThread.made[0]!.says({ op: 'result', value: bytes(5) });
    await proof;

    expect(AThread.made[0]!.terminated).toBe(true);
    expect(p.idle).toBe(0);
    expect(timers.count).toBe(0);
  });
});

describe('A PROOF IS GIVEN TEN MINUTES OF SILENCE, AND A REFUSED KEY IS SAID AS IT WAS REFUSED', () => {
  const MINUTE = 60_000;
  const outcome = (proof: Promise<unknown>) => proof.then(() => 'proved', (e: unknown) => e);

  /* RED WHEN: ten minutes run from the start of the proof while its thread waits for a key. */
  it('a thread that asks the page for its key is given ten more minutes from the ask', async () => {
    const clock = clockTimers();
    const s = source();
    s.lookupKey.mockImplementation(() => new Promise<never>(() => {}));
    const proof = outcome(new Promise((resolve) => { resolve(provingOnWorkers(s, spawnThread, clock, 1).prove(bytes(1), circuit(1))); }));
    const t = AThread.made[0]!;
    t.says({ op: 'ready' });
    clock.advance(9 * MINUTE);
    t.says({ op: 'lookupKey', askId: 0, keyLocation: circuit(1) });
    clock.advance(9 * MINUTE);

    expect(t.terminated).toBe(false);
    clock.advance(MINUTE + 1);
    expect(t.terminated).toBe(true);
    expect(((await proof) as Error).message).toMatch(/took more than ten minutes/u);
  });

  /* RED WHEN: the arrival of a key does not give the proof ten more minutes. */
  it('a thread whose key arrives after nine minutes is given ten more minutes from the answer', async () => {
    const clock = clockTimers();
    const s = source();
    let arrive: (v: never) => void = () => {};
    s.lookupKey.mockImplementation(() => new Promise<never>((resolve) => { arrive = resolve; }));
    const p = provingOnWorkers(s, spawnThread, clock, 1);
    const proof = outcome(p.prove(bytes(1), circuit(1)));
    const t = AThread.made[0]!;
    t.says({ op: 'ready' });
    t.says({ op: 'lookupKey', askId: 0, keyLocation: circuit(1) });
    clock.advance(9 * MINUTE);
    arrive({ loc: circuit(1) } as never);
    await settle();
    clock.advance(9 * MINUTE);

    expect(t.terminated).toBe(false);
    clock.advance(MINUTE + 1);
    expect(t.terminated).toBe(true);
    expect(((await proof) as Error).message).toMatch(/took more than ten minutes/u);
  });

  /* RED WHEN: ten minutes run from the start of the proof while its thread waits for a size. */
  it('a thread that asks for its size is given ten more minutes from the ask', async () => {
    const clock = clockTimers();
    const p = provingOnWorkers(source(), spawnThread, clock, 1);
    const proof = outcome(p.prove(bytes(1), circuit(1)));
    const t = AThread.made[0]!;
    t.says({ op: 'ready' });
    clock.advance(9 * MINUTE);
    t.says({ op: 'getParams', askId: 0, k: 15 });
    clock.advance(9 * MINUTE);

    expect(t.terminated).toBe(false);
    clock.advance(MINUTE + 1);
    expect(t.terminated).toBe(true);
    expect(((await proof) as Error).message).toMatch(/took more than ten minutes/u);
  });

  /* RED WHEN: a refused key gives the proof no more time, though its thread was heard from. */
  it('a thread whose key is refused after nine minutes is given ten more minutes from the refusal', async () => {
    const clock = clockTimers();
    const s = source();
    let refuse: (e: Error) => void = () => {};
    s.lookupKey.mockImplementation(() => new Promise<never>((_resolve, reject) => { refuse = reject; }));
    const p = provingOnWorkers(s, spawnThread, clock, 1);
    const proof = outcome(p.prove(bytes(1), circuit(1)));
    const t = AThread.made[0]!;
    t.says({ op: 'ready' });
    t.says({ op: 'lookupKey', askId: 0, keyLocation: circuit(1) });
    clock.advance(9 * MINUTE);
    refuse(new Error('this key is not served'));
    await settle();
    clock.advance(9 * MINUTE);

    expect(t.terminated).toBe(false);
    clock.advance(MINUTE + 1);
    expect(t.terminated).toBe(true);
    expect(((await proof) as Error).message).toMatch(/took more than ten minutes/u);
  });

  /* RED WHEN: a refusal of a key reaches the screen as a failure to work out the proof, or another failure is shown as a refusal. */
  it('a proof that failed because the device refused its key is rejected with that refusal, and any other failure is not', async () => {
    const s = source();
    const refusal = new ProvingMaterialRefused('other-bytes-served', circuit(1), 'The key served for this circuit is not this build\'s.');
    s.lookupKey.mockRejectedValueOnce(refusal).mockRejectedValueOnce(new Error('the network dropped'));
    const p = provingOnWorkers(s, spawnThread, handTimers(), 2);
    const refused = outcome(p.prove(bytes(1), circuit(1)));
    const dropped = outcome(p.prove(bytes(2), circuit(2)));
    const [a, b] = AThread.made as [AThread, AThread];
    a.says({ op: 'ready' }); b.says({ op: 'ready' });
    a.says({ op: 'lookupKey', askId: 0, keyLocation: circuit(1) });
    await settle();
    a.says({ op: 'failure', error: refusal.message });
    b.says({ op: 'lookupKey', askId: 0, keyLocation: circuit(2) });
    await settle();
    b.says({ op: 'failure', error: 'the network dropped' });

    expect(await refused).toBe(refusal);
    const other = (await dropped) as Error;
    expect(other).not.toBe(refusal);
    expect(other.message).toMatch(/^This device could not work out the proof/u);
  });
});
