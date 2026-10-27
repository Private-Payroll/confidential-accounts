import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker as ThreadWorker } from 'node:worker_threads';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { identityFromSecret } from 'midnight-identity/keys/derivation';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import { pureCircuits } from '../../../../contracts/managed/contract/index.js';
import { AccountSimulator, change, privateStateFor } from '../../../../contracts/test/simulator.js';
import { DEPLOYED_CIRCUITS } from '../../../../src/midnight/deferral.js';
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import { seatBlinding } from '../../../../src/core/seat-opening.js';
import { storedSignerLeaf } from '../../../../src/core/signer-leaf.js';
import { toHex, type Hex } from '../../../../src/core/crypto.js';
import { answerVaultAsk } from '../../../../packages/web-shared/src/vault-worker-entry.js';
import { vaultBuilderDeps } from './vault-builder.js';
import { ACCOUNT_KEYS_FOLDER } from './key-material.js';
import { keptProvers, type ProvingWorkerLike } from './proving.js';

/* A signer invited by address takes the seat from their own wallet, against the compiled account: the company's
 * signers raise and approve the invitation of the wallet's private address, the wallet builds `seatInvited` in its own
 * builder with its own seat and the address's coin key and proves it with its own pinned keys, and the account's
 * ledger, as the ledger package this build ships runs it, takes the proven call on its state and seats it. That
 * package does not verify a contract proof (it is built without proof verifying), so what is checked here is the
 * proven call's form and its effect on the account's state; the proof itself is verified by the network's node. A
 * wallet holding another address cannot build the seat. */

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
  for (const file of ['prover', 'verifier', 'bzkir'].map((k) => `${ACCOUNT_KEYS_FOLDER}/seatInvited.${k}`)) {
    if (pins[file] === undefined || !existsSync(join(WALLET_KEYS, file))) return `the wallet has no pinned ${file}`;
  }
  return null;
};
const WHY_NOT = whyNotHere();
/** Whether the compiled keys this needs are here, in the wallet: what the title names it waits for. */
const KEYS_HERE = WHY_NOT === null;
if (WHY_NOT !== null) console.log(`  NOT CHECKED HERE: the wallet did not take a seat invited by address with its own keys, because ${WHY_NOT}`);

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
  /* `proven`: the transaction is read as a proven one. The flag asks the ledger to verify contract proofs, which the
   * ledger package this build ships does not do; it checks the rest of the transaction's form. */
  apply(tx: any, proven: boolean): { ok: boolean; error: string } {
    const s = new L.WellFormedStrictness();
    s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = proven;
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

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');


describe.skipIf(!KEYS_HERE)('A SIGNER INVITED BY ADDRESS IS SEATED FROM THEIR OWN WALLET AGAINST THE COMPILED ACCOUNT [needs the compiled account keys in contracts/managed/keys and in the wallet: `npm run compact`, then `npm run vendor-keys:account`]', () => {
  const LABEL = drawCompanyLabel();
  const dee = identityFromSecret(new Uint8Array(32).fill(44));
  const A = privateStateFor(1);
  const B = privateStateFor(2);
  let chain: Chain;
  let company: string;
  const c = change(0n, 911);
  const scope = MidnightCommitments.allVaults().toLowerCase() as Hex;
  const coinOf = (who: ReturnType<typeof identityFromSecret>) => {
    const keys = L.ZswapSecretKeys.fromSeed(who.moneyAt(0).zswap);
    const raw = keys.coinSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize();
    return { secret: toHex(raw.slice(raw.length - 32)) as Hex, public: String(keys.coinPublicKey).toLowerCase() as Hex };
  };
  const addressSalt = '3c'.repeat(32) as Hex;
  let proposal: string;
  const fetched: string[] = [];
  const fetchFn = (async (url: string) => {
    fetched.push(url);
    const file = join(WALLET_KEYS, url.replace(/^\/keys\//u, ''));
    return existsSync(file) ? new Response(new Uint8Array(readFileSync(file))) : new Response('none', { status: 404 });
  }) as typeof fetch;
  const store = new Map<string, Uint8Array>();
  const deps = vaultBuilderDeps({
    keyMaterial: {
      fetchFn,
      cache: { get: async (p) => store.get(p)?.slice() ?? null, put: async (p, b) => { store.set(p, b.slice()); }, remove: async (p) => { store.delete(p); } },
    },
    provers: keptProvers(() => new ProverThread()),
  });
  const seatOf = (n: number) => {
    const keys = seatKeysFor(dee, LABEL, n);
    const signingSecret = toHex(keys.signingSecret) as Hex;
    const walletKey = { tag: 'schnorr' as const, value: String(committeeKeyFor(dee, LABEL).value).toLowerCase() };
    const blinding = seatBlinding(walletKey, toHex(keys.salt)) as Hex;
    return { signingSecret, blinding, scope, leaf: storedSignerLeaf({ signingSecret, blinding, scope }, MidnightCommitments).toLowerCase() };
  };
  const chainNow = () => ({ accountState: b64(chain.state.index(company).serialize()), parameters: b64(L.LedgerParameters.initialParameters().serialize()) });
  const seatAsked = (id: number, coinSecretKey: Hex) => answerVaultAsk(deps as never, {
    id, network: NET, ask: 'seat-invited', account: company, proposal, intoVacatedSlot: false, proposalSalt: toHex(c.salt),
    material: { signingSecret: seatOf(0).signingSecret, blinding: seatOf(0).blinding, scope }, invite: { coinSecretKey, addressSalt }, chain: chainNow(),
  } as never) as Promise<{ ok: boolean; tx?: string; error?: string }>;

  beforeAll(async () => {
    setNetworkId(NET as never);
    chain = new Chain();
    /* The company's two signers raise the invitation of Dee's private address with every right, and approve it to the seat bar. */
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const address = MidnightCommitments.inviteAddressOf(coinOf(dee).public, addressSalt);
    const payload = pureCircuits.signerInvitePayload(Buffer.from(address, 'hex'), Buffer.from(scope, 'hex'));
    await sim.as(sim.applying(A, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);
    await sim.as(B).approve(id);
    proposal = toHex(id);
    /* The account, as the simulator left it, placed in a blank ledger with this build's verifier keys. */
    const accountState = L.ContractState.deserialize((sim.contractStateForCall as { serialize(): Uint8Array }).serialize());
    for (const circuit of DEPLOYED_CIRCUITS) {
      const op = new L.ContractOperation();
      op.verifierKey = new Uint8Array(readFileSync(join(ACCOUNT_KEYS, `${circuit}.verifier`)));
      accountState.setOperation(circuit, op);
    }
    const deploy = new L.ContractDeploy(accountState);
    const placed = chain.apply(L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(new Date(Date.now() + 600_000)).addDeploy(deploy)), false);
    if (!placed.ok) throw new Error(`the company account was not placed: ${placed.error}`);
    company = String(deploy.address).toLowerCase();
  }, 170_000);

  it('RED WHEN: a wallet holding another address builds the seat', async () => {
    await expect(seatAsked(1, coinOf(identityFromSecret(new Uint8Array(32).fill(45))).secret)).rejects.toThrow(/does not invite this wallet/u);
  }, 170_000);

  it('the seat is built in the wallet\'s own builder on the account\'s state, and the account seats it and closes the invitation', async () => {
    const unproven: unknown[] = [];
    const building = async () => ({ ...(await deps()), prove: async (u: unknown) => { unproven.push(u); return u; } });
    const answer = await answerVaultAsk(building as never, {
      id: 3, network: NET, ask: 'seat-invited', account: company, proposal, intoVacatedSlot: false, proposalSalt: toHex(c.salt),
      material: { signingSecret: seatOf(0).signingSecret, blinding: seatOf(0).blinding, scope }, invite: { coinSecretKey: coinOf(dee).secret, addressSalt }, chain: chainNow(),
    } as never) as { tx?: string; error?: string };
    expect(answer.error ?? null).toBeNull();
    /* RED WHEN: the seat is built anywhere but in the wallet's own builder, which hands it to the wallet's prover. */
    expect(unproven).toHaveLength(1);
    const tx = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', Buffer.from(answer.tx!, 'base64'));
    const before = chain.state;
    /* RED WHEN: the call the wallet builds is not the seat the account takes on its state as the chain holds it. */
    expect(chain.apply(tx, false)).toEqual({ ok: true, error: '' });
    const view = (await import('../../../../contracts/managed/contract/index.js')).ledger((runtime.ContractState.deserialize(chain.state.index(company).serialize()) as any).data) as any;
    expect(view.signerLeaves.member(Buffer.from(seatOf(0).leaf, 'hex'))).toBe(true);
    expect(view.openProposals.member(Buffer.from(proposal, 'hex'))).toBe(false);
    chain.state = before;
  }, 170_000);

  it('the wallet proves its own seat with the address\'s coin key and its own pinned keys, and the account takes the proven call and seats it', async () => {
    const answer = await seatAsked(2, coinOf(dee).secret);
    expect(answer.error ?? null).toBeNull();
    const tx = L.Transaction.deserialize('signature', 'proof', 'pre-binding', Buffer.from(answer.tx!, 'base64'));
    /* RED WHEN: the proven seat is not a call the account takes on its state, or the account refuses the seat. The proof
     * itself is not verified here: the ledger package this build ships verifies no contract proof; the node does. */
    expect(chain.apply(tx, true)).toEqual({ ok: true, error: '' });
    /* RED WHEN: the seat the account holds is not the wallet's own seat 0, or the invitation stays open. */
    const view = (await import('../../../../contracts/managed/contract/index.js')).ledger((runtime.ContractState.deserialize(chain.state.index(company).serialize()) as any).data) as any;
    expect(view.signerLeaves.member(Buffer.from(seatOf(0).leaf, 'hex'))).toBe(true);
    expect(view.openProposals.member(Buffer.from(proposal, 'hex'))).toBe(false);
    /* RED WHEN: the seat's proving key comes from anywhere but the wallet's own pinned folder. */
    expect(fetched.some((u) => u.endsWith(`${ACCOUNT_KEYS_FOLDER}/seatInvited.prover`))).toBe(true);
  }, 600_000);
});
