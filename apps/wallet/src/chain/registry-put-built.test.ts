import { describe, expect, it } from 'vitest';
import { SPENDS_NO_COIN } from '../../../../packages/web-shared/src/contract-call-built.js';
import {
  registryPutBuilt,
  registryValuesAt,
  type RegistryBuildingDeps,
  type RegistryParts
} from './registry-put-built.js';

/*
 * **THE REGISTRY'S ONE WRITE, AS THE WALLET BUILDS IT**: one call to `put` on the registry named, with the tag and the
 * value given and nothing else, built on the registry's state read at one block and spending no coin; and what the
 * registry holds at a person's tags, read off the same state.
 */

const REGISTRY = '5e'.repeat(32);
const tag = new Uint8Array(32).fill(1);
const value = new Uint8Array(288).fill(2);

describe('the registry write built in the wallet', () => {
  it('is one put to the registry named, of the tag and value given, on the state read, spending no coin, and proved as put', async () => {
    const asked: unknown[] = [];
    const proved: unknown[] = [];
    const d = {
      ledger: {
        ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'cpk', encryptionPublicKey: 'epk', clear: () => {} }) }
      },
      contracts: {
        buildCall: async (zk: unknown, call: unknown, epk: unknown) => {
          asked.push({ zk, call, epk });
          return { private: { unprovenTx: 'U' } };
        }
      },
      network: 'preprod',
      registry: { compiled: 'REGISTRY', zkConfig: 'ZK' } as unknown as RegistryParts,
      prove: async (u: unknown, c?: string) => {
        proved.push([u, c]);
        return { serialize: () => new Uint8Array([9]) };
      }
    } as unknown as RegistryBuildingDeps;
    const tx = await registryPutBuilt(d, {
      registry: REGISTRY,
      tag,
      value,
      state: new Uint8Array([3]),
      parameters: new Uint8Array([4])
    });
    /* RED WHEN: the write calls another circuit or contract, carries more than the tag and value, or spends a coin. */
    expect(asked).toEqual([
      {
        zk: 'ZK',
        epk: 'epk',
        call: {
          compiledContract: 'REGISTRY',
          circuitId: 'put',
          contractAddress: REGISTRY,
          coinPublicKey: 'cpk',
          network: 'preprod',
          read: { contract: new Uint8Array([3]), zswap: SPENDS_NO_COIN, parameters: new Uint8Array([4]) },
          args: [tag, value]
        }
      }
    ]);
    /* RED WHEN: the proof is made for another circuit than the one called. */
    expect(proved).toEqual([['U', 'put']]);
    expect(tx).toEqual(new Uint8Array([9]));
  });

  it("reads each tag's value, or null for a tag the registry does not hold", () => {
    const held = new Map([[tag.join(','), value]]);
    const registry = {
      contractState: { deserialize: () => ({ data: 'DATA' }) },
      ledger: (data: unknown) => {
        expect(data).toBe('DATA');
        return {
          entries: {
            member: (t: Uint8Array) => held.has(t.join(',')),
            lookup: (t: Uint8Array) => held.get(t.join(','))!
          }
        };
      }
    } as unknown as Pick<RegistryParts, 'ledger' | 'contractState'>;
    /* RED WHEN: a tag the registry does not hold reads as holding something, or a held one as free. */
    expect(registryValuesAt(registry, new Uint8Array([1]), [tag, new Uint8Array(32).fill(7)])).toEqual([value, null]);
  });
});
