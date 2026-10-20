/**
 * THE PUBLIC PROVING FILES ARE FETCHED BEFORE A PROOF NEEDS THEM.
 *
 * The vault worker can be asked, with no proof under way, to fetch and check the
 * public parameters every circuit this app proves needs. It reads the size of
 * each circuit off the circuit itself, asks for each size once, and reads
 * everything through the same checked source the prover uses, so a file the
 * service sends that is not the published one is refused by name, as it would be
 * at a proof. The page's client and the worker's handler carry the ask.
 */
import { describe, expect, it } from 'vitest';
import { answerVaultAsk, provingWarmed, type WorkerDeps } from './vault-worker-entry.js';
import { vaultBuilderOver, type VaultAnswer } from './vault-worker-client.js';
import { httpKeyMaterialSource, type ArtefactSource, type ProvingPins } from './key-material.js';
import { ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE, VAULT_CIRCUITS } from '../../../src/midnight/vault-contract.js';

const NETWORK = ['output', 'spend', 'sign'].map((c) => `midnight/zswap/${c}`);
const EVERY_CIRCUIT = [...VAULT_CIRCUITS, ...ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE, ...NETWORK];

/** A source that records what it was asked, and serves each circuit's size by its location. */
const recordingSource = (sizeOfLocation: (location: string) => number, failParams: (k: number) => Error | null = () => null) => {
  const irsAsked: string[] = [];
  const paramsAsked: number[] = [];
  const source: ArtefactSource = {
    lookupKey: async () => { throw new Error('a warm-up fetches no proving key'); },
    getParams: async (k) => {
      paramsAsked.push(k);
      const bad = failParams(k);
      if (bad !== null) throw bad;
      return new Uint8Array(1);
    },
    artefact: async (kind, location) => {
      if (kind !== 'ir') throw new Error(`a warm-up fetches only circuits, not a ${kind}`);
      irsAsked.push(location);
      return new TextEncoder().encode(String(sizeOfLocation(location)));
    },
  };
  return { source, irsAsked, paramsAsked };
};
const sizeFromBytes = (ir: Uint8Array): number => Number(new TextDecoder().decode(ir));

describe('warming the public parameters', () => {
  /*
   * RED WHEN: a circuit this app proves is left out of the warm-up, so its first
   * proof still waits on a download.
   */
  it('reads the size of every circuit the device proves, the network\'s shielded ones included', async () => {
    const r = recordingSource(() => 14);
    await provingWarmed(r.source, sizeFromBytes);
    expect([...r.irsAsked].sort()).toEqual([...EVERY_CIRCUIT].sort());
  });

  /*
   * RED WHEN: a size shared by many circuits is fetched once per circuit, or a
   * size one of them needs is never fetched.
   */
  it('asks for each size once, smallest first', async () => {
    const sizes: Record<string, number> = { deposit: 17, payout: 12, propose: 17, 'midnight/zswap/spend': 15 };
    const r = recordingSource((l) => sizes[l] ?? 12);
    await provingWarmed(r.source, sizeFromBytes);
    expect(r.paramsAsked).toEqual([12, 15, 17]);
  });

  /*
   * RED WHEN: one circuit the service cannot show leaves every other size
   * unfetched, or the failure is swallowed so the page thinks it is warm.
   */
  it('fetches the sizes it could read and then refuses with the first thing that went wrong', async () => {
    const r = recordingSource(() => 13);
    const bad = new Error('a circuit would not read');
    const source: ArtefactSource = { ...r.source, artefact: async (kind, l) => { if (l === 'payout') throw bad; return r.source.artefact(kind, l); } };
    await expect(provingWarmed(source, sizeFromBytes)).rejects.toBe(bad);
    expect(r.paramsAsked).toEqual([13]);
  });

  /*
   * RED WHEN: parameters the service sends that are not the published ones are
   * kept or used because a warm-up is not a proof.
   */
  it('refuses by name parameters that are not the published ones, as a proof would', async () => {
    const pins: ProvingPins = {
      whose: 'a test build', carriesKeys: true, circuitIn: (l) => l, digestOf: (kind) => (kind === 'verifier' ? 'vk' : 'ir-ok'),
      paramsDigest: () => 'published',
    };
    const put: string[] = [];
    const served = (url: string) => new Response(url.includes('/params/') ? 'not published' : 'ir-ok');
    const source = httpKeyMaterialSource('https://service.example/keys', {
      pins, fetchImpl: (async (url: string) => served(String(url))) as typeof fetch,
      digest: async (bytes) => new TextDecoder().decode(bytes) === 'ir-ok' ? 'ir-ok' : 'other',
      cache: { get: async () => null, put: async (k) => { put.push(k); } },
    });
    await expect(provingWarmed(source, () => 9)).rejects.toMatchObject({ name: 'ProvingMaterialRefused', kind: 'other-bytes-served' });
    expect(put.some((k) => k.includes('params'))).toBe(false);
  });
});

describe('the worker and its client carry the ask', () => {
  const asked: unknown[] = [];
  const deps = (warmed: () => Promise<void>) => ({ provingWarmed: warmed }) as unknown as WorkerDeps;

  /*
   * RED WHEN: the worker answers the ask without having fetched anything, or
   * fetches for an ask it is not given.
   */
  it('answers once the worker has fetched and checked the files', async () => {
    let done = false;
    const answer = await answerVaultAsk(async () => deps(async () => { await Promise.resolve(); done = true; }), { id: 7, network: 'undeployed', ask: 'warm-proving' });
    expect(answer).toEqual({ id: 7, ok: true, ask: 'warm-proving' });
    expect(done).toBe(true);
  });

  /*
   * RED WHEN: the page's client sends another ask or none, or reports the files
   * as ready when the worker said it could not fetch them.
   */
  it('is asked by the page as one ask, and carries a refusal back', async () => {
    const listeners: Array<(e: { data: unknown }) => void> = [];
    let warm: () => Promise<void> = async () => {};
    const client = vaultBuilderOver({
      postMessage: (m) => {
        asked.push(m);
        void answerVaultAsk(async () => deps(warm), m as never).then(
          (a: VaultAnswer) => listeners.forEach((l) => l({ data: structuredClone(a) })),
          (e: Error) => listeners.forEach((l) => l({ data: { id: (m as { id: number }).id, ok: false, error: e.message } })));
      },
      addEventListener: (_t, l) => { listeners.push(l); },
    }, 'undeployed');
    await client.provingWarmed!();
    expect(asked).toEqual([{ ask: 'warm-proving', id: 1, network: 'undeployed' }]);
    warm = async () => { throw new Error('the public parameters did not arrive'); };
    await expect(client.provingWarmed!()).rejects.toThrow('the public parameters did not arrive');
  });
});
