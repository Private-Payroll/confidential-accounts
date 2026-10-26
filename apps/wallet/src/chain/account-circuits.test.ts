import { describe, expect, it } from 'vitest';
import { createCircuitContext, createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import * as ocrt from '@midnightntwrk/onchain-runtime-v4';
import { Contract as Vault, pureCircuits as vaultPure } from '../../../../contracts/managed-vault/contract/index.js';
import { pureCircuits as accountPure } from '../../../../contracts/managed/contract/index.js';
import { AccountSimulator, change, payoutTreeOf, privateStateFor, vaultRunOf } from '../../../../contracts/test/simulator.js';
import { noFurtherNote } from '../../../../src/midnight/vault-step-notes.js';
import { startTheVault, TEST_VAULT_SECRET } from '../../../../contracts/test/start-a-vault.js';
import { ACCOUNT_CIRCUITS_A_VAULT_CALLS } from '../../../../src/midnight/vault-contract.js';
import { fromHex, toHex } from '../../../../src/core/crypto.js';
import {
  ACCOUNT_CIRCUITS_EACH_VAULT_CIRCUIT_CALLS, ACCOUNT_CIRCUITS_THE_WALLET_HOLDS_KEYS_FOR, ACCOUNT_CIRCUITS_THE_WALLET_PROVES,
  ACCOUNT_CIRCUITS_THE_WALLETS_VAULT_CIRCUITS_CALL, VAULT_CIRCUITS_THE_WALLET_PROVES,
} from './account-circuits.js';

/*
 * The account circuits a vault circuit the wallet proves calls are read here from the compiled vault itself, run on
 * a simulated account: every circuit of the account the runtime asks the account's state for during the call is one
 * the call reaches, and so one more proof the wallet must make with a key it holds.
 */

const A = privateStateFor(1);
const B = privateStateFor(2);
const NOW = 1_800_000_000;
const BLOCK = '0'.repeat(64);

interface VaultPrivate { coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint }; secret: Uint8Array }
const witnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.coin],
  nonceSecret: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.secret],
};

/**
 * Starts a vault, makes a deposit into it, and pays one payee of an approved run privately and one publicly, as the
 * wallet does, and says which account circuits each call reached.
 */
const accountCircuitsEachCallReaches = async (): Promise<Record<string, string[]>> => {
  const sim = await AccountSimulator.liveAccount([A, B], 2n);
  sim.at(NOW);
  const vault = new Vault<VaultPrivate>(witnesses as never);
  const addr = String(sampleContractAddress());
  let state = (await vault.initialState(createConstructorContext({} as VaultPrivate, BLOCK), { bytes: fromHex(String(sim.address)) } as never)).currentContractState;
  const priv: VaultPrivate = { coin: { nonce: new Uint8Array(32), color: new Uint8Array(32), value: 0n, mt_index: 0n }, secret: TEST_VAULT_SECRET };
  const reached: Record<string, string[]> = {};
  let publicMoney: bigint | null = null;
  const call = async (circuit: string, ...args: unknown[]): Promise<unknown> => {
    if (publicMoney !== null) {
      const held = new ocrt.ContractState();
      (held as { data: unknown }).data = (state as { data?: unknown }).data ?? state;
      held.balance = new Map([[{ tag: 'unshielded', raw: 'ab'.repeat(32) } as never, publicMoney]]);
      state = held as never;
    }
    const asked: string[] = [];
    const provider = {
      getContractState: async (_b: string, address: unknown) => {
        if (String(address) !== String(sim.address)) return undefined;
        const account = sim.contractStateForCall as { operation(id: string): unknown };
        const own = Object.getPrototypeOf(account).operation as (id: string) => unknown;
        account.operation = (id: string) => { asked.push(id); return own.call(account, id); };
        return account as never;
      },
    };
    const ctx = createCircuitContext<VaultPrivate>(circuit as never, addr as never, BLOCK, state, priv, provider as never, undefined, undefined, NOW, BLOCK);
    const out: any = await (vault.impureCircuits as any)[circuit](ctx, ...args);
    state = out.context.callContext.currentQueryContext.state;
    try { sim.adoptFromCall(out.context); } catch { /* this call did not reach the account */ }
    reached[circuit] = [...new Set([...(reached[circuit] ?? []), ...asked])];
    return out.result;
  };
  await startTheVault({ sim, vault: fromHex(addr), call, approvers: [A, B], now: NOW });
  const note = { nonce: new Uint8Array(32).fill(0x77), color: new Uint8Array(32).fill(0x9b), value: 1_000n };
  await call('deposit', note);
  priv.coin = { ...note, mt_index: 0n };
  const vaultBytes = fromHex(addr);
  const payee = new Uint8Array(32).fill(0x0a);
  const blinding = new Uint8Array(32).fill(0x40);
  const [from, until] = [BigInt(NOW - 3_600), BigInt(NOW + 3_600)];
  const approvedRun = async (token: Uint8Array, details: (to: Uint8Array, t: Uint8Array, a: bigint, b: Uint8Array) => Uint8Array, seed: number) => {
    const c = change(0n, seed);
    const tree = payoutTreeOf([{ details: toHex(details(payee, token, 250n, blinding)), nonce: toHex(new Uint8Array(32).fill(seed)) }], [250n], token);
    await sim.as(sim.applying(A, c)).proposeRun({ root: fromHex(tree.root), payees: tree.payees, from, until, vault: vaultBytes });
    const id = sim.proposalId(accountPure.runPayload(fromHex(tree.root), tree.payees, from, until, 0n), c.salt, vaultBytes);
    await sim.as(sim.applying(B, c)).approve(id);
    return vaultRunOf({ proposal: id, vault: vaultBytes, tree, i: 0, opensAt: from, closesAt: until, salt: c.salt, nonce: new Uint8Array(32).fill(seed) });
  };
  await call('payout', await approvedRun(note.color, vaultPure.payoutDetails, 0xc1), payee, note.color, 250n, blinding, noFurtherNote());
  const night = new Uint8Array(32).fill(0xab);
  const run = await approvedRun(night, vaultPure.unshieldedPayoutDetails, 0xc2);
  publicMoney = 500n;
  await call('payoutUnshielded', run, payee, night, 250n, blinding);
  return reached;
};

describe('the account circuits the wallet holds keys for', () => {
  it('are, for each vault circuit the wallet proves, exactly the account circuits that circuit calls when it runs', async () => {
    // RED WHEN: a vault circuit the wallet proves calls an account circuit the wallet holds no key for, so that transaction can never be proved here
    const reached = await accountCircuitsEachCallReaches();
    expect(Object.keys(reached).sort()).toEqual([...VAULT_CIRCUITS_THE_WALLET_PROVES].sort());
    for (const circuit of VAULT_CIRCUITS_THE_WALLET_PROVES) {
      expect([...(ACCOUNT_CIRCUITS_EACH_VAULT_CIRCUIT_CALLS[circuit] ?? [])].sort(), circuit).toEqual([...reached[circuit]!].sort());
    }
  }, 120_000);

  it('name every vault circuit the wallet proves, and only account circuits a vault may call', () => {
    // RED WHEN: a vault circuit the wallet proves has no entry, so the account calls it makes are served by nobody
    expect(Object.keys(ACCOUNT_CIRCUITS_EACH_VAULT_CIRCUIT_CALLS).sort()).toEqual([...VAULT_CIRCUITS_THE_WALLET_PROVES].sort());
    // RED WHEN: an account circuit no vault circuit calls is served to the wallet's prover as if a vault had called it
    for (const c of ACCOUNT_CIRCUITS_THE_WALLETS_VAULT_CIRCUITS_CALL) expect(ACCOUNT_CIRCUITS_A_VAULT_CALLS, c).toContain(c);
    expect([...ACCOUNT_CIRCUITS_THE_WALLETS_VAULT_CIRCUITS_CALL].sort()).toEqual(['approveVaultChange', 'recordPaymentFromVault']);
  });

  it('are the circuits the wallet proves itself and the ones its vault circuits call, each once', () => {
    // RED WHEN: the keys copied into the wallet leave out the account call a vault's first secret makes, or the one a payment out of a vault makes
    expect([...ACCOUNT_CIRCUITS_THE_WALLET_HOLDS_KEYS_FOR].sort()).toEqual([...ACCOUNT_CIRCUITS_THE_WALLET_PROVES, 'approveVaultChange', 'recordPaymentFromVault'].sort());
    expect(new Set(ACCOUNT_CIRCUITS_THE_WALLET_HOLDS_KEYS_FOR).size).toBe(ACCOUNT_CIRCUITS_THE_WALLET_HOLDS_KEYS_FOR.length);
  });
});
