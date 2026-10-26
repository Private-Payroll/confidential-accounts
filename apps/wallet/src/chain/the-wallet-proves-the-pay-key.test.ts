import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
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
import { NO_ASSET } from '../../../../src/core/assets.js';
import { newWrappingKeypair } from '../../../../src/core/crypto.js';
import { buildGovernedCall, type GovernedCallOrder, type OpenedRound } from '../../../../packages/web-shared/src/governed-call-builder.js';
import { accountBuilderDeps, answerAccountAsk, type AccountBuilderAsk } from './account-builder.js';
import { ACCOUNT_KEYS_FOLDER } from './key-material.js';
import { keptProvers, type ProvingWorkerLike } from './proving.js';

/*
 * THE PAY-RECORD KEY'S PROPOSAL, BUILT AND PROVED IN THE WALLET. The wallet's
 * account builder is handed the account's state and the seat's secrets, reads
 * its proving keys from the wallet's own key folder through the wallet's own
 * provider, and proves on the wallet's own proving worker. The chain then
 * takes the transaction with every proof checked against the keys the account
 * was deployed with.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ACCOUNT_KEYS = join(ROOT, 'contracts', 'managed', 'keys');
const WALLET_KEYS = join(ROOT, 'apps', 'wallet', 'public', 'keys');
const NET = 'undeployed';
const PROVED = ['propose', 'cancel', 'approve', 'sealPayKey'] as const;
/* The parameter sizes the proofs ask for: a proposal, an approval and a seal are circuits of 2^16 rows, a withdrawal of 2^15. */
const PARAMETERS = ['bls_midnight_2p15', 'bls_midnight_2p16'] as const;

const whyNotHere = (): string | null => {
  for (const c of DEPLOYED_CIRCUITS) {
    if (!existsSync(join(ACCOUNT_KEYS, `${c}.verifier`))) return `contracts/managed/keys/${c}.verifier is missing`;
  }
  const manifest = join(WALLET_KEYS, 'manifest.json');
  if (!existsSync(manifest)) return 'the wallet holds no key manifest';
  const pins = (JSON.parse(readFileSync(manifest, 'utf8')) as { artefacts: Record<string, unknown> }).artefacts;
  const wanted = [...PROVED.flatMap((c) => ['prover', 'verifier', 'bzkir'].map((k) => `${ACCOUNT_KEYS_FOLDER}/${c}.${k}`)), ...PARAMETERS];
  for (const file of wanted) {
    if (pins[file] === undefined || !existsSync(join(WALLET_KEYS, file))) return `the wallet has no pinned ${file}`;
  }
  return null;
};
const WHY_NOT = whyNotHere();
const CAN_PROVE_HERE = WHY_NOT === null;
if (WHY_NOT !== null) console.log(`  NOT CHECKED HERE: the wallet did not prove the pay-record key's proposal, because ${WHY_NOT}`);

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
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

describe.skipIf(!CAN_PROVE_HERE)('THE WALLET PROVES THE PAY-RECORD KEY\'S CALLS ITSELF [needs contracts/managed/keys and the account\'s keys and the network\'s parameters in the wallet: `npm run compact`, `npm run vendor-keys`, then `npm run vendor-keys:account`]', () => {
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
  const deps = accountBuilderDeps({
    keyMaterial: {
      fetchFn,
      cache: { get: async (p) => store.get(p)?.slice() ?? null, put: async (p, b) => { store.set(p, b.slice()); }, remove: async (p) => { store.delete(p); } },
    },
    provers: keptProvers(() => new ProverThread()),
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

  const callState = () => ({
    accountState: b64(chain.state.index(company).serialize()),
    parameters: b64(L.LedgerParameters.initialParameters().serialize()),
  });

  /** The pay-record key's proposal, as the wallet reads where the key stands and the company's record opens it. */
  const thePayKeyRound = async () => {
    const answer = await answerAccountAsk(deps, {
      id: 1, ask: 'pay-key-standing', account: company, accountState: callState().accountState,
      key: hex(new Uint8Array(randomBytes(32))), signingSecret: material.signingSecret, wrappingPublicKey: newWrappingKeypair().publicKey,
    });
    if (!answer.ok || answer.ask !== 'pay-key-standing') throw new Error(`the standing was not read: ${JSON.stringify(answer)}`);
    const r = answer.standing.round;
    const payKey = { kind: 'pay-key', commitment: r.commitment } as const;
    const half = { assetId: NO_ASSET, changeAmount: '0', changeBatchDigest: '00'.repeat(32) };
    const opened: OpenedRound = { chainId: r.proposal, digest: r.payload, vault: answer.standing.noVault, salt: r.salt, summary: '', governance: payKey, half };
    const propose = { circuit: 'propose', payKey, half: { ...half, assetBlinding: hex(new Uint8Array(randomBytes(32))), proposalSalt: r.salt }, proposal: r.proposal } as GovernedCallOrder;
    return { proposal: r.proposal, opened, propose };
  };

  const proved = (tx: string) => L.Transaction.deserialize('signature', 'proof', 'pre-binding', Buffer.from(tx, 'base64'));
  const openOnChain = (proposal: string): boolean =>
    (accountModule as any).ledger((runtime as any).ContractState.deserialize(chain.state.index(company).serialize()).data)
      .openProposals.member(Buffer.from(proposal, 'hex'));

  it('the proposal to commit the pay-record key is built and proved in the wallet, and the chain checks its proof and opens it', async () => {
    // RED WHEN: the wallet's prover cannot prove the account's proposal, or proves it against a key the account was not deployed with
    const round = await thePayKeyRound();
    const answer = await answerAccountAsk(deps, {
      id: 2, ask: 'governed-call', network: NET, account: company, order: round.propose, material, chain: callState(), opened: round.opened,
    } as AccountBuilderAsk);
    if (!answer.ok || answer.ask !== 'governed-call') throw new Error(`the proposal was not built: ${JSON.stringify(answer)}`);
    expect(chain.apply(proved(answer.tx), true)).toEqual({ ok: true, error: '' });
    expect(openOnChain(round.proposal)).toBe(true);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.filter((u) => !u.startsWith('/keys/'))).toEqual([]);
  }, 600_000);

  it('the proposal is withdrawn by a call built and proved in the wallet, and the chain checks its proof and closes it', async () => {
    // RED WHEN: a withdrawal proved in the wallet is not the call the account takes, so a seat cannot withdraw its own proposal from the wallet
    const round = await thePayKeyRound();
    const unproved = await buildGovernedCall({ ...(await deps()), prove: async (u: any) => u }, {
      account: company, order: round.propose, material, opened: round.opened,
      chain: { accountState: chain.state.index(company).serialize(), parameters: L.LedgerParameters.initialParameters().serialize() },
    });
    expect(chain.apply(L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', unproved.proven), false)).toEqual({ ok: true, error: '' });
    expect(openOnChain(round.proposal)).toBe(true);
    const answer = await answerAccountAsk(deps, {
      id: 3, ask: 'governed-call', network: NET, account: company, order: { circuit: 'cancel', proposal: round.proposal },
      material, chain: callState(), opened: round.opened,
    } as AccountBuilderAsk);
    if (!answer.ok || answer.ask !== 'governed-call') throw new Error(`the withdrawal was not built: ${JSON.stringify(answer)}`);
    expect(chain.apply(proved(answer.tx), true)).toEqual({ ok: true, error: '' });
    expect(openOnChain(round.proposal)).toBe(false);
    expect(fetched.filter((u) => !u.startsWith('/keys/'))).toEqual([]);
  }, 600_000);

  it('the whole commitment of the pay-record key, its proposal (which counts as the seat\'s approval) and the seat\'s sealed copy, is proved in the wallet from the chain as it stands, and the chain takes each', async () => {
    // RED WHEN: any of the calls finishing a company proves is not built and proved in the wallet from the account as the chain holds it, or the chain does not take it
    const key = hex(new Uint8Array(randomBytes(32)));
    const wrapping = newWrappingKeypair();
    let id = 10;
    const standing = async () => {
      const a = await answerAccountAsk(deps, {
        id: id++, ask: 'pay-key-standing', account: company, accountState: callState().accountState, key,
        signingSecret: material.signingSecret, wrappingPublicKey: wrapping.publicKey,
      });
      if (!a.ok || a.ask !== 'pay-key-standing') throw new Error(`the standing was not read: ${JSON.stringify(a)}`);
      return a.standing;
    };
    const call = async (order: GovernedCallOrder, opened: OpenedRound) => {
      const a = await answerAccountAsk(deps, { id: id++, ask: 'governed-call', network: NET, account: company, order, material, chain: callState(), opened } as AccountBuilderAsk);
      if (!a.ok || a.ask !== 'governed-call') throw new Error(`the call was not built: ${JSON.stringify(a)}`);
      return a.tx;
    };
    const first = await standing();
    const r = first.round;
    const payKey = { kind: 'pay-key', commitment: r.commitment } as const;
    const half = { assetId: NO_ASSET, changeAmount: '0', changeBatchDigest: '00'.repeat(32) };
    const opened: OpenedRound = { chainId: r.proposal, digest: r.payload, vault: first.noVault, salt: r.salt, summary: '', governance: payKey, half };
    expect([first.committed, first.round.open, first.sealedMine]).toEqual([null, false, false]);
    expect(chain.apply(proved(await call({ circuit: 'propose', payKey, half: { ...half, assetBlinding: hex(new Uint8Array(randomBytes(32))), proposalSalt: r.salt }, proposal: r.proposal } as GovernedCallOrder, opened)), true)).toEqual({ ok: true, error: '' });
    const approved = await standing();
    expect(approved.round.open).toBe(true);
    /* RED WHEN: the raise is not counted as the founding signer's own approval, so the proposal needs a second transaction before it can be sealed. */
    expect(BigInt(approved.round.approvals) >= BigInt(approved.round.needed)).toBe(true);
    /* RED WHEN: the founding signer can approve its own raise again, which would count it twice. */
    await expect(call({ circuit: 'approve', proposal: r.proposal, of: { governance: payKey, proposalSalt: r.salt } } as GovernedCallOrder, opened))
      .rejects.toThrow(/you have already approved this proposal/);
    expect(chain.apply(proved(await call({ circuit: 'sealPayKey', wrap: approved.wrap, commitment: r.commitment, proposal: r.proposal, proposalSalt: r.salt } as GovernedCallOrder, opened)), true)).toEqual({ ok: true, error: '' });
    const sealed = await standing();
    expect([sealed.committed, sealed.isThisKey, sealed.sealedMine]).toEqual([r.commitment, true, true]);
    expect(fetched.filter((u) => !u.startsWith('/keys/'))).toEqual([]);
  }, 1_200_000);
});

/* Where the job that builds the keys runs this file, a stand-down is a failure naming what is missing, never a pass. */
const KEYS_MUST_BE_BUILT = (process.env.KEYS_MUST_BE_BUILT ?? '') !== '';

describe.skipIf(!KEYS_MUST_BE_BUILT)('where the checks built the keys, the wallet proves the pay-record key\'s calls for real [needs KEYS_MUST_BE_BUILT, which the job that runs `npm run compact`, `npm run vendor-keys` and `npm run vendor-keys:account` sets]', () => {
  it('the account\'s keys and the network\'s parameters are in the wallet', () => {
    // RED WHEN: the account's keys or a parameter file are missing from the wallet, which would stand the wallet's prover down green
    expect(WHY_NOT, `the wallet cannot prove here: ${WHY_NOT}`).toBeNull();
  });
});
