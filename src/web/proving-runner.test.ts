/**
 * **WHAT A DEVICE THAT PROVES IS ALLOWED TO DO, AND HOW IT SENDS.**
 *
 * The four steps of a job cost different things. Building and proving are pure:
 * they reach no chain, spend nothing, and an interruption costs time. Balancing
 * books coins, and submitting may settle whether or not anybody is still
 * watching.
 *
 * **THIS RUNNER DOES THE PURE HALF ON THE DEVICE AND HANDS THE PROVEN
 * TRANSACTION TO THE SERVICE**, which balances, pays and submits or refuses.
 * The cases here hold what leaves the device and how the service's answer is
 * read - a refusal is final, a failed submission is not.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { provingRunner, type ProvingCapability, type SendProven } from './proving-runner.js';
import { preimageOver, sendOver } from './proving-worker-entry.js';
import { NothingWasSent, saysNothingWasSent, type Job } from '../core/jobs.js';

const job = (payload: Record<string, unknown> = {}): Job => ({
  id: 'job_1', accountId: 'acc_1', kind: 'approve', state: 'queued', signerId: 'sgn_1',
  payload, attempts: 0, createdAt: 'x', updatedAt: 'x',
});

const capability = (over: Partial<ProvingCapability> = {}) => {
  const proved: unknown[] = [];
  const built: number[] = [];
  const it: ProvingCapability = {
    preimageFor: async () => ({ circuit: 'propose', unprovenTransaction: new Uint8Array([1, 2, 3]) }),
    keyMaterial: { lookupKey: async () => undefined, getParams: async () => new Uint8Array() },
    transactionCodec: async () => ({
      deserializeUnproven: (raw) => ({ unproven: [...raw] }),
      serializeProven: (tx) => new Uint8Array([(tx as { proven?: number }).proven ?? 0, 42]),
    }),
    proofProvider: async () => {
      built.push(1);
      return { proveTx: async (tx, cfg) => { proved.push({ tx, cfg }); return { proven: 9 }; } };
    },
    ...over,
  };
  return { it, proved, built };
};

/** A sender that records what it was handed and answers a reference. */
const sender = (answer: SendProven = async () => ({ txRef: 'ref-from-the-service' })) => {
  const sent: Array<{ job: Job; bytes: number[] }> = [];
  const send: SendProven = async (j, bytes) => { sent.push({ job: j, bytes: [...bytes] }); return answer(j, bytes); };
  return { send, sent };
};
const provingOnlyRunner = (c: ProvingCapability) => provingRunner(c, sender().send);

describe('a device that can prove', () => {
  it('proves the transaction it was given, for the circuit it was told', async () => {
    /*
     * RED WHEN: `circuitId` stops being passed to `proveTx`. The prover looks
     * its keys up by that name, so a proof for the wrong circuit fetches keys
     * for something the transaction does not contain - and the failure arrives
     * from inside WebAssembly saying nothing about why.
     */
    const c = capability();
    const out = await provingOnlyRunner(c.it).prove(job());

    expect(c.proved).toEqual([{ tx: { unproven: [1, 2, 3] }, cfg: { circuitId: 'propose' } }]);
    expect(out.proof).toEqual({ circuit: 'propose', provenTx: { proven: 9 } });
  });

  it('builds the prover once and shares it across approvals', async () => {
    /*
     * RED WHEN: the memo is removed. Constructing a prover instantiates a
     * WebAssembly module and reads nothing job-specific, so building one per
     * approval pays that cost on every one for no gain.
     */
    const c = capability();
    const runner = provingOnlyRunner(c.it);
    await runner.prove(job());
    await runner.prove(job());
    expect(c.built).toHaveLength(1);
  });

  it('sends the proof it made, as the transaction\'s own wire form, and answers the reference', async () => {
    /*
     * RED WHEN: `submit` sends anything but the serialised proven transaction -
     * the preimage, the proof object, nothing - or drops the service's reference.
     */
    const c = capability();
    const s = sender();
    const runner = provingRunner(c.it, s.send);
    const { proof } = await runner.prove(job());
    await expect(runner.submit(job(), proof)).resolves.toEqual({ txRef: 'ref-from-the-service' });
    expect(s.sent).toEqual([{ job: job(), bytes: [9, 42] }]);
    expect(s.sent[0].bytes, 'the preimage left the device').not.toEqual([1, 2, 3]);
  });

  it('passes a refusal on as nothing sent, and a failure as unknown', async () => {
    /*
     * RED WHEN: the runner rewraps what the service said, so a refusal loses
     * its mark or a failed submission gains one.
     */
    const c = capability();
    const refusing = provingRunner(c.it, sender(async () => { throw new NothingWasSent('over the ceiling'); }).send);
    const refused = await refusing.submit(job(), { provenTx: { proven: 1 } }).catch((e) => e);
    expect(refused.message).toBe('over the ceiling');
    expect(saysNothingWasSent(refused)).toBe(true);

    const failing = provingRunner(c.it, sender(async () => { throw new Error('socket closed'); }).send);
    const failed = await failing.submit(job(), { provenTx: { proven: 1 } }).catch((e) => e);
    expect(saysNothingWasSent(failed), 'a send that may have landed was called nothing sent').toBe(false);
  });

  it('with no proof in hand, sends nothing and says so', async () => {
    /*
     * RED WHEN: the guard on a missing proof is removed, so `undefined` reaches
     * the codec and the failure is recorded as a send whose outcome is unknown.
     */
    const s = sender();
    const refusal = await provingRunner(capability().it, s.send).submit(job(), {}).catch((e) => e);
    expect(refusal.message).toMatch(/no finished proof on this device/);
    expect(saysNothingWasSent(refusal)).toBe(true);
    expect(s.sent).toEqual([]);
  });

  it('has no recovery yet, so a lost answer stops the job for a person to look at', async () => {
    /*
     * RED WHEN: a `recover` is added that answers without asking the chain.
     * The queue's own behaviour with none is to stop and say a person should
     * look, which is the honest answer about a send whose answer was lost.
     */
    expect(provingOnlyRunner(capability().it).recover).toBeUndefined();
  });
});

describe('what the service\'s answer means', () => {
  const answering = (status: number, body: unknown) => {
    const asked: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: any, init: any) => {
      asked.push({ url: String(url), init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
    return { send: sendOver(f), asked };
  };
  const PROVEN = new Uint8Array([1, 255, 0, 7]);

  /* RED WHEN: the path, the method or the encoding of the proven bytes changes. */
  it('posts the proven transaction to the company\'s own route, same origin', async () => {
    const a = answering(200, { txRef: 'ref-9' });
    await expect(a.send(job(), PROVEN)).resolves.toEqual({ txRef: 'ref-9' });
    expect(a.asked[0].url).toBe('/api/accounts/acc_1/proven');
    expect(a.asked[0].init.method).toBe('POST');
    expect(JSON.parse(String(a.asked[0].init.body))).toEqual({ tx: Buffer.from(PROVEN).toString('base64') });
  });

  /* RED WHEN: an account id is put into the path unescaped. */
  it('escapes the company in the path', async () => {
    const a = answering(200, { txRef: 'r' });
    await a.send({ ...job(), accountId: '../x?y' }, PROVEN);
    expect(a.asked[0].url).toBe('/api/accounts/..%2Fx%3Fy/proven');
  });

  /* RED WHEN: any row of the table in `sendOver`'s comment is read the other way. */
  it('reads each kind of answer the way it was meant', async () => {
    const outcome = async (status: number, body: unknown) => {
      const e = await answering(status, body).send(job(), PROVEN).catch((x) => x);
      return { nothing: saysNothingWasSent(e), message: String(e?.message) };
    };
    expect(await outcome(422, { nothingWasSent: true, error: 'over' })).toEqual({ nothing: true, message: 'over' });
    expect(await outcome(503, { nothingWasSent: true, error: 'cannot send' }))
      .toEqual({ nothing: true, message: 'cannot send' });
    expect(await outcome(502, { nothingWasSent: false, error: 'lost' })).toEqual({ nothing: false, message: 'lost' });
    expect((await outcome(404, { error: 'account not found' })).nothing).toBe(true);
    expect((await outcome(401, 'not json')).nothing).toBe(true);
    expect((await outcome(502, 'bad gateway')).nothing, 'a gateway failure was called nothing sent').toBe(false);
    const noReference = await outcome(200, { nope: 1 });
    expect(noReference.nothing, 'an answer with no reference was called nothing sent').toBe(false);
    expect(noReference.message, 'an answer with no reference was taken as sent').toMatch(/answered 200/);
    expect((await outcome(409, { nothingWasSent: false, error: 'x' })).nothing).toBe(false);
  });

  /* RED WHEN: a request that never got an answer is called nothing sent. */
  it('no answer at all is an unknown outcome', async () => {
    const send = sendOver((async () => { throw new TypeError('network down'); }) as typeof fetch);
    const e = await send(job(), PROVEN).catch((x) => x);
    expect(saysNothingWasSent(e)).toBe(false);
  });
});

describe('the preimage is never written down', () => {
  it('is fetched for the length of one proof and is not in what the runner returns', async () => {
    /*
     * **AN UNPROVEN TRANSACTION IS THE PROOF PREIMAGE, AND THE PROOF PREIMAGE
     * IS THE PRIVATE INPUT** - the balance, the amount, the signer's secret
     * key. The job record is persisted, so anything this returns could reach
     * storage, and the returned proof carries the proven transaction and the
     * circuit name and nothing else.
     *
     * RED WHEN: the unproven bytes are put on the returned proof. **The other
     * half of this property - that the job PAYLOAD carries a location and not
     * the bytes - lives in `proving-worker-entry.ts` and is asserted by the
     * cases above, not here; the first version of this comment named it as
     * though this case covered it.**
     */
    /*
     * **THE KEYS, EXACTLY, NOT A SEARCH FOR A WORD.** The first version looked
     * for the string `unproven` in the serialised proof, which passed only
     * because the fixture happened to name its key that way - returning the raw
     * bytes serialises to `{"0":1,...}` and would have stayed green. What the
     * property actually says is that the proof carries two things and neither
     * of them is the preimage.
     *
     * RED WHEN: anything is added to the returned proof, including the bytes
     * themselves.
     */
    const c = capability();
    const out = await provingOnlyRunner(c.it).prove(job());
    expect(Object.keys(out.proof as object).sort(),
      'the proof the queue will hold carries something other than the circuit and the result')
      .toEqual(['circuit', 'provenTx']);
  });

  /**
   * **THE FIRST VERSION OF THIS BLOCK SUPPLIED ITS OWN COPY OF THE GUARD AND
   * THEN ASSERTED THAT ITS OWN COPY THREW.** Deleting the real one - which
   * lives in `proving-worker-entry.ts`, not here - left it green. These cases
   * drive the real one.
   */
  it('refuses a job that does not say what it is approving', async () => {
    /*
     * RED WHEN: the guard on `circuit` and `preimageUrl` is removed. A missing
     * location then reaches `fetch` as `undefined`, and the failure arrives
     * from inside the network layer naming nothing a person can act on.
     */
    const fetched: string[] = [];
    const preimage = preimageOver((async (url: any) => {
      fetched.push(String(url));
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer } as Response;
    }) as typeof fetch);

    await expect(preimage(job())).rejects.toThrow(/does not say what it is approving/);
    await expect(preimage(job({ circuit: 'propose' }))).rejects.toThrow(/does not say what it is approving/);
    expect(fetched, 'a job with nothing to prove still made a request').toEqual([]);
  });

  it('refuses material from anywhere but this application', async () => {
    /*
     * **THE THING THIS LOCATION POINTS AT IS THE PRIVATE INPUT.** It comes off
     * a persisted record, and a record naming another origin would send this
     * worker to fetch a proof preimage from there.
     *
     * RED WHEN: the same-origin guard is removed, or written as a
     * `startsWith('http')` refusal - which lets `//elsewhere/x` through, and a
     * protocol-relative URL is another origin.
     */
    const fetched: string[] = [];
    const preimage = preimageOver((async (url: any) => {
      fetched.push(String(url));
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer } as Response;
    }) as typeof fetch);

    for (const preimageUrl of ['https://elsewhere.example/x', '//elsewhere.example/x', 'x']) {
      await expect(preimage(job({ circuit: 'propose', preimageUrl })), preimageUrl)
        .rejects.toThrow(/outside the application/);
    }
    expect(fetched, 'material was fetched from outside the application').toEqual([]);

    await expect(preimage(job({ circuit: 'propose', preimageUrl: '/fixture/propose.bin' })))
      .resolves.toEqual({ circuit: 'propose', unprovenTransaction: new Uint8Array([1]) });
  });

  it('says the material is gone rather than passing a failed fetch on', async () => {
    /*
     * RED WHEN: the `res.ok` branch is removed. `arrayBuffer()` on a 404 gives
     * the error page's bytes, which the prover then fails on with a message
     * about a malformed transaction - naming nothing true.
     */
    const preimage = preimageOver((async () => ({ ok: false, status: 404 })) as unknown as typeof fetch);
    await expect(preimage(job({ circuit: 'propose', preimageUrl: '/fixture/gone.bin' })))
      .rejects.toThrow(/no longer available \(404\)/);
  });
});

describe('the worker the page starts', () => {
  /*
   * READ, NOT RUN: starting it opens a database and a thread. RED WHEN: the
   * worker is started with a runner that does not send through the service's
   * route, or with a sender other than its own same-origin fetch.
   */
  it('sends what it proves through this application\'s own route', () => {
    const text = readFileSync(join(import.meta.dirname, 'proving-worker-entry.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(text).toMatch(/const runner = provingRunner\(capability, sendOver\(scope\.fetch\.bind\(scope\)\)\);/);
    expect(text.match(/provingRunner\(/g)).toHaveLength(1);
  });
});

