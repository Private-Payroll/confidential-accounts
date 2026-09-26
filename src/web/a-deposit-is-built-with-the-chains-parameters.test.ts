/**
 * **A DEPOSIT IS BUILT WITH THE LEDGER PARAMETERS THE CHAIN HOLDS NOW, AND WITH
 * NO OTHERS.** The ledger, the transaction builder and the prover are handed to
 * the builder, so each is stood in here by an object that answers only what
 * the builder may ask - the ledger's starting parameters included, which
 * refuse to be asked at all.
 */
import { describe, it, expect } from 'vitest';
import { buildDeposit, type VaultBuilderDeps } from './vault-builder.js';
import { answerVaultAsk } from './vault-worker-entry.js';

const VAULT = 'cd'.repeat(32);
const COIN = { nonce: 'c1'.repeat(32), token: 'ab'.repeat(32), value: 5n };
const CHAIN_PARAMETERS = new Uint8Array([9, 8, 7, 6, 5]);
const base64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

const standIns = () => {
  const asked: Array<{ circuitId: string; ledgerParameters: unknown }> = [];
  const read: Uint8Array[] = [];
  const ledger = {
    ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'cpk', encryptionPublicKey: 'epk' }) },
    ZswapChainState: class {},
    LedgerParameters: {
      deserialize: (raw: Uint8Array) => { read.push(raw); return { readFrom: raw }; },
      initialParameters: () => { throw new Error('the ledger\'s starting parameters were asked for'); },
    },
  };
  const deps: VaultBuilderDeps = {
    ledger,
    runtimeState: { deserialize: () => ({ state: true }) },
    contracts: {
      createUnprovenDeployTxFromVerifierKeys: async () => { throw new Error('no deploy here'); },
      createUnprovenCallTxFromInitialStates: async (_zk: unknown, options: { circuitId: string; ledgerParameters: unknown }) => {
        asked.push({ circuitId: options.circuitId, ledgerParameters: options.ledgerParameters });
        return { private: { unprovenTx: 'unproven' } };
      },
    },
    compiled: {},
    zkConfig: {},
    prove: async () => ({ serialize: () => new Uint8Array([1]) }),
    network: 'undeployed',
    random: (n) => new Uint8Array(n).fill(4),
  };
  return { deps, asked, read };
};

describe('the ledger parameters a deposit is built with', () => {
  it('ARE THE CHAIN\'S, AS HANDED OVER, AND NEVER THE LEDGER\'S STARTING ONES', async () => {
    const { deps, asked, read } = standIns();
    await buildDeposit(deps, { vault: VAULT, coin: COIN, state: new Uint8Array([1]), parameters: CHAIN_PARAMETERS });
    /* RED WHEN: the deposit is built with `LedgerParameters.initialParameters()` - the stand-in throws. */
    expect(read, 'RED WHEN: the parameters read are not the bytes the chain served').toEqual([CHAIN_PARAMETERS]);
    expect(asked, 'RED WHEN: the call is built with anything but the parameters just read').toEqual([
      { circuitId: 'deposit', ledgerParameters: { readFrom: CHAIN_PARAMETERS } },
    ]);
  });

  it('REFUSES TO BUILD WITH NO PARAMETERS, AND BUILDS NOTHING', async () => {
    const { deps, asked } = standIns();
    for (const parameters of [new Uint8Array(0), undefined as unknown as Uint8Array]) {
      /* RED WHEN: a deposit with no parameters falls back to some others instead of refusing. */
      await expect(buildDeposit(deps, { vault: VAULT, coin: COIN, state: new Uint8Array([1]), parameters }))
        .rejects.toThrow(/current ledger parameters were not handed over, so nothing was built or sent/);
    }
    expect(asked).toEqual([]);
  });

  it('REACH THE BUILDER FROM THE PAGE\'S ASK, THROUGH THE WORKER, AS THE SAME BYTES', async () => {
    const { deps, asked, read } = standIns();
    const answer = await answerVaultAsk(async () => deps as never, {
      id: 7, network: 'undeployed', ask: 'deposit', vault: VAULT,
      coin: { nonce: COIN.nonce, token: COIN.token, value: '5' }, state: base64(new Uint8Array([1])), parameters: base64(CHAIN_PARAMETERS),
    });
    expect(answer).toMatchObject({ id: 7, ok: true, ask: 'deposit' });
    /* RED WHEN: the worker drops the ask's parameters or hands the builder other bytes. */
    expect(read.map((b) => Array.from(b))).toEqual([Array.from(CHAIN_PARAMETERS)]);
    expect(asked).toHaveLength(1);
    /* An ask that names none is refused by the builder, not built with some. */
    await expect(answerVaultAsk(async () => deps as never, {
      id: 8, network: 'undeployed', ask: 'deposit', vault: VAULT,
      coin: { nonce: COIN.nonce, token: COIN.token, value: '5' }, state: base64(new Uint8Array([1])),
    } as never)).rejects.toThrow(/parameters were not handed over/);
    expect(asked).toHaveLength(1);
  });
});
