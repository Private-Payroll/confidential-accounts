import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as vaultModule from '../../../contracts/managed-vault/contract/index.js';
import { keysOnDisk, VAULT_KEYS } from '../../../contracts/test/keys-on-disk.js';
import type { Committee } from '../../../src/midnight/vault-committee.js';
import { buildVaultBornHeld, type VaultBuilderDeps } from './vault-builder.js';
import { checkedAccountKeys } from './vault-worker-entry.js';
import { vaultAsDeployed } from './vault-as-deployed.js';

/*
 * A vault, built on the device held by the company's committee from its first
 * transaction, and read on a signer's device from the deploy its address was
 * made from, before it is adopted or set up. Real transactions, built by
 * the device's own builder; nothing is sent.
 */
const NET = 'undeployed';
const ACCOUNT = 'c0'.repeat(32);
const MANAGED = join(import.meta.dirname, '../../../contracts/managed-vault');
const KEYS = keysOnDisk([VAULT_KEYS]).ok;
const vk = (n: number) => L.signatureVerifyingKey(L.signingKeyFromBip340(new Uint8Array(32).fill(n)));
const committee: Committee = { committee: [vk(1), vk(2)].sort((a, b) => (a.value < b.value ? -1 : 1)), threshold: 2 };
const keyFile = async (c: string) => new Uint8Array(readFileSync(join(MANAGED, 'keys', `${c}.verifier`)));
const expected = (vaultModule as unknown as { expectedVk: Record<string, string> }).expectedVk;
const deps = (): VaultBuilderDeps => ({
  ledger: L, runtimeState: (runtime as any).ContractState, contracts: contracts as any, network: NET,
  compiled: CompiledContract.make('Vault', (vaultModule as any).Contract).pipe(
    CompiledContract.withWitnesses({ noteToSpend: () => { throw new Error('no'); }, nonceSecret: () => { throw new Error('no'); } } as never)),
  zkConfig: new NodeZkConfigProvider(MANAGED),
  prove: async (tx: any) => tx.prove({
    check: async () => { throw new Error('asked to check'); }, prove: async () => { throw new Error('asked to prove'); }, lookupKey: async () => undefined,
  } as never, L.CostModel.initialCostModel()),
});
/** The state a built deploy leaves at its own address, as the chain records it: what the indexer serves for the vault's deploy. */
const deployStateOf = (proven: Uint8Array): unknown => {
  const tx = L.Transaction.deserialize('signature', 'proof', 'pre-binding', proven) as { intents?: Map<unknown, { actions?: Array<{ initialState?: unknown }> }> };
  return [...(tx.intents?.values() ?? [])][0]?.actions?.[0]?.initialState;
};
/** The indexer the wallet names, standing in: it holds `deploys` by address, and nothing else. */
const chainHolding = (deploys: Record<string, Uint8Array>, now: Record<string, Uint8Array> = deploys) => ({
  deployState: async (address: string) => (deploys[address] === undefined ? null : deployStateOf(deploys[address]!)),
  /* The vault's state now: by default the one its deploy left; with `now`, a state held as another build's deploy left it. */
  contractState: async (address: string) => (now[address] === undefined ? null : deployStateOf(now[address]!) as never),
});
const reader = (fetchKey = keyFile) => ({
  ledger: L, runtimeState: (runtime as any).ContractState, vault: vaultModule,
  vaultKeys: checkedAccountKeys(fetchKey, expected, sha256, 'the vault'),
}) as never;

describe.skipIf(!KEYS)('A VAULT READ AS IT WAS BORN [needs contracts/managed-vault/keys; `npm run compact:vault -- --full` builds them]', () => {
  let born: { address: string; proven: Uint8Array };
  let other: { address: string; proven: Uint8Array };
  beforeAll(async () => {
    setNetworkId(NET as never);
    born = await buildVaultBornHeld(deps(), { account: ACCOUNT, holders: committee });
    other = await buildVaultBornHeld(deps(), { account: ACCOUNT, holders: { committee: [vk(3)], threshold: 1 } });
  }, 120_000);
  const ask = (over: Partial<{ vault: string; account: string; holders: Committee; again: boolean }> = {}) =>
    ({ vault: born.address, account: ACCOUNT, holders: committee, ...over });
  const chain = () => chainHolding({ [born.address]: born.proven, [other.address]: other.proven });

  it('THE DEVICE\'S OWN BUILD IS READ AS BORN HELD BY THE COMMITTEE IT WAS BUILT FOR', async () => {
    /* RED WHEN: the device's builder holds the vault by anything but the committee it was given, or writes anything into it. */
    expect(await vaultAsDeployed(reader(), ask(), chain())).toBeNull();
  });

  it('A DEPLOY HELD BY OTHER KEYS, OR READ AGAINST ANOTHER COMMITTEE, ACCOUNT OR THRESHOLD, IS REFUSED', async () => {
    const held = /held from its first transaction by the company's committee/;
    /* RED WHEN: the deploy's own committee is believed rather than compared with the company's. */
    expect(await vaultAsDeployed(reader(), ask({ vault: other.address }), chain())).toMatch(held);
    expect(await vaultAsDeployed(reader(), ask({ holders: { ...committee, threshold: 1 } }), chain())).toMatch(held);
    expect(await vaultAsDeployed(reader(), ask({ holders: { committee: [...committee.committee].reverse(), threshold: 2 } }), chain())).toMatch(held);
    /* RED WHEN: the account the vault is pinned to is not compared. */
    expect(await vaultAsDeployed(reader(), ask({ account: 'd0'.repeat(32) }), chain())).toMatch(/pinned to a different company's account/);
  });

  it('THE DEPLOY READ IS THE ONE THE CHAIN HOLDS AT THE VAULT\'S OWN ADDRESS, AND AN ADDRESS WITH NONE IS NO VAULT', async () => {
    /* RED WHEN: a vault is read from a deploy at another address than its own. */
    expect(await vaultAsDeployed(reader(), ask(), chainHolding({ [born.address]: other.proven }))).toMatch(/held from its first transaction by the company's committee/);
    /* RED WHEN: an address the chain holds no deploy for is read as a vault born held. */
    expect(await vaultAsDeployed(reader(), ask(), chainHolding({}))).toMatch(/the chain holds no deploy at this vault's address/);
  });

  it('IS NEVER BUILT FOR A COMMITTEE THE ONE INSTALL RULE REFUSES', async () => {
    /* RED WHEN: the device builds a vault whose committee lists a key twice, or whose threshold is outside its keys. */
    const [first] = committee.committee;
    await expect(buildVaultBornHeld(deps(), { account: ACCOUNT, holders: { committee: [first!, first!], threshold: 2 } })).rejects.toThrow(/are the same key/);
    await expect(buildVaultBornHeld(deps(), { account: ACCOUNT, holders: { ...committee, threshold: 0 } })).rejects.toThrow(/not a whole number of at least one/);
    await expect(buildVaultBornHeld(deps(), { account: ACCOUNT, holders: { ...committee, threshold: committee.committee.length + 1 } })).rejects.toThrow(/can never be met/);
  });

  it('IS READ AGAINST THIS BUILD\'S KEYS ONLY: A SERVED KEY THAT IS NOT THIS BUILD\'S STOPS THE READ', async () => {
    const swapped = async (c: string) => (c === 'payout' ? keyFile('deposit') : keyFile(c));
    /* RED WHEN: the keys the deploy is compared with are taken as served, unchecked. */
    await expect(vaultAsDeployed(reader(swapped), ask(), chain())).rejects.toThrow('the verifying key served for the vault\'s payout circuit is not this build\'s');
  });

  it('A VAULT ADOPTED AGAIN IS HELD BY THE COMMITTEE THE COMPANY HOLDS NOW, SO A CHANGE OF SUPER ADMINS SINCE ITS DEPLOY STRANDS NOTHING', async () => {
    const moved = { committee: [vk(3)], threshold: 1 };
    /* The super admins changed: the vault, born held by the first committee, is held now as the change left it. */
    const changed = chainHolding({ [born.address]: born.proven }, { [born.address]: other.proven });
    /* RED WHEN: a retired vault adopted again is held to the committee of its deploy, which no change since can ever match, so the money paid into it is reached by no device. */
    expect(await vaultAsDeployed(reader(), ask({ holders: moved, again: true }), changed)).toBeNull();
    /* RED WHEN: a first adoption is no longer held to its deploy's committee. */
    expect(await vaultAsDeployed(reader(), ask({ holders: moved }), changed)).toMatch(/held from its first transaction by the company's committee/);
    /* RED WHEN: a vault held now by other keys than the company's is adopted again, or refused without saying what clears it. */
    expect(await vaultAsDeployed(reader(), ask({ holders: moved, again: true }), chain()))
      .toMatch(/held now by other keys, or at another threshold, than your company's super admins hold\. Have the super admins make their change again.*Nothing was sent\.$/);
    /* RED WHEN: the account a vault adopted again is pinned to is not compared. */
    expect(await vaultAsDeployed(reader(), ask({ holders: moved, again: true, account: 'd0'.repeat(32) }), changed)).toMatch(/pinned to a different company's account/);
  });
});
