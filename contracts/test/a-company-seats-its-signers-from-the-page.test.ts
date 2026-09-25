/**
 * **A COMPANY SEATS ITS SIGNERS FROM THEIR OWN DEVICES, AND A SIGNER BEYOND ITS
 * THRESHOLD IS SEATED THE SAME WAY.**
 *
 * What is real here:
 *   · the chain is the ledger's own state machine, applying each transaction as
 *     its own block;
 *   · the company account is the compiled account, deployed with the state its
 *     own constructor writes: one founding signer, a threshold of one;
 *   · every raise, approval, seat and threshold change is built by the device's
 *     own builder, reached through the page's own worker client and the
 *     worker's own handler, from key material shaped exactly as the keyring
 *     holds it;
 *   · what the device sends is read by the service's own reader and passed by
 *     the service's own check before the chain applies it.
 *
 * **THE SHAPE IT PROVES.** A company is founded one of one. Every seat after the
 * first is an approved round, because the account's signers never fall below its
 * threshold - so the second signer is already a signer beyond the threshold, and
 * after the threshold is raised to two, the third needs two approvals from two
 * devices before anybody can seat them.
 *
 * **WHAT THIS DOES NOT SHOW, SAID HERE SO NOTHING RELIES ON IT:**
 *   · **no proof is made.** The call reaches the chain unproven and the ledger
 *     is told not to check proofs;
 *   · no fee is balanced and nothing reaches a network, an indexer, a browser
 *     or a wallet;
 *   · the service's routes and its records are not driven here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as accountModule from '../managed/contract/index.js';
import { witnesses, type AccountPrivateState } from '../src/witnesses.js';
import { privateStateFor, leafOfDevice, change } from './simulator.js';
import { DEPLOYED_CIRCUITS } from '../../src/midnight/deferral.js';
import { answerVaultAsk } from '../../src/web/vault-worker-entry.js';
import { vaultBuilderOver, type AccountCallChainOnTheWire, type VaultAnswer } from '../../src/web/vault-worker-client.js';
import type { GovernedCallOrder, SignerMaterial } from '../../src/web/governed-call-builder.js';
import { refusalForProven } from '../../src/wiring/proven-submission.js';

const NET = 'undeployed';
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const asRuntime = (state: { serialize(): Uint8Array }) => (runtime as any).ContractState.deserialize(state.serialize());
const accountLedgerOf = (state: { serialize(): Uint8Array }) => (accountModule as any).ledger(asRuntime(state).data);
const circuits = (accountModule as any).pureCircuits;

/** The ledger's own state machine, one transaction per block. */
class Chain {
  state: any = L.LedgerState.blank(NET);
  apply(tx: any): { ok: boolean; error: string } {
    const s = new L.WellFormedStrictness();
    s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = false;
    s.enforceLimits = false; s.verifySignatures = true;
    const now = new Date();
    const t = BigInt(Math.floor(now.getTime() / 1000));
    const [next, result] = this.state.apply(tx.wellFormed(this.state, s, now),
      new L.TransactionContext(this.state, {
        secondsSinceEpoch: t, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: t - 6n,
      }));
    const ok = result.type === 'success';
    if (ok) this.state = next.postBlockUpdate(now);
    return { ok, error: String(result.error ?? '') };
  }
  contract(address: string): any { return this.state.index(address); }
}

/*
 * **THE ACCOUNT'S VERIFIER KEYS, WHICH ONLY A FULL COMPILE PRODUCES.** Skipped
 * by name where they are absent, and the job that builds the keys runs this
 * file by name.
 */
const KEYS_ON_DISK = ['propose', 'approve', 'amendSigner', 'setThreshold'].every((c) => existsSync(new URL(`../managed/keys/${c}.verifier`, import.meta.url)));
if (!KEYS_ON_DISK) {
  console.log(
    '  NOT CHECKED HERE: the account\'s verifier keys are not on disk, so no signer was seated'
    + ' from a device. `npm run compact` builds them.',
  );
}

describe.skipIf(!KEYS_ON_DISK)('A COMPANY SEATS ITS SIGNERS FROM THEIR OWN DEVICES [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  let chain: Chain;
  let company: string;
  let founder: AccountPrivateState;

  const accountZk = new NodeZkConfigProvider(new URL('../managed', import.meta.url).pathname);
  const accountCompiled = CompiledContract.make('ConfidentialAccount', (accountModule as any).Contract).pipe(
    CompiledContract.withWitnesses(witnesses as never));

  const builder = () => {
    const deps = async () => ({
      ledger: L, runtimeState: (runtime as any).ContractState,
      contracts, accountCompiled, accountZkConfig: accountZk, accountPure: circuits,
      /* No proof is made here: what the chain is handed is the unproven call. */
      prove: async (unproven: any) => unproven,
    });
    const listeners: Array<(e: { data: unknown }) => void> = [];
    return vaultBuilderOver({
      addEventListener: (_t, l) => { listeners.push(l); },
      postMessage: (message) => {
        void answerVaultAsk(deps as never, message as never).then(
          (a: VaultAnswer) => listeners.forEach((l) => l({ data: a })),
          (e: Error) => listeners.forEach((l) => l({ data: { id: (message as { id: number }).id, ok: false, error: e.message } })));
      },
    }, NET);
  };

  const callState = (): AccountCallChainOnTheWire => ({
    blockHash: '00'.repeat(32),
    accountState: b64(chain.contract(company).serialize()),
    parameters: b64(L.LedgerParameters.initialParameters().serialize()),
  });

  const keyringOf = (s: AccountPrivateState): SignerMaterial => ({
    signingSecret: hex(s.secretKey), blinding: hex(s.blinding), scope: hex(s.scope),
  });

  const send = (tx: string) => {
    const read = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', Buffer.from(tx, 'base64'));
    const refusal = refusalForProven(read, company);
    if (refusal !== null) throw new Error(`the service refused it: ${refusal}`);
    return chain.apply(read);
  };

  const ledgerNow = () => accountLedgerOf(chain.contract(company));
  const seated = (leaf: Uint8Array): boolean => ledgerNow().signerLeaves.member(leaf);
  const approvalsOf = (id: string): bigint | null => {
    const key = Buffer.from(id, 'hex');
    return ledgerNow().approvalCounts.member(key) ? ledgerNow().approvalCounts.lookup(key) : null;
  };

  /** A governance round as the service would write it down: its change, a fresh salt, and the identity they make. */
  const aRound = (governance: GovernedCallOrder & { circuit: 'propose' } extends never ? never : any, seed: number) => {
    const c = change(0n, seed);
    const payload = governance.kind === 'add-signer'
      ? circuits.signerAddPayload(Buffer.from(governance.leaf, 'hex'))
      : circuits.setThresholdPayload(BigInt(governance.threshold));
    const id = hex(circuits.proposalIdOf(payload, circuits.noVault(), c.salt));
    const raise: GovernedCallOrder = {
      circuit: 'propose', governance, proposal: id,
      half: {
        assetId: hex(c.asset), assetBlinding: hex(founder.assetBlinding), proposalSalt: hex(c.salt),
        changeAmount: '0', changeBatchDigest: hex(c.batch),
      },
    };
    return { raise, id, salt: hex(c.salt) };
  };

  /** One device builds one call, and the chain applies what it sent. */
  const onDevice = async (who: AccountPrivateState, order: GovernedCallOrder) =>
    send((await builder().governedCall({ account: company, order, material: keyringOf(who), chain: callState() })).tx);

  /** A seat raised, approved by every device named, and carried out by the first of them. */
  const seat = async (who: AccountPrivateState, approvers: AccountPrivateState[], seed: number) => {
    const leaf = hex(leafOfDevice(who));
    const r = aRound({ kind: 'add-signer', leaf }, seed);
    expect(await onDevice(approvers[0]!, r.raise)).toEqual({ ok: true, error: '' });
    for (const a of approvers) expect(await onDevice(a, { circuit: 'approve', proposal: r.id })).toEqual({ ok: true, error: '' });
    return onDevice(approvers[0]!, { circuit: 'amendSigner', leaf, proposal: r.id, proposalSalt: r.salt });
  };

  beforeEach(async () => {
    setNetworkId(NET as never);
    chain = new Chain();
    founder = privateStateFor(1);
    const init = await new (accountModule as any).Contract(witnesses).initialState(
      runtime.createConstructorContext(founder, '0'.repeat(64)), leafOfDevice(founder));
    const accountState = L.ContractState.deserialize(init.currentContractState.serialize());
    for (const c of DEPLOYED_CIRCUITS) {
      const op = new L.ContractOperation();
      op.verifierKey = new Uint8Array(readFileSync(new URL(`../managed/keys/${c}.verifier`, import.meta.url)));
      accountState.setOperation(c, op);
    }
    const deploy = new L.ContractDeploy(accountState);
    const seeded = chain.apply(L.Transaction.fromParts(NET, undefined, undefined,
      L.Intent.new(new Date(Date.now() + 600_000)).addDeploy(deploy)));
    if (!seeded.ok) throw new Error(`the company account was not deployed: ${seeded.error}`);
    company = String(deploy.address).toLowerCase();
  });

  it('THE SECOND SIGNER - ALREADY ONE BEYOND A THRESHOLD OF ONE - IS SEATED FROM THE FIRST SIGNER\'S DEVICE, AND CAN THEN APPROVE FROM THEIR OWN', async () => {
    const blake = privateStateFor(2);
    expect(ledgerNow().threshold).toBe(1n);
    expect(ledgerNow().signerLeaves.size()).toBe(1n);
    /* RED WHEN: a device cannot raise, approve or carry out a seat - the company then stays one of one for ever. */
    expect(await seat(blake, [founder], 11)).toEqual({ ok: true, error: '' });
    expect(seated(leafOfDevice(blake))).toBe(true);
    expect(ledgerNow().signerLeaves.size()).toBe(2n);
    /* The seated signer's own device proves membership: it can raise and approve. */
    const r = aRound({ kind: 'threshold', threshold: '2' }, 12);
    expect(await onDevice(blake, r.raise)).toEqual({ ok: true, error: '' });
    expect(await onDevice(blake, { circuit: 'approve', proposal: r.id })).toEqual({ ok: true, error: '' });
    expect(approvalsOf(r.id)).toBe(1n);
  });

  it('THE THRESHOLD IS RAISED FROM A DEVICE, AND THE NEXT SIGNER BEYOND IT NEEDS TWO DEVICES\' APPROVALS BEFORE ANYBODY CAN SEAT THEM', async () => {
    const blake = privateStateFor(2);
    const cleo = privateStateFor(3);
    expect(await seat(blake, [founder], 21)).toEqual({ ok: true, error: '' });
    const up = aRound({ kind: 'threshold', threshold: '2' }, 22);
    expect(await onDevice(founder, up.raise)).toEqual({ ok: true, error: '' });
    expect(await onDevice(founder, { circuit: 'approve', proposal: up.id })).toEqual({ ok: true, error: '' });
    /* RED WHEN: the threshold cannot be changed from a device - the company can then never ask for more than one approval. */
    expect(await onDevice(founder, { circuit: 'setThreshold', threshold: '2', proposal: up.id, proposalSalt: up.salt }))
      .toEqual({ ok: true, error: '' });
    expect(ledgerNow().threshold).toBe(2n);

    const leaf = hex(leafOfDevice(cleo));
    const r = aRound({ kind: 'add-signer', leaf }, 23);
    expect(await onDevice(founder, r.raise)).toEqual({ ok: true, error: '' });
    expect(await onDevice(founder, { circuit: 'approve', proposal: r.id })).toEqual({ ok: true, error: '' });
    const carry = { circuit: 'amendSigner', leaf, proposal: r.id, proposalSalt: r.salt } as const;
    /* One approval of two: the contract refuses the seat, from the device, before anything is sent. */
    await expect(onDevice(founder, carry)).rejects.toThrow(/not enough approvals/u);
    expect(seated(leafOfDevice(cleo))).toBe(false);
    /* RED WHEN: the second signer's device cannot approve a seat - a company larger than its threshold is then never finished. */
    expect(await onDevice(blake, { circuit: 'approve', proposal: r.id })).toEqual({ ok: true, error: '' });
    expect(await onDevice(blake, carry)).toEqual({ ok: true, error: '' });
    expect(seated(leafOfDevice(cleo))).toBe(true);
    expect(ledgerNow().signerLeaves.size()).toBe(3n);
  });

  it('A DEVICE ASKED TO SEAT A LEAF THE APPROVED ROUND WAS NOT RAISED FOR BUILDS NOTHING', async () => {
    const blake = privateStateFor(2);
    const other = privateStateFor(4);
    const leaf = hex(leafOfDevice(blake));
    const r = aRound({ kind: 'add-signer', leaf }, 31);
    expect(await onDevice(founder, r.raise)).toEqual({ ok: true, error: '' });
    expect(await onDevice(founder, { circuit: 'approve', proposal: r.id })).toEqual({ ok: true, error: '' });
    /* RED WHEN: a round approved for one person can seat another. */
    await expect(onDevice(founder, {
      circuit: 'amendSigner', leaf: hex(leafOfDevice(other)), proposal: r.id, proposalSalt: r.salt,
    })).rejects.toThrow(/not for this change/u);
    expect(seated(leafOfDevice(other))).toBe(false);
  });

  it('SOMEBODY WHO IS NOT A SIGNER CANNOT SEAT ANYBODY, EVEN ON AN APPROVED ROUND', async () => {
    const outsider = privateStateFor(9);
    const leaf = hex(leafOfDevice(outsider));
    const r = aRound({ kind: 'add-signer', leaf }, 41);
    expect(await onDevice(founder, r.raise)).toEqual({ ok: true, error: '' });
    expect(await onDevice(founder, { circuit: 'approve', proposal: r.id })).toEqual({ ok: true, error: '' });
    await expect(onDevice(outsider, { circuit: 'amendSigner', leaf, proposal: r.id, proposalSalt: r.salt }))
      .rejects.toThrow(/not a signer/u);
    expect(seated(leafOfDevice(outsider))).toBe(false);
  });
});
