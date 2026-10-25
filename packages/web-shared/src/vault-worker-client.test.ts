import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vaultBuilderOver, vaultBuilderOnWorkers, VaultAskFailed } from './vault-worker-client.js';
import { startVaultWorker, toldOfEachCall, provingToldOf, loadDeps, provingWarmed, type WorkerDeps } from './vault-worker-entry.js';
import { SERVICE_READ_BOUND_MS } from './read-bound.js';
import { ProvingMaterialRefused, type ArtefactSource } from './key-material.js';
import { PROOF_CEILING_MS } from './vault-proof-workers.js';
import { existsSync } from 'node:fs';
/* The loader fetches a key only for a circuit this build has digests for: a build without its compiled keys (CI's test job) runs this in its keys job. */
const HAS_KEYS = existsSync(new URL('../../../contracts/managed-vault/keys/retire.verifier', import.meta.url))
  && existsSync(new URL('../../../contracts/managed/keys/adopt.verifier', import.meta.url));

/*
 * The page's side of the vault worker, over a worker that does nothing on its
 * own: each test says what the worker says, and when. Time is the fake clock's.
 */
const NET = 'undeployed';
type Listener = (event: any) => void;
interface FakeWorker {
  posted: any[];
  terminated: boolean;
  addEventListener(type: string, l: Listener): void;
  removeEventListener(type: string, l: Listener): void;
  postMessage(m: unknown): void;
  terminate(): void;
  says(data: unknown): void;
  fails(type: 'error' | 'messageerror'): void;
  answers(i?: number, value?: string): void;
}
const aWorker = (): FakeWorker => {
  const on: Record<string, Listener[]> = { message: [], error: [], messageerror: [] };
  const w: FakeWorker = {
    posted: [] as any[],
    terminated: false,
    addEventListener: (type: string, l: Listener) => { on[type]!.push(l); },
    removeEventListener: (type: string, l: Listener) => { on[type] = on[type]!.filter((x) => x !== l); },
    postMessage: (m: unknown) => { w.posted.push(m); },
    terminate: () => { w.terminated = true; },
    says: (data: unknown) => { for (const l of [...on.message!]) l({ data }); },
    fails: (type: 'error' | 'messageerror') => { for (const l of [...on[type]!]) l({ message: 'the thread stopped' }); },
    answers: (i = w.posted.length - 1, value = 'answered') => {
      const m = w.posted[i];
      w.says({ id: m.id, ok: true, ask: m.ask, value });
    },
  };
  return w;
};
const settle = () => vi.advanceTimersByTimeAsync(0);
const MINUTE = 60_000;

/** A client over workers this test starts, and every worker it started. */
const aClient = () => {
  const started: FakeWorker[] = [];
  const client = vaultBuilderOnWorkers(() => { const w = aWorker(); started.push(w); return w; }, NET);
  return { client, started };
};
/** Asks, and lets the first (or next) worker say it is ready. */
const asked = async (c: ReturnType<typeof aClient>, ready = true) => {
  const outcome: { value?: unknown; error?: unknown; done: boolean } = { done: false };
  const promise = c.client.companyWide().then(
    (v) => { outcome.value = v; outcome.done = true; },
    (e) => { outcome.error = e; outcome.done = true; },
  );
  await settle();
  const w = c.started[c.started.length - 1]!;
  if (ready && w.posted.length === 0) { w.says({ kind: 'vault-worker-ready' }); await settle(); }
  return { outcome, promise, worker: w };
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('EVERY ASK OF THE VAULT WORKER ANSWERS OR FAILS WITH A REASON', () => {
  it('a worker that says nothing for ten minutes fails every waiting ask, and is stopped', async () => {
    /* RED WHEN: an ask has no time limit - a worker that went quiet leaves the page waiting for ever. */
    const c = aClient();
    const one = await asked(c);
    const two = await asked(c);
    expect(one.worker.posted).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(PROOF_CEILING_MS - 1);
    expect(one.outcome.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    for (const a of [one, two]) {
      expect(a.outcome.error).toBeInstanceOf(VaultAskFailed);
      expect((a.outcome.error as VaultAskFailed).reason).toBe('took-too-long');
      expect((a.outcome.error as VaultAskFailed).ask).toBe('company-wide');
    }
    expect(one.worker.terminated).toBe(true);
  });

  it('a proof that starts nine minutes in has its own ten minutes', async () => {
    /* RED WHEN: the worker's word about a running proof does not restart the time limit - a long proof is stopped half way. */
    const c = aClient();
    const a = await asked(c);
    const id = a.worker.posted[0].id;
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    a.worker.says({ kind: 'vault-proof', id, ask: 'company-wide', circuit: 'payout', state: 'started' });
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(a.outcome.done).toBe(false);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect((a.outcome.error as VaultAskFailed).reason).toBe('took-too-long');
  });

  it('two proofs in one ask, fifteen minutes in all, are answered', async () => {
    /* RED WHEN: one ask has one time limit - a company's deploy and its second step, proved in turn, never finish. */
    const c = aClient();
    const a = await asked(c);
    const id = a.worker.posted[0].id;
    const word = (state: string) => a.worker.says({ kind: 'vault-proof', id, ask: 'company-wide', circuit: null, state });
    word('started');
    await vi.advanceTimersByTimeAsync(8 * MINUTE);
    word('ended');
    word('started');
    await vi.advanceTimersByTimeAsync(7 * MINUTE);
    word('ended');
    a.worker.answers(0, 'both proved');
    await settle();
    expect(a.outcome.value).toBe('both proved');
  });

  it('an ask waiting behind another ask\'s proof is not failed while that proof runs', async () => {
    /* RED WHEN: each ask is timed only by words about itself - a read waiting behind a long proof stops the worker and the proof with it. */
    const c = aClient();
    const reading = await asked(c);
    const proving = await asked(c);
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    proving.worker.says({ kind: 'vault-proof', id: proving.worker.posted[1].id, ask: 'company-wide', circuit: 'payout', state: 'started' });
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(reading.outcome.done).toBe(false);
    expect(reading.worker.terminated).toBe(false);
  });

  it('a download of proving material nine minutes in restarts the time limit', async () => {
    /* RED WHEN: the worker's word about a fetch of a key or the parameters is not heard - a slow download fails a proof that is still working. */
    const c = aClient();
    const a = await asked(c);
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    a.worker.says({ kind: 'vault-worker-busy' });
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(a.outcome.done).toBe(false);
  });

  it('an ask that is never answered fails at the time limit while other asks keep being answered', async () => {
    /* RED WHEN: an answer to another ask restarts every window - a deposit whose build never finishes waits for as long as the page keeps reading. */
    const c = aClient();
    const stuck = await asked(c);
    for (let minute = 1; minute < 10; minute += 1) {
      await vi.advanceTimersByTimeAsync(MINUTE);
      const read = await asked(c);
      read.worker.answers(read.worker.posted.length - 1);
      await settle();
      expect(read.outcome.value).toBe('answered');
    }
    expect(stuck.outcome.done).toBe(false);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect((stuck.outcome.error as VaultAskFailed).reason).toBe('took-too-long');
  });

  it('the time limit is checked once when it is due, not over and over after each word', async () => {
    /* RED WHEN: the time limit is scheduled from an ask's posting alone, or a word leaves the timer before it running - the page runs timers with no delay, or one more for every word. */
    const c = aClient();
    const a = await asked(c);
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    a.worker.says({ kind: 'vault-worker-busy' });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(timers.mock.calls.length).toBeLessThanOrEqual(2);
    timers.mockRestore();
    for (let word = 0; word < 10; word += 1) {
      a.worker.says({ kind: 'vault-worker-busy' });
      await vi.advanceTimersByTimeAsync(MINUTE);
    }
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2);
    expect(a.outcome.done).toBe(false);
  });

  it('an ask posted after the worker was quiet for longer than the limit has its own ten minutes', async () => {
    /* RED WHEN: an ask's window is taken from the worker's last word alone - a deposit started on a page left open fails at once. */
    const c = aClient();
    const first = await asked(c);
    first.worker.answers(0);
    await settle();
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    const later = await asked(c);
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(later.outcome.done).toBe(false);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect((later.outcome.error as VaultAskFailed).reason).toBe('took-too-long');
  });

  it('an answer to a different kind of ask is refused, never handed over as this one', async () => {
    /* RED WHEN: an answer is matched by its number alone - a caller is handed another ask's result as its own. */
    const c = aClient();
    const a = await asked(c);
    a.worker.says({ id: a.worker.posted[0].id, ok: true, ask: 'deploy', vault: 'v', temporaryKey: {}, tx: 't' });
    await settle();
    expect((a.outcome.error as Error).message).toBe('the vault worker answered a different question.');
  });

  it('an ask answered while its proof is still said to run is no longer shown as proving', async () => {
    /* RED WHEN: an answered ask's proof stays in what the page reads - the clock runs on for a proof that is done. */
    const c = aClient();
    const a = await asked(c);
    a.worker.says({ kind: 'vault-proof', id: a.worker.posted[0].id, ask: 'company-wide', circuit: 'payout', state: 'started' });
    a.worker.answers(0);
    await settle();
    expect(c.client.proofsInProgress!()).toEqual([]);
  });

  it('a worker that stops after it started fails every waiting ask, and so does an answer the page cannot read', async () => {
    /* RED WHEN: the worker's error after it started is not heard - an ask waits for ever on a worker that is gone. */
    for (const [type, reason] of [['error', 'stopped'], ['messageerror', 'unreadable-answer']] as const) {
      const c = aClient();
      const one = await asked(c);
      const two = await asked(c);
      one.worker.fails(type);
      await settle();
      expect((one.outcome.error as VaultAskFailed).reason).toBe(reason);
      expect((two.outcome.error as VaultAskFailed).reason).toBe(reason);
      expect(one.worker.terminated).toBe(true);
    }
  });

  it('the next ask after a failure starts a new worker and is answered', async () => {
    /* RED WHEN: a stopped worker is kept - every ask after the first failure fails too, until the page is reloaded. */
    const c = aClient();
    const first = await asked(c);
    first.worker.fails('error');
    await settle();
    const next = await asked(c);
    expect(c.started).toHaveLength(2);
    expect(next.worker).not.toBe(first.worker);
    next.worker.answers();
    await settle();
    expect(next.outcome.value).toBe('answered');
  });

  it('a new worker that never says it is ready fails the ask that started it after thirty seconds', async () => {
    /* RED WHEN: a replacement worker that never starts is waited for without a limit. */
    const c = aClient();
    const first = await asked(c);
    first.worker.fails('error');
    await settle();
    const next = await asked(c, false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((next.outcome.error as VaultAskFailed).reason).toBe('did-not-start');
    expect(next.worker.terminated).toBe(true);
  });

  it('the worker\'s word about a proof is never taken for the answer', async () => {
    /* RED WHEN: any message carrying an ask's id is taken for its answer - the page reads a proof's start as a failed ask. */
    const c = aClient();
    const a = await asked(c);
    a.worker.says({ kind: 'vault-proof', id: a.worker.posted[0].id, ask: 'company-wide', circuit: 'payout', state: 'started' });
    await settle();
    expect(a.outcome.done).toBe(false);
    a.worker.answers(0, 'the answer');
    await settle();
    expect(a.outcome.value).toBe('the answer');
  });

  it('the page reads how long a running proof has run, and nothing once it ends or fails', async () => {
    /* RED WHEN: the page cannot read a proof in progress - a screen has no clock to show while a device proves. */
    const c = aClient();
    const a = await asked(c);
    const id = a.worker.posted[0].id;
    a.worker.says({ kind: 'vault-proof', id, ask: 'company-wide', circuit: 'payout', state: 'started' });
    const startedAt = Date.now();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(c.client.proofsInProgress!()).toEqual([{ ask: 'company-wide', circuit: 'payout', startedAt, elapsedMs: 90_000 }]);
    a.worker.says({ kind: 'vault-proof', id, ask: 'company-wide', circuit: 'payout', state: 'ended' });
    expect(c.client.proofsInProgress!()).toEqual([]);
    a.worker.says({ kind: 'vault-proof', id, ask: 'company-wide', circuit: 'payout', state: 'started' });
    a.worker.fails('error');
    await settle();
    expect(c.client.proofsInProgress!()).toEqual([]);
  });

  it('a refusal the worker answered with keeps its words, its name and its kind', async () => {
    /* RED WHEN: the worker's error reaches the page as a bare message - an approval already made reads as a failure, and a key not this build's reads like any other. */
    const c = aClient();
    const a = await asked(c);
    a.worker.says({ id: a.worker.posted[0].id, ok: false, error: 'you have already approved this proposal', name: 'CallNotBuilt' });
    await settle();
    const e = a.outcome.error as VaultAskFailed;
    expect(e).toBeInstanceOf(VaultAskFailed);
    expect([e.reason, e.name, e.message, e.kind]).toEqual(['answered', 'CallNotBuilt', 'you have already approved this proposal', undefined]);
    const b = await asked(c);
    b.worker.says({ id: b.worker.posted[1].id, ok: false, error: 'the key is not this build\'s', name: 'ProvingMaterialRefused', kind: 'not-this-builds-circuit' });
    await settle();
    expect([(b.outcome.error as VaultAskFailed).kind, (b.outcome.error as VaultAskFailed).workerName]).toEqual(['not-this-builds-circuit', 'ProvingMaterialRefused']);
  });

  it('what a stopped worker still says is not heard', async () => {
    /* RED WHEN: a stopped worker's late answer is matched to a new ask by its number. */
    const c = aClient();
    const first = await asked(c);
    first.worker.fails('error');
    await settle();
    const next = await asked(c);
    first.worker.says({ id: next.worker.posted[0].id, ok: true, ask: 'company-wide', value: 'from the stopped worker' });
    await settle();
    expect(next.outcome.done).toBe(false);
  });

  it('a client over a worker that is already running listens to its messages only, and still has the time limit', async () => {
    /* RED WHEN: the client over a running worker listens for its errors too - a test worker that ignores the event name reads every answer as a stop. */
    const listeners: Listener[] = [];
    const posted: any[] = [];
    const client = vaultBuilderOver({
      addEventListener: (_t: 'message', l: Listener) => { listeners.push(l); },
      postMessage: (m: unknown) => { posted.push(m); },
    }, NET);
    const answered = client.companyWide();
    await settle();
    expect(listeners).toHaveLength(1);
    listeners.forEach((l) => l({ data: { id: posted[0].id, ok: true, ask: 'company-wide', value: 'v' } }));
    await expect(answered).resolves.toBe('v');
    const silent = client.companyWide().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PROOF_CEILING_MS);
    expect(((await silent) as VaultAskFailed).reason).toBe('took-too-long');
  });
});

describe('THE WORKER TELLS THE PAGE WHAT IT IS DOING', () => {
  it('each proof is told to the page as it starts and ends, under the ask it belongs to', async () => {
    /* RED WHEN: a proof is not told to the page - the page's time limit stops a proof that is still working. */
    const said: unknown[] = [];
    let finish: (v: { serialize(): Uint8Array }) => void = () => {};
    const deps = async () => ({ prove: () => new Promise<{ serialize(): Uint8Array }>((r) => { finish = r; }) }) as never;
    const d = await provingToldOf(deps, { id: 7, ask: 'payout' } as never, (m) => said.push(m))();
    const proof = (d as { prove(u: unknown, c?: string): Promise<unknown> }).prove({}, 'payout');
    expect(said).toEqual([{ kind: 'vault-proof', id: 7, ask: 'payout', circuit: 'payout', state: 'started' }]);
    finish({ serialize: () => new Uint8Array() });
    await proof;
    expect(said).toEqual([
      { kind: 'vault-proof', id: 7, ask: 'payout', circuit: 'payout', state: 'started' },
      { kind: 'vault-proof', id: 7, ask: 'payout', circuit: 'payout', state: 'ended' },
    ]);
  });

  it('each fetch of proving material is told once as it starts and once as it ends, even when it is refused', async () => {
    /* RED WHEN: a fetch of a key is not told - a slow download on the device reads as a worker that went quiet. */
    let words = 0;
    const source: ArtefactSource = {
      lookupKey: async () => undefined,
      getParams: async () => { throw new Error('refused'); },
      artefact: async () => new Uint8Array(),
    };
    const told = toldOfEachCall(source, () => { words += 1; });
    await told.lookupKey('payout');
    expect(words).toBe(2);
    await expect(told.getParams(14)).rejects.toThrow('refused');
    expect(words).toBe(4);
    await told.artefact('verifier', 'payout');
    expect(words).toBe(6);
  });

  it('a key refused during a proof reaches the page as that refusal, with its kind, though the prover passed it on as text', async () => {
    /* RED WHEN: a refusal the prover turned into text is answered as plain text - the page cannot tell a key not this build's from any other failure. */
    const refusal = new ProvingMaterialRefused('other-bytes-served', 'payout',
      'the proving key served for the vault\'s payout circuit is not this build\'s, so nothing was proved or sent.');
    const told = toldOfEachCall({
      lookupKey: async () => { throw refusal; },
      getParams: async () => new Uint8Array(),
      artefact: async () => new Uint8Array(),
    }, () => {});
    const deps = async () => ({
      prove: async () => {
        try { await told.lookupKey('payout'); } catch (e) {
          throw `'check' returned an error: Error: lookupKey promise resolve to error: ${(e as Error).message}`;
        }
        return { serialize: () => new Uint8Array() };
      },
    }) as never;
    const d = await provingToldOf(deps, { id: 3, ask: 'payout' } as never, () => {})();
    const e = await (d as { prove(u: unknown, c?: string): Promise<unknown> }).prove({}, 'payout').catch((x: unknown) => x) as ProvingMaterialRefused;
    expect(e).toBeInstanceOf(ProvingMaterialRefused);
    expect([e.name, e.kind, e.keyLocation, e.message]).toEqual(['ProvingMaterialRefused', 'other-bytes-served', 'payout', refusal.message]);
    expect(String((e as { cause?: unknown }).cause)).toMatch(/lookupKey promise resolve to error/);
    /* The prover's own check passes the refusal on without its final full stop: it is still that refusal. */
    const unstopped = async () => ({
      prove: async () => {
        try { await told.lookupKey('payout'); } catch (x) {
          throw `'check' returned an error: Error: lookupKey promise resolve to error: ${(x as Error).message.replace(/\.\s*$/u, '')}`;
        }
        return { serialize: () => new Uint8Array() };
      },
    }) as never;
    const u = await provingToldOf(unstopped, { id: 5, ask: 'payout' } as never, () => {})();
    const stopless = await (u as { prove(x: unknown): Promise<unknown> }).prove({}).catch((x: unknown) => x) as ProvingMaterialRefused;
    expect(stopless).toBeInstanceOf(ProvingMaterialRefused);
    expect(stopless.kind).toBe('other-bytes-served');
    /* A later proof that fails with the same words, and met no refusal of its own, is left as it is. */
    const echoing = async () => ({ prove: async () => { throw `'check' returned an error: ${refusal.message}`; } }) as never;
    const later = await provingToldOf(echoing, { id: 6, ask: 'payout' } as never, () => {})();
    const echoed = await (later as { prove(x: unknown): Promise<unknown> }).prove({}).catch((x: unknown) => x);
    expect(echoed).toBe(`'check' returned an error: ${refusal.message}`);
    /* A failure whose text names only part of a refusal is left as it is. */
    const partly = async () => ({
      prove: async () => {
        await told.lookupKey('payout').catch(() => undefined);
        throw 'the proving key served for the vault\'s payout circuit';
      },
    }) as never;
    const p = await provingToldOf(partly, { id: 4, ask: 'payout' } as never, () => {})();
    const left = await (p as { prove(u: unknown): Promise<unknown> }).prove({}).catch((x: unknown) => x);
    expect(left).toBe('the proving key served for the vault\'s payout circuit');
  });

  it('an answer the worker cannot send goes back as a failure, and a refusal of proving material says its kind', async () => {
    /* RED WHEN: an answer that cannot be copied to the page is dropped - the ask is never answered. */
    const posted: any[] = [];
    let onMessage: Listener = () => {};
    let throwOnce = true;
    const scope = {
      addEventListener: (_t: string, l: Listener) => { onMessage = l; },
      postMessage: (m: any) => {
        if (m?.ok === true && throwOnce) { throwOnce = false; const e = new Error('could not be cloned'); e.name = 'DataCloneError'; throw e; }
        posted.push(m);
      },
    };
    let refuse = false;
    startVaultWorker(scope, async () => {
      if (refuse) throw new Error('nothing was proved', { cause: new ProvingMaterialRefused('other-bytes-served', 'payout', 'the bytes are not this build\'s') });
      return { accountPure: { companyWide: () => new Uint8Array([1]) } } as never;
    });
    onMessage({ data: { id: 1, ask: 'company-wide', network: NET } });
    await vi.waitFor(() => expect(posted.some((m) => m.id === 1)).toBe(true));
    expect(posted.find((m) => m.id === 1)).toMatchObject({ id: 1, ok: false, name: 'DataCloneError' });
    refuse = true;
    onMessage({ data: { id: 2, ask: 'company-wide', network: NET } });
    await vi.waitFor(() => expect(posted.some((m) => m.id === 2)).toBe(true));
    const refused = posted.find((m) => m.id === 2);
    expect(refused).toMatchObject({ id: 2, ok: false, kind: 'other-bytes-served' });
    expect(refused.name).toBeUndefined();
  });
});

/* The worker's own loader, over an origin that serves nothing: a fetch refused is told to the page all the same. */
describe('THE WORKER\'S OWN LOADER TELLS THE PAGE OF EVERY FETCH', () => {
  it.skipIf(!HAS_KEYS)('a verifying key fetched by the worker\'s loader is told to the page as it starts and ends, even when it is refused [needs contracts/managed-vault/keys and contracts/managed/keys; `npm run compact` then `npm run compact:vault -- --full` build them]', async () => {
    /* RED WHEN: the loader hands out its sources untold - every download on the device is silent, and a slow one fails at the time limit. */
    vi.useRealTimers();
    const posted: unknown[] = [];
    const fetchImpl = (async () => ({ ok: false, status: 404 }) as Response) as unknown as typeof fetch;
    const noStore = { open: () => { const r: any = {}; queueMicrotask(() => r.onerror?.()); return r; } };
    const deps = await loadDeps({ indexedDB: noStore, fetch: fetchImpl, console: { warn: () => {} }, postMessage: (m: unknown) => posted.push(m) })();
    const busy = () => posted.filter((m) => (m as { kind?: unknown }).kind === 'vault-worker-busy').length;
    expect(busy()).toBe(0);
    await expect((deps as any).zkConfig.getVerifierKey('retire')).rejects.toThrow();
    expect(busy()).toBe(2);
    await expect(deps.vaultKeys.getVerifierKey('retire')).rejects.toThrow();
    expect(busy()).toBe(4);
    await expect(deps.accountKeys.getVerifierKey('adopt')).rejects.toThrow();
    expect(busy()).toBe(6);
  }, 60_000);
});

/*
 * The page's client over the worker's own ask handling, as a page reaches it: what one side posts the other hears a
 * turn later, and the worker's code loads when its first ask arrives, as the page's worker's does. Time is the fake
 * clock's; the worker's code takes LOAD_MS to load.
 */
describe('A READ IS TIMED FROM WHEN THE WORKER STARTS IT, NOT FROM WHEN THE WORKER STARTS LOADING', () => {
  const LOAD_MS = 25_000;
  const indexer = { indexerUri: 'https://i.example/graphql', indexerWsUri: 'wss://i.example/ws' };
  const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => { setTimeout(() => resolve(value), ms); });
  const overTheWorker = (made: Partial<WorkerDeps>) => {
    let loading: Promise<WorkerDeps> | null = null;
    const deps = () => (loading ??= later(LOAD_MS, made as WorkerDeps));
    return vaultBuilderOnWorkers(() => {
      const page = aWorker();
      const inside: Listener[] = [];
      const scope = {
        addEventListener: (_t: string, l: Listener) => { inside.push(l); },
        postMessage: (m: unknown) => { queueMicrotask(() => page.says(m)); },
      };
      page.postMessage = (m: unknown) => { queueMicrotask(() => { for (const l of inside) l({ data: m }); }); };
      queueMicrotask(() => startVaultWorker(scope, deps));
      return page;
    }, NET);
  };
  const outcomeOf = <T>(p: Promise<T>) => {
    const o: { done: boolean; value?: T; error?: unknown } = { done: false };
    p.then((v) => { o.done = true; o.value = v; }, (e: unknown) => { o.done = true; o.error = e; });
    return o;
  };
  /* What the worker loads for an ask, loaded once here so the fake clock alone decides when the ask goes on. */
  beforeEach(async () => {
    vi.useRealTimers();
    await import('./vault-on-chain-here.js');
    await import('@midnight-ntwrk/midnight-js-network-id');
    vi.useFakeTimers();
  });

  it('a read the worker answers in three seconds is answered, though the worker took longer than the read\'s twenty seconds to load', async () => {
    /* RED WHEN: the read's twenty seconds start when it is posted - the worker's loading uses them up and an account
     * that is on the chain cannot be opened after a refresh. */
    const client = overTheWorker({ chainSourceAt: () => ({ events: { eventsOf: () => later(3_000, []) } }) as never });
    const read = outcomeOf(client.eventsOf({ transactionHash: 'cc', indexer }));
    await vi.advanceTimersByTimeAsync(LOAD_MS + 2_999);
    expect(read.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(read.error).toBeUndefined();
    expect(read).toEqual({ done: true, value: [] });
  });

  it('a read that itself takes longer than twenty seconds still ends at twenty seconds, with the same words', async () => {
    /* RED WHEN: a read the worker has started is no longer held to twenty seconds, or ends without saying what did not answer. */
    const client = overTheWorker({ chainSourceAt: () => ({ events: { eventsOf: () => new Promise(() => {}) } }) as never });
    const read = outcomeOf(client.eventsOf({ transactionHash: 'cc', indexer }));
    await vi.advanceTimersByTimeAsync(LOAD_MS + SERVICE_READ_BOUND_MS - 1);
    expect(read.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(read.done).toBe(true);
    expect((read.error as Error).message).toMatch(/^The network \(events-of\) did not answer within 20 seconds/);
  });

  const warming = (eventsOf: () => Promise<unknown>) => {
    const fetchedAt: number[] = [];
    const fetched = async () => { fetchedAt.push(Date.now()); return new Uint8Array(1); };
    const source = { lookupKey: async () => undefined, getParams: fetched, artefact: fetched };
    const client = overTheWorker({
      chainSourceAt: () => ({ events: { eventsOf } }) as never,
      provingWarmed: () => provingWarmed(source, () => 10),
    });
    return { client, fetchedAt };
  };

  it('the proving warm-up started at sign-in waits while a read is under way, and goes on once it has answered', async () => {
    /* RED WHEN: the warm-up's downloads run beside the first read in the worker and slow it past its twenty seconds. */
    const t0 = Date.now();
    const { client, fetchedAt } = warming(() => later(3_000, []));
    const warm = outcomeOf(client.provingWarmed!());
    await settle();
    const read = outcomeOf(client.eventsOf({ transactionHash: 'cc', indexer }));
    await vi.advanceTimersByTimeAsync(LOAD_MS + 2_999);
    expect(fetchedAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(read).toEqual({ done: true, value: [] });
    expect(fetchedAt.length).toBeGreaterThan(0);
    expect(Math.min(...fetchedAt) - t0).toBeGreaterThanOrEqual(LOAD_MS + 3_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(warm).toEqual({ done: true, value: undefined });
  });

  it('a read that never ends holds the warm-up back for twenty seconds and no longer', async () => {
    /* RED WHEN: the warm-up waits on a read with no end, and proving is never made ready. */
    const t0 = Date.now();
    const { client, fetchedAt } = warming(() => new Promise(() => {}));
    const warm = outcomeOf(client.provingWarmed!());
    await settle();
    void client.eventsOf({ transactionHash: 'cc', indexer }).catch(() => {});
    await vi.advanceTimersByTimeAsync(LOAD_MS + SERVICE_READ_BOUND_MS - 1);
    expect(fetchedAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchedAt.length).toBeGreaterThan(0);
    expect(Math.min(...fetchedAt) - t0).toBeLessThanOrEqual(LOAD_MS + SERVICE_READ_BOUND_MS + 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(warm.done).toBe(true);
  });
});
