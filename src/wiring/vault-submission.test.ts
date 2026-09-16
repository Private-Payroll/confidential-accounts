import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as vaultModule from '../../contracts/managed-vault/contract/index.js';
import { buildDeposit, buildVaultDeploy, type VaultBuilderDeps } from '../web/vault-builder.js';
import { committeeReplacement, type Committee } from '../midnight/vault-committee.js';
import { VAULT_CIRCUITS } from '../midnight/vault-contract.js';
import type { AuthorityRead, OnChainAuthority } from '../midnight/ledger.js';
import {
  circuitsRefusal, fundingRefusal, heldKeyFundingRefusal, readVaultDeploy, refusalForDeposit, refusalForHandover,
  startingLedgerFrom, type VaultStartingLedger,
} from './vault-submission.js';

/*
 * What the company's fee payer will pay for on a vault, read off the ledger's
 * own transactions as the device's builder makes them (unproven: the shape the
 * service reads is the same, and nothing here is proved).
 */
const NET = 'undeployed';
const ACCOUNT = 'c0'.repeat(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const zk = new NodeZkConfigProvider(new URL('../../contracts/managed-vault', import.meta.url).pathname);
const deps: VaultBuilderDeps = {
  ledger: L,
  runtimeState: (runtime as any).ContractState,
  contracts: contracts as any,
  compiled: CompiledContract.make('Vault', (vaultModule as any).Contract).pipe(
    CompiledContract.withWitnesses({ noteToSpend: () => { throw new Error('no'); } } as never)),
  zkConfig: zk,
  prove: async (tx: any) => tx,
  network: NET,
};
const readDeploy = (b: Uint8Array) => L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', b) as any;
const startingLedgerOf = (state: any): VaultStartingLedger =>
  startingLedgerFrom((vaultModule as any).ledger((runtime as any).ContractState.deserialize(state.serialize()).data));
const vk = (n: number) => L.signatureVerifyingKey(L.signingKeyFromBip340(new Uint8Array(32).fill(n)));
const committee: Committee = { committee: [vk(1), vk(2)].sort((a, b) => (a.value < b.value ? -1 : 1)), threshold: 2 };

/*
 * **THESE ASSERTIONS READ THE VAULT'S VERIFIER KEYS, WHICH ONLY A FULL VAULT
 * COMPILE PRODUCES.** The general checks compile without them, so without a
 * guard this file fails there on a checkout that is correct. The job that
 * builds the keys runs this file by name after building them.
 *
 * Derived from this file's own location, not the working directory: read
 * relatively, a run started anywhere but the root would answer "no keys" and
 * skip in silence.
 */
const KEYS_ON_DISK = existsSync(new URL('../../contracts/managed-vault/keys/deposit.verifier', import.meta.url));
if (!KEYS_ON_DISK) {
  console.log(
    '  NOT CHECKED HERE: the vault\'s verifier keys are not on disk, so what the fee payer'
    + ' will pay for on a vault was not read off real transactions.'
    + ' `npm run compact:vault -- --full` builds them.',
  );
}

describe.skipIf(!KEYS_ON_DISK)('what the fee payer pays for on a vault [needs contracts/managed-vault/keys; `npm run compact:vault -- --full` builds them]', () => {
  let deploy: any;
  let temporary: { tag: string; value: string };
  let vault: string;
  let verifierKeys: Map<string, Uint8Array>;

  beforeAll(async () => {
    setNetworkId(NET as never);
    const built = await buildVaultDeploy(deps, { account: ACCOUNT });
    deploy = readDeploy(built.proven);
    temporary = built.temporaryKey;
    vault = built.vault;
    verifierKeys = new Map(await Promise.all(VAULT_CIRCUITS.map(async (c) => [c, await zk.getVerifierKey(c) as unknown as Uint8Array] as const)));
  });

  const expectations = () => ({ account: ACCOUNT, verifierKeys, startingLedgerOf });
  const oneIntent = (actions: unknown[], extra: Record<string, unknown> = {}) => ({
    intents: new Map([[1, { actions, ...extra }]]),
  });
  const refusalOf = (v: { vault: string } | { refusal: string }) => ('refusal' in v ? v.refusal : null);

  describe('A VAULT DEPLOYED FOR THIS COMPANY', () => {
    it('is read, and its address is the one the device will hand over', () => {
      expect(readVaultDeploy(deploy, expectations())).toEqual({ vault });
    });

    it('REFUSES A VAULT PINNED TO ANOTHER COMPANY\'S ACCOUNT', () => {
      expect(refusalOf(readVaultDeploy(deploy, { ...expectations(), account: 'd0'.repeat(32) })))
        .toMatch(/pinned to a different company's account/);
    });

    it('REFUSES A VAULT THAT STARTS WITH ANYTHING WRITTEN BESIDES ITS ACCOUNT', () => {
      const d = deploy.intents.values().next().value.actions[0];
      /* What the device's builder writes, read through the vault's own ledger: nothing besides the account. */
      expect(startingLedgerOf(d.initialState)).toEqual({ account: ACCOUNT, notes: 0n, unshieldedTokens: 0n, payments: 0n, spendingCaps: 0n });
      for (const written of [{ notes: 1n }, { unshieldedTokens: 1n }, { payments: 1n }, { spendingCaps: 1n }]) {
        const withIt = (s: unknown) => ({ ...startingLedgerOf(s), ...written });
        expect(refusalOf(readVaultDeploy(deploy, { ...expectations(), startingLedgerOf: withIt })), JSON.stringify(written, (_k, v) => String(v)))
          .toMatch(/starts with records a new vault does not have/);
      }
      expect(refusalOf(readVaultDeploy(deploy, { ...expectations(), startingLedgerOf: (s) => ({ ...startingLedgerOf(s), account: 'c0' }) })))
        .toMatch(/not a vault's/);
      expect(refusalOf(readVaultDeploy(deploy, { ...expectations(), startingLedgerOf: () => { throw new Error('no'); } })))
        .toMatch(/not a vault's/);
    });

    it('REFUSES A CIRCUIT THIS BUILD DID NOT COMPILE, AND NAMES IT', () => {
      const swapped = new Map(verifierKeys);
      const k = new Uint8Array(swapped.get('payout')!); k[k.length - 1] ^= 1;
      swapped.set('payout', k);
      expect(refusalOf(readVaultDeploy(deploy, { ...expectations(), verifierKeys: swapped })))
        .toMatch(/its 'payout' circuit is not the one this service's build compiled/);
    });

    it('REFUSES ANY AUTHORITY BUT ONE TEMPORARY KEY, AND A STATE THAT HOLDS MONEY', () => {
      const d = deploy.intents.values().next().value.actions[0];
      const state = d.initialState;
      const as = (mutate: (s: any) => void) => {
        const copy = L.ContractState.deserialize(state.serialize()) as any;
        mutate(copy);
        return oneIntent([{ address: d.address, initialState: copy }]);
      };
      expect(refusalOf(readVaultDeploy(as((s) => { s.maintenanceAuthority = new L.ContractMaintenanceAuthority([vk(1), vk(2)], 1, 0n); }), expectations())))
        .toMatch(/one temporary key/);
      expect(refusalOf(readVaultDeploy(as((s) => { s.maintenanceAuthority = new L.ContractMaintenanceAuthority([vk(1)], 0, 0n); }), expectations())))
        .toMatch(/one temporary key/);
      expect(refusalOf(readVaultDeploy(as(() => {}), expectations()))).toBeNull();
      const rich = { address: d.address, initialState: { ...state, maintenanceAuthority: state.maintenanceAuthority, balance: new Map([['x', 1n]]), operations: () => state.operations(), operation: (n: string) => state.operation(n) } };
      expect(refusalOf(readVaultDeploy(oneIntent([rich]), expectations()))).toMatch(/start holding money/);
      const fewer = { address: d.address, initialState: { maintenanceAuthority: state.maintenanceAuthority, operations: () => state.operations().slice(1), operation: (n: string) => state.operation(n) } };
      expect(refusalOf(readVaultDeploy(oneIntent([fewer]), expectations()))).toMatch(/circuits other than the vault's own/);
    });

    it('REFUSES ANYTHING BUT ONE DEPLOY: a call, two actions, two intents, or coins', () => {
      const d = deploy.intents.values().next().value.actions[0];
      expect(refusalOf(readVaultDeploy(oneIntent([{ address: vault, entryPoint: 'deposit' }]), expectations())))
        .toMatch(/something other than deploy/);
      expect(refusalOf(readVaultDeploy(oneIntent([d, d]), expectations()))).toMatch(/exactly one thing/);
      expect(refusalOf(readVaultDeploy({ intents: new Map([[1, { actions: [d] }], [2, { actions: [] }]]) }, expectations())))
        .toMatch(/exactly one set of actions/);
      expect(refusalOf(readVaultDeploy({ ...oneIntent([d]), guaranteedOffer: { inputs: [], outputs: [1], transients: [] } }, expectations())))
        .toMatch(/moves coins/);
      expect(refusalOf(readVaultDeploy(oneIntent([d], { dustActions: { spends: [1], registrations: [] } }), expectations())))
        .toMatch(/moves coins/);
      expect(refusalOf(readVaultDeploy(null, expectations()))).toMatch(/exactly one set of actions/);
    });
  });

  describe('THE VAULT HANDED TO THE COMPANY\'S COMMITTEE', () => {
    const onChain = (over: Partial<OnChainAuthority> = {}): OnChainAuthority => ({
      committee: [{ tag: 'schnorr', value: 'aa'.repeat(32) }], threshold: 1, counter: 0n, shape: 'one-key', hasDuplicateMembers: false, ...over,
    });
    const handover = (to: Committee, counter = 0n, sign = true) => {
      let u = committeeReplacement(L as never, { vault, counter, to }) as any;
      if (sign) u = u.addSignature(0n, L.signData(temporary as never, u.dataToSign));
      return L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(new Date(Date.now() + 60_000)).addMaintenanceUpdate(u));
    };

    it('is paid for when it installs exactly the committee, against the counter the chain holds', () => {
      expect(refusalForHandover(handover(committee), { vault, to: committee, onChain: onChain() })).toBeNull();
    });

    it('REFUSES OTHER KEYS, ANOTHER THRESHOLD, ANOTHER ORDER, OR ONE KEY FEWER', () => {
      const other: Committee = { committee: [vk(1), vk(3)].sort((a, b) => (a.value < b.value ? -1 : 1)), threshold: 2 };
      expect(refusalForHandover(handover(other), { vault, to: committee, onChain: onChain() })).toMatch(/not this company's committee/);
      const lower: Committee = { ...committee, threshold: 1 };
      expect(refusalForHandover(handover(lower), { vault, to: committee, onChain: onChain() })).toMatch(/not this company's committee/);
      const reversed = { committee: [...committee.committee].reverse(), threshold: 2 };
      expect(refusalForHandover(handover(committee), { vault, to: reversed, onChain: onChain() })).toMatch(/not this company's committee/);
      const one: Committee = { committee: [vk(1)], threshold: 1 };
      expect(refusalForHandover(handover(one), { vault, to: committee, onChain: onChain() })).toMatch(/not this company's committee/);
    });

    it('REFUSES A VAULT WHOSE TEMPORARY KEY ALREADY CHANGED ITS RULES, however the handover is built', () => {
      /* One key, counter 1: the key it was created with has signed a change already - perhaps to its circuits. */
      for (const builtAt of [1n, 0n]) {
        expect(refusalForHandover(handover(committee, builtAt), { vault, to: committee, onChain: onChain({ counter: 1n }) }))
          .toMatch(/already changed by the key it was created with/);
      }
    });

    it('REFUSES A STALE COUNTER, ANOTHER VAULT, A VAULT ALREADY HANDED OVER, AND AN UNSIGNED CHANGE', () => {
      expect(refusalForHandover(handover(committee, 1n), { vault, to: committee, onChain: onChain() })).toMatch(/built against counter 1/);
      expect(refusalForHandover(handover(committee), { vault: 'ee'.repeat(32), to: committee, onChain: onChain() })).toMatch(/changes a different contract/);
      expect(refusalForHandover(handover(committee), { vault, to: committee, onChain: onChain({ shape: 'committee' }) })).toMatch(/nothing to hand over/);
      expect(refusalForHandover(handover(committee, 0n, false), { vault, to: committee, onChain: onChain() })).toMatch(/nobody signed it/);
    });

    it('REFUSES A DEPLOY OR A CALL SENT AS A HANDOVER', () => {
      expect(refusalForHandover(deploy, { vault, to: committee, onChain: onChain() })).toMatch(/something other than change the vault's rules/);
      expect(refusalForHandover(oneIntent([{ address: vault, entryPoint: 'deposit' }]), { vault, to: committee, onChain: onChain() }))
        .toMatch(/something other than change the vault's rules/);
    });
  });

  describe('A DEPOSIT INTO THE VAULT', () => {
    it('is paid for when it only calls this vault\'s deposit, whatever private coins the wallet added', async () => {
      const state = new L.ContractState();
      const vaultState = (deploy.intents.values().next().value.actions[0]).initialState;
      const built = await buildDeposit(deps, {
        vault, coin: { nonce: 'c1'.repeat(32), token: 'ab'.repeat(32), value: 5n }, state: vaultState.serialize(),
      });
      const tx = readDeploy(built.proven);
      expect(tx.guaranteedOffer.outputs.length).toBe(1);
      expect(refusalForDeposit(tx, { vault })).toBeNull();
      expect(refusalForDeposit(tx, { vault: 'ee'.repeat(32) })).toMatch(/something other than this vault's deposit/);
      void state;
    });

    it('REFUSES ANOTHER ENTRY POINT, PUBLIC MONEY, A FEE PAID ELSEWHERE, OR NO CALL AT ALL', () => {
      expect(refusalForDeposit(oneIntent([{ address: vault, entryPoint: 'payout' }]), { vault })).toMatch(/something other than this vault's deposit/);
      expect(refusalForDeposit(oneIntent([{ address: vault, entryPoint: new TextEncoder().encode('deposit') }]), { vault })).toBeNull();
      expect(refusalForDeposit(oneIntent([{ address: vault, entryPoint: 'deposit' }], { guaranteedUnshieldedOffer: { inputs: [1], outputs: [] } }), { vault }))
        .toMatch(/moves public money/);
      expect(refusalForDeposit(oneIntent([{ address: vault, entryPoint: 'deposit' }], { dustActions: { spends: [1], registrations: [] } }), { vault }))
        .toMatch(/network fee from somewhere else/);
      expect(refusalForDeposit(oneIntent([{ address: vault, initialState: {} }]), { vault })).toMatch(/something other than call the vault/);
      expect(refusalForDeposit(oneIntent([]), { vault })).toMatch(/calls nothing/);
      expect(refusalForDeposit({ intents: new Map() }, { vault })).toMatch(/calls nothing/);
    });
  });

  describe('WHETHER MONEY MAY GO IN, READ FROM THE CHAIN', () => {
    const read = (authority: Partial<OnChainAuthority>): AuthorityRead => ({
      state: 'read', address: vault,
      authority: { committee: committee.committee.map((k) => ({ ...k })), threshold: 2, counter: 1n, shape: 'committee', hasDuplicateMembers: false, ...authority },
    });

    it('only when the chain holds exactly the company\'s committee', () => {
      expect(fundingRefusal(read({}), committee)).toBeNull();
      expect(fundingRefusal(read({ threshold: 1 }), committee)).toMatch(/not held by the company's committee/);
      expect(fundingRefusal(read({ committee: [{ tag: 'schnorr', value: 'aa'.repeat(32) }], threshold: 1, shape: 'one-key' }), committee))
        .toMatch(/finish handing it to the committee first/);
      expect(fundingRefusal({ state: 'unreachable', address: vault, why: 'down' }, committee)).toMatch(/could not be asked/);
      expect(fundingRefusal({ state: 'absent', address: vault, why: 'none' }, committee)).toMatch(/could not be asked/);
    });

    it('A VAULT WHOSE PROOFS ARE NOT THIS BUILD\'S IS NOT FUNDED, whoever holds it', () => {
      const d = deploy.intents.values().next().value.actions[0];
      expect(circuitsRefusal(d.initialState, verifierKeys, 'no')).toBeNull();
      const swapped = new Map(verifierKeys);
      const k = new Uint8Array(swapped.get('payout')!); k[0] ^= 1;
      swapped.set('payout', k);
      expect(circuitsRefusal(d.initialState, swapped, 'this vault is not funded')).toMatch(/^this vault is not funded: its 'payout' circuit/);
      const fewer = { operations: () => d.initialState.operations().slice(1), operation: (n: string) => d.initialState.operation(n) };
      expect(circuitsRefusal(fewer, verifierKeys, 'no')).toMatch(/circuits other than the vault's own/);
      expect(circuitsRefusal(null, verifierKeys, 'no')).toMatch(/circuits other than the vault's own/);
    });

    it('the operator tools refuse a committee any one member can act for, one nobody can, and one listing a key twice', () => {
      const three = [vk(4), vk(5), vk(6)];
      expect(heldKeyFundingRefusal(read({ committee: three, threshold: 2 }), [], 'v')).toBeNull();
      expect(heldKeyFundingRefusal(read({ committee: three, threshold: 1 }), [], 'v')).toMatch(/any one member/);
      expect(heldKeyFundingRefusal(read({ committee: three, threshold: 4, shape: 'no-one' }), [], 'v')).toMatch(/nobody can ever change its rules/);
      expect(heldKeyFundingRefusal(read({ committee: [], threshold: 1, shape: 'no-one' }), [], 'v')).toMatch(/nobody can ever change its rules/);
      expect(heldKeyFundingRefusal(read({ committee: [vk(4), vk(4), vk(5)], threshold: 2, hasDuplicateMembers: true }), [], 'v'))
        .toMatch(/lists one key more than once/);
    });

    it('the operator tools refuse a single key, a committee holding a key they keep, and a chain they cannot read', () => {
      const held = [vk(1)];
      expect(heldKeyFundingRefusal(read({ committee: [vk(9)], threshold: 1, shape: 'one-key' }), [], 'v')).toMatch(/still held by a single key/);
      expect(heldKeyFundingRefusal(read({}), held, 'v')).toMatch(/a key this machine keeps/);
      expect(heldKeyFundingRefusal(read({ threshold: 0, shape: 'anyone' }), [], 'v')).toMatch(/single key/);
      expect(heldKeyFundingRefusal({ state: 'unreadable', address: vault, why: 'x' }, [], 'v')).toMatch(/could not be asked/);
      expect(heldKeyFundingRefusal(read({ committee: [vk(3), vk(4)], shape: 'committee' }), held, 'v')).toBeNull();
    });
  });
});
