/**
 * **A PAYMENT THAT DRAWS ON TWO NOTES IS BUILT WITH BOTH, THROUGH THE WORKER.**
 *
 * The device chooses a payment's notes before the call: the first is the note
 * the vault's witness is offered, the rest go in the payout's further place.
 * Here the worker's own `payout` ask is driven with the call builder stood in,
 * so what reaches the circuit - the witness's answer and the further place -
 * is read exactly as built, and the pool's record after it lands is the
 * worker's own `after-payment` answer.
 */
import { describe, it, expect } from 'vitest';
import { answerVaultAsk } from './vault-worker-entry.js';
import { vaultNoteCommitment } from '../../../src/midnight/note-index.js';
import { payeeFor } from '../../../src/testing/payees.js';

const VAULT = 'ab'.repeat(32);
const ACCOUNT = 'c0'.repeat(32);
const TOKEN = '9b'.repeat(32);
const A = { nonce: '11'.repeat(32), token: TOKEN, value: '120', createdIn: '0e'.repeat(32) };
const B = { nonce: '12'.repeat(32), token: TOKEN, value: '100', createdIn: '0f'.repeat(32) };
const b64 = (s: string) => Buffer.from(s).toString('base64');
/** A path of sixteen steps, each a node, a sum and a side as their bytes: what an approved leaf's path looks like on the wire. */
const PATH = Array.from({ length: 16 }, () => ['00'.repeat(32), '00'.repeat(16), '00']).flat();

/** The events of the transaction that made `note`, filing it for this vault at `index`. */
const eventsMaking = async (note: typeof A, index: number) => [{
  transactionHash: note.createdIn,
  details: {
    tag: 'zswapOutput', contract: VAULT, mtIndex: String(index),
    commitment: await vaultNoteCommitment({ nonce: note.nonce, token: note.token, value: BigInt(note.value) } as never, VAULT as never),
  },
}];

/** The worker's dependencies with the call builder stood in: it asks the witness as the circuit would, and records the call. */
const standIn = () => {
  const seen: { args?: unknown[]; offered?: { nonce: Uint8Array; value: bigint; mt_index: bigint } } = {};
  const deps = {
    ledger: {
      ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'cpk', encryptionPublicKey: 'epk' }) },
      ZswapChainState: { deserialize: () => ({}) },
      LedgerParameters: { deserialize: () => ({}) },
    },
    runtimeState: { deserialize: () => ({}) },
    zkConfig: {},
    compiled: {},
    compiledWith: (w: { noteToSpend: (ctx: unknown, token: Uint8Array, amount: bigint) => [unknown, never] }) => w,
    contracts: {
      createUnprovenDeployTxFromVerifierKeys: async () => { throw new Error('no deploy here'); },
      createUnprovenCallTxFromInitialStates: async (_zk: unknown, o: { compiledContract: any; args: unknown[] }) => {
        seen.args = o.args;
        const [, coin] = o.compiledContract.noteToSpend({}, Buffer.from(TOKEN, 'hex'), o.args[3]);
        seen.offered = coin;
        return {
          private: {
            unprovenTx: 'U',
            nextZswapLocalState: {
              outputs: [{
                recipient: { is_left: false, left: '', right: VAULT },
                coinInfo: { nonce: 'cc'.repeat(32), type: TOKEN, value: 20n },
              }],
            },
          },
        };
      },
    },
    prove: async () => ({ serialize: () => new Uint8Array([1]) }),
    random: (n: number) => new Uint8Array(n).fill(7),
  };
  return { deps, seen };
};

describe('a payment that draws on two notes, through the worker', () => {
  it('OFFERS THE FIRST NOTE TO THE WITNESS AND PUTS THE FURTHER ONE IN THE CALL, EACH AT THE PLACE THE CHAIN FILED IT', async () => {
    const { deps, seen } = standIn();
    const payee = payeeFor('5a'.repeat(32), 'undeployed').bech32;
    const answer = await answerVaultAsk(async () => deps as never, {
      id: 1, network: 'undeployed', ask: 'payout', vault: VAULT, account: ACCOUNT,
      order: {
        asset: TOKEN, form: 'shielded', symbol: 'tUSD', vault: VAULT, proposal: '0f'.repeat(32), salt: '5a'.repeat(32),
        root: '9a'.repeat(32), payees: '1', opensAt: '1', closesAt: '2',
      },
      payment: {
        index: 0, kind: 'shielded', payee, token: TOKEN, amount: '200', blinding: '0b'.repeat(32),
        nonce: '0c'.repeat(32), leaf: '0d'.repeat(32), path: PATH, paid: false,
      },
      note: A, events: await eventsMaking(A, 41),
      further: [{ note: B, events: await eventsMaking(B, 42) }],
      secret: '5a'.repeat(32),
      chain: { blockHash: 'B1', vaultState: b64('V'), zswapState: b64('Z'), parameters: b64('P'), accountState: b64('A') },
    } as never) as { ok: boolean; spent?: string; change?: { value: string }; error?: string };
    expect(answer.ok, answer.error).toBe(true);
    /* RED WHEN: the witness is handed anything but the first note chosen, at the index its own transaction filed it. */
    expect([Buffer.from(seen.offered!.nonce).toString('hex'), seen.offered!.value, seen.offered!.mt_index]).toEqual([A.nonce, 120n, 41n]);
    /* RED WHEN: the further note does not reach the call - the payment would draw on one note and be refused - or the worker drops it. */
    const further = seen.args![5] as Array<{ nonce: Uint8Array; value: bigint; mt_index: bigint }>;
    expect(further.map((p) => [Buffer.from(p.nonce).toString('hex'), p.value, p.mt_index])).toEqual([[B.nonce, 100n, 42n]]);
    expect(answer).toMatchObject({ spent: A.nonce, change: { value: '20' } });
  });

  it('A NOTE NAMED TWICE, OR NOTES THAT DO NOT COVER THE PAYMENT, ARE REFUSED BEFORE ANYTHING IS BUILT', async () => {
    const { deps, seen } = standIn();
    const payee = payeeFor('5a'.repeat(32), 'undeployed').bech32;
    const ask = async (further: unknown[], amount: string) => answerVaultAsk(async () => deps as never, {
      id: 2, network: 'undeployed', ask: 'payout', vault: VAULT, account: ACCOUNT,
      order: { asset: TOKEN, form: 'shielded', symbol: 'tUSD', vault: VAULT, proposal: '0f'.repeat(32), salt: '5a'.repeat(32), root: '9a'.repeat(32), payees: '1', opensAt: '1', closesAt: '2' },
      payment: { index: 0, kind: 'shielded', payee, token: TOKEN, amount, blinding: '0b'.repeat(32), nonce: '0c'.repeat(32), leaf: '0d'.repeat(32), path: PATH, paid: false },
      note: A, events: await eventsMaking(A, 41), further, secret: '5a'.repeat(32),
      chain: { blockHash: 'B1', vaultState: b64('V'), zswapState: b64('Z'), parameters: b64('P'), accountState: b64('A') },
    } as never);
    /* RED WHEN: one note offered twice, or notes holding less than the payment, reach the call builder. */
    await expect(ask([{ note: A, events: await eventsMaking(A, 41) }], '200')).rejects.toThrow(/different notes/);
    await expect(ask([{ note: B, events: await eventsMaking(B, 42) }], '221')).rejects.toThrow(/do not cover/);
    expect(seen.args).toBeUndefined();
  });

  it('THE POOL AFTER IT LANDED HOLDS NEITHER NOTE, THROUGH THE WORKER\'S OWN ANSWER', async () => {
    const answer = await answerVaultAsk(async () => ({}) as never, {
      id: 3, network: 'undeployed', ask: 'after-payment', notes: [A, B], spent: A.nonce, further: [B.nonce], amount: '200',
      change: { nonce: 'cc'.repeat(32), token: TOKEN, value: '20' }, createdIn: 'dd'.repeat(32),
    } as never) as { ok: boolean; notes?: Array<{ nonce: string }> };
    /* RED WHEN: the worker drops the further note on its way to the pool's rule - the record would keep a spent note. */
    expect(answer).toMatchObject({ ok: true, notes: [{ nonce: 'cc'.repeat(32), value: '20', createdIn: 'dd'.repeat(32) }] });
  });
});
