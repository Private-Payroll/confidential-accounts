/**
 * **A RECOVERY OF THE COMPANY'S RECORD ANCHOR, CARRIED OUT FROM A SIGNER'S
 * DEVICE AND APPLIED BY THE CHAIN: LANDED, OR BEATEN BY ANOTHER ANCHOR.**
 *
 * At the ledger's initial parameters a recovery's checks are over the budget of
 * its transaction's guaranteed section, so the call lands in the fallible one.
 * There a carrying out another anchor beats lands, pays its fee, writes nothing
 * and leaves the recovery open. The device reads that off the transaction - the
 * account's history at the indexer the person's own wallet names records every
 * call with its transaction's result - and says so; carried out again within
 * its window, it lands.
 *
 * What is real here:
 *   · the chain is the ledger's own state machine, applying each transaction as
 *     its own block, and its history is every call each block applied, with the
 *     state after it and whether its transaction succeeded in full, as the
 *     indexer records them;
 *   · the company account is the compiled account, deployed with this build's
 *     circuits and verifier keys;
 *   · every call - the raise, the approval, the anchors and the recovery - is
 *     built by the device's own builder, through the page's own worker client
 *     and the worker's own handler, and the device's own steps raise, approve
 *     and carry out the recovery.
 *
 * **WHAT THIS DOES NOT SHOW, SAID HERE SO NOTHING RELIES ON IT:** no proof is
 * made (the ledger is told not to check proofs), no fee is balanced, and nothing
 * reaches a network; that a refused call in the fallible section pays its fee
 * is read from where it lands and the ledger's result type, not from a fee
 * paid. The device's own read of the company's records is a stand-in: it
 * stands at the first batch with the second's header given by nobody, as a
 * read of a header nobody kept does.
 *
 * The one to read first is "A CARRYING OUT ANOTHER ANCHOR BEATS".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as accountModule from '../managed/contract/index.js';
import { witnesses, type AccountPrivateState } from '../src/witnesses.js';
import { privateStateFor, leafOfDevice, COMPANY_LABEL } from './simulator.js';
import { DEPLOYED_CIRCUITS } from '../../src/midnight/deferral.js';
import { assetIdBytes, NO_ASSET } from '../../src/core/assets.js';
import { commit, type Hex } from '../../src/core/crypto.js';
import { EMPTY_HEAD } from '../../src/midnight/record-manifest.js';
import { answerVaultAsk } from 'vaults-web-shared/vault-worker-entry.js';
import { vaultBuilderOver, type AccountCallChainOnTheWire, type VaultAnswer } from 'vaults-web-shared/vault-worker-client.js';
import type { GovernanceOnTheWire, SignerMaterial } from 'vaults-web-shared/governed-call-builder.js';
import { proposalFileRead, proposalFileText, raiseFromTheChain, approveFromAFile } from 'vaults-web-shared/governance-from-the-chain.js';
import {
  approveRecoveryHere, carryOutRecoveryHere, raiseRecoveryHere, RecoveryNotCarriedOut, type RecoveryDoors,
} from 'vaults-web-shared/records-recovered-here.js';
import { treeKeptInMemory } from 'vaults-web-shared/tree-kept-here.js';
import { refusalForProven } from '../../src/wiring/proven-submission.js';
import { ACCOUNT_KEYS, keysOnDisk } from './keys-on-disk.js';

const NET = 'undeployed';
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const circuits = (accountModule as any).pureCircuits;
const INDEXER = { indexerUri: 'https://indexer.invalid/api', indexerWsUri: 'wss://indexer.invalid/ws' };
const COMPANY_ID = 'acct_recovered_on_the_chain';

/** One step of the account's history, as the indexer records each call: its state after the block, and its transaction's result. */
interface Step {
  readonly kind: 'deploy' | 'call'; readonly transaction: string; readonly state: Uint8Array;
  readonly block: { readonly height: number; readonly at: number }; readonly entryPoint?: string; readonly succeeded: boolean;
}

/** The circuits a transaction calls, as the ledger lays its intents out. */
const callsIn = (tx: any): string[] => {
  const out: string[] = [];
  for (const intent of (tx.intents as Map<number, any>).values()) {
    for (const a of intent.actions as any[]) {
      if (a.entryPoint === undefined) continue;
      out.push(a.entryPoint instanceof Uint8Array ? new TextDecoder().decode(a.entryPoint) : String(a.entryPoint));
    }
  }
  return out;
};

/** The ledger's own state machine, one transaction per block, keeping the account's history as the indexer records it. */
class Chain {
  state: any = L.LedgerState.blank(NET);
  height = 0;
  readonly steps: Step[] = [];
  apply(tx: any, account?: string): { type: string; error: string } {
    const s = new L.WellFormedStrictness();
    s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = false;
    s.enforceLimits = false; s.verifySignatures = true;
    const now = new Date();
    const t = BigInt(Math.floor(now.getTime() / 1000));
    const [next, result] = this.state.apply(tx.wellFormed(this.state, s, now),
      new L.TransactionContext(this.state, {
        secondsSinceEpoch: t, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: t - 6n,
      }));
    const type = String(result.type);
    if (type === 'success' || type === 'partialSuccess') {
      this.state = next.postBlockUpdate(now);
      this.height += 1;
      if (account !== undefined) {
        const state = this.contract(account).serialize();
        const block = { height: this.height, at: now.getTime() };
        const transaction = this.height.toString(16).padStart(64, '0');
        for (const entryPoint of callsIn(tx)) this.steps.push({ kind: 'call', transaction, state, block, entryPoint, succeeded: type === 'success' });
      }
    }
    return { type, error: String(result.error ?? '') };
  }
  contract(address: string): any { return this.state.index(address); }
}

/* The account's verifier keys, which only a full compile produces; the job that builds them runs this file by name. */
const KEYS = keysOnDisk([ACCOUNT_KEYS]);
if (!KEYS.ok) console.log(`  NOT CHECKED HERE: no recovery was carried out on the chain, because ${KEYS.why}`);

describe.skipIf(!KEYS.ok)('A RECOVERY CARRIED OUT ON THE CHAIN FROM A SIGNER\'S DEVICE [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  let chain: Chain;
  let company: string;
  let founder: AccountPrivateState;
  /** What the chain did with each transaction the service was handed, in order. */
  let results: Array<{ circuits: string[]; type: string; error: string }>;
  const accountZk = new NodeZkConfigProvider(new URL('../managed', import.meta.url).pathname);
  const accountCompiled = CompiledContract.make('ConfidentialAccount', (accountModule as any).Contract).pipe(
    CompiledContract.withWitnesses(witnesses as never));
  /* What the worker proves is handed back unproven: the chain here checks no proof. */
  const client = vaultBuilderOver((() => {
    const listeners: Array<(e: { data: unknown }) => void> = [];
    const deps = async () => ({
      ledger: L, runtimeState: (runtime as any).ContractState, contracts,
      accountCompiled, accountZkConfig: accountZk, accountPure: circuits, accountLedger: (accountModule as any).ledger,
      accountTree: { StateBoundedMerkleTree: runtime.StateBoundedMerkleTree, CompactTypeBytes: runtime.CompactTypeBytes, CompactTypeMerkleTreeDigest: runtime.CompactTypeMerkleTreeDigest },
      prove: async (unproven: any) => unproven,
      /* The indexer the wallet names: the account's history as the chain applied it. */
      historyAt: () => ({
        latest: async () => chain.steps[chain.steps.length - 1]!.transaction,
        of: async () => [...chain.steps],
      }),
    });
    return {
      addEventListener: (_t: 'message', l: (e: { data: unknown }) => void) => { listeners.push(l); },
      postMessage: (message: unknown) => {
        void answerVaultAsk(deps as never, message as never).then(
          (a: VaultAnswer) => listeners.forEach((l) => l({ data: a })),
          (e: Error) => listeners.forEach((l) => l({ data: { id: (message as { id: number }).id, ok: false, error: e.message } })));
      },
    };
  })(), NET);
  const material = (s: AccountPrivateState): SignerMaterial => ({ signingSecret: hex(s.secretKey), blinding: hex(s.blinding), scope: hex(s.scope) });
  /* What a call to the account is built on, as the wallet's indexer holds it now. */
  const callState = (): AccountCallChainOnTheWire => ({
    blockHash: '00'.repeat(32),
    accountState: b64(chain.contract(company).serialize()),
    parameters: b64(L.LedgerParameters.initialParameters().serialize()),
  });
  const onChain = () => client.anchorsOnChain({ account: company, indexer: INDEXER });
  const headNow = async () => (await onChain()).landed.at(-1)?.head ?? EMPTY_HEAD;
  /** What the device sent, read by the service's own reader and check. */
  const read = (tx: string) => {
    const t = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', Buffer.from(tx, 'base64'));
    const refusal = refusalForProven(t, company);
    if (refusal !== null) throw new Error(`the service refused it: ${refusal}`);
    return t;
  };
  /** The service sending what it is handed: applied by the chain as its own block. */
  const sent = (tx: string): void => {
    const t = read(tx);
    const r = chain.apply(t, company);
    results.push({ circuits: callsIn(t), ...r });
    if (r.type === 'failure') throw new Error(`the chain refused it: ${r.error}`);
  };
  /** One anchor of the founding seat's, moving the head on from the one the chain holds by `batch`. */
  const anchorOnce = async (batch: string) => {
    const { now } = await onChain();
    const { tx } = await client.anchor({ account: company, material: material(founder), chain: callState(), previous: await headNow(), batch, held: now });
    sent(tx);
  };
  /** Where the founding seat's device's own read stands: the first batch checked, the second's header given by nobody. */
  let reached: { seq: number; head: Hex; root: Hex; dirVersion: number };
  const doorsWith = (send: RecoveryDoors['send']): RecoveryDoors => ({
    accountId: COMPANY_ID, account: company, material: material(founder), indexer: INDEXER,
    builder: { ...client, accountCallChain: async () => callState() },
    send,
    read: async () => ({ reached, stop: { stop: 'not-given', seq: reached.seq + 1, what: 'its header' } }),
    onChain, headers: treeKeptInMemory().headers,
    watch: { everyMs: 1000, withinMs: 3000, sleep: async () => {} },
  });
  /** A recovery raised from the founding seat's device and approved by its one seat: the file, handed over as text. */
  const raisedAndApproved = async (doors: RecoveryDoors) => {
    const { file } = await raiseRecoveryHere(doors, { latest: new Date(Date.now() + 24 * 3600 * 1000) });
    const handed = proposalFileRead(proposalFileText(file));
    await approveRecoveryHere(doors, handed);
    return handed;
  };
  const standing = async (chainId: string) => (await client.roundsOnChain({ account: company, indexer: INDEXER, chainIds: [chainId] }))[chainId]!;

  beforeEach(async () => {
    setNetworkId(NET as never);
    chain = new Chain();
    results = [];
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
    const seeded = chain.apply(L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(new Date(Date.now() + 600_000)).addDeploy(deploy)));
    if (seeded.type !== 'success') throw new Error(`the company account was not deployed: ${seeded.error}`);
    company = String(deploy.address).toLowerCase();
    chain.steps.push({ kind: 'deploy', transaction: '00'.repeat(32), state: chain.contract(company).serialize(), block: { height: chain.height, at: Date.now() }, succeeded: true });
    /* The first batch, which the founding seat's device checked; then a second, whose header nobody kept. */
    await anchorOnce('b1'.repeat(32));
    reached = { seq: 0, head: (await headNow()) as Hex, root: 'a0'.repeat(32) as Hex, dirVersion: 0 };
    await anchorOnce('b2'.repeat(32));
  });

  it('A RECOVERY CARRIED OUT FROM THE DEVICE LANDS IN THE FALLIBLE SECTION, AND THE CHAIN MOVES THE HEAD ON AND CLOSES ITS PROPOSAL', async () => {
    const doors = doorsWith({ service: async (tx) => { sent(tx); } });
    const file = await raisedAndApproved(doors);
    const before = await headNow();
    const done = await carryOutRecoveryHere(doors, file);
    /* RED WHEN: a recovery is refused for landing in the fallible section - no recovery could ever be carried out. */
    expect(done.placement).toBe('fallible');
    /* RED WHEN: the recovery the chain took is not applied whole. */
    expect(results.at(-1)).toEqual({ circuits: ['recoverAnchor'], type: 'success', error: '' });
    /* RED WHEN: the head the device worked out is not the one the chain moved to, from the head it held. */
    expect(await headNow()).toBe(done.head);
    expect(done.head).not.toBe(before);
    expect(done.header).toMatchObject({ kind: 'recovery', seq: 1, resumesFrom: file.resumesFrom, changes: [] });
    /* RED WHEN: the recovery's proposal is left open once it is carried out. */
    expect(await standing(file.chainId)).toMatchObject({ held: 'closed', closedBy: ['recoverAnchor'] });
    /* RED WHEN: the history at the wallet's indexer is not read for the call that moved the head: a device could not say a recovery moved it. */
    expect((await onChain()).landed.at(-1)).toMatchObject({ head: done.head, anchorsInBlock: 1, recovered: true });
  });

  it('A CARRYING OUT ANOTHER ANCHOR BEATS LANDS, WRITES NOTHING AND LEAVES THE RECOVERY OPEN; THE DEVICE READS IT OFF THE TRANSACTION AND SAYS SO, AND CARRIED OUT AGAIN IT LANDS', async () => {
    let beatOnce = true;
    /* Between the device building the recovery and the chain taking it, another anchor lands. */
    const doors = doorsWith({ service: async (tx) => {
      if (beatOnce && callsIn(read(tx)).includes('recoverAnchor')) { beatOnce = false; await anchorOnce('b3'.repeat(32)); }
      sent(tx);
    } });
    const file = await raisedAndApproved(doors);
    const said = await carryOutRecoveryHere(doors, file).then(() => null, (e: unknown) => e);
    /* RED WHEN: the chain refuses the beaten recovery whole - then it would not be in the fallible section, and its fee not paid. */
    expect(results.at(-1)).toMatchObject({ circuits: ['recoverAnchor'], type: 'partialSuccess' });
    /* RED WHEN: a beaten carrying out is believed carried out, or said as anything but another anchor first and the recovery still open. */
    expect(said).toBeInstanceOf(RecoveryNotCarriedOut);
    expect((said as Error).message).toMatch(
      /^another anchor of the company's records got there first, so this carrying out wrote nothing and its fee was paid\. The recovery is still open: carry it out again before /u);
    /* RED WHEN: the beaten call wrote anything - the head is the other anchor's, and the proposal still open, its refused call in the history. */
    const after = await standing(file.chainId);
    expect(after).toMatchObject({ held: 'open', approvals: 1, failedCalls: ['recoverAnchor'] });
    const beaten = await headNow();
    /* Carried out again, within its window, from the head the chain holds now: it lands. */
    const done = await carryOutRecoveryHere(doors, file);
    expect(results.at(-1)).toEqual({ circuits: ['recoverAnchor'], type: 'success', error: '' });
    expect(await headNow()).toBe(done.head);
    expect(done.header.previous).toBe(beaten);
    expect(await standing(file.chainId)).toMatchObject({ held: 'closed' });
  });

  it('A RECOVERY SHORT OF THE APPROVALS THE ACCOUNT ASKS - ITS POLICY BAR ABOVE ITS THRESHOLD - IS REFUSED AS IT IS BUILT, IN THE ACCOUNT\'S OWN WORDS, AND NOTHING IS KEPT OR SENT', async () => {
    const doors = doorsWith({ service: async (tx) => { sent(tx); } });
    /** One governance change raised and approved from the founding seat's device, then carried out by `order`. */
    const governed = async (change: GovernanceOnTheWire, carry: (proposal: string, proposalSalt: string) => any) => {
      const { file: f } = await raiseFromTheChain(doors, { change, summary: 'a change' });
      await approveFromAFile(doors, f, async () => {});
      const identity = await client.proposalIdentity(change, f.salt);
      const { tx } = await client.governedCall({
        account: company, material: material(founder), chain: callState(),
        opened: {
          chainId: identity.chainId, digest: identity.digest, vault: identity.noVault, salt: f.salt, summary: f.summary, governance: change,
          half: { assetId: hex(assetIdBytes(NO_ASSET)), changeAmount: '0', changeBatchDigest: commit('', '') },
        },
        order: carry(identity.chainId, f.salt),
      });
      sent(tx);
      expect(results.at(-1)).toMatchObject({ type: 'success' });
    };
    /* A second signer seated, then the company's policy bar raised to two, above its threshold of one. */
    const leaf = hex(leafOfDevice(privateStateFor(2)));
    await governed({ kind: 'add-signer', leaf }, (proposal, proposalSalt) => ({ circuit: 'amendSigner', leaf, proposal, proposalSalt }));
    await governed({ kind: 'policy-bar', bar: '2' }, (proposal, proposalSalt) => ({ circuit: 'setPolicyBar', bar: '2', proposal, proposalSalt }));
    const file = await raisedAndApproved(doors);
    expect(await standing(file.chainId)).toMatchObject({ held: 'open', approvals: 1 });
    const kept = treeKeptInMemory();
    const sentBefore = results.length;
    /* RED WHEN: the device judges the approvals by its threshold and keeps a header for a call the account refuses. */
    await expect(carryOutRecoveryHere({ ...doors, headers: kept.headers }, file)).rejects.toThrow(
      /^the recovery of the company's records was not carried out: .*needs as many approvals as a policy change needs, and at least the threshold; ask more signers to approve it\. Nothing was built or sent\.$/u);
    expect(await kept.headers.at(COMPANY_ID, 1)).toEqual([]);
    expect(results).toHaveLength(sentBefore);
    expect(await standing(file.chainId)).toMatchObject({ held: 'open' });
  });
});
