/**
 * **A PROOF'S THREAD REPORTS WHY ITS MATERIAL WAS REFUSED, AND ASKS FOR IT ONCE.**
 *
 * The thread asks the vault worker for every file a proof needs. When the vault
 * worker refuses one - the circuit on the chain is not this build's, or the
 * service sent other bytes - the prover's own failure says nothing about it,
 * so the thread must carry the vault worker's reason back itself. The prover is
 * stood in by one that asks for its material the way the real one does, more
 * than once per proof, and fails with words of its own when an ask is refused.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

/* The stand-in prover: asks for one location's material and the parameters more than once, then proves or fails on its own. */
const prover = vi.hoisted(() => ({
  location: 'contract:ab/payout?vk=01',
  failsOnItsOwn: false,
  run: async (material: any): Promise<Uint8Array> => {
    const at = prover.location;
    await material.lookupKey(at);
    await material.lookupKey(at);
    await material.getParams(9);
    await material.lookupKey(at);
    await material.getParams(9);
    if (prover.failsOnItsOwn) throw new Error('the circuit did not hold');
    return new Uint8Array([1]);
  },
}));
vi.mock('@midnight-ntwrk/zkir-v2', () => ({
  prove: async (_p: Uint8Array, material: any) => {
    try { return await prover.run(material); } catch { throw new Error('RuntimeError: unreachable'); }
  },
  check: async () => [],
}));

const posted: any[] = [];
let listener: ((event: { data: any }) => void) | null = null;
const REFUSAL = 'The service sent a proving key for the payout circuit of the vault that is not this app\'s, so it was neither used nor kept, and no proof was made.';

/* The vault worker's side: answers each ask with the material, or with a refusal for the asks a test names. */
let refuse = (_ask: any): boolean => false;
const answerAsks = () => {
  for (const m of posted.splice(0)) {
    if (m.op === 'lookupKey' || m.op === 'getParams') {
      asksSeen.push(m.op === 'lookupKey' ? `key ${m.keyLocation}` : `params ${m.k}`);
      listener!({ data: refuse(m)
        ? { op: 'answer', askId: m.askId, ok: false, error: REFUSAL }
        : { op: 'answer', askId: m.askId, ok: true, value: { proverKey: new Uint8Array(), verifierKey: new Uint8Array(), ir: new Uint8Array() } } });
    } else outcomes.push(m);
  }
};
const asksSeen: string[] = [];
const outcomes: any[] = [];

const aProof = async (): Promise<any> => {
  outcomes.length = 0;
  listener!({ data: { op: 'prove', preimage: new Uint8Array() } });
  for (let i = 0; i < 50 && outcomes.length === 0; i += 1) { answerAsks(); await new Promise((r) => setTimeout(r, 0)); }
  return outcomes[0];
};

beforeAll(async () => {
  (globalThis as any).self = {
    postMessage: (m: unknown) => { posted.push(m); },
    addEventListener: (_t: string, l: (event: { data: any }) => void) => { listener = l; },
  };
  await import('./vault-proof-worker-entry.js');
  expect(posted.splice(0)).toEqual([{ op: 'ready' }]);
});

describe('WHAT A PROOF\'S THREAD SAYS AND ASKS', () => {
  it('a refused file fails the proof with the vault worker\'s reason, not the prover\'s words or a word about the connection', async () => {
    /* RED WHEN: the reason the vault worker gave is lost behind the prover's own failure. */
    prover.location = 'contract:ab/payout?vk=01';
    prover.failsOnItsOwn = false;
    refuse = (m) => m.op === 'lookupKey';
    const outcome = await aProof();
    expect(outcome.op).toBe('failure');
    expect(outcome.error).toBe(REFUSAL);
    expect(outcome.error).not.toMatch(/connection|unreachable/u);
  });

  it('a refused file is asked for again by the next proof, and a supplied one is asked for once for the thread\'s life', async () => {
    /* RED WHEN: a refusal is kept for good, or every ask the prover makes crosses to the vault worker again. */
    prover.location = 'contract:ab/merge?vk=02';
    prover.failsOnItsOwn = false;
    refuse = (m) => m.op === 'lookupKey';
    expect((await aProof()).op).toBe('failure');
    refuse = () => false;
    asksSeen.length = 0;
    expect((await aProof()).op).toBe('result');
    expect(asksSeen, 'a refused file was not asked for again').toContain('key contract:ab/merge?vk=02');
    asksSeen.length = 0;
    expect((await aProof()).op).toBe('result');
    expect(asksSeen, 'a second proof on the same thread asked again for what it already holds').toEqual([]);
  });

  it('a proof that fails on its own after an earlier refusal says its own reason, not the earlier one', async () => {
    /* RED WHEN: a refusal's reason is kept past its proof, so a later failure of another kind is reported as that refusal. */
    prover.location = 'contract:ab/deposit?vk=03';
    prover.failsOnItsOwn = false;
    refuse = (m) => m.op === 'lookupKey';
    expect((await aProof()).error).toBe(REFUSAL);
    refuse = () => false;
    prover.failsOnItsOwn = true;
    const outcome = await aProof();
    expect(outcome.op).toBe('failure');
    expect(outcome.error).not.toBe(REFUSAL);
    expect(outcome.error).toMatch(/unreachable/u);
  });
});
