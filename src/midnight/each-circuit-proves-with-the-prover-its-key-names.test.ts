/**
 * Which prover a circuit is sent to. A contract's own circuits are compiled to the newer circuit format and prove
 * with zkir-v3; the network's own circuits (shielded transfers and fees, at `midnight/...`) prove with zkir-v2. A
 * circuit sent to the other prover fails after it has been asked for its keys, so the choice is made from the key
 * location alone, before anything is loaded, and a location naming neither is refused.
 */
import { describe, it, expect } from 'vitest';
import {
  keyLocationOf, provingProviderFor, wasmProofProvider, zkirEngineFor, ZKIR_ENGINES,
  type KeyMaterialSource, type ZkirEngine, type ZkirEngines,
} from './wasm-proving.js';

const ADDRESS = '90a19bf2cd784d5b52d6264cc0facbef657f2a9be16cf6f510aee4c2d275d484';
const VK = '5ac4195fe2a6800891d33311411f4f0cd294d5c795021aa1fdb2d2ad8b704f84';
const A_VAULT_PAYMENT = `contract:${ADDRESS}/payout?vk=${VK}`;

const source: KeyMaterialSource = {
  lookupKey: async () => ({ proverKey: new Uint8Array([1]), verifierKey: new Uint8Array([2]), ir: new Uint8Array([3]) }),
  getParams: async () => new Uint8Array([4]),
};

/** Two stand-in provers that record which key locations reached them, and how often each was loaded. */
const recordingEngines = () => {
  const reached: Record<'contract' | 'network', string[]> = { contract: [], network: [] };
  const loads = { contract: 0, network: 0 };
  const engine = (kind: 'contract' | 'network'): ZkirEngine => ({
    provingProvider: () => ({
      check: async (_preimage, keyLocation) => { reached[kind].push(`check ${keyLocation}`); return []; },
      prove: async (_preimage, keyLocation) => { reached[kind].push(`prove ${keyLocation}`); return new Uint8Array(); },
    }),
    Zkir: { deserialize: () => ({ getK: () => 0 }) },
  });
  const engines: ZkirEngines = {
    contract: async () => { loads.contract += 1; return engine('contract'); },
    network: async () => { loads.network += 1; return engine('network'); },
  };
  return { engines, reached, loads };
};

describe('the prover a circuit is sent to', () => {
  it('a vault payment proves with the contract prover, and the network prover is never loaded', async () => {
    const r = recordingEngines();
    const prover = provingProviderFor(source, r.engines);
    await prover.check(new Uint8Array(), A_VAULT_PAYMENT);
    await prover.prove(new Uint8Array(), A_VAULT_PAYMENT);
    /* RED WHEN: a contract's circuit is sent to the network's prover, and every vault payment fails at its proof. */
    expect(r.reached).toEqual({ contract: [`check ${A_VAULT_PAYMENT}`, `prove ${A_VAULT_PAYMENT}`], network: [] });
    /* RED WHEN: the network's prover is loaded for a payment that needs none of it. */
    expect(r.loads).toEqual({ contract: 1, network: 0 });
  });

  it('the shielded transfer and fee circuits prove with the network prover', async () => {
    const r = recordingEngines();
    const prover = provingProviderFor(source, r.engines);
    for (const location of ['midnight/zswap/spend', 'midnight/zswap/output', 'midnight/dust/spend']) {
      await prover.prove(new Uint8Array(), location);
    }
    /* RED WHEN: a private deposit's shielded spend or a fee's DUST spend goes to the contract prover. */
    expect(r.reached).toEqual({
      contract: [],
      network: ['prove midnight/zswap/spend', 'prove midnight/zswap/output', 'prove midnight/dust/spend'],
    });
  });

  it('a contract circuit named without its verifying key is refused before any prover is loaded', async () => {
    const r = recordingEngines();
    const prover = provingProviderFor(source, r.engines);
    /* RED WHEN: a circuit named only by its name is proved, and nothing holds its keys to the contract's verifying key. */
    await expect(prover.prove(new Uint8Array(), 'payout')).rejects.toThrow(/without the verifying key it is proved against/);
    await expect(prover.check(new Uint8Array(), 'payout')).rejects.toThrow(/without the verifying key it is proved against/);
    await expect(prover.lookupKey('payout')).rejects.toThrow(/without the verifying key it is proved against/);
    await expect(zkirEngineFor('payout')).rejects.toThrow(/without the verifying key it is proved against/);
    expect(r.loads).toEqual({ contract: 0, network: 0 });
  });

  it('a key location naming neither is refused before any prover is loaded', async () => {
    const r = recordingEngines();
    const prover = provingProviderFor(source, r.engines);
    for (const location of ['zswap/spend', `contract:${ADDRESS}/payout`, 'midnight/', '../keys/payout']) {
      /* RED WHEN: an unreadable location falls back to one of the provers, which then proves whatever it is handed. */
      await expect(prover.prove(new Uint8Array(), location)).rejects.toThrow(/names neither a contract's circuit nor one of the network's own/);
    }
    expect(r.loads).toEqual({ contract: 0, network: 0 });
  });

  it('each prover is loaded once, however many circuits it proves', async () => {
    const r = recordingEngines();
    const prover = provingProviderFor(source, r.engines);
    await Promise.all([prover.prove(new Uint8Array(), A_VAULT_PAYMENT), prover.prove(new Uint8Array(), `contract:${ADDRESS}/mergeNotes?vk=${VK}`)]);
    await prover.check(new Uint8Array(), `contract:${ADDRESS}/splitNote?vk=${VK}`);
    /* RED WHEN: the prover's WebAssembly is instantiated again for every circuit of a payment. */
    expect(r.loads.contract).toBe(1);
  });

  it('a key asked for directly comes from the source, and a failure names what was asked for', async () => {
    const prover = provingProviderFor({ ...source, lookupKey: async () => { throw new Error('404'); } }, recordingEngines().engines);
    /* RED WHEN: a missing proving key surfaces as a bare error that names no circuit. */
    await expect(prover.lookupKey(A_VAULT_PAYMENT)).rejects.toThrow(`could not load proving material for "${A_VAULT_PAYMENT}": 404`);
  });

  it('contract circuits load zkir-v3 and the network\'s load zkir-v2', async () => {
    /* RED WHEN: the two packages are swapped, and both kinds of circuit fail at their proofs. */
    expect(await ZKIR_ENGINES.contract()).toBe(await import('@midnightntwrk/zkir-v3'));
    expect(await ZKIR_ENGINES.network()).toBe(await import('@midnightntwrk/zkir-v2'));
  });

  it('a worker proving one circuit at a time is handed the same package for it', async () => {
    /* RED WHEN: a proof thread loads a different package for a circuit than the device's own prover would. */
    expect(await zkirEngineFor(A_VAULT_PAYMENT)).toBe(await import('@midnightntwrk/zkir-v3'));
    expect(await zkirEngineFor('midnight/zswap/spend')).toBe(await import('@midnightntwrk/zkir-v2'));
    /* RED WHEN: a proof thread loads a package for a location that names neither kind of circuit. */
    await expect(zkirEngineFor('zswap/spend')).rejects.toThrow(/names neither/);
  });

  it('the device\'s proof provider proves ledger 9 transactions and says so', async () => {
    /* RED WHEN: the provider claims an era it cannot prove, and an operation is refused only after its proof was paid for. */
    expect((await wasmProofProvider(source)).supportedEras).toEqual(['v9']);
  });
});

describe('what a key location names', () => {
  it('reads the circuit and the verifier key hash a contract call carries', () => {
    /* RED WHEN: a vault payment's circuit is read as something other than its name, and the wrong key is fetched. */
    expect(keyLocationOf(A_VAULT_PAYMENT)).toEqual({ kind: 'contract', circuit: 'payout', verifierKeyHash: VK });
    expect(keyLocationOf('payout')).toEqual({ kind: 'contract', circuit: 'payout', verifierKeyHash: null });
    expect(keyLocationOf('midnight/dust/spend')).toEqual({ kind: 'network', path: 'dust/spend' });
  });
});
