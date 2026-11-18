import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { heldStateFromTheStart, type HeldStateDeps } from './held-from-the-start.js';

/*
 * A CONTRACT'S STARTING STATE IS ASSEMBLED FROM WHAT THE DEPLOY BUILDER READS.
 * The deploy builder hands back the deploy sealed for proving and, beside it,
 * the ledger's reading of the transaction and the runtime's reading of the
 * contract's starting state; the assembly reads only those readings. The
 * builder here is the device's and the service's in shape, with a constructor
 * that made nothing but its state, so the assembly can be read without this
 * build's keys.
 */

const holder = { tag: 'schnorr', value: Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(7))).toString('hex') };
const asked: string[] = [];

/** A deploy builder whose reading of the transaction carries `offers`, and whose sealed deploy carries none. */
const builderReading = (offers: Record<string, unknown> = {}): HeldStateDeps['contracts'] => ({
  buildDeploy: async (_zk, _coin, _asked, _enc, network) => {
    asked.push(network);
    return {
      public: { contractAddress: 'ab'.repeat(32), initialContractState: new runtime.ContractState() },
      private: { unprovenTx: { protocolVersion: 0n, stage: 'Unproven' } as never, transaction: { ...offers }, newCoins: [] },
    };
  },
});

const depsOver = (contracts: HeldStateDeps['contracts']): HeldStateDeps => ({
  ledger: L, runtimeState: runtime.ContractState, contracts, network: 'undeployed',
});
const input = { compiled: null, zkConfig: null, args: [], circuits: [], holders: { committee: [holder], threshold: 1 } };

describe('A CONTRACT HELD FROM ITS FIRST TRANSACTION, FROM WHAT ITS DEPLOY BUILDER READS', () => {
  it('is built for the network it is asked for, and held by the holders given, at counter 0', async () => {
    asked.length = 0;
    const state = await heldStateFromTheStart(depsOver(builderReading()), input);
    /* RED WHEN: the deploy is built without the network it is for. */
    expect(asked).toEqual(['undeployed']);
    const authority = state.maintenanceAuthority as { committee: unknown[]; threshold: number; counter: bigint };
    /* RED WHEN: the state is not held by the holders given, from its first transaction. */
    expect(authority.committee).toHaveLength(1);
    expect(authority.threshold).toBe(1);
    expect(authority.counter).toBe(0n);
  });

  it('refuses a constructor that made a coin, read from the ledger\'s reading of the deploy and not from its sealed copy', async () => {
    /* RED WHEN: the coins are looked for on the sealed deploy, which carries no offers to read, so a deploy making
     * a coin is built into a contract held from the start. */
    await expect(heldStateFromTheStart(depsOver(builderReading({ guaranteedOffer: {} })), input))
      .rejects.toThrow(/constructor made coins/u);
  });
});
