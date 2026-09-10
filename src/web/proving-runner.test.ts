/**
 * **WHAT A DEVICE THAT CAN PROVE AND CANNOT PAY IS ALLOWED TO DO.**
 *
 * The four steps of a job cost different things. Building and proving are pure:
 * they reach no chain, spend nothing, and an interruption costs time. Balancing
 * books coins, and submitting may settle whether or not anybody is still
 * watching.
 *
 * **THIS RUNNER DOES THE PURE HALF AND REFUSES THE REST BY NAME**, because
 * nothing in this product is wired to pay a network fee - the one place that
 * would supply a wallet and a fee payer sets its capability to nothing, on
 * purpose. A runner that appeared to balance and submit would be describing a
 * deployment that does not exist, and every case about it would be reading its
 * own double back.
 */
import { describe, it, expect } from 'vitest';
import { provingOnlyRunner, NOTHING_PAYS_FEES, type ProvingCapability } from './proving-runner.js';
import { preimageOver } from './proving-worker-entry.js';
import { saysNothingWasSent, type Job } from '../core/jobs.js';

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
      serializeProven: () => new Uint8Array(),
    }),
    proofProvider: async () => {
      built.push(1);
      return { proveTx: async (tx, cfg) => { proved.push({ tx, cfg }); return { proven: true }; } };
    },
    ...over,
  };
  return { it, proved, built };
};

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
    expect(out.proof).toEqual({ circuit: 'propose', provenTx: { proven: true } });
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

  it('and cannot send it, in a sentence that says which half is missing', async () => {
    /*
     * **NOT A PLACEHOLDER.** A device can prove without a wallet because
     * proving is pure, and cannot send without one. Those are genuinely
     * different halves, and a person who is told only *it failed* cannot tell
     * whether they did something wrong.
     *
     * RED WHEN: `submit` returns anything, or the refusal stops saying that
     * nothing was sent and nothing was lost.
     */
    await expect(provingOnlyRunner(capability().it).submit(job(), {}))
      .rejects.toThrow(/cannot send it/);

    /*
     * **AND IT IS MARKED AS HAVING REACHED NOTHING, WHICH IS THE HALF THAT
     * MATTERS TO THE QUEUE.** Unmarked, a thrown submission is recorded as
     * *sent, outcome unknown* - correct for anything that made a network call
     * and wrong here - and the person ends up being told to check the account
     * for a payment that never existed. Measured on a real run before the mark
     * existed.
     *
     * RED WHEN: this throws a plain `Error`.
     */
    const refusal = await provingOnlyRunner(capability().it).submit(job(), {}).catch((e) => e);
    expect(saysNothingWasSent(refusal),
      'the refusal does not say that nothing reached the chain, so the queue will ask about it')
      .toBe(true);
    expect(NOTHING_PAYS_FEES).toMatch(/nothing has been lost and nothing has been sent/);
    expect(NOTHING_PAYS_FEES, 'the refusal names something only a developer could act on')
      .not.toMatch(/\.ts\b|writeCapability|undefined|FeeSponsor/);
  });

  it('has no recovery, because nothing it does reaches a chain', async () => {
    /*
     * **THE ABSENCE IS THE CORRECT ANSWER RATHER THAN AN UNFINISHED ONE.** A
     * recovery answers *did this land*. Nothing here lands. And the queue's own
     * behaviour with no recovery is exactly right for that: it stops and says a
     * person should look, which is the only honest thing a device that cannot
     * submit can say about something it never submitted.
     *
     * RED WHEN: a `recover` is added that answers anything at all.
     */
    expect(provingOnlyRunner(capability().it).recover).toBeUndefined();
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
