/**
 * **A COMPANY INVITES ITS SIGNERS FROM THEIR OWN DEVICES, EACH INVITEE TAKES
 * THEIR OWN SEAT, AND A SIGNER BEYOND ITS THRESHOLD IS SEATED THE SAME WAY.**
 *
 * What is real here:
 *   · the chain is the ledger's own state machine, applying each transaction as
 *     its own block;
 *   · the company account is the compiled account, deployed with the state its
 *     own constructor writes: one founding signer, a threshold of one;
 *   · every raise, approval and threshold change is built by the device's
 *     own builder, reached through the page's own worker client and the
 *     worker's own handler, from key material shaped exactly as the keyring
 *     holds it;
 *   · each invitee takes their seat with `seatInvited`, built here from the
 *     invitee's own key material and the address they were invited at, the
 *     way their wallet builds it;
 *   · what the device sends is read by the service's own reader and passed by
 *     the service's own check before the chain applies it.
 *
 * **THE SHAPE IT PROVES.** A company is founded one of one. Every seat after the
 * first is an approved invitation the invitee takes - so the second signer is
 * already a signer beyond the threshold, and after the threshold is raised to
 * two, the third needs two approvals from two devices before they can take it.
 *
 * **WHAT THIS DOES NOT SHOW, SAID HERE SO NOTHING RELIES ON IT:**
 *   · **no proof is made.** The call reaches the chain unproven and the ledger
 *     is told not to check proofs;
 *   · no fee is balanced and nothing reaches a network, an indexer, a browser
 *     or a wallet;
 *   · the service's routes and its records are not driven here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as accountModule from '../managed/contract/index.js';
import { witnesses, type AccountPrivateState } from '../src/witnesses.js';
import {
  privateStateFor, leafOfDevice, change, COMPANY_LABEL, invitedAddressFor, invitedAddressCommitmentOf,
} from './simulator.js';
import type { InvitedAddress } from '../src/witnesses.js';
import { inviteeSeatCall } from './an-invitee-takes-the-seat.js';
import { DEPLOYED_CIRCUITS } from '../../src/midnight/deferral.js';
import { answerVaultAsk } from 'vaults-web-shared/vault-worker-entry.js';
import { vaultBuilderOver, type AccountCallChainOnTheWire, type VaultAnswer } from 'vaults-web-shared/vault-worker-client.js';
import type { GovernedCallOrder, OpenedRound, SignerMaterial } from 'vaults-web-shared/governed-call-builder.js';
import { refusalForProven } from '../../src/wiring/proven-submission.js';
import { keysOnDisk } from './keys-on-disk.js';

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
/* Every circuit of the account and of the vault has its verifier key on disk, and each is the key this build compiled. */
const KEYS = keysOnDisk();
const KEYS_ON_DISK = KEYS.ok;
if (!KEYS_ON_DISK) {
  console.log(`  NOT CHECKED HERE: no signer was seated from a device, because ${KEYS.why}`);
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

  /**
   * What a signer's device opens from the company's own records for each round
   * written down, by identity: the record's payload, vault and sealed salt, the
   * change it names and the change it commits to. The page's opening itself runs over
   * real records in `packages/web-shared/src/the-device-proves-what-it-opened.test.ts`.
   */
  const opened = new Map<string, OpenedRound>();
  const openedFor = (order: GovernedCallOrder): OpenedRound => {
    const { half, ...record } = opened.get(order.proposal)!;
    return order.circuit === 'propose' ? { ...record, half: half! } : record;
  };

  /** A governance round as the service would write it down: its change, a fresh salt, and the identity they make. */
  const aRound = (governance: GovernedCallOrder & { circuit: 'propose' } extends never ? never : any, seed: number) => {
    const c = change(0n, seed);
    const payload = governance.kind === 'add-signer'
      ? circuits.signerInvitePayload(Buffer.from(governance.address, 'hex'), Buffer.from(governance.scope, 'hex'))
      : circuits.setThresholdPayload(BigInt(governance.threshold));
    const id = hex(circuits.proposalIdOf(payload, circuits.noVault(), c.salt));
    const raise: GovernedCallOrder = {
      circuit: 'propose', governance, proposal: id,
      half: {
        assetId: hex(c.asset), assetBlinding: hex(founder.assetBlinding), proposalSalt: hex(c.salt),
        changeAmount: '0', changeBatchDigest: hex(c.batch),
      },
    };
    opened.set(id, {
      chainId: id, digest: hex(payload), vault: hex(circuits.noVault()), salt: hex(c.salt), summary: '', governance,
      half: { assetId: hex(c.asset), changeAmount: '0', changeBatchDigest: hex(c.batch) },
    });
    return { raise, id, salt: hex(c.salt) };
  };

  /** One device builds one call, and the chain applies what it sent. */
  const onDevice = async (who: AccountPrivateState, order: GovernedCallOrder) =>
    send((await builder().governedCall({ account: company, order, material: keyringOf(who), chain: callState(), opened: openedFor(order) })).tx);

  /** The invitation of `who`: the commitment to the address they were invited at, and their seat's rights. */
  const invitationOf = (who: AccountPrivateState, invite: InvitedAddress = invitedAddressFor(who)) =>
    ({ kind: 'add-signer', address: hex(invitedAddressCommitmentOf(invite)), scope: hex(who.scope) }) as const;

  /** The invitee takes the seat, as their own wallet builds the call, and the chain applies what it sent. */
  const inviteeTakes = async (who: AccountPrivateState, id: string, salt: string, invite: InvitedAddress = invitedAddressFor(who)) =>
    send(await inviteeSeatCall({
      accountCompiled, accountZk, company, accountState: chain.contract(company).serialize(), who, proposal: id, salt, invite,
    }));

  /** An invitation raised by the first device named (which counts as its approval), approved by the rest, and taken by the invitee. */
  const seat = async (who: AccountPrivateState, approvers: AccountPrivateState[], seed: number) => {
    const r = aRound(invitationOf(who), seed);
    expect(await onDevice(approvers[0]!, r.raise)).toEqual({ ok: true, error: '' });
    for (const a of approvers.slice(1)) expect(await onDevice(a, { circuit: 'approve', proposal: r.id })).toEqual({ ok: true, error: '' });
    return inviteeTakes(who, r.id, r.salt);
  };

  beforeEach(async () => {
    setNetworkId(NET as never);
    chain = new Chain();
    founder = privateStateFor(1);
    const init = await new (accountModule as any).Contract(witnesses).initialState(
      runtime.createConstructorContext(founder, '0'.repeat(64)), leafOfDevice(founder), COMPANY_LABEL);
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
    /* RED WHEN: a device cannot raise or approve an invitation, or the invitee cannot take it - the company then stays one of one for ever. */
    expect(await seat(blake, [founder], 11)).toEqual({ ok: true, error: '' });
    expect(seated(leafOfDevice(blake))).toBe(true);
    expect(ledgerNow().signerLeaves.size()).toBe(2n);
    /* The seated signer's own device proves membership: it can raise, which counts as its approval, and approve another's. */
    const r = aRound({ kind: 'threshold', threshold: '2' }, 12);
    expect(await onDevice(blake, r.raise)).toEqual({ ok: true, error: '' });
    expect(approvalsOf(r.id)).toBe(1n);
    const other = aRound({ kind: 'threshold', threshold: '1' }, 13);
    expect(await onDevice(founder, other.raise)).toEqual({ ok: true, error: '' });
    expect(await onDevice(blake, { circuit: 'approve', proposal: other.id })).toEqual({ ok: true, error: '' });
    expect(approvalsOf(other.id)).toBe(2n);
  });

  it('THE THRESHOLD IS RAISED FROM A DEVICE, AND THE NEXT SIGNER BEYOND IT NEEDS TWO DEVICES\' APPROVALS BEFORE ANYBODY CAN SEAT THEM', async () => {
    const blake = privateStateFor(2);
    const cleo = privateStateFor(3);
    expect(await seat(blake, [founder], 21)).toEqual({ ok: true, error: '' });
    const up = aRound({ kind: 'threshold', threshold: '2' }, 22);
    expect(await onDevice(founder, up.raise)).toEqual({ ok: true, error: '' });
    /* RED WHEN: the threshold cannot be changed from a device - the company can then never ask for more than one approval. */
    expect(await onDevice(founder, { circuit: 'setThreshold', threshold: '2', proposal: up.id, proposalSalt: up.salt }))
      .toEqual({ ok: true, error: '' });
    expect(ledgerNow().threshold).toBe(2n);

    const r = aRound(invitationOf(cleo), 23);
    expect(await onDevice(founder, r.raise)).toEqual({ ok: true, error: '' });
    /* One approval of two: the contract refuses the seat while the call is built, before anything is sent. */
    await expect(inviteeTakes(cleo, r.id, r.salt)).rejects.toThrow(/not enough approvals/u);
    expect(seated(leafOfDevice(cleo))).toBe(false);
    /* RED WHEN: the second signer's device cannot approve an invitation - a company larger than its threshold is then never finished. */
    expect(await onDevice(blake, { circuit: 'approve', proposal: r.id })).toEqual({ ok: true, error: '' });
    expect(await inviteeTakes(cleo, r.id, r.salt)).toEqual({ ok: true, error: '' });
    expect(seated(leafOfDevice(cleo))).toBe(true);
    expect(ledgerNow().signerLeaves.size()).toBe(3n);
  });

  it('ANOTHER WALLET HOLDING THE INVITATION CANNOT TAKE THE SEAT IT NAMES', async () => {
    const blake = privateStateFor(2);
    const other = privateStateFor(4);
    const r = aRound(invitationOf(blake), 31);
    expect(await onDevice(founder, r.raise)).toEqual({ ok: true, error: '' });
    /* RED WHEN: an invitation approved for one address can be taken by another wallet. */
    await expect(inviteeTakes(other, r.id, r.salt, { ...invitedAddressFor(blake), coinSecretKey: invitedAddressFor(other).coinSecretKey }))
      .rejects.toThrow(/that proposal does not invite this wallet with these rights/u);
    expect(seated(leafOfDevice(other))).toBe(false);
  });

  it('SOMEBODY WHO IS NOT A SIGNER CANNOT INVITE ANYBODY, AND NO SIGNER\'S DEVICE CARRIES AN INVITATION OUT', async () => {
    const outsider = privateStateFor(9);
    const blake = privateStateFor(2);
    const r = aRound(invitationOf(outsider), 41);
    await expect(onDevice(outsider, r.raise)).rejects.toThrow(/not a signer/u);
    const invited = aRound(invitationOf(blake), 42);
    expect(await onDevice(founder, invited.raise)).toEqual({ ok: true, error: '' });
    /* RED WHEN: a signer's device builds a seat for an invitation instead of leaving it to the invitee's wallet. */
    await expect(onDevice(founder, {
      circuit: 'amendSigner', leaf: hex(leafOfDevice(blake)), proposal: invited.id, proposalSalt: invited.salt, removing: true,
    })).rejects.toThrow(/does not match the company's own record/u);
    expect(seated(leafOfDevice(blake))).toBe(false);
  });
});
