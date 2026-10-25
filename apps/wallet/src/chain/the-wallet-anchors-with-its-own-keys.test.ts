import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker as ThreadWorker } from 'node:worker_threads';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as accountModule from '../../../../contracts/managed/contract/index.js';
import { witnesses } from '../../../../contracts/src/witnesses.js';
import { privateStateFor, leafOfDevice, COMPANY_LABEL } from '../../../../contracts/test/simulator.js';
import { DEPLOYED_CIRCUITS } from '../../../../src/midnight/deferral.js';
import { EMPTY_HEAD } from '../../../../src/midnight/record-manifest.js';
import { answerVaultAsk } from '../../../../packages/web-shared/src/vault-worker-entry.js';
import { vaultBuilderDeps } from './vault-builder.js';
import { ACCOUNT_KEYS_FOLDER, makePinnedKeyMaterialProvider } from './key-material.js';
import { ACCOUNT_CIRCUITS_THE_WALLET_PROVES } from './account-circuits.js';
import { keptProvers, type ProvingWorkerLike } from './proving.js';

/*
 * **THE WALLET ANCHORS THE COMPANY'S RECORDS WITH ITS OWN KEYS, IN ITS OWN VAULT BUILDER.** At the end of a seat
 * action the wallet moves the company's record anchor on the chain: the call is built in the wallet's vault builder on
 * the account's state, proved with the anchor's proving key the wallet pinned, served at the account's own location,
 * on the wallet's own proving worker. The chain then takes the transaction with its proof checked against the key the
 * account was deployed with, and the head moves on. The first test builds the call and checks the key served for it;
 * the second proves it, which takes longer than the first.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ACCOUNT_KEYS = join(ROOT, 'contracts', 'managed', 'keys');
const WALLET_KEYS = join(ROOT, 'apps', 'wallet', 'public', 'keys');
const NET = 'undeployed';

const whyNotHere = (): string | null => {
  for (const c of DEPLOYED_CIRCUITS) {
    if (!existsSync(join(ACCOUNT_KEYS, `${c}.verifier`))) return `contracts/managed/keys/${c}.verifier is missing`;
  }
  const manifest = join(WALLET_KEYS, 'manifest.json');
  if (!existsSync(manifest)) return 'the wallet holds no key manifest';
  const pins = (JSON.parse(readFileSync(manifest, 'utf8')) as { artefacts: Record<string, unknown> }).artefacts;
  for (const file of ['prover', 'verifier', 'bzkir'].map((k) => `${ACCOUNT_KEYS_FOLDER}/anchor.${k}`)) {
    if (pins[file] === undefined || !existsSync(join(WALLET_KEYS, file))) return `the wallet has no pinned ${file}`;
  }
  return null;
};
const WHY_NOT = whyNotHere();
/** Whether the compiled keys this needs are here, in the wallet: what the title names it waits for. */
const KEYS_HERE = WHY_NOT === null;
if (WHY_NOT !== null) console.log(`  NOT CHECKED HERE: the wallet did not anchor the company's records with its own keys, because ${WHY_NOT}`);

/** The wallet's proving worker, started as a thread with the browser's two calls given to it. */
class ProverThread implements ProvingWorkerLike {
  private readonly worker: ThreadWorker;
  constructor() {
    const entry = JSON.stringify(new URL('./proving-worker.ts', import.meta.url).href);
    this.worker = new ThreadWorker(`const { parentPort } = require('node:worker_threads');
globalThis.postMessage = (m, t) => parentPort.postMessage(m, t);
globalThis.addEventListener = (type, l) => { if (type === 'message') parentPort.on('message', (data) => l({ data })); };
import('tsx/esm/api').then(({ register }) => { register(); return import(${entry}); });`, { eval: true });
  }
  postMessage(message: unknown, transfer?: Transferable[]): void { this.worker.postMessage(message, transfer as never); }
  addEventListener(type: 'message' | 'error', listener: (e: never) => void): void {
    if (type === 'message') this.worker.on('message', (data) => listener({ data } as never));
    else this.worker.on('error', (e: Error) => listener({ message: e.message } as never));
  }
  terminate(): void { void this.worker.terminate(); }
}

class Chain {
  state: any = L.LedgerState.blank(NET);
  apply(tx: any, proofsChecked: boolean): { ok: boolean; error: string } {
    const s = new L.WellFormedStrictness();
    s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = proofsChecked;
    s.enforceLimits = false; s.verifySignatures = true;
    const now = new Date();
    const t = BigInt(Math.floor(now.getTime() / 1000));
    const [next, result] = this.state.apply(tx.wellFormed(this.state, s, now),
      new L.TransactionContext(this.state, { secondsSinceEpoch: t, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: t - 6n }));
    const ok = result.type === 'success';
    if (ok) this.state = next.postBlockUpdate(now);
    return { ok, error: String(result.error ?? '') };
  }
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

describe.skipIf(!KEYS_HERE)('THE WALLET ANCHORS THE COMPANY\'S RECORDS WITH ITS OWN KEYS [needs the compiled account keys in contracts/managed/keys and in the wallet: `npm run compact`, then `npm run vendor-keys:account`, which runs vendor-keys --account]', () => {
  let chain: Chain;
  let company: string;
  const founder = privateStateFor(1);
  const material = { signingSecret: hex(founder.secretKey), blinding: hex(founder.blinding), scope: hex(founder.scope) };
  const fetched: string[] = [];
  const fetchFn = (async (url: string) => {
    fetched.push(url);
    const file = join(WALLET_KEYS, url.replace(/^\/keys\//u, ''));
    return existsSync(file) ? new Response(new Uint8Array(readFileSync(file))) : new Response('none', { status: 404 });
  }) as typeof fetch;
  const store = new Map<string, Uint8Array>();
  const base = vaultBuilderDeps({
    keyMaterial: {
      fetchFn,
      cache: { get: async (p) => store.get(p)?.slice() ?? null, put: async (p, b) => { store.set(p, b.slice()); }, remove: async (p) => { store.delete(p); } },
    },
    provers: keptProvers(() => new ProverThread()),
  });
  let reads = 0;
  /* The indexer the wallet reads through, serving the account as the chain holds it now as its one step of history. */
  const deps = async () => ({
    ...(await base()),
    historyAt: () => {
      const read = ++reads;
      return {
        latest: async () => `${read}`.padStart(64, '0'),
        of: async () => [{ kind: 'call' as const, transaction: `${read}`.padStart(64, '0'), state: chain.state.index(company).serialize(), block: { height: read, at: read } }],
      };
    },
  });

  beforeEach(async () => {
    setNetworkId(NET as never);
    chain = new Chain();
    const init = await new (accountModule as any).Contract(witnesses).initialState(
      runtime.createConstructorContext(founder, '0'.repeat(64)), leafOfDevice(founder), COMPANY_LABEL);
    const accountState = L.ContractState.deserialize(init.currentContractState.serialize());
    for (const c of DEPLOYED_CIRCUITS) {
      const op = new L.ContractOperation();
      op.verifierKey = new Uint8Array(readFileSync(join(ACCOUNT_KEYS, `${c}.verifier`)));
      accountState.setOperation(c, op);
    }
    const deploy = new L.ContractDeploy(accountState);
    const seeded = chain.apply(L.Transaction.fromParts(NET, undefined, undefined,
      L.Intent.new(new Date(Date.now() + 600_000)).addDeploy(deploy)), false);
    if (!seeded.ok) throw new Error(`the company account was not deployed: ${seeded.error}`);
    company = String(deploy.address).toLowerCase();
  });

  const indexerOf = { indexerUri: 'https://indexer.wallet.example', indexerWsUri: 'wss://indexer.wallet.example' };
  const chainNow = () => ({ blockHash: '00'.repeat(32), accountState: b64(chain.state.index(company).serialize()), parameters: b64(L.LedgerParameters.initialParameters().serialize()) });

  it('the anchor is built in the wallet\'s vault builder on the account\'s state, and the key served to prove it is the anchor\'s own', async () => {
    const unproven: unknown[] = [];
    const building = async () => ({ ...(await deps()), prove: async (u: unknown) => { unproven.push(u); return u; } });
    const read = await answerVaultAsk(building as never, { id: 1, network: NET, ask: 'anchors-on-chain', account: company, indexer: indexerOf } as never) as { now?: { approvals: number; signerRoot: string }; error?: string };
    expect(read.error ?? null).toBeNull();
    const answer = await answerVaultAsk(building as never, {
      id: 2, network: NET, ask: 'anchor', account: company, material, previous: EMPTY_HEAD, batch: 'b1'.repeat(32), held: read.now!, chain: chainNow(),
    } as never) as { tx?: string; error?: string };
    expect(answer.error ?? null).toBeNull();
    // RED WHEN: the anchor is built anywhere but in the wallet's own vault builder, which hands it to the wallet's prover
    expect(unproven).toHaveLength(1);
    const tx = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', Buffer.from(answer.tx!, 'base64'));
    // RED WHEN: the call the wallet builds does not move the company's head on, on the account's state as the chain holds it
    expect(chain.apply(tx, false)).toEqual({ ok: true, error: '' });
    // RED WHEN: the proving key the wallet serves for the anchor is not the account's own, at the account's own location
    const vk = new Uint8Array(readFileSync(join(ACCOUNT_KEYS, 'anchor.verifier')));
    const keys = makePinnedKeyMaterialProvider({
      fetchFn, cache: { get: async () => null, put: async () => {}, remove: async () => {} }, accountCircuits: ACCOUNT_CIRCUITS_THE_WALLET_PROVES,
      compiledVerifierKeys: (accountModule as unknown as { expectedVk: Record<string, string> }).expectedVk,
    });
    const served = await keys.lookupKey(`contract:${company}/anchor?vk=${sha(vk)}`);
    expect(sha(served!.proverKey)).toBe(sha(new Uint8Array(readFileSync(join(ACCOUNT_KEYS, 'anchor.prover')))));
  }, 170_000);

  it('the anchor is built and proved in the wallet\'s vault builder, and the chain checks its proof and moves the head on', async () => {
    const indexer = indexerOf;
    const read = await answerVaultAsk(deps as never, { id: 1, network: NET, ask: 'anchors-on-chain', account: company, indexer } as never) as { ok: boolean; now?: { approvals: number; signerRoot: string }; landed?: unknown[]; error?: string };
    expect(read.error ?? null).toBeNull();
    const chainAt = chainNow();
    const answer = await answerVaultAsk(deps as never, {
      id: 2, network: NET, ask: 'anchor', account: company, material, previous: EMPTY_HEAD, batch: 'b1'.repeat(32), held: read.now!, chain: chainAt,
    } as never) as { ok: boolean; tx?: string; error?: string };
    expect(answer.error ?? null).toBeNull();
    // RED WHEN: the wallet proves the anchor with a key other than the one the account was deployed with, or cannot prove it at all
    const tx = L.Transaction.deserialize('signature', 'proof', 'pre-binding', Buffer.from(answer.tx!, 'base64'));
    expect(chain.apply(tx, true)).toEqual({ ok: true, error: '' });
    // RED WHEN: the anchor's proving key comes from anywhere but the wallet's own pinned folder
    expect(fetched.some((u) => u.endsWith(`${ACCOUNT_KEYS_FOLDER}/anchor.prover`))).toBe(true);
    const after = await answerVaultAsk(deps as never, { id: 3, network: NET, ask: 'anchors-on-chain', account: company, indexer } as never) as unknown as { landed: { head: string }[] };
    // RED WHEN: the anchor lands without moving the company's head on from the empty one
    expect(after.landed.at(-1)?.head).not.toBe(EMPTY_HEAD);
    expect(after.landed).toHaveLength(1);
  }, 600_000);
});
