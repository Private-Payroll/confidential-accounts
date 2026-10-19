/**
 * **A PUBLIC DEPOSIT IS PROVED FOR REAL ON THE DEVICE, THROUGH THE WORKER THE PAGE STARTS, ON ONE THREAD AND ON TWO.**
 *
 * The worker's own entry (`startVaultWorker`) runs over the origin's own artefact routes, with the vault's real
 * compiled contract and the real proving keys and public parameters, and the page asks it for a public deposit
 * (`depositUnshielded`, which needs one small proof; the vault's other public circuits `forgetUnshielded` and `retire` are small too, but the public deposit is the page's own path). The proof is real: the
 * prover checks what it makes against the verifier key it is handed. Nothing is sent anywhere. The vault is a fresh
 * deploy given a started state, because a vault fresh from its deploy is not yet started.
 *
 * Facts come from the compiled contract and its keys on disk, never from the service: the served files are checked
 * by the device against this build's own digests, so a key the service alters by one byte must be refused by name
 * before anything is proved or kept.
 *
 * **WHAT THIS DOES NOT SHOW**: that the chain accepts the proof (the ledger this repository installs verifies no
 * contract proof, and the last tests here pin exactly that), the wallet's balancing of the deposit, or any chain.
 *
 * Needs every verifier key on disk (`npm run compact:vault -- --full` builds them), the `depositUnshielded` proving
 * key and circuit, and the public parameters for size 9, whose digest is Midnight's published one. The transaction
 * checked here is the page's own unproven deposit, which holds one proof; the person's wallet adds its own later.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker as ThreadWorker } from 'node:worker_threads';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { IDBFactory } from 'fake-indexeddb';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { createProofProvider } from '@midnight-ntwrk/midnight-js-types';
import * as vaultModule from '../../../contracts/managed-vault/contract/index.js';
import { buildPublicDeposit, buildVaultDeploy, whyNotOnlyThisPublicDeposit, type VaultBuilderDeps } from './vault-builder.js';
import { startVaultWorker } from './vault-worker-entry.js';
import { provingOnWorkers } from './vault-proof-workers.js';
import { vaultArtefactPlaces, vaultArtefactRoutes } from '../../../src/server/vault-artefacts.js';
import { publishedByMidnight } from '../../../src/server/proving-parameters.js';
import { fileKeyMaterialSource, wasmProofProvider } from '../../../src/midnight/wasm-proving.js';
import { keysOnDisk } from '../../../contracts/test/keys-on-disk.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PLACES = vaultArtefactPlaces(ROOT, process.env);
const CIRCUIT = 'depositUnshielded';
const PARAMETERS = 'bls_midnight_2p9';
const NET = 'undeployed';
const TOKEN = 'ab'.repeat(32);
const AMOUNT = 40n;
const ACCOUNT = 'c0'.repeat(32);

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const placeOf = (file: string): string => join(PLACES.compiled, file);
const FILES = {
  prover: `keys/${CIRCUIT}.prover`, verifier: `keys/${CIRCUIT}.verifier`, ir: `zkir/${CIRCUIT}.bzkir`,
} as const;

/** Why the real prover cannot run here, or null. Checks the files the one circuit needs and the published digest of its parameters. */
const whyNotHere = (): string | null => {
  const keys = keysOnDisk();
  if (!keys.ok) return keys.why;
  for (const file of Object.values(FILES)) if (!existsSync(placeOf(file))) return `${placeOf(file)} is missing`;
  const params = join(PLACES.params, PARAMETERS);
  if (!existsSync(params)) return `${params} is missing`;
  if (sha256(readFileSync(params)) !== publishedByMidnight(PARAMETERS)) return `${params} is not the file Midnight publishes`;
  return null;
};
const WHY_NOT = whyNotHere();
const CAN_PROVE_HERE = WHY_NOT === null;
if (WHY_NOT !== null) console.log(`  NOT CHECKED HERE: a public deposit was not proved on the device, because ${WHY_NOT}`);

/** The same thread the page spawns, run as a node thread. It counts what it was built for and what it was told. */
const threads: Array<{ readonly told: Array<{ op?: string }> }> = [];
class ThreadOnNode {
  private readonly worker: ThreadWorker;
  readonly told: Array<{ op?: string }> = [];
  constructor(_url: unknown, _options?: unknown) {
    threads.push(this);
    const entry = JSON.stringify(`file://${join(ROOT, 'packages/web-shared/src/vault-proof-worker-entry.ts')}`);
    // The entry talks to a worker scope; a node thread has `parentPort`. The scope also carries `crypto`, which the
    // proving code reads its randomness from, as a browser's worker scope does.
    this.worker = new ThreadWorker(`const { parentPort } = require('node:worker_threads');
globalThis.self = { crypto: globalThis.crypto, postMessage: (m) => parentPort.postMessage(m),
  addEventListener: (type, l) => { parentPort.on('message', (data) => l({ data })); } };
import(${entry});`, { eval: true });
  }
  postMessage(message: { op?: string }): void { this.told.push(message); this.worker.postMessage(message); }
  addEventListener(type: string, listener: (e: unknown) => void): void {
    if (type === 'message') this.worker.on('message', (data) => listener({ data }));
    else this.worker.on('error', (e: Error) => listener({ message: e.message }));
  }
  terminate(): void { void this.worker.terminate(); }
}

type Posted = { id?: number; ok?: boolean; kind?: string; state?: string; tx?: string; error?: string; name?: string; ask?: string };

describe.skipIf(!CAN_PROVE_HERE)('A PUBLIC DEPOSIT IS PROVED FOR REAL ON THE DEVICE [needs contracts/managed-vault/keys and the size 9 public parameters; `npm run compact` then `npm run compact:vault -- --full` build the keys]', () => {
  const zk = new NodeZkConfigProvider(PLACES.compiled);
  const compiled = CompiledContract.make('Vault', (vaultModule as any).Contract).pipe(
    CompiledContract.withWitnesses({ noteToSpend: () => { throw new Error('a deposit spends no note'); }, nonceSecret: () => { throw new Error('a deposit spends no note'); } } as never));
  const baseDeps = (): Omit<VaultBuilderDeps, 'prove'> => ({
    ledger: L, runtimeState: (runtime as any).ContractState, compiled, zkConfig: zk, network: NET, contracts: contracts as any,
  } as never);
  const parameters = L.LedgerParameters.initialParameters().serialize();

  let vault: string;
  let deployTx: any;
  let startedState: Uint8Array;
  let server: Server;
  let port: number;
  let served: string[] = [];
  let tamper: ((path: string) => Uint8Array | null) | null = null;

  beforeAll(async () => {
    setNetworkId(NET as never);
    const built = await buildVaultDeploy({ ...baseDeps(), prove: async (tx: any) => tx } as VaultBuilderDeps, { account: ACCOUNT });
    vault = built.vault;
    deployTx = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', built.proven);
    const deployed: any = L.ContractState.deserialize(deployTx.intents.values().next().value.actions[0].initialState.serialize());
    const fields = deployed.data.state.asArray();
    const held = (vaultModule as any).pureCircuits.secretCommitmentOf(Buffer.from(vault, 'hex'), Buffer.from('51'.repeat(31) + '00', 'hex'));
    const bytes32 = new (runtime as any).CompactTypeBytes(32);
    const aligned = (b: Uint8Array) => ({ value: bytes32.toValue(b), alignment: bytes32.alignment() });
    let next = (L as any).StateValue.newArray();
    fields.forEach((f: unknown, i: number) => {
      next = next.arrayPush(i === 5 ? (L as any).StateValue.newCell({ value: [held], alignment: fields[5].asCell().alignment })
        : i === 7 ? (L as any).StateValue.newMap(fields[7].asMap().insert(
          aligned((vaultModule as any).pureCircuits.copiesWrittenKey()), (L as any).StateValue.newCell(aligned(held))))
          : f);
    });
    deployed.data = new (L as any).ChargedState(next);
    startedState = deployed.serialize();

    const app = express();
    app.use((req, res, nxt) => {
      served.push(req.path);
      const altered = tamper?.(req.path) ?? null;
      if (altered === null) { nxt(); return; }
      res.type('application/octet-stream').send(Buffer.from(altered));
    });
    app.use(vaultArtefactRoutes(PLACES));
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    port = (server.address() as AddressInfo).port;
  }, 60_000);
  afterAll(async () => { await new Promise((r) => server.close(r)); });

  const flipped = (file: string, at: number) => (path: string): Uint8Array | null => {
    if (path !== `/artefacts/vault/${file}`) return null;
    const bytes = Uint8Array.from(readFileSync(placeOf(file)));
    bytes[at] = bytes[at]! ^ 1;
    return bytes;
  };

  /** One public-deposit ask to the worker's own entry, on this device's scope. Resolves with everything the page was sent. */
  const ask = async (how: { threads: boolean; state?: Uint8Array }) => {
    const posted: Posted[] = [];
    const idb = new IDBFactory();
    let listener: ((e: { data: unknown }) => void) | undefined;
    const scope: any = {
      indexedDB: idb, crypto: globalThis.crypto, console, navigator: { hardwareConcurrency: 2 },
      fetch: (url: string, init?: unknown) => fetch(`http://127.0.0.1:${port}${url}`, init as never),
      postMessage: (m: Posted) => { posted.push(m); },
      addEventListener: (_type: string, l: (e: { data: unknown }) => void) => { listener = l; },
      ...(how.threads ? { Worker: ThreadOnNode } : {}),
    };
    threads.length = 0;
    served = [];
    if (how.threads) vi.stubGlobal('Worker', ThreadOnNode);
    try {
      startVaultWorker(scope);
      listener!({ data: {
        id: 1, network: NET, ask: 'public-deposit', vault, token: TOKEN, amount: String(AMOUNT),
        state: Buffer.from(how.state ?? startedState).toString('base64'), parameters: Buffer.from(parameters).toString('base64'),
      } });
      const deadline = Date.now() + 90_000;
      while (!posted.some((p) => p.id === 1 && p.ok !== undefined) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    } finally { vi.unstubAllGlobals(); }
    const answer = posted.find((p) => p.id === 1 && p.ok !== undefined);
    return { posted, answer, served: [...new Set(served)].sort(), idb, threads: [...threads] };
  };

  const filedIn = (idb: IDBFactory): Promise<string[]> => new Promise((resolve, reject) => {
    const open = idb.open('confidential-accounts-artefacts', 1);
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains('artefacts')) open.result.createObjectStore('artefacts'); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const keys = db.transaction('artefacts', 'readonly').objectStore('artefacts').getAllKeys();
      keys.onsuccess = () => { db.close(); resolve(keys.result.map(String).sort()); };
      keys.onerror = () => reject(keys.error);
    };
  });

  const proven = (b64: string | undefined) => L.Transaction.deserialize('signature', 'proof', 'pre-binding', Buffer.from(b64!, 'base64')) as any;
  const callOf = (tx: any) => [...tx.intents.values()].flatMap((i: any) => i.actions);
  const proofBytesOf = (tx: any): Uint8Array => callOf(tx)[0].proof.serialize();

  /** What a proved public deposit must be: one call to the vault's public deposit, a real proof, no offer, the token and amount asked. */
  const expectAPublicDeposit = (b64: string | undefined) => {
    const tx = proven(b64);
    const calls = callOf(tx);
    expect(tx.intents.size, 'one intent').toBe(1);
    expect(calls, 'one call').toHaveLength(1);
    const entry = calls[0].entryPoint;
    expect(entry instanceof Uint8Array ? new TextDecoder().decode(entry) : String(entry)).toBe(CIRCUIT);
    expect(String(calls[0].address).toLowerCase()).toBe(vault);
    expect(tx.guaranteedOffer, 'no private money moves').toBeUndefined();
    expect(tx.fallibleOffer, 'no private money moves').toBeUndefined();
    for (const intent of tx.intents.values()) {
      expect(intent.dustActions, 'the page\'s deposit carries no fee proof of its own').toBeUndefined();
      expect(intent.guaranteedUnshieldedOffer, 'the page\'s deposit moves no public money of its own').toBeUndefined();
    }
    expect(proofBytesOf(tx).length, 'a proof is there').toBeGreaterThan(1000);
    expect(whyNotOnlyThisPublicDeposit(tx.eraseProofs(), { vault, token: TOKEN, amount: AMOUNT })).toBeNull();
    return tx;
  };

  const SERVED_FOR_THE_DEPOSIT = [
    `/artefacts/vault/${FILES.ir}`, `/artefacts/vault/${FILES.prover}`, `/artefacts/vault/${FILES.verifier}`, `/artefacts/vault/params/${PARAMETERS}`,
  ].sort();

  /** The deposit's three files and its parameters, each kept under the digest this build knows it by. */
  const expectKeptUnderThisBuildsDigests = async (idb: IDBFactory) => {
    const vk = (vaultModule as any).expectedVk[CIRCUIT] as string;
    const kept = await filedIn(idb);
    expect(kept, 'RED WHEN: the device keeps a file under a name that does not bind it to this build\'s digest').toEqual([
      `artefact:ir:${CIRCUIT}?vk=${vk}&sha256=${sha256(readFileSync(placeOf(FILES.ir)))}`,
      `artefact:params:${PARAMETERS}?sha256=${publishedByMidnight(PARAMETERS)}`,
      `artefact:prover:${CIRCUIT}?vk=${vk}&sha256=${sha256(readFileSync(placeOf(FILES.prover)))}`,
      `artefact:verifier:${CIRCUIT}?vk=${vk}&sha256=${sha256(readFileSync(placeOf(FILES.verifier)))}`,
    ].sort());
  };

  const wordsAround = (posted: Posted[]) => {
    const start = posted.findIndex((p) => p.kind === 'vault-proof' && p.state === 'started');
    const end = posted.findIndex((p) => p.kind === 'vault-proof' && p.state === 'ended');
    return { start, end, busyWithin: posted.filter((p, i) => p.kind === 'vault-worker-busy' && i > start && i < end).length };
  };

  it('a public deposit is proved for real on this device\'s own thread, from the files the service serves', async () => {
    const run = await ask({ threads: false });
    expect(run.answer?.ok, run.answer?.error).toBe(true);
    expectAPublicDeposit(run.answer?.tx);
    expect(run.served, 'RED WHEN: the deposit starts needing a key or circuit other than its own').toEqual(SERVED_FOR_THE_DEPOSIT);
    await expectKeptUnderThisBuildsDigests(run.idb);
    const { start, end } = wordsAround(run.posted);
    const answered = run.posted.findIndex((p) => p.id === 1 && p.ok !== undefined);
    expect(start, 'RED WHEN: the page is not told a proof began').toBeGreaterThanOrEqual(0);
    expect(end, 'RED WHEN: the page is not told a proof ended').toBeGreaterThan(start);
    expect(answered).toBeGreaterThan(end);
    expect(run.threads, 'one thread means no worker thread was made').toHaveLength(0);
  }, 120_000);

  it('a public deposit is proved for real on a second thread, whose key fetches the page is told of', async () => {
    const run = await ask({ threads: true });
    expect(run.answer?.ok, run.answer?.error).toBe(true);
    expectAPublicDeposit(run.answer?.tx);
    expect(run.served, 'RED WHEN: the deposit starts needing a key or circuit other than its own').toEqual(SERVED_FOR_THE_DEPOSIT);
    await expectKeptUnderThisBuildsDigests(run.idb);
    expect(run.threads, 'RED WHEN: the proof falls back to the page\'s own thread without saying so').toHaveLength(1);
    expect(run.threads[0]!.told.map((m) => m.op), 'the thread was told to prove').toContain('prove');
    expect(wordsAround(run.posted).busyWithin,
      'RED WHEN: the thread\'s key and parameter fetches are not told to the page while it proves').toBeGreaterThanOrEqual(2);
  }, 120_000);

  /** The one deposit, unproven, as bytes, so each prover is handed its own copy of the same transaction. */
  const unprovenDeposit = async (state: Uint8Array = startedState): Promise<Uint8Array> => {
    let bytes: Uint8Array | undefined;
    await buildPublicDeposit({ ...baseDeps(), prove: async (tx: any) => { bytes = tx.serialize(); return { serialize: () => new Uint8Array(1) }; } } as VaultBuilderDeps,
      { vault, token: TOKEN, amount: AMOUNT, state, parameters });
    return bytes!;
  };
  const fresh = (bytes: Uint8Array) => L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', bytes) as any;
  const material = () => fileKeyMaterialSource(PLACES.compiled, PLACES.params);
  const spawnNodeThread = () => new ThreadOnNode(undefined) as never;

  it('the same unproven deposit proves to the same transaction on one thread and on two', async () => {
    const unproven = await unprovenDeposit();
    const erased = Buffer.from(fresh(unproven).eraseProofs().serialize());
    const source = await material();
    const oneThread = await (await wasmProofProvider(source)).proveTx(fresh(unproven), { circuitId: CIRCUIT } as never) as any;
    const provider = provingOnWorkers(source, spawnNodeThread);
    const twoThreads = await (createProofProvider(provider as never) as any).proveTx(fresh(unproven), { circuitId: CIRCUIT }) as any;
    provider.stop();
    for (const [how, tx] of [['one thread', oneThread], ['two threads', twoThreads]] as const) {
      const again = L.Transaction.deserialize('signature', 'proof', 'pre-binding', tx.serialize()) as any;
      expect(Buffer.from(again.eraseProofs().serialize()).equals(erased),
        `RED WHEN: ${how} proves a different transaction from the one it was handed`).toBe(true);
    }
    const [a, b] = [proofBytesOf(oneThread), proofBytesOf(twoThreads)];
    expect(a.length, 'RED WHEN: the two paths make proofs of different shapes').toBe(b.length);
    expect(Buffer.from(a).equals(Buffer.from(b)), 'RED WHEN: the second thread hands back a proof it did not make').toBe(false);
  }, 120_000);

  it('the prover refuses a proof made against another circuit\'s verifier key, or a verifier key altered at its byte 600', async () => {
    const unproven = await unprovenDeposit();
    const real = await material();
    const withVerifier = async (bytes: (honest: Uint8Array) => Uint8Array) => {
      const provider = await wasmProofProvider({
        getParams: (k) => real.getParams(k),
        lookupKey: async (location) => { const m = (await real.lookupKey(location))!; return { ...m, verifierKey: bytes(m.verifierKey) }; },
      });
      return (provider as any).proveTx(fresh(unproven), { circuitId: CIRCUIT });
    };
    const other = (circuit: string) => Uint8Array.from(readFileSync(placeOf(`keys/${circuit}.verifier`)));
    const honest = await withVerifier((v) => v);
    expect(proofBytesOf(honest).length, 'the honest key proves, so a refusal below is the key\'s').toBeGreaterThan(1000);
    await expect(withVerifier(() => other('forgetUnshielded')), 'RED WHEN: the prover stops checking its proof against the verifier key it is handed')
      .rejects.toThrow(/Invalid proof/);
    await expect(withVerifier((v) => { const c = Uint8Array.from(v); c[600] = c[600]! ^ 1; return c; }),
      'RED WHEN: a verifier key altered by one byte is used').rejects.toThrow(/problem reading the verifier key/);
  }, 120_000);

  it('the ledger\'s well-formedness check accepts a deposit whose proof was altered, so it is no check of the proof', async () => {
    const run = await ask({ threads: false });
    expect(run.answer?.ok, run.answer?.error).toBe(true);
    const strictness = new L.WellFormedStrictness();
    strictness.enforceBalancing = false;
    strictness.verifyContractProofs = true;
    strictness.verifyNativeProofs = true;
    strictness.verifySignatures = false;
    const ledger0 = new L.LedgerState(NET, new L.ZswapChainState());
    const [ledger] = ledger0.apply(deployTx.wellFormed(ledger0, strictness, new Date()),
      new L.TransactionContext(ledger0, { secondsSinceEpoch: BigInt(Math.floor(Date.now() / 1000)), secondsSinceEpochErr: 0, parentBlockHash: '00'.repeat(32), lastBlockTime: 0n }));
    const bytes = Buffer.from(run.answer!.tx!, 'base64');
    const checks = (b: Uint8Array) => (L.Transaction.deserialize('signature', 'proof', 'pre-binding', b) as any).wellFormed(ledger, strictness, new Date());
    expect(() => checks(bytes), 'the honest deposit is well formed against its deployed vault').not.toThrow();
    const proof = proofBytesOf(proven(run.answer!.tx));
    const piece = (from: number) => bytes.indexOf(Buffer.from(proof.subarray(from, from + 32)));
    const places = [Math.floor(proof.length / 4), Math.floor(proof.length / 2), Math.floor((proof.length * 3) / 4)].map((from) => piece(from) + 8);
    expect(places.every((at) => at >= 8), 'the proof is inside the transaction\'s bytes').toBe(true);
    for (const at of places) {
      const altered = Uint8Array.from(bytes);
      altered[at] = altered[at]! ^ 1;
      expect(() => checks(altered),
        'RED WHEN: the installed ledger starts verifying contract proofs, so the claims made of it here must be read again').not.toThrow();
    }
  }, 120_000);

  describe('a key the service alters by one byte is refused by name, on both threads, and nothing of it is kept', () => {
    const kinds = [['prover', FILES.prover, 70_000], ['verifier', FILES.verifier, 600], ['ir', FILES.ir, 250]] as const;
    for (const onThreads of [false, true]) {
      for (const [kind, file, at] of kinds) {
        it(`${onThreads ? 'a second thread' : 'the page\'s thread'} refuses a ${kind} the service altered, for the public deposit`, async () => {
          tamper = flipped(file, at);
          try {
            const run = await ask({ threads: onThreads });
            expect(run.answer?.ok, 'RED WHEN: the device proves with a file the service altered').toBe(false);
            expect(run.answer?.error, 'RED WHEN: the refusal does not say the service sent a file that is not this app\'s')
              .toMatch(/The service sent an? (proving key|verifying key|circuit) for the depositUnshielded circuit of the vault that is not this app's, so it was neither used nor kept, and no proof was made/);
            expect({ name: run.answer?.name, kind: run.answer?.kind },
              'RED WHEN: the page is not told by name that the service sent a file that is not this app\'s')
              .toEqual({ name: 'ProvingMaterialRefused', kind: 'other-bytes-served' });
            const kept = await filedIn(run.idb);
            expect(kept.filter((k) => k.startsWith(`artefact:${kind}:${CIRCUIT}`)),
              'RED WHEN: a file the service altered is kept for the next proof').toEqual([]);
            expect(run.posted.some((p) => p.id === 1 && p.ok === true)).toBe(false);
            if (onThreads && kind !== 'verifier') {
              expect(run.threads, 'the refusal came from a proof on the second thread').toHaveLength(1);
            }
          } finally { tamper = null; }
        }, 120_000);
      }
    }
  });

  describe('a vault whose deposit circuit is not this build\'s is refused before anything is fetched for the proof', () => {
    const otherCircuit = async () => {
      const state: any = L.ContractState.deserialize(startedState);
      const operation = new L.ContractOperation();
      operation.verifierKey = Uint8Array.from(readFileSync(placeOf('keys/payoutUnshielded.verifier')));
      state.setOperation(CIRCUIT, operation);
      return state.serialize() as Uint8Array;
    };
    for (const onThreads of [false, true]) {
      it(`${onThreads ? 'a second thread' : 'the page\'s thread'} refuses a vault whose deposit circuit is not this build\'s`, async () => {
        const run = await ask({ threads: onThreads, state: await otherCircuit() });
        expect(run.answer?.ok, 'RED WHEN: a deposit is proved for a vault whose circuit is not this build\'s').toBe(false);
        expect(run.answer?.error, 'RED WHEN: the refusal does not say the vault\'s circuit is not the one this app proves')
          .toMatch(/The depositUnshielded circuit this proof was asked for, for the vault, is not the one this app proves, so no proof was made/);
        expect({ name: run.answer?.name, kind: run.answer?.kind },
          'RED WHEN: the page is not told by name that the vault holds a circuit that is not this build\'s')
          .toEqual({ name: 'ProvingMaterialRefused', kind: 'not-this-builds-circuit' });
        expect(run.served, 'RED WHEN: anything is fetched for a vault whose circuit is not this build\'s').toEqual([]);
        expect(run.threads.flatMap((t) => t.told.map((m) => m.op))).not.toContain('prove');
      }, 120_000);
    }
  });
});
