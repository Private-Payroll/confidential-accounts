import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEPT_IDLE_MS, keptProvers, makeBrowserProvingService } from './proving.js';
import type { ProofEvent, ProvingWorkerLike } from './proving.js';

/*
 * **A WORKER THAT HAS PROVED IS KEPT FOR THE NEXT PROOF OF ITS CIRCUIT, AND
 * NOTHING ELSE ABOUT PROVING CHANGES.** Proofs that run together still get a
 * worker each; each answer goes back to the proof that asked; a worker that
 * failed is never used again; and the key material is always the asking
 * proof's.
 */

/** A worker the test answers for, recording what it was sent. */
class AWorker {
  static made: AWorker[] = [];
  readonly sent: unknown[] = [];
  terminated = false;
  private onMessage: ((e: { data: never }) => void)[] = [];
  private onError: ((e: { message?: string }) => void)[] = [];
  constructor() { AWorker.made.push(this); }
  postMessage(m: unknown): void { this.sent.push(m); }
  addEventListener(type: 'message' | 'error', l: (e: { data: never } & { message?: string }) => void): void {
    if (type === 'message') this.onMessage.push(l as (e: { data: never }) => void);
    else this.onError.push(l as (e: { message?: string }) => void);
  }
  terminate(): void { this.terminated = true; }
  says(data: unknown): void { for (const l of this.onMessage) l({ data } as never); }
  breaks(message: string): void { for (const l of this.onError) l({ message }); }
  /** The work orders this worker was sent, without the key-material answers. */
  get orders(): unknown[] { return this.sent.filter((m) => (m as { op: string }).op !== 'answer'); }
}

const km = (name: string) => ({
  lookupKey: vi.fn(async (loc: string) => ({ proverKey: new Uint8Array([1]), verifierKey: new Uint8Array([2]), ir: new Uint8Array([3]), from: name, loc }) as never),
  getParams: vi.fn(async (k: number) => new Uint8Array([k])),
});
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
const SPEND = 'midnight/zswap/spend';
const OUTPUT = 'midnight/zswap/output';

afterEach(() => { AWorker.made = []; vi.useRealTimers(); });

describe('THE WALLET\'S PROVERS, KEPT BETWEEN PROOFS', () => {
  it('proofs asked together each get a worker, and each answer goes back to the proof that asked', async () => {
    const provers = keptProvers(() => new AWorker() as unknown as ProvingWorkerLike);
    const spend = provers.run('prove', SPEND, new Uint8Array([1]), km('a'));
    const output = provers.run('prove', OUTPUT, new Uint8Array([2]), km('a'));
    /* RED WHEN: proofs asked together are made to wait for one another on one worker. */
    expect(AWorker.made).toHaveLength(2);
    const [w1, w2] = AWorker.made as [AWorker, AWorker];
    w1.says({ op: 'ready' }); w2.says({ op: 'ready' });
    expect(w1.orders).toEqual([{ op: 'prove', preimage: new Uint8Array([1]), overwriteBindingInput: undefined }]);
    /* The second finishes first. */
    w2.says({ op: 'result', value: 'output proof' });
    w1.says({ op: 'result', value: 'spend proof' });
    /* RED WHEN: answers cross, and a proof lands in the wrong place in the transaction - a faster proof that is not the same transaction. */
    expect(await spend).toBe('spend proof');
    expect(await output).toBe('output proof');
  });

  it('the next proof of the same circuit reuses the worker that has its key, and posts at once', async () => {
    const provers = keptProvers(() => new AWorker() as unknown as ProvingWorkerLike);
    const first = provers.run('prove', SPEND, new Uint8Array([1]), km('a'));
    const w = AWorker.made[0]!;
    w.says({ op: 'ready' });
    w.says({ op: 'result', value: 'one' });
    await first;
    expect(provers.idle).toBe(1);
    const second = provers.run('prove', SPEND, new Uint8Array([9]), km('b'));
    /* RED WHEN: every proof starts a new worker and reads its key again - the 6 to 14 seconds this keeps. */
    expect(AWorker.made).toHaveLength(1);
    expect(w.orders).toHaveLength(2);
    w.says({ op: 'result', value: 'two' });
    expect(await second).toBe('two');
    /* A proof of another circuit is not handed a worker that holds the wrong key. */
    const other = provers.run('prove', OUTPUT, new Uint8Array([3]), km('a'));
    expect(AWorker.made).toHaveLength(2);
    AWorker.made[1]!.says({ op: 'ready' });
    AWorker.made[1]!.says({ op: 'result', value: 'three' });
    expect(await other).toBe('three');
  });

  it('asks the key material of the proof it is working on, and of no other', async () => {
    const provers = keptProvers(() => new AWorker() as unknown as ProvingWorkerLike);
    const a = km('a'); const b = km('b');
    const first = provers.run('prove', SPEND, new Uint8Array([1]), a);
    const w = AWorker.made[0]!;
    w.says({ op: 'ready' });
    w.says({ op: 'getParams', askId: 0, k: 14 });
    await settle();
    expect(a.getParams).toHaveBeenCalledWith(14);
    w.says({ op: 'result', value: 'one' });
    await first;
    const second = provers.run('prove', SPEND, new Uint8Array([2]), b);
    w.says({ op: 'getParams', askId: 7, k: 15 });
    await settle();
    /* RED WHEN: a kept worker keeps answering from the material of the proof it was first made for. */
    expect(b.getParams).toHaveBeenCalledWith(15);
    expect(a.getParams).toHaveBeenCalledTimes(1);
    expect(w.sent.at(-1)).toEqual({ op: 'answer', askId: 7, ok: true, value: new Uint8Array([15]) });
    w.says({ op: 'result', value: 'two' });
    await second;
  });

  it('a worker whose proof failed, or that broke, is never given another proof', async () => {
    const provers = keptProvers(() => new AWorker() as unknown as ProvingWorkerLike);
    const failed = provers.run('prove', SPEND, new Uint8Array([1]), km('a'));
    AWorker.made[0]!.says({ op: 'ready' });
    AWorker.made[0]!.says({ op: 'failure', error: 'the circuit did not hold' });
    await expect(failed).rejects.toThrow('the circuit did not hold');
    /* RED WHEN: a worker left in an unknown state by a failed proof is kept. */
    expect(AWorker.made[0]!.terminated).toBe(true);
    expect(provers.idle).toBe(0);
    const broken = provers.run('prove', SPEND, new Uint8Array([2]), km('a'));
    AWorker.made[1]!.breaks('out of memory');
    await expect(broken).rejects.toThrow('out of memory');
    /* RED WHEN: a worker that broke is left running beside the next one. */
    expect(AWorker.made[1]!.terminated).toBe(true);
    const next = provers.run('prove', SPEND, new Uint8Array([3]), km('a'));
    expect(AWorker.made).toHaveLength(3);
    AWorker.made[2]!.says({ op: 'ready' });
    AWorker.made[2]!.says({ op: 'result', value: 'fine' });
    expect(await next).toBe('fine');
  });

  it('keeps one idle worker per circuit, lets it go after the idle time, and lets them all go on stop', async () => {
    vi.useFakeTimers();
    const provers = keptProvers(() => new AWorker() as unknown as ProvingWorkerLike);
    const a = provers.run('prove', SPEND, new Uint8Array([1]), km('a'));
    const b = provers.run('prove', SPEND, new Uint8Array([2]), km('a'));
    for (const w of AWorker.made) { w.says({ op: 'ready' }); w.says({ op: 'result', value: 'x' }); }
    await a; await b;
    /* RED WHEN: every finished worker is kept, holding the memory it proved in. */
    expect(provers.idle).toBe(1);
    expect(AWorker.made.filter((w) => w.terminated)).toHaveLength(1);
    vi.advanceTimersByTime(KEPT_IDLE_MS + 1);
    /* RED WHEN: an idle worker is kept for as long as the page is open. */
    expect(provers.idle).toBe(0);
    expect(AWorker.made.every((w) => w.terminated)).toBe(true);
    const c = provers.run('prove', OUTPUT, new Uint8Array([3]), km('a'));
    AWorker.made[2]!.says({ op: 'ready' }); AWorker.made[2]!.says({ op: 'result', value: 'y' });
    await c;
    provers.stop();
    expect(AWorker.made[2]!.terminated).toBe(true);
  });

  it('the proving service says each proof starting and ending, and passes the circuit the ledger names', async () => {
    const provers = keptProvers(() => new AWorker() as unknown as ProvingWorkerLike);
    const events: ProofEvent[] = [];
    const service = makeBrowserProvingService(km('a') as never, { provers, onProof: (e) => events.push(e) });
    let provider: { prove(p: Uint8Array, k: string, b?: bigint): Promise<unknown>; check(p: Uint8Array, k: string): Promise<unknown> } | null = null;
    await service.prove({ prove: (p: never) => { provider = p; return Promise.resolve('proved'); } } as never);
    const proof = provider!.prove(new Uint8Array([5]), OUTPUT, 3n);
    /* RED WHEN: a proof starting is not said, so a wallet proving for ninety seconds looks like one that has gone. */
    expect(events).toEqual([{ op: 'prove', at: 'start' }]);
    AWorker.made[0]!.says({ op: 'ready' });
    expect(AWorker.made[0]!.orders).toEqual([{ op: 'prove', preimage: new Uint8Array([5]), overwriteBindingInput: 3n }]);
    AWorker.made[0]!.says({ op: 'result', value: new Uint8Array([6]) });
    await proof;
    expect(events).toEqual([{ op: 'prove', at: 'start' }, { op: 'prove', at: 'end' }]);
    const failing = provider!.check(new Uint8Array([7]), OUTPUT);
    AWorker.made[0]!.says({ op: 'failure', error: 'no' });
    await expect(failing).rejects.toThrow('no');
    /* RED WHEN: a proof that failed is never said to have ended, and the stage stays "proving" for a wallet that has stopped. */
    expect(events.slice(2)).toEqual([{ op: 'check', at: 'start' }, { op: 'check', at: 'end' }]);
  });
});
