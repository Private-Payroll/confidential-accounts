/**
 * **THE COMPANY'S RECORD ANCHOR MOVED ON FROM A SIGNER'S DEVICE, AND APPLIED BY
 * THE CHAIN.**
 *
 * What is real here:
 *   · the chain is the ledger's own state machine, applying each transaction as
 *     its own block;
 *   · the company account is the compiled account, deployed with this build's
 *     circuits and verifier keys;
 *   · the anchor call is built by the device's own builder, reached through the
 *     page's own worker client and the worker's own handler, from key material
 *     shaped as the keyring holds it, and read by the service's own check.
 *
 * **WHAT THIS DOES NOT SHOW, SAID HERE SO NOTHING RELIES ON IT:** no proof is
 * made (the ledger is told not to check proofs), no fee is balanced, and nothing
 * reaches a network. Whether a refused call is charged a fee is read from where
 * the call lands in its transaction and from the ledger's own result type, not
 * from a fee paid.
 *
 * The one to read first is "A CALL BUILT AGAINST A HEAD ANOTHER DEVICE HAS SINCE MOVED".
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
import { answerVaultAsk } from 'vaults-web-shared/vault-worker-entry.js';
import { vaultBuilderOver, type AccountCallChainOnTheWire, type VaultAnswer } from 'vaults-web-shared/vault-worker-client.js';
import { anchorPlacementOf, type SignerMaterial } from 'vaults-web-shared/governed-call-builder.js';
import { refusalForProven } from '../../src/wiring/proven-submission.js';
import { ACCOUNT_KEYS, keysOnDisk } from './keys-on-disk.js';
import { EMPTY_HEAD } from '../../src/midnight/record-manifest.js';

const NET = 'undeployed';
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const circuits = (accountModule as any).pureCircuits;

/** The ledger's own state machine, one transaction per block, saying what kind of result each was. */
class Chain {
  state: any = L.LedgerState.blank(NET);
  apply(tx: any): { type: string; error: string } {
    const s = new L.WellFormedStrictness();
    s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = false;
    s.enforceLimits = false; s.verifySignatures = true;
    const now = new Date();
    const t = BigInt(Math.floor(now.getTime() / 1000));
    const [next, result] = this.state.apply(tx.wellFormed(this.state, s, now),
      new L.TransactionContext(this.state, {
        secondsSinceEpoch: t, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: t - 6n,
      }));
    if (result.type === 'success' || result.type === 'partialSuccess') this.state = next.postBlockUpdate(now);
    return { type: String(result.type), error: String(result.error ?? '') };
  }
  contract(address: string): any { return this.state.index(address); }
}

/* The account's verifier keys, which only a full compile produces; the job that builds them runs this file by name. */
const KEYS = keysOnDisk([ACCOUNT_KEYS]);
if (!KEYS.ok) console.log(`  NOT CHECKED HERE: the record anchor was not moved on from a device, because ${KEYS.why}`);

let historyReads = 0;

describe.skipIf(!KEYS.ok)('THE RECORD ANCHOR, MOVED ON FROM A SIGNER\'S DEVICE [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  let chain: Chain;
  let company: string;
  let founder: AccountPrivateState;
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
      /* The indexer the wallet names, serving the account as the chain holds it now as its one step of history. */
      historyAt: () => {
        const read = ++historyReads;
        return {
          latest: async () => `${read}`.padStart(64, '0'),
          of: async () => [{ kind: 'call' as const, transaction: `${read}`.padStart(64, '0'), state: chain.contract(company).serialize(), block: { height: read, at: read } }],
        };
      },
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
  const callState = (): AccountCallChainOnTheWire => ({
    blockHash: '00'.repeat(32),
    accountState: b64(chain.contract(company).serialize()),
    parameters: b64(L.LedgerParameters.initialParameters().serialize()),
  });
  /* The head the account holds, as its history at the wallet's indexer holds it. */
  const onChain = () => client.anchorsOnChain({ account: company, indexer: { indexerUri: 'https://i.example', indexerWsUri: 'wss://i.example' } });
  const headNow = async () => (await onChain()).landed.at(-1)?.head ?? EMPTY_HEAD;
  /** What the device sent, read by the service's own reader and check. */
  const read = (tx: string) => {
    const t = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', Buffer.from(tx, 'base64'));
    const refusal = refusalForProven(t, company);
    if (refusal !== null) throw new Error(`the service refused it: ${refusal}`);
    return t;
  };
  /* Who holds the account now, as the history at the wallet's indexer shows it and a batch's header names them. */
  const anchorFrom = async (chainAt: AccountCallChainOnTheWire, previous: string, batch: string) => {
    const { now } = await onChain();
    return client.anchor({ account: company, material: material(founder), chain: chainAt, previous, batch, held: now });
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
    const seeded = chain.apply(L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(new Date(Date.now() + 600_000)).addDeploy(deploy)));
    if (seeded.type !== 'success') throw new Error(`the company account was not deployed: ${seeded.error}`);
    company = String(deploy.address).toLowerCase();
  });

  it('THE CALL BUILT ON THE DEVICE LANDS IN ITS TRANSACTION\'S GUARANTEED SECTION, AND THE CHAIN MOVES THE HEAD ON BY ITS BATCH', async () => {
    expect(await headNow()).toBe(EMPTY_HEAD);
    const tx = read((await anchorFrom(callState(), EMPTY_HEAD, 'b1'.repeat(32))).tx);
    /* RED WHEN: the call is placed where a refusal of it would still pay the transaction's fee. */
    expect(anchorPlacementOf(tx)).toBe('guaranteed');
    expect(chain.apply(tx)).toEqual({ type: 'success', error: '' });
    /* RED WHEN: the head the chain holds is not the batch, its holders and the founding seat's tag folded into the empty head by the account's own functions. */
    const { now, landed } = await onChain();
    const tag = await client.anchorTag({ account: company, material: material(founder) });
    expect(await headNow()).toBe(hex(circuits.anchorHeadOf(new Uint8Array(32),
      circuits.anchorHeldOf(Buffer.from('b1'.repeat(32), 'hex'), BigInt(now.approvals), { field: BigInt(`0x${now.signerRoot}`) }, Buffer.from(tag, 'hex')))));
    /* RED WHEN: the worker's tag is not the one the account's call wrote beside the head - a device's headers would never fold to it. */
    expect(landed.at(-1)?.tag).toBe(tag);
  });

  it('A CALL BUILT AGAINST A HEAD ANOTHER DEVICE HAS SINCE MOVED IS REFUSED WHOLE BY THE CHAIN: NOTHING OF IT LANDS, AND THE HEAD DOES NOT MOVE', async () => {
    const both = callState();
    const first = read((await anchorFrom(both, EMPTY_HEAD, 'b1'.repeat(32))).tx);
    const second = read((await anchorFrom(both, EMPTY_HEAD, 'b2'.repeat(32))).tx);
    expect(chain.apply(first).type).toBe('success');
    const moved = await headNow();
    const refused = chain.apply(second);
    /* RED WHEN: the stale call is applied in part - its fee taken and its write dropped - or applied at all. */
    expect(refused.type).toBe('failure');
    /* RED WHEN: the chain takes the call and refuses it for anything but the head it read no longer being the head. */
    expect(refused.error).toMatch(/mismatch between expected .* and actual .* read/u);
    /* RED WHEN: a refused anchor overwrites the head another device moved it to, so that device's batch no longer folds. */
    expect(await headNow()).toBe(moved);
  });

  it('A DEVICE THAT READ AN OLDER HEAD THAN THE STATE IT WAS GIVEN IS REFUSED BEFORE ANYTHING IS PROVED, IN THE CONTRACT\'S OWN WORDS', async () => {
    chain.apply(read((await anchorFrom(callState(), EMPTY_HEAD, 'b1'.repeat(32))).tx));
    /* RED WHEN: a call naming another head than the one the state holds is built at all. */
    await expect(anchorFrom(callState(), EMPTY_HEAD, 'b2'.repeat(32))).rejects.toThrow(/another device anchored the company's records first/u);
  });
});
