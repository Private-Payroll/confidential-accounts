/**
 * THE PUBLIC PROVING FILES ARE FETCHED BEFORE A PROOF NEEDS THEM.
 *
 * The vault worker can be asked, with no proof under way, to fetch and check the
 * public parameters every circuit this app proves needs, and the keys of the
 * circuits a deposit proves. It reads the size of each circuit off the circuit
 * itself, asks for each size once, and reads everything through the same checked
 * source the prover and its threads use, so a file the service sends that is not
 * the published one is refused by name, as it would be at a proof, and a deposit
 * after the warm-up reads nothing from the network. The page's client and the
 * worker's handler carry the ask.
 */
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  accountCircuitsBeside, answerVaultAsk, networkCircuitsBeside, provingWarmed, VAULT_ARTEFACT_BASE, type WorkerDeps,
} from './vault-worker-entry.js';
import { vaultBuilderOver, type VaultAnswer } from './vault-worker-client.js';
import {
  contractPins, httpKeyMaterialSource, MemoryArtefactCache, networkPins, type ArtefactSource, type ProvingPins,
} from './key-material.js';
import { provingOnWorkers, type ProofWorkerLike } from './vault-proof-workers.js';
import { ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE, VAULT_CIRCUITS } from '../../../src/midnight/vault-contract.js';

const NETWORK = ['output', 'spend', 'sign'].map((c) => `midnight/zswap/${c}`);
const EVERY_CIRCUIT = [...VAULT_CIRCUITS, ...ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE, ...NETWORK];
const A_DEPOSITS_CIRCUITS = ['deposit', 'depositUnshielded', 'midnight/zswap/output'];

/** A source that records what it was asked, and serves each circuit's size by its location. */
const recordingSource = (sizeOfLocation: (location: string) => number, failParams: (k: number) => Error | null = () => null) => {
  const irsAsked: string[] = [];
  const keysAsked: string[] = [];
  const paramsAsked: number[] = [];
  const inOrder: string[] = [];
  const source: ArtefactSource = {
    lookupKey: async () => { throw new Error('a warm-up fetches no proving key'); },
    getParams: async (k) => {
      paramsAsked.push(k);
      inOrder.push(`params ${k}`);
      const bad = failParams(k);
      if (bad !== null) throw bad;
      return new Uint8Array(1);
    },
    artefact: async (kind, location) => {
      inOrder.push(`${kind} ${location}`);
      if (kind !== 'ir') { keysAsked.push(`${kind} ${location}`); return new Uint8Array(1); }
      irsAsked.push(location);
      return new TextEncoder().encode(String(sizeOfLocation(location)));
    },
  };
  return { source, irsAsked, keysAsked, paramsAsked, inOrder };
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
  it('asks for each size once, a deposit\'s sizes first, each smallest first', async () => {
    const sizes: Record<string, number> = { deposit: 17, payout: 12, propose: 17, 'midnight/zswap/spend': 15 };
    const r = recordingSource((l) => sizes[l] ?? 12);
    await provingWarmed(r.source, sizeFromBytes);
    expect(r.paramsAsked).toEqual([12, 17, 15]);
  });

  /*
   * RED WHEN: a deposit asked for right after sign-in waits while the other
   * circuits are read: any other circuit is asked for before a deposit's
   * circuits, keys and parameters are all in hand.
   */
  it('fetches everything a deposit proves with before it reads any other circuit', async () => {
    const sizes: Record<string, number> = { deposit: 15, depositUnshielded: 11, 'midnight/zswap/output': 13, payout: 16 };
    const r = recordingSource((l) => sizes[l] ?? 14);
    await provingWarmed(r.source, sizeFromBytes);
    const firstOther = r.inOrder.findIndex((a) => a.startsWith('ir ') && !A_DEPOSITS_CIRCUITS.includes(a.slice(3)));
    const theDeposits = A_DEPOSITS_CIRCUITS.flatMap((c) => [`ir ${c}`, `prover ${c}`, `verifier ${c}`]).concat(['params 11', 'params 13', 'params 15']);
    expect(firstOther).toBeGreaterThan(-1);
    expect([...r.inOrder.slice(0, firstOther)].sort()).toEqual([...theDeposits].sort());
    expect(r.inOrder.slice(firstOther).filter((a) => a.startsWith('params '))).toEqual(['params 14', 'params 16']);
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

describe('warming the keys a deposit proves with', () => {
  /*
   * RED WHEN: a circuit a deposit proves is left out of the warm-up, so a first
   * deposit still waits on its key; or every circuit's key is fetched, hundreds
   * of MB nobody asked for.
   */
  it('fetches the proving and verifying keys of exactly the circuits a deposit proves', async () => {
    const r = recordingSource(() => 14);
    await provingWarmed(r.source, sizeFromBytes);
    expect([...r.keysAsked].sort()).toEqual(A_DEPOSITS_CIRCUITS.flatMap((c) => [`prover ${c}`, `verifier ${c}`]).sort());
  });

  /** The files a service of this build serves, each pinned by its sha256, as the vault worker's sources pin them. */
  const B = VAULT_ARTEFACT_BASE;
  const NET = `${B}/builtin/zswap/9`;
  const servedAt = (url: string): Uint8Array => new TextEncoder().encode(`the file at ${url}`);
  const pinOf = (url: string): string => bytesToHex(sha256(servedAt(url)));
  const contractBuild = (base: string, circuits: readonly string[]) => ({
    expectedVk: Object.fromEntries(circuits.map((c) => [c, pinOf(`${base}/keys/${c}.verifier`)])),
    manifest: {
      keys: Object.fromEntries(circuits.map((c) => [`${c}.prover`, { hash: pinOf(`${base}/keys/${c}.prover`) }])),
      zkir: Object.fromEntries(circuits.map((c) => [`${c}.bzkir`, { hash: pinOf(`${base}/zkir/${c}.bzkir`) }])),
    },
  });
  const VAULT = contractBuild(B, VAULT_CIRCUITS);
  const ACCOUNT = contractBuild(`${B}/account`, ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE);
  const NETWORK_FILES = Object.fromEntries(['output', 'spend', 'sign'].flatMap((c) => [
    [`zswap/9/${c}.prover`, { sha256: pinOf(`${NET}/keys/${c}.prover`) }],
    [`zswap/9/${c}.verifier`, { sha256: pinOf(`${NET}/keys/${c}.verifier`) }],
    [`zswap/9/${c}.bzkir`, { sha256: pinOf(`${NET}/zkir/${c}.bzkir`) }],
  ]));
  const K = 14;

  /**
   * The vault worker's checked source over `cache`, built afresh as a reload of
   * the page builds it, with a service that answers `serve` and a record of
   * every file it was asked for.
   */
  const theWorkersSource = (cache: MemoryArtefactCache, serve: (url: string) => Uint8Array = servedAt) => {
    const fetched: string[] = [];
    const fetchImpl = (async (url: string) => {
      fetched.push(String(url));
      return new Response(serve(String(url)) as BodyInit);
    }) as unknown as typeof fetch;
    const options = { cache, fetchImpl };
    const vault = httpKeyMaterialSource(B, {
      ...options, pins: contractPins('the vault', VAULT.expectedVk, VAULT.manifest, (name) => pinOf(`${B}/params/${name}`)),
    });
    const account = httpKeyMaterialSource(`${B}/account`, {
      ...options, pins: contractPins('the company account', ACCOUNT.expectedVk, ACCOUNT.manifest),
    });
    const network = httpKeyMaterialSource(NET, {
      ...options, pins: networkPins('the network\'s shielded transfers', { artefacts: NETWORK_FILES }, 'zswap/9'),
    });
    return { source: networkCircuitsBeside(accountCircuitsBeside(vault, account), network), fetched };
  };

  /** Where the ledger asks a vault's deposit to be proven: the vault's address, the circuit and its verifying key. */
  const atTheVault = (circuit: string) => `contract:${'54'.repeat(32)}/${circuit}?vk=${VAULT.expectedVk[circuit]}`;

  /** A proof thread that asks the vault worker for a circuit's keys and its parameters, as a thread proving does. */
  class AThread {
    static made: AThread[] = [];
    readonly answers: Array<{ ok: boolean; error?: string }> = [];
    private listeners: Array<(e: { data: unknown }) => void> = [];
    constructor() { AThread.made.push(this); }
    postMessage(m: unknown): void { if ((m as { op: string }).op === 'answer') this.answers.push(m as { ok: boolean }); }
    addEventListener(type: string, l: (e: { data: unknown }) => void): void { if (type === 'message') this.listeners.push(l); }
    terminate(): void {}
    says(data: unknown): void { for (const l of this.listeners) l({ data }); }
  }
  const settle = async (): Promise<void> => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 0)); };

  /** Proves each location on the proof threads over `source`, each thread asking for that circuit's keys and parameters. */
  const provedOnThreads = async (source: ArtefactSource, locations: readonly string[]) => {
    AThread.made = [];
    const provider = provingOnWorkers(source, () => new AThread() as unknown as ProofWorkerLike, undefined, locations.length);
    const proofs = locations.map((l) => provider.prove(new Uint8Array([1]), l));
    await settle();
    AThread.made.forEach((t, i) => {
      t.says({ op: 'ready' });
      t.says({ op: 'lookupKey', askId: 0, keyLocation: locations[i] });
      t.says({ op: 'getParams', askId: 1, k: K });
    });
    await settle();
    const answers = AThread.made.flatMap((t) => t.answers);
    AThread.made.forEach((t) => t.says({ op: 'result', value: new Uint8Array([2]) }));
    await Promise.all(proofs);
    return answers;
  };

  /*
   * RED WHEN: after the warm-up, a private or a public deposit's proof still
   * downloads a key, a circuit or its parameters, here or after the page is
   * opened again; or the proof threads read other files than the warm-up kept.
   */
  it('a deposit proven after the warm-up fetches no file from the network, after a reload too', async () => {
    const cache = new MemoryArtefactCache();
    const warm = theWorkersSource(cache);
    await provingWarmed(warm.source, () => K);
    expect(warm.fetched.length).toBeGreaterThan(0);
    const before = warm.fetched.length;

    const privateDeposit = [atTheVault('deposit'), 'midnight/zswap/output'];
    const publicDeposit = [atTheVault('depositUnshielded')];
    const answers = await provedOnThreads(warm.source, [...privateDeposit, ...publicDeposit]);
    expect(answers.every((a) => a.ok)).toBe(true);
    expect(warm.fetched.slice(before)).toEqual([]);

    const reloaded = theWorkersSource(cache);
    const again = await provedOnThreads(reloaded.source, [...privateDeposit, ...publicDeposit]);
    expect(again.every((a) => a.ok)).toBe(true);
    expect(reloaded.fetched).toEqual([]);
  });

  /*
   * RED WHEN: a deposit's key the service sends that is not this build's is kept
   * or used because a warm-up is not a proof.
   */
  it('refuses by name a deposit key that is not this build\'s, keeps nothing of it, and fetches it again at the proof', async () => {
    const cache = new MemoryArtefactCache();
    const kept: string[] = [];
    const put = cache.put.bind(cache);
    cache.put = async (key, bytes) => { kept.push(key); await put(key, bytes); };
    const wrong = `${B}/keys/deposit.prover`;
    const warm = theWorkersSource(cache, (url) => (url === wrong ? new TextEncoder().encode('another build\'s key') : servedAt(url)));
    await expect(provingWarmed(warm.source, () => K)).rejects.toMatchObject({ name: 'ProvingMaterialRefused', kind: 'other-bytes-served' });
    expect(kept.filter((key) => key.startsWith('artefact:prover:deposit?'))).toEqual([]);
    expect(kept.some((key) => key.startsWith('artefact:prover:depositUnshielded?'))).toBe(true);

    const honest = theWorkersSource(cache);
    const answers = await provedOnThreads(honest.source, [atTheVault('deposit')]);
    expect(answers.every((a) => a.ok)).toBe(true);
    expect(honest.fetched).toEqual([wrong]);
  });

  /*
   * RED WHEN: one deposit key that does not arrive leaves the other files
   * unfetched, or the warm-up says it is done so the page never asks again.
   */
  it('a key that does not arrive leaves everything else warmed and is fetched when the page asks again', async () => {
    const cache = new MemoryArtefactCache();
    const missing = `${NET}/keys/output.prover`;
    const warm = theWorkersSource(cache, (url) => { if (url === missing) throw new Error('the service did not answer'); return servedAt(url); });
    await expect(provingWarmed(warm.source, () => K)).rejects.toThrow('could not be reached');

    const publicDeposit = theWorkersSource(cache);
    await provedOnThreads(publicDeposit.source, [atTheVault('depositUnshielded')]);
    expect(publicDeposit.fetched).toEqual([]);

    const askedAgain = theWorkersSource(cache);
    await provingWarmed(askedAgain.source, () => K);
    expect(askedAgain.fetched).toEqual([missing]);
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
