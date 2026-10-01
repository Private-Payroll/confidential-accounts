/**
 * **A PRIVATE DEPOSIT IS BUILT IN THE VAULT'S WORKER EVEN WHERE THE RUNTIME HAS
 * NO `Buffer`, AS IN EVERY BROWSER.**
 *
 * The contract runtime turns the commitment of the coin a deposit makes into
 * hex with Node's `Buffer`. In Node that is a global and nothing notices; in a
 * browser's worker it does not exist, and the deposit circuit stopped inside
 * `receiveShielded` with `Buffer is not defined`, wrapped as "Error executing
 * circuit 'deposit'", before the depositor's wallet was ever asked. That is
 * how a real deposit failed on stagenet, and every test here was green,
 * because every test here runs in Node.
 *
 * This runs the worker's own handler with the real ledger, contract runtime,
 * compiled vault and transaction builder, over the state of a real vault on
 * stagenet and the parameters that chain held, read from its indexer and kept
 * in `contracts/fixtures/a-vault-on-stagenet/state.json`, with `Buffer` taken
 * away for the length of the ask. Only the prover is stood in: it is reached
 * only once the circuit has run.
 *
 * That vault is of the old shape, five fields and no secret, and this build's
 * vault takes no money until its account has approved a secret. So its state
 * is carried into this build's fourteen fields as an approved secret run and
 * its written sealed copies would leave it: its own account, notes, public
 * tokens and count, a secret's commitment, the mark the last copy leaves, and
 * this build's empty fields otherwise.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import * as vaultModule from '../../../contracts/managed-vault/contract/index.js';
import { answerVaultAsk, type WorkerDeps } from './vault-worker-entry.js';
import onStagenet from '../../../contracts/fixtures/a-vault-on-stagenet/state.json';

const NET = onStagenet.network;
const VAULT = onStagenet.vault;
const COIN = { nonce: '3a'.repeat(31) + '07', token: '1d'.repeat(32), value: '5100000' };
const { parameters } = onStagenet;

/** The stagenet vault's state in this build's shape, started: what the deposit circuit reads. */
const startedState = async (): Promise<string> => {
  const Rt = runtime as any;
  const onChain = Rt.ContractState.deserialize(Buffer.from(onStagenet.state, 'base64'));
  const theirs = onChain.data.state.asArray();
  const nothingCallsThese = new Proxy({}, { get: () => () => { throw new Error('a constructor calls no witness'); } });
  const built = await new (vaultModule as any).Contract(nothingCallsThese).initialState(
    { initialPrivateState: {}, initialZswapLocalState: { coinPublicKey: new Uint8Array(32) } }, { bytes: new Uint8Array(32) });
  const ours = built.currentContractState.data.state.asArray();
  const commitment = Rt.StateValue.newCell({ value: [new Uint8Array(32).fill(0x51)], alignment: ours[5].asCell().alignment });
  let fields = Rt.StateValue.newArray();
  const bytes32 = new Rt.CompactTypeBytes(32);
  const aligned = (b: Uint8Array) => ({ value: bytes32.toValue(b), alignment: bytes32.alignment() });
  /* And the mark the last sealed copy leaves, without which the vault still takes no money. */
  const written = Rt.StateValue.newMap(ours[7].asMap().insert(
    aligned((vaultModule as any).pureCircuits.copiesWrittenKey()), Rt.StateValue.newCell(aligned(new Uint8Array(32).fill(0x51)))));
  for (let i = 0; i < ours.length; i++) fields = fields.arrayPush(i < 4 ? theirs[i] : i === 5 ? commitment : i === 7 ? written : ours[i]);
  onChain.data = new Rt.ChargedState(fields);
  return Buffer.from(onChain.serialize()).toString('base64');
};
const state = await startedState();
const proved: Array<string | undefined> = [];

const deps = (): WorkerDeps => ({
  ledger: L,
  vault: vaultModule,
  runtimeState: (runtime as any).ContractState,
  contracts: contracts as any,
  compiled: CompiledContract.make('Vault', (vaultModule as any).Contract).pipe(
    CompiledContract.withWitnesses({ noteToSpend: () => { throw new Error('a deposit spends no note'); }, nonceSecret: () => { throw new Error('a deposit spends no note'); } } as never)),
  zkConfig: new NodeZkConfigProvider(new URL('../../../contracts/managed-vault', import.meta.url).pathname),
  prove: async (_unproven: unknown, circuit?: string) => { proved.push(circuit); return { serialize: () => new Uint8Array([7]) }; },
} as unknown as WorkerDeps);

/** Runs `go` with no `Buffer` anywhere global, as a browser's worker has none, and puts back what was there. */
const withoutBuffer = async <T,>(go: () => Promise<T>): Promise<T> => {
  const g = globalThis as { Buffer?: unknown };
  const held = g.Buffer;
  delete g.Buffer;
  try {
    return await go();
  } finally {
    g.Buffer = held;
  }
};

describe('a private deposit, built in the vault worker', () => {
  it('RUNS THE DEPOSIT CIRCUIT WHERE THERE IS NO Buffer, AND REACHES THE PROVER', async () => {
    proved.length = 0;
    const answer = await withoutBuffer(() => answerVaultAsk(async () => deps(), {
      id: 1, network: NET, ask: 'deposit', vault: VAULT, coin: COIN, state, parameters,
    }));
    /* RED WHEN the worker leaves the runtime without a Buffer: the circuit stops in receiveShielded, as a real deposit's did on stagenet. */
    expect(answer).toMatchObject({ id: 1, ok: true, ask: 'deposit' });
    /* RED WHEN the circuit did not run to the end: the prover is reached only after it has. */
    expect(proved).toEqual(['deposit']);
  });

  it('BUILDS WITH THE Buffer A BROWSER IS GIVEN, WHICH IS THE PACKAGE AND NOT NODE\'S OWN', async () => {
    /* In Node the bare name resolves to Node's own; a browser's bundle resolves it to the package on disk. */
    const packaged = (createRequire(import.meta.url)('buffer/') as { Buffer: unknown }).Buffer;
    expect(packaged, 'the control: this is not Node\'s own Buffer').not.toBe(Buffer);
    proved.length = 0;
    const answer = await withoutBuffer(async () => {
      (globalThis as { Buffer?: unknown }).Buffer = packaged;
      return answerVaultAsk(async () => deps(), { id: 3, network: NET, ask: 'deposit', vault: VAULT, coin: COIN, state, parameters });
    });
    /* RED WHEN the package a browser gets cannot do what the runtime asks of Buffer. */
    expect(answer).toMatchObject({ id: 3, ok: true, ask: 'deposit' });
    expect(proved).toEqual(['deposit']);
  });

  it('THE CONTROL: THE SAME ASK IN NODE, WITH ITS OWN Buffer, BUILDS TOO', async () => {
    proved.length = 0;
    const answer = await answerVaultAsk(async () => deps(), {
      id: 2, network: NET, ask: 'deposit', vault: VAULT, coin: COIN, state, parameters,
    });
    /* RED WHEN the ask itself is wrong, so the case above would be red for a reason that is not Buffer. */
    expect(answer).toMatchObject({ id: 2, ok: true, ask: 'deposit' });
    expect(proved).toEqual(['deposit']);
  });
});
