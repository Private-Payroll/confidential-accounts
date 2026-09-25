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
  circuitsRefusal, refusalToPutMoneyIn, readVaultDeploy, refusalForDeposit, refusalForHandover,
  refusalForPayout, refusalForPublicPayout, startingLedgerFrom, type VaultStartingLedger,
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

    /*
     * **THE ONE GATE, ASKED ABOUT THE VAULT.** The account half is handed a read
     * that passes, so each row below is about the vault and nothing else.
     */
    const ok = read({});
    const gate = (
      vaultRead: AuthorityRead, to: Committee | null, over: Record<string, unknown> = {},
    ): string | null => refusalToPutMoneyIn({
      label: 'v', what: 'no money goes in', vault: vaultRead, vaultCircuits: null,
      pinnedAccount: 'acc', companyAccount: 'acc', account: ok, accountCircuits: null,
      committee: to, heldHere: [], ...over,
    })?.why ?? null;

    it('only when the chain holds exactly the company\'s committee', () => {
      expect(gate(read({}), committee)).toBeNull();
      expect(gate(read({ threshold: 1 }), committee)).toMatch(/not held by the company's committee/);
      expect(gate(read({ committee: [{ tag: 'schnorr', value: 'aa'.repeat(32) }], threshold: 1, shape: 'one-key' }), committee))
        .toMatch(/finish handing it to the committee first/);
      expect(gate({ state: 'unreachable', address: vault, why: 'down' }, committee)).toMatch(/could not be asked/);
      expect(gate({ state: 'absent', address: vault, why: 'none' }, committee)).toMatch(/could not be asked/);
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

    /* The same gate with no roster to compare against, which is what an operator tool asks. */
    it('with no roster it refuses a committee any one member can act for, one nobody can, and one listing a key twice', () => {
      const three = [vk(4), vk(5), vk(6)];
      expect(gate(read({ committee: three, threshold: 2 }), null)).toBeNull();
      expect(gate(read({ committee: three, threshold: 1 }), null)).toMatch(/any one member/);
      expect(gate(read({ committee: three, threshold: 4, shape: 'no-one' }), null)).toMatch(/nobody can ever change its rules/);
      expect(gate(read({ committee: [], threshold: 1, shape: 'no-one' }), null)).toMatch(/nobody can ever change its rules/);
      expect(gate(read({ committee: [vk(4), vk(4), vk(5)], threshold: 2, hasDuplicateMembers: true }), null))
        .toMatch(/lists one key more than once/);
    });

    it('with no roster it refuses a single key, a committee holding a key this machine keeps, and a chain it cannot read', () => {
      const held = [vk(1)];
      expect(gate(read({ committee: [vk(9)], threshold: 1, shape: 'one-key' }), null)).toMatch(/still held by a single key/);
      /* `account: ok` would say the same sentence, so the account is given a committee this machine has no key of. */
      const theirs = read({ committee: [vk(3), vk(4)], shape: 'committee' });
      expect(gate(read({}), null, { heldHere: held, account: theirs })).toMatch(/a key this machine keeps/);
      expect(gate(read({ threshold: 0, shape: 'anyone' }), null)).toMatch(/single key/);
      expect(gate({ state: 'unreadable', address: vault, why: 'x' }, null)).toMatch(/could not be asked/);
      /* The account is asked the same question, so it too must hold no key this machine keeps. */
      const clean = read({ committee: [vk(3), vk(4)], shape: 'committee' });
      expect(gate(clean, null, { heldHere: held, account: clean })).toBeNull();
      expect(gate(clean, null, { heldHere: held }), 'RED WHEN: the account half stops being asked with no roster')
        .toMatch(/a key this machine keeps/);
    });
  });
});

/*
 * **A PRIVATE PAYMENT OUT, AS THE FEE PAYER READS IT.** Shaped objects with the
 * ledger's own field names; the same reader over a payment the device's own
 * builder made, applied by the ledger's own state machine, is
 * `contracts/test/a-company-vault-from-the-page.test.ts`.
 */
describe('A PRIVATE PAYMENT OUT OF THE VAULT', () => {
  const VAULT = 'ab'.repeat(32);
  const OTHER = 'ee'.repeat(32);
  const shielded = (raw: string) => ({ tag: 'shielded', raw });
  type Shape = {
    actions?: unknown[]; intentExtra?: Record<string, unknown>;
    guaranteed?: unknown; fallible?: unknown; imbalances?: (segment: number) => Map<unknown, bigint>; intents?: number;
  };
  const payout = (over: Shape = {}) => {
    const actions = over.actions ?? [
      { address: ACCOUNT, entryPoint: 'recordPayment' },
      { address: VAULT, entryPoint: new TextEncoder().encode('payout') },
    ];
    const intent = { actions, ...(over.intentExtra ?? {}) };
    return {
      intents: new Map(Array.from({ length: over.intents ?? 1 }, (_, i) => [i + 1, intent])),
      guaranteedOffer: 'guaranteed' in over ? over.guaranteed : {
        inputs: [{ contractAddress: VAULT }],
        outputs: [{ contractAddress: undefined }, { contractAddress: VAULT }],
        transients: [],
      },
      fallibleOffer: 'fallible' in over ? over.fallible : undefined,
      imbalances: over.imbalances ?? (() => new Map<unknown, bigint>([[{ tag: 'dust' }, -5n], [shielded('ab'), 0n]])),
    };
  };
  const expect_ = { vault: VAULT, account: ACCOUNT };

  it('is paid for when it spends one of this vault\'s coins into one person\'s, with the change back to the vault, and asks this company\'s account', () => {
    expect(refusalForPayout(payout(), expect_)).toBeNull();
    /* A payment that spends a note exactly has no change. RED WHEN: the change output is required. */
    expect(refusalForPayout(payout({ guaranteed: { inputs: [{ contractAddress: VAULT }], outputs: [{}], transients: [] } }), expect_)).toBeNull();
    /* The coins may sit in a fallible part. RED WHEN: only the guaranteed offer is read. */
    expect(refusalForPayout(payout({
      guaranteed: undefined,
      fallible: new Map([[1, { inputs: [{ contractAddress: VAULT }], outputs: [{}, { contractAddress: VAULT }], transients: [] }]]),
    }), expect_)).toBeNull();
  });

  it('REFUSES ANY CALL BUT THE VAULT\'S PAYOUT AND THIS COMPANY\'S APPROVAL OF IT', () => {
    /* RED WHEN: the call set is not compared exactly. */
    const refuse = /must call this vault's payout and this company's approval of it/;
    expect(refusalForPayout(payout({ actions: [{ address: VAULT, entryPoint: 'payout' }] }), expect_)).toMatch(refuse);
    expect(refusalForPayout(payout({ actions: [{ address: OTHER, entryPoint: 'recordPayment' }, { address: VAULT, entryPoint: 'payout' }] }), expect_)).toMatch(refuse);
    expect(refusalForPayout(payout({ actions: [{ address: ACCOUNT, entryPoint: 'recordPayment' }, { address: OTHER, entryPoint: 'payout' }] }), expect_)).toMatch(refuse);
    expect(refusalForPayout(payout({ actions: [{ address: ACCOUNT, entryPoint: 'recordPayment' }, { address: VAULT, entryPoint: 'splitNote' }] }), expect_)).toMatch(refuse);
    expect(refusalForPayout(payout({ actions: [
      { address: ACCOUNT, entryPoint: 'recordPayment' }, { address: VAULT, entryPoint: 'payout' }, { address: VAULT, entryPoint: 'payout' },
    ] }), expect_)).toMatch(refuse);
    expect(refusalForPayout(payout({ actions: [{ address: ACCOUNT, entryPoint: 'recordPayment' }, { address: VAULT, initialState: {} }] }), expect_))
      .toMatch(/something other than call the vault and the account/);
    expect(refusalForPayout(payout({ intents: 2 }), expect_)).toMatch(/exactly one set of actions/);
    expect(refusalForPayout({ intents: new Map() }, expect_)).toMatch(/exactly one set of actions/);
  });

  it('REFUSES PUBLIC MONEY AND A FEE PAID FROM ELSEWHERE', () => {
    /* RED WHEN: either offer check is removed. */
    expect(refusalForPayout(payout({ intentExtra: { fallibleUnshieldedOffer: { inputs: [], outputs: [1] } } }), expect_)).toMatch(/moves public money/);
    expect(refusalForPayout(payout({ intentExtra: { guaranteedUnshieldedOffer: { inputs: [1], outputs: [] } } }), expect_)).toMatch(/moves public money/);
    expect(refusalForPayout(payout({ intentExtra: { dustActions: { spends: [1], registrations: [] } } }), expect_)).toMatch(/network fee from somewhere else/);
  });

  it('REFUSES A COIN THAT IS NOT THIS VAULT\'S, A SECOND COIN, A SECOND PERSON, CHANGE SENT ELSEWHERE, OR A COIN MADE AND SPENT', () => {
    const offer = (o: Record<string, unknown>) => payout({ guaranteed: { inputs: [{ contractAddress: VAULT }], outputs: [{}], transients: [], ...o } });
    /* RED WHEN: the input's owner is not compared - a person's own coin, or another contract's, would be spent under the company's fee. */
    expect(refusalForPayout(offer({ inputs: [{ contractAddress: OTHER }] }), expect_)).toMatch(/exactly one coin, and that coin must be this vault's/);
    expect(refusalForPayout(offer({ inputs: [{}] }), expect_)).toMatch(/exactly one coin, and that coin must be this vault's/);
    expect(refusalForPayout(offer({ inputs: [{ contractAddress: VAULT }, { contractAddress: VAULT }] }), expect_)).toMatch(/exactly one coin/);
    expect(refusalForPayout(offer({ inputs: [] }), expect_)).toMatch(/exactly one coin/);
    /* RED WHEN: the person count is not checked. */
    expect(refusalForPayout(offer({ outputs: [{}, {}] }), expect_)).toMatch(/pay exactly one person/);
    expect(refusalForPayout(offer({ outputs: [{ contractAddress: VAULT }] }), expect_)).toMatch(/pay exactly one person/);
    /* RED WHEN: a contract-owned output's owner is not compared. */
    expect(refusalForPayout(offer({ outputs: [{}, { contractAddress: OTHER }] }), expect_)).toMatch(/may only go back to this vault/);
    expect(refusalForPayout(offer({ outputs: [{}, { contractAddress: VAULT }, { contractAddress: VAULT }] }), expect_)).toMatch(/may only go back to this vault/);
    expect(refusalForPayout(offer({ transients: [{}] }), expect_)).toMatch(/makes and spends a coin in one go/);
    expect(refusalForPayout(payout({ guaranteed: undefined, fallible: [] }), expect_)).toMatch(/coins could not be read/);
    expect(refusalForPayout(offer({ outputs: undefined }), expect_)).toMatch(/coins could not be read/);
  });

  it('REFUSES A PAYMENT THAT DOES NOT BALANCE IN ITS OWN MONEY, IN ANY PART, OR ONE THAT CANNOT BE ADDED UP', () => {
    /* RED WHEN: the imbalance check is removed, reads only the guaranteed part, or treats DUST as the payment's own money. */
    expect(refusalForPayout(payout({ imbalances: () => new Map([[shielded('ab'), 7n]]) }), expect_)).toMatch(/does not balance in its own money/);
    expect(refusalForPayout(payout({ imbalances: () => new Map([[{ tag: 'unshielded', raw: '00' }, -1n]]) }), expect_)).toMatch(/does not balance/);
    const fallibleOnly = (segment: number) => new Map([[shielded('ab'), segment === 1 ? 3n : 0n]]);
    expect(refusalForPayout(payout({
      guaranteed: undefined, imbalances: fallibleOnly,
      fallible: new Map([[1, { inputs: [{ contractAddress: VAULT }], outputs: [{}], transients: [] }]]),
    }), expect_)).toMatch(/does not balance/);
    expect(refusalForPayout(payout({ imbalances: () => { throw new Error('unreadable'); } }), expect_)).toMatch(/could not be added up/);
    const noSums = payout() as Record<string, unknown>;
    delete noSums.imbalances;
    expect(refusalForPayout(noSums, expect_)).toMatch(/could not be added up/);
  });
});

/*
 * **THE FEE ON A PUBLIC PAYMENT OUT.** The shape the SDK builds, read back from a
 * real transaction the ledger applied, is pinned in
 * `contracts/test/a-private-payment-from-the-page.test.ts`; these are the refusals.
 */
describe('A PUBLIC PAYMENT OUT OF THE VAULT', () => {
  const VAULT = 'ab'.repeat(32);
  const ACCOUNT = 'cd'.repeat(32);
  const OTHER = 'ee'.repeat(32);
  type Shape = {
    actions?: unknown[]; intentExtra?: Record<string, unknown>; guaranteed?: unknown; fallible?: unknown;
    imbalances?: (segment: number) => Map<unknown, bigint>;
  };
  const payout = (over: Shape = {}) => ({
    intents: new Map([[1, {
      actions: over.actions ?? [
        { address: ACCOUNT, entryPoint: 'recordPayment' },
        { address: VAULT, entryPoint: new TextEncoder().encode('payoutUnshielded') },
      ],
      guaranteedUnshieldedOffer: { inputs: [], outputs: [{ owner: 'c3'.repeat(32), type: 'a8'.repeat(32), value: 250n }], signatures: [] },
      ...(over.intentExtra ?? {}),
    }]]),
    guaranteedOffer: 'guaranteed' in over ? over.guaranteed : undefined,
    fallibleOffer: 'fallible' in over ? over.fallible : undefined,
    imbalances: over.imbalances ?? (() => new Map<unknown, bigint>([[{ tag: 'dust' }, -5n], [{ tag: 'unshielded' }, 0n]])),
  });
  const expect_ = { vault: VAULT, account: ACCOUNT };

  it('is paid for when the vault\'s public payout pays one public address and asks this company\'s account', () => {
    expect(refusalForPublicPayout(payout(), expect_)).toBeNull();
    /* RED WHEN: a public payment is taken by the private payout's reader. */
    expect(refusalForPayout(payout(), expect_)).toMatch(/moves public money/);
  });

  it('REFUSES ANY CALL BUT THE VAULT\'S PUBLIC PAYOUT AND THIS COMPANY\'S APPROVAL OF IT', () => {
    const refuse = /must call this vault's public payout and this company's approval of it/;
    /* RED WHEN: the call set is not compared exactly, or the private payout is taken for the public one. */
    expect(refusalForPublicPayout(payout({ actions: [{ address: ACCOUNT, entryPoint: 'recordPayment' }, { address: VAULT, entryPoint: 'payout' }] }), expect_)).toMatch(refuse);
    expect(refusalForPublicPayout(payout({ actions: [{ address: OTHER, entryPoint: 'recordPayment' }, { address: VAULT, entryPoint: 'payoutUnshielded' }] }), expect_)).toMatch(refuse);
    expect(refusalForPublicPayout(payout({ actions: [{ address: ACCOUNT, entryPoint: 'recordPayment' }, { address: OTHER, entryPoint: 'payoutUnshielded' }] }), expect_)).toMatch(refuse);
    expect(refusalForPublicPayout(payout({ actions: [{ address: VAULT, entryPoint: 'payoutUnshielded' }] }), expect_)).toMatch(refuse);
  });

  it('REFUSES ONE THAT SPENDS ANYBODY\'S COIN, MOVES PRIVATE MONEY, PAYS MORE THAN ONE ADDRESS, OR BRINGS ITS OWN FEE', () => {
    /* RED WHEN: a public input is let through - the fee payer would add DUST to a spend of somebody's coin. */
    expect(refusalForPublicPayout(payout({ intentExtra: { guaranteedUnshieldedOffer: { inputs: [1], outputs: [1] } } }), expect_))
      .toMatch(/spends somebody's public coin/);
    /* RED WHEN: a private coin is let through on a public payment. */
    expect(refusalForPublicPayout(payout({ guaranteed: { inputs: [{ contractAddress: VAULT }], outputs: [], transients: [] } }), expect_))
      .toMatch(/moves private money as well/);
    expect(refusalForPublicPayout(payout({ fallible: new Map([[1, { inputs: [], outputs: [{}], transients: [] }]]) }), expect_))
      .toMatch(/moves private money as well/);
    /* RED WHEN: the output count is not exactly one, across both parts. */
    expect(refusalForPublicPayout(payout({ intentExtra: { fallibleUnshieldedOffer: { inputs: [], outputs: [1] } } }), expect_))
      .toMatch(/must pay exactly one person/);
    expect(refusalForPublicPayout(payout({ intentExtra: { guaranteedUnshieldedOffer: { inputs: [], outputs: [] } } }), expect_))
      .toMatch(/must pay exactly one person/);
    /* RED WHEN: a fee already paid from elsewhere is let through. */
    expect(refusalForPublicPayout(payout({ intentExtra: { dustActions: { spends: [1], registrations: [] } } }), expect_))
      .toMatch(/already pays a network fee/);
    /* RED WHEN: anything but DUST left unbalanced is let through. */
    expect(refusalForPublicPayout(payout({ imbalances: () => new Map([[{ tag: 'unshielded' }, 5n]]) }), expect_))
      .toMatch(/does not balance in its own money/);
    /* RED WHEN: the intent's own segment is not asked - a public output left unbalanced there is paid for. */
    expect(refusalForPublicPayout(payout({
      imbalances: (segment) => new Map(segment === 1 ? [[{ tag: 'unshielded' }, -999n]] : [[{ tag: 'dust' }, -5n]]),
    }), expect_)).toMatch(/does not balance in its own money/);
  });
});
